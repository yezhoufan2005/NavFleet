/**
 * 大屏值班 — the pure parts.
 *
 * The wall view (`views/WallView.vue`) is a shell-less screen left running for months on
 * an unattended display. Everything here is the logic that decides *what* it shows —
 * freshness tone, the KPI tiles, the worst-first alert stream — pulled out of the component
 * so it can be asserted directly (jsdom lays nothing out and never advances the wall's
 * clock, so the view test can only prove the wiring, not the arithmetic). The view stays a
 * thin renderer over these functions, the same split the reports and charts code already uses.
 */
import type { Severity } from "@navfleet/shared";
import type { GroupedAlert, GroupedAlerts } from "@/stores/fleet";

/**
 * When "last updated N seconds ago" turns from calm to a warning, and then to an alarm.
 *
 * A healthy fleet reports at ~1 Hz, so a gap of ten seconds already means something is
 * wrong upstream (link, backend, or the browser itself), and thirty means the screen is
 * almost certainly frozen — the failure a wall exists to make visible from across the room.
 * These are the thresholds the mandatory colour change keys off (`docs/frontend-ia.md` §4).
 */
export const WALL_STALE_WARNING_MS = 10_000;
export const WALL_STALE_CRITICAL_MS = 30_000;

export type WallTone = "ok" | "warning" | "critical";

export interface WallFreshness {
  tone: WallTone;
  /** Age in ms, or `null` when nothing has ever been ingested. */
  ageMs: number | null;
  /** The whole phrase, e.g. `数据 8 秒前更新` or `尚无数据` — never a fragment a template splices. */
  ageLabel: string;
}

/**
 * How stale the screen is, measured on the browser's own clock.
 *
 * Deliberately against `nowMs` (the browser clock) and never the server's timestamp: the two
 * clocks can be skewed, and subtracting one from the other is how a freshness line ends up
 * reading "更新于 -8 秒前" (the same trap `OverviewView` documents). No data at all is the worst
 * case, not a neutral one — a wall showing nothing since boot is a broken wall, so it is
 * `critical`, not `ok`.
 */
export function wallFreshness(
  lastUpdateAt: string | null,
  nowMs: number,
): WallFreshness {
  const ingestedMs = lastUpdateAt
    ? new Date(lastUpdateAt).getTime()
    : Number.NaN;
  if (!Number.isFinite(ingestedMs)) {
    return { tone: "critical", ageMs: null, ageLabel: "尚无数据" };
  }

  const ageMs = Math.max(0, nowMs - ingestedMs);
  const seconds = Math.round(ageMs / 1000);
  const ago =
    seconds < 60
      ? `${seconds} 秒前`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} 分钟前`
        : `${Math.floor(seconds / 3600)} 小时前`;
  const tone: WallTone =
    ageMs >= WALL_STALE_CRITICAL_MS
      ? "critical"
      : ageMs >= WALL_STALE_WARNING_MS
        ? "warning"
        : "ok";
  return { tone, ageMs, ageLabel: `数据 ${ago}更新` };
}

/** Worst first — the order alerts should be read, not the order they arrived. Matches `AlertsView`. */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  notice: 2,
};

/**
 * Every active alert in the fleet, worst severity first, newest **onset** first within it.
 *
 * By `firstSeenAt`, never `ts`: a vehicle re-sends its active codes every telemetry cycle, so
 * `ts` jumps to "now" for every row at once and the order falls to millisecond noise — on a
 * wall that reads as the whole list twitching once a second (documented at length in the store).
 */
export function flattenActiveAlerts(grouped: GroupedAlerts): GroupedAlert[] {
  return (["critical", "warning", "notice"] as const)
    .flatMap((bucket) => grouped[bucket])
    .sort(
      (left, right) =>
        SEVERITY_WEIGHT[left.severity] - SEVERITY_WEIGHT[right.severity] ||
        right.firstSeenAt - left.firstSeenAt ||
        left.id.localeCompare(right.id),
    );
}

export interface WallSummaryInput {
  totalCount: number;
  onlineCount: number;
  alertTotal: number;
  gpsCount: number;
}

export interface WallTile {
  key: string;
  label: string;
  value: string;
  note: string;
  /** `muted` tiles never colour — a permanently-toned tile teaches the room to ignore the colour. */
  tone: WallTone | "muted";
}

/**
 * The four numbers the wall leads with.
 *
 * `tone` is only ever "not ok" when the number itself says so (the rule `OverviewView` settled
 * on): online is `critical` only when the whole fleet is dark, `warning` when some are; alerts
 * follow the presence of a critical-severity row. GPS coverage and formation count are context,
 * so they stay `muted`.
 */
export function buildWallTiles(
  summary: WallSummaryInput,
  criticalCount: number,
  formationCount: number,
): WallTile[] {
  const { totalCount, onlineCount, alertTotal, gpsCount } = summary;
  const offline = totalCount - onlineCount;
  const offlineTone: WallTone =
    totalCount > 0 && onlineCount === 0
      ? "critical"
      : offline > 0
        ? "warning"
        : "ok";

  return [
    {
      key: "online",
      label: "在线设备",
      value: `${onlineCount} / ${totalCount}`,
      note: offline > 0 ? `${offline} 台离线` : "全部在线",
      tone: offlineTone,
    },
    {
      key: "alerts",
      label: "活跃告警",
      value: String(alertTotal),
      note: criticalCount > 0 ? `${criticalCount} 条告警级` : "无告警级",
      tone: criticalCount > 0 ? "critical" : alertTotal > 0 ? "warning" : "ok",
    },
    {
      key: "gps",
      label: "GPS 覆盖",
      value: `${gpsCount} / ${totalCount}`,
      note:
        gpsCount < totalCount
          ? `${totalCount - gpsCount} 台无定位`
          : "全部已定位",
      tone: "muted",
    },
    {
      key: "formations",
      label: "设备编队",
      value: String(formationCount),
      note: formationCount > 0 ? "运行中" : "未配置编队",
      tone: "muted",
    },
  ];
}
