import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { HistorySample } from "@navfleet/fleet-core";
import DevicePlaybackTab from "@/components/device/DevicePlaybackTab.vue";
import SceneMap from "@/components/map/SceneMap.vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import { delayFor } from "@/composables/useHistoryPlayback";
import { useFleetStore } from "@/stores/fleet";

/**
 * The playback tab, mounted directly rather than through the device page — the tab
 * shell is `device-detail.test.ts`'s subject, and routing through it for every case
 * would test Reka's tab switching twenty times over.
 *
 * Most of these are about v1.0.0's dead ends rather than about playback, because
 * playback itself worked: it was reachable only by choosing the same vehicle a second
 * time, it opened empty, Enter did nothing in its inputs, a preset filled the boxes and
 * left you to press the button, `from > to` came back as "加载失败", and switching
 * device kept the old vehicle's samples playing under the new one's name.
 */
enableAutoUnmount(afterEach);

/** See `charts.test.ts`: jsdom has no 2D context, and only the renderer is replaced. */
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

const BASE_MS = Date.parse("2026-08-30T02:00:00.000Z");

/**
 * One persisted sample. `x`/`y` advance with the index so the trail has a shape, and
 * every third one carries no pose at all — the gap playback has to skip rather than
 * draw a line through.
 */
const sample = (index: number, patch: Record<string, unknown> = {}) =>
  ({
    ts: new Date(BASE_MS + index * 1000).toISOString(),
    meta: { deviceId: "agv-01" },
    measurements: {
      sceneId: "yard",
      taskStatus: 2,
      vehicleInfo: { speed: 1 + index / 10, soc: 80 - index },
      ...(index % 3 === 2
        ? {}
        : { fusionLoc: { x: index, y: index * 2, yaw: 0.5 } }),
      ...patch,
    },
  }) as unknown as HistorySample;

const track = (length: number): HistorySample[] =>
  Array.from({ length }, (_unused, index) => sample(index));

let store: ReturnType<typeof useFleetStore>;
let getHistory: MockInstance<typeof fleetApi.getHistory>;

/** A scene with real bounds, so `SceneMap` renders rather than saying it has no map. */
const SCENE = {
  sceneId: "yard",
  sceneName: "北区堆场",
  bounds: { minX: -10, maxX: 60, minY: -10, maxY: 120 },
};

const seedFleet = (): void => {
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
        },
        { deviceId: "agv-02", deviceName: "A02 牵引车", sceneId: "yard" },
      ],
    },
    "api",
  );
  // Written straight into state: merging a scene definition is the bootstrap's job and
  // is not part of the store's public surface.
  store.state.sceneDefinitions.yard = SCENE as never;
};

const mountPlayback = async (deviceId = "agv-01") => {
  const wrapper = mount(DevicePlaybackTab, { props: { deviceId } });
  await flushPromises();
  return wrapper;
};

const control = (
  wrapper: Awaited<ReturnType<typeof mountPlayback>>,
  label: string,
) => wrapper.get(`[aria-label='${label}']`);

const button = (
  wrapper: Awaited<ReturnType<typeof mountPlayback>>,
  text: string,
) => wrapper.findAll("button").find((item) => item.text().includes(text));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  getHistory = vi
    .spyOn(fleetApi, "getHistory")
    .mockResolvedValue({ deviceId: "agv-01", items: track(9) });
  store = useFleetStore();
  seedFleet();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the window", () => {
  /** The request's `[from, to]` in epoch ms. */
  const windowOf = (call = 0): [number, number] => {
    const params = getHistory.mock.calls[call]![1] as {
      from: string;
      to: string;
    };
    return [Date.parse(params.from), Date.parse(params.to)];
  };

  it("loads on arrival, over the last hour", async () => {
    // v1.0.0 opened empty and waited to be told what everyone already knew: which
    // device (the route) and roughly when (recently).
    await mountPlayback();

    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(getHistory.mock.calls[0]![0]).toBe("agv-01");
    const [from, to] = windowOf();
    // An hour, plus at most the minute the inputs round to — see below.
    expect(to - from).toBeGreaterThanOrEqual(3_600_000);
    expect(to - from).toBeLessThan(3_660_000);
  });

  it("does not floor the end of the window into the past", async () => {
    // The defect the browser suite found. `datetime-local` holds a *minute*, so
    // rendering `now` into it drops up to 59 seconds — and asking for a window that
    // ends 59 seconds ago silently discards the newest samples, which are the ones
    // someone opened this tab for. The end of a minute-precision range is the end of
    // that minute, not its start.
    const openedAt = Date.now();
    await mountPlayback();

    expect(windowOf()[1]).toBeGreaterThanOrEqual(openedAt);
  });

  it("sends no limit, because the server's cap is the one that counts", async () => {
    // v1.0.0's 最大点数 input accepted 5000 and got 500: its min/max constrained
    // nothing (no `<form>`) and the server clamps to `MAX_HISTORY_POINTS` regardless.
    await mountPlayback();

    expect(getHistory.mock.calls[0]![1]).not.toHaveProperty("limit");
    expect(getHistory.mock.calls[0]![1]).toEqual({
      from: expect.any(String),
      to: expect.any(String),
    });
  });

  it("states the span actually covered, not the one requested", async () => {
    // The honest reading of a capped window: the operator can see it was cut without
    // being handed a diagnosis the frontend cannot make — "the cap trimmed it" and
    // "the vehicle was parked and reporting nothing" look identical from here.
    const wrapper = await mountPlayback();

    expect(wrapper.text()).toContain("已载入 9 条采样");
    expect(wrapper.text()).toMatch(/覆盖 .+ – .+。/);
  });

  it("submits on Enter, because it is a form", async () => {
    const wrapper = await mountPlayback();
    getHistory.mockClear();

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it("queries straight away when a preset is picked", async () => {
    // v1.0.0 filled the two inputs and left the button unpressed, which reads as a
    // control that did nothing.
    const wrapper = await mountPlayback();
    getHistory.mockClear();

    await button(wrapper, "最近 6 小时")!.trigger("click");
    await flushPromises();

    const [from, to] = windowOf();
    expect(to - from).toBeGreaterThanOrEqual(21_600_000);
    expect(to - from).toBeLessThan(21_660_000);
  });

  it("refuses a backwards window before asking the server", async () => {
    // v1.0.0 let it through and surfaced the 400 as "加载失败", which blames the
    // backend for the operator's typo.
    const wrapper = await mountPlayback();
    getHistory.mockClear();

    const inputs = wrapper.findAll("input[type='datetime-local']");
    await inputs[0]!.setValue("2026-08-30T12:00");
    await inputs[1]!.setValue("2026-08-30T09:00");

    expect(wrapper.text()).toContain("起始时间晚于结束时间");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(getHistory).not.toHaveBeenCalled();
  });

  it("reports a failure on the map rather than as an empty window", async () => {
    getHistory.mockRejectedValue(new Error("HTTP 503"));
    const wrapper = await mountPlayback();

    expect(wrapper.text()).toContain("历史数据加载失败");
    expect(wrapper.text()).toContain("HTTP 503");
  });

  it("drops a response for the device you have navigated away from", async () => {
    // Two windows in flight and the slow one landing last would draw agv-01's track
    // under agv-02's name.
    let settleFirst: (value: {
      deviceId: string;
      items: HistorySample[];
    }) => void = () => undefined;
    getHistory.mockImplementationOnce(
      () => new Promise((resolve) => (settleFirst = resolve)),
    );

    const wrapper = await mountPlayback();
    getHistory.mockResolvedValue({ deviceId: "agv-02", items: track(4) });
    await wrapper.setProps({ deviceId: "agv-02" });
    await flushPromises();

    settleFirst({ deviceId: "agv-01", items: track(9) });
    await flushPromises();

    expect(wrapper.text()).toContain("已载入 4 条采样");
  });
});

describe("the playback bar", () => {
  it("names the slider and the speed control, which have no visible labels", async () => {
    // The axe critical Phase 10 found. Both are label-free by design — the bar reads as
    // a row of media controls — so the accessible name has to come from `aria-label`,
    // or a screen reader announces an unnamed slider and an unnamed combobox.
    const wrapper = await mountPlayback();

    expect(control(wrapper, "回放进度").attributes("type")).toBe("range");
    expect(control(wrapper, "回放速度").element.tagName).toBe("SELECT");
  });

  it("counts from one while the cursor counts from zero", async () => {
    const wrapper = await mountPlayback();
    expect(wrapper.text()).toContain("1 / 9");
  });

  it("advances the cursor while playing", async () => {
    vi.useFakeTimers();
    const wrapper = await mountPlayback();

    await button(wrapper, "播放")!.trigger("click");
    vi.advanceTimersByTime(delayFor(1) * 2);
    await flushPromises();

    expect(wrapper.text()).toContain("3 / 9");
    expect(button(wrapper, "暂停")).toBeDefined();
    vi.useRealTimers();
  });

  it("pauses when the slider is dragged", async () => {
    // Scrubbing while the timer keeps firing means the playhead fights the pointer.
    vi.useFakeTimers();
    const wrapper = await mountPlayback();
    await button(wrapper, "播放")!.trigger("click");

    await control(wrapper, "回放进度").setValue("6");
    await flushPromises();

    expect(wrapper.text()).toContain("7 / 9");
    expect(button(wrapper, "播放")).toBeDefined();
    // Nothing moves after the scrub, which is what "paused" has to mean.
    vi.advanceTimersByTime(delayFor(1) * 3);
    await flushPromises();
    expect(wrapper.text()).toContain("7 / 9");
    vi.useRealTimers();
  });

  it("disables the whole bar when there is nothing to play", async () => {
    getHistory.mockResolvedValue({ deviceId: "agv-01", items: [] });
    const wrapper = await mountPlayback();

    expect(control(wrapper, "回放进度").attributes("disabled")).toBeDefined();
    expect(control(wrapper, "回放速度").attributes("disabled")).toBeDefined();
    expect(button(wrapper, "播放")!.attributes("disabled")).toBeDefined();
  });

  it("offers the four speeds and no others", async () => {
    const wrapper = await mountPlayback();
    const options = control(wrapper, "回放速度")
      .findAll("option")
      .map((option) => option.text());

    expect(options).toEqual(["0.5×", "1×", "2×", "4×"]);
  });
});

describe("the map and the curve", () => {
  it("hands the map the frame under the cursor, not the live vehicle", async () => {
    // A field the sample does not carry has to come out blank: filling it from the
    // current snapshot would print this second's error code on an hour-old frame.
    const wrapper = await mountPlayback();
    const map = wrapper.getComponent(SceneMap);

    expect(map.props("selectedDevice")!.fusionLoc.x).toBe(0);
    expect(map.props("selectedDevice")!.deviceName).toBe("A01 巡检车");
    // No formation peers on a playback: there is one vehicle in this window.
    expect(map.props("sceneDevices")).toEqual([]);
  });

  it("grows the trail behind the cursor, skipping poseless samples", async () => {
    const wrapper = await mountPlayback();
    await control(wrapper, "回放进度").setValue("4");
    await flushPromises();

    // Index 2 has no pose; 5..8 are past the cursor.
    const trail = wrapper.getComponent(SceneMap).props("trails")["agv-01"]!;
    expect(trail.map((point) => point.x)).toEqual([0, 1, 3, 4]);
  });

  it("puts the chart cursor on the instant the map is showing", async () => {
    // This is the linkage the standalone history page could not have: the trail says
    // where, the curve says how fast, and the cursor is the one instant shared.
    const wrapper = await mountPlayback();
    const chart = () => wrapper.getComponent(TimeSeriesChart);

    expect(chart().props("cursorAt")).toBe(BASE_MS);
    await control(wrapper, "回放进度").setValue("5");
    await flushPromises();
    expect(chart().props("cursorAt")).toBe(BASE_MS + 5000);
  });

  it("plots the window's speed and drops samples that have none", async () => {
    getHistory.mockResolvedValue({
      deviceId: "agv-01",
      items: [
        sample(0),
        { ts: new Date(BASE_MS + 1000).toISOString(), measurements: {} },
      ] as HistorySample[],
    });
    const wrapper = await mountPlayback();

    const series = wrapper.getComponent(TimeSeriesChart).props("series");
    expect(series[0]!.name).toBe("速度");
    expect(series[0]!.points).toHaveLength(1);
  });

  it("shows the sample under the cursor, in words where there are words", async () => {
    const wrapper = await mountPlayback();
    await control(wrapper, "回放进度").setValue("3");
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("1.30 m/s");
    expect(text).toContain("77.0%");
    // `taskStatus: 2` — a bare `2` is what v1.0.0 printed here.
    expect(text).not.toMatch(/任务状态\s*2/);
    expect(text).toContain("北区堆场");
  });

  it("says `--` for a sample with no timestamp rather than claiming it is now", async () => {
    // `formatDateTime` falls back to `Date.now()`, so the naive version dates an
    // undated sample to this second.
    getHistory.mockResolvedValue({
      deviceId: "agv-01",
      items: [
        { measurements: { vehicleInfo: { speed: 1 } } },
      ] as HistorySample[],
    });
    const wrapper = await mountPlayback();

    const rows = wrapper.findAll("dl div");
    expect(rows[0]!.text()).toContain("采样时间");
    expect(rows[0]!.text()).toContain("--");
  });
});

describe("the empty states", () => {
  it("says there is no history, and where history comes from", async () => {
    getHistory.mockResolvedValue({ deviceId: "agv-01", items: [] });
    const wrapper = await mountPlayback();

    expect(wrapper.text()).toContain("没有历史轨迹数据");
    expect(wrapper.text()).toContain("MongoDB");
    expect(wrapper.findComponent(SceneMap).exists()).toBe(false);
  });

  it("distinguishes a track with no pose from one with no map", async () => {
    // v1.0.0's last branch covered both "nothing loaded yet" and "loaded but the scene
    // is unknown", so a missing scene definition told you to press a button you had
    // already pressed.
    getHistory.mockResolvedValue({
      deviceId: "agv-01",
      items: [sample(2), sample(5)],
    });
    const wrapper = await mountPlayback();

    expect(wrapper.text()).toContain("缺少 ROS 位姿");
  });

  it("names the scene it cannot find a map for", async () => {
    getHistory.mockResolvedValue({
      deviceId: "agv-01",
      items: [sample(0, { sceneId: "dock-9" })],
    });
    const wrapper = await mountPlayback();

    expect(wrapper.text()).toContain("缺少场景地图定义");
    expect(wrapper.text()).toContain("dock-9");
    expect(wrapper.text()).not.toContain("加载轨迹后");
  });
});

describe("changing device", () => {
  it("clears the previous vehicle's track instead of playing it on", async () => {
    // v1.0.0 had no watch on its picker: the old samples kept playing while the name,
    // the trail key and the scene had already switched.
    vi.useFakeTimers();
    const wrapper = await mountPlayback();
    await button(wrapper, "播放")!.trigger("click");
    vi.advanceTimersByTime(delayFor(1) * 3);
    await flushPromises();
    expect(wrapper.text()).toContain("4 / 9");

    getHistory.mockResolvedValue({ deviceId: "agv-02", items: track(4) });
    await wrapper.setProps({ deviceId: "agv-02" });
    await flushPromises();

    expect(wrapper.text()).toContain("1 / 4");
    expect(button(wrapper, "播放")).toBeDefined();
    expect(wrapper.getComponent(SceneMap).props("trails")).not.toHaveProperty(
      "agv-01",
    );
    vi.useRealTimers();
  });
});
