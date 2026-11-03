import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { HistorySample } from "@navfleet/fleet-core";
import DeviceMetricCurve from "@/components/device/DeviceMetricCurve.vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import { useFleetStore } from "@/stores/fleet";

/**
 * One metric card: a live 15-minute window and a three-day history overlay behind a 实时/历史
 * toggle. As elsewhere, only `echarts.init` is stubbed (jsdom has no canvas); the option
 * building and the component's own state stay real, and the 1 Hz clock is driven by fake timers.
 */
enableAutoUnmount(afterEach);

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

const NOW = new Date("2026-11-03T12:00:00+08:00");

/** A persisted sample carrying only the two vehicleInfo fields these charts read. */
const sample = (ts: string, speed: number, soc: number): HistorySample =>
  ({
    ts,
    meta: { deviceId: "agv-01" },
    measurements: { vehicleInfo: { speed, soc } },
  }) as unknown as HistorySample;

let store: ReturnType<typeof useFleetStore>;
let pinia: ReturnType<typeof createPinia>;

const seed = (patch: Record<string, unknown> = {}) =>
  store.ingestPayload(
    {
      fleetName: "示范车队",
      topicPattern: "/fleet/{deviceId}/vehicle_info",
      devices: [
        {
          deviceId: "agv-01",
          deviceName: "A01 巡检车",
          online: true,
          sceneId: "yard",
          vehicle_info: { speed: 1.25, soc: 82, controlMode: 2, gear: 1 },
          ...patch,
        },
      ],
    },
    "api",
  );

const mountCurve = (props: Record<string, unknown> = {}) =>
  mount(DeviceMetricCurve, {
    props: {
      deviceId: "agv-01",
      metric: "speed",
      unit: "m/s",
      realtimeLabel: "实时速度",
      historyLabel: "历史速度",
      ...props,
    },
    global: { plugins: [pinia] },
  });

/** The visible chart, or undefined when a status/table stands in its place. */
const chartOf = (wrapper: ReturnType<typeof mountCurve>) =>
  wrapper.findComponent(TimeSeriesChart);

const clickButton = async (
  wrapper: ReturnType<typeof mountCurve>,
  text: string,
) => {
  const button = wrapper.findAll("button").find((b) => b.text() === text);
  expect(button, `button「${text}」`).toBeTruthy();
  await button!.trigger("click");
  await flushPromises();
};

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  store = useFleetStore();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(fleetApi, "getHistory").mockResolvedValue({
    deviceId: "agv-01",
    items: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DeviceMetricCurve 实时", () => {
  it("opens on 实时 and seeds the window from the last 15 minutes of history", async () => {
    const getHistory = vi.spyOn(fleetApi, "getHistory").mockResolvedValue({
      deviceId: "agv-01",
      items: [sample("2026-11-03T11:50:00+08:00", 1.1, 80)],
    });
    seed();
    const wrapper = mountCurve();
    await flushPromises();

    // The seed is a plain latest/earliest window — no `sampling`, which is the three-day path.
    const [, params] = getHistory.mock.calls[0]!;
    expect(params).toMatchObject({
      from: expect.any(String),
      to: expect.any(String),
    });
    expect(params).not.toHaveProperty("sampling");
    expect(chartOf(wrapper).props("series")[0]?.points).toHaveLength(1);
  });

  it("pins the axis to a trailing 15-minute window; speed anchors at 0 with an auto max", async () => {
    seed();
    const wrapper = mountCurve();
    await flushPromises();

    const chart = chartOf(wrapper);
    // Speed: lower bound fixed at 0 (the default), upper bound follows the data — so no fixed
    // yMax and no data-range yScale that would also float the floor.
    expect(chart.props("yMin")).toBeUndefined();
    expect(chart.props("yMax")).toBeUndefined();
    expect(chart.props("yScale")).toBeFalsy();
    expect(chart.props("showTableToggle")).toBe(false);
    expect(chart.props("labelHidden")).toBe(true);
    expect(
      (chart.props("xMax") as number) - (chart.props("xMin") as number),
    ).toBe(15 * 60_000);
  });

  it("gives 电量 a fixed 0–100 axis rather than a dynamic one", async () => {
    seed();
    const wrapper = mountCurve({
      metric: "soc",
      unit: "%",
      realtimeLabel: "实时电量",
      historyLabel: "历史电量",
    });
    await flushPromises();

    const chart = chartOf(wrapper);
    expect(chart.props("yMin")).toBe(0);
    expect(chart.props("yMax")).toBe(100);
  });

  it("appends the live reading once per second and drops nothing valid within the window", async () => {
    seed();
    const wrapper = mountCurve();
    await flushPromises();
    expect(chartOf(wrapper).props("series")[0]?.points).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    await flushPromises();

    const points = chartOf(wrapper).props("series")[0]?.points as readonly [
      number,
      number,
    ][];
    expect(points).toHaveLength(1);
    expect(points[0]![1]).toBe(1.25);
  });

  it("treats a missing reading as a gap, not a zero", async () => {
    seed({ vehicle_info: { speed: null } });
    const wrapper = mountCurve();
    await flushPromises();

    vi.advanceTimersByTime(3000);
    await flushPromises();

    // Three ticks, no numeric speed: the window stays empty rather than drawing a flat 0 line.
    expect(chartOf(wrapper).props("series")[0]?.points).toHaveLength(0);
  });

  it("offers no data table in 实时", async () => {
    seed();
    const wrapper = mountCurve();
    await flushPromises();

    expect(wrapper.findAll("button").map((b) => b.text())).not.toContain(
      "数据表",
    );
  });
});

describe("DeviceMetricCurve 历史", () => {
  const threeDays = [
    sample("2026-11-01T08:00:00+08:00", 1, 70),
    sample("2026-11-02T08:00:00+08:00", 2, 60),
    sample("2026-11-03T09:00:00+08:00", 3, 50),
  ];

  it("fetches the three-day span only once 历史 is selected", async () => {
    const getHistory = vi
      .spyOn(fleetApi, "getHistory")
      .mockResolvedValue({ deviceId: "agv-01", items: threeDays });
    seed();
    const wrapper = mountCurve();
    await flushPromises();

    // The mount seeded 实时 (no sampling). None of those calls asked for the even three-day span.
    expect(getHistory.mock.calls.some(([, p]) => p?.sampling === "even")).toBe(
      false,
    );

    await clickButton(wrapper, "历史速度");

    expect(getHistory.mock.calls.some(([, p]) => p?.sampling === "even")).toBe(
      true,
    );
    expect(chartOf(wrapper).props("series")).toHaveLength(3);
  });

  it("shows a per-day data table, one column per day, rows by time-of-day", async () => {
    vi.spyOn(fleetApi, "getHistory").mockResolvedValue({
      deviceId: "agv-01",
      items: threeDays,
    });
    seed();
    const wrapper = mountCurve();
    await flushPromises();
    await clickButton(wrapper, "历史速度");
    await clickButton(wrapper, "数据表");

    const headers = wrapper.findAll("thead th").map((c) => c.text());
    expect(headers).toEqual([
      "时间",
      "11-01 (m/s)",
      "11-02 (m/s)",
      "11-03 (m/s)",
    ]);
    const firstRow = wrapper
      .findAll("tbody tr")[0]!
      .findAll("th, td")
      .map((c) => c.text());
    expect(firstRow).toEqual(["08:00", "1.00", "2.00", "--"]);
  });

  it("says there is no history rather than drawing an empty overlay", async () => {
    seed();
    const wrapper = mountCurve();
    await flushPromises();
    await clickButton(wrapper, "历史速度");

    expect(wrapper.text()).toContain("最近三天还没有落库的历史遥测");
    expect(chartOf(wrapper).exists()).toBe(false);
  });

  it("reports a failed history request without leaking the backend code", async () => {
    vi.spyOn(fleetApi, "getHistory")
      .mockResolvedValueOnce({ deviceId: "agv-01", items: [] }) // 实时 seed
      .mockRejectedValue(new Error("HTTP 503")); // 历史 load
    seed();
    const wrapper = mountCurve();
    await flushPromises();
    await clickButton(wrapper, "历史速度");

    expect(wrapper.text()).toContain("历史数据加载失败");
    expect(wrapper.text()).not.toContain("HTTP 503");
  });
});
