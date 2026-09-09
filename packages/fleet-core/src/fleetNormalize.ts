/**
 * Pure normalization + shaping helpers for fleet telemetry.
 *
 * Extracted from the former monolithic `useDashboard` composable so the data
 * model logic (multi-format ingestion, alert derivation, lidar→fusion fallback,
 * scene merging, movement trails) can be unit-tested in isolation and reused by
 * the Pinia store. Everything here is a pure function with no Vue/reactive
 * dependency. Inputs are intentionally heterogeneous (the normalizer accepts
 * many payload shapes), so loose values are typed `unknown` / `Record<string,
 * unknown>` and narrowed defensively rather than with `any`.
 */

import type {
  CodeState,
  DeviceAlert,
  DeviceSnapshot,
  FormationSnapshot,
  Severity,
} from "@navfleet/shared";

/** A point-like value whose coordinates may be absent/nullish (loose input). */
type MaybePoint = { x?: number | null; y?: number | null } | null | undefined;
/** A GPS-like value whose coordinates may be absent/nullish (loose input). */
type MaybeGps = { lat?: number | null; lng?: number | null } | null | undefined;

/** Minimal fields `dedupeAlerts` reads; kept loose so raw alert-ish objects fit. */
interface AlertLike {
  id: string;
  severity: string;
  title: string;
  ts: string;
}

/** Loose, partial scene-definition parts consumed by the scene merge helpers. */
interface ScenePartLike {
  origin?: { x?: number | null; y?: number | null; yaw?: number | null } | null;
  bounds?: {
    minX?: number;
    maxX?: number;
    minY?: number;
    maxY?: number;
  } | null;
  defaultView?: { zoom?: number; centerX?: number; centerY?: number } | null;
  width?: number | null;
  height?: number | null;
  resolution?: number | null;
  [key: string]: unknown;
}

export const cloneValue = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

/**
 * A JSON scalar as text; anything else becomes `fallback`.
 *
 * The twin of `asText` in `backend/src/normalize.ts`, and for the same reason: on a payload
 * field typed `unknown`, `String(x)` promises something it cannot deliver — a vehicle
 * publishing `"formationName": {}` got the literal string `"[object Object]"` shown in the
 * console. Nothing in the fleet does that; nothing rejected it either, and a normaliser is
 * exactly the layer whose job is to stop it.
 *
 * `no-base-to-string` (P0-f 第 3 批) named all 16 of this package's at once.
 */
export const asText = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
};

/** A loose object as a readable record; anything else as an empty one. */
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export const round = (value: unknown, digits = 2): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
};

/**
 * A numeric reading, or `fallback` when the value carries no reading.
 *
 * The `null`/`undefined`/`""` guard is the entire point, and it has to live **here**
 * rather than only in `formatNumber`. `Number()` maps every kind of "nothing" onto a
 * perfectly finite zero, and every default telemetry field in this system is `null`:
 * the backend serialises a device that has never reported as `soc: null`,
 * `speedLimit.limit: null`, `fusionLoc: {x: null, y: null, yaw: null}`. Both consoles
 * re-normalise every snapshot through `normalizeDevice`, so without this guard those
 * nulls became real zeros *before* any formatter saw them —
 *
 *   - `soc` rendered `0%`, i.e. a flat battery for a vehicle that reported none;
 *   - `controlMode` resolved to a real mode name instead of `--`;
 *   - `hasPose({x: 0, y: 0})` returned true, so a vehicle with no pose was drawn at
 *     the site map's origin.
 *
 * `formatNumber`'s own guard (see formatters.ts) was written for exactly this defect
 * and documents it as fixed — it could never fire, because by the time it ran the
 * `null` had already become `0`. A fix applied downstream of the coercion is not a fix.
 *
 * A real zero still passes through: the distinction is "no reading" versus "a reading
 * of zero", and on a monitoring console those are different facts.
 *
 * Kept identical to `backend/src/normalize.ts`'s `toNumeric` on purpose; the parity is
 * asserted from both sides (`packages/fleet-core/test/fleetNormalize.test.ts` and
 * `backend/test/normalize-numeric.test.ts`) rather than only claimed in a comment.
 */
export const toNumeric = (
  value: unknown,
  fallback: number | null = null,
): number | null => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

/**
 * A timestamp in epoch milliseconds, or `null` when the value carries no time.
 *
 * The primitive, so that every caller has to say what "no timestamp" means *there* —
 * which is the fix for parity 9.19. The old single helper answered `Date.now()`, and
 * that answer is right at exactly one kind of call site and wrong at the others:
 *
 * - **A receiver** (the backend normalising an arriving MQTT frame) legitimately uses
 *   its own clock: the message *did* just arrive, and a vehicle that does not stamp its
 *   own reports still has a knowable receive time.
 * - **A reader** (either frontend sorting stored alerts) must not. There, `Date.now()`
 *   turns "we do not know when this happened" into "it happened this instant", which
 *   sorts an undated alert above every real one — and the row then re-sorts on every
 *   tick, because the fabricated stamp moves.
 *
 * Seconds are accepted as well as milliseconds: `< 1e12` is treated as seconds, which
 * is the convention the vehicles publish and predates this function.
 */
export const parseTimestampMs = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && asText(value).trim() !== "") {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Epoch milliseconds, falling back to **now**. Only for receivers — see
 * `parseTimestampMs`. The name says the fallback out loud precisely because the
 * previous name did not, and the ambiguity is what caused 9.19.
 */
export const toTimestampMsOrNow = (value: unknown): number =>
  parseTimestampMs(value) ?? Date.now();

export const toIsoString = (value: unknown): string =>
  new Date(toTimestampMsOrNow(value)).toISOString();

/** Localised timestamp, or the placeholder when there is no time to show. */
export const formatDateTime = (value: unknown): string => {
  const at = parseTimestampMs(value);
  if (at === null) return "--";
  return new Date(at).toLocaleString("zh-CN", {
    hour12: false,
  });
};

export const extractDeviceIdFromTopic = (topic: unknown): string => {
  const match = asText(topic || "").match(/^\/fleet\/([^/]+)\//);
  return match?.[1] || "";
};

export const hasPose = (pose: MaybePoint): boolean =>
  Number.isFinite(pose?.x) && Number.isFinite(pose?.y);
export const hasGps = (gps: MaybeGps): boolean =>
  Number.isFinite(gps?.lat) && Number.isFinite(gps?.lng);
export const isNormalizedSnapshot = (raw: unknown): boolean =>
  !!raw &&
  (Object.prototype.hasOwnProperty.call(raw, "runtimeSceneId") ||
    Object.prototype.hasOwnProperty.call(raw, "defaultSceneId") ||
    Object.prototype.hasOwnProperty.call(raw, "fusionLoc") ||
    Object.prototype.hasOwnProperty.call(raw, "vehicleInfo") ||
    Object.prototype.hasOwnProperty.call(raw, "infoCode") ||
    Object.prototype.hasOwnProperty.call(raw, "speedLimit"));

export const createDefaultCode = (): CodeState => ({
  code: 0,
  info: "",
  stamp: null,
});

export const createDefaultFormation = (
  formationId = "",
): FormationSnapshot => ({
  formationId,
  formationName: formationId || "未命名编队",
  deviceIds: [],
  deviceCount: 0,
  onlineCount: 0,
  sceneId: "",
  description: "",
  color: "",
});

export const createDefaultDevice = (
  deviceId: string,
  topic = "",
): DeviceSnapshot => ({
  deviceId,
  deviceName: deviceId || "未命名设备",
  topic,
  online: true,
  stamp: new Date().toISOString(),
  sceneId: "",
  runtimeSceneId: "",
  defaultSceneId: "",
  mapProfile: "lanelet",
  gpsEnabled: true,
  rosMapEnabled: true,
  tags: [],
  formationIds: [],
  gps: { lat: null, lng: null, heading: null },
  fusionLoc: { x: null, y: null, yaw: null },
  lidarLoc: { x: null, y: null, yaw: null },
  vehicleInfo: {
    controlMode: null,
    gear: null,
    speed: null,
    omega: null,
    soc: null,
  },
  taskStatus: null,
  platformTaskStatus: null,
  infoCode: createDefaultCode(),
  warningCode: createDefaultCode(),
  errorCode: createDefaultCode(),
  speedLimit: { limit: null, slowdownTime: null, stamp: null, moduleName: "" },
  alerts: [],
  extra: {},
});

export const normalizeCode = (rawCode: unknown): CodeState => {
  const raw = rawCode as
    { code?: unknown; info?: unknown; stamp?: unknown } | null | undefined;
  return {
    code: toNumeric(raw?.code, 0) ?? 0,
    info: asText(raw?.info),
    stamp: raw?.stamp ? toIsoString(raw.stamp) : null,
  };
};
export const normalizeFormation = (
  rawInput: unknown,
  existingFormation: Partial<FormationSnapshot> | null = null,
): FormationSnapshot => {
  const raw = (
    rawInput && typeof rawInput === "object" ? rawInput : {}
  ) as Record<string, unknown>;
  const formationId = asText(
    raw.formationId || raw.id || existingFormation?.formationId || "",
  );
  const base = createDefaultFormation(formationId);
  const deviceIds = Array.isArray(raw.deviceIds)
    ? raw.deviceIds.map((deviceId) => String(deviceId)).filter(Boolean)
    : existingFormation?.deviceIds || [];

  return {
    ...base,
    ...existingFormation,
    formationId,
    formationName: asText(
      raw.formationName ||
        raw.name ||
        existingFormation?.formationName ||
        formationId,
      // Reached only when an earlier member is truthy and not a scalar; the id beats "".
      formationId,
    ),
    deviceIds,
    deviceCount: Number.isFinite(Number(raw.deviceCount))
      ? Number(raw.deviceCount)
      : deviceIds.length,
    onlineCount: Number.isFinite(Number(raw.onlineCount))
      ? Number(raw.onlineCount)
      : existingFormation?.onlineCount || 0,
    sceneId: asText(raw.sceneId || existingFormation?.sceneId || ""),
    description: asText(
      raw.description || existingFormation?.description || "",
    ),
    color: asText(raw.color || existingFormation?.color || ""),
  };
};

/**
 * Coerce a vendor-supplied severity onto the `Severity` union.
 *
 * Mirrors `backend/src/normalize.ts`'s `normalizeSeverity`. Without it, a frame
 * carrying `severity: "ERROR"` kept that string, and the console then indexed
 * `grouped[alert.severity]` with a key that does not exist — an `undefined` bucket
 * rather than a critical alert.
 */
export const normalizeSeverity = (value: unknown): Severity => {
  const normalized = asText(value || "").toLowerCase();
  if (
    normalized.includes("critical") ||
    normalized.includes("fatal") ||
    normalized.includes("error")
  ) {
    return "critical";
  }
  if (normalized.includes("warn") || normalized.includes("low")) {
    return "warning";
  }
  return "notice";
};

export const dedupeAlerts = <T extends AlertLike>(alerts: T[]): T[] => {
  const deduped = new Map<string, T>();
  alerts.forEach((alert) => {
    const key = `${alert.id}|${alert.severity}|${alert.title}`;
    if (!deduped.has(key)) {
      deduped.set(key, alert);
    }
  });
  // Newest first, and an alert with no timestamp sorts **last** rather than first.
  // `?? 0` is the whole point: the old `Date.now()` fallback promoted every undated
  // alert to the top of the list and then re-sorted it on each tick, because the
  // fabricated stamp kept moving (parity 9.19).
  return [...deduped.values()].sort(
    (left, right) =>
      (parseTimestampMs(right.ts) ?? 0) - (parseTimestampMs(left.ts) ?? 0),
  );
};

export const buildCodeAlerts = (device: DeviceSnapshot): DeviceAlert[] => {
  const items: Array<{
    /**
     * The id's middle segment, spelled out rather than derived from `source`.
     *
     * Interpolating `source` produced `agv-1-error_code-5102` against the backend's
     * `agv-1-error-code-5102` (`backend/src/normalize.ts`'s `buildCodeAlerts`), and
     * acknowledgement is persisted **by id** (`navfleet:acked-alerts`) — so the two
     * derivations of one condition could not agree on what had been acknowledged.
     * Latent rather than live today, because the console keeps the backend's ids for
     * a normalized snapshot and only derives its own from a raw frame.
     */
    idSegment: string;
    severity: Severity;
    source: string;
    payload: CodeState;
    title: string;
  }> = [
    {
      idSegment: "info-code",
      severity: "notice",
      source: "info_code",
      payload: device.infoCode,
      title: "提示报码",
    },
    {
      idSegment: "warning-code",
      severity: "warning",
      source: "warning_code",
      payload: device.warningCode,
      title: "预警报码",
    },
    {
      idSegment: "error-code",
      severity: "critical",
      source: "error_code",
      payload: device.errorCode,
      title: "告警报码",
    },
  ];

  return items
    .filter((item) => Number(item.payload?.code) !== 0)
    .map((item) => ({
      id: `${device.deviceId}-${item.idSegment}-${item.payload.code}`,
      severity: item.severity,
      source: item.source,
      title: item.title,
      detail: item.payload.info || "",
      code: item.payload.code,
      info: item.payload.info || "",
      ts: item.payload.stamp || device.stamp,
      // The backend sets this on every alert it derives; omitting it meant one alert
      // had two shapes depending on which side built it.
      active: true,
    }));
};
export const buildRuleAlerts = (device: DeviceSnapshot): DeviceAlert[] => {
  const alerts: DeviceAlert[] = [];
  const soc = Number(device.vehicleInfo?.soc);

  if (Number.isFinite(soc) && soc > 0 && soc < 20) {
    alerts.push({
      id: `${device.deviceId}-low-soc`,
      severity: "warning",
      source: "rule-engine",
      title: "低电量预警",
      // `round`, not `toFixed(1)`: the backend renders the same sentence with
      // `round(soc, 1)`, so an integral reading came out as "15.0%" here and "15%"
      // there — the same alert, two texts, decided by which side built it.
      detail: `当前电量 ${round(soc, 1)}%，建议尽快安排回充`,
      ts: device.stamp,
      active: true,
    });
  }

  if (!device.online) {
    alerts.push({
      id: `${device.deviceId}-offline`,
      severity: "critical",
      source: "rule-engine",
      title: "设备离线",
      detail: "设备超过离线阈值未上报，系统已自动标记为离线",
      ts: device.stamp,
      active: true,
    });
  }

  return alerts;
};

export const normalizeDevice = (
  rawInput: unknown,
  topicHint = "",
  existingDevice: Partial<DeviceSnapshot> | null = null,
) => {
  const source = rawInput as Record<string, unknown>;
  const raw = (
    rawInput &&
    source.payload &&
    typeof source.payload === "object" &&
    !Array.isArray(source.payload)
      ? {
          ...(source.payload as Record<string, unknown>),
          topic:
            source.topic || (source.payload as Record<string, unknown>).topic,
        }
      : rawInput
  ) as Record<string, unknown>;

  const topic = asText(raw.topic || topicHint || existingDevice?.topic);
  const deviceId =
    asText(
      raw.deviceId ||
        raw.id ||
        raw.device_id ||
        extractDeviceIdFromTopic(topic) ||
        existingDevice?.deviceId,
    ) || `device-${Date.now()}`;
  const base = createDefaultDevice(
    deviceId,
    topic || `/fleet/${deviceId}/vehicle_info`,
  );

  const fusionLoc = (raw.fusion_loc || raw.fusionLoc || {}) as Record<
    string,
    unknown
  >;
  const lidarLoc = (raw.lidar_loc || raw.lidarLoc || {}) as Record<
    string,
    unknown
  >;
  const vehicleInfo = (raw.vehicle_info || raw.vehicleInfo || {}) as Record<
    string,
    unknown
  >;
  const speedLimit = (raw.speed_limit || raw.speedLimit || {}) as Record<
    string,
    unknown
  >;
  const gps = (raw.gps || raw.location || {}) as Record<string, unknown>;
  const runtimeSceneId = asText(
    raw.runtimeSceneId ||
      raw.scene_id ||
      raw.sceneId ||
      (raw.scenePose as { sceneId?: unknown } | null | undefined)?.sceneId ||
      existingDevice?.runtimeSceneId,
  );
  const normalizedDevice = {
    ...base,
    ...existingDevice,
    deviceId,
    deviceName:
      asText(
        raw.deviceName ||
          raw.device_name ||
          raw.name ||
          existingDevice?.deviceName,
        deviceId,
      ) || deviceId,
    topic: topic || existingDevice?.topic || base.topic,
    online:
      typeof raw.online === "boolean"
        ? raw.online
        : (existingDevice?.online ?? true),
    stamp: toIsoString(
      raw.stamp ||
        raw.lastSeen ||
        raw.timestamp ||
        raw.time ||
        existingDevice?.stamp ||
        Date.now(),
    ),
    sceneId: asText(
      raw.scene_id ||
        raw.sceneId ||
        (raw.scenePose as { sceneId?: unknown } | null | undefined)?.sceneId ||
        raw.runtimeSceneId ||
        existingDevice?.sceneId,
    ),
    runtimeSceneId,
    defaultSceneId: asText(
      raw.defaultSceneId || existingDevice?.defaultSceneId,
    ),
    mapProfile:
      asText(raw.mapProfile || existingDevice?.mapProfile) || "lanelet",
    gpsEnabled:
      typeof raw.gpsEnabled === "boolean"
        ? raw.gpsEnabled
        : (existingDevice?.gpsEnabled ?? true),
    rosMapEnabled:
      typeof raw.rosMapEnabled === "boolean"
        ? raw.rosMapEnabled
        : (existingDevice?.rosMapEnabled ?? true),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((tag) => String(tag))
      : existingDevice?.tags || [],
    formationIds: Array.isArray(raw.formationIds)
      ? raw.formationIds.map((formationId) => String(formationId))
      : existingDevice?.formationIds || [],
    gps: {
      lat: toNumeric(
        gps.lat ?? raw.latitude ?? raw.gps_lat ?? raw.lat,
        existingDevice?.gps?.lat ?? null,
      ),
      lng: toNumeric(
        gps.lng ?? raw.longitude ?? raw.gps_lng ?? raw.lng,
        existingDevice?.gps?.lng ?? null,
      ),
      heading: toNumeric(
        gps.heading ?? gps.yaw ?? raw.heading ?? raw.gps_heading,
        existingDevice?.gps?.heading ?? null,
      ),
    },
    fusionLoc: {
      x: toNumeric(fusionLoc.x, existingDevice?.fusionLoc?.x ?? null),
      y: toNumeric(fusionLoc.y, existingDevice?.fusionLoc?.y ?? null),
      yaw: toNumeric(fusionLoc.yaw, existingDevice?.fusionLoc?.yaw ?? null),
    },
    lidarLoc: {
      x: toNumeric(lidarLoc.x, existingDevice?.lidarLoc?.x ?? null),
      y: toNumeric(lidarLoc.y, existingDevice?.lidarLoc?.y ?? null),
      yaw: toNumeric(lidarLoc.yaw, existingDevice?.lidarLoc?.yaw ?? null),
    },
    vehicleInfo: {
      controlMode: toNumeric(
        vehicleInfo.control_mode ?? vehicleInfo.controlMode,
        existingDevice?.vehicleInfo?.controlMode ?? null,
      ),
      gear: toNumeric(
        vehicleInfo.gear,
        existingDevice?.vehicleInfo?.gear ?? null,
      ),
      speed: toNumeric(
        vehicleInfo.speed,
        existingDevice?.vehicleInfo?.speed ?? null,
      ),
      omega: toNumeric(
        vehicleInfo.omega,
        existingDevice?.vehicleInfo?.omega ?? null,
      ),
      soc: toNumeric(vehicleInfo.soc, existingDevice?.vehicleInfo?.soc ?? null),
    },
    taskStatus: toNumeric(
      raw.task_status ??
        raw.taskStatus ??
        (raw.task as { status?: unknown } | null | undefined)?.status,
      existingDevice?.taskStatus ?? null,
    ),
    platformTaskStatus: toNumeric(
      raw.platform_task_status ?? raw.platformTaskStatus,
      existingDevice?.platformTaskStatus ?? null,
    ),
    infoCode: normalizeCode(
      raw.info_code || raw.infoCode || existingDevice?.infoCode,
    ),
    warningCode: normalizeCode(
      raw.warning_code || raw.warningCode || existingDevice?.warningCode,
    ),
    errorCode: normalizeCode(
      raw.error_code || raw.errorCode || existingDevice?.errorCode,
    ),
    speedLimit: {
      limit: toNumeric(
        speedLimit.limit,
        existingDevice?.speedLimit?.limit ?? null,
      ),
      slowdownTime: toNumeric(
        speedLimit.slowdown_time ?? speedLimit.slowdownTime,
        existingDevice?.speedLimit?.slowdownTime ?? null,
      ),
      stamp: speedLimit.stamp
        ? toIsoString(speedLimit.stamp)
        : (existingDevice?.speedLimit?.stamp ?? null),
      moduleName: asText(
        speedLimit.module_name ||
          speedLimit.moduleName ||
          existingDevice?.speedLimit?.moduleName,
      ),
    },
    /**
     * Always empty here, and that is not a placeholder being sloppy — the three branches
     * below (`isArray && normalized`, `isArray && !normalized`, `!isArray`) cover every
     * input, so whatever this field is set to is overwritten before the function returns.
     *
     * It used to read `Array.isArray(raw.alerts) ? raw.alerts : []`, whose live branch is
     * therefore dead. The cost was not the dead code: `Array.isArray` on an `unknown`
     * narrows to `any[]`, so this one expression made `alerts` an `any[]` for every reader
     * of the returned snapshot — including the tests, which had to annotate each
     * `.find()` callback by hand and still got `any` back out.
     */
    alerts: [] as DeviceAlert[],
    extra: {
      ...((existingDevice?.extra as Record<string, unknown>) || {}),
      ...((raw.extra as Record<string, unknown>) || {}),
    },
  };
  if (
    !hasPose(normalizedDevice.fusionLoc) &&
    hasPose(normalizedDevice.lidarLoc)
  ) {
    normalizedDevice.fusionLoc = { ...normalizedDevice.lidarLoc };
  }

  if (Array.isArray(raw.alerts) && isNormalizedSnapshot(raw)) {
    // `Array.isArray` on an `unknown` narrows to `any[]`, so every field below used to be
    // read off `any` — eight `no-unsafe-member-access` in a branch whose entire purpose is
    // to re-derive these fields. `asRecord` is the same narrowing the vendor branch below
    // already did by hand.
    normalizedDevice.alerts = dedupeAlerts(
      (raw.alerts as unknown[]).map((entry, index) => {
        const alert = asRecord(entry);
        return {
          id:
            asText(alert.id) ||
            `${normalizedDevice.deviceId}-alert-${index + 1}`,
          severity: normalizeSeverity(alert.severity),
          source: asText(alert.source) || "snapshot",
          title: asText(alert.title) || "设备告警",
          detail: asText(alert.detail),
          code: toNumeric(alert.code, 0) ?? 0,
          info: asText(alert.info),
          ts: asText(alert.ts) || normalizedDevice.stamp,
        };
      }),
    );
  } else if (Array.isArray(raw.alerts)) {
    // A raw vendor frame that carries its own `alerts` array. This case used to fall
    // past both branches, leaving the array assigned **verbatim** further up: no id
    // defaulting, no severity coercion, no dedupe, no ordering — and typed `any[]`,
    // which is why the fields were read off `any`. A vendor `severity: "ERROR"` then
    // survived into the store and indexed `grouped[severity]` with a key that is not
    // in the union.
    normalizedDevice.alerts = dedupeAlerts(
      (raw.alerts as unknown[]).map((entry, index) => {
        const alert = asRecord(entry);
        return {
          id: asText(
            alert.id || `${normalizedDevice.deviceId}-alert-${index + 1}`,
          ),
          severity: normalizeSeverity(alert.severity),
          source: asText(alert.source || "device"),
          title: asText(alert.title || "设备告警"),
          detail: asText(alert.detail || alert.info || ""),
          code: toNumeric(alert.code, 0) ?? 0,
          info: asText(alert.info || ""),
          ts: asText(alert.ts) || normalizedDevice.stamp,
          active: true,
        };
      }),
    );
  } else if (!Array.isArray(raw.alerts)) {
    normalizedDevice.alerts = dedupeAlerts([
      ...buildCodeAlerts(normalizedDevice),
      ...buildRuleAlerts(normalizedDevice),
    ]);
  }

  return normalizedDevice;
};

export const mergeDevice = (
  existingDevice: Partial<DeviceSnapshot> | null,
  incomingDevice: Partial<DeviceSnapshot>,
): DeviceSnapshot => {
  if (!existingDevice) {
    return incomingDevice as DeviceSnapshot;
  }
  return {
    ...existingDevice,
    ...incomingDevice,
    gps: { ...existingDevice.gps, ...incomingDevice.gps },
    fusionLoc: { ...existingDevice.fusionLoc, ...incomingDevice.fusionLoc },
    lidarLoc: { ...existingDevice.lidarLoc, ...incomingDevice.lidarLoc },
    vehicleInfo: {
      ...existingDevice.vehicleInfo,
      ...incomingDevice.vehicleInfo,
    },
    infoCode: { ...existingDevice.infoCode, ...incomingDevice.infoCode },
    warningCode: {
      ...existingDevice.warningCode,
      ...incomingDevice.warningCode,
    },
    errorCode: { ...existingDevice.errorCode, ...incomingDevice.errorCode },
    speedLimit: { ...existingDevice.speedLimit, ...incomingDevice.speedLimit },
    extra: { ...existingDevice.extra, ...incomingDevice.extra },
    alerts: incomingDevice.alerts,
    formationIds: Array.isArray(incomingDevice.formationIds)
      ? [...incomingDevice.formationIds]
      : [...(existingDevice.formationIds || [])],
  } as DeviceSnapshot;
};
const mergeBounds = (
  baseBounds: ScenePartLike["bounds"],
  overrideBounds: ScenePartLike["bounds"],
  definition: ScenePartLike,
) =>
  overrideBounds ||
  baseBounds || {
    minX: definition.origin?.x || 0,
    maxX:
      (definition.origin?.x || 0) +
      (definition.width || 1000) * (definition.resolution || 0.1),
    minY: definition.origin?.y || 0,
    maxY:
      (definition.origin?.y || 0) +
      (definition.height || 620) * (definition.resolution || 0.1),
  };

export const mergeSceneDefinitionParts = (
  base: ScenePartLike = {},
  override: ScenePartLike = {},
) => ({
  ...base,
  ...override,
  origin: {
    ...(base.origin || {}),
    ...(override.origin || {}),
  },
  bounds: mergeBounds(base.bounds, override.bounds, {
    ...base,
    ...override,
    origin: { ...(base.origin || {}), ...(override.origin || {}) },
  }),
  defaultView:
    base.defaultView || override.defaultView
      ? {
          ...(base.defaultView || {}),
          ...(override.defaultView || {}),
        }
      : undefined,
});

export const normalizePathPoint = (
  point: MaybePoint,
): { x: number; y: number } | null => {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return null;
  }
  return {
    x: round(point!.x, 3),
    y: round(point!.y, 3),
  };
};

export const pointsAreNear = (
  left: MaybePoint,
  right: MaybePoint,
  epsilon = 0.05,
): boolean =>
  Number.isFinite(left?.x) &&
  Number.isFinite(left?.y) &&
  Number.isFinite(right?.x) &&
  Number.isFinite(right?.y) &&
  Math.hypot(
    (left!.x as number) - (right!.x as number),
    (left!.y as number) - (right!.y as number),
  ) <= epsilon;

// Movement history ("trails"): how many recent points to keep per device, and
// the minimum world-space distance (m) a device must move before a new point
// is recorded — keeps trails compact and avoids jitter noise.
export const TRAIL_MAX_POINTS = 240;
export const TRAIL_MIN_DISTANCE = 0.12;

export const pickTrailPose = (
  device: { fusionLoc?: MaybePoint; lidarLoc?: MaybePoint } | null | undefined,
): MaybePoint => {
  if (
    Number.isFinite(device?.fusionLoc?.x) &&
    Number.isFinite(device?.fusionLoc?.y)
  ) {
    return device!.fusionLoc;
  }
  if (
    Number.isFinite(device?.lidarLoc?.x) &&
    Number.isFinite(device?.lidarLoc?.y)
  ) {
    return device!.lidarLoc;
  }
  return null;
};
