<script setup lang="ts">
/**
 * A time-series chart, plus the data table that stands in for it.
 *
 * The table is not an extra. The series palette clears every hard gate of the
 * data-viz method on both of our surfaces, but it lands in the **contrast WARN**
 * band — three slots in light, four in dark, sit below 3:1 against
 * `surface-raised`. That band comes with an obligation rather than a shrug: the
 * values have to be readable through a second channel. So this component ships a
 * table view, and removing it would make the palette non-compliant rather than
 * merely make the component smaller.
 *
 * Two more things follow from the same method:
 *
 * - **A legend appears for two or more series, never for one.** With one series the
 *   heading already names it, and a legend box would be a swatch next to the only
 *   thing it could refer to.
 * - **Identity is never colour alone.** Up to four series also carry their name at
 *   the line's right end, so a reader who cannot separate two hues still can.
 *
 * ECharts copies colours at `setOption` time, so a theme switch has to rebuild the
 * option — that is what `useChartTheme` watches for.
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import type { ECharts } from "echarts/core";
import UiButton from "@/components/ui/UiButton.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import {
  buildTimeSeriesOption,
  echarts,
  type TimeSeries,
} from "./timeSeriesOption";

const {
  series,
  unit,
  height = 260,
  label,
} = defineProps<{
  series: readonly TimeSeries[];
  /** One unit for the chart — see `timeSeriesOption.ts` for why not per series. */
  unit?: string;
  height?: number;
  /** Accessible name for the figure, and the table's caption. */
  label: string;
}>();

/**
 * Fires when ECharts reports it has finished drawing, carrying the milliseconds
 * since the option was handed over. It exists for the performance baseline in
 * `console-charts.spec.ts`: measuring from outside the component would time Vue's
 * scheduler as well, and measuring `setOption`'s return would miss the drawing,
 * which is the part that gets slow.
 */
const emit = defineEmits<{ rendered: [durationMs: number] }>();

const { palette, animate } = useChartTheme();

const surface = useTemplateRef<HTMLElement>("surface");
const showTable = ref(false);
let chart: ECharts | null = null;
let observer: ResizeObserver | null = null;
/** When the current option was handed to ECharts; null once its render is timed. */
let startedAt: number | null = null;

const option = computed(() =>
  buildTimeSeriesOption({
    series,
    palette: palette.value,
    unit,
    animate: animate.value,
  }),
);

const mountChart = (): void => {
  const element = surface.value;
  if (!element || chart) return;

  chart = echarts.init(element, undefined, { renderer: "canvas" });
  chart.on("finished", () => {
    if (startedAt !== null) {
      emit("rendered", performance.now() - startedAt);
      startedAt = null;
    }
  });
  startedAt = performance.now();
  chart.setOption(option.value);

  // The chart has no intrinsic size — it fills its box, so it has to be told when
  // the box changes. A window `resize` listener would miss the sidebar collapsing.
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(element);
};

const disposeChart = (): void => {
  observer?.disconnect();
  observer = null;
  chart?.dispose();
  chart = null;
};

/**
 * Mount only while the chart is the visible view. Switching to the table disposes
 * the instance rather than leaving a canvas ticking behind a `hidden` attribute —
 * on the wall display, that is the difference between an idle screen and one
 * animating something nobody is looking at.
 */
watch(
  [showTable, surface],
  ([tableVisible]) => {
    if (tableVisible) disposeChart();
    else mountChart();
  },
  { flush: "post" },
);

// `notMerge: false` on purpose: an update that only changes the data should not
// throw away the axis extent ECharts has already computed.
watch(
  option,
  (next) => {
    startedAt = performance.now();
    chart?.setOption(next);
  },
  { flush: "post" },
);

onBeforeUnmount(disposeChart);

/**
 * Rows for the table view: one per timestamp, one column per series.
 *
 * Capped, and the cap is honest rather than arbitrary — the history endpoint returns
 * at most 500 samples, so in practice nothing is dropped; a caller that hands over
 * more gets an even stride through them and a note saying so.
 */
const TABLE_ROW_LIMIT = 500;

const stamps = computed(() => {
  const all = new Set<number>();
  for (const entry of series) {
    for (const point of entry.points) all.add(point[0]);
  }
  return [...all].sort((left, right) => left - right);
});

const rows = computed(() => {
  const all = stamps.value;
  const stride = Math.max(1, Math.ceil(all.length / TABLE_ROW_LIMIT));
  const byStamp = series.map((entry) => new Map(entry.points));

  return all
    .filter((_stamp, index) => index % stride === 0)
    .map((stamp) => ({
      stamp,
      values: byStamp.map((lookup) => lookup.get(stamp)),
    }));
});

const sampled = computed(() => stamps.value.length > TABLE_ROW_LIMIT);

const formatStamp = (stamp: number): string =>
  new Date(stamp).toLocaleString(undefined, { hour12: false });
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

    <!-- `v-if`, not `hidden`: see the watcher above for why the instance goes away. -->
    <div
      v-if="!showTable"
      ref="surface"
      class="w-full"
      :style="{ height: `${height}px` }"
      role="img"
      :aria-label="`${label}（图表；可切换为数据表）`"
      data-testid="chart-surface"
    />

    <div v-else class="max-h-96 overflow-auto rounded-sm border border-border">
      <table class="w-full border-collapse text-left text-sm">
        <caption class="sr-only">
          {{
            label
          }}
          <template v-if="sampled"
            >（等距抽样后的 {{ rows.length }} 行）</template
          >
        </caption>
        <thead
          class="sticky top-0 bg-surface-sunken text-2xs text-ink-muted uppercase"
        >
          <tr>
            <th scope="col" class="px-3 py-2 font-medium">时间</th>
            <th
              v-for="entry in series"
              :key="entry.name"
              scope="col"
              class="px-3 py-2 font-medium"
            >
              {{ entry.name }}<template v-if="unit"> ({{ unit }})</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.stamp"
            class="border-t border-border"
          >
            <th
              scope="row"
              class="px-3 py-1.5 font-mono text-xs font-normal whitespace-nowrap text-ink-muted"
            >
              {{ formatStamp(row.stamp) }}
            </th>
            <td
              v-for="(value, index) in row.values"
              :key="index"
              class="px-3 py-1.5 font-mono text-xs text-ink"
            >
              {{ value === undefined ? "--" : value.toFixed(2) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </figure>
</template>
