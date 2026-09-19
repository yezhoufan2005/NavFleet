import { describe, it, expect } from "vitest";
import type { AlertStatsReport, AvailabilityReport } from "@navfleet/shared";
import { buildReportEmail } from "../src/reports/reportEmail";

/**
 * The scheduled-report email builder (Phase 17B-2), a pure function. What a machine check waves
 * through: an unescaped device name turning the HTML body into an injection point, a soc mean
 * printed as a bare ratio, a null soc written as 0 in the CSV, the "no history" caveat dropped
 * when both aggregates are unavailable. The scheduler wiring is tested separately.
 */

const availability = (patch: Partial<AvailabilityReport> = {}): AvailabilityReport => ({
  bucket: "day",
  available: true,
  devices: [
    {
      deviceId: "agv-1",
      buckets: [
        {
          bucketStart: "2026-09-01T00:00:00.000Z",
          onlineSamples: 18,
          totalSamples: 20,
          onlineRatio: 0.9,
          socMean: 80,
          socMin: 60,
        },
        {
          bucketStart: "2026-09-02T00:00:00.000Z",
          onlineSamples: 20,
          totalSamples: 20,
          onlineRatio: 1,
          socMean: null,
          socMin: null,
        },
      ],
    },
  ],
  ...patch,
});

const alertStats = (patch: Partial<AlertStatsReport> = {}): AlertStatsReport => ({
  total: 5,
  bySeverity: { critical: 2, warning: 2, notice: 1 },
  topDevices: [{ deviceId: "agv-1", count: 5 }],
  daily: [{ day: "2026-09-01", count: 5 }],
  ackRate: 0.6,
  duration: { count: 3, meanMs: 120000, p50Ms: 90000 },
  available: true,
  ...patch,
});

const nameOf = (id: string) => (id === "agv-1" ? "A01 巡检车" : id);

const build = (over: { availability?: AvailabilityReport; alertStats?: AlertStatsReport } = {}) =>
  buildReportEmail({
    scheduleId: "daily",
    range: "7d",
    generatedAt: "2026-09-08T00:00:00.000Z",
    availability: over.availability ?? availability(),
    alertStats: over.alertStats ?? alertStats(),
    nameOf,
  });

describe("buildReportEmail", () => {
  it("names the range and date in the subject", () => {
    expect(build().subject).toBe("NavFleet 车队报表 · 近 7 天 · 2026-09-08");
  });

  it("puts sample-weighted KPIs in the body", () => {
    const content = build();
    // Online = 38/40 = 95.0%; soc weighted over buckets with a value = (80*20)/20 = 80.0%.
    expect(content.text).toContain("平均在线率：95.0%");
    expect(content.text).toContain("平均电量：80.0%");
    expect(content.text).toContain("告警总数：5");
    expect(content.text).toContain("确认率：60%");
  });

  it("escapes device names in the HTML body", () => {
    const content = buildReportEmail({
      scheduleId: "daily",
      range: "24h",
      generatedAt: "2026-09-08T00:00:00.000Z",
      availability: availability(),
      alertStats: alertStats({ topDevices: [{ deviceId: "x", count: 1 }] }),
      nameOf: () => '<img src=x onerror="alert(1)">',
    });
    expect(content.html).toContain("&lt;img src=x");
    expect(content.html).not.toContain("<img src=x");
  });

  it("attaches a BOM-prefixed CSV whose null soc is a blank cell, not 0", () => {
    const [attachment] = build().attachments;
    expect(attachment!.filename).toBe("navfleet-可用率-7d-2026-09-08.csv");
    expect(attachment!.content.startsWith("﻿")).toBe(true);
    const lines = attachment!.content.replace("﻿", "").split("\n");
    expect(lines[0]).toBe("设备ID,设备名称,时间桶,在线帧,总帧,在线率,电量均值,电量最低");
    // Second bucket had a null soc → trailing cells empty, never 0.
    expect(lines[2]).toBe("agv-1,A01 巡检车,2026-09-02T00:00:00.000Z,20,20,1.0000,,");
  });

  it("says so when there is no history backend, instead of dressing zeros as a real report", () => {
    const content = build({
      availability: availability({ devices: [], available: false }),
      alertStats: alertStats({ total: 0, available: false }),
    });
    expect(content.text).toContain("未连接历史后端");
    expect(content.html).toContain("未连接历史后端");
  });
});
