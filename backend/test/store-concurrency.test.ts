import { describe, expect, it } from "vitest";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig } from "../src/types";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Persistence stub whose writes yield to the event loop, so two in-flight
 * store mutations interleave deterministically instead of by luck.
 */
class SlowPersistence {
  readonly writes: string[] = [];

  constructor(private readonly delayMs = 5) {}

  async connect(): Promise<void> {}

  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    return [];
  }

  async writeLatestSnapshot(snapshot: DeviceSnapshot): Promise<void> {
    this.writes.push(snapshot.deviceId);
    await delay(this.delayMs);
  }

  async writeTelemetry(): Promise<void> {
    await delay(this.delayMs);
  }

  async upsertAlerts(): Promise<void> {}

  forgetDevice(): void {}
}

const FLEET_CONFIG: FleetConfig = {
  fleetName: "concurrency-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultMapProfile: "lanelet",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

/** Config registry stub: identity device config, no formations, no scenes. */
const configRegistryStub = {
  async load(): Promise<void> {},
  getFleetConfig: (): FleetConfig => ({ ...FLEET_CONFIG }),
  applyDeviceConfig: (snapshot: DeviceSnapshot): DeviceSnapshot => snapshot,
  hasDeviceConfig: (): boolean => false,
  listScenes: () => [],
  buildFormationSnapshots: () => [],
};

const createStore = (delayMs = 5): { store: DashboardStore; persistence: SlowPersistence } => {
  const persistence = new SlowPersistence(delayMs);
  const store = new DashboardStore(
    persistence as unknown as Persistence,
    configRegistryStub as unknown as ConfigRegistry,
  );
  return { store, persistence };
};

const telemetry = (deviceId: string): Record<string, unknown> => ({
  deviceId,
  online: true,
  stamp: new Date().toISOString(),
  vehicle_info: { soc: 80, speed: 1 },
});

describe("DashboardStore mutation serialization", () => {
  it("keeps every device when concurrent applyPayload calls interleave", async () => {
    const { store } = createStore();
    const deviceIds = ["agv-1", "agv-2", "agv-3", "agv-4"];

    // Fire-and-collect: all calls start before any of them completes, which is
    // exactly what the (un-awaited, un-serialized) MQTT message handler does.
    const inFlight = deviceIds.map((deviceId) => store.applyPayload(telemetry(deviceId), "test"));
    await Promise.all(inFlight);

    const stored = store
      .snapshot()
      .devices.map((device) => device.deviceId)
      .sort();
    expect(stored).toEqual([...deviceIds].sort());
    expect(store.buildSummary().deviceCount).toBe(deviceIds.length);
  });

  it("does not drop a status update that lands during an in-flight applyPayload", async () => {
    const { store } = createStore();
    await store.applyPayload(telemetry("agv-a"), "seed");

    // applyPayload for agv-b is mid-flight (already past its first await) when
    // the status update for agv-a arrives.
    const payloadInFlight = store.applyPayload(telemetry("agv-b"), "test");
    const statusInFlight = store.applyStatus("agv-a", "offline");
    await Promise.all([payloadInFlight, statusInFlight]);

    const devices = store.snapshot().devices;
    expect(devices.map((device) => device.deviceId).sort()).toEqual(["agv-a", "agv-b"]);
    expect(devices.find((device) => device.deviceId === "agv-a")?.online).toBe(false);
  });
});
