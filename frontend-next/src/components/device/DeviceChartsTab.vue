<script setup lang="ts">
/**
 * 曲线 — speed and charge over time, each with a 实时 / 历史 toggle.
 *
 * Distinct from the 回放 tab on purpose. This one answers "how is it behaving now" and "how has
 * it behaved lately" for the cost of opening a tab; playback answers "what happened between 14:00
 * and 15:00", which needs a window and a playhead. Collapsing them would make the cheap questions
 * expensive.
 *
 * ## Two cards, never one chart with two y-axes
 *
 * Speed is m/s and charge is %, and putting them on one pair of axes would let the crossing point
 * be chosen by whoever picked the scales — the single most common way a chart misleads. Each metric
 * is its own `DeviceMetricCurve`, which takes one `unit`, so a dual axis is inexpressible.
 *
 * The tab itself is thin: each card owns its own live buffer, history fetch and view state. A
 * device opened on 实时 costs no history request — this is a lazy child route, so arriving at 实时
 * mounts neither card until 曲线 is entered, and even then each card fetches history only once 历史
 * is first selected.
 */
import DeviceMetricCurve from "@/components/device/DeviceMetricCurve.vue";

const { deviceId } = defineProps<{ deviceId: string }>();
</script>

<template>
  <section class="flex flex-col gap-3" aria-label="速度与电量曲线">
    <DeviceMetricCurve
      :device-id="deviceId"
      metric="speed"
      unit="m/s"
      realtime-label="实时速度"
      history-label="历史速度"
    />
    <DeviceMetricCurve
      :device-id="deviceId"
      metric="soc"
      unit="%"
      realtime-label="实时电量"
      history-label="历史电量"
    />
  </section>
</template>
