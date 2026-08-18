import { describe, it, expect } from "vitest";
import { historyQuerySchema, alertsQuerySchema, ingestBodySchema } from "../src/validation";

describe("historyQuerySchema", () => {
  it("coerces limit to a positive integer", () => {
    const parsed = historyQuerySchema.parse({ limit: "100" });
    expect(parsed.limit).toBe(100);
  });

  it("accepts ISO and numeric timestamps", () => {
    expect(historyQuerySchema.safeParse({ from: "2024-01-01T00:00:00Z" }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ from: "1712472000000" }).success).toBe(true);
  });

  it("rejects a non-positive or non-numeric limit", () => {
    expect(historyQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(historyQuerySchema.safeParse({ from: "not-a-date" }).success).toBe(false);
  });
});

describe("alertsQuerySchema", () => {
  it("accepts known severity and status values", () => {
    expect(alertsQuerySchema.safeParse({ severity: "critical", status: "active" }).success).toBe(
      true,
    );
  });

  it("rejects unknown severity or status values", () => {
    expect(alertsQuerySchema.safeParse({ severity: "fatal" }).success).toBe(false);
    expect(alertsQuerySchema.safeParse({ status: "open" }).success).toBe(false);
  });
});

describe("ingestBodySchema", () => {
  it("accepts objects and arrays", () => {
    expect(ingestBodySchema.safeParse({ deviceId: "a" }).success).toBe(true);
    expect(ingestBodySchema.safeParse([{ deviceId: "a" }]).success).toBe(true);
  });

  it("rejects primitives", () => {
    expect(ingestBodySchema.safeParse("nope").success).toBe(false);
    expect(ingestBodySchema.safeParse(42).success).toBe(false);
  });
});
