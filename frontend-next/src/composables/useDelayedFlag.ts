import { onBeforeUnmount, ref, watch, type Ref, type WatchSource } from "vue";

/**
 * How long a wait must last before the console shows that it is waiting. Below this a request
 * reads as instant, and a skeleton or progress bar that appears for 80ms and vanishes is a flicker,
 * not information (the same threshold Ant Design's `Spin delay` and GitHub's progress bar use).
 */
const LOADING_DELAY_MS = 200;

/**
 * `source`, but turning true only once it has stayed true for `delay` ms; it turns false at once.
 * Every loading indicator (skeleton, busy region, route progress) goes through this, so a fast
 * response shows nothing and a slow one shows the same thing everywhere.
 */
export const useDelayedFlag = (
  source: WatchSource<boolean>,
  delay = LOADING_DELAY_MS,
): Ref<boolean> => {
  const shown = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(
    source,
    (on) => {
      clearTimeout(timer);
      if (!on) {
        shown.value = false;
        return;
      }
      if (delay <= 0) {
        shown.value = true;
        return;
      }
      timer = setTimeout(() => (shown.value = true), delay);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => clearTimeout(timer));
  return shown;
};
