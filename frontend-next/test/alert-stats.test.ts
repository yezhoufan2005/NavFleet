import { describe, it, expect } from "vitest";
import type { AlertRecord } from "@navfleet/fleet-core";
import {
  computeAlertStats,
  formatDurationMs,
  severityOf,
} from "@/lib/alertStats";

/**
 * The alert statistics, computed client-side (Phase 16B — the backend has no aggregation
 * layer; that is 17A). Pure functions, so every branch is exercised by feeding records in and
 * asserting the numbers out — no DOM, no clock.
 */
const HOUR = 3_600_000;

const record = (over: Partial<AlertRecord> = {}): AlertRecord => ({
  severity: "warning",
  deviceId: "agv-01",
  deviceName: "A01",
  firstSeenAt: "2026-03-01T00:00:00.000Z",
  clearedAt: "2026-03-01T01:00:00.000Z",
  ackedBy: null,
  ...over,
});

describe("severityOf", () => {
  it("passes through the three known severities and defaults the rest to notice", () => {
    expect(severityOf(record({ severity: "critical" }))).toBe("critical");
    expect(severityOf(record({ severity: "warning" }))).toBe("warning");
    expect(severityOf(record({ severity: "notice" }))).toBe("notice");
    // An unknown / malformed value is treated as the least severe rather than dropped.
    expect(severityOf(record({ severity: "boom" as never }))).toBe("notice");
  });
});

describe("computeAlertStats", () => {
  it("returns an all-zero shape for an empty set, with a null ack rate", () => {
    const stats = computeAlertStats([]);
    expect(stats.total).toBe(0);
    expect(stats.bySeverity).toEqual({ critical: 0, warning: 0, notice: 0 });
    expect(stats.topDevices).toEqual([]);
    expect(stats.daily).toEqual([]);
    expect(stats.ackRate).toBeNull();
    expect(stats.duration).toEqual({ count: 0, meanMs: null, medianMs: null });
  });

  it("counts by severity", () => {
    const stats = computeAlertStats([
      record({ severity: "critical" }),
      record({ severity: "critical" }),
      record({ severity: "warning" }),
      record({ severity: "notice" }),
    ]);
    expect(stats.bySeverity).toEqual({ critical: 2, warning: 1, notice: 1 });
    expect(stats.total).toBe(4);
  });

  it("ranks devices by count, breaking ties by name, and caps at topN", () => {
    const stats = computeAlertStats(
      [
        record({ deviceId: "a", deviceName: "A" }),
        record({ deviceId: "a", deviceName: "A" }),
        record({ deviceId: "b", deviceName: "B" }),
        record({ deviceId: "c", deviceName: "C" }),
      ],
      { topN: 2 },
    );
    expect(stats.topDevices).toEqual([
      { deviceId: "a", deviceName: "A", count: 2 },
      { deviceId: "b", deviceName: "B", count: 1 },
    ]);
  });

  it("buckets onset by local day, ascending", () => {
    // Two on one local day, one on the next.
    const stats = computeAlertStats([
      record({ firstSeenAt: "2026-03-01T08:00:00" }),
      record({ firstSeenAt: "2026-03-01T20:00:00" }),
      record({ firstSeenAt: "2026-03-02T09:00:00" }),
    ]);
    expect(stats.daily).toEqual([
      { day: "2026-03-01", count: 2 },
      { day: "2026-03-02", count: 1 },
    ]);
  });

  it("falls back to ts when firstSeenAt is absent for the day bucket", () => {
    const stats = computeAlertStats([
      record({
        firstSeenAt: undefined,
        ts: "2026-03-05T10:00:00",
        clearedAt: null,
      }),
    ]);
    expect(stats.daily).toEqual([{ day: "2026-03-05", count: 1 }]);
  });

  it("computes the ack rate over the whole set", () => {
    const stats = computeAlertStats([
      record({ ackedBy: "op" }),
      record({ ackedBy: "op" }),
      record({ ackedBy: null }),
      record({ ackedBy: null }),
    ]);
    expect(stats.ackRate).toBe(0.5);
  });

  it("measures duration only for records that both started and cleared", () => {
    const stats = computeAlertStats([
      // 1h and 3h → mean 2h, median 2h.
      record({
        firstSeenAt: "2026-03-01T00:00:00.000Z",
        clearedAt: "2026-03-01T01:00:00.000Z",
      }),
      record({
        firstSeenAt: "2026-03-01T00:00:00.000Z",
        clearedAt: "2026-03-01T03:00:00.000Z",
      }),
      // Never cleared → contributes nothing to duration.
      record({ clearedAt: null }),
    ]);
    expect(stats.duration.count).toBe(2);
    expect(stats.duration.meanMs).toBe(2 * HOUR);
    expect(stats.duration.medianMs).toBe(2 * HOUR);
  });

  it("ignores a clear time that precedes the onset (malformed)", () => {
    const stats = computeAlertStats([
      record({
        firstSeenAt: "2026-03-01T05:00:00.000Z",
        clearedAt: "2026-03-01T04:00:00.000Z",
      }),
    ]);
    expect(stats.duration.count).toBe(0);
    expect(stats.duration.meanMs).toBeNull();
  });

  it("takes the median of an odd count as the middle value", () => {
    const stats = computeAlertStats([
      record({ clearedAt: "2026-03-01T01:00:00.000Z" }), // 1h
      record({ clearedAt: "2026-03-01T02:00:00.000Z" }), // 2h
      record({ clearedAt: "2026-03-01T04:00:00.000Z" }), // 4h
    ]);
    expect(stats.duration.medianMs).toBe(2 * HOUR);
  });
});

describe("formatDurationMs", () => {
  it("reads hours, minutes and seconds by magnitude", () => {
    expect(formatDurationMs(2 * HOUR + 3 * 60_000)).toBe("2小时3分");
    expect(formatDurationMs(5 * 60_000 + 12_000)).toBe("5分12秒");
    expect(formatDurationMs(8_000)).toBe("8秒");
  });

  it("renders a null or negative duration as a dash", () => {
    expect(formatDurationMs(null)).toBe("--");
    expect(formatDurationMs(-1)).toBe("--");
  });
});
