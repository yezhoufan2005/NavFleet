import { describe, it, expect } from "vitest";
import { MissingDeviceIdError, normalizeDevice, normalizePayload, hasGps } from "../src/normalize";

describe("hasGps", () => {
  it("is true only when both lat and lng are finite", () => {
    expect(hasGps({ lat: 31.2, lng: 121.4, heading: null })).toBe(true);
    expect(hasGps({ lat: null, lng: 121.4, heading: null })).toBe(false);
  });
});

describe("normalizeDevice", () => {
  it("builds a canonical snapshot from a minimal raw payload", () => {
    const device = normalizeDevice({ deviceId: "agv-a01", stamp: 1712472000000 });
    expect(device.deviceId).toBe("agv-a01");
    expect(device.deviceName).toBe("agv-a01");
    expect(device.topic).toBe("/fleet/agv-a01/vehicle_info");
    expect(device.online).toBe(true);
    expect(device.alerts).toEqual([]);
  });

  it("accepts both snake_case and camelCase nested fields", () => {
    const snake = normalizeDevice({
      deviceId: "d1",
      fusion_loc: { x: 1, y: 2, yaw: 0.5 },
      vehicle_info: { control_mode: 1, soc: 80 },
      scene_id: "scene-x",
    });
    const camel = normalizeDevice({
      deviceId: "d1",
      fusionLoc: { x: 1, y: 2, yaw: 0.5 },
      vehicleInfo: { controlMode: 1, soc: 80 },
      sceneId: "scene-x",
    });
    expect(snake.fusionLoc).toEqual({ x: 1, y: 2, yaw: 0.5 });
    expect(camel.fusionLoc).toEqual({ x: 1, y: 2, yaw: 0.5 });
    expect(snake.vehicleInfo.controlMode).toBe(1);
    expect(camel.vehicleInfo.controlMode).toBe(1);
    expect(snake.runtimeSceneId).toBe("scene-x");
    expect(camel.runtimeSceneId).toBe("scene-x");
  });

  it("falls back to lidarLoc when fusionLoc has no valid pose", () => {
    const device = normalizeDevice({
      deviceId: "d2",
      lidar_loc: { x: 5, y: 6, yaw: 1 },
    });
    expect(device.fusionLoc).toEqual({ x: 5, y: 6, yaw: 1 });
  });

  it("refuses a frame that names no device rather than inventing an id for it", () => {
    // The id comes from the body, or from the topic before this is called (normalizePayload).
    // It used to fall back to `device-<timestamp>`: a new phantom vehicle per frame.
    expect(() => normalizeDevice({ speed: 1 }, null, "/fleet/agv-b07/vehicle_info")).toThrow(
      MissingDeviceIdError,
    );
  });

  it("synthesizes a low-SOC warning rule alert", () => {
    const device = normalizeDevice({ deviceId: "d3", vehicle_info: { soc: 12 } });
    const lowSoc = device.alerts.find((a) => a.id === "d3-low-soc");
    expect(lowSoc?.severity).toBe("warning");
  });

  it("does not raise a low-SOC alert at healthy charge", () => {
    const device = normalizeDevice({ deviceId: "d3", vehicle_info: { soc: 80 } });
    expect(device.alerts.find((a) => a.id === "d3-low-soc")).toBeUndefined();
  });

  it("synthesizes an offline critical alert when online is false", () => {
    const device = normalizeDevice({ deviceId: "d4", online: false });
    const offline = device.alerts.find((a) => a.id === "d4-offline");
    expect(offline?.severity).toBe("critical");
  });

  it("derives alerts from non-zero warning/error codes", () => {
    const device = normalizeDevice({
      deviceId: "d5",
      warning_code: { code: 42, info: "battery hot" },
      error_code: { code: 7, info: "motor fault" },
    });
    expect(device.alerts.find((a) => a.source === "warning_code")?.code).toBe(42);
    expect(device.alerts.find((a) => a.source === "error_code")?.severity).toBe("critical");
  });
});

describe("report-code text across frames", () => {
  const frame = (code: number, info?: string) => ({
    deviceId: "agv-a01",
    stamp: 1712472000000,
    info_code: { code, ...(info !== undefined ? { info } : {}) },
  });

  it("drops the previous code's text when a frame clears the code", () => {
    const first = normalizeDevice(frame(1302, "任务完成，待命中"));
    const cleared = normalizeDevice(frame(0, ""), first);
    expect(cleared.infoCode).toMatchObject({ code: 0, info: "" });
  });

  it("keeps the text for the same code when a frame omits it", () => {
    const first = normalizeDevice(frame(1302, "任务完成，待命中"));
    const again = normalizeDevice(frame(1302), first);
    expect(again.infoCode.info).toBe("任务完成，待命中");
  });
});

describe("normalizePayload device-id extraction", () => {
  it("honors a custom (non-/fleet/) topic pattern", () => {
    const result = normalizePayload(
      { topic: "/org/site/agv-z9/vehicle_info", payload: { speed: 1 } },
      new Map(),
      "fleet",
      "/org/site/{deviceId}/vehicle_info",
    );
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]?.deviceId).toBe("agv-z9");
  });

  it("still handles the default /fleet/ scheme", () => {
    const result = normalizePayload(
      { topic: "/fleet/agv-a01/vehicle_info", payload: { speed: 1 } },
      new Map(),
      "fleet",
      "/fleet/{deviceId}/vehicle_info",
    );
    expect(result.devices[0]?.deviceId).toBe("agv-a01");
  });
});
