import { describe, expect, it, vi } from "vitest";
import type { AlertRulesConfig } from "@navfleet/shared";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig } from "../src/types";

/**
 * Rules scoped by tag or formation, through the real ingest path.
 *
 * A frame carries no tags and no formations: those come from `vehicles.json` and
 * `formations.json`, which the store applies to the snapshot after normalising it. The rules
 * used to be evaluated on the raw snapshot, so a rule scoped by tag or formation matched no
 * vehicle. In the demo, fourteen of the eighteen vehicles in the tag-scoped low-battery rule
 * dropped below its 20 % threshold over a month, one to 3.6 %, and not one low-battery warning
 * was raised. The shared evaluator's own tests hand it devices that already carry their tags,
 * which is why they never saw it.
 */

const FLEET_CONFIG: FleetConfig = {
  fleetName: "scope-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

/** What config says about each vehicle; none of it is in the frames. */
const MEMBERSHIP: Record<string, { tags: string[]; formationIds: string[] }> = {
  "agv-cold": { tags: ["cold"], formationIds: [] },
  "agv-line": { tags: [], formationIds: ["line-a"] },
  "agv-other": { tags: ["dry"], formationIds: ["line-b"] },
};

class QuietPersistence {
  async connect(): Promise<void> {}
  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    return [];
  }
  async writeLatestSnapshot(): Promise<void> {}
  async writeTelemetry(): Promise<void> {}
  async upsertAlerts(): Promise<void> {}
  forgetDevice(): void {}
}

const createStore = (rules: AlertRulesConfig): DashboardStore => {
  const registry = {
    async load(): Promise<void> {},
    getFleetConfig: (): FleetConfig => ({ ...FLEET_CONFIG }),
    getAlertRules: () => rules,
    // As the real registry does: config decides membership, whatever the snapshot carried.
    applyDeviceConfig: (snapshot: DeviceSnapshot): DeviceSnapshot => ({
      ...snapshot,
      tags: [...(MEMBERSHIP[snapshot.deviceId]?.tags ?? snapshot.tags)],
      formationIds: [...(MEMBERSHIP[snapshot.deviceId]?.formationIds ?? snapshot.formationIds)],
    }),
    hasDeviceConfig: (deviceId: string): boolean => deviceId in MEMBERSHIP,
    listScenes: () => [],
    buildFormationSnapshots: () => [],
  };
  return new DashboardStore(
    new QuietPersistence() as unknown as Persistence,
    registry as unknown as ConfigRegistry,
  );
};

const frame = (deviceId: string, soc: number, stamp = new Date().toISOString()) => ({
  deviceId,
  stamp,
  vehicle_info: { soc, speed: 0 },
});

const alertIds = (store: DashboardStore, deviceId: string): string[] =>
  store.getDevice(deviceId)?.alerts.map((alert) => alert.id) ?? [];

const lowBatteryScopedTo = (scope: NonNullable<AlertRulesConfig["lowBattery"]["scope"]>) =>
  ({
    lowBattery: { enabled: true, thresholdPct: 20, debounceSeconds: 0, scope },
    offline: { enabled: true },
  }) satisfies AlertRulesConfig;

describe("rule scopes match the configured membership, not the frame's", () => {
  it("raises a tag-scoped low-battery warning for a vehicle config tags so", async () => {
    const store = createStore(lowBatteryScopedTo({ tags: ["cold"] }));
    await store.applyPayload(frame("agv-cold", 12), "mqtt");
    await store.applyPayload(frame("agv-other", 12), "mqtt");

    expect(alertIds(store, "agv-cold")).toContain("agv-cold-low-soc");
    // Same reading, out of scope: still nothing.
    expect(alertIds(store, "agv-other")).not.toContain("agv-other-low-soc");
  });

  it("raises a formation-scoped low-battery warning for a member of that formation", async () => {
    const store = createStore(lowBatteryScopedTo({ formationIds: ["line-a"] }));
    await store.applyPayload(frame("agv-line", 12), "mqtt");
    await store.applyPayload(frame("agv-other", 12), "mqtt");

    expect(alertIds(store, "agv-line")).toContain("agv-line-low-soc");
    expect(alertIds(store, "agv-other")).not.toContain("agv-other-low-soc");
  });

  it("keeps a device-scoped rule working as before", async () => {
    const store = createStore(lowBatteryScopedTo({ deviceIds: ["agv-other"] }));
    await store.applyPayload(frame("agv-other", 12), "mqtt");
    expect(alertIds(store, "agv-other")).toContain("agv-other-low-soc");
  });

  it("judges silence only for vehicles a tag-scoped offline rule watches", async () => {
    const store = createStore({
      lowBattery: { enabled: true, thresholdPct: 20, debounceSeconds: 0 },
      offline: { enabled: true, afterSeconds: 60, scope: { tags: ["cold"] } },
    });
    const stale = new Date(Date.now() - 120_000).toISOString();
    await store.applyPayload(frame("agv-cold", 80, stale), "seed");
    await store.applyPayload(frame("agv-other", 80, stale), "seed");

    // Silence is measured from arrival: let the 60 s window pass, then sweep once.
    vi.useFakeTimers({ now: Date.now() + 90_000, toFake: ["Date"] });
    try {
      await store.evaluateOfflineDevices();
    } finally {
      vi.useRealTimers();
    }

    expect(store.getDevice("agv-cold")?.online).toBe(false);
    expect(alertIds(store, "agv-cold")).toContain("agv-cold-offline");
    // Out of scope: no offline alert — but silent is still offline, not shown as online at a
    // stale position.
    expect(store.getDevice("agv-other")?.online).toBe(false);
    expect(alertIds(store, "agv-other")).not.toContain("agv-other-offline");
  });
});

describe("a vehicle's first frame is visible to the alert.created listeners", () => {
  it("resolves the configured tags and formations while the frame's events go out", async () => {
    // The notify dispatcher looks the device up again on alert.created, for its scope and display
    // name. The events go out inside the ingest loop, before the snapshot map is swapped, so for a
    // vehicle's first frame the lookup returned null and every tag- or formation-scoped channel
    // missed the alert.
    const store = createStore(lowBatteryScopedTo({}));
    const seen: Array<{ tags: string[]; formationIds: string[] } | null> = [];
    store.on("event", (event: { type: string; payload: { deviceId: string } }) => {
      if (event.type !== "alert.created") return;
      const device = store.getDevice(event.payload.deviceId);
      seen.push(device ? { tags: device.tags, formationIds: device.formationIds } : null);
    });

    await store.applyPayload(frame("agv-line", 12), "mqtt");

    expect(seen).toEqual([{ tags: [], formationIds: ["line-a"] }]);
  });
});
