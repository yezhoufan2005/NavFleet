/**
 * Pan/zoom engine for the ROS scene map SVG.
 *
 * The SVG renders in world (map) coordinates and is placed on screen by a single
 * transform derived from `viewport` (`{ width, height, scale, offsetX, offsetY }`).
 * This composable owns that state and every imperative path that mutates it:
 * pointer drag panning, cursor-anchored wheel zoom, container resize handling,
 * scene-change hydration, and the per-scene save/restore of the view.
 *
 * The world coordinate space itself is NOT owned here — the caller passes it in
 * (`effectiveWorldBounds`, `sceneReady`, `worldWidth`, `worldHeight`) because it
 * is derived from the scene definition, the lanelet overlay and the point-cloud
 * backdrop. Everything reactive is injected as refs so this stays a pure state
 * machine over the viewport.
 *
 * `saveViewportState`/`restoreViewportState` live here rather than in
 * `useSceneViewportPersistence` because they are viewport math (they need
 * `getViewportCenter`, `centerWorldPoint`, `getBaseScale` and `clampScale`);
 * only the raw storage read/write is delegated to that module.
 */

import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { ComputedRef } from "vue";
import { useSceneViewportPersistence } from "./useSceneViewportPersistence";

/** Pointer travel (px) beyond which a press counts as a pan, not a click. */
const CLICK_THRESHOLD_PX = 6;

export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface WorldPoint {
  x: number;
  y: number;
}

/** Raw telemetry pose — fields may be absent or null until a fix arrives. */
interface DevicePose {
  x?: number | null;
  y?: number | null;
  yaw?: number | null;
}

interface SelectedDeviceLike {
  deviceId?: string;
  sceneId?: string;
  fusionLoc?: DevicePose | null;
  lidarLoc?: DevicePose | null;
}

/** Only the zoom/default-view knobs of the merged scene are needed here. */
interface ResolvedSceneLike {
  minZoom?: number;
  maxZoom?: number;
  defaultView?: {
    zoom?: number;
    centerX?: number;
    centerY?: number;
  };
}

interface BackgroundLayerLike {
  width: number;
  height: number;
}

export interface UseSvgViewportOptions {
  /** `props.round`, so number formatting stays owned by the component. */
  round: (value: number, digits: number) => number;
  selectedDevice: ComputedRef<SelectedDeviceLike | null>;
  resolvedScene: ComputedRef<ResolvedSceneLike>;
  activeSceneId: ComputedRef<string>;
  effectiveWorldBounds: ComputedRef<WorldBounds | null>;
  sceneReady: ComputedRef<boolean>;
  worldWidth: ComputedRef<number>;
  worldHeight: ComputedRef<number>;
  backgroundLayerDefinition: ComputedRef<BackgroundLayerLike | null>;
  formationPeerDevices: ComputedRef<unknown[]>;
  deviceExtentBounds: ComputedRef<WorldBounds | null>;
}

const hasPose = (pose: DevicePose | null | undefined): boolean =>
  Number.isFinite(pose?.x) && Number.isFinite(pose?.y);

export function useSvgViewport(options: UseSvgViewportOptions) {
  const {
    round,
    selectedDevice,
    resolvedScene,
    activeSceneId,
    effectiveWorldBounds,
    sceneReady,
    worldWidth,
    worldHeight,
    backgroundLayerDefinition,
    formationPeerDevices,
    deviceExtentBounds,
  } = options;

  const { readSavedSceneViews, writeSavedSceneViews } = useSceneViewportPersistence();

  const shellRef = ref<HTMLDivElement | null>(null);
  const svgRef = ref<SVGSVGElement | null>(null);
  const dragging = ref(false);
  const hydratedSceneId = ref("");
  const viewport = reactive({
    width: 1000,
    height: 620,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });

  let resizeObserver: ResizeObserver | null = null;
  let isDragging = false;
  let activePointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let dragMoved = false;

  function getBaseScale(): number {
    if (!sceneReady.value) {
      return 1;
    }
    const fitted = Math.min(viewport.width / worldWidth.value, viewport.height / worldHeight.value);
    return Math.max(fitted * 0.92, 0.0001);
  }

  function getScaleLimits(baseScale = getBaseScale()): { minScale: number; maxScale: number } {
    const scene = resolvedScene.value;
    const minZoom = scene.minZoom ?? 0.75;
    const maxZoom = scene.maxZoom ?? 8;
    return {
      minScale: baseScale * minZoom,
      maxScale: baseScale * maxZoom,
    };
  }

  function clampScale(nextScale: number, baseScale = getBaseScale()): number {
    const limits = getScaleLimits(baseScale);
    return Math.min(Math.max(nextScale, limits.minScale), limits.maxScale);
  }

  function getViewportCenter(
    scale = viewport.scale,
    offsetX = viewport.offsetX,
    offsetY = viewport.offsetY,
  ): WorldPoint | null {
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

  function isWorldPointWithinBounds(
    point: WorldPoint | null,
    bounds: WorldBounds | null = effectiveWorldBounds.value,
  ): boolean {
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

  function saveViewportState(sceneId: string = activeSceneId.value): void {
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

  function restoreViewportState(sceneId: string = activeSceneId.value): boolean {
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
    if (
      !savedView ||
      !savedCenter ||
      !isWorldPointWithinBounds(savedCenter) ||
      !Number.isFinite(Number(savedView.scale))
    ) {
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

  function pointerToWorld(event: MouseEvent): WorldPoint | null {
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
      x: round(worldX, 3),
      y: round(worldY, 3),
    };
  }

  function centerWorldPoint(worldX: number, worldY: number, scale: number): boolean {
    const bounds = effectiveWorldBounds.value;
    if (!sceneReady.value || !bounds || !Number.isFinite(worldX) || !Number.isFinite(worldY)) {
      return false;
    }

    viewport.offsetX = viewport.width / 2 - (worldX - bounds.minX) * scale;
    viewport.offsetY = viewport.height / 2 - (bounds.maxY - worldY) * scale;
    return true;
  }

  function fitWorldBounds(scale: number): void {
    const bounds = effectiveWorldBounds.value;
    if (!sceneReady.value || !bounds) {
      return;
    }

    viewport.scale = scale;
    viewport.offsetX = (viewport.width - worldWidth.value * scale) / 2;
    viewport.offsetY = (viewport.height - worldHeight.value * scale) / 2;
  }

  // Fit the view to an arbitrary world-space region (with padding), clamped to the
  // scene's zoom limits. Used to frame a formation's vehicles.
  function fitToRegion(region: WorldBounds): boolean {
    const width = region.maxX - region.minX;
    const height = region.maxY - region.minY;
    if (!(width > 0) || !(height > 0)) {
      return false;
    }
    const fitted = Math.min(viewport.width / width, viewport.height / height) * 0.82;
    const scale = clampScale(fitted);
    viewport.scale = scale;
    return centerWorldPoint(
      (region.minX + region.maxX) / 2,
      (region.minY + region.maxY) / 2,
      scale,
    );
  }

  function getFocusPose(): WorldPoint | null {
    // `hasPose` has already proven x/y are finite numbers.
    if (hasPose(selectedDevice.value?.fusionLoc)) {
      return selectedDevice.value!.fusionLoc as WorldPoint;
    }
    if (hasPose(selectedDevice.value?.lidarLoc)) {
      return selectedDevice.value!.lidarLoc as WorldPoint;
    }
    return null;
  }

  /**
   * The default view for a scene: the whole scene, framed.
   *
   * It used to end with a 45-metre close-up whenever the selected vehicle had a
   * pose, which computed to `viewport.width / 45` — 22.22x on a 1000px panel.
   * On a 74m x 88m road network that showed about a sixth of it, so the map
   * opened onto a vehicle floating in blank space with the road network out of
   * frame. Framing the scene is what "reset" should mean; the close-up is now an
   * explicit action (`focusSelectedDevice`).
   */
  function resetView(): void {
    if (!sceneReady.value) {
      return;
    }

    const scene = resolvedScene.value;
    const baseScale = getBaseScale();
    const sceneZoom = Number.isFinite(scene.defaultView?.zoom) ? scene.defaultView!.zoom! : 1;
    const nextScale = clampScale(baseScale * sceneZoom, baseScale);
    viewport.scale = nextScale;

    if (
      Number.isFinite(scene.defaultView?.centerX) &&
      Number.isFinite(scene.defaultView?.centerY) &&
      centerWorldPoint(scene.defaultView!.centerX!, scene.defaultView!.centerY!, nextScale)
    ) {
      saveViewportState();
      return;
    }

    fitWorldBounds(nextScale);
    saveViewportState();
  }

  /**
   * Zoom to the selected vehicle — its formation if it has peers on screen,
   * otherwise a fixed-size window around its own pose. Returns false when there
   * is nothing to focus, so a caller can leave the viewport alone.
   */
  function focusSelectedDevice(): boolean {
    if (!sceneReady.value) {
      return false;
    }

    const baseScale = getBaseScale();

    if (formationPeerDevices.value.length && deviceExtentBounds.value) {
      if (fitToRegion(deviceExtentBounds.value)) {
        saveViewportState();
        return true;
      }
    }

    const focusPose = getFocusPose();
    if (!focusPose) {
      return false;
    }

    const FOCUS_WORLD_METERS = 45;
    const focusScale = clampScale(
      Math.max(baseScale * 1.3, viewport.width / FOCUS_WORLD_METERS),
      baseScale,
    );
    viewport.scale = focusScale;
    if (centerWorldPoint(focusPose.x, focusPose.y, focusScale)) {
      saveViewportState();
      return true;
    }
    return false;
  }

  function applyStoredOrDefaultView(sceneId: string = activeSceneId.value): void {
    if (!sceneId || !sceneReady.value) {
      return;
    }

    if (!restoreViewportState(sceneId)) {
      resetView();
    }

    hydratedSceneId.value = sceneId;
  }

  function updateViewportSize(): void {
    const rect = shellRef.value?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) {
      return;
    }
    viewport.width = rect.width;
    viewport.height = rect.height;
  }

  function syncViewportAfterResize(): void {
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

  function handleWheel(event: WheelEvent): void {
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
    viewport.offsetX = event.clientX - rect.left - (worldPoint.x - bounds!.minX) * nextScale;
    viewport.offsetY = event.clientY - rect.top - (bounds!.maxY - worldPoint.y) * nextScale;
    saveViewportState();
  }

  function handlePointerDown(event: PointerEvent): void {
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

  function handlePointerMove(event: PointerEvent): void {
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

  function finishPointerInteraction(event: PointerEvent): void {
    if (!isDragging || event.pointerId !== activePointerId) {
      return;
    }

    isDragging = false;
    activePointerId = null;
    dragging.value = false;
    svgRef.value?.releasePointerCapture?.(event.pointerId);

    if (dragMoved) {
      saveViewportState();
    }
  }

  function handlePointerUp(event: PointerEvent): void {
    finishPointerInteraction(event);
  }

  onMounted(() => {
    updateViewportSize();
    resizeObserver = new ResizeObserver(() => {
      syncViewportAfterResize();
    });
    if (shellRef.value) {
      resizeObserver.observe(shellRef.value);
    }
  });

  onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  watch(
    activeSceneId,
    (sceneId, previousSceneId) => {
      if (sceneId !== previousSceneId) {
        hydratedSceneId.value = "";
      }
    },
    { immediate: true },
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
    { immediate: true },
  );

  watch(
    () => [selectedDevice.value?.deviceId, selectedDevice.value?.sceneId],
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
    },
  );

  return {
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
  };
}
