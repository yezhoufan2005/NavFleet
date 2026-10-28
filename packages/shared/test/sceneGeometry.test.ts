import { describe, it, expect } from "vitest";
import {
  mapFootprintBounds,
  mapToWorld,
  toScenePose,
  worldToMap,
  yawToDegrees,
} from "../src/index";

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
