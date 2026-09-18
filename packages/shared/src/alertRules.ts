/**
 * The alert rule engine — the single source of truth, shared verbatim.
 *
 * It used to be written twice: once in `backend/src/normalize.ts` (the live ingest
 * normaliser) and once in `packages/fleet-core/src/fleetNormalize.ts` (the reader both
 * frontends compile in). The two are on opposite sides of a boundary — the backend does
 * not depend on `@navfleet/fleet-core` — so neither could import the other, and the low
 * battery threshold `20` lived as a literal on both sides. This module is the place they
 * *can* both reach: `@navfleet/shared` is the one package every consumer already depends
 * on, and it is DOM-free and framework-free, so a pure evaluator belongs here as much as
 * the `DeviceAlert` shape it returns does.
 *
 * The backend is the configurable authority: it loads `rules.json` and passes the merged
 * config in, so a deployment can retune thresholds / disable a rule / scope it to some
 * devices without a rebuild. The frontends call `evaluateRuleAlerts(device)` with the
 * built-in defaults — they cannot see backend config, and they do not need to: they keep
 * the `alerts` array the backend already put on every snapshot, and only fall back to
 * deriving from defaults for a frame that arrives without one. So a retuned threshold
 * changes what the backend emits, and the frontends display exactly that.
 */

import type { DeviceAlert, DeviceSnapshot } from "./index";

/**
 * Which devices a rule applies to. An empty scope (no dimension listed) means **all
 * devices** — the common case, and the default. When any dimension is listed, a device is
 * in scope if it matches *any* listed value across *any* dimension (union, not
 * intersection): "these vehicles, plus everything in these formations, plus anything
 * tagged so." Matching nothing listed means out of scope.
 */
export interface RuleScope {
  deviceIds?: string[];
  formationIds?: string[];
  tags?: string[];
}

/** Common knobs every rule carries. */
interface RuleCommon {
  /** A disabled rule never fires, whatever the reading. */
  enabled: boolean;
  /** Devices this rule watches. Absent/empty = the whole fleet. */
  scope?: RuleScope;
  /**
   * Anti-flap window. After a rule stops firing for a device, the alert is retained for
   * this many seconds rather than cleared at once, so a reading hovering on the threshold
   * does not toggle the alert on and off frame by frame. `0` (the default for the battery
   * rule) means clear immediately. Honoured by the backend, which alone sees the timeline;
   * the pure evaluator below only answers "is it firing *now*".
   */
  debounceSeconds?: number;
}

export interface LowBatteryRuleConfig extends RuleCommon {
  /** Fire below this state-of-charge percentage. */
  thresholdPct: number;
}

export interface OfflineRuleConfig extends RuleCommon {
  /**
   * Seconds of silence before a device is marked offline. This *is* the offline rule's
   * anti-flap window (a device is not offline until it has been quiet this long), which is
   * why offline needs no separate `debounceSeconds`. Defaults to the backend's
   * `OFFLINE_AFTER_SECONDS` when the file omits it.
   */
  afterSeconds?: number;
}

export interface AlertRulesConfig {
  lowBattery: LowBatteryRuleConfig;
  offline: OfflineRuleConfig;
}

/**
 * The built-in rules — exactly the behaviour that was hardcoded before this module: low
 * battery below 20%, offline on the flag. A deployment's `rules.json` is layered over
 * these, and the frontends use them unchanged.
 */
export const DEFAULT_ALERT_RULES: AlertRulesConfig = {
  lowBattery: { enabled: true, thresholdPct: 20, debounceSeconds: 0 },
  offline: { enabled: true },
};

/** The id every offline alert carries; acknowledgement and the offline sweep key on it. */
export const offlineAlertId = (deviceId: string): string =>
  `${deviceId}-offline`;

/**
 * The "device is offline" alert, in one place. Two callers raise it for the same reason at
 * different moments: the normaliser, for a snapshot that arrives already marked offline,
 * and the store's sweep, for a device that has stopped reporting. Only the timestamp
 * differs between them — hence the parameter.
 */
export const buildOfflineAlert = (
  deviceId: string,
  ts: string,
): DeviceAlert => ({
  id: offlineAlertId(deviceId),
  title: "设备离线",
  detail: "设备超过离线阈值未上报，系统已自动标记为离线",
  severity: "critical",
  source: "rule-engine",
  ts,
  active: true,
});

/** `round(15.0, 1)` is `15`, not `"15.0"` — the reason the detail text uses it (see below). */
const round = (value: number, precision = 2): number => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

/** Whether a rule with this scope watches this device. Empty scope = the whole fleet. */
export const deviceMatchesScope = (
  device: Pick<DeviceSnapshot, "deviceId" | "formationIds" | "tags">,
  scope?: RuleScope,
): boolean => {
  if (!scope) {
    return true;
  }
  const byDevice = scope.deviceIds ?? [];
  const byFormation = scope.formationIds ?? [];
  const byTag = scope.tags ?? [];
  if (byDevice.length === 0 && byFormation.length === 0 && byTag.length === 0) {
    return true;
  }
  return (
    byDevice.includes(device.deviceId) ||
    byFormation.some((id) => device.formationIds.includes(id)) ||
    byTag.some((tag) => device.tags.includes(tag))
  );
};

/**
 * The rule alerts firing for a device *right now*, given the rules. Pure: no clock, no
 * state, no debounce — the backend layers those on. Returns the same alerts, verbatim, the
 * two hand-written copies used to.
 */
export const evaluateRuleAlerts = (
  device: DeviceSnapshot,
  rules: AlertRulesConfig = DEFAULT_ALERT_RULES,
): DeviceAlert[] => {
  const alerts: DeviceAlert[] = [];

  const lowBattery = rules.lowBattery;
  if (lowBattery.enabled && deviceMatchesScope(device, lowBattery.scope)) {
    const soc = Number(device.vehicleInfo?.soc);
    if (Number.isFinite(soc) && soc > 0 && soc < lowBattery.thresholdPct) {
      alerts.push({
        id: `${device.deviceId}-low-soc`,
        title: "低电量预警",
        // `round`, not `toFixed(1)`: an integral reading must read "15%", not "15.0%".
        // The two former copies drifted on exactly this before they were unified.
        detail: `当前电量 ${round(soc, 1)}%，建议尽快安排回充`,
        severity: "warning",
        source: "rule-engine",
        ts: device.stamp,
        active: true,
      });
    }
  }

  const offline = rules.offline;
  if (
    offline.enabled &&
    deviceMatchesScope(device, offline.scope) &&
    !device.online
  ) {
    alerts.push(buildOfflineAlert(device.deviceId, device.stamp));
  }

  return alerts;
};

/**
 * Linger a debounced rule alert across the frame that would clear it, so a reading hovering
 * on the threshold does not toggle the alert on and off. Pure, so the caller supplies the
 * clock: the store passes the previous frame's alerts, this frame's freshly-evaluated ones,
 * and `Date.now()`. Only the low-battery rule carries `debounceSeconds` — the offline rule's
 * anti-flap is its `afterSeconds` silence window, applied before the alert is ever raised.
 *
 * An alert is retained only while it is within `debounceSeconds` of when it *last fired*
 * (its `ts`, which the evaluator refreshes each firing frame), so the linger is bounded and
 * a genuinely-recovered device clears once the window lapses. A retained alert stays active,
 * which is exactly right for history: no premature clear event is written.
 */
export const applyRuleDebounce = (
  deviceId: string,
  previousAlerts: readonly DeviceAlert[],
  currentAlerts: DeviceAlert[],
  rules: AlertRulesConfig,
  nowMs: number,
): DeviceAlert[] => {
  const debounceSeconds = rules.lowBattery.debounceSeconds ?? 0;
  if (debounceSeconds <= 0) {
    return currentAlerts;
  }
  const id = `${deviceId}-low-soc`;
  if (currentAlerts.some((alert) => alert.id === id)) {
    return currentAlerts;
  }
  const previous = previousAlerts.find((alert) => alert.id === id);
  if (!previous) {
    return currentAlerts;
  }
  const lastFiredMs = Date.parse(previous.ts);
  if (
    Number.isFinite(lastFiredMs) &&
    nowMs - lastFiredMs < debounceSeconds * 1000
  ) {
    return [...currentAlerts, previous];
  }
  return currentAlerts;
};
