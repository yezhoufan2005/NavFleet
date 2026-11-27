import { computed, onBeforeUnmount, ref, watch, type WatchSource } from "vue";

/**
 * The console's one "still working" line, flush under the top bar (`AppPageProgress`).
 * Anything that is waiting on the network with data already on screen — a page re-querying after
 * a filter change, a refresh, a page turn — holds it while it waits; a pending navigation holds it
 * too. The line shows while any hold is open, so two regions re-querying at once draw one line,
 * and nothing on the page moves to make room for it.
 */
const holds = ref(0);

/** Whether anything holds the page progress line right now (before the display delay). */
export const pageProgressActive = computed(() => holds.value > 0);

/** Hold the page progress line while `source` is true; released on unmount. */
export const usePageProgress = (source: WatchSource<boolean>): void => {
  let held = false;
  const set = (on: boolean): void => {
    if (on === held) return;
    held = on;
    holds.value += on ? 1 : -1;
  };
  watch(source, (on) => set(Boolean(on)), { immediate: true });
  onBeforeUnmount(() => set(false));
};

/** Test-only reset for the module singleton. */
export const __resetPageProgress = (): void => {
  holds.value = 0;
};
