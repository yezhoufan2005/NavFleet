/**
 * Rasterizes a scene's point cloud into a PNG data URL for the scene map backdrop.
 *
 * As of 13A-2 everything except the canvas lives in `@navfleet/fleet-core`: the PCD
 * header parse, the geometry fallbacks, the z-band classifier, the binning loop and
 * the pixel arithmetic. This file is the part that genuinely needs a document.
 * Extracting it is what finally gave that arithmetic tests (23 of them) — it had
 * none while it lived here.
 *
 * **The palette stays the hardcoded dark pair on purpose.** In `fleet-core` it is
 * now a parameter, and the new console passes its theme's colours; passing them here
 * too would change how the production map looks in light mode, and that is a change
 * to review against a rendered map rather than to slip into a refactor. The old
 * frontend therefore keeps producing byte-identical images, and the theme fix ships
 * with the console in Phase 14.
 */

import {
  buildOccupancyGrid,
  paintOccupancy,
  type PointCloudBounds,
  type PointCloudMeta,
  type PointCloudPalette,
} from "@navfleet/fleet-core";
import type { SceneMapDefinition } from "@navfleet/shared";

export type { PointCloudBounds, PointCloudMeta };

export interface PointCloudBackdrop {
  dataUrl: string;
  width: number;
  height: number;
  bounds: PointCloudBounds;
  meta: PointCloudMeta;
}

type ScenePart = Partial<SceneMapDefinition>;

const POINT_CLOUD_CACHE = new Map<string, Promise<PointCloudBackdrop>>();

/** The values this file wrote inline before 13A-2 — see the header. */
const LEGACY_DARK_PALETTE: PointCloudPalette = {
  obstacle: [182, 237, 255],
  floor: [108, 132, 148],
};

function fetchJson(url: string): Promise<PointCloudMeta> {
  return fetch(url, { cache: "no-store" }).then((response) => {
    if (!response.ok) {
      throw new Error(`点云元数据加载失败: HTTP ${response.status}`);
    }
    return response.json() as Promise<PointCloudMeta>;
  });
}

function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  return fetch(url, { cache: "no-store" }).then((response) => {
    if (!response.ok) {
      throw new Error(`点云文件加载失败: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  });
}

function rasterizePointCloud(
  arrayBuffer: ArrayBuffer,
  meta: PointCloudMeta,
  sceneDefinition: ScenePart,
): PointCloudBackdrop {
  const grid = buildOccupancyGrid(arrayBuffer, meta, sceneDefinition);
  const { width, height, bounds } = grid.geometry;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("浏览器无法创建点云渲染画布");
  }

  const imageData = context.createImageData(width, height);
  imageData.data.set(paintOccupancy(grid, LEGACY_DARK_PALETTE));
  context.putImageData(imageData, 0, 0);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
    bounds,
    meta,
  };
}

export async function loadPointCloudBackdrop(
  sceneDefinition: ScenePart | null | undefined,
): Promise<PointCloudBackdrop | null> {
  if (!sceneDefinition?.pointCloudUrl) {
    return null;
  }

  const cacheKey = JSON.stringify({
    pointCloudUrl: sceneDefinition.pointCloudUrl,
    pointCloudMetaUrl: sceneDefinition.pointCloudMetaUrl || "",
    resolution: sceneDefinition.resolution,
    origin: sceneDefinition.origin,
    width: sceneDefinition.width,
    height: sceneDefinition.height,
  });

  const cached = POINT_CLOUD_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const loadingPromise = Promise.all([
    fetchArrayBuffer(sceneDefinition.pointCloudUrl),
    sceneDefinition.pointCloudMetaUrl
      ? fetchJson(sceneDefinition.pointCloudMetaUrl)
      : Promise.resolve<PointCloudMeta>({}),
  ])
    .then(([arrayBuffer, meta]) => rasterizePointCloud(arrayBuffer, meta, sceneDefinition))
    .catch((error) => {
      POINT_CLOUD_CACHE.delete(cacheKey);
      throw error;
    });

  POINT_CLOUD_CACHE.set(cacheKey, loadingPromise);
  return loadingPromise;
}
