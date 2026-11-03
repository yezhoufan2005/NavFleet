import { describe, it, expect } from "vitest";
import { formatSoc } from "../src/metrics";

/**
 * `formatSoc` is the one spelling of state-of-charge: the chips and the low-battery message both
 * route through it, so a reading never shows as two different numbers on two surfaces (a 15.5%
 * battery once read "15.5%" in its alert and "16%" on the row). One decimal, trailing zero
 * dropped, `--` for no reading.
 */
describe("formatSoc", () => {
  it("keeps one decimal so a 15.5% battery is not rounded to 16%", () => {
    expect(formatSoc(15.5)).toBe("15.5%");
  });

  it("drops a trailing zero so a whole percent reads as an integer", () => {
    expect(formatSoc(82)).toBe("82%");
    expect(formatSoc(82.0)).toBe("82%");
  });

  it("rounds to the one-decimal resolution the telemetry carries", () => {
    expect(formatSoc(41.49)).toBe("41.5%");
  });

  it("answers -- for a missing or non-numeric reading, never 0%", () => {
    expect(formatSoc(null)).toBe("--");
    expect(formatSoc(undefined)).toBe("--");
    expect(formatSoc("")).toBe("--");
    expect(formatSoc("n/a")).toBe("--");
  });

  it("reads a numeric string, because telemetry fields arrive as strings too", () => {
    expect(formatSoc("58.5")).toBe("58.5%");
  });
});
