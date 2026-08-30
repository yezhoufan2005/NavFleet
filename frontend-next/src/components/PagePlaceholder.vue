<script setup lang="ts">
/**
 * Placeholder body for a section whose page has not been built yet.
 *
 * It says which PR fills it in and what will be there, rather than showing an
 * empty panel or — worse — mock content. Mock content in a shell is how a review
 * ends with "looks done" about something that reads from nothing, and how a
 * screenshot of fabricated telemetry ends up in a status update.
 *
 * Every one of these disappears during Phase 13. If any survives into Phase 14,
 * that is a parity gap the checklist should already have caught.
 */
defineProps<{
  /** Which roadmap PR replaces this, e.g. "13B". */
  plan: string;
  /** What that PR will put here, in one line. */
  intent: string;
}>();
</script>

<template>
  <section
    class="flex max-w-3xl flex-col items-start gap-3 rounded-md border border-dashed border-border-strong bg-surface-raised p-6"
  >
    <span
      class="rounded-full bg-notice-wash px-2.5 py-1 font-mono text-2xs font-semibold text-notice-ink"
    >
      施工中 · PR {{ plan }}
    </span>
    <p class="max-w-prose text-ink-muted">{{ intent }}</p>
    <p class="max-w-prose text-sm text-ink-subtle">
      当前这一版只搭好了外壳（导航、鉴权、主题、错误边界）。这一页的内容会在
      Phase 13 按 <code class="font-mono">docs/frontend-parity.md</code>
      的清单逐项补齐，届时本占位块会被删除。
    </p>
  </section>
</template>
