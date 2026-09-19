import { describe, it, expect } from "vitest";
import type { AvailabilityReport } from "@navfleet/shared";
import {
  buildAvailabilityCsv,
  onlineRatioSeries,
  socSeries,
  summarizeAvailability,
  windowForPreset,
} from "@/lib/reportsView";

/**
 * The report page's pure logic (Phase 17B-1). The view feeds these the server aggregates and
 * renders what comes back; the branches worth pinning are here — the window maths, the
 * sample-weighted means with their zero-guards, the null-soc skips, and CSV escaping.
 */

const report = (
  devices: AvailabilityReport["devices"],
  available = true,
): AvailabilityReport => ({ bucket: "day", devices, available });

const iso = (h: number) => new Date(Date.UTC(2026, 8, 1, h)).toISOString();

describe("windowForPreset", () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);

  it("ends the window at now and reaches back the preset span", () => {
    expect(windowForPreset("12h", now)).toEqual({
      from: new Date(now - 12 * 3_600_000).toISOString(),
      to: new Date(now).toISOString(),
    });
    expect(windowForPreset("24h", now)).toEqual({
      from: new Date(now - 24 * 3_600_000).toISOString(),
      to: new Date(now).toISOString(),
    });
    expect(windowForPreset("7d", now).from).toBe(
      new Date(now - 7 * 24 * 3_600_000).toISOString(),
    );
    expect(windowForPreset("30d", now).from).toBe(
      new Date(now - 30 * 24 * 3_600_000).toISOString(),
    );
  });
});

describe("summarizeAvailability", () => {
  it("weights the online ratio and soc by sample count, not by bucket", () => {
    // Bucket A: 100 frames, 90 online, soc 80. Bucket B: 10 frames, 0 online, soc 20.
    // Sample-weighted online = 90/110; soc = (80*100 + 20*10)/110. A per-bucket average would
    // wrongly weight the tiny bucket equally.
    const summary = summarizeAvailability(
      report([
        {
          deviceId: "agv-1",
          buckets: [
            {
              bucketStart: iso(0),
              onlineSamples: 90,
              totalSamples: 100,
              onlineRatio: 0.9,
              socMean: 80,
              socMin: 70,
            },
            {
              bucketStart: iso(1),
              onlineSamples: 0,
              totalSamples: 10,
              onlineRatio: 0.0,
              socMean: 20,
              socMin: 20,
            },
          ],
        },
      ]),
    );
    expect(summary.onlineRatio).toBeCloseTo(90 / 110, 10);
    expect(summary.socMean).toBeCloseTo((80 * 100 + 20 * 10) / 110, 10);
    expect(summary.deviceCount).toBe(1);
  });

  it("returns nulls instead of dividing by zero, and skips null-soc buckets in the mean", () => {
    const summary = summarizeAvailability(
      report([
        {
          deviceId: "agv-1",
          buckets: [
            {
              bucketStart: iso(0),
              onlineSamples: 0,
              totalSamples: 0,
              onlineRatio: 0,
              socMean: null,
              socMin: null,
            },
          ],
        },
      ]),
    );
    expect(summary.onlineRatio).toBeNull();
    expect(summary.socMean).toBeNull();
  });
});

describe("onlineRatioSeries / socSeries", () => {
  const built = report([
    {
      deviceId: "agv-1",
      buckets: [
        {
          bucketStart: iso(0),
          onlineSamples: 8,
          totalSamples: 10,
          onlineRatio: 0.8,
          socMean: 80,
          socMin: 60,
        },
        {
          bucketStart: iso(1),
          onlineSamples: 10,
          totalSamples: 10,
          onlineRatio: 1.0,
          socMean: null,
          socMin: null,
        },
      ],
    },
  ]);
  const nameOf = (id: string) => (id === "agv-1" ? "A01 巡检车" : id);

  it("emits online ratio as a percentage, one series per device, named", () => {
    const [series] = onlineRatioSeries(built, nameOf);
    expect(series!.name).toBe("A01 巡检车");
    expect(series!.points).toEqual([
      [Date.parse(iso(0)), 80],
      [Date.parse(iso(1)), 100],
    ]);
  });

  it("drops buckets with no soc rather than plotting them as zero", () => {
    const [series] = socSeries(built, nameOf);
    // Only the first bucket had a soc; the null one is skipped, not charted as 0.
    expect(series!.points).toEqual([[Date.parse(iso(0)), 80]]);
  });
});

describe("buildAvailabilityCsv", () => {
  const built = report([
    {
      deviceId: "agv-1",
      buckets: [
        {
          bucketStart: iso(0),
          onlineSamples: 9,
          totalSamples: 10,
          onlineRatio: 0.9,
          socMean: 82.5,
          socMin: 70,
        },
        {
          bucketStart: iso(1),
          onlineSamples: 4,
          totalSamples: 4,
          onlineRatio: 1.0,
          socMean: null,
          socMin: null,
        },
      ],
    },
  ]);

  it("writes a header, ratios to 4 dp, and leaves a blank cell for a null soc", () => {
    const csv = buildAvailabilityCsv(built, () => "A01 巡检车");
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "设备ID,设备名称,时间桶,在线帧,总帧,在线率,电量均值,电量最低",
    );
    expect(lines[1]).toBe(`agv-1,A01 巡检车,${iso(0)},9,10,0.9000,82.5,70`);
    // A null soc is an empty cell (no sample), never 0 — 0 would read as "flat battery".
    expect(lines[2]).toBe(`agv-1,A01 巡检车,${iso(1)},4,4,1.0000,,`);
  });

  it("quotes a field containing a comma and doubles inner quotes (RFC-4180)", () => {
    const csv = buildAvailabilityCsv(built, () => 'A01, "巡检"');
    expect(csv.split("\n")[1]).toContain('"A01, ""巡检"""');
  });
});
