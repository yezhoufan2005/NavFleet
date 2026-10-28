import { describe, it, expect } from "vitest";
import { formatNumber, formatValue, formatStamp } from "../src/formatters";

/**
 * These three helpers had no direct tests: in the old frontend they were only
 * exercised incidentally, through DashboardView's component tests. Extracting
 * them into this package made that visible as 0% coverage — the same lesson as
 * the vacuous-100% one from Phase 10, running in the other direction.
 *
 * Several assertions below pin behaviour that is **wrong** and is filed as a
 * defect (frontend-parity.md 9.1): `Number(null) === 0`, so a missing reading
 * renders as `0.00` rather than a placeholder, and `createDefaultDevice`
 * initialises soc/speed/omega/x/y/yaw/limit to exactly that. A device with no
 * telemetry therefore reads as "speed 0, battery 0" instead of "no data".
 *
 * They are pinned rather than fixed here on purpose. This PR moves code without
 * changing behaviour — that is what makes the extraction verifiable. The fix
 * belongs to the new frontend (Phase 13), and when it lands these expectations
 * should change in the same commit, deliberately, rather than quietly drifting.
 */
describe("formatNumber", () => {
  it("formats finite numbers to the requested precision with an optional unit", () => {
    expect(formatNumber(1.234)).toBe("1.23");
    expect(formatNumber(1.234, 1)).toBe("1.2");
    expect(formatNumber(0.5, 1, "%")).toBe("0.5%");
    expect(formatNumber(12, 2, " m/s")).toBe("12.00 m/s");
  });

  it("returns the placeholder for values that are not finite numbers", () => {
    expect(formatNumber(undefined)).toBe("--");
    expect(formatNumber(Number.NaN)).toBe("--");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("--");
    expect(formatNumber("not a number")).toBe("--");
  });

  it("coerces numeric strings, because payload fields arrive as strings", () => {
    expect(formatNumber("2.5", 1)).toBe("2.5");
  });

  it("tells a missing reading apart from a reading of zero (parity 9.1)", () => {
    // `Number(null)` is 0 and every default telemetry field is null, so an un-reported
    // battery used to render "0.0%" and read like a flat one. On a monitoring console
    // "no reading" and "a reading of zero" are different facts: one is a vehicle that
    // is parked, the other is a vehicle that is not talking to us.
    expect(formatNumber(null, 1, "%")).toBe("--");
    expect(formatNumber(null, 2, " m/s")).toBe("--");
    expect(formatNumber("", 1, "%")).toBe("--");
    expect(formatNumber("   ", 1, "%")).toBe("--");

    // A real zero still formats — that is the half of the distinction that must not
    // be lost while fixing the other half.
    expect(formatNumber(0, 1, "%")).toBe("0.0%");
    expect(formatNumber("0", 2, " m/s")).toBe("0.00 m/s");
  });

  it("refuses values that are not readings at all, rather than coercing them", () => {
    // `Number(true)` is 1 and `Number([])` is 0; both are finite, so the old guard
    // let them through and invented a measurement out of a boolean.
    expect(formatNumber(true)).toBe("--");
    expect(formatNumber(false)).toBe("--");
    expect(formatNumber([])).toBe("--");
    expect(formatNumber([5])).toBe("--");
    expect(formatNumber({})).toBe("--");
  });
});

describe("formatValue", () => {
  it("stringifies anything present", () => {
    expect(formatValue("D")).toBe("D");
    expect(formatValue(42)).toBe("42");
    expect(formatValue(false)).toBe("false");
  });

  it("keeps zero, which is a meaningful report code", () => {
    expect(formatValue(0)).toBe("0");
  });

  it("returns the placeholder for null, undefined and the empty string", () => {
    expect(formatValue(null)).toBe("--");
    expect(formatValue(undefined)).toBe("--");
    expect(formatValue("")).toBe("--");
  });
});

describe("formatStamp", () => {
  it("returns the placeholder for falsy stamps", () => {
    expect(formatStamp(null)).toBe("--");
    expect(formatStamp(undefined)).toBe("--");
    expect(formatStamp("")).toBe("--");
    expect(formatStamp(0)).toBe("--");
  });

  it("renders a real timestamp without an am/pm marker", () => {
    const rendered = formatStamp("2026-08-29T12:34:56.000Z");
    expect(rendered).not.toBe("--");
    expect(rendered).not.toMatch(/[AP]M|上午|下午/);
    // Locale and timezone are the runtime's, so assert the shape rather than an
    // exact string — a hardcoded expectation here would fail on a CI box in
    // another timezone.
    expect(rendered).toMatch(/\d{4}/);
  });
});
