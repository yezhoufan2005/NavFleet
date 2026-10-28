import { describe, it, expect } from "vitest";
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

/** Scene-map geometry as fleet-core consumes it (the pure transforms are tested in shared). */
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
