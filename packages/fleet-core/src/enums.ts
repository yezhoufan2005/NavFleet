/**
 * Enum label maps for vehicle telemetry fields.
 *
 * The detail panel would otherwise show raw numeric codes; these maps render
 * human-readable Chinese labels (with the raw code kept visible via formatEnum).
 */

export interface EnumEntry {
  label: string;
  description: string;
}

export type EnumMap = Record<string, EnumEntry>;

export const controlModeMap: EnumMap = {
  "0": { label: "待命 / 人工", description: "当前未进入自动控制" },
  "1": { label: "自动驾驶", description: "车辆由控制器自动接管" },
  "2": { label: "遥控接管", description: "当前处于远程接管状态" },
  "3": { label: "紧急停止", description: "控制器触发了安全保护" },
};

export const gearMap: EnumMap = {
  "-1": { label: "R", description: "倒挡" },
  "0": { label: "N", description: "空挡 / 未知" },
  "1": { label: "D", description: "前进挡" },
  "2": { label: "P", description: "驻车挡" },
};

export const taskStatusMap: EnumMap = {
  "0": { label: "空闲", description: "当前没有正在执行的任务" },
  "1": { label: "执行中", description: "任务正在正常推进" },
  "2": { label: "已完成", description: "任务已完成，等待下一次调度" },
  "3": { label: "异常中断", description: "任务被错误或告警中断" },
  "4": { label: "充电中", description: "设备正在补能或等待补能" },
};

/**
 * Resolve an enum value to its label, appending the raw code (e.g. "自动驾驶 (1)")
 * so the underlying value stays visible. Returns "--" for empty input and the
 * bare value for codes not present in the map.
 */
export function formatEnum(
  value: number | string | null | undefined,
  map: EnumMap,
): string {
  if (value === null || value === undefined || value === "") {
    return "--";
  }
  const key = String(value);
  const entry = map[key];
  return entry ? `${entry.label} (${key})` : key;
}

/** The description for an enum value, suitable for a `title` tooltip. */
export function describeEnum(
  value: number | string | null | undefined,
  map: EnumMap,
): string | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  return map[String(value)]?.description;
}
