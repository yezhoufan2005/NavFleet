import { describe, it, expect } from "vitest";
import type { AlertStatsReport, AvailabilityReport } from "@navfleet/shared";
import { AVAILABILITY_OTHERS_DEVICE_ID } from "@navfleet/shared";
import {
  buildAlertStatsCsv,
  buildAvailabilityCsv,
  defaultBucketForPreset,
  defaultBucketForSpanMs,
  deviceAvailabilityRows,
  onlineRatioSeries,
  socSeries,
  sparklinePoints,
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

describe("defaultBucketForSpanMs / defaultBucketForPreset", () => {
  const H = 3_600_000;
  it("picks hour for short windows, day for medium, month for long", () => {
    // 12h/24h windows as a single daily bucket were the near-empty chart; short ⇒ hour.
    expect(defaultBucketForSpanMs(12 * H)).toBe("hour");
    expect(defaultBucketForSpanMs(2 * 24 * H)).toBe("hour");
    expect(defaultBucketForSpanMs(7 * 24 * H)).toBe("day");
    expect(defaultBucketForSpanMs(30 * 24 * H)).toBe("day");
    expect(defaultBucketForSpanMs(200 * 24 * H)).toBe("month");
  });

  it("maps each preset to its fitting default", () => {
    expect(defaultBucketForPreset("12h")).toBe("hour");
    expect(defaultBucketForPreset("24h")).toBe("hour");
    expect(defaultBucketForPreset("7d")).toBe("day");
    expect(defaultBucketForPreset("30d")).toBe("day");
  });
});

describe("deviceAvailabilityRows", () => {
  it("summarizes each device, sorts by samples, and relabels the Top-N fold last", () => {
    const rows = deviceAvailabilityRows(
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
              socMin: 60,
            },
          ],
        },
        {
          deviceId: AVAILABILITY_OTHERS_DEVICE_ID,
          buckets: [
            {
              bucketStart: iso(0),
              onlineSamples: 5,
              totalSamples: 20,
              onlineRatio: 0.25,
              socMean: 30,
              socMin: 10,
            },
          ],
        },
      ]),
      (id) => (id === "agv-1" ? "A01 巡检车" : id),
    );

    // The real device ranks first even though it was listed first; 「其余」 is pinned to the end.
    expect(rows.map((row) => row.name)).toEqual(["A01 巡检车", "其余设备"]);
    expect(rows[0]).toMatchObject({
      isOthers: false,
      onlineRatio: 0.9,
      socMean: 80,
      socMin: 60,
      totalSamples: 100,
    });
    expect(rows[1]).toMatchObject({
      isOthers: true,
      onlineRatio: 0.25,
      socMin: 10,
    });
  });

  it("returns null metrics for a device with no samples rather than dividing by zero", () => {
    const rows = deviceAvailabilityRows(
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
      (id) => id,
    );
    expect(rows[0]).toMatchObject({
      onlineRatio: null,
      socMean: null,
      socMin: null,
    });
  });
});

describe("sparklinePoints", () => {
  it("normalizes points into the box with a flipped y-axis", () => {
    const series = [
      {
        name: "x",
        points: [[0, 0] as [number, number], [10, 10] as [number, number]],
      },
    ];
    // Two points spanning the full range land at the box corners: low value at the bottom
    // (y=height), high value at the top (y=0).
    expect(sparklinePoints(series, 100, 20)).toBe("0.0,20.0 100.0,0.0");
  });

  it("returns an empty string for fewer than two points (nothing to draw)", () => {
    expect(sparklinePoints([], 100, 20)).toBe("");
    expect(sparklinePoints([{ name: "x", points: [[0, 5]] }], 100, 20)).toBe(
      "",
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

  it("emits online ratio as a percentage in a single named series", () => {
    // One device in the report → the series is named after it, and the aggregate over one
    // device is that device.
    const [series] = onlineRatioSeries(built, nameOf);
    expect(onlineRatioSeries(built, nameOf)).toHaveLength(1);
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

  it("folds many devices into one frame-weighted fleet-mean line", () => {
    // Two devices sharing a bucket: online is Σonline/Σtotal (frame-weighted, not the mean
    // of ratios), and soc is frame-weighted too. This is the fix for «图例太多 / 数据表堆叠».
    const fleet = report([
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
        ],
      },
      {
        deviceId: "agv-2",
        buckets: [
          {
            bucketStart: iso(0),
            onlineSamples: 6,
            totalSamples: 30,
            onlineRatio: 0.2,
            socMean: 40,
            socMin: 20,
          },
        ],
      },
    ]);
    const nameOfFleet = (id: string) => id;

    const online = onlineRatioSeries(fleet, nameOfFleet);
    expect(online).toHaveLength(1);
    expect(online[0]!.name).toBe("全部设备均值");
    // (8+6)/(10+30) = 0.35 → 35%
    expect(online[0]!.points).toEqual([[Date.parse(iso(0)), 35]]);

    // (80*10 + 40*30) / (10+30) = 2000/40 = 50
    const soc = socSeries(fleet, nameOfFleet);
    expect(soc[0]!.points).toEqual([[Date.parse(iso(0)), 50]]);
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

describe("buildAlertStatsCsv (1.6.1 export parity)", () => {
  const alertReport = (
    over: Partial<AlertStatsReport> = {},
  ): AlertStatsReport => ({
    total: 5,
    bySeverity: { critical: 2, warning: 2, notice: 1 },
    topDevices: [
      { deviceId: "agv-1", count: 3 },
      { deviceId: "agv-2", count: 2 },
    ],
    daily: [
      { day: "2026-03-01", count: 2 },
      { day: "2026-03-02", count: 3 },
    ],
    ackRate: 0.5,
    duration: { count: 4, meanMs: 3_600_000, p50Ms: 1_800_000 },
    available: true,
    ...over,
  });

  const nameOf = (id: string) => (id === "agv-1" ? "A01 巡检车" : id);

  it("packs summary, severity, device (named) and daily rows into one long-format table", () => {
    const lines = buildAlertStatsCsv(alertReport(), nameOf).split("\n");
    expect(lines[0]).toBe("分组,项,数值");
    expect(lines).toContain("汇总,消息总数,5");
    expect(lines).toContain("汇总,确认率,0.5");
    expect(lines).toContain("汇总,平均处理时长(ms),3600000");
    expect(lines).toContain("严重度,告警,2");
    expect(lines).toContain("严重度,提示,1");
    // topDevices carry only an id; the name is resolved through the live fleet.
    expect(lines).toContain("设备,A01 巡检车,3");
    expect(lines).toContain("设备,agv-2,2");
    expect(lines).toContain("按天,2026-03-01,2");
  });

  it("leaves 确认率 blank (not 0) when there are no records to rate", () => {
    const lines = buildAlertStatsCsv(
      alertReport({ ackRate: null, total: 0 }),
      nameOf,
    ).split("\n");
    // A blank cell is "no sample to compute a rate"; 0 would read as "nothing was acknowledged".
    expect(lines).toContain("汇总,确认率,");
  });
});
