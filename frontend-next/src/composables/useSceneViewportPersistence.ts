/**
 * Per-scene viewport persistence for the scene map.
 *
 * A scene reopens where you left it, so pan/zoom is remembered per `sceneId`. It is
 * `sessionStorage` rather than `localStorage` deliberately: a remembered view is a
 * per-tab convenience, and a view from days ago is more confusing than a fresh
 * fit-to-scene.
 *
 * **Reads come from memory, writes are coalesced.** v1.0.0 did a synchronous
 * `getItem` + `JSON.parse` *and* a `JSON.stringify` + `setItem` on every save — and
 * `saveViewportState` is called from the wheel handler, so a trackpad gesture meant
 * 60–120 synchronous storage round-trips per second on the main thread, inside an
 * input handler. Since `sessionStorage` is scoped to this tab and nothing else in
 * the tab writes this key, an in-memory copy cannot go stale; the store only has to
 * be caught up before the tab goes away.
 *
 * This module owns the raw read/write only. Turning viewport numbers into a saved
 * entry needs the viewport math, so `saveViewportState` / `restoreViewportState`
 * live in `useSvgViewport`.
 */

// Versioned: v1's default view computed a 22.22x close-up, and a saved entry from
// before that fix would keep re-applying it (the restore path rejects out-of-range
// centres, never an absurd scale). The key retires those entries.
export const ROS_VIEW_STORAGE_KEY = "navfleet:ros-scene-views:v2";

/**
 * How long a pending write may sit unflushed. Long enough that a continuous wheel
 * gesture writes once at the end, short enough to be irrelevant to a human.
 */
export const VIEW_FLUSH_DELAY_MS = 250;

export interface SavedSceneView {
  centerX: number;
  centerY: number;
  scale: number;
  updatedAt: number;
}

export type SavedSceneViews = Record<string, SavedSceneView>;

const getStorage = (): Storage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // Privacy mode can throw on access alone.
    return null;
  }
};

let views: SavedSceneViews | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;

const loadFromStorage = (): SavedSceneViews => {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(ROS_VIEW_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as SavedSceneViews)
      : {};
  } catch {
    return {};
  }
};

const flush = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const storage = getStorage();
  if (!storage || views === null) return;
  try {
    storage.setItem(ROS_VIEW_STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Quota and privacy-mode failures are not worth interrupting anyone over: the
    // view still applies for this session, it just will not survive a reload.
  }
};

/**
 * `pagehide` rather than `beforeunload`: it is the one that fires when a mobile
 * browser or a background tab is discarded, which is exactly the case where a
 * pending write would otherwise be lost. `visibilitychange` covers a tab being
 * hidden and never coming back.
 */
const installFlushListeners = (): void => {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
};

const readSavedSceneViews = (): SavedSceneViews => {
  views ??= loadFromStorage();
  return views;
};

const writeSavedSceneViews = (nextValue: SavedSceneViews): void => {
  views = nextValue;
  installFlushListeners();
  if (flushTimer !== null) return;
  flushTimer = setTimeout(flush, VIEW_FLUSH_DELAY_MS);
};

const clearSavedSceneViews = (): void => {
  views = {};
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(ROS_VIEW_STORAGE_KEY);
  } catch {
    // Ignore privacy-mode failures.
  }
};

export const useSceneViewportPersistence = () => ({
  readSavedSceneViews,
  writeSavedSceneViews,
  clearSavedSceneViews,
  /** Write now instead of waiting for the timer — for unmount and for tests. */
  flushSavedSceneViews: flush,
});

/** Test-only: drop the in-memory copy so the next read hits storage again. */
export const __resetSceneViewCache = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  views = null;
};
