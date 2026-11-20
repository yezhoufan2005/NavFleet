import type { AlertRecord } from "@navfleet/fleet-core";

/**
 * Pure statistics over a set of alert records.
 *
 * Kept out of the view and free of `Date.now()` / DOM so every branch is unit-testable by
 * feeding records in and asserting the numbers out. The server aggregates too
 * (`/api/reports/alerts`, which the 报表 page reads, over the whole window); 消息史 computes these
 * client-side over the records it already holds from `getAlerts`, so its charts match its list —
 * bounded by the endpoint's row cap, which the view states in words when it bites.
 */
export type Severity = "critical" | "warning" | "notice";

const SEVERITIES: readonly Severity[] = ["critical", "warning", "notice"];

export interface SeverityCounts {
  critical: number;
  warning: number;
  notice: number;
}

export interface DeviceCount {
  deviceId: string;
  deviceName: string;
  count: number;
  /** Per-severity split of this device's count, for a stacked Top-N bar. Sums to `count`. */
  bySeverity: SeverityCounts;
}

export interface DailyCount {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  count: number;
}

export interface DurationStats {
  /** How many records had both an onset and a clear time (so a duration at all). */
  count: number;
  meanMs: number | null;
  medianMs: number | null;
}

export interface AlertStats {
  total: number;
  bySeverity: SeverityCounts;
  topDevices: DeviceCount[];
  daily: DailyCount[];
  /**
   * Disposition rates over the records, each ÷ total (null when there are no records), matching
   * the server (`AlertStatsReport`). Disjoint; the remainder is still-open-unhandled:
   * claimRate = claimed-and-not-ignored, ignoreRate = ignored, autoRecoverRate = cleared with
   * neither (auto-recovered, no one involved).
   */
  claimRate: number | null;
  ignoreRate: number | null;
  autoRecoverRate: number | null;
  duration: DurationStats;
}

/** Normalise a record's severity to a known bucket, defaulting to the least severe. */
export const severityOf = (record: AlertRecord): Severity =>
  SEVERITIES.includes(record.severity) ? record.severity : "notice";

/** Onset in epoch ms: `firstSeenAt` when present, else `ts`; NaN if neither parses. */
const onsetOf = (record: AlertRecord): number => {
  const raw = record.firstSeenAt ?? record.ts ?? "";
  return Date.parse(String(raw));
};

/** Local `YYYY-MM-DD` for an epoch-ms instant. */
const localDay = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
};

export interface AlertStatsOptions {
  /** How many devices the Top-N ranking keeps. */
  topN?: number;
}

export const computeAlertStats = (
  records: readonly AlertRecord[],
  { topN = 8 }: AlertStatsOptions = {},
): AlertStats => {
  const bySeverity: SeverityCounts = { critical: 0, warning: 0, notice: 0 };
  const deviceCounts = new Map<string, DeviceCount>();
  const dayCounts = new Map<string, number>();
  const durations: number[] = [];
  let claimed = 0;
  let ignored = 0;
  let autoRecovered = 0;

  for (const record of records) {
    bySeverity[severityOf(record)] += 1;

    const deviceId = String(record.deviceId ?? "");
    if (deviceId) {
      const severity = severityOf(record);
      const existing = deviceCounts.get(deviceId);
      if (existing) {
        existing.count += 1;
        existing.bySeverity[severity] += 1;
      } else {
        const perSeverity: SeverityCounts = {
          critical: 0,
          warning: 0,
          notice: 0,
        };
        perSeverity[severity] += 1;
        deviceCounts.set(deviceId, {
          deviceId,
          deviceName: String(record.deviceName || deviceId),
          count: 1,
          bySeverity: perSeverity,
        });
      }
    }

    const onset = onsetOf(record);
    if (Number.isFinite(onset)) {
      const day = localDay(onset);
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    }

    // A duration exists only when the alert has both an onset and a clear time.
    const cleared = record.clearedAt
      ? Date.parse(String(record.clearedAt))
      : NaN;
    const isCleared = Number.isFinite(cleared);

    // Disposition tallies, disjoint and matching the server: ignore supersedes a claim, and an
    // occurrence that cleared with neither disposition auto-recovered with no one involved.
    if (record.ignoredBy) ignored += 1;
    else if (record.claimedBy) claimed += 1;
    else if (isCleared) autoRecovered += 1;

    if (Number.isFinite(onset) && isCleared && cleared >= onset) {
      durations.push(cleared - onset);
    }
  }

  const topDevices = [...deviceCounts.values()]
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.deviceName.localeCompare(right.deviceName, "zh-Hans-CN"),
    )
    .slice(0, topN);

  const daily = [...dayCounts.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((left, right) => left.day.localeCompare(right.day));

  const total = records.length;
  const mean =
    durations.length > 0
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : null;

  return {
    total,
    bySeverity,
    topDevices,
    daily,
    claimRate: total > 0 ? claimed / total : null,
    ignoreRate: total > 0 ? ignored / total : null,
    autoRecoverRate: total > 0 ? autoRecovered / total : null,
    duration: {
      count: durations.length,
      meanMs: mean,
      medianMs: median(durations),
    },
  };
};

/** Human duration from milliseconds: `2小时3分` / `5分12秒` / `8秒`; null → `--`. */
export const formatDurationMs = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "--";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
};

/** One cell of the 日期 × 小时 onset heatmap. `dateIndex` indexes the row's date list; `hour` 0…23. */
export interface DateHourCell {
  dateIndex: number;
  hour: number;
  count: number;
}

/**
 * Bucket message onsets into a (date × local hour) grid — one row per calendar day the data spans,
 * newest day first, every hour 0…23 present (0 included) so the grid is dense. Days between the
 * first and last onset with no messages stay as blank rows, so the time axis is continuous rather
 * than skipping quiet days. Pure and clock-free (dates come from the records); returns the ordered
 * `MM-DD` day labels and the max cell for the sequential colour scale.
 */
export const dateHourHeatmap = (
  records: readonly AlertRecord[],
): { dates: string[]; cells: DateHourCell[]; max: number } => {
  // Local-midnight day key, so an onset is filed under the day the operator saw it.
  const dayStart = (ms: number): number => {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const perDay = new Map<number, number[]>(); // day-start ms → 24 hourly counts
  let minDay = Number.POSITIVE_INFINITY;
  let maxDay = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    const onset = onsetOf(record);
    if (!Number.isFinite(onset)) continue;
    const key = dayStart(onset);
    const hour = new Date(onset).getHours();
    const row = perDay.get(key) ?? new Array<number>(24).fill(0);
    row[hour] = (row[hour] ?? 0) + 1;
    perDay.set(key, row);
    if (key < minDay) minDay = key;
    if (key > maxDay) maxDay = key;
  }
  if (!Number.isFinite(minDay)) return { dates: [], cells: [], max: 0 };

  const dates: string[] = [];
  const cells: DateHourCell[] = [];
  let max = 0;
  // Walk newest day → oldest (one calendar day at a time, DST-safe), so row 0 is the newest; the
  // y-axis then renders it at the top with `inverse`. `dateIndex` is the row's position.
  const cursor = new Date(maxDay);
  let dateIndex = 0;
  while (cursor.getTime() >= minDay) {
    const mm = String(cursor.getMonth() + 1).padStart(2, "0");
    const dd = String(cursor.getDate()).padStart(2, "0");
    dates.push(`${mm}-${dd}`);
    const row = perDay.get(cursor.getTime()) ?? [];
    for (let hour = 0; hour < 24; hour += 1) {
      const count = row[hour] ?? 0;
      cells.push({ dateIndex, hour, count });
      if (count > max) max = count;
    }
    cursor.setDate(cursor.getDate() - 1);
    dateIndex += 1;
  }
  return { dates, cells, max };
};
