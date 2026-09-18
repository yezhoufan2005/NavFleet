import * as echarts from "echarts/core";
import { BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import type { ChartPalette } from "@/composables/useChartTheme";

/**
 * ECharts bar chart, registered once and only the parts we use.
 *
 * The sibling `timeSeriesOption.ts` registers Line; this adds Bar for the categorical
 * magnitudes Phase 16B needs — severity distribution, per-device Top-N, per-day frequency.
 * Both files call `echarts.use()`, and registration is additive and idempotent, so importing
 * either (or both) leaves every needed piece registered. Keeping the list explicit is the
 * same intended friction the time-series file documents: a new chart type is a deliberate line
 * here, not an accidental bundle.
 *
 * jsdom has no canvas, so the unit tests assert on the option object this builds rather than
 * on rendered output — the option is the contract with ECharts.
 */
echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer]);

export { echarts };

/** One bar: a label and its magnitude, with an optional explicit colour. */
export interface CategoryDatum {
  label: string;
  value: number;
  /** Overrides the chart's single colour — used to paint severity bars with status tokens. */
  color?: string;
}

export type BarOrientation = "horizontal" | "vertical";

export interface CategoryBarOptionInput {
  data: readonly CategoryDatum[];
  palette: ChartPalette;
  /** Axis unit / value suffix in the tooltip (e.g. "条"). */
  unit?: string;
  /** Bar direction. Horizontal reads long category labels (device names) without rotation. */
  orientation?: BarOrientation;
  /** Single bar colour when a datum carries none. Defaults to the first series slot. */
  color?: string;
  animate?: boolean;
}

/**
 * Builds the ECharts option for a categorical bar chart.
 *
 * Pulled out of the component so the design decisions are testable without a canvas:
 * one value axis (never two), recessive frame, tooltip on ink tokens, and a per-datum colour
 * that lets severity wear its status token while a plain magnitude chart stays single-hued.
 */
export const buildCategoryBarOption = ({
  data,
  palette,
  unit,
  orientation = "vertical",
  color,
  animate = true,
}: CategoryBarOptionInput): EChartsOption => {
  const horizontal = orientation === "horizontal";
  const single = color ?? palette.series[0] ?? "#2a78d6";
  const labels = data.map((datum) => datum.label);

  const categoryAxis = {
    type: "category" as const,
    data: labels,
    axisLine: { lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    axisLabel: { color: palette.inkMuted, fontSize: 11, hideOverlap: true },
    splitLine: { show: false },
  };
  const valueAxis = {
    type: "value" as const,
    name: unit,
    nameTextStyle: {
      color: palette.inkMuted,
      fontSize: 11,
      align: "left" as const,
    },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: palette.inkMuted, fontSize: 11 },
    splitLine: { lineStyle: { color: palette.grid, width: 1 } },
    // Counts are whole numbers; fractional ticks on a "3 alerts" axis read as noise.
    minInterval: 1,
  };

  return {
    animation: animate,
    backgroundColor: "transparent",
    grid: {
      top: 12,
      right: 16,
      // Horizontal bars need room on the left for the category labels; vertical need it below.
      bottom: horizontal ? 12 : 28,
      left: horizontal ? 96 : 44,
      containLabel: false,
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
    // Horizontal: category on Y, value on X. Vertical: the reverse. `inverse` on the Y
    // category axis puts the largest bar at the top for the Top-N reading.
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
    series: [
      {
        type: "bar",
        data: data.map((datum) => ({
          value: datum.value,
          itemStyle: { color: datum.color ?? single, borderRadius: 4 },
        })),
        barMaxWidth: 28,
        emphasis: { focus: "self" },
      },
    ],
  };
};
