import { describe, it, expect } from "vitest";
import { parseVehicles, parseFormations } from "@navfleet/shared";

/**
 * Shared validators for the device-onboarding wizard (Phase 18). They mirror `parseCodebook`:
 * accept a JSON array, throw a labelled message on the first problem, and default the fields
 * the config registry defaults at load time. Referential integrity (formation → vehicle) is
 * NOT here — it lives at the write site, which knows the current vehicle set.
 */
describe("parseVehicles", () => {
  it("accepts a valid array and defaults deviceName to the id", () => {
    const out = parseVehicles([
      { deviceId: "agv-1", gpsEnabled: true, tags: ["巡检"] },
      { deviceId: "agv-2", deviceName: "二号车" },
    ]);
    expect(out).toEqual([
      {
        deviceId: "agv-1",
        deviceName: "agv-1",
        defaultSceneId: undefined,
        gpsEnabled: true,
        rosMapEnabled: undefined,
        tags: ["巡检"],
      },
      {
        deviceId: "agv-2",
        deviceName: "二号车",
        defaultSceneId: undefined,
        gpsEnabled: undefined,
        rosMapEnabled: undefined,
        tags: undefined,
      },
    ]);
  });

  it("rejects a non-array, a missing/empty deviceId, a duplicate, and a bad field type", () => {
    expect(() => parseVehicles({})).toThrow(/must be a JSON array/);
    expect(() => parseVehicles([{ deviceId: "" }])).toThrow(
      /deviceId must be a non-empty string/,
    );
    expect(() => parseVehicles([{ deviceId: "a" }, { deviceId: "a" }])).toThrow(
      /duplicate deviceId: a/,
    );
    expect(() => parseVehicles([{ deviceId: "a", gpsEnabled: "yes" }])).toThrow(
      /gpsEnabled must be a boolean/,
    );
    expect(() => parseVehicles([{ deviceId: "a", tags: [""] }])).toThrow(
      /tags\[0\] must be a non-empty string/,
    );
  });
});

describe("parseFormations", () => {
  it("accepts a valid array and defaults formationName to the id", () => {
    const out = parseFormations([
      { formationId: "f1", deviceIds: ["agv-1", "agv-2"], color: "#46d7c3" },
    ]);
    expect(out).toEqual([
      {
        formationId: "f1",
        formationName: "f1",
        deviceIds: ["agv-1", "agv-2"],
        sceneId: undefined,
        description: undefined,
        color: "#46d7c3",
      },
    ]);
  });

  it("rejects a missing/empty formationId, a duplicate, and empty deviceIds", () => {
    expect(() => parseFormations([{ formationId: "" }])).toThrow(
      /formationId must be a non-empty string/,
    );
    expect(() =>
      parseFormations([
        { formationId: "f", deviceIds: ["a"] },
        { formationId: "f", deviceIds: ["a"] },
      ]),
    ).toThrow(/duplicate formationId: f/);
    expect(() =>
      parseFormations([{ formationId: "f", deviceIds: [] }]),
    ).toThrow(/deviceIds must not be empty/);
  });
});
