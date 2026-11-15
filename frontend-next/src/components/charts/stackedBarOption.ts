import type { EChartsOption } from "echarts";
import type { ChartPalette } from "@/composables/useChartTheme";
import { echarts } from "./categoryBarOption";

/**
 * A horizontal **stacked** bar chart — the Top-N device message chart stacks each device's bar by
 * severity (critical / warning / notice) so one row shows both how many messages a vehicle raised
 * and what kind. Sibling to `categoryBarOption` (single series); it reuses that module's ECharts
 * registration (`BarChart` + grid + tooltip), so importing either leaves Bar registered.
 *
 * Built as a pure function so the option is testable without a canvas, like every chart here.
 */
export { echarts };

/** One stacked series: a severity's per-category counts, painted with its own (status) colour. */
export interface StackedSeries {
  name: string;
  color: string;
  data: readonly number[];
}

export interface StackedBarOptionInput {
  /** Category labels (device names), largest first — drawn top-down via the inverse Y axis. */
  categories: readonly string[];
  series: readonly StackedSeries[];
  palette: ChartPalette;
  /** Value-axis unit / tooltip suffix (e.g. "条"). */
  unit?: string;
  animate?: boolean;
}

export const buildStackedBarOption = ({
  categories,
  series,
  palette,
  unit,
  animate = true,
}: StackedBarOptionInput): EChartsOption => ({
  animation: animate,
  backgroundColor: "transparent",
  grid: { top: 28, right: 16, bottom: 12, left: 96, containLabel: false },
  legend: {
    top: 0,
    right: 0,
    icon: "roundRect",
    itemWidth: 10,
    itemHeight: 10,
    textStyle: { color: palette.inkMuted, fontSize: 12 },
  },
  tooltip: {
    trigger: "axis",
    axisPointer: { type: "shadow" },
    backgroundColor: palette.surface,
    borderColor: palette.tooltipBorder,
    textStyle: { color: palette.ink, fontSize: 12 },
    valueFormatter: (value) =>
      typeof value === "number" ? `${value}${unit ?? ""}` : String(value),
  },
  // Value on X; categories on an inverse Y so the largest total sits at the top (Top-N reading).
  xAxis: {
    type: "value",
    name: unit,
    nameTextStyle: { color: palette.inkMuted, fontSize: 11, align: "left" },
    min: 0,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: palette.inkMuted, fontSize: 11 },
    splitLine: { lineStyle: { color: palette.grid, width: 1 } },
    minInterval: 1,
  },
  yAxis: {
    type: "category",
    inverse: true,
    data: [...categories],
    axisLine: { lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    axisLabel: { color: palette.inkMuted, fontSize: 11, hideOverlap: true },
    splitLine: { show: false },
  },
  series: series.map((entry) => ({
    type: "bar",
    name: entry.name,
    stack: "total",
    data: [...entry.data],
    // A 2px surface-coloured hairline between stacked segments, so adjacent severities read apart.
    itemStyle: {
      color: entry.color,
      borderColor: palette.surface,
      borderWidth: 2,
    },
    barMaxWidth: 28,
    emphasis: { focus: "series" },
  })),
});
