<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { loadPointCloudBackdrop } from "../utils/point-cloud";

const props = defineProps({
  selectedDevice: { type: Object, default: null },
  sceneDefinition: { type: Object, default: null },
  sceneDevices: { type: Array, default: () => [] },
  getDeviceTone: { type: Function, required: true },
  round: { type: Function, required: true },
  pathPoints: { type: Array, default: () => [] },
  isPathEditMode: { type: Boolean, default: false },
});

const emit = defineEmits(["update-path", "clear-path", "undo-path", "set-edit-mode"]);

const CLICK_THRESHOLD_PX = 6;
const PATH_POINT_EPSILON = 0.05;
const ROS_VIEW_STORAGE_KEY = "navfleet:ros-scene-views";

const overlay = ref(null);
const metadata = ref(null);
const pointCloudBackdrop = ref(null);
const pointCloudError = ref("");
const shellRef = ref(null);
const svgRef = ref(null);
const dragging = ref(false);
const hydratedSceneId = ref("");
const viewport = reactive({
  width: 1000,
  height: 620,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
});

let resizeObserver = null;
let isDragging = false;
let activePointerId = null;
let dragStartX = 0;
let dragStartY = 0;
let dragOriginX = 0;
let dragOriginY = 0;
let dragMoved = false;
let pointCloudRequestId = 0;

const hasPose = (pose) => Number.isFinite(pose?.x) && Number.isFinite(pose?.y);

const hasBounds = (bounds) =>
  Number.isFinite(bounds?.minX) &&
  Number.isFinite(bounds?.maxX) &&
  Number.isFinite(bounds?.minY) &&
  Number.isFinite(bounds?.maxY) &&
  bounds.maxX > bounds.minX &&
  bounds.maxY > bounds.minY;

const mergeSceneDefinition = (base = {}, override = {}) => {
  const merged = {
    ...base,
    ...override,
    origin: {
      ...(base.origin || {}),
      ...(override.origin || {}),
    },
    defaultView:
      base.defaultView || override.defaultView
        ? {
            ...(base.defaultView || {}),
            ...(override.defaultView || {}),
          }
        : undefined,
  };

  if (!merged.bounds && Number.isFinite(merged.width) && Number.isFinite(merged.height) && Number.isFinite(merged.resolution)) {
    merged.bounds = {
      minX: merged.origin?.x || 0,
      maxX: (merged.origin?.x || 0) + merged.width * merged.resolution,
      minY: merged.origin?.y || 0,
      maxY: (merged.origin?.y || 0) + merged.height * merged.resolution,
    };
  }

  return merged;
};

const resolvedScene = computed(() => mergeSceneDefinition(props.sceneDefinition || {}, metadata.value || {}));
const activeSceneId = computed(() => resolvedScene.value?.sceneId || props.sceneDefinition?.sceneId || "");
const sceneBounds = computed(() => (hasBounds(resolvedScene.value?.bounds) ? resolvedScene.value.bounds : null));
const overlayBounds = computed(() => (hasBounds(overlay.value?.bounds) ? overlay.value.bounds : null));
const pointCloudBounds = computed(() =>
  hasBounds(pointCloudBackdrop.value?.bounds) ? pointCloudBackdrop.value.bounds : null
);

const imageLayerDefinition = computed(() => {
  const scene = resolvedScene.value;
  if (!scene?.imageUrl) {
    return null;
  }
  if (
    !Number.isFinite(scene?.origin?.x) ||
    !Number.isFinite(scene?.origin?.y) ||
    !Number.isFinite(scene?.width) ||
    !Number.isFinite(scene?.height) ||
    !Number.isFinite(scene?.resolution)
  ) {
    return null;
  }

  const width = scene.width * scene.resolution;
  const height = scene.height * scene.resolution;
  return {
    href: scene.imageUrl,
    x: scene.origin.x,
    y: scene.origin.y,
    width,
    height,
    minX: scene.origin.x,
    maxX: scene.origin.x + width,
    minY: scene.origin.y,
    maxY: scene.origin.y + height,
  };
});

const pointCloudLayerDefinition = computed(() => {
  const scene = resolvedScene.value;
  if (!scene?.pointCloudUrl || !pointCloudBackdrop.value?.dataUrl || !pointCloudBounds.value) {
    return null;
  }

  const bounds = pointCloudBounds.value;
  return {
    href: pointCloudBackdrop.value.dataUrl,
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    minX: bounds.minX,
    maxX: bounds.maxX,
    minY: bounds.minY,
    maxY: bounds.maxY,
  };
});

const backgroundLayerDefinition = computed(() => pointCloudLayerDefinition.value || imageLayerDefinition.value);

const unionBounds = (...boundsList) => {
  const validBounds = boundsList.filter(hasBounds);
  if (!validBounds.length) {
    return null;
  }

  return validBounds.reduce(
    (accumulator, bounds) => ({
      minX: Math.min(accumulator.minX, bounds.minX),
      maxX: Math.max(accumulator.maxX, bounds.maxX),
      minY: Math.min(accumulator.minY, bounds.minY),
      maxY: Math.max(accumulator.maxY, bounds.maxY),
    }),
    { ...validBounds[0] }
  );
};

const effectiveWorldBounds = computed(() => {
  const backgroundBounds = backgroundLayerDefinition.value;
  const configuredBounds = sceneBounds.value;
  const laneletBounds = overlayBounds.value;

  if (laneletBounds && !backgroundBounds) {
    return laneletBounds;
  }

  return unionBounds(backgroundBounds, configuredBounds, laneletBounds) || configuredBounds || laneletBounds || null;
});

const sceneReady = computed(() => hasBounds(effectiveWorldBounds.value));
const worldWidth = computed(() =>
  sceneReady.value ? effectiveWorldBounds.value.maxX - effectiveWorldBounds.value.minX : 0
);
const worldHeight = computed(() =>
  sceneReady.value ? effectiveWorldBounds.value.maxY - effectiveWorldBounds.value.minY : 0
);

const stageTransform = computed(() => {
  const bounds = effectiveWorldBounds.value;
  if (!sceneReady.value || !bounds) {
    return "";
  }
  return [
    `translate(${props.round(viewport.offsetX, 2)} ${props.round(viewport.offsetY, 2)})`,
    `scale(${viewport.scale} ${-viewport.scale})`,
    `translate(${-props.round(bounds.minX, 4)} ${-props.round(bounds.maxY, 4)})`,
  ].join(" ");
});

const scaleLabel = computed(() => `${props.round(viewport.scale, 2)}x`);

const markerMetrics = computed(() => ({
  fusionRing: 24,
  fusionCore: 10,
  lidarRing: 20,
  lidarCore: 8,
  arrowHeight: 30,
  arrowHalfWidth: 10,
  peerCore: 7,
}));

const pathMetrics = computed(() => ({
  pointRadius: 6,
  endpointRadius: 8,
}));

const screenInvariantScale = computed(() => 1 / Math.max(viewport.scale || 1, 0.0001));
const screenInvariantTransform = computed(
  () => `scale(${props.round(screenInvariantScale.value, 6)} ${props.round(-screenInvariantScale.value, 6)})`
);

const plannedPathPoints = computed(() =>
  (Array.isArray(props.pathPoints) ? props.pathPoints : []).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
);

function buildWorldPath(points) {
  if (!Array.isArray(points) || !points.length) {
    return "";
  }

  return points
    .map((point, index) => {
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        return "";
      }
      const prefix = index === 0 ? "M" : "L";
      return `${prefix} ${props.round(point.x, 3)} ${props.round(point.y, 3)}`;
    })
    .filter(Boolean)
    .join(" ");
}

function buildArrowPath(height, halfWidth) {
  return `M 0 ${-height} L ${halfWidth} ${-halfWidth} L ${-halfWidth} ${-halfWidth} Z`;
}

function getBaseScale() {
  if (!sceneReady.value) {
    return 1;
  }
  const fitted = Math.min(viewport.width / worldWidth.value, viewport.height / worldHeight.value);
  return Math.max(fitted * 0.92, 0.0001);
}

function getScaleLimits(baseScale = getBaseScale()) {
  const scene = resolvedScene.value;
  const minZoom = scene.minZoom ?? 0.75;
  const maxZoom = scene.maxZoom ?? 8;
  return {
    minScale: baseScale * minZoom,
    maxScale: baseScale * maxZoom,
  };
}

function clampScale(nextScale, baseScale = getBaseScale()) {
  const limits = getScaleLimits(baseScale);
  return Math.min(Math.max(nextScale, limits.minScale), limits.maxScale);
}

function getStorage() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readSavedSceneViews() {
  const storage = getStorage();
  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(ROS_VIEW_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSavedSceneViews(nextValue) {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(ROS_VIEW_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage quota and privacy mode failures.
  }
}

function getViewportCenter(scale = viewport.scale, offsetX = viewport.offsetX, offsetY = viewport.offsetY) {
  const bounds = effectiveWorldBounds.value;
  if (!sceneReady.value || !bounds || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }

  const x = bounds.minX + (viewport.width / 2 - offsetX) / scale;
  const y = bounds.maxY - (viewport.height / 2 - offsetY) / scale;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

function isWorldPointWithinBounds(point, bounds = effectiveWorldBounds.value) {
  return (
    !!bounds &&
    !!point &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

function saveViewportState(sceneId = activeSceneId.value) {
  if (!sceneId || !sceneReady.value) {
    return;
  }

  const center = getViewportCenter();
  if (!center) {
    return;
  }

  const savedViews = readSavedSceneViews();
  savedViews[sceneId] = {
    centerX: Number(center.x.toFixed(4)),
    centerY: Number(center.y.toFixed(4)),
    scale: Number(viewport.scale.toFixed(6)),
    updatedAt: Date.now(),
  };
  writeSavedSceneViews(savedViews);
}

function restoreViewportState(sceneId = activeSceneId.value) {
  if (!sceneId || !sceneReady.value) {
    return false;
  }

  const savedView = readSavedSceneViews()[sceneId];
  const savedCenter = savedView
    ? {
        x: Number(savedView.centerX),
        y: Number(savedView.centerY),
      }
    : null;
  if (!savedView || !savedCenter || !isWorldPointWithinBounds(savedCenter) || !Number.isFinite(Number(savedView.scale))) {
    return false;
  }

  const baseScale = getBaseScale();
  const nextScale = clampScale(Number(savedView.scale), baseScale);
  viewport.scale = nextScale;
  if (!centerWorldPoint(savedCenter.x, savedCenter.y, nextScale)) {
    return false;
  }

  saveViewportState(sceneId);
  return true;
}

function worldToViewport(point) {
  const bounds = effectiveWorldBounds.value;
  if (!sceneReady.value || !bounds || !hasPose(point)) {
    return null;
  }

  return {
    x: viewport.offsetX + (point.x - bounds.minX) * viewport.scale,
    y: viewport.offsetY + (bounds.maxY - point.y) * viewport.scale,
  };
}

function pointerToWorld(event) {
  const bounds = effectiveWorldBounds.value;
  const rect = svgRef.value?.getBoundingClientRect();
  if (!sceneReady.value || !bounds || !rect) {
    return null;
  }

  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const worldX = (pointerX - viewport.offsetX) / viewport.scale + bounds.minX;
  const worldY = bounds.maxY - (pointerY - viewport.offsetY) / viewport.scale;

  if (
    !Number.isFinite(worldX) ||
    !Number.isFinite(worldY) ||
    worldX < bounds.minX ||
    worldX > bounds.maxX ||
    worldY < bounds.minY ||
    worldY > bounds.maxY
  ) {
    return null;
  }

  return {
    x: props.round(worldX, 3),
    y: props.round(worldY, 3),
  };
}

function centerWorldPoint(worldX, worldY, scale) {
  const bounds = effectiveWorldBounds.value;
  if (!sceneReady.value || !bounds || !Number.isFinite(worldX) || !Number.isFinite(worldY)) {
    return false;
  }

  viewport.offsetX = viewport.width / 2 - (worldX - bounds.minX) * scale;
  viewport.offsetY = viewport.height / 2 - (bounds.maxY - worldY) * scale;
  return true;
}

function fitWorldBounds(scale) {
  const bounds = effectiveWorldBounds.value;
  if (!sceneReady.value || !bounds) {
    return;
  }

  viewport.scale = scale;
  viewport.offsetX = (viewport.width - worldWidth.value * scale) / 2;
  viewport.offsetY = (viewport.height - worldHeight.value * scale) / 2;
}

function getFocusPose() {
  if (hasPose(props.selectedDevice?.fusionLoc)) {
    return props.selectedDevice.fusionLoc;
  }
  if (hasPose(props.selectedDevice?.lidarLoc)) {
    return props.selectedDevice.lidarLoc;
  }
  return null;
}

function resetView() {
  if (!sceneReady.value) {
    return;
  }

  const scene = resolvedScene.value;
  const baseScale = getBaseScale();
  fitWorldBounds(baseScale);

  const focusPose = getFocusPose();
  if (focusPose) {
    const focusScale = clampScale(baseScale * 1.6, baseScale);
    viewport.scale = focusScale;
    if (centerWorldPoint(focusPose.x, focusPose.y, focusScale)) {
      saveViewportState();
      return;
    }
  }

  const sceneZoom = Number.isFinite(scene.defaultView?.zoom) ? scene.defaultView.zoom : 1;
  const nextScale = clampScale(baseScale * sceneZoom, baseScale);
  viewport.scale = nextScale;

  if (
    Number.isFinite(scene.defaultView?.centerX) &&
    Number.isFinite(scene.defaultView?.centerY) &&
    centerWorldPoint(scene.defaultView.centerX, scene.defaultView.centerY, nextScale)
  ) {
    saveViewportState();
    return;
  }

  fitWorldBounds(nextScale);
  saveViewportState();
}

function applyStoredOrDefaultView(sceneId = activeSceneId.value) {
  if (!sceneId || !sceneReady.value) {
    return;
  }

  if (!restoreViewportState(sceneId)) {
    resetView();
  }

  hydratedSceneId.value = sceneId;
}

const laneletPaths = computed(() =>
  (overlay.value?.lanelets || []).map((lanelet) => ({
    id: lanelet.id,
    subtype: lanelet.subtype,
    leftPath: buildWorldPath(lanelet.left),
    rightPath: buildWorldPath(lanelet.right),
    centerPath: buildWorldPath(lanelet.centerline),
  }))
);

const selectedFusionPoint = computed(() => (hasPose(props.selectedDevice?.fusionLoc) ? props.selectedDevice.fusionLoc : null));
const selectedLidarPoint = computed(() => (hasPose(props.selectedDevice?.lidarLoc) ? props.selectedDevice.lidarLoc : null));
const formationPeerDevices = computed(() =>
  (Array.isArray(props.sceneDevices) ? props.sceneDevices : [])
    .filter((device) => device?.deviceId && device.deviceId !== props.selectedDevice?.deviceId)
    .map((device) => {
      const pose = hasPose(device.fusionLoc) ? device.fusionLoc : hasPose(device.lidarLoc) ? device.lidarLoc : null;
      if (!pose) {
        return null;
      }
      return {
        deviceId: device.deviceId,
        deviceName: device.deviceName || device.deviceId,
        pose,
        tone: props.getDeviceTone(device),
      };
    })
    .filter(Boolean)
);

const selectedFusionAngle = computed(() =>
  Number.isFinite(props.selectedDevice?.fusionLoc?.yaw)
    ? 90 - props.round((props.selectedDevice.fusionLoc.yaw * 180) / Math.PI, 1)
    : 0
);

const selectedLidarAngle = computed(() =>
  Number.isFinite(props.selectedDevice?.lidarLoc?.yaw)
    ? 90 - props.round((props.selectedDevice.lidarLoc.yaw * 180) / Math.PI, 1)
    : 0
);

const connectorPath = computed(() => {
  if (!selectedFusionPoint.value || !selectedLidarPoint.value) {
    return "";
  }
  return buildWorldPath([selectedFusionPoint.value, selectedLidarPoint.value]);
});

const plannedPathD = computed(() => buildWorldPath(plannedPathPoints.value));
const pathStartPoint = computed(() => plannedPathPoints.value[0] || null);
const pathEndPoint = computed(() =>
  plannedPathPoints.value.length ? plannedPathPoints.value[plannedPathPoints.value.length - 1] : null
);
const pathMiddlePoints = computed(() =>
  plannedPathPoints.value.slice(1, Math.max(plannedPathPoints.value.length - 1, 1))
);

const pathHintPosition = computed(() => {
  if (!pathEndPoint.value) {
    return null;
  }
  return worldToViewport(pathEndPoint.value);
});

async function loadOverlay(url) {
  if (!url) {
    overlay.value = null;
    return;
  }

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    overlay.value = await response.json();
  } catch (_error) {
    overlay.value = null;
  }
}

async function loadMetadata(url) {
  if (!url) {
    metadata.value = null;
    return;
  }

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    metadata.value = await response.json();
  } catch (_error) {
    metadata.value = null;
  }
}

async function loadPointCloud(scene) {
  const requestId = pointCloudRequestId + 1;
  pointCloudRequestId = requestId;

  if (!scene?.pointCloudUrl) {
    pointCloudBackdrop.value = null;
    pointCloudError.value = "";
    return;
  }

  try {
    pointCloudError.value = "";
    const result = await loadPointCloudBackdrop(scene);
    if (requestId !== pointCloudRequestId) {
      return;
    }
    pointCloudBackdrop.value = result;
  } catch (error) {
    if (requestId !== pointCloudRequestId) {
      return;
    }
    pointCloudBackdrop.value = null;
    pointCloudError.value = error instanceof Error ? error.message : "点云背景加载失败";
  }
}

function updateViewportSize() {
  const rect = shellRef.value?.getBoundingClientRect();
  if (!rect?.width || !rect?.height) {
    return;
  }
  viewport.width = rect.width;
  viewport.height = rect.height;
}

function syncViewportAfterResize() {
  const previousCenter = getViewportCenter();
  const previousScale = viewport.scale;

  updateViewportSize();

  if (!sceneReady.value) {
    return;
  }

  if (previousCenter && isWorldPointWithinBounds(previousCenter)) {
    const nextScale = clampScale(previousScale);
    viewport.scale = nextScale;
    if (centerWorldPoint(previousCenter.x, previousCenter.y, nextScale)) {
      saveViewportState();
      return;
    }
  }

  if (hydratedSceneId.value !== activeSceneId.value) {
    applyStoredOrDefaultView(activeSceneId.value);
  }
}

function handleWheel(event) {
  if (!sceneReady.value) {
    return;
  }

  const worldPoint = pointerToWorld(event);
  if (!worldPoint) {
    return;
  }

  const nextScale = clampScale(viewport.scale * (event.deltaY < 0 ? 1.12 : 0.88));
  if (nextScale === viewport.scale) {
    return;
  }

  viewport.scale = nextScale;
  const bounds = effectiveWorldBounds.value;
  const rect = svgRef.value?.getBoundingClientRect();
  if (!rect) {
    return;
  }
  viewport.offsetX = event.clientX - rect.left - (worldPoint.x - bounds.minX) * nextScale;
  viewport.offsetY = event.clientY - rect.top - (bounds.maxY - worldPoint.y) * nextScale;
  saveViewportState();
}

function handlePointerDown(event) {
  if (!sceneReady.value || event.button !== 0) {
    return;
  }

  isDragging = true;
  activePointerId = event.pointerId;
  dragging.value = true;
  dragMoved = false;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragOriginX = viewport.offsetX;
  dragOriginY = viewport.offsetY;
  svgRef.value?.setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event) {
  if (!isDragging || event.pointerId !== activePointerId) {
    return;
  }

  const deltaX = event.clientX - dragStartX;
  const deltaY = event.clientY - dragStartY;
  if (Math.hypot(deltaX, deltaY) > CLICK_THRESHOLD_PX) {
    dragMoved = true;
  }

  viewport.offsetX = dragOriginX + deltaX;
  viewport.offsetY = dragOriginY + deltaY;
}

function appendPathPoint(point) {
  if (!point) {
    return;
  }

  const nextPoints = [...plannedPathPoints.value];
  const lastPoint = nextPoints[nextPoints.length - 1];
  if (lastPoint && Math.hypot(lastPoint.x - point.x, lastPoint.y - point.y) <= PATH_POINT_EPSILON) {
    return;
  }

  nextPoints.push(point);
  emit("update-path", nextPoints);
}

function finishPointerInteraction(event) {
  if (!isDragging || event.pointerId !== activePointerId) {
    return;
  }

  const treatAsClick = !dragMoved;
  isDragging = false;
  activePointerId = null;
  dragging.value = false;
  svgRef.value?.releasePointerCapture?.(event.pointerId);

  if (dragMoved) {
    saveViewportState();
  }

  if (props.isPathEditMode && treatAsClick) {
    appendPathPoint(pointerToWorld(event));
  }
}

function handlePointerUp(event) {
  finishPointerInteraction(event);
}

function handleDoubleClick(event) {
  if (!props.isPathEditMode) {
    return;
  }
  event.preventDefault();
  emit("set-edit-mode", false);
}

function handleContextMenu(event) {
  if (!props.isPathEditMode) {
    return;
  }
  event.preventDefault();
  emit("undo-path");
}

function handleKeydown(event) {
  if (event.key === "Escape" && props.isPathEditMode) {
    emit("set-edit-mode", false);
  }
}

onMounted(() => {
  updateViewportSize();
  resizeObserver = new ResizeObserver(() => {
    syncViewportAfterResize();
  });
  if (shellRef.value) {
    resizeObserver.observe(shellRef.value);
  }
  window.addEventListener("keydown", handleKeydown);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  pointCloudRequestId += 1;
  window.removeEventListener("keydown", handleKeydown);
});

watch(
  activeSceneId,
  (sceneId, previousSceneId) => {
    if (sceneId !== previousSceneId) {
      hydratedSceneId.value = "";
    }
  },
  { immediate: true }
);

watch(
  () => props.sceneDefinition?.overlayUrl,
  (url) => {
    void loadOverlay(url);
  },
  { immediate: true }
);

watch(
  () => props.sceneDefinition?.metadataUrl,
  (url) => {
    void loadMetadata(url);
  },
  { immediate: true }
);

watch(
  () => [
    props.sceneDefinition?.sceneId,
    props.sceneDefinition?.pointCloudUrl,
    props.sceneDefinition?.pointCloudMetaUrl,
    props.sceneDefinition?.resolution,
    props.sceneDefinition?.width,
    props.sceneDefinition?.height,
    props.sceneDefinition?.origin?.x,
    props.sceneDefinition?.origin?.y,
  ],
  () => {
    void loadPointCloud(props.sceneDefinition || {});
  },
  { immediate: true }
);

watch(
  () => [
    activeSceneId.value,
    backgroundLayerDefinition.value?.width,
    backgroundLayerDefinition.value?.height,
    effectiveWorldBounds.value?.minX,
    effectiveWorldBounds.value?.maxX,
    effectiveWorldBounds.value?.minY,
    effectiveWorldBounds.value?.maxY,
  ],
  () => {
    if (!sceneReady.value || !activeSceneId.value) {
      return;
    }

    if (hydratedSceneId.value !== activeSceneId.value) {
      applyStoredOrDefaultView(activeSceneId.value);
      return;
    }

    const center = getViewportCenter();
    if (!center || !isWorldPointWithinBounds(center)) {
      applyStoredOrDefaultView(activeSceneId.value);
      return;
    }

    saveViewportState(activeSceneId.value);
  },
  { immediate: true }
);

watch(
  () => [props.selectedDevice?.deviceId, props.selectedDevice?.sceneId],
  ([nextDeviceId, nextSceneId], [previousDeviceId, previousSceneId]) => {
    if (!sceneReady.value || !activeSceneId.value || !nextDeviceId) {
      return;
    }

    if (hydratedSceneId.value !== activeSceneId.value || nextSceneId !== previousSceneId) {
      hydratedSceneId.value = "";
      applyStoredOrDefaultView(activeSceneId.value);
      return;
    }

    if (previousDeviceId && nextDeviceId !== previousDeviceId) {
      resetView();
    }
  }
);
</script>

<template>
  <div ref="shellRef" class="ros-map-shell">
    <svg
      ref="svgRef"
      class="map-canvas ros-stage"
      :class="{ dragging, 'path-editing': isPathEditMode }"
      :viewBox="`0 0 ${viewport.width || 1000} ${viewport.height || 620}`"
      role="img"
      aria-label="ROS 场景地图"
      @wheel.prevent="handleWheel"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerUp"
      @pointerleave="handlePointerUp"
      @dblclick.prevent="handleDoubleClick"
      @contextmenu="handleContextMenu"
    >
      <rect :width="viewport.width || 1000" :height="viewport.height || 620" fill="#071119" />

      <g v-if="sceneReady" :transform="stageTransform">
        <rect
          :x="effectiveWorldBounds.minX"
          :y="effectiveWorldBounds.minY"
          :width="worldWidth"
          :height="worldHeight"
          class="ros-map-bg"
          :class="{ 'lanelet-mode': !!overlay && !backgroundLayerDefinition }"
        />

        <image
          v-if="backgroundLayerDefinition"
          :href="backgroundLayerDefinition.href"
          x="0"
          y="0"
          :width="backgroundLayerDefinition.width"
          :height="backgroundLayerDefinition.height"
          preserveAspectRatio="none"
          :transform="`translate(${props.round(backgroundLayerDefinition.x, 3)} ${props.round(backgroundLayerDefinition.y + backgroundLayerDefinition.height, 3)}) scale(1 -1)`"
          image-rendering="pixelated"
        />

        <g v-if="laneletPaths.length" class="lanelet-overlay">
          <path
            v-for="lanelet in laneletPaths"
            :key="`${lanelet.id}-left`"
            :d="lanelet.leftPath"
            class="lanelet-edge"
            vector-effect="non-scaling-stroke"
          />
          <path
            v-for="lanelet in laneletPaths"
            :key="`${lanelet.id}-right`"
            :d="lanelet.rightPath"
            class="lanelet-edge"
            vector-effect="non-scaling-stroke"
          />
          <path
            v-for="lanelet in laneletPaths"
            :key="`${lanelet.id}-center`"
            :d="lanelet.centerPath"
            class="lanelet-centerline"
            vector-effect="non-scaling-stroke"
          />
        </g>

        <rect
          :x="effectiveWorldBounds.minX"
          :y="effectiveWorldBounds.minY"
          :width="worldWidth"
          :height="worldHeight"
          fill="none"
          stroke="rgba(15, 28, 39, 0.56)"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />

        <path
          v-if="plannedPathD"
          :d="plannedPathD"
          class="planned-path-line"
          vector-effect="non-scaling-stroke"
        />

        <g
          v-for="(point, index) in pathMiddlePoints"
          :key="`path-middle-${index}`"
          :transform="`translate(${props.round(point.x, 3)} ${props.round(point.y, 3)})`"
        >
          <g :transform="screenInvariantTransform">
            <circle
              cx="0"
              cy="0"
              :r="pathMetrics.pointRadius"
              class="planned-path-point"
              vector-effect="non-scaling-stroke"
            />
          </g>
        </g>

        <g
          v-if="pathStartPoint"
          :transform="`translate(${props.round(pathStartPoint.x, 3)} ${props.round(pathStartPoint.y, 3)})`"
        >
          <g :transform="screenInvariantTransform">
            <circle
              cx="0"
              cy="0"
              :r="pathMetrics.endpointRadius"
              class="planned-path-point start"
              vector-effect="non-scaling-stroke"
            />
          </g>
        </g>

        <g
          v-if="pathEndPoint"
          :transform="`translate(${props.round(pathEndPoint.x, 3)} ${props.round(pathEndPoint.y, 3)})`"
        >
          <g :transform="screenInvariantTransform">
            <circle
              cx="0"
              cy="0"
              :r="pathMetrics.endpointRadius"
              class="planned-path-point end"
              vector-effect="non-scaling-stroke"
            />
          </g>
        </g>

        <path
          v-if="connectorPath"
          :d="connectorPath"
          class="ros-link-line"
          vector-effect="non-scaling-stroke"
        />

        <g
          v-for="peer in formationPeerDevices"
          :key="peer.deviceId"
          class="ros-secondary-marker"
          :data-tone="peer.tone"
          :transform="`translate(${props.round(peer.pose.x, 2)} ${props.round(peer.pose.y, 2)})`"
        >
          <g :transform="screenInvariantTransform">
            <circle class="ros-secondary-core" cx="0" cy="0" :r="markerMetrics.peerCore" vector-effect="non-scaling-stroke" />
            <text class="ros-secondary-label" x="0" y="-16">{{ peer.deviceName }}</text>
          </g>
        </g>

        <g
          v-if="selectedFusionPoint"
          class="ros-marker fusion"
          :transform="`translate(${props.round(selectedFusionPoint.x, 2)} ${props.round(selectedFusionPoint.y, 2)})`"
        >
          <g :transform="screenInvariantTransform">
            <g :transform="`rotate(${selectedFusionAngle})`">
              <circle class="ros-marker-ring" :r="markerMetrics.fusionRing" vector-effect="non-scaling-stroke" />
              <circle class="ros-marker-core" :r="markerMetrics.fusionCore" vector-effect="non-scaling-stroke" />
              <path
                class="ros-marker-arrow"
                :d="buildArrowPath(markerMetrics.arrowHeight, markerMetrics.arrowHalfWidth)"
                vector-effect="non-scaling-stroke"
              />
            </g>
          </g>
        </g>

        <g
          v-if="selectedLidarPoint"
          class="ros-marker lidar"
          :transform="`translate(${props.round(selectedLidarPoint.x, 2)} ${props.round(selectedLidarPoint.y, 2)})`"
        >
          <g :transform="screenInvariantTransform">
            <g :transform="`rotate(${selectedLidarAngle})`">
              <circle class="ros-marker-ring" :r="markerMetrics.lidarRing" vector-effect="non-scaling-stroke" />
              <rect
                class="ros-marker-core"
                :x="-markerMetrics.lidarCore"
                :y="-markerMetrics.lidarCore"
                :width="markerMetrics.lidarCore * 2"
                :height="markerMetrics.lidarCore * 2"
                rx="3"
                ry="3"
                transform="rotate(45)"
                vector-effect="non-scaling-stroke"
              />
              <path
                class="ros-marker-arrow"
                :d="buildArrowPath(markerMetrics.arrowHeight * 0.92, markerMetrics.arrowHalfWidth * 0.92)"
                vector-effect="non-scaling-stroke"
              />
            </g>
          </g>
        </g>
      </g>
    </svg>

    <div class="ros-hud">
      <div class="ros-hud-card">
        <span>场景</span>
        <strong>{{ resolvedScene.sceneName || resolvedScene.sceneId || "--" }}</strong>
      </div>
      <div class="ros-hud-card">
        <span>缩放</span>
        <strong>{{ scaleLabel }}</strong>
      </div>
    </div>

    <div class="ros-toolbar">
      <button
        type="button"
        class="secondary-btn"
        :class="{ 'is-active': isPathEditMode }"
        @click="emit('set-edit-mode', !isPathEditMode)"
      >
        {{ isPathEditMode ? "完成编辑" : "添加路径" }}
      </button>
      <button
        type="button"
        class="secondary-btn"
        :disabled="!plannedPathPoints.length"
        @click="emit('clear-path')"
      >
        清空路径
      </button>
      <button type="button" class="secondary-btn" @click="resetView">重置视图</button>
    </div>

    <div class="ros-legend">
      <span v-if="laneletPaths.length" class="legend-item lanelet">
        <i></i>
        路网覆盖
      </span>
      <span v-if="resolvedScene.pointCloudUrl" class="legend-item point-cloud">
        <i></i>
        点云背景
      </span>
      <span v-if="plannedPathPoints.length" class="legend-item route">
        <i></i>
        规划路径
      </span>
      <span class="legend-item fusion">
        <i></i>
        融合定位
      </span>
      <span class="legend-item lidar">
        <i></i>
        激光定位
      </span>
    </div>

    <div v-if="sceneReady && isPathEditMode" class="path-helper">
      <strong>路径编辑中</strong>
      <span>单击添加点，双击完成，右键撤销，滚轮缩放，拖拽平移。</span>
    </div>

    <div
      v-if="sceneReady && isPathEditMode && pathHintPosition"
      class="path-callout"
      :style="{ left: `${pathHintPosition.x}px`, top: `${pathHintPosition.y}px` }"
    >
      当前终点
    </div>

    <div v-if="pointCloudError" class="ros-warning">
      <strong>点云背景加载失败</strong>
      <span>{{ pointCloudError }}</span>
    </div>

    <div v-if="!sceneReady" class="ros-empty">
      <strong>暂无可用地图</strong>
      <span>当前场景缺少有效的 ROS 地图元数据，请先补齐场景配置或地图资源。</span>
    </div>

    <div v-else-if="!selectedFusionPoint && !selectedLidarPoint" class="ros-empty">
      <strong>暂无 ROS 位姿</strong>
      <span>当前设备还没有融合定位或激光定位数据，地图仍可用于查看场景和编辑路径。</span>
    </div>
  </div>
</template>
