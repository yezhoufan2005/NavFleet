import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { fleetApi } from "@navfleet/fleet-core";
import { useFleetStore } from "@/stores/fleet";
import {
  useNotifications,
  __resetNotifications,
} from "@/composables/useNotifications";
import { acceptLastSocket, openedSockets } from "./setup";

/**
 * The data layer, ported from the 746-line v1.0.0 store. Nothing in that store had a
 * test; these cover the parts a page reads directly, plus the three bootstrap
 * outcomes — because "the backend is down" and "the backend answered with something
 * we cannot read" send whoever is on shift to different places.
 */
const device = (patch: Record<string, unknown> = {}) => ({
  deviceId: "agv-01",
  deviceName: "AGV 01",
  online: true,
  fusion_loc: { x: 1, y: 1 },
  ...patch,
});

const snapshot = (devices: unknown[], extra: Record<string, unknown> = {}) => ({
  fleetName: "北区仓储车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  devices,
  ...extra,
});

const toastMessages = (): string[] =>
  useNotifications().items.map((item) => item.message);

let store: ReturnType<typeof useFleetStore>;

beforeEach(() => {
  setActivePinia(createPinia());
  __resetNotifications();
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  store = useFleetStore();
});

afterEach(() => {
  store.disconnectRealtime();
  vi.restoreAllMocks();
});

describe("ingest", () => {
  it("replaces the fleet from a full snapshot and takes its name", () => {
    store.ingestPayload(
      snapshot([device(), device({ deviceId: "agv-02" })]),
      "api",
    );

    expect(store.sortedDevices.map((item) => item.deviceId)).toEqual([
      "agv-01",
      "agv-02",
    ]);
    expect(store.state.fleetName).toBe("北区仓储车队");
    expect(store.state.lastSource).toBe("api");
  });

  it("merges a single-device update instead of replacing the fleet", () => {
    store.ingestPayload(
      snapshot([device(), device({ deviceId: "agv-02" })]),
      "api",
    );
    store.ingestPayload(device({ deviceName: "AGV 01 改名" }), "mqtt");

    expect(store.sortedDevices).toHaveLength(2);
    expect(store.selectedDevice?.deviceName).toBe("AGV 01 改名");
  });

  it("accepts a bare array of devices as a whole fleet", () => {
    store.ingestPayload([device(), device({ deviceId: "agv-02" })], "ws");
    expect(store.sortedDevices).toHaveLength(2);
  });

  it("unwraps a {topic, payload} envelope and reads the id from the topic", () => {
    store.ingestPayload(
      {
        topic: "/fleet/agv-77/vehicle_info",
        payload: JSON.stringify({ online: true, fusion_loc: { x: 2, y: 2 } }),
      },
      "mqtt",
    );

    expect(store.sortedDevices.map((item) => item.deviceId)).toEqual([
      "agv-77",
    ]);
  });

  it("refuses a payload that is not an object", () => {
    expect(() => store.ingestPayload("not json", "ws")).toThrow();
  });

  it("orders devices by id so rows do not jump as telemetry lands", () => {
    store.ingestPayload(
      snapshot([
        device({ deviceId: "agv-10" }),
        device({ deviceId: "agv-02" }),
      ]),
      "api",
    );
    expect(store.sortedDevices.map((item) => item.deviceId)).toEqual([
      "agv-02",
      "agv-10",
    ]);
  });
});

describe("trails", () => {
  it("records a point per move and drops samples that did not move", () => {
    store.ingestPayload(
      snapshot([device({ fusion_loc: { x: 0, y: 0 } })]),
      "api",
    );
    store.ingestPayload(device({ fusion_loc: { x: 0, y: 0.01 } }), "mqtt");
    store.ingestPayload(device({ fusion_loc: { x: 0, y: 5 } }), "mqtt");

    // A parked vehicle otherwise accumulates 240 identical points and its trail
    // stops meaning anything.
    expect(store.trailsByDeviceId["agv-01"]).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 5 },
    ]);
  });

  it("forgets the trail of a device a full snapshot no longer lists", () => {
    store.ingestPayload(
      snapshot([device(), device({ deviceId: "agv-02" })]),
      "api",
    );
    store.ingestPayload(snapshot([device()]), "api");

    expect(Object.keys(store.trailsByDeviceId)).toEqual(["agv-01"]);
  });

  it("clears one device's trail on request", () => {
    store.ingestPayload(snapshot([device()]), "api");
    store.clearTrail("agv-01");
    expect(store.trailsByDeviceId["agv-01"]).toBeUndefined();
  });
});

describe("derived views", () => {
  const withFormation = () =>
    store.ingestPayload(
      snapshot(
        [
          device({ deviceId: "agv-01", sceneId: "yard" }),
          device({ deviceId: "agv-02", sceneId: "yard", online: false }),
          device({ deviceId: "agv-09", sceneId: "dock" }),
        ],
        {
          formations: [
            {
              formationId: "f-1",
              formationName: "北区编队",
              deviceIds: ["agv-01", "agv-02"],
            },
          ],
        },
      ),
      "api",
    );

  it("counts the fleet and names what is in focus", () => {
    withFormation();
    expect(store.summary.totalCount).toBe(3);
    expect(store.summary.onlineCount).toBe(2);
  });

  it("filters the device list to a selected formation", () => {
    withFormation();
    store.selectFormation("f-1");

    expect(store.filteredDevices.map((item) => item.deviceId)).toEqual([
      "agv-01",
      "agv-02",
    ]);
    expect(store.summary.focusName).toBe("北区编队");
  });

  it("counts a formation's members and how many are online", () => {
    withFormation();
    expect(store.formations[0]).toMatchObject({
      deviceCount: 2,
      onlineCount: 1,
      sceneId: "yard",
    });
  });

  it("draws every vehicle standing in the scene, not only the selected one", () => {
    // v1.0.0 returned nothing at all without a formation selected, so the scene map
    // of a six-vehicle site showed one vehicle and no hint the others existed.
    withFormation();
    store.selectDevice("agv-01");

    expect(store.sceneDevices.map((item) => item.deviceId)).toEqual([
      "agv-01",
      "agv-02",
    ]);
  });

  it("groups alerts by severity, newest first", () => {
    store.ingestPayload(
      snapshot([
        device({
          error_code: { code: 5102, info: "路径规划超时", stamp: null },
        }),
      ]),
      "api",
    );

    expect(store.groupedAlerts.critical).toHaveLength(1);
    expect(store.groupedAlerts.critical[0]).toMatchObject({
      deviceId: "agv-01",
      deviceName: "AGV 01",
    });
  });
});

describe("selection", () => {
  it("selects the first device when a snapshot arrives with none chosen", () => {
    store.ingestPayload(
      snapshot([device({ deviceId: "agv-05" }), device()]),
      "api",
    );
    expect(store.state.selectedDeviceId).toBe("agv-01");
  });

  it("ignores a device that is not in the fleet", () => {
    store.ingestPayload(snapshot([device()]), "api");
    store.selectDevice("ghost");
    expect(store.state.selectedDeviceId).toBe("agv-01");
  });

  it("leaves the formation when a device outside it is chosen", () => {
    store.ingestPayload(
      snapshot([device(), device({ deviceId: "agv-02" })], {
        formations: [
          {
            formationId: "f-1",
            formationName: "北区编队",
            deviceIds: ["agv-01"],
          },
        ],
      }),
      "api",
    );
    store.selectFormation("f-1");
    store.selectDevice("agv-02");

    expect(store.state.selectedFormationId).toBe("");
  });

  it("moves the selection into the formation that was just chosen", () => {
    store.ingestPayload(
      snapshot([device(), device({ deviceId: "agv-02" })], {
        formations: [
          {
            formationId: "f-1",
            formationName: "北区编队",
            deviceIds: ["agv-02"],
          },
        ],
      }),
      "api",
    );
    store.selectFormation("f-1");

    expect(store.state.selectedDeviceId).toBe("agv-02");
  });
});

describe("bootstrap", () => {
  it("ingests the snapshot and opens the realtime link", async () => {
    vi.spyOn(fleetApi, "getSnapshot").mockResolvedValue(snapshot([device()]));

    await expect(store.bootstrap()).resolves.toBe(true);
    expect(store.state.realtime.apiReady).toBe(true);
    expect(store.sortedDevices).toHaveLength(1);
    expect(openedSockets.at(-1)?.url).toMatch(/\/ws$/);
  });

  it("falls back to an empty fleet and says so when the backend is unreachable", async () => {
    vi.spyOn(fleetApi, "getSnapshot").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    await expect(store.bootstrap()).resolves.toBe(false);
    expect(store.state.realtime.apiReady).toBe(false);
    expect(store.sortedDevices).toEqual([]);
    expect(toastMessages()).toContain("无法连接后端服务，请检查服务状态后重试");
    // No socket: there is nothing to subscribe to yet.
    expect(openedSockets).toEqual([]);
  });

  it("says something different when the backend answers with a snapshot it cannot read", async () => {
    // v1.0.0 reported this as "检查服务状态", sending whoever is on shift to look at
    // a service that had answered promptly.
    vi.spyOn(fleetApi, "getSnapshot").mockResolvedValue(
      "nonsense" as unknown as Awaited<ReturnType<typeof fleetApi.getSnapshot>>,
    );

    await expect(store.bootstrap()).resolves.toBe(false);
    expect(toastMessages()).toContain("后端返回的车队快照无法解析");
    expect(toastMessages()).not.toContain(
      "无法连接后端服务，请检查服务状态后重试",
    );
  });

  it("marks the bootstrap as pending only while it is in flight", async () => {
    type Snapshot = Awaited<ReturnType<typeof fleetApi.getSnapshot>>;
    let release: (value: Snapshot) => void = () => undefined;
    vi.spyOn(fleetApi, "getSnapshot").mockReturnValue(
      new Promise<Snapshot>((resolve) => {
        release = resolve;
      }),
    );

    const pending = store.bootstrap();
    await Promise.resolve();
    expect(store.bootstrapPending).toBe(true);

    release(snapshot([device()]));
    await pending;
    expect(store.bootstrapPending).toBe(false);
  });
});

describe("what arrives over the socket", () => {
  /** Bootstraps, then hands back the accepted socket to push frames into. */
  const live = async () => {
    vi.spyOn(fleetApi, "getSnapshot").mockResolvedValue(snapshot([device()]));
    await store.bootstrap();
    return acceptLastSocket();
  };

  it("merges a delta frame into the fleet", async () => {
    const socket = await live();
    socket.deliver({
      type: "fleet.delta",
      payload: { device: device({ deviceName: "AGV 01 新名" }) },
    });

    expect(store.selectedDevice?.deviceName).toBe("AGV 01 新名");
    expect(store.state.lastSource).toBe("mqtt");
  });

  it("accepts a delta whose payload is the device itself", async () => {
    const socket = await live();
    socket.deliver({
      type: "fleet.delta",
      payload: device({ deviceId: "agv-42" }),
    });

    expect(store.sortedDevices.map((item) => item.deviceId)).toEqual([
      "agv-01",
      "agv-42",
    ]);
  });

  it("replaces the fleet from a snapshot frame", async () => {
    const socket = await live();
    socket.deliver({
      type: "fleet.snapshot",
      payload: snapshot([device({ deviceId: "agv-99" })]),
    });

    expect(store.sortedDevices.map((item) => item.deviceId)).toEqual([
      "agv-99",
    ]);
    expect(store.state.lastSource).toBe("ws");
  });

  it("survives a frame it cannot normalize", async () => {
    // One unusable frame must not take the link down with it: the next telemetry
    // message is a second later and is usually fine.
    const socket = await live();
    socket.deliver({ type: "fleet.delta", payload: "nonsense" });

    expect(store.sortedDevices).toHaveLength(1);
    expect(store.state.realtime.linkStatus).toBe("open");
  });

  it("ignores a frame with no type at all", async () => {
    const socket = await live();
    socket.deliver({ payload: { device: device({ deviceId: "agv-42" }) } });

    expect(store.sortedDevices).toHaveLength(1);
  });

  it("announces losing the link, then getting it back — once each", async () => {
    const socket = await live();
    // Fake timers only from here: the bootstrap above resolves on promises, but the
    // reconnect that follows the drop is on the backoff timer.
    vi.useFakeTimers();
    try {
      socket.drop();
      expect(toastMessages()).toContain("实时连接中断，正在自动重连…");

      vi.advanceTimersByTime(1_000);
      acceptLastSocket();
      expect(toastMessages()).toContain("实时连接已恢复");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about a link that was never up", async () => {
    // Otherwise a cold start against a down backend opens with "连接中断",
    // reporting the loss of something the operator never had.
    vi.spyOn(fleetApi, "getSnapshot").mockResolvedValue(snapshot([device()]));
    await store.bootstrap();

    openedSockets.at(-1)?.drop();
    expect(toastMessages()).not.toContain("实时连接中断，正在自动重连…");
  });
});

describe("what the top bar says", () => {
  it("reports the snapshot request while it is in flight", () => {
    store.state.realtime.bootstrapPending = true;
    expect(store.connection).toMatchObject({
      tone: "pending",
      label: "连接中",
    });
  });

  it("reports an unreachable backend as the worst state", () => {
    store.state.realtime.apiReady = false;
    expect(store.connection).toMatchObject({
      tone: "critical",
      label: "后端离线",
    });
  });

  it("separates a live link from one that is retrying", () => {
    // The distinction is the point: the API answering while the socket is down
    // means the page is showing stale data, not that nothing works.
    store.state.realtime.apiReady = true;
    store.state.realtime.linkStatus = "open";
    expect(store.connection).toMatchObject({ tone: "ok", label: "实时" });

    store.state.realtime.linkStatus = "reconnecting";
    store.state.realtime.reconnectAttempts = 3;
    expect(store.connection.tone).toBe("warning");
    expect(store.connection.detail).toContain("第 3 次");
  });

  it("does not call a first connection a reconnection", () => {
    // FIXED: every cold start spent the socket's opening moments claiming 重连中,
    // announcing a failure that had not happened. Found by the first test that
    // rendered the indicator against a socket which had not opened yet.
    store.state.realtime.apiReady = true;
    store.state.realtime.linkStatus = "connecting";

    expect(store.connection).toMatchObject({
      tone: "pending",
      label: "连接中",
    });
  });
});
