import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mqtt from "mqtt";
import { parseLaneletOsmFile } from "../src/laneletOsm";

/**
 * Demo telemetry publisher.
 *
 * The demo fleet is NOT hardcoded: the script reads the real runtime config
 * (config-runtime/vehicles.json + scenes.json) and drives it through the real
 * MQTT path — only the telemetry *values* are synthetic. Swap the config for a
 * real fleet and the same pipeline carries real data.
 *
 * The simulation is fully deterministic (no randomness) so every run reproduces
 * the same demo: each vehicle patrols a fixed rectangular route inside its scene
 * at a realistic speed with heading aligned to travel; battery drains while
 * driving and recharges at the charging station; one vehicle faults and goes
 * offline. Restart the publisher to reset the demo from t=0.
 */

type Scenario = "cruising" | "speed-limited" | "charging" | "hauling" | "fault-offline" | "teleop";

interface Vehicle {
  deviceId: string;
  deviceName?: string;
  defaultSceneId?: string;
  gpsEnabled?: boolean;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface SceneConfig {
  sceneId: string;
  bounds?: Bounds;
  /** Present on Lanelet2 scenes; vehicles then drive the real road network. */
  osmUrl?: string;
  osmProjectionOrigin?: { lat: number; lng: number };
}

interface CliOptions {
  broker: string;
  count: number;
  interval: number;
}

interface Point {
  x: number;
  y: number;
}
interface DeviceState {
  deviceId: string;
  sceneId: string;
  gpsEnabled: boolean;
  /** Where this vehicle's scene sits on the globe; see sceneGpsOrigin(). */
  gpsOrigin: GpsOrigin;
  scenario: Scenario;
  route: Point[]; // closed patrol loop (corners); movement interpolates along it
  cruiseSpeed: number; // m/s along the route
  station: Point; // parked position (charging / after a fault)
  soc: number; // battery %, evolves deterministically per tick
  mode: Motion; // current duty cycle phase: patrolling the route, or parked charging
  distance: number; // metres travelled along the route (only advances while driving)
  frozenAt: { x: number; y: number; yaw: number } | null; // where a faulted vehicle stopped
  tick: number;
  active: boolean;
}

const DEFAULT_BROKER = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const DEFAULT_INTERVAL = 1000;
/**
 * Base point for the demo fleet's synthetic GPS, and the spacing between scenes.
 *
 * Each scene gets its own origin. Every scene used to map onto this one point,
 * so the whole demo fleet piled into a cluster ~30 px across: the GPS view was a
 * single unreadable stack of labels however far you zoomed out, and "fit fleet"
 * had nothing to fit. Real sites sit kilometres apart, so the demo should too.
 */
const GPS_ORIGIN = { lat: 31.2304, lng: 121.4737 };
const SCENE_SPACING_KM = 3;
const KM_PER_DEGREE_LAT = 110.574;

interface GpsOrigin {
  lat: number;
  lng: number;
}

/** Scenes laid out on a 3-wide grid, in the order scenes.json declares them. */
function sceneGpsOrigin(sceneIndex: number): GpsOrigin {
  const safeIndex = sceneIndex < 0 ? 0 : sceneIndex;
  const column = safeIndex % 3;
  const row = Math.floor(safeIndex / 3);
  const kmPerDegreeLng = 111.32 * Math.cos((GPS_ORIGIN.lat * Math.PI) / 180);
  return {
    lat: GPS_ORIGIN.lat + (row * SCENE_SPACING_KM) / KM_PER_DEGREE_LAT,
    lng: GPS_ORIGIN.lng + (column * SCENE_SPACING_KM) / kmPerDegreeLng,
  };
}

// Per-scene base cruising speed (m/s), by vehicle role. Deterministic.
const SCENE_BASE_SPEED: Record<string, number> = {
  "kangcheng-airy": 1.3, // 巡检车
  "warehouse-a": 1.0, // 仓储搬运车
  "yard-north": 0.8, // 装卸牵引车
  "assembly-line": 0.6, // 产线配料车
  "cloudpoint-demo": 0.9, // 点云示例车
};
const DEFAULT_SPEED = 1.0;

// The demo tells a "平稳运营 + 少量事件" story: almost every vehicle patrols/hauls
// normally, and exactly four carry a scripted event. Assigning events by deviceId (not a
// round-robin over the whole fleet) fixes the event count at four however large the fleet
// grows — a 23-vehicle round-robin over the six scenarios would otherwise manufacture
// several faults and several charging vehicles at once.
const EVENT_SCENARIOS: Record<string, Scenario> = {
  "agv-a03": "speed-limited", // 巡检 A03：限速区降速通行
  "agv-a05": "teleop", // 巡检 A05：远程接管中
  "agv-w04": "charging", // 仓储 W04：低电回桩充电
  "agv-y03": "fault-offline", // 装卸 Y03：故障停车后离线
};

// The normal (non-event) scenario for a scene: outdoor patrol vs indoor/yard material
// handling. Only affects the reported status frame (info text, task/gear, speed limit).
const normalScenarioFor = (sceneId: string): Scenario =>
  sceneId === "kangcheng-airy" || sceneId === "cloudpoint-demo" ? "cruising" : "hauling";

// Hand-authored patrol loops (scene metres) for scenes with no Lanelet2 road network to
// drive. Each is a closed rectangle laid in the scene's *drivable* space — the aisle band
// around the racks, the maneuvering apron, the lane around the conveyor, the mapped core
// of the point cloud — so demo vehicles run believable routes on the map instead of a
// generic box that clips through shelves or lands off the point cloud. Vehicles sharing a
// scene are spaced out as beads along the loop (see buildStates). Lanelet scenes ignore
// this and drive parsed centrelines. Coordinates come from each SVG's geometry mapped
// through its resolution (world_x = px·res, world_y = (heightPx − px_y)·res, map is y-up).
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

let intervalSeconds = DEFAULT_INTERVAL / 1000;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { broker: DEFAULT_BROKER, count: 0, interval: DEFAULT_INTERVAL };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--broker" && next) {
      options.broker = next;
      index += 1;
    } else if (current === "--count" && next) {
      options.count = Math.max(0, Number(next) || 0);
      index += 1;
    } else if (current === "--interval" && next) {
      // Floor at 20ms so higher-frequency profiles are possible for perf runs.
      options.interval = Math.max(20, Number(next) || DEFAULT_INTERVAL);
      index += 1;
    } else if (current === "--help" || current === "-h") {
      console.log(
        `
Usage: npx tsx scripts/mock-mqtt.ts [options]

Publishes deterministic demo telemetry for the fleet in config-runtime/vehicles.json.

Options:
  --broker <url>    MQTT broker URL, default: ${DEFAULT_BROKER}
  --count <number>  Limit to the first N configured vehicles, default: all
  --interval <ms>   Publish interval in milliseconds, default: ${DEFAULT_INTERVAL}
      `.trim(),
      );
      process.exit(0);
    }
  }

  return options;
}

function resolveConfigRoot(): string {
  const candidates = [
    process.env.CONFIG_ROOT_PATH,
    path.resolve(process.cwd(), "config-runtime"),
    path.resolve(process.cwd(), "../config-runtime"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "vehicles.json"))) {
      return candidate;
    }
  }
  throw new Error(
    "找不到 config-runtime/vehicles.json；请在仓库根或 backend 目录下运行，或设置 CONFIG_ROOT_PATH。",
  );
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function findBounds(scenes: SceneConfig[], sceneId: string): Bounds {
  const scene = scenes.find((item) => item.sceneId === sceneId);
  if (scene?.bounds && Number.isFinite(scene.bounds.minX)) {
    return scene.bounds;
  }
  return { minX: 0, maxX: 60, minY: 0, maxY: 40 };
}
const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

/**
 * Scene yaw (radians, maths convention: 0 = +x/east, counter-clockwise) to the
 * compass bearing a GPS receiver reports (0 = north, clockwise). Emitting the
 * raw yaw as `heading` made the map's direction arrow point 90° off and turn the
 * wrong way, because every consumer reads `gps.heading` as a bearing.
 */
function headingFromYaw(yaw: number): number {
  const degrees = (yaw * 180) / Math.PI;
  const bearing = 90 - degrees;
  return round(((bearing % 360) + 360) % 360, 1);
}

/** Scene-local metres to latitude/longitude around the vehicle's scene origin. */
function sceneToGps(origin: GpsOrigin, x: number, y: number, yaw: number) {
  const latFactor = 1 / 111320;
  const lngFactor = 1 / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return {
    lat: round(origin.lat + y * latFactor, 6),
    lng: round(origin.lng + x * lngFactor, 6),
    heading: headingFromYaw(yaw),
  };
}

// A rectangular patrol loop inside the scene, offset per vehicle index so cars
// on the same scene circulate different aisles without overlapping. Corners are
// listed clockwise; movement interpolates along the closed perimeter.
function buildRoute(bounds: Bounds, index: number): { route: Point[]; station: Point } {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const cx = bounds.minX + spanX * (0.5 + 0.12 * Math.cos(index * 2.3));
  const cy = bounds.minY + spanY * (0.5 + 0.12 * Math.sin(index * 2.3));
  const halfW = spanX * 0.22;
  const halfH = spanY * 0.22;
  const route: Point[] = [
    { x: cx - halfW, y: cy - halfH },
    { x: cx + halfW, y: cy - halfH },
    { x: cx + halfW, y: cy + halfH },
    { x: cx - halfW, y: cy + halfH },
  ];
  // Charging station sits just inside the lower-left corner of the loop.
  const station: Point = { x: cx - halfW, y: cy - halfH };
  return { route, station };
}

/**
 * The segments of a polyline, as pairs of endpoints; `closed` also yields the segment
 * back to the first point.
 *
 * **Five geometry helpers below used to walk `points[i]` / `points[i - 1]` inside a `for`
 * loop bounded by `.length`.** Every one of those reads is provably in range and the
 * compiler cannot see it, so `noUncheckedIndexedAccess` turned this one file into **48 of
 * the batch's 103**「possibly undefined」— by a wide margin the largest cluster, and all of
 * it the same sentence repeated.
 *
 * The answer is not 48 `!`s. It is to iterate what the geometry is actually about — the
 * *segment* — so both endpoints arrive already definite, once, here. The `if (previous)` is
 * the only branch involved and it is a real one: false exactly once, on the first point.
 */
const segmentsOf = (points: readonly Point[], closed = false): Array<readonly [Point, Point]> => {
  const segments: Array<readonly [Point, Point]> = [];
  let previous: Point | undefined;
  for (const point of points) {
    if (previous) {
      segments.push([previous, point]);
    }
    previous = point;
  }
  const first = points[0];
  if (closed && first && previous) {
    segments.push([previous, first]);
  }
  return segments;
};

/** Cumulative length of an open polyline. */
function polylineLength(points: readonly Point[]): number {
  let total = 0;
  for (const [from, to] of segmentsOf(points)) {
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return total;
}

/** Point at fraction `t` (0..1) of an open polyline's arc length. */
function pointAtFraction(points: readonly Point[], t: number): Point {
  const segments = segmentsOf(points);
  const target = polylineLength(points) * Math.min(Math.max(t, 0), 1);
  let walked = 0;

  for (const [index, [from, to]] of segments.entries()) {
    const seg = Math.hypot(to.x - from.x, to.y - from.y);
    if (walked + seg >= target || index === segments.length - 1) {
      const f = seg > 0 ? (target - walked) / seg : 0;
      return {
        x: from.x + (to.x - from.x) * f,
        y: from.y + (to.y - from.y) * f,
      };
    }
    walked += seg;
  }

  // Only reachable for a polyline with fewer than two points, which has no segment to
  // walk: the `index === segments.length - 1` arm above returns on the last one otherwise.
  // The previous version ended with `return points[points.length - 1]` — typed `Point`,
  // actually `undefined` for an empty array. Both call sites check `.length < 2` first, so
  // that lie never fired; it is still a lie the compiler now declines to sign.
  return points[0] ?? { x: 0, y: 0 };
}

/**
 * A lanelet's driving line: the explicit centreline when the map carries one,
 * otherwise the average of the two boundaries — which is what Lanelet2 itself
 * does when the centreline is omitted. In this project's sample network only 36
 * of 88 lanelets declare one, so without the fallback most of the road network
 * would be undrivable.
 *
 * The boundaries rarely have matching point counts, so both are resampled at the
 * same fractions of their own arc length before averaging.
 */
const CENTRELINE_SAMPLES = 8;

function laneletDrivingLine(lanelet: {
  left: Point[];
  right: Point[];
  centerline: Point[];
}): Point[] {
  if (lanelet.centerline.length >= 2) {
    return lanelet.centerline;
  }
  if (lanelet.left.length < 2 || lanelet.right.length < 2) {
    return [];
  }
  const line: Point[] = [];
  for (let i = 0; i <= CENTRELINE_SAMPLES; i += 1) {
    const t = i / CENTRELINE_SAMPLES;
    const a = pointAtFraction(lanelet.left, t);
    const b = pointAtFraction(lanelet.right, t);
    line.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return line;
}

// How far apart two lanelet ends may be and still count as connected, and how
// much road one vehicle patrols. The cap matters: stitching all 88 lanelets would
// give a lap so long that a 1 m/s vehicle looks stationary.
const STITCH_TOLERANCE_METRES = 4;
const MAX_LOOP_METRES = 260;

/**
 * Chain lanelet driving lines into a patrol route, starting from `startIndex`.
 *
 * The parsed overlay carries no successor/predecessor topology, so connectivity
 * is inferred geometrically: repeatedly append the unused line whose nearer end
 * is within tolerance of the current path end, reversing it when it is the far
 * end that matches.
 *
 * The result is then walked out and back. `pointOnRoute` treats a route as a
 * closed ring, so handing it an open path would teleport the vehicle from the
 * last point to the first once per lap; an out-and-back path closes the ring
 * honestly, and a vehicle patrolling a road in both directions is what an AGV
 * on a fixed route actually does.
 */
function buildLaneletRoute(lines: Point[][], startIndex: number): Point[] {
  if (!lines.length) {
    return [];
  }

  const used = new Set<number>();
  const first = startIndex % lines.length;
  used.add(first);
  const path: Point[] = [...(lines[first] ?? [])];

  while (polylineLength(path) < MAX_LOOP_METRES) {
    const tail = path.at(-1);
    if (!tail) {
      break;
    }
    let bestIndex = -1;
    let bestDistance = Infinity;
    let bestReversed = false;

    lines.forEach((line, index) => {
      const [start] = line;
      const end = line.at(-1);
      // `!start || !end` adds nothing to `line.length < 2` — a one-point line still has
      // both — and is what lets the two `Math.hypot` calls below read them directly.
      if (used.has(index) || line.length < 2 || !start || !end) {
        return;
      }
      const toStart = Math.hypot(start.x - tail.x, start.y - tail.y);
      const toEnd = Math.hypot(end.x - tail.x, end.y - tail.y);
      const distance = Math.min(toStart, toEnd);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
        bestReversed = toEnd < toStart;
      }
    });

    if (bestIndex < 0 || bestDistance > STITCH_TOLERANCE_METRES) {
      break;
    }
    used.add(bestIndex);
    const best = lines[bestIndex] ?? [];
    const next = bestReversed ? [...best].reverse() : best;
    // Skip the joining point so the route has no zero-length segment.
    path.push(...next.slice(1));
  }

  if (path.length < 2) {
    return [];
  }
  const back = [...path].reverse().slice(1, -1);
  return [...path, ...back];
}

/** Driving lines for every lanelet in a scene's OSM file, or [] if it has none. */
async function loadSceneDrivingLines(
  configRoot: string,
  scene: SceneConfig | undefined,
): Promise<Point[][]> {
  if (!scene?.osmUrl) {
    return [];
  }
  const relative = scene.osmUrl.replace(/^\/scene-maps\//, "");
  const filePath = path.join(configRoot, "scene-maps", relative);
  if (!fs.existsSync(filePath)) {
    console.warn(
      `[mock-mqtt] ${scene.sceneId}: ${filePath} not found, falling back to a synthetic route.`,
    );
    return [];
  }
  try {
    const overlay = await parseLaneletOsmFile(filePath, scene.sceneId, scene.osmProjectionOrigin);
    return overlay.lanelets.map(laneletDrivingLine).filter((line) => line.length >= 2);
  } catch (error) {
    console.warn(
      `[mock-mqtt] ${scene.sceneId}: could not parse ${path.basename(filePath)} (${
        error instanceof Error ? error.message : String(error)
      }); falling back to a synthetic route.`,
    );
    return [];
  }
}

function routePerimeter(route: readonly Point[]): number {
  let total = 0;
  for (const [from, to] of segmentsOf(route, true)) {
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return total;
}

// Point + heading at arc-length `distance` along the closed route.
function pointOnRoute(
  route: readonly Point[],
  distance: number,
): { x: number; y: number; yaw: number } {
  const perimeter = routePerimeter(route);
  const segments = segmentsOf(route, true);
  let d = ((distance % perimeter) + perimeter) % perimeter;

  for (const [index, [from, to]] of segments.entries()) {
    const segLen = Math.hypot(to.x - from.x, to.y - from.y);
    if (d <= segLen || index === segments.length - 1) {
      const t = segLen > 0 ? d / segLen : 0;
      return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        yaw: Math.atan2(to.y - from.y, to.x - from.x),
      };
    }
    d -= segLen;
  }

  // A route with fewer than two points has no segment; `d` is then NaN as well, since the
  // perimeter is 0. The previous version wrote this case as `route[0].x`, which threw on an
  // empty route rather than degrading.
  const start = route[0];
  return { x: start?.x ?? 0, y: start?.y ?? 0, yaw: 0 };
}

async function buildStates(count: number): Promise<DeviceState[]> {
  const root = resolveConfigRoot();
  const vehicles = readJson<Vehicle[]>(path.join(root, "vehicles.json"));
  const scenes = readJson<SceneConfig[]>(path.join(root, "scenes.json"));
  const limit = count > 0 ? Math.min(count, vehicles.length) : vehicles.length;

  // Parse each Lanelet2 scene once, not once per vehicle.
  const drivingLinesByScene = new Map<string, Point[][]>();
  for (const scene of scenes) {
    drivingLinesByScene.set(scene.sceneId, await loadSceneDrivingLines(root, scene));
  }

  // How many vehicles share each scene, to space co-located vehicles along a demo loop.
  const sceneCounts = new Map<string, number>();
  for (const vehicle of vehicles.slice(0, limit)) {
    const sceneId = vehicle.defaultSceneId || "";
    sceneCounts.set(sceneId, (sceneCounts.get(sceneId) ?? 0) + 1);
  }
  const sceneSeen = new Map<string, number>();

  let laneletVehicles = 0;
  const states: DeviceState[] = vehicles.slice(0, limit).map((vehicle, index) => {
    const sceneId = vehicle.defaultSceneId || "";
    const bounds = findBounds(scenes, sceneId);
    const scenario = EVENT_SCENARIOS[vehicle.deviceId] ?? normalScenarioFor(sceneId);

    const ordinal = sceneSeen.get(sceneId) ?? 0;
    sceneSeen.set(sceneId, ordinal + 1);
    const countInScene = sceneCounts.get(sceneId) ?? 1;

    // Prefer the real road network; then a hand-authored demo loop for scenes without one;
    // then a generic box only as a last resort. A demo whose vehicles drive across blank
    // space beside the map tells you nothing about whether the map is right.
    const fallback = buildRoute(bounds, index);
    const lines = drivingLinesByScene.get(sceneId) ?? [];
    const laneletRoute = lines.length
      ? buildLaneletRoute(lines, index * 7 + Math.floor(index / 2))
      : [];
    const demoRoute = DEMO_ROUTES[sceneId] ?? [];
    const usingLanelet = laneletRoute.length >= 2;
    const route = usingLanelet ? laneletRoute : demoRoute.length >= 2 ? demoRoute : fallback.route;
    const station = route[0] ?? fallback.station;
    if (usingLanelet) {
      laneletVehicles += 1;
    }

    // Lanelet vehicles each start from a different lanelet, so they are already spread.
    // Vehicles sharing one demo loop are spaced as beads at staggered arc-length offsets,
    // so they neither stack up at t=0 nor move in lockstep (identical speed on one loop).
    const startDistance = usingLanelet ? 0 : (ordinal / countInScene) * routePerimeter(route);

    const baseSpeed = SCENE_BASE_SPEED[sceneId] ?? DEFAULT_SPEED;
    const cruiseSpeed = scenario === "speed-limited" ? baseSpeed * 0.5 : baseSpeed;

    return {
      deviceId: vehicle.deviceId,
      sceneId,
      gpsEnabled: vehicle.gpsEnabled !== false,
      gpsOrigin: sceneGpsOrigin(scenes.findIndex((scene) => scene.sceneId === sceneId)),
      scenario,
      route,
      cruiseSpeed,
      station,
      // Battery is spread across the fleet so the 电量 column reads like a real fleet
      // rather than every vehicle starting equal; the charging vehicle starts low so its
      // 回桩 story is visible from t=0.
      soc: scenario === "charging" ? 16 : 58 + ((index * 17) % 38),
      mode: scenario === "charging" ? "charging" : "route",
      distance: startDistance,
      frozenAt: null,
      tick: 0,
      active: true,
    };
  });

  if (laneletVehicles) {
    console.log(
      `[mock-mqtt] ${laneletVehicles}/${states.length} vehicles are driving parsed lanelet centrelines`,
    );
  }
  return states;
}
type Motion = "route" | "charging";

interface ScenarioFrame {
  controlMode: number;
  gear: number;
  taskStatus: number;
  platformTaskStatus: number;
  motion: Motion;
  info: { code: number; info: string };
  warning: { code: number; info: string };
  error: { code: number; info: string };
  speedLimit: { limit: number; slowdownTime: number; module: string };
}

const NO_CODE = { code: 0, info: "" };

function scenarioFrame(scenario: Scenario): ScenarioFrame {
  switch (scenario) {
    case "speed-limited":
      return {
        controlMode: 1,
        gear: 1,
        taskStatus: 1,
        platformTaskStatus: 1,
        motion: "route",
        info: NO_CODE,
        warning: { code: 2203, info: "前方限速区，已降速通行" },
        error: NO_CODE,
        speedLimit: { limit: 0.8, slowdownTime: 5, module: "safety" },
      };
    case "charging":
      return {
        controlMode: 0,
        gear: 0,
        taskStatus: 4,
        platformTaskStatus: 0,
        motion: "charging",
        info: { code: 1203, info: "充电中，等待补能完成" },
        warning: NO_CODE,
        error: NO_CODE,
        speedLimit: { limit: 0, slowdownTime: 0, module: "dispatcher" },
      };
    case "hauling":
      return {
        controlMode: 1,
        gear: 1,
        taskStatus: 1,
        platformTaskStatus: 2,
        motion: "route",
        info: { code: 1101, info: "定位稳定" },
        warning: NO_CODE,
        error: NO_CODE,
        speedLimit: { limit: 1.5, slowdownTime: 0, module: "dispatcher" },
      };
    case "fault-offline":
      return {
        controlMode: 3,
        gear: 2,
        taskStatus: 3,
        platformTaskStatus: 3,
        motion: "route",
        info: NO_CODE,
        warning: NO_CODE,
        error: { code: 5102, info: "路径规划超时，已触发急停" },
        speedLimit: { limit: 0, slowdownTime: 0, module: "planner" },
      };
    case "teleop":
      return {
        controlMode: 2,
        gear: 1,
        taskStatus: 1,
        platformTaskStatus: 1,
        motion: "route",
        info: { code: 1101, info: "远程接管中，操作员在线" },
        warning: NO_CODE,
        error: NO_CODE,
        speedLimit: { limit: 2, slowdownTime: 0, module: "teleop" },
      };
    case "cruising":
    default:
      return {
        controlMode: 1,
        gear: 1,
        taskStatus: 1,
        platformTaskStatus: 1,
        motion: "route",
        info: { code: 1101, info: "定位稳定" },
        warning: NO_CODE,
        error: NO_CODE,
        speedLimit: { limit: 2.5, slowdownTime: 0, module: "dispatcher" },
      };
  }
}

// The fault device drives for FAULT_MOVE_TICKS, then holds position reporting the
// fault, then drops offline (stops publishing) at FAULT_OFFLINE_TICKS.
const FAULT_MOVE_TICKS = 6;
const FAULT_OFFLINE_TICKS = 14;

// Battery duty cycle: a vehicle patrols until it runs low, parks at its charging
// station to recharge, then resumes patrolling. Without this the deterministic
// drain simply bottoms out and every vehicle sits at 0% for the rest of the demo.
//
// The recharge trigger sits *below* the 20% low-battery alert threshold
// (@navfleet/shared DEFAULT_ALERT_RULES.lowBattery.thresholdPct) on purpose. If a
// vehicle turned back to charge the instant it crossed 20%, its soc would dip under
// 20 for a single frame and be pushed back over it the very next frame — flickering
// the low-battery warning (and the active-alert count) on and off every duty cycle.
// That boundary flicker was the "告警在 7↔8 之间快速抖动" report. Parking only at 15%
// gives the excursion below 20% real width, so the warning fires once, stays on while
// the vehicle is genuinely low, and clears once on the way back up.
const LOW_SOC_PERCENT = 15;
const RESUME_SOC_PERCENT = 90;

// Evolve battery deterministically: recharge at the station, drain while driving.
function stepBattery(state: DeviceState, charging: boolean, moving: boolean): void {
  if (charging) {
    state.soc = Math.min(100, state.soc + 0.06);
  } else if (moving) {
    state.soc = Math.max(0, state.soc - 0.03 * state.cruiseSpeed);
  } else {
    state.soc = Math.max(0, state.soc - 0.004);
  }
}

/** Flip between patrolling and charging so the demo can run indefinitely. */
function advanceDutyCycle(state: DeviceState): void {
  if (state.mode === "route" && state.soc <= LOW_SOC_PERCENT) {
    state.mode = "charging";
  } else if (state.mode === "charging" && state.soc >= RESUME_SOC_PERCENT) {
    state.mode = "route";
  }
}

// Presentation must follow the *current* phase, not just the scenario: a patrol
// vehicle that parked to recharge reports as charging, and the charging-scenario
// vehicle that finished charging reports as a normal patrol.
function presentFrame(state: DeviceState, motion: Motion): ScenarioFrame {
  const base = scenarioFrame(state.scenario);
  if (motion === "charging") {
    return base.motion === "charging"
      ? base
      : {
          ...base,
          controlMode: 0,
          gear: 0,
          taskStatus: 4,
          platformTaskStatus: 0,
          motion: "charging",
          info: { code: 1203, info: "电量偏低，回桩充电中" },
          speedLimit: { limit: 0, slowdownTime: 0, module: "dispatcher" },
        };
  }
  return base.motion === "charging" ? scenarioFrame("cruising") : base;
}

function buildTelemetry(state: DeviceState) {
  const stamp = Date.now();

  let x: number;
  let y: number;
  let yaw: number;
  let speed: number;

  const faulted = state.scenario === "fault-offline" && state.tick >= FAULT_MOVE_TICKS;
  if (!faulted) {
    advanceDutyCycle(state);
  }
  const motion: Motion = faulted ? "route" : state.mode;
  const frame = presentFrame(state, motion);

  if (motion === "charging") {
    x = state.station.x;
    y = state.station.y;
    yaw = 0;
    speed = 0;
  } else if (faulted) {
    const stopPose = state.frozenAt ?? pointOnRoute(state.route, state.distance);
    state.frozenAt = stopPose;
    x = stopPose.x;
    y = stopPose.y;
    yaw = stopPose.yaw;
    speed = 0;
  } else {
    const pose = pointOnRoute(state.route, state.distance);
    x = pose.x;
    y = pose.y;
    yaw = pose.yaw;
    speed = state.cruiseSpeed;
    // Travel accumulates only while driving, so a vehicle resumes from where it
    // parked instead of teleporting to where it "would" have been.
    state.distance += state.cruiseSpeed * intervalSeconds;
  }

  stepBattery(state, motion === "charging", speed > 0);
  const gps = state.gpsEnabled ? sceneToGps(state.gpsOrigin, x, y, yaw) : undefined;

  return {
    stamp,
    scene_id: state.sceneId,
    ...(gps ? { gps } : {}),
    fusion_loc: { x: round(x), y: round(y), yaw: round(yaw) },
    lidar_loc: { x: round(x - 0.15), y: round(y - 0.12), yaw: round(yaw) },
    vehicle_info: {
      control_mode: frame.controlMode,
      gear: frame.gear,
      speed: round(speed),
      omega: 0,
      soc: round(state.soc, 1),
    },
    task_status: frame.taskStatus,
    platform_task_status: frame.platformTaskStatus,
    info_code: { ...frame.info, stamp },
    warning_code: { ...frame.warning, stamp },
    error_code: { ...frame.error, stamp },
    speed_limit: {
      limit: frame.speedLimit.limit,
      slowdown_time: frame.speedLimit.slowdownTime,
      stamp,
      module_name: frame.speedLimit.module,
    },
  };
}
// Single-instance guard, in two layers, because two publishers driving the same deviceIds
// make telemetry (battery %, position, alert state) flip between their two timelines every
// tick. (1) A fixed MQTT client id (see mqtt.connect) makes the broker evict any publisher —
// past or future — that connects with the same id, so at most one is ever attached to the
// broker; a superseded one stands down on the takeover DISCONNECT. (2) This PID file is the
// fast same-host path that also evicts a predecessor before it can connect. The deterministic
// sim then resets cleanly from t=0. (A pre-existing orphan from *before* the fixed id shipped
// used a random id the broker will not dedup — kill it once by hand; every launch after that
// is deduped by the broker.)
const PID_FILE = path.join(os.tmpdir(), "navfleet-mock-mqtt.pid");

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireSingleInstanceLock(): Promise<void> {
  try {
    const existingPid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (
      Number.isInteger(existingPid) &&
      existingPid > 0 &&
      existingPid !== process.pid &&
      isProcessAlive(existingPid)
    ) {
      console.log(`[mock-mqtt] evicting previous publisher (pid ${existingPid})`);
      try {
        process.kill(existingPid, "SIGTERM");
      } catch {
        // already gone between the check and the signal
      }
      for (let i = 0; i < 30 && isProcessAlive(existingPid); i += 1) {
        await delay(50);
      }
    }
  } catch {
    // no readable PID file yet — first run
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

const releaseSingleInstanceLock = (): void => {
  try {
    if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // nothing to release
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  intervalSeconds = options.interval / 1000;
  await acquireSingleInstanceLock();
  const states = await buildStates(options.count);

  if (!states.length) {
    console.error("[mock-mqtt] config-runtime/vehicles.json 为空，无设备可发布。");
    process.exit(1);
  }

  const client = mqtt.connect(options.broker, {
    // A FIXED client id is the airtight single-publisher guarantee. The PID lock above
    // only covers this host, and it fails when a previous publisher is orphaned (npm does
    // not forward Ctrl+C to the tsx grandchild) or wedged (a hung `client.end` never
    // exits). Two publishers each run the deterministic sim at a different age, so the
    // backend sees battery/position/state flip between two timelines every tick — the
    // "C12/W05 一直在 定位/电量低/充电 之间跳、电量在两个数字之间跳" report. With one id the
    // broker performs MQTT session takeover: the newer publisher's connect disconnects the
    // older one, so only one timeline ever reaches the broker. MQTT 5 is requested so that
    // takeover arrives as a DISCONNECT with a reason code we can act on (see below).
    clientId: "navfleet-demo-publisher",
    protocolVersion: 5,
    // The bundled broker no longer allows anonymous clients. Prefer the
    // publisher account (write-only on the fleet topics); fall back to the
    // backend's own credentials so a single-account external broker works too.
    username: process.env.MQTT_PUBLISHER_USERNAME || process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PUBLISHER_PASSWORD || process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 3000,
  });

  let timer: NodeJS.Timeout | null = null;
  let superseded = false;

  const publishStatus = (deviceId: string, online: boolean) =>
    client.publish(`/fleet/${deviceId}/status`, JSON.stringify({ online, ts: Date.now() }));

  const publishTelemetry = (state: DeviceState) =>
    client.publish(`/fleet/${state.deviceId}/vehicle_info`, JSON.stringify(buildTelemetry(state)));

  client.on("connect", () => {
    console.log(`[mock-mqtt] connected: ${options.broker}`);
    console.log(
      `[mock-mqtt] devices: ${states.map((s) => `${s.deviceId}:${s.scenario}`).join(", ")}`,
    );

    states.forEach((state) => {
      publishTelemetry(state);
      state.tick += 1;
      publishStatus(state.deviceId, true);
    });

    timer = setInterval(() => {
      states.forEach((state) => {
        if (!state.active) {
          return;
        }

        publishTelemetry(state);
        state.tick += 1;

        if (state.tick % 10 === 0) {
          publishStatus(state.deviceId, true);
        }

        // The faulted vehicle reports its stop for a while, then drops offline so
        // the backend's offline detection (and the critical offline alert) shows.
        if (state.scenario === "fault-offline" && state.tick >= FAULT_OFFLINE_TICKS) {
          console.log(
            `[mock-mqtt] ${state.deviceId} stopped reporting — waiting for backend offline detection`,
          );
          publishStatus(state.deviceId, false);
          state.active = false;
        }
      });
    }, options.interval);
  });

  // MQTT 5 server-initiated DISCONNECT. Reason code 142 (0x8E) is "Session taken over":
  // a newer publisher connected with our fixed client id, so we are the stale timeline —
  // stand down instead of letting `reconnectPeriod` reconnect and kick the newcomer back
  // (a kick-war that would flicker the demo worse than a single stale publisher). Other
  // reason codes (e.g. a transient server shutdown) fall through to normal reconnect.
  client.on("disconnect", (packet) => {
    if (packet?.reasonCode === 142 && !superseded) {
      superseded = true;
      console.log(
        "[mock-mqtt] superseded by a newer publisher (session taken over); standing down",
      );
      shutdown();
    }
  });

  client.on("error", (error) => {
    console.error("[mock-mqtt] broker error:", error.message);
    // mqtt.js surfaces CONNACK 4/5 as a "Connection refused" error. Anonymous
    // access is off in the bundled broker, so this is the likely first stumble.
    if (/not authorized|bad user name or password/i.test(error.message)) {
      console.error(
        "[mock-mqtt] the broker rejected these credentials. Export MQTT_PUBLISHER_USERNAME and\n" +
          "            MQTT_PUBLISHER_PASSWORD (see deploy/.env) before publishing.",
      );
    }
  });

  const shutdown = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    releaseSingleInstanceLock();
    // Force-exit fallback: a wedged broker connection can leave `client.end`'s callback
    // pending forever, which is exactly how a publisher survives SIGTERM and becomes the
    // orphan the next run collides with. Never let this process outlive its stop signal.
    const force = setTimeout(() => process.exit(0), 1500);
    force.unref?.();
    client.end(true, () => {
      console.log("[mock-mqtt] stopped");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
