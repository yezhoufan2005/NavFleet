import { describe, it, expect } from "vitest";
import {
  historyQuerySchema,
  alertsQuerySchema,
  ingestBodySchema,
  mqttTelemetrySchema,
  mqttStatusSchema,
  deviceIdParamSchema,
  sceneIdParamSchema,
} from "../src/validation";

describe("historyQuerySchema", () => {
  it("coerces limit to a positive integer", () => {
    const parsed = historyQuerySchema.parse({ limit: "100" });
    expect(parsed.limit).toBe(100);
  });

  it("accepts ISO and numeric timestamps", () => {
    expect(historyQuerySchema.safeParse({ from: "2024-01-01T00:00:00Z" }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ from: "1712472000000" }).success).toBe(true);
  });

  it("rejects a non-positive or non-numeric limit", () => {
    expect(historyQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(historyQuerySchema.safeParse({ from: "not-a-date" }).success).toBe(false);
  });
});

describe("alertsQuerySchema", () => {
  it("accepts known severity and status values", () => {
    expect(alertsQuerySchema.safeParse({ severity: "critical", status: "active" }).success).toBe(
      true,
    );
  });

  it("rejects unknown severity or status values", () => {
    expect(alertsQuerySchema.safeParse({ severity: "fatal" }).success).toBe(false);
    expect(alertsQuerySchema.safeParse({ status: "open" }).success).toBe(false);
  });
});

describe("ingestBodySchema", () => {
  it("accepts objects and arrays", () => {
    expect(ingestBodySchema.safeParse({ deviceId: "a" }).success).toBe(true);
    expect(ingestBodySchema.safeParse([{ deviceId: "a" }]).success).toBe(true);
  });

  it("rejects primitives", () => {
    expect(ingestBodySchema.safeParse("nope").success).toBe(false);
    expect(ingestBodySchema.safeParse(42).success).toBe(false);
  });
});

// Mirrors the exact frame published by scripts/mock-mqtt.ts (buildTelemetry), so
// this asserts the ingest gate does not break the running demo.
const mockPublishedFrame = {
  stamp: 1712472000000,
  scene_id: "warehouse-a",
  gps: { lat: 31.230612, lng: 121.473986, heading: 0 },
  fusion_loc: { x: 34.32, y: 12.32, yaw: 0 },
  lidar_loc: { x: 34.17, y: 12.2, yaw: 0 },
  vehicle_info: { control_mode: 1, gear: 1, speed: 1.3, omega: 0, soc: 81.9 },
  task_status: 1,
  platform_task_status: 1,
  info_code: { code: 1101, info: "定位稳定", stamp: 1712472000000 },
  warning_code: { code: 0, info: "", stamp: 1712472000000 },
  error_code: { code: 0, info: "", stamp: 1712472000000 },
  speed_limit: { limit: 2.5, slowdown_time: 0, stamp: 1712472000000, module_name: "dispatcher" },
};

describe("mqttTelemetrySchema", () => {
  it("accepts a realistic frame as published by scripts/mock-mqtt.ts", () => {
    expect(mqttTelemetrySchema.safeParse(mockPublishedFrame).success).toBe(true);
  });

  it("stays permissive about heterogeneous frame shapes", () => {
    expect(mqttTelemetrySchema.safeParse({}).success).toBe(true);
    expect(
      mqttTelemetrySchema.safeParse({ deviceId: "car-1", unknownVendorField: [1, 2] }).success,
    ).toBe(true);
    expect(mqttTelemetrySchema.safeParse({ stamp: "2024-01-01T00:00:00Z" }).success).toBe(true);
  });

  it("rejects an unparseable payload (which arrives as the raw string)", () => {
    // safeJsonParse in mqtt.ts hands the raw text through when JSON.parse fails.
    expect(mqttTelemetrySchema.safeParse("{not json at all").success).toBe(false);
    expect(mqttTelemetrySchema.safeParse("").success).toBe(false);
  });

  it("rejects null, arrays and primitives", () => {
    expect(mqttTelemetrySchema.safeParse(null).success).toBe(false);
    expect(mqttTelemetrySchema.safeParse([{ deviceId: "car-1" }]).success).toBe(false);
    expect(mqttTelemetrySchema.safeParse(42).success).toBe(false);
    expect(mqttTelemetrySchema.safeParse(true).success).toBe(false);
  });
});

describe("mqttStatusSchema", () => {
  it("accepts the status object published by scripts/mock-mqtt.ts", () => {
    expect(mqttStatusSchema.safeParse({ online: true, ts: 1712472000000 }).success).toBe(true);
    expect(mqttStatusSchema.safeParse({ status: "offline" }).success).toBe(true);
  });

  it("accepts a bare boolean status", () => {
    expect(mqttStatusSchema.safeParse(true).success).toBe(true);
    expect(mqttStatusSchema.safeParse(false).success).toBe(true);
  });

  it("accepts the plain-text encodings that store.parseOnline understands", () => {
    for (const value of ["offline", "0", "false", "online", "1", "true"]) {
      expect(mqttStatusSchema.safeParse(value).success).toBe(true);
    }
  });

  it("accepts plain-text status case-insensitively and with surrounding space", () => {
    expect(mqttStatusSchema.safeParse("OFFLINE").success).toBe(true);
    expect(mqttStatusSchema.safeParse("  Online \n").success).toBe(true);
  });

  it("rejects garbage text, null, arrays and numbers", () => {
    expect(mqttStatusSchema.safeParse("{not json").success).toBe(false);
    expect(mqttStatusSchema.safeParse("offline-ish").success).toBe(false);
    expect(mqttStatusSchema.safeParse(null).success).toBe(false);
    expect(mqttStatusSchema.safeParse([true]).success).toBe(false);
    expect(mqttStatusSchema.safeParse(1).success).toBe(false);
  });
});

describe("deviceIdParamSchema", () => {
  it("accepts vendor-shaped device ids", () => {
    expect(deviceIdParamSchema.safeParse("vehicle-01").success).toBe(true);
    expect(deviceIdParamSchema.safeParse("AGV:厂区/07").success).toBe(true);
  });

  it("rejects an empty or over-long id", () => {
    expect(deviceIdParamSchema.safeParse("").success).toBe(false);
    expect(deviceIdParamSchema.safeParse("d".repeat(201)).success).toBe(false);
  });
});

describe("sceneIdParamSchema", () => {
  it("accepts safe scene ids", () => {
    expect(sceneIdParamSchema.safeParse("warehouse-a").success).toBe(true);
    expect(sceneIdParamSchema.safeParse("scene_1.v2").success).toBe(true);
  });

  it("rejects an empty or over-long id", () => {
    expect(sceneIdParamSchema.safeParse("").success).toBe(false);
    expect(sceneIdParamSchema.safeParse("s".repeat(201)).success).toBe(false);
  });

  it("rejects traversal-shaped and separator-bearing ids", () => {
    expect(sceneIdParamSchema.safeParse("../../etc/passwd").success).toBe(false);
    expect(sceneIdParamSchema.safeParse("scene/../secret").success).toBe(false);
    expect(sceneIdParamSchema.safeParse("scene a").success).toBe(false);
  });

  it("rejects dot-only ids", () => {
    expect(sceneIdParamSchema.safeParse(".").success).toBe(false);
    expect(sceneIdParamSchema.safeParse("..").success).toBe(false);
    expect(sceneIdParamSchema.safeParse("...").success).toBe(false);
  });
});
