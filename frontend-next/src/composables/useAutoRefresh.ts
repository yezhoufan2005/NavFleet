import { onBeforeUnmount, onMounted } from "vue";

/**
 * Re-fetch a page's data when the operator comes back to it, instead of making them press a
 * 刷新 button (1.6.1). Fires the given `refresh` when the tab becomes visible again or the window
 * regains focus — the moments a long-open admin page (审计 / 用户 / 外发) is most likely stale.
 *
 * Deliberately event-driven, not an interval: a ticking poll would re-order or blank rows out from
 * under someone mid-read or mid-filter. Focus/visibility refreshes only at a natural boundary, and
 * because `refresh` reads the page's own current filter/pagination state, it preserves them.
 *
 * `enabled` guards against refreshing at a bad moment — pass a getter that returns false while an
 * edit dialog or an expanded inline panel is open, so a background refresh never yanks it away.
 * `focus` and `visibilitychange` can both fire for one alt-tab, so firings are throttled.
 */
export const useAutoRefresh = (
  refresh: () => void,
  options: { enabled?: () => boolean } = {},
): void => {
  let last = 0;

  const trigger = (): void => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    if (options.enabled && !options.enabled()) {
      return;
    }
    const now = Date.now();
    if (now - last < 500) {
      return;
    }
    last = now;
    refresh();
  };

  onMounted(() => {
    document.addEventListener("visibilitychange", trigger);
    window.addEventListener("focus", trigger);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("visibilitychange", trigger);
    window.removeEventListener("focus", trigger);
  });
};
