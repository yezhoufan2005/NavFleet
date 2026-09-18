import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi, type AlertRecord } from "@navfleet/fleet-core";
import AlertHistoryView from "@/views/AlertHistoryView.vue";
import UiSelect from "@/components/ui/UiSelect.vue";

/**
 * 告警史 — the cleared-alert history + statistics page (Phase 16B). `fleetApi.getAlerts` is
 * mocked; the charts are stubbed (their option builders are tested in charts.test.ts), so this
 * file owns the view's own logic: loading/error/empty states, the client-side stats it derives,
 * the URL filters, and the 500-row cap notice.
 */
enableAutoUnmount(afterEach);

// The charts need a canvas; stub them and assert the view feeds them the right data instead.
const barStub = {
  props: ["data", "label"],
  template:
    '<div class="bar-stub" :data-label="label" :data-count="data.length" :data-total="data.reduce((s, d) => s + d.value, 0)"></div>',
};

const record = (over: Partial<AlertRecord> = {}): AlertRecord => ({
  eventKey: "agv-01:e1",
  deviceId: "agv-01",
  deviceName: "A01 巡检车",
  severity: "warning",
  title: "电量偏低",
  detail: "电量偏低，已提醒",
  firstSeenAt: "2026-03-01T00:00:00.000Z",
  clearedAt: "2026-03-01T01:00:00.000Z",
  ts: "2026-03-01T00:00:00.000Z",
  ackedBy: null,
  ...over,
});

let router: Router;

const mountView = async (query = "") => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/alert-history", component: AlertHistoryView },
      { path: "/alerts", component: { template: "<i />" } },
      { path: "/admin/system", component: { template: "<i />" } },
      { path: "/devices/:deviceId", component: { template: "<i />" } },
    ],
  });
  await router.push(`/alert-history${query}`);
  await router.isReady();
  const wrapper = mount(AlertHistoryView, {
    global: { plugins: [router], stubs: { CategoryBarChart: barStub } },
  });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({ items: [record()] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loading and failure", () => {
  it("reads only cleared alerts from the endpoint", async () => {
    const spy = vi
      .spyOn(fleetApi, "getAlerts")
      .mockResolvedValue({ items: [] });
    await mountView();
    expect(spy).toHaveBeenCalledWith({ status: "cleared" });
  });

  it("shows an error state when the history fails to load", async () => {
    vi.spyOn(fleetApi, "getAlerts").mockRejectedValue(new Error("HTTP 503"));
    const wrapper = await mountView();
    expect(wrapper.find("[role='status']").text()).toContain("HTTP 503");
  });

  it("explains the empty result and links to 系统状态 (Mongo may be off)", async () => {
    vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({ items: [] });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("MongoDB");
    expect(wrapper.find("a[href='/admin/system']").exists()).toBe(true);
  });
});

describe("the statistics", () => {
  it("summarises count, ack rate and duration", async () => {
    vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({
      items: [
        record({ ackedBy: "op", clearedAt: "2026-03-01T01:00:00.000Z" }), // 1h, acked
        record({
          eventKey: "agv-02:e1",
          deviceId: "agv-02",
          ackedBy: null,
          clearedAt: "2026-03-01T03:00:00.000Z",
        }), // 3h, not acked
      ],
    });
    const wrapper = await mountView();
    const text = wrapper.text();
    expect(text).toContain("已清除");
    // 1 of 2 acknowledged.
    expect(text).toContain("50%");
    // mean of 1h and 3h = 2h.
    expect(text).toContain("2小时0分");
  });

  it("feeds the severity chart one bar per severity, summing to the total", async () => {
    vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({
      items: [
        record({ severity: "critical" }),
        record({ severity: "critical" }),
        record({ severity: "notice" }),
      ],
    });
    const wrapper = await mountView();
    const severityBar = wrapper
      .findAll(".bar-stub")
      .find((node) => node.attributes("data-label") === "按严重度分布");
    expect(severityBar?.attributes("data-count")).toBe("3");
    expect(severityBar?.attributes("data-total")).toBe("3");
  });
});

describe("the cleared-alert list", () => {
  it("renders a row that reaches the vehicle and shows its duration", async () => {
    const wrapper = await mountView();
    expect(wrapper.find("a[href='/devices/agv-01']").exists()).toBe(true);
    expect(wrapper.text()).toContain("1小时0分");
  });

  it("shows who acknowledged a cleared alert", async () => {
    vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({
      items: [record({ ackedBy: "supervisor" })],
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("已确认 · supervisor");
  });
});

describe("filters and the cap notice", () => {
  it("narrows the list by severity from the URL, client-side", async () => {
    vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({
      items: [
        record({
          severity: "critical",
          title: "路径规划超时",
          detail: "已触发急停",
        }),
        record({
          severity: "warning",
          title: "限速降速",
          detail: "前方限速区",
        }),
      ],
    });
    const wrapper = await mountView("?severity=critical");
    expect(wrapper.text()).toContain("路径规划超时");
    expect(wrapper.text()).not.toContain("限速降速");
  });

  it("writes the device filter back to the URL", async () => {
    const wrapper = await mountView();
    wrapper.findComponent(UiSelect).vm.$emit("update:modelValue", "agv-01");
    await flushPromises();
    expect(router.currentRoute.value.query.device).toBe("agv-01");
  });

  it("says so when the result is capped at 500", async () => {
    vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({
      items: Array.from({ length: 500 }, (_unused, index) =>
        record({ eventKey: `agv:${index}` }),
      ),
    });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("最近 500 条");
  });
});
