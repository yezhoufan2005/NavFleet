import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ALERT_RULES } from "@navfleet/shared";
import { config } from "../src/config";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig } from "../src/types";

/**
 * Device ids come from topics through the pattern MQTT subscribed with (MQTT_TOPIC_PATTERN).
 * fleet.json has a `topicPattern` too, but only for display, and the store used to read ids
 * with that one: under a custom subscription every frame missed it and became a new
 * `device-<timestamp>` vehicle, until MAX_DEVICES was full.
 */

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

const createStore = (): DashboardStore => {
  const registry = {
    async load(): Promise<void> {},
    // The display template left at its default, as a deployment that only set the env would.
    getFleetConfig: (): FleetConfig => ({
      fleetName: "topic-fleet",
      topicPattern: "/fleet/{deviceId}/vehicle_info",
      defaultGpsEnabled: true,
      defaultRosMapEnabled: true,
    }),
    getAlertRules: () => DEFAULT_ALERT_RULES,
    applyDeviceConfig: (snapshot: DeviceSnapshot): DeviceSnapshot => snapshot,
    hasDeviceConfig: (): boolean => true,
    listScenes: () => [],
    buildFormationSnapshots: () => [],
  };
  return new DashboardStore(
    new QuietPersistence() as unknown as Persistence,
    registry as unknown as ConfigRegistry,
  );
};

describe("device ids under a custom MQTT_TOPIC_PATTERN", () => {
  const original = config.topicPattern;
  afterEach(() => {
    config.topicPattern = original;
  });

  it("files every frame under the vehicle its topic names", async () => {
    config.topicPattern = "/org/site/{deviceId}/vehicle_info";
    const store = createStore();
    // Loads fleet.json, as the backend does on start.
    await store.initialize();
    for (let frame = 0; frame < 3; frame += 1) {
      await store.applyPayload(
        {
          topic: "/org/site/agv-a01/vehicle_info",
          payload: { stamp: new Date().toISOString(), vehicle_info: { soc: 80 } },
        },
        "mqtt",
      );
    }

    expect(store.snapshot().devices.map((device) => device.deviceId)).toEqual(["agv-a01"]);
    expect(store.getDevice("agv-a01")?.vehicleInfo.soc).toBe(80);
  });
});
