import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi, formatDateTime } from "@navfleet/fleet-core";
import type { AlertRecord } from "@navfleet/fleet-core";
import DeviceAlertsTab from "@/components/device/DeviceAlertsTab.vue";

/**
 * 告警史 — the fourth L3 tab, and the first consumer of `/api/v1/alerts` anywhere in
 * the console (13D-1 built the alert centre on the store's live alerts and left the
 * endpoint at zero calls).
 *
 * The tests that matter most are about the two states an operator can misread: an
 * empty history that is really a missing MongoDB, and a row that is still running
 * versus one that has ended.
 */
enableAutoUnmount(afterEach);

const BASE = Date.parse("2026-08-30T02:00:00.000Z");

const record = (patch: Partial<AlertRecord> = {}): AlertRecord =>
  ({
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
  }) as AlertRecord;

let getAlerts: MockInstance<typeof fleetApi.getAlerts>;

const mountTab = async (deviceId = "agv-01") => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
  });
  // Pushed before `isReady`: a memory history performs no initial navigation on its
  // own, so awaiting readiness without a push never resolves.
  await router.push("/devices/agv-01");
  await router.isReady();
  const wrapper = mount(DeviceAlertsTab, {
    props: { deviceId },
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());
  getAlerts = vi
    .spyOn(fleetApi, "getAlerts")
    .mockResolvedValue({ items: [record()] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("告警史", () => {
  it("按设备取，而不是取全车队再筛", async () => {
    await mountTab("agv-07");
    expect(getAlerts).toHaveBeenCalledWith({ deviceId: "agv-07" });
  });

  it("是这个端点在控制台里的第一个消费者", async () => {
    // Worth an assertion rather than a comment: 13D-1 recorded `/api/v1/alerts` as
    // having zero callers, and this tab is the change.
    await mountTab();
    expect(getAlerts).toHaveBeenCalledTimes(1);
  });

  it("显示告警中心从不显示的三样：发生、结束、还在不在", async () => {
    // The reason this is not the alert centre's row. That page renders live alerts —
    // active by definition — so `ts` / `clearedAt` / `active` never appear there.
    const wrapper = await mountTab();

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

    // Scoped to the row: the header legitimately says "0 条仍活跃".
    const row = wrapper.get("li");
    expect(row.text()).toContain("已清除");
    expect(row.text()).not.toContain("仍活跃");
    // Built with the same formatter rather than typed out. A literal "2026/8/30
    // 10:01:30" is the UTC+8 rendering of this instant, so it asserted the author's
    // timezone — it passed here and failed on both CI legs, which run UTC. The
    // timezone is pinned in `vitest.config.ts` now; this still goes through the
    // formatter, because what the test means is "the cleared instant is shown".
    expect(row.text()).toContain(formatDateTime(BASE + 90_000));
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
    const titles = wrapper.findAll("li strong").map((item) => item.text());

    expect(titles).toEqual(["较晚的一条", "较早的一条"]);
  });

  it("没有时间戳的排最后，而不是自称就是现在", async () => {
    // `formatDateTime` falls back to `Date.now()`, so the naive version both dates an
    // undated record to this second and sorts it to the top.
    getAlerts.mockResolvedValue({
      items: [
        record({ id: "undated", title: "无时间戳", ts: undefined }),
        record({ id: "dated", title: "有时间戳" }),
      ],
    });
    const wrapper = await mountTab();
    const items = wrapper.findAll("li");

    expect(items[1]!.text()).toContain("无时间戳");
    expect(items[1]!.text()).toContain("--");
  });

  it("空态说清缺的是 MongoDB，并给出能回答这件事的那一页", async () => {
    // Without Mongo the endpoint can only answer with active alerts, so a vehicle with
    // a long troubled history looks exactly like one that has never faulted. That is
    // the state this copy exists to separate.
    getAlerts.mockResolvedValue({ items: [] });
    const wrapper = await mountTab();

    expect(wrapper.text()).toContain("MongoDB");
    expect(wrapper.find("a").attributes("href")).toBe("/admin/system");
  });

  it("数出仍活跃的条数，那是决定要不要动手的数字", async () => {
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

    expect(wrapper.text()).toContain("2 条 · 1 条仍活跃");
  });

  it("请求失败就说失败，不装成没有历史", async () => {
    getAlerts.mockRejectedValue(new Error("HTTP 503"));
    const wrapper = await mountTab();

    expect(wrapper.text()).toContain("HTTP 503");
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
    const text = wrapper.text();

    expect(text).toContain("告警");
    expect(text).toContain("预警");
    expect(text).toContain("提示");
  });
});
