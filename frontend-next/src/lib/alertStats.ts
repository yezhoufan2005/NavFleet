import type { AlertRecord } from "@navfleet/fleet-core";

/**
 * Pure statistics over a set of alert records (Phase 16B).
 *
 * Kept out of the view and free of `Date.now()` / DOM so every branch is unit-testable by
 * feeding records in and asserting the numbers out. The backend has no aggregation layer yet
 * (that is Phase 17A), so 16B computes these client-side over what `getAlerts` returns —
 * bounded by the endpoint's 500-row cap, which the view states in words when it bites.
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
  /** Acknowledged / total, in [0,1]; null when there are no records. */
  ackRate: number | null;
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
  let acked = 0;

  for (const record of records) {
    bySeverity[severityOf(record)] += 1;

    const deviceId = String(record.deviceId ?? "");
    if (deviceId) {
      const existing = deviceCounts.get(deviceId);
      if (existing) {
        existing.count += 1;
      } else {
        deviceCounts.set(deviceId, {
          deviceId,
          deviceName: String(record.deviceName || deviceId),
          count: 1,
        });
      }
    }

    const onset = onsetOf(record);
    if (Number.isFinite(onset)) {
      const day = localDay(onset);
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    }

    if (record.ackedBy) acked += 1;

    // A duration exists only when the alert has both an onset and a clear time.
    const cleared = record.clearedAt
      ? Date.parse(String(record.clearedAt))
      : NaN;
    if (
      Number.isFinite(onset) &&
      Number.isFinite(cleared) &&
      cleared >= onset
    ) {
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
    ackRate: total > 0 ? acked / total : null,
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
