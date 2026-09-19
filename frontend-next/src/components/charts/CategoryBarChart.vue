<script setup lang="ts">
/**
 * A categorical bar chart, plus the data table that stands in for it.
 *
 * Sibling to `TimeSeriesChart.vue` and built on the same contract: the option is produced by a
 * pure builder (`categoryBarOption.ts`) so it is testable without a canvas, ECharts copies
 * colours at `setOption` time so a theme switch rebuilds the option (`useChartTheme` watches),
 * and a data table ships alongside because identity/magnitude must be readable without colour.
 *
 * Used by the 告警史 page for severity distribution, per-device Top-N and per-day frequency.
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import type { CSSProperties } from "vue";
import type { ECharts } from "echarts/core";
import UiButton from "@/components/ui/UiButton.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import {
  buildCategoryBarOption,
  echarts,
  type BarOrientation,
  type CategoryDatum,
} from "./categoryBarOption";

const {
  data,
  label,
  unit,
  height = 260,
  orientation = "vertical",
  color,
  scroll = false,
} = defineProps<{
  data: readonly CategoryDatum[];
  /** Accessible name for the figure, and the table's caption. */
  label: string;
  unit?: string;
  height?: number;
  orientation?: BarOrientation;
  color?: string;
  /**
   * Keep the card at `height` and let the plot grow past it with one scrollbar, instead of
   * compressing every bar to fit. Horizontal bars grow downward (vertical scroll), vertical
   * bars grow rightward (horizontal scroll). Off by default — a fixed 3-bar chart needs none.
   */
  scroll?: boolean;
}>();

const { palette, animate } = useChartTheme();

/** Min on-screen slot per bar before the plot outgrows the card and scrolls. */
const SLOT_PX = 32;

/**
 * The plotting surface size. Without `scroll` it fills the fixed-height card. With it, the
 * card stays `height` and scrolls while the surface grows along the bars' axis — down for
 * horizontal bars, right for vertical — so a long Top-N or a wide day range stays readable.
 */
const surfaceStyle = computed<CSSProperties>(() => {
  if (!scroll) return { width: "100%", height: "100%" };
  const extent = data.length * SLOT_PX;
  return orientation === "horizontal"
    ? { width: "100%", height: `${Math.max(height, extent)}px` }
    : { height: "100%", minWidth: `${extent}px` };
});

const surface = useTemplateRef<HTMLElement>("surface");
const showTable = ref(false);
let chart: ECharts | null = null;
let observer: ResizeObserver | null = null;

const option = computed(() =>
  buildCategoryBarOption({
    data,
    palette: palette.value,
    unit,
    orientation,
    color,
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
    <figcaption class="flex items-center justify-between gap-3">
      <span class="text-sm font-medium text-ink">{{ label }}</span>
      <UiButton
        variant="ghost"
        size="sm"
        :aria-pressed="showTable"
        @click="showTable = !showTable"
      >
        {{ showTable ? "看图表" : "看数据表" }}
      </UiButton>
    </figcaption>

    <div
      v-if="!showTable"
      class="w-full overflow-auto"
      :style="{ height: `${height}px` }"
    >
      <div
        ref="surface"
        :style="surfaceStyle"
        role="img"
        :aria-label="`${label}（图表；可切换为数据表）`"
        data-testid="bar-surface"
      />
    </div>

    <div
      v-else
      class="max-h-96 overflow-auto rounded-sm border border-border"
      tabindex="0"
      role="region"
      :aria-label="`${label} 数据表`"
    >
      <table class="w-full border-collapse text-left text-sm">
        <caption class="sr-only">
          {{
            label
          }}
        </caption>
        <thead
          class="sticky top-0 bg-surface-sunken text-2xs text-ink-muted uppercase"
        >
          <tr>
            <th scope="col" class="px-3 py-2 font-medium">项</th>
            <th scope="col" class="px-3 py-2 font-medium">
              数值<template v-if="unit"> ({{ unit }})</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="datum in data"
            :key="datum.label"
            class="border-t border-border"
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
        </tbody>
      </table>
    </div>
  </figure>
</template>
