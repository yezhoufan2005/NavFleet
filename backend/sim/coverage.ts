/**
 * Coverage: run the timeline offline over the last N days and report which of the states the
 * console can show it actually reaches — every report code (built-in, deployment, unknown), every
 * value of the enums the console labels, every field a vendor may leave out, the platform's own
 * rules, the personas. What the everyday timeline cannot reach by design (a fleet-wide e-stop, 99+
 * active messages) is listed with the drill that stages it.
 *
 *   sim coverage [days]     exit 1 when something the timeline should reach did not appear
 *
 * Frames are built once a minute, which is plenty to see every value; the state machine still steps
 * every second (codes and alarms are counted from the state, at their onset), so what is measured
 * is the real timeline.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_REPORT_CODES, mergeCodebook, parseCodebook } from "@navfleet/shared";
import { loadFleet, newState } from "./fleet";
import { FIRMWARE_CODES, VENDOR_ALARMS } from "./profiles";
import { step, type ActiveCode } from "./vehicle";

export interface CoverageItem {
  group: string;
  label: string;
  count: number;
  /** Where to see it when the timeline itself does not produce it. */
  via?: string;
}

export interface CoverageReport {
  days: number;
  items: CoverageItem[];
  missing: CoverageItem[];
}

/** States the everyday timeline never reaches on purpose, and the drill that stages each. */
const STAGED: readonly CoverageItem[] = [
  {
    group: "极端情况",
    label: "全车队活跃消息 > 99（导航徽标 99+）",
    count: 0,
    via: "sim scenario fire-drill",
  },
  { group: "极端情况", label: "单车活跃消息 ≥ 6", count: 0, via: "sim scenario cascade" },
  {
    group: "极端情况",
    label: "同一场景整体失联（状态变化合并提示）",
    count: 0,
    via: "sim scenario ap-restart",
  },
];

type Counter = Map<string, number>;
const bump = (counter: Counter, key: string, by = 1): void => {
  counter.set(key, (counter.get(key) ?? 0) + by);
};

export const measureCoverage = async (
  configRoot: string,
  days: number,
): Promise<CoverageReport> => {
  const fleet = await loadFleet(configRoot);
  const shipped = parseCodebook(
    JSON.parse(fs.readFileSync(path.join(configRoot, "codebook.json"), "utf8")),
  );
  const dictionary = mergeCodebook(DEFAULT_REPORT_CODES, shipped);
  const rules = JSON.parse(fs.readFileSync(path.join(configRoot, "rules.json"), "utf8")) as {
    lowBattery: { thresholdPct: number };
  };
  const end = Math.floor(Date.now() / 1000) * 1000;
  const start = end - days * 86_400_000;

  const codes: Counter = new Map();
  const alarms: Counter = new Map();
  const enums: Counter = new Map();
  const omitted: Counter = new Map();
  const behaviour: Counter = new Map();
  let perVehicleMax = 0;

  const states = fleet.sites.map((site) =>
    newState(
      fleet,
      site,
      Math.max(start, Math.floor((fleet.commissioned.get(site.deviceId) ?? 0) / 1000) * 1000),
    ),
  );
  const seen = states.map(() => ({
    since: new Map<string, number>(),
    online: true,
    away: false,
    lowBattery: false,
  }));

  for (let t = start; t < end; t += 1000) {
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index]!;
      const site = fleet.sites[index]!;
      const track = seen[index]!;
      if (state.t !== t) continue;
      // A frame a minute, and every second while a buffering gateway may flush a late one.
      const withFrame =
        t % 60_000 === 0 || (!!site.persona.lateFrames && state.warning?.code === 2601);
      const result = step(site, state, [], withFrame);
      for (const slot of [state.info, state.warning, state.error] as Array<ActiveCode | null>) {
        if (!slot) continue;
        const key = `code:${slot.code}`;
        if (track.since.get(key) !== slot.since) {
          track.since.set(key, slot.since);
          bump(codes, String(slot.code));
        }
      }
      for (const alarm of state.alarms ?? []) {
        const key = `alarm:${alarm.code}`;
        if (track.since.get(key) !== alarm.since) {
          track.since.set(key, alarm.since);
          bump(alarms, String(alarm.code));
        }
      }
      if (track.online && !state.online) bump(behaviour, "离线");
      track.online = state.online;
      if (!track.away && state.away) bump(behaviour, "跨场景夜巡");
      track.away = !!state.away;
      const low = state.soc < rules.lowBattery.thresholdPct && state.online;
      if (low && !track.lowBattery) bump(behaviour, "低电量（规则）");
      track.lowBattery = low;
      if (result.lateFrame) bump(behaviour, "乱序补发帧");
      if (state.phase === "maintenance") bump(behaviour, "计划维护（秒）");
      const active =
        (state.online ? 0 : 1) +
        [state.info, state.warning, state.error].filter(Boolean).length +
        (state.alarms?.length ?? 0) +
        (low ? 1 : 0);
      perVehicleMax = Math.max(perVehicleMax, active);
      if (active >= 4) bump(behaviour, "单车同时 ≥ 4 条消息（秒）");

      const frame = result.frame;
      if (!frame) continue;
      const info = (frame.vehicle_info ?? {}) as Record<string, unknown>;
      if ("control_mode" in info) bump(enums, `控制模式 ${String(info.control_mode)}`);
      if ("gear" in info) bump(enums, `挡位 ${String(info.gear)}`);
      bump(enums, `车端任务状态 ${String(frame.task_status)}`);
      bump(enums, `平台任务状态 ${String(frame.platform_task_status)}`);
      const limit = frame.speed_limit as { module_name?: string } | undefined;
      if (limit?.module_name) bump(enums, `限速来源 ${limit.module_name}`);
      const task = frame.task as Record<string, unknown> | null | undefined;
      bump(
        enums,
        task ? `任务类型 ${typeof task.type === "string" ? task.type : "（未报）"}` : "任务 无",
      );
      if (
        task &&
        typeof task.step === "number" &&
        typeof task.steps === "number" &&
        task.step > task.steps
      ) {
        bump(omitted, "任务步数越界");
      }
      if (task && !("steps" in task)) bump(omitted, "任务只报部分字段");
      if (!("omega" in info) && "vehicle_info" in frame) bump(omitted, "不报角速度");
      if (!("gear" in info) && "vehicle_info" in frame) bump(omitted, "不报挡位");
      if (!("vehicle_info" in frame)) bump(omitted, "不报车辆状态（调试车）");
      if (!("speed_limit" in frame)) bump(omitted, "不报限速");
      if (!("fusion_loc" in frame) && "lidar_loc" in frame) bump(omitted, "只报激光位姿");
      if (!("fusion_loc" in frame) && !("lidar_loc" in frame)) bump(omitted, "无场景位姿");
      const fusion = frame.fusion_loc as Record<string, unknown> | undefined;
      if (fusion && !("yaw" in fusion)) bump(omitted, "位姿不带朝向");
      const gps = frame.gps as Record<string, unknown> | undefined;
      if (gps && !("heading" in gps)) bump(omitted, "GPS 无航向");
      if (frame.scene_id === "") bump(omitted, "不配场景");
      if (Array.isArray(frame.alarmList)) bump(omitted, "带厂商告警列表");
      if ((frame.stamp as number) - t > 60_000) bump(behaviour, "车端时钟偏差");
      if (site.visitor) bump(behaviour, "未登记车辆上报");
    }
  }

  const items: CoverageItem[] = [];
  const known = new Set(dictionary.map((entry) => entry.code));
  const builtIn = new Set(DEFAULT_REPORT_CODES.map((entry) => entry.code));
  // Built-in codes, then the deployment's own (a code the deployment re-labels counts as built-in).
  for (const own of [false, true]) {
    for (const entry of dictionary) {
      if (builtIn.has(entry.code) === own) continue;
      items.push({
        group: own ? "报码（部署码表）" : "报码（内置）",
        label: `${entry.code} ${entry.label}`,
        count: codes.get(String(entry.code)) ?? 0,
      });
    }
  }
  for (const entry of FIRMWARE_CODES) {
    if (known.has(entry.code)) continue;
    items.push({
      group: "报码（字典外）",
      label: String(entry.code),
      count: codes.get(String(entry.code)) ?? 0,
    });
  }
  for (const alarm of VENDOR_ALARMS) {
    const staged = alarm.code === 51001;
    items.push({
      group: "厂商告警列表",
      label: `${alarm.code} ${alarm.title}（${alarm.level}）`,
      count: alarms.get(String(alarm.code)) ?? 0,
      ...(staged ? { via: "sim scenario fire-drill" } : {}),
    });
  }
  const enumValues = [
    ...["0", "1", "2", "3"].map((value) => `控制模式 ${value}`),
    ...["-1", "0", "1", "2"].map((value) => `挡位 ${value}`),
    ...["0", "1", "2", "3", "4"].map((value) => `车端任务状态 ${value}`),
    ...["0", "1", "2", "3", "4"].map((value) => `平台任务状态 ${value}`),
    ...["dispatcher", "safety", "navigation", "bms", "teleop"].map((value) => `限速来源 ${value}`),
    ...["巡检", "搬运", "牵引", "配料", "充电", "（未报）"].map((value) => `任务类型 ${value}`),
    "任务 无",
  ];
  for (const label of enumValues)
    items.push({ group: "枚举取值", label, count: enums.get(label) ?? 0 });
  for (const label of [
    "不报角速度",
    "不报挡位",
    "不报限速",
    "只报激光位姿",
    "无场景位姿",
    "位姿不带朝向",
    "GPS 无航向",
    "不配场景",
    "不报车辆状态（调试车）",
    "任务只报部分字段",
    "任务步数越界",
    "带厂商告警列表",
  ]) {
    items.push({ group: "字段缺失与形态", label, count: omitted.get(label) ?? 0 });
  }
  for (const label of [
    "离线",
    "计划维护（秒）",
    "低电量（规则）",
    "乱序补发帧",
    "车端时钟偏差",
    "跨场景夜巡",
    "未登记车辆上报",
    "单车同时 ≥ 4 条消息（秒）",
  ]) {
    items.push({ group: "行为与人设", label, count: behaviour.get(label) ?? 0 });
  }
  items.push({ group: "行为与人设", label: "单车同时最多消息数", count: perVehicleMax });
  items.push(...STAGED);
  const missing = items.filter((item) => item.count === 0 && !item.via);
  return { days, items, missing };
};

export const formatCoverage = (report: CoverageReport): string => {
  const lines: string[] = [`演示时间线覆盖（最近 ${report.days} 天）`];
  let group = "";
  for (const item of report.items) {
    if (item.group !== group) {
      group = item.group;
      lines.push("", `【${group}】`);
    }
    const mark = item.count > 0 ? "✓" : item.via ? "·" : "✗";
    const tail = item.count > 0 ? String(item.count) : item.via ? `演练：${item.via}` : "未出现";
    lines.push(`  ${mark} ${item.label}  ${tail}`);
  }
  const reached = report.items.filter((item) => item.count > 0).length;
  lines.push(
    "",
    `出现 ${reached} 项，由演练给出 ${report.items.filter((item) => item.count === 0 && item.via).length} 项，未出现 ${report.missing.length} 项`,
  );
  return lines.join("\n");
};
