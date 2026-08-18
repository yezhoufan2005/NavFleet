import { describe, it, expect } from "vitest";
import { wgs84ToGcj02 } from "../../src/utils/gps";

describe("wgs84ToGcj02", () => {
  it("returns null for non-finite input", () => {
    expect(wgs84ToGcj02(Number.NaN, 31)).toBeNull();
    expect(wgs84ToGcj02(121, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("passes coordinates outside mainland China through unchanged", () => {
    // Tokyo — outside the China bounding box
    expect(wgs84ToGcj02(139.6917, 35.6895)).toEqual([139.6917, 35.6895]);
  });

  it("applies a small offset for coordinates inside China (Shanghai)", () => {
    const result = wgs84ToGcj02(121.4737, 31.2304);
    expect(result).not.toBeNull();
    const [lng, lat] = result!;
    // GCJ02 offset in Shanghai is on the order of a few thousandths of a degree
    expect(Math.abs(lng - 121.4737)).toBeGreaterThan(0.001);
    expect(Math.abs(lng - 121.4737)).toBeLessThan(0.02);
    expect(Math.abs(lat - 31.2304)).toBeGreaterThan(0.001);
    expect(Math.abs(lat - 31.2304)).toBeLessThan(0.02);
  });
});
