import { describe, it, expect } from "vitest";
import { MERGE_SPECS, mergeConfig } from "../src/configMerge";

/**
 * The three-way merge behind 无感 concurrent editing. Every case is "base B, our edit O, their
 * save T": a merge may only happen when the result is unambiguous; anything else must conflict.
 */
const vehicles = MERGE_SPECS.vehicles;
const v = (deviceId: string, deviceName = deviceId) => ({ deviceId, deviceName });

describe("mergeConfig — list files (per entry id)", () => {
  const base = [v("a"), v("b"), v("c")];

  it("merges edits to different entries", () => {
    const ours = [v("a", "A 改名"), v("b"), v("c")];
    const theirs = [v("a"), v("b", "B 改名"), v("c")];
    expect(mergeConfig(vehicles, base, ours, theirs)).toEqual({
      ok: true,
      value: [v("a", "A 改名"), v("b", "B 改名"), v("c")],
    });
  });

  it("keeps both sides' additions and honours an untouched-side deletion", () => {
    const ours = [...base, v("d")];
    const theirs = [v("a"), v("c"), v("e")]; // they deleted b and added e
    expect(mergeConfig(vehicles, base, ours, theirs)).toEqual({
      ok: true,
      value: [v("a"), v("c"), v("e"), v("d")],
    });
  });

  it("conflicts when both changed the same entry differently", () => {
    const ours = [v("a", "我改的"), v("b"), v("c")];
    const theirs = [v("a", "他改的"), v("b"), v("c")];
    expect(mergeConfig(vehicles, base, ours, theirs)).toEqual({ ok: false });
  });

  it("accepts the identical change made on both sides", () => {
    const both = [v("a", "同样的名字"), v("b"), v("c")];
    expect(mergeConfig(vehicles, base, both, both)).toEqual({ ok: true, value: both });
  });

  it("conflicts on delete versus modify, either way round", () => {
    expect(mergeConfig(vehicles, base, [v("b"), v("c")], [v("a", "改"), v("b"), v("c")])).toEqual({
      ok: false,
    });
    expect(mergeConfig(vehicles, base, [v("a", "改"), v("b"), v("c")], [v("b"), v("c")])).toEqual({
      ok: false,
    });
  });

  it("conflicts when both added the same id with different content", () => {
    expect(mergeConfig(vehicles, base, [...base, v("x", "一")], [...base, v("x", "二")])).toEqual({
      ok: false,
    });
  });

  it("refuses to guess when an entry has no id or an id repeats", () => {
    expect(mergeConfig(vehicles, base, [...base, { deviceName: "无 id" }], base).ok).toBe(true);
    expect(mergeConfig(vehicles, base, [...base, v("a")], [v("a"), v("b", "改"), v("c")])).toEqual({
      ok: false,
    });
  });

  it("ignores key order when deciding whether an entry changed", () => {
    const reordered = [{ deviceName: "a", deviceId: "a" }, v("b"), v("c")];
    expect(mergeConfig(vehicles, base, reordered, [v("a"), v("b", "改"), v("c")])).toMatchObject({
      ok: true,
    });
  });
});

describe("mergeConfig — record files", () => {
  it("merges notify channels by id and groups by name", () => {
    const base = { channels: [{ id: "w", enabled: true }], groups: { ops: ["a@x.io"] } };
    const ours = { channels: [{ id: "w", enabled: false }], groups: { ops: ["a@x.io"] } };
    const theirs = {
      channels: [
        { id: "w", enabled: true },
        { id: "m", enabled: true },
      ],
      groups: { ops: ["a@x.io"], night: ["n@x.io"] },
    };
    expect(mergeConfig(MERGE_SPECS.notify, base, ours, theirs)).toEqual({
      ok: true,
      value: {
        channels: [
          { id: "w", enabled: false },
          { id: "m", enabled: true },
        ],
        groups: { ops: ["a@x.io"], night: ["n@x.io"] },
      },
    });
  });

  it("treats each alert rule as one unit", () => {
    const base = { lowBattery: { thresholdPct: 20 }, offline: { afterSeconds: 60 } };
    const ours = { lowBattery: { thresholdPct: 25 }, offline: { afterSeconds: 60 } };
    const theirsOther = { lowBattery: { thresholdPct: 20 }, offline: { afterSeconds: 90 } };
    expect(mergeConfig(MERGE_SPECS.rules, base, ours, theirsOther)).toEqual({
      ok: true,
      value: { lowBattery: { thresholdPct: 25 }, offline: { afterSeconds: 90 } },
    });
    const theirsSame = { lowBattery: { thresholdPct: 30 }, offline: { afterSeconds: 60 } };
    expect(mergeConfig(MERGE_SPECS.rules, base, ours, theirsSame)).toEqual({ ok: false });
  });
});
