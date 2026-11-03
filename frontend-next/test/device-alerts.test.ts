import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { fleetApi, formatDateTime } from "@navfleet/fleet-core";
import type { AlertRecord } from "@navfleet/fleet-core";
import DeviceAlertsTab from "@/components/device/DeviceAlertsTab.vue";

/**
 * 消息史 — the fourth L3 tab, and the first consumer of `/api/v1/alerts` anywhere in
 * the console.
 *
 * The history is grouped into one collapsible card per calendar day, closed on arrival with a
 * summary (date · count · severity tally). So most assertions about a row's content expand its
 * day first (`expandAll`); what reads while collapsed is the per-day summary.
 *
 * The states an operator can misread are still the point: an empty history that is really a
 * missing MongoDB, a 发生 that is the onset and not the last report, and — unlike 消息·消息史 —
 * a row that is still active rather than cleared.
 */
enableAutoUnmount(afterEach);

const BASE = Date.parse("2026-08-30T02:00:00.000Z");

const record = (patch: Partial<AlertRecord> = {}): AlertRecord => ({
  id: "agv-01-error-5102",
  deviceId: "agv-01",
  deviceName: "A01 巡检车",
  severity: "critical",
  source: "error_code",
  title: "路径规划超时",
  detail: "目标点被占据",
  code: 5102,
  active: true,
  ts: new Date(BASE).toISOString(),
  clearedAt: null,
  ...patch,
});

let getAlerts: MockInstance<typeof fleetApi.getAlerts>;

const mountTab = async (deviceId = "agv-01") => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
  });
  await router.push("/devices/agv-01");
  await router.isReady();
  const wrapper = mount(DeviceAlertsTab, {
    props: { deviceId },
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
};

/** Open every collapsed day group so row-level content renders. */
const expandAll = async (wrapper: VueWrapper): Promise<void> => {
  for (const button of wrapper.findAll("button[aria-expanded]")) {
    if (button.attributes("aria-expanded") === "false")
      await button.trigger("click");
  }
  await flushPromises();
};

/** A day-group summary button (the thing rendered while collapsed). */
const dayButtons = (wrapper: VueWrapper) =>
  wrapper.findAll("button[aria-expanded]");
/** A message row within an expanded day. */
const rowItems = (wrapper: VueWrapper) => wrapper.findAll("li[data-severity]");

beforeEach(() => {
  setActivePinia(createPinia());
  getAlerts = vi
    .spyOn(fleetApi, "getAlerts")
    .mockResolvedValue({ items: [record()] });
});

afterEach(() => {
  vi.restoreAllMocks();
});
describe("消息史", () => {
  it("按设备取，30 天窗 + 1000 条上限，而不是取全车队再筛", async () => {
    await mountTab("agv-07");
    expect(getAlerts).toHaveBeenCalledTimes(1);
    const [params] = getAlerts.mock.calls[0]!;
    expect(params).toMatchObject({ deviceId: "agv-07", limit: 1000 });
    expect(typeof params!.from).toBe("string");
  });

  it("按天分组，组头给出条数与严重度概要", async () => {
    getAlerts.mockResolvedValue({
      items: [
        record({ id: "a" }),
        record({
          id: "b",
          active: false,
          clearedAt: new Date(BASE).toISOString(),
        }),
      ],
    });
    const wrapper = await mountTab();

    // Both on the same calendar day → one group; its summary counts both and tallies severity.
    expect(wrapper.text()).toContain("最近 30 天 · 2 条");
    const summary = dayButtons(wrapper)[0]!;
    expect(summary.text()).toContain("2 条");
    expect(summary.text()).toContain("告警 2");
  });

  it("默认全部收起，点日期组才展开当天的记录", async () => {
    const wrapper = await mountTab();
    const summary = dayButtons(wrapper)[0]!;

    expect(summary.attributes("aria-expanded")).toBe("false");
    // Collapsed: the row (and its 发生/结束) is not in the DOM yet.
    expect(rowItems(wrapper).length).toBe(0);

    await summary.trigger("click");
    await flushPromises();

    expect(summary.attributes("aria-expanded")).toBe("true");
    expect(rowItems(wrapper).length).toBe(1);
  });
  it("去掉了醒目的活跃计数与每条的活跃/已清除徽标，状态只落在结束一栏", async () => {
    getAlerts.mockResolvedValue({
      items: [
        record({ id: "a" }),
        record({
          id: "b",
          active: false,
          clearedAt: new Date(BASE).toISOString(),
        }),
      ],
    });
    const wrapper = await mountTab();

    // Header counts the total, not "N 条仍活跃"; the summary tallies severity, not active state.
    expect(wrapper.text()).toContain("2 条");
    expect(wrapper.text()).not.toContain("仍活跃");

    await expandAll(wrapper);
    // Expanded, 仍活跃 shows as the active row's 结束 value.
    const activeRow = rowItems(wrapper).find((row) =>
      row.text().includes("仍活跃"),
    );
    expect(activeRow).toBeTruthy();
  });

  it("每条写出发生、结束，仍在运行的写「仍活跃」", async () => {
    const wrapper = await mountTab();
    await expandAll(wrapper);

    expect(wrapper.text()).toContain("发生");
    expect(wrapper.text()).toContain("结束");
    expect(wrapper.text()).toContain("仍活跃");
  });

  it("已清除的写出清除时间，而不是只说已清除", async () => {
    getAlerts.mockResolvedValue({
      items: [
        record({
          active: false,
          clearedAt: new Date(BASE + 90_000).toISOString(),
        }),
      ],
    });
    const wrapper = await mountTab();
    await expandAll(wrapper);

    const row = rowItems(wrapper)[0]!;
    expect(row.text()).toContain(formatDateTime(BASE + 90_000));
    expect(row.text()).not.toContain("仍活跃");
  });
  it("最新的排在最前，因为时间线是从现在往回读的", async () => {
    getAlerts.mockResolvedValue({
      items: [
        record({
          id: "old",
          title: "较早的一条",
          ts: new Date(BASE).toISOString(),
        }),
        record({
          id: "new",
          title: "较晚的一条",
          ts: new Date(BASE + 60_000).toISOString(),
        }),
      ],
    });
    const wrapper = await mountTab();
    await expandAll(wrapper);
    const titles = wrapper
      .findAll("li[data-severity] strong")
      .map((item) => item.text());

    expect(titles).toEqual(["较晚的一条", "较早的一条"]);
  });

  it("没有时间戳的归到末尾的「未知时间」，而不是自称就是现在", async () => {
    getAlerts.mockResolvedValue({
      items: [
        record({ id: "undated", title: "无时间戳", ts: undefined }),
        record({ id: "dated", title: "有时间戳" }),
      ],
    });
    const wrapper = await mountTab();

    // The undated bucket is the last group and is named 未知时间.
    const groups = dayButtons(wrapper);
    expect(groups[groups.length - 1]!.text()).toContain("未知时间");

    await expandAll(wrapper);
    const undatedRow = rowItems(wrapper).find((row) =>
      row.text().includes("无时间戳"),
    )!;
    expect(undatedRow.text()).toContain("--");
  });

  it("空态说清缺的是 MongoDB，并给出能回答这件事的那一页", async () => {
    getAlerts.mockResolvedValue({ items: [] });
    const wrapper = await mountTab();

    expect(wrapper.text()).toContain("MongoDB");
    expect(wrapper.find("a").attributes("href")).toBe("/system");
  });

  it("请求失败就说失败，不装成没有历史", async () => {
    getAlerts.mockRejectedValue(new Error("HTTP 503"));
    const wrapper = await mountTab();

    expect(wrapper.text()).toContain("消息历史加载失败");
    expect(wrapper.text()).not.toContain("HTTP 503");
    expect(wrapper.text()).not.toContain("MongoDB");
  });
  it("换设备重新取，且旧设备的迟到响应不会落地", async () => {
    let settleFirst: (value: { items: AlertRecord[] }) => void = () =>
      undefined;
    getAlerts.mockImplementationOnce(
      () => new Promise((resolve) => (settleFirst = resolve)),
    );
    const wrapper = await mountTab("agv-01");

    getAlerts.mockResolvedValue({
      items: [record({ id: "b", deviceId: "agv-02", title: "第二台的告警" })],
    });
    await wrapper.setProps({ deviceId: "agv-02" });
    await flushPromises();

    settleFirst({ items: [record({ title: "第一台的告警" })] });
    await flushPromises();
    await expandAll(wrapper);

    expect(wrapper.text()).toContain("第二台的告警");
    expect(wrapper.text()).not.toContain("第一台的告警");
  });

  it("严重度用词，不只用颜色", async () => {
    getAlerts.mockResolvedValue({
      items: [
        record({ id: "c", severity: "critical" }),
        record({ id: "w", severity: "warning" }),
        record({ id: "n", severity: "notice" }),
      ],
    });
    const wrapper = await mountTab();
    // The words ride the collapsed summary's severity tally — identity never colour alone.
    const text = wrapper.text();

    expect(text).toContain("告警");
    expect(text).toContain("预警");
    expect(text).toContain("提示");
  });

  it("「发生」取这次发生的起点，不是最后一次上报", async () => {
    getAlerts.mockResolvedValue({
      items: [
        record({
          firstSeenAt: "2026-08-30T00:00:00.000Z",
          ts: "2026-08-30T02:59:58.000Z",
          active: false,
          clearedAt: "2026-08-30T03:00:03.000Z",
        }),
      ],
    });
    const wrapper = await mountTab();
    await expandAll(wrapper);
    const text = wrapper.text();

    expect(text).toContain(
      formatDateTime(Date.parse("2026-08-30T00:00:00.000Z")),
    );
    expect(text).not.toContain(
      formatDateTime(Date.parse("2026-08-30T02:59:58.000Z")),
    );
  });

  it("说明只显示了后端上限内的最近几条", async () => {
    getAlerts.mockResolvedValue({
      items: [record()],
      truncated: true,
      limit: 500,
    });
    const wrapper = await mountTab();
    expect(wrapper.text()).toContain("只显示最近 500 条");
  });
});
