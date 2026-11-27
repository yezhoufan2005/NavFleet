/**
 * How each kind of vehicle behaves — the numbers the simulation draws from, gathered in one place
 * so they can be tuned against a real fleet without touching the state machine.
 *
 * Rates are **estimates**, not measurements from a real site: speeds and battery figures sit in
 * the range of small indoor AMRs and yard tugs, event rates are per working hour and chosen so a
 * 29-vehicle fleet shows a few warnings an hour and a fault or two a day. What is not an estimate
 * is the shape: low battery is the platform's rule, not a vehicle code (as in VDA 5050, a vehicle
 * reports its charge and the fleet side decides it is low); a vehicle's codes are its own
 * observations — localisation, obstacles, safety stops, drive and sensor faults, BMS temperature.
 */

export type Category = "巡检" | "搬运" | "牵引" | "配料";

export interface Profile {
  /** Cruise speed (m/s) empty, and the factor a full load applies. */
  speed: number;
  loadedSpeedFactor: number;
  accel: number;
  decel: number;
  /** Battery %/h while driving at cruise, and while standing in automatic mode. */
  drainDriving: number;
  drainStanding: number;
  /** Charge rate (%/h) up to 80 %, tapering above. */
  chargeRate: number;
  /** Working hours [start, end) for shift-bound vehicles; null = round the clock. */
  shift: [number, number] | null;
  /**
   * Mean wait (s) for the next task during the day; tripled at night for round-the-clock vehicles.
   * For a patrol vehicle, the wait between inspection rounds.
   */
  taskWait: number;
  /** Dwell (s) at pick and drop, as [min, max]. */
  dwell: [number, number];
  /** Whether this vehicle carries loads (inspection vehicles patrol instead). */
  carries: boolean;
  /** Event rates per working hour. */
  events: Partial<Record<EventKind, number>>;
}

export type EventKind =
  | "locDegraded"
  | "commDegraded"
  | "commLoss"
  | "obstacle"
  | "collisionGuard"
  | "estop"
  | "trackingDeviation"
  | "lidarDirty"
  | "driveFault"
  | "planTimeout"
  | "taskFailed"
  | "payloadOffset"
  | "payloadShift"
  | "tempLimitZone"
  | "teleopSession"
  // Site- and vendor-dependent (see `siteEventRates`), not part of a category profile.
  | "peopleNearby"
  | "liftJam"
  | "coldBattery"
  | "vendorAlarm"
  | "firmwareCode";

export const PROFILES: Record<Category, Profile> = {
  巡检: {
    speed: 1.3,
    loadedSpeedFactor: 1,
    accel: 0.5,
    decel: 0.8,
    drainDriving: 7,
    drainStanding: 1.2,
    chargeRate: 40,
    shift: null,
    taskWait: 3000,
    dwell: [20, 60],
    carries: false,
    events: {
      locDegraded: 0.05,
      commDegraded: 0.02,
      commLoss: 0.003,
      obstacle: 0.008,
      collisionGuard: 0.006,
      estop: 0.002,
      lidarDirty: 0.006,
      driveFault: 0.0008,
      planTimeout: 0.003,
      tempLimitZone: 0.04,
    },
  },
  搬运: {
    speed: 1.0,
    loadedSpeedFactor: 0.8,
    accel: 0.4,
    decel: 0.7,
    drainDriving: 9,
    drainStanding: 1.2,
    chargeRate: 42,
    shift: null,
    taskWait: 120,
    dwell: [25, 70],
    carries: true,
    events: {
      locDegraded: 0.015,
      commDegraded: 0.01,
      commLoss: 0.002,
      obstacle: 0.02,
      collisionGuard: 0.008,
      estop: 0.0025,
      driveFault: 0.0008,
      planTimeout: 0.003,
      taskFailed: 0.004,
      payloadShift: 0.02,
      tempLimitZone: 0.03,
    },
  },
  牵引: {
    speed: 1.6,
    loadedSpeedFactor: 0.7,
    accel: 0.3,
    decel: 0.6,
    drainDriving: 12,
    drainStanding: 1.5,
    chargeRate: 35,
    shift: null,
    taskWait: 240,
    dwell: [40, 120],
    carries: true,
    events: {
      locDegraded: 0.03,
      commDegraded: 0.02,
      commLoss: 0.003,
      obstacle: 0.02,
      collisionGuard: 0.006,
      estop: 0.003,
      trackingDeviation: 0.02,
      lidarDirty: 0.005,
      driveFault: 0.001,
      planTimeout: 0.003,
      taskFailed: 0.003,
      payloadOffset: 0.03,
      tempLimitZone: 0.03,
    },
  },
  配料: {
    speed: 0.8,
    loadedSpeedFactor: 0.85,
    accel: 0.4,
    decel: 0.7,
    drainDriving: 8,
    drainStanding: 1.0,
    chargeRate: 45,
    shift: [6, 22],
    taskWait: 180,
    dwell: [20, 50],
    carries: true,
    events: {
      locDegraded: 0.01,
      commDegraded: 0.008,
      obstacle: 0.015,
      collisionGuard: 0.006,
      estop: 0.002,
      driveFault: 0.0008,
      taskFailed: 0.004,
      payloadShift: 0.015,
      tempLimitZone: 0.02,
    },
  },
};

/**
 * Per-vehicle multipliers on top of the profile, keyed by the `notes` an operator wrote in
 * vehicles.json — so the demo's "偶发激光定位丢失" vehicle really does lose localisation more.
 */
export const vehicleQuirks = (
  notes: string | undefined,
): Partial<Record<EventKind | "batteryHeat", number>> => {
  const text = notes ?? "";
  return {
    ...(text.includes("定位丢失") ? { locDegraded: 4 } : {}),
    ...(text.includes("电池") ? { batteryHeat: 3 } : {}),
    ...(text.includes("遥控") ? { teleopSession: 1 } : {}),
  };
};

/**
 * The vehicle's own words for each code it reports (the codebook carries the platform's label). A
 * code missing here is reported with an empty text, as some firmware does — the console then shows
 * the dictionary's label alone.
 */
export const CODE_TEXT: Record<number, string> = {
  1101: "定位稳定，可接收任务",
  1102: "已完成重定位",
  1301: "正在充电",
  1501: "巡检轮次已完成",
  1502: "任务完成，待命中",
  1503: "到达人工交接位，等待确认",
  1601: "远程接管中，操作员在线",
  1602: "Wi-Fi 信号弱，已切换 4G 备用链路",
  2101: "定位置信度偏低，已减速",
  2203: "前方临时限速区，已降速通行",
  2204: "轨迹跟踪偏差偏大",
  2302: "充电中电池温度偏高",
  2303: "电芯温度 3 ℃，放电功率限制 60%",
  2401: "激光雷达窗口受污，请清洁",
  2601: "通信质量下降，遥测可能延迟",
  2701: "人车混行区检测到人员，已减速鸣笛",
  2801: "牵引载荷偏心",
  2802: "载荷偏移超阈值，请检查货物与托盘",
  // Not in any dictionary: what a trial firmware reports before the codebook catches up.
  2805: "牵引销未完全落位，已降速",
  5101: "定位丢失，已停车等待重定位",
  5102: "路径规划超时，已停车",
  5203: "驱动器报错，已停车",
  5301: "电量耗尽保护，已停车",
  5401: "激光雷达无数据，已停车",
  5501: "任务执行失败，等待调度重派",
  5701: "急停已触发，等待人工复位",
  5702: "防撞保护停车",
  5703: "避障等待超时，障碍未解除",
};

/** Local hour (Asia/Shanghai, no DST) of an instant — the site's clock for shifts and nights. */
export const localHour = (ms: number): number => new Date(ms + 8 * 3_600_000).getUTCHours();

export const isNight = (ms: number): boolean => {
  const hour = localHour(ms);
  return hour < 7 || hour >= 22;
};

// ── Vendors ───────────────────────────────────────────────────────────────────

/** A field of the vehicle protocol a vendor's firmware may simply not send. */
export type OptionalField =
  "omega" | "gear" | "speedLimit" | "fusionLoc" | "poseYaw" | "gpsHeading";

/**
 * What a vendor's firmware puts in its frames. A mixed fleet is mixed in this too: one chassis
 * does not report angular velocity, a QR-guided carrier localises with its lidar only, a GNSS
 * receiver with one antenna has no heading, older firmware passes the dispatcher's task on in
 * part. The platform shows such a field as 缺失 — the demo makes sure it does somewhere.
 */
export interface VendorProfile {
  /** Fields this firmware never sends. */
  omits: readonly OptionalField[];
  /**
   * How much of the task it passes on: `full`; `untyped` (no task type); `brief` (id, destination
   * and step name — no origin, step count or start time).
   */
  task: "full" | "untyped" | "brief";
  /** Reports the step one past the total when a task completes (the platform clamps it). */
  stepOverrun: boolean;
  /** Also reports the vendor's own alarm list (`alarmList`), next to the report codes. */
  alarms: boolean;
}

const FULL: VendorProfile = { omits: [], task: "full", stepOverrun: false, alarms: false };

export const VENDORS: Record<string, VendorProfile> = {
  优艾智合: FULL,
  // Passes the dispatcher's task on without its type.
  海康机器人: { ...FULL, task: "untyped" },
  // Single-antenna GNSS: a position, no heading.
  亿嘉和: { ...FULL, omits: ["gpsHeading"] },
  // The chassis controller does not pass angular velocity up.
  快仓: { ...FULL, omits: ["omega"] },
  // SEER controllers report their own alarm list besides the codes.
  仙工智能: { ...FULL, alarms: true },
  // Counts the completed step past the total at the end of a job.
  斯坦德: { ...FULL, stepOverrun: true },
  // QR-code guided with a lidar for the aisles: lidar pose only, no gear.
  极智嘉: { ...FULL, omits: ["fusionLoc", "gear"] },
  // Older firmware: no speed-limit block, poses as x/y without a heading, a brief task.
  未来机器人: { ...FULL, omits: ["speedLimit", "poseYaw"], task: "brief" },
};

export const vendorProfile = (vendor: string | undefined): VendorProfile =>
  (vendor && VENDORS[vendor]) || FULL;

/**
 * A vendor's own alarms (SEER-style `alarmList`): conditions its controller watches that have no
 * platform report code, in its own severity words. Rates are per working hour of one vehicle.
 */
export const VENDOR_ALARMS: ReadonlyArray<{
  code: number;
  title: string;
  detail: string;
  level: "ERROR" | "WARN" | "INFO";
  seconds: [number, number];
  weight: number;
}> = [
  {
    code: 54003,
    title: "驱动器温度偏高",
    detail: "左驱动器 68 ℃，已限制加速度",
    level: "WARN",
    seconds: [600, 2400],
    weight: 5,
  },
  {
    code: 52101,
    title: "电池通讯中断",
    detail: "BMS 心跳超时 3 s，电量读数暂不可信",
    level: "ERROR",
    seconds: [60, 300],
    weight: 1,
  },
  {
    // Raised by the site's fire-alarm interlock (the 消防联动演练 scenario), never drawn (weight 0).
    code: 51001,
    title: "安全回路断开",
    detail: "外部急停回路断开（消防联动），驱动已断电",
    level: "ERROR",
    seconds: [0, 0],
    weight: 0,
  },
  {
    // Held while the charge is under 12 % and the vehicle is not charging (weight 0: not drawn).
    code: 52301,
    title: "电量低",
    detail: "电量低于 12%，请尽快安排回充",
    level: "INFO",
    seconds: [0, 0],
    weight: 0,
  },
  {
    // Raised with the battery protection stop (5301), never drawn on its own (weight 0).
    code: 52203,
    title: "电池欠压保护",
    detail: "电芯最低电压 3.02 V，已切断驱动输出",
    level: "ERROR",
    seconds: [1200, 3600],
    weight: 0,
  },
  {
    code: 50601,
    title: "地图版本与调度不一致",
    detail: "车载地图 v12，调度下发 v13，等待同步",
    level: "INFO",
    seconds: [300, 900],
    weight: 2,
  },
];

// ── Vehicles with a story ───────────────────────────────────────────────────

/**
 * Individual vehicles that behave unlike their kind, each for a reason a site would recognise
 * (the reason is in the vehicle's `notes` in vehicles.json, which the console shows).
 */
export interface Persona {
  /** Registered but never switched on (a spare in storage): the simulator does not run it. */
  dormant?: boolean;
  /** The on-board computer's clock runs this far ahead of real time (ms). */
  clockSkewMs?: number;
  /** A 4G gateway that buffers on a weak link and flushes late: frames now and then out of order. */
  lateFrames?: boolean;
  /** Reports GPS even though the platform is told not to show it (`gpsEnabled: false`). */
  gpsAntenna?: boolean;
  /** Metres of positioning noise on that GPS (multipath under a roof). */
  gpsNoise?: number;
  /** No map localisation at all: drives on GPS, reports no ROS pose. */
  poseless?: boolean;
  /** A second scene this vehicle patrols on some nights. */
  nightScene?: string;
  /** Runs a trial firmware that reports codes the dictionary does not have yet. */
  trialFirmware?: boolean;
}

export const PERSONAS: Record<string, Persona> = {
  "agv-y09": { dormant: true },
  "agv-p03": { clockSkewMs: 125_000 },
  "agv-a08": { lateFrames: true },
  "agv-c01": { gpsAntenna: true, gpsNoise: 3 },
  "agv-s01": { poseless: true },
  "agv-a06": { nightScene: "yard-north" },
  "agv-y08": { trialFirmware: true },
};

/** Codes a trial firmware reports that no dictionary knows; 5299 comes without any text. */
export const FIRMWARE_CODES: ReadonlyArray<{
  slot: "warning" | "error";
  code: number;
  seconds: [number, number];
}> = [
  { slot: "warning", code: 2805, seconds: [60, 300] },
  { slot: "error", code: 5299, seconds: [120, 600] },
];

/**
 * Vehicles that report without being in vehicles.json: a vendor's test vehicle on site for a few
 * afternoons a week. It reports what its debug build does — position, codes, its alarm list — and
 * nothing about speed, battery, gear or task; it has no place on the site maps.
 */
export interface VisitorConfig {
  deviceId: string;
  /** The site scene it drives in (its loop and GPS position come from there). */
  sceneId: string;
  /** The map its debug build carries and reports — the vendor's lab, unknown to this site. */
  reportedSceneId: string;
  vendor: string;
  /** Local weekdays (0 = Sunday) and hours [from, to) it is switched on. */
  days: readonly number[];
  hours: [number, number];
}

export const VISITORS: readonly VisitorConfig[] = [
  {
    deviceId: "seer-test-07",
    sceneId: "yard-north",
    reportedSceneId: "seer-lab-03",
    vendor: "仙工智能",
    days: [2, 4],
    hours: [14, 17.5],
  },
];

/** Local weekday (0 = Sunday) of an instant, on the site's clock. */
export const localWeekday = (ms: number): number => new Date(ms + 8 * 3_600_000).getUTCDay();

/** Local hour with minutes as a fraction (14.5 = 14:30). */
export const localHourFraction = (ms: number): number => {
  const date = new Date(ms + 8 * 3_600_000);
  return date.getUTCHours() + date.getUTCMinutes() / 60;
};
