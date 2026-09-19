import { describe, it, expect } from "vitest";
import {
  buildAlertStatsPipeline,
  mapAlertStatsFacet,
  type AlertStatsFacet,
} from "../src/reports/alertStatsPipeline";

/**
 * The alert-stats aggregation, as two pure functions (Phase 17A).
 *
 * These are the parts a machine check cannot catch: a `$group` key pointed at the wrong field,
 * a day bucket cut in UTC instead of the deployment timezone, a median that reads the wrong
 * element, an unknown severity that silently invents a fourth bucket. The persistence wiring
 * test (persistence-mongo) proves the pipeline reaches `alerts.aggregate` and the result reaches
 * the mapper; here we prove the pipeline and the mapper are individually correct.
 */

const TZ = "Asia/Shanghai";

/** Pull the `$facet` stage's sub-pipelines out of a built pipeline. */
const facetOf = (pipeline: Record<string, unknown>[]): Record<string, unknown[]> =>
  pipeline.find((stage) => "$facet" in stage)!.$facet as Record<string, unknown[]>;

describe("buildAlertStatsPipeline", () => {
  it("puts a firstSeenAt range match before the facet when both bounds are given", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2026-09-30T00:00:00Z");
    const pipeline = buildAlertStatsPipeline({ from, to, topN: 8, timezone: TZ });

    // The range is on firstSeenAt (onset), the Date field upsertAlerts writes — not on `ts`,
    // which the collection stores as a string and `$dateTrunc`/`$dateDiff` cannot read.
    expect(pipeline[0]).toEqual({ $match: { firstSeenAt: { $gte: from, $lte: to } } });
    expect(pipeline[1]).toHaveProperty("$facet");
  });

  it("emits a half-open range when only one bound is given", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const pipeline = buildAlertStatsPipeline({ from, to: null, topN: 8, timezone: TZ });
    expect(pipeline[0]).toEqual({ $match: { firstSeenAt: { $gte: from } } });
  });

  it("omits the match entirely with no bounds — the facet scans the whole TTL window", () => {
    const pipeline = buildAlertStatsPipeline({ from: null, to: null, topN: 8, timezone: TZ });
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0]).toHaveProperty("$facet");
  });

  it("threads topN into the Top-N limit and keeps a stable id tiebreaker", () => {
    const pipeline = buildAlertStatsPipeline({ from: null, to: null, topN: 3, timezone: TZ });
    const topDevices = facetOf(pipeline).topDevices as Record<string, unknown>[];
    expect(topDevices).toContainEqual({ $limit: 3 });
    // A second sort key on _id: without it, devices tied on count reorder run to run and the
    // Top-N cut point drifts.
    expect(topDevices).toContainEqual({ $sort: { count: -1, _id: 1 } });
  });

  it("cuts day buckets in the configured timezone, not UTC", () => {
    const pipeline = buildAlertStatsPipeline({ from: null, to: null, topN: 8, timezone: TZ });
    const daily = facetOf(pipeline).daily as Record<string, unknown>[];
    const group = daily[0]!.$group as { _id: { $dateToString: { timezone: string } } };
    expect(group._id.$dateToString.timezone).toBe(TZ);
  });

  it("counts a duration only for a genuinely-cleared alert", () => {
    const pipeline = buildAlertStatsPipeline({ from: null, to: null, topN: 8, timezone: TZ });
    const durations = facetOf(pipeline).durations as Record<string, unknown>[];
    // `$type: date` excludes active alerts, which have no clearedAt field at all in Mongo.
    expect(durations[0]).toEqual({
      $match: { clearedAt: { $type: "date" }, firstSeenAt: { $type: "date" } },
    });
  });
});

describe("mapAlertStatsFacet", () => {
  const full: AlertStatsFacet = {
    bySeverity: [
      { _id: "critical", count: 2 },
      { _id: "warning", count: 3 },
      { _id: "weird", count: 1 },
    ],
    topDevices: [
      { _id: "agv-1", count: 4 },
      { _id: "agv-2", count: 1 },
    ],
    daily: [{ _id: "2026-09-01", count: 5 }],
    totals: [{ total: 6, acked: 3 }],
    durations: [{ values: [3000, 1000, 2000] }],
  };

  it("maps a full facet, folding an unknown severity into notice", () => {
    const report = mapAlertStatsFacet(full);
    expect(report.available).toBe(true);
    expect(report.total).toBe(6);
    // 2 critical + 3 warning + 1 unknown → the unknown is the least severe bucket, not a 4th.
    expect(report.bySeverity).toEqual({ critical: 2, warning: 3, notice: 1 });
    expect(report.topDevices).toEqual([
      { deviceId: "agv-1", count: 4 },
      { deviceId: "agv-2", count: 1 },
    ]);
    expect(report.daily).toEqual([{ day: "2026-09-01", count: 5 }]);
    expect(report.ackRate).toBe(0.5);
  });

  it("computes mean and median over unsorted duration samples", () => {
    // Three samples 1000/2000/3000 → mean 2000, median (middle after sort) 2000.
    const report = mapAlertStatsFacet(full);
    expect(report.duration).toEqual({ count: 3, meanMs: 2000, p50Ms: 2000 });
  });

  it("averages the two middle samples for an even count", () => {
    const report = mapAlertStatsFacet({ durations: [{ values: [10, 20, 30, 40] }] });
    // (20 + 30) / 2 = 25.
    expect(report.duration.p50Ms).toBe(25);
    expect(report.duration.meanMs).toBe(25);
  });

  it("returns nulls, not zeros, when there is nothing to average or divide", () => {
    // An empty facet (no docs matched): total 0 must give ackRate null (not 0/0 = NaN), and
    // no duration samples must give null mean/median — a "no data" answer, not "0 ms".
    const report = mapAlertStatsFacet({});
    expect(report.total).toBe(0);
    expect(report.bySeverity).toEqual({ critical: 0, warning: 0, notice: 0 });
    expect(report.topDevices).toEqual([]);
    expect(report.daily).toEqual([]);
    expect(report.ackRate).toBeNull();
    expect(report.duration).toEqual({ count: 0, meanMs: null, p50Ms: null });
    // Mapping never sets available:false — that is the persistence layer's call for no-Mongo.
    expect(report.available).toBe(true);
  });
});
