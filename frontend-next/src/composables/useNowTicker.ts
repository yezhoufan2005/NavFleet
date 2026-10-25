import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/**
 * A `now` clock that re-reads `Date.now()` on a fixed interval, for views that render ages or
 * freshness relative to the current moment (总览 / 大屏). Self-managed: it starts the interval on
 * mount and clears it on unmount, so a caller just reads the returned ref.
 *
 * The default cadence is one second — the smallest step those labels show, and the point below
 * which a freshness number that does not move would read as frozen.
 */
export const useNowTicker = (intervalMs = 1_000): Ref<number> => {
  const now = ref(Date.now());
  let ticker: ReturnType<typeof setInterval> | null = null;

  onMounted(() => {
    ticker = setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  });

  onBeforeUnmount(() => {
    if (ticker !== null) clearInterval(ticker);
  });

  return now;
};
