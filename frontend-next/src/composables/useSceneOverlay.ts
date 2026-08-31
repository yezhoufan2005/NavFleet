/**
 * Async scene assets for the scene map: the lanelet overlay, the scene metadata
 * document, and the rasterized point-cloud backdrop.
 *
 * All three come from the scene definition and are optional — a scene with none of
 * them still renders. Overlay and metadata failures raise a toast (the map degrades
 * gracefully); a point-cloud failure is reported in the map itself through
 * `pointCloudError`, because it is the visible backdrop and its absence is what the
 * operator is looking at.
 *
 * **All three loads are guarded by a monotonic request id**, so a slow load for a
 * scene you have already left can never overwrite the current one — nor raise a toast
 * about a scene that is no longer on screen.
 *
 * **The palette is watched along with the scene**, which the v1.0.0 version had no
 * reason to do because its colours were hardcoded. Rasterizing bakes the colours
 * into a PNG, so a theme switch has to produce a new one — and the cache in
 * `pointCloudBackdrop.ts` keys on the palette so that it does.
 */

import { onBeforeUnmount, ref, watch } from "vue";
import type { Ref } from "vue";
import type { LaneletOverlay, SceneMapDefinition } from "@navfleet/shared";
import { loadPointCloudBackdrop } from "@/lib/pointCloudBackdrop";
import type {
  PointCloudBackdrop,
  PointCloudPalette,
} from "@/lib/pointCloudBackdrop";
import { notify } from "./useNotifications";

type ScenePart = Partial<SceneMapDefinition>;

export interface UseSceneOverlayResult {
  overlay: Ref<LaneletOverlay | null>;
  metadata: Ref<ScenePart | null>;
  pointCloudBackdrop: Ref<PointCloudBackdrop | null>;
  pointCloudError: Ref<string>;
}

export function useSceneOverlay(
  getSceneDefinition: () => ScenePart | null | undefined,
  getPalette: () => PointCloudPalette,
): UseSceneOverlayResult {
  const overlay = ref<LaneletOverlay | null>(null);
  const metadata = ref<ScenePart | null>(null);
  const pointCloudBackdrop = ref<PointCloudBackdrop | null>(null);
  const pointCloudError = ref("");

  let overlayRequestId = 0;
  let metadataRequestId = 0;
  let pointCloudRequestId = 0;

  const loadJson = async <T>(url: string): Promise<T> => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  };

  async function loadOverlay(url?: string): Promise<void> {
    const requestId = ++overlayRequestId;
    if (!url) {
      overlay.value = null;
      return;
    }
    try {
      const result = await loadJson<LaneletOverlay>(url);
      if (requestId !== overlayRequestId) return;
      overlay.value = result;
    } catch {
      if (requestId !== overlayRequestId) return;
      overlay.value = null;
      notify("路网覆盖层加载失败，地图将不显示车道线。", {
        type: "warning",
        dedupeKey: "ros-overlay-failed",
      });
    }
  }

  async function loadMetadata(url?: string): Promise<void> {
    const requestId = ++metadataRequestId;
    if (!url) {
      metadata.value = null;
      return;
    }
    try {
      const result = await loadJson<ScenePart>(url);
      if (requestId !== metadataRequestId) return;
      metadata.value = result;
    } catch {
      if (requestId !== metadataRequestId) return;
      metadata.value = null;
      notify("场景元数据加载失败，地图可能无法正确定位。", {
        type: "warning",
        dedupeKey: "ros-metadata-failed",
      });
    }
  }

  async function loadPointCloud(scene: ScenePart): Promise<void> {
    const requestId = ++pointCloudRequestId;

    if (!scene?.pointCloudUrl) {
      pointCloudBackdrop.value = null;
      pointCloudError.value = "";
      return;
    }

    try {
      pointCloudError.value = "";
      const result = await loadPointCloudBackdrop(scene, getPalette());
      if (requestId !== pointCloudRequestId) return;
      pointCloudBackdrop.value = result;
    } catch (error) {
      if (requestId !== pointCloudRequestId) return;
      pointCloudBackdrop.value = null;
      pointCloudError.value =
        error instanceof Error ? error.message : "点云背景加载失败";
    }
  }

  watch(
    () => getSceneDefinition()?.overlayUrl,
    (url) => {
      void loadOverlay(url);
    },
    { immediate: true },
  );

  watch(
    () => getSceneDefinition()?.metadataUrl,
    (url) => {
      void loadMetadata(url);
    },
    { immediate: true },
  );

  watch(
    () => {
      const scene = getSceneDefinition();
      const palette = getPalette();
      return [
        scene?.sceneId,
        scene?.pointCloudUrl,
        scene?.pointCloudMetaUrl,
        scene?.resolution,
        scene?.width,
        scene?.height,
        scene?.origin?.x,
        scene?.origin?.y,
        // See the header: the colours are baked into the raster, so the theme is
        // part of what identifies the image to draw.
        palette.obstacle.join(","),
        palette.floor.join(","),
      ];
    },
    () => {
      void loadPointCloud(getSceneDefinition() || {});
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    // Invalidate whatever is still in flight rather than letting it resolve into a
    // ref nobody is rendering.
    overlayRequestId += 1;
    metadataRequestId += 1;
    pointCloudRequestId += 1;
  });

  return { overlay, metadata, pointCloudBackdrop, pointCloudError };
}
