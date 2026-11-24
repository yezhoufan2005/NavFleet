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

/** An outer-ring slice: which inner slice it belongs to (`group`) rides along for the tooltip. */
export interface RingDatum extends CategoryDatum {
  group: string;
}

export interface PieOptionInput {
  /** Slices: label, value, and a per-slice colour (severity wears its status token). */
  data: readonly CategoryDatum[];
  palette: ChartPalette;
  /** Value suffix in the tooltip and on the slice label (e.g. "条"). */
  unit?: string;
  animate?: boolean;
  /**
   * A second, outer ring that breaks each inner slice down (e.g. 时长 inside, 严重度 outside).
   * Its slices must come in the inner slices' order, each run summing to its inner slice, so the
   * two rings' angles line up. With it, the inner ring is a pie labelled in place and the legend
   * names the outer ring.
   */
  outer?: readonly RingDatum[];
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
  outer,
}: PieOptionInput): EChartsOption => {
  const slices = data.filter((datum) => datum.value > 0);
  const percentOf = (params: unknown) => {
    const point = params as {
      name: string;
      value: number;
      percent: number;
      data?: { group?: string };
    };
    const name = point.data?.group
      ? `${point.data.group} · ${point.name}`
      : point.name;
    return `${name}: ${point.value}${unit ?? ""} (${point.percent}%)`;
  };
  const tooltip = {
    trigger: "item" as const,
    backgroundColor: palette.surface,
    borderColor: palette.tooltipBorder,
    textStyle: { color: palette.ink, fontSize: 12 },
    formatter: percentOf,
  };
  const ring = {
    borderColor: palette.surface,
    borderWidth: 2,
    borderRadius: 4,
  };
  const toData = (datum: CategoryDatum & { group?: string }) => ({
    name: datum.label,
    value: datum.value,
    ...(datum.group ? { group: datum.group } : {}),
    ...(datum.color ? { itemStyle: { color: datum.color } } : {}),
  });
  if (outer) {
    const outerSlices = outer.filter((datum) => datum.value > 0);
    return {
      animation: animate,
      backgroundColor: "transparent",
      tooltip,
      // The outer ring is the one that needs naming; the inner ring labels itself in place.
      legend: {
        type: "scroll",
        bottom: 0,
        icon: "roundRect",
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: palette.inkMuted, fontSize: 12 },
        pageTextStyle: { color: palette.inkMuted },
        data: [...new Set(outerSlices.map((datum) => datum.label))],
      },
      series: [
        {
          type: "pie",
          radius: ["0%", "36%"],
          center: ["50%", "44%"],
          itemStyle: ring,
          // Labelled inside; a surface-coloured halo keeps the text legible on any fill.
          label: {
            position: "inner",
            color: palette.ink,
            fontSize: 10,
            textBorderColor: palette.surface,
            textBorderWidth: 2,
            formatter: (params) => (params as { name: string }).name,
          },
          emphasis: { focus: "self" },
          data: slices.map(toData),
        },
        {
          type: "pie",
          radius: ["44%", "66%"],
          center: ["50%", "44%"],
          itemStyle: ring,
          // Thin slices: identity is the legend, the number (with its inner slice) the tooltip.
          label: { show: false },
          labelLine: { show: false },
          emphasis: { focus: "self" },
          data: outerSlices.map(toData),
        },
      ],
    };
  }
  return {
    animation: animate,
    backgroundColor: "transparent",
    tooltip,
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
