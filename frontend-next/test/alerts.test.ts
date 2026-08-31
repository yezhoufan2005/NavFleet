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

  it("filters by the search box, committing on Enter", async () => {
    // Enter skips the debounce, because pressing it in a search box means "now".
    seedMixed();
    const wrapper = await mountAlerts();
    const box = wrapper.find("input[type='search']");

    await box.setValue("电量");
    await box.trigger("keydown.enter");
    await flushPromises();

    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("does not navigate on every keystroke", async () => {
    // `q` lives in the URL like the other filters, so a link reproduces the view — but
    // eight characters used to mean eight `router.replace` calls, each re-running every
    // filter computed. The draft is local until the typing settles.
    vi.useFakeTimers();
    try {
      seedMixed();
      const wrapper = await mountAlerts();
      const box = wrapper.find("input[type='search']");

      await box.setValue("电");
      await box.setValue("电量");
      // The box shows what was typed straight away…
      expect((box.element as HTMLInputElement).value).toBe("电量");
      // …and the URL has not moved yet.
      expect(router.currentRoute.value.query.q).toBeUndefined();

      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();

      expect(router.currentRoute.value.query.q).toBe("电量");
      expect(wrapper.findAll("li")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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
      .find((button) => button.text().includes("确认当前筛选"));
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
      .find((button) => button.text().includes("确认当前筛选"))
      ?.trigger("click");
    __resetNotifications();
    await flushPromises();

    // The bulk button is gone, so there is nothing to click — and nothing to announce.
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("确认当前筛选")),
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

describe("what a row says without being read", () => {
  /**
   * Three visual encodings v1.0.0 had and the port reduced to a single badge. They are
   * asserted through `data-*` hooks rather than computed styles, because the scoped rules
   * key on exactly these attributes — an assertion on colour would pin the palette, which
   * is not the contract.
   */
  it("carries its severity on the whole row, not only in a badge", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    expect(
      wrapper.findAll("li").map((row) => row.attributes("data-severity")),
    ).toEqual(["critical", "warning", "notice"]);
    for (const row of wrapper.findAll("li")) {
      expect(row.classes()).toContain("alert-row");
    }
  });

  it("marks the rows belonging to the vehicle the map is on", async () => {
    // 告警 and the maps share one selection, so this says which rows belong to the
    // vehicle you were just looking at.
    seedMixed();
    store.selectDevice("agv-02");
    const wrapper = await mountAlerts();

    const focused = wrapper
      .findAll("li")
      .filter((row) => row.attributes("data-focused") === "true");
    expect(focused).toHaveLength(1);
    expect(focused[0]!.text()).toContain("B07 巡检车");
  });

  it("fades an acknowledged row instead of making it identical", async () => {
    // Revealed by 显示已确认, acknowledged and unacknowledged rows used to differ only in
    // one button's colour — so right after a bulk confirm you could not see which ones
    // you had just done.
    seedMixed();
    const wrapper = await mountAlerts("?acked=1");
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    const acked = wrapper
      .findAll("li")
      .filter((row) => row.attributes("data-acknowledged") === "true");
    expect(acked).toHaveLength(1);
  });

  it("names where the row came from", async () => {
    // `source` has been computed on every alert since 12A and read by nothing. It decides
    // whether the vehicle or the platform is the thing to go and look at.
    seedMixed();
    const wrapper = await mountAlerts();
    const rows = wrapper.findAll("li");

    expect(rows[0]!.text()).toContain("告警报码");
    expect(rows[1]!.text()).toContain("预警报码");
    expect(rows[2]!.text()).toContain("提示报码");
  });

  it("finds a row by its source, in either form", async () => {
    // The placeholder names 来源, and a placeholder promising a field the filter does not
    // search is its own small lie. Both forms are searched: the operator sees 规则引擎 on
    // the row, but a deployment reading logs knows it as `rule-engine`.
    seedMixed();
    const wrapper = await mountAlerts("?q=" + encodeURIComponent("预警报码"));
    expect(wrapper.findAll("li")).toHaveLength(1);

    const raw = await mountAlerts("?q=warning_code");
    expect(raw.findAll("li")).toHaveLength(1);
  });

  it("shows an unmapped source verbatim rather than hiding it", async () => {
    // A pre-normalized snapshot can carry any string (`fleetNormalize.ts:500`), so the
    // label map cannot be treated as exhaustive.
    store.ingestPayload(
      {
        fleetName: "示范车队",
        topicPattern: "/fleet/{deviceId}/vehicle_info",
        devices: [
          {
            deviceId: "agv-01",
            deviceName: "A01",
            online: true,
            alerts: [
              {
                id: "custom-1",
                severity: "warning",
                title: "自定义告警",
                source: "external-scada",
                ts: new Date().toISOString(),
              },
            ],
          },
        ],
      } as never,
      "api",
    );
    const wrapper = await mountAlerts();

    expect(wrapper.text()).toContain("external-scada");
  });
});

describe("acting on more than one row", () => {
  it("acknowledges the whole filtered set, not just the visible page", async () => {
    // The port had narrowed this to the page. `frontend-research.md:36` says
    // 「保持能力，补反馈与撤销」 for this control — the feedback and the undo arrived,
    // the capability shrank.
    seedMixed();
    const wrapper = await mountAlerts();
    const bulk = wrapper
      .findAll("button")
      .find((button) => button.text().includes("确认当前筛选"));

    expect(bulk?.text()).toContain("3");
  });

  it("respects the filter it says it respects", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?severity=critical");
    const bulk = wrapper
      .findAll("button")
      .find((button) => button.text().includes("确认当前筛选"));

    expect(bulk?.text()).toContain("1");
  });

  it("offers 清除已确认 with a count, and an undo", async () => {
    // The counterpart v1.0.0 had beside the bulk confirm. The admin page's 清除本地数据
    // is not an equivalent — it takes theme, sidebar, map mode and sound with it.
    seedMixed();
    const wrapper = await mountAlerts();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("确认当前筛选"))!
      .trigger("click");
    await flushPromises();
    __resetNotifications();

    const clear = wrapper
      .findAll("button")
      .find((button) => button.text().includes("清除已确认"));
    expect(clear?.text()).toContain("3");

    await clear!.trigger("click");
    await flushPromises();

    expect(wrapper.findAll("li")).toHaveLength(3);
    const toast = useNotifications().items.at(-1);
    expect(toast?.message).toContain("已取消确认 3 条");
    expect(toast?.action?.label).toBe("撤销");
  });

  it("counts the acknowledged alerts present, not every id ever stored", async () => {
    // The stored set keeps ids for alerts that have since cleared, so counting it drifts
    // upward forever — a page showing three rows could have reported 「已确认 12」.
    localStorage.setItem(
      ALERT_ACK_STORAGE_KEY,
      JSON.stringify(["long-gone-1", "long-gone-2", "long-gone-3"]),
    );
    __resetAlertAck();
    seedMixed();
    const wrapper = await mountAlerts();

    // Nothing present is acknowledged, so neither control appears.
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("清除已确认")),
    ).toBe(false);
    expect(wrapper.text()).not.toContain("显示已确认（");
  });

  it("puts the count in the 显示已确认 label, so the checkbox says what it would reveal", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("显示已确认（1）");
  });
});

describe("the acknowledgement store itself", () => {
  /**
   * `acknowledgedCount` and `clearAll` were deleted rather than wired up in 13T-C — both
   * operated on the whole *stored* set, which keeps ids for alerts that have since
   * cleared, so both reported and acted on more than any button could honestly claim.
   * The page counts and clears what is currently in the fleet instead; these cases assert
   * the store's surface through the operations that remain.
   */
  it("clears the ids it is given, and only those", async () => {
    seedMixed();
    const ack = (await import("@/composables/useAlertAck")).useAlertAck();
    const ids = alertIds();
    ack.acknowledgeMany(ids);
    ack.acknowledge("stale-alert-no-longer-in-fleet");

    const cleared = ack.unacknowledgeMany(ids);

    expect(cleared).toEqual(ids);
    expect(ids.every((id) => !ack.isAcknowledged(id))).toBe(true);
    // The id for an alert that has cleared is untouched — `clearAll` would have taken it.
    expect(ack.isAcknowledged("stale-alert-no-longer-in-fleet")).toBe(true);
  });

  it("ignores an empty id rather than storing one", async () => {
    const ack = (await import("@/composables/useAlertAck")).useAlertAck();
    ack.acknowledge("");
    ack.unacknowledge("");
    expect(ack.isAcknowledged("")).toBe(false);
  });

  it("reports only the ids a bulk call actually changed", async () => {
    // That set is what an undo has to reverse — undoing an id that was already
    // acknowledged before the bulk action would un-acknowledge someone else's work.
    const ack = (await import("@/composables/useAlertAck")).useAlertAck();
    ack.acknowledge("a");

    expect(ack.acknowledgeMany(["a", "b"])).toEqual(["b"]);
    // Symmetric, which is what lets 清除已确认 offer an undo of its own.
    expect(ack.unacknowledgeMany(["a", "never-acked"])).toEqual(["a"]);
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

    expect(ack.isAcknowledged("anything")).toBe(false);
  });
});
