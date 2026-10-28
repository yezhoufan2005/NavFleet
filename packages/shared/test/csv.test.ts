import { describe, it, expect } from "vitest";
import { csvField } from "../src/csv";

describe("csvField", () => {
  it("quotes cells holding a quote, comma or line break", () => {
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField(3)).toBe("3");
  });

  it("neutralises text a spreadsheet would run as a formula, but leaves numbers alone", () => {
    expect(csvField('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvField("+cmd")).toBe("'+cmd");
    expect(csvField("@sum")).toBe("'@sum");
    expect(csvField(-3.5)).toBe("-3.5");
    expect(csvField("A01 巡检车")).toBe("A01 巡检车");
  });
});
