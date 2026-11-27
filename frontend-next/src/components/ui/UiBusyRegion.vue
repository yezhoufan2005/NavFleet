<script setup lang="ts">
/**
 * A region that already shows data and is re-querying it — a filter change, a refresh, a page
 * turn. The content stays put (blanking it to a skeleton on every keystroke would make the table
 * flicker away); while `busy`, the region is marked `aria-busy` and holds the page progress line
 * at the top of the viewport (`usePageProgress`). Nothing is drawn inside the region, so nothing
 * in it moves.
 *
 * First loads are not this component's job — those render `UiLoading` in the content's place.
 */
import { usePageProgress } from "@/composables/usePageProgress";

const { busy = false, contentClass = "" } = defineProps<{
  busy?: boolean;
  /** Layout for the wrapped content (e.g. `flex flex-col gap-2`) — the region adds one box. */
  contentClass?: string;
}>();

usePageProgress(() => busy);
</script>

<template>
  <div :class="contentClass" :aria-busy="busy || undefined">
    <slot />
  </div>
</template>
