const sceneCatalog = {};

const fallbackFleetPayload = {
  fleetName: "多车监控平台",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  updatedAt: "",
  devices: [],
};

const controlModeMap = {
  0: { label: "寰呭懡 / 浜哄伐", description: "褰撳墠鏈繘鍏ヨ嚜鍔ㄦ帶鍒? },
  1: { label: "鑷姩椹鹃┒", description: "杞﹁締鐢辨帶鍒跺櫒鑷姩鎺ョ" },
  2: { label: "閬ユ帶鎺ョ", description: "褰撳墠澶勪簬杩滅▼鎺ョ鐘舵€? },
  3: { label: "绱ф€ュ仠姝?, description: "鎺у埗鍣ㄨЕ鍙戜簡瀹夊叏淇濇姢" },
};

const gearMap = {
  "-1": { label: "R", description: "鍊掓尅" },
  0: { label: "N", description: "绌烘尅 / 鏈煡" },
  1: { label: "D", description: "鍓嶈繘鎸? },
  2: { label: "P", description: "椹昏溅鎸? },
};

const taskStatusMap = {
  0: { label: "绌洪棽", description: "褰撳墠娌℃湁姝ｅ湪鎵ц鐨勪换鍔? },
  1: { label: "鎵ц涓?, description: "浠诲姟姝ｅ湪姝ｅ父鎺ㄨ繘" },
  2: { label: "宸插畬鎴?, description: "浠诲姟宸插畬鎴愶紝绛夊緟涓嬩竴娆¤皟搴? },
  3: { label: "寮傚父涓柇", description: "浠诲姟琚敊璇垨鍛婅涓柇" },
  4: { label: "鍏呯數涓?, description: "璁惧姝ｅ湪琛ヨ兘鎴栫瓑寰呰ˉ鑳? },
};

const state = {
  fleetName: fallbackFleetPayload.fleetName,
  topicPattern: fallbackFleetPayload.topicPattern,
  devices: new Map(),
  sceneTrails: {},
  selectedDeviceId: "",
  selectedMapMode: "gps",
  lastSource: "bootstrap",
  lastUpdateAt: null,
  lastRawPayload: cloneValue(fallbackFleetPayload),
  initialMockPayload: cloneValue(fallbackFleetPayload),
  sceneDefinitions: cloneValue(sceneCatalog),
  pendingSceneLoads: {},
  realtime: {
    apiReady: false,
    wsReady: false,
    ws: null,
  },
};

const elements = {
  connectionChip: document.getElementById("connectionChip"),
  onlineCount: document.getElementById("onlineCount"),
  sceneCoverage: document.getElementById("sceneCoverage"),
  alertTotal: document.getElementById("alertTotal"),
  focusDeviceName: document.getElementById("focusDeviceName"),
  focusDeviceHint: document.getElementById("focusDeviceHint"),
  lastUpdate: document.getElementById("lastUpdate"),
  deviceCount: document.getElementById("deviceCount"),
  deviceList: document.getElementById("deviceList"),
  gpsTabBtn: document.getElementById("gpsTabBtn"),
  sceneTabBtn: document.getElementById("sceneTabBtn"),
  gpsProviderBadge: document.getElementById("gpsProviderBadge"),
  gpsMap: document.getElementById("gpsMap"),
  gpsBackdrop: document.getElementById("gpsBackdrop"),
  gpsMarkerLayer: document.getElementById("gpsMarkerLayer"),
  gpsLabelLayer: document.getElementById("gpsLabelLayer"),
  sceneMap: document.getElementById("sceneMap"),
  sceneZoneLayer: document.getElementById("sceneZoneLayer"),
  sceneMarkerLayer: document.getElementById("sceneMarkerLayer"),
  sceneLabelLayer: document.getElementById("sceneLabelLayer"),
  sceneTrail: document.getElementById("sceneTrail"),
  mapEmptyState: document.getElementById("mapEmptyState"),
  mapEmptyTitle: document.getElementById("mapEmptyTitle"),
  mapEmptyCopy: document.getElementById("mapEmptyCopy"),
  mapFocusName: document.getElementById("mapFocusName"),
  mapFocusMeta: document.getElementById("mapFocusMeta"),
  clearTrailBtn: document.getElementById("clearTrailBtn"),
  selectedDeviceName: document.getElementById("selectedDeviceName"),
  selectedDeviceStatus: document.getElementById("selectedDeviceStatus"),
  selectedDevicePill: document.getElementById("selectedDevicePill"),
  controlModeValue: document.getElementById("controlModeValue"),
  controlModeDesc: document.getElementById("controlModeDesc"),
  gearValue: document.getElementById("gearValue"),
  gearDesc: document.getElementById("gearDesc"),
  speedValue: document.getElementById("speedValue"),
  speedDesc: document.getElementById("speedDesc"),
  omegaValue: document.getElementById("omegaValue"),
  omegaDesc: document.getElementById("omegaDesc"),
  socValue: document.getElementById("socValue"),
  socDesc: document.getElementById("socDesc"),
  taskStatusValue: document.getElementById("taskStatusValue"),
  taskStatusDesc: document.getElementById("taskStatusDesc"),
  gpsValue: document.getElementById("gpsValue"),
  gpsDesc: document.getElementById("gpsDesc"),
  sceneValue: document.getElementById("sceneValue"),
  sceneDesc: document.getElementById("sceneDesc"),
  extraValue: document.getElementById("extraValue"),
  extraDesc: document.getElementById("extraDesc"),
  selectedAlertCount: document.getElementById("selectedAlertCount"),
  criticalCount: document.getElementById("criticalCount"),
  warningCount: document.getElementById("warningCount"),
  noticeCount: document.getElementById("noticeCount"),
  criticalList: document.getElementById("criticalList"),
  warningList: document.getElementById("warningList"),
  noticeList: document.getElementById("noticeList"),
  jsonInput: document.getElementById("jsonInput"),
  rawPayload: document.getElementById("rawPayload"),
  applyJsonBtn: document.getElementById("applyJsonBtn"),
  simulateBtn: document.getElementById("simulateBtn"),
  resetMockBtn: document.getElementById("resetMockBtn"),
};

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function round(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumeric(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toTimestampMs(value) {
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
}

function toIsoString(value) {
  return new Date(toTimestampMs(value)).toISOString();
}

function formatDateTime(value) {
  return new Date(toTimestampMs(value)).toLocaleString("zh-CN", { hour12: false });
}

function extractDeviceIdFromTopic(topic) {
  const match = String(topic || "").match(/^\/fleet\/([^/]+)\//);
  return match?.[1] || "";
}

function controlModeInfo(value) {
  return controlModeMap[value] || {
    label: String(value),
    description: "鏈槧灏勭殑鎺у埗妯″紡缂栫爜",
  };
}

function gearInfo(value) {
  return gearMap[String(value)] || {
    label: String(value),
    description: "鏈槧灏勭殑鎸′綅缂栫爜",
  };
}

function taskStatusInfo(value) {
  return taskStatusMap[value] || {
    label: String(value),
    description: "鏈槧灏勭殑浠诲姟鐘舵€佺紪鐮?,
  };
}

function normalizeSeverity(value) {
  const normalized = String(value || "").toLowerCase();
  if (
    normalized.includes("critical") ||
    normalized.includes("danger") ||
    normalized.includes("fatal") ||
    normalized.includes("error") ||
    normalized.includes("涓ラ噸")
  ) {
    return "critical";
  }
  if (normalized.includes("warn") || normalized.includes("棰勮") || normalized.includes("鍏虫敞") || normalized.includes("low")) {
    return "warning";
  }
  return "notice";
}

function getSeverityText(value) {
  return {
    critical: "涓ラ噸",
    warning: "棰勮",
    notice: "鎻愮ず",
  }[value] || "鎻愮ず";
}

function hasGps(gps) {
  return Number.isFinite(gps?.lat) && Number.isFinite(gps?.lng);
}

function hasScene(scene) {
  return Boolean(scene?.sceneId) && Number.isFinite(scene?.x) && Number.isFinite(scene?.y);
}

function createDefaultDevice(deviceId) {
  return {
    deviceId,
    deviceName: deviceId ? `鏅鸿兘杞?${deviceId}` : "鏈懡鍚嶈澶?,
    topic: deviceId ? `/fleet/${deviceId}/vehicle_info` : "",
    online: true,
    lastSeen: new Date().toISOString(),
    gps: { lat: null, lng: null, heading: 0 },
    scene: { sceneId: "", sceneName: "", mapFrame: "map", x: null, y: null, yaw: 0 },
    vehicle: { controlMode: 0, gear: 0, speed: 0, omega: 0, soc: 0 },
    task: { status: 0, name: "寰呭懡" },
    alerts: [],
    extra: {},
  };
}

function pushAlertRecord(target, item, defaultSeverity, defaultSource, fallbackTs, fallbackTitle) {
  if (!item) {
    return;
  }
  if (Array.isArray(item)) {
    item.forEach((entry, index) => {
      pushAlertRecord(target, entry, defaultSeverity, defaultSource, fallbackTs, `${fallbackTitle || "璁惧鍛婅"} ${index + 1}`);
    });
    return;
  }
  if (typeof item === "string") {
    target.push({
      title: fallbackTitle || "璁惧鍛婅",
      detail: item,
      severity: defaultSeverity,
      source: defaultSource,
      ts: fallbackTs,
    });
    return;
  }
  if (typeof item !== "object") {
    return;
  }
  if (item.title || item.message || item.detail || item.code) {
    target.push({
      id: item.id || item.code || fallbackTitle || `alert-${target.length + 1}`,
      title: item.title || item.code || fallbackTitle || "璁惧鍛婅",
      detail: item.message || item.detail || item.description || JSON.stringify(item),
      severity: normalizeSeverity(item.severity || item.level || defaultSeverity),
      source: item.source || item.module || defaultSource,
      ts: toIsoString(item.ts || item.timestamp || item.time || fallbackTs),
    });
    return;
  }
  Object.entries(item).forEach(([key, value]) => {
    pushAlertRecord(target, value, defaultSeverity, defaultSource, fallbackTs, key);
  });
}

function normalizeAlerts(raw, normalizedDevice) {
  const explicitAlerts = [];
  const fallbackTs = raw.lastSeen || raw.ts || raw.timestamp || raw.stamp || Date.now();

  pushAlertRecord(explicitAlerts, raw.alerts, "notice", "璁惧涓婃姤", fallbackTs);
  pushAlertRecord(explicitAlerts, raw.errors, "critical", "璁惧涓婃姤", fallbackTs, "閿欒");
  pushAlertRecord(explicitAlerts, raw.faults, "critical", "璁惧涓婃姤", fallbackTs, "鏁呴殰");
  pushAlertRecord(explicitAlerts, raw.alarm_list || raw.alarmList, "warning", "璁惧涓婃姤", fallbackTs, "鍛婅");
  pushAlertRecord(explicitAlerts, raw.error_info, "warning", "璁惧涓婃姤", fallbackTs, "閿欒淇℃伅");
  pushAlertRecord(explicitAlerts, raw.vehicle_info?.errors, "critical", "杞﹀喌涓婃姤", fallbackTs, "杞﹀喌寮傚父");

  const derivedAlerts = [];

  if (normalizedDevice.task.status === 3) {
    derivedAlerts.push({
      id: "task-fault",
      title: "浠诲姟寮傚父涓柇",
      detail: "浠诲姟鐘舵€佷负寮傚父涓柇锛岃妫€鏌ヨ鍒掑櫒銆佹帶鍒跺櫒鎴栬矾渚х姸鎬併€?,
      severity: "critical",
      source: "瑙勫垯鎺ㄦ柇",
      ts: toIsoString(fallbackTs),
    });
  }
  if (normalizedDevice.vehicle.soc > 0 && normalizedDevice.vehicle.soc < 20) {
    derivedAlerts.push({
      id: "low-soc",
      title: "浣庣數閲忛璀?,
      detail: `SOC ${round(normalizedDevice.vehicle.soc, 1)}%锛屽缓璁畨鎺掑洖鍏呫€俙,
      severity: "warning",
      source: "瑙勫垯鎺ㄦ柇",
      ts: toIsoString(fallbackTs),
    });
  }
  if (!normalizedDevice.online) {
    derivedAlerts.push({
      id: "device-offline",
      title: "璁惧绂荤嚎",
      detail: "鏈€杩戜竴娈垫椂闂存湭鏀跺埌鏂扮殑閬ユ祴鍖咃紝璇锋鏌ュ叕缃戦摼璺垨杞︾鐢垫簮銆?,
      severity: "critical",
      source: "閾捐矾鐩戞祴",
      ts: toIsoString(fallbackTs),
    });
  }
  if (!hasGps(normalizedDevice.gps)) {
    derivedAlerts.push({
      id: "gps-missing",
      title: "GPS 缂哄け",
      detail: "褰撳墠娑堟伅鏈彁渚涘彲鐢?GPS锛岀粡绾害瑙嗗浘鏃犳硶瀹氫綅璇ヨ澶囥€?,
      severity: "notice",
      source: "鎺ュ叆鏈嶅姟",
      ts: toIsoString(fallbackTs),
    });
  }
  if (!hasScene(normalizedDevice.scene)) {
    derivedAlerts.push({
      id: "scene-missing",
      title: "ROS 鍦烘櫙瀹氫綅缂哄け",
      detail: "褰撳墠璁惧灏氭湭涓婁紶 ROS 鍦板浘浣嶅Э銆?,
      severity: "notice",
      source: "鎺ュ叆鏈嶅姟",
      ts: toIsoString(fallbackTs),
    });
  }

  const allAlerts = [...explicitAlerts, ...derivedAlerts].map((alert, index) => ({
    id: alert.id || `${normalizedDevice.deviceId}-alert-${index + 1}`,
    title: alert.title || `璁惧鍛婅 ${index + 1}`,
    detail: alert.detail || "",
    severity: normalizeSeverity(alert.severity),
    source: alert.source || "璁惧涓婃姤",
    ts: toIsoString(alert.ts || fallbackTs),
  }));

  const deduplicated = [];
  const seenKeys = new Set();
  allAlerts.forEach((alert) => {
    const key = `${alert.id}|${alert.title}|${alert.detail}|${alert.severity}`;
    if (seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    deduplicated.push(alert);
  });

  return deduplicated.sort((left, right) => toTimestampMs(right.ts) - toTimestampMs(left.ts));
}

function getSceneDefinition(sceneId) {
  if (!sceneId) {
    return null;
  }
  return state.sceneDefinitions[sceneId] || sceneCatalog[sceneId] || null;
}

function normalizeDevice(rawInput, topicHint = "", existingDevice = null) {
  const raw =
    rawInput && rawInput.payload && typeof rawInput.payload === "object" && !Array.isArray(rawInput.payload)
      ? { ...rawInput.payload, topic: rawInput.topic || rawInput.payload.topic }
      : rawInput;

  const topic = raw.topic || topicHint || existingDevice?.topic || "";
  const deviceId = raw.deviceId || raw.id || raw.device_id || extractDeviceIdFromTopic(topic) || existingDevice?.deviceId || `device-${Date.now()}`;
  const base = createDefaultDevice(deviceId);
  const fusionLoc = raw.fusion_loc || raw.fusionLoc || {};
  const rawScene = raw.scenePose || raw.scene || {};
  const sceneId =
    rawScene.sceneId ||
    raw.sceneId ||
    raw.scene_id ||
    existingDevice?.scene.sceneId ||
    (Number.isFinite(toNumeric(fusionLoc.x)) && Number.isFinite(toNumeric(fusionLoc.y)) ? "warehouse-a" : "");
  const sceneDefinition = getSceneDefinition(sceneId);
  const sceneName =
    rawScene.sceneName ||
    raw.sceneName ||
    raw.scene_name ||
    sceneDefinition?.sceneName ||
    existingDevice?.scene.sceneName ||
    "";

  const normalizedDevice = {
    ...base,
    ...existingDevice,
    deviceId,
    deviceName: raw.deviceName || raw.device_name || raw.name || existingDevice?.deviceName || `鏅鸿兘杞?${deviceId}`,
    topic: topic || `/fleet/${deviceId}/vehicle_info`,
    online: typeof raw.online === "boolean" ? raw.online : existingDevice?.online ?? true,
    lastSeen: toIsoString(raw.lastSeen || raw.last_seen || raw.ts || raw.timestamp || raw.time || raw.stamp || existingDevice?.lastSeen || Date.now()),
    gps: {
      lat: toNumeric(raw.gps?.lat ?? raw.location?.lat ?? raw.latitude ?? raw.gps_lat ?? raw.lat, existingDevice?.gps.lat ?? null),
      lng: toNumeric(raw.gps?.lng ?? raw.location?.lng ?? raw.longitude ?? raw.gps_lng ?? raw.lng, existingDevice?.gps.lng ?? null),
      heading: toNumeric(raw.gps?.heading ?? raw.heading ?? raw.gps?.yaw ?? existingDevice?.gps.heading ?? 0, 0),
    },
    scene: {
      sceneId,
      sceneName,
      mapFrame: rawScene.mapFrame || raw.mapFrame || existingDevice?.scene.mapFrame || sceneDefinition?.mapFrame || "map",
      x: toNumeric(rawScene.x ?? raw.x ?? fusionLoc.x, existingDevice?.scene.x ?? null),
      y: toNumeric(rawScene.y ?? raw.y ?? fusionLoc.y, existingDevice?.scene.y ?? null),
      yaw: toNumeric(rawScene.yaw ?? raw.yaw ?? fusionLoc.yaw ?? existingDevice?.scene.yaw ?? 0, 0),
    },
    vehicle: {
      controlMode: toNumeric(raw.vehicle?.controlMode ?? raw.vehicle_info?.control_mode ?? existingDevice?.vehicle.controlMode ?? 0, 0),
      gear: toNumeric(raw.vehicle?.gear ?? raw.vehicle_info?.gear ?? existingDevice?.vehicle.gear ?? 0, 0),
      speed: toNumeric(raw.vehicle?.speed ?? raw.vehicle_info?.speed ?? existingDevice?.vehicle.speed ?? 0, 0),
      omega: toNumeric(raw.vehicle?.omega ?? raw.vehicle_info?.omega ?? existingDevice?.vehicle.omega ?? 0, 0),
      soc: toNumeric(raw.vehicle?.soc ?? raw.vehicle_info?.soc ?? existingDevice?.vehicle.soc ?? 0, 0),
    },
    task: {
      status: toNumeric(raw.task?.status ?? raw.task_status ?? existingDevice?.task.status ?? 0, 0),
      name: raw.task?.name || raw.task_name || existingDevice?.task.name || taskStatusInfo(toNumeric(raw.task?.status ?? raw.task_status ?? existingDevice?.task.status ?? 0, 0)).label,
    },
    extra: {
      ...(existingDevice?.extra || {}),
      ...(raw.extra || {}),
    },
  };

  if (raw.temperature !== undefined) {
    normalizedDevice.extra.temperature = raw.temperature;
  }
  if (raw.networkQuality !== undefined) {
    normalizedDevice.extra.networkQuality = raw.networkQuality;
  }

  normalizedDevice.alerts = normalizeAlerts(raw, normalizedDevice);
  return normalizedDevice;
}

function mergeDevice(existingDevice, incomingDevice) {
  if (!existingDevice) {
    return incomingDevice;
  }
  return {
    ...existingDevice,
    ...incomingDevice,
    gps: { ...existingDevice.gps, ...incomingDevice.gps },
    scene: { ...existingDevice.scene, ...incomingDevice.scene },
    vehicle: { ...existingDevice.vehicle, ...incomingDevice.vehicle },
    task: { ...existingDevice.task, ...incomingDevice.task },
    extra: { ...existingDevice.extra, ...incomingDevice.extra },
    alerts: incomingDevice.alerts,
  };
}

function normalizePayload(input) {
  if (!input || typeof input !== "object") {
    throw new Error("娑堟伅蹇呴』鏄?JSON 瀵硅薄");
  }
  if (Array.isArray(input)) {
    return {
      replace: true,
      fleetName: state.fleetName,
      topicPattern: state.topicPattern,
      devices: input.map((item) => normalizeDevice(item)),
    };
  }
  if (Array.isArray(input.devices)) {
    return {
      replace: true,
      fleetName: input.fleetName || state.fleetName,
      topicPattern: input.topicPattern || state.topicPattern,
      devices: input.devices.map((item) => normalizeDevice(item)),
    };
  }
  if (input.device && typeof input.device === "object") {
    const existing = state.devices.get(input.device.deviceId || extractDeviceIdFromTopic(input.topic));
    return {
      replace: false,
      fleetName: state.fleetName,
      topicPattern: state.topicPattern,
      devices: [normalizeDevice(input.device, input.topic, existing)],
    };
  }
  if (input.topic && input.payload !== undefined) {
    const payloadBody = typeof input.payload === "string" ? JSON.parse(input.payload) : input.payload;
    if (payloadBody && Array.isArray(payloadBody.devices)) {
      return {
        replace: true,
        fleetName: payloadBody.fleetName || state.fleetName,
        topicPattern: payloadBody.topicPattern || state.topicPattern,
        devices: payloadBody.devices.map((item) => normalizeDevice(item)),
      };
    }
    const existing = state.devices.get(payloadBody.deviceId || extractDeviceIdFromTopic(input.topic));
    return {
      replace: false,
      fleetName: state.fleetName,
      topicPattern: state.topicPattern,
      devices: [normalizeDevice(payloadBody, input.topic, existing)],
    };
  }

  const existing = state.devices.get(input.deviceId || extractDeviceIdFromTopic(input.topic));
  return {
    replace: false,
    fleetName: state.fleetName,
    topicPattern: state.topicPattern,
    devices: [normalizeDevice(input, input.topic, existing)],
  };
}

function getDevices() {
  return Array.from(state.devices.values());
}

function getSelectedDevice() {
  return state.devices.get(state.selectedDeviceId) || null;
}

function mergeSceneDefinition(definition) {
  if (!definition?.sceneId) {
    return;
  }
  const fallback = sceneCatalog[definition.sceneId] || {};
  state.sceneDefinitions[definition.sceneId] = {
    ...fallback,
    ...definition,
    bounds:
      definition.bounds ||
      fallback.bounds || {
        minX: definition.origin?.x || 0,
        maxX: (definition.origin?.x || 0) + (definition.width || 1000) * (definition.resolution || 0.1),
        minY: definition.origin?.y || 0,
        maxY: (definition.origin?.y || 0) + (definition.height || 620) * (definition.resolution || 0.1),
      },
  };
}

async function loadSceneDefinition(sceneId) {
  if (!sceneId || state.pendingSceneLoads[sceneId]) {
    return;
  }
  state.pendingSceneLoads[sceneId] = true;
  try {
    const response = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    mergeSceneDefinition(await response.json());
    render(false);
  } catch (_error) {
    // Keep local fallback.
  } finally {
    delete state.pendingSceneLoads[sceneId];
  }
}

function getDeviceTone(device) {
  if (!device.online) {
    return "offline";
  }
  if (device.alerts.some((alert) => alert.severity === "critical")) {
    return "critical";
  }
  if (device.alerts.some((alert) => alert.severity === "warning")) {
    return "warning";
  }
  return "normal";
}

function sortDevices(left, right) {
  const toneWeight = {
    critical: 0,
    warning: 1,
    normal: 2,
    offline: 3,
  };
  const leftTone = getDeviceTone(left);
  const rightTone = getDeviceTone(right);
  if (toneWeight[leftTone] !== toneWeight[rightTone]) {
    return toneWeight[leftTone] - toneWeight[rightTone];
  }
  if (left.online !== right.online) {
    return Number(right.online) - Number(left.online);
  }
  return toTimestampMs(right.lastSeen) - toTimestampMs(left.lastSeen);
}

function updateSceneTrail(device) {
  if (!hasScene(device.scene)) {
    return;
  }
  const trail = state.sceneTrails[device.deviceId] || [];
  const lastPoint = trail[trail.length - 1];
  if (lastPoint && lastPoint.sceneId !== device.scene.sceneId) {
    state.sceneTrails[device.deviceId] = [];
  }
  const nextTrail = state.sceneTrails[device.deviceId] || [];
  const shouldAppend =
    !nextTrail.length ||
    Math.hypot((nextTrail[nextTrail.length - 1].x || 0) - device.scene.x, (nextTrail[nextTrail.length - 1].y || 0) - device.scene.y) > 0.4;

  if (shouldAppend) {
    nextTrail.push({
      sceneId: device.scene.sceneId,
      x: device.scene.x,
      y: device.scene.y,
      yaw: device.scene.yaw,
    });
  }
  if (nextTrail.length > 20) {
    nextTrail.splice(0, nextTrail.length - 20);
  }
  state.sceneTrails[device.deviceId] = nextTrail;
}

function ensureSelectedDevice() {
  if (state.selectedDeviceId && state.devices.has(state.selectedDeviceId)) {
    return;
  }
  const orderedDevices = getDevices().sort(sortDevices);
  const preferred = orderedDevices.find((device) => device.online) || orderedDevices[0];
  state.selectedDeviceId = preferred ? preferred.deviceId : "";
}

function buildFleetSnapshot() {
  return {
    fleetName: state.fleetName,
    topicPattern: state.topicPattern,
    updatedAt: state.lastUpdateAt || new Date().toISOString(),
    devices: getDevices()
      .sort(sortDevices)
      .map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        online: device.online,
        lastSeen: device.lastSeen,
        topic: device.topic,
        gps: device.gps,
        scene: device.scene,
        scenePose: device.scene,
        vehicle: device.vehicle,
        task: device.task,
        alerts: device.alerts,
        extra: device.extra,
      })),
  };
}

function primeSceneDefinitions(devices) {
  devices.forEach((device) => {
    if (hasScene(device.scene) && !getSceneDefinition(device.scene.sceneId)) {
      void loadSceneDefinition(device.scene.sceneId);
    }
  });
}

function ingestPayload(rawPayload, source, syncInput = false) {
  const normalized = normalizePayload(rawPayload);
  const nextMap = normalized.replace ? new Map() : new Map(state.devices);

  normalized.devices.forEach((device) => {
    const existingDevice = state.devices.get(device.deviceId);
    const mergedDevice = mergeDevice(existingDevice, device);
    nextMap.set(mergedDevice.deviceId, mergedDevice);
  });

  state.devices = nextMap;
  state.fleetName = normalized.fleetName;
  state.topicPattern = normalized.topicPattern;
  state.lastSource = source;
  state.lastUpdateAt = new Date().toISOString();
  state.lastRawPayload = cloneValue(rawPayload);

  getDevices().forEach(updateSceneTrail);
  primeSceneDefinitions(getDevices());
  ensureSelectedDevice();
  render(syncInput);
}

function getToneText(tone) {
  if (tone === "critical") {
    return "涓ラ噸";
  }
  if (tone === "warning") {
    return "棰勮";
  }
  if (tone === "offline") {
    return "绂荤嚎";
  }
  return "姝ｅ父";
}

function formatGps(gps) {
  if (!hasGps(gps)) {
    return "--";
  }
  return `${round(gps.lat, 5)}, ${round(gps.lng, 5)} / ${round(gps.heading, 1)}掳`;
}

function formatScene(scene) {
  if (!hasScene(scene)) {
    return "--";
  }
  return `${scene.sceneId} / ${round(scene.x, 1)} / ${round(scene.y, 1)} / ${round(scene.yaw, 2)}`;
}

function setConnectionChip() {
  const sourceMap = {
    bootstrap: "鏈湴 Mock 杞﹂槦",
    manual: "鎵嬪伐 JSON 璋冭瘯",
    simulation: "妯℃嫙杞﹂槦鍒锋柊",
    mqtt: "MQTT 瀹炴椂澧為噺鍒锋柊",
    api: "鍚庣 REST 蹇収",
    ws: "鍚庣 WebSocket 瀹炴椂鎺ㄩ€?,
  };
  const effectiveSource = state.realtime.wsReady ? "ws" : state.lastSource;
  elements.connectionChip.dataset.source = effectiveSource;
  elements.connectionChip.textContent = sourceMap[effectiveSource] || "鏈湴 Mock 杞﹂槦";
}

function renderSummary() {
  const devices = getDevices();
  const selectedDevice = getSelectedDevice();
  const onlineCount = devices.filter((device) => device.online).length;
  const activeScenes = new Set(
    devices.filter((device) => device.online && hasScene(device.scene)).map((device) => device.scene.sceneId)
  );
  const allAlerts = devices.flatMap((device) => device.alerts);
  const selectedAlerts = selectedDevice ? selectedDevice.alerts.length : 0;

  elements.onlineCount.textContent = `${onlineCount} / ${devices.length}`;
  elements.sceneCoverage.textContent = `${activeScenes.size} 涓満鏅湪绾縛;
  elements.alertTotal.textContent = String(allAlerts.length);
  elements.lastUpdate.textContent = formatDateTime(state.lastUpdateAt || Date.now());
  elements.deviceCount.textContent = `${devices.length} 鍙癭;
  elements.selectedAlertCount.textContent = `${selectedAlerts} 鏉″叧娉╜;

  if (selectedDevice) {
    elements.focusDeviceName.textContent = selectedDevice.deviceName;
    elements.focusDeviceHint.textContent = `${selectedDevice.online ? "鍦ㄧ嚎" : "绂荤嚎"} / ${taskStatusInfo(selectedDevice.task.status).label} / ${selectedDevice.alerts.length} 鏉″憡璀;
  } else {
    elements.focusDeviceName.textContent = "--";
    elements.focusDeviceHint.textContent = "绛夊緟璁惧鎺ュ叆";
  }
}

function renderDeviceList() {
  const devices = getDevices().sort(sortDevices);

  if (!devices.length) {
    elements.deviceList.innerHTML = `<div class="empty-alert">褰撳墠娌℃湁璁惧鏁版嵁锛岃鍏堝姞杞?mock 鏁版嵁鎴栫瓑寰呭悗绔揩鐓с€?/div>`;
    return;
  }

  elements.deviceList.innerHTML = devices
    .map((device) => {
      const tone = getDeviceTone(device);
      const sceneName = hasScene(device.scene) ? device.scene.sceneName || device.scene.sceneId : "鏈粦瀹氬満鏅?;
      const warningCount = device.alerts.filter((alert) => alert.severity === "warning").length;
      const criticalCount = device.alerts.filter((alert) => alert.severity === "critical").length;

      return `
        <button
          type="button"
          class="device-item ${device.deviceId === state.selectedDeviceId ? "selected" : ""}"
          data-device-id="${escapeHtml(device.deviceId)}"
          data-tone="${tone}"
        >
          <div class="device-row">
            <div>
              <h3 class="device-name">${escapeHtml(device.deviceName)}</h3>
              <div class="device-subtitle">${escapeHtml(device.deviceId)}</div>
            </div>
            <span class="device-status" data-tone="${tone}">${escapeHtml(getToneText(tone))}</span>
          </div>

          <div class="device-metrics">
            <span>鏈€杩戜笂鎶ワ細${escapeHtml(formatDateTime(device.lastSeen))}</span>
            <span>閫熷害锛?{round(device.vehicle.speed, 2).toFixed(2)} m/s</span>
            <span>鐢甸噺锛?{round(device.vehicle.soc, 1).toFixed(1)}%</span>
          </div>

          <div class="device-tags">
            <span class="device-tag">${escapeHtml(sceneName)}</span>
            <span class="device-tag">涓ラ噸 ${criticalCount}</span>
            <span class="device-tag">棰勮 ${warningCount}</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function setMapEmpty(title, description) {
  elements.mapEmptyState.classList.remove("hidden");
  elements.mapEmptyTitle.textContent = title;
  elements.mapEmptyCopy.textContent = description;
}

function hideMapEmpty() {
  elements.mapEmptyState.classList.add("hidden");
}

function renderProviderBadge(text) {
  elements.gpsProviderBadge.textContent = text;
}

function buildGpsViewport(points) {
  const latitudes = points.map((point) => point.gps.lat);
  const longitudes = points.map((point) => point.gps.lng);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const latPadding = Math.max((maxLat - minLat) * 0.25, 0.003);
  const lngPadding = Math.max((maxLng - minLng) * 0.25, 0.003);
  return {
    minLat: minLat - latPadding,
    maxLat: maxLat + latPadding,
    minLng: minLng - lngPadding,
    maxLng: maxLng + lngPadding,
  };
}

function gpsToCanvas(gps, viewport) {
  const x = ((gps.lng - viewport.minLng) / (viewport.maxLng - viewport.minLng)) * 920 + 40;
  const y = 580 - ((gps.lat - viewport.minLat) / (viewport.maxLat - viewport.minLat)) * 520;
  return { x, y };
}

function renderGpsMap() {
  const gpsDevices = getDevices().filter((device) => hasGps(device.gps));
  const selectedDevice = getSelectedDevice();

  if (!gpsDevices.length) {
    setMapEmpty("鏆傛棤 GPS 鍧愭爣", "褰撳墠杞﹂槦娌℃湁鍙敤鐨勭粡绾害鏁版嵁锛岃鍒囨崲鍒?ROS 鍦板浘鎴栫瓑寰呰澶囦笂鎶ャ€?);
    renderProviderBadge("绛夊緟 GPS 涓婃姤");
    elements.gpsBackdrop.innerHTML = "";
    elements.gpsMarkerLayer.innerHTML = "";
    elements.gpsLabelLayer.innerHTML = "";
    return;
  }

  hideMapEmpty();
  renderProviderBadge("鐐瑰嚮灏忚溅鍥炬爣鍙烦杞埌瀵瑰簲 ROS 鍦板浘");
  const viewport = buildGpsViewport(gpsDevices);

  elements.gpsBackdrop.innerHTML = `
    <path class="gps-water" d="M 62 480 C 210 430, 360 500, 520 450 C 640 410, 760 330, 900 360 L 900 620 L 62 620 Z"></path>
    <path class="gps-road" d="M 80 160 C 250 140, 360 200, 540 190 C 690 182, 810 110, 930 96"></path>
    <path class="gps-road outline" d="M 80 160 C 250 140, 360 200, 540 190 C 690 182, 810 110, 930 96"></path>
    <path class="gps-road" d="M 120 520 C 220 450, 360 400, 520 340 C 640 295, 780 238, 912 180"></path>
    <path class="gps-road outline" d="M 120 520 C 220 450, 360 400, 520 340 C 640 295, 780 238, 912 180"></path>
    <text class="gps-bound-text" x="48" y="42">鍖楃含 ${round(viewport.maxLat, 5)}</text>
    <text class="gps-bound-text" x="48" y="590">鍖楃含 ${round(viewport.minLat, 5)}</text>
    <text class="gps-bound-text" x="740" y="590">涓滅粡 ${round(viewport.maxLng, 5)}</text>
    <text class="gps-bound-text" x="48" y="330">鍏綉 GPS 鎬佸娍鍒嗗竷</text>
  `;

  elements.gpsMarkerLayer.innerHTML = gpsDevices
    .map((device) => {
      const point = gpsToCanvas(device.gps, viewport);
      const tone = getDeviceTone(device);
      const isSelected = device.deviceId === selectedDevice?.deviceId;
      const canJump = hasScene(device.scene);
      return `
        <g class="gps-marker-button" data-device-id="${escapeHtml(device.deviceId)}" data-can-jump="${canJump ? "true" : "false"}">
          <g class="gps-marker ${isSelected ? "selected" : ""}" data-tone="${tone}" transform="translate(${round(point.x, 2)} ${round(point.y, 2)})" filter="url(#markerGlow)">
            <circle class="marker-ring" r="${isSelected ? 22 : 17}"></circle>
            <circle class="marker-core" r="${isSelected ? 10 : 8}"></circle>
            <g transform="rotate(${round(device.gps.heading || 0, 1)})">
              <path class="marker-heading" d="M 0 -22 L 9 -4 L -9 -4 Z"></path>
            </g>
          </g>
        </g>
      `;
    })
    .join("");

  elements.gpsLabelLayer.innerHTML = gpsDevices
    .map((device) => {
      const point = gpsToCanvas(device.gps, viewport);
      const tone = getDeviceTone(device);
      const boxWidth = Math.max(132, device.deviceName.length * 18);
      return `
        <g transform="translate(${round(point.x + 16, 2)} ${round(point.y - 30, 2)})">
          <rect class="gps-tag-bg" x="0" y="0" rx="12" ry="12" width="${boxWidth}" height="46"></rect>
          <text class="gps-tag-text" x="14" y="18">${escapeHtml(device.deviceName)}</text>
          <text class="gps-tag-text" x="14" y="36">${escapeHtml(getToneText(tone))} / ${hasScene(device.scene) ? "鍙烦杞?ROS" : "鏃?ROS"}</text>
        </g>
      `;
    })
    .join("");
}

function sceneWorldToImage(point, sceneDefinition) {
  const resolution = sceneDefinition.resolution || 0.1;
  const origin = sceneDefinition.origin || { x: 0, y: 0 };
  const imageWidth = sceneDefinition.width || 1000;
  const imageHeight = sceneDefinition.height || 620;
  const pixelX = (point.x - origin.x) / resolution;
  const pixelY = imageHeight - (point.y - origin.y) / resolution;
  return {
    x: clamp(pixelX, 0, imageWidth),
    y: clamp(pixelY, 0, imageHeight),
  };
}

function sceneToCanvas(point, sceneDefinition) {
  const imagePoint = sceneWorldToImage(point, sceneDefinition);
  return {
    x: (imagePoint.x / (sceneDefinition.width || 1000)) * 1000,
    y: (imagePoint.y / (sceneDefinition.height || 620)) * 620,
  };
}

function buildTrailPath(trail, sceneDefinition) {
  if (!trail || trail.length < 2) {
    return "";
  }

  return trail
    .map((point, index) => {
      const canvasPoint = sceneToCanvas(point, sceneDefinition);
      return `${index === 0 ? "M" : "L"} ${round(canvasPoint.x, 2)} ${round(canvasPoint.y, 2)}`;
    })
    .join(" ");
}

function renderSceneMap() {
  const selectedDevice = getSelectedDevice();

  if (!selectedDevice || !hasScene(selectedDevice.scene)) {
    setMapEmpty("鏆傛棤 ROS 鍦烘櫙瀹氫綅", "褰撳墠閫変腑璁惧鏈粦瀹?ROS 鍦板浘鍧愭爣锛岃鍒囨崲鍒?GPS 瑙嗗浘鎴栫瓑寰呭満鏅秷鎭€?);
    elements.sceneZoneLayer.innerHTML = "";
    elements.sceneMarkerLayer.innerHTML = "";
    elements.sceneLabelLayer.innerHTML = "";
    elements.sceneTrail.setAttribute("d", "");
    return;
  }

  const sceneDefinition = getSceneDefinition(selectedDevice.scene.sceneId);
  if (!sceneDefinition) {
    void loadSceneDefinition(selectedDevice.scene.sceneId);
    setMapEmpty("鍦烘櫙鍦板浘鍔犺浇涓?, "宸茶瘑鍒埌璁惧鐨勫満鏅?ID锛屾鍦ㄥ皾璇曚粠鍚庣鎷夊彇 ROS 鍦板浘鍏冩暟鎹€?);
    elements.sceneZoneLayer.innerHTML = "";
    elements.sceneMarkerLayer.innerHTML = "";
    elements.sceneLabelLayer.innerHTML = "";
    elements.sceneTrail.setAttribute("d", "");
    return;
  }

  hideMapEmpty();
  const sceneDevices = getDevices().filter((device) => device.scene.sceneId === selectedDevice.scene.sceneId && hasScene(device.scene));
  const trail = (state.sceneTrails[selectedDevice.deviceId] || []).filter((point) => point.sceneId === selectedDevice.scene.sceneId);
  elements.sceneTrail.setAttribute("d", buildTrailPath(trail, sceneDefinition));

  elements.sceneZoneLayer.innerHTML = `
    <image href="${escapeHtml(sceneDefinition.imageUrl || "")}" x="0" y="0" width="1000" height="620" preserveAspectRatio="none"></image>
    <rect x="1" y="1" width="998" height="618" fill="none" stroke="rgba(10, 19, 28, 0.6)" stroke-width="2"></rect>
    <g>
      ${Array.from({ length: 9 })
        .map((_, index) => `<line x1="${index * 125}" y1="0" x2="${index * 125}" y2="620" stroke="rgba(54, 72, 88, 0.16)" stroke-width="1"></line>`)
        .join("")}
      ${Array.from({ length: 6 })
        .map((_, index) => `<line x1="0" y1="${index * 124}" x2="1000" y2="${index * 124}" stroke="rgba(54, 72, 88, 0.16)" stroke-width="1"></line>`)
        .join("")}
    </g>
  `;

  elements.sceneMarkerLayer.innerHTML = sceneDevices
    .map((device) => {
      const point = sceneToCanvas(device.scene, sceneDefinition);
      const tone = getDeviceTone(device);
      const isSelected = device.deviceId === selectedDevice.deviceId;
      const yawDegrees = -round((device.scene.yaw || 0) * 57.2958, 1);
      return `
        <g class="scene-marker ${isSelected ? "selected" : ""}" data-tone="${tone}" transform="translate(${round(point.x, 2)} ${round(point.y, 2)}) rotate(${yawDegrees})">
          <circle class="scene-ring" r="${isSelected ? 24 : 16}"></circle>
          <rect class="scene-body" x="-14" y="-24" width="28" height="48" rx="10" ry="10"></rect>
          <path class="scene-arrow" d="M 0 -34 L 10 -12 L -10 -12 Z"></path>
          <circle cx="0" cy="0" r="4" fill="#eef7fb"></circle>
        </g>
      `;
    })
    .join("");

  elements.sceneLabelLayer.innerHTML = `
    <text class="scene-label-text" x="36" y="42">ROS Occupancy Map / ${escapeHtml(sceneDefinition.sceneName)}</text>
    <text class="scene-label-text" x="36" y="72">map frame: ${escapeHtml(sceneDefinition.mapFrame || "map")} / resolution ${round(sceneDefinition.resolution, 3)} m</text>
    <text class="scene-label-text" x="36" y="102">璁惧鏁?${sceneDevices.length} / origin (${round(sceneDefinition.origin?.x || 0, 2)}, ${round(sceneDefinition.origin?.y || 0, 2)})</text>
  `;
}

function renderMaps() {
  const selectedDevice = getSelectedDevice();
  const isGpsMode = state.selectedMapMode === "gps";

  elements.gpsMap.classList.toggle("hidden", !isGpsMode);
  elements.sceneMap.classList.toggle("hidden", isGpsMode);
  elements.gpsTabBtn.classList.toggle("active", isGpsMode);
  elements.gpsTabBtn.classList.toggle("secondary-btn", !isGpsMode);
  elements.sceneTabBtn.classList.toggle("active", !isGpsMode);
  elements.sceneTabBtn.classList.toggle("secondary-btn", isGpsMode);

  if (isGpsMode) {
    renderGpsMap();
  } else {
    renderProviderBadge(state.realtime.wsReady ? "ROS 鏍呮牸鍦板浘 / WebSocket 瀹炴椂鍚屾" : "ROS 鏍呮牸鍦板浘瑙嗗浘");
    renderSceneMap();
  }

  if (!selectedDevice) {
    elements.mapFocusName.textContent = "--";
    elements.mapFocusMeta.textContent = "璇蜂粠宸︿晶閫夋嫨涓€鍙拌澶囥€?;
    return;
  }

  elements.mapFocusName.textContent = selectedDevice.deviceName;
  if (state.selectedMapMode === "gps") {
    const gpsDevices = getDevices().filter((device) => hasGps(device.gps)).length;
    elements.mapFocusMeta.textContent = `GPS 瑙嗗浘宸插睍绀?${gpsDevices} 鍙版湁鍏綉鍧愭爣鐨勮澶囷紝鐐瑰嚮灏忚溅鍥炬爣鍙垏鎹㈠埌瀵瑰簲 ROS 鍦板浘銆俙;
  } else if (hasScene(selectedDevice.scene)) {
    const sceneDefinition = getSceneDefinition(selectedDevice.scene.sceneId);
    elements.mapFocusMeta.textContent = `${selectedDevice.scene.sceneName || selectedDevice.scene.sceneId} / x ${round(selectedDevice.scene.x, 1)} / y ${round(selectedDevice.scene.y, 1)} / ${sceneDefinition?.mapFrame || "map"}`;
  } else {
    elements.mapFocusMeta.textContent = "褰撳墠璁惧灏氭湭缁戝畾鍦烘櫙鍧愭爣锛岃鍒囨崲鍥?GPS 瑙嗗浘銆?;
  }
}

function renderSelectedDevice() {
  const device = getSelectedDevice();

  if (!device) {
    elements.selectedDeviceName.textContent = "鏈€夋嫨璁惧";
    elements.selectedDeviceStatus.textContent = "绛夊緟璁惧鍒楄〃鍔犺浇銆?;
    elements.selectedDevicePill.textContent = "--";
    elements.selectedDevicePill.dataset.tone = "notice";
    return;
  }

  const tone = getDeviceTone(device);
  const controlMode = controlModeInfo(device.vehicle.controlMode);
  const gear = gearInfo(device.vehicle.gear);
  const taskStatus = taskStatusInfo(device.task.status);
  const extraParts = [];

  if (device.extra.temperature !== undefined) {
    extraParts.push(`娓╁害 ${round(device.extra.temperature, 1)}掳C`);
  }
  if (device.extra.networkQuality !== undefined) {
    extraParts.push(`缃戠粶 ${round(device.extra.networkQuality, 0)}%`);
  }
  if (!extraParts.length) {
    extraParts.push("鏆傛棤棰濆瀛楁");
  }

  elements.selectedDeviceName.textContent = device.deviceName;
  elements.selectedDeviceStatus.textContent = `${device.online ? "鍦ㄧ嚎" : "绂荤嚎"} / 鏈€杩戞秷鎭?${formatDateTime(device.lastSeen)} / ${device.alerts.length} 鏉″憡璀;
  elements.selectedDevicePill.textContent = getToneText(tone);
  elements.selectedDevicePill.dataset.tone = tone;

  elements.controlModeValue.textContent = controlMode.label;
  elements.controlModeDesc.textContent = controlMode.description;
  elements.gearValue.textContent = gear.label;
  elements.gearDesc.textContent = gear.description;
  elements.speedValue.textContent = round(device.vehicle.speed, 2).toFixed(2);
  elements.speedDesc.textContent = `${round(device.vehicle.speed * 3.6, 2).toFixed(2)} km/h`;
  elements.omegaValue.textContent = round(device.vehicle.omega, 3).toFixed(3);
  elements.omegaDesc.textContent = Math.abs(device.vehicle.omega) > 0.8 ? "褰撳墠杞悜鍔ㄤ綔鍋忔縺鐑? : "褰撳墠杞悜鍔ㄤ綔骞崇ǔ";
  elements.socValue.textContent = round(device.vehicle.soc, 1).toFixed(1);
  elements.socDesc.textContent = device.vehicle.soc < 20 ? "鐢甸噺鍋忎綆锛岃灏藉揩鍥炲厖" : "鐢甸噺鐘舵€佹甯?;
  elements.taskStatusValue.textContent = `${taskStatus.label} / ${device.task.name}`;
  elements.taskStatusDesc.textContent = taskStatus.description;
  elements.gpsValue.textContent = formatGps(device.gps);
  elements.gpsDesc.textContent = hasGps(device.gps) ? "缁忕含搴?/ 鑸悜" : "褰撳墠鏈笂浼?GPS";
  elements.sceneValue.textContent = formatScene(device.scene);
  elements.sceneDesc.textContent = hasScene(device.scene) ? "ROS sceneId / x / y / yaw" : "褰撳墠鏈粦瀹氬満鏅?;
  elements.extraValue.textContent = extraParts.join(" / ");
  elements.extraDesc.textContent = `Topic ${device.topic}`;
}

function buildAlertCard(alert, isFocused) {
  return `
    <article class="alert-item ${isFocused ? "focused" : ""}" data-severity="${alert.severity}">
      <div class="alert-item-top">
        <strong>${escapeHtml(alert.title)}</strong>
        <span class="severity-chip" data-tone="${alert.severity}">${escapeHtml(getSeverityText(alert.severity))}</span>
      </div>
      <p>${escapeHtml(alert.detail)}</p>
      <div class="alert-meta">
        <span>${escapeHtml(alert.deviceName)}</span>
        <span>${escapeHtml(alert.source)}</span>
        <span>${escapeHtml(formatDateTime(alert.ts))}</span>
      </div>
    </article>
  `;
}

function renderAlerts() {
  const selectedDevice = getSelectedDevice();
  const grouped = {
    critical: [],
    warning: [],
    notice: [],
  };

  getDevices().forEach((device) => {
    device.alerts.forEach((alert) => {
      grouped[alert.severity].push({
        ...alert,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      });
    });
  });

  Object.values(grouped).forEach((list) => {
    list.sort((left, right) => {
      if ((left.deviceId === selectedDevice?.deviceId) !== (right.deviceId === selectedDevice?.deviceId)) {
        return Number(right.deviceId === selectedDevice?.deviceId) - Number(left.deviceId === selectedDevice?.deviceId);
      }
      return toTimestampMs(right.ts) - toTimestampMs(left.ts);
    });
  });

  elements.criticalCount.textContent = String(grouped.critical.length);
  elements.warningCount.textContent = String(grouped.warning.length);
  elements.noticeCount.textContent = String(grouped.notice.length);

  const renderBucket = (list, container) => {
    if (!list.length) {
      container.innerHTML = `<div class="empty-alert">褰撳墠鍒嗙粍鏆傛棤鍛婅銆?/div>`;
      return;
    }
    container.innerHTML = list.map((alert) => buildAlertCard(alert, alert.deviceId === selectedDevice?.deviceId)).join("");
  };

  renderBucket(grouped.critical, elements.criticalList);
  renderBucket(grouped.warning, elements.warningList);
  renderBucket(grouped.notice, elements.noticeList);
}

function renderRawPayload(syncInput = false) {
  const snapshotText = JSON.stringify(buildFleetSnapshot(), null, 2);
  elements.rawPayload.textContent = snapshotText;
  if (syncInput) {
    elements.jsonInput.value = snapshotText;
  }
}

function render(syncInput = false) {
  setConnectionChip();
  renderSummary();
  renderDeviceList();
  renderMaps();
  renderSelectedDevice();
  renderAlerts();
  renderRawPayload(syncInput);
}

function applyJsonInput() {
  try {
    const payload = JSON.parse(elements.jsonInput.value);
    ingestPayload(payload, "manual", true);
  } catch (error) {
    window.alert(`JSON 瑙ｆ瀽澶辫触: ${error.message}`);
  }
}

function createSimulatedSnapshot() {
  const now = new Date().toISOString();
  const deviceCount = Math.max(getDevices().length, 1);
  const criticalTarget = Math.floor(Math.random() * deviceCount);
  const noticeTarget = Math.floor(Math.random() * deviceCount);

  return {
    fleetName: state.fleetName,
    topicPattern: state.topicPattern,
    updatedAt: now,
    devices: getDevices().map((device, index) => {
      const sceneDefinition = getSceneDefinition(device.scene.sceneId) || sceneCatalog[device.scene.sceneId];
      const nextOnline = device.online ? true : Math.random() > 0.72;
      const nextGps = hasGps(device.gps)
        ? {
            lat: round(device.gps.lat + (Math.random() - 0.5) * 0.0018, 6),
            lng: round(device.gps.lng + (Math.random() - 0.5) * 0.0016, 6),
            heading: round((device.gps.heading + (Math.random() - 0.5) * 22 + 360) % 360, 1),
          }
        : { ...device.gps };
      const nextScene =
        hasScene(device.scene) && sceneDefinition
          ? {
              ...device.scene,
              x: round(
                clamp(device.scene.x + (Math.random() - 0.5) * 6, sceneDefinition.bounds.minX + 2, sceneDefinition.bounds.maxX - 2),
                2
              ),
              y: round(
                clamp(device.scene.y + (Math.random() - 0.5) * 5, sceneDefinition.bounds.minY + 2, sceneDefinition.bounds.maxY - 2),
                2
              ),
              yaw: round(device.scene.yaw + (Math.random() - 0.5) * 0.25, 3),
            }
          : { ...device.scene };
      const nextVehicle = {
        ...device.vehicle,
        speed: nextOnline ? round(clamp(device.vehicle.speed + (Math.random() - 0.5) * 0.7, 0, 4.8), 2) : 0,
        omega: nextOnline ? round((Math.random() - 0.5) * 1.4, 3) : 0,
        soc: round(Math.max(6, device.vehicle.soc - Math.random() * 0.45), 1),
      };
      const nextTaskStatus = nextOnline ? (index === criticalTarget ? 3 : 1) : 0;
      const nextAlerts = [];

      if (index === criticalTarget && nextOnline) {
        nextAlerts.push({
          id: `${device.deviceId}-planner-timeout`,
          title: "灞€閮ㄨ鍒掕秴鏃?,
          detail: "妯℃嫙鍒锋柊涓娴嬪埌璺緞姹傝В瓒呮椂锛岃妫€鏌ュ綋鍓嶄綔涓氬尯鎷ュ牭绋嬪害銆?,
          severity: "critical",
          source: "妯℃嫙鍣?,
          ts: now,
        });
      } else if (index === noticeTarget && nextOnline) {
        nextAlerts.push({
          id: `${device.deviceId}-sync-pending`,
          title: "鍦板浘鍚屾涓?,
          detail: "鍦烘櫙搴曞浘涓庡叕缃戝潗鏍囨鍦ㄩ噸鏂板榻愶紝棰勮鏁扮鍐呮仮澶嶃€?,
          severity: "notice",
          source: "妯℃嫙鍣?,
          ts: now,
        });
      }

      return {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        topic: device.topic,
        online: nextOnline,
        lastSeen: now,
        gps: nextGps,
        scenePose: nextScene,
        vehicle: nextVehicle,
        task: {
          status: nextTaskStatus,
          name: nextTaskStatus === 3 ? "鍛婅鎭㈠涓? : device.task.name,
        },
        alerts: nextAlerts,
        extra: {
          ...device.extra,
          networkQuality: round(clamp((device.extra.networkQuality || 80) + (Math.random() - 0.5) * 12, 0, 100), 0),
          temperature: round((device.extra.temperature || 30) + (Math.random() - 0.5) * 1.8, 1),
        },
      };
    }),
  };
}

function clearTrail() {
  if (state.selectedDeviceId) {
    state.sceneTrails[state.selectedDeviceId] = [];
  } else {
    state.sceneTrails = {};
  }
  render(false);
}

function resetMockData() {
  state.sceneTrails = {};
  ingestPayload(cloneValue(state.initialMockPayload), "bootstrap", true);
}

function resolveWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function connectRealtime() {
  if (state.realtime.ws) {
    return;
  }

  try {
    const ws = new WebSocket(resolveWebSocketUrl());
    state.realtime.ws = ws;

    ws.addEventListener("open", () => {
      state.realtime.wsReady = true;
      render(false);
    });

    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "fleet.snapshot") {
          ingestPayload(message.payload, "ws", false);
          return;
        }
        if (message.type === "fleet.delta") {
          ingestPayload(message.payload.device || message.payload, "mqtt", false);
        }
      } catch (_error) {
        // Ignore malformed messages.
      }
    });

    const markClosed = () => {
      state.realtime.wsReady = false;
      state.realtime.ws = null;
      render(false);
      window.setTimeout(connectRealtime, 4000);
    };

    ws.addEventListener("close", markClosed);
    ws.addEventListener("error", markClosed);
  } catch (_error) {
    state.realtime.wsReady = false;
    state.realtime.ws = null;
  }
}

async function loadSceneCatalogFromBackend() {
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
}

async function bootstrapFromBackend() {
  try {
    await loadSceneCatalogFromBackend();
    const response = await fetch("/api/fleet/snapshot", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    state.realtime.apiReady = true;
    state.initialMockPayload = cloneValue(payload);
    ingestPayload(payload, "api", true);
    connectRealtime();
    return true;
  } catch (_error) {
    state.realtime.apiReady = false;
    return false;
  }
}

async function bootstrapEmptyState() {
  state.initialMockPayload = cloneValue(fallbackFleetPayload);
  ingestPayload(cloneValue(fallbackFleetPayload), "bootstrap", true);
}

elements.applyJsonBtn.addEventListener("click", applyJsonInput);
elements.simulateBtn.addEventListener("click", () => {
  ingestPayload(createSimulatedSnapshot(), "simulation", true);
});
elements.resetMockBtn.addEventListener("click", resetMockData);
elements.clearTrailBtn.addEventListener("click", clearTrail);

elements.deviceList.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-device-id]");
  if (!trigger) {
    return;
  }
  state.selectedDeviceId = trigger.dataset.deviceId;
  render(false);
});

elements.gpsMap.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-device-id]");
  if (!trigger) {
    return;
  }
  state.selectedDeviceId = trigger.dataset.deviceId;
  const selectedDevice = getSelectedDevice();
  if (selectedDevice && hasScene(selectedDevice.scene)) {
    state.selectedMapMode = "scene";
  }
  render(false);
});

[elements.gpsTabBtn, elements.sceneTabBtn].forEach((button) => {
  button.addEventListener("click", () => {
    state.selectedMapMode = button.dataset.mode;
    render(false);
  });
});

window.vehicleDashboard = {
  updateFromPayload(payload) {
    const normalizedPayload = typeof payload === "string" ? JSON.parse(payload) : payload;
    ingestPayload(normalizedPayload, "mqtt", false);
  },
  clearTrail,
  selectDevice(deviceId) {
    if (state.devices.has(deviceId)) {
      state.selectedDeviceId = deviceId;
      render(false);
    }
  },
  getSnapshot() {
    return cloneValue(buildFleetSnapshot());
  },
  getBackendStatus() {
    return {
      apiReady: state.realtime.apiReady,
      wsReady: state.realtime.wsReady,
      source: state.lastSource,
    };
  },
};

async function bootstrap() {
  const backendReady = await bootstrapFromBackend();
  if (!backendReady) {
    await bootstrapEmptyState();
  }
}

bootstrap();

