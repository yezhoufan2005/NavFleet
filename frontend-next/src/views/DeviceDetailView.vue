<script setup lang="ts">
/**
 * 设备详情 — a route, not a nav section.
 *
 * Reached from the list, the map or an alert, and it is where the 11B audit found
 * the worst task flow in v1.0.0: diagnosing one vehicle took six steps and still
 * did not answer the question, because live telemetry and history lived on
 * different pages and each made you pick the device again. Here they are tabs over
 * one already-chosen device.
 */
import { useRoute } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import PagePlaceholder from "@/components/PagePlaceholder.vue";

const route = useRoute();
</script>

<template>
  <PageHeader
    :title="`设备 ${String(route.params.deviceId)}`"
    lede="实时 · 曲线 · 历史回放 · 告警史，都在同一台车上。"
  >
    <PagePlaceholder
      plan="13C"
      intent="四个 tab：实时遥测、ECharts 时序曲线、历史回放、该设备的告警历史。"
    />
  </PageHeader>
</template>
