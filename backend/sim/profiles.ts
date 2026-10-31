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
  | "teleopSession";

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

/** The vehicle's own words for each code it reports (the codebook carries the platform's label). */
export const CODE_TEXT: Record<number, string> = {
  1101: "定位稳定，可接收任务",
  1102: "已完成重定位",
  1301: "正在充电",
  1501: "巡检轮次已完成",
  1502: "任务完成，待命中",
  1503: "到达人工交接位，等待确认",
  1601: "远程接管中，操作员在线",
  2101: "定位置信度偏低，已减速",
  2203: "前方临时限速区，已降速通行",
  2204: "轨迹跟踪偏差偏大",
  2302: "充电中电池温度偏高",
  2401: "激光雷达窗口受污，请清洁",
  2601: "通信质量下降，遥测可能延迟",
  2801: "牵引载荷偏心",
  2802: "载荷偏移超阈值，请检查货物与托盘",
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
