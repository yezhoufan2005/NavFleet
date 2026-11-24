/**
 * 设备当前任务的只读内容（车端上报，平台只展示、不下发）。
 *
 * `taskStatus` / `platformTaskStatus` 只是两个状态枚举，说不出「在干什么」。车端在帧里附带一个
 * `task` 对象时，平台把它原样归一成这里的形状：任务编号、类型、起止位置、当前第几步共几步、步骤名、
 * 开始时间。**只读红线不变**：这是遥测，平台不据此调度、也不回写任何东西。
 *
 * 帧里 `task: null` 表示「当前没有任务」（清空）；帧里没有 `task` 键表示「这一帧没说」，沿用上一帧。
 */
export interface DeviceTask {
  id: string;
  /** 任务类型，车端给的文字（如 巡检 / 搬运 / 充电）。 */
  type: string;
  /** 起点、终点（站位名）；没有的一端为 null。 */
  from: string | null;
  to: string | null;
  /** 第几步（从 1 起）与共几步；车端不报时为 null。 */
  step: number | null;
  steps: number | null;
  stepName: string;
  /** 任务开始时间（ISO）；车端不报时为 null。 */
  startedAt: string | null;
}

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
const textOrNull = (value: unknown): string | null => text(value) || null;
const positiveInt = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0
    ? number
    : null;
};

/**
 * 帧（snake_case）或已归一快照（camelCase）里的 `task` → `DeviceTask`。
 *
 * - 键不在：返回 `fallback`（沿用上一帧）。
 * - `null`、非对象、或没有任务编号：返回 null（当前无任务）。
 * - `toIso` 把车端时间转成平台时间（后端用帧的校正时钟；前端读快照时原样转 ISO）。
 */
export const parseDeviceTask = (
  raw: UnknownRecord,
  fallback: DeviceTask | null | undefined,
  toIso: (value: unknown) => string | null,
): DeviceTask | null => {
  if (!("task" in raw)) return fallback ?? null;
  const task = raw.task;
  if (!isRecord(task)) return null;
  const id = text(task.id);
  if (!id) return null;
  const steps = positiveInt(task.steps);
  const step = positiveInt(task.step);
  const startedAt = task.started_at ?? task.startedAt;
  return {
    id,
    type: text(task.type),
    from: textOrNull(task.from),
    to: textOrNull(task.to),
    // A step past the total is a reporting slip; clamp it rather than show 「第 5 / 4 步」.
    step: step !== null && steps !== null ? Math.min(step, steps) : step,
    steps,
    stepName: text(task.step_name ?? task.stepName),
    startedAt:
      startedAt === undefined || startedAt === null ? null : toIso(startedAt),
  };
};

/** 「取货位 P03 → 卸货位 D07」；只有一端时只写那一端，两端都没有为空串。 */
export const formatTaskRoute = (task: DeviceTask): string =>
  task.from && task.to
    ? `${task.from} → ${task.to}`
    : (task.to ?? task.from ?? "");

/** 「第 2 / 4 步 · 装货」；没有步数时只写步骤名。 */
export const formatTaskStep = (task: DeviceTask): string => {
  const count =
    task.step !== null && task.steps !== null
      ? `第 ${task.step} / ${task.steps} 步`
      : "";
  return [count, task.stepName].filter(Boolean).join(" · ");
};
