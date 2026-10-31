import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig, SocketEvent } from "../src/types";
import { DEFAULT_ALERT_RULES } from "@navfleet/shared";

/**
 * Three defects found by the 2026-09-09 repo-wide audit, all in `DashboardStore`
 * and all invisible to the suite as it stood. Each test here fails on the code as
 * it was and passes on the fix; the point of the file is that the *next* refactor
 * of these three paths cannot quietly restore them.
 */

const FLEET_CONFIG: FleetConfig = {
  fleetName: "audit-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
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
  readonly alertSyncs: Array<{ deviceId: string; ids: string[]; at: Date }> = [];
  async upsertAlerts(deviceId: string, alerts: Array<{ id: string }>, at: Date): Promise<void> {
    this.alertSyncs.push({ deviceId, ids: alerts.map((alert) => alert.id), at });
  }
  forgetDevice(deviceId: string): void {
    this.forgotten.push(deviceId);
  }
}

const createStore = (
  configuredDeviceIds: string[] = [],
  now?: () => number,
): { store: DashboardStore; persistence: RecordingPersistence; events: SocketEvent[] } => {
  const persistence = new RecordingPersistence();
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
    now,
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

  it("reads a numeric or string `online` field the way the plain forms read", async () => {
    // `{ online: 0 }` is a common last-will payload; it used to fall through to "online".
    const { store } = createStore(["agv-1"]);
    await store.applyPayload(telemetry("agv-1"), "seed");
    for (const value of [0, "0", "false", "offline"]) {
      await store.applyStatus("agv-1", { online: value });
      expect(onlineOf(store, "agv-1"), JSON.stringify(value)).toBe(false);
      await store.applyStatus("agv-1", { online: 1 });
      expect(onlineOf(store, "agv-1")).toBe(true);
    }
  });

  it("keeps the vehicle's own alarm across a heartbeat instead of clearing and re-raising it", async () => {
    const { store, events } = createStore(["agv-1"]);
    const frame = {
      ...telemetry("agv-1"),
      alarmList: [{ id: "agv-1-bumper", title: "防撞条触发", level: "error" }],
    };
    await store.applyPayload(frame, "mqtt");
    await store.applyStatus("agv-1", { online: true });
    await store.applyPayload({ ...frame, stamp: new Date().toISOString() }, "mqtt");

    const lifecycle = events
      .filter((event) => event.type === "alert.created" || event.type === "alert.cleared")
      .map((event) => event.type);
    expect(lifecycle).toEqual(["alert.created"]);
    expect(store.snapshot().devices[0]?.alerts.map((alert) => alert.id)).toContain("agv-1-bumper");
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

describe("a device the offline monitor marked offline comes back on the next telemetry frame", () => {
  // A real vehicle_info frame carries no `online` field — the whole offline design infers
  // liveness from `stamp` freshness — so telemetry resuming must clear the offline state the
  // silence monitor set. Before the fix, normalize inherited the stale `online:false`, leaving a
  // device that was actively reporting stuck offline (and re-raising its offline alert every
  // frame) until it was evicted.
  const vehicleInfo = (deviceId: string, stamp: string): Record<string, unknown> => ({
    deviceId,
    stamp,
    vehicle_info: { soc: 80, speed: 1 },
    fusion_loc: { x: 1, y: 2, yaw: 0 },
  });
  const offlineAlertPresent = (store: DashboardStore, deviceId: string): boolean =>
    (store.snapshot().devices.find((device) => device.deviceId === deviceId)?.alerts ?? []).some(
      (alert) => alert.id === `${deviceId}-offline`,
    );

  it("resets online:true (and clears the offline alert) without needing an explicit status frame", async () => {
    const { store } = createStore(["agv-1"]);
    // Present and online, but already older than the 60s silence window.
    const stale = new Date(Date.now() - 120_000).toISOString();
    await store.applyPayload({ ...vehicleInfo("agv-1", stale), online: true }, "seed");
    expect(onlineOf(store, "agv-1")).toBe(true);

    // The silence-based monitor marks it offline and raises the offline alert.
    await store.evaluateOfflineDevices();
    expect(onlineOf(store, "agv-1")).toBe(false);
    expect(offlineAlertPresent(store, "agv-1")).toBe(true);

    // A fresh vehicle_info frame (no `online` field) must bring it back.
    await store.applyPayload(vehicleInfo("agv-1", new Date().toISOString()), "mqtt");
    expect(onlineOf(store, "agv-1")).toBe(true);
    expect(offlineAlertPresent(store, "agv-1")).toBe(false);
  });

  it("holds off offline verdicts while the telemetry source is down, and for one window after", async () => {
    const { store } = createStore(["agv-1"]);
    const stale = new Date(Date.now() - 120_000).toISOString();
    await store.applyPayload({ ...vehicleInfo("agv-1", stale), online: true }, "seed");

    // Broker down: the whole fleet is silent, which says nothing about this vehicle.
    store.setSourceConnected(false);
    await store.evaluateOfflineDevices();
    expect(onlineOf(store, "agv-1")).toBe(true);
    expect(offlineAlertPresent(store, "agv-1")).toBe(false);

    // Just reconnected: vehicles get one offline window to report again first.
    store.setSourceConnected(true);
    await store.evaluateOfflineDevices();
    expect(onlineOf(store, "agv-1")).toBe(true);

    // A full window later, a vehicle that still has not reported is judged offline. The sweep
    // keeps its 15 s cadence meanwhile, as the backend's timer does.
    vi.useFakeTimers();
    try {
      for (let step = 0; step < 5; step += 1) {
        vi.setSystemTime(Date.now() + 15_000);
        await store.evaluateOfflineDevices();
      }
      expect(onlineOf(store, "agv-1")).toBe(false);
      expect(offlineAlertPresent(store, "agv-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a sweep gap longer than the offline window as a suspension, not a silent fleet", async () => {
    const { store } = createStore(["agv-1"]);
    const recent = new Date(Date.now() - 5_000).toISOString();
    await store.applyPayload({ ...vehicleInfo("agv-1", recent), online: true }, "seed");
    await store.evaluateOfflineDevices();

    vi.useFakeTimers();
    try {
      // The host slept for ten minutes: on waking the vehicle's last frame is ten minutes old,
      // but nothing ran to hear from it. No verdict until it has had a window to report.
      vi.setSystemTime(Date.now() + 10 * 60_000);
      await store.evaluateOfflineDevices();
      expect(onlineOf(store, "agv-1")).toBe(true);
      expect(offlineAlertPresent(store, "agv-1")).toBe(false);

      // Still silent a full window after waking: now it is evidence.
      for (let step = 0; step < 5; step += 1) {
        vi.setSystemTime(Date.now() + 15_000);
        await store.evaluateOfflineDevices();
      }
      expect(onlineOf(store, "agv-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

describe("the store's clock is injectable", () => {
  // The demo history backfill runs a month of frames through this store in a few minutes. Every
  // time the store records — arrival, the offline verdict, when an alert set changed — has to be
  // the simulated time, or a month of history would be stamped with the minute it was generated.
  it("judges silence, stamps the offline alert and dates alert syncs by the injected clock", async () => {
    let simulated = Date.parse("2026-09-01T00:00:00Z");
    const { store, persistence } = createStore(["agv-1"], () => simulated);
    await store.applyPayload(
      { deviceId: "agv-1", stamp: new Date(simulated).toISOString(), vehicle_info: { soc: 80 } },
      "mqtt",
      { checkDeviceClock: true },
    );
    // Within the device-clock tolerance of the *simulated* arrival, so the stamp is trusted.
    expect(store.snapshot().devices[0]?.stamp).toBe("2026-09-01T00:00:00.000Z");

    // Two minutes of simulated silence, swept every 15 s as the backend's timer does.
    for (let step = 0; step < 8; step += 1) {
      simulated += 15_000;
      await store.evaluateOfflineDevices();
    }
    const device = store.snapshot().devices[0];
    expect(device?.online).toBe(false);
    const offline = device?.alerts.find((alert) => alert.id === "agv-1-offline");
    // 90 s is past the 60 s default threshold, so the sweep at 00:01:15 is the first verdict.
    expect(offline?.ts).toBe("2026-09-01T00:01:15.000Z");
    expect(persistence.alertSyncs.at(-1)?.at.toISOString()).toBe("2026-09-01T00:01:15.000Z");
  });
});
