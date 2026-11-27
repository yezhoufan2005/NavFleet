<script setup lang="ts">
/**
 * The indeterminate progress line: a brand-coloured segment sliding along a faint track. Used at
 * the top of the viewport (`AppPageProgress`, for navigations and re-queries) and on the boot
 * screen. The caller positions it; this component sets no `position` of its own, so a
 * `fixed` / `absolute` class from the caller is never overridden by the scoped style here (an
 * in-flow line pushed the content below it down by its 2px).
 *
 * Decorative (`aria-hidden`): the owner of the wait carries `aria-busy` / a status message.
 * Under reduced motion the segment holds still across the whole track instead of sweeping.
 */
</script>

<template>
  <div class="busy-bar" aria-hidden="true">
    <span class="busy-bar-segment" />
  </div>
</template>

<style scoped>
.busy-bar {
  height: 2px;
  overflow: hidden;
  /* The segment is positioned against the track without the track claiming `position`. */
  contain: layout paint;
  background: color-mix(in oklch, var(--color-brand) 18%, transparent);
}

.busy-bar-segment {
  display: block;
  width: 35%;
  height: 100%;
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
