import { describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES, type AlertRulesConfig } from "@navfleet/shared";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig, SocketEvent } from "../src/types";

/**
 * The offline sweep, a config reload and the paths that forget a device, on a manual clock.
 *
 * Silence used to be measured on the vehicle's own `stamp`, an out-of-scope vehicle was never
 * marked offline, the sweep wrote a duplicate telemetry frame, a reload left rule alerts on
 * silent vehicles, and eviction and a whole-fleet replace left active alerts behind.
 */

const FLEET_CONFIG: FleetConfig = {
  fleetName: "sweep-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

const START = Date.parse("2026-10-31T08:00:00.000Z");

class CountingPersistence {
  telemetryWrites = 0;
  readonly alertSyncs: Array<{ deviceId: string; ids: string[] }> = [];
  async connect(): Promise<void> {}
  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    return [];
  }
  async writeLatestSnapshot(): Promise<void> {}
  async writeTelemetry(): Promise<void> {
    this.telemetryWrites += 1;
  }
  async upsertAlerts(deviceId: string, alerts: Array<{ id: string }>): Promise<void> {
    this.alertSyncs.push({ deviceId, ids: alerts.map((alert) => alert.id) });
  }
  forgetDevice(): void {}
}

const harness = (rules: AlertRulesConfig = DEFAULT_ALERT_RULES, configured: string[] = []) => {
  const clock = { ms: START };
  const state = { rules };
  const persistence = new CountingPersistence();
  const registry = {
    async load(): Promise<void> {},
    getFleetConfig: (): FleetConfig => ({ ...FLEET_CONFIG }),
    getAlertRules: () => state.rules,
    applyDeviceConfig: (snapshot: DeviceSnapshot): DeviceSnapshot => snapshot,
    hasDeviceConfig: (deviceId: string): boolean => configured.includes(deviceId),
    listVehicleConfigs: () => configured.map((deviceId) => ({ deviceId })),
    listScenes: () => [],
    buildFormationSnapshots: () => [],
  };
  const store = new DashboardStore(
    persistence as unknown as Persistence,
    registry as unknown as ConfigRegistry,
    () => clock.ms,
  );
  const events: SocketEvent[] = [];
  store.on("event", (event: SocketEvent) => events.push(event));
  return { store, persistence, clock, state, events };
};

const frame = (deviceId: string, stampMs: number, soc = 80) => ({
  deviceId,
  stamp: new Date(stampMs).toISOString(),
  vehicle_info: { soc, speed: 0 },
});

const rulesWith = (offline: Partial<AlertRulesConfig["offline"]>): AlertRulesConfig => ({
  ...DEFAULT_ALERT_RULES,
  offline: { ...DEFAULT_ALERT_RULES.offline, afterSeconds: 90, ...offline },
});

describe("the offline sweep", () => {
  it("measures silence from arrival, not from the vehicle's slow clock", async () => {
    const { store, clock } = harness(rulesWith({}));
    // A clock 55 s slow, inside the tolerance, so its stamp is trusted.
    await store.applyPayload(frame("agv-slow", START - 55_000), "mqtt");
    clock.ms = START + 45_000;
    await store.evaluateOfflineDevices();
    expect(store.getDevice("agv-slow")?.online).toBe(true);

    clock.ms = START + 95_000;
    await store.evaluateOfflineDevices();
    expect(store.getDevice("agv-slow")?.online).toBe(false);
  });

  it("marks a silent vehicle offline even when the rule raises no alert for it", async () => {
    const { store, clock } = harness(rulesWith({ enabled: false }));
    await store.applyPayload(frame("agv-1", START), "mqtt");
    clock.ms = START + 6 * 3_600_000;
    await store.evaluateOfflineDevices();
    const device = store.getDevice("agv-1");
    expect(device?.online).toBe(false);
    expect(device?.alerts.map((alert) => alert.id)).not.toContain("agv-1-offline");
  });

  it("writes no telemetry frame for its own verdict", async () => {
    const { store, persistence, clock } = harness(rulesWith({}));
    await store.applyPayload(frame("agv-1", START), "mqtt");
    const framesWritten = persistence.telemetryWrites;
    clock.ms = START + 120_000;
    await store.evaluateOfflineDevices();
    expect(store.getDevice("agv-1")?.online).toBe(false);
    expect(persistence.telemetryWrites).toBe(framesWritten);
  });
});

describe("a config reload", () => {
  it("clears a rule alert the new rules no longer raise, on a vehicle that is silent", async () => {
    const { store, clock, state, events, persistence } = harness(rulesWith({}), ["agv-1"]);
    await store.applyPayload(frame("agv-1", START, 12), "mqtt");
    clock.ms = START + 120_000;
    await store.evaluateOfflineDevices();
    expect(store.getDevice("agv-1")?.alerts.map((alert) => alert.id)).toEqual(
      expect.arrayContaining(["agv-1-low-soc", "agv-1-offline"]),
    );

    // Maintenance: both rules off. The vehicle sends nothing more.
    state.rules = {
      ...rulesWith({ enabled: false }),
      lowBattery: { ...DEFAULT_ALERT_RULES.lowBattery, enabled: false },
    };
    events.length = 0;
    await store.reloadConfig();

    expect(store.getDevice("agv-1")?.alerts).toEqual([]);
    expect(
      events.filter((event) => event.type === "alert.cleared").map((event) => event.payload),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ alertId: "agv-1-low-soc" }),
        expect.objectContaining({ alertId: "agv-1-offline" }),
      ]),
    );
    expect(persistence.alertSyncs.at(-1)).toEqual({ deviceId: "agv-1", ids: [] });
  });
});

describe("forgetting a device", () => {
  it("closes an evicted device's active alerts", async () => {
    const { store, clock, persistence, events } = harness(rulesWith({}));
    await store.applyPayload(frame("stray-01", START, 12), "mqtt");
    clock.ms = START + 2 * 86_400_000;
    await store.evaluateOfflineDevices();

    expect(store.getDevice("stray-01")).toBeNull();
    expect(persistence.alertSyncs.at(-1)).toEqual({ deviceId: "stray-01", ids: [] });
    expect(events.some((event) => event.type === "alert.cleared")).toBe(true);
  });

  it("broadcasts a snapshot after a whole-fleet replace, and closes the dropped device's alerts", async () => {
    const { store, events, persistence } = harness();
    await store.applyPayload(
      { devices: [frame("agv-1", START, 12), frame("agv-2", START)] },
      "debug-api",
      { allowReplace: true },
    );
    events.length = 0;
    await store.applyPayload({ devices: [frame("agv-2", START + 1_000)] }, "debug-api", {
      allowReplace: true,
    });

    const snapshot = events.find((event) => event.type === "fleet.snapshot");
    expect(
      (snapshot?.payload as { devices: Array<{ deviceId: string }> }).devices.map(
        (device) => device.deviceId,
      ),
    ).toEqual(["agv-2"]);
    expect(persistence.alertSyncs).toContainEqual({ deviceId: "agv-1", ids: [] });
  });
});
