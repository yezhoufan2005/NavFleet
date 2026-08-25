import fs from "node:fs";
import path from "node:path";
import mqtt from "mqtt";

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
// __MOCK_1__
interface DeviceState {
  deviceId: string;
  sceneId: string;
  gpsEnabled: boolean;
  scenario: Scenario;
  route: Point[]; // closed patrol loop (corners); movement interpolates along it
  cruiseSpeed: number; // m/s along the route
  station: Point; // parked position (charging / after a fault)
  soc: number; // battery %, evolves deterministically per tick
  frozenAt: { x: number; y: number; yaw: number } | null; // where a faulted vehicle stopped
  tick: number;
  active: boolean;
}

const DEFAULT_BROKER = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const DEFAULT_INTERVAL = 1000;
const GPS_ORIGIN = { lat: 31.2304, lng: 121.4737 };

// Assigned round-robin by vehicle index so a full fleet covers the whole surface.
const SCENARIO_RING: Scenario[] = [
  "cruising",
  "speed-limited",
  "charging",
  "hauling",
  "fault-offline",
  "teleop",
];

// Per-scenario cruising speed (m/s) and initial battery (%). Deterministic.
const SCENARIO_SPEED: Record<Scenario, number> = {
  cruising: 1.3,
  "speed-limited": 0.7,
  charging: 0,
  hauling: 1.0,
  "fault-offline": 1.1,
  teleop: 0.9,
};
const SCENARIO_INITIAL_SOC: Record<Scenario, number> = {
  cruising: 82,
  "speed-limited": 66,
  charging: 16,
  hauling: 73,
  "fault-offline": 55,
  teleop: 60,
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
// __MOCK_2__
const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

function normalizeHeading(yaw: number): number {
  const degrees = (yaw * 180) / Math.PI;
  return round(((degrees % 360) + 360) % 360, 1);
}

function sceneToGps(x: number, y: number, yaw: number) {
  const latFactor = 1 / 111320;
  const lngFactor = 1 / (111320 * Math.cos((GPS_ORIGIN.lat * Math.PI) / 180));
  return {
    lat: round(GPS_ORIGIN.lat + y * latFactor, 6),
    lng: round(GPS_ORIGIN.lng + x * lngFactor, 6),
    heading: normalizeHeading(yaw),
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

function routePerimeter(route: Point[]): number {
  let total = 0;
  for (let i = 0; i < route.length; i += 1) {
    const a = route[i];
    const b = route[(i + 1) % route.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

// Point + heading at arc-length `distance` along the closed route.
function pointOnRoute(route: Point[], distance: number): { x: number; y: number; yaw: number } {
  const perimeter = routePerimeter(route);
  let d = ((distance % perimeter) + perimeter) % perimeter;
  for (let i = 0; i < route.length; i += 1) {
    const a = route[i];
    const b = route[(i + 1) % route.length];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= segLen || i === route.length - 1) {
      const t = segLen > 0 ? d / segLen : 0;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        yaw: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
    d -= segLen;
  }
  return { x: route[0].x, y: route[0].y, yaw: 0 };
}

function buildStates(count: number): DeviceState[] {
  const root = resolveConfigRoot();
  const vehicles = readJson<Vehicle[]>(path.join(root, "vehicles.json"));
  const scenes = readJson<SceneConfig[]>(path.join(root, "scenes.json"));
  const limit = count > 0 ? Math.min(count, vehicles.length) : vehicles.length;

  return vehicles.slice(0, limit).map((vehicle, index) => {
    const bounds = findBounds(scenes, vehicle.defaultSceneId || "");
    const scenario = SCENARIO_RING[index % SCENARIO_RING.length];
    const { route, station } = buildRoute(bounds, index);
    return {
      deviceId: vehicle.deviceId,
      sceneId: vehicle.defaultSceneId || "",
      gpsEnabled: vehicle.gpsEnabled !== false,
      scenario,
      route,
      cruiseSpeed: SCENARIO_SPEED[scenario],
      station,
      soc: SCENARIO_INITIAL_SOC[scenario],
      frozenAt: null,
      tick: 0,
      active: true,
    };
  });
}
// __MOCK_3__
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

function buildTelemetry(state: DeviceState) {
  const stamp = Date.now();
  const frame = scenarioFrame(state.scenario);

  let x: number;
  let y: number;
  let yaw: number;
  let speed: number;

  const faulted = state.scenario === "fault-offline" && state.tick >= FAULT_MOVE_TICKS;

  if (frame.motion === "charging") {
    x = state.station.x;
    y = state.station.y;
    yaw = 0;
    speed = 0;
  } else if (faulted) {
    const stopPose =
      state.frozenAt ??
      pointOnRoute(state.route, state.cruiseSpeed * FAULT_MOVE_TICKS * intervalSeconds);
    state.frozenAt = stopPose;
    x = stopPose.x;
    y = stopPose.y;
    yaw = stopPose.yaw;
    speed = 0;
  } else {
    const pose = pointOnRoute(state.route, state.cruiseSpeed * state.tick * intervalSeconds);
    x = pose.x;
    y = pose.y;
    yaw = pose.yaw;
    speed = state.cruiseSpeed;
  }

  stepBattery(state, frame.motion === "charging", speed > 0);
  const gps = state.gpsEnabled ? sceneToGps(x, y, yaw) : undefined;

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
// __MOCK_4__
async function main() {
  const options = parseArgs(process.argv.slice(2));
  intervalSeconds = options.interval / 1000;
  const states = buildStates(options.count);

  if (!states.length) {
    console.error("[mock-mqtt] config-runtime/vehicles.json 为空，无设备可发布。");
    process.exit(1);
  }

  const client = mqtt.connect(options.broker, {
    clientId: `fleet-mock-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 3000,
  });

  let timer: NodeJS.Timeout | null = null;

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

  client.on("error", (error) => {
    console.error("[mock-mqtt] broker error:", error.message);
  });

  const shutdown = () => {
    if (timer) {
      clearInterval(timer);
    }
    client.end(true, () => {
      console.log("[mock-mqtt] stopped");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
