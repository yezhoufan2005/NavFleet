import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig, SocketEvent } from "../src/types";

/**
 * Three defects found by the 2026-09-09 repo-wide audit, all in `DashboardStore`
 * and all invisible to the suite as it stood. Each test here fails on the code as
 * it was and passes on the fix; the point of the file is that the *next* refactor
 * of these three paths cannot quietly restore them.
 */

const FLEET_CONFIG: FleetConfig = {
  fleetName: "audit-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultMapProfile: "lanelet",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

class RecordingPersistence {
  readonly forgotten: string[] = [];

  async connect(): Promise<void> {}
  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    return [];
  }
  async writeLatestSnapshot(): Promise<void> {}
  async writeTelemetry(): Promise<void> {}
  async upsertAlerts(): Promise<void> {}
  forgetDevice(deviceId: string): void {
    this.forgotten.push(deviceId);
  }
}

const createStore = (
  configuredDeviceIds: string[] = [],
): { store: DashboardStore; persistence: RecordingPersistence; events: SocketEvent[] } => {
  const persistence = new RecordingPersistence();
  const configured = new Set(configuredDeviceIds);
  const configRegistryStub = {
    async load(): Promise<void> {},
    getFleetConfig: (): FleetConfig => ({ ...FLEET_CONFIG }),
    applyDeviceConfig: (snapshot: DeviceSnapshot): DeviceSnapshot => snapshot,
    hasDeviceConfig: (deviceId: string): boolean => configured.has(deviceId),
    listScenes: () => [],
    buildFormationSnapshots: () => [],
  };
  const store = new DashboardStore(
    persistence as unknown as Persistence,
    configRegistryStub as unknown as ConfigRegistry,
  );
  const events: SocketEvent[] = [];
  store.on("event", (event: SocketEvent) => events.push(event));
  return { store, persistence, events };
};

const onlineOf = (store: DashboardStore, deviceId: string): boolean | undefined =>
  store.snapshot().devices.find((device) => device.deviceId === deviceId)?.online;

const deviceIds = (store: DashboardStore): string[] =>
  store.snapshot().devices.map((device) => device.deviceId);

const telemetry = (deviceId: string): Record<string, unknown> => ({
  deviceId,
  online: true,
  stamp: new Date().toISOString(),
  vehicle_info: { soc: 80, speed: 1 },
});

describe("status frames: every shape mqttStatusSchema admits", () => {
  it("treats a bare `false` as offline rather than online", async () => {
    const { store } = createStore(["agv-1"]);
    await store.applyPayload(telemetry("agv-1"), "seed");
    expect(onlineOf(store, "agv-1")).toBe(true);

    // The gate accepts `z.boolean()`, so this reaches the store unchanged. It used
    // to fall past a string branch and an object branch into `return true`.
    await store.applyStatus("agv-1", false);
    expect(onlineOf(store, "agv-1")).toBe(false);

    await store.applyStatus("agv-1", true);
    expect(onlineOf(store, "agv-1")).toBe(true);
  });

  it("reads the same word the same way whether or not it is wrapped in an object", async () => {
    const { store } = createStore(["agv-1"]);
    await store.applyPayload(telemetry("agv-1"), "seed");

    // `"false"` and `"0"` were offline as bare strings and online inside
    // `{ status: … }`; untrimmed `" offline "` was offline bare, online wrapped.
    for (const token of ["offline", "0", "false", " OFFLINE ", "Offline"]) {
      await store.applyStatus("agv-1", token);
      expect(onlineOf(store, "agv-1"), `bare ${JSON.stringify(token)}`).toBe(false);

      await store.applyStatus("agv-1", { online: true });
      await store.applyStatus("agv-1", { status: token });
      expect(onlineOf(store, "agv-1"), `wrapped ${JSON.stringify(token)}`).toBe(false);

      await store.applyStatus("agv-1", { online: true });
    }
  });

  it("still defaults to online for a frame that says nothing about it", async () => {
    const { store } = createStore(["agv-1"]);
    await store.applyPayload(telemetry("agv-1"), "seed");
    await store.applyStatus("agv-1", false);

    // A frame arrived at all, so the device is talking to us.
    await store.applyStatus("agv-1", { battery: 41 });
    expect(onlineOf(store, "agv-1")).toBe(true);
  });
});

describe("MAX_DEVICES applies within a single payload", () => {
  const originalMax = config.maxDevices;
  afterEach(() => {
    config.maxDevices = originalMax;
  });

  it("caps a multi-device replace payload instead of admitting all of it", async () => {
    config.maxDevices = 2;
    const { store } = createStore();

    // One call, four undeclared devices. The cap was measured against the live map
    // while the loop accumulated into a map assigned only afterwards, so the
    // observed size never grew and all four were admitted.
    await store.applyPayload(
      { devices: ["agv-1", "agv-2", "agv-3", "agv-4"].map((id) => telemetry(id)) },
      "debug",
      { allowReplace: true },
    );

    expect(deviceIds(store)).toHaveLength(2);
    expect(store.deviceAdmissionStats().capped).toBeGreaterThanOrEqual(2);
  });

  it("still exempts devices declared in vehicles.json", async () => {
    config.maxDevices = 1;
    const { store } = createStore(["agv-declared-a", "agv-declared-b"]);

    await store.applyPayload(
      {
        devices: ["agv-declared-a", "agv-declared-b", "agv-walkin"].map((id) => telemetry(id)),
      },
      "debug",
      { allowReplace: true },
    );

    // Both declared devices get in even though the cap is 1; the walk-in does not.
    const ids = deviceIds(store);
    expect(ids).toEqual(expect.arrayContaining(["agv-declared-a", "agv-declared-b"]));
    expect(ids).not.toContain("agv-walkin");
  });
});

describe("a replace payload cascades the drop, not just the two snapshot maps", () => {
  it("forgets the departed device's telemetry and its lastIngestAt entry", async () => {
    const { store, persistence } = createStore();
    await store.applyPayload(telemetry("agv-keep"), "mqtt");
    await store.applyPayload(telemetry("agv-drop"), "mqtt");
    expect(deviceIds(store)).toHaveLength(2);

    await store.applyPayload({ devices: [telemetry("agv-keep")] }, "debug", {
      allowReplace: true,
    });

    expect(deviceIds(store)).toEqual(["agv-keep"]);
    // Was the leak: the snapshot maps were rebuilt, but the per-device telemetry
    // ring was left behind — and `lastIngestAt` too, whose only sweep iterates
    // `rawDevices`, so the entry could never be reached again.
    expect(persistence.forgotten).toEqual(["agv-drop"]);
  });

  it("does not forget anything on an ordinary merge payload", async () => {
    const { store, persistence } = createStore();
    await store.applyPayload(telemetry("agv-1"), "mqtt");
    await store.applyPayload(telemetry("agv-2"), "mqtt");

    expect(persistence.forgotten).toEqual([]);
    expect(deviceIds(store)).toHaveLength(2);
  });
});
