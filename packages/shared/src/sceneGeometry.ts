/**
 * Scene-map geometry: where a map's rectangle lands in the world frame.
 *
 * Scene maps follow the ROS `map_server` convention. `origin` is the world pose of the map's
 * **lower-left** corner, and `origin.yaw` (radians, counter-clockwise, world frame) rotates the
 * whole map about that corner. Map coordinates `(u, v)` are metres along the map's own right
 * and up edges, so a map that is `width × height` cells at `resolution` spans
 * `u ∈ [0, width·resolution]`, `v ∈ [0, height·resolution]`.
 *
 * Every consumer — the backend's derived scene bounds, the point-cloud rasterizer, the console's
 * backdrop placement — goes through these helpers, so a rotated map is placed the same way
 * everywhere. At `yaw = 0` the maths reduces exactly (cos 0 = 1, sin 0 = 0) to the axis-aligned
 * `origin + (u, v)` the platform used before yaw was honoured, so unrotated scenes are unchanged.
 */

export interface ScenePose {
  x: number;
  y: number;
  yaw: number;
}

export interface SceneBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A pose whose missing/non-finite fields read as 0 — scene parts arrive partial. */
export const toScenePose = (
  origin: { x?: unknown; y?: unknown; yaw?: unknown } | null | undefined,
): ScenePose => {
  const finite = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    x: finite(origin?.x),
    y: finite(origin?.y),
    yaw: finite(origin?.yaw),
  };
};

/** Map coordinates (metres along the map's edges) → world coordinates. */
export const mapToWorld = (
  pose: ScenePose,
  u: number,
  v: number,
): { x: number; y: number } => {
  const cos = Math.cos(pose.yaw);
  const sin = Math.sin(pose.yaw);
  return { x: pose.x + u * cos - v * sin, y: pose.y + u * sin + v * cos };
};

/** World coordinates → map coordinates; the inverse of {@link mapToWorld}. */
export const worldToMap = (
  pose: ScenePose,
  x: number,
  y: number,
): { u: number; v: number } => {
  const cos = Math.cos(pose.yaw);
  const sin = Math.sin(pose.yaw);
  const dx = x - pose.x;
  const dy = y - pose.y;
  return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos };
};

/**
 * The axis-aligned world bounds of a `widthM × heightM` map placed at `pose` — the box around
 * its four (possibly rotated) corners. This is what the viewport fits and pans within.
 */
export const mapFootprintBounds = (
  pose: ScenePose,
  widthM: number,
  heightM: number,
): SceneBounds => {
  const corners = [
    mapToWorld(pose, 0, 0),
    mapToWorld(pose, widthM, 0),
    mapToWorld(pose, 0, heightM),
    mapToWorld(pose, widthM, heightM),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
};

/** Radians (counter-clockwise) → degrees, for an SVG `rotate()` in a y-up world frame. */
export const yawToDegrees = (yaw: number): number => (yaw * 180) / Math.PI;
