/**
 * Fleet monitoring store (Pinia).
 *
 * Successor to the monolithic `useDashboard` composable. Owns the reactive
 * fleet state, derived views (sorted/filtered devices, formations, grouped
 * alerts, per-device trails), and the resilient realtime (WebSocket) link.
 * Pure shaping logic lives in `../lib/fleetNormalize`; REST access lives in
 * `../services/fleetApi`. Being a store (single instance) it is safely shared
 * across router views without duplicating the socket or state.
 */

import { computed, reactive, toRaw } from "vue";
import { defineStore } from "pinia";
import { fallbackFleetPayload, sceneCatalog } from "../data-defaults";
import { fleetApi } from "../services/fleetApi";
import { notify } from "../composables/useNotifications";
import {
  cloneValue,
  round,
  toTimestampMs,
  formatDateTime,
  extractDeviceIdFromTopic,
  hasPose,
  normalizeDevice,
  normalizeFormation,
  normalizePathPoint,
  pointsAreNear,
  pickTrailPose,
  mergeDevice,
  mergeSceneDefinitionParts,
  TRAIL_MAX_POINTS,
  TRAIL_MIN_DISTANCE,
} from "../lib/fleetNormalize";
import type {
  DeviceAlert,
  DeviceSnapshot,
  FormationSnapshot,
  SceneMapDefinition,
  Severity,
} from "@navfleet/shared";
import type { SceneDefinition } from "../services/fleetApi";

/**
 * Loose scene-definition record: seeded from the typed catalog and then merged
 * with dynamically-shaped backend/scene parts, so the value is either a known
 * `SceneMapDefinition` or an open record.
 */
type SceneDefinitionRecord = SceneMapDefinition | Record<string, unknown>;
/** A movement-trail sample (world-space point). */
type TrailPoint = { x: number; y: number };
/** One grouped alert row: a device alert annotated with its owning device. */
type GroupedAlert = DeviceAlert & { deviceId: string; deviceName: string };
type GroupedAlerts = Record<Severity, GroupedAlert[]>;

/** Canonical shape produced by `normalizePayload` from a raw inbound payload. */
interface NormalizedPayload {
  replace: boolean;
  fleetName: string;
  topicPattern: string;
  devices: DeviceSnapshot[];
  formations: FormationSnapshot[] | null;
}

interface RealtimeState {
  apiReady: boolean;
  wsReady: boolean;
  ws: WebSocket | null;
  reconnectAttempts: number;
  /**
   * True while the very first snapshot request is in flight.
   *
   * Without it a view cannot tell "no data has arrived yet" from "no data
   * matches the current filters", so a cold load rendered the empty-filter
   * message for however long the request took — telling the operator their
   * filters were wrong when nothing had been filtered at all. Views render
   * skeleton placeholders while this is set.
   */
  bootstrapPending: boolean;
}

interface FleetState {
  fleetName: string;
  topicPattern: string;
  devicesById: Record<string, DeviceSnapshot>;
  formationsById: Record<string, FormationSnapshot>;
  selectedDeviceId: string;
  selectedFormationId: string;
  selectedMapMode: string;
  lastSource: string;
  lastUpdateAt: string | null;
  sceneDefinitions: Record<string, SceneDefinitionRecord>;
  pendingSceneLoads: Record<string, boolean>;
  trailsByDeviceId: Record<string, TrailPoint[]>;
  realtime: RealtimeState;
}

export const useFleetStore = defineStore("fleet", () => {
  const state = reactive<FleetState>({
    fleetName: fallbackFleetPayload.fleetName,
    topicPattern: fallbackFleetPayload.topicPattern,
    devicesById: {},
    formationsById: {},
    selectedDeviceId: "",
    selectedFormationId: "",
    selectedMapMode: "gps",
    lastSource: "bootstrap",
    lastUpdateAt: null,
    sceneDefinitions: cloneValue(sceneCatalog),
    pendingSceneLoads: {},
    trailsByDeviceId: {},
    realtime: {
      apiReady: false,
      wsReady: false,
      ws: null,
      reconnectAttempts: 0,
      bootstrapPending: false,
    },
  });

  const getSceneDefinition = (sceneId: string) => {
    if (!sceneId) {
      return null;
    }
    return state.sceneDefinitions[sceneId] || sceneCatalog[sceneId] || null;
  };

  const mergeSceneDefinition = (definition: SceneDefinition) => {
    if (!definition?.sceneId) {
      return;
    }
    // `SceneMapDefinition` has no index signature, so bridge it to the loose,
    // dynamically-merged shape `mergeSceneDefinitionParts` consumes.
    const fallback = (sceneCatalog[definition.sceneId] || {}) as unknown as Record<string, unknown>;
    state.sceneDefinitions[definition.sceneId] = mergeSceneDefinitionParts(fallback, definition);
  };

  const normalizePayload = (input: unknown): NormalizedPayload => {
    if (!input || typeof input !== "object") {
      throw new Error("消息必须是 JSON 对象");
    }

    if (Array.isArray(input)) {
      return {
        replace: true,
        fleetName: state.fleetName,
        topicPattern: state.topicPattern,
        devices: input.map((item) => normalizeDevice(item)),
        formations: null,
      };
    }

    const record = input as Record<string, unknown>;

    if (Array.isArray(record.devices)) {
      return {
        replace: true,
        fleetName: (record.fleetName as string) || state.fleetName,
        topicPattern: (record.topicPattern as string) || state.topicPattern,
        devices: record.devices.map((item) => normalizeDevice(item)),
        formations: Array.isArray(record.formations)
          ? record.formations.map((item) => normalizeFormation(item))
          : null,
      };
    }

    if (record.topic && record.payload !== undefined) {
      const payloadBody =
        typeof record.payload === "string" ? JSON.parse(record.payload) : record.payload;
      const body = payloadBody as Record<string, unknown>;
      const existing =
        state.devicesById[(body.deviceId as string) || extractDeviceIdFromTopic(record.topic)];
      return {
        replace: false,
        fleetName: state.fleetName,
        topicPattern: state.topicPattern,
        devices: [normalizeDevice(payloadBody, record.topic as string, existing)],
        formations: Array.isArray(body.formations)
          ? body.formations.map((item) => normalizeFormation(item))
          : null,
      };
    }

    const existing =
      state.devicesById[(record.deviceId as string) || extractDeviceIdFromTopic(record.topic)];
    return {
      replace: false,
      fleetName: (record.fleetName as string) || state.fleetName,
      topicPattern: (record.topicPattern as string) || state.topicPattern,
      devices: [normalizeDevice(record, record.topic as string, existing)],
      formations: Array.isArray(record.formations)
        ? record.formations.map((item) => normalizeFormation(item))
        : null,
    };
  };

  const devices = computed<DeviceSnapshot[]>(() => Object.values(state.devicesById));
  const formations = computed<FormationSnapshot[]>(() =>
    Object.values(state.formationsById).map((formation) => {
      const memberDevices = (formation.deviceIds || [])
        .map((deviceId: string) => state.devicesById[deviceId])
        .filter(Boolean);
      const sceneCandidates = memberDevices
        .map((device) => device.sceneId || device.runtimeSceneId || device.defaultSceneId || "")
        .filter(Boolean);
      const uniqueScenes = [...new Set(sceneCandidates)];

      return {
        ...formation,
        deviceCount: memberDevices.length || formation.deviceCount || 0,
        onlineCount: memberDevices.filter((device) => device.online).length,
        sceneId:
          formation.sceneId ||
          (uniqueScenes.length === 1 ? uniqueScenes[0] : memberDevices[0]?.sceneId || ""),
      };
    }),
  );

  const getDeviceTone = (device: DeviceSnapshot) => {
    if (!device.online) {
      return "offline";
    }
    if (Number(device.errorCode?.code) !== 0) {
      return "critical";
    }
    if (Number(device.warningCode?.code) !== 0) {
      return "warning";
    }
    if (Number(device.infoCode?.code) !== 0) {
      return "notice";
    }
    return "normal";
  };

  // Fixed, stable ordering by device id so rows never jump as telemetry/alerts
  // update — severity is still conveyed by each row's colour/status, not order.
  const sortedDevices = computed<DeviceSnapshot[]>(() =>
    [...devices.value].sort((left, right) =>
      String(left.deviceId).localeCompare(String(right.deviceId), "en"),
    ),
  );

  const sortedFormations = computed<FormationSnapshot[]>(() =>
    [...formations.value].sort((left, right) =>
      String(left.formationId).localeCompare(String(right.formationId), "en"),
    ),
  );

  const selectedDevice = computed<DeviceSnapshot | null>(
    () => state.devicesById[state.selectedDeviceId] || null,
  );
  const selectedFormation = computed<FormationSnapshot | null>(
    () => state.formationsById[state.selectedFormationId] || null,
  );

  const filteredDevices = computed<DeviceSnapshot[]>(() => {
    if (!selectedFormation.value) {
      return sortedDevices.value;
    }
    const formationDeviceIds = new Set(selectedFormation.value.deviceIds || []);
    return sortedDevices.value.filter((device) => formationDeviceIds.has(device.deviceId));
  });

  const formationSceneId = computed(
    () => selectedFormation.value?.sceneId || selectedDevice.value?.sceneId || "",
  );

  const summary = computed(() => {
    const onlineCount = devices.value.filter((device) => device.online).length;
    const alertTotal = devices.value.reduce((sum, device) => sum + device.alerts.length, 0);
    return {
      totalCount: devices.value.length,
      onlineCount,
      alertTotal,
      focusName: selectedFormation.value?.formationName || selectedDevice.value?.deviceName || "--",
    };
  });

  const groupedAlerts = computed<GroupedAlerts>(() => {
    const grouped: GroupedAlerts = { critical: [], warning: [], notice: [] };
    devices.value.forEach((device) => {
      device.alerts.forEach((alert) => {
        grouped[alert.severity].push({
          ...alert,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
        });
      });
    });
    Object.values(grouped).forEach((list) => {
      list.sort((left, right) => toTimestampMs(right.ts) - toTimestampMs(left.ts));
    });
    return grouped;
  });

  /**
   * Vehicles the scene map should draw alongside the selected one.
   *
   * With a formation selected, that formation's members; otherwise every vehicle
   * standing in the same scene. It used to return nothing at all without a
   * formation, so a scene map of a six-vehicle site showed exactly one vehicle
   * and no hint that the others existed.
   */
  const sceneDevices = computed<DeviceSnapshot[]>(() => {
    const currentSceneId = formationSceneId.value;
    const formationDeviceIds = selectedFormation.value
      ? new Set(selectedFormation.value.deviceIds || [])
      : null;
    return sortedDevices.value.filter(
      (device) =>
        (!formationDeviceIds || formationDeviceIds.has(device.deviceId)) &&
        device.rosMapEnabled !== false &&
        (!currentSceneId || device.sceneId === currentSceneId),
    );
  });

  const ensureSelectedDevice = () => {
    if (state.selectedDeviceId && state.devicesById[state.selectedDeviceId]) {
      if (!selectedFormation.value) {
        return;
      }
      if ((selectedFormation.value.deviceIds || []).includes(state.selectedDeviceId)) {
        return;
      }
    }

    if (selectedFormation.value) {
      const preferred = filteredDevices.value.find(
        (device) => !formationSceneId.value || device.sceneId === formationSceneId.value,
      );
      state.selectedDeviceId = preferred?.deviceId || filteredDevices.value[0]?.deviceId || "";
      return;
    }

    state.selectedDeviceId = sortedDevices.value[0]?.deviceId || "";
  };

  const primeSceneDefinitions = (list: DeviceSnapshot[]) => {
    list.forEach((device) => {
      if (device.sceneId && !getSceneDefinition(device.sceneId)) {
        void loadSceneDefinition(device.sceneId);
      }
    });
  };

  const recordTrails = (
    incomingDevices: DeviceSnapshot[],
    mergedById: Record<string, DeviceSnapshot>,
    replace: boolean,
  ) => {
    const nextTrails: Record<string, TrailPoint[]> = { ...state.trailsByDeviceId };
    incomingDevices.forEach((device) => {
      const pose = pickTrailPose(mergedById[device.deviceId]);
      const point = pose ? normalizePathPoint(pose) : null;
      if (!point) {
        return;
      }
      const existing = nextTrails[device.deviceId] || [];
      const last = existing[existing.length - 1];
      if (last && pointsAreNear(last, point, TRAIL_MIN_DISTANCE)) {
        return;
      }
      const appended = [...existing, point];
      nextTrails[device.deviceId] =
        appended.length > TRAIL_MAX_POINTS
          ? appended.slice(appended.length - TRAIL_MAX_POINTS)
          : appended;
    });
    if (replace) {
      Object.keys(nextTrails).forEach((deviceId) => {
        if (!mergedById[deviceId]) {
          delete nextTrails[deviceId];
        }
      });
    }
    state.trailsByDeviceId = nextTrails;
  };

  const ingestPayload = (rawPayload: unknown, source: string) => {
    const normalized = normalizePayload(rawPayload);
    const nextDevicesById: Record<string, DeviceSnapshot> = normalized.replace
      ? {}
      : { ...state.devicesById };

    normalized.devices.forEach((device) => {
      const existingDevice = state.devicesById[device.deviceId];
      nextDevicesById[device.deviceId] = mergeDevice(existingDevice, device);
    });

    if (normalized.formations) {
      const nextFormationsById: Record<string, FormationSnapshot> = {};
      normalized.formations.forEach((formation) => {
        const existingFormation = state.formationsById[formation.formationId];
        nextFormationsById[formation.formationId] = normalizeFormation(
          formation,
          existingFormation,
        );
      });
      state.formationsById = nextFormationsById;
    }

    state.devicesById = nextDevicesById;
    recordTrails(normalized.devices, nextDevicesById, normalized.replace);
    state.fleetName = normalized.fleetName;
    state.topicPattern = normalized.topicPattern;
    state.lastSource = source;
    state.lastUpdateAt = new Date().toISOString();
    primeSceneDefinitions(Object.values(state.devicesById));
    ensureSelectedDevice();
  };

  const buildFleetSnapshot = () => ({
    fleetName: state.fleetName,
    topicPattern: state.topicPattern,
    updatedAt: state.lastUpdateAt || new Date().toISOString(),
    devices: sortedDevices.value.map((device) => cloneValue(device)),
    formations: sortedFormations.value.map((formation) => cloneValue(formation)),
  });

  const trailsByDeviceId = computed(() => state.trailsByDeviceId);

  const clearTrail = (deviceId = state.selectedDeviceId) => {
    if (!deviceId || !state.trailsByDeviceId[deviceId]) {
      return;
    }
    const next = { ...state.trailsByDeviceId };
    delete next[deviceId];
    state.trailsByDeviceId = next;
  };

  const selectDevice = (deviceId: string, options: { preserveFormation?: boolean } = {}) => {
    if (!state.devicesById[deviceId]) {
      return;
    }

    state.selectedDeviceId = deviceId;
    if (!options.preserveFormation) {
      const belongsToSelectedFormation =
        selectedFormation.value && (selectedFormation.value.deviceIds || []).includes(deviceId);
      if (!belongsToSelectedFormation) {
        state.selectedFormationId = "";
      }
    }
  };

  const selectFormation = (formationId: string) => {
    if (!state.formationsById[formationId]) {
      return;
    }
    state.selectedFormationId = formationId;
    state.selectedMapMode = "scene";
    ensureSelectedDevice();
  };

  const clearFormationSelection = () => {
    state.selectedFormationId = "";
    ensureSelectedDevice();
  };

  const setMapMode = (mode: string) => {
    state.selectedMapMode = mode;
  };

  const resolveWebSocketUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  };

  // Reconnect with exponential backoff (capped); app-level ping/pong detects a
  // silently dead socket that never fires "close" (e.g. network black-hole).
  const WS_HEARTBEAT_MS = 20000;
  const WS_PONG_GRACE_MS = 10000;
  const WS_BACKOFF_BASE_MS = 1000;
  const WS_BACKOFF_MAX_MS = 30000;

  let wsReconnectTimer: number | null = null;
  let wsHeartbeatTimer: number | null = null;
  let wsPongTimer: number | null = null;
  let wsManuallyClosed = false;

  const clearWsTimers = () => {
    [wsReconnectTimer, wsHeartbeatTimer, wsPongTimer].forEach((timer) => {
      if (timer) {
        window.clearTimeout(timer);
        window.clearInterval(timer);
      }
    });
    wsReconnectTimer = null;
    wsHeartbeatTimer = null;
    wsPongTimer = null;
  };

  const scheduleReconnect = () => {
    if (wsManuallyClosed || wsReconnectTimer) {
      return;
    }
    const attempt = state.realtime.reconnectAttempts;
    const delay = Math.min(WS_BACKOFF_BASE_MS * 2 ** attempt, WS_BACKOFF_MAX_MS);
    state.realtime.reconnectAttempts = attempt + 1;
    wsReconnectTimer = window.setTimeout(() => {
      wsReconnectTimer = null;
      connectRealtime();
    }, delay);
  };

  const startHeartbeat = (ws: WebSocket) => {
    wsHeartbeatTimer = window.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        return;
      }
      if (wsPongTimer) {
        window.clearTimeout(wsPongTimer);
      }
      wsPongTimer = window.setTimeout(() => {
        // No pong in time — assume the socket is dead and force a reconnect.
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, WS_PONG_GRACE_MS);
    }, WS_HEARTBEAT_MS);
  };

  const connectRealtime = () => {
    if (state.realtime.ws) {
      return;
    }
    wsManuallyClosed = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(resolveWebSocketUrl());
    } catch {
      state.realtime.wsReady = false;
      state.realtime.ws = null;
      scheduleReconnect();
      return;
    }
    state.realtime.ws = ws;

    ws.addEventListener("open", () => {
      state.realtime.wsReady = true;
      if (state.realtime.reconnectAttempts > 0) {
        notify("实时连接已恢复", { type: "success", dedupeKey: "ws-restored" });
      }
      state.realtime.reconnectAttempts = 0;
      startHeartbeat(ws);
    });

    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "pong") {
          if (wsPongTimer) {
            window.clearTimeout(wsPongTimer);
            wsPongTimer = null;
          }
          return;
        }
        if (message.type === "fleet.snapshot") {
          ingestPayload(message.payload, "ws");
          return;
        }
        if (message.type === "fleet.delta") {
          ingestPayload(message.payload.device || message.payload, "mqtt");
        }
      } catch {
        // Ignore malformed messages.
      }
    });

    const markClosed = () => {
      const wasReady = state.realtime.wsReady;
      state.realtime.wsReady = false;
      state.realtime.ws = null;
      clearWsTimers();
      if (wasReady && !wsManuallyClosed) {
        notify("实时连接中断，正在自动重连…", { type: "warning", dedupeKey: "ws-down" });
      }
      scheduleReconnect();
    };
    ws.addEventListener("close", markClosed);
    ws.addEventListener("error", () => {
      // "error" is followed by "close"; let markClosed drive the reconnect.
    });
  };

  const disconnectRealtime = () => {
    wsManuallyClosed = true;
    clearWsTimers();
    if (state.realtime.ws) {
      try {
        state.realtime.ws.close();
      } catch {
        // ignore
      }
    }
    state.realtime.ws = null;
    state.realtime.wsReady = false;
    state.realtime.reconnectAttempts = 0;
  };

  const loadSceneDefinition = async (sceneId: string) => {
    if (!sceneId || state.pendingSceneLoads[sceneId]) {
      return;
    }
    state.pendingSceneLoads[sceneId] = true;
    try {
      mergeSceneDefinition(await fleetApi.getScene(sceneId));
    } catch {
      // Keep local fallback.
    } finally {
      delete state.pendingSceneLoads[sceneId];
    }
  };

  const loadSceneCatalogFromBackend = async () => {
    try {
      const payload = await fleetApi.getScenes();
      (payload.items || []).forEach(mergeSceneDefinition);
      return true;
    } catch {
      return false;
    }
  };

  const bootstrapFromBackend = async () => {
    try {
      await loadSceneCatalogFromBackend();
      const payload = await fleetApi.getSnapshot();
      state.realtime.apiReady = true;
      ingestPayload(payload, "api");
      connectRealtime();
      return true;
    } catch {
      state.realtime.apiReady = false;
      notify("无法连接后端服务，请检查服务状态后重试", {
        type: "error",
        dedupeKey: "bootstrap-failed",
      });
      return false;
    }
  };

  const bootstrapEmptyState = async () => {
    const payload = cloneValue(fallbackFleetPayload);
    ingestPayload(payload, "bootstrap");
  };

  const retryBootstrap = async () => {
    state.realtime.bootstrapPending = true;
    try {
      const ready = await bootstrapFromBackend();
      if (!ready) {
        await bootstrapEmptyState();
      }
      return ready;
    } finally {
      state.realtime.bootstrapPending = false;
    }
  };

  const bootstrap = async () => {
    state.realtime.bootstrapPending = true;
    try {
      const backendReady = await bootstrapFromBackend();
      if (!backendReady) {
        await bootstrapEmptyState();
      }
    } finally {
      state.realtime.bootstrapPending = false;
    }
  };

  const bootstrapPending = computed(() => state.realtime.bootstrapPending);

  const registerWindowApi = () => {
    (window as unknown as Record<string, unknown>).vehicleDashboard = {
      updateFromPayload(payload: unknown) {
        const normalizedPayload = typeof payload === "string" ? JSON.parse(payload) : payload;
        ingestPayload(normalizedPayload, "mqtt");
      },
      selectDevice,
      selectFormation,
      clearFormationSelection,
      getSnapshot() {
        return cloneValue(toRaw(buildFleetSnapshot()));
      },
      getBackendStatus() {
        return {
          apiReady: state.realtime.apiReady,
          wsReady: state.realtime.wsReady,
          source: state.lastSource,
        };
      },
    };
  };

  return {
    state,
    formations,
    sortedDevices,
    filteredDevices,
    sortedFormations,
    selectedDevice,
    selectedFormation,
    summary,
    groupedAlerts,
    bootstrapPending,
    sceneDevices,
    formationSceneId,
    hasPose,
    round,
    formatDateTime,
    getSceneDefinition,
    getDeviceTone,
    buildFleetSnapshot,
    bootstrap,
    registerWindowApi,
    selectDevice,
    selectFormation,
    clearFormationSelection,
    setMapMode,
    trailsByDeviceId,
    clearTrail,
    retryBootstrap,
    disconnectRealtime,
  };
});
