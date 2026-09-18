/**
 * The report-code dictionary: what a number on screen actually means.
 *
 * Moved here from `@navfleet/fleet-core` in Phase 16C-2 for the same reason the alert rule
 * engine moved ([[alertRules]]): the backend has to layer a deployment's `codebook.json`
 * over the built-in table and **下发 the merged result**, and the backend depends only on
 * `@navfleet/shared`, not on `fleet-core`. So the built-in data, the wire type, and the
 * pure merge/lookup live here; `fleet-core` keeps built-in-bound convenience wrappers so the
 * two frontends' existing call sites are unchanged.
 *
 * ## Where the model comes from
 *
 * - **VDA 5050** (the AGV ↔ fleet-manager standard) reports errors with an `errorLevel`,
 *   defined by **what the vehicle can still do** (continue its order? accept a new one?)
 *   rather than by how bad it feels, and separates `errorDescription` (causes) from
 *   `errorHint` (how to approach it). `impact` / `description` / `hint` are those three.
 * - **SAE J1939** splits a diagnostic code into SPN (*what* is wrong) and FMI (*how*). The
 *   four-digit numbers follow the same separation: channel, subsystem, then condition.
 *
 * ## The number scheme — `S B NN`
 *
 * | digit | meaning                                    |
 * | ----- | ------------------------------------------ |
 * | `S`   | channel: `1` info, `2` warning, `5` error  |
 * | `B`   | subsystem (see `CODE_SUBSYSTEMS`)          |
 * | `NN`  | the specific condition within that subsystem |
 *
 * ## What the built-in table is and is not
 *
 * It is a **reference table shaped like a real one**, good enough to build and demonstrate
 * the console against — **not** authoritative for any fleet. The public repo may reproduce
 * only VDA 5050's public `errorType` enum verbatim; everything else is original prose
 * modelled on public fault categories, so this is a real *shape*, not real *content*. Real
 * code values come from each deployment's vehicle firmware — hence `codebook.json`, which a
 * deployment layers over this table (`mergeCodebook`), overriding a built-in code or adding
 * its own. An unknown code is always reported *as unknown*, never guessed at.
 */

import type { CodeState } from "./index";

/** Which channel a code is expected to arrive in. */
export type CodeChannel = "info" | "warning" | "error";

/**
 * What the vehicle can still do — VDA 5050's error levels, plus `none` for codes that are
 * purely informational. A separate axis from `channel`: the channel is what the firmware
 * chose, the impact is what it means for the shift.
 */
export type CodeImpact =
  "none" | "watch" | "urgent" | "blocked" | "intervention";

export interface CodeImpactMeta {
  label: string;
  /** Stated as a capability, because that is what someone on shift can act on. */
  meaning: string;
}

export const CODE_IMPACTS: Record<CodeImpact, CodeImpactMeta> = {
  none: { label: "无影响", meaning: "仅供了解，不影响任务执行" },
  watch: {
    label: "留意",
    meaning: "无需立即处理，车辆可继续当前任务并接受新任务，可能自行恢复",
  },
  urgent: {
    label: "尽快处理",
    meaning: "需要立即关注，车辆仍可继续当前任务并接受新任务",
  },
  blocked: {
    label: "任务受阻",
    meaning: "需要立即处理，车辆无法继续当前任务，但仍可接受新任务",
  },
  intervention: {
    label: "需人工介入",
    meaning: "必须人工到场，车辆既不能继续当前任务，也无法接受新任务",
  },
};

export type CodeSubsystem =
  | "navigation"
  | "motion"
  | "power"
  | "perception"
  | "task"
  | "network"
  | "safety"
  | "payload";

export const CODE_SUBSYSTEMS: Record<CodeSubsystem, string> = {
  navigation: "导航与定位",
  motion: "运动与速度控制",
  power: "电源与电池",
  perception: "传感器与感知",
  task: "任务与调度",
  network: "通信与网络",
  safety: "安全与防撞",
  payload: "载荷与执行机构",
};

export interface ReportCodeEntry {
  code: number;
  channel: CodeChannel;
  subsystem: CodeSubsystem;
  /** Short enough for a table cell. */
  label: string;
  /** Causes — VDA 5050's `errorDescription`. */
  description: string;
  /** What to do about it — VDA 5050's `errorHint`. */
  hint: string;
  impact: CodeImpact;
}

// PLACEHOLDER_ENTRIES

/**
 * The built-in table. Ordered by number so a reader can scan it like a manual. The three
 * codes v1.0.0 already used (1101 / 2203 / 5102) keep their exact meanings; everything else
 * is modelled on the same conventions. Frozen: it is data, not scratch space. A deployment
 * overrides or extends it through `codebook.json` (`mergeCodebook`), never by editing this.
 */
export const DEFAULT_REPORT_CODES: readonly ReportCodeEntry[] = Object.freeze([
  // ── 1xxx 提示 ────────────────────────────────────────────────────────────────
  {
    code: 1101,
    channel: "info",
    subsystem: "navigation",
    label: "定位稳定",
    description: "融合定位与激光定位一致，位姿置信度处于正常区间",
    hint: "无需处理；这条通常用于确认车辆刚完成重定位",
    impact: "none",
  },
  {
    code: 1102,
    channel: "info",
    subsystem: "navigation",
    label: "已完成重定位",
    description:
      "车辆在当前场景内重新建立了位姿，通常发生在开机或短暂丢失定位之后",
    hint: "无需处理；若频繁出现，检查场景反光板或点云地图是否与现场一致",
    impact: "none",
  },
  {
    code: 1301,
    channel: "info",
    subsystem: "power",
    label: "正在充电",
    description: "车辆已连接充电桩并进入充电流程",
    hint: "无需处理；充电完成后车辆会自行退出并回到待命状态",
    impact: "none",
  },
  {
    code: 1501,
    channel: "info",
    subsystem: "task",
    label: "任务已完成",
    description: "当前任务的全部节点与动作均已执行完毕",
    hint: "无需处理；若车辆完成任务后长时间未接新单，检查调度侧的派发队列而不是车辆",
    impact: "none",
  },
  {
    code: 1601,
    channel: "info",
    subsystem: "network",
    label: "远程接管中",
    description: "操作员已接入并接管该车，自动驾驶暂停",
    hint: "无需处理；接管期间调度指令不会下发到该车",
    impact: "none",
  },
  // CHUNK_2
  // ── 2xxx 预警 ────────────────────────────────────────────────────────────────
  {
    code: 2101,
    channel: "warning",
    subsystem: "navigation",
    label: "定位置信度偏低",
    description:
      "融合定位与激光定位出现偏差，或环境特征不足（长直走廊、大面积空旷区域、反光板被遮挡）",
    hint: "可继续观察；若持续偏低，安排车辆经过特征丰富的区域重定位，并检查反光板是否被货物挡住",
    impact: "watch",
  },
  {
    code: 2203,
    channel: "warning",
    subsystem: "motion",
    label: "限速区降速",
    description: "车辆进入配置的限速区域，已按区域速度上限降速通行",
    hint: "无需处理；若该路段不应限速，检查场景配置里的限速区范围",
    impact: "watch",
  },
  {
    code: 2204,
    channel: "warning",
    subsystem: "motion",
    label: "轨迹跟踪偏差偏大",
    description:
      "实际轨迹与规划路径的横向偏差超过告警阈值，常见于地面湿滑、载荷偏心或轮径标定漂移",
    hint: "尽快安排检查：轮径标定、载荷摆放、路面状况；偏差继续增大会升级为任务受阻",
    impact: "urgent",
  },
  {
    code: 2301,
    channel: "warning",
    subsystem: "power",
    label: "电量偏低",
    description: "剩余电量低于调度阈值，尚可完成当前任务但不宜接受长距离任务",
    hint: "尽快安排返充；调度侧应停止向该车派发新的长距离任务",
    impact: "urgent",
  },
  {
    code: 2302,
    channel: "warning",
    subsystem: "power",
    label: "电池温度偏高",
    description: "电池组温度接近上限，可能由连续大电流放电或环境温度过高引起",
    hint: "尽快让车辆停在通风处降温；持续升高会触发保护性停车",
    impact: "urgent",
  },
  // CHUNK_3
  {
    code: 2401,
    channel: "warning",
    subsystem: "perception",
    label: "激光雷达受污",
    description: "激光雷达回波强度整体下降，通常是镜面积灰、结露或被薄膜遮挡",
    hint: "擦拭雷达视窗即可，多数情况下自行恢复；这类问题不影响当前任务",
    impact: "watch",
  },
  {
    code: 2601,
    channel: "warning",
    subsystem: "network",
    label: "通信质量下降",
    description: "无线链路丢包率或时延升高，车辆仍在线但状态上报可能出现间隔",
    hint: "留意该区域的 AP 覆盖；若集中在固定路段，属于覆盖盲区而非车辆问题",
    impact: "watch",
  },
  {
    code: 2801,
    channel: "warning",
    subsystem: "payload",
    label: "载荷偏心",
    description: "载荷重心偏离托盘中心超过阈值，会加剧轨迹偏差与轮系磨损",
    hint: "尽快在下一个停靠点重新摆放载荷",
    impact: "urgent",
  },

  // ── 5xxx 告警 ────────────────────────────────────────────────────────────────
  {
    code: 5101,
    channel: "error",
    subsystem: "navigation",
    label: "定位丢失",
    description:
      "车辆无法在当前地图内确定位姿，位置数据不可信；多由环境剧变（货物摆放大幅改动）、地图与现场不一致或雷达故障引起",
    hint: "必须人工介入：确认车辆实际位置后手动重定位，并核对场景地图是否为最新；定位丢失期间车辆不会自行恢复行驶",
    impact: "intervention",
  },
  {
    code: 5102,
    channel: "error",
    subsystem: "navigation",
    label: "路径规划超时",
    description:
      "在规定时间内未能规划出可行路径，通常是目标点被占据、通道被临时堵塞，或可通行区域被地图标记为不可通行",
    hint: "检查目标点与沿途通道是否被占；清障后车辆可接受新任务，当前任务需重新派发",
    impact: "blocked",
  },
  // CHUNK_4
  {
    code: 5203,
    channel: "error",
    subsystem: "motion",
    label: "驱动器报错",
    description: "驱动器上报故障并切断输出，可能是过流、过温或编码器信号异常",
    hint: "必须人工介入：读取驱动器故障码后复位；不要在未查明原因前反复上电",
    impact: "intervention",
  },
  {
    code: 5301,
    channel: "error",
    subsystem: "power",
    label: "电量耗尽保护",
    description: "剩余电量低于保护阈值，车辆已停车以保护电池",
    hint: "必须人工介入：现场牵引或人工引导至充电桩",
    impact: "intervention",
  },
  {
    code: 5401,
    channel: "error",
    subsystem: "perception",
    label: "激光雷达无数据",
    description: "在超时时间内未收到雷达点云，通常是供电、网口或雷达自身故障",
    hint: "必须人工介入：检查雷达供电与网线；无点云时车辆不具备避障能力，不应恢复自动行驶",
    impact: "intervention",
  },
  {
    code: 5501,
    channel: "error",
    subsystem: "task",
    label: "任务执行失败",
    description:
      "动作未能完成（例如取货位没有货物、放货位已被占用），任务无法继续",
    hint: "确认现场后重新派发任务；车辆本身可用，仍可接受新任务",
    impact: "blocked",
  },
  {
    code: 5701,
    channel: "error",
    subsystem: "safety",
    label: "急停触发",
    description:
      "安全回路被触发：可能是急停按钮被按下、安全触边受压，或安全雷达检测到近距离障碍",
    hint: "必须人工介入：排除触发原因后在车上手动复位安全回路",
    impact: "intervention",
  },
  {
    code: 5702,
    channel: "error",
    subsystem: "safety",
    label: "防撞保护停车",
    description: "安全雷达在保护区内持续检测到障碍物，车辆已减速至停止并保持",
    hint: "移走障碍物后车辆可自行恢复；若无可见障碍，检查安全雷达是否受污或标定漂移",
    impact: "blocked",
  },
]);

export interface DescribedCode {
  code: number;
  /** True when the codebook had no entry — the console must say so. */
  unknown: boolean;
  label: string;
  description: string;
  hint: string;
  impact: CodeImpact;
  subsystem: CodeSubsystem | null;
  /** The `info` string the device sent, when it sent one. */
  reported: string;
  /** When the device reported this code, straight off `CodeState.stamp`; `null` if none. */
  stamp: string | null;
}

/** Build a `code → entry` lookup once, so `describeCodeWith` is O(1) per call. */
export const buildCodebookIndex = (
  entries: readonly ReportCodeEntry[],
): Map<number, ReportCodeEntry> =>
  new Map(entries.map((entry) => [entry.code, entry]));

/** The built-in table as a lookup, for the frontends' built-in-bound wrappers. */
export const DEFAULT_CODEBOOK_INDEX = buildCodebookIndex(DEFAULT_REPORT_CODES);

/** What a code means in this codebook, or `null` when it does not know / there is no code. */
export const lookupCode = (
  index: ReadonlyMap<number, ReportCodeEntry>,
  code: unknown,
): ReportCodeEntry | null => {
  const numeric = Number(code);
  if (!Number.isFinite(numeric) || numeric === 0) return null;
  return index.get(numeric) ?? null;
};

/**
 * A code plus whatever the device said about it, resolved against a codebook into one
 * displayable thing. The unknown branch is the one that matters: reported *as unknown*, with
 * the raw number and the device's own string, never guessed at — the honest state for most
 * deployments until their own 码表 is loaded.
 */
export const describeCodeWith = (
  index: ReadonlyMap<number, ReportCodeEntry>,
  state: CodeState | null | undefined,
): DescribedCode | null => {
  const numeric = Number(state?.code);
  if (!Number.isFinite(numeric) || numeric === 0) return null;

  const reported = typeof state?.info === "string" ? state.info : "";
  const stamp = typeof state?.stamp === "string" ? state.stamp : null;
  const entry = index.get(numeric);

  if (!entry) {
    return {
      code: numeric,
      unknown: true,
      label: reported || `未知报码 ${numeric}`,
      description: "该报码不在当前字典中，含义需查阅车辆固件文档",
      hint: "把这条报码补进部署侧码表后，此处会显示它的含义与处理建议",
      impact: "watch",
      subsystem: null,
      reported,
      stamp,
    };
  }

  return {
    code: entry.code,
    unknown: false,
    label: entry.label,
    description: entry.description,
    hint: entry.hint,
    impact: entry.impact,
    subsystem: entry.subsystem,
    reported,
    stamp,
  };
};

/** The three channels of one device, described against a codebook, worst-channel-first. */
export const describeDeviceCodesWith = (
  index: ReadonlyMap<number, ReportCodeEntry>,
  device:
    | Pick<
        { errorCode: CodeState; warningCode: CodeState; infoCode: CodeState },
        "errorCode" | "warningCode" | "infoCode"
      >
    | null
    | undefined,
): { channel: CodeChannel; described: DescribedCode }[] =>
  (
    [
      ["error", device?.errorCode],
      ["warning", device?.warningCode],
      ["info", device?.infoCode],
    ] as const
  )
    .map(([channel, state]) => {
      const described = describeCodeWith(index, state);
      return described ? { channel, described } : null;
    })
    .filter(
      (row): row is { channel: CodeChannel; described: DescribedCode } =>
        row !== null,
    );

const CHANNELS: readonly CodeChannel[] = ["info", "warning", "error"];
const CHANNEL_DIGIT: Record<CodeChannel, string> = {
  info: "1",
  warning: "2",
  error: "5",
};

/**
 * Validate a deployment's (untrusted) `codebook.json` into well-formed entries. A JSON array
 * of entries; every field is checked and the "no duplicate code" discipline is enforced, so
 * a malformed file is a load failure (old snapshot kept) rather than a silent bad table.
 * Throws with a labelled message. Does **not** enforce the `S B NN` digit scheme — a
 * deployment's real code values need not follow the built-in table's numbering convention.
 */
export const parseCodebook = (raw: unknown): ReportCodeEntry[] => {
  if (!Array.isArray(raw)) {
    throw new Error("codebook must be a JSON array of entries");
  }
  const seen = new Set<number>();
  return raw.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`codebook[${index}] must be a JSON object`);
    }
    const entry = value as Record<string, unknown>;
    const code = entry.code;
    if (typeof code !== "number" || !Number.isInteger(code) || code <= 0) {
      throw new Error(`codebook[${index}].code must be a positive integer`);
    }
    if (seen.has(code)) {
      throw new Error(`codebook has a duplicate code: ${code}`);
    }
    seen.add(code);
    if (
      entry.channel !== "info" &&
      entry.channel !== "warning" &&
      entry.channel !== "error"
    ) {
      throw new Error(
        `codebook[${index}].channel must be info/warning/error (code ${code})`,
      );
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        CODE_SUBSYSTEMS,
        entry.subsystem as string,
      )
    ) {
      throw new Error(
        `codebook[${index}].subsystem is not a known subsystem (code ${code})`,
      );
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        CODE_IMPACTS,
        entry.impact as string,
      )
    ) {
      throw new Error(
        `codebook[${index}].impact is not a known impact (code ${code})`,
      );
    }
    const text = (field: string): string => {
      const found = entry[field];
      if (typeof found !== "string" || found.trim() === "") {
        throw new Error(
          `codebook[${index}].${field} must be a non-empty string (code ${code})`,
        );
      }
      return found;
    };
    return {
      code,
      channel: entry.channel,
      subsystem: entry.subsystem as CodeSubsystem,
      label: text("label"),
      description: text("description"),
      hint: text("hint"),
      impact: entry.impact as CodeImpact,
    };
  });
};

/**
 * Layer a deployment's entries over the built-in base: an override with the same `code`
 * replaces the built-in one, a new `code` is added. Returned sorted by code so the merged
 * table the backend 下发s reads like a manual, whichever order the file listed things in.
 */
export const mergeCodebook = (
  base: readonly ReportCodeEntry[],
  overrides: readonly ReportCodeEntry[],
): ReportCodeEntry[] => {
  const byCode = new Map<number, ReportCodeEntry>(
    base.map((entry) => [entry.code, entry]),
  );
  for (const entry of overrides) {
    byCode.set(entry.code, entry);
  }
  return [...byCode.values()].sort((left, right) => left.code - right.code);
};

/** The `S B NN` digit that a channel must start with — exported for the table's own tests. */
export const channelDigit = (channel: CodeChannel): string =>
  CHANNEL_DIGIT[channel];

/** The channels, worst-last, for callers that iterate them. */
export const CODE_CHANNELS = CHANNELS;
