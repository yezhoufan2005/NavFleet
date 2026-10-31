import { describe, it, expect } from "vitest";
import type { DeviceSnapshot } from "@navfleet/shared";
import {
  DEVICE_TONE_SEVERITY,
  deviceToneLabels,
  activeCodeText,
  alertHeadline,
  deviceToneRank,
  getDeviceTone,
} from "../src/deviceTone";

/**
 * These tests exist because the logic they cover used to be in three places at once
 * — the derivation in the v1.0.0 store, and the label map copied into two components
 * — with no direct test on any of them. The duplication was the actual risk: with two
 * frontends running side by side, a change applied to one copy and not the others
 * produces no error, just two consoles disagreeing about a vehicle.
 */
const device = (
  patch: Partial<DeviceSnapshot> = {},
): Pick<
  DeviceSnapshot,
  "online" | "errorCode" | "warningCode" | "infoCode"
> => ({
  online: true,
  errorCode: { code: 0, info: "", stamp: null },
  warningCode: { code: 0, info: "", stamp: null },
  infoCode: { code: 0, info: "", stamp: null },
  ...patch,
});

describe("getDeviceTone", () => {
  it("reports a healthy device as normal", () => {
    expect(getDeviceTone(device())).toBe("normal");
  });

  it("ranks offline above every code", () => {
    // A vehicle we have not heard from has *stale* codes. Reporting its last known
    // error as current would claim knowledge we do not have.
    const stale = device({
      online: false,
      errorCode: { code: 5102, info: "路径规划超时", stamp: null },
    });
    expect(getDeviceTone(stale)).toBe("offline");
  });

  it("ranks error over warning over info", () => {
    const all = {
      errorCode: { code: 5102, info: "", stamp: null },
      warningCode: { code: 2203, info: "", stamp: null },
      infoCode: { code: 1101, info: "", stamp: null },
    };
    expect(getDeviceTone(device(all))).toBe("critical");
    expect(
      getDeviceTone(
        device({ ...all, errorCode: { code: 0, info: "", stamp: null } }),
      ),
    ).toBe("warning");
    expect(
      getDeviceTone(
        device({
          ...all,
          errorCode: { code: 0, info: "", stamp: null },
          warningCode: { code: 0, info: "", stamp: null },
        }),
      ),
    ).toBe("notice");
  });

  it('treats the string "0" as no code, because MQTT sends both shapes', () => {
    // `"0"` is truthy, so a truthiness test here would mark every healthy device
    // critical — and only for the payloads that happen to send strings.
    const stringy = device({
      errorCode: { code: "0" as unknown as number, info: "", stamp: null },
      warningCode: { code: "0" as unknown as number, info: "", stamp: null },
      infoCode: { code: "0" as unknown as number, info: "", stamp: null },
    });
    expect(getDeviceTone(stringy)).toBe("normal");
  });

  it("treats a numeric string code as present", () => {
    const stringy = device({
      warningCode: { code: "2203" as unknown as number, info: "", stamp: null },
    });
    expect(getDeviceTone(stringy)).toBe("warning");
  });

  it("FIXED: a payload with no code objects is normal, not critical", () => {
    // v1.0.0 used `Number(code) !== 0`, and `Number(undefined) !== 0` is `NaN !== 0`
    // → true — so a device whose codes were simply absent reported as 告警. Absent
    // means "not reported" and must not read as the worst possible state. This test
    // is what found it.
    const bare = { online: true } as Parameters<typeof getDeviceTone>[0];
    expect(getDeviceTone(bare)).toBe("normal");
  });

  it("treats an unparseable code as absent rather than as a fault", () => {
    const junk = device({
      errorCode: { code: "n/a" as unknown as number, info: "", stamp: null },
    });
    expect(getDeviceTone(junk)).toBe("normal");
  });
});

describe("labels and ordering", () => {
  it("labels every tone, with no gaps", () => {
    for (const tone of DEVICE_TONE_SEVERITY) {
      expect(deviceToneLabels[tone], tone).toBeTruthy();
    }
    expect(Object.keys(deviceToneLabels)).toHaveLength(
      DEVICE_TONE_SEVERITY.length,
    );
  });

  it("uses the labels the Playwright suite matches on", () => {
    // Changing any of these breaks e2e assertions in both frontends at once, which
    // is the intended cost of having one source of truth.
    expect(deviceToneLabels).toEqual({
      normal: "正常",
      notice: "提示",
      warning: "预警",
      critical: "告警",
      offline: "离线",
    });
  });

  it("orders severity worst-first so a device list can sort by who needs attention", () => {
    expect(deviceToneRank("critical")).toBeLessThan(deviceToneRank("warning"));
    expect(deviceToneRank("warning")).toBeLessThan(deviceToneRank("notice"));
    expect(deviceToneRank("notice")).toBeLessThan(deviceToneRank("offline"));
    expect(deviceToneRank("offline")).toBeLessThan(deviceToneRank("normal"));
  });
});

describe("getDeviceTone — active messages", () => {
  it("counts a rule-raised message that has no code behind it", () => {
    // 低电量预警 comes from the backend's rule engine with every code at 0.
    expect(
      getDeviceTone({ ...device(), alerts: [{ severity: "warning" }] }),
    ).toBe("warning");
  });

  it("takes the worse of the codes and the messages", () => {
    const withNotice = device({
      infoCode: { code: 1301, info: "正在充电", stamp: null },
    });
    expect(
      getDeviceTone({ ...withNotice, alerts: [{ severity: "critical" }] }),
    ).toBe("critical");
    expect(
      getDeviceTone({
        ...device({ errorCode: { code: 5102, info: "", stamp: null } }),
        alerts: [{ severity: "notice" }],
      }),
    ).toBe("critical");
  });

  it("still lets offline win", () => {
    expect(
      getDeviceTone({
        ...device({ online: false }),
        alerts: [{ severity: "critical" }],
      }),
    ).toBe("offline");
  });
});

describe("activeCodeText", () => {
  it("ignores text left on a channel whose code has cleared", () => {
    // The live snapshot had errorCode {code: 0, info: "路径规划超时，已触发急停"} beside an
    // active 1301 — the overview showed the cleared 急停.
    expect(
      activeCodeText(
        device({
          errorCode: { code: 0, info: "路径规划超时，已触发急停", stamp: null },
          infoCode: { code: 1301, info: "正在充电", stamp: null },
        }),
      ),
    ).toBe("正在充电");
    expect(activeCodeText(device())).toBe("");
  });
});

describe("alertHeadline", () => {
  it("leads with the fault for a report-code message, the title otherwise", () => {
    expect(
      alertHeadline({
        title: "告警报码",
        detail: "路径规划超时",
        source: "error_code",
      }),
    ).toBe("路径规划超时");
    expect(
      alertHeadline({ title: "告警报码", detail: "", source: "error_code" }),
    ).toBe("告警报码");
    expect(
      alertHeadline({
        title: "低电量预警",
        detail: "当前电量 12%，建议尽快安排回充",
        source: "rule-engine",
      }),
    ).toBe("低电量预警");
  });
});
