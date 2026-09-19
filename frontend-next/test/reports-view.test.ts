import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { AlertStatsReport, AvailabilityReport } from "@navfleet/shared";
import ReportsView from "@/views/ReportsView.vue";
import { useFleetStore } from "@/stores/fleet";

/**
 * 报表 — the aggregation-backed report page (Phase 17B-1). Both `fleetApi.getAvailabilityReport`
 * and `getAlertStatsReport` are mocked; the charts are stubbed (their option builders are tested
 * in charts.test.ts), so this file owns the view's own logic: the four states, the KPI band, the
 * honest-empty link when there is no Mongo, CSV export, and refetching when a filter changes.
 */
enableAutoUnmount(afterEach);

// Charts need a canvas jsdom lacks; stub them and assert the view feeds them the right data.
const lineStub = {
  props: ["series", "label"],
  template:
    '<div class="line-stub" :data-label="label" :data-series="series.length" />',
};
const barStub = {
  props: ["data", "label"],
  template:
    '<div class="bar-stub" :data-label="label" :data-count="data.length" />',
};

const availabilityReport = (
  patch: Partial<AvailabilityReport> = {},
): AvailabilityReport => ({
  bucket: "day",
  available: true,
  devices: [
    {
      deviceId: "agv-01",
      buckets: [
        {
          bucketStart: "2026-09-01T00:00:00.000Z",
          onlineSamples: 9,
          totalSamples: 10,
          onlineRatio: 0.9,
          socMean: 80,
          socMin: 60,
        },
        {
          bucketStart: "2026-09-02T00:00:00.000Z",
          onlineSamples: 10,
          totalSamples: 10,
          onlineRatio: 1.0,
          socMean: 78,
          socMin: 70,
        },
      ],
    },
  ],
  ...patch,
});

const alertStatsReport = (
  patch: Partial<AlertStatsReport> = {},
): AlertStatsReport => ({
  total: 4,
  bySeverity: { critical: 1, warning: 2, notice: 1 },
  topDevices: [{ deviceId: "agv-01", count: 4 }],
  daily: [{ day: "2026-09-01", count: 4 }],
  ackRate: 0.5,
  duration: { count: 2, meanMs: 90000, p50Ms: 90000 },
  available: true,
  ...patch,
});

let router: Router;

const mountView = async (query = "") => {
  setActivePinia(createPinia());
  // Seed one device so nameOf/deviceOptions resolve a real name rather than the bare id.
  useFleetStore().ingestPayload(
    {
      fleetName: "示范车队",
      topicPattern: "/fleet/{deviceId}/vehicle_info",
      devices: [{ deviceId: "agv-01", deviceName: "A01 巡检车" }],
    },
    "api",
  );
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/reports", component: ReportsView },
      { path: "/admin/system", component: { template: "<i />" } },
    ],
  });
  await router.push(`/reports${query}`);
  await router.isReady();
  const wrapper = mount(ReportsView, {
    global: {
      plugins: [router],
      stubs: { TimeSeriesChart: lineStub, CategoryBarChart: barStub },
    },
  });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  vi.spyOn(fleetApi, "getAvailabilityReport").mockResolvedValue(
    availabilityReport(),
  );
  vi.spyOn(fleetApi, "getAlertStatsReport").mockResolvedValue(
    alertStatsReport(),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("报表 状态与内容", () => {
  it("接口失败时报出错误而不是留空白", async () => {
    vi.spyOn(fleetApi, "getAvailabilityReport").mockRejectedValue(
      new Error("HTTP 503"),
    );
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("HTTP 503");
  });

  it("两个报表都 available:false 时说无历史并链到系统状态", async () => {
    vi.spyOn(fleetApi, "getAvailabilityReport").mockResolvedValue(
      availabilityReport({ devices: [], available: false }),
    );
    vi.spyOn(fleetApi, "getAlertStatsReport").mockResolvedValue(
      alertStatsReport({ total: 0, available: false }),
    );
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("暂无历史可聚合");
    expect(wrapper.find('a[href="/admin/system"]').exists()).toBe(true);
  });

  it("渲染 KPI 带、时序图与告警柱图", async () => {
    const wrapper = await mountView();

    // KPI band: fleet online = 19/20 = 95.0%, weighted soc = (80*10+78*10)/20 = 79.0%.
    expect(wrapper.text()).toContain("平均在线率");
    expect(wrapper.text()).toContain("95.0%");
    expect(wrapper.text()).toContain("79.0%");
    // 确认率 0.5 → 50%; 消息总数 4.
    expect(wrapper.text()).toContain("50%");

    // Two time-series (online + battery) and three bar charts (severity/top/daily).
    expect(wrapper.findAll(".line-stub")).toHaveLength(2);
    expect(wrapper.findAll(".bar-stub")).toHaveLength(3);
  });

  it("导出 CSV 时生成一个带 BOM 的 Blob 并触发下载", async () => {
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:stub");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const wrapper = await mountView();
    const exportButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("导出"));
    await exportButton!.trigger("click");

    expect(createUrl).toHaveBeenCalledOnce();
    expect(createUrl.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect(click).toHaveBeenCalledOnce();
  });

  it("切换时间范围会带新窗口重新取数", async () => {
    const avail = vi
      .spyOn(fleetApi, "getAvailabilityReport")
      .mockResolvedValue(availabilityReport());
    const wrapper = await mountView();
    const firstFrom = avail.mock.calls[0]![0]!.from;

    const button = wrapper
      .findAll("button")
      .find((candidate) => candidate.text() === "近 7 天");
    await button!.trigger("click");
    await flushPromises();

    // A refetch happened, and the 7-day window starts earlier than the default 12-hour one.
    expect(avail.mock.calls.length).toBeGreaterThan(1);
    const lastFrom = avail.mock.calls.at(-1)![0]!.from;
    expect(Date.parse(lastFrom!)).toBeLessThan(Date.parse(firstFrom!));
  });

  it("自定义起止日期接管预设并带该窗口取数", async () => {
    const avail = vi
      .spyOn(fleetApi, "getAvailabilityReport")
      .mockResolvedValue(availabilityReport());
    // A custom window in the URL: the fetch must use those dates, not a preset window.
    const wrapper = await mountView("?from=2026-03-01&to=2026-03-03");

    const call = avail.mock.calls.at(-1)![0]!;
    expect(call.from).toBe(new Date("2026-03-01T00:00:00").toISOString());
    expect(call.to).toBe(new Date("2026-03-03T23:59:59.999").toISOString());

    // No preset is highlighted while a custom window is in force.
    const pressed = wrapper
      .findAll("button")
      .filter((button) => button.attributes("aria-pressed") === "true")
      .map((button) => button.text());
    expect(pressed).not.toContain("近 12 小时");
  });

  it("按月粒度会带 month 去取可用率", async () => {
    const avail = vi
      .spyOn(fleetApi, "getAvailabilityReport")
      .mockResolvedValue(availabilityReport());
    await mountView("?bucket=month");
    expect(avail.mock.calls.at(-1)![0]!.bucket).toBe("month");
  });
});
