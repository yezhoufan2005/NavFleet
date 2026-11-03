import type { DeviceSnapshot, VehicleInfoState } from "@navfleet/shared";

/**
 * 实时状态 — a vehicle's current *operational* state, one level finer than the
 * `DeviceTone` severity bucket (正常/提示/预警/告警/离线).
 *
 * A tone answers "how worried should I be"; it collapses a charging robot, a robot
 * running a task and an idle robot all into 正常. 实时状态 answers "what is it doing
 * right now", which is the question the 待处理项 list and the device pages actually
 * need. It is *derived*, not a new telemetry field: every signal it reads
 * (`online`, `controlMode`, `taskStatus`, the active error code) already arrives on
 * `DeviceSnapshot`, so there is nothing to add to the ingest path — see
 * `packages/fleet-core/src/enums.ts` for the raw `controlModeMap` / `taskStatusMap`
 * these values come from. Framework-free like the rest of the package so both
 * frontends share one definition rather than each inventing its own.
 */
export type DeviceStatus =
  | "offline"
  | "estop"
  | "fault"
  | "teleop"
  | "charging"
  | "tasking"
  | "interrupted"
  | "standby";

/** Chinese labels for each 实时状态. */
export const deviceStatusLabels: Record<DeviceStatus, string> = {
  offline: "离线",
  estop: "急停",
  fault: "故障",
  teleop: "遥控",
  charging: "充电中",
  tasking: "任务中",
  interrupted: "异常中断",
  standby: "待命",
};

/**
 * Is a report code present and non-zero? Same finiteness guard as `deviceTone.ts`:
 * the field arrives as a number or a numeric string, `"0"` is truthy, and an absent
 * code (`Number(undefined)` → `NaN`) must not read as "set". Kept local rather than
 * shared so neither module reaches into the other's internals.
 */
const hasActiveCode = (code: unknown): boolean => {
  const value = Number(code);
  return Number.isFinite(value) && value !== 0;
};

/**
 * Resolve a device to its 实时状态, by priority — the first state that applies wins,
 * worst/most-overriding first:
 *
 *   离线 > 急停 > 故障 > 遥控 > 充电中 > 任务中 > 异常中断 > 待命
 *
 * Offline wins over everything for the same reason it wins for the tone: a vehicle we
 * have not heard from has stale telemetry, so its last `controlMode`/`taskStatus` are
 * not "current". 急停 and 遥控 come from `controlMode`; 充电中/任务中/异常中断 from
 * `taskStatus`; 故障 from an active error-channel code. Everything else is 待命.
 */
export const getDeviceStatus = (
  device: Pick<DeviceSnapshot, "online" | "taskStatus" | "errorCode"> & {
    vehicleInfo?: Pick<VehicleInfoState, "controlMode"> | null;
  },
): DeviceStatus => {
  if (!device.online) return "offline";
  const controlMode = device.vehicleInfo?.controlMode ?? null;
  if (controlMode === 3) return "estop";
  if (hasActiveCode(device.errorCode?.code)) return "fault";
  if (controlMode === 2) return "teleop";
  if (device.taskStatus === 4) return "charging";
  if (device.taskStatus === 1) return "tasking";
  if (device.taskStatus === 3) return "interrupted";
  return "standby";
};

/** The 实时状态 label for a device in one call. */
export const deviceStatusLabel = (
  device: Parameters<typeof getDeviceStatus>[0],
): string => deviceStatusLabels[getDeviceStatus(device)];
