import * as echarts from "echarts/core";
import { HeatmapChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import type { ChartPalette } from "@/composables/useChartTheme";
import { WEEKDAY_LABELS, type WeekHourCell } from "@/lib/alertStats";

/**
 * 星期 × 小时 onset heatmap, registered with only the parts it needs (Heatmap + VisualMap + grid +
 * tooltip), the same explicit-registration pattern as `categoryBarOption`/`timeSeriesOption`.
 *
 * Sequential by magnitude (dataviz: one hue, low→high): the scale runs from the chart surface (a 0
 * cell blends in) to the notice-blue token, both theme-aware via the palette, so "more blue = more
 * messages" reads the same in light and dark. Pure builder — the option is asserted without a canvas.
 */
echarts.use([
  HeatmapChart,
  VisualMapComponent,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);
export { echarts };

const HOURS = Array.from({ length: 24 }, (_unused, hour) => String(hour));

export interface HeatmapOptionInput {
  cells: readonly WeekHourCell[];
  /** Largest cell count, for the colour scale's upper bound (floored at 1 to avoid 0→0). */
  max: number;
  palette: ChartPalette;
  animate?: boolean;
}

export const buildWeekHourHeatmapOption = ({
  cells,
  max,
  palette,
  animate = true,
}: HeatmapOptionInput): EChartsOption => ({
  animation: animate,
  backgroundColor: "transparent",
  grid: { top: 30, right: 12, bottom: 24, left: 44, containLabel: false },
  tooltip: {
    position: "top",
    backgroundColor: palette.surface,
    borderColor: palette.tooltipBorder,
    textStyle: { color: palette.ink, fontSize: 12 },
    formatter: (params: unknown): string => {
      const point = params as { value: [number, number, number] };
      const [hour, weekday, count] = point.value;
      return `${WEEKDAY_LABELS[weekday] ?? ""} ${hour}:00 · ${count} 条`;
    },
  },
  xAxis: {
    type: "category",
    data: HOURS,
    splitArea: { show: false },
    axisLine: { lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    // 24 hours crowd the axis; label every third (0/3/6…) and keep them small.
    axisLabel: { color: palette.inkMuted, fontSize: 10, interval: 2 },
  },
  yAxis: {
    type: "category",
    data: [...WEEKDAY_LABELS],
    inverse: true,
    splitArea: { show: false },
    axisLine: { lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    axisLabel: { color: palette.inkMuted, fontSize: 11 },
  },
  visualMap: {
    min: 0,
    max: Math.max(1, max),
    calculable: false,
    orient: "horizontal",
    right: 0,
    top: 0,
    itemWidth: 10,
    itemHeight: 64,
    text: ["多", "少"],
    textStyle: { color: palette.inkMuted, fontSize: 10 },
    inRange: { color: [palette.surface, palette.status.notice] },
  },
  series: [
    {
      type: "heatmap",
      data: cells.map((cell) => [cell.hour, cell.weekday, cell.count]),
      // A 1px surface hairline between cells so the grid reads as cells, not a wash.
      itemStyle: { borderColor: palette.surface, borderWidth: 1 },
      emphasis: {
        itemStyle: { borderColor: palette.ink, borderWidth: 1 },
      },
    },
  ],
});
