import { describe, expect, it } from "vitest";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig, SocketEvent } from "../src/types";
import { DEFAULT_ALERT_RULES } from "@navfleet/shared";

/**
 * The disposition broadcast. Unlike the fleet/device/alert events, this is not derived from a
 * telemetry delta — the disposition route calls it directly after writing to persistence — so it
 * has its own entry point. What matters is that it emits on the same `"event"` channel `wsBridge`
 * forwards, carrying exactly the fields a client needs to reconcile its overlay.
 */
const FLEET_CONFIG: FleetConfig = {
  fleetName: "ack-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

const createStore = (): { store: DashboardStore; events: SocketEvent[] } => {
  const persistence = {
    async connect(): Promise<void> {},
    async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
      return [];
    },
    async writeLatestSnapshot(): Promise<void> {},
    async writeTelemetry(): Promise<void> {},
    async upsertAlerts(): Promise<void> {},
    forgetDevice(): void {},
  };
  const configRegistryStub = {
    async load(): Promise<void> {},
    getFleetConfig: (): FleetConfig => ({ ...FLEET_CONFIG }),
    getAlertRules: () => DEFAULT_ALERT_RULES,
    applyDeviceConfig: (snapshot: DeviceSnapshot): DeviceSnapshot => snapshot,
    hasDeviceConfig: (): boolean => false,
    listScenes: () => [],
    buildFormationSnapshots: () => [],
  };
  const store = new DashboardStore(
    persistence as unknown as Persistence,
    configRegistryStub as unknown as ConfigRegistry,
  );
  const events: SocketEvent[] = [];
  store.on("event", (event: SocketEvent) => events.push(event));
  return { store, events };
};

describe("DashboardStore — disposition broadcast", () => {
  it("emits alert.disposition with the full disposition on the event channel", () => {
    const { store, events } = createStore();

    store.broadcastAlertDisposition({
      deviceId: "agv-01",
      alertId: "err-1",
      version: 1,
      disposition: "investigating",
      claimedBy: "op-1",
      claimedAt: "2026-03-01T08:00:00.000Z",
      ignoredBy: null,
      ignoredAt: null,
      ignoreReason: null,
    });

    expect(events).toEqual([
      {
        type: "alert.disposition",
        payload: {
          deviceId: "agv-01",
          alertId: "err-1",
          version: 1,
          disposition: "investigating",
          claimedBy: "op-1",
          claimedAt: "2026-03-01T08:00:00.000Z",
          ignoredBy: null,
          ignoredAt: null,
          ignoreReason: null,
        },
      },
    ]);
  });
});
