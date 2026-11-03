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
 * pulls every chart type and component, which is most of the library. This file
 * registers what the time series needs (line + four components); the bar chart
 * registers its own in `categoryBarOption.ts`. Adding a chart type means adding it
 * explicitly — that is the intended friction, because the alternative is a bundle that
 * grows by accident.
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
  /**
   * Which value axis this line reads. `"left"` (the default) is the only axis unless the
   * chart opts into `rightAxis`; `"right"` binds the line to that second axis. See the
   * `unit` note for why a second axis exists at all and stays off by default.
   */
  axis?: "left" | "right";
}

export interface TimeSeriesOptionInput {
  series: readonly TimeSeries[];
  palette: ChartPalette;
  /**
   * The unit for the left value axis. By default it is the unit for the *whole* chart,
   * and that is a deliberate structural choice: two measurements on different scales
   * normally become two charts, never two y-axes, because a dual-axis chart lets the
   * author place the crossing point anywhere and so shows a relationship the data does
   * not contain. The default path cannot express a second axis, which keeps that mistake
   * out of reach by accident. The one exception is `rightAxis` below — an explicit,
   * opt-in second axis for the single case where one reader must watch two bounded
   * measures against a shared timeline (回放's speed and charge), and the cost of two
   * stacked charts is vertical space the view does not have.
   */
  unit?: string;
  /**
   * Where the legend sits when there is more than one series. `"top"` (the default) is a
   * horizontal strip above the plot; `"right"` is a vertical list beside it — which a chart
   * with many series (e.g. one line per vehicle on the reports page) needs, because a top
   * strip wraps over several rows and covers the plot.
   */
  legendPosition?: "top" | "right";
  animate?: boolean;
  /**
   * Pin the time axis to the selected window (epoch ms) rather than letting it shrink to the data
   * extent. Picking 近 12 小时 should show a 12-hour axis even when telemetry only covers part of
   * it; without this the axis ends at the last sample and 「选 12 小时却只显示 8 小时」.
   */
  xMin?: number;
  xMax?: number;
  /**
   * Let the value axis zoom to the data's own min/max instead of anchoring at 0. 在线率 lives at
   * 95–100% almost always, so a 0-based axis flattens every dip into the top edge; scaling folds
   * the axis to the curve's range so the variation is actually visible.
   */
  yScale?: boolean;
  /**
   * Fix the value-axis bounds. Leave both unset for the default (anchored at 0, auto max — speed
   * wants 下界0固定、上界随数据); set both for a known full range (电量 is 0–100, so it gets a
   * fixed 0/100 axis rather than a dynamic one that would make a 70→72% wiggle look dramatic).
   */
  yMin?: number;
  yMax?: number;
  /**
   * Opt into a second, right-hand value axis for series marked `axis: "right"`. Off by
   * default (see `unit`): drawn only when this is set, and only 回放 sets it — speed on
   * the left (0 … auto), charge on the right (a fixed 0–100), both over one time axis so
   * the operator reads how fast and how full at the same instant without a second chart.
   * Its own bounds live here; the left axis keeps using `yMin`/`yMax`/`yScale`.
   */
  rightAxis?: { unit?: string; yMin?: number; yMax?: number };
  /**
   * Per-chart color override, in series order. Defaults to the palette's fixed slot order;
   * pass this only to re-order the hues for one chart (the 历史曲线's three days want 蓝绿橙,
   * not the slot-order 蓝橙绿).
   */
  colors?: readonly string[];
  /**
   * Render the time axis as one 00:00–24:00 day: flat (un-rotated) HH:mm labels, and 24:00
   * rather than 00:00 at the far-right max tick. For the 历史曲线, where every day is overlaid
   * on a single day-of-the-clock axis and the span is wide enough that tilting is just noise.
   */
  dayAxis?: boolean;
  /**
   * Tune the update for a ~1 Hz flowing window: the line morphs to its new state over roughly
   * one tick (linear), so appending a second reads as the curve sliding left and extending, not
   * redrawing from scratch. The component also skips `replaceMerge` while streaming so ECharts
   * updates the existing series instead of replacing it (a replace restarts the draw animation).
   */
  streaming?: boolean;
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
  legendPosition = "top",
  animate = true,
  xMin,
  xMax,
  yScale = false,
  yMin,
  yMax,
  colors,
  dayAxis = false,
  streaming = false,
  rightAxis,
}: TimeSeriesOptionInput): EChartsOption => {
  const legendRight = legendPosition === "right" && series.length > 1;
  const hasRightAxis = rightAxis !== undefined;
  // End labels and a right-side legend both claim the right margin, so they are mutually
  // exclusive: with the legend on the right, identity comes from it, not from end labels.
  // A right value axis also owns that margin, and there identity comes from the (top) legend.
  const directLabels =
    series.length <= DIRECT_LABEL_LIMIT && !legendRight && !hasRightAxis;
  // The unit that belongs to a series, by the axis it reads — for the tooltip and nothing
  // else. Left is the chart unit; right is the second axis's own unit.
  const unitFor = (entry: TimeSeries): string =>
    (entry.axis === "right" ? rightAxis?.unit : unit) ?? "";
  // When the axis is pinned to a fixed window (reports), tilt the time labels so none is dropped
  // for lack of room — 选 12 小时时 22:00 被挤掉就是平排标签相撞被 hideOverlap 丢了。A day axis
  // is wide and its ticks are whole hours, so it stays flat instead.
  const tilt = xMin !== undefined && xMax !== undefined && !dayAxis;
  const seriesColors = colors ?? palette.series;
  // A day-of-the-clock axis labels every tick HH:mm, and the far-right boundary (the next
  // midnight, === xMax) as 24:00 rather than a wrapped 00:00.
  const dayAxisFormatter = (value: number): string => {
    if (xMax !== undefined && value >= xMax) return "24:00";
    const date = new Date(value);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  return {
    // A streaming window renders every frame at its final position with no animation: the entrance
    // tween (and the vertical re-tween when the auto max shifts) is what made the line "从上划到下"
    // on load and each update. The flow comes from the window advancing ~1px/s, which needs none.
    animation: streaming ? false : animate,
    // Colours are assigned in slot order and never cycled: slot N belongs to the
    // Nth series for as long as that series exists, so filtering the list cannot
    // repaint the survivors.
    color: [...seriesColors],
    backgroundColor: "transparent",
    // Room on the right for the end labels (or the legend), and none wasted on a title
    // ECharts would draw in its own font — the surrounding card owns the heading.
    grid: {
      top: series.length > 1 && !legendRight ? 32 : 12,
      right: hasRightAxis ? 52 : directLabels ? 72 : 16,
      bottom: tilt ? 40 : 28,
      left: 52,
      containLabel: false,
    },
    // A right-side legend is rendered by the component as a scrollable HTML column beside the
    // canvas (真·滑动，无上下翻页三角 — ECharts' built-in legend only scrolls via page buttons),
    // so the option emits no ECharts legend for that case. A top legend is still ECharts' own.
    legend:
      !legendRight && series.length > 1
        ? {
            top: 0,
            // Top-right by default. With a right axis that corner is taken by the axis
            // name (电量's %), which would sit under the legend — so a dual-axis chart
            // centres the legend instead.
            ...(hasRightAxis ? { left: "center" } : { right: 0 }),
            icon: "roundRect",
            itemWidth: 10,
            itemHeight: 10,
            type: "scroll",
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
      // With one axis every value wears the same unit, so the simple per-value formatter
      // does. With two axes a value's unit depends on which series it belongs to, which
      // the per-value hook cannot see — so that case formats the whole row itself, giving
      // each line its own axis's unit (速度 m/s, 电量 %).
      ...(hasRightAxis
        ? {
            formatter: (params: unknown): string => {
              const items = (Array.isArray(params) ? params : [params]) as {
                seriesIndex: number;
                seriesName: string;
                marker: string;
                axisValueLabel?: string;
                value?: [number, number] | number;
              }[];
              const head = items[0]?.axisValueLabel ?? "";
              const rows = items.map((item) => {
                const raw = Array.isArray(item.value)
                  ? item.value[1]
                  : item.value;
                const shown =
                  typeof raw === "number" ? raw.toFixed(2) : String(raw ?? "");
                const entry = series[item.seriesIndex];
                const u = entry ? unitFor(entry) : "";
                return `${item.marker}${item.seriesName}: ${shown}${u}`;
              });
              return [head, ...rows].join("<br/>");
            },
          }
        : {
            valueFormatter: (value) =>
              typeof value === "number"
                ? `${value.toFixed(2)}${unit ?? ""}`
                : String(value),
          }),
    },
    xAxis: {
      type: "time",
      // Span the selected window when given, so the axis does not shrink to the data extent.
      min: xMin,
      max: xMax,
      // Recessive: the data is the subject, the frame is not.
      axisLine: { lineStyle: { color: palette.axis } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.inkMuted,
        fontSize: 11,
        hideOverlap: true,
        rotate: tilt ? 30 : 0,
        formatter: dayAxis ? dayAxisFormatter : undefined,
      },
      splitLine: { show: false },
    },
    // One value axis by default. A second, right-hand axis is drawn only when `rightAxis`
    // opts in (回放): the left keeps 速度 (0 … auto), the right carries 电量 on its own
    // 0–100, and only the left paints gridlines so the plot does not wear two grids.
    yAxis: hasRightAxis
      ? [
          {
            type: "value",
            name: unit,
            scale: yScale,
            min: yMin,
            max: yMax,
            nameTextStyle: {
              color: palette.inkMuted,
              fontSize: 11,
              align: "left",
            },
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { color: palette.inkMuted, fontSize: 11 },
            splitLine: { lineStyle: { color: palette.grid, width: 1 } },
          },
          {
            type: "value",
            name: rightAxis?.unit,
            position: "right",
            min: rightAxis?.yMin,
            max: rightAxis?.yMax,
            nameTextStyle: {
              color: palette.inkMuted,
              fontSize: 11,
              align: "right",
            },
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { color: palette.inkMuted, fontSize: 11 },
            splitLine: { show: false },
          },
        ]
      : {
          type: "value",
          name: unit,
          // Fold the axis to the data range when asked (在线率 hugs 100%); otherwise anchor at 0.
          scale: yScale,
          // Fixed bounds win when given (电量 0–100). Left undefined, ECharts keeps its own —
          // which with `scale: false` is 0 … auto-max, i.e. 下界0固定、上界随数据.
          min: yMin,
          max: yMax,
          nameTextStyle: {
            color: palette.inkMuted,
            fontSize: 11,
            align: "left",
          },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: palette.inkMuted, fontSize: 11 },
          splitLine: { lineStyle: { color: palette.grid, width: 1 } },
        },
    series: series.map((entry, index) => ({
      type: "line",
      name: entry.name,
      // Bind to the right axis when the series asks for it; 0 (the left/only axis) otherwise.
      yAxisIndex: entry.axis === "right" ? 1 : 0,
      data: entry.points.map((point) => [point[0], point[1]]),
      // Thin marks. The line is 2px; points are drawn only on hover, because a
      // marker on every sample is noise at telemetry density.
      lineStyle: { width: 2 },
      // Draw the line even where it sits on the grid edge. A value pinned at the axis max (100%
      // 在线率 is dead flat at the top) was half-clipped by the plot boundary and read as a ~1px
      // hairline — `clip:false` lets the full 2px stroke show.
      clip: false,
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
