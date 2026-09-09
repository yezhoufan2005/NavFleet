import { describe, expect, it } from "vitest";
import { hasPose, normalizeDevice, toNumeric } from "../src/fleetNormalize";
import { formatNumber } from "../src/formatters";

/**
 * `toNumeric` had no test at all, which is how it kept a defect that the formatter
 * downstream of it was explicitly written — and documented — to prevent.
 *
 * The table below is deliberately the same table `backend/test/normalize-numeric.test.ts`
 * asserts. `backend/src/normalize.ts:22-25` claims the two implementations are kept
 * behaviourally identical; a claim in a comment is not a guard, so both sides now pin it.
 */
const NUMERIC_CASES: ReadonlyArray<
  [label: string, input: unknown, expected: number | null]
> = [
  ["a number", 42, 42],
  ["a real zero", 0, 0],
  ["a negative number", -3.5, -3.5],
  ["a numeric string", "12.5", 12.5],
  ["null", null, null],
  ["undefined", undefined, null],
  ["an empty string", "", null],
  ["a non-numeric string", "n/a", null],
  ["NaN", Number.NaN, null],
  ["Infinity", Number.POSITIVE_INFINITY, null],
];

describe("toNumeric", () => {
  for (const [label, input, expected] of NUMERIC_CASES) {
    it(`maps ${label} to ${JSON.stringify(expected)}`, () => {
      expect(toNumeric(input)).toBe(expected);
    });
  }

  it("returns the supplied fallback rather than zero for a missing reading", () => {
    // This is the shape the merge path uses: keep the previous reading when the new
    // frame omits the field. `Number(null) === 0` meant the fallback was unreachable.
    expect(toNumeric(null, 80)).toBe(80);
    expect(toNumeric(undefined, 80)).toBe(80);
    expect(toNumeric("", 80)).toBe(80);
  });

  it("still prefers a real reading over the fallback, including zero", () => {
    expect(toNumeric(0, 80)).toBe(0);
  });
});

describe("a device that has never reported telemetry", () => {
  /** What the backend serialises for a configured-but-silent device. */
  const silentSnapshot = {
    deviceId: "agv-silent",
    online: false,
    vehicleInfo: { soc: null, speed: null, controlMode: null, gear: null },
    speedLimit: { limit: null },
    fusionLoc: { x: null, y: null, yaw: null },
    lidarLoc: { x: null, y: null, yaw: null },
    gps: { lat: null, lng: null },
  };

  it("keeps its missing readings missing instead of inventing zeros", () => {
    const device = normalizeDevice(silentSnapshot);

    expect(device.vehicleInfo.soc).toBeNull();
    expect(device.vehicleInfo.speed).toBeNull();
    expect(device.vehicleInfo.controlMode).toBeNull();
    expect(device.speedLimit.limit).toBeNull();
  });

  it("is not placed at the map origin", () => {
    const device = normalizeDevice(silentSnapshot);

    // The visible symptom: `{x: 0, y: 0}` is a perfectly valid pose, so a vehicle
    // that has never reported one was drawn at the site map's origin.
    expect(device.fusionLoc.x).toBeNull();
    expect(device.fusionLoc.y).toBeNull();
    expect(hasPose(device.fusionLoc)).toBe(false);
    expect(hasPose(device.lidarLoc)).toBe(false);
  });

  it("renders as a placeholder, which is what formatNumber was written to do", () => {
    const device = normalizeDevice(silentSnapshot);

    // formatNumber's guard has always been correct; it just never saw a null.
    expect(formatNumber(device.vehicleInfo.soc, 0, "%")).toBe("--");
    expect(formatNumber(device.speedLimit.limit)).toBe("--");
    // A genuine zero still formats as a reading.
    expect(formatNumber(0, 0, "%")).toBe("0%");
  });
});
