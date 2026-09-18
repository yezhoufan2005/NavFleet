import { describe, expect, it } from "vitest";
import type { ConfigRegistry } from "../src/configRegistry";
import type { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import type { DeviceSnapshot, FleetConfig, SocketEvent } from "../src/types";
import { DEFAULT_ALERT_RULES } from "@navfleet/shared";

/**
 * The two acknowledgement broadcasts (Phase 16A). Unlike the fleet/device/alert events, these
 * are not derived from a telemetry delta — the ack route calls them directly after writing to
 * persistence — so they have their own entry points. What matters is that they emit on the
 * same `"event"` channel `wsBridge` forwards, carrying exactly the fields a client needs to
 * reconcile its overlay.
 */
const FLEET_CONFIG: FleetConfig = {
  fleetName: "ack-fleet",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultMapProfile: "lanelet",
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

describe("DashboardStore — acknowledgement broadcasts", () => {
  it("emits alert.acked with who and when on the event channel", () => {
    const { store, events } = createStore();

    store.broadcastAlertAck({
      deviceId: "agv-01",
      alertId: "err-1",
      ackedBy: "op-1",
      ackedAt: "2026-03-01T08:00:00.000Z",
    });

    expect(events).toEqual([
      {
        type: "alert.acked",
        payload: {
          deviceId: "agv-01",
          alertId: "err-1",
          ackedBy: "op-1",
          ackedAt: "2026-03-01T08:00:00.000Z",
        },
      },
    ]);
  });

  it("emits alert.unacked with just the ref", () => {
    const { store, events } = createStore();

    store.broadcastAlertUnack({ deviceId: "agv-01", alertId: "err-1" });

    expect(events).toEqual([
      { type: "alert.unacked", payload: { deviceId: "agv-01", alertId: "err-1" } },
    ]);
  });
});
