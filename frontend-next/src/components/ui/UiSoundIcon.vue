<script setup lang="ts">
/**
 * The speaker glyph, in one place, because it now appears in two and has to agree.
 *
 * The top bar's control and the session menu's volume rows both draw it: the bar says
 * "this is how loud a critical will be", the menu rows say "this is what you would be
 * choosing". Two copies of a five-path SVG is exactly the kind of duplication that ends
 * with the menu showing three arcs while the bar shows two.
 *
 * `arcs` is the count of sound waves — one for 轻, two for 中, three for 重 — and
 * `crossed` replaces them with a cross for every state in which nothing will be heard.
 * Deliberately not a boolean pair: "how loud" and "silent" are one readout, and a
 * component that could render both at once would let the two disagree.
 */
const { arcs = 0, crossed = false } = defineProps<{
  /** 1–3 sound waves. Ignored when `crossed`. */
  arcs?: number;
  /** Muted, or otherwise unable to sound. */
  crossed?: boolean;
}>();

/** Radii chosen so three arcs fit the 24-unit box without touching its edge. */
const ARC_PATHS: readonly string[] = [
  "M14.5 9.6a4 4 0 0 1 0 4.8",
  "M17 7.8a7 7 0 0 1 0 8.4",
  "M19.5 6a10 10 0 0 1 0 12",
];
</script>

<template>
  <svg
    class="size-4 shrink-0"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M5 9v6h3l5 4V5L8 9H5Z" />
    <path v-if="crossed" d="M16 9.5l5 5M21 9.5l-5 5" />
    <template v-else>
      <path
        v-for="(arc, index) in ARC_PATHS.slice(0, arcs)"
        :key="index"
        :d="arc"
      />
    </template>
  </svg>
</template>
