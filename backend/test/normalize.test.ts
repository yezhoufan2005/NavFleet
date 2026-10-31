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

  it("takes an explicit empty text as the text, and clears stale words on code 0", () => {
    // A snapshot restored with text left on code 0 must be cleaned by the next frame, which
    // carries `{ code: 0, info: "" }` — that used to fall through to the inherited text.
    const stale = normalizeDevice(frame(0, "路径规划超时，已触发急停"));
    expect(stale.infoCode.info).toBe("");
    const restored = { ...stale, infoCode: { code: 0, info: "路径规划超时", stamp: null } };
    expect(normalizeDevice(frame(0, ""), restored).infoCode.info).toBe("");
    const withText = normalizeDevice(frame(1302, "任务完成"));
    expect(normalizeDevice(frame(1302, ""), withText).infoCode.info).toBe("");
  });

  it("does not give a new code the previous code's onset", () => {
    const first = normalizeDevice({
      deviceId: "agv-a01",
      stamp: "2026-09-01T08:00:00Z",
      error_code: { code: 5101, info: "急停", stamp: "2026-09-01T08:00:00Z" },
    });
    const next = normalizeDevice(
      { deviceId: "agv-a01", stamp: "2026-09-01T09:30:00Z", error_code: { code: 5102 } },
      first,
    );
    expect(next.errorCode.stamp).toBe("2026-09-01T09:30:00.000Z");
    expect(next.alerts.find((alert) => alert.code === 5102)?.ts).toBe("2026-09-01T09:30:00.000Z");
    // The same code carries its onset forward.
    const same = normalizeDevice(
      { deviceId: "agv-a01", stamp: "2026-09-01T09:31:00Z", error_code: { code: 5102 } },
      next,
    );
    expect(same.errorCode.stamp).toBe("2026-09-01T09:30:00.000Z");
  });
});

describe("a frame from a vehicle whose clock cannot be trusted", () => {
  const receivedAt = Date.parse("2026-09-01T08:00:00Z");
  const clock = { receivedAt, toleranceMs: 60_000 };

  it("shifts every time in the frame by the same offset, not only the frame stamp", () => {
    // The RTC went back to 1970 after a reboot: the frame stamp and the code's onset both
    // come from it. The code started 30 s before this frame.
    const device = normalizeDevice(
      {
        deviceId: "agv-a01",
        stamp: "1970-01-07T22:40:30Z",
        error_code: { code: 5101, info: "急停", stamp: "1970-01-07T22:40:00Z" },
        speed_limit: { limit: 0.5, stamp: "1970-01-07T22:40:20Z" },
      },
      null,
      "",
      undefined,
      clock,
    );
    expect(device.stamp).toBe("2026-09-01T08:00:00.000Z");
    expect(device.errorCode.stamp).toBe("2026-09-01T07:59:30.000Z");
    expect(device.speedLimit.stamp).toBe("2026-09-01T07:59:50.000Z");
    expect(device.alerts.find((alert) => alert.code === 5101)?.ts).toBe("2026-09-01T07:59:30.000Z");
  });

  it("reports which vehicle and by how much", () => {
    const seen: Array<{ deviceId: string; skewMs: number }> = [];
    normalizeDevice({ deviceId: "agv-fast", stamp: "2026-09-01T10:00:00Z" }, null, "", undefined, {
      ...clock,
      onUntrusted: (event) => seen.push(event),
    });
    expect(seen).toEqual([{ deviceId: "agv-fast", skewMs: 2 * 3_600_000 }]);
  });

  it("does not throw on a stamp in nanoseconds", () => {
    const device = normalizeDevice(
      {
        deviceId: "agv-ros",
        stamp: receivedAt * 1e6,
        error_code: { code: 5101, stamp: receivedAt * 1e6 },
      },
      null,
      "",
      undefined,
      clock,
    );
    expect(device.stamp).toBe("2026-09-01T08:00:00.000Z");
    expect(device.errorCode.stamp).toBe("2026-09-01T08:00:00.000Z");
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
