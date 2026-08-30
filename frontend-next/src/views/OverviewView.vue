<script setup lang="ts">
/**
 * 总览 — the default landing page, and the biggest single bet in the new IA.
 *
 * v1.0.0 landed on a full-width map. The research says that is the wrong first
 * screen: supervisors running forty or more units stop looking at live positions
 * within the first week, because "where is everyone" is not the question a shift
 * starts with. "Which few need me right now" is. This page answers that one; the
 * map is one of two projections of 设备 (see `docs/frontend-ia.md` §2).
 */
import PageHeader from "@/components/PageHeader.vue";
import PagePlaceholder from "@/components/PagePlaceholder.vue";
</script>

<template>
  <PageHeader
    title="总览"
    lede="值班第一眼要看的四五个信号，加上此刻需要处理的车辆。"
  >
    <PagePlaceholder
      plan="13B"
      intent="车队健康度、需要处理的车辆队列、当班告警摘要与数据新鲜度。这是新增页面，没有现成实现可搬。"
    />
  </PageHeader>
</template>
