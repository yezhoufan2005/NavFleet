import { describe, expect, it } from "vitest";
import { parseTimeParam } from "../src/timeParam";

describe("parseTimeParam", () => {
  it("reads ISO datetimes and whole-number epochs in seconds or milliseconds", () => {
    expect(parseTimeParam("2026-10-31T00:00:00Z")).toBe(Date.parse("2026-10-31T00:00:00Z"));
    expect(parseTimeParam("1760000000")).toBe(1_760_000_000_000);
    expect(parseTimeParam("1760000000000")).toBe(1_760_000_000_000);
    expect(parseTimeParam(" 1760000000 ")).toBe(1_760_000_000_000);
  });

  it("refuses what it cannot read without guessing", () => {
    for (const value of ["", "not-a-date", "1.7e12", "2026", "12.5", "-5"]) {
      expect(parseTimeParam(value), value).toBeNull();
    }
    expect(parseTimeParam(undefined)).toBeNull();
  });
});
