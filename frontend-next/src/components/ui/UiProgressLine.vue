<script setup lang="ts">
/**
 * The indeterminate progress line: a brand-coloured segment sliding along a faint track. One
 * component for the three places the console says "still working" with a line rather than a
 * skeleton — the top edge of a re-querying region (`UiBusyRegion`), the top of the viewport while
 * a route's code loads (`AppRouteProgress`), and the boot screen.
 *
 * Decorative (`aria-hidden`): the owner of the wait carries `aria-busy` / a status message.
 * Under reduced motion the segment holds still across the whole track instead of sweeping.
 */
const { inset = false } = defineProps<{
  /** Drawn inside a rounded box: clip to its corners rather than run square past them. */
  inset?: boolean;
}>();
</script>

<template>
  <div class="busy-bar" :class="inset ? 'rounded-t-md' : ''" aria-hidden="true">
    <span class="busy-bar-segment" />
  </div>
</template>

<style scoped>
.busy-bar {
  position: relative;
  height: 2px;
  overflow: hidden;
  background: color-mix(in oklch, var(--color-brand) 18%, transparent);
}

.busy-bar-segment {
  position: absolute;
  inset-block: 0;
  left: 0;
  width: 35%;
  border-radius: 9999px;
  background: var(--color-brand);
  animation: busy-bar-slide 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes busy-bar-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(290%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .busy-bar-segment {
    animation: none;
    width: 100%;
    opacity: 0.6;
  }
}
</style>
