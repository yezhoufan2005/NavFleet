/**
 * Where each demo vehicle drives: a closed loop in its scene, with the points along it that its
 * work happens at.
 *
 * Route sources, in order of preference: the scene's Lanelet2 road network, a hand-authored loop
 * laid in the scene's drivable space (the aisle band around the racks, the yard apron, the lane
 * around the conveyor, the mapped core of the point cloud), then a box inside the scene bounds.
 * A demo whose vehicles drive across blank space beside the map says nothing about whether the
 * map is right.
 */
import fs from "node:fs";
import path from "node:path";
import { mapFootprintBounds, mapToWorld, toScenePose } from "@navfleet/shared";
import { parseLaneletOsmFile } from "../src/laneletOsm";

export interface Point {
  x: number;
  y: number;
}

export interface Pose extends Point {
  yaw: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface SceneConfig {
  sceneId: string;
  bounds?: Bounds;
  origin?: { x?: number; y?: number; yaw?: number };
  width?: number;
  height?: number;
  resolution?: number;
  osmUrl?: string;
  osmProjectionOrigin?: { lat: number; lng: number };
}

/**
 * A closed polyline with its arc lengths precomputed, so a position lookup is a binary search
 * rather than a walk — the backfill asks for one per vehicle-second, 75 million times a month.
 */
export class Route {
  readonly length: number;
  private readonly starts: number[] = [];
  private readonly segments: Array<{
    from: Point;
    dx: number;
    dy: number;
    len: number;
    yaw: number;
  }> = [];

  constructor(readonly points: readonly Point[]) {
    let total = 0;
    points.forEach((from, index) => {
      const to = points[(index + 1) % points.length] ?? from;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len <= 1e-6) return;
      this.starts.push(total);
      this.segments.push({ from, dx, dy, len, yaw: Math.atan2(dy, dx) });
      total += len;
    });
    this.length = total;
  }

  /** Arc length wrapped into [0, length). */
  wrap(s: number): number {
    if (this.length <= 0) return 0;
    return ((s % this.length) + this.length) % this.length;
  }

  pose(s: number): Pose {
    const segment = this.segmentAt(s);
    if (!segment) return { x: this.points[0]?.x ?? 0, y: this.points[0]?.y ?? 0, yaw: 0 };
    const t = segment.offset / segment.len;
    return {
      x: segment.from.x + segment.dx * t,
      y: segment.from.y + segment.dy * t,
      yaw: segment.yaw,
    };
  }

  /** Heading change between `s` and `s + ahead`, wrapped to (−π, π]. */
  turnAhead(s: number, ahead: number): number {
    const here = this.segmentAt(s)?.yaw ?? 0;
    const there = this.segmentAt(s + ahead)?.yaw ?? 0;
    let delta = there - here;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta <= -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  /** Forward distance from `from` to `to` along the loop. */
  ahead(from: number, to: number): number {
    return this.wrap(to - from);
  }

  private segmentAt(s: number) {
    if (!this.segments.length) return undefined;
    const target = this.wrap(s);
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= target) lo = mid;
      else hi = mid - 1;
    }
    const segment = this.segments[lo];
    return segment ? { ...segment, offset: target - (this.starts[lo] ?? 0) } : undefined;
  }
}

/** Hand-authored loops (scene metres) for scenes with no road network; see the file comment. */
const DEMO_ROUTES: Record<string, Point[]> = {
  "warehouse-a": [
    { x: 6, y: 6 },
    { x: 114, y: 6 },
    { x: 114, y: 68 },
    { x: 6, y: 68 },
  ],
  "yard-north": [
    { x: 82, y: 22 },
    { x: 132, y: 22 },
    { x: 132, y: 70 },
    { x: 82, y: 70 },
  ],
  "assembly-line": [
    { x: 9, y: 25.5 },
    { x: 76, y: 25.5 },
    { x: 76, y: 33 },
    { x: 9, y: 33 },
  ],
  "cloudpoint-demo": [
    { x: -48, y: -2 },
    { x: -12, y: -2 },
    { x: -12, y: 24 },
    { x: -48, y: 24 },
  ],
};

/** No stated bounds: the (possibly rotated) map rectangle, as the backend derives it. */
const sceneBounds = (scene: SceneConfig | undefined): Bounds => {
  if (scene?.bounds && Number.isFinite(scene.bounds.minX)) return scene.bounds;
  if (scene && Number.isFinite(scene.width) && Number.isFinite(scene.resolution)) {
    return mapFootprintBounds(
      toScenePose(scene.origin),
      (scene.width ?? 0) * (scene.resolution ?? 0),
      (scene.height ?? 0) * (scene.resolution ?? 0),
    );
  }
  return { minX: 0, maxX: 60, minY: 0, maxY: 40 };
};

/** A box inside the scene, offset per vehicle so boxes on one scene do not coincide. */
const boxRoute = (bounds: Bounds, index: number): Point[] => {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const cx = bounds.minX + spanX * (0.5 + 0.12 * Math.cos(index * 2.3));
  const cy = bounds.minY + spanY * (0.5 + 0.12 * Math.sin(index * 2.3));
  const halfW = spanX * 0.22;
  const halfH = spanY * 0.22;
  return [
    { x: cx - halfW, y: cy - halfH },
    { x: cx + halfW, y: cy - halfH },
    { x: cx + halfW, y: cy + halfH },
    { x: cx - halfW, y: cy + halfH },
  ];
};

const lerpPolyline = (points: readonly Point[], t: number): Point => {
  const route = new Route(points);
  // An open polyline's arc length is the closed loop's minus the closing segment.
  const first = points[0];
  const last = points.at(-1);
  const closing = first && last ? Math.hypot(first.x - last.x, first.y - last.y) : 0;
  return route.pose(Math.min(Math.max(t, 0), 1) * (route.length - closing));
};

/**
 * A lanelet's driving line: its centreline, or the average of its two boundaries (resampled at
 * the same fractions of their own arc length) — what Lanelet2 itself does when the centreline is
 * omitted. In the sample network only 36 of 88 lanelets declare one.
 */
const drivingLine = (lanelet: { left: Point[]; right: Point[]; centerline: Point[] }): Point[] => {
  if (lanelet.centerline.length >= 2) return lanelet.centerline;
  if (lanelet.left.length < 2 || lanelet.right.length < 2) return [];
  const line: Point[] = [];
  for (let i = 0; i <= 8; i += 1) {
    const a = lerpPolyline(lanelet.left, i / 8);
    const b = lerpPolyline(lanelet.right, i / 8);
    line.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return line;
};

const STITCH_TOLERANCE_METRES = 4;
const MAX_LOOP_METRES = 260;

const openLength = (points: readonly Point[]): number => {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
};

/**
 * Chain driving lines into a patrol, starting from `startIndex`: repeatedly append the unused
 * line whose nearer end is within tolerance of the path end (reversed when its far end matches),
 * then walk it out and back so the loop closes without a jump. Capped, or a 1 m/s vehicle on the
 * whole network would look parked.
 */
const laneletLoop = (lines: Point[][], startIndex: number): Point[] => {
  if (!lines.length) return [];
  const used = new Set<number>([startIndex % lines.length]);
  const path: Point[] = [...(lines[startIndex % lines.length] ?? [])];
  while (openLength(path) < MAX_LOOP_METRES) {
    const tail = path.at(-1);
    if (!tail) break;
    let best = -1;
    let bestDistance = Infinity;
    let reversed = false;
    lines.forEach((line, index) => {
      const [start] = line;
      const end = line.at(-1);
      if (used.has(index) || line.length < 2 || !start || !end) return;
      const toStart = Math.hypot(start.x - tail.x, start.y - tail.y);
      const toEnd = Math.hypot(end.x - tail.x, end.y - tail.y);
      if (Math.min(toStart, toEnd) < bestDistance) {
        bestDistance = Math.min(toStart, toEnd);
        best = index;
        reversed = toEnd < toStart;
      }
    });
    if (best < 0 || bestDistance > STITCH_TOLERANCE_METRES) break;
    used.add(best);
    const next = reversed ? [...(lines[best] ?? [])].reverse() : (lines[best] ?? []);
    path.push(...next.slice(1));
  }
  if (path.length < 2) return [];
  return [...path, ...[...path].reverse().slice(1, -1)];
};

const sceneDrivingLines = async (configRoot: string, scene: SceneConfig): Promise<Point[][]> => {
  if (!scene.osmUrl) return [];
  const filePath = path.join(configRoot, "scene-maps", scene.osmUrl.replace(/^\/scene-maps\//, ""));
  if (!fs.existsSync(filePath)) return [];
  try {
    const overlay = await parseLaneletOsmFile(filePath, scene.sceneId, scene.osmProjectionOrigin);
    return overlay.lanelets.map(drivingLine).filter((line) => line.length >= 2);
  } catch {
    return [];
  }
};

export interface RouteRequest {
  sceneId: string;
  /** Position in the roster, which picks a lanelet start or a box offset. */
  index: number;
}

/** One route per request; Lanelet scenes are parsed once however many vehicles share them. */
export const buildRoutes = async (
  configRoot: string,
  scenes: readonly SceneConfig[],
  requests: readonly RouteRequest[],
): Promise<Route[]> => {
  const lines = new Map<string, Point[][]>();
  for (const scene of scenes) lines.set(scene.sceneId, await sceneDrivingLines(configRoot, scene));
  return requests.map(({ sceneId, index }) => {
    const scene = scenes.find((item) => item.sceneId === sceneId);
    const lanelet = laneletLoop(lines.get(sceneId) ?? [], index * 7 + Math.floor(index / 2));
    if (lanelet.length >= 2) return new Route(lanelet);
    // Loops of a rotated scene are authored in map metres and placed through the scene pose.
    const pose = toScenePose(scene?.origin);
    const demo = (DEMO_ROUTES[sceneId] ?? []).map((point) =>
      pose.yaw ? mapToWorld(pose, point.x, point.y) : point,
    );
    return new Route(demo.length >= 2 ? demo : boxRoute(sceneBounds(scene), index));
  });
};

/** Where a scene sits on the globe: scenes on a 3-wide grid 3 km apart, in scenes.json order. */
export const sceneGpsOrigin = (sceneIndex: number): Point => {
  const base = { lat: 31.2304, lng: 121.4737 };
  const index = Math.max(0, sceneIndex);
  const kmPerDegreeLng = 111.32 * Math.cos((base.lat * Math.PI) / 180);
  return {
    y: base.lat + (Math.floor(index / 3) * 3) / 110.574,
    x: base.lng + ((index % 3) * 3) / kmPerDegreeLng,
  };
};

/** Scene metres to latitude/longitude, and scene yaw (east, CCW) to a compass bearing. */
export const sceneToGps = (
  origin: Point,
  pose: Pose,
): { lat: number; lng: number; heading: number } => {
  const bearing = 90 - (pose.yaw * 180) / Math.PI;
  return {
    lat: Number((origin.y + pose.y / 111320).toFixed(6)),
    lng: Number((origin.x + pose.x / (111320 * Math.cos((origin.y * Math.PI) / 180))).toFixed(6)),
    heading: Number((((bearing % 360) + 360) % 360).toFixed(1)),
  };
};
