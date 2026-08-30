<script setup lang="ts">
/**
 * The frame every page sits in: title, optional lede, actions slot, content.
 *
 * Exists so the page heading is one decision made once rather than twelve. v1.0.0
 * had no such thing, and the result is visible in `frontend-parity.md`: heading
 * levels, spacing and whether a page even has a title vary page by page.
 *
 * The title is an `h2`. The product name in the top bar is the document's `h1`, so
 * a page heading is one level below it — that also matches v1.0.0, which keeps the
 * existing Playwright `getByRole("heading", …)` queries working (they match on
 * name, not level, but the reading order they imply should still be right).
 */
defineProps<{
  title: string;
  lede?: string;
}>();
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="text-xl font-semibold text-ink">{{ title }}</h2>
        <p v-if="lede" class="max-w-prose text-sm text-ink-muted">{{ lede }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </div>
</template>
