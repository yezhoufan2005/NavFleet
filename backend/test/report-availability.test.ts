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

describe("buildAvailabilityPipeline", () => {
  it("filters by device and ts range, groups by device × truncated bucket", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2026-09-02T00:00:00Z");
    const pipeline = buildAvailabilityPipeline({
      deviceId: "agv-1",
      from,
      to,
      bucket: "hour",
      timezone: TZ,
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

  it("omits the match entirely for the whole fleet over the whole window", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceId: null,
      from: null,
      to: null,
      bucket: "day",
      timezone: TZ,
    });
    // First stage is the group, not a match — nothing to filter on.
    expect(pipeline[0]).toHaveProperty("$group");
    expect(pipeline.some((stage) => "$match" in stage)).toBe(false);
  });

  it("matches on device alone when only a device is given", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceId: "agv-9",
      from: null,
      to: null,
      bucket: "day",
      timezone: TZ,
    });
    expect(pipeline[0]).toEqual({ $match: { "meta.deviceId": "agv-9" } });
  });

  it("sorts by device then bucket so the mapper can slice runs into series", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceId: null,
      from: null,
      to: null,
      bucket: "day",
      timezone: TZ,
    });
    expect(pipeline.at(-1)).toEqual({
      $sort: { "_id.deviceId": 1, "_id.bucketStart": 1 },
    });
  });
});

describe("mapAvailabilityRows", () => {
  const iso = (h: number) => new Date(Date.UTC(2026, 8, 1, h)).toISOString();

  it("slices contiguous device runs into one series each, computing onlineRatio", () => {
    const rows: AvailabilityRow[] = [
      {
        _id: { deviceId: "agv-1", bucketStart: new Date(iso(0)) },
        onlineSamples: 8,
        totalSamples: 10,
        socMean: 80,
        socMin: 60,
      },
      {
        _id: { deviceId: "agv-1", bucketStart: new Date(iso(1)) },
        onlineSamples: 10,
        totalSamples: 10,
        socMean: 75,
        socMin: 70,
      },
      {
        _id: { deviceId: "agv-2", bucketStart: new Date(iso(0)) },
        onlineSamples: 0,
        totalSamples: 4,
        socMean: null,
        socMin: null,
      },
    ];

    const report = mapAvailabilityRows(rows, "hour");
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
      onlineRatio: 0.8,
      socMean: 80,
      socMin: 60,
    });
    // A device that never reported online is a real answer (ratio 0), and a null soc stays null.
    expect(second!.buckets[0]).toMatchObject({ onlineRatio: 0, socMean: null, socMin: null });
  });

  it("guards the ratio against an empty bucket instead of dividing by zero", () => {
    const rows: AvailabilityRow[] = [
      {
        _id: { deviceId: "agv-1", bucketStart: new Date(iso(0)) },
        onlineSamples: 0,
        totalSamples: 0,
      },
    ];
    expect(mapAvailabilityRows(rows, "day").devices[0]!.buckets[0]!.onlineRatio).toBe(0);
  });

  it("rounds soc to three places so a float mean does not leak 79.99999996", () => {
    const rows: AvailabilityRow[] = [
      {
        _id: { deviceId: "agv-1", bucketStart: new Date(iso(0)) },
        onlineSamples: 1,
        totalSamples: 3,
        socMean: 79.999999996,
        socMin: 12.3456,
      },
    ];
    const bucket = mapAvailabilityRows(rows, "hour").devices[0]!.buckets[0]!;
    expect(bucket.socMean).toBe(80);
    expect(bucket.socMin).toBe(12.346);
  });

  it("returns an empty device list for no rows (the honest-empty shape without matches)", () => {
    const report = mapAvailabilityRows([], "day");
    expect(report).toEqual({ bucket: "day", devices: [], available: true });
  });
});
