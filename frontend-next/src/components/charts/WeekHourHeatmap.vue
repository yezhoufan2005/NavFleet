<script setup lang="ts">
/**
 * 星期 × 小时 onset heatmap, plus the data table that stands in for it.
 *
 * Same contract as the other charts here: a pure option builder (`heatmapOption.ts`), a
 * theme-watching rebuild (ECharts copies colours at `setOption`), and a colour-independent data
 * table (weekday rows × hour columns + a row total) so the magnitudes are readable without colour.
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import type { ECharts } from "echarts/core";
import UiButton from "@/components/ui/UiButton.vue";
import UiScrollTable from "@/components/ui/UiScrollTable.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import { WEEKDAY_LABELS, type WeekHourCell } from "@/lib/alertStats";
import { buildWeekHourHeatmapOption, echarts } from "./heatmapOption";

const {
  cells,
  max,
  label,
  height = 260,
} = defineProps<{
  cells: readonly WeekHourCell[];
  max: number;
  /** Accessible name for the figure, and the table's caption. */
  label: string;
  height?: number;
}>();

const { palette, animate } = useChartTheme();

const surface = useTemplateRef<HTMLElement>("surface");
const showTable = ref(false);
let chart: ECharts | null = null;
let observer: ResizeObserver | null = null;

const option = computed(() =>
  buildWeekHourHeatmapOption({
    cells,
    max,
    palette: palette.value,
    animate: animate.value,
  }),
);

/** Weekday row → the 24 hourly counts and the row total, for the data table. */
const rows = computed(() =>
  WEEKDAY_LABELS.map((name, weekday) => {
    const hours = Array.from(
      { length: 24 },
      (_unused, hour) =>
        cells.find((cell) => cell.weekday === weekday && cell.hour === hour)
          ?.count ?? 0,
    );
    return { name, hours, total: hours.reduce((sum, n) => sum + n, 0) };
  }),
);
const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

const mountChart = (): void => {
  const element = surface.value;
  if (!element || chart) return;
  // A canvas-less environment (jsdom in unit tests, a headless capture) makes ECharts' init
  // throw on a null 2D context; the heatmap is a non-essential view, so a failure there must not
  // tear down the whole 消息史 panel. The data table remains available as the readable fallback.
  try {
    chart = echarts.init(element, undefined, { renderer: "canvas" });
    chart.setOption(option.value);
    observer = new ResizeObserver(() => chart?.resize());
    observer.observe(element);
  } catch {
    chart = null;
  }
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
      <span class="text-sm font-medium text-ink">{{ label }}</span>
      <UiButton
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
        class="h-full w-full"
        role="img"
        :aria-label="`${label}（图表；可切换为数据表）`"
        data-testid="heatmap-surface"
      />
    </div>

    <UiScrollTable v-else :label="label" :height="height" min-width="52rem">
      <template #colgroup>
        <col class="w-14" />
        <col v-for="hour in HOURS" :key="hour" />
        <col class="w-12" />
      </template>
      <template #head>
        <tr>
          <th scope="col" class="px-2 py-2 font-medium">星期</th>
          <th
            v-for="hour in HOURS"
            :key="hour"
            scope="col"
            class="px-1 py-2 text-right font-medium tabular-nums"
          >
            {{ hour }}
          </th>
          <th scope="col" class="px-2 py-2 text-right font-medium">合计</th>
        </tr>
      </template>
      <tr
        v-for="row in rows"
        :key="row.name"
        class="border-b border-border last:border-b-0"
      >
        <th
          scope="row"
          class="px-2 py-1.5 text-xs font-normal whitespace-nowrap text-ink-muted"
        >
          {{ row.name }}
        </th>
        <td
          v-for="(count, hour) in row.hours"
          :key="hour"
          class="px-1 py-1.5 text-right font-mono text-xs tabular-nums"
          :class="count ? 'text-ink' : 'text-ink-subtle'"
        >
          {{ count }}
        </td>
        <td
          class="px-2 py-1.5 text-right font-mono text-xs font-medium tabular-nums text-ink"
        >
          {{ row.total }}
        </td>
      </tr>
    </UiScrollTable>
  </figure>
</template>
