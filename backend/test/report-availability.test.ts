import { describe, it, expect } from "vitest";
import {
  buildAvailabilityPipeline,
  mapAvailabilityRows,
  OTHERS_DEVICE_ID,
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
      deviceIds: ["agv-1"],
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

  it("passes a month granularity straight through to $dateTrunc", () => {
    // Phase 18: 按月 is a valid granularity. `$dateTrunc` truncates to the month natively, so
    // the pipeline just forwards the unit — no new aggregation code, only the wider enum.
    const pipeline = buildAvailabilityPipeline({
      deviceIds: null,
      from: null,
      to: null,
      bucket: "month",
      timezone: TZ,
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
    });
    // First stage is the group, not a match — nothing to filter on.
    expect(pipeline[0]).toHaveProperty("$group");
    expect(pipeline.some((stage) => "$match" in stage)).toBe(false);
  });

  it("matches on device alone when only a device is given", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceIds: ["agv-9"],
      from: null,
      to: null,
      bucket: "day",
      timezone: TZ,
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
    });
    expect(pipeline[0]).toEqual({
      $match: { "meta.deviceId": { $in: ["agv-1", "agv-2"] } },
    });
  });

  it("sorts by device then bucket so the mapper can slice runs into series", () => {
    const pipeline = buildAvailabilityPipeline({
      deviceIds: null,
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

describe("mapAvailabilityRows — Top-N capping (Phase 18)", () => {
  const iso = (h: number) => new Date(Date.UTC(2026, 8, 1, h)).toISOString();
  // One bucket per device, each device's totalSamples set so the ranking is unambiguous.
  const rowsFor = (
    specs: Array<{ id: string; online: number; total: number; soc: number | null }>,
  ) =>
    specs.map<AvailabilityRow>((spec) => ({
      _id: { deviceId: spec.id, bucketStart: new Date(iso(0)) },
      onlineSamples: spec.online,
      totalSamples: spec.total,
      socMean: spec.soc,
      socMin: spec.soc,
    }));

  it("leaves the series untouched when the device count is within topN", () => {
    const report = mapAvailabilityRows(
      rowsFor([
        { id: "a", online: 1, total: 2, soc: 50 },
        { id: "b", online: 1, total: 2, soc: 50 },
      ]),
      "hour",
      { topN: 2 },
    );
    expect(report.devices.map((d) => d.deviceId)).toEqual(["a", "b"]);
  });

  it("keeps the top-N busiest devices and folds the rest into 「其余」", () => {
    const report = mapAvailabilityRows(
      rowsFor([
        { id: "big1", online: 90, total: 100, soc: 80 },
        { id: "big2", online: 40, total: 50, soc: 60 },
        { id: "small1", online: 5, total: 10, soc: 40 },
        { id: "small2", online: 2, total: 10, soc: 20 },
      ]),
      "hour",
      { topN: 2 },
    );
    expect(report.devices.map((d) => d.deviceId)).toEqual(["big1", "big2", OTHERS_DEVICE_ID]);

    const others = report.devices.find((d) => d.deviceId === OTHERS_DEVICE_ID)!;
    const bucket = others.buckets[0]!;
    // Frames add; the online ratio is recomputed over the merged totals.
    expect(bucket.onlineSamples).toBe(7);
    expect(bucket.totalSamples).toBe(20);
    expect(bucket.onlineRatio).toBeCloseTo(7 / 20);
    // soc is sample-weighted across the folded devices (40·10 + 20·10)/20 = 30, min is the lowest.
    expect(bucket.socMean).toBe(30);
    expect(bucket.socMin).toBe(20);
  });

  it("preserves the fleet-weighted online total after folding (fold is lossless)", () => {
    const specs = [
      { id: "a", online: 90, total: 100, soc: 80 },
      { id: "b", online: 40, total: 50, soc: 60 },
      { id: "c", online: 5, total: 10, soc: 40 },
      { id: "d", online: 2, total: 10, soc: 20 },
    ];
    const sum = (report: ReturnType<typeof mapAvailabilityRows>) =>
      report.devices
        .flatMap((device) => device.buckets)
        .reduce(
          (acc, bucket) => ({
            online: acc.online + bucket.onlineSamples,
            total: acc.total + bucket.totalSamples,
          }),
          { online: 0, total: 0 },
        );
    const full = sum(mapAvailabilityRows(rowsFor(specs), "hour"));
    const capped = sum(mapAvailabilityRows(rowsFor(specs), "hour", { topN: 2 }));
    expect(capped).toEqual(full);
  });
});
