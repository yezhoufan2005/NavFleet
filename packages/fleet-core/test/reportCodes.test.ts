import { describe, it, expect } from "vitest";
import {
  CODE_IMPACTS,
  CODE_SUBSYSTEMS,
  REPORT_CODES,
  describeCode,
  describeDeviceCodes,
  lookupReportCode,
} from "../src/reportCodes";
import type { CodeState } from "@navfleet/shared";

/**
 * The dictionary, and mostly one property: that it never invents a meaning.
 *
 * The table itself is reference data modelled on VDA 5050 (impact stated as what the
 * vehicle can still do) and J1939 (a number that separates *what* from *how*). What is
 * worth testing is not its contents but its discipline — the internal consistency of
 * the number scheme, and the unknown-code path, which is the state most real
 * deployments will be in until their own 码表 is loaded.
 */
const state = (code: number, info = ""): CodeState => ({
  code,
  info,
  stamp: null,
});

const CHANNEL_DIGIT: Record<string, string> = {
  info: "1",
  warning: "2",
  error: "5",
};

describe("the table's own consistency", () => {
  it("has no duplicate codes", () => {
    // The demo data already reused 1101 for two unrelated meanings (定位稳定 and
    // 远程接管中). A dictionary that allows that is not a dictionary.
    const codes = REPORT_CODES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("numbers every code by its own channel and subsystem", () => {
    // `S B N N` — the scheme is only useful if it actually holds, and a table this
    // size is exactly where a typo hides.
    for (const entry of REPORT_CODES) {
      const digits = String(entry.code);
      expect(digits, `${entry.code} length`).toHaveLength(4);
      expect(digits[0], `${entry.code} channel digit`).toBe(
        CHANNEL_DIGIT[entry.channel],
      );
    }
  });

  it("gives every code a label, a cause and something to do about it", () => {
    // A dictionary entry without a hint is a number with a nicer name — the whole
    // point is the last column.
    for (const entry of REPORT_CODES) {
      expect(entry.label, `${entry.code} label`).toBeTruthy();
      expect(
        entry.description.length,
        `${entry.code} description`,
      ).toBeGreaterThan(10);
      expect(entry.hint.length, `${entry.code} hint`).toBeGreaterThan(10);
      expect(CODE_SUBSYSTEMS[entry.subsystem], entry.subsystem).toBeTruthy();
      expect(CODE_IMPACTS[entry.impact], entry.impact).toBeTruthy();
    }
  });

  it("keeps info codes free of operational impact, and errors never free of it", () => {
    // The two axes are independent (VDA keeps `errorLevel` apart from whether a thing
    // is an error at all), but these two ends of them cannot legitimately cross.
    for (const entry of REPORT_CODES) {
      if (entry.channel === "info") {
        expect(entry.impact, `${entry.code}`).toBe("none");
      }
      if (entry.channel === "error") {
        expect(["blocked", "intervention"], `${entry.code}`).toContain(
          entry.impact,
        );
      }
    }
  });

  it("states every impact as a capability rather than a feeling", () => {
    // Copied from VDA 5050 deliberately: "can it continue, can it accept work" is
    // actionable, "how bad is it" is not.
    for (const meta of Object.values(CODE_IMPACTS)) {
      expect(meta.meaning).toMatch(/任务|处理|了解/);
    }
  });

  it("keeps the three codes v1.0.0 already emitted", () => {
    // Changing what these mean would silently reinterpret existing mock data, the e2e
    // seed, and any deployment already running them.
    expect(lookupReportCode(1101)?.label).toBe("定位稳定");
    expect(lookupReportCode(2203)?.label).toBe("限速区降速");
    expect(lookupReportCode(5102)?.label).toBe("路径规划超时");
  });
});

describe("looking a code up", () => {
  it("finds a known code", () => {
    expect(lookupReportCode(5701)?.subsystem).toBe("safety");
  });

  it("treats zero and nonsense as no code at all", () => {
    // `0` is the device's "nothing to report", and it arrives as both a number and a
    // string — the same coercion trap `getDeviceTone` was fixed for.
    expect(lookupReportCode(0)).toBeNull();
    expect(lookupReportCode("0")).toBeNull();
    expect(lookupReportCode(undefined)).toBeNull();
    expect(lookupReportCode("n/a")).toBeNull();
  });

  it("returns null rather than a placeholder for an unknown number", () => {
    expect(lookupReportCode(9999)).toBeNull();
  });
});

describe("describing what the device reported", () => {
  it("pairs the dictionary's meaning with the device's own text", () => {
    // The device's string is the only part that can carry run-specific detail, so it
    // is kept rather than replaced by the canonical label.
    const described = describeCode(state(5102, "路径规划超时，已触发急停"));

    expect(described).toMatchObject({
      code: 5102,
      unknown: false,
      label: "路径规划超时",
      impact: "blocked",
      reported: "路径规划超时，已触发急停",
    });
    expect(described?.hint).toContain("重新派发");
  });

  it("says a code is unknown instead of guessing at it", () => {
    // The important case. A console that invents a plausible meaning is worse than one
    // that admits it does not know, because someone will act on the invention.
    const described = describeCode(state(7788, "驱动板 B 相异常"));

    expect(described).toMatchObject({ code: 7788, unknown: true });
    expect(described?.description).toContain("不在当前字典中");
    // The device's own words survive, because they are all the information there is.
    expect(described?.label).toBe("驱动板 B 相异常");
    expect(described?.reported).toBe("驱动板 B 相异常");
  });

  it("names an unknown code by its number when the device said nothing either", () => {
    expect(describeCode(state(7788))?.label).toBe("未知报码 7788");
  });

  it("returns nothing for a channel with no code", () => {
    expect(describeCode(state(0))).toBeNull();
    expect(describeCode(null)).toBeNull();
  });
});

describe("describing a whole device", () => {
  const device = (patch: Partial<Record<string, CodeState>> = {}) => ({
    errorCode: state(0),
    warningCode: state(0),
    infoCode: state(0),
    ...patch,
  });

  it("lists the channels that have something to say, worst first", () => {
    const rows = describeDeviceCodes(
      device({
        errorCode: state(5701),
        warningCode: state(2301),
        infoCode: state(1101),
      }),
    );

    expect(rows.map((row) => row.channel)).toEqual([
      "error",
      "warning",
      "info",
    ]);
    expect(rows[0]?.described.impact).toBe("intervention");
  });

  it("skips the silent channels rather than rendering three empty rows", () => {
    const rows = describeDeviceCodes(device({ warningCode: state(2401) }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe("warning");
  });

  it("says nothing at all about a healthy device", () => {
    expect(describeDeviceCodes(device())).toEqual([]);
    expect(describeDeviceCodes(null)).toEqual([]);
  });
});
