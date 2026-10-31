import { describe, it, expect } from "vitest";
import {
  asText,
  createDefaultCode,
  dedupeAlerts,
  hasGps,
  hasPose,
  normalizeSeverity,
  parseTimestampMs,
  toIsoString,
  toIsoStringOrNull,
  toNumeric,
  toTimestampMsOrNow,
} from "../src/index";

/**
 * The coercions both normalisers share. They used to be two copies pinned to each other by
 * matching tables on both sides; this is now the one table.
 */
describe("asText", () => {
  it("keeps scalars and drops everything else to the fallback", () => {
    expect(asText("A01")).toBe("A01");
    expect(asText(7)).toBe("7");
    expect(asText(true)).toBe("true");
    expect(asText(10n)).toBe("10");
    expect(asText({})).toBe("");
    expect(asText(null, "未命名")).toBe("未命名");
    expect(asText(Number.NaN, "-")).toBe("-");
  });
});

describe("toNumeric", () => {
  it.each([
    [42, 42],
    [0, 0],
    ["12.5", 12.5],
    [null, null],
    [undefined, null],
    ["", null],
    ["n/a", null],
    [Number.POSITIVE_INFINITY, null],
  ])("maps %j to %j", (input, expected) => {
    expect(toNumeric(input)).toBe(expected);
  });

  it("returns the fallback for a missing reading, not zero", () => {
    expect(toNumeric(null, 80)).toBe(80);
    expect(toNumeric("", 80)).toBe(80);
  });
});

describe("timestamps", () => {
  it("reads seconds and milliseconds, ISO and numeric strings", () => {
    expect(parseTimestampMs(1_000_000)).toBe(1_000_000_000);
    expect(parseTimestampMs(2_000_000_000_000)).toBe(2_000_000_000_000);
    expect(parseTimestampMs("2000000000000")).toBe(2_000_000_000_000);
    expect(parseTimestampMs("1700000000")).toBe(1_700_000_000_000);
    expect(parseTimestampMs("2026-09-02T00:00:00.000Z")).toBe(
      Date.parse("2026-09-02T00:00:00.000Z"),
    );
  });

  it("reads micro- and nanosecond epochs, and refuses what a Date cannot hold", () => {
    const ms = Date.parse("2026-09-02T00:00:00.000Z");
    expect(parseTimestampMs(ms * 1e3)).toBe(ms);
    expect(parseTimestampMs(ms * 1e6)).toBe(ms);
    expect(parseTimestampMs(String(ms * 1e6))).toBe(ms);
    expect(parseTimestampMs(1e30)).toBeNull();
    // So the receiver-side helper falls back instead of throwing RangeError.
    expect(() => toIsoString(1e30)).not.toThrow();
  });

  it("answers null for anything that carries no time", () => {
    for (const absent of [
      null,
      undefined,
      "",
      "   ",
      "not a date",
      Number.NaN,
      {},
      [],
    ]) {
      expect(parseTimestampMs(absent)).toBeNull();
    }
  });

  it("falls back to now only in the receiver-side helpers", () => {
    const before = Date.now();
    expect(toTimestampMsOrNow(null)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(toIsoString("garbage"))).toBeGreaterThanOrEqual(before);
    expect(toIsoString(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(toIsoStringOrNull("n/a")).toBeNull();
    expect(toIsoStringOrNull(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("normalizeSeverity", () => {
  it.each([
    ["CRITICAL", "critical"],
    ["fatal", "critical"],
    ["ERROR", "critical"],
    ["warn", "warning"],
    ["low", "warning"],
    ["info", "notice"],
    [undefined, "notice"],
  ])("folds %j onto %s", (input, expected) => {
    expect(normalizeSeverity(input)).toBe(expected);
  });
});

describe("poses, fixes and empty codes", () => {
  it("needs both coordinates finite", () => {
    expect(hasPose({ x: 1, y: 2 })).toBe(true);
    expect(hasPose({ x: 1, y: null })).toBe(false);
    expect(hasPose(null)).toBe(false);
    expect(hasGps({ lat: 31.2, lng: 121.4 })).toBe(true);
    expect(hasGps({ lat: Number.NaN, lng: 121.4 })).toBe(false);
    expect(hasGps(undefined)).toBe(false);
  });

  it("starts a code channel at nothing reported", () => {
    expect(createDefaultCode()).toEqual({ code: 0, info: "", stamp: null });
  });
});

describe("dedupeAlerts", () => {
  it("keeps one per id/severity/title, newest first, undated last", () => {
    const result = dedupeAlerts([
      { id: "x", severity: "warning", title: "t", ts: "2026-01-01T00:00:00Z" },
      { id: "x", severity: "warning", title: "t", ts: "2026-01-01T00:00:00Z" },
      { id: "u", severity: "notice", title: "undated", ts: "" },
      {
        id: "y",
        severity: "critical",
        title: "t2",
        ts: "2026-01-02T00:00:00Z",
      },
    ]);
    expect(result.map((alert) => alert.id)).toEqual(["y", "x", "u"]);
  });
});
