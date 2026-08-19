import mqtt from "mqtt";

type Scenario = "normal" | "low-soc" | "warning" | "critical-then-offline";

interface CliOptions {
  broker: string;
  count: number;
  interval: number;
  devicePrefix: string;
}

interface MockDeviceState {
  deviceId: string;
  scenario: Scenario;
  tick: number;
  active: boolean;
  baseX: number;
  baseY: number;
  baseYaw: number;
}

const DEFAULT_BROKER = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const DEFAULT_COUNT = 4;
const DEFAULT_INTERVAL = 1000;
const DEFAULT_DEVICE_PREFIX = "agv";
const GPS_ORIGIN = {
  lat: 31.2304,
  lng: 121.4737,
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    broker: DEFAULT_BROKER,
    count: DEFAULT_COUNT,
    interval: DEFAULT_INTERVAL,
    devicePrefix: DEFAULT_DEVICE_PREFIX,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--broker" && next) {
      options.broker = next;
      index += 1;
      continue;
    }
    if (current === "--count" && next) {
      options.count = Math.max(1, Number(next) || DEFAULT_COUNT);
      index += 1;
      continue;
    }
    if (current === "--interval" && next) {
      // Floor at 20ms so higher-frequency load profiles are possible for perf runs.
      options.interval = Math.max(20, Number(next) || DEFAULT_INTERVAL);
      index += 1;
      continue;
    }
    if (current === "--device-prefix" && next) {
      options.devicePrefix = next;
      index += 1;
      continue;
    }
    if (current === "--help" || current === "-h") {
      console.log(
        `
Usage: npx tsx scripts/mock-mqtt.ts [options]

Options:
  --broker <url>         MQTT broker URL, default: ${DEFAULT_BROKER}
  --count <number>       Number of mock devices, default: ${DEFAULT_COUNT}
  --interval <ms>        Publish interval in milliseconds, default: ${DEFAULT_INTERVAL}
  --device-prefix <str>  Device id prefix, default: ${DEFAULT_DEVICE_PREFIX}
      `.trim(),
      );
      process.exit(0);
    }
  }

  return options;
}

function createDeviceId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(2, "0")}`;
}

function buildScenario(index: number): Scenario {
  const scenarios: Scenario[] = ["normal", "low-soc", "warning", "critical-then-offline"];
  return scenarios[index % scenarios.length];
}

function createStates(options: CliOptions): MockDeviceState[] {
  return Array.from({ length: options.count }, (_, index) => ({
    deviceId: createDeviceId(options.devicePrefix, index),
    scenario: buildScenario(index),
    tick: 0,
    active: true,
    baseX: 12 + index * 14,
    baseY: 18 + index * 11,
    baseYaw: 0.15 + index * 0.22,
  }));
}

function nowStamp(): number {
  return Date.now();
}

function drift(base: number, tick: number, scale: number): number {
  return Number((base + Math.sin(tick / 3) * scale).toFixed(3));
}

function normalizeHeading(yaw: number): number {
  const degrees = (yaw * 180) / Math.PI;
  return Number((((degrees % 360) + 360) % 360).toFixed(1));
}

function sceneToGps(x: number, y: number, yaw: number) {
  const latFactor = 1 / 111320;
  const lngFactor = 1 / (111320 * Math.cos((GPS_ORIGIN.lat * Math.PI) / 180));
  return {
    lat: Number((GPS_ORIGIN.lat + y * latFactor).toFixed(6)),
    lng: Number((GPS_ORIGIN.lng + x * lngFactor).toFixed(6)),
    heading: normalizeHeading(yaw),
  };
}

function buildTelemetry(state: MockDeviceState) {
  const stamp = nowStamp();
  const moving = state.scenario !== "critical-then-offline" || state.tick < 2;
  const x = drift(state.baseX, state.tick, moving ? 0.55 : 0.05);
  const y = drift(state.baseY, state.tick + 1.2, moving ? 0.45 : 0.05);
  const yaw = drift(state.baseYaw, state.tick, 0.04);
  const speed = moving ? drift(1.2 + state.tick * 0.01, state.tick, 0.18) : 0.08;

  const infoCode =
    state.scenario === "normal"
      ? { code: 1101, info: "定位稳定", stamp }
      : { code: 0, info: "", stamp };

  const warningCode =
    state.scenario === "warning"
      ? { code: 2203, info: "限速生效", stamp }
      : { code: 0, info: "", stamp };

  const errorCode =
    state.scenario === "critical-then-offline"
      ? { code: 5102, info: "规划超时", stamp }
      : { code: 0, info: "", stamp };

  const soc =
    state.scenario === "low-soc"
      ? 15.8
      : state.scenario === "critical-then-offline"
        ? 44.6
        : 68.5 - state.tick * 0.05;

  const speedLimitModule =
    state.scenario === "warning"
      ? "safety"
      : state.scenario === "critical-then-offline"
        ? "planner"
        : "dispatcher";
  const gps = state.scenario === "critical-then-offline" ? undefined : sceneToGps(x, y, yaw);

  return {
    stamp,
    scene_id: "kangcheng-airy",
    ...(gps ? { gps } : {}),
    fusion_loc: { x, y, yaw },
    lidar_loc: {
      x: Number((x - 0.2).toFixed(3)),
      y: Number((y - 0.18).toFixed(3)),
      yaw: Number((yaw - 0.03).toFixed(3)),
    },
    vehicle_info: {
      control_mode: 1,
      gear: moving ? 1 : 0,
      speed,
      omega: Number((Math.cos(state.tick / 4) * 0.08).toFixed(3)),
      soc: Number(soc.toFixed(1)),
    },
    task_status: moving ? 1 : 0,
    platform_task_status: moving ? 2 : 0,
    info_code: infoCode,
    warning_code: warningCode,
    error_code: errorCode,
    speed_limit: {
      limit: state.scenario === "warning" ? 1.2 : 2.5,
      slowdown_time: state.scenario === "warning" ? 5 : 0,
      stamp,
      module_name: speedLimitModule,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const states = createStates(options);

  const client = mqtt.connect(options.broker, {
    clientId: `fleet-mock-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 3000,
  });

  let timer: NodeJS.Timeout | null = null;

  const publishStatus = (deviceId: string, online: boolean) =>
    client.publish(`/fleet/${deviceId}/status`, JSON.stringify({ online, ts: nowStamp() }));

  const publishTelemetry = (state: MockDeviceState) => {
    const payload = buildTelemetry(state);
    client.publish(`/fleet/${state.deviceId}/vehicle_info`, JSON.stringify(payload));
  };

  client.on("connect", () => {
    console.log(`[mock-mqtt] connected: ${options.broker}`);
    console.log(
      `[mock-mqtt] devices: ${states.map((state) => `${state.deviceId}:${state.scenario}`).join(", ")}`,
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

        if (state.scenario === "critical-then-offline" && state.tick >= 2) {
          console.log(
            `[mock-mqtt] stop publishing ${state.deviceId}, waiting for backend offline detection`,
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
