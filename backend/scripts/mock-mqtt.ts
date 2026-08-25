import mqtt from "mqtt";

type Scenario = "cruising" | "speed-limited" | "charging" | "hauling" | "fault-offline" | "teleop";

interface DeviceProfile {
  deviceId: string;
  sceneId: string;
  gpsEnabled: boolean;
  home: { x: number; y: number; yaw: number };
  scenario: Scenario;
}

interface CliOptions {
  broker: string;
  count: number;
  interval: number;
}

/**
 * The mock fleet mirrors config-runtime/vehicles.json + formations.json so a
 * single `npm run mock:mqtt` lights up the whole product surface:
 *   - three map types: lanelet (kangcheng-airy), raster image (warehouse-a),
 *     point cloud (cloudpoint-demo);
 *   - every control-mode / gear / task-status enum label;
 *   - notice / warning / critical alerts, the low-battery rule, and the
 *     backend offline-detection path;
 *   - GPS-enabled outdoor cars and GPS-disabled indoor cars.
 * Coordinates stay well inside each scene's configured bounds.
 */
const DEVICE_PROFILES: DeviceProfile[] = [
  {
    deviceId: "agv-a01",
    sceneId: "kangcheng-airy",
    gpsEnabled: true,
    home: { x: 24, y: 30, yaw: 0.4 },
    scenario: "cruising",
  },
  {
    deviceId: "agv-b07",
    sceneId: "kangcheng-airy",
    gpsEnabled: true,
    home: { x: 40, y: 54, yaw: 1.2 },
    scenario: "speed-limited",
  },
  {
    deviceId: "agv-c12",
    sceneId: "kangcheng-airy",
    gpsEnabled: true,
    home: { x: 56, y: 22, yaw: 2.4 },
    scenario: "charging",
  },
  {
    deviceId: "agv-w05",
    sceneId: "warehouse-a",
    gpsEnabled: false,
    home: { x: 45, y: 30, yaw: 0.2 },
    scenario: "hauling",
  },
  {
    deviceId: "agv-w09",
    sceneId: "warehouse-a",
    gpsEnabled: false,
    home: { x: 82, y: 48, yaw: 3.0 },
    scenario: "fault-offline",
  },
  {
    deviceId: "agv-r01",
    sceneId: "cloudpoint-demo",
    gpsEnabled: true,
    home: { x: -46, y: 6, yaw: 1.0 },
    scenario: "teleop",
  },
];

const DEFAULT_BROKER = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const DEFAULT_INTERVAL = 1000;
const GPS_ORIGIN = { lat: 31.2304, lng: 121.4737 };

interface MockDeviceState extends DeviceProfile {
  tick: number;
  active: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    broker: DEFAULT_BROKER,
    count: DEVICE_PROFILES.length,
    interval: DEFAULT_INTERVAL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--broker" && next) {
      options.broker = next;
      index += 1;
    } else if (current === "--count" && next) {
      options.count = Math.max(1, Number(next) || DEVICE_PROFILES.length);
      index += 1;
    } else if (current === "--interval" && next) {
      // Floor at 20ms so higher-frequency load profiles are possible for perf runs.
      options.interval = Math.max(20, Number(next) || DEFAULT_INTERVAL);
      index += 1;
    } else if (current === "--help" || current === "-h") {
      console.log(
        `
Usage: npx tsx scripts/mock-mqtt.ts [options]

Options:
  --broker <url>    MQTT broker URL, default: ${DEFAULT_BROKER}
  --count <number>  Device count (1-${DEVICE_PROFILES.length} use the demo fleet;
                    more are synthesized for load tests), default: all
  --interval <ms>   Publish interval in milliseconds, default: ${DEFAULT_INTERVAL}
      `.trim(),
      );
      process.exit(0);
    }
  }

  return options;
}

function buildStates(count: number): MockDeviceState[] {
  const states: MockDeviceState[] = DEVICE_PROFILES.slice(0, count).map((profile) => ({
    ...profile,
    tick: 0,
    active: true,
  }));

  // Synthesize extra generic devices beyond the demo fleet for load testing.
  for (let index = DEVICE_PROFILES.length; index < count; index += 1) {
    states.push({
      deviceId: `agv-load-${String(index + 1).padStart(3, "0")}`,
      sceneId: "kangcheng-airy",
      gpsEnabled: true,
      home: { x: 10 + (index % 6) * 10, y: 10 + (index % 8) * 9, yaw: (index % 8) * 0.3 },
      scenario: "cruising",
      tick: 0,
      active: true,
    });
  }

  return states;
}

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
// __MOCK_REST__
interface ScenarioFrame {
  controlMode: number;
  gear: number;
  taskStatus: number;
  platformTaskStatus: number;
  soc: number;
  speed: number;
  moving: boolean;
  info: { code: number; info: string };
  warning: { code: number; info: string };
  error: { code: number; info: string };
  speedLimit: { limit: number; slowdownTime: number; module: string };
}

const NO_CODE = { code: 0, info: "" };

function scenarioFrame(state: MockDeviceState): ScenarioFrame {
  const t = state.tick;
  switch (state.scenario) {
    case "speed-limited":
      return {
        controlMode: 1,
        gear: 1,
        taskStatus: 1,
        platformTaskStatus: 1,
        soc: 63 - t * 0.02,
        speed: 0.6,
        moving: true,
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
        soc: Math.min(13 + t * 0.05, 30),
        speed: 0,
        moving: false,
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
        soc: 85 - t * 0.03,
        speed: 1.1,
        moving: true,
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
        soc: 48,
        speed: 0,
        moving: false,
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
        soc: 70 - t * 0.02,
        speed: 0.9,
        moving: true,
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
        soc: 78 - t * 0.02,
        speed: 1.3,
        moving: true,
        info: { code: 1101, info: "定位稳定" },
        warning: NO_CODE,
        error: NO_CODE,
        speedLimit: { limit: 2.5, slowdownTime: 0, module: "dispatcher" },
      };
  }
}
// __MOCK_REST2__
function buildTelemetry(state: MockDeviceState) {
  const stamp = Date.now();
  const frame = scenarioFrame(state);
  const wobble = frame.moving ? 1 : 0.05;
  const x = state.home.x + Math.sin(state.tick / 6 + state.home.yaw) * 3 * wobble;
  const y = state.home.y + Math.cos(state.tick / 7 + state.home.yaw) * 2.4 * wobble;
  const yaw = state.home.yaw + Math.sin(state.tick / 9) * 0.25 * wobble;
  const gps = state.gpsEnabled ? sceneToGps(x, y, yaw) : undefined;

  return {
    stamp,
    scene_id: state.sceneId,
    ...(gps ? { gps } : {}),
    fusion_loc: { x: round(x), y: round(y), yaw: round(yaw) },
    lidar_loc: { x: round(x - 0.2), y: round(y - 0.18), yaw: round(yaw - 0.03) },
    vehicle_info: {
      control_mode: frame.controlMode,
      gear: frame.gear,
      speed: round(frame.speed + Math.sin(state.tick / 4) * 0.12 * (frame.moving ? 1 : 0)),
      omega: round(Math.cos(state.tick / 5) * 0.06 * (frame.moving ? 1 : 0)),
      soc: round(Math.max(frame.soc, 0), 1),
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const states = buildStates(options.count);

  const client = mqtt.connect(options.broker, {
    clientId: `fleet-mock-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 3000,
  });

  let timer: NodeJS.Timeout | null = null;

  const publishStatus = (deviceId: string, online: boolean) =>
    client.publish(`/fleet/${deviceId}/status`, JSON.stringify({ online, ts: Date.now() }));

  const publishTelemetry = (state: MockDeviceState) =>
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

        // The fault device stops reporting after a short burst so the backend's
        // offline detection (and the critical offline alert) can be observed.
        if (state.scenario === "fault-offline" && state.tick >= 6) {
          console.log(
            `[mock-mqtt] ${state.deviceId} stopped reporting — waiting for backend offline detection`,
          );
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
