/**
 * Per-scene viewport persistence for the ROS scene map.
 *
 * Operators expect a scene to reopen where they left it, so the pan/zoom state
 * is remembered per `sceneId`. It is deliberately stored in `sessionStorage`
 * (not `localStorage`): a remembered view is a per-tab convenience, and a stale
 * view from days ago is more confusing than a fresh fit-to-scene.
 *
 * This module only owns the raw read/write of the stored map. Turning viewport
 * numbers into a saved entry (and back) needs the viewport math itself, so
 * `saveViewportState`/`restoreViewportState` live in `useSvgViewport`.
 */

// Versioned: the previous default view computed a 22.22x close-up, and a saved
// entry from before that fix would keep re-applying it (the restore path only
// rejects out-of-range centres, never an absurd scale). Bumping the key retires
// those entries instead of leaving a stale session pinned to the old behaviour.
export const ROS_VIEW_STORAGE_KEY = "navfleet:ros-scene-views:v2";

export interface SavedSceneView {
  centerX: number;
  centerY: number;
  scale: number;
  updatedAt: number;
}

export type SavedSceneViews = Record<string, SavedSceneView>;

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readSavedSceneViews(): SavedSceneViews {
  const storage = getStorage();
  if (!storage) {
    return {};
  }

  try {
    const raw = storage.getItem(ROS_VIEW_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SavedSceneViews) : {};
  } catch {
    return {};
  }
}

function writeSavedSceneViews(nextValue: SavedSceneViews): void {
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

export function useSceneViewportPersistence() {
  return { readSavedSceneViews, writeSavedSceneViews };
}
