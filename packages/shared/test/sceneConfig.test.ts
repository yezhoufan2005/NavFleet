import { describe, it, expect } from "vitest";
import { parseScenes } from "../src/index";

/**
 * Shared validator for the scene-map management page. Mirrors parseVehicles: a JSON
 * array, a labelled throw on the first problem, defaults filled. The security-relevant rules are
 * the path-safe sceneId and the `/scene-maps/`-confined asset URLs — an id becomes a directory
 * segment and a URL becomes a fetch, so both are validated here as well as at the write site.
 */
describe("parseScenes", () => {
  it("accepts a valid array, defaults sceneName/mapFrame/origin, and keeps geometry", () => {
    const out = parseScenes([
      { sceneId: "yard", resolution: 0.05, width: 800, height: 600 },
      {
        sceneId: "line-a",
        sceneName: "总装产线",
        mapFrame: "line",
        resolution: 0.1,
        origin: { x: 1, y: 2, yaw: 0.5 },
        width: 1000,
        height: 620,
        imageUrl: "/scene-maps/line-a/image.svg",
        bounds: { minX: -1, maxX: 99, minY: -2, maxY: 60 },
      },
    ]);
    expect(out[0]).toEqual({
      sceneId: "yard",
      sceneName: "yard",
      mapFrame: "map",
      resolution: 0.05,
      origin: { x: 0, y: 0, yaw: 0 },
      width: 800,
      height: 600,
    });
    expect(out[1]?.imageUrl).toBe("/scene-maps/line-a/image.svg");
    expect(out[1]?.bounds).toEqual({ minX: -1, maxX: 99, minY: -2, maxY: 60 });
  });

  it("drops a client-supplied overlayUrl/overlayType (the backend mints those)", () => {
    const [scene] = parseScenes([
      {
        sceneId: "yard",
        resolution: 0.05,
        width: 800,
        height: 600,
        overlayUrl: "https://evil.example/overlay",
        overlayType: "lanelet2",
      },
    ]);
    expect(scene).not.toHaveProperty("overlayUrl");
    expect(scene).not.toHaveProperty("overlayType");
  });

  it("rejects a non-array, bad geometry, duplicates, and unsafe ids/urls", () => {
    expect(() => parseScenes({})).toThrow(/must be a JSON array/);
    expect(() => parseScenes([{ sceneId: "" }])).toThrow(/non-empty string/);
    expect(() => parseScenes([{ sceneId: "../etc" }])).toThrow(
      /letters, digits/,
    );
    expect(() =>
      parseScenes([{ sceneId: "..", resolution: 1, width: 1, height: 1 }]),
    ).toThrow(/letters, digits/);
    expect(() =>
      parseScenes([
        { sceneId: "a", resolution: 1, width: 1, height: 1 },
        { sceneId: "a", resolution: 1, width: 1, height: 1 },
      ]),
    ).toThrow(/duplicate sceneId: a/);
    expect(() =>
      parseScenes([{ sceneId: "a", resolution: 0, width: 1, height: 1 }]),
    ).toThrow(/resolution must be greater than 0/);
    expect(() =>
      parseScenes([
        { sceneId: "a", resolution: 1, width: Infinity, height: 1 },
      ]),
    ).toThrow(/width must be greater than 0|finite/);
    expect(() =>
      parseScenes([
        {
          sceneId: "a",
          resolution: 1,
          width: 1,
          height: 1,
          imageUrl: "/evil/x.svg",
        },
      ]),
    ).toThrow(/must start with \/scene-maps\//);
  });
});

describe("scene cross-field rules", () => {
  const base = { sceneId: "s", resolution: 0.1, width: 100, height: 50 };

  it("rejects inverted or empty bounds", () => {
    expect(() =>
      parseScenes([
        { ...base, bounds: { minX: 10, maxX: 0, minY: 0, maxY: 5 } },
      ]),
    ).toThrow(/maxX must be greater than minX/);
    expect(() =>
      parseScenes([
        { ...base, bounds: { minX: 0, maxX: 10, minY: 5, maxY: 5 } },
      ]),
    ).toThrow(/maxY must be greater than minY/);
  });

  it("requires minZoom ≤ maxZoom and a positive minZoom", () => {
    expect(() => parseScenes([{ ...base, minZoom: 6, maxZoom: 2 }])).toThrow(
      /must not exceed/,
    );
    expect(() => parseScenes([{ ...base, minZoom: 0 }])).toThrow(
      /greater than 0/,
    );
  });

  it("requires whole-pixel width/height and a real lat/lng", () => {
    expect(() => parseScenes([{ ...base, width: 100.5 }])).toThrow(
      /whole number/,
    );
    expect(() =>
      parseScenes([{ ...base, osmProjectionOrigin: { lat: 120, lng: 0 } }]),
    ).toThrow(/lat must be between/);
  });
});
