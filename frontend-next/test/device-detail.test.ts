import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import {
  controlModeMap,
  describeEnum,
  fleetApi,
  formatStamp,
} from "@navfleet/fleet-core";
import type { HistorySample } from "@navfleet/fleet-core";
import DeviceDetailView from "@/views/DeviceDetailView.vue";
import DeviceLiveTab from "@/components/device/DeviceLiveTab.vue";
import DeviceChartsTab from "@/components/device/DeviceChartsTab.vue";
import DeviceMetricCurve from "@/components/device/DeviceMetricCurve.vue";
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

/** The tab strip's four entries, declared on the `:deviceId` parent as in the real router. */
const TAB_META = [
  { routeName: "device-detail", label: "实时" },
  { routeName: "device-charts", label: "曲线" },
  { routeName: "device-playback", label: "回放" },
  { routeName: "device-alerts", label: "消息史" },
];

/** Playback/alerts pull in heavy deps (the map engine); this file only exercises 实时 and 曲线. */
const Stub = { template: "<i />" };
/** A root that is just the outlet, so the shell's own `<RouterView>` resolves the active tab. */
const Root = { template: "<router-view />" };

const mountDetail = async (deviceId = "agv-01", tab?: string) => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: Stub },
      {
        // 设备详情 is now a shell with four child routes, not a `?tab=` view.
        path: "/devices/:deviceId",
        component: DeviceDetailView,
        meta: { tabs: TAB_META },
        children: [
          {
            path: "",
            name: "device-detail",
            component: DeviceLiveTab,
            meta: { title: "实时" },
            props: true,
          },
          {
            path: "charts",
            name: "device-charts",
            component: DeviceChartsTab,
            meta: { title: "曲线" },
            props: true,
          },
          {
            path: "playback",
            name: "device-playback",
            component: Stub,
            meta: { title: "回放" },
            props: true,
          },
          {
            path: "alerts",
            name: "device-alerts",
            component: Stub,
            meta: { title: "消息史" },
            props: true,
          },
        ],
      },
    ],
  });
  await router.push(`/devices/${deviceId}${tab ? `/${tab}` : ""}`);
  await router.isReady();

  const wrapper = mount(Root, { global: { plugins: [router] } });
  await flushPromises();

  // The 曲线 tab fetches history on mount; wait until that request has settled so the
  // chart (or its empty state) has rendered rather than the loading placeholder.
  if (tab === "charts") {
    await vi.waitFor(() =>
      expect(wrapper.text()).not.toContain("正在加载历史数据"),
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
    // The card reads the codebook, not the firmware string (车端上报 was dropped from it).
    expect(section.text()).not.toContain("路径规划超时，已触发急停");
  });

  it("states what the vehicle can still do, not how bad it feels", async () => {
    // VDA 5050's model: a dispatcher can act on "cannot continue but can accept work";
    // "严重" tells them nothing.
    seed({ error_code: code(5102) });
    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain("任务受阻");
    // The sentence behind the tag rides on its tooltip.
    expect(wrapper.get("[title*='无法继续当前任务']").text()).toBe("任务受阻");
  });

  it("keeps a long code name inside the card: wraps to two lines, the tag stays put", async () => {
    seed({ error_code: code(5102) });
    const wrapper = await mountDetail();
    const card = wrapper.get("section[aria-labelledby='codes-heading']");
    const name = card.get("strong");
    expect(name.classes()).toEqual(
      expect.arrayContaining(["line-clamp-2", "wrap-break-word"]),
    );
    expect(name.attributes("title")).toBe(name.text());
    // The title row is a grid whose middle track can shrink below its content.
    expect(name.element.parentElement?.className).toContain("minmax(0,1fr)");
    const meta = card.get("p.font-mono");
    expect(meta.classes()).toContain("truncate");
    expect(meta.attributes("title")).toBe("5102 · 导航与定位");
  });

  it("distinguishes intervention from merely blocked", async () => {
    seed({ error_code: code(5701) });
    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain("需人工介入");
    expect(wrapper.get("[title*='必须人工到场']").text()).toBe("需人工介入");
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

  it("folds 报码解读 to a placeholder for a healthy vehicle, without a 'nothing here' sentence", async () => {
    seed({
      task: {
        id: "t-1",
        type: "搬运",
        step: 1,
        steps: 4,
        step_name: "前往取货位",
      },
    });
    const wrapper = await mountDetail();
    const codes = wrapper.get("section[aria-labelledby='codes-heading']");
    expect(codes.text()).toBe("报码解读");
    expect(wrapper.text()).not.toContain("当前没有活跃报码");
    expect(wrapper.get(".top-cards").attributes("style")).toContain(
      "--top-columns: 3.25rem 1fr",
    );
  });

  it("keeps two flat placeholders side by side when there is neither a code nor a task", async () => {
    seed({ task: null });
    const wrapper = await mountDetail();
    const row = wrapper.get("[data-testid='live-top-row']");
    expect(row.attributes("style")).toContain("--top-columns: 1fr 1fr");
    expect(row.findAll("[data-state='folded']")).toHaveLength(2);
    expect(row.findAll(".is-collapsed")).toHaveLength(2);
    // Flat, not the vertical strip used beside an open card.
    expect(row.html()).not.toContain("writing-mode");
  });

  it("gives each card half the row when both have content", async () => {
    seed({
      error_code: code(5102),
      task: {
        id: "t-1",
        type: "搬运",
        step: 1,
        steps: 4,
        step_name: "前往取货位",
      },
    });
    const wrapper = await mountDetail();
    const cards = wrapper.get(".top-cards");
    expect(cards.attributes("style")).toContain("--top-columns: 1fr 1fr");
    expect(cards.findAll("[data-state='open']")).toHaveLength(2);
  });
});

describe("遥测面板", () => {
  it("renders enum values as words, not bare numbers", async () => {
    // The three enum maps are what v1.0.0 lost in its own Vue migration: before
    // 最早版本里 控制模式 / 挡位 / 任务状态 rendered as digits.
    seed();
    const wrapper = await mountDetail();

    expect(wrapper.text()).toMatch(/控制模式/);
    expect(wrapper.text()).not.toMatch(/控制模式\s*2\s*$/);
    expect(wrapper.text()).toContain("1.25 m/s");
    // `0` digits and no space before `%`: SOC to 0.1% is false precision, and the
    // playback tab used to print `82.3%` for the same reading — all three sites now share
    // one form.
    expect(wrapper.text()).toContain("82%");
  });

  it("shows the task the vehicle reports — id, route and step — read-only", async () => {
    seed({
      task: {
        id: "agv-01-20261124-0003",
        type: "搬运",
        from: "取货位 P03",
        to: "卸货位 D07",
        step: 2,
        steps: 4,
        step_name: "装货",
        started_at: "2026-11-24T02:00:00.000Z",
      },
    });
    const wrapper = await mountDetail();
    const text = wrapper.text();
    const block = wrapper.get("section[aria-labelledby='task-heading']");
    expect(block.text()).toContain("搬运");
    expect(block.text()).toContain("agv-01-20261124-0003");
    expect(block.text()).toMatch(/起点\s*取货位 P03/);
    expect(block.text()).toMatch(/终点\s*卸货位 D07/);
    expect(block.text()).toContain("开始时间");
    expect(block.text()).toContain("进行时长");
    expect(block.text()).toContain("第 2 / 4 步 · 装货");
    // Two of four segments filled, and the bar says so to AT.
    const bar = block.get("[role='progressbar']");
    expect(bar.attributes("aria-valuenow")).toBe("2");
    expect(bar.findAll(".bg-brand")).toHaveLength(2);
    // It sits in the top row beside 报码解读, not in the panel grid below.
    expect(text).toContain("任务状态");
    // Read-only: the task card offers nothing to press.
    expect(
      block
        .findAll("button")
        .filter((b) => !b.attributes("aria-label")?.includes("说明")),
    ).toHaveLength(0);
  });

  it("folds 当前任务 to a placeholder when the vehicle reports no task", async () => {
    seed({ error_code: code(5102), task: null });
    const wrapper = await mountDetail();
    expect(wrapper.get("section[aria-labelledby='task-heading']").text()).toBe(
      "当前任务",
    );
    expect(wrapper.get(".top-cards").attributes("style")).toContain(
      "--top-columns: 1fr 3.25rem",
    );
  });

  it("explains an enum code on hover, not just names it", async () => {
    // `describeEnum` has lived in fleet-core with tests and had zero readers:
    // the port took `formatEnum`'s label and left the sentence behind. No hover underline:
    // the value reads as plain text, the sentence rides on the tooltip and to AT.
    seed();
    const wrapper = await mountDetail();

    const described = wrapper
      .findAll("dd")
      .filter((cell) => cell.attributes("title"));
    expect(described.length).toBeGreaterThanOrEqual(2);

    const controlMode = described.find((cell) =>
      cell.text().includes("遥控接管"),
    );
    expect(controlMode?.attributes("title")).toBe(
      describeEnum(2, controlModeMap),
    );
    // Announced too — `title` alone on a non-interactive element is not reliable.
    expect(controlMode?.attributes("aria-description")).toBe(
      describeEnum(2, controlModeMap),
    );
    expect(controlMode?.classes()).not.toContain("hover:underline");

    // A plain number has no sentence to carry.
    const speed = wrapper.findAll("dd").find((c) => c.text() === "1.25 m/s");
    expect(speed?.attributes("title")).toBeUndefined();
  });

  it("dates the speed limit, so a standing one is not read as a fresh one", async () => {
    // The normalizer even carries `speedLimit.stamp` forward between snapshots; the
    // panel had three rows and no reader for it.
    seed({
      speed_limit: {
        limit: 1.5,
        slowdown_time: 2,
        module_name: "safety",
        stamp: "2026-08-30T02:00:00.000Z",
      },
    });
    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain("更新时间");
    expect(wrapper.text()).toContain(formatStamp("2026-08-30T02:00:00.000Z"));
  });

  it("says 未配置场景 rather than `--` when no scene is configured", async () => {
    // `--` conflated "no scene" with "scene name not loaded yet". v1.0.0 had this
    // wording (`DashboardView.vue:87`) and the port dropped it.
    seed({ sceneId: "" });
    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain("未配置场景");
  });

  it("names the scene when its definition is known, and falls back to the id", async () => {
    seed();
    const wrapper = await mountDetail();
    // No definition loaded in this harness, so the id is the honest answer — it is
    // still *which* scene, just not a readable name.
    expect(wrapper.text()).toContain("yard");
  });

  it("still shows every panel, with 缺失 where the vehicle has no data", async () => {
    // Reversed by request: a card that disappears reads as "this vehicle is different"
    // while scanning several. GPS with no receiver keeps its panel and says 缺失.
    seed({ gpsEnabled: false });
    const wrapper = await mountDetail();

    const titles = wrapper.findAll("h3").map((heading) => heading.text());
    expect(titles).toContain("GPS");
    expect(titles).toContain("位姿");
    // The GPS panel's 经纬度/航向 rows are present as placeholders, not dropped.
    expect(wrapper.text()).toContain("经纬度");
    expect(wrapper.text()).toContain("缺失");
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
   * Four answers to four questions asked at different times — right now / lately /
   * that afternoon / has this happened before. They are **real child routes**, rendered by
   * the section tab strip, so a tab is a URL rather than a `?tab=`: the breadcrumb reads
   * 设备 › <id> › 实时, and Back/Forward walk them.
   */
  const tabStrip = (wrapper: Awaited<ReturnType<typeof mountDetail>>) =>
    wrapper.find("nav[aria-label='分区导航']");
  const tabLinks = (wrapper: Awaited<ReturnType<typeof mountDetail>>) =>
    tabStrip(wrapper)
      .findAll("a")
      .map((link) => link.text());

  it("offers the four views, with 实时 first", async () => {
    seed();
    const wrapper = await mountDetail();

    expect(tabLinks(wrapper)).toEqual(["实时", "曲线", "回放", "消息史"]);
    expect(tabStrip(wrapper).find("a[aria-current='page']").text()).toBe(
      "实时",
    );
  });

  it("opens the tab named in the URL, so a playback is a link", async () => {
    // "Look at c12's charts" should be a URL rather than a sentence with a step in it.
    seed();
    const wrapper = await mountDetail("agv-01", "charts");

    expect(tabStrip(wrapper).find("a[aria-current='page']").text()).toBe(
      "曲线",
    );
  });

  it("links each tab to its own route rather than a query toggle", async () => {
    seed();
    const wrapper = await mountDetail();

    const hrefs = tabStrip(wrapper)
      .findAll("a")
      .map((link) => link.attributes("href"));
    expect(hrefs).toEqual([
      "/devices/agv-01",
      "/devices/agv-01/charts",
      "/devices/agv-01/playback",
      "/devices/agv-01/alerts",
    ]);
  });

  it("does not download the chart or map engine to show 实时", async () => {
    // Each tab is a lazy route import, so arriving at 实时 mounts none of ECharts: the
    // split point and the "do we need this yet" point are the same line. Measured in the
    // bundle by `e2e/specs/console-devices.spec.ts`; here the proxy is that the component
    // is not in the tree.
    seed();
    const wrapper = await mountDetail();

    expect(wrapper.findComponent(TimeSeriesChart).exists()).toBe(false);
    // The live tab's own content is there.
    expect(wrapper.text()).toContain("报码解读");
  });
});

describe("曲线", () => {
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
   * Mounted on the `charts` child route, and that is the assertion as much as the
   * setup: the tab is a lazy child route, so a device opened on 实时 mounts neither this
   * component nor its history request.
   */
  const mountCharts = () => mountDetail("agv-01", "charts");

  it("draws speed and charge as two cards, never one chart with two axes", async () => {
    // m/s and % on shared axes would let the crossing point be chosen by whoever
    // picked the scales, which is the single most common way a chart misleads.
    seed();
    const wrapper = await mountCharts();

    const cards = wrapper.findAllComponents(DeviceMetricCurve);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.props("metric")).toBe("speed");
    expect(cards[0]?.props("unit")).toBe("m/s");
    expect(cards[1]?.props("metric")).toBe("soc");
    expect(cards[1]?.props("unit")).toBe("%");
  });

  it("opens both cards on 实时, seeded from a plain recent-history window", async () => {
    const getHistory = vi.spyOn(fleetApi, "getHistory").mockResolvedValue({
      deviceId: "agv-01",
      items: [sample("2026-11-03T11:55:00+08:00", 1.1, 80)],
    });
    seed();
    const wrapper = await mountCharts();

    // Each card shows its live chart straight away, seeded by a from/to query — never the
    // three-day even-sampled span, which is only fetched when 历史 is selected.
    expect(wrapper.findAllComponents(TimeSeriesChart)).toHaveLength(2);
    expect(
      getHistory.mock.calls.every(([, p]) => p?.sampling === undefined),
    ).toBe(true);
    expect(getHistory.mock.calls[0]?.[1]).toMatchObject({
      from: expect.any(String),
      to: expect.any(String),
    });
  });

  it("costs no request at all while the 实时 tab is the one showing", async () => {
    const getHistory = vi.spyOn(fleetApi, "getHistory");
    seed();
    await mountDetail();

    expect(getHistory).not.toHaveBeenCalled();
  });
});
