import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALERT_RULES,
  applyRuleDebounce,
  buildOfflineAlert,
  deviceMatchesScope,
  evaluateRuleAlerts,
  offlineAlertId,
  type AlertRulesConfig,
  type DeviceAlert,
} from "@navfleet/shared";
import { createDefaultDevice } from "../src/fleetNormalize";

/**
 * The rule engine, now the single source both this package and the backend reach
 * (Phase 16C-1). These cover the pure evaluator's branches directly; the backend's
 * `config-registry.test.ts` covers loading a deployment's `rules.json` over the defaults,
 * and `normalize`/`fleetNormalize` tests cover the two normalisers calling in.
 */
const deviceWith = (
  overrides: Partial<ReturnType<typeof createDefaultDevice>> = {},
): ReturnType<typeof createDefaultDevice> => ({
  ...createDefaultDevice("agv-1"),
  stamp: "2026-09-18T00:00:00.000Z",
  ...overrides,
});

const socDevice = (soc: number | null) =>
  deviceWith({
    vehicleInfo: {
      controlMode: null,
      gear: null,
      speed: null,
      omega: null,
      soc,
    },
  });

describe("evaluateRuleAlerts — low battery", () => {
  it("fires below the default threshold and renders an integral reading without a decimal", () => {
    const alerts = evaluateRuleAlerts(socDevice(15));
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    expect(alert).toMatchObject({
      id: "agv-1-low-soc",
      severity: "warning",
      source: "rule-engine",
      title: "低电量预警",
    });
    // The drift the shared engine was built to end: `round`, not `toFixed(1)`, so 15 is
    // "15%", not "15.0%".
    expect(alert.detail).toBe("当前电量 15%，建议尽快安排回充");
  });

  it("rounds a fractional reading to one decimal", () => {
    expect(evaluateRuleAlerts(socDevice(15.26))[0]?.detail).toBe(
      "当前电量 15.3%，建议尽快安排回充",
    );
  });

  it("does not fire at, above, or at the boundary of the threshold", () => {
    expect(evaluateRuleAlerts(socDevice(20))).toHaveLength(0);
    expect(evaluateRuleAlerts(socDevice(55))).toHaveLength(0);
  });

  it("treats a flat/absent reading as nothing to report, not a 0% alert", () => {
    expect(evaluateRuleAlerts(socDevice(0))).toHaveLength(0);
    expect(evaluateRuleAlerts(socDevice(null))).toHaveLength(0);
  });

  it("honours a retuned threshold", () => {
    const rules: AlertRulesConfig = {
      ...DEFAULT_ALERT_RULES,
      lowBattery: { enabled: true, thresholdPct: 50 },
    };
    expect(evaluateRuleAlerts(socDevice(30), rules)).toHaveLength(1);
    expect(evaluateRuleAlerts(socDevice(60), rules)).toHaveLength(0);
  });

  it("emits nothing when the rule is disabled", () => {
    const rules: AlertRulesConfig = {
      ...DEFAULT_ALERT_RULES,
      lowBattery: { enabled: false, thresholdPct: 20 },
    };
    expect(evaluateRuleAlerts(socDevice(10), rules)).toHaveLength(0);
  });
});

describe("evaluateRuleAlerts — offline", () => {
  it("raises the offline alert for an offline device and nothing for an online one", () => {
    expect(evaluateRuleAlerts(deviceWith({ online: false }))).toEqual([
      buildOfflineAlert("agv-1", "2026-09-18T00:00:00.000Z"),
    ]);
    expect(evaluateRuleAlerts(deviceWith({ online: true }))).toHaveLength(0);
  });

  it("emits nothing when the offline rule is disabled", () => {
    const rules: AlertRulesConfig = {
      ...DEFAULT_ALERT_RULES,
      offline: { enabled: false },
    };
    expect(
      evaluateRuleAlerts(deviceWith({ online: false }), rules),
    ).toHaveLength(0);
  });
});

describe("evaluateRuleAlerts — scope", () => {
  const lowDevice = socDevice(10);

  it("does not fire for a device outside the rule's scope", () => {
    const rules: AlertRulesConfig = {
      ...DEFAULT_ALERT_RULES,
      lowBattery: {
        enabled: true,
        thresholdPct: 20,
        scope: { deviceIds: ["other"] },
      },
    };
    expect(evaluateRuleAlerts(lowDevice, rules)).toHaveLength(0);
  });

  it("fires for a device the scope names", () => {
    const rules: AlertRulesConfig = {
      ...DEFAULT_ALERT_RULES,
      lowBattery: {
        enabled: true,
        thresholdPct: 20,
        scope: { deviceIds: ["agv-1"] },
      },
    };
    expect(evaluateRuleAlerts(lowDevice, rules)).toHaveLength(1);
  });
});

describe("deviceMatchesScope", () => {
  const device = deviceWith({
    formationIds: ["team-a"],
    tags: ["cold-storage"],
  });

  it("matches everything when the scope is absent or empty", () => {
    expect(deviceMatchesScope(device)).toBe(true);
    expect(deviceMatchesScope(device, {})).toBe(true);
    expect(
      deviceMatchesScope(device, { deviceIds: [], formationIds: [], tags: [] }),
    ).toBe(true);
  });

  it("matches on any single listed dimension (union, not intersection)", () => {
    expect(deviceMatchesScope(device, { deviceIds: ["agv-1"] })).toBe(true);
    expect(deviceMatchesScope(device, { formationIds: ["team-a"] })).toBe(true);
    expect(deviceMatchesScope(device, { tags: ["cold-storage"] })).toBe(true);
    expect(
      deviceMatchesScope(device, {
        deviceIds: ["nope"],
        tags: ["cold-storage"],
      }),
    ).toBe(true);
  });

  it("does not match when nothing listed applies", () => {
    expect(
      deviceMatchesScope(device, {
        deviceIds: ["nope"],
        formationIds: ["team-z"],
        tags: ["hot"],
      }),
    ).toBe(false);
  });
});

describe("applyRuleDebounce", () => {
  const lowSocAt = (iso: string): DeviceAlert => ({
    id: "agv-1-low-soc",
    title: "低电量预警",
    detail: "当前电量 10%，建议尽快安排回充",
    severity: "warning",
    source: "rule-engine",
    ts: iso,
    active: true,
  });
  const rulesWithDebounce = (debounceSeconds: number): AlertRulesConfig => ({
    ...DEFAULT_ALERT_RULES,
    lowBattery: { enabled: true, thresholdPct: 20, debounceSeconds },
  });
  const nowMs = Date.parse("2026-09-18T00:01:00.000Z");

  it("is a no-op when debounce is off (the default)", () => {
    const previous = [lowSocAt("2026-09-18T00:00:59.000Z")];
    expect(
      applyRuleDebounce("agv-1", previous, [], DEFAULT_ALERT_RULES, nowMs),
    ).toEqual([]);
  });

  it("leaves a still-firing alert untouched", () => {
    const current = [lowSocAt("2026-09-18T00:01:00.000Z")];
    expect(
      applyRuleDebounce(
        "agv-1",
        current,
        current,
        rulesWithDebounce(60),
        nowMs,
      ),
    ).toBe(current);
  });

  it("retains a just-cleared alert while inside the window", () => {
    const previous = [lowSocAt("2026-09-18T00:00:30.000Z")]; // 30s ago, window 60s
    const retained = applyRuleDebounce(
      "agv-1",
      previous,
      [],
      rulesWithDebounce(60),
      nowMs,
    );
    expect(retained).toHaveLength(1);
    expect(retained[0]?.id).toBe("agv-1-low-soc");
  });

  it("lets the alert clear once the window has lapsed", () => {
    const previous = [lowSocAt("2026-09-18T00:00:00.000Z")]; // 60s ago, window 30s
    expect(
      applyRuleDebounce("agv-1", previous, [], rulesWithDebounce(30), nowMs),
    ).toEqual([]);
  });

  it("does nothing when there was no previous alert to retain", () => {
    expect(
      applyRuleDebounce("agv-1", [], [], rulesWithDebounce(60), nowMs),
    ).toEqual([]);
  });
});

describe("offline alert helpers", () => {
  it("keys the alert on the stable per-device id acknowledgement uses", () => {
    expect(offlineAlertId("agv-7")).toBe("agv-7-offline");
    expect(buildOfflineAlert("agv-7", "2026-09-18T00:00:00.000Z")).toEqual({
      id: "agv-7-offline",
      title: "设备离线",
      detail: "设备超过离线阈值未上报，系统已自动标记为离线",
      severity: "critical",
      source: "rule-engine",
      ts: "2026-09-18T00:00:00.000Z",
      active: true,
    });
  });
});
