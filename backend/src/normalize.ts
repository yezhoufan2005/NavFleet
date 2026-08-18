import { CodeState, DeviceAlert, DeviceSnapshot, FleetSnapshot, Severity } from "./types";

type UnknownRecord = Record<string, unknown>;

const round = (value: number, precision = 2): number => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

const toNumeric = (value: unknown, fallback: number | null = null): number | null => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toTimestampMs = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const toIsoString = (value: unknown): string => new Date(toTimestampMs(value)).toISOString();

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNormalizedSnapshotRecord = (value: UnknownRecord): boolean =>
  "runtimeSceneId" in value ||
  "defaultSceneId" in value ||
  "fusionLoc" in value ||
  "vehicleInfo" in value ||
  "infoCode" in value ||
  "speedLimit" in value;

const extractDeviceIdFromTopic = (topic: string): string => {
  const match = String(topic || "").match(/^\/fleet\/([^/]+)\//);
  return match?.[1] || "";
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const hasPose = (pose: DeviceSnapshot["fusionLoc"] | DeviceSnapshot["lidarLoc"]): boolean =>
  isFiniteNumber(pose?.x) && isFiniteNumber(pose?.y);

export const hasGps = (gps: DeviceSnapshot["gps"]): boolean =>
  isFiniteNumber(gps?.lat) && isFiniteNumber(gps?.lng);

const normalizeSeverity = (value: unknown): Severity => {
  const normalized = String(value || "").toLowerCase();
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

const createDefaultCode = (): CodeState => ({
  code: 0,
  info: "",
  stamp: null,
});

const normalizeCode = (rawCode: unknown, fallback?: CodeState): CodeState => {
  const source = isRecord(rawCode) ? rawCode : {};
  return {
    code: Number(toNumeric(source.code, fallback?.code ?? 0) ?? 0),
    info: String(source.info || fallback?.info || ""),
    stamp: source.stamp ? toIsoString(source.stamp) : fallback?.stamp || null,
  };
};

const createDefaultDevice = (deviceId: string): DeviceSnapshot => ({
  deviceId,
  deviceName: deviceId,
  topic: `/fleet/${deviceId}/vehicle_info`,
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
  speedLimit: {
    limit: null,
    slowdownTime: null,
    stamp: null,
    moduleName: "",
  },
  alerts: [],
  extra: {},
});

const buildRawAlerts = (raw: UnknownRecord, nowIso: string, deviceId: string): DeviceAlert[] => {
  const sourceValue = Array.isArray(raw.alerts)
    ? raw.alerts
    : Array.isArray(raw.alarmList)
      ? raw.alarmList
      : [];
  return sourceValue.filter(isRecord).map((item, index) => ({
    id: String(item.id || `${deviceId}-alert-${index + 1}`),
    title: String(item.title || `设备告警 ${index + 1}`),
    detail: String(item.detail || item.info || ""),
    severity: normalizeSeverity(item.severity || item.level),
    source: String(item.source || "device-alert"),
    ts: toIsoString(item.ts || item.timestamp || nowIso),
    active: true,
    code: Number(toNumeric(item.code, 0) ?? 0),
    info: item.info ? String(item.info) : "",
  }));
};

const buildCodeAlerts = (snapshot: DeviceSnapshot): DeviceAlert[] => {
  const codeItems = [
    {
      id: `${snapshot.deviceId}-info-code-${snapshot.infoCode.code}`,
      title: "提示报码",
      severity: "notice" as const,
      source: "info_code",
      payload: snapshot.infoCode,
    },
    {
      id: `${snapshot.deviceId}-warning-code-${snapshot.warningCode.code}`,
      title: "预警报码",
      severity: "warning" as const,
      source: "warning_code",
      payload: snapshot.warningCode,
    },
    {
      id: `${snapshot.deviceId}-error-code-${snapshot.errorCode.code}`,
      title: "告警报码",
      severity: "critical" as const,
      source: "error_code",
      payload: snapshot.errorCode,
    },
  ];

  return codeItems
    .filter((item) => item.payload.code !== 0)
    .map((item) => ({
      id: item.id,
      title: item.title,
      detail: item.payload.info || "",
      severity: item.severity,
      source: item.source,
      ts: item.payload.stamp || snapshot.stamp,
      active: true,
      code: item.payload.code,
      info: item.payload.info || "",
    }));
};

const buildRuleAlerts = (snapshot: DeviceSnapshot): DeviceAlert[] => {
  const alerts: DeviceAlert[] = [];
  const soc = snapshot.vehicleInfo.soc ?? 0;

  if (soc > 0 && soc < 20) {
    alerts.push({
      id: `${snapshot.deviceId}-low-soc`,
      title: "低电量预警",
      detail: `当前电量 ${round(soc, 1)}%，建议尽快安排回充。`,
      severity: "warning",
      source: "rule-engine",
      ts: snapshot.stamp,
      active: true,
    });
  }

  if (!snapshot.online) {
    alerts.push({
      id: `${snapshot.deviceId}-offline`,
      title: "设备离线",
      detail: "设备超过离线阈值未上报，系统已自动标记为离线。",
      severity: "critical",
      source: "rule-engine",
      ts: snapshot.stamp,
      active: true,
    });
  }

  return alerts;
};

const dedupeAlerts = (alerts: DeviceAlert[]): DeviceAlert[] => {
  const deduplicated = new Map<string, DeviceAlert>();
  alerts.forEach((alert) => {
    const key = `${alert.id}|${alert.severity}|${alert.title}`;
    if (!deduplicated.has(key)) {
      deduplicated.set(key, alert);
    }
  });
  return [...deduplicated.values()].sort(
    (left, right) => toTimestampMs(right.ts) - toTimestampMs(left.ts),
  );
};

export const normalizeDevice = (
  rawInput: UnknownRecord,
  existingDevice: DeviceSnapshot | null = null,
  topicHint = "",
): DeviceSnapshot => {
  const payloadRecord = isRecord(rawInput.payload) ? rawInput.payload : null;
  const raw: UnknownRecord = payloadRecord
    ? {
        ...payloadRecord,
        topic: rawInput.topic || payloadRecord.topic,
      }
    : rawInput;
  const isNormalizedSnapshot = isNormalizedSnapshotRecord(raw);

  const topic = String(raw.topic || topicHint || existingDevice?.topic || "");
  const deviceId = String(
    raw.deviceId ||
      raw.id ||
      raw.device_id ||
      extractDeviceIdFromTopic(topic) ||
      existingDevice?.deviceId ||
      `device-${Date.now()}`,
  );

  const base = createDefaultDevice(deviceId);
  const fusionLoc = isRecord(raw.fusion_loc)
    ? raw.fusion_loc
    : isRecord(raw.fusionLoc)
      ? raw.fusionLoc
      : {};
  const lidarLoc = isRecord(raw.lidar_loc)
    ? raw.lidar_loc
    : isRecord(raw.lidarLoc)
      ? raw.lidarLoc
      : {};
  const vehicleInfo = isRecord(raw.vehicle_info)
    ? raw.vehicle_info
    : isRecord(raw.vehicleInfo)
      ? raw.vehicleInfo
      : {};
  const speedLimit = isRecord(raw.speed_limit)
    ? raw.speed_limit
    : isRecord(raw.speedLimit)
      ? raw.speedLimit
      : {};
  const gps = isRecord(raw.gps) ? raw.gps : isRecord(raw.location) ? raw.location : {};
  const stamp = toIsoString(
    raw.stamp || raw.lastSeen || raw.last_seen || raw.ts || raw.timestamp || Date.now(),
  );
  const runtimeSceneId = String(
    raw.scene_id ||
      raw.sceneId ||
      (isRecord(raw.scenePose) ? raw.scenePose.sceneId : undefined) ||
      raw.runtimeSceneId ||
      existingDevice?.runtimeSceneId ||
      "",
  );

  const snapshot: DeviceSnapshot = {
    ...base,
    ...existingDevice,
    deviceId,
    deviceName: String(
      raw.deviceName || raw.device_name || raw.name || existingDevice?.deviceName || deviceId,
    ),
    topic: topic || existingDevice?.topic || `/fleet/${deviceId}/vehicle_info`,
    online: typeof raw.online === "boolean" ? raw.online : (existingDevice?.online ?? true),
    stamp,
    sceneId: runtimeSceneId || existingDevice?.sceneId || "",
    runtimeSceneId,
    defaultSceneId: String(raw.defaultSceneId || existingDevice?.defaultSceneId || ""),
    mapProfile: String(raw.mapProfile || existingDevice?.mapProfile || "lanelet"),
    gpsEnabled:
      typeof raw.gpsEnabled === "boolean" ? raw.gpsEnabled : (existingDevice?.gpsEnabled ?? true),
    rosMapEnabled:
      typeof raw.rosMapEnabled === "boolean"
        ? raw.rosMapEnabled
        : (existingDevice?.rosMapEnabled ?? true),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((tag) => String(tag))
      : existingDevice?.tags
        ? [...existingDevice.tags]
        : [],
    gps: {
      lat: toNumeric(
        gps.lat ?? raw.latitude ?? raw.gps_lat ?? raw.lat,
        existingDevice?.gps.lat ?? null,
      ),
      lng: toNumeric(
        gps.lng ?? raw.longitude ?? raw.gps_lng ?? raw.lng,
        existingDevice?.gps.lng ?? null,
      ),
      heading: toNumeric(
        gps.heading ?? raw.heading ?? gps.yaw,
        existingDevice?.gps.heading ?? null,
      ),
    },
    fusionLoc: {
      x: toNumeric(fusionLoc.x ?? raw.x, existingDevice?.fusionLoc.x ?? null),
      y: toNumeric(fusionLoc.y ?? raw.y, existingDevice?.fusionLoc.y ?? null),
      yaw: toNumeric(fusionLoc.yaw ?? raw.yaw, existingDevice?.fusionLoc.yaw ?? null),
    },
    lidarLoc: {
      x: toNumeric(lidarLoc.x, existingDevice?.lidarLoc.x ?? null),
      y: toNumeric(lidarLoc.y, existingDevice?.lidarLoc.y ?? null),
      yaw: toNumeric(lidarLoc.yaw, existingDevice?.lidarLoc.yaw ?? null),
    },
    vehicleInfo: {
      controlMode: toNumeric(
        vehicleInfo.control_mode ?? vehicleInfo.controlMode,
        existingDevice?.vehicleInfo.controlMode ?? null,
      ),
      gear: toNumeric(vehicleInfo.gear, existingDevice?.vehicleInfo.gear ?? null),
      speed: toNumeric(vehicleInfo.speed, existingDevice?.vehicleInfo.speed ?? null),
      omega: toNumeric(vehicleInfo.omega, existingDevice?.vehicleInfo.omega ?? null),
      soc: toNumeric(vehicleInfo.soc, existingDevice?.vehicleInfo.soc ?? null),
    },
    taskStatus: toNumeric(raw.task_status ?? raw.taskStatus, existingDevice?.taskStatus ?? null),
    platformTaskStatus: toNumeric(
      raw.platform_task_status ?? raw.platformTaskStatus,
      existingDevice?.platformTaskStatus ?? null,
    ),
    infoCode: normalizeCode(raw.info_code || raw.infoCode, existingDevice?.infoCode),
    warningCode: normalizeCode(raw.warning_code || raw.warningCode, existingDevice?.warningCode),
    errorCode: normalizeCode(raw.error_code || raw.errorCode, existingDevice?.errorCode),
    speedLimit: {
      limit: toNumeric(speedLimit.limit, existingDevice?.speedLimit.limit ?? null),
      slowdownTime: toNumeric(
        speedLimit.slowdown_time ?? speedLimit.slowdownTime,
        existingDevice?.speedLimit.slowdownTime ?? null,
      ),
      stamp: speedLimit.stamp
        ? toIsoString(speedLimit.stamp)
        : (existingDevice?.speedLimit.stamp ?? null),
      moduleName: String(
        speedLimit.module_name ||
          speedLimit.moduleName ||
          existingDevice?.speedLimit.moduleName ||
          "",
      ),
    },
    alerts: [],
    extra: {
      ...(existingDevice?.extra || {}),
      ...(isRecord(raw.extra) ? raw.extra : {}),
    },
  };

  if (!hasPose(snapshot.fusionLoc) && hasPose(snapshot.lidarLoc)) {
    snapshot.fusionLoc = { ...snapshot.lidarLoc };
  }

  if (raw.temperature !== undefined) {
    snapshot.extra.temperature = raw.temperature;
  }
  if (raw.networkQuality !== undefined) {
    snapshot.extra.networkQuality = raw.networkQuality;
  }
  if (raw.vehicleModel !== undefined) {
    snapshot.extra.vehicleModel = raw.vehicleModel;
  }

  if (Array.isArray(raw.alerts) && isNormalizedSnapshot) {
    snapshot.alerts = dedupeAlerts(
      raw.alerts.filter(isRecord).map((alert, index) => ({
        id: String(alert.id || `${deviceId}-alert-${index + 1}`),
        title: String(alert.title || "设备告警"),
        detail: String(alert.detail || ""),
        severity: normalizeSeverity(alert.severity),
        source: String(alert.source || "snapshot"),
        ts: toIsoString(alert.ts || stamp),
        active: typeof alert.active === "boolean" ? alert.active : true,
        code: Number(toNumeric(alert.code, 0) ?? 0),
        info: alert.info ? String(alert.info) : "",
      })),
    );
  } else {
    snapshot.alerts = dedupeAlerts([
      ...buildRawAlerts(raw, stamp, deviceId),
      ...buildCodeAlerts(snapshot),
      ...buildRuleAlerts(snapshot),
    ]);
  }

  return snapshot;
};

export const mergeDevice = (
  existingDevice: DeviceSnapshot | null | undefined,
  incomingDevice: DeviceSnapshot,
): DeviceSnapshot => {
  if (!existingDevice) {
    return incomingDevice;
  }

  return {
    ...existingDevice,
    ...incomingDevice,
    gps: { ...existingDevice.gps, ...incomingDevice.gps },
    fusionLoc: { ...existingDevice.fusionLoc, ...incomingDevice.fusionLoc },
    lidarLoc: { ...existingDevice.lidarLoc, ...incomingDevice.lidarLoc },
    vehicleInfo: { ...existingDevice.vehicleInfo, ...incomingDevice.vehicleInfo },
    infoCode: { ...existingDevice.infoCode, ...incomingDevice.infoCode },
    warningCode: { ...existingDevice.warningCode, ...incomingDevice.warningCode },
    errorCode: { ...existingDevice.errorCode, ...incomingDevice.errorCode },
    speedLimit: { ...existingDevice.speedLimit, ...incomingDevice.speedLimit },
    extra: { ...existingDevice.extra, ...incomingDevice.extra },
    alerts: incomingDevice.alerts,
  };
};

export const normalizePayload = (
  input: unknown,
  existingDevices: Map<string, DeviceSnapshot>,
  fleetName: string,
  topicPattern: string,
): { replace: boolean; fleetName: string; topicPattern: string; devices: DeviceSnapshot[] } => {
  if (!isRecord(input) && !Array.isArray(input)) {
    throw new Error("payload must be a JSON object");
  }

  if (Array.isArray(input)) {
    return {
      replace: true,
      fleetName,
      topicPattern,
      devices: input.filter(isRecord).map((item) => normalizeDevice(item)),
    };
  }

  if (Array.isArray(input.devices)) {
    return {
      replace: true,
      fleetName,
      topicPattern,
      devices: input.devices.filter(isRecord).map((item) => normalizeDevice(item)),
    };
  }

  if (input.topic && input.payload !== undefined) {
    const payloadBody =
      typeof input.payload === "string"
        ? (JSON.parse(String(input.payload)) as UnknownRecord)
        : (input.payload as UnknownRecord);
    if (Array.isArray(payloadBody.devices)) {
      return {
        replace: true,
        fleetName,
        topicPattern,
        devices: payloadBody.devices.filter(isRecord).map((item) => normalizeDevice(item)),
      };
    }

    const deviceId = String(payloadBody.deviceId || extractDeviceIdFromTopic(String(input.topic)));
    return {
      replace: false,
      fleetName,
      topicPattern,
      devices: [
        normalizeDevice(payloadBody, existingDevices.get(deviceId) || null, String(input.topic)),
      ],
    };
  }

  const deviceId = String(input.deviceId || extractDeviceIdFromTopic(String(input.topic || "")));
  return {
    replace: false,
    fleetName,
    topicPattern,
    devices: [
      normalizeDevice(input, existingDevices.get(deviceId) || null, String(input.topic || "")),
    ],
  };
};

export const buildFleetSnapshot = (
  devices: DeviceSnapshot[],
  fleetName: string,
  topicPattern: string,
  formations: FleetSnapshot["formations"] = [],
  updatedAt = new Date().toISOString(),
): FleetSnapshot => ({
  fleetName,
  topicPattern,
  updatedAt,
  devices: [...devices].sort((left, right) => Date.parse(right.stamp) - Date.parse(left.stamp)),
  formations,
});
