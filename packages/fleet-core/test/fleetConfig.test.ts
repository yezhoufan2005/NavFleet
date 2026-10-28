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

  it("treats a whitespace-only deviceName as empty and defaults it to the id", () => {
    // `optionalString` used to only test `=== ""`, so a "   " name survived instead of
    // defaulting to the id, leaving a blank-looking label.
    const [vehicle] = parseVehicles([{ deviceId: "agv-1", deviceName: "   " }]);
    expect(vehicle?.deviceName).toBe("agv-1");
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

describe("vehicle / formation field rules", () => {
  it("trims a device id and rejects one that can never match an MQTT topic", () => {
    expect(parseVehicles([{ deviceId: "  agv-1  " }])[0]?.deviceId).toBe(
      "agv-1",
    );
    for (const bad of ["agv 1", "agv/1", "agv+1", "agv#1"]) {
      expect(() => parseVehicles([{ deviceId: bad }])).toThrow(
        /must not contain spaces/,
      );
    }
    expect(() => parseVehicles([{ deviceId: "x".repeat(201) }])).toThrow(
      /at most 200/,
    );
  });

  it("treats ids differing only by surrounding spaces as duplicates", () => {
    expect(() =>
      parseVehicles([{ deviceId: "agv-1" }, { deviceId: " agv-1" }]),
    ).toThrow(/duplicate deviceId/);
  });

  it("bounds free text, checks the commissioning date, and dedupes tags", () => {
    expect(() =>
      parseVehicles([{ deviceId: "a", deviceName: "名".repeat(201) }]),
    ).toThrow(/at most 200/);
    expect(() =>
      parseVehicles([{ deviceId: "a", commissionedAt: "去年" }]),
    ).toThrow(/YYYY-MM-DD/);
    expect(
      parseVehicles([{ deviceId: "a", commissionedAt: "2024-03-18" }])[0]
        ?.commissionedAt,
    ).toBe("2024-03-18");
    expect(
      parseVehicles([{ deviceId: "a", tags: ["巡检", " 巡检 ", "室外"] }])[0]
        ?.tags,
    ).toEqual(["巡检", "室外"]);
  });

  it("checks a formation colour and dedupes its members", () => {
    expect(() =>
      parseFormations([{ formationId: "f", deviceIds: ["a"], color: "green" }]),
    ).toThrow(/hex colour/);
    expect(
      parseFormations([
        { formationId: "f", deviceIds: ["a"], color: "#46d7c3" },
      ])[0]?.color,
    ).toBe("#46d7c3");
    expect(
      parseFormations([{ formationId: "f", deviceIds: ["a", "a ", "b"] }])[0]
        ?.deviceIds,
    ).toEqual(["a", "b"]);
  });
});
