<script setup lang="ts">
/**
 * A horizontal **stacked** bar chart, plus the data table that stands in for it.
 *
 * Sibling to `CategoryBarChart.vue` (single series); this one takes several `series` stacked per
 * category — the 消息史 Top-N device chart stacks each vehicle's bar by severity. Same contract:
 * a pure option builder (`stackedBarOption.ts`), a theme-watching rebuild, and a colour-independent
 * data table (a column per series + a total) so identity never rides colour alone.
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import type { CSSProperties } from "vue";
import type { ECharts } from "echarts/core";
import UiButton from "@/components/ui/UiButton.vue";
import UiScrollTable from "@/components/ui/UiScrollTable.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import {
  buildStackedBarOption,
  echarts,
  type StackedSeries,
} from "./stackedBarOption";

const {
  categories,
  series,
  label,
  unit,
  height = 260,
  scroll = false,
} = defineProps<{
  categories: readonly string[];
  series: readonly StackedSeries[];
  /** Accessible name for the figure, and the table's caption. */
  label: string;
  unit?: string;
  height?: number;
  /** Keep the card at `height` and let the plot grow downward with one scrollbar past it. */
  scroll?: boolean;
}>();

const { palette, animate } = useChartTheme();

/** Min on-screen slot per bar before the plot outgrows the card and scrolls. */
const SLOT_PX = 34;

const surfaceStyle = computed<CSSProperties>(() =>
  scroll
    ? {
        width: "100%",
        height: `${Math.max(height, categories.length * SLOT_PX)}px`,
      }
    : { width: "100%", height: "100%" },
);

const surface = useTemplateRef<HTMLElement>("surface");
const showTable = ref(false);
let chart: ECharts | null = null;
let observer: ResizeObserver | null = null;

const option = computed(() =>
  buildStackedBarOption({
    categories,
    series,
    palette: palette.value,
    unit,
    animate: animate.value,
  }),
);

/** Per-category row totals, for the data table's trailing column. */
const totals = computed(() =>
  categories.map((_label, index) =>
    series.reduce((sum, entry) => sum + (entry.data[index] ?? 0), 0),
  ),
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
    <figcaption class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium text-ink">{{ label }}</span>
        <!-- Header controls the parent injects (e.g. a Top-N selector), right of the title. -->
        <slot name="actions" />
      </div>
      <UiButton
        variant="ghost"
        size="sm"
        :aria-pressed="showTable"
        @click="showTable = !showTable"
      >
        {{ showTable ? "图表" : "数据表" }}
      </UiButton>
    </figcaption>

    <div
      v-if="!showTable"
      class="w-full overflow-x-hidden overflow-y-auto"
      :style="{ height: `${height}px` }"
    >
      <div
        ref="surface"
        :style="surfaceStyle"
        role="img"
        :aria-label="`${label}（图表；可切换为数据表）`"
        data-testid="stacked-bar-surface"
      />
    </div>

    <!-- Every column sized per the shared width standard: 设备 has the largest base, each severity
         and the total a narrow numeric one; below `min-width` the table scrolls sideways so 设备
         is never squeezed onto two lines. -->
    <UiScrollTable
      v-else
      :label="label"
      :height="height"
      :min-width="`${10 + (series.length + 1) * 3.5}rem`"
    >
      <template #colgroup>
        <col class="w-40" />
        <col v-for="s in series" :key="s.name" class="w-14" />
        <col class="w-14" />
      </template>
      <template #head>
        <tr>
          <th scope="col" class="px-3 py-2 font-medium">设备</th>
          <th
            v-for="s in series"
            :key="s.name"
            scope="col"
            class="px-2 py-2 text-right font-medium"
          >
            {{ s.name }}
          </th>
          <th scope="col" class="px-2 py-2 text-right font-medium">合计</th>
        </tr>
      </template>
      <tr
        v-for="(category, index) in categories"
        :key="category"
        class="border-b border-border last:border-b-0"
      >
        <th
          scope="row"
          class="px-3 py-1.5 text-xs font-normal whitespace-nowrap text-ink-muted"
        >
          {{ category }}
        </th>
        <td
          v-for="s in series"
          :key="s.name"
          class="px-2 py-1.5 text-right font-mono text-xs tabular-nums text-ink"
        >
          {{ s.data[index] ?? 0 }}
        </td>
        <td
          class="px-2 py-1.5 text-right font-mono text-xs font-medium tabular-nums text-ink"
        >
          {{ totals[index] }}
        </td>
      </tr>
    </UiScrollTable>
  </figure>
</template>
