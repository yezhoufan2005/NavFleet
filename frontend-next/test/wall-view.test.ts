import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import WallView from "@/views/WallView.vue";
import { useFleetStore } from "@/stores/fleet";

/**
 * 大屏值班 — the shell-less wall view. jsdom lays nothing out (so the auto-scroll never
 * engages here, which is why the arithmetic lives in `wall-lib.test.ts`); these cases pin the
 * wiring: the store's numbers reach the KPI band, the alert stream is worst-first, and the
 * mandatory freshness indicator moves and changes colour as the data goes stale.
 */
enableAutoUnmount(afterEach);

const device = (patch: Record<string, unknown> = {}) => ({
  deviceId: "agv-01",
  deviceName: "AGV 01",
  online: true,
  gps: { lat: 31.2, lng: 121.4 },
  ...patch,
});

const code = (value: number, info: string) => ({
  code: value,
  info,
  stamp: null,
});

const snapshot = (devices: unknown[], extra: Record<string, unknown> = {}) => ({
  fleetName: "示范车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  devices,
  ...extra,
});

let store: ReturnType<typeof useFleetStore>;

const mountWall = async () => {
  const wrapper = mount(WallView);
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  store = useFleetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the KPI band", () => {
  it("reads its numbers from the store", async () => {
    store.ingestPayload(
      snapshot(
        [
          device(),
          device({ deviceId: "agv-02", online: false }),
          device({ deviceId: "agv-03", gps: null }),
        ],
        {
          formations: [
            {
              formationId: "f-1",
              formationName: "北区",
              deviceIds: ["agv-01"],
            },
          ],
        },
      ),
      "api",
    );
    const wrapper = await mountWall();
    const tiles = wrapper.findAll(".wall-tile");

    expect(tiles).toHaveLength(4);
    expect(tiles[0]?.text()).toContain("2 / 3");
    expect(tiles[0]?.text()).toContain("1 台离线");
    expect(tiles[0]?.attributes("data-tone")).toBe("warning");
    expect(tiles[3]?.text()).toContain("1");
  });

  it("shows the fleet name in the header", async () => {
    store.ingestPayload(snapshot([device()]), "api");
    const wrapper = await mountWall();
    expect(wrapper.find(".wall-fleet-name").text()).toBe("示范车队");
  });
});

describe("the alert stream", () => {
  it("lists active alerts worst-first with the device and a severity badge", async () => {
    store.ingestPayload(
      snapshot([
        device({
          deviceId: "agv-02",
          deviceName: "预警车",
          warning_code: code(2203, "电量偏低"),
        }),
        device({
          deviceId: "agv-03",
          deviceName: "告警车",
          error_code: code(5102, "路径规划超时"),
        }),
      ]),
      "api",
    );
    const wrapper = await mountWall();
    const rows = wrapper.findAll(".wall-alert");

    expect(rows.length).toBe(2);
    // critical before warning.
    expect(rows[0]?.text()).toContain("告警车");
    expect(rows[0]?.find(".wall-alert-badge").text()).toBe("告警");
    expect(rows[1]?.text()).toContain("预警车");
    expect(rows[1]?.find(".wall-alert-badge").text()).toBe("预警");
  });

  it("says so in one line when the fleet is quiet, rather than an empty column", async () => {
    store.ingestPayload(snapshot([device()]), "api");
    const wrapper = await mountWall();

    expect(wrapper.find(".wall-alerts-empty").exists()).toBe(true);
    expect(wrapper.find(".wall-alerts-empty").text()).toContain("无活跃告警");
    expect(wrapper.findAll(".wall-alert")).toHaveLength(0);
  });
});

describe("the freshness indicator", () => {
  it("says there is no data before the first ingest, and calls it critical", async () => {
    const wrapper = await mountWall();
    expect(wrapper.find(".wall-age").text()).toContain("尚无数据");
    expect(wrapper.find(".wall-pill").text()).toContain("画面可能已冻结");
  });

  it("moves the age and reddens the pill as the data goes stale", async () => {
    vi.useFakeTimers();
    try {
      store.ingestPayload(snapshot([device()]), "api");
      const wrapper = await mountWall();
      // Fresh at ingest.
      expect(wrapper.find(".wall-age").text()).toMatch(/0 秒前/);
      expect(wrapper.find(".wall-pill").text()).toContain("实时");

      vi.advanceTimersByTime(31_000);
      await flushPromises();
      expect(wrapper.find(".wall-age").text()).toContain("秒前");
      expect(wrapper.find(".wall-pill").text()).toContain("画面可能已冻结");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("non-interactive by construction", () => {
  it("renders the map read-only and turns off the pointer for the whole surface", async () => {
    store.ingestPayload(snapshot([device()]), "api");
    const wrapper = await mountWall();

    // The map is present (its own no-key fallback is fine in tests) and gets no select handler.
    expect(wrapper.find(".wall-map").exists()).toBe(true);

    // Asserted against the stylesheet because jsdom applies no scoped CSS: the wall must be
    // pointer-dead (a wall is watched, not operated) and the map's own controls hidden.
    const source = readFileSync(
      resolve(__dirname, "../src/views/WallView.vue"),
      "utf8",
    );
    expect(source).toMatch(/\.wall-root\s*\{[^}]*pointer-events:\s*none/s);
    expect(source).toMatch(
      /\.wall-map\s*:deep\(button\)\s*\{\s*display:\s*none/,
    );
  });
});
