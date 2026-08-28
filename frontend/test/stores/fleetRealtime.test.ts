/**
 * Fleet store realtime link: REST bootstrap, WebSocket message handling,
 * exponential-backoff reconnect and the app-level ping/pong heartbeat.
 *
 * `connectRealtime` is internal, so the socket is reached the way the app does
 * it — through `bootstrap()`. Everything time-based runs on fake timers and the
 * socket is a hand-driven fake, so no real network or clock is involved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useFleetStore } from "../../src/stores/fleet";
import { useNotifications } from "../../src/composables/useNotifications";
import {
  FakeWebSocket,
  installFakeWebSocket,
  lastSocket,
  rawAlert,
  rawDevice,
  rawFormation,
  snapshotPayload,
  stubFetchRoutes,
} from "../helpers/fleetFixtures";

const WS_HEARTBEAT_MS = 20_000;
const WS_PONG_GRACE_MS = 10_000;

let store: ReturnType<typeof useFleetStore>;

const notifications = useNotifications();
const notificationMessages = (): string[] => notifications.items.map((item) => item.message);

const apiSnapshot = () =>
  snapshotPayload([rawDevice("agv-1"), rawDevice("agv-2")], [rawFormation("f-1", ["agv-1"])]);

const stubBackend = (snapshotStatus = 200) =>
  stubFetchRoutes({
    "/api/v1/scenes": { body: { items: [] } },
    "/api/v1/fleet/snapshot": { status: snapshotStatus, body: apiSnapshot() },
  });

/** Bootstrap, then take the socket to its "connected" state. */
const connect = async (): Promise<FakeWebSocket> => {
  await store.bootstrap();
  const socket = lastSocket();
  socket.emitOpen();
  return socket;
};

beforeEach(() => {
  vi.useFakeTimers();
  // Toast state is a module-level singleton: drop leftovers so dedupe keys from
  // a previous case cannot suppress the notifications under test.
  [...notifications.items].forEach((item) => notifications.dismiss(item.id));
  setActivePinia(createPinia());
  store = useFleetStore();
  installFakeWebSocket();
  stubBackend();
});

afterEach(() => {
  store.disconnectRealtime();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fleet store bootstrap", () => {
  it("ingests the REST snapshot and opens the realtime socket", async () => {
    await store.bootstrap();

    expect(store.state.realtime.apiReady).toBe(true);
    expect(store.state.lastSource).toBe("api");
    expect(store.sortedDevices.map((device) => device.deviceId)).toEqual(["agv-1", "agv-2"]);
    expect(store.sortedFormations.map((formation) => formation.formationId)).toEqual(["f-1"]);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(lastSocket().url).toBe(`ws://${window.location.host}/ws`);
    expect(store.state.realtime.wsReady).toBe(false);

    lastSocket().emitOpen();
    expect(store.state.realtime.wsReady).toBe(true);
  });

  it("does not open a second socket when bootstrapped again", async () => {
    await store.bootstrap();
    await store.bootstrap();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("falls back to an empty fleet and warns when the backend is unreachable", async () => {
    stubBackend(503);

    await store.bootstrap();

    expect(store.state.realtime.apiReady).toBe(false);
    expect(store.sortedDevices).toEqual([]);
    expect(store.state.fleetName).toBe("智能车队");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(notificationMessages()).toContain("无法连接后端服务，请检查服务状态后重试");
  });

  it("schedules a reconnect when the WebSocket constructor throws", async () => {
    vi.stubGlobal(
      "WebSocket",
      class BlockedWebSocket {
        constructor() {
          throw new Error("blocked by policy");
        }
      },
    );

    await store.bootstrap();

    expect(store.state.realtime.ws).toBeNull();
    expect(store.state.realtime.wsReady).toBe(false);
    expect(store.state.realtime.reconnectAttempts).toBe(1);
  });
});

describe("fleet store realtime messages", () => {
  it("applies a fleet.snapshot frame as a full replacement", async () => {
    const socket = await connect();

    socket.emitMessage({
      type: "fleet.snapshot",
      payload: snapshotPayload([rawDevice("agv-9")]),
    });

    expect(store.sortedDevices.map((device) => device.deviceId)).toEqual(["agv-9"]);
    expect(store.state.lastSource).toBe("ws");
  });

  it("merges the device carried by a fleet.delta frame", async () => {
    const socket = await connect();

    socket.emitMessage({
      type: "fleet.delta",
      payload: {
        source: "mqtt",
        device: { deviceId: "agv-1", online: false, vehicle_info: { soc: 5 } },
      },
    });

    const device = store.state.devicesById["agv-1"];
    expect(device.online).toBe(false);
    expect(device.vehicleInfo.soc).toBe(5);
    expect(device.deviceName).toBe("车 agv-1");
    expect(store.sortedDevices).toHaveLength(2);
    expect(store.state.lastSource).toBe("mqtt");
  });

  it("accepts a fleet.delta frame whose payload is the device itself", async () => {
    const socket = await connect();

    socket.emitMessage({
      type: "fleet.delta",
      payload: { deviceId: "agv-2", vehicle_info: { speed: 3 } },
    });

    expect(store.state.devicesById["agv-2"].vehicleInfo.speed).toBe(3);
  });

  it("ignores device.online / device.offline frames, whose state rides on fleet.delta", async () => {
    const socket = await connect();

    // The backend emits these alongside a fleet.delta for the same device; the
    // frontend deliberately reads only the delta, so the notices are inert.
    expect(() => {
      socket.emitMessage({
        type: "device.offline",
        payload: { source: "mqtt", deviceId: "agv-1", at: "2026-08-26T10:01:00.000Z" },
      });
      socket.emitMessage({
        type: "device.online",
        payload: { source: "mqtt", deviceId: "agv-2", at: "2026-08-26T10:01:00.000Z" },
      });
    }).not.toThrow();
    expect(store.state.devicesById["agv-1"].online).toBe(true);

    socket.emitMessage({
      type: "fleet.delta",
      payload: { device: { deviceId: "agv-1", online: false } },
    });
    expect(store.state.devicesById["agv-1"].online).toBe(false);
  });

  it("ignores alert.created / alert.cleared frames, whose alerts ride on fleet.delta", async () => {
    const socket = await connect();

    expect(() => {
      socket.emitMessage({
        type: "alert.created",
        payload: { source: "mqtt", deviceId: "agv-1", alert: rawAlert("a-1", "critical") },
      });
      socket.emitMessage({
        type: "alert.cleared",
        payload: { source: "mqtt", deviceId: "agv-1", alertId: "a-1" },
      });
    }).not.toThrow();
    expect(store.groupedAlerts.critical).toEqual([]);

    socket.emitMessage({
      type: "fleet.delta",
      payload: { device: rawDevice("agv-1", { alerts: [rawAlert("a-1", "critical")] }) },
    });
    expect(store.groupedAlerts.critical.map((alert) => alert.id)).toEqual(["a-1"]);
  });

  it("swallows malformed frames without disturbing state", async () => {
    const socket = await connect();
    const before = store.state.devicesById["agv-1"].vehicleInfo.soc;

    expect(() => {
      socket.emitRaw("not-json");
      socket.emitMessage({ type: "fleet.snapshot", payload: null });
      socket.emitMessage({ type: "fleet.delta" });
      socket.emitMessage({});
    }).not.toThrow();

    expect(store.sortedDevices).toHaveLength(2);
    expect(store.state.devicesById["agv-1"].vehicleInfo.soc).toBe(before);
  });
});

describe("fleet store reconnect backoff", () => {
  it("retries with exponential backoff capped at 30s", async () => {
    await store.bootstrap();

    // The socket never opens, so attempts keep climbing: 1s, 2s, 4s … 30s.
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].forEach((delay, index) => {
      lastSocket().emitClose();
      expect(FakeWebSocket.instances).toHaveLength(index + 1);

      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(index + 1);

      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(index + 2);
    });
  });

  it("resets the backoff once a reconnect succeeds", async () => {
    await store.bootstrap();

    lastSocket().emitClose();
    vi.advanceTimersByTime(1_000);
    lastSocket().emitClose();
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    const revived = lastSocket();
    revived.emitOpen();
    expect(store.state.realtime.reconnectAttempts).toBe(0);
    expect(notificationMessages()).toContain("实时连接已恢复");

    revived.emitClose();
    expect(notificationMessages()).toContain("实时连接中断，正在自动重连…");
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("does not reconnect after a manual disconnect", async () => {
    const socket = await connect();

    store.disconnectRealtime();

    expect(socket.closeCount).toBe(1);
    expect(store.state.realtime.ws).toBeNull();
    expect(store.state.realtime.wsReady).toBe(false);
    expect(store.state.realtime.reconnectAttempts).toBe(0);

    // The browser still delivers "close" after close() — it must stay quiet.
    socket.emitClose();
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent).toEqual([]);
    expect(notificationMessages()).toEqual([]);
  });
});

describe("fleet store heartbeat", () => {
  it("pings the server on the heartbeat interval", async () => {
    const socket = await connect();

    vi.advanceTimersByTime(WS_HEARTBEAT_MS);

    expect(socket.sent).toEqual(['{"type":"ping"}']);
  });

  it("keeps the socket when a pong answers in time", async () => {
    const socket = await connect();

    vi.advanceTimersByTime(WS_HEARTBEAT_MS);
    socket.emitMessage({ type: "pong", payload: null });
    vi.advanceTimersByTime(WS_PONG_GRACE_MS);

    expect(socket.closeCount).toBe(0);
    expect(store.state.realtime.wsReady).toBe(true);
  });

  it("closes a black-holed socket when no pong arrives, then reconnects", async () => {
    const socket = await connect();

    vi.advanceTimersByTime(WS_HEARTBEAT_MS);
    vi.advanceTimersByTime(WS_PONG_GRACE_MS - 1);
    expect(socket.closeCount).toBe(0);

    vi.advanceTimersByTime(1);
    expect(socket.closeCount).toBe(1);

    socket.emitClose();
    expect(store.state.realtime.wsReady).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

/**
 * The flag the dashboard keys its skeletons off. The failure mode that matters
 * is not the happy path but the `finally`: a bootstrap that throws must still
 * clear it, or a backend outage leaves the dashboard shimmering forever.
 */
describe("fleet store bootstrapPending", () => {
  it("is false before anything starts", () => {
    expect(store.bootstrapPending).toBe(false);
  });

  it("is set while the first snapshot is in flight and cleared after", async () => {
    const pending = store.bootstrap();
    expect(store.bootstrapPending).toBe(true);

    await pending;
    expect(store.bootstrapPending).toBe(false);
  });

  it("is cleared even when the backend rejects the snapshot", async () => {
    stubBackend(503);

    await store.bootstrap();

    expect(store.state.realtime.apiReady).toBe(false);
    expect(store.bootstrapPending).toBe(false);
  });

  it("is set again by a manual retry", async () => {
    await store.bootstrap();

    const retry = store.retryBootstrap();
    expect(store.bootstrapPending).toBe(true);

    await retry;
    expect(store.bootstrapPending).toBe(false);
  });
});
