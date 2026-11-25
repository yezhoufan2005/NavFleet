<script setup lang="ts">
/**
 * Route progress: a progress line across the very top of the viewport while a navigation is
 * pending — almost always a page's code chunk still downloading (every view is lazy). Like
 * GitHub's top bar: nothing for a fast navigation (`LOADING_DELAY_MS`), a line for a slow one,
 * gone the moment the page renders or the navigation fails.
 */
import { onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";
import { useDelayedFlag } from "@/composables/useDelayedFlag";
import UiProgressLine from "@/components/ui/UiProgressLine.vue";

const router = useRouter();
const pending = ref(false);
const shown = useDelayedFlag(pending);

const stops = [
  router.beforeEach(() => {
    pending.value = true;
  }),
  router.afterEach(() => {
    pending.value = false;
  }),
  router.onError(() => {
    pending.value = false;
  }),
];
onBeforeUnmount(() => stops.forEach((stop) => stop()));
</script>

<template>
  <UiProgressLine
    v-if="shown"
    class="fixed inset-x-0 top-[env(safe-area-inset-top,0px)] z-[60]"
    data-testid="route-progress"
  />
  <p v-if="shown" class="sr-only" role="status">正在打开页面</p>
</template>
