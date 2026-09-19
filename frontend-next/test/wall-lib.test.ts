import { describe, it, expect } from "vitest";
import {
  WALL_STALE_CRITICAL_MS,
  WALL_STALE_WARNING_MS,
  buildWallTiles,
  flattenActiveAlerts,
  wallFreshness,
} from "@/lib/wallView";
import type { GroupedAlert, GroupedAlerts } from "@/stores/fleet";

/**
 * The wall's pure parts. These are the arithmetic the view cannot prove itself: jsdom lays
 * nothing out and never advances the clock, so freshness tone, the KPI tiles and the
 * worst-first stream are asserted here and the view test only checks the wiring.
 */

const alert = (
  patch: Partial<GroupedAlert> & { id: string },
): GroupedAlert => ({
  title: "占位",
  detail: "",
  severity: "notice",
  source: "snapshot",
  ts: "2026-09-19T00:00:00.000Z",
  deviceId: "agv-01",
  deviceName: "AGV 01",
  firstSeenAt: 0,
  ...patch,
});

const grouped = (lists: Partial<GroupedAlerts>): GroupedAlerts => ({
  critical: [],
  warning: [],
  notice: [],
  ...lists,
});

describe("wallFreshness", () => {
  const base = Date.parse("2026-09-19T12:00:00.000Z");

  it("stays calm within the warning window and moves its number", () => {
    const fresh = wallFreshness(new Date(base).toISOString(), base + 8_000);
    expect(fresh.tone).toBe("ok");
    expect(fresh.ageMs).toBe(8_000);
    expect(fresh.ageLabel).toBe("数据 8 秒前更新");
  });

  it("turns amber at the warning threshold and red at the critical one", () => {
    expect(
      wallFreshness(new Date(base).toISOString(), base + WALL_STALE_WARNING_MS)
        .tone,
    ).toBe("warning");
    expect(
      wallFreshness(new Date(base).toISOString(), base + WALL_STALE_CRITICAL_MS)
        .tone,
    ).toBe("critical");
  });

  it("phrases minutes and hours rather than a runaway second count", () => {
    expect(
      wallFreshness(new Date(base).toISOString(), base + 90_000).ageLabel,
    ).toBe("数据 1 分钟前更新");
    expect(
      wallFreshness(new Date(base).toISOString(), base + 7_200_000).ageLabel,
    ).toBe("数据 2 小时前更新");
  });

  it("treats never-ingested and an unparseable stamp as the worst case, not a zero age", () => {
    for (const value of [null, "not-a-date"]) {
      const fresh = wallFreshness(value, base);
      expect(fresh.tone).toBe("critical");
      expect(fresh.ageMs).toBeNull();
      expect(fresh.ageLabel).toBe("尚无数据");
    }
  });

  it("never reports a negative age from a skewed clock", () => {
    // now behind the stamp would otherwise read "-N 秒前".
    const fresh = wallFreshness(new Date(base).toISOString(), base - 5_000);
    expect(fresh.ageMs).toBe(0);
    expect(fresh.tone).toBe("ok");
  });
});

describe("flattenActiveAlerts", () => {
  it("orders worst severity first, then newest onset, then id", () => {
    const flat = flattenActiveAlerts(
      grouped({
        critical: [
          alert({ id: "c-old", severity: "critical", firstSeenAt: 10 }),
          alert({ id: "c-new", severity: "critical", firstSeenAt: 20 }),
        ],
        warning: [alert({ id: "w", severity: "warning", firstSeenAt: 100 })],
        notice: [alert({ id: "n", severity: "notice", firstSeenAt: 100 })],
      }),
    );
    expect(flat.map((entry) => entry.id)).toEqual(["c-new", "c-old", "w", "n"]);
  });

  it("breaks an identical onset by id so the order does not twitch", () => {
    const flat = flattenActiveAlerts(
      grouped({
        critical: [
          alert({ id: "b", severity: "critical", firstSeenAt: 5 }),
          alert({ id: "a", severity: "critical", firstSeenAt: 5 }),
        ],
      }),
    );
    expect(flat.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("is empty for a quiet fleet", () => {
    expect(flattenActiveAlerts(grouped({}))).toEqual([]);
  });
});

describe("buildWallTiles", () => {
  const summary = { totalCount: 6, onlineCount: 6, alertTotal: 0, gpsCount: 6 };

  it("keeps ok tones ok when the numbers are fine", () => {
    const tiles = buildWallTiles(summary, 0, 3);
    const byKey = Object.fromEntries(tiles.map((tile) => [tile.key, tile]));
    expect(byKey.online?.tone).toBe("ok");
    expect(byKey.online?.note).toBe("全部在线");
    expect(byKey.alerts?.tone).toBe("ok");
    expect(byKey.alerts?.note).toBe("无告警级");
    // Context tiles never colour.
    expect(byKey.gps?.tone).toBe("muted");
    expect(byKey.formations?.tone).toBe("muted");
    expect(byKey.formations?.value).toBe("3");
  });

  it("warns when some are offline and alarms when the whole fleet is dark", () => {
    expect(
      buildWallTiles({ ...summary, onlineCount: 4 }, 0, 0).find(
        (tile) => tile.key === "online",
      )?.tone,
    ).toBe("warning");
    const dark = buildWallTiles({ ...summary, onlineCount: 0 }, 0, 0).find(
      (tile) => tile.key === "online",
    );
    expect(dark?.tone).toBe("critical");
    expect(dark?.note).toBe("6 台离线");
  });

  it("makes the alert tile critical only when a critical-severity alert is up", () => {
    expect(
      buildWallTiles({ ...summary, alertTotal: 2 }, 0, 0).find(
        (tile) => tile.key === "alerts",
      )?.tone,
    ).toBe("warning");
    const withCritical = buildWallTiles(
      { ...summary, alertTotal: 2 },
      1,
      0,
    ).find((tile) => tile.key === "alerts");
    expect(withCritical?.tone).toBe("critical");
    expect(withCritical?.note).toBe("1 条告警级");
  });

  it("counts GPS gaps and an unconfigured formation set", () => {
    const tiles = buildWallTiles({ ...summary, gpsCount: 4 }, 0, 0);
    const byKey = Object.fromEntries(tiles.map((tile) => [tile.key, tile]));
    expect(byKey.gps?.note).toBe("2 台无定位");
    expect(byKey.formations?.note).toBe("未配置编队");
  });

  it("labels the four tiles the room expects", () => {
    const labels = buildWallTiles(summary, 0, 0).map((tile) => tile.label);
    expect(labels).toEqual(["在线设备", "活跃告警", "GPS 覆盖", "设备编队"]);
  });
});
