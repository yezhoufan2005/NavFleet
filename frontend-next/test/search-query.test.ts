import { describe, it, expect } from "vitest";
import { compileSearch } from "@/lib/searchQuery";

/**
 * The boolean search language behind 设备 / 消息 搜索. The cases worth pinning: adjacent terms are
 * an implicit AND, the three operators each have Latin / CJK / symbol spellings, precedence is
 * NOT > AND > OR, parentheses group, a lone CJK operator char inside a word is *not* an operator,
 * and anything malformed degrades to a plain substring match rather than throwing.
 */
describe("compileSearch", () => {
  it("matches everything when the query is blank", () => {
    const match = compileSearch("   ");
    expect(match("anything")).toBe(true);
  });

  it("is a case-insensitive substring for a single term", () => {
    const match = compileSearch("AGV");
    expect(match("agv-a01 康城")).toBe(true);
    expect(match("truck-7")).toBe(false);
  });

  it("treats adjacent terms as an implicit AND", () => {
    const match = compileSearch("agv 康城");
    expect(match("agv-a01 · 康城 Airy 路网")).toBe(true);
    expect(match("agv-a01 · 北区堆场")).toBe(false);
  });

  it("reads the mixed example as all-four-AND", () => {
    // `agv-a01 and 康城 Airy 路网` → agv-a01 AND 康城 AND Airy AND 路网.
    const match = compileSearch("agv-a01 and 康城 Airy 路网");
    expect(match("agv-a01 康城 airy 路网")).toBe(true);
    expect(match("agv-a01 北区堆场")).toBe(false);
  });

  it("accepts every spelling of OR", () => {
    for (const query of ["a or b", "a OR b", "a 或 b", "a | b"]) {
      const match = compileSearch(query);
      expect(match("x a y"), query).toBe(true);
      expect(match("x b y"), query).toBe(true);
      expect(match("x c y"), query).toBe(false);
    }
  });

  it("accepts every spelling of AND and NOT", () => {
    for (const query of ["a and b", "a & b", "a 与 b"]) {
      expect(compileSearch(query)("a b"), query).toBe(true);
      expect(compileSearch(query)("a c"), query).toBe(false);
    }
    for (const query of ["not b", "NOT b", "非 b", "~b"]) {
      expect(compileSearch(query)("a c"), query).toBe(true);
      expect(compileSearch(query)("a b"), query).toBe(false);
    }
  });

  it("binds NOT tighter than AND, and AND tighter than OR", () => {
    // a AND NOT b
    const andNot = compileSearch("a and not b");
    expect(andNot("a c")).toBe(true);
    expect(andNot("a b")).toBe(false);
    // a OR (b AND c) — the b-and-c branch needs both
    const orAnd = compileSearch("a or b c");
    expect(orAnd("a only")).toBe(true);
    expect(orAnd("b c together")).toBe(true);
    expect(orAnd("b x")).toBe(false);
  });

  it("groups with parentheses, ASCII or fullwidth", () => {
    const match = compileSearch("(a or b) and c");
    expect(match("a c")).toBe(true);
    expect(match("b c")).toBe(true);
    expect(match("a only")).toBe(false);
    expect(compileSearch("（a or b) c")("b c")).toBe(true);
  });

  it("does not treat a CJK operator char embedded in a word as an operator", () => {
    // 「参与区」 contains 与 but is one term, so this is a single substring, not A-AND-B.
    const match = compileSearch("参与区");
    expect(match("设备在参与区巡检")).toBe(true);
    expect(match("设备在北区")).toBe(false);
  });

  it("falls back to a literal match when the query is malformed", () => {
    // A dangling operator cannot parse; rather than throw, match the raw text literally.
    const match = compileSearch("a and");
    expect(match("x a and y")).toBe(true);
    expect(match("a without the operator word")).toBe(false);
  });
});
