import { describe, it, expect } from "vitest";
import {
  mapFootprintBounds,
  mapToWorld,
  toScenePose,
  worldToMap,
  yawToDegrees,
} from "@navfleet/shared";
import { mergeSceneDefinitionParts } from "../src/fleetNormalize";
import {
  buildOccupancyGrid,
  CELL_EMPTY,
  CELL_FLOOR,
  derivePointCloudGeometry,
} from "../src/pointCloud";

/** A minimal binary PCD (float32 x y z) — enough to bin points into a grid. */
const pcdOf = (
  points: Array<{ x: number; y: number; z: number }>,
): ArrayBuffer => {
  const header =
    "VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n" +
    `WIDTH ${points.length}\nHEIGHT 1\nPOINTS ${points.length}\nDATA binary\n`;
  const headerBytes = new TextEncoder().encode(header);
  const buffer = new ArrayBuffer(headerBytes.length + points.length * 12);
  new Uint8Array(buffer).set(headerBytes, 0);
  const view = new DataView(buffer);
  points.forEach((point, index) => {
    const offset = headerBytes.length + index * 12;
    view.setFloat32(offset, point.x, true);
    view.setFloat32(offset + 4, point.y, true);
    view.setFloat32(offset + 8, point.z, true);
  });
  return buffer;
};

/**
 * Scene-map geometry (`@navfleet/shared` sceneGeometry) and its fleet-core consumer. The ROS
 * map_server convention: origin is the lower-left corner's world pose, yaw rotates about it.
 */
const close = (actual: { x: number; y: number }, x: number, y: number) => {
  expect(actual.x).toBeCloseTo(x, 9);
  expect(actual.y).toBeCloseTo(y, 9);
};

describe("sceneGeometry", () => {
  it("is plain origin + offset at yaw 0 (unrotated scenes unchanged)", () => {
    close(mapToWorld({ x: 3, y: -2, yaw: 0 }, 10, 5), 13, 3);
    expect(mapFootprintBounds({ x: 3, y: -2, yaw: 0 }, 10, 5)).toEqual({
      minX: 3,
      maxX: 13,
      minY: -2,
      maxY: 3,
    });
  });

  it("rotates map axes counter-clockwise about the lower-left corner", () => {
    const pose = { x: 1, y: 1, yaw: Math.PI / 2 };
    // The map's +u (right edge) points along world +y; its +v (up edge) along world -x.
    close(mapToWorld(pose, 4, 0), 1, 5);
    close(mapToWorld(pose, 0, 2), -1, 1);
  });

  it("worldToMap inverts mapToWorld at any yaw", () => {
    const pose = { x: -7.5, y: 12, yaw: 0.73 };
    const world = mapToWorld(pose, 6.25, -3.5);
    const back = worldToMap(pose, world.x, world.y);
    expect(back.u).toBeCloseTo(6.25, 9);
    expect(back.v).toBeCloseTo(-3.5, 9);
  });

  it("bounds a rotated map by the box around its four corners", () => {
    // 4 × 2 m map turned 90°: occupies x ∈ [-2, 0], y ∈ [0, 4].
    const bounds = mapFootprintBounds({ x: 0, y: 0, yaw: Math.PI / 2 }, 4, 2);
    expect(bounds.minX).toBeCloseTo(-2, 9);
    expect(bounds.maxX).toBeCloseTo(0, 9);
    expect(bounds.minY).toBeCloseTo(0, 9);
    expect(bounds.maxY).toBeCloseTo(4, 9);

    // 45° grows the box: a 2 × 2 square's diagonal becomes its width.
    const diamond = mapFootprintBounds({ x: 0, y: 0, yaw: Math.PI / 4 }, 2, 2);
    expect(diamond.maxX - diamond.minX).toBeCloseTo(2 * Math.SQRT2, 9);
  });

  it("reads a partial / non-finite origin as zeros", () => {
    expect(toScenePose(null)).toEqual({ x: 0, y: 0, yaw: 0 });
    expect(toScenePose({ x: 2, yaw: Number.NaN })).toEqual({
      x: 2,
      y: 0,
      yaw: 0,
    });
  });

  it("converts yaw radians to SVG degrees", () => {
    expect(yawToDegrees(Math.PI)).toBeCloseTo(180, 9);
  });
});

describe("mergeSceneDefinitionParts — derived bounds honour yaw", () => {
  it("derives the rotated footprint when no bounds are stated", () => {
    const merged = mergeSceneDefinitionParts(
      {
        origin: { x: 0, y: 0, yaw: Math.PI / 2 },
        width: 40,
        height: 20,
        resolution: 0.1,
      },
      {},
    );
    expect(merged.bounds.minX).toBeCloseTo(-2, 9);
    expect(merged.bounds.maxY).toBeCloseTo(4, 9);
  });

  it("still prefers explicitly stated bounds", () => {
    const stated = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    const merged = mergeSceneDefinitionParts(
      {
        origin: { x: 0, y: 0, yaw: 1 },
        width: 40,
        height: 20,
        resolution: 0.1,
        bounds: stated,
      },
      {},
    );
    expect(merged.bounds).toEqual(stated);
  });
});

describe("point-cloud grid — rotated by origin.yaw", () => {
  // A 2 × 1-cell grid (1 m cells) turned 90°: cell (0,0) covers world x ∈ [-1, 0], y ∈ [0, 1];
  // cell (1,0) covers y ∈ [1, 2].
  const ROTATED = {
    resolution: 1,
    origin: { x: 0, y: 0, yaw: Math.PI / 2 },
    width: 2,
    height: 1,
  };

  it("takes yaw from the metadata, else the scene", () => {
    expect(derivePointCloudGeometry(ROTATED).yaw).toBeCloseTo(Math.PI / 2, 9);
    expect(
      derivePointCloudGeometry(ROTATED, { origin: { x: 0, y: 0, yaw: 0.5 } })
        .yaw,
    ).toBe(0.5);
    expect(derivePointCloudGeometry({}).yaw).toBe(0);
  });

  it("bounds the rotated grid by its footprint", () => {
    const { bounds } = derivePointCloudGeometry(ROTATED);
    expect(bounds.minX).toBeCloseTo(-1, 9);
    expect(bounds.maxX).toBeCloseTo(0, 9);
    expect(bounds.minY).toBeCloseTo(0, 9);
    expect(bounds.maxY).toBeCloseTo(2, 9);
  });

  it("bins world points into the grid's own rotated frame", () => {
    const grid = buildOccupancyGrid(
      pcdOf([
        { x: -0.5, y: 1.5, z: 0 }, // map (u 1.5, v 0.5) → cell (1, 0)
        { x: 0.5, y: 0.5, z: 0 }, // outside the rotated grid (v < 0) → dropped
      ]),
      {},
      ROTATED,
    );
    expect([...grid.occupancy]).toEqual([CELL_EMPTY, CELL_FLOOR]);
  });
});
