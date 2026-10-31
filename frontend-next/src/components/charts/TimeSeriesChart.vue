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
import UiScrollTable from "@/components/ui/UiScrollTable.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import {
  buildCursorPatch,
  buildTimeSeriesOption,
  echarts,
  type TimeSeries,
} from "./timeSeriesOption";

const {
  series,
  unit,
  height = 260,
  label,
  legendPosition = "top",
  tableMatchHeight = false,
  cursorAt = null,
  xMin,
  xMax,
  yScale = false,
} = defineProps<{
  series: readonly TimeSeries[];
  /** One unit for the chart — see `timeSeriesOption.ts` for why not per series. */
  unit?: string;
  height?: number;
  /** Accessible name for the figure, and the table's caption. */
  label: string;
  /** Legend placement for multi-series charts — `"right"` when a top strip would wrap. */
  legendPosition?: "top" | "right";
  /**
   * Match the table view's total height to the chart's `height`, so toggling 图表 ↔
   * 数据表 keeps the block exactly the same size instead of the table jumping to its own
   * row count. The header stays a fixed row and the records scroll in the remaining
   * space — pixel-exact without guessing a header height. False (the default) keeps the
   * original single-scroller table capped at 24rem for every other chart.
   */
  tableMatchHeight?: boolean;
  /**
   * A vertical cursor at this instant (epoch ms), for history playback. Applied as a
   * separate merge rather than through the option, so a moving cursor does not
   * re-derive the series data every frame — see `buildCursorPatch`.
   */
  cursorAt?: number | null;
  /** Pin the time axis to this window (epoch ms) so it spans the selected range, not just the data. */
  xMin?: number;
  xMax?: number;
  /** Fold the value axis to the data's own range instead of anchoring at 0 (for near-flat series). */
  yScale?: boolean;
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

/**
 * The right-side legend is ours, not ECharts': a plain scrollable HTML column beside the canvas,
 * so many vehicles slide (wheel/drag) instead of paging through ECharts' ▲▼ buttons, and it
 * repaints the instant the series set changes. `seriesColor` reads the same slot-ordered palette
 * the chart uses, so a swatch always matches its line.
 */
const legendRight = computed(
  () => legendPosition === "right" && series.length > 1,
);
const seriesColor = (index: number): string =>
  palette.value.series[index % palette.value.series.length] ??
  palette.value.ink;

/**
 * Give the data table a floor width once it has many columns (one per vehicle), so the cells do
 * not crush together — the block then scrolls horizontally instead. Few columns fit, so no floor.
 */
const tableMinWidth = computed(() =>
  series.length > 3 ? `${200 + series.length * 88}px` : undefined,
);

const option = computed(() =>
  buildTimeSeriesOption({
    series,
    palette: palette.value,
    unit,
    legendPosition,
    animate: animate.value,
    xMin,
    xMax,
    yScale,
  }),
);

/**
 * The cursor, merged over whatever option ECharts is already holding.
 *
 * Called after every `setOption` of the main option as well as on its own, because a
 * merge that replaces the series array drops the `markLine` with it — the cursor has
 * to be re-stated, not just watched.
 */
const applyCursor = (): void => {
  if (!chart) return;
  chart.setOption(
    buildCursorPatch({
      seriesCount: series.length,
      at: cursorAt,
      palette: palette.value,
    }),
  );
};

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
  applyCursor();

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

// `replaceMerge` the series (and legend) so a change that *removes* series actually drops them.
// ECharts' default merge is by index: going from 3 lines to 1 (deselecting vehicles) would leave
// the 2 stale lines on the canvas, and a now-absent `legend` would linger — the "图全出 / 关掉选择
// 不更新，要手动刷新" bug. Everything else (axis, grid, tooltip) still merges, so the axis extent
// ECharts already computed on a pure data update is preserved.
watch(
  option,
  (next) => {
    startedAt = performance.now();
    chart?.setOption(next, { replaceMerge: ["series", "legend"] });
    applyCursor();
  },
  { flush: "post" },
);

// The cursor on its own. This is the playback path — up to twelve times a second —
// and it must not touch the series data.
watch(() => cursorAt, applyCursor, { flush: "post" });

onBeforeUnmount(disposeChart);

/**
 * Rows for the table view: one per timestamp, one column per series.
 *
 * Capped at 500 rows. The device history endpoint returns at most `MAX_HISTORY_POINTS`
 * (500 by default) samples, so there nothing is dropped; the 报表 page's long windows do
 * exceed it (30 days of hourly buckets is 720 timestamps), and then the table takes an
 * even stride through them and says so in a note.
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
/** The table's caption/aria label, noting when rows were down-sampled. */
const tableLabel = computed(() =>
  sampled.value ? `${label}（等距抽样后的 ${rows.value.length} 行）` : label,
);

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
        {{ showTable ? "图表" : "数据表" }}
      </UiButton>
    </figcaption>

    <!-- `v-if`, not `hidden`: see the watcher above for why the instance goes away. -->
    <div
      v-if="!showTable"
      class="flex w-full gap-3"
      :style="{ height: `${height}px` }"
    >
      <div
        ref="surface"
        class="h-full min-w-0 flex-1"
        role="img"
        :aria-label="`${label}（图表；可切换为数据表）`"
        data-testid="chart-surface"
      />
      <!-- Scrollable HTML legend (right position, multi-series): slides, no page triangles. -->
      <ul
        v-if="legendRight"
        class="m-0 flex h-full w-28 shrink-0 list-none flex-col gap-1.5 overflow-y-auto p-0 pr-0.5"
      >
        <li
          v-for="(entry, index) in series"
          :key="entry.name"
          class="flex items-center gap-1.5 text-2xs text-ink-muted"
        >
          <span
            class="size-2.5 shrink-0 rounded-xs"
            :style="{ backgroundColor: seriesColor(index) }"
            aria-hidden="true"
          />
          <span class="truncate" :title="entry.name">{{ entry.name }}</span>
        </li>
      </ul>
    </div>

    <!--
      Data table. The header is its own table outside the scroll box, so the scrollbar runs
      beside the records only — never up through the 时间/值 header row (the shape 曲线 and
      回放 now share). Both tables are `table-fixed` over the same colgroup, so the columns
      line up despite the split. The body scrolls on the y-axis only.

      When `tableMatchHeight` is set, the whole block is pinned to the chart's `height`: the
      header is a fixed row and the records fill the rest, so toggling 图表 ↔ 数据表 does not
      change the block's size. Otherwise the body is capped at 24rem, as every other chart.
    -->
    <!-- Data table — the shared scroll-table shell. `minWidth` gives many vehicle columns room and
         scrolls the whole table horizontally (header + body together); `tableMatchHeight` pins it
         to the chart height, else it caps at 24rem. -->
    <UiScrollTable
      v-else
      :label="tableLabel"
      :height="tableMatchHeight ? height : undefined"
      :max-height="tableMatchHeight ? undefined : '24rem'"
      :min-width="tableMinWidth"
    >
      <template #colgroup>
        <col class="w-[45%]" />
        <col v-for="entry in series" :key="entry.name" />
      </template>
      <template #head>
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
      </template>
      <tr
        v-for="row in rows"
        :key="row.stamp"
        class="border-b border-border last:border-b-0"
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
    </UiScrollTable>
  </figure>
</template>
