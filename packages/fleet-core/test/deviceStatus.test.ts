import { describe, it, expect } from "vitest";
import type { DeviceSnapshot } from "@navfleet/shared";
import {
  getDeviceStatus,
  deviceStatusLabel,
  deviceStatusLabels,
} from "../src/deviceStatus";

/**
 * 实时状态 is derived from fields already on the snapshot, so these tests pin the
 * priority order (负责人 2026-11-03): 离线 > 急停 > 故障 > 遥控 > 充电中 > 任务中 >
 * 异常中断 > 待命. The ordering is the part that breaks silently if someone reshuffles
 * the branches, so each case sets a higher-priority signal *and* a lower one and
 * asserts the higher wins.
 */
const device = (
  patch: Partial<
    Pick<DeviceSnapshot, "online" | "taskStatus" | "errorCode" | "vehicleInfo">
  > = {},
): Pick<DeviceSnapshot, "online" | "taskStatus" | "errorCode"> & {
  vehicleInfo?: DeviceSnapshot["vehicleInfo"];
} => ({
  online: true,
  taskStatus: 0,
  errorCode: { code: 0, info: "", stamp: null },
  vehicleInfo: {
    controlMode: 1,
    gear: 1,
    speed: 0,
    omega: 0,
    soc: 80,
  },
  ...patch,
});

describe("getDeviceStatus", () => {
  it("offline wins over every other signal (telemetry is stale)", () => {
    expect(
      getDeviceStatus(
        device({
          online: false,
          taskStatus: 1,
          errorCode: { code: 5703, info: "障碍物", stamp: null },
          vehicleInfo: { ...device().vehicleInfo!, controlMode: 3 },
        }),
      ),
    ).toBe("offline");
  });

  it("急停 (controlMode 3) wins over an active fault code and a running task", () => {
    expect(
      getDeviceStatus(
        device({
          taskStatus: 1,
          errorCode: { code: 5703, info: "障碍物", stamp: null },
          vehicleInfo: { ...device().vehicleInfo!, controlMode: 3 },
        }),
      ),
    ).toBe("estop");
  });

  it("故障 (active error code) outranks 遥控 and 任务中", () => {
    expect(
      getDeviceStatus(
        device({
          taskStatus: 1,
          errorCode: { code: 5201, info: "定位丢失", stamp: null },
          vehicleInfo: { ...device().vehicleInfo!, controlMode: 2 },
        }),
      ),
    ).toBe("fault");
  });

  it("遥控 (controlMode 2) outranks 充电中/任务中", () => {
    expect(
      getDeviceStatus(
        device({
          taskStatus: 4,
          vehicleInfo: { ...device().vehicleInfo!, controlMode: 2 },
        }),
      ),
    ).toBe("teleop");
  });

  it("充电中 is taskStatus 4", () => {
    expect(getDeviceStatus(device({ taskStatus: 4 }))).toBe("charging");
  });

  it("任务中 is taskStatus 1", () => {
    expect(getDeviceStatus(device({ taskStatus: 1 }))).toBe("tasking");
  });

  it("异常中断 is taskStatus 3", () => {
    expect(getDeviceStatus(device({ taskStatus: 3 }))).toBe("interrupted");
  });

  it("待命 is the fallback (idle task, no override)", () => {
    expect(getDeviceStatus(device({ taskStatus: 0 }))).toBe("standby");
    expect(getDeviceStatus(device({ taskStatus: 2 }))).toBe("standby");
    expect(getDeviceStatus(device({ taskStatus: null }))).toBe("standby");
  });

  it("an absent error code does not read as 故障 (NaN guard)", () => {
    // Number(undefined) !== 0 is true — the bug deviceTone documents; must stay 待命.
    expect(
      getDeviceStatus({
        online: true,
        taskStatus: 0,
        errorCode: undefined as unknown as DeviceSnapshot["errorCode"],
      }),
    ).toBe("standby");
  });

  it("deviceStatusLabel maps to the Chinese label", () => {
    expect(deviceStatusLabel(device({ taskStatus: 4 }))).toBe(
      deviceStatusLabels.charging,
    );
    expect(deviceStatusLabel(device({ taskStatus: 4 }))).toBe("充电中");
  });
});
