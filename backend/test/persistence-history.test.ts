import { describe, it, expect } from "vitest";
import { Persistence } from "../src/persistence";
import type { DeviceSnapshot } from "../src/types";

function sample(deviceId: string, stamp: string, x: number): DeviceSnapshot {
  return {
    deviceId,
    deviceName: deviceId,
    topic: `/fleet/${deviceId}/vehicle_info`,
    stamp,
    online: true,
    sceneId: "",
    runtimeSceneId: "",
    defaultSceneId: "",
    mapProfile: "lanelet",
    gpsEnabled: true,
    rosMapEnabled: true,
    tags: [],
    formationIds: [],
    gps: { lat: null, lng: null, heading: null },
    fusionLoc: { x, y: x, yaw: 0 },
    lidarLoc: { x: null, y: null, yaw: null },
    vehicleInfo: { controlMode: null, gear: null, speed: 1, omega: null, soc: 80 },
    taskStatus: 1,
    platformTaskStatus: null,
    infoCode: { code: 0, info: "", stamp: null },
    warningCode: { code: 0, info: "", stamp: null },
    errorCode: { code: 0, info: "", stamp: null },
    speedLimit: { limit: null, slowdownTime: null, stamp: null, moduleName: "" },
    alerts: [],
    extra: {},
  } as DeviceSnapshot;
}

describe("Persistence in-memory history fallback", () => {
  it("serves recent telemetry without Mongo, newest-first, time-filtered and limited", async () => {
    // Never call connect(): db stays null, so the in-memory buffer is exercised.
    const persistence = new Persistence();
    await persistence.writeTelemetry(sample("agv-x", "2026-01-01T00:00:00Z", 1));
    await persistence.writeTelemetry(sample("agv-x", "2026-01-01T00:00:10Z", 2));
    await persistence.writeTelemetry(sample("agv-y", "2026-01-01T00:00:05Z", 9));

    const all = (await persistence.queryHistory({ deviceId: "agv-x" })) as Array<{
      measurements: { fusionLoc: { x: number } };
    }>;
    expect(all).toHaveLength(2);
    // Newest-first, matching the Mongo query contract.
    expect(all[0].measurements.fusionLoc.x).toBe(2);

    // Per-device isolation.
    expect(await persistence.queryHistory({ deviceId: "agv-y" })).toHaveLength(1);

    // Time-window filtering (inclusive lower bound).
    const windowed = (await persistence.queryHistory({
      deviceId: "agv-x",
      from: "2026-01-01T00:00:05Z",
    })) as Array<{ measurements: { fusionLoc: { x: number } } }>;
    expect(windowed).toHaveLength(1);
    expect(windowed[0].measurements.fusionLoc.x).toBe(2);

    // Limit is honoured.
    expect(await persistence.queryHistory({ deviceId: "agv-x", limit: 1 })).toHaveLength(1);
  });
});
