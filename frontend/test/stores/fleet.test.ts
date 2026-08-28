/**
 * Fleet store: derived state, payload ingestion and movement trails.
 *
 * Ingestion is driven through `registerWindowApi()`'s `updateFromPayload`, the
 * store's exported entry point into `ingestPayload` (the MQTT / manual injection
 * bridge). The REST bootstrap and WebSocket entry points live in
 * `fleetRealtime.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useFleetStore } from "../../src/stores/fleet";
import { TRAIL_MAX_POINTS } from "../../src/lib/fleetNormalize";
import {
  rawAlert,
  rawDevice,
  rawFormation,
  snapshotPayload,
  stubFetchRoutes,
  windowFleetApi,
} from "../helpers/fleetFixtures";

let store: ReturnType<typeof useFleetStore>;

const ingest = (payload: unknown): void => windowFleetApi().updateFromPayload(payload);

const deviceIdsOf = (devices: Array<{ deviceId: string }>): string[] =>
  devices.map((device) => device.deviceId);

/** Devices arrive out of id order on purpose, so sorting is observable. */
const baseSnapshot = () =>
  snapshotPayload(
    [
      rawDevice("agv-3", { online: false, sceneId: "dock", runtimeSceneId: "dock" }),
      rawDevice("agv-1"),
      rawDevice("agv-2"),
    ],
    [rawFormation("f-2", ["agv-1", "agv-2"]), rawFormation("f-1", ["agv-3"])],
  );

const poseDelta = (deviceId: string, x: number, y = 0) => ({ deviceId, fusion_loc: { x, y } });

beforeEach(() => {
  // Ingesting a device primes its scene definition over REST; answer 404 so the
  // store keeps its local fallback instead of reaching for the network.
  stubFetchRoutes({});
  // The map surface preference is persisted, and localStorage is shared across
  // cases in a file — clear it so each case starts from the real default.
  window.localStorage.removeItem("navfleet:map-mode");
  setActivePinia(createPinia());
  store = useFleetStore();
  store.registerWindowApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fleet store derived state", () => {
  beforeEach(() => {
    ingest(baseSnapshot());
  });

  it("orders devices by id so rows never jump as telemetry arrives", () => {
    expect(deviceIdsOf(store.sortedDevices)).toEqual(["agv-1", "agv-2", "agv-3"]);

    ingest({ deviceId: "agv-3", vehicle_info: { speed: 9 }, fusion_loc: { x: 5, y: 5 } });
    ingest({ deviceId: "agv-1", vehicle_info: { speed: 1 } });

    expect(deviceIdsOf(store.sortedDevices)).toEqual(["agv-1", "agv-2", "agv-3"]);
  });

  it("sorts a late-arriving device into place instead of appending it", () => {
    ingest({ deviceId: "agv-0", vehicle_info: { soc: 50 } });
    expect(deviceIdsOf(store.sortedDevices)).toEqual(["agv-0", "agv-1", "agv-2", "agv-3"]);
  });

  it("orders formations by id and enriches them from their members", () => {
    expect(store.sortedFormations.map((formation) => formation.formationId)).toEqual([
      "f-1",
      "f-2",
    ]);

    const [first, second] = store.sortedFormations;
    expect(first).toMatchObject({
      formationId: "f-1",
      deviceCount: 1,
      onlineCount: 0,
      sceneId: "dock",
    });
    expect(second).toMatchObject({
      formationId: "f-2",
      deviceCount: 2,
      onlineCount: 2,
      sceneId: "yard",
    });
  });

  it("auto-selects the first device once a payload lands", () => {
    expect(store.selectedDevice?.deviceId).toBe("agv-1");
    expect(store.selectedFormation).toBeNull();
  });

  it("ignores selection of an unknown device or formation id", () => {
    store.selectDevice("nope");
    store.selectFormation("nope");
    expect(store.selectedDevice?.deviceId).toBe("agv-1");
    expect(store.state.selectedFormationId).toBe("");
  });

  it("filters the device list down to the selected formation's members", () => {
    expect(deviceIdsOf(store.filteredDevices)).toEqual(["agv-1", "agv-2", "agv-3"]);

    store.selectFormation("f-2");
    expect(deviceIdsOf(store.filteredDevices)).toEqual(["agv-1", "agv-2"]);
  });

  it("switches to scene map mode and selects a member when a formation is picked", () => {
    store.selectFormation("f-1");
    expect(store.state.selectedMapMode).toBe("scene");
    expect(store.selectedFormation?.formationId).toBe("f-1");
    expect(store.selectedDevice?.deviceId).toBe("agv-3");
  });

  it("drops the formation filter when a device outside it is selected", () => {
    store.selectFormation("f-2");
    store.selectDevice("agv-3");

    expect(store.state.selectedFormationId).toBe("");
    expect(store.selectedDevice?.deviceId).toBe("agv-3");
  });

  it("keeps the formation filter when preserveFormation is requested", () => {
    store.selectFormation("f-2");
    store.selectDevice("agv-3", { preserveFormation: true });

    expect(store.state.selectedFormationId).toBe("f-2");
    expect(store.selectedDevice?.deviceId).toBe("agv-3");
  });

  it("keeps the current device when the formation filter is cleared", () => {
    store.selectFormation("f-1");
    store.clearFormationSelection();

    expect(store.state.selectedFormationId).toBe("");
    expect(store.selectedDevice?.deviceId).toBe("agv-3");
  });

  it("summarizes fleet counts and the current focus", () => {
    expect(store.summary).toEqual({
      totalCount: 3,
      onlineCount: 2,
      alertTotal: 0,
      focusName: "车 agv-1",
    });

    store.selectFormation("f-2");
    expect(store.summary.focusName).toBe("编队 f-2");
  });

  it("limits scene devices to formation members sharing the scene and exposing a map", () => {
    ingest(
      snapshotPayload(
        [
          rawDevice("agv-1"),
          rawDevice("agv-2", { rosMapEnabled: false }),
          rawDevice("agv-3", { sceneId: "dock", runtimeSceneId: "dock" }),
        ],
        [rawFormation("f-1", ["agv-1", "agv-2", "agv-3"], { sceneId: "yard" })],
      ),
    );

    // No formation selected: every vehicle in the selected device's scene, minus
    // the ones excluded from the ROS map. agv-3 stands in another scene.
    expect(deviceIdsOf(store.sceneDevices)).toEqual(["agv-1"]);

    store.selectFormation("f-1");
    expect(store.formationSceneId).toBe("yard");
    expect(deviceIdsOf(store.sceneDevices)).toEqual(["agv-1"]);
  });

  it("groups alerts by severity, newest first, annotated with their device", () => {
    ingest(
      snapshotPayload([
        rawDevice("agv-1", {
          alerts: [
            rawAlert("a-old", "critical", { ts: "2026-08-26T09:00:00.000Z" }),
            rawAlert("a-notice", "notice"),
          ],
        }),
        rawDevice("agv-2", {
          deviceName: "叉车 2",
          alerts: [
            rawAlert("a-new", "critical", { ts: "2026-08-26T11:00:00.000Z" }),
            rawAlert("a-warn", "warning"),
          ],
        }),
      ]),
    );

    expect(store.groupedAlerts.critical.map((alert) => alert.id)).toEqual(["a-new", "a-old"]);
    expect(store.groupedAlerts.critical[0]).toMatchObject({
      deviceId: "agv-2",
      deviceName: "叉车 2",
    });
    expect(store.groupedAlerts.warning).toHaveLength(1);
    expect(store.groupedAlerts.notice).toHaveLength(1);
    expect(store.summary.alertTotal).toBe(4);
  });

  it("maps device health to a display tone", () => {
    ingest(
      snapshotPayload([
        rawDevice("d-normal"),
        rawDevice("d-offline", { online: false }),
        rawDevice("d-critical", { errorCode: { code: 7, info: "急停", stamp: null } }),
        rawDevice("d-warning", { warningCode: { code: 3, info: "低压", stamp: null } }),
        rawDevice("d-notice", { infoCode: { code: 1, info: "提示", stamp: null } }),
      ]),
    );

    const tones = Object.fromEntries(
      store.sortedDevices.map((device) => [device.deviceId, store.getDeviceTone(device)]),
    );
    expect(tones).toEqual({
      "d-critical": "critical",
      "d-normal": "normal",
      "d-notice": "notice",
      "d-offline": "offline",
      "d-warning": "warning",
    });
  });
});

describe("fleet store payload ingestion", () => {
  it("replaces the roster and adopts fleet metadata from a full snapshot", () => {
    ingest(baseSnapshot());

    expect(store.state.fleetName).toBe("测试车队");
    expect(store.state.topicPattern).toBe("/fleet/{deviceId}/vehicle_info");
    expect(store.state.lastSource).toBe("mqtt");
    expect(store.state.lastUpdateAt).toBeTruthy();
    expect(deviceIdsOf(store.sortedDevices)).toEqual(["agv-1", "agv-2", "agv-3"]);

    ingest(snapshotPayload([rawDevice("agv-2")]));

    expect(deviceIdsOf(store.sortedDevices)).toEqual(["agv-2"]);
    // A device-only snapshot carries no formations, so the roster is left alone.
    expect(store.sortedFormations.map((formation) => formation.formationId)).toEqual([
      "f-1",
      "f-2",
    ]);
  });

  it("merges a delta onto the existing device instead of replacing it", () => {
    ingest(baseSnapshot());
    ingest({
      deviceId: "agv-1",
      vehicle_info: { speed: 2.5 },
      stamp: "2026-08-26T10:05:00.000Z",
    });

    const device = store.state.devicesById["agv-1"];
    expect(device.vehicleInfo.speed).toBe(2.5);
    // Fields absent from the delta keep their previous readings.
    expect(device.vehicleInfo.soc).toBe(80);
    expect(device.deviceName).toBe("车 agv-1");
    expect(device.gps.lat).toBe(31.2);
    expect(device.topic).toBe("/fleet/agv-1/vehicle_info");
    expect(device.stamp).toBe("2026-08-26T10:05:00.000Z");
    expect(deviceIdsOf(store.sortedDevices)).toEqual(["agv-1", "agv-2", "agv-3"]);
  });

  it("adds an unknown device from a single-device payload without dropping the rest", () => {
    ingest(baseSnapshot());
    ingest({ deviceId: "agv-9", deviceName: "新车", vehicle_info: { soc: 42 } });

    expect(deviceIdsOf(store.sortedDevices)).toEqual(["agv-1", "agv-2", "agv-3", "agv-9"]);
    expect(store.state.devicesById["agv-9"].vehicleInfo.soc).toBe(42);
  });

  it("resolves the device id from a topic envelope with a stringified payload", () => {
    ingest(baseSnapshot());
    ingest({
      topic: "/fleet/agv-2/vehicle_info",
      payload: JSON.stringify({ vehicle_info: { soc: 17 } }),
    });

    const device = store.state.devicesById["agv-2"];
    expect(device.vehicleInfo.soc).toBe(17);
    expect(device.deviceName).toBe("车 agv-2");
    expect(store.sortedDevices).toHaveLength(3);
  });

  it("replaces the formation roster when a payload carries formations", () => {
    ingest(baseSnapshot());
    ingest({ deviceId: "agv-1", formations: [rawFormation("f-9", ["agv-1", "agv-2"])] });

    expect(store.sortedFormations.map((formation) => formation.formationId)).toEqual(["f-9"]);
    expect(store.sortedFormations[0].deviceCount).toBe(2);
  });

  it("replaces the roster from a bare device array", () => {
    ingest(baseSnapshot());
    ingest([rawDevice("agv-7")]);

    expect(deviceIdsOf(store.sortedDevices)).toEqual(["agv-7"]);
    // An array carries no metadata, so the fleet name/topic pattern are kept.
    expect(store.state.fleetName).toBe("测试车队");
  });

  it("tolerates an unrecognised object payload", () => {
    ingest(baseSnapshot());

    expect(() => ingest({ hello: "world" })).not.toThrow();
    // Treated as a single unknown device; the existing roster survives.
    expect(store.sortedDevices).toHaveLength(4);
    expect(store.state.devicesById["agv-1"]).toBeTruthy();
  });

  it("rejects payloads that are not JSON objects", () => {
    // The manual bridge surfaces the error to its caller; inbound WebSocket
    // frames are swallowed instead (see fleetRealtime.test.ts).
    expect(() => ingest(null)).toThrow("消息必须是 JSON 对象");
    expect(() => ingest("not-json")).toThrow();
    expect(store.sortedDevices).toHaveLength(0);
  });
});

describe("fleet store movement trails", () => {
  it("records a point per move and ignores sub-threshold jitter", () => {
    ingest(snapshotPayload([rawDevice("agv-1")]));
    expect(store.trailsByDeviceId["agv-1"]).toEqual([{ x: 0, y: 0 }]);

    ingest(poseDelta("agv-1", 0.05));
    expect(store.trailsByDeviceId["agv-1"]).toHaveLength(1);

    ingest(poseDelta("agv-1", 1));
    expect(store.trailsByDeviceId["agv-1"]).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
  });

  it("caps each trail at TRAIL_MAX_POINTS, keeping the newest samples", () => {
    ingest(snapshotPayload([rawDevice("agv-1")]));
    for (let step = 1; step <= 300; step += 1) {
      ingest(poseDelta("agv-1", step * 0.5));
    }

    const trail = store.trailsByDeviceId["agv-1"];
    expect(trail).toHaveLength(TRAIL_MAX_POINTS);
    expect(trail[trail.length - 1]).toEqual({ x: 150, y: 0 });
    // 301 samples were recorded, so the oldest 61 have been dropped.
    expect(trail[0]).toEqual({ x: 30.5, y: 0 });
  });

  it("clears one trail by id and defaults to the selected device", () => {
    ingest(
      snapshotPayload([
        rawDevice("agv-1"),
        rawDevice("agv-2", { fusionLoc: { x: 5, y: 5, yaw: 0 } }),
      ]),
    );
    expect(Object.keys(store.trailsByDeviceId).sort()).toEqual(["agv-1", "agv-2"]);

    store.clearTrail("agv-2");
    expect(store.trailsByDeviceId["agv-2"]).toBeUndefined();

    expect(store.selectedDevice?.deviceId).toBe("agv-1");
    store.clearTrail();
    expect(store.trailsByDeviceId).toEqual({});

    expect(() => store.clearTrail("ghost")).not.toThrow();
  });

  it("prunes trails for devices missing from a replacement snapshot", () => {
    ingest(
      snapshotPayload([
        rawDevice("agv-1"),
        rawDevice("agv-2", { fusionLoc: { x: 5, y: 5, yaw: 0 } }),
      ]),
    );
    ingest(snapshotPayload([rawDevice("agv-1")]));

    expect(Object.keys(store.trailsByDeviceId)).toEqual(["agv-1"]);
  });
});

describe("fleet store buildFleetSnapshot", () => {
  it("exports an id-sorted, detached copy of the current fleet", () => {
    ingest(baseSnapshot());

    const snapshot = store.buildFleetSnapshot();
    expect(deviceIdsOf(snapshot.devices)).toEqual(["agv-1", "agv-2", "agv-3"]);
    expect(snapshot.formations.map((formation) => formation.formationId)).toEqual(["f-1", "f-2"]);
    expect(snapshot.fleetName).toBe("测试车队");
    expect(snapshot.updatedAt).toBe(store.state.lastUpdateAt);

    snapshot.devices[0].deviceName = "被改名";
    expect(store.state.devicesById["agv-1"].deviceName).toBe("车 agv-1");
  });
});

/**
 * Map surface preference.
 *
 * It used to live only in memory, so every refresh threw an operator watching a
 * vehicle on the ROS scene map back to the GPS view.
 */
describe("fleet store map mode persistence", () => {
  const MAP_MODE_KEY = "navfleet:map-mode";

  it("remembers the chosen surface", () => {
    store.setMapMode("scene");
    expect(window.localStorage.getItem(MAP_MODE_KEY)).toBe("scene");
  });

  it("opens on the remembered surface in a fresh store", () => {
    window.localStorage.setItem(MAP_MODE_KEY, "scene");

    setActivePinia(createPinia());
    expect(useFleetStore().state.selectedMapMode).toBe("scene");
  });

  it("ignores a stored value that is not a surface", () => {
    // Anything could be in localStorage — another app, an old build, a user
    // poking at devtools. An unrecognised value must not leave the map blank.
    window.localStorage.setItem(MAP_MODE_KEY, "definitely-not-a-map");

    setActivePinia(createPinia());
    expect(useFleetStore().state.selectedMapMode).toBe("gps");
  });
});
