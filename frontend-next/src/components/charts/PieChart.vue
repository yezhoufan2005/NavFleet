<script setup lang="ts">
/**
 * A donut pie, plus the data table that stands in for it.
 *
 * Sibling to `CategoryBarChart.vue` / `TimeSeriesChart.vue` on the same contract: a pure option
 * builder (`pieOption.ts`) tested without a canvas, colours rebuilt on a theme switch
 * (`useChartTheme`), and a table alternative so identity/value are readable without colour.
 *
 * `labelHidden` / `showTableToggle` are the same opt-outs the time-series chart carries, for when
 * a parent owns the heading and the view toggle — the 消息史 severity card toggles 饼图 ⇆ 柱状图
 * itself and hands this component just the plot.
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import type { ECharts } from "echarts/core";
import UiButton from "@/components/ui/UiButton.vue";
import UiScrollTable from "@/components/ui/UiScrollTable.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import type { CategoryDatum } from "./categoryBarOption";
import { buildPieOption, echarts } from "./pieOption";

const {
  data,
  label,
  unit,
  height = 260,
  labelHidden = false,
  showTableToggle = true,
} = defineProps<{
  data: readonly CategoryDatum[];
  /** Accessible name for the figure, and the table's caption. */
  label: string;
  unit?: string;
  height?: number;
  /** Keep `label` as the accessible name but drop the visible caption (a parent shows the heading). */
  labelHidden?: boolean;
  /** Show the built-in 图表/数据表 toggle. False when a parent owns the view toggle. */
  showTableToggle?: boolean;
}>();

const { palette, animate } = useChartTheme();

const surface = useTemplateRef<HTMLElement>("surface");
const showTable = ref(false);
let chart: ECharts | null = null;
let observer: ResizeObserver | null = null;

const option = computed(() =>
  buildPieOption({
    data,
    palette: palette.value,
    unit,
    animate: animate.value,
  }),
);

const mountChart = (): void => {
  const element = surface.value;
  if (!element || chart) return;
  chart = echarts.init(element, undefined, { renderer: "canvas" });
  chart.setOption(option.value);
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(element);
};

const disposeChart = (): void => {
  observer?.disconnect();
  observer = null;
  chart?.dispose();
  chart = null;
};

// Mount only while the chart is the visible view (see TimeSeriesChart for the wall-display
// reason): the table path disposes the instance rather than leaving a canvas behind `hidden`.
watch(
  [showTable, surface],
  ([tableVisible]) => {
    if (tableVisible) disposeChart();
    else mountChart();
  },
  { flush: "post" },
);

watch(option, (next) => chart?.setOption(next), { flush: "post" });

onBeforeUnmount(disposeChart);
</script>

<template>
  <figure class="m-0 flex flex-col gap-2">
    <figcaption
      v-if="!labelHidden || showTableToggle"
      class="flex items-center justify-between gap-3"
    >
      <span v-if="!labelHidden" class="text-sm font-medium text-ink">{{
        label
      }}</span>
      <span v-else aria-hidden="true" />
      <UiButton
        v-if="showTableToggle"
        variant="ghost"
        size="sm"
        :aria-pressed="showTable"
        @click="showTable = !showTable"
      >
        {{ showTable ? "图表" : "数据表" }}
      </UiButton>
    </figcaption>

    <div v-if="!showTable" class="w-full" :style="{ height: `${height}px` }">
      <div
        ref="surface"
        class="size-full"
        role="img"
        :aria-label="`${label}（饼图；可切换为数据表）`"
        data-testid="pie-surface"
      />
    </div>

    <!-- Data-table view — the shared scroll-table shell, pinned to the chart's height so toggling
         never resizes the card. -->
    <UiScrollTable v-else :label="label" :height="height">
      <template #colgroup>
        <col />
        <col class="w-24" />
      </template>
      <template #head>
        <tr>
          <th scope="col" class="px-3 py-2 font-medium">项</th>
          <th scope="col" class="px-3 py-2 font-medium">
            数值<template v-if="unit"> ({{ unit }})</template>
          </th>
        </tr>
      </template>
      <tr
        v-for="datum in data"
        :key="datum.label"
        class="border-b border-border last:border-b-0"
      >
        <th
          scope="row"
          class="px-3 py-1.5 text-xs font-normal whitespace-nowrap text-ink-muted"
        >
          {{ datum.label }}
        </th>
        <td class="px-3 py-1.5 font-mono text-xs tabular-nums text-ink">
          {{ datum.value }}
        </td>
      </tr>
    </UiScrollTable>
  </figure>
</template>
