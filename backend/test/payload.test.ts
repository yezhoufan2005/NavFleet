import { describe, it, expect } from "vitest";
import {
  normalizeDevice,
  mergeDevice,
  normalizePayload,
  buildFleetSnapshot,
} from "../src/normalize";
import type { DeviceSnapshot } from "../src/types";

describe("mergeDevice", () => {
  it("returns the incoming device when no existing device is present", () => {
    const incoming = normalizeDevice({ deviceId: "m1" });
    expect(mergeDevice(null, incoming)).toBe(incoming);
  });

  it("takes the incoming alerts array wholesale and merges top-level fields", () => {
    const existing = normalizeDevice({ deviceId: "m2", vehicle_info: { soc: 90 } });
    const incoming = normalizeDevice({ deviceId: "m2", online: false });
    const merged = mergeDevice(existing, incoming);
    expect(merged.online).toBe(false);
    // alerts come from the incoming snapshot (offline rule alert present)
    expect(merged.alerts).toBe(incoming.alerts);
    expect(merged.alerts.some((a) => a.id === "m2-offline")).toBe(true);
  });

  it("retains prior pose via normalizeDevice's existingDevice fallback when omitted", () => {
    const existing = normalizeDevice({ deviceId: "m3", fusion_loc: { x: 1, y: 2, yaw: 0 } });
    // new payload omits pose entirely -> falls back to existing device values
    const next = normalizeDevice({ deviceId: "m3", vehicle_info: { speed: 4 } }, existing);
    expect(next.fusionLoc).toEqual({ x: 1, y: 2, yaw: 0 });
    expect(next.vehicleInfo.speed).toBe(4);
  });
});

describe("normalizePayload", () => {
  const empty = new Map<string, DeviceSnapshot>();

  it("marks array payloads as a full replace", () => {
    const result = normalizePayload(
      [{ deviceId: "a" }, { deviceId: "b" }],
      empty,
      "fleet",
      "topic",
    );
    expect(result.replace).toBe(true);
    expect(result.devices.map((d) => d.deviceId)).toEqual(["a", "b"]);
  });

  it("marks { devices: [] } payloads as a full replace", () => {
    const result = normalizePayload({ devices: [{ deviceId: "c" }] }, empty, "f", "t");
    expect(result.replace).toBe(true);
    expect(result.devices).toHaveLength(1);
  });

  it("treats a single {topic,payload} MQTT message as an incremental update", () => {
    const result = normalizePayload(
      { topic: "/fleet/agv-x/vehicle_info", payload: { speed: 3 } },
      empty,
      "f",
      "t",
    );
    expect(result.replace).toBe(false);
    expect(result.devices[0].deviceId).toBe("agv-x");
  });

  it("parses a stringified JSON payload body", () => {
    const result = normalizePayload(
      { topic: "/fleet/agv-y/vehicle_info", payload: JSON.stringify({ vehicle_info: { soc: 55 } }) },
      empty,
      "f",
      "t",
    );
    expect(result.devices[0].deviceId).toBe("agv-y");
    expect(result.devices[0].vehicleInfo.soc).toBe(55);
  });

  it("throws on non-object, non-array payloads", () => {
    expect(() => normalizePayload("nope", empty, "f", "t")).toThrow();
  });
});

describe("buildFleetSnapshot", () => {
  it("sorts devices by stamp descending (newest first)", () => {
    const older = normalizeDevice({ deviceId: "old", stamp: 1000 });
    const newer = normalizeDevice({ deviceId: "new", stamp: 2000 });
    const snapshot = buildFleetSnapshot([older, newer], "fleet", "topic");
    expect(snapshot.devices[0].deviceId).toBe("new");
    expect(snapshot.fleetName).toBe("fleet");
  });
});
