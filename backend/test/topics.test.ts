import { describe, it, expect } from "vitest";
import { buildTopicScheme } from "../src/topics";

describe("buildTopicScheme", () => {
  const scheme = buildTopicScheme("/fleet/{deviceId}/vehicle_info");

  it("derives wildcard subscriptions for telemetry and status", () => {
    expect(scheme.telemetrySubscription).toBe("/fleet/+/vehicle_info");
    expect(scheme.statusSubscription).toBe("/fleet/+/status");
  });

  it("extracts the device id from telemetry and status topics", () => {
    expect(scheme.extractDeviceId("/fleet/agv-a01/vehicle_info")).toBe("agv-a01");
    expect(scheme.extractDeviceId("/fleet/agv-b07/status")).toBe("agv-b07");
  });

  it("returns empty string for non-matching topics", () => {
    expect(scheme.extractDeviceId("/other/agv-a01/vehicle_info")).toBe("");
    expect(scheme.extractDeviceId("/fleet/agv-a01/extra/vehicle_info")).toBe("");
  });

  it("identifies status topics precisely", () => {
    expect(scheme.isStatusTopic("/fleet/agv-a01/status")).toBe(true);
    expect(scheme.isStatusTopic("/fleet/agv-a01/vehicle_info")).toBe(false);
  });

  it("normalizes a pattern that omits the leading slash", () => {
    const s = buildTopicScheme("fleet/{deviceId}/telemetry");
    expect(s.telemetrySubscription).toBe("/fleet/+/telemetry");
    expect(s.statusSubscription).toBe("/fleet/+/status");
    expect(s.extractDeviceId("/fleet/x1/telemetry")).toBe("x1");
  });

  it("supports a custom multi-segment prefix", () => {
    const s = buildTopicScheme("/org/site/{deviceId}/vehicle_info");
    expect(s.telemetrySubscription).toBe("/org/site/+/vehicle_info");
    expect(s.statusSubscription).toBe("/org/site/+/status");
    expect(s.extractDeviceId("/org/site/robot-9/status")).toBe("robot-9");
  });
});
