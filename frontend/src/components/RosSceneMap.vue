<script setup>
import { computed } from "vue";
import { useSceneOverlay } from "../composables/useSceneOverlay";
import { useSvgViewport } from "../composables/useSvgViewport";

const props = defineProps({
  selectedDevice: { type: Object, default: null },
  sceneDefinition: { type: Object, default: null },
  sceneDevices: { type: Array, default: () => [] },
  getDeviceTone: { type: Function, required: true },
  round: { type: Function, required: true },
  trails: { type: Object, default: () => ({}) },
});

// Async scene assets: lanelet overlay, scene metadata and point-cloud backdrop.
const { overlay, metadata, pointCloudBackdrop, pointCloudError } = useSceneOverlay(
  () => props.sceneDefinition,
);

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

  if (
    !merged.bounds &&
    Number.isFinite(merged.width) &&
    Number.isFinite(merged.height) &&
    Number.isFinite(merged.resolution)
  ) {
    merged.bounds = {
      minX: merged.origin?.x || 0,
      maxX: (merged.origin?.x || 0) + merged.width * merged.resolution,
      minY: merged.origin?.y || 0,
      maxY: (merged.origin?.y || 0) + merged.height * merged.resolution,
    };
  }

  return merged;
};

const resolvedScene = computed(() =>
  mergeSceneDefinition(props.sceneDefinition || {}, metadata.value || {}),
);
const activeSceneId = computed(
  () => resolvedScene.value?.sceneId || props.sceneDefinition?.sceneId || "",
);
const sceneBounds = computed(() =>
  hasBounds(resolvedScene.value?.bounds) ? resolvedScene.value.bounds : null,
);
const overlayBounds = computed(() =>
  hasBounds(overlay.value?.bounds) ? overlay.value.bounds : null,
);
const pointCloudBounds = computed(() =>
  hasBounds(pointCloudBackdrop.value?.bounds) ? pointCloudBackdrop.value.bounds : null,
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

const backgroundLayerDefinition = computed(
  () => pointCloudLayerDefinition.value || imageLayerDefinition.value,
);

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
    { ...validBounds[0] },
  );
};

// The world coordinate space is the STATIC map extent (background image / OSM
// network / configured bounds). It stays stable while vehicles move so the view
// never jitters; keeping vehicles on-screen is the job of the scene bounds
// (config) plus the focus logic in resetView().
const effectiveWorldBounds = computed(() => {
  const backgroundBounds = backgroundLayerDefinition.value;
  const configuredBounds = sceneBounds.value;
  const laneletBounds = overlayBounds.value;

  if (laneletBounds && !backgroundBounds) {
    return laneletBounds;
  }
  return (
    unionBounds(backgroundBounds, configuredBounds, laneletBounds) ||
    configuredBounds ||
    laneletBounds ||
    null
  );
});

const sceneReady = computed(() => hasBounds(effectiveWorldBounds.value));
const worldWidth = computed(() =>
  sceneReady.value ? effectiveWorldBounds.value.maxX - effectiveWorldBounds.value.minX : 0,
);
const worldHeight = computed(() =>
  sceneReady.value ? effectiveWorldBounds.value.maxY - effectiveWorldBounds.value.minY : 0,
);

const markerMetrics = computed(() => ({
  fusionRing: 24,
  fusionCore: 10,
  lidarRing: 20,
  lidarCore: 8,
  arrowHeight: 30,
  arrowHalfWidth: 10,
  peerCore: 7,
}));

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

const laneletPaths = computed(() =>
  (overlay.value?.lanelets || []).map((lanelet) => ({
    id: lanelet.id,
    subtype: lanelet.subtype,
    leftPath: buildWorldPath(lanelet.left),
    rightPath: buildWorldPath(lanelet.right),
    centerPath: buildWorldPath(lanelet.centerline),
  })),
);

const selectedFusionPoint = computed(() =>
  hasPose(props.selectedDevice?.fusionLoc) ? props.selectedDevice.fusionLoc : null,
);
const selectedLidarPoint = computed(() =>
  hasPose(props.selectedDevice?.lidarLoc) ? props.selectedDevice.lidarLoc : null,
);
const formationPeerDevices = computed(() =>
  (Array.isArray(props.sceneDevices) ? props.sceneDevices : [])
    .filter((device) => device?.deviceId && device.deviceId !== props.selectedDevice?.deviceId)
    .map((device) => {
      const pose = hasPose(device.fusionLoc)
        ? device.fusionLoc
        : hasPose(device.lidarLoc)
          ? device.lidarLoc
          : null;
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
    .filter(Boolean),
);

// Bounding box of every pose currently drawn (selected fusion/lidar + peers),
// padded, so effectiveWorldBounds can keep the fleet framed on the map.
const deviceExtentBounds = computed(() => {
  const points = [];
  if (selectedFusionPoint.value) {
    points.push(selectedFusionPoint.value);
  }
  if (selectedLidarPoint.value) {
    points.push(selectedLidarPoint.value);
  }
  formationPeerDevices.value.forEach((peer) => points.push(peer.pose));
  if (!points.length) {
    return null;
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const pad = 5;
  return {
    minX: Math.min(...xs) - pad,
    maxX: Math.max(...xs) + pad,
    minY: Math.min(...ys) - pad,
    maxY: Math.max(...ys) + pad,
  };
});

const selectedFusionAngle = computed(() =>
  Number.isFinite(props.selectedDevice?.fusionLoc?.yaw)
    ? 90 - props.round((props.selectedDevice.fusionLoc.yaw * 180) / Math.PI, 1)
    : 0,
);

const selectedLidarAngle = computed(() =>
  Number.isFinite(props.selectedDevice?.lidarLoc?.yaw)
    ? 90 - props.round((props.selectedDevice.lidarLoc.yaw * 180) / Math.PI, 1)
    : 0,
);

const connectorPath = computed(() => {
  if (!selectedFusionPoint.value || !selectedLidarPoint.value) {
    return "";
  }
  return buildWorldPath([selectedFusionPoint.value, selectedLidarPoint.value]);
});

const selectedTrailD = computed(() => {
  const deviceId = props.selectedDevice?.deviceId;
  if (!deviceId) {
    return "";
  }
  return buildWorldPath(props.trails?.[deviceId] || []);
});

const peerTrails = computed(() =>
  formationPeerDevices.value
    .map((peer) => ({
      deviceId: peer.deviceId,
      tone: peer.tone,
      d: buildWorldPath(props.trails?.[peer.deviceId] || []),
    }))
    .filter((trail) => trail.d),
);

// Pan/zoom engine. Declared after the world-bounds and formation computeds
// above because its scene-hydration watch runs immediately and reads them.
const {
  viewport,
  shellRef,
  svgRef,
  dragging,
  resetView,
  handleWheel,
  handlePointerDown,
  handlePointerMove,
  handlePointerUp,
} = useSvgViewport({
  round: (value, digits) => props.round(value, digits),
  selectedDevice: computed(() => props.selectedDevice),
  resolvedScene,
  activeSceneId,
  effectiveWorldBounds,
  sceneReady,
  worldWidth,
  worldHeight,
  backgroundLayerDefinition,
  formationPeerDevices,
  deviceExtentBounds,
});

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

const screenInvariantScale = computed(() => 1 / Math.max(viewport.scale || 1, 0.0001));
const screenInvariantTransform = computed(
  () =>
    `scale(${props.round(screenInvariantScale.value, 6)} ${props.round(-screenInvariantScale.value, 6)})`,
);
</script>

<template>
  <div ref="shellRef" class="ros-map-shell">
    <svg
      ref="svgRef"
      class="map-canvas ros-stage"
      :class="{ dragging }"
      :viewBox="`0 0 ${viewport.width || 1000} ${viewport.height || 620}`"
      role="img"
      aria-label="ROS 场景地图"
      @wheel.prevent="handleWheel"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerUp"
      @pointerleave="handlePointerUp"
    >
      <rect
        :width="viewport.width || 1000"
        :height="viewport.height || 620"
        class="ros-canvas-bg"
      />

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
          v-for="trail in peerTrails"
          :key="`trail-${trail.deviceId}`"
          :d="trail.d"
          class="device-trail-line peer"
          :data-tone="trail.tone"
          vector-effect="non-scaling-stroke"
        />

        <path
          v-if="selectedTrailD"
          :d="selectedTrailD"
          class="device-trail-line selected"
          vector-effect="non-scaling-stroke"
        />

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
            <circle
              class="ros-secondary-core"
              cx="0"
              cy="0"
              :r="markerMetrics.peerCore"
              vector-effect="non-scaling-stroke"
            />
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
              <circle
                class="ros-marker-ring"
                :r="markerMetrics.fusionRing"
                vector-effect="non-scaling-stroke"
              />
              <circle
                class="ros-marker-core"
                :r="markerMetrics.fusionCore"
                vector-effect="non-scaling-stroke"
              />
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
              <circle
                class="ros-marker-ring"
                :r="markerMetrics.lidarRing"
                vector-effect="non-scaling-stroke"
              />
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
                :d="
                  buildArrowPath(
                    markerMetrics.arrowHeight * 0.92,
                    markerMetrics.arrowHalfWidth * 0.92,
                  )
                "
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
      <span class="legend-item fusion">
        <i></i>
        融合定位
      </span>
      <span class="legend-item lidar">
        <i></i>
        激光定位
      </span>
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
      <span>当前设备还没有融合定位或激光定位数据，地图仍可用于查看当前场景。</span>
    </div>
  </div>
</template>
