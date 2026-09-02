<script setup lang="ts">
/**
 * 报表 — the section that turns already-collected data into answers.
 *
 * The second audit found `telemetry_ts` storing seventeen measurements while the UI
 * renders five, and the alert lifecycle timestamps written on every record with no
 * reader at all. Nothing here needs new instrumentation; it needs an aggregation
 * layer, which is Phase 17A.
 */
import PageHeader from "@/components/PageHeader.vue";
import PagePlaceholder from "@/components/PagePlaceholder.vue";
</script>

<template>
  <PageHeader title="报表">
    <PagePlaceholder
      plan="17B"
      intent="聚合报表与导出。这一页在 Phase 13 只有骨架，内容依赖 Phase 17A 的聚合层。"
    />
  </PageHeader>
</template>
