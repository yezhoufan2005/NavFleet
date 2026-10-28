import { describe, it, expect } from "vitest";
import { emptyAlertStatsReport, emptyAvailabilityReport } from "../src/index";

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
