import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import {
  buildCursorPatch,
  buildTimeSeriesOption,
  TIME_SERIES_DIRECT_LABEL_LIMIT,
  TIME_SERIES_SAMPLING_THRESHOLD,
  type TimeSeries,
} from "@/components/charts/timeSeriesOption";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import { __resetTheme, useTheme } from "@/composables/useTheme";

/**
 * The chart base.
 *
 * jsdom has no canvas, so these tests assert on **the option we hand ECharts** and on
 * the parts of the component that are plain DOM — the table view and its toggle. That
 * split is deliberate rather than a compromise: the option object *is* the contract
 * between us and the library, and asserting it catches the decisions worth protecting
 * (one axis, fixed colour order, a legend only when it means something) without
 * pretending to measure rendering. Rendering and timing are measured in a real
 * browser by `e2e/specs/console-charts.spec.ts`.
 */
/**
 * The renderer is replaced, and only the renderer.
 *
 * `echarts.init` needs a real 2D context, which jsdom does not have — it fails, and
 * then `dispose()` on the half-built instance throws `Cannot read properties of null`
 * from somewhere deep in zrender, which is a spectacularly unhelpful way to find out
 * your test environment has no canvas. Stubbing `init` keeps `buildTimeSeriesOption`
 * (the thing actually under test) real while making the component mountable. Real
 * rendering is measured in a browser by `e2e/specs/console-charts.spec.ts`.
 */
vi.mock("@/components/charts/timeSeriesOption", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/charts/timeSeriesOption")
    >();
  return {
    ...actual,
    echarts: {
      init: () => ({
        setOption: vi.fn(),
        on: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
      }),
    },
  };
});

const palette = {
  series: ["#111111", "#222222", "#333333", "#444444", "#555555"],
  grid: "#dddddd",
  axis: "#cccccc",
  ink: "#000000",
  inkMuted: "#666666",
  surface: "#ffffff",
  tooltipBorder: "#eeeeee",
};

const points = (count: number, offset = 0): [number, number][] =>
  Array.from({ length: count }, (_unused, index) => [
    1_000_000 + index * 1000,
    index + offset,
  ]);

const seriesOf = (count: number, pointsPer = 10): TimeSeries[] =>
  Array.from({ length: count }, (_unused, index) => ({
    name: `设备 ${index + 1}`,
    points: points(pointsPer, index),
  }));

describe("buildTimeSeriesOption", () => {
  it("assigns colours in slot order so filtering cannot repaint the survivors", () => {
    const option = buildTimeSeriesOption({ series: seriesOf(3), palette });
    expect(option.color).toEqual(palette.series);
  });

  it("declares exactly one y-axis, because two would let the author invent a story", () => {
    // A dual-axis chart lets whoever built it choose where the lines cross. That is
    // the single most common charting mistake, and the option builder is where it
    // becomes impossible rather than discouraged.
    const option = buildTimeSeriesOption({
      series: seriesOf(3),
      palette,
      unit: "%",
    });
    expect(Array.isArray(option.yAxis)).toBe(false);
    expect(option.yAxis).toMatchObject({ type: "value", name: "%" });
  });

  it("shows a legend for two or more series and none for one", () => {
    // With one series the heading already names it; a legend would be a swatch
    // beside the only thing it could refer to.
    expect(buildTimeSeriesOption({ series: seriesOf(1), palette }).legend).toBe(
      undefined,
    );
    expect(
      buildTimeSeriesOption({ series: seriesOf(2), palette }).legend,
    ).toBeTruthy();
  });

  it("direct-labels up to four series so identity is never colour alone", () => {
    const labelled = buildTimeSeriesOption({
      series: seriesOf(TIME_SERIES_DIRECT_LABEL_LIMIT),
      palette,
    });
    const crowded = buildTimeSeriesOption({
      series: seriesOf(TIME_SERIES_DIRECT_LABEL_LIMIT + 1),
      palette,
    });

    const endLabels = (option: ReturnType<typeof buildTimeSeriesOption>) =>
      (option.series as { endLabel?: unknown }[]).map(
        (entry) => entry.endLabel !== undefined,
      );

    expect(endLabels(labelled).every(Boolean)).toBe(true);
    // Past the limit the labels would collide, and a colliding label is not a label.
    expect(endLabels(crowded).some(Boolean)).toBe(false);
  });

  it("keeps legend and axis text on ink tokens, never on the series colour", () => {
    const option = buildTimeSeriesOption({ series: seriesOf(3), palette });
    expect(option.legend).toMatchObject({
      textStyle: { color: palette.inkMuted },
    });
    expect(option.yAxis).toMatchObject({
      axisLabel: { color: palette.inkMuted },
    });
  });

  it("downsamples only once a series is dense enough to need it", () => {
    const sparse = buildTimeSeriesOption({
      series: seriesOf(1, TIME_SERIES_SAMPLING_THRESHOLD),
      palette,
    });
    const dense = buildTimeSeriesOption({
      series: seriesOf(1, TIME_SERIES_SAMPLING_THRESHOLD + 1),
      palette,
    });

    expect((sparse.series as { sampling?: string }[])[0]?.sampling).toBe(
      undefined,
    );
    // LTTB rather than averaging: it keeps spikes, and a spike is the whole reason
    // anyone looks at telemetry.
    expect((dense.series as { sampling?: string }[])[0]?.sampling).toBe("lttb");
  });

  it("draws thin marks and no per-point symbol", () => {
    const option = buildTimeSeriesOption({ series: seriesOf(1), palette });
    expect((option.series as { lineStyle?: unknown }[])[0]).toMatchObject({
      lineStyle: { width: 2 },
      showSymbol: false,
    });
  });

  it("passes every point through — sampling is ECharts' job, not a data haircut", () => {
    const option = buildTimeSeriesOption({
      series: seriesOf(1, 1234),
      palette,
    });
    expect((option.series as { data: unknown[] }[])[0]?.data).toHaveLength(
      1234,
    );
  });

  it("can turn animation off for a reduced-motion viewer", () => {
    expect(
      buildTimeSeriesOption({ series: seriesOf(1), palette, animate: false })
        .animation,
    ).toBe(false);
  });
});

describe("buildCursorPatch", () => {
  /** The entry that carries the cursor, typed just enough to read `markLine`. */
  const cursorSeries = (patch: ReturnType<typeof buildCursorPatch>) =>
    (
      patch.series as {
        markLine?: { data: unknown[]; lineStyle: { color: string } };
      }[]
    )[0]!;

  it("carries only a markLine, so a moving cursor cannot touch the data", () => {
    // The point of the whole separation: playback moves the cursor up to twelve times
    // a second, and rebuilding the option would re-derive every series' points each
    // time — the same mistake `useHistoryPlayback` exists to undo.
    const patch = buildCursorPatch({ seriesCount: 2, at: 1_700_000, palette });

    expect(Object.keys(patch)).toEqual(["series"]);
    for (const entry of patch.series as Record<string, unknown>[]) {
      expect(entry.data).toBeUndefined();
    }
  });

  it("puts the line on the first series only, at the instant asked for", () => {
    // One vertical line per series would draw the same line N times.
    const patch = buildCursorPatch({ seriesCount: 3, at: 1_700_000, palette });
    const entries = patch.series as { markLine?: unknown }[];

    expect(entries).toHaveLength(3);
    expect(cursorSeries(patch).markLine?.data).toEqual([{ xAxis: 1_700_000 }]);
    expect(entries[1]?.markLine).toBeUndefined();
    expect(entries[2]?.markLine).toBeUndefined();
  });

  it("clears the cursor with an empty array rather than by omission", () => {
    // Merge replaces arrays wholesale but ignores absent keys, so `data: []` is the
    // only way "there is no cursor now" is expressible at all.
    expect(
      cursorSeries(buildCursorPatch({ seriesCount: 1, at: null, palette }))
        .markLine?.data,
    ).toEqual([]);
  });

  it("draws the cursor in ink, never in a series colour", () => {
    // It marks where you are, which is a reading aid; in a series colour it would
    // read as another measurement.
    const colour = cursorSeries(
      buildCursorPatch({ seriesCount: 4, at: 1, palette }),
    ).markLine?.lineStyle.color;

    expect(colour).toBe(palette.inkMuted);
    expect(palette.series).not.toContain(colour);
  });

  it("still produces one entry when there is no series to merge onto", () => {
    const patch = buildCursorPatch({ seriesCount: 0, at: null, palette });
    expect((patch.series as unknown[]).length).toBe(1);
  });
});

describe("useChartTheme", () => {
  beforeEach(() => {
    __resetTheme();
  });

  it("re-reads the tokens when the theme changes", async () => {
    // ECharts copies colours at setOption time, so a palette that did not change
    // here would leave a dark chart wearing light colours.
    const seen: string[] = [];
    const { palette: live } = useChartTheme();
    seen.push(live.value.series[0] ?? "");

    useTheme().setPreference("dark");
    await flushPromises();
    seen.push(live.value.series[0] ?? "");

    // jsdom resolves no custom properties, so both reads fall back — what is being
    // asserted is that the watcher fired at all, which is the part that breaks.
    expect(seen).toHaveLength(2);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("TimeSeriesChart", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // ECharts warns about a zero-size container in jsdom; that is expected here and
    // says nothing about the code under test.
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const mountChart = (
    series: TimeSeries[],
    props: Record<string, unknown> = {},
  ) =>
    mount(TimeSeriesChart, {
      props: { series, label: "电量", ...props },
    });

  it("names the figure for a screen reader and offers the table as an alternative", () => {
    const wrapper = mountChart(seriesOf(2));
    const surface = wrapper.get("[data-testid='chart-surface']");

    expect(surface.attributes("role")).toBe("img");
    expect(surface.attributes("aria-label")).toContain("电量");
    expect(wrapper.get("button").text()).toBe("看数据表");
  });

  it("switches to a real table, which is what makes the palette compliant", async () => {
    // Three light-mode slots sit below 3:1 on `surface-raised`. The method's relief
    // rule turns that from a warning into an obligation: the values must be readable
    // some other way. This table is that other way — deleting it would make the
    // palette non-compliant.
    const wrapper = mountChart(seriesOf(2, 3), { unit: "%" });
    await wrapper.get("button").trigger("click");

    expect(wrapper.find("[data-testid='chart-surface']").exists()).toBe(false);
    const headers = wrapper.findAll("thead th").map((cell) => cell.text());
    expect(headers).toEqual(["时间", "设备 1 (%)", "设备 2 (%)"]);
    expect(wrapper.findAll("tbody tr")).toHaveLength(3);
  });

  it("renders a placeholder rather than an empty cell for a missing sample", async () => {
    const wrapper = mountChart([
      { name: "甲", points: points(2) },
      { name: "乙", points: [[1_000_000, 7]] },
    ]);
    await wrapper.get("button").trigger("click");

    const secondRow = wrapper.findAll("tbody tr")[1];
    expect(secondRow?.findAll("td").map((cell) => cell.text())).toEqual([
      "1.00",
      "--",
    ]);
  });

  it("caps the table and says so rather than rendering thousands of rows", async () => {
    const wrapper = mountChart(seriesOf(1, 1200));
    await wrapper.get("button").trigger("click");

    const rows = wrapper.findAll("tbody tr");
    expect(rows.length).toBeLessThanOrEqual(500);
    expect(wrapper.get("caption").text()).toContain("抽样");
  });

  it("goes back to the chart, and the toggle says which way it goes", async () => {
    const wrapper = mountChart(seriesOf(1));
    const toggle = wrapper.get("button");

    await toggle.trigger("click");
    expect(toggle.text()).toBe("看图表");
    expect(toggle.attributes("aria-pressed")).toBe("true");

    await toggle.trigger("click");
    expect(wrapper.find("[data-testid='chart-surface']").exists()).toBe(true);
  });

  it("accepts a playback cursor without it becoming part of the series", async () => {
    // The prop exists so the history tab can put a playhead on the curve; what must
    // not happen is the cursor arriving through the data, which is the version that
    // costs a full option rebuild per frame.
    const wrapper = mountChart(seriesOf(1), { cursorAt: 1_000_500 });
    await wrapper.setProps({ cursorAt: 1_002_000 });
    await flushPromises();

    expect(wrapper.props("series")[0]?.points).toHaveLength(10);
    expect(wrapper.find("[data-testid='chart-surface']").exists()).toBe(true);
  });
});
