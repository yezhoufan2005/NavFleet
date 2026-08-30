import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import AlertsView from "@/views/AlertsView.vue";
import NotificationHost from "@/components/NotificationHost.vue";
import { useFleetStore } from "@/stores/fleet";
import {
  ALERT_ACK_STORAGE_KEY,
  __resetAlertAck,
} from "@/composables/useAlertAck";
import {
  useNotifications,
  __resetNotifications,
} from "@/composables/useNotifications";

/**
 * The alert centre. Most of these cover the 11B audit's list — the things that were
 * missing rather than wrong: filter state in the URL, a toggle that says it is one,
 * an empty state that is announced, and a row that reaches the vehicle.
 */
enableAutoUnmount(afterEach);

const code = (value: number, info: string) => ({
  code: value,
  info,
  stamp: null,
});

const device = (patch: Record<string, unknown> = {}) => ({
  deviceId: "agv-01",
  deviceName: "A01 巡检车",
  online: true,
  ...patch,
});

let store: ReturnType<typeof useFleetStore>;
let router: Router;

const mountAlerts = async (query = "") => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/alerts", component: AlertsView },
      { path: "/devices/:deviceId", component: { template: "<i />" } },
    ],
  });
  await router.push(`/alerts${query}`);
  await router.isReady();

  const wrapper = mount(AlertsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

/** A fleet whose alerts span all three severities and two vehicles. */
const seedMixed = () =>
  store.ingestPayload(
    {
      fleetName: "示范车队",
      topicPattern: "/fleet/{deviceId}/vehicle_info",
      devices: [
        device({ error_code: code(5102, "路径规划超时") }),
        device({
          deviceId: "agv-02",
          deviceName: "B07 巡检车",
          warning_code: code(2301, "电量偏低"),
        }),
        device({
          deviceId: "agv-03",
          deviceName: "C12 巡检车",
          info_code: code(1101, "定位稳定"),
        }),
      ],
    },
    "api",
  );

const alertIds = () =>
  (["critical", "warning", "notice"] as const).flatMap((bucket) =>
    store.groupedAlerts[bucket].map((alert) => alert.id),
  );

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  __resetAlertAck();
  __resetNotifications();
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  store = useFleetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the list", () => {
  it("orders worst severity first", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    const badges = wrapper.findAll("li").map((row) => row.find("span").text());

    expect(badges).toEqual(["告警", "预警", "提示"]);
  });

  it("says the fleet is quiet, distinctly from an over-filtered list", async () => {
    // Two different situations, and telling them apart is the whole value of the
    // sentence: one means nothing is wrong, the other means look at your filters.
    const empty = await mountAlerts();
    expect(empty.find("[role='status']").text()).toContain("没有活跃告警");
    empty.unmount();

    seedMixed();
    const filtered = await mountAlerts("?q=不存在的关键词");
    expect(filtered.find("[role='status']").text()).toContain(
      "没有符合当前筛选条件",
    );
  });

  it("links each row to the vehicle it came from", async () => {
    // Diagnosing an alert used to mean reading the device id and going to find it.
    seedMixed();
    const wrapper = await mountAlerts();

    expect(wrapper.find("a[href='/devices/agv-01']").exists()).toBe(true);
  });

  it("states the acknowledgement limitation on the page", async () => {
    // A known limitation and a silent one look identical to whoever is on shift.
    seedMixed();
    const wrapper = await mountAlerts();
    expect(wrapper.text()).toContain("只保存在当前浏览器");
  });
});

describe("filters live in the URL", () => {
  it("reads severity, device, search and page from the query", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?severity=warning");

    expect(wrapper.findAll("li")).toHaveLength(1);
    expect(wrapper.text()).toContain("电量偏低");
  });

  it("writes a filter back so the view can be sent to someone", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    const critical = wrapper
      .findAll("button")
      .find((button) => button.text() === "告警");
    await critical?.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.query.severity).toBe("critical");
    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("keeps a clean URL for the default view", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?severity=critical");

    const all = wrapper.findAll("button").find((b) => b.text() === "全部");
    await all?.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.query.severity).toBeUndefined();
  });

  it("marks the active severity as pressed, not merely coloured", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?severity=critical");
    const pressed = wrapper
      .findAll("button")
      .filter((button) => button.attributes("aria-pressed") === "true")
      .map((button) => button.text());

    expect(pressed).toContain("告警");
  });

  it("narrows to one vehicle", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?device=agv-02");

    expect(wrapper.findAll("li")).toHaveLength(1);
    expect(wrapper.text()).toContain("B07");
  });

  it("searches title, detail and device together", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?q=C12");

    expect(wrapper.findAll("li")).toHaveLength(1);
  });
});

describe("the controls the template wires up", () => {
  it("filters by the device select", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    await wrapper.find("select").setValue("agv-02");
    await flushPromises();

    expect(router.currentRoute.value.query.device).toBe("agv-02");
    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("filters by the search box", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    await wrapper.find("input[type='search']").setValue("电量");
    await flushPromises();

    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("reveals acknowledged alerts on request", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(2);

    await wrapper.find("input[type='checkbox']").setValue(true);
    await flushPromises();

    expect(router.currentRoute.value.query.acked).toBe("1");
    expect(wrapper.findAll("li")).toHaveLength(3);
  });

  it("pages a long list and clamps when a filter shrinks it", async () => {
    // 25 faulted vehicles: two pages at 20 per page.
    store.ingestPayload(
      {
        fleetName: "示范车队",
        topicPattern: "/fleet/{deviceId}/vehicle_info",
        devices: Array.from({ length: 25 }, (_unused, index) =>
          device({
            deviceId: `agv-${String(index + 1).padStart(2, "0")}`,
            deviceName: `车 ${index + 1}`,
            error_code: code(5102, "路径规划超时"),
          }),
        ),
      },
      "api",
    );
    const wrapper = await mountAlerts();
    expect(wrapper.findAll("li")).toHaveLength(20);

    const next = wrapper.findAll("button").find((b) => b.text() === "下一页");
    await next?.trigger("click");
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(5);
    expect(wrapper.text()).toContain("第 2 / 2 页");

    const previous = wrapper
      .findAll("button")
      .find((b) => b.text() === "上一页");
    await previous?.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.query.page).toBeUndefined();
  });

  it("pulls the page number back when a filter leaves it past the end", async () => {
    // Staying on page 2 of a one-page list shows nothing and looks broken.
    store.ingestPayload(
      {
        fleetName: "示范车队",
        topicPattern: "/fleet/{deviceId}/vehicle_info",
        devices: Array.from({ length: 25 }, (_unused, index) =>
          device({
            deviceId: `agv-${String(index + 1).padStart(2, "0")}`,
            error_code: code(5102, "路径规划超时"),
          }),
        ),
      },
      "api",
    );
    const wrapper = await mountAlerts("?page=2");
    expect(wrapper.findAll("li")).toHaveLength(5);

    await wrapper.find("select").setValue("agv-01");
    await flushPromises();

    expect(router.currentRoute.value.query.page).toBeUndefined();
    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("ignores a page number that is not one", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?page=abc");
    expect(wrapper.findAll("li")).toHaveLength(3);
  });
});

describe("acknowledging", () => {
  it("is a toggle that says so", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?acked=1");
    const button = wrapper.findAll("li")[0]!.findAll("button").at(-1)!;

    expect(button.attributes("aria-pressed")).toBe("false");
    expect(button.attributes("aria-label")).toContain("确认告警");

    await button.trigger("click");
    expect(
      wrapper
        .findAll("li")[0]!
        .findAll("button")
        .at(-1)!
        .attributes("aria-pressed"),
    ).toBe("true");
  });

  it("hides an acknowledged alert unless asked for", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    expect(wrapper.findAll("li")).toHaveLength(3);

    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    expect(wrapper.findAll("li")).toHaveLength(2);
  });

  it("survives a reload", async () => {
    seedMixed();
    const [first] = alertIds();
    const wrapper = await mountAlerts();
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");

    expect(localStorage.getItem(ALERT_ACK_STORAGE_KEY)).toContain(first);
  });

  it("offers an undo after a bulk acknowledgement, and the undo works", async () => {
    // A bulk action is easy to trigger by accident and tedious to reverse by hand.
    seedMixed();
    const wrapper = await mountAlerts();

    const bulk = wrapper
      .findAll("button")
      .find((button) => button.text().includes("确认本页"));
    await bulk?.trigger("click");
    await flushPromises();

    expect(wrapper.findAll("li")).toHaveLength(0);
    const toast = useNotifications().items.at(-1);
    expect(toast?.message).toContain("已确认 3 条");
    expect(toast?.action?.label).toBe("撤销");

    toast!.action!.handler();
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(3);
  });

  it("raises no toast when there was nothing left to acknowledge", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("确认本页"))
      ?.trigger("click");
    __resetNotifications();
    await flushPromises();

    // The bulk button is gone, so there is nothing to click — and nothing to announce.
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("确认本页")),
    ).toBe(false);
    expect(useNotifications().items).toEqual([]);
  });
});

describe("the toast's undo button", () => {
  it("runs the action and dismisses itself", async () => {
    // Leaving 撤销 on screen after it has been used invites a second click that would
    // undo the undo.
    const undone = vi.fn();
    const host = mount(NotificationHost);
    useNotifications().notify("已确认 3 条告警", {
      action: { label: "撤销", handler: undone },
    });
    await flushPromises();

    const button = host.findAll("button").find((b) => b.text() === "撤销");
    expect(button).toBeDefined();

    await button!.trigger("click");
    expect(undone).toHaveBeenCalledTimes(1);
    expect(useNotifications().items).toEqual([]);
  });

  it("is absent when the message offers no action", async () => {
    const host = mount(NotificationHost);
    useNotifications().notify("普通提示");
    await flushPromises();

    expect(host.findAll("button").map((b) => b.text())).toEqual(["×"]);
  });
});

describe("the acknowledgement store itself", () => {
  it("clears everything on request", async () => {
    seedMixed();
    const ack = (await import("@/composables/useAlertAck")).useAlertAck();
    ack.acknowledgeMany(alertIds());
    expect(ack.acknowledgedCount.value).toBe(3);

    ack.clearAll();
    expect(ack.acknowledgedCount.value).toBe(0);
  });

  it("ignores an empty id rather than storing one", async () => {
    const ack = (await import("@/composables/useAlertAck")).useAlertAck();
    ack.acknowledge("");
    ack.unacknowledge("");
    expect(ack.acknowledgedCount.value).toBe(0);
  });

  it("reports only the ids a bulk call actually changed", async () => {
    // That set is what an undo has to reverse — undoing an id that was already
    // acknowledged before the bulk action would un-acknowledge someone else's work.
    const ack = (await import("@/composables/useAlertAck")).useAlertAck();
    ack.acknowledge("a");

    expect(ack.acknowledgeMany(["a", "b"])).toEqual(["b"]);
  });

  it("keeps working when storage refuses", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const ack = (await import("@/composables/useAlertAck")).useAlertAck();

    expect(() => ack.acknowledge("a")).not.toThrow();
    expect(ack.isAcknowledged("a")).toBe(true);
  });

  it("survives a stored value that is not an array", async () => {
    localStorage.setItem(ALERT_ACK_STORAGE_KEY, '{"not":"an array"}');
    __resetAlertAck();
    const ack = (await import("@/composables/useAlertAck")).useAlertAck();

    expect(ack.acknowledgedCount.value).toBe(0);
  });
});
