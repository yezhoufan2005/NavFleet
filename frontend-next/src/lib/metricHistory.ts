/**
 * The 历史 half of the device 曲线 tab: the last few calendar days of a metric, each day
 * drawn as its own line overlaid on one shared 00:00–24:00 axis.
 *
 * Pulled out of the component and kept pure for the same reason the chart option builder is:
 * the branches worth pinning — bucket means, grouping a sample into the right calendar day,
 * mapping an instant to its time-of-day on a single reference axis — are exactly the ones a
 * component test cannot reach without a canvas. The component fetches, wires, and renders the
 * four states; everything numeric is here and is unit-tested directly.
 *
 * `nowMs` is injected rather than read from `Date.now()` so the day window is deterministic in
 * a test. The overlay trick: every point's x is a fixed reference midnight plus the sample's
 * local time-of-day, so an ECharts `type:"time"` axis pinned to `[refMidnight, refMidnight+1d]`
 * renders HH:mm and all days stack on the same 00:00–24:00 span regardless of their real date.
 */

import { toNumeric } from "@navfleet/shared";
import type { HistorySample } from "@navfleet/fleet-core";
import type {
  TimePoint,
  TimeSeries,
} from "@/components/charts/timeSeriesOption";

const DAY_MS = 86_400_000;

export interface MetricHistoryInput {
  samples: readonly HistorySample[];
  /** Reads the metric off one sample; a null / absent / non-numeric value drops the sample. */
  pick: (sample: HistorySample) => unknown;
  /** How many calendar days back to draw, including the day of `nowMs`. */
  days: number;
  /** Bucket width in minutes — the metric's mean within each bucket is one point. */
  bucketMinutes: number;
  /** Local wall-clock reference, injected so the day window stays testable. */
  nowMs: number;
}

export interface MetricHistoryTableRow {
  /** The bucket's start as local HH:mm. */
  time: string;
  /** The mean per day column, aligned with `dayLabels`; null where that day had no sample. */
  values: (number | null)[];
}

export interface MetricHistoryTable {
  /** Column headers, one per day as MM-DD, oldest → newest. */
  dayLabels: string[];
  /** One row per bucket any day filled, ordered by time-of-day. */
  rows: MetricHistoryTableRow[];
}

export interface MetricHistory {
  /** One line per day; names are the day labels, x overlays every day on one 00:00–24:00 axis. */
  series: TimeSeries[];
  /** The same numbers as a table — bucket rows × day columns — for the 数据表 view. */
  table: MetricHistoryTable;
  /** The time axis window to pin: local midnight of `nowMs`'s day, and one day on. */
  axisMin: number;
  axisMax: number;
}

/** Local midnight (00:00 in the runtime's timezone) of the day containing `ms`. */
const localMidnight = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** A day's MM-DD label in local time. */
const dayLabel = (midnightMs: number): string => {
  const date = new Date(midnightMs);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
};

/** A time-of-day (ms since local midnight) as HH:mm. */
const hourMinute = (timeOfDayMs: number): string => {
  const hour = Math.floor(timeOfDayMs / 3_600_000);
  const minute = Math.floor((timeOfDayMs % 3_600_000) / 60_000);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

interface Bucket {
  sum: number;
  count: number;
}

export const buildMetricHistory = ({
  samples,
  pick,
  days,
  bucketMinutes,
  nowMs,
}: MetricHistoryInput): MetricHistory => {
  const bucketMs = bucketMinutes * 60_000;
  const refMidnight = localMidnight(nowMs);

  // The target days, oldest → newest: `days - 1` back … today. Stepped by date arithmetic
  // rather than `refMidnight - offset * DAY_MS`, so a DST day that is not 24h long still lands
  // exactly on its own local midnight.
  const dayMidnights: number[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(refMidnight);
    date.setDate(date.getDate() - offset);
    dayMidnights.push(date.getTime());
  }
  const dayIndex = new Map(dayMidnights.map((ms, index) => [ms, index]));

  // One bucket map per day, keyed by bucket index within that day.
  const perDay = dayMidnights.map(() => new Map<number, Bucket>());

  for (const sample of samples) {
    const value = toNumeric(pick(sample));
    if (value === null) continue;
    const ts = new Date(sample.ts).getTime();
    if (!Number.isFinite(ts)) continue;
    const midnight = localMidnight(ts);
    const index = dayIndex.get(midnight);
    // Outside the window (older than `days` back, or — with clock skew — in the future).
    if (index === undefined) continue;
    const bucket = Math.floor((ts - midnight) / bucketMs);
    const byBucket = perDay[index]!;
    const cell = byBucket.get(bucket);
    if (cell) {
      cell.sum += value;
      cell.count += 1;
    } else {
      byBucket.set(bucket, { sum: value, count: 1 });
    }
  }

  const series: TimeSeries[] = dayMidnights.map((midnight, index) => {
    const points: TimePoint[] = [...perDay[index]!.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([bucket, { sum, count }]) => [
        refMidnight + bucket * bucketMs,
        sum / count,
      ]);
    return { name: dayLabel(midnight), points };
  });

  // The table shares the series' buckets: every bucket any day filled becomes a row, and each
  // day is a column, so the rows line up across days on one time-of-day index.
  const bucketIndices = new Set<number>();
  for (const byBucket of perDay) {
    for (const bucket of byBucket.keys()) bucketIndices.add(bucket);
  }
  const rows: MetricHistoryTableRow[] = [...bucketIndices]
    .sort((left, right) => left - right)
    .map((bucket) => ({
      time: hourMinute(bucket * bucketMs),
      values: perDay.map((byBucket) => {
        const cell = byBucket.get(bucket);
        return cell ? cell.sum / cell.count : null;
      }),
    }));

  return {
    series,
    table: { dayLabels: dayMidnights.map(dayLabel), rows },
    axisMin: refMidnight,
    axisMax: refMidnight + DAY_MS,
  };
};
