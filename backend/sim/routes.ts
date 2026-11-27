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
import { seedOf } from "./rng";

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

/**
 * Hand-authored loops for scenes with no road network; see the file comment. Always **map**
 * metres, placed through the scene pose: a zero yaw makes that a translation by the origin, not
 * a different coordinate system, so editing a scene's yaw or origin moves its loop with its map.
 */
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
  // Map metres from the cloud's corner (origin -106.62, -59.17): the mapped core of the cloud.
  "cloudpoint-demo": [
    { x: 58.62, y: 57.17 },
    { x: 94.62, y: 57.17 },
    { x: 94.62, y: 83.17 },
    { x: 58.62, y: 83.17 },
  ],
  // The same aisle as cloudpoint-demo (world -48…-12, -2…24), in the re-mapped grid's frame: that
  // map is rotated 0.3 rad about its corner (-96.105, -93.16), so the loop is too.
  "assembly-remap": [
    { x: 72.9, y: 72.87 },
    { x: 107.29, y: 62.24 },
    { x: 114.97, y: 87.07 },
    { x: 80.58, y: 97.71 },
  ],
  // The aisle round the freezer racks (scripts/demo-assets/cold-store-map.mjs lays them out).
  "cold-store": [
    { x: 5, y: 5 },
    { x: 52, y: 5 },
    { x: 52, y: 33 },
    { x: 5, y: 33 },
  ],
  // The dock apron, in front of the doors.
  "dock-2": [
    { x: 15, y: 12 },
    { x: 85, y: 12 },
    { x: 85, y: 45 },
    { x: 15, y: 45 },
  ],
};

/**
 * The loop for a vehicle with no scene — the perimeter patrol, which has no ROS map and drives on
 * GPS alone: the campus fence, in metres east/north of `CAMPUS_ANCHOR`, round the 康城 road
 * network, 北区装卸场 and the warehouses.
 */
const SCENELESS_ROUTE: Point[] = [
  { x: -70, y: -140 },
  { x: 520, y: -140 },
  { x: 520, y: 200 },
  { x: -70, y: 200 },
];

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
  /**
   * The vehicle's slot in its scene (see `sceneSlots`), which picks a lanelet start or a box
   * offset. Not its position in vehicles.json: the console's editors reorder that file, and a
   * roster edit must not move every vehicle after it.
   */
  slot: number;
}

/** One route per request; Lanelet scenes are parsed once however many vehicles share them. */
export const buildRoutes = async (
  configRoot: string,
  scenes: readonly SceneConfig[],
  requests: readonly RouteRequest[],
): Promise<Route[]> => {
  const lines = new Map<string, Point[][]>();
  for (const scene of scenes) lines.set(scene.sceneId, await sceneDrivingLines(configRoot, scene));
  return requests.map(({ sceneId, slot }) => {
    if (!sceneId) return new Route(SCENELESS_ROUTE);
    const scene = scenes.find((item) => item.sceneId === sceneId);
    // A hand-authored loop wins over the road network: 北区装卸场's lanes include dock spurs a
    // stitched lanelet loop would wander into and back out of, while its loop is the one-way ring
    // the tugs actually drive (the network's ring has the same centreline).
    const pose = toScenePose(scene?.origin);
    const demo = (DEMO_ROUTES[sceneId] ?? []).map((point) => mapToWorld(pose, point.x, point.y));
    if (demo.length >= 2) return new Route(demo);
    const lanelet = laneletLoop(lines.get(sceneId) ?? [], slot * 7 + Math.floor(slot / 2));
    if (lanelet.length >= 2) return new Route(lanelet);
    return new Route(boxRoute(sceneBounds(scene), slot));
  });
};

/** Slots per scene: more than any scene holds, so a vehicle's preferred slot is usually free. */
export const SCENE_SLOTS = 16;

/**
 * A slot in `[0, SCENE_SLOTS)` for each vehicle, unique within its scene: the one its id hashes
 * to, or the next free one when a vehicle with a smaller id already holds it. It decides where the
 * vehicle's loop starts, where it charges and where it first stands, so it hangs on the id alone:
 * reordering vehicles.json changes nothing, and removing a vehicle moves at most one that had been
 * pushed along by it.
 */
export const sceneSlots = (
  vehicles: ReadonlyArray<{ deviceId: string; sceneId: string }>,
): Map<string, number> => {
  const taken = new Map<string, Set<number>>();
  const slots = new Map<string, number>();
  const ordered = [...vehicles].sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
  for (const { deviceId, sceneId } of ordered) {
    const used = taken.get(sceneId) ?? new Set<number>();
    taken.set(sceneId, used);
    let slot = seedOf(`slot:${deviceId}`) % SCENE_SLOTS;
    for (let probe = 0; probe < SCENE_SLOTS && used.has(slot); probe += 1) {
      slot = (slot + 1) % SCENE_SLOTS;
    }
    used.add(slot);
    slots.set(deviceId, slot);
  }
  return slots;
};

/**
 * Metres per degree of latitude on the local tangent plane the backend projects Lanelet2 maps with
 * (`laneletOsm.ts`, WGS-84 equatorial radius): the same constant both ways, so a vehicle driving a
 * lanelet reports the latitude/longitude the lanelet's own nodes carry.
 */
const METRES_PER_DEGREE = (Math.PI * 6378137) / 180;

/** Latitude/longitude (`y`/`x`) `offset` metres east/north of `anchor`. */
const offsetGps = (anchor: Point, offset: Point): Point => ({
  y: anchor.y + offset.y / METRES_PER_DEGREE,
  x: anchor.x + offset.x / (METRES_PER_DEGREE * Math.cos((anchor.y * Math.PI) / 180)),
});

/**
 * The demo campus on the globe (WGS-84): the 康城 road network's projection origin
 * (`scenes.json` › kangcheng-airy › osmProjectionOrigin). Scenes without a projection origin of
 * their own are placed relative to it (`SITE_OFFSETS`), and so is the perimeter patrol.
 */
export const CAMPUS_ANCHOR: Point = { y: 31.0988, x: 121.3878 };

/**
 * Where each site's map origin stands on the campus, in metres east/north of `CAMPUS_ANCHOR` — the
 * simulator's model of the site plan, so outdoor vehicles in neighbouring scenes appear side by
 * side on the GPS map. 北区装卸场 and 康城 carry their own `osmProjectionOrigin` instead.
 */
const SITE_OFFSETS: Record<string, Point> = {
  "dock-2": { x: 70, y: -120 },
  "warehouse-a": { x: 230, y: -40 },
  // The cold store's west wall (map x -10) stands against the warehouse's east wall.
  "cold-store": { x: 360, y: -30 },
  "assembly-line": { x: 230, y: 60 },
  "cloudpoint-demo": { x: 470, y: 120 },
  "assembly-remap": { x: 470, y: 120 },
  "staging-depot": { x: -160, y: -60 },
};

/**
 * Where a scene's map origin sits on the globe (latitude in `y`, longitude in `x`): its Lanelet2
 * projection origin when it has one, else its place on the campus plan; a vehicle with no scene
 * drives in campus metres. A scene the plan does not know (one added in the editor) gets a point
 * within 12 km of the campus from a hash of its id — stable however the editor reorders the file.
 */
export const sceneGpsOrigin = (sceneId: string, scene?: SceneConfig): Point => {
  const projection = scene?.osmProjectionOrigin;
  if (projection && Number.isFinite(projection.lat) && Number.isFinite(projection.lng)) {
    return { y: projection.lat, x: projection.lng };
  }
  if (!sceneId) return CAMPUS_ANCHOR;
  const offset = SITE_OFFSETS[sceneId];
  if (offset) return offsetGps(CAMPUS_ANCHOR, offset);
  const hash = seedOf(`gps:${sceneId}`);
  return offsetGps(CAMPUS_ANCHOR, {
    x: ((hash & 0xffff) / 0xffff) * 12_000,
    y: ((hash >>> 16) / 0xffff) * 12_000,
  });
};

/** Scene metres to latitude/longitude, and scene yaw (east, CCW) to a compass bearing. */
export const sceneToGps = (
  origin: Point,
  pose: Pose,
): { lat: number; lng: number; heading: number } => {
  const bearing = 90 - (pose.yaw * 180) / Math.PI;
  const point = offsetGps(origin, pose);
  return {
    lat: Number(point.y.toFixed(7)),
    lng: Number(point.x.toFixed(7)),
    heading: Number((((bearing % 360) + 360) % 360).toFixed(1)),
  };
};
