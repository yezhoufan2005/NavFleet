import { computed, reactive, toRaw } from "vue";
import { fallbackFleetPayload, sceneCatalog } from "../data-defaults";
import { notify } from "./useNotifications";

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const round = (value, digits = 2) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
};

const toNumeric = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const toTimestampMs = (value) => {
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

const toIsoString = (value) => new Date(toTimestampMs(value)).toISOString();

const formatDateTime = (value) =>
  new Date(toTimestampMs(value)).toLocaleString("zh-CN", {
    hour12: false,
  });

const extractDeviceIdFromTopic = (topic) => {
  const match = String(topic || "").match(/^\/fleet\/([^/]+)\//);
  return match?.[1] || "";
};

const hasPose = (pose) => Number.isFinite(pose?.x) && Number.isFinite(pose?.y);
const hasGps = (gps) => Number.isFinite(gps?.lat) && Number.isFinite(gps?.lng);
const isNormalizedSnapshot = (raw) =>
  !!raw &&
  (Object.prototype.hasOwnProperty.call(raw, "runtimeSceneId") ||
    Object.prototype.hasOwnProperty.call(raw, "defaultSceneId") ||
    Object.prototype.hasOwnProperty.call(raw, "fusionLoc") ||
    Object.prototype.hasOwnProperty.call(raw, "vehicleInfo") ||
    Object.prototype.hasOwnProperty.call(raw, "infoCode") ||
    Object.prototype.hasOwnProperty.call(raw, "speedLimit"));

const createDefaultCode = () => ({
  code: 0,
  info: "",
  stamp: null,
});

const createDefaultFormation = (formationId = "") => ({
  formationId,
  formationName: formationId || "未命名编队",
  deviceIds: [],
  deviceCount: 0,
  onlineCount: 0,
  sceneId: "",
  description: "",
  color: "",
});

const createDefaultDevice = (deviceId, topic = "") => ({
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
  vehicleInfo: { controlMode: null, gear: null, speed: null, omega: null, soc: null },
  taskStatus: null,
  platformTaskStatus: null,
  infoCode: createDefaultCode(),
  warningCode: createDefaultCode(),
  errorCode: createDefaultCode(),
  speedLimit: { limit: null, slowdownTime: null, stamp: null, moduleName: "" },
  alerts: [],
  extra: {},
});

const normalizeCode = (rawCode) => ({
  code: toNumeric(rawCode?.code, 0) ?? 0,
  info: rawCode?.info || "",
  stamp: rawCode?.stamp ? toIsoString(rawCode.stamp) : null,
});

const normalizeFormation = (rawInput, existingFormation = null) => {
  const raw = rawInput && typeof rawInput === "object" ? rawInput : {};
  const formationId = String(raw.formationId || raw.id || existingFormation?.formationId || "");
  const base = createDefaultFormation(formationId);
  const deviceIds = Array.isArray(raw.deviceIds)
    ? raw.deviceIds.map((deviceId) => String(deviceId)).filter(Boolean)
    : existingFormation?.deviceIds || [];

  return {
    ...base,
    ...existingFormation,
    formationId,
    formationName: String(
      raw.formationName || raw.name || existingFormation?.formationName || formationId,
    ),
    deviceIds,
    deviceCount: Number.isFinite(Number(raw.deviceCount))
      ? Number(raw.deviceCount)
      : deviceIds.length,
    onlineCount: Number.isFinite(Number(raw.onlineCount))
      ? Number(raw.onlineCount)
      : existingFormation?.onlineCount || 0,
    sceneId: String(raw.sceneId || existingFormation?.sceneId || ""),
    description: String(raw.description || existingFormation?.description || ""),
    color: String(raw.color || existingFormation?.color || ""),
  };
};

const dedupeAlerts = (alerts) => {
  const deduped = new Map();
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

const buildCodeAlerts = (device) => {
  const items = [
    { severity: "notice", source: "info_code", payload: device.infoCode, title: "提示报码" },
    { severity: "warning", source: "warning_code", payload: device.warningCode, title: "预警报码" },
    { severity: "critical", source: "error_code", payload: device.errorCode, title: "告警报码" },
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

const buildRuleAlerts = (device) => {
  const alerts = [];
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

const normalizeDevice = (rawInput, topicHint = "", existingDevice = null) => {
  const raw =
    rawInput &&
    rawInput.payload &&
    typeof rawInput.payload === "object" &&
    !Array.isArray(rawInput.payload)
      ? { ...rawInput.payload, topic: rawInput.topic || rawInput.payload.topic }
      : rawInput;

  const topic = raw.topic || topicHint || existingDevice?.topic || "";
  const deviceId =
    raw.deviceId ||
    raw.id ||
    raw.device_id ||
    extractDeviceIdFromTopic(topic) ||
    existingDevice?.deviceId ||
    `device-${Date.now()}`;
  const base = createDefaultDevice(deviceId, topic || `/fleet/${deviceId}/vehicle_info`);

  const fusionLoc = raw.fusion_loc || raw.fusionLoc || {};
  const lidarLoc = raw.lidar_loc || raw.lidarLoc || {};
  const vehicleInfo = raw.vehicle_info || raw.vehicleInfo || {};
  const speedLimit = raw.speed_limit || raw.speedLimit || {};
  const gps = raw.gps || raw.location || {};
  const runtimeSceneId =
    raw.runtimeSceneId ||
    raw.scene_id ||
    raw.sceneId ||
    raw.scenePose?.sceneId ||
    existingDevice?.runtimeSceneId ||
    "";

  const normalizedDevice = {
    ...base,
    ...existingDevice,
    deviceId,
    deviceName:
      raw.deviceName || raw.device_name || raw.name || existingDevice?.deviceName || deviceId,
    topic: topic || existingDevice?.topic || base.topic,
    online: typeof raw.online === "boolean" ? raw.online : (existingDevice?.online ?? true),
    stamp: toIsoString(
      raw.stamp || raw.lastSeen || raw.timestamp || raw.time || existingDevice?.stamp || Date.now(),
    ),
    sceneId:
      raw.scene_id ||
      raw.sceneId ||
      raw.scenePose?.sceneId ||
      raw.runtimeSceneId ||
      existingDevice?.sceneId ||
      "",
    runtimeSceneId,
    defaultSceneId: raw.defaultSceneId || existingDevice?.defaultSceneId || "",
    mapProfile: raw.mapProfile || existingDevice?.mapProfile || "lanelet",
    gpsEnabled:
      typeof raw.gpsEnabled === "boolean" ? raw.gpsEnabled : (existingDevice?.gpsEnabled ?? true),
    rosMapEnabled:
      typeof raw.rosMapEnabled === "boolean"
        ? raw.rosMapEnabled
        : (existingDevice?.rosMapEnabled ?? true),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => String(tag)) : existingDevice?.tags || [],
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
      gear: toNumeric(vehicleInfo.gear, existingDevice?.vehicleInfo?.gear ?? null),
      speed: toNumeric(vehicleInfo.speed, existingDevice?.vehicleInfo?.speed ?? null),
      omega: toNumeric(vehicleInfo.omega, existingDevice?.vehicleInfo?.omega ?? null),
      soc: toNumeric(vehicleInfo.soc, existingDevice?.vehicleInfo?.soc ?? null),
    },
    taskStatus: toNumeric(
      raw.task_status ?? raw.taskStatus ?? raw.task?.status,
      existingDevice?.taskStatus ?? null,
    ),
    platformTaskStatus: toNumeric(
      raw.platform_task_status ?? raw.platformTaskStatus,
      existingDevice?.platformTaskStatus ?? null,
    ),
    infoCode: normalizeCode(raw.info_code || raw.infoCode || existingDevice?.infoCode),
    warningCode: normalizeCode(raw.warning_code || raw.warningCode || existingDevice?.warningCode),
    errorCode: normalizeCode(raw.error_code || raw.errorCode || existingDevice?.errorCode),
    speedLimit: {
      limit: toNumeric(speedLimit.limit, existingDevice?.speedLimit?.limit ?? null),
      slowdownTime: toNumeric(
        speedLimit.slowdown_time ?? speedLimit.slowdownTime,
        existingDevice?.speedLimit?.slowdownTime ?? null,
      ),
      stamp: speedLimit.stamp
        ? toIsoString(speedLimit.stamp)
        : (existingDevice?.speedLimit?.stamp ?? null),
      moduleName:
        speedLimit.module_name ||
        speedLimit.moduleName ||
        existingDevice?.speedLimit?.moduleName ||
        "",
    },
    alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
    extra: {
      ...(existingDevice?.extra || {}),
      ...(raw.extra || {}),
    },
  };

  if (!hasPose(normalizedDevice.fusionLoc) && hasPose(normalizedDevice.lidarLoc)) {
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

const mergeDevice = (existingDevice, incomingDevice) => {
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
    formationIds: Array.isArray(incomingDevice.formationIds)
      ? [...incomingDevice.formationIds]
      : [...(existingDevice.formationIds || [])],
  };
};

const mergeBounds = (baseBounds, overrideBounds, definition) =>
  overrideBounds ||
  baseBounds || {
    minX: definition.origin?.x || 0,
    maxX: (definition.origin?.x || 0) + (definition.width || 1000) * (definition.resolution || 0.1),
    minY: definition.origin?.y || 0,
    maxY: (definition.origin?.y || 0) + (definition.height || 620) * (definition.resolution || 0.1),
  };

const mergeSceneDefinitionParts = (base = {}, override = {}) => ({
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

const normalizePathPoint = (point) => {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return null;
  }
  return {
    x: round(point.x, 3),
    y: round(point.y, 3),
  };
};

const pointsAreNear = (left, right, epsilon = 0.05) =>
  Number.isFinite(left?.x) &&
  Number.isFinite(left?.y) &&
  Number.isFinite(right?.x) &&
  Number.isFinite(right?.y) &&
  Math.hypot(left.x - right.x, left.y - right.y) <= epsilon;

// Movement history ("trails"): how many recent points to keep per device, and
// the minimum world-space distance (m) a device must move before a new point
// is recorded — keeps trails compact and avoids jitter noise.
const TRAIL_MAX_POINTS = 240;
const TRAIL_MIN_DISTANCE = 0.12;

const pickTrailPose = (device) => {
  if (Number.isFinite(device?.fusionLoc?.x) && Number.isFinite(device?.fusionLoc?.y)) {
    return device.fusionLoc;
  }
  if (Number.isFinite(device?.lidarLoc?.x) && Number.isFinite(device?.lidarLoc?.y)) {
    return device.lidarLoc;
  }
  return null;
};

export function useDashboard() {
  const state = reactive({
    fleetName: fallbackFleetPayload.fleetName,
    topicPattern: fallbackFleetPayload.topicPattern,
    devicesById: {},
    formationsById: {},
    selectedDeviceId: "",
    selectedFormationId: "",
    selectedMapMode: "gps",
    lastSource: "bootstrap",
    lastUpdateAt: null,
    initialMockPayload: cloneValue(fallbackFleetPayload),
    sceneDefinitions: cloneValue(sceneCatalog),
    pendingSceneLoads: {},
    pathsByDeviceId: {},
    isPathEditMode: false,
    trailsByDeviceId: {},
    realtime: {
      apiReady: false,
      wsReady: false,
      ws: null,
      reconnectAttempts: 0,
    },
  });

  const getSceneDefinition = (sceneId) => {
    if (!sceneId) {
      return null;
    }
    return state.sceneDefinitions[sceneId] || sceneCatalog[sceneId] || null;
  };

  const mergeSceneDefinition = (definition) => {
    if (!definition?.sceneId) {
      return;
    }
    const fallback = sceneCatalog[definition.sceneId] || {};
    state.sceneDefinitions[definition.sceneId] = mergeSceneDefinitionParts(fallback, definition);
  };

  const normalizePayload = (input) => {
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

    if (Array.isArray(input.devices)) {
      return {
        replace: true,
        fleetName: input.fleetName || state.fleetName,
        topicPattern: input.topicPattern || state.topicPattern,
        devices: input.devices.map((item) => normalizeDevice(item)),
        formations: Array.isArray(input.formations)
          ? input.formations.map((item) => normalizeFormation(item))
          : null,
      };
    }

    if (input.topic && input.payload !== undefined) {
      const payloadBody =
        typeof input.payload === "string" ? JSON.parse(input.payload) : input.payload;
      const existing =
        state.devicesById[payloadBody.deviceId || extractDeviceIdFromTopic(input.topic)];
      return {
        replace: false,
        fleetName: state.fleetName,
        topicPattern: state.topicPattern,
        devices: [normalizeDevice(payloadBody, input.topic, existing)],
        formations: Array.isArray(payloadBody.formations)
          ? payloadBody.formations.map((item) => normalizeFormation(item))
          : null,
      };
    }

    const existing = state.devicesById[input.deviceId || extractDeviceIdFromTopic(input.topic)];
    return {
      replace: false,
      fleetName: input.fleetName || state.fleetName,
      topicPattern: input.topicPattern || state.topicPattern,
      devices: [normalizeDevice(input, input.topic, existing)],
      formations: Array.isArray(input.formations)
        ? input.formations.map((item) => normalizeFormation(item))
        : null,
    };
  };

  const devices = computed(() => Object.values(state.devicesById));
  const formations = computed(() =>
    Object.values(state.formationsById).map((formation) => {
      const memberDevices = (formation.deviceIds || [])
        .map((deviceId) => state.devicesById[deviceId])
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

  const getDeviceTone = (device) => {
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

  const sortedDevices = computed(() =>
    [...devices.value].sort((left, right) => {
      const toneWeight = { critical: 0, warning: 1, notice: 2, normal: 3, offline: 4 };
      const leftTone = getDeviceTone(left);
      const rightTone = getDeviceTone(right);
      if (toneWeight[leftTone] !== toneWeight[rightTone]) {
        return toneWeight[leftTone] - toneWeight[rightTone];
      }
      return toTimestampMs(right.stamp) - toTimestampMs(left.stamp);
    }),
  );

  const sortedFormations = computed(() =>
    [...formations.value].sort((left, right) => {
      if (right.onlineCount !== left.onlineCount) {
        return right.onlineCount - left.onlineCount;
      }
      return left.formationName.localeCompare(right.formationName, "zh-CN");
    }),
  );

  const selectedDevice = computed(() => state.devicesById[state.selectedDeviceId] || null);
  const selectedFormation = computed(() => state.formationsById[state.selectedFormationId] || null);

  const filteredDevices = computed(() => {
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

  const groupedAlerts = computed(() => {
    const grouped = { critical: [], warning: [], notice: [] };
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

  const sceneDevices = computed(() => {
    if (!selectedFormation.value) {
      return [];
    }
    const currentSceneId = formationSceneId.value;
    const formationDeviceIds = new Set(selectedFormation.value.deviceIds || []);
    return sortedDevices.value.filter(
      (device) =>
        formationDeviceIds.has(device.deviceId) &&
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

  const primeSceneDefinitions = (list) => {
    list.forEach((device) => {
      if (device.sceneId && !getSceneDefinition(device.sceneId)) {
        void loadSceneDefinition(device.sceneId);
      }
    });
  };

  const recordTrails = (incomingDevices, mergedById, replace) => {
    const nextTrails = { ...state.trailsByDeviceId };
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

  const ingestPayload = (rawPayload, source) => {
    const normalized = normalizePayload(rawPayload);
    const nextDevicesById = normalized.replace ? {} : { ...state.devicesById };

    normalized.devices.forEach((device) => {
      const existingDevice = state.devicesById[device.deviceId];
      nextDevicesById[device.deviceId] = mergeDevice(existingDevice, device);
    });

    if (normalized.formations) {
      const nextFormationsById = {};
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

  const getPlannedPath = (deviceId = state.selectedDeviceId) =>
    cloneValue(state.pathsByDeviceId[deviceId] || []);

  const setPlannedPath = (deviceId, points) => {
    if (!deviceId) {
      return [];
    }
    const sanitized = (Array.isArray(points) ? points : [])
      .map(normalizePathPoint)
      .filter(Boolean)
      .filter((point, index, list) => index === 0 || !pointsAreNear(point, list[index - 1]));
    state.pathsByDeviceId = {
      ...state.pathsByDeviceId,
      [deviceId]: sanitized,
    };
    return sanitized;
  };

  const addPlannedPathPoint = (deviceId, point) => {
    const normalizedPoint = normalizePathPoint(point);
    if (!deviceId || !normalizedPoint) {
      return getPlannedPath(deviceId);
    }
    const existing = state.pathsByDeviceId[deviceId] || [];
    if (existing.length && pointsAreNear(existing[existing.length - 1], normalizedPoint)) {
      return getPlannedPath(deviceId);
    }
    return setPlannedPath(deviceId, [...existing, normalizedPoint]);
  };

  const undoPlannedPathPoint = (deviceId = state.selectedDeviceId) => {
    if (!deviceId) {
      return [];
    }
    const existing = state.pathsByDeviceId[deviceId] || [];
    return setPlannedPath(deviceId, existing.slice(0, -1));
  };

  const clearPlannedPath = (deviceId = state.selectedDeviceId) => {
    if (!deviceId) {
      return [];
    }
    return setPlannedPath(deviceId, []);
  };

  const setPathEditMode = (active) => {
    state.isPathEditMode = Boolean(active);
  };

  const togglePathEditMode = () => {
    state.isPathEditMode = !state.isPathEditMode;
  };

  const trailsByDeviceId = computed(() => state.trailsByDeviceId);

  const clearTrail = (deviceId = state.selectedDeviceId) => {
    if (!deviceId || !state.trailsByDeviceId[deviceId]) {
      return;
    }
    const next = { ...state.trailsByDeviceId };
    delete next[deviceId];
    state.trailsByDeviceId = next;
  };

  const clearAllTrails = () => {
    state.trailsByDeviceId = {};
  };

  const selectDevice = (deviceId, options = {}) => {
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
    state.isPathEditMode = false;
  };

  const selectFormation = (formationId) => {
    if (!state.formationsById[formationId]) {
      return;
    }
    state.selectedFormationId = formationId;
    state.selectedMapMode = "scene";
    state.isPathEditMode = false;
    ensureSelectedDevice();
  };

  const clearFormationSelection = () => {
    state.selectedFormationId = "";
    ensureSelectedDevice();
  };

  const setMapMode = (mode) => {
    state.selectedMapMode = mode;
    if (mode !== "scene") {
      state.isPathEditMode = false;
    }
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

  let wsReconnectTimer = null;
  let wsHeartbeatTimer = null;
  let wsPongTimer = null;
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

  const startHeartbeat = (ws) => {
    wsHeartbeatTimer = window.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch (_error) {
        return;
      }
      if (wsPongTimer) {
        window.clearTimeout(wsPongTimer);
      }
      wsPongTimer = window.setTimeout(() => {
        // No pong in time — assume the socket is dead and force a reconnect.
        try {
          ws.close();
        } catch (_error) {
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
    let ws;
    try {
      ws = new WebSocket(resolveWebSocketUrl());
    } catch (_error) {
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
      } catch (_error) {
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
      } catch (_error) {
        // ignore
      }
    }
    state.realtime.ws = null;
    state.realtime.wsReady = false;
    state.realtime.reconnectAttempts = 0;
  };

  const loadSceneDefinition = async (sceneId) => {
    if (!sceneId || state.pendingSceneLoads[sceneId]) {
      return;
    }
    state.pendingSceneLoads[sceneId] = true;
    try {
      const response = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      mergeSceneDefinition(await response.json());
    } catch (_error) {
      // Keep local fallback.
    } finally {
      delete state.pendingSceneLoads[sceneId];
    }
  };

  const loadSceneCatalogFromBackend = async () => {
    try {
      const response = await fetch("/api/scenes", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      (payload.items || []).forEach(mergeSceneDefinition);
      return true;
    } catch (_error) {
      return false;
    }
  };

  const bootstrapFromBackend = async () => {
    try {
      await loadSceneCatalogFromBackend();
      const response = await fetch("/api/fleet/snapshot", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      state.realtime.apiReady = true;
      state.initialMockPayload = cloneValue(payload);
      ingestPayload(payload, "api");
      connectRealtime();
      return true;
    } catch (_error) {
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
    state.initialMockPayload = payload;
    ingestPayload(payload, "bootstrap");
  };

  const retryBootstrap = async () => {
    const ready = await bootstrapFromBackend();
    if (!ready) {
      await bootstrapEmptyState();
    }
    return ready;
  };

  const bootstrap = async () => {
    const backendReady = await bootstrapFromBackend();
    if (!backendReady) {
      await bootstrapEmptyState();
    }
  };

  const registerWindowApi = () => {
    window.vehicleDashboard = {
      updateFromPayload(payload) {
        const normalizedPayload = typeof payload === "string" ? JSON.parse(payload) : payload;
        ingestPayload(normalizedPayload, "mqtt");
      },
      selectDevice,
      selectFormation,
      clearFormationSelection,
      getSnapshot() {
        return cloneValue(toRaw(buildFleetSnapshot()));
      },
      getPlannedPath(deviceId) {
        return getPlannedPath(deviceId);
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
    sceneDevices,
    formationSceneId,
    hasGps,
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
    getPlannedPath,
    setPlannedPath,
    addPlannedPathPoint,
    undoPlannedPathPoint,
    clearPlannedPath,
    setPathEditMode,
    togglePathEditMode,
    trailsByDeviceId,
    clearTrail,
    clearAllTrails,
    retryBootstrap,
    disconnectRealtime,
  };
}
