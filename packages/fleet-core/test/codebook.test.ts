import { describe, it, expect } from "vitest";
import {
  DEFAULT_REPORT_CODES,
  buildCodebookIndex,
  describeCodeWith,
  describeDeviceCodesWith,
  mergeCodebook,
  parseCodebook,
  type CodeState,
  type ReportCodeEntry,
} from "@navfleet/shared";

/**
 * The report-code dictionary's deployment-overlay machinery (Phase 16C-2): validating an
 * untrusted `codebook.json`, layering it over the built-in table, and describing a code
 * against a specific codebook. The built-in table's own invariants live in
 * `reportCodes.test.ts`; this covers the parts a deployment exercises.
 */
const entry = (over: Partial<ReportCodeEntry> = {}): ReportCodeEntry => ({
  code: 2301,
  channel: "warning",
  subsystem: "power",
  label: "电量偏低",
  description: "剩余电量低于阈值",
  hint: "尽快返充",
  impact: "urgent",
  ...over,
});

const state = (code: number, info = ""): CodeState => ({
  code,
  info,
  stamp: null,
});

describe("parseCodebook", () => {
  it("accepts a well-formed array and returns typed entries", () => {
    const parsed = parseCodebook([
      entry(),
      entry({ code: 9001, channel: "error", impact: "blocked" }),
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toMatchObject({
      code: 9001,
      channel: "error",
      impact: "blocked",
    });
  });

  it("rejects a non-array", () => {
    expect(() => parseCodebook({ items: [] })).toThrow(/must be a JSON array/);
  });

  it("rejects a duplicate code", () => {
    expect(() => parseCodebook([entry(), entry()])).toThrow(
      /duplicate code: 2301/,
    );
  });

  it.each([
    ["code", entry({ code: 0 }), /code must be a positive integer/],
    ["code", entry({ code: 1.5 }), /code must be a positive integer/],
    ["channel", { ...entry(), channel: "alarm" }, /channel must be/],
    [
      "subsystem",
      { ...entry(), subsystem: "wheels" },
      /subsystem is not a known/,
    ],
    ["impact", { ...entry(), impact: "meh" }, /impact is not a known/],
    ["label", entry({ label: "  " }), /label must be a non-empty string/],
    ["hint", entry({ hint: "" }), /hint must be a non-empty string/],
  ])("rejects a bad %s", (_field, bad, message) => {
    expect(() => parseCodebook([bad])).toThrow(message);
  });

  it("rejects a non-object entry", () => {
    expect(() => parseCodebook(["2301"])).toThrow(/must be a JSON object/);
  });
});

describe("mergeCodebook", () => {
  it("overrides a built-in code, adds a new one, and sorts by code", () => {
    const overrides = [
      entry({ code: 2301, label: "本厂电量低", hint: "推去充电区" }),
      entry({
        code: 3001,
        channel: "warning",
        subsystem: "payload",
        label: "夹具松动",
      }),
    ];
    const merged = mergeCodebook(DEFAULT_REPORT_CODES, overrides);
    const byCode = new Map(merged.map((e) => [e.code, e]));

    // Same code, deployment meaning wins.
    expect(byCode.get(2301)?.label).toBe("本厂电量低");
    // New code is present.
    expect(byCode.get(3001)?.label).toBe("夹具松动");
    // A built-in the overrides did not touch survives.
    expect(byCode.get(1101)?.label).toBe("定位稳定");
    // Sorted ascending.
    const codes = merged.map((e) => e.code);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
  });

  it("returns the base unchanged when there are no overrides", () => {
    expect(mergeCodebook(DEFAULT_REPORT_CODES, [])).toHaveLength(
      DEFAULT_REPORT_CODES.length,
    );
  });
});

describe("describeCodeWith / describeDeviceCodesWith against a codebook", () => {
  it("describes a code using the given codebook, not the built-in one", () => {
    const index = buildCodebookIndex([
      entry({ code: 2301, label: "本厂电量低" }),
    ]);
    expect(describeCodeWith(index, state(2301))?.label).toBe("本厂电量低");
  });

  it("reports a code the codebook does not know as unknown, never guessed", () => {
    const index = buildCodebookIndex([]);
    const described = describeCodeWith(index, state(7777, "厂商原文"));
    expect(described).toMatchObject({
      unknown: true,
      code: 7777,
      reported: "厂商原文",
    });
  });

  it("returns null for no code / zero", () => {
    const index = buildCodebookIndex(DEFAULT_REPORT_CODES);
    expect(describeCodeWith(index, state(0))).toBeNull();
    expect(describeCodeWith(index, null)).toBeNull();
  });

  it("orders a device's channels error-first and drops empty ones", () => {
    const index = buildCodebookIndex(DEFAULT_REPORT_CODES);
    const rows = describeDeviceCodesWith(index, {
      errorCode: state(5102),
      warningCode: state(2301),
      infoCode: state(0),
    });
    expect(rows.map((row) => row.channel)).toEqual(["error", "warning"]);
  });
});
