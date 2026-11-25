<script setup lang="ts">
/**
 * A region that already shows data and is re-querying it — a filter change, a refresh, a page
 * turn. The content stays put (blanking it to a skeleton on every keystroke would make the table
 * flicker away); the region says it is working, after `LOADING_DELAY_MS`, in the style chosen in
 * `useRefetchStyle`: a progress line on its top edge, or the content faded.
 *
 * First loads are not this component's job — those render `UiLoading` in the content's place.
 */
import { useDelayedFlag } from "@/composables/useDelayedFlag";
import { useRefetchStyle } from "@/composables/useRefetchStyle";
import UiProgressLine from "@/components/ui/UiProgressLine.vue";

const { busy = false, contentClass = "" } = defineProps<{
  busy?: boolean;
  /** Layout for the wrapped content (e.g. `flex flex-col gap-2`) — the region adds one box. */
  contentClass?: string;
}>();

const shown = useDelayedFlag(() => busy);
const { style } = useRefetchStyle();
</script>

<template>
  <div class="relative" :aria-busy="busy || undefined">
    <UiProgressLine
      v-if="shown && style === 'bar'"
      inset
      class="absolute inset-x-0 top-0 z-10"
      data-testid="busy-line"
    />
    <div
      class="transition-opacity duration-150 ease-standard"
      :class="[contentClass, shown && style === 'dim' ? 'opacity-60' : '']"
      :data-dimmed="shown && style === 'dim' ? '' : undefined"
    >
      <slot />
    </div>
  </div>
</template>
