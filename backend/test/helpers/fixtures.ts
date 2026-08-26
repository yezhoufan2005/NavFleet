import type {
  DeviceSnapshot,
  FleetSnapshot,
  FormationSnapshot,
  LaneletOverlay,
  SceneMapDefinition,
  UserRecord,
} from "../../src/types";

/**
 * Domain fixtures shared by the backend tests. Deliberately free of runtime
 * imports from src/ (types only), so a test that needs to point
 * CONFIG_ROOT_PATH at a temp directory before src/config is evaluated can use
 * them without pulling the config singleton in early.
 */

export const UPDATED_AT = "2026-01-01T00:00:00.000Z";
export const SCENE_ID = "scene-a";
export const DEVICE_ID = "agv-1";

export const sampleDevice = (): DeviceSnapshot => ({
  deviceId: DEVICE_ID,
  deviceName: "测试车 1",
  topic: `/fleet/${DEVICE_ID}/vehicle_info`,
  online: true,
  stamp: UPDATED_AT,
  sceneId: SCENE_ID,
  runtimeSceneId: SCENE_ID,
  defaultSceneId: SCENE_ID,
  mapProfile: "lanelet",
  gpsEnabled: true,
  rosMapEnabled: true,
  tags: ["demo"],
  formationIds: ["formation-a"],
  gps: { lat: null, lng: null, heading: null },
  fusionLoc: { x: 1, y: 2, yaw: 0 },
  lidarLoc: { x: null, y: null, yaw: null },
  vehicleInfo: { controlMode: 1, gear: 1, speed: 1.5, omega: 0, soc: 80 },
  taskStatus: 1,
  platformTaskStatus: null,
  infoCode: { code: 0, info: "", stamp: null },
  warningCode: { code: 0, info: "", stamp: null },
  errorCode: { code: 0, info: "", stamp: null },
  speedLimit: { limit: null, slowdownTime: null, stamp: null, moduleName: "" },
  alerts: [],
  extra: {},
});

export const sampleFormation = (): FormationSnapshot => ({
  formationId: "formation-a",
  formationName: "编队 A",
  deviceIds: [DEVICE_ID],
  deviceCount: 1,
  onlineCount: 1,
  sceneId: SCENE_ID,
  description: "",
  color: "",
});

export const sampleScene = (): SceneMapDefinition => ({
  sceneId: SCENE_ID,
  sceneName: "场景 A",
  mapFrame: "map",
  resolution: 0.05,
  origin: { x: 0, y: 0, yaw: 0 },
  occupiedThresh: 0.65,
  freeThresh: 0.2,
  negate: 0,
  width: 100,
  height: 200,
  bounds: { minX: 0, maxX: 5, minY: 0, maxY: 10 },
});

export const sampleOverlay = (): LaneletOverlay => ({
  sceneId: SCENE_ID,
  source: "scene-a.osm",
  generator: "lanelet2",
  projection: { type: "local-tangent-plane", originLat: 31.23, originLng: 121.47 },
  bounds: { minX: 0, minY: 0, maxX: 5, maxY: 10 },
  stats: { nodeCount: 4, wayCount: 2, laneletCount: 1 },
  lanelets: [],
});

export const sampleSnapshot = (): FleetSnapshot => ({
  fleetName: "测试车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  updatedAt: UPDATED_AT,
  devices: [sampleDevice()],
  formations: [sampleFormation()],
});

export const sampleHistoryPoint = (): Record<string, unknown> => ({
  deviceId: DEVICE_ID,
  ts: UPDATED_AT,
  measurements: { fusionLoc: { x: 1, y: 2, yaw: 0 } },
});

export const sampleAlert = (): Record<string, unknown> => ({
  deviceId: DEVICE_ID,
  alertId: `${DEVICE_ID}-low-soc`,
  severity: "warning",
  status: "active",
});

export const adminUser = (): UserRecord => ({
  username: "admin",
  passwordHash: "not-checked-by-the-stub",
  role: "admin",
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
});

/** A minimal Lanelet2 OSM document: 4 nodes, 2 ways, 1 lanelet relation. */
export const SAMPLE_OSM = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="31.2300" lon="121.4700"/>
  <node id="2" lat="31.2301" lon="121.4700"/>
  <node id="3" lat="31.2300" lon="121.4702"/>
  <node id="4" lat="31.2301" lon="121.4702"/>
  <way id="10">
    <nd ref="1"/>
    <nd ref="2"/>
  </way>
  <way id="11">
    <nd ref="3"/>
    <nd ref="4"/>
  </way>
  <relation id="100">
    <tag k="type" v="lanelet"/>
    <tag k="subtype" v="road"/>
    <member type="way" ref="10" role="left"/>
    <member type="way" ref="11" role="right"/>
  </relation>
</osm>`;
