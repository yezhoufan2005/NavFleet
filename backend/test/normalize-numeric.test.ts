import { describe, expect, it } from "vitest";
import { normalizePayload } from "../src/normalize";

/**
 * The backend half of the `toNumeric` parity claim at `src/normalize.ts:22-25`.
 *
 * `packages/fleet-core/test/numeric-readings.test.ts` asserts the same table against
 * fleet-core's copy. The two implementations are separate on purpose (the backend does
 * not depend on fleet-core), so the only thing that can keep them honest is both sides
 * pinning the same behaviour — a comment saying "kept identical" cannot, and did not:
 * fleet-core's copy was missing the null guard entirely.
 *
 * `toNumeric` is module-private, so this exercises it through `normalizePayload`, which
 * is how it is actually reached.
 */

const frameWith = (vehicleInfo: Record<string, unknown>): Record<string, unknown> => ({
  deviceId: "agv-1",
  stamp: "2026-09-09T00:00:00.000Z",
  vehicle_info: vehicleInfo,
});

const socOf = (vehicleInfo: Record<string, unknown>): number | null | undefined => {
  const result = normalizePayload(
    frameWith(vehicleInfo),
    new Map(),
    "fleet",
    "/fleet/{deviceId}/vehicle_info",
    {},
  );
  return result.devices[0]?.vehicleInfo.soc;
};

describe("numeric telemetry readings (backend side of the fleet-core parity)", () => {
  const cases: ReadonlyArray<[label: string, input: unknown, expected: number | null]> = [
    ["a number", 42, 42],
    ["a real zero", 0, 0],
    ["a negative number", -3.5, -3.5],
    ["a numeric string", "12.5", 12.5],
    ["null", null, null],
    ["an empty string", "", null],
    ["a non-numeric string", "n/a", null],
  ];

  for (const [label, input, expected] of cases) {
    it(`maps ${label} to ${JSON.stringify(expected)}`, () => {
      expect(socOf({ soc: input })).toBe(expected);
    });
  }

  it("leaves an omitted field missing rather than zero", () => {
    expect(socOf({ speed: 1 })).toBeNull();
  });

  it("keeps a device with no pose out of the map origin", () => {
    const result = normalizePayload(
      { deviceId: "agv-1", stamp: "2026-09-09T00:00:00.000Z", fusion_loc: { x: null, y: null } },
      new Map(),
      "fleet",
      "/fleet/{deviceId}/vehicle_info",
      {},
    );
    expect(result.devices[0]?.fusionLoc.x).toBeNull();
    expect(result.devices[0]?.fusionLoc.y).toBeNull();
  });
});
