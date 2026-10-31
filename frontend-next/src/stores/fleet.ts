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
 *   The devices page needs a three-state list/map/auto mode with a vehicle-count
 *   threshold, so porting the two-state version now would only be something to
 *   delete. It arrives with the maps that need it.
 */

import { computed, reactive } from "vue";
import { defineStore } from "pinia";
import {
  deviceToneRank,
  extractDeviceIdFromTopic,
  fallbackFleetPayload,
  fleetApi,
  getDeviceTone,
  alertHeadline,
  hasGps,
  mergeDevice,
  mergeSceneDefinitionParts,
  normalizeDevice,
  normalizeFormation,
  normalizePathPoint,
  pickTrailPose,
  pointsAreNear,
  toTimestampMsOrNow,
  TRAIL_MAX_POINTS,
  TRAIL_MIN_DISTANCE,
} from "@navfleet/fleet-core";
import type { SceneDefinition } from "@navfleet/fleet-core";
import { offlineAlertId } from "@navfleet/shared";
import type {
  AlertClearedPayload,
  AlertCreatedPayload,
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
// `firstSeenAt` is the snapshot's ISO onset on a DeviceAlert; here it is resolved to epoch ms.
export type GroupedAlert = Omit<DeviceAlert, "firstSeenAt"> & {
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
    sceneDefinitions: {},
    pendingSceneLoads: {},
    trailsByDeviceId: {},
    realtime: {
      apiReady: false,
      linkStatus: "idle",
      reconnectAttempts: 0,
      bootstrapPending: false,
    },
  });

  /**
   * Server-backed acknowledgement overlay, keyed by eventKey (`deviceId:alertId`).
   *
   * Confirmation used to live in browser localStorage, so it did not survive a different
   * device, a different operator, or a cleared cache, and could not be audited. It now lives
   * on the `alerts` collection; this map is the console's live view of it — seeded once from
   * `GET /alerts?status=active` on bootstrap and kept current by `alert.acked`/`alert.unacked`
   * WS events, so every open console agrees on what is confirmed and by whom, across users.
   *
   * A reactive Map (not a plain object) so `useAlertAck`'s reads track individual keys.
   */
  interface AckEntry {
    ackedBy: string;
    ackedAt: string;
  }
  const ackState = reactive(new Map<string, AckEntry>());
  const ackEventKey = (deviceId: string, alertId: string): string =>
    `${deviceId}:${alertId}`;
  const isAlertAcked = (deviceId: string, alertId: string): boolean =>
    ackState.has(ackEventKey(deviceId, alertId));
  const getAck = (deviceId: string, alertId: string): AckEntry | null =>
    ackState.get(ackEventKey(deviceId, alertId)) ?? null;
  /** Bumped on every live change to the overlay, so a seed can tell it was overtaken. */
  let ackGeneration = 0;
  const applyAck = (eventKey: string, entry: AckEntry): void => {
    ackGeneration += 1;
    ackState.set(eventKey, entry);
  };
  const applyUnack = (eventKey: string): void => {
    ackGeneration += 1;
    ackState.delete(eventKey);
  };

  let ackSeedInFlight = false;
  /**
   * Reload the acknowledgement overlay from the backend. Called from the alerts view on mount
   * (the one place the overlay is displayed) and whenever the realtime link comes back, so a
   * confirmation made while this console was disconnected — or by another operator — is
   * picked up; between reads the WS `alert.acked`/`alert.unacked` events keep it current.
   *
   * The read replaces the overlay only when it is the whole truth. If a live event changed
   * the overlay while the read was in flight, or the server capped the list (`truncated`),
   * the result is merged in instead: replacing would drop the newer change, or every
   * confirmation beyond the cap. A failure is swallowed: a missing overlay must not blank
   * the page, and the live stream will still deliver new changes.
   */
  const seedAckState = async (): Promise<void> => {
    if (ackSeedInFlight) return;
    ackSeedInFlight = true;
    const generation = ackGeneration;
    try {
      const { items, truncated } = await fleetApi.getAlerts({
        status: "active",
      });
      const next = new Map<string, AckEntry>();
      for (const item of items) {
        const eventKey =
          item.eventKey ??
          (item.deviceId && item.alertId
            ? ackEventKey(item.deviceId, item.alertId)
            : null);
        if (eventKey && item.ackedBy && item.ackedAt) {
          next.set(eventKey, { ackedBy: item.ackedBy, ackedAt: item.ackedAt });
        }
      }
      if (generation === ackGeneration && !truncated) ackState.clear();
      for (const [key, entry] of next) {
        if (generation === ackGeneration || !ackState.has(key)) {
          ackState.set(key, entry);
        }
      }
    } catch {
      // Keep whatever overlay we have; the WS stream will still deliver new changes.
    } finally {
      ackSeedInFlight = false;
    }
  };

  const getSceneDefinition = (
    sceneId: string,
  ): SceneDefinitionRecord | null => {
    if (!sceneId) return null;
    return state.sceneDefinitions[sceneId] || null;
  };

  const mergeSceneDefinition = (definition: SceneDefinition): void => {
    if (!definition?.sceneId) return;
    // There is no built-in catalogue to merge over any more (see `dataDefaults.ts`):
    // every scene comes from the backend, so the base is whatever we already hold.
    // `SceneMapDefinition` has no index signature, so bridge it to the loose,
    // dynamically-merged shape `mergeSceneDefinitionParts` consumes.
    const existing = (state.sceneDefinitions[definition.sceneId] ||
      {}) as unknown as Record<string, unknown>;
    state.sceneDefinitions[definition.sceneId] = mergeSceneDefinitionParts(
      existing,
      definition,
    );
  };

  /**
   * Scene ids whose lookup failed, and the epoch ms before which they are not asked for again.
   * A vehicle reporting a scene that `scenes.json` does not define (or no longer does) used to be
   * re-requested on every frame, which spent the per-IP API rate limit in seconds and turned every
   * other request from that address into a 429. Cleared whenever the catalogue is reloaded.
   */
  const failedSceneLoads = new Map<string, number>();
  const SCENE_RETRY_MS = 60_000;

  const loadSceneDefinition = async (sceneId: string): Promise<void> => {
    if (!sceneId || state.pendingSceneLoads[sceneId]) return;
    if ((failedSceneLoads.get(sceneId) ?? 0) > Date.now()) return;
    state.pendingSceneLoads[sceneId] = true;
    try {
      mergeSceneDefinition(await fleetApi.getScene(sceneId));
      failedSceneLoads.delete(sceneId);
    } catch {
      // Keep whatever we have; a missing scene must not blank the map.
      failedSceneLoads.set(sceneId, Date.now() + SCENE_RETRY_MS);
    } finally {
      delete state.pendingSceneLoads[sceneId];
    }
  };

  /**
   * Replace the scene definitions with the backend's catalogue. Replaced, not merged: after a
   * `scenes.json` edit a merge kept fields the edit had removed, and a deleted scene stayed.
   */
  const loadSceneCatalog = async (): Promise<boolean> => {
    try {
      const payload = await fleetApi.getScenes();
      const next: Record<string, SceneDefinitionRecord> = {};
      for (const definition of payload.items || []) {
        if (!definition?.sceneId) continue;
        next[definition.sceneId] = mergeSceneDefinitionParts({}, definition);
      }
      state.sceneDefinitions = next;
      failedSceneLoads.clear();
      primeSceneDefinitions(Object.values(state.devicesById));
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
      // Annotated `unknown` rather than left to inference: `JSON.parse` returns `any`, and
      // an `any` here would have spread through `body` into every field read below with no
      // rule able to see it.
      const payloadBody: unknown =
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
            : memberDevices[0]?.sceneId ||
              memberDevices[0]?.defaultSceneId ||
              ""),
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
   * (the unbounded-device failure mode the backend guards against), and — more visibly — an alert
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
        // The backend's onset wins: it saw the occurrence begin, this tab may have opened later.
        if (alert.firstSeenAt) {
          alertFirstSeen.set(alert.id, toTimestampMsOrNow(alert.firstSeenAt));
        } else if (!alertFirstSeen.has(alert.id)) {
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
            alertFirstSeen.get(alert.id) ??
            toTimestampMsOrNow(alert.firstSeenAt ?? alert.ts),
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

  function primeSceneDefinitions(list: DeviceSnapshot[]): void {
    list.forEach((device) => {
      if (device.sceneId && !getSceneDefinition(device.sceneId)) {
        void loadSceneDefinition(device.sceneId);
      }
    });
  }

  /** The scene each trail was drawn in; scene coordinate frames are unrelated to one another. */
  const trailSceneOf = new Map<string, string>();

  const recordTrails = (
    incomingDevices: DeviceSnapshot[],
    mergedById: Record<string, DeviceSnapshot>,
  ): void => {
    const nextTrails: Record<string, TrailPoint[]> = {
      ...state.trailsByDeviceId,
    };
    incomingDevices.forEach((device) => {
      const merged = mergedById[device.deviceId];
      // A vehicle sent to another scene starts a new trail: its old points are in another
      // frame, and kept they drew a line from the old scene's coordinates to the new position.
      const sceneId = merged?.sceneId ?? "";
      if (trailSceneOf.get(device.deviceId) !== sceneId) {
        delete nextTrails[device.deviceId];
        trailSceneOf.set(device.deviceId, sceneId);
      }
      const pose = pickTrailPose(merged);
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
    // Drop the trail of any device that has left the fleet or gone offline, on every
    // ingest (not just full snapshots). Deltas never remove a device, so without this a
    // straggler — or a device that simply stopped reporting, e.g. a stale duplicate
    // publisher's ghost — would keep a frozen or jumping line on the map long after it
    // stopped being real. A device that comes back online just starts a fresh trail.
    Object.keys(nextTrails).forEach((deviceId) => {
      const device = mergedById[deviceId];
      if (!device || device.online === false) {
        delete nextTrails[deviceId];
        trailSceneOf.delete(deviceId);
      }
    });
    state.trailsByDeviceId = nextTrails;
  };

  /**
   * Devices this tab has announced as offline.
   *
   * `device.online` is emitted for a device's **first** ingest too (the backend's
   * `emitChangeEvents` treats "no previous snapshot" as a transition), so a backend
   * restart would otherwise pop one "back online" toast per vehicle for devices
   * nobody had been told were gone. Announcing the recovery only for a device whose
   * departure we announced keeps the pair symmetric.
   */
  const announcedOffline = new Set<string>();

  /**
   * Alerts this tab has announced, by eventKey, with what the clear toast needs to name them:
   * `alert.cleared` carries only the id, so the severity and title are the ones kept here.
   * A clear is only reported if its onset was.
   */
  const announcedAlerts = new Map<
    string,
    { severity: Severity; title: string }
  >();

  /**
   * Burst guard for the transition events.
   *
   * A backend restart re-ingests the whole fleet in one go, and every device's first
   * frame is a transition — six vehicles with two alerts each is 18 toasts arriving
   * together, which is not information, it is a wall. Past the threshold the window
   * collapses into one summary line and individual toasts are suppressed until it
   * closes.
   */
  const BURST_WINDOW_MS = 3_000;
  const BURST_THRESHOLD = 4;
  let burstWindowStartedAt = 0;
  let burstCount = 0;
  let burstSummarised = false;

  /** Whether this event may raise its own toast, or belongs to a collapsed burst. */
  const admitTransitionToast = (): boolean => {
    const now = Date.now();
    if (now - burstWindowStartedAt > BURST_WINDOW_MS) {
      burstWindowStartedAt = now;
      burstCount = 0;
      burstSummarised = false;
    }
    burstCount += 1;
    if (burstCount <= BURST_THRESHOLD) return true;
    if (!burstSummarised) {
      burstSummarised = true;
      notify(`车队状态密集变化（${burstCount} 条），详情见消息页`, {
        type: "warning",
        dedupeKey: "transition-burst",
      });
    }
    return false;
  };

  const displayNameOf = (deviceId: string): string =>
    state.devicesById[deviceId]?.deviceName || deviceId;

  /**
   * The four transition events the backend has always broadcast and nothing consumed:
   * `device.online` / `device.offline` / `alert.created` / `alert.cleared`.
   *
   * They deliberately do **not** touch state. `fleet.delta` carries the whole device
   * and is broadcast *before* these for the same change, so the online flag and the
   * alerts array are already current by the time one of these arrives — mutating here
   * would be a second, divergent path to the same fields. What these add is the thing
   * a snapshot cannot express: that a transition *happened*, at a moment someone may
   * not have been looking at the tile it happened on.
   *
   * The alert sound is not driven from here either: `useAlertSound` watches the store's
   * grouped alerts and keeps its own `announcedIds`, so wiring it up a second time
   * would double-announce every critical.
   */
  const handleTransitionEvent = (type: string, payload: unknown): void => {
    const frame = (payload ?? {}) as { deviceId?: unknown };
    const deviceId =
      typeof frame.deviceId === "string" ? frame.deviceId : undefined;
    if (!deviceId) return;

    // Acknowledgement events carry no `alert` object and never toast — they
    // only reconcile the ack overlay so every open console reflects who confirmed what,
    // the moment any operator (here or elsewhere) does it.
    if (type === "alert.acked" || type === "alert.unacked") {
      const ack = payload as {
        alertId?: unknown;
        ackedBy?: unknown;
        ackedAt?: unknown;
      };
      if (typeof ack.alertId !== "string") return;
      const eventKey = ackEventKey(deviceId, ack.alertId);
      if (type === "alert.acked") {
        if (
          typeof ack.ackedBy === "string" &&
          typeof ack.ackedAt === "string"
        ) {
          applyAck(eventKey, { ackedBy: ack.ackedBy, ackedAt: ack.ackedAt });
        }
      } else {
        applyUnack(eventKey);
      }
      return;
    }

    // The one toast for a vehicle going silent. The offline monitor also raises a critical
    // 设备离线 alert for the same moment, and that alert's own created/cleared toasts are
    // skipped below, so the error tone here matches it.
    if (type === "device.offline") {
      announcedOffline.add(deviceId);
      if (!admitTransitionToast()) return;
      notify(`${displayNameOf(deviceId)} 已离线`, {
        type: "error",
        dedupeKey: `offline-${deviceId}`,
      });
      return;
    }

    if (type === "device.online") {
      if (!announcedOffline.delete(deviceId)) return;
      if (!admitTransitionToast()) return;
      notify(`${displayNameOf(deviceId)} 已恢复在线`, {
        type: "success",
        dedupeKey: `online-${deviceId}`,
      });
      return;
    }

    if (type === "alert.created") {
      const { alert } = payload as Partial<AlertCreatedPayload>;
      if (!alert || typeof alert.id !== "string") return;
      if (alert.id === offlineAlertId(deviceId)) return;
      // 提示级不弹。报码里的提示位在正常运行中就会亮，一台车一条就足以让提示流变成
      // 背景噪声 —— 而背景噪声会让人连告警一起忽略。它们仍然进消息页与徽标。
      const severity = alert.severity;
      if (severity !== "critical" && severity !== "warning") return;
      const title =
        typeof alert.title === "string"
          ? alertHeadline({
              title: alert.title,
              detail: typeof alert.detail === "string" ? alert.detail : "",
              source: typeof alert.source === "string" ? alert.source : "",
            })
          : "设备告警";
      announcedAlerts.set(ackEventKey(deviceId, alert.id), { severity, title });
      if (!admitTransitionToast()) return;
      notify(`${displayNameOf(deviceId)}：${title}`, {
        type: severity === "critical" ? "error" : "warning",
        dedupeKey: `alert-new-${alert.id}`,
      });
      return;
    }

    if (type === "alert.cleared") {
      const { alertId } = payload as Partial<AlertClearedPayload>;
      if (typeof alertId !== "string") return;
      const eventKey = ackEventKey(deviceId, alertId);
      // A clear closes that occurrence, acknowledgement included; if the code fires again it is
      // a new, unacknowledged occurrence under the same eventKey — drop the overlay entry so the
      // new one does not inherit the old confirmation. Every severity, before any toast filter.
      applyUnack(eventKey);
      // Only if its onset was announced: otherwise a tab that opened mid-incident reports the
      // recovery of something it never reported.
      const announced = announcedAlerts.get(eventKey);
      if (!announced) return;
      announcedAlerts.delete(eventKey);
      if (!admitTransitionToast()) return;
      notify(`${displayNameOf(deviceId)}：${announced.title}已解除`, {
        type: "success",
        dedupeKey: `alert-clear-${alertId}`,
      });
    }
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
    recordTrails(normalized.devices, nextDevicesById);
    state.fleetName = normalized.fleetName;
    state.topicPattern = normalized.topicPattern;
    state.lastSource = source;
    state.lastUpdateAt = new Date().toISOString();
    if (normalized.updatedAt) state.serverUpdatedAt = normalized.updatedAt;
    // Only the devices this payload carried: walking the whole fleet on every delta was what
    // turned one undefined scene into a request per frame.
    primeSceneDefinitions(normalized.devices);
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
        // The backend broadcasts a snapshot after a config reload, so scene edits (a new
        // backdrop, a moved origin) reach open pages without a reload.
        void loadSceneCatalog();
        return;
      }
      if (envelope.type === "fleet.delta") {
        const payload = envelope.payload as
          { device?: unknown; updatedAt?: unknown } | undefined;
        ingestPayload(payload?.device ?? envelope.payload, "mqtt");
        // The envelope's own server time, which `ingestPayload` cannot see: it is handed
        // the device, not the frame around it. Without this the freshness line only moved
        // when a whole snapshot arrived — every second or so of live telemetry left it
        // frozen at the time the socket opened.
        if (typeof payload?.updatedAt === "string") {
          state.serverUpdatedAt = payload.updatedAt;
        }
        return;
      }
      handleTransitionEvent(envelope.type, envelope.payload);
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
      // Confirmations made while the link was down never arrived as events.
      void seedAckState();
    }
  };

  /** Set by the session layer: re-check the session when the socket reports it invalid. */
  let onSessionInvalid: (() => void) | null = null;
  const setSessionInvalidHandler = (handler: (() => void) | null): void => {
    onSessionInvalid = handler;
  };

  const connectRealtime = (): void => {
    link ??= createRealtimeLink({
      onMessage: handleRealtimeMessage,
      onStatus: handleRealtimeStatus,
      onSessionInvalid: () => onSessionInvalid?.(),
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
  /**
   * Bumped by `stopRealtime`. A bootstrap still awaiting the backend when the user signs out
   * must not go on to open the socket, or schedule a retry, for a session that has ended:
   * that left a live, authenticated socket behind the login screen.
   */
  let sessionEpoch = 0;

  const bootstrapFromBackend = async (epoch: number): Promise<boolean> => {
    let payload;
    try {
      await loadSceneCatalog();
      payload = await fleetApi.getSnapshot();
    } catch {
      if (epoch !== sessionEpoch) return false;
      state.realtime.apiReady = false;
      notify("无法连接后端服务，请检查服务状态后重试", {
        type: "error",
        dedupeKey: "bootstrap-failed",
      });
      return false;
    }

    if (epoch !== sessionEpoch) return false;

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
   * `fallbackFleetPayload.devices` and `sceneCatalog` used to be permanently empty
   * constants in `fleet-core`, copied over from v1.0.0 verbatim, and five lookups across
   * the two front ends never once hit them. So "the console shows demo content when the
   * backend is down" had never been true in any release — and ingesting that empty payload
   * dressed the absence up as a fleet of zero vehicles, which is a different and much more
   * alarming statement than "we cannot reach the backend".
   *
   * An earlier change did this half (seed only the two label fields; leave the device map
   * untouched so a reconnect merges into what was last known); 1.0.3 deleted the constants
   * themselves, which had to wait because `fleet-core` is imported by the shipped v1.0.0 too.
   */
  const bootstrapEmptyState = (): void => {
    if (!state.fleetName) state.fleetName = fallbackFleetPayload.fleetName;
    if (!state.topicPattern)
      state.topicPattern = fallbackFleetPayload.topicPattern;
  };

  /**
   * Retry schedule for a bootstrap that could not reach the backend. A wall display cannot press
   * 重试, so a backend that comes up after the console must be picked up automatically.
   */
  const BOOTSTRAP_RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const;
  let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let bootstrapFailures = 0;

  const clearBootstrapRetry = (): void => {
    if (bootstrapRetryTimer !== null) clearTimeout(bootstrapRetryTimer);
    bootstrapRetryTimer = null;
  };

  const bootstrap = async (): Promise<boolean> => {
    clearBootstrapRetry();
    state.realtime.bootstrapPending = true;
    const epoch = sessionEpoch;
    try {
      const ready = await bootstrapFromBackend(epoch);
      if (epoch !== sessionEpoch) return false;
      if (ready) {
        bootstrapFailures = 0;
      } else {
        bootstrapEmptyState();
        const delay =
          BOOTSTRAP_RETRY_MS[bootstrapFailures] ??
          BOOTSTRAP_RETRY_MS[BOOTSTRAP_RETRY_MS.length - 1];
        bootstrapFailures += 1;
        bootstrapRetryTimer = setTimeout(() => {
          bootstrapRetryTimer = null;
          void bootstrap();
        }, delay);
      }
      return ready;
    } finally {
      state.realtime.bootstrapPending = false;
    }
  };

  /** Stop retrying (signed out) and drop the socket. */
  const stopRealtime = (): void => {
    sessionEpoch += 1;
    clearBootstrapRetry();
    bootstrapFailures = 0;
    disconnectRealtime();
  };

  // The browser came back online: retry what is waiting instead of sitting out the backoff.
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      if (bootstrapRetryTimer !== null) {
        void bootstrap();
      } else {
        link?.retryNow();
      }
    });
  }

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
    // Acknowledgement overlay. `useAlertAck` reads `isAlertAcked`/`getAck` and
    // drives optimistic updates through `applyAck`/`applyUnack`; the alerts view seeds it once
    // on mount via `seedAckState`. The map itself stays internal — never poked from outside.
    isAlertAcked,
    getAck,
    applyAck,
    applyUnack,
    seedAckState,
    bootstrapPending,
    connection,
    getSceneDefinition,
    loadSceneCatalog,
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
    stopRealtime,
    setSessionInvalidHandler,
  };
});
