import { describe, it, expect } from "vitest";
import {
  normalizeDevice,
  normalizeFormation,
  dedupeAlerts,
  mergeDevice,
  normalizePathPoint,
  pointsAreNear,
  pickTrailPose,
  toTimestampMs,
} from "../../src/lib/fleetNormalize";

describe("normalizeDevice", () => {
  it("maps snake_case telemetry into the canonical camelCase shape", () => {
    const device = normalizeDevice({
      device_id: "agv-1",
      device_name: "叉车 1",
      vehicle_info: { control_mode: 1, gear: 2, soc: 80, speed: 1.5 },
      fusion_loc: { x: 3, y: 4, yaw: 0.2 },
      scene_id: "warehouse-a",
    });

    expect(device.deviceId).toBe("agv-1");
    expect(device.deviceName).toBe("叉车 1");
    expect(device.vehicleInfo.controlMode).toBe(1);
    expect(device.vehicleInfo.soc).toBe(80);
    expect(device.fusionLoc).toEqual({ x: 3, y: 4, yaw: 0.2 });
    expect(device.sceneId).toBe("warehouse-a");
  });

  it("derives deviceId from an MQTT topic when none is provided", () => {
    const device = normalizeDevice({ vehicle_info: { soc: 50 } }, "/fleet/robot-9/vehicle_info");
    expect(device.deviceId).toBe("robot-9");
  });

  it("falls back to lidar pose when fusion pose is missing", () => {
    const device = normalizeDevice({
      deviceId: "agv-2",
      lidar_loc: { x: 10, y: 20, yaw: 1 },
    });
    expect(device.fusionLoc).toEqual({ x: 10, y: 20, yaw: 1 });
  });

  it("derives a critical alert from a non-zero error code", () => {
    const device = normalizeDevice({
      deviceId: "agv-3",
      error_code: { code: 42, info: "急停触发" },
    });
    const critical = device.alerts.find(
      (alert: { severity: string }) => alert.severity === "critical",
    );
    expect(critical).toBeTruthy();
    expect(critical.code).toBe(42);
  });

  it("derives a low-battery warning when soc drops below the threshold", () => {
    const device = normalizeDevice({ deviceId: "agv-4", vehicle_info: { soc: 12 } });
    const lowSoc = device.alerts.find((alert: { id: string }) => alert.id.endsWith("low-soc"));
    expect(lowSoc).toBeTruthy();
    expect(lowSoc.severity).toBe("warning");
  });

  it("derives an offline alert when the device is marked offline", () => {
    const device = normalizeDevice({ deviceId: "agv-5", online: false });
    const offline = device.alerts.find((alert: { id: string }) => alert.id.endsWith("offline"));
    expect(offline).toBeTruthy();
    expect(offline.severity).toBe("critical");
  });
});

describe("mergeDevice", () => {
  it("returns the incoming device when there is no existing entry", () => {
    const incoming = normalizeDevice({ deviceId: "agv-6" });
    expect(mergeDevice(null, incoming)).toBe(incoming);
  });

  it("deep-merges nested telemetry so partial updates keep prior values", () => {
    const existing = normalizeDevice({ deviceId: "agv-7", vehicle_info: { soc: 90, speed: 1 } });
    // A partial update: the normalizer carries prior fields forward via existingDevice,
    // then mergeDevice deep-merges the nested telemetry objects.
    const incoming = normalizeDevice(
      { deviceId: "agv-7", vehicle_info: { speed: 2 } },
      "",
      existing,
    );
    const merged = mergeDevice(existing, incoming);
    expect(merged.vehicleInfo.speed).toBe(2);
    // soc is absent from the incoming payload; the prior reading is preserved.
    expect(merged.vehicleInfo.soc).toBe(90);
  });
});

describe("normalizeFormation", () => {
  it("normalizes ids and counts device membership", () => {
    const formation = normalizeFormation({
      id: "line-a",
      name: "产线A",
      deviceIds: ["a", "b", "a"],
    });
    expect(formation.formationId).toBe("line-a");
    expect(formation.formationName).toBe("产线A");
    expect(formation.deviceIds).toEqual(["a", "b", "a"]);
    expect(formation.deviceCount).toBe(3);
  });
});

describe("dedupeAlerts", () => {
  it("removes duplicates and sorts newest-first", () => {
    const alerts = [
      { id: "x", severity: "warning", title: "t", ts: "2026-01-01T00:00:00Z" },
      { id: "x", severity: "warning", title: "t", ts: "2026-01-01T00:00:00Z" },
      { id: "y", severity: "critical", title: "t2", ts: "2026-01-02T00:00:00Z" },
    ];
    const result = dedupeAlerts(alerts);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("y");
  });
});

describe("path + trail helpers", () => {
  it("rounds path points and rejects non-finite coordinates", () => {
    expect(normalizePathPoint({ x: 1.23456, y: 2.34567 })).toEqual({ x: 1.235, y: 2.346 });
    expect(normalizePathPoint({ x: NaN, y: 1 })).toBeNull();
  });

  it("detects near-coincident points within epsilon", () => {
    expect(pointsAreNear({ x: 0, y: 0 }, { x: 0.01, y: 0.01 })).toBe(true);
    expect(pointsAreNear({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });

  it("prefers fusion pose, then lidar, for trail recording", () => {
    expect(pickTrailPose({ fusionLoc: { x: 1, y: 2 }, lidarLoc: { x: 9, y: 9 } })).toEqual({
      x: 1,
      y: 2,
    });
    expect(pickTrailPose({ fusionLoc: { x: null, y: null }, lidarLoc: { x: 5, y: 6 } })).toEqual({
      x: 5,
      y: 6,
    });
    expect(pickTrailPose({ fusionLoc: {}, lidarLoc: {} })).toBeNull();
  });
});

describe("toTimestampMs", () => {
  it("upconverts second-precision epochs to milliseconds", () => {
    expect(toTimestampMs(1_000_000)).toBe(1_000_000 * 1000);
    expect(toTimestampMs(2_000_000_000_000)).toBe(2_000_000_000_000);
  });
});
