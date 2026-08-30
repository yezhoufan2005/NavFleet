<script setup lang="ts">
/**
 * 设备 — one collection with two projections: a list and a map.
 *
 * Both show the same set, and which one opens first is decided by fleet size with
 * a 40-unit threshold (`docs/frontend-ia.md` §5.1). The threshold only decides the
 * *first* visit: once someone switches views that choice is remembered and wins
 * over the automatic guess, so getting the threshold wrong costs one click rather
 * than a permanently awkward default.
 */
import PageHeader from "@/components/PageHeader.vue";
import PagePlaceholder from "@/components/PagePlaceholder.vue";
</script>

<template>
  <PageHeader
    title="设备"
    lede="列表与地图是同一批设备的两种投影，可随时切换。"
  >
    <PagePlaceholder
      plan="13A"
      intent="设备列表（筛选 / 搜索 / 排序，v1.0.0 一个都没有）与 ROS / GPS 地图视图，地图升为页面主体。"
    />
  </PageHeader>
</template>
