/**
 * The scene map's point-cloud backdrop: fetch, rasterize, cache.
 *
 * Everything with arithmetic in it is in `@navfleet/fleet-core` (and has 23 tests
 * there). What is left here is the canvas — `createImageData` / `putImageData` /
 * `toDataURL` — plus the cache, which is where this file's own two fixes live.
 *
 * **Fix 1: the palette is an argument, and it is in the cache key.** v1.0.0 wrote
 * the obstacle and floor colours inline (values chosen for a dark canvas) and keyed
 * the cache on the scene alone. Making the palette injectable without keying on it
 * would be worse than leaving it hardcoded: switching themes would serve the PNG
 * rasterized for the *previous* theme, and it would look like the switch had simply
 * failed. The colours themselves are chosen by the caller — 13A-2b picks them from
 * the map tokens, with the map on screen to judge them against.
 *
 * **Fix 2: the cache is bounded.** v1.0.0 never evicted an entry; the only `delete`
 * was the error path. Each entry holds a full-scene PNG as a base64 data URL, so a
 * console left open across a shift's worth of scenes — now multiplied by themes —
 * grew a set of multi-megabyte strings that nothing could reclaim.
 */

import { buildOccupancyGrid, paintOccupancy } from "@navfleet/fleet-core";
import type {
  PointCloudBounds,
  PointCloudMeta,
  PointCloudPalette,
} from "@navfleet/fleet-core";
import type { SceneMapDefinition } from "@navfleet/shared";

export type { PointCloudPalette };

export interface PointCloudBackdrop {
  dataUrl: string;
  width: number;
  height: number;
  bounds: PointCloudBounds;
  meta: PointCloudMeta;
}

type ScenePart = Partial<SceneMapDefinition>;

/**
 * How many rasterized scenes to keep. Two themes × a couple of scenes is the real
 * working set; beyond that the oldest goes. Small on purpose — the entries are
 * base64 PNGs of a whole scene, not thumbnails.
 */
export const BACKDROP_CACHE_LIMIT = 6;

/** Insertion-ordered, and re-inserted on read, so the first key is the coldest. */
const cache = new Map<string, Promise<PointCloudBackdrop>>();

const cacheKey = (scene: ScenePart, palette: PointCloudPalette): string =>
  JSON.stringify({
    pointCloudUrl: scene.pointCloudUrl,
    pointCloudMetaUrl: scene.pointCloudMetaUrl || "",
    resolution: scene.resolution,
    origin: scene.origin,
    width: scene.width,
    height: scene.height,
    // See fix 1 in the header: omitting this serves the other theme's image.
    palette: [palette.obstacle, palette.floor],
  });

const evictOldest = (): void => {
  while (cache.size > BACKDROP_CACHE_LIMIT) {
    const coldest = cache.keys().next();
    if (coldest.done) return;
    cache.delete(coldest.value);
  }
};

const fetchJson = async (url: string): Promise<PointCloudMeta> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`点云元数据加载失败: HTTP ${response.status}`);
  }
  return (await response.json()) as PointCloudMeta;
};

const fetchArrayBuffer = async (url: string): Promise<ArrayBuffer> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`点云文件加载失败: HTTP ${response.status}`);
  }
  return response.arrayBuffer();
};

const rasterize = (
  arrayBuffer: ArrayBuffer,
  meta: PointCloudMeta,
  scene: ScenePart,
  palette: PointCloudPalette,
): PointCloudBackdrop => {
  const grid = buildOccupancyGrid(arrayBuffer, meta, scene);
  const { width, height, bounds } = grid.geometry;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("浏览器无法创建点云渲染画布");
  }

  const imageData = context.createImageData(width, height);
  imageData.data.set(paintOccupancy(grid, palette));
  context.putImageData(imageData, 0, 0);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
    bounds,
    meta,
  };
};

export const loadPointCloudBackdrop = async (
  scene: ScenePart | null | undefined,
  palette: PointCloudPalette,
): Promise<PointCloudBackdrop | null> => {
  if (!scene?.pointCloudUrl) return null;

  const key = cacheKey(scene, palette);
  const cached = cache.get(key);
  if (cached) {
    // Re-insert so the working set survives eviction and the idle entries do not.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const pending = Promise.all([
    fetchArrayBuffer(scene.pointCloudUrl),
    scene.pointCloudMetaUrl
      ? fetchJson(scene.pointCloudMetaUrl)
      : Promise.resolve<PointCloudMeta>({}),
  ])
    .then(([arrayBuffer, meta]) => rasterize(arrayBuffer, meta, scene, palette))
    .catch((error: unknown) => {
      // A failed load must not be remembered as a result — the next attempt would
      // get the same rejection forever, including after the network recovered.
      cache.delete(key);
      throw error;
    });

  cache.set(key, pending);
  evictOldest();
  return pending;
};

/** Test-only. The cache is module state and would otherwise leak between files. */
export const __clearBackdropCache = (): void => cache.clear();

/** Test-only view of what is cached, coldest first. */
export const __cachedBackdropCount = (): number => cache.size;
