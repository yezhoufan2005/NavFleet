/**
 * Seed fleet for the end-to-end suite.
 *
 * The payloads are the same snake_case telemetry frames the vehicles publish
 * over MQTT (see `backend/scripts/mock-mqtt.ts`), pushed through
 * `POST /api/debug/ingest` so the run needs no broker. Device *names*, scenes
 * and formations are deliberately left out of the payloads: they come from
 * `config-runtime/*.json`, so the suite also covers the config-registry wiring.
 *
 * All three vehicles live on `kangcheng-airy`, the one demo scene backed by a
 * Lanelet2 OSM road network — which is what makes the ROS map render lane
 * geometry rather than just a placeholder.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./harness";

/** Report code as carried in a telemetry frame. */
interface SeedCode {
  code: number;
  info: string;
}

export interface SeededDevice {
  deviceId: string;
  /** From config-runtime/vehicles.json — what the UI actually renders. */
  deviceName: string;
  /** Status pill / tone label the dashboard derives from the report codes. */
  statusLabel: string;
  soc: number;
  start: { x: number; y: number };
  infoCode?: SeedCode;
  warningCode?: SeedCode;
  errorCode?: SeedCode;
}

/** The scene shared by the seeded vehicles (config-runtime/scenes.json). */
export const SEEDED_SCENE = {
  sceneId: "kangcheng-airy",
  sceneName: "康城 Airy 路网",
} as const;

/** Telemetry frames pushed per device — also the number of history samples. */
export const SAMPLES_PER_DEVICE = 6;

/** Well inside the scene bounds (minX -51, maxX 25, minY -45, maxY 45). */
export const SEEDED_DEVICES: SeededDevice[] = [
  {
    deviceId: "agv-a01",
    deviceName: "A01 巡检车",
    statusLabel: "提示",
    soc: 74.5,
    start: { x: -30, y: -12 },
    infoCode: { code: 1101, info: "定位稳定" },
  },
  {
    deviceId: "agv-b07",
    deviceName: "B07 巡检车",
    statusLabel: "预警",
    soc: 58.5,
    start: { x: -20, y: 2 },
    warningCode: { code: 2203, info: "前方限速区，已降速通行" },
  },
  {
    deviceId: "agv-c12",
    deviceName: "C12 巡检车",
    statusLabel: "告警",
    soc: 41.5,
    start: { x: -8, y: 14 },
    errorCode: { code: 5102, info: "路径规划超时，已触发急停" },
  },
];

/**
 * The seeded vehicle carrying a report code, and the one carrying a non-normal status.
 *
 * Exported — and asserted here rather than guarded at each call site — because five
 * specs used to open with `test.skip(!faulted, "seed carries no faulted vehicle")`.
 * That guard can never fire against this seed, so it looked like defensive care and
 * was in fact a **silent hole**: edit the seed to drop `errorCode` and those tests
 * stop running instead of failing, taking the report-code explanation, the alert
 * centre's severity filter and 告警史 with them, with nothing red to say so.
 *
 * Throwing at import time is the opposite trade: the seed cannot lose these
 * properties without every spec that depends on them failing immediately.
 */
const findFaulted = (): SeededDevice => {
  const faulted = SEEDED_DEVICES.find((device) => device.errorCode?.code);
  if (!faulted) {
    throw new Error(
      "SEEDED_DEVICES must contain a device with a non-zero errorCode: the report-code and 告警史 specs assert against it",
    );
  }
  return faulted;
};

const findAlerting = (): SeededDevice => {
  const alerting = SEEDED_DEVICES.find(
    (device) => device.statusLabel !== "正常",
  );
  if (!alerting) {
    throw new Error(
      "SEEDED_DEVICES must contain a device whose statusLabel is not 正常: the alert-centre specs assert against it",
    );
  }
  return alerting;
};

/** The faulted vehicle (`agv-c12`, code 5102). */
export const SEEDED_FAULTED: SeededDevice = findFaulted();

/** A vehicle with something to report, for the alert-centre specs. */
export const SEEDED_ALERTING: SeededDevice = findAlerting();

/**
 * How many formations the deployment config declares.
 *
 * Read from the file rather than written as `3`, because the overview's formation
 * panel is asserted against it in a browser (row count, pinned row height, the
 * `max-height` that makes "three rows" mean three, and the absence of a scrollbar).
 * Those were bare literals coupled to `config-runtime/formations.json` with nothing
 * pointing at the coupling — so adding a fourth formation to the *deployment* config
 * broke a spec whose failure message said nothing about why.
 *
 * If this ever exceeds 3, the panel's own rule changes rather than the number: three
 * rows stay visible and the rest become scrollable. That is a deliberate assertion to
 * revisit, not a constant to bump.
 */
export const CONFIGURED_FORMATION_COUNT: number = (
  JSON.parse(
    readFileSync(
      // Relative to the repo root, which is where playwright runs from — the e2e
      // tsconfig targets CommonJS, so `import.meta.url` is not available here.
      join(REPO_ROOT, "config-runtime", "formations.json"),
      "utf8",
    ),
  ) as unknown[]
).length;

const GPS_ORIGIN = { lat: 31.2304, lng: 121.4737 };

const round = (value: number, digits = 3): number =>
  Number(value.toFixed(digits));

/** Scene metres → WGS84, mirroring the demo publisher's flat projection. */
const sceneToGps = (x: number, y: number, yaw: number) => ({
  lat: round(GPS_ORIGIN.lat + y / 111320, 6),
  lng: round(
    GPS_ORIGIN.lng + x / (111320 * Math.cos((GPS_ORIGIN.lat * Math.PI) / 180)),
    6,
  ),
  heading: round(((((yaw * 180) / Math.PI) % 360) + 360) % 360, 1),
});

const emptyCode = { code: 0, info: "" } as const;

/**
 * One telemetry frame. Every frame of a device repeats its report codes so the
 * device's current alerts do not depend on which frame landed last, while pose
 * and timestamp advance to give history playback a real track.
 */
const buildFrame = (
  device: SeededDevice,
  index: number,
  endStampMs: number,
) => {
  const stamp = endStampMs - (SAMPLES_PER_DEVICE - 1 - index) * 2000;
  const x = round(device.start.x + index * 1.5);
  const y = round(device.start.y + index * 0.75);
  const yaw = 0.463;

  return {
    deviceId: device.deviceId,
    stamp,
    scene_id: SEEDED_SCENE.sceneId,
    gps: sceneToGps(x, y, yaw),
    fusion_loc: { x, y, yaw },
    lidar_loc: { x: round(x - 0.15), y: round(y - 0.12), yaw },
    vehicle_info: {
      control_mode: 1,
      gear: 1,
      speed: 1.2,
      omega: 0,
      soc: device.soc,
    },
    task_status: 1,
    platform_task_status: 1,
    info_code: { ...(device.infoCode ?? emptyCode), stamp },
    warning_code: { ...(device.warningCode ?? emptyCode), stamp },
    error_code: { ...(device.errorCode ?? emptyCode), stamp },
    speed_limit: {
      limit: 2.5,
      slowdown_time: 0,
      stamp,
      module_name: "dispatcher",
    },
  };
};

/** Every frame to ingest, oldest first, ending "now". */
export const buildSeedFrames = (
  endStampMs = Date.now(),
): ReturnType<typeof buildFrame>[] =>
  SEEDED_DEVICES.flatMap((device) =>
    Array.from({ length: SAMPLES_PER_DEVICE }, (_unused, index) =>
      buildFrame(device, index, endStampMs),
    ),
  );
