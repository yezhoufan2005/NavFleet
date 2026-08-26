/**
 * Async scene assets for the ROS scene map: the lanelet overlay, the scene
 * metadata document, and the rasterized point-cloud backdrop.
 *
 * All three are fetched from the scene definition and are optional — a scene
 * with none of them still renders. Overlay/metadata failures are surfaced as a
 * toast (the map degrades gracefully); a point-cloud failure is surfaced in the
 * map itself via `pointCloudError`, because it is the visible backdrop.
 *
 * Point-cloud loads are guarded by a monotonic request id so a slow load for a
 * previous scene can never overwrite the current one.
 */

import { onBeforeUnmount, ref, watch } from "vue";
import type { Ref } from "vue";
import type { LaneletOverlay, SceneMapDefinition } from "@navfleet/shared";
import { loadPointCloudBackdrop } from "../utils/point-cloud";
import type { PointCloudBackdrop } from "../utils/point-cloud";
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
): UseSceneOverlayResult {
  const overlay = ref<LaneletOverlay | null>(null);
  const metadata = ref<ScenePart | null>(null);
  const pointCloudBackdrop = ref<PointCloudBackdrop | null>(null);
  const pointCloudError = ref("");

  let pointCloudRequestId = 0;

  async function loadOverlay(url?: string): Promise<void> {
    if (!url) {
      overlay.value = null;
      return;
    }

    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      overlay.value = (await response.json()) as LaneletOverlay;
    } catch (_error) {
      overlay.value = null;
      notify("路网覆盖层加载失败，地图将不显示车道线。", {
        type: "warning",
        dedupeKey: "ros-overlay-failed",
      });
    }
  }

  async function loadMetadata(url?: string): Promise<void> {
    if (!url) {
      metadata.value = null;
      return;
    }

    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      metadata.value = (await response.json()) as ScenePart;
    } catch (_error) {
      metadata.value = null;
      notify("场景元数据加载失败，地图可能无法正确定位。", {
        type: "warning",
        dedupeKey: "ros-metadata-failed",
      });
    }
  }

  async function loadPointCloud(scene: ScenePart): Promise<void> {
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
    () => [
      getSceneDefinition()?.sceneId,
      getSceneDefinition()?.pointCloudUrl,
      getSceneDefinition()?.pointCloudMetaUrl,
      getSceneDefinition()?.resolution,
      getSceneDefinition()?.width,
      getSceneDefinition()?.height,
      getSceneDefinition()?.origin?.x,
      getSceneDefinition()?.origin?.y,
    ],
    () => {
      void loadPointCloud(getSceneDefinition() || {});
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    pointCloudRequestId += 1;
  });

  return { overlay, metadata, pointCloudBackdrop, pointCloudError };
}
