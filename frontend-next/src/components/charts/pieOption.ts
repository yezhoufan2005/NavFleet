import * as echarts from "echarts/core";
import { PieChart } from "echarts/charts";
import { LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import type { ChartPalette } from "@/composables/useChartTheme";
import type { CategoryDatum } from "./categoryBarOption";

/**
 * ECharts pie chart, registered once and only the parts we use.
 *
 * Sibling to `categoryBarOption.ts` / `timeSeriesOption.ts`, same contract: a pure builder so the
 * option is testable without a canvas, colours copied at `setOption` time (so `useChartTheme`
 * rebuilds on a theme switch). Registration is additive and idempotent across the three files.
 *
 * A pie is a weaker tool than a bar for comparing magnitudes, so the severity card keeps the bar
 * a toggle away; the pie is the at-a-glance 占比 view. It carries both channels the method asks
 * for — a legend for identity and a value on each slice — so it never leans on colour alone.
 */
echarts.use([PieChart, LegendComponent, TooltipComponent, CanvasRenderer]);

export { echarts };

export interface PieOptionInput {
  /** Slices: label, value, and a per-slice colour (severity wears its status token). */
  data: readonly CategoryDatum[];
  palette: ChartPalette;
  /** Value suffix in the tooltip and on the slice label (e.g. "条"). */
  unit?: string;
  animate?: boolean;
}

/**
 * Builds the ECharts option for a donut pie.
 *
 * Identity never rides colour alone: a bottom legend names every slice and each slice carries its
 * own value, so a reader who cannot separate two hues still has the name and the number. A 2px
 * surface ring between slices keeps adjacent fills apart (the method's spacer), and zero-value
 * slices are dropped so an absent severity leaves no sliver.
 */
export const buildPieOption = ({
  data,
  palette,
  unit,
  animate = true,
}: PieOptionInput): EChartsOption => {
  const slices = data.filter((datum) => datum.value > 0);
  return {
    animation: animate,
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: palette.surface,
      borderColor: palette.tooltipBorder,
      textStyle: { color: palette.ink, fontSize: 12 },
      formatter: (params) => {
        const point = params as {
          name: string;
          value: number;
          percent: number;
        };
        return `${point.name}: ${point.value}${unit ?? ""} (${point.percent}%)`;
      },
    },
    legend: {
      bottom: 0,
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: palette.inkMuted, fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        // A donut, not a full disc: the hole makes slice-angle comparison a touch easier and
        // leaves the centre clear. Lifted above the bottom legend.
        radius: ["45%", "70%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        // 2px surface ring between slices (the method's fill spacer); 4px rounded like the bars.
        itemStyle: {
          borderColor: palette.surface,
          borderWidth: 2,
          borderRadius: 4,
        },
        // The value on each slice — identity comes from the legend, the number from here.
        label: {
          color: palette.inkMuted,
          fontSize: 11,
          formatter: (params) =>
            `${(params as { value: number }).value}${unit ?? ""}`,
        },
        labelLine: {
          lineStyle: { color: palette.axis },
          length: 8,
          length2: 8,
        },
        emphasis: { focus: "self" },
        data: slices.map((datum) => ({
          name: datum.label,
          value: datum.value,
          ...(datum.color ? { itemStyle: { color: datum.color } } : {}),
        })),
      },
    ],
  };
};
