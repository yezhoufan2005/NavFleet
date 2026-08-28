<script setup>
/**
 * Shimmer placeholder for content that has not arrived yet.
 *
 * Marked `aria-hidden` on purpose: the shimmer states "loading" *visually*, and
 * the region that owns it carries `aria-busy="true"` instead. Exposing the bars
 * themselves would make a screen reader announce a row of empty boxes and say
 * nothing about why they are empty.
 */
defineProps({
  /** How many placeholder bars to render. */
  rows: { type: Number, default: 1 },
  /**
   * Shape preset: `line` for a text row, `card` for a device/stat block.
   * Sizing lives in `styles/skeleton.css` so callers stay markup-only.
   */
  variant: { type: String, default: "line" },
});
</script>

<template>
  <div class="skeleton-stack" aria-hidden="true">
    <div v-for="row in rows" :key="row" class="skeleton" :class="`skeleton-${variant}`"></div>
  </div>
</template>
