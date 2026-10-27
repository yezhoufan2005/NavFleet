import { describe, it, expect } from "vitest";
import {
  buildAvailabilityPipeline,
  mapAvailabilityRows,
  type AvailabilityRow,
} from "../src/reports/availabilityPipeline";

/**
 * The availability/battery aggregation, as two pure functions (Phase 17A-2).
 *
 * The bugs a machine check waves through: bucketing in UTC instead of the deployment timezone, a
 * missing soc counted as 0 in the mean, an `onlineRatio` that divides by zero, device rows that
 * bleed into the wrong series. The persistence wiring test proves the pipeline reaches
 * `telemetry_ts.aggregate`; here each function is checked on its own.
 */

const TZ = "Asia/Shanghai";
const HORIZON = new Date("2026-09-02T00:00:00Z");
const TIMING = { maxGapMs: 60_000, horizon: HORIZON };

describe("buildAvailabilityPipeline", () => {
  it("filters by device and ts range, groups by device × truncated bucket", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2026-09-02T00:00:00Z");
    const pipeline = buildAvailabilityPipeline({
      deviceIds: ["agv-1"],
      from,
      to,
      bucket: "hour",
      timezone: TZ,
      ...TIMING,
    });

    expect(pipeline[0]).toEqual({
      $match: { "meta.deviceId": "agv-1", ts: { $gte: from, $lte: to } },
    });
    const group = pipeline.find((stage) => "$group" in stage)!.$group as {
      _id: { bucketStart: { $dateTrunc: { unit: string; timezone: string } } };
    };
    // The bucket boundary is cut in the configured timezone at the requested granularity —
    // an "hour"/"day" that follows local midnight, not UTC.
    expect(group._id.bucketStart.$dateTrunc.unit).toBe("hour");
    expect(group._id.bucketStart.$dateTrunc.timezone).toBe(TZ);
  });

  it("passes a month granularity straight through to $dateTrunc", () => {
    // Phase 18: 按月 is a valid granularity. `$dateTrunc` truncates to the month natively, so
    // the pipeline just forwards the unit — no new aggregation code, only the wider enum.
    const pipeline = buildAvailabilityPipeline({
      deviceIds: null,
      from: null,
      to: null,
      bucket: "month",
      timezone: TZ,
      ...TIMING,
    });
    const group = pipeline.find((stage) => "$group" in stage)!.$group as {
      _id: { bucketStart: { $dateTrunc: { unit: string; timezone: string } } };
    };
    expect(group._id.bucketStart.$dateTrunc.unit).toBe("month");
  });

  it("omits the match entirely for the whole fleet over the whole window", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceIds: null,
      from: null,
      to: null,
      bucket: "day",
      timezone: TZ,
      ...TIMING,
    });
    // First stage is the field projection, not a match — nothing to filter on.
    expect(pipeline[0]).toHaveProperty("$project");
    expect(pipeline.some((stage) => "$match" in stage)).toBe(false);
  });

  it("matches on device alone when only a device is given", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceIds: ["agv-9"],
      from: null,
      to: null,
      bucket: "day",
      timezone: TZ,
      ...TIMING,
    });
    expect(pipeline[0]).toEqual({ $match: { "meta.deviceId": "agv-9" } });
  });

  it("matches several devices with $in, keeping each its own series", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceIds: ["agv-1", "agv-2"],
      from: null,
      to: null,
      bucket: "day",
      timezone: TZ,
      ...TIMING,
    });
    expect(pipeline[0]).toEqual({
      $match: { "meta.deviceId": { $in: ["agv-1", "agv-2"] } },
    });
  });

  it("weights by time: each frame covers until the next frame, capped at the offline threshold", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceIds: null,
      from: null,
      to: null,
      bucket: "hour",
      timezone: TZ,
      ...TIMING,
    });
    const windowStage: unknown = pipeline.find(
      (stage) => "$setWindowFields" in stage,
    )!.$setWindowFields;
    expect(windowStage).toMatchObject({
      partitionBy: "$meta.deviceId",
      sortBy: { ts: 1 },
      output: { nextTs: { $shift: { output: "$ts", by: 1 } } },
    });
    const covered = JSON.stringify(pipeline.find((stage) => "$addFields" in stage));
    // The cap is the offline threshold; the last frame runs to the horizon (not to infinity).
    expect(covered).toContain("60000");
    expect(covered).toContain(HORIZON.toISOString());
    const group = pipeline.find((stage) => "$group" in stage)!.$group as Record<string, unknown>;
    expect(group.onlineMs).toEqual({
      $sum: { $cond: ["$measurements.online", "$coveredMs", 0] },
    });
  });

  it("sorts by device then bucket so the mapper can slice runs into series", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceIds: null,
      from: null,
      to: null,
      bucket: "day",
      timezone: TZ,
      ...TIMING,
    });
    expect(pipeline.at(-1)).toEqual({
      $sort: { "_id.deviceId": 1, "_id.bucketStart": 1 },
    });
  });
});

describe("mapAvailabilityRows", () => {
  const iso = (h: number) => new Date(Date.UTC(2026, 8, 1, h)).toISOString();
  const HOUR = 3_600_000;
  const at = (h: number) => new Date(iso(h));
  const row = (
    deviceId: string,
    h: number,
    extra: Partial<AvailabilityRow> = {},
  ): AvailabilityRow => ({
    _id: { deviceId, bucketStart: at(h) },
    bucketEnd: at(h + 1),
    onlineSamples: 0,
    totalSamples: 0,
    onlineMs: 0,
    ...extra,
  });
  const WINDOW = { from: at(0), horizon: at(24) };

  it("slices contiguous device runs into one series each, ratio = online time / bucket time", () => {
    const rows: AvailabilityRow[] = [
      row("agv-1", 0, {
        onlineSamples: 8,
        totalSamples: 10,
        onlineMs: 0.8 * HOUR,
        socMean: 80,
        socMin: 60,
      }),
      row("agv-1", 1, {
        onlineSamples: 10,
        totalSamples: 10,
        onlineMs: HOUR,
        socMean: 75,
        socMin: 70,
      }),
      row("agv-2", 0, { onlineSamples: 0, totalSamples: 4, socMean: null, socMin: null }),
    ];

    const report = mapAvailabilityRows(rows, "hour", WINDOW);
    expect(report.available).toBe(true);
    expect(report.bucket).toBe("hour");
    expect(report.devices).toHaveLength(2);

    const [first, second] = report.devices;
    expect(first!.deviceId).toBe("agv-1");
    expect(first!.buckets).toHaveLength(2);
    expect(first!.buckets[0]).toEqual({
      bucketStart: iso(0),
      onlineSamples: 8,
      totalSamples: 10,
      onlineSeconds: 2880,
      spanSeconds: 3600,
      onlineRatio: 0.8,
      socMean: 80,
      socMin: 60,
    });
    // A device that never reported online is a real answer (ratio 0), and a null soc stays null.
    expect(second!.buckets[0]).toMatchObject({ onlineRatio: 0, socMean: null, socMin: null });
  });

  it("counts silence as offline: one online frame-hour in a day is ~4%, not 100%", () => {
    // Every frame said online, but they only cover one hour of the 24-hour day bucket.
    const rows = [
      {
        ...row("agv-1", 0, { onlineSamples: 3600, totalSamples: 3600, onlineMs: HOUR }),
        bucketEnd: at(24),
      },
    ];
    const bucket = mapAvailabilityRows(rows, "day", WINDOW).devices[0]!.buckets[0]!;
    expect(bucket.onlineRatio).toBeCloseTo(1 / 24, 9);
  });

  it("measures the current bucket only up to the horizon, and the first only from `from`", () => {
    const rows = [row("agv-1", 10, { onlineMs: 0.5 * HOUR })];
    // Window starts at 10:30 and ends at 10:45: a 15-minute span, fully covered.
    const window = {
      from: new Date(at(10).getTime() + 0.5 * HOUR),
      horizon: new Date(at(10).getTime() + 0.75 * HOUR),
    };
    const bucket = mapAvailabilityRows(rows, "hour", window).devices[0]!.buckets[0]!;
    expect(bucket.spanSeconds).toBe(900);
    // Coverage beyond the span (a gap spilling over the edge) is clamped to 100%.
    expect(bucket.onlineRatio).toBe(1);
  });

  it("guards the ratio against an empty span instead of dividing by zero", () => {
    const rows = [row("agv-1", 30)];
    expect(mapAvailabilityRows(rows, "hour", WINDOW).devices[0]!.buckets[0]!.onlineRatio).toBe(0);
  });

  it("rounds soc to three places so a float mean does not leak 79.99999996", () => {
    const rows = [
      row("agv-1", 0, {
        onlineSamples: 1,
        totalSamples: 3,
        socMean: 79.999999996,
        socMin: 12.3456,
      }),
    ];
    const bucket = mapAvailabilityRows(rows, "hour", WINDOW).devices[0]!.buckets[0]!;
    expect(bucket.socMean).toBe(80);
    expect(bucket.socMin).toBe(12.346);
  });

  it("returns an empty device list for no rows (the honest-empty shape without matches)", () => {
    const report = mapAvailabilityRows([], "day", WINDOW);
    expect(report).toEqual({ bucket: "day", devices: [], available: true });
  });
});
