import { describe, expect, it, vi } from "vitest";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig } from "../src/types";
import { DEFAULT_ALERT_RULES } from "@navfleet/shared";

/**
 * A returning backend restores the last-seen devices from `device_latest`. That set
 * is bounded by the retention window, not by the current roster — so after
 * `vehicles.json` shrinks, an id it dropped can still sit in `device_latest` and,
 * before this fix, was resurrected into the fleet and shown until it fell silent for
 * a full DEVICE_RETENTION_SECONDS. That is the "设备列表里有 26 台，配置只有 23 台"
 * report. Restore now keeps only ids the current config still lists; a device that is
 * genuinely still publishing reappears on its next report like any live one.
 */

const FLEET_CONFIG: FleetConfig = {
  fleetName: "restore-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

const restoredDevice = (deviceId: string, stamp = new Date().toISOString()): DeviceSnapshot =>
  ({
    deviceId,
    online: true,
    stamp,
    vehicle_info: { soc: 80, speed: 1 },
  }) as unknown as DeviceSnapshot;

class RestoringPersistence {
  constructor(private readonly restored: DeviceSnapshot[]) {}
  async connect(): Promise<void> {}
  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    return this.restored;
  }
  async writeLatestSnapshot(): Promise<void> {}
  async writeTelemetry(): Promise<void> {}
  async upsertAlerts(): Promise<void> {}
  forgetDevice(): void {}
}

const createStore = (configuredDeviceIds: string[], restored: DeviceSnapshot[]): DashboardStore => {
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
  return new DashboardStore(
    new RestoringPersistence(restored) as unknown as Persistence,
    configRegistryStub as unknown as ConfigRegistry,
  );
};

describe("restore honours the current roster", () => {
  it("drops a restored device the current config no longer lists", async () => {
    const store = createStore(
      ["agv-a01", "agv-a02"],
      [restoredDevice("agv-a01"), restoredDevice("agv-a02"), restoredDevice("agv-old-01")],
    );
    await store.initialize();

    const ids = store
      .snapshot()
      .devices.map((device) => device.deviceId)
      .sort();
    expect(ids).toEqual(["agv-a01", "agv-a02"]);
  });

  it("still restores every device the roster does configure", async () => {
    const store = createStore(
      ["agv-a01", "agv-a02"],
      [restoredDevice("agv-a01"), restoredDevice("agv-a02")],
    );
    await store.initialize();

    expect(store.snapshot().devices).toHaveLength(2);
  });
});

describe("a restart is not evidence that the fleet went offline", () => {
  // Restored stamps are as old as the restart took. Judged on the first sweep, a two-minute
  // restart marked every vehicle offline and raised 29 offline alerts that cleared seconds later.
  it("gives restored vehicles one offline window to report before judging them", async () => {
    const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString();
    const store = createStore(["agv-a01"], [restoredDevice("agv-a01", twoMinutesAgo)]);
    await store.initialize();

    await store.evaluateOfflineDevices();
    expect(store.snapshot().devices[0]?.online).toBe(true);

    vi.useFakeTimers();
    try {
      for (let step = 0; step < 5; step += 1) {
        vi.setSystemTime(Date.now() + 15_000);
        await store.evaluateOfflineDevices();
      }
      expect(store.snapshot().devices[0]?.online).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
