import { describe, it, expect } from "vitest";
import {
  HOUR_MS,
  ROLLUP_SETTLE_MS,
  buildHourRollupPipeline,
  buildRollupReportPipeline,
  closedHours,
  floorToHour,
  planAvailabilityWindow,
  timezoneOffsetMs,
} from "../src/reports/telemetryRollup";
import { mergeAvailabilityRows, type AvailabilityRow } from "../src/reports/availabilityPipeline";

/**
 * The hourly telemetry summary, as pure functions. What a machine check waves through: hours cut
 * in UTC for a timezone whose offset is not whole hours, an edge hour served from the summary
 * although the window only covers part of it, the summary's last frames standing for silence
 * past the hour, and a merged bucket whose soc mean is an average of averages. The end-to-end
 * equality of the two report paths is checked against a real MongoDB in development; these pin
 * the pieces it is built from.
 */

const TZ = "Asia/Shanghai";
const at = (iso: string): number => Date.parse(iso);

describe("floorToHour / timezoneOffsetMs", () => {
  it("cuts hours on the local clock", () => {
    expect(timezoneOffsetMs(at("2026-09-01T03:20:00Z"), TZ)).toBe(8 * HOUR_MS);
    expect(new Date(floorToHour(at("2026-09-01T03:59:59Z"), TZ)).toISOString()).toBe(
      "2026-09-01T03:00:00.000Z",
    );
  });

  it("follows a half-hour offset, so local days are whole numbers of these hours", () => {
    // Asia/Kolkata is UTC+05:30: its hours start at :30 UTC.
    expect(new Date(floorToHour(at("2026-09-01T03:20:00Z"), "Asia/Kolkata")).toISOString()).toBe(
      "2026-09-01T02:30:00.000Z",
    );
  });
});

describe("buildHourRollupPipeline", () => {
  const hourStart = new Date("2026-09-01T03:00:00Z");
  const pipeline = buildHourRollupPipeline({ hourStart, maxGapMs: 90_000, timezone: TZ });

  it("reads past the hour by the offline threshold, then keeps only the hour's own frames", () => {
    expect(pipeline[0]).toEqual({
      $match: { ts: { $gte: hourStart, $lt: new Date("2026-09-01T04:01:30Z") } },
    });
    const windowIndex = pipeline.findIndex((stage) => "$setWindowFields" in stage);
    // The trim comes after the successor is known, not before.
    expect(pipeline[windowIndex + 1]).toEqual({
      $match: { ts: { $lt: new Date("2026-09-01T04:00:00Z") } },
    });
  });

  it("stores sums and counts, keyed by device and hour, with the parameters it was built under", () => {
    const project = pipeline.find((stage) => "$project" in stage && "hour" in stage.$project)!
      .$project as Record<string, unknown>;
    expect(project).toMatchObject({
      hour: hourStart,
      maxGapMs: { $literal: 90_000 },
      timezone: { $literal: TZ },
      socSum: 1,
      socCount: 1,
    });
    expect(pipeline.at(-1)).toMatchObject({ $merge: { into: "telemetry_hourly", on: "_id" } });
  });
});

describe("buildRollupReportPipeline", () => {
  it("reads exactly the planned hours and re-buckets them in the report timezone", () => {
    const hours = [new Date("2026-09-01T03:00:00Z")];
    const pipeline = buildRollupReportPipeline({
      deviceIds: ["agv-1", "agv-2"],
      hours,
      bucket: "day",
      timezone: TZ,
    });
    expect(pipeline[0]).toEqual({
      $match: { hour: { $in: hours }, deviceId: { $in: ["agv-1", "agv-2"] } },
    });
    const group = pipeline[1]!.$group as { _id: { bucketStart: { $dateTrunc: unknown } } };
    expect(group._id.bucketStart.$dateTrunc).toEqual({ date: "$hour", unit: "day", timezone: TZ });
  });
});

describe("planAvailabilityWindow", () => {
  const h = (n: number): number => at("2026-09-01T00:00:00Z") + n * HOUR_MS;

  it("serves whole summarised hours from the rollup and the rest from raw frames", () => {
    const from = h(0) + 20 * 60_000;
    const horizon = h(5) + 10 * 60_000;
    const plan = planAvailabilityWindow(from, horizon, new Set([h(0), h(1), h(2), h(4)]), TZ);
    // h(0) is only partly inside the window; h(3) has no run; h(5) is the current hour.
    expect(plan.hours).toEqual([h(1), h(2), h(4)]);
    expect(plan.raw).toEqual([
      { from, to: h(1) },
      { from: h(3), to: h(4) },
      { from: h(5), to: horizon },
    ]);
  });

  it("keeps the last hour raw even when it ends exactly at the horizon", () => {
    const plan = planAvailabilityWindow(h(0), h(3), new Set([h(0), h(1), h(2)]), TZ);
    expect(plan.hours).toEqual([h(0), h(1)]);
    expect(plan.raw).toEqual([{ from: h(2), to: h(3) }]);
  });

  it("falls back to one raw slice when nothing is summarised", () => {
    expect(planAvailabilityWindow(h(0), h(2), new Set(), TZ)).toEqual({
      hours: [],
      raw: [{ from: h(0), to: h(2) }],
    });
  });
});

describe("closedHours", () => {
  it("lists hours that ended at least the threshold plus the settle time ago, newest first", () => {
    const now = at("2026-09-01T05:00:00Z") + 90_000 + ROLLUP_SETTLE_MS;
    expect(
      closedHours(at("2026-09-01T02:40:00Z"), now, 90_000, TZ).map((ms) =>
        new Date(ms).toISOString(),
      ),
    ).toEqual(["2026-09-01T04:00:00.000Z", "2026-09-01T03:00:00.000Z", "2026-09-01T02:00:00.000Z"]);
    // One millisecond earlier the 04:00 hour is not ready yet.
    expect(closedHours(at("2026-09-01T02:40:00Z"), now - 1, 90_000, TZ)).toHaveLength(2);
  });
});

describe("mergeAvailabilityRows", () => {
  const row = (
    deviceId: string,
    start: string,
    overrides: Partial<AvailabilityRow>,
  ): AvailabilityRow => ({
    _id: { deviceId, bucketStart: new Date(start) },
    bucketEnd: new Date(at(start) + 86_400_000),
    ...overrides,
  });

  it("adds a bucket's parts and weights the soc mean by reading count", () => {
    const [merged, ...rest] = mergeAvailabilityRows([
      row("agv-1", "2026-09-01T16:00:00Z", {
        onlineSamples: 3,
        totalSamples: 4,
        onlineMs: 3000,
        socSum: 30,
        socCount: 3,
        socMin: 8,
      }),
      row("agv-1", "2026-09-01T16:00:00Z", {
        onlineSamples: 1,
        totalSamples: 1,
        onlineMs: 1000,
        socSum: 90,
        socCount: 1,
        socMin: 90,
      }),
    ]);
    expect(rest).toEqual([]);
    expect(merged).toMatchObject({ onlineSamples: 4, totalSamples: 5, onlineMs: 4000, socMin: 8 });
    // (30 + 90) / 4 = 30, not the mean of the two means (55).
    expect((merged!.socSum ?? 0) / (merged!.socCount ?? 1)).toBe(30);
  });

  it("sorts by device then bucket so the mapper can slice series", () => {
    const merged = mergeAvailabilityRows([
      row("agv-2", "2026-09-01T16:00:00Z", {}),
      row("agv-1", "2026-09-02T16:00:00Z", {}),
      row("agv-1", "2026-09-01T16:00:00Z", {}),
    ]);
    expect(
      merged.map((r) => `${String(r._id.deviceId)} ${new Date(r._id.bucketStart!).toISOString()}`),
    ).toEqual([
      "agv-1 2026-09-01T16:00:00.000Z",
      "agv-1 2026-09-02T16:00:00.000Z",
      "agv-2 2026-09-01T16:00:00.000Z",
    ]);
  });
});
