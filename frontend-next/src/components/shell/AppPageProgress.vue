<script setup lang="ts">
/**
 * The page progress line: 2px along the bottom edge of the top bar, across the whole window. It is
 * drawn out of the layout (`absolute`, over the content row's top edge), so nothing on the page
 * moves when it appears. Like GitHub's bar, it shows while a navigation is pending (almost always a
 * page's code chunk downloading — every view is lazy) or while any region re-queries data already
 * on screen (`UiBusyRegion` → `usePageProgress`). Nothing for a wait under `LOADING_DELAY_MS`;
 * gone the moment the last wait ends.
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import { useDelayedFlag } from "@/composables/useDelayedFlag";
import { pageProgressActive } from "@/composables/usePageProgress";
import UiProgressLine from "@/components/ui/UiProgressLine.vue";

const router = useRouter();
const navigating = ref(false);
const shown = useDelayedFlag(
  computed(() => navigating.value || pageProgressActive.value),
);

const stops = [
  router.beforeEach(() => {
    navigating.value = true;
  }),
  router.afterEach(() => {
    navigating.value = false;
  }),
  router.onError(() => {
    navigating.value = false;
  }),
];
onBeforeUnmount(() => stops.forEach((stop) => stop()));
</script>

<template>
  <UiProgressLine
    v-if="shown"
    class="pointer-events-none absolute inset-x-0 top-0 z-30"
    data-testid="page-progress"
  />
  <p v-if="shown" class="sr-only" role="status">正在加载</p>
</template>
