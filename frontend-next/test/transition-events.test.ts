import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

/**
 * The four transition events the backend has always broadcast and nothing consumed:
 * `device.online` / `device.offline` / `alert.created` / `alert.cleared`.
 *
 * The link is mocked so the envelopes can be handed straight to the store's own
 * handler — the transport is tested separately in `realtime.test.ts`, and what needs
 * pinning here is the decision layer: which transitions become a toast, which are
 * deliberately silent, and what happens when a whole fleet transitions at once.
 */

let capturedOnMessage: ((message: unknown) => void) | null = null;

vi.mock("@/lib/realtimeLink", () => ({
  createRealtimeLink: (options: { onMessage: (message: unknown) => void }) => {
    capturedOnMessage = options.onMessage;
    return { connect: () => {}, disconnect: () => {} };
  },
}));

const notified: { message: string; type?: string }[] = [];

vi.mock("@/composables/useNotifications", () => ({
  notify: (message: string, options?: { type?: string }) => {
    notified.push({ message, type: options?.type });
    return notified.length;
  },
  dismissNotification: () => {},
}));

const { useFleetStore } = await import("@/stores/fleet");

const deviceFrame = (
  deviceId: string,
  deviceName: string,
  online = true,
): Record<string, unknown> => ({
  deviceId,
  deviceName,
  online,
  stamp: new Date().toISOString(),
  vehicleInfo: { soc: 80 },
  alerts: [],
});

const send = (type: string, payload: unknown): void => {
  if (!capturedOnMessage) throw new Error("the store never opened a link");
  capturedOnMessage({ type, payload });
};

const messages = (): string[] => notified.map((entry) => entry.message);

describe("transition events", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    notified.length = 0;
    capturedOnMessage = null;
    const store = useFleetStore();
    store.connectRealtime();
    // A fleet to name in the toasts. Sent as a snapshot, which is what a real
    // connection receives first.
    send("fleet.snapshot", {
      devices: [
        deviceFrame("agv-a01", "A01 巡检车"),
        deviceFrame("agv-b07", "B07 巡检车"),
      ],
    });
    notified.length = 0;
  });

  it("names the device rather than printing its id", () => {
    send("device.offline", { deviceId: "agv-a01", at: "2026-09-09T00:00:00Z" });
    expect(messages()).toEqual(["A01 巡检车 已离线"]);
  });

  it("falls back to the id for a device it has never seen", () => {
    send("device.offline", { deviceId: "agv-unknown" });
    expect(messages()).toEqual(["agv-unknown 已离线"]);
  });

  it("announces a recovery only for a departure it announced", () => {
    // The backend emits `device.online` for a device's *first* ingest too, so an
    // unpaired recovery is the normal case after a backend restart — not news.
    send("device.online", { deviceId: "agv-a01" });
    expect(messages()).toEqual([]);

    send("device.offline", { deviceId: "agv-a01" });
    send("device.online", { deviceId: "agv-a01" });
    expect(messages()).toEqual(["A01 巡检车 已离线", "A01 巡检车 已恢复在线"]);
  });

  it("raises告警 and 预警 but stays silent for 提示", () => {
    send("alert.created", {
      deviceId: "agv-a01",
      alert: { id: "a-1", severity: "critical", title: "告警报码" },
    });
    send("alert.created", {
      deviceId: "agv-b07",
      alert: { id: "a-2", severity: "warning", title: "低电量预警" },
    });
    // 报码里的提示位在正常运行中就会亮；每条都弹会让提示流变成背景噪声。
    send("alert.created", {
      deviceId: "agv-a01",
      alert: { id: "a-3", severity: "notice", title: "提示报码" },
    });

    expect(messages()).toEqual([
      "A01 巡检车：告警报码",
      "B07 巡检车：低电量预警",
    ]);
    expect(notified[0]?.type).toBe("error");
    expect(notified[1]?.type).toBe("warning");
  });

  it("reports a clear only when it reported the onset", () => {
    send("alert.cleared", {
      deviceId: "agv-a01",
      alert: { id: "never-seen", severity: "critical", title: "告警报码" },
    });
    expect(messages()).toEqual([]);

    send("alert.created", {
      deviceId: "agv-a01",
      alert: { id: "a-1", severity: "critical", title: "告警报码" },
    });
    send("alert.cleared", {
      deviceId: "agv-a01",
      alert: { id: "a-1", severity: "critical", title: "告警报码" },
    });
    expect(messages()).toEqual([
      "A01 巡检车：告警报码",
      "A01 巡检车：告警报码已解除",
    ]);
  });

  it("collapses a burst into one line instead of a wall of toasts", () => {
    // What a backend restart looks like from here: every device's first frame is a
    // transition, so the events arrive together.
    for (let index = 0; index < 12; index += 1) {
      send("device.offline", { deviceId: `agv-burst-${index}` });
    }

    const summaries = messages().filter((message) =>
      message.includes("车队状态密集变化"),
    );
    expect(summaries).toHaveLength(1);
    // Four individual toasts plus the single summary; the rest are suppressed.
    expect(messages()).toHaveLength(5);
  });

  it("ignores a frame with no device id, and does not mutate state", () => {
    send("device.offline", {});
    send("alert.created", { deviceId: "agv-a01", alert: null });
    expect(messages()).toEqual([]);

    const store = useFleetStore();
    // `fleet.delta` carries the device and arrives first; these events must not be a
    // second path to the same fields.
    expect(store.devices.find((d) => d.deviceId === "agv-a01")?.online).toBe(
      true,
    );
  });
});
