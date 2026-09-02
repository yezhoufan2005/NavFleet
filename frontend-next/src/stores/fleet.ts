/**
 * Fleet monitoring store (Pinia) — the console's data layer.
 *
 * Owns the reactive fleet state, the derived views every page reads, and the
 * bootstrap sequence. Pure shaping logic and REST access live in
 * `@navfleet/fleet-core`, and the socket lives in `lib/realtimeLink.ts`; what is
 * left here is the part that is genuinely about *this* application's state.
 *
 * Ported from the v1.0.0 store with three deliberate differences:
 *
 * - **The socket is not in the state.** v1.0.0 kept the live `WebSocket` on
 *   `state.realtime.ws`. Nothing rendered it, and a connection object inside a
 *   `reactive()` invites the question of whether calls on it go through a proxy.
 *   The link is a closure in `realtimeLink.ts`; the store keeps only what the UI
 *   can display — a status, an attempt count, and whether the API answered.
 * - **No `window.vehicleDashboard` bridge.** v1.0.0 published `updateFromPayload`
 *   and friends on `window` for the pre-Vue page to drive. Nothing reads it: not
 *   the app, and not one of the 36 e2e assertions. Porting a debug surface that
 *   accepts arbitrary state into the console would be adding an injection point
 *   for no gain, so it stops here.
 * - **No map-mode preference.** v1.0.0 persisted a two-value `gps|scene` toggle.
 *   Phase 13A-2 needs a three-state list/map/auto mode with a vehicle-count
 *   threshold, so porting the two-state version now would only be something to
 *   delete. It arrives with the maps that need it.
 */

import { computed, reactive } from "vue";
import { defineStore } from "pinia";
import {
  cloneValue,
  deviceToneRank,
  extractDeviceIdFromTopic,
  fallbackFleetPayload,
  fleetApi,
  getDeviceTone,
  hasGps,
  mergeDevice,
  mergeSceneDefinitionParts,
  normalizeDevice,
  normalizeFormation,
  normalizePathPoint,
  pickTrailPose,
  pointsAreNear,
  sceneCatalog,
  toTimestampMsOrNow,
  TRAIL_MAX_POINTS,
  TRAIL_MIN_DISTANCE,
} from "@navfleet/fleet-core";
import type { SceneDefinition } from "@navfleet/fleet-core";
import type {
  DeviceAlert,
  DeviceSnapshot,
  FormationSnapshot,
  SceneMapDefinition,
  Severity,
} from "@navfleet/shared";
import { notify } from "@/composables/useNotifications";
import { createRealtimeLink } from "@/lib/realtimeLink";
import type { RealtimeLink, RealtimeLinkStatus } from "@/lib/realtimeLink";

/**
 * Loose scene-definition record: seeded from the typed catalog and then merged
 * with dynamically-shaped backend parts, so a value is either a known
 * `SceneMapDefinition` or an open record.
 */
type SceneDefinitionRecord = SceneMapDefinition | Record<string, unknown>;
/** A movement-trail sample (world-space point). */
export type TrailPoint = { x: number; y: number };
/** One grouped alert row: a device alert annotated with its owning device. */
export type GroupedAlert = DeviceAlert & {
  deviceId: string;
  deviceName: string;
  /**
   * When this alert was **first seen**, in epoch ms — as distinct from `ts`, which is
   * the last report that carried it. See `alertFirstSeen`.
   */
  firstSeenAt: number;
};
export type GroupedAlerts = Record<Severity, GroupedAlert[]>;

/** Canonical shape produced by `normalizePayload` from a raw inbound payload. */
interface NormalizedPayload {
  replace: boolean;
  fleetName: string;
  topicPattern: string;
  devices: DeviceSnapshot[];
  formations: FormationSnapshot[] | null;
  /** The server's own timestamp, when the payload carries one. */
  updatedAt: string | null;
}

interface RealtimeState {
  /** Did the last snapshot request succeed? */
  apiReady: boolean;
  linkStatus: RealtimeLinkStatus;
  reconnectAttempts: number;
  /**
   * True while the very first snapshot request is in flight.
   *
   * Without it a view cannot tell "no data has arrived yet" from "no data matches
   * the current filters", so a cold load rendered the empty-filter message for
   * however long the request took — telling the operator their filters were wrong
   * when nothing had been filtered at all. 总览 and 设备 render `UiSkeleton` while it
   * is set, each with `aria-busy` on the region that owns the placeholders.
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
  lastSource: string;
  /**
   * When *this browser* last ingested something, and when the *server* last said its
   * fleet state changed. Both, because they answer different questions and are
   * measured on different clocks.
   *
   * Freshness ("how stale is what I am looking at") has to be measured on one clock or
   * a skewed browser produces "更新于 -8 秒前"; that is `lastUpdateAt`. The absolute
   * time worth *displaying* is the server's — an ingest timestamp looks fresh even
   * when the backend stopped producing hours ago. v1.0.0 kept only the first and
   * overwrote the server's value with `new Date()`, so it could not tell the two apart.
   */
  lastUpdateAt: string | null;
  serverUpdatedAt: string | null;
  sceneDefinitions: Record<string, SceneDefinitionRecord>;
  pendingSceneLoads: Record<string, boolean>;
  trailsByDeviceId: Record<string, TrailPoint[]>;
  realtime: RealtimeState;
}

/** How the link should be described on screen. See `connection` below. */
export type ConnectionTone = "ok" | "warning" | "critical" | "pending";

export const useFleetStore = defineStore("fleet", () => {
  const state = reactive<FleetState>({
    fleetName: fallbackFleetPayload.fleetName,
    topicPattern: fallbackFleetPayload.topicPattern,
    devicesById: {},
    formationsById: {},
    selectedDeviceId: "",
    selectedFormationId: "",
    lastSource: "bootstrap",
    lastUpdateAt: null,
    serverUpdatedAt: null,
    sceneDefinitions: cloneValue(sceneCatalog),
    pendingSceneLoads: {},
    trailsByDeviceId: {},
    realtime: {
      apiReady: false,
      linkStatus: "idle",
      reconnectAttempts: 0,
      bootstrapPending: false,
    },
  });

  const getSceneDefinition = (
    sceneId: string,
  ): SceneDefinitionRecord | null => {
    if (!sceneId) return null;
    return state.sceneDefinitions[sceneId] || sceneCatalog[sceneId] || null;
  };

  const mergeSceneDefinition = (definition: SceneDefinition): void => {
    if (!definition?.sceneId) return;
    // `SceneMapDefinition` has no index signature, so bridge it to the loose,
    // dynamically-merged shape `mergeSceneDefinitionParts` consumes.
    const fallback = (sceneCatalog[definition.sceneId] ||
      {}) as unknown as Record<string, unknown>;
    state.sceneDefinitions[definition.sceneId] = mergeSceneDefinitionParts(
      fallback,
      definition,
    );
  };

  const loadSceneDefinition = async (sceneId: string): Promise<void> => {
    if (!sceneId || state.pendingSceneLoads[sceneId]) return;
    state.pendingSceneLoads[sceneId] = true;
    try {
      mergeSceneDefinition(await fleetApi.getScene(sceneId));
    } catch {
      // Keep whatever local fallback we have; a missing scene must not blank the map.
    } finally {
      delete state.pendingSceneLoads[sceneId];
    }
  };

  const loadSceneCatalog = async (): Promise<boolean> => {
    try {
      const payload = await fleetApi.getScenes();
      (payload.items || []).forEach(mergeSceneDefinition);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Four inbound shapes, because the backend, the MQTT bridge and the offline
   * fallback do not agree on one: a bare array of devices, a full snapshot, a
   * `{topic, payload}` envelope, and a single loose device record.
   */
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
        updatedAt: null,
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
        // Only a full snapshot restates it; a delta says nothing about the fleet's
        // overall timestamp, so the last known one stands.
        updatedAt:
          typeof record.updatedAt === "string" ? record.updatedAt : null,
      };
    }

    if (record.topic && record.payload !== undefined) {
      const payloadBody =
        typeof record.payload === "string"
          ? JSON.parse(record.payload)
          : record.payload;
      const body = payloadBody as Record<string, unknown>;
      const existing =
        state.devicesById[
          (body.deviceId as string) || extractDeviceIdFromTopic(record.topic)
        ];
      return {
        replace: false,
        fleetName: state.fleetName,
        topicPattern: state.topicPattern,
        devices: [
          normalizeDevice(payloadBody, record.topic as string, existing),
        ],
        formations: Array.isArray(body.formations)
          ? body.formations.map((item) => normalizeFormation(item))
          : null,
        updatedAt: null,
      };
    }

    const existing =
      state.devicesById[
        (record.deviceId as string) || extractDeviceIdFromTopic(record.topic)
      ];
    return {
      replace: false,
      fleetName: (record.fleetName as string) || state.fleetName,
      topicPattern: (record.topicPattern as string) || state.topicPattern,
      devices: [normalizeDevice(record, record.topic as string, existing)],
      formations: Array.isArray(record.formations)
        ? record.formations.map((item) => normalizeFormation(item))
        : null,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    };
  };

  const devices = computed<DeviceSnapshot[]>(() =>
    Object.values(state.devicesById),
  );

  const formations = computed<FormationSnapshot[]>(() =>
    Object.values(state.formationsById).map((formation) => {
      // A predicate rather than `.filter(Boolean)`: a formation may list a device
      // the fleet has not sent yet, so the lookup really can miss, and `Boolean`
      // does not tell the compiler the misses are gone. v1.0.0 wrote it the short
      // way and only compiled because its tsconfig did not check index access.
      const memberDevices = (formation.deviceIds || [])
        .map((deviceId: string) => state.devicesById[deviceId])
        .filter((device): device is DeviceSnapshot => device !== undefined);
      const sceneCandidates = memberDevices
        .map(
          (device) =>
            device.sceneId ||
            device.runtimeSceneId ||
            device.defaultSceneId ||
            "",
        )
        .filter(Boolean);
      const uniqueScenes = [...new Set(sceneCandidates)];

      return {
        ...formation,
        deviceCount: memberDevices.length || formation.deviceCount || 0,
        onlineCount: memberDevices.filter((device) => device.online).length,
        sceneId:
          formation.sceneId ||
          (uniqueScenes.length === 1
            ? (uniqueScenes[0] ?? "")
            : memberDevices[0]?.sceneId || ""),
      };
    }),
  );

  // Fixed, stable ordering by device id so rows never jump as telemetry updates —
  // severity is conveyed by each row's status, not by its position.
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
    if (!selectedFormation.value) return sortedDevices.value;
    const formationDeviceIds = new Set(selectedFormation.value.deviceIds || []);
    return sortedDevices.value.filter((device) =>
      formationDeviceIds.has(device.deviceId),
    );
  });

  const formationSceneId = computed(
    () =>
      selectedFormation.value?.sceneId || selectedDevice.value?.sceneId || "",
  );

  /**
   * Fleet counts, recomputed from the devices in hand rather than read off the
   * server's `summary`.
   *
   * The backend does send one (`deviceCount` / `onlineCount` / `alertCount` /
   * `gpsCount`), and taking it would be wrong: it is computed when a *snapshot* is
   * built, while most of what arrives afterwards is single-device deltas. The
   * server's numbers would then disagree with the rows on screen, which is worse
   * than recomputing. `gpsCount` is the one it had that we did not — so it is
   * computed here, on the same terms as the rest.
   */
  const summary = computed(() => {
    const onlineCount = devices.value.filter((device) => device.online).length;
    const alertTotal = devices.value.reduce(
      (sum, device) => sum + device.alerts.length,
      0,
    );
    const gpsCount = devices.value.filter(
      (device) => device.gpsEnabled !== false && hasGps(device.gps),
    ).length;
    return {
      totalCount: devices.value.length,
      onlineCount,
      alertTotal,
      gpsCount,
      focusName:
        selectedFormation.value?.formationName ||
        selectedDevice.value?.deviceName ||
        "--",
    };
  });

  /**
   * The fleet ordered by who needs attention, worst tone first, id second.
   *
   * This is what the overview page is for — "which few need me right now" rather
   * than "where is everyone". The ordering lives here rather than in the page so the
   * wall display cannot invent a different answer to the same question, which is the
   * argument that hoisted `deviceToneRank` into `fleet-core` in the first place.
   */
  const devicesByAttention = computed<DeviceSnapshot[]>(() =>
    [...sortedDevices.value].sort((left, right) => {
      const byTone =
        deviceToneRank(getDeviceTone(left)) -
        deviceToneRank(getDeviceTone(right));
      return byTone !== 0
        ? byTone
        : String(left.deviceId).localeCompare(String(right.deviceId), "en");
    }),
  );

  /**
   * When each alert id was first seen, in epoch ms.
   *
   * The alert list has to be ordered by **onset**, and `ts` cannot do it: for a code
   * alert `ts` is the stamp of the *last report that carried the code*, and a vehicle
   * re-sends its active codes on every telemetry cycle. So every row's `ts` jumps to
   * "now" together, once a second, and the order within a severity bucket is then
   * decided by millisecond noise — the rows visibly swap places. Manual review saw it
   * as flicker; it is a list sorted on a key that changes every tick.
   *
   * This is not a demo artefact: real vehicles report periodically too, so the same
   * error code arrives again and again with a fresh stamp.
   *
   * A plain `Map`, not reactive state, and that is deliberate on both counts:
   * `groupedAlerts` re-runs because `devices` changed on the same ingest, so the map
   * does not need to be a dependency — and making one entry per alert reactive would
   * be work with no reader.
   */
  const alertFirstSeen = new Map<string, number>();

  /**
   * Records an onset for every alert now present, and forgets the ones that cleared.
   *
   * The prune is not housekeeping. Without it this map grows for the life of the tab
   * (the failure mode P0-d describes on the backend), and — more visibly — an alert
   * that clears and later fires again would inherit its *first* onset and sort as
   * though it had never gone away.
   */
  const recordAlertOnsets = (
    devicesById: Record<string, DeviceSnapshot>,
  ): void => {
    const present = new Set<string>();
    for (const device of Object.values(devicesById)) {
      for (const alert of device.alerts) {
        present.add(alert.id);
        if (!alertFirstSeen.has(alert.id)) {
          alertFirstSeen.set(alert.id, toTimestampMsOrNow(alert.ts));
        }
      }
    }
    for (const id of [...alertFirstSeen.keys()]) {
      if (!present.has(id)) alertFirstSeen.delete(id);
    }
  };

  const groupedAlerts = computed<GroupedAlerts>(() => {
    const grouped: GroupedAlerts = { critical: [], warning: [], notice: [] };
    devices.value.forEach((device) => {
      device.alerts.forEach((alert) => {
        grouped[alert.severity].push({
          ...alert,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          // Falls back to `ts` only for an alert this store has not ingested yet,
          // which is the path tests take when they read the computed directly.
          firstSeenAt:
            alertFirstSeen.get(alert.id) ?? toTimestampMsOrNow(alert.ts),
        });
      });
    });
    Object.values(grouped).forEach((list) => {
      // Newest incident first, then by id so the order is fully determined. Without
      // the second key two alerts that started in the same millisecond would swap
      // on every recompute — the same defect in miniature.
      list.sort(
        (left, right) =>
          right.firstSeenAt - left.firstSeenAt ||
          left.id.localeCompare(right.id),
      );
    });
    return grouped;
  });

  /**
   * Vehicles the scene map should draw alongside the selected one: a formation's
   * members when one is selected, otherwise every vehicle standing in the same
   * scene. v1.0.0 returned nothing at all without a formation, so a scene map of a
   * six-vehicle site showed one vehicle and no hint that the others existed.
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

  const ensureSelectedDevice = (): void => {
    if (state.selectedDeviceId && state.devicesById[state.selectedDeviceId]) {
      if (!selectedFormation.value) return;
      if (
        (selectedFormation.value.deviceIds || []).includes(
          state.selectedDeviceId,
        )
      ) {
        return;
      }
    }

    if (selectedFormation.value) {
      const preferred = filteredDevices.value.find(
        (device) =>
          !formationSceneId.value || device.sceneId === formationSceneId.value,
      );
      state.selectedDeviceId =
        preferred?.deviceId || filteredDevices.value[0]?.deviceId || "";
      return;
    }

    state.selectedDeviceId = sortedDevices.value[0]?.deviceId || "";
  };

  const primeSceneDefinitions = (list: DeviceSnapshot[]): void => {
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
  ): void => {
    const nextTrails: Record<string, TrailPoint[]> = {
      ...state.trailsByDeviceId,
    };
    incomingDevices.forEach((device) => {
      const pose = pickTrailPose(mergedById[device.deviceId]);
      const point = pose ? normalizePathPoint(pose) : null;
      if (!point) return;
      const existing = nextTrails[device.deviceId] || [];
      const last = existing[existing.length - 1];
      // Drop samples the vehicle has not meaningfully moved between, or a parked
      // vehicle accumulates 240 identical points and its trail means nothing.
      if (last && pointsAreNear(last, point, TRAIL_MIN_DISTANCE)) return;
      const appended = [...existing, point];
      nextTrails[device.deviceId] =
        appended.length > TRAIL_MAX_POINTS
          ? appended.slice(appended.length - TRAIL_MAX_POINTS)
          : appended;
    });
    if (replace) {
      Object.keys(nextTrails).forEach((deviceId) => {
        if (!mergedById[deviceId]) delete nextTrails[deviceId];
      });
    }
    state.trailsByDeviceId = nextTrails;
  };

  const ingestPayload = (rawPayload: unknown, source: string): void => {
    const normalized = normalizePayload(rawPayload);
    const nextDevicesById: Record<string, DeviceSnapshot> = normalized.replace
      ? {}
      : { ...state.devicesById };

    normalized.devices.forEach((device) => {
      nextDevicesById[device.deviceId] = mergeDevice(
        state.devicesById[device.deviceId] ?? null,
        device,
      );
    });

    if (normalized.formations) {
      const nextFormationsById: Record<string, FormationSnapshot> = {};
      normalized.formations.forEach((formation) => {
        nextFormationsById[formation.formationId] = normalizeFormation(
          formation,
          state.formationsById[formation.formationId] ?? null,
        );
      });
      state.formationsById = nextFormationsById;
    }

    state.devicesById = nextDevicesById;
    recordAlertOnsets(nextDevicesById);
    recordTrails(normalized.devices, nextDevicesById, normalized.replace);
    state.fleetName = normalized.fleetName;
    state.topicPattern = normalized.topicPattern;
    state.lastSource = source;
    state.lastUpdateAt = new Date().toISOString();
    if (normalized.updatedAt) state.serverUpdatedAt = normalized.updatedAt;
    primeSceneDefinitions(Object.values(state.devicesById));
    ensureSelectedDevice();
  };

  const trailsByDeviceId = computed(() => state.trailsByDeviceId);

  const clearTrail = (deviceId = state.selectedDeviceId): void => {
    if (!deviceId || !state.trailsByDeviceId[deviceId]) return;
    const next = { ...state.trailsByDeviceId };
    delete next[deviceId];
    state.trailsByDeviceId = next;
  };

  const selectDevice = (
    deviceId: string,
    options: { preserveFormation?: boolean } = {},
  ): void => {
    if (!state.devicesById[deviceId]) return;

    state.selectedDeviceId = deviceId;
    if (options.preserveFormation) return;
    const belongsToSelectedFormation =
      selectedFormation.value &&
      (selectedFormation.value.deviceIds || []).includes(deviceId);
    if (!belongsToSelectedFormation) state.selectedFormationId = "";
  };

  const selectFormation = (formationId: string): void => {
    if (!state.formationsById[formationId]) return;
    state.selectedFormationId = formationId;
    ensureSelectedDevice();
  };

  const clearFormationSelection = (): void => {
    state.selectedFormationId = "";
    ensureSelectedDevice();
  };

  // ── realtime ──────────────────────────────────────────────────────────────
  /**
   * One link per store instance, created lazily so importing the store does not
   * open a socket (the router's guards import it at module scope).
   */
  let link: RealtimeLink | null = null;

  const handleRealtimeMessage = (message: unknown): void => {
    const envelope = message as
      { type?: string; payload?: unknown } | null | undefined;
    if (!envelope?.type) return;
    try {
      if (envelope.type === "fleet.snapshot") {
        ingestPayload(envelope.payload, "ws");
        return;
      }
      if (envelope.type === "fleet.delta") {
        const payload = envelope.payload as { device?: unknown } | undefined;
        ingestPayload(payload?.device ?? envelope.payload, "mqtt");
      }
    } catch {
      // A frame we cannot normalize must not take the socket down with it: the
      // next telemetry message is a second later and is usually fine.
    }
  };

  const handleRealtimeStatus = (
    status: RealtimeLinkStatus,
    attempt: number,
  ): void => {
    const previous = state.realtime.linkStatus;
    state.realtime.linkStatus = status;
    state.realtime.reconnectAttempts = attempt;

    // Announce only the transitions a person needs to know about. Notifying on
    // every retry would repeat itself for as long as the backend is down; the
    // status indicator in the top bar is what reports the ongoing condition.
    if (status === "reconnecting" && previous === "open") {
      notify("实时连接中断，正在自动重连…", {
        type: "warning",
        dedupeKey: "ws-down",
      });
    }
    if (status === "open" && previous === "reconnecting") {
      notify("实时连接已恢复", { type: "success", dedupeKey: "ws-restored" });
    }
  };

  const connectRealtime = (): void => {
    link ??= createRealtimeLink({
      onMessage: handleRealtimeMessage,
      onStatus: handleRealtimeStatus,
    });
    link.connect();
  };

  const disconnectRealtime = (): void => {
    link?.disconnect();
  };

  /**
   * What the top bar says about the link, in one place.
   *
   * A four-state indicator rather than a boolean, because "the API answered but
   * the socket is down" and "nothing is reachable" call for different actions from
   * whoever is watching. Derived here rather than in the component so a second
   * consumer (the wall view) reads the same answer instead of re-deriving one —
   * the same argument that hoisted device tone into `fleet-core`.
   *
   * `connecting` is grouped with the bootstrap rather than with `reconnecting`, and
   * that distinction is a defect the first test on this found: every cold start
   * spent the socket's opening moments claiming to be **重连中**, announcing a
   * failure that had not happened. A link on its way up is not a link coming back.
   */
  const connection = computed<{
    tone: ConnectionTone;
    label: string;
    detail: string;
  }>(() => {
    if (state.realtime.bootstrapPending) {
      return { tone: "pending", label: "连接中", detail: "正在获取车队快照…" };
    }
    if (!state.realtime.apiReady) {
      return {
        tone: "critical",
        label: "后端离线",
        detail: "无法连接后端服务，页面显示的是最后一次已知状态",
      };
    }
    if (state.realtime.linkStatus === "open") {
      return { tone: "ok", label: "实时", detail: "实时数据连接正常" };
    }
    if (state.realtime.linkStatus !== "reconnecting") {
      return {
        tone: "pending",
        label: "连接中",
        detail: "正在建立实时数据连接…",
      };
    }
    return {
      tone: "warning",
      label: "重连中",
      detail: `实时连接已中断，正在重试（第 ${state.realtime.reconnectAttempts} 次）`,
    };
  });

  // ── bootstrap ─────────────────────────────────────────────────────────────
  const bootstrapFromBackend = async (): Promise<boolean> => {
    let payload;
    try {
      await loadSceneCatalog();
      payload = await fleetApi.getSnapshot();
    } catch {
      state.realtime.apiReady = false;
      notify("无法连接后端服务，请检查服务状态后重试", {
        type: "error",
        dedupeKey: "bootstrap-failed",
      });
      return false;
    }

    // Reached separately from the request above on purpose: a snapshot we cannot
    // read is not an unreachable backend, and saying "检查服务状态" about a service
    // that answered promptly sends whoever is on shift to look in the wrong place.
    try {
      state.realtime.apiReady = true;
      ingestPayload(payload, "api");
    } catch {
      notify("后端返回的车队快照无法解析", {
        type: "error",
        dedupeKey: "bootstrap-unreadable",
      });
      return false;
    }

    connectRealtime();
    return true;
  };

  /**
   * What the console holds when the backend cannot be reached: **nothing**, said plainly.
   *
   * `fallbackFleetPayload.devices` and `sceneCatalog` are both permanently empty in
   * `fleet-core` — they were copied over from v1.0.0 verbatim, and three lookups in this
   * file have never once hit them. So "the console shows demo content when the backend is
   * down" has never been true, in either front end, and ingesting an empty payload dressed
   * the absence up as a fleet of zero vehicles.
   *
   * The honest version keeps only the two fields that do carry a value (the fleet's default
   * name and the topic pattern, which are what the shell renders) and leaves the device map
   * untouched, so a reconnect merges into whatever was last known rather than into a fleet
   * that was silently replaced by an empty one.
   *
   * The empty constants themselves live in `fleet-core`, which **v1.0.0 also imports**, so
   * deleting them is a change to shipped code and belongs with 9.1 / 9.19 in the 1.0.3
   * batch. This is the half that can be done without touching the released product.
   */
  const bootstrapEmptyState = (): void => {
    if (!state.fleetName) state.fleetName = fallbackFleetPayload.fleetName;
    if (!state.topicPattern)
      state.topicPattern = fallbackFleetPayload.topicPattern;
  };

  const bootstrap = async (): Promise<boolean> => {
    state.realtime.bootstrapPending = true;
    try {
      const ready = await bootstrapFromBackend();
      if (!ready) bootstrapEmptyState();
      return ready;
    } finally {
      state.realtime.bootstrapPending = false;
    }
  };

  /** Same sequence as `bootstrap`; named for the retry button that calls it. */
  const retryBootstrap = bootstrap;

  const bootstrapPending = computed(() => state.realtime.bootstrapPending);

  return {
    state,
    devices,
    formations,
    sortedDevices,
    sortedFormations,
    devicesByAttention,
    filteredDevices,
    selectedDevice,
    formationSceneId,
    sceneDevices,
    summary,
    groupedAlerts,
    trailsByDeviceId,
    bootstrapPending,
    connection,
    getSceneDefinition,
    /*
     * Not `getDeviceTone` / `hasPose` / `round` / `formatDateTime`. They were re-exported
     * here and every consumer imports them straight from `@navfleet/fleet-core` instead,
     * so the store was publishing four aliases nobody read — and, worse, publishing them
     * made the store look like the place those helpers come from.
     */
    ingestPayload,
    selectDevice,
    selectFormation,
    clearFormationSelection,
    clearTrail,
    bootstrap,
    retryBootstrap,
    connectRealtime,
    disconnectRealtime,
  };
});
