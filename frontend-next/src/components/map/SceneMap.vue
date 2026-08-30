<script setup lang="ts">
/**
 * The scene (ROS) map: a world-coordinate SVG with a point-cloud or image backdrop,
 * the Lanelet2 road network, vehicle markers and their trails.
 *
 * Ported from v1.0.0's `RosSceneMap.vue`, with three differences worth knowing:
 *
 * - **It takes the fleet from the store's shapes, not from function props.** The old
 *   component received `getDeviceTone` and `round` as props because the dashboard
 *   owned them; both now live in `@navfleet/fleet-core` and are imported directly.
 * - **Colours come from tokens** in a scoped stylesheet rather than a global
 *   `map-overlays.css`, so the map follows the theme like everything else. The
 *   point-cloud backdrop is the exception that proves the rule: it is a PNG, so its
 *   two colours have to be read out and re-rasterized (`usePointCloudPalette`).
 * - **The marker structure is preserved exactly**, down to the class names. The
 *   Playwright suite measures the selected vehicle's screen position by reading
 *   `.ros-marker.fusion .ros-marker-core` inside `.map-surface svg`, and that
 *   assertion is the only thing standing between "the map opens on the vehicle" and
 *   a regression nobody notices. `.ros-marker-core` must stay a shape centred on 0,0
 *   inside the pose-translated group.
 */
import { computed } from "vue";
import type { DeviceSnapshot, SceneMapDefinition } from "@navfleet/shared";
import { getDeviceTone, round } from "@navfleet/fleet-core";
import { useSceneOverlay } from "@/composables/useSceneOverlay";
import { useSvgViewport } from "@/composables/useSvgViewport";
import type { WorldBounds, WorldPoint } from "@/composables/useSvgViewport";
import { usePointCloudPalette } from "@/composables/usePointCloudPalette";

/**
 * Either a known scene definition or the loose record the store produces after
 * merging a backend document into it. Intersecting with `Record<string, unknown>`
 * would demand an index signature the shared type does not have, so it is a union.
 */
type ScenePart =
  SceneMapDefinition | (Partial<SceneMapDefinition> & Record<string, unknown>);
type Pose = { x?: number | null; y?: number | null; yaw?: number | null };

/**
 * `readonly` because this component only ever reads a trail. Playback hands over the
 * array it maintains incrementally (`useHistoryPlayback` exposes it through
 * `readonly()`), and requiring a mutable one here would force a copy per frame — the
 * exact cost that composable exists to avoid.
 */
type Trail = readonly { x: number; y: number }[];

const { selectedDevice, sceneDefinition, sceneDevices, trails } = defineProps<{
  selectedDevice: DeviceSnapshot | null;
  sceneDefinition: ScenePart | null;
  sceneDevices: DeviceSnapshot[];
  trails: Record<string, Trail>;
}>();

const hasPose = (pose: Pose | null | undefined): boolean =>
  Number.isFinite(pose?.x) && Number.isFinite(pose?.y);

const hasBounds = (bounds: Partial<WorldBounds> | null | undefined): boolean =>
  Number.isFinite(bounds?.minX) &&
  Number.isFinite(bounds?.maxX) &&
  Number.isFinite(bounds?.minY) &&
  Number.isFinite(bounds?.maxY) &&
  (bounds as WorldBounds).maxX > (bounds as WorldBounds).minX &&
  (bounds as WorldBounds).maxY > (bounds as WorldBounds).minY;

const { getPalette } = usePointCloudPalette();
const { overlay, metadata, pointCloudBackdrop, pointCloudError } =
  useSceneOverlay(() => sceneDefinition, getPalette);

/**
 * Scene definition + the metadata document, merged, with `bounds` derived from
 * width/height/resolution when the scene does not state them outright.
 */
const mergeScene = (base: ScenePart, override: ScenePart): ScenePart => {
  const merged: ScenePart = {
    ...base,
    ...override,
    origin: { ...(base.origin ?? {}), ...(override.origin ?? {}) },
    defaultView:
      base.defaultView || override.defaultView
        ? { ...(base.defaultView ?? {}), ...(override.defaultView ?? {}) }
        : undefined,
  } as ScenePart;

  if (
    !merged.bounds &&
    Number.isFinite(merged.width) &&
    Number.isFinite(merged.height) &&
    Number.isFinite(merged.resolution)
  ) {
    const originX = merged.origin?.x ?? 0;
    const originY = merged.origin?.y ?? 0;
    merged.bounds = {
      minX: originX,
      maxX: originX + (merged.width as number) * (merged.resolution as number),
      minY: originY,
      maxY: originY + (merged.height as number) * (merged.resolution as number),
    };
  }

  return merged;
};

const resolvedScene = computed(() =>
  mergeScene(sceneDefinition ?? {}, (metadata.value ?? {}) as ScenePart),
);
const activeSceneId = computed(
  () =>
    (resolvedScene.value.sceneId as string) || sceneDefinition?.sceneId || "",
);
const boundsOf = (candidate: unknown): WorldBounds | null =>
  hasBounds(candidate as WorldBounds) ? (candidate as WorldBounds) : null;

const sceneBounds = computed(() => boundsOf(resolvedScene.value.bounds));
const overlayBounds = computed(() => boundsOf(overlay.value?.bounds));
const pointCloudBounds = computed(() =>
  boundsOf(pointCloudBackdrop.value?.bounds),
);

interface BackgroundLayer extends WorldBounds {
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const imageLayer = computed<BackgroundLayer | null>(() => {
  const scene = resolvedScene.value;
  if (!scene.imageUrl) return null;
  if (
    !Number.isFinite(scene.origin?.x) ||
    !Number.isFinite(scene.origin?.y) ||
    !Number.isFinite(scene.width) ||
    !Number.isFinite(scene.height) ||
    !Number.isFinite(scene.resolution)
  ) {
    return null;
  }

  const width = (scene.width as number) * (scene.resolution as number);
  const height = (scene.height as number) * (scene.resolution as number);
  const x = scene.origin!.x;
  const y = scene.origin!.y;
  return {
    href: scene.imageUrl,
    x,
    y,
    width,
    height,
    minX: x,
    maxX: x + width,
    minY: y,
    maxY: y + height,
  };
});

const pointCloudLayer = computed<BackgroundLayer | null>(() => {
  const bounds = pointCloudBounds.value;
  const dataUrl = pointCloudBackdrop.value?.dataUrl;
  if (!resolvedScene.value.pointCloudUrl || !dataUrl || !bounds) return null;
  return {
    href: dataUrl,
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    ...bounds,
  };
});

const backgroundLayerDefinition = computed(
  () => pointCloudLayer.value ?? imageLayer.value,
);
const unionBounds = (...list: (WorldBounds | null)[]): WorldBounds | null => {
  const valid = list.filter((bounds): bounds is WorldBounds => !!bounds);
  const first = valid[0];
  if (!first) return null;
  return valid.reduce(
    (accumulator, bounds) => ({
      minX: Math.min(accumulator.minX, bounds.minX),
      maxX: Math.max(accumulator.maxX, bounds.maxX),
      minY: Math.min(accumulator.minY, bounds.minY),
      maxY: Math.max(accumulator.maxY, bounds.maxY),
    }),
    { ...first },
  );
};

/**
 * The world space is the **static** map extent (backdrop / road network /
 * configured bounds). It stays put while vehicles move, so the view never jitters;
 * keeping a vehicle on screen is the job of `focusSelectedDevice`, not of the world.
 */
const effectiveWorldBounds = computed<WorldBounds | null>(() => {
  const background = boundsOf(backgroundLayerDefinition.value);
  if (overlayBounds.value && !background) return overlayBounds.value;
  return (
    unionBounds(background, sceneBounds.value, overlayBounds.value) ??
    sceneBounds.value ??
    overlayBounds.value
  );
});

const sceneReady = computed(() => hasBounds(effectiveWorldBounds.value));
const worldWidth = computed(() =>
  sceneReady.value
    ? effectiveWorldBounds.value!.maxX - effectiveWorldBounds.value!.minX
    : 0,
);
const worldHeight = computed(() =>
  sceneReady.value
    ? effectiveWorldBounds.value!.maxY - effectiveWorldBounds.value!.minY
    : 0,
);

/** Marker sizes in screen pixels — see `screenInvariantTransform`. */
const MARKER = {
  fusionRing: 24,
  fusionCore: 10,
  lidarRing: 20,
  lidarCore: 8,
  arrowHeight: 30,
  arrowHalfWidth: 10,
  peerCore: 7,
} as const;

const buildWorldPath = (points: Trail): string =>
  (Array.isArray(points) ? points : [])
    .map((point, index) =>
      Number.isFinite(point?.x) && Number.isFinite(point?.y)
        ? `${index === 0 ? "M" : "L"} ${round(point.x, 3)} ${round(point.y, 3)}`
        : "",
    )
    .filter(Boolean)
    .join(" ");

const buildArrowPath = (height: number, halfWidth: number): string =>
  `M 0 ${-height} L ${halfWidth} ${-halfWidth} L ${-halfWidth} ${-halfWidth} Z`;
const laneletPaths = computed(() =>
  (overlay.value?.lanelets ?? []).map((lanelet) => ({
    id: lanelet.id,
    leftPath: buildWorldPath(lanelet.left as { x: number; y: number }[]),
    rightPath: buildWorldPath(lanelet.right as { x: number; y: number }[]),
    centerPath: buildWorldPath(
      lanelet.centerline as { x: number; y: number }[],
    ),
  })),
);

const selectedFusionPoint = computed<WorldPoint | null>(() =>
  hasPose(selectedDevice?.fusionLoc)
    ? (selectedDevice!.fusionLoc as WorldPoint)
    : null,
);
const selectedLidarPoint = computed<WorldPoint | null>(() =>
  hasPose(selectedDevice?.lidarLoc)
    ? (selectedDevice!.lidarLoc as WorldPoint)
    : null,
);

const formationPeerDevices = computed(() =>
  (Array.isArray(sceneDevices) ? sceneDevices : [])
    .filter(
      (device) =>
        device?.deviceId && device.deviceId !== selectedDevice?.deviceId,
    )
    .map((device) => {
      const pose = hasPose(device.fusionLoc)
        ? device.fusionLoc
        : hasPose(device.lidarLoc)
          ? device.lidarLoc
          : null;
      if (!pose) return null;
      return {
        deviceId: device.deviceId,
        deviceName: device.deviceName || device.deviceId,
        pose: pose as WorldPoint,
        tone: getDeviceTone(device),
      };
    })
    .filter((peer): peer is NonNullable<typeof peer> => peer !== null),
);

/** Every drawn pose, padded — what "frame this formation" fits to. */
const deviceExtentBounds = computed<WorldBounds | null>(() => {
  const points: WorldPoint[] = [];
  if (selectedFusionPoint.value) points.push(selectedFusionPoint.value);
  if (selectedLidarPoint.value) points.push(selectedLidarPoint.value);
  formationPeerDevices.value.forEach((peer) => points.push(peer.pose));
  if (!points.length) return null;

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
/** Screen-up heading: telemetry yaw is radians counter-clockwise from +x. */
const headingOf = (pose: Pose | null): number =>
  Number.isFinite(pose?.yaw)
    ? 90 - round(((pose!.yaw as number) * 180) / Math.PI, 1)
    : 0;

const selectedFusionAngle = computed(() =>
  headingOf(selectedDevice?.fusionLoc ?? null),
);
const selectedLidarAngle = computed(() =>
  headingOf(selectedDevice?.lidarLoc ?? null),
);

const connectorPath = computed(() =>
  selectedFusionPoint.value && selectedLidarPoint.value
    ? buildWorldPath([selectedFusionPoint.value, selectedLidarPoint.value])
    : "",
);

const selectedTrailD = computed(() => {
  const deviceId = selectedDevice?.deviceId;
  return deviceId ? buildWorldPath(trails?.[deviceId] ?? []) : "";
});

const peerTrails = computed(() =>
  formationPeerDevices.value
    .map((peer) => ({
      deviceId: peer.deviceId,
      tone: peer.tone,
      d: buildWorldPath(trails?.[peer.deviceId] ?? []),
    }))
    .filter((trail) => trail.d),
);

// The pan/zoom engine, declared after the world bounds and the peer list because its
// hydration watch runs immediately and reads them.
const {
  viewport,
  shellRef,
  svgRef,
  dragging,
  resetView,
  focusSelectedDevice,
  handleWheel,
  handlePointerDown,
  handlePointerMove,
  handlePointerUp,
} = useSvgViewport({
  round,
  selectedDevice: computed(() => selectedDevice),
  resolvedScene: resolvedScene as never,
  activeSceneId,
  effectiveWorldBounds,
  sceneReady,
  worldWidth,
  worldHeight,
  backgroundLayerDefinition,
  formationPeerDevices,
  deviceExtentBounds,
});

/**
 * Function refs rather than `ref="shellRef"`.
 *
 * The string form works at runtime, but `vue-tsc` does not link it to the setup
 * variable, so both refs read as unused locals under `noUnusedLocals` — and silencing
 * that with a `void` reference would be a comment where a binding belongs. These are
 * ordinary Vue function refs: explicit, typed, and a real use.
 */
const bindShell = (el: unknown): void => {
  shellRef.value = (el as HTMLDivElement | null) ?? null;
};
const bindSvg = (el: unknown): void => {
  svgRef.value = (el as SVGSVGElement | null) ?? null;
};

/** World → screen. The negative y scale is what makes the map y-up. */
const stageTransform = computed(() => {
  const bounds = effectiveWorldBounds.value;
  if (!sceneReady.value || !bounds) return "";
  return [
    `translate(${round(viewport.offsetX, 2)} ${round(viewport.offsetY, 2)})`,
    `scale(${viewport.scale} ${-viewport.scale})`,
    `translate(${-round(bounds.minX, 4)} ${-round(bounds.maxY, 4)})`,
  ].join(" ");
});

const scaleLabel = computed(() => `${round(viewport.scale, 2)}x`);

/** ` · 128 段` when the overlay reports a count, empty when it does not. */
const laneletCountLabel = computed(() => {
  const count = overlay.value?.stats?.laneletCount;
  return Number.isFinite(count) ? ` · ${count} 段` : "";
});

/**
 * Undoes the stage scale for a marker's contents, so a vehicle stays the same size
 * on screen at every zoom — and flips y back, or the labels render mirrored.
 */
const screenInvariantTransform = computed(() => {
  const inverse = 1 / Math.max(viewport.scale || 1, 0.0001);
  return `scale(${round(inverse, 6)} ${round(-inverse, 6)})`;
});
</script>

<template>
  <div :ref="bindShell" class="relative min-h-0 flex-1 overflow-hidden">
    <svg
      :ref="bindSvg"
      class="ros-stage block size-full touch-none select-none"
      :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
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

      <g v-if="sceneReady && effectiveWorldBounds" :transform="stageTransform">
        <rect
          :x="effectiveWorldBounds.minX"
          :y="effectiveWorldBounds.minY"
          :width="worldWidth"
          :height="worldHeight"
          class="ros-world-bg"
        />

        <!-- Flipped back upright: the stage scales y by -1, and an image drawn under
             that transform would otherwise appear upside down. -->
        <image
          v-if="backgroundLayerDefinition"
          :href="backgroundLayerDefinition.href"
          x="0"
          y="0"
          :width="backgroundLayerDefinition.width"
          :height="backgroundLayerDefinition.height"
          preserveAspectRatio="none"
          :transform="`translate(${round(backgroundLayerDefinition.x, 3)} ${round(
            backgroundLayerDefinition.y + backgroundLayerDefinition.height,
            3,
          )}) scale(1 -1)`"
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
          class="ros-world-frame"
          vector-effect="non-scaling-stroke"
        />

        <path
          v-for="trail in peerTrails"
          :key="`trail-${trail.deviceId}`"
          :d="trail.d"
          class="device-trail peer"
          :data-tone="trail.tone"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-if="selectedTrailD"
          :d="selectedTrailD"
          class="device-trail selected"
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
          :transform="`translate(${round(peer.pose.x, 2)} ${round(peer.pose.y, 2)})`"
        >
          <g :transform="screenInvariantTransform">
            <circle
              class="ros-secondary-core"
              cx="0"
              cy="0"
              :r="MARKER.peerCore"
              vector-effect="non-scaling-stroke"
            />
            <text class="ros-secondary-label" x="0" y="-16">
              {{ peer.deviceName }}
            </text>
          </g>
        </g>

        <!-- `.ros-marker.fusion .ros-marker-core` is an e2e contract: the suite reads
             its screen box to prove the map opened on the selected vehicle. It has to
             stay a shape centred on 0,0 inside the pose-translated group. -->
        <g
          v-if="selectedFusionPoint"
          class="ros-marker fusion"
          :transform="`translate(${round(selectedFusionPoint.x, 2)} ${round(
            selectedFusionPoint.y,
            2,
          )})`"
        >
          <g :transform="screenInvariantTransform">
            <g :transform="`rotate(${selectedFusionAngle})`">
              <circle
                class="ros-marker-ring"
                :r="MARKER.fusionRing"
                vector-effect="non-scaling-stroke"
              />
              <circle
                class="ros-marker-core"
                :r="MARKER.fusionCore"
                vector-effect="non-scaling-stroke"
              />
              <path
                class="ros-marker-arrow"
                :d="buildArrowPath(MARKER.arrowHeight, MARKER.arrowHalfWidth)"
                vector-effect="non-scaling-stroke"
              />
            </g>
          </g>
        </g>

        <g
          v-if="selectedLidarPoint"
          class="ros-marker lidar"
          :transform="`translate(${round(selectedLidarPoint.x, 2)} ${round(
            selectedLidarPoint.y,
            2,
          )})`"
        >
          <g :transform="screenInvariantTransform">
            <g :transform="`rotate(${selectedLidarAngle})`">
              <circle
                class="ros-marker-ring"
                :r="MARKER.lidarRing"
                vector-effect="non-scaling-stroke"
              />
              <rect
                class="ros-marker-core"
                :x="-MARKER.lidarCore"
                :y="-MARKER.lidarCore"
                :width="MARKER.lidarCore * 2"
                :height="MARKER.lidarCore * 2"
                rx="3"
                ry="3"
                transform="rotate(45)"
                vector-effect="non-scaling-stroke"
              />
              <path
                class="ros-marker-arrow"
                :d="
                  buildArrowPath(
                    MARKER.arrowHeight * 0.92,
                    MARKER.arrowHalfWidth * 0.92,
                  )
                "
                vector-effect="non-scaling-stroke"
              />
            </g>
          </g>
        </g>
      </g>
    </svg>

    <div
      class="pointer-events-none absolute top-2 left-2 flex gap-2 font-mono text-2xs"
    >
      <span class="rounded-xs bg-surface-raised/85 px-2 py-1 text-ink-muted">
        场景
        <strong class="ml-1 text-ink">{{
          resolvedScene.sceneName || resolvedScene.sceneId || "--"
        }}</strong>
      </span>
      <span class="rounded-xs bg-surface-raised/85 px-2 py-1 text-ink-muted">
        缩放 <strong class="ml-1 text-ink">{{ scaleLabel }}</strong>
      </span>
    </div>

    <div class="absolute top-2 right-2 flex gap-2">
      <button type="button" class="map-btn" @click="resetView">适应场景</button>
      <button type="button" class="map-btn" @click="focusSelectedDevice">
        定位车辆
      </button>
    </div>

    <ul
      class="pointer-events-none absolute bottom-2 left-2 m-0 flex list-none flex-wrap gap-3 p-0 text-2xs text-ink-muted"
    >
      <!-- The count is the overlay's own `stats.laneletCount`, which v1.0.0 carried
           in the payload and rendered nowhere. It answers a question the legend
           otherwise cannot: whether the overlay loaded *fully*. -->
      <li v-if="laneletPaths.length" class="legend">
        <i class="lanelet" />路网覆盖{{ laneletCountLabel }}
      </li>
      <li v-if="resolvedScene.pointCloudUrl" class="legend">
        <i class="cloud" />点云背景
      </li>
      <li class="legend"><i class="fusion" />融合定位</li>
      <li class="legend"><i class="lidar" />激光定位</li>
    </ul>

    <!-- The backdrop is what the operator is looking at, so its failure belongs on
         the map rather than in a toast that scrolls away. -->
    <p
      v-if="pointCloudError"
      class="absolute right-2 bottom-2 m-0 max-w-80 rounded-sm border border-critical bg-critical-wash px-3 py-2 text-xs text-critical-ink"
      role="status"
    >
      <strong class="block">点云背景加载失败</strong>
      {{ pointCloudError }}
    </p>

    <div
      v-if="!sceneReady"
      class="absolute inset-0 grid place-content-center gap-1 bg-surface/80 px-6 text-center"
    >
      <strong class="text-md text-ink">暂无可用地图</strong>
      <span class="text-sm text-ink-muted"
        >当前场景缺少有效的地图元数据，请先补齐场景配置或地图资源。</span
      >
    </div>
    <div
      v-else-if="!selectedFusionPoint && !selectedLidarPoint"
      class="pointer-events-none absolute inset-x-0 top-1/2 grid -translate-y-1/2 place-items-center gap-1 px-6 text-center"
    >
      <strong class="text-md text-ink">暂无场景位姿</strong>
      <span class="text-sm text-ink-muted"
        >当前设备还没有融合定位或激光定位数据，地图仍可用于查看当前场景。</span
      >
    </div>
  </div>
</template>

<style scoped>
/*
 * Scoped CSS rather than utility classes, for two reasons that are specific to SVG:
 * the tone-driven variants would need a literal Tailwind class per tone (and Tailwind
 * only sees literal strings), and `vector-effect` plus stroke geometry has no utility
 * equivalent. Every value is a token, so the map follows the theme like everything
 * else — there is no `dark:` here and there should not be.
 */
.ros-canvas-bg {
  fill: var(--color-ros-canvas);
}
.ros-world-bg {
  fill: var(--color-ros-free);
  opacity: 0.35;
}
.ros-world-frame {
  fill: none;
  stroke: var(--color-map-grid);
  stroke-width: 1;
}

.lanelet-edge {
  fill: none;
  stroke: var(--color-ros-lanelet-line);
  stroke-width: 1.5;
}
.lanelet-centerline {
  fill: none;
  stroke: var(--color-ros-lanelet-center);
  stroke-width: 1;
  stroke-dasharray: 6 5;
}

.ros-link-line {
  fill: none;
  stroke: var(--color-ros-link);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

.device-trail {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.device-trail.selected {
  stroke: var(--color-brand);
  opacity: 0.9;
}
.device-trail.peer {
  stroke: var(--color-offline);
  opacity: 0.55;
}
.device-trail.peer[data-tone="critical"] {
  stroke: var(--color-critical);
}
.device-trail.peer[data-tone="warning"] {
  stroke: var(--color-warning);
}
.device-trail.peer[data-tone="notice"] {
  stroke: var(--color-notice);
}
.device-trail.peer[data-tone="normal"] {
  stroke: var(--color-brand);
}

.ros-marker-ring {
  fill: none;
  stroke: var(--color-brand);
  stroke-width: 1.5;
  opacity: 0.55;
}
.ros-marker-core {
  fill: var(--color-brand);
  stroke: var(--color-surface-raised);
  stroke-width: 2;
}
.ros-marker-arrow {
  fill: var(--color-brand);
  opacity: 0.85;
}
.ros-marker.lidar .ros-marker-ring,
.ros-marker.lidar .ros-marker-arrow {
  stroke: var(--color-notice);
  fill: none;
}
.ros-marker.lidar .ros-marker-arrow {
  fill: var(--color-notice);
}
.ros-marker.lidar .ros-marker-core {
  fill: var(--color-notice);
}

.ros-secondary-core {
  fill: var(--color-offline);
  stroke: var(--color-surface-raised);
  stroke-width: 1.5;
}
.ros-secondary-marker[data-tone="critical"] .ros-secondary-core {
  fill: var(--color-critical);
}
.ros-secondary-marker[data-tone="warning"] .ros-secondary-core {
  fill: var(--color-warning);
}
.ros-secondary-marker[data-tone="notice"] .ros-secondary-core {
  fill: var(--color-notice);
}
.ros-secondary-marker[data-tone="normal"] .ros-secondary-core {
  fill: var(--color-brand);
}
.ros-secondary-label {
  fill: var(--color-ink-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  text-anchor: middle;
}

.map-btn {
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-xs);
  background: var(--color-surface-raised);
  color: var(--color-ink-muted);
  font-size: var(--text-xs);
  padding: 4px 10px;
  transition: color 150ms var(--ease-standard);
}
.map-btn:hover {
  color: var(--color-ink);
}

.legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend i {
  display: block;
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full, 999px);
}
.legend i.lanelet {
  background: var(--color-ros-lanelet-line);
}
.legend i.cloud {
  background: var(--color-ros-cloud-obstacle);
}
.legend i.fusion {
  background: var(--color-brand);
}
.legend i.lidar {
  background: var(--color-notice);
}
</style>
