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
  MapProfile,
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

export const cloneValue = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export const round = (value: unknown, digits = 2): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
};

export const toNumeric = (
  value: unknown,
  fallback: number | null = null,
): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

export const toTimestampMs = (value: unknown): number => {
  if (value === null || value === undefined || value === "") {
    return Date.now();
  }
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
};

export const toIsoString = (value: unknown): string =>
  new Date(toTimestampMs(value)).toISOString();

export const formatDateTime = (value: unknown): string =>
  new Date(toTimestampMs(value)).toLocaleString("zh-CN", {
    hour12: false,
  });

export const extractDeviceIdFromTopic = (topic: unknown): string => {
  const match = String(topic || "").match(/^\/fleet\/([^/]+)\//);
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
    info: (raw?.info as string) || "",
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
  const formationId = String(
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
    formationName: String(
      raw.formationName ||
        raw.name ||
        existingFormation?.formationName ||
        formationId,
    ),
    deviceIds,
    deviceCount: Number.isFinite(Number(raw.deviceCount))
      ? Number(raw.deviceCount)
      : deviceIds.length,
    onlineCount: Number.isFinite(Number(raw.onlineCount))
      ? Number(raw.onlineCount)
      : existingFormation?.onlineCount || 0,
    sceneId: String(raw.sceneId || existingFormation?.sceneId || ""),
    description: String(
      raw.description || existingFormation?.description || "",
    ),
    color: String(raw.color || existingFormation?.color || ""),
  };
};

export const dedupeAlerts = <T extends AlertLike>(alerts: T[]): T[] => {
  const deduped = new Map<string, T>();
  alerts.forEach((alert) => {
    const key = `${alert.id}|${alert.severity}|${alert.title}`;
    if (!deduped.has(key)) {
      deduped.set(key, alert);
    }
  });
  return [...deduped.values()].sort(
    (left, right) => toTimestampMs(right.ts) - toTimestampMs(left.ts),
  );
};

export const buildCodeAlerts = (device: DeviceSnapshot): DeviceAlert[] => {
  const items: Array<{
    severity: Severity;
    source: string;
    payload: CodeState;
    title: string;
  }> = [
    {
      severity: "notice",
      source: "info_code",
      payload: device.infoCode,
      title: "提示报码",
    },
    {
      severity: "warning",
      source: "warning_code",
      payload: device.warningCode,
      title: "预警报码",
    },
    {
      severity: "critical",
      source: "error_code",
      payload: device.errorCode,
      title: "告警报码",
    },
  ];

  return items
    .filter((item) => Number(item.payload?.code) !== 0)
    .map((item) => ({
      id: `${device.deviceId}-${item.source}-${item.payload.code}`,
      severity: item.severity,
      source: item.source,
      title: item.title,
      detail: item.payload.info || "",
      code: item.payload.code,
      info: item.payload.info || "",
      ts: item.payload.stamp || device.stamp,
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
      detail: `当前电量 ${soc.toFixed(1)}%，建议尽快安排回充。`,
      ts: device.stamp,
    });
  }

  if (!device.online) {
    alerts.push({
      id: `${device.deviceId}-offline`,
      severity: "critical",
      source: "rule-engine",
      title: "设备离线",
      detail: "设备超过离线阈值未上报，系统已自动标记为离线。",
      ts: device.stamp,
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

  const topic = (raw.topic ||
    topicHint ||
    existingDevice?.topic ||
    "") as string;
  const deviceId = (raw.deviceId ||
    raw.id ||
    raw.device_id ||
    extractDeviceIdFromTopic(topic) ||
    existingDevice?.deviceId ||
    `device-${Date.now()}`) as string;
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
  const runtimeSceneId = (raw.runtimeSceneId ||
    raw.scene_id ||
    raw.sceneId ||
    (raw.scenePose as { sceneId?: unknown } | null | undefined)?.sceneId ||
    existingDevice?.runtimeSceneId ||
    "") as string;
  const normalizedDevice = {
    ...base,
    ...existingDevice,
    deviceId,
    deviceName: (raw.deviceName ||
      raw.device_name ||
      raw.name ||
      existingDevice?.deviceName ||
      deviceId) as string,
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
    sceneId: (raw.scene_id ||
      raw.sceneId ||
      (raw.scenePose as { sceneId?: unknown } | null | undefined)?.sceneId ||
      raw.runtimeSceneId ||
      existingDevice?.sceneId ||
      "") as string,
    runtimeSceneId,
    defaultSceneId: (raw.defaultSceneId ||
      existingDevice?.defaultSceneId ||
      "") as string,
    mapProfile: (raw.mapProfile ||
      existingDevice?.mapProfile ||
      "lanelet") as MapProfile,
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
      moduleName: (speedLimit.module_name ||
        speedLimit.moduleName ||
        existingDevice?.speedLimit?.moduleName ||
        "") as string,
    },
    alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
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
    normalizedDevice.alerts = dedupeAlerts(
      raw.alerts.map((alert, index) => ({
        id: alert.id || `${normalizedDevice.deviceId}-alert-${index + 1}`,
        severity: alert.severity || "notice",
        source: alert.source || "snapshot",
        title: alert.title || "设备告警",
        detail: alert.detail || "",
        code: toNumeric(alert.code, 0) ?? 0,
        info: alert.info || "",
        ts: alert.ts || normalizedDevice.stamp,
      })),
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
