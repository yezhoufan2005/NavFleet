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
  orientation = "horizontal",
  categoryLabel = "设备",
  categoryWidth = 7,
  labelHidden = false,
  showTableToggle = true,
} = defineProps<{
  categories: readonly string[];
  series: readonly StackedSeries[];
  /** Accessible name for the figure, and the table's caption. */
  label: string;
  unit?: string;
  height?: number;
  /** Keep the card at `height` and let the plot grow downward with one scrollbar past it. */
  scroll?: boolean;
  /** `vertical` for a trend or histogram (see `stackedBarOption`); `scroll` applies to horizontal only. */
  orientation?: "horizontal" | "vertical";
  /** The data table's first-column header — what a category is (设备 / 日期 / 时长). */
  categoryLabel?: string;
  /** The data table's first-column base width in rem: 7 fits a device name, 4 a MM-DD date. */
  categoryWidth?: number;
  /** Keep `label` as the accessible name but drop the visible caption (a parent shows the heading). */
  labelHidden?: boolean;
  /** Show the built-in 图表/数据表 toggle. False when a parent owns the view toggle. */
  showTableToggle?: boolean;
}>();

const { palette, animate } = useChartTheme();

/** Min on-screen slot per bar before the plot outgrows the card and scrolls. */
const SLOT_PX = 34;

const surfaceStyle = computed<CSSProperties>(() =>
  scroll && orientation === "horizontal"
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
    orientation,
  }),
);

/**
 * Each numeric column's width (rem), from its own header: a 2xs CJK glyph is 11px (≤ 0.75rem) and
 * `px-2` adds 1rem, floored at 2.5rem for up to four digits. A fixed 2.5rem split 自动恢复 and
 * 已认领 over two lines; sizing per column (not to the longest) keeps the table inside a
 * one-third card.
 */
const widthFor = (name: string): number =>
  Math.max(2.5, name.length * 0.75 + 1);
const seriesWidths = computed(() =>
  series.map((entry) => widthFor(entry.name)),
);
const TOTAL_WIDTH = widthFor("合计");
const tableMinWidth = computed(
  () =>
    `${categoryWidth + seriesWidths.value.reduce((sum, width) => sum + width, 0) + TOTAL_WIDTH}rem`,
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
    <figcaption
      v-if="!labelHidden || showTableToggle"
      class="flex items-center justify-between gap-3"
    >
      <div v-if="!labelHidden" class="flex items-center gap-2">
        <span class="text-sm font-medium text-ink">{{ label }}</span>
        <!-- Header controls the parent injects (e.g. a Top-N selector), right of the title. -->
        <slot name="actions" />
      </div>
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

    <!-- Every column sized per the shared width standard: the category column has the largest base, each severity
         and the total a narrow numeric one; below `min-width` the table scrolls sideways so 设备
         is never squeezed onto two lines. -->
    <UiScrollTable
      v-else
      :label="label"
      :height="height"
      :min-width="tableMinWidth"
    >
      <template #colgroup>
        <col :style="{ width: `${categoryWidth}rem` }" />
        <col
          v-for="(s, index) in series"
          :key="s.name"
          :style="{ width: `${seriesWidths[index]}rem` }"
        />
        <col :style="{ width: `${TOTAL_WIDTH}rem` }" />
      </template>
      <template #head>
        <tr>
          <th scope="col" class="px-3 py-2 font-medium">
            {{ categoryLabel }}
          </th>
          <th
            v-for="s in series"
            :key="s.name"
            scope="col"
            class="px-2 py-2 text-right font-medium whitespace-nowrap"
          >
            {{ s.name }}
          </th>
          <th
            scope="col"
            class="px-2 py-2 text-right font-medium whitespace-nowrap"
          >
            合计
          </th>
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
