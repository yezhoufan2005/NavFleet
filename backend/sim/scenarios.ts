/**
 * Drills: rare, fleet-wide situations an operator rehearses, staged on the live timeline on demand.
 *
 * The everyday timeline only produces what a site produces on an ordinary day; a fleet-wide e-stop
 * or a wireless outage across a whole scene happen a few times a year. These are what the console's
 * extremes are for — the 99+ on the 消息 badge, a vehicle with more messages than its card shows,
 * the toast that collapses a burst of transitions — so a drill puts each on screen when asked,
 * named for what it is, and ends on its own (every injection has a duration).
 *
 *   sim scenario                       list the drills
 *   sim scenario <name> [target]       stage one (target: a vehicle or a scene, where it takes one)
 *
 * A drill is a set of injections (`main.ts inject`) the live publisher applies at its next second;
 * from then on it is part of the timeline like any other event.
 */
import type { Fleet } from "./fleet";
import type { InjectionKind } from "./vehicle";

export interface ScenarioStep {
  deviceId: string;
  kind: InjectionKind;
  minutes: number;
}

export interface Scenario {
  name: string;
  title: string;
  /** What happens, and what the console should show — printed when the drill is staged. */
  description: string;
  /** What `target` names, when the drill takes one, and its default. */
  target?: { what: "vehicle" | "scene"; default: string };
  steps: (fleet: Fleet, target: string) => ScenarioStep[];
}

/**
 * The site's own vehicles the timeline runs: not the spare in storage (not simulated), and not a
 * visiting vendor vehicle, which is not wired into the site's safety loop.
 */
const running = (fleet: Fleet): string[] =>
  fleet.sites.filter((site) => !site.visitor).map((site) => site.deviceId);

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "fire-drill",
    title: "消防联动演练",
    description:
      "消防系统联动断开园区安全回路：所有车辆急停（5701），控制器在告警列表里报「安全回路断开」；调度台对每台车发起远程接管准备（1601），大量重连挤占无线（2601）。每台车同时 4 条消息，全车队超过 99 条，导航栏消息徽标显示 99+。10 分钟后演练结束，复位后各车自行恢复。",
    steps: (fleet) =>
      running(fleet).flatMap((deviceId) => [
        { deviceId, kind: "safety-loop" as const, minutes: 10 },
        { deviceId, kind: "teleop" as const, minutes: 10 },
        { deviceId, kind: "comm-degraded" as const, minutes: 8 },
      ]),
  },
  {
    name: "cascade",
    title: "连锁故障演练",
    description:
      "一台牵引车连续出问题：电量见底（低电量）、驱动器过热（告警列表）、载荷偏移（2802）、避障等待超时（5703）、操作员远程接管（1601），厂商控制器另报电池通讯中断。同一台车同时 6 条消息，设备列表卡片只列 3 条并显示「另有 3 条」。约 10 分钟后逐条恢复。",
    target: { what: "vehicle", default: "agv-y02" },
    steps: (_fleet, deviceId) => [
      { deviceId, kind: "low-battery", minutes: 0 },
      { deviceId, kind: "vendor-alarm", minutes: 12 },
      { deviceId, kind: "payload", minutes: 8 },
      { deviceId, kind: "obstacle", minutes: 6 },
      { deviceId, kind: "teleop", minutes: 10 },
      { deviceId, kind: "bms-comm", minutes: 9 },
    ],
  },
  {
    name: "ap-restart",
    title: "无线 AP 重启",
    description:
      "一个场景的无线 AP 重启：场景内所有车辆同时失联，45 秒后同一秒判离线，2 分钟后同时恢复。几秒内的状态变化超过 4 条，控制台把逐条提示合并成一条「车队状态密集变化」；每台车留下一条离线消息与外发记录。",
    target: { what: "scene", default: "kangcheng-airy" },
    steps: (fleet, sceneId) =>
      fleet.sites
        .filter((site) => site.sceneId === sceneId && !site.visitor)
        .map((site) => ({ deviceId: site.deviceId, kind: "comm-loss" as const, minutes: 2 })),
  },
  {
    name: "estop",
    title: "单车急停",
    description:
      "一台车急停 5 分钟：新的告警级消息进来时，已经打开的控制台响一次告警提示音（需先在页面上点击一次以解锁音频），并按外发规则推送。",
    target: { what: "vehicle", default: "agv-w05" },
    steps: (_fleet, deviceId) => [{ deviceId, kind: "estop", minutes: 5 }],
  },
];

export const findScenario = (name: string): Scenario | undefined =>
  SCENARIOS.find((scenario) => scenario.name === name);
