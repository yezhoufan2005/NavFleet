<script setup lang="ts">
/**
 * The card — the bordered, raised panel every view groups content into.
 *
 * The frame `rounded-md border border-border bg-surface-raised` had been hand-written
 * ~30 times, its padding drifting across `p-3`/`p-4`/`p-5`/`p-8`/`p-10` with no rule.
 * This is that frame once, with a padding scale and an optional header. Cards stay flat
 * (border, no shadow) on purpose — shadow is reserved for genuinely floating layers
 * (dropdowns, dialogs, toasts), so a page of cards reads as one clean plane.
 *
 * The header is opt-in: pass `title` (or fill `#header`) for a consistent
 * `text-md font-semibold` card title with an `#actions` slot on its right; pass neither
 * and the card is just the frame around the default slot, so bespoke layouts keep it.
 * `padding="none"` is for cards whose body manages its own edges — a full-bleed table.
 *
 * Rendered as a `<div>`; a card that must be a labelled landmark passes `as="section"`
 * plus its own `aria-label`/`aria-labelledby`, which fall through to the root.
 */
import { computed, useSlots } from "vue";

type Padding = "md" | "sm" | "none";

const {
  padding = "md",
  title,
  as = "div",
} = defineProps<{
  padding?: Padding;
  title?: string;
  as?: "div" | "section";
}>();

const PADDING: Record<Padding, string> = { md: "p-4", sm: "p-3", none: "" };

const slots = useSlots();
const hasHeader = computed(() => Boolean(title) || Boolean(slots.header));
</script>

<template>
  <component
    :is="as"
    :class="[
      'rounded-md border border-border bg-surface-raised',
      PADDING[padding],
    ]"
  >
    <div v-if="hasHeader" class="mb-3 flex items-start justify-between gap-3">
      <slot name="header">
        <h3 class="text-md font-semibold text-ink">{{ title }}</h3>
      </slot>
      <div v-if="slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </component>
</template>
