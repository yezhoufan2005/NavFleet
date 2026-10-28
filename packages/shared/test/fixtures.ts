import type { CodeState, DeviceSnapshot } from "../src/index";

const emptyCode = (): CodeState => ({ code: 0, info: "", stamp: null });

/** A device with every field at its "nothing reported" value, for the pure evaluators. */
export const blankDevice = (deviceId: string): DeviceSnapshot => ({
  deviceId,
  deviceName: deviceId,
  topic: "",
  online: true,
  stamp: new Date().toISOString(),
  sceneId: "",
  runtimeSceneId: "",
  defaultSceneId: "",
  gpsEnabled: true,
  rosMapEnabled: true,
  tags: [],
  formationIds: [],
  gps: { lat: null, lng: null, heading: null },
  fusionLoc: { x: null, y: null, yaw: null },
  lidarLoc: { x: null, y: null, yaw: null },
  vehicleInfo: {
    controlMode: null,
    gear: null,
    speed: null,
    omega: null,
    soc: null,
  },
  taskStatus: null,
  platformTaskStatus: null,
  infoCode: emptyCode(),
  warningCode: emptyCode(),
  errorCode: emptyCode(),
  speedLimit: { limit: null, slowdownTime: null, stamp: null, moduleName: "" },
  alerts: [],
  extra: {},
});
