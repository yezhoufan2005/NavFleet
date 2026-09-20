import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig, SocketEvent } from "../src/types";
import { DEFAULT_ALERT_RULES } from "@navfleet/shared";

const FLEET_CONFIG: FleetConfig = {
  fleetName: "backpressure-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

/**
 * Persistence stub whose writes block until released, so the ingest queue can be
 * held full deterministically instead of by timing luck.
 */
class BlockingPersistence {
  readonly written: string[] = [];
  readonly forgotten: string[] = [];
  private release: (() => void) | null = null;
  private gate: Promise<void> | null = null;

  /** Make every subsequent write wait until `releaseWrites()` is called. */
  block(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseWrites(): void {
    this.release?.();
    this.release = null;
    this.gate = null;
  }

  async connect(): Promise<void> {}

  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    return [];
  }

  async writeLatestSnapshot(snapshot: DeviceSnapshot): Promise<void> {
    this.written.push(snapshot.deviceId);
    if (this.gate) await this.gate;
  }

  async writeTelemetry(): Promise<void> {}

  async upsertAlerts(): Promise<void> {}

  forgetDevice(deviceId: string): void {
    this.forgotten.push(deviceId);
  }
}

const createStore = (
  configuredDeviceIds: string[] = [],
): { store: DashboardStore; persistence: BlockingPersistence; events: SocketEvent[] } => {
  const persistence = new BlockingPersistence();
  const configured = new Set(configuredDeviceIds);
  const configRegistryStub = {
    async load(): Promise<void> {},
    getFleetConfig: (): FleetConfig => ({ ...FLEET_CONFIG }),
    getAlertRules: () => DEFAULT_ALERT_RULES,
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

const telemetry = (
  deviceId: string,
  stamp = new Date().toISOString(),
): Record<string, unknown> => ({
  deviceId,
  online: true,
  stamp,
  vehicle_info: { soc: 80, speed: 1 },
});

describe("ingest queue backpressure (P0-b)", () => {
  const originalLimit = config.ingestQueueLimit;

  afterEach(() => {
    config.ingestQueueLimit = originalLimit;
  });

  it("drops the oldest sheddable frames instead of growing without bound", async () => {
    config.ingestQueueLimit = 3;
    const { store, persistence } = createStore();

    // One mutation is in flight and stuck inside persistence; everything after it
    // piles up in the queue.
    persistence.block();
    const inFlight = store.applyPayload(telemetry("agv-stuck"), "mqtt", { sheddable: true });

    const queued = ["a", "b", "c", "d", "e", "f"].map((suffix) =>
      store.applyPayload(telemetry(`agv-${suffix}`), "mqtt", { sheddable: true }),
    );

    expect(store.ingestQueueStats().depth).toBe(3);
    expect(store.ingestQueueStats().dropped).toBe(3);

    persistence.releaseWrites();
    await Promise.all([inFlight, ...queued]);

    // Shed frames resolve rather than reject: the caller has no better recovery
    // than the counter the store already keeps.
    const survivors = store.snapshot().devices.map((device) => device.deviceId);
    expect(survivors).toContain("agv-stuck");
    // The three newest survived; the three oldest were shed.
    expect(survivors).toEqual(expect.arrayContaining(["agv-d", "agv-e", "agv-f"]));
    expect(survivors).not.toContain("agv-a");
    expect(store.ingestQueueStats().depth).toBe(0);
  });

  it("never sheds a status frame, a config reload or a drain", async () => {
    config.ingestQueueLimit = 1;
    const { store, persistence } = createStore();
    await store.applyPayload(telemetry("agv-1"), "seed");

    persistence.block();
    const inFlight = store.applyStatus("agv-1", "offline");
    // Two unsheddable entries queue up behind it, plus a sheddable one that is over
    // the limit and therefore the only thing dropped.
    const status = store.applyStatus("agv-2", { online: true });
    const reload = store.reloadConfig();
    const shedMe = store.applyPayload(telemetry("agv-3"), "mqtt", { sheddable: true });

    expect(store.ingestQueueStats().dropped).toBe(1);

    persistence.releaseWrites();
    await Promise.all([inFlight, status, reload, shedMe, store.drain()]);

    const ids = store.snapshot().devices.map((device) => device.deviceId);
    expect(ids).toContain("agv-2");
    expect(ids).not.toContain("agv-3");
  });

  it("keeps FIFO order and does not let a rejected mutation stall the queue", async () => {
    const { store } = createStore();
    // A payload the normalizer refuses: `replace` without `allowReplace` (P0-e).
    const rejected = store.applyPayload({ devices: [telemetry("agv-x")] }, "mqtt");
    await expect(rejected).rejects.toThrow(/whole-fleet payload/);

    await store.applyPayload(telemetry("agv-after"), "mqtt", { sheddable: true });
    expect(store.snapshot().devices.map((device) => device.deviceId)).toEqual(["agv-after"]);
    expect(store.ingestQueueStats().depth).toBe(0);
  });
});

describe("device admission and eviction (P0-d)", () => {
  const originalMaxDevices = config.maxDevices;
  const originalRetention = config.deviceRetentionSeconds;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    config.maxDevices = originalMaxDevices;
    config.deviceRetentionSeconds = originalRetention;
    vi.useRealTimers();
  });

  it("refuses device ids that could not have come from a topic segment", async () => {
    const { store } = createStore();

    await store.applyPayload(telemetry("agv-ok"), "mqtt", { sheddable: true });
    // One per clause of the guard: whitespace, the topic separator, both
    // wildcards, a control character, and the length bound.
    for (const badId of [
      "agv bad",
      "agv/bad",
      "agv+bad",
      "agv#bad",
      "agv\u0000bad",
      "x".repeat(201),
    ]) {
      await store.applyPayload(telemetry(badId), "mqtt", { sheddable: true });
    }
    await store.applyStatus("agv bad", "offline");

    // A hyphen is not suspicious — `agv-a01` is what the shipped fleet uses.
    expect(store.snapshot().devices.map((device) => device.deviceId)).toEqual(["agv-ok"]);
    expect(store.deviceAdmissionStats().rejected).toBe(7);
  });

  it("refuses a new device at MAX_DEVICES but keeps updating the ones already in", async () => {
    config.maxDevices = 2;
    const { store } = createStore();

    await store.applyPayload(telemetry("agv-1"), "mqtt", { sheddable: true });
    await store.applyPayload(telemetry("agv-2"), "mqtt", { sheddable: true });
    await store.applyPayload(telemetry("agv-3"), "mqtt", { sheddable: true });
    await store.applyStatus("agv-1", "offline");

    const devices = store.snapshot().devices;
    expect(devices.map((device) => device.deviceId).sort()).toEqual(["agv-1", "agv-2"]);
    expect(devices.find((device) => device.deviceId === "agv-1")?.online).toBe(false);
    expect(store.deviceAdmissionStats().capped).toBe(1);
  });

  it("admits a configured device even when the fleet is at the cap", async () => {
    config.maxDevices = 1;
    const { store } = createStore(["agv-declared"]);

    await store.applyPayload(telemetry("agv-stranger"), "mqtt", { sheddable: true });
    await store.applyPayload(telemetry("agv-declared"), "mqtt", { sheddable: true });

    expect(
      store
        .snapshot()
        .devices.map((device) => device.deviceId)
        .sort(),
    ).toEqual(["agv-declared", "agv-stranger"]);
    expect(store.deviceAdmissionStats().capped).toBe(0);
  });

  it("evicts a silent undeclared device, cascades to persistence and republishes the fleet", async () => {
    config.deviceRetentionSeconds = 60;
    const { store, persistence, events } = createStore(["agv-declared"]);

    await store.applyPayload(telemetry("agv-declared"), "mqtt", { sheddable: true });
    await store.applyPayload(telemetry("agv-stranger"), "mqtt", { sheddable: true });

    // Advance our own ingest clock past the retention window. The device's `stamp`
    // is deliberately left alone: eviction must key off when *we* last heard from
    // it, not off a value the vehicle supplied.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    events.length = 0;
    await store.evaluateOfflineDevices();

    expect(store.snapshot().devices.map((device) => device.deviceId)).toEqual(["agv-declared"]);
    expect(persistence.forgotten).toEqual(["agv-stranger"]);
    expect(store.deviceAdmissionStats().evicted).toBe(1);
    // A long-lived tab learns about the removal from an authoritative snapshot.
    expect(events.filter((event) => event.type === "fleet.snapshot")).toHaveLength(1);
  });

  it("does not evict when DEVICE_RETENTION_SECONDS is 0", async () => {
    config.deviceRetentionSeconds = 0;
    const { store, persistence } = createStore();

    await store.applyPayload(telemetry("agv-stranger"), "mqtt", { sheddable: true });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30 * 24 * 3_600_000);
    await store.evaluateOfflineDevices();

    expect(store.snapshot().devices).toHaveLength(1);
    expect(persistence.forgotten).toEqual([]);
    expect(store.deviceAdmissionStats().evicted).toBe(0);
  });
});
