import { describe, expect, it } from "vitest";
import { DEFAULT_REPORT_CODES } from "@navfleet/shared";
import { CODE_TEXT } from "../sim/profiles";

/**
 * Every code the demo can emit must be defined in the shared report-code dictionary. When it is
 * not, the console looks the code up, misses, and shows "未知报码 N" instead of the code's
 * meaning / 处理建议 / 影响等级 — which is exactly the gap a 15.5%-vs-16% audit turned up (the sim
 * emitted 1502 / 1503 / 2802 / 5703, none of them in the dictionary). This pins the two sides
 * together so the next added sim code without a dictionary entry fails here, not in the UI.
 */
describe("sim report codes are all in the dictionary", () => {
  const known = new Set(DEFAULT_REPORT_CODES.map((entry) => entry.code));

  it("defines every code the simulator's CODE_TEXT can report", () => {
    const missing = Object.keys(CODE_TEXT)
      .map(Number)
      .filter((code) => !known.has(code));
    expect(missing).toEqual([]);
  });
});
