import { describe, it, expect } from "vitest";
import {
  normalizeDevice,
  normalizeFormation,
  dedupeAlerts,
  mergeDevice,
  normalizePathPoint,
  pointsAreNear,
  pickTrailPose,
  parseTimestampMs,
  toTimestampMsOrNow,
  formatDateTime,
} from "../src/fleetNormalize";

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
    const device = normalizeDevice(
      { vehicle_info: { soc: 50 } },
      "/fleet/robot-9/vehicle_info",
    );
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
    // The callback used to need `(alert: { severity: string })`: `alerts` was inferred
    // `any[]`, so without it the parameter was an implicit any. It is `DeviceAlert[]` now.
    const critical = device.alerts.find(
      (alert) => alert.severity === "critical",
    );
    expect(critical).toBeTruthy();
    expect(critical?.code).toBe(42);
  });

  it("derives a low-battery warning when soc drops below the threshold", () => {
    const device = normalizeDevice({
      deviceId: "agv-4",
      vehicle_info: { soc: 12 },
    });
    const lowSoc = device.alerts.find((alert) => alert.id.endsWith("low-soc"));
    expect(lowSoc).toBeTruthy();
    expect(lowSoc?.severity).toBe("warning");
  });

  it("derives an offline alert when the device is marked offline", () => {
    const device = normalizeDevice({ deviceId: "agv-5", online: false });
    const offline = device.alerts.find((alert) => alert.id.endsWith("offline"));
    expect(offline).toBeTruthy();
    expect(offline?.severity).toBe("critical");
  });
});

describe("mergeDevice", () => {
  it("returns the incoming device when there is no existing entry", () => {
    const incoming = normalizeDevice({ deviceId: "agv-6" });
    expect(mergeDevice(null, incoming)).toBe(incoming);
  });

  it("deep-merges nested telemetry so partial updates keep prior values", () => {
    const existing = normalizeDevice({
      deviceId: "agv-7",
      vehicle_info: { soc: 90, speed: 1 },
    });
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
      {
        id: "y",
        severity: "critical",
        title: "t2",
        ts: "2026-01-02T00:00:00Z",
      },
    ];
    const result = dedupeAlerts(alerts);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("y");
  });
});

describe("path + trail helpers", () => {
  it("rounds path points and rejects non-finite coordinates", () => {
    expect(normalizePathPoint({ x: 1.23456, y: 2.34567 })).toEqual({
      x: 1.235,
      y: 2.346,
    });
    expect(normalizePathPoint({ x: NaN, y: 1 })).toBeNull();
  });

  it("detects near-coincident points within epsilon", () => {
    expect(pointsAreNear({ x: 0, y: 0 }, { x: 0.01, y: 0.01 })).toBe(true);
    expect(pointsAreNear({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });

  it("prefers fusion pose, then lidar, for trail recording", () => {
    expect(
      pickTrailPose({ fusionLoc: { x: 1, y: 2 }, lidarLoc: { x: 9, y: 9 } }),
    ).toEqual({
      x: 1,
      y: 2,
    });
    expect(
      pickTrailPose({
        fusionLoc: { x: null, y: null },
        lidarLoc: { x: 5, y: 6 },
      }),
    ).toEqual({
      x: 5,
      y: 6,
    });
    expect(pickTrailPose({ fusionLoc: {}, lidarLoc: {} })).toBeNull();
  });
});

describe("parseTimestampMs", () => {
  it("upconverts second-precision epochs to milliseconds", () => {
    expect(parseTimestampMs(1_000_000)).toBe(1_000_000 * 1000);
    expect(parseTimestampMs(2_000_000_000_000)).toBe(2_000_000_000_000);
  });

  it("parses ISO strings and numeric strings", () => {
    expect(parseTimestampMs("2026-09-02T00:00:00.000Z")).toBe(
      Date.parse("2026-09-02T00:00:00.000Z"),
    );
    expect(parseTimestampMs("2000000000000")).toBe(2_000_000_000_000);
  });

  it("answers null for anything that carries no time (parity 9.19)", () => {
    // The old helper answered `Date.now()` here, which turns "we do not know when this
    // happened" into "it happened this instant" — so an undated alert sorted above
    // every real one, and moved again on the next tick.
    for (const absent of [
      null,
      undefined,
      "",
      "   ",
      "not a date",
      Number.NaN,
      {},
      [],
    ]) {
      expect(parseTimestampMs(absent)).toBeNull();
    }
  });
});

describe("toTimestampMsOrNow", () => {
  it("falls back to now, which is why the name says so", () => {
    // For a *receiver* this is the right answer: the frame did just arrive. The name
    // exists so that a reader cannot reach for it by accident.
    const before = Date.now();
    const at = toTimestampMsOrNow(null);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(toTimestampMsOrNow(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});

describe("formatDateTime", () => {
  it("shows the placeholder rather than a fabricated time", () => {
    expect(formatDateTime(null)).toBe("--");
    expect(formatDateTime("")).toBe("--");
    expect(formatDateTime("not a date")).toBe("--");
    expect(formatDateTime(1_700_000_000_000)).not.toBe("--");
  });
});

describe("非标量字段", () => {
  it("不把对象渲染成 [object Object]", () => {
    // 这条用例存在的理由是它此前不存在：`String(raw.deviceName || …)` 在 `deviceName` 是
    // 对象时会产出字面量 "[object Object]"，一路进到 console 的设备列表。车队里没有车这么
    // 发，也没有任何东西拒绝它 —— 而归一化层的全部职责就是让「到达的东西」变成「模型说的
    // 东西」。P0-f 第 3 批的 `no-base-to-string` 指到了它。
    const device = normalizeDevice({
      deviceId: "agv-obj",
      deviceName: { zh: "叉车" },
      scene_id: ["warehouse-a"],
    });

    expect(device.deviceName).not.toContain("[object");
    // 兜底是设备 id，而不是空名字：一个没有名字的行比一个叫 "[object Object]" 的行还难用。
    expect(device.deviceName).toBe("agv-obj");
    expect(device.sceneId).toBe("");
  });

  it("整编队名同样兜底到 id 而不是空串", () => {
    const formation = normalizeFormation({
      formationId: "fm-1",
      formationName: { zh: "巡检组" },
      deviceIds: ["agv-1"],
    });
    expect(formation.formationName).toBe("fm-1");
  });
});

describe("厂商自带的 alerts 数组", () => {
  const vendorFrame = {
    deviceId: "agv-vendor",
    alerts: [
      {
        id: "v-1",
        severity: "ERROR",
        title: "急停",
        detail: "触发急停",
        code: 5102,
      },
      // 非对象条目：整个数组不能因为一条脏数据而被丢掉。
      "not an object",
    ],
  };

  it("把厂商 severity 收进联合类型，而不是原样带进 store", () => {
    // 一个 `severity: "ERROR"` 原样活下来之后，console 会用一个不在联合里的 key 去索引
    // `grouped[severity]` —— 拿到的是 undefined 桶，而不是一条 critical 告警。
    const device = normalizeDevice(vendorFrame);
    const first = device.alerts.find((alert) => alert.id === "v-1");

    expect(first?.severity).toBe("critical");
    expect(first?.code).toBe(5102);
  });

  it("脏条目补齐成一条可显示的告警而不是抛错", () => {
    const device = normalizeDevice(vendorFrame);
    const filled = device.alerts.find(
      (alert) => alert.id === "agv-vendor-alert-2",
    );

    expect(filled).toBeTruthy();
    expect(filled?.title).toBe("设备告警");
    expect(filled?.severity).toBe("notice");
    // ts 缺失时用设备自己的 stamp，而不是另造一个时间。
    expect(filled?.ts).toBe(device.stamp);
  });
});
