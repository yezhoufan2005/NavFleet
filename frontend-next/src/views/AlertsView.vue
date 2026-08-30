<script setup lang="ts">
/**
 * 告警 — equivalence first, depth in Phase 16.
 *
 * v1.0.0 keeps acknowledgements in the browser's own storage: they do not reach the
 * database, do not carry who or when, and the next person on shift sees none of it.
 * The `/api/v1/alerts` endpoint that would fix half of that already exists and has
 * never been called. Both are Phase 16 work; this page reaches parity first.
 */
import PageHeader from "@/components/PageHeader.vue";
import PagePlaceholder from "@/components/PagePlaceholder.vue";
</script>

<template>
  <PageHeader
    title="告警"
    lede="按严重度分流，筛选状态进 URL，可以把一个视图发给同事。"
  >
    <PagePlaceholder
      plan="13D"
      intent="实时告警列表与筛选（先做到与 v1.0.0 等价），tab 分区与确认落库留给 Phase 16。"
    />
  </PageHeader>
</template>
