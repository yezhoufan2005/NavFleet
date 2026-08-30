import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import type { ChartPalette } from "@/composables/useChartTheme";

/**
 * ECharts, registered once and only the parts we use.
 *
 * `echarts/core` plus explicit `use()` rather than the default bundle: the default
 * pulls every chart type and component, which is most of the library. The console's
 * only chart form today is a time series, so this list is line + the four components
 * it needs. Adding a chart type means adding it here — that is the intended
 * friction, because the alternative is a bundle that grows by accident.
 *
 * Canvas rather than SVG: the baseline in `console-charts.spec.ts` measures the
 * canvas path, and at a few thousand points canvas is the one that holds up. jsdom
 * has no canvas, which is why the unit tests assert on the option we build rather
 * than on rendered output — the option *is* the contract between us and ECharts.
 *
 * `MarkLineComponent` is here for exactly one thing: the history playback cursor
 * (`buildCursorPatch`). Without it registered, `markLine` is silently ignored — the
 * option is accepted and nothing draws.
 */
echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };

/** One measurement over time. `[epoch milliseconds, value]`, oldest first. */
export type TimePoint = readonly [number, number];

export interface TimeSeries {
  name: string;
  points: readonly TimePoint[];
}

export interface TimeSeriesOptionInput {
  series: readonly TimeSeries[];
  palette: ChartPalette;
  /**
   * The unit for the whole chart, not per series — and that is a deliberate
   * structural choice. Two measurements on different scales must become two charts,
   * never two y-axes: a dual-axis chart lets the author place the crossing point
   * anywhere, so the reader sees a relationship that the data does not contain.
   * Making the unit chart-level means the option builder cannot express one.
   */
  unit?: string;
  animate?: boolean;
}

/** Points above this get LTTB-downsampled by ECharts before drawing. */
const SAMPLING_THRESHOLD = 800;

/**
 * Series count at or below which each line also carries its name at its right end.
 * Past that the labels collide and stop being readable, and the legend carries the
 * identity on its own.
 */
const DIRECT_LABEL_LIMIT = 4;

/**
 * Builds the ECharts option for a time series.
 *
 * Pulled out of the component so it can be tested without a canvas, and so the
 * design decisions below are readable in one place rather than spread through a
 * template.
 */
export const buildTimeSeriesOption = ({
  series,
  palette,
  unit,
  animate = true,
}: TimeSeriesOptionInput): EChartsOption => {
  const directLabels = series.length <= DIRECT_LABEL_LIMIT;

  return {
    animation: animate,
    // Colours are assigned in slot order and never cycled: slot N belongs to the
    // Nth series for as long as that series exists, so filtering the list cannot
    // repaint the survivors.
    color: [...palette.series],
    backgroundColor: "transparent",
    // Room on the right for the end labels, and none wasted on a title ECharts
    // would draw in its own font — the surrounding card owns the heading.
    grid: {
      top: series.length > 1 ? 32 : 12,
      right: directLabels ? 72 : 16,
      bottom: 28,
      left: 52,
      containLabel: false,
    },
    legend:
      series.length > 1
        ? {
            top: 0,
            left: 0,
            icon: "roundRect",
            itemWidth: 10,
            itemHeight: 10,
            // Text wears an ink token, never the series colour: the swatch beside
            // it already carries identity.
            textStyle: { color: palette.inkMuted, fontSize: 12 },
          }
        : undefined,
    tooltip: {
      trigger: "axis",
      // A crosshair, because reading one series' value at a moment means reading
      // all of them at the same moment.
      axisPointer: { type: "cross", label: { show: false } },
      backgroundColor: palette.surface,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.ink, fontSize: 12 },
      valueFormatter: (value) =>
        typeof value === "number"
          ? `${value.toFixed(2)}${unit ?? ""}`
          : String(value),
    },
    xAxis: {
      type: "time",
      // Recessive: the data is the subject, the frame is not.
      axisLine: { lineStyle: { color: palette.axis } },
      axisTick: { show: false },
      axisLabel: { color: palette.inkMuted, fontSize: 11, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      name: unit,
      nameTextStyle: { color: palette.inkMuted, fontSize: 11, align: "left" },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.inkMuted, fontSize: 11 },
      splitLine: { lineStyle: { color: palette.grid, width: 1 } },
    },
    series: series.map((entry, index) => ({
      type: "line",
      name: entry.name,
      data: entry.points.map((point) => [point[0], point[1]]),
      // Thin marks. The line is 2px; points are drawn only on hover, because a
      // marker on every sample is noise at telemetry density.
      lineStyle: { width: 2 },
      showSymbol: false,
      symbolSize: 8,
      // Largest-Triangle-Three-Buckets keeps the visual shape — including spikes,
      // which is the whole point for telemetry — while drawing far fewer points.
      sampling: entry.points.length > SAMPLING_THRESHOLD ? "lttb" : undefined,
      emphasis: { focus: "series" },
      endLabel: directLabels
        ? {
            show: true,
            formatter: entry.name,
            color: palette.inkMuted,
            fontSize: 11,
            distance: 6,
          }
        : undefined,
      z: series.length - index,
    })),
  };
};

export const TIME_SERIES_SAMPLING_THRESHOLD = SAMPLING_THRESHOLD;
export const TIME_SERIES_DIRECT_LABEL_LIMIT = DIRECT_LABEL_LIMIT;

export interface CursorPatchInput {
  /** How many series the chart currently has — the patch merges by index. */
  seriesCount: number;
  /** Where the cursor sits, in epoch milliseconds, or `null` for no cursor. */
  at: number | null;
  palette: ChartPalette;
}

/**
 * A patch that moves the playback cursor, and nothing else.
 *
 * Deliberately *not* a parameter of `buildTimeSeriesOption`. During playback the
 * cursor moves up to twelve times a second, and folding it into the option would
 * re-derive every series' point array on every frame — which is the same shape of
 * mistake `useHistoryPlayback` exists to undo, only with the allocation moved from the
 * trail to the chart. Here the data half of the option is built once and the cursor is
 * merged over it by series index, so a frame costs one `markLine`.
 *
 * The line is `inkMuted` rather than a series colour: it marks *where you are*, which
 * is a reading aid, and a coloured one would read as another measurement. It carries no
 * label — the timestamp is already in the playback bar, and a label on a line that
 * moves every 150 ms is unreadable by construction.
 */
export const buildCursorPatch = ({
  seriesCount,
  at,
  palette,
}: CursorPatchInput): EChartsOption => ({
  // One entry per series so ECharts' index merge lines up; only the first carries the
  // cursor, because one vertical line per series would draw the same line N times.
  series: Array.from({ length: Math.max(1, seriesCount) }, (_unused, index) =>
    index === 0
      ? {
          type: "line" as const,
          markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            label: { show: false },
            lineStyle: { color: palette.inkMuted, width: 1, type: "solid" },
            // An empty array clears a cursor that was there — merge replaces arrays
            // wholesale, which is what makes "no cursor" expressible at all.
            data: at === null ? [] : [{ xAxis: at }],
          },
        }
      : { type: "line" as const },
  ),
});
