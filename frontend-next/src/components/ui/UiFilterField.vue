<script setup lang="ts">
/**
 * The label-over-control wrapper every filter bar repeats: a 2xs muted caption stacked above
 * the control with a 4px gap. The control itself goes in the default slot.
 *
 * This is pure layout — no state, no control-specific logic. It existed inline, copied verbatim
 * (`<label class="flex flex-col gap-1"><span class="text-2xs text-ink-muted">…</span> …`) in
 * every filter bar — 设备 / 消息 / 报表 / 审计 / 外发 — so a caption's size or the gap could drift
 * on one page and nowhere else. One component ends that, the same move `UiInput` / `UiSelect`
 * made for the controls themselves.
 *
 * A `<label>` rather than a bare `<div>` keeps parity with what the bars already shipped: for the
 * native `UiInput` (search / date) it associates the caption with the field; for the custom
 * controls (`UiSelect` / `UiMultiSelect` / `UiSegmented`), which carry their own `aria-label`, it
 * is harmless. The caption stays a `<span>` — not a second accessible name — for that reason.
 */
defineProps<{ label: string }>();
</script>

<template>
  <label class="flex flex-col gap-1">
    <span class="text-2xs text-ink-muted">{{ label }}</span>
    <slot />
  </label>
</template>
