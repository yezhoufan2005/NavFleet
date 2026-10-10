<script setup lang="ts">
/**
 * The "filters matched nothing" placeholder — a bordered, raised, centred panel that stands in the
 * body's place so a bare column header never reads as "there is no data at all".
 *
 * Factored out of the device list, whose exact box the admin tables (审计 / 外发 / …) had each
 * re-typed or, worse, replaced with a bare `<p>` that did not match. One component keeps every
 * empty state the same shape; the message is the slot. `role="status"` so a screen reader hears it.
 */
</script>

<template>
  <p
    class="m-0 rounded-md border border-border bg-surface-raised px-4 py-6 text-center text-sm text-ink-muted"
    role="status"
  >
    <slot />
  </p>
</template>
