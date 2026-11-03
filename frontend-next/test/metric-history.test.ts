import { describe, it, expect } from "vitest";
import type { HistorySample } from "@navfleet/fleet-core";
import { buildMetricHistory } from "@/lib/metricHistory";

/**
 * The pure core of the 曲线 tab's 历史 view: last-N-days bucketing and the single-axis
 * overlay. jsdom has no canvas, so the branches worth protecting — bucket means, grouping a
 * sample into the right calendar day, mapping an instant to its time-of-day on one reference
 * axis — are tested here on the numbers, not through a chart.
 *
 * `nowMs` is injected, and vitest pins TZ to Asia/Shanghai (UTC+8), so every `+08:00`
 * timestamp below lands on the local day its text reads.
 */
const NOW = new Date("2026-11-03T12:00:00+08:00").getTime();
const REF_MIDNIGHT = new Date("2026-11-03T00:00:00+08:00").getTime();
const BUCKET_MS = 10 * 60_000;

/** A sample carrying one value under `v`; the helper's `pick` reads it back. */
const sample = (ts: string, v: unknown): HistorySample => ({ ts, v });

const build = (samples: HistorySample[], days = 3) =>
  buildMetricHistory({
    samples,
    pick: (s) => (s as unknown as { v: unknown }).v,
    days,
    bucketMinutes: 10,
    nowMs: NOW,
  });

describe("buildMetricHistory", () => {
  it("draws one line per calendar day, oldest first, each named MM-DD", () => {
    const result = build([
      sample("2026-11-01T08:00:00+08:00", 1),
      sample("2026-11-02T08:00:00+08:00", 2),
      sample("2026-11-03T09:00:00+08:00", 3),
    ]);

    expect(result.series.map((s) => s.name)).toEqual([
      "11-01",
      "11-02",
      "11-03",
    ]);
    expect(result.table.dayLabels).toEqual(["11-01", "11-02", "11-03"]);
  });

  it("averages the samples that fall in one bucket on one day", () => {
    const result = build([
      sample("2026-11-01T08:05:00+08:00", 10),
      sample("2026-11-01T08:06:00+08:00", 20),
    ]);

    // 08:00–08:10 is bucket 48; its one point carries the mean of the two readings.
    const points = result.series[0]!.points;
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual([REF_MIDNIGHT + 48 * BUCKET_MS, 15]);
  });

  it("lands the same time-of-day on different days at the same x", () => {
    // The overlay trick: x is a fixed reference midnight plus the time-of-day, so three days
    // stack on one 00:00–24:00 span. 08:05 on either day must share an x.
    const result = build([
      sample("2026-11-01T08:05:00+08:00", 1),
      sample("2026-11-02T08:05:00+08:00", 2),
    ]);

    expect(result.series[0]!.points[0]![0]).toBe(
      result.series[1]!.points[0]![0],
    );
    expect(result.series[0]!.points[0]![0]).toBe(REF_MIDNIGHT + 48 * BUCKET_MS);
  });

  it("drops a null, absent or non-numeric reading instead of plotting it at 0", () => {
    const result = build([
      sample("2026-11-03T08:00:00+08:00", 5),
      sample("2026-11-03T08:10:00+08:00", null),
      sample("2026-11-03T08:20:00+08:00", undefined),
      sample("2026-11-03T08:30:00+08:00", "nope"),
    ]);

    expect(result.series[2]!.points).toEqual([
      [REF_MIDNIGHT + 48 * BUCKET_MS, 5],
    ]);
  });

  it("excludes a sample older than the window or dated in the future", () => {
    const result = build([
      sample("2026-10-30T08:00:00+08:00", 1), // four days back — out
      sample("2026-11-02T08:00:00+08:00", 2), // in
      sample("2026-11-04T08:00:00+08:00", 3), // tomorrow — out
    ]);

    const counts = result.series.map((s) => s.points.length);
    expect(counts).toEqual([0, 1, 0]);
  });

  it("skips a sample whose timestamp does not parse", () => {
    const result = build([
      sample("not a date", 9),
      sample("2026-11-03T08:00:00+08:00", 7),
    ]);

    expect(result.series[2]!.points).toHaveLength(1);
  });

  it("keeps every day's column even with no samples at all", () => {
    const result = build([]);

    expect(result.series).toHaveLength(3);
    expect(result.series.every((s) => s.points.length === 0)).toBe(true);
    expect(result.table.dayLabels).toEqual(["11-01", "11-02", "11-03"]);
    expect(result.table.rows).toEqual([]);
  });

  it("lays the table out as bucket rows × day columns, null where a day lacks the bucket", () => {
    const result = build([
      sample("2026-11-01T08:05:00+08:00", 10),
      sample("2026-11-01T08:06:00+08:00", 20),
      sample("2026-11-02T08:05:00+08:00", 30),
      sample("2026-11-03T09:00:00+08:00", 40),
    ]);

    expect(result.table.rows).toEqual([
      { time: "08:00", values: [15, 30, null] },
      { time: "09:00", values: [null, null, 40] },
    ]);
  });

  it("pins the axis window to the reference day", () => {
    const result = build([]);
    expect(result.axisMin).toBe(REF_MIDNIGHT);
    expect(result.axisMax).toBe(REF_MIDNIGHT + 86_400_000);
  });

  it("honours a different day count", () => {
    const result = build(
      [
        sample("2026-11-02T08:00:00+08:00", 1),
        sample("2026-11-03T08:00:00+08:00", 2),
      ],
      2,
    );
    expect(result.series.map((s) => s.name)).toEqual(["11-02", "11-03"]);
  });
});
