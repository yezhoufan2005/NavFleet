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
  /**
   * False until `updateViewportSize` has read a real panel size. `viewport`'s
   * initial 1000x620 is a placeholder, and any view computed against it is wrong
   * for the panel the user is actually looking at — see `applyStoredOrDefaultView`.
   */
  let hasMeasuredPanel = false;

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
   * The smallest region centred on `pose` that still contains all of `extent`.
   *
   * Fitting the raw extent of every drawn pose frames the *formation*, which is
   * not what "locate this vehicle" means: if the selected vehicle sits at one
   * edge of the spread, it ends up against the edge of the panel — measured at
   * 262px from centre in a 637px-wide panel, which is what made the button look
   * broken. Mirroring the extent about the vehicle's own pose puts the vehicle
   * dead centre and still keeps every peer on screen; the cost is a slightly
   * wider view than the tight bounding box would give.
   */
  function regionCenteredOn(pose: WorldPoint, extent: WorldBounds): WorldBounds {
    const halfWidth = Math.max(pose.x - extent.minX, extent.maxX - pose.x);
    const halfHeight = Math.max(pose.y - extent.minY, extent.maxY - pose.y);
    return {
      minX: pose.x - halfWidth,
      maxX: pose.x + halfWidth,
      minY: pose.y - halfHeight,
      maxY: pose.y + halfHeight,
    };
  }

  /**
   * Zoom to the selected vehicle — centred on its own pose, wide enough to keep
   * its formation peers on screen when it has any, otherwise a fixed-size window
   * around it. Returns false when there is nothing to focus, so a caller can
   * leave the viewport alone.
   */
  function focusSelectedDevice(): boolean {
    if (!sceneReady.value) {
      return false;
    }

    const baseScale = getBaseScale();
    const focusPose = getFocusPose();

    if (!focusPose) {
      // No pose for the selected vehicle. Framing its formation is still more
      // useful than doing nothing, so fall back to that when peers are drawn.
      if (formationPeerDevices.value.length && deviceExtentBounds.value) {
        if (fitToRegion(deviceExtentBounds.value)) {
          saveViewportState();
          return true;
        }
      }
      return false;
    }

    if (formationPeerDevices.value.length && deviceExtentBounds.value) {
      if (fitToRegion(regionCenteredOn(focusPose, deviceExtentBounds.value))) {
        saveViewportState();
        return true;
      }
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

  /**
   * Apply the view a scene should open with: the one this tab last left, else
   * the selected vehicle located on the map, else the whole scene framed.
   *
   * Locating the vehicle before falling back to the scene fit is deliberate.
   * Opening on the whole scene left the vehicle wherever it happened to be —
   * measured 276px off-centre and 59px from the right edge — so the first thing
   * an operator did on every visit was hunt for it and click 定位车辆. Note this
   * is *not* a return to the pre-Phase-9 behaviour: `resetView` (适应场景) still
   * fits the scene, which is what that button should mean; only the initial view
   * changed.
   */
  function applyStoredOrDefaultView(sceneId: string = activeSceneId.value): void {
    // `hasMeasuredPanel` is the important guard, and it fixes the defect that
    // made this whole path look broken. The bounds watcher below runs with
    // `immediate: true`, i.e. during setup, before `onMounted` has measured the
    // panel — so the view used to be computed against the 1000x620 placeholder
    // size. `updateViewportSize` then overwrote width/height *without* touching
    // the offsets, silently invalidating it, and the ResizeObserver pass that
    // followed derived its "previous centre" from that already-inconsistent
    // state and faithfully preserved the wrong thing. Traced end to end: the
    // vehicle was centred for a 1000x620 panel and ended up 274px off-centre in
    // the real 637x802 one. Deferring until the panel is measured (onMounted
    // hydrates straight after) is what makes the first view correct.
    if (!sceneId || !sceneReady.value || !hasMeasuredPanel) {
      return;
    }

    if (!restoreViewportState(sceneId) && !focusSelectedDevice()) {
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
    hasMeasuredPanel = true;
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

  /**
   * Hold the view still when the world origin moves.
   *
   * `stageTransform` places the scene as `offset + (worldX - bounds.minX) *
   * scale`, so the offsets are anchored to `bounds.minX` / `bounds.maxY`. When the
   * lanelet overlay finishes loading and widens `effectiveWorldBounds`, that
   * anchor moves and every pixel slides by the delta — the view silently pans away
   * from whatever it was centred on, and the bounds watcher then *saves* the
   * drifted result. Measured as a 199px drift in a 637px-wide panel immediately
   * after the initial focus: the vehicle was centred, the overlay arrived, and it
   * ended up a third of the panel off-centre, which read as "the map never located
   * the vehicle at all".
   *
   * The correction is a pure translation, derived from holding the screen position
   * of any world point constant across the anchor change.
   */
  function rebaseOffsetsToBounds(previousMinX: number, previousMaxY: number): void {
    const bounds = effectiveWorldBounds.value;
    if (!bounds) {
      return;
    }
    viewport.offsetX += (bounds.minX - previousMinX) * viewport.scale;
    viewport.offsetY -= (bounds.maxY - previousMaxY) * viewport.scale;
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
    // First chance to hydrate against a real panel size: the bounds watcher ran
    // during setup and deliberately skipped, because back then the panel was
    // still the 1000x620 placeholder.
    if (hydratedSceneId.value !== activeSceneId.value) {
      applyStoredOrDefaultView(activeSceneId.value);
    }
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
    (next, previous) => {
      if (!sceneReady.value || !activeSceneId.value) {
        return;
      }

      // Same scene, already hydrated, but the world origin moved: hold the view
      // still rather than letting it slide. See `rebaseOffsetsToBounds`.
      const previousMinX = previous?.[3];
      const previousMaxY = previous?.[6];
      if (
        next[0] === previous?.[0] &&
        hydratedSceneId.value === activeSceneId.value &&
        typeof previousMinX === "number" &&
        typeof previousMaxY === "number"
      ) {
        rebaseOffsetsToBounds(previousMinX, previousMaxY);
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

      // Picking another vehicle in the same scene: locate the one just selected.
      // This used to re-fit the whole scene, which answered a question nobody
      // asked — you clicked a specific vehicle, so that vehicle is what the map
      // should show. Falls back to the scene fit when the new selection has no
      // pose yet.
      if (previousDeviceId && nextDeviceId !== previousDeviceId && !focusSelectedDevice()) {
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
