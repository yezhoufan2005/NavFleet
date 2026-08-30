import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { HistorySample } from "@navfleet/fleet-core";
import DeviceDetailView from "@/views/DeviceDetailView.vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import { useFleetStore } from "@/stores/fleet";

/**
 * The device detail page. Its reason for existing is the report-code section, so most
 * of these are about that: a number becoming a meaning, and — the case that matters
 * more — a number that has no meaning in the dictionary saying so out loud.
 */
enableAutoUnmount(afterEach);

/**
 * Only the renderer is replaced. `echarts.init` needs a real 2D context, which jsdom
 * does not have; without this the failure surfaces as `Cannot read properties of null`
 * from inside zrender, which is a spectacularly unhelpful way to learn that. The
 * option-building stays real, and real rendering is measured in a browser by
 * `e2e/specs/console-charts.spec.ts`.
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

const code = (value: number, info = "") => ({ code: value, info, stamp: null });

const device = (patch: Record<string, unknown> = {}) => ({
  deviceId: "agv-01",
  deviceName: "A01 巡检车",
  online: true,
  sceneId: "yard",
  fusion_loc: { x: 12.5, y: 30.25, yaw: 1.57 },
  vehicle_info: { controlMode: 2, gear: 1, speed: 1.25, omega: 0.05, soc: 82 },
  ...patch,
});

let store: ReturnType<typeof useFleetStore>;
let router: Router;

const mountDetail = async (deviceId = "agv-01", tab?: string) => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/devices/:deviceId", component: DeviceDetailView },
      { path: "/", component: { template: "<i />" } },
    ],
  });
  await router.push(`/devices/${deviceId}${tab ? `?tab=${tab}` : ""}`);
  await router.isReady();

  const wrapper = mount(DeviceDetailView, { global: { plugins: [router] } });
  await flushPromises();

  // The three non-default panels are `defineAsyncComponent`, so one microtask flush
  // does not guarantee the child has mounted — how many ticks a dynamic import takes
  // depends on whether another test file already warmed the module cache, which is
  // exactly the kind of thing that makes a suite pass alone and fail together. Wait on
  // the condition instead: *some* panel has content. (Not the first one — Reka renders
  // all four `tabpanel` elements and leaves the inactive ones empty, so `get()` would
  // wait forever on the live panel.)
  if (tab) {
    await vi.waitFor(() =>
      expect(
        wrapper
          .findAll("[role='tabpanel']")
          .some((panel) => panel.text().length > 0),
      ).toBe(true),
    );
  }
  return wrapper;
};

const seed = (patch: Record<string, unknown> = {}) =>
  store.ingestPayload(
    {
      fleetName: "示范车队",
      topicPattern: "/fleet/{deviceId}/vehicle_info",
      devices: [device(patch)],
    },
    "api",
  );

beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  vi.spyOn(fleetApi, "getHistory").mockResolvedValue({
    deviceId: "agv-01",
    items: [],
  });
  store = useFleetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("报码解读", () => {
  it("turns a number into a meaning, a cause and something to do", async () => {
    // v1.0.0 printed `5102` and whatever string the firmware attached, so the number
    // meant nothing until someone who knew the vehicle explained it.
    seed({ error_code: code(5102, "路径规划超时，已触发急停") });
    const wrapper = await mountDetail();
    const section = wrapper.find("section[aria-labelledby='codes-heading']");

    expect(section.text()).toContain("5102");
    expect(section.text()).toContain("路径规划超时");
    expect(section.text()).toContain("目标点被占据");
    expect(section.text()).toContain("重新派发");
    // The device's own words survive alongside the canonical label.
    expect(section.text()).toContain("路径规划超时，已触发急停");
  });

  it("states what the vehicle can still do, not how bad it feels", async () => {
    // VDA 5050's model: a dispatcher can act on "cannot continue but can accept work";
    // "严重" tells them nothing.
    seed({ error_code: code(5102) });
    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain("任务受阻");
    expect(wrapper.text()).toContain("无法继续当前任务");
  });

  it("distinguishes intervention from merely blocked", async () => {
    seed({ error_code: code(5701) });
    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain("需人工介入");
    expect(wrapper.text()).toContain("必须人工到场");
  });

  it("says a code is unknown rather than inventing a meaning", async () => {
    // The state most real deployments are in until their own 码表 is loaded. A console
    // that invents a plausible meaning is worse than one that admits it, because
    // someone will act on the invention.
    seed({ error_code: code(7788, "驱动板 B 相异常") });
    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain("7788");
    expect(wrapper.text()).toContain("不在当前字典中");
    expect(wrapper.text()).toContain("驱动板 B 相异常");
  });

  it("lists every active channel, worst first", async () => {
    seed({
      error_code: code(5102),
      warning_code: code(2301),
      info_code: code(1101),
    });
    const wrapper = await mountDetail();
    const articles = wrapper
      .find("section[aria-labelledby='codes-heading']")
      .findAll("article");

    expect(articles).toHaveLength(3);
    expect(articles[0]?.text()).toContain("告警");
    expect(articles[1]?.text()).toContain("预警");
    expect(articles[2]?.text()).toContain("提示");
  });

  it("says there is nothing to explain for a healthy vehicle", async () => {
    seed();
    const wrapper = await mountDetail();
    expect(wrapper.text()).toContain("当前没有活跃报码");
  });
});

describe("遥测面板", () => {
  it("renders enum values as words, not bare numbers", async () => {
    // The three enum maps are what v1.0.0 lost in its own Vue migration: before
    // Phase 1 控制模式 / 挡位 / 任务状态 rendered as digits.
    seed();
    const wrapper = await mountDetail();

    expect(wrapper.text()).toMatch(/控制模式/);
    expect(wrapper.text()).not.toMatch(/控制模式\s*2\s*$/);
    expect(wrapper.text()).toContain("1.25 m/s");
    expect(wrapper.text()).toContain("82 %");
  });

  it("omits a panel the vehicle has no data for", async () => {
    // A panel of `--` reads as lost data. GPS is configured per device, so "no fix"
    // and "no receiver" are different answers.
    seed({ gpsEnabled: false });
    const wrapper = await mountDetail();

    const titles = wrapper.findAll("h3").map((heading) => heading.text());
    expect(titles).not.toContain("GPS");
    expect(titles).toContain("位姿");
  });

  it("shows the GPS panel when there is a fix", async () => {
    seed({ gps: { lat: 31.2304, lng: 121.4737, heading: 90 } });
    const wrapper = await mountDetail();

    expect(wrapper.findAll("h3").map((h) => h.text())).toContain("GPS");
    expect(wrapper.text()).toContain("121.473700");
  });

  it("shows both fixes so the gap between them is visible", async () => {
    seed({
      fusion_loc: { x: 10, y: 20, yaw: 0 },
      lidar_loc: { x: 10.4, y: 20.2, yaw: 0.01 },
    });
    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain("融合定位");
    expect(wrapper.text()).toContain("激光定位");
  });
});

describe("找不到设备", () => {
  it("distinguishes a missing device from a fleet that has not arrived", async () => {
    const wrapper = await mountDetail("ghost");
    expect(wrapper.text()).toContain("找不到这台设备");
    expect(wrapper.text()).toContain("ghost");

    store.state.realtime.bootstrapPending = true;
    await flushPromises();
    expect(wrapper.text()).toContain("正在加载车队…");
  });
});

describe("视图切换", () => {
  /**
   * Three answers to three questions asked at different times — right now / lately /
   * that afternoon. They are tabs rather than one scroll because stacking them would
   * bury 实时 under the other two, and 历史回放 is a tab here rather than a nav section
   * because a separate page made you choose the same vehicle twice (`frontend-ia.md`).
   */
  const tabLabels = (wrapper: Awaited<ReturnType<typeof mountDetail>>) =>
    wrapper.findAll("[role='tab']").map((tab) => tab.text());

  /**
   * `mousedown`, not `click`: Reka activates a tab on pointer-down (matching the
   * WAI-ARIA pattern), so a synthetic `click` alone selects nothing.
   */
  const openTab = async (
    wrapper: Awaited<ReturnType<typeof mountDetail>>,
    index: number,
  ) => {
    await wrapper.findAll("[role='tab']")[index]!.trigger("mousedown");
    await flushPromises();
  };

  it("offers the four views, with 实时 first", async () => {
    seed();
    const wrapper = await mountDetail();

    expect(tabLabels(wrapper)).toEqual(["实时", "曲线", "历史回放", "告警史"]);
    expect(wrapper.find("[role='tab'][aria-selected='true']").text()).toBe(
      "实时",
    );
  });

  it("opens the tab named in the URL, so a playback is a link", async () => {
    // "Look at c12's playback" should be a URL rather than a sentence with a step in it.
    seed();
    const wrapper = await mountDetail("agv-01", "playback");

    expect(wrapper.find("[role='tab'][aria-selected='true']").text()).toBe(
      "历史回放",
    );
  });

  it("ignores a tab name that is not one of the three", async () => {
    seed();
    const wrapper = await mountDetail("agv-01", "nonsense");

    expect(wrapper.find("[role='tab'][aria-selected='true']").text()).toBe(
      "实时",
    );
  });

  it("puts the tab in the query, replacing rather than stacking history", async () => {
    // `replace`, so the back button leaves the device instead of walking back through
    // tabs one at a time. Asserted on the call rather than by walking history, because
    // the latter measures vue-router's entry bookkeeping instead of this decision.
    seed();
    const wrapper = await mountDetail();
    const replace = vi.spyOn(router, "replace");
    const push = vi.spyOn(router, "push");

    await openTab(wrapper, 1);

    expect(router.currentRoute.value.query.tab).toBe("charts");
    expect(router.currentRoute.value.params.deviceId).toBe("agv-01");
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("drops the query entirely when returning to the default tab", async () => {
    // `?tab=live` and no query mean the same thing, and only one of them should exist.
    seed();
    const wrapper = await mountDetail("agv-01", "charts");

    await openTab(wrapper, 0);

    expect(router.currentRoute.value.query.tab).toBeUndefined();
  });

  it("does not download the chart or map engine to show 实时", async () => {
    // The three non-default panels are async, and the tab boundary is the split point:
    // Reka does not mount an inactive panel, so "not needed yet" and "not loaded yet"
    // coincide. Measured: this view's chunk went from 564 kB to 14.5 kB.
    seed();
    const wrapper = await mountDetail();

    expect(wrapper.findComponent(TimeSeriesChart).exists()).toBe(false);
    // The panel element exists (Reka renders the active one only), and the live tab's
    // own content is there.
    expect(wrapper.text()).toContain("报码解读");
  });
});

describe("历史曲线", () => {
  /**
   * `measurements` is a `Partial<DeviceSnapshot>`, so a fixture carrying only
   * `vehicleInfo` needs the cast — the alternative is filling seventeen fields to
   * test two of them.
   */
  const sample = (ts: string, speed: number, soc: number): HistorySample =>
    ({
      ts,
      meta: { deviceId: "agv-01" },
      measurements: { vehicleInfo: { speed, soc } },
    }) as unknown as HistorySample;

  /**
   * Mounted on `?tab=charts`, and that is the assertion as much as the setup: Reka does
   * not mount an inactive panel, so a device opened on 实时 issues no history request
   * at all. `mountCharts()` failing to find a chart would mean the tab did not open.
   */
  const mountCharts = () => mountDetail("agv-01", "charts");

  it("draws speed and charge as two charts, never one with two axes", async () => {
    // m/s and % on shared axes would let the crossing point be chosen by whoever
    // picked the scales, which is the single most common way a chart misleads.
    vi.spyOn(fleetApi, "getHistory").mockResolvedValue({
      deviceId: "agv-01",
      items: [
        sample("2026-08-30T02:00:00.000Z", 1.1, 80),
        sample("2026-08-30T02:00:10.000Z", 1.4, 79),
      ],
    });
    seed();
    const wrapper = await mountCharts();

    const charts = wrapper.findAllComponents(TimeSeriesChart);
    expect(charts).toHaveLength(2);
    expect(charts[0]?.props("unit")).toBe("m/s");
    expect(charts[1]?.props("unit")).toBe("%");
    expect(charts[0]?.props("series")[0]?.points).toHaveLength(2);
  });

  it("sorts samples oldest first whatever order they arrive in", async () => {
    vi.spyOn(fleetApi, "getHistory").mockResolvedValue({
      deviceId: "agv-01",
      items: [
        sample("2026-08-30T02:00:10.000Z", 1.4, 79),
        sample("2026-08-30T02:00:00.000Z", 1.1, 80),
      ],
    });
    seed();
    const wrapper = await mountCharts();

    const points = wrapper
      .findAllComponents(TimeSeriesChart)[0]
      ?.props("series")[0]?.points as readonly (readonly [number, number])[];
    expect(points[0]![0]).toBeLessThan(points[1]![0]!);
  });

  it("drops a sample whose value is not a number rather than plotting NaN", async () => {
    vi.spyOn(fleetApi, "getHistory").mockResolvedValue({
      deviceId: "agv-01",
      items: [
        sample("2026-08-30T02:00:00.000Z", 1.1, 80),
        { ts: "2026-08-30T02:00:10.000Z", measurements: {} } as HistorySample,
      ],
    });
    seed();
    const wrapper = await mountCharts();

    expect(
      wrapper.findAllComponents(TimeSeriesChart)[0]?.props("series")[0]?.points,
    ).toHaveLength(1);
  });

  it("says the device has no history rather than drawing an empty chart", async () => {
    seed();
    const wrapper = await mountCharts();

    expect(wrapper.text()).toContain("还没有落库的历史遥测");
    expect(wrapper.findAllComponents(TimeSeriesChart)).toHaveLength(0);
  });

  it("reports a failed request instead of looking like an empty device", async () => {
    vi.spyOn(fleetApi, "getHistory").mockRejectedValue(new Error("HTTP 503"));
    seed();
    const wrapper = await mountCharts();

    expect(wrapper.text()).toContain("HTTP 503");
  });

  it("costs no request at all while the 实时 tab is the one showing", async () => {
    const getHistory = vi.spyOn(fleetApi, "getHistory");
    seed();
    await mountDetail();

    expect(getHistory).not.toHaveBeenCalled();
  });
});
