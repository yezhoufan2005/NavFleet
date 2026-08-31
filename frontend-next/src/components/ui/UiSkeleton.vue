<script setup lang="ts">
/**
 * Shimmer placeholder for content that has not arrived yet.
 *
 * ## Why this exists at all
 *
 * The alternative is rendering the empty state, and that says **"there is no data"** —
 * a different and wrong message while a request is still in flight. v1.0.0 drew this
 * distinction and the port lost it: `frontend-next` had zero `*keleton*` files while
 * `stores/fleet.ts:106` still claimed "Views render skeletons while it is set", which
 * made the comment assert a fact the code had stopped providing.
 *
 * ## `aria-hidden`, and where the announcement actually lives
 *
 * The bars are hidden from assistive tech on purpose: the shimmer says "loading"
 * *visually*, and the region that owns it carries `aria-busy="true"` instead. Exposing
 * the bars would make a screen reader read out a row of empty boxes and never say why
 * they are empty. So this component is only half of the mechanism — a caller that
 * renders it without `aria-busy` on the surrounding region has built a loading state
 * that only sighted users can perceive.
 *
 * ## Why sizing is a preset rather than a prop
 *
 * A placeholder whose height differs from the content it stands in for does not remove
 * the layout jump, it moves the jump to the moment the data lands. So each variant is
 * pinned to a real line box — see `value` below, which is the one that has to be kept
 * in step with the type scale.
 */

type Variant = "line" | "value" | "card";

const { rows = 1, variant = "line" } = defineProps<{
  /** How many placeholder bars to render. */
  rows?: number;
  variant?: Variant;
}>();
</script>

<template>
  <div class="skeleton-stack" aria-hidden="true">
    <div
      v-for="row in rows"
      :key="row"
      class="skeleton"
      :class="`skeleton-${variant}`"
    />
  </div>
</template>

<style scoped>
/*
 * Scoped CSS rather than utilities: the sweep is a keyframed `background-position` on a
 * gradient, which has no utility equivalent, and the variant heights are measurements
 * that want the comment next to them rather than a number inline in a template.
 */
.skeleton-stack {
  display: grid;
  gap: 0.625rem;
}

.skeleton {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-sm);
  /* Two stops of the same surface ramp: reads as a block on both themes without
     inventing a colour token that only this file would use. */
  background: linear-gradient(
    90deg,
    var(--color-surface-sunken) 0%,
    var(--color-border) 50%,
    var(--color-surface-sunken) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-sweep 1.4s ease-in-out infinite;
}

.skeleton-line {
  height: 14px;
}

/*
 * Sized to the line box of 总览's stat value — `text-3xl font-semibold`, so
 * 30px × 1.2 = 36px (`ramp.css:109-110`). v1.0.0's was 27px against its own 20px × 1.35
 * scale; copying that number over would have reserved 9px too little and reintroduced
 * exactly the jump this variant exists to prevent (measured at 13px per card before the
 * original existed). **Keep this in step with `--text-3xl` if that scale changes.**
 */
.skeleton-value {
  height: 36px;
}

.skeleton-line:last-child:not(:only-child) {
  /* A ragged last line reads as text rather than as a solid block. */
  width: 62%;
}

.skeleton-card {
  height: 74px;
  border-radius: var(--radius-md);
}

@keyframes skeleton-sweep {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

/*
 * A sweeping gradient is exactly the kind of repetitive motion that triggers discomfort
 * for motion-sensitive users, and it repeats indefinitely. Hold a static block instead —
 * the placeholder still communicates "not yet here", which is the whole message.
 */
@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
    background: var(--color-border);
  }
}
</style>
