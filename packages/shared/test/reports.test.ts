import { describe, it, expect } from "vitest";
import {
  emptyAlertStatsReport,
  emptyAvailabilityReport,
  buildAvailabilityCsv,
  formatBucketStart,
} from "../src/index";

describe("empty report shapes", () => {
  it("states whether history exists, with zeroes rather than a missing field", () => {
    const stats = emptyAlertStatsReport(false);
    expect(stats.available).toBe(false);
    expect(stats.total).toBe(0);
    expect(stats.bySeverity).toEqual({ critical: 0, warning: 0, notice: 0 });
    expect(stats.ackRate).toBeNull();
    expect(emptyAlertStatsReport(true).available).toBe(true);
  });

  it("keeps the requested bucket on an empty availability report", () => {
    expect(emptyAvailabilityReport("day", true)).toEqual({
      bucket: "day",
      devices: [],
      available: true,
    });
  });
});

describe("formatBucketStart", () => {
  it("writes a bucket start as the deployment's local time", () => {
    // A UTC+8 day bucket starts at 16:00Z the day before; read raw, a spreadsheet dates it a day early.
    expect(formatBucketStart("2026-10-29T16:00:00.000Z", "Asia/Shanghai")).toBe(
      "2026-10-30 00:00",
    );
    expect(formatBucketStart("2026-10-29T16:00:00.000Z", "UTC")).toBe(
      "2026-10-29 16:00",
    );
    expect(formatBucketStart("not a date", "UTC")).toBe("not a date");
  });
});

describe("buildAvailabilityCsv", () => {
  it("is the one file both the console export and the report email write", () => {
    const csv = buildAvailabilityCsv(
      {
        bucket: "day",
        available: true,
        devices: [
          {
            deviceId: "agv-1",
            buckets: [
              {
                bucketStart: "2026-10-29T16:00:00.000Z",
                onlineSamples: 3,
                totalSamples: 4,
                onlineSeconds: 30,
                spanSeconds: 40,
                onlineRatio: 0.75,
                socMean: null,
                socMin: 12,
              },
            ],
          },
        ],
      },
      (id) => `=${id}`,
      "Asia/Shanghai",
    );
    const [header, row] = csv.split("\n");
    expect(header).toContain("时间桶（Asia/Shanghai）");
    // Local day, percent, a blank null soc, and a formula-looking name defused.
    expect(row).toBe("agv-1,'=agv-1,2026-10-30 00:00,3,4,30,40,75.0,,12");
  });
});
