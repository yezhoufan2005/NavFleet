import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_REPORT_CODES, mergeCodebook, parseCodebook } from "@navfleet/shared";
import { CODE_TEXT, FIRMWARE_CODES } from "../sim/profiles";

/**
 * Every code the demo can emit must be defined in the dictionary the demo deployment ships — the
 * built-in table plus config-runtime/codebook.json — except the trial firmware's, which are
 * unknown on purpose. When a code is missing, the console looks it up, misses, and shows "未知报码
 * N" instead of the code's meaning / 处理建议 / 影响等级 — which is exactly the gap a 15.5%-vs-16%
 * audit turned up (the sim emitted 1502 / 1503 / 2802 / 5703, none of them in the dictionary). This
 * pins the sides together so the next added sim code without an entry fails here, not in the UI.
 */
describe("sim report codes are all in the dictionary", () => {
  const shipped = parseCodebook(
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../config-runtime/codebook.json"), "utf8"),
    ),
  );
  const known = new Set(mergeCodebook(DEFAULT_REPORT_CODES, shipped).map((entry) => entry.code));
  const trial = new Set(FIRMWARE_CODES.map((entry) => entry.code));

  it("defines every code the simulator's CODE_TEXT can report, but the trial firmware's", () => {
    const missing = Object.keys(CODE_TEXT)
      .map(Number)
      .filter((code) => !known.has(code) && !trial.has(code));
    expect(missing).toEqual([]);
  });

  it("keeps the trial firmware's codes out of the dictionary, so they show as unknown", () => {
    expect([...trial].filter((code) => known.has(code))).toEqual([]);
  });
});
