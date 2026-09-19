import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { UserRole } from "@navfleet/shared";
import AlertsView from "@/views/AlertsView.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import NotificationHost from "@/components/NotificationHost.vue";
import { useFleetStore } from "@/stores/fleet";
import { useAuth, __resetAuth } from "@/composables/useAuth";
import {
  ALERT_ACK_STORAGE_KEY,
  useAlertAck,
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
 *
 * Acknowledgement is server-backed since Phase 16A: `fleetApi.ack/unackAlert` are mocked,
 * the confirm control is operator+ only, and the overlay the view reads lives in the fleet
 * store (seeded from the backend, kept live by WS). These tests sign in as `operator` by
 * default so the control is present; the viewer case has its own test.
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
/** Captured so an assertion reads the spy variable, not `fleetApi.ackAlert` unbound. */
let ackSpy: ReturnType<typeof vi.spyOn>;

/** Sign in so `canAck` is true (operator+) unless a test asks for another role. */
const signIn = (role: UserRole = "operator"): void => {
  const auth = useAuth();
  auth.state.status = "authenticated";
  auth.state.user = { username: "op", role };
};

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

/** The critical alert's (deviceId, id) — the row the ack tests act on. */
const criticalRef = (): { deviceId: string; id: string } => {
  const alert = store.groupedAlerts.critical[0]!;
  return { deviceId: alert.deviceId, id: alert.id };
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  __resetAlertAck();
  __resetAuth();
  __resetNotifications();
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  // AlertsView seeds the ack overlay from this on mount; default it empty. Tests that care
  // about a pre-existing ack drive the store overlay directly instead.
  vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({ items: [] });
  // Acknowledgement writes succeed by default; tests that need a failure re-mock.
  ackSpy = vi.spyOn(fleetApi, "ackAlert").mockResolvedValue();
  vi.spyOn(fleetApi, "unackAlert").mockResolvedValue();
  store = useFleetStore();
  signIn();
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

  it("no longer warns that acknowledgement is browser-only", async () => {
    // The limitation the page used to state out loud is gone: acknowledgement is
    // server-backed now, so the sentence would be a lie.
    seedMixed();
    const wrapper = await mountAlerts();
    expect(wrapper.text()).not.toContain("只保存在本浏览器");
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

    // Driven through the component's own contract rather than a DOM `<select>`: the
    // filter is a `UiSelect` now, and its list lives in a portal that jsdom cannot open
    // meaningfully. What this case owns is the *wiring* — that the view turns a chosen
    // value into a query param — and `UiSelect`'s own mapping is covered in ui-select.
    wrapper.findComponent(UiSelect).vm.$emit("update:modelValue", "agv-02");
    await flushPromises();

    expect(router.currentRoute.value.query.device).toBe("agv-02");
    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("keeps the filtered vehicle selectable after its alert clears", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?device=agv-02");
    expect(wrapper.findAll("li")).toHaveLength(1);

    // Same device, no warning any more — so it contributes no alert to the option list.
    store.ingestPayload(
      {
        fleetName: "示范车队",
        topicPattern: "/fleet/{deviceId}/vehicle_info",
        devices: [
          device({ error_code: code(5102, "路径规划超时") }),
          device({ deviceId: "agv-02", deviceName: "B07 巡检车" }),
        ],
      },
      "api",
    );
    await flushPromises();

    const select = wrapper.findComponent(UiSelect);
    const options = select.props("options");
    expect(options.map((option) => option.value)).toContain("agv-02");
    expect(select.text()).toContain("B07 巡检车");
  });

  it("filters by the search box, committing on Enter", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    const box = wrapper.find("input[type='search']");

    await box.setValue("电量");
    await box.trigger("keydown.enter");
    await flushPromises();

    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("does not navigate on every keystroke", async () => {
    vi.useFakeTimers();
    try {
      seedMixed();
      const wrapper = await mountAlerts();
      const box = wrapper.find("input[type='search']");

      await box.setValue("电");
      await box.setValue("电量");
      expect((box.element as HTMLInputElement).value).toBe("电量");
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

    wrapper.findComponent(UiSelect).vm.$emit("update:modelValue", "agv-01");
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

describe("acknowledging (server-backed, Phase 16A)", () => {
  it("is a toggle that says so, and writes through to the backend", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?acked=1");
    const button = wrapper.findAll("li")[0]!.findAll("button").at(-1)!;

    expect(button.attributes("aria-pressed")).toBe("false");
    expect(button.attributes("aria-label")).toContain("确认告警");

    const ref = criticalRef();
    await button.trigger("click");
    await flushPromises();

    expect(ackSpy).toHaveBeenCalledWith(ref.deviceId, ref.id);
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

  it("shows who confirmed a row", async () => {
    // The whole point of moving off localStorage: the name is the same on every console.
    seedMixed();
    const wrapper = await mountAlerts("?acked=1");
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    expect(wrapper.findAll("li")[0]!.text()).toContain("已确认 · op");
  });

  it("rolls the row back and warns when the write fails", async () => {
    vi.spyOn(fleetApi, "ackAlert").mockRejectedValue(new Error("forbidden"));
    seedMixed();
    const wrapper = await mountAlerts("?acked=1");
    const button = wrapper.findAll("li")[0]!.findAll("button").at(-1)!;

    await button.trigger("click");
    await flushPromises();

    expect(
      wrapper
        .findAll("li")[0]!
        .findAll("button")
        .at(-1)!
        .attributes("aria-pressed"),
    ).toBe("false");
    expect(useNotifications().items.at(-1)?.message).toContain("权限");
  });

  it("reflects an acknowledgement made on another console", async () => {
    // A cross-console `alert.acked` lands in the store overlay; the open view must follow
    // without a reload — that is what the WS branch buys.
    seedMixed();
    const wrapper = await mountAlerts("?acked=1");
    const ref = criticalRef();

    store.applyAck(`${ref.deviceId}:${ref.id}`, {
      ackedBy: "someone-else",
      ackedAt: "2026-01-01T00:00:00.000Z",
      comment: null,
    });
    await flushPromises();

    const row = wrapper
      .findAll("li")
      .find((li) => li.attributes("data-acknowledged") === "true");
    expect(row?.text()).toContain("已确认 · someone-else");
  });

  it("offers an undo after a bulk acknowledgement, and the undo works", async () => {
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
    await flushPromises();
    __resetNotifications();
    await flushPromises();

    expect(
      wrapper.findAll("button").some((b) => b.text().includes("确认当前筛选")),
    ).toBe(false);
    expect(useNotifications().items).toEqual([]);
  });

  it("hides every confirm control from a viewer", async () => {
    // Acknowledging is the first operator-only capability; a viewer reads the list but
    // cannot confirm. The backend enforces it too — this is the UI half.
    __resetAuth();
    signIn("viewer");
    seedMixed();
    const wrapper = await mountAlerts("?acked=1");

    const rowButtons = wrapper.findAll("li")[0]!.findAll("button");
    expect(rowButtons).toHaveLength(0);
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("确认当前筛选")),
    ).toBe(false);
  });
});

describe("the toast's undo button", () => {
  it("runs the action and dismisses itself", async () => {
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

  it("does not ring the rows of whatever vehicle the store happens to have selected", async () => {
    seedMixed();
    store.selectDevice("agv-02");
    const wrapper = await mountAlerts();

    expect(wrapper.text()).toContain("B07 巡检车");
    expect(
      wrapper.findAll("li").filter((row) => row.attributes("data-focused")),
    ).toHaveLength(0);
  });

  it("fades an acknowledged row instead of making it identical", async () => {
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
    seedMixed();
    const wrapper = await mountAlerts();
    const rows = wrapper.findAll("li");

    expect(rows[0]!.text()).toContain("告警报码");
    expect(rows[1]!.text()).toContain("预警报码");
    expect(rows[2]!.text()).toContain("提示报码");
  });

  it("finds a row by its source, in either form", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?q=" + encodeURIComponent("预警报码"));
    expect(wrapper.findAll("li")).toHaveLength(1);

    const raw = await mountAlerts("?q=warning_code");
    expect(raw.findAll("li")).toHaveLength(1);
  });

  it("shows an unmapped source verbatim rather than hiding it", async () => {
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
      },
      "api",
    );
    const wrapper = await mountAlerts();

    expect(wrapper.text()).toContain("external-scada");
  });
});

describe("acting on more than one row", () => {
  it("acknowledges the whole filtered set, not just the visible page", async () => {
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

  it("offers 清除已经确认 with a count, and an undo", async () => {
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
      .find((button) => button.text().includes("清除已经确认"));
    expect(clear?.text()).toContain("3");

    await clear!.trigger("click");
    await flushPromises();

    expect(wrapper.findAll("li")).toHaveLength(3);
    const toast = useNotifications().items.at(-1);
    expect(toast?.message).toContain("已取消确认 3 条");
    expect(toast?.action?.label).toBe("撤销");
  });

  it("counts the acknowledged alerts present, not a stale overlay", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    // Nothing present is acknowledged yet, so neither control appears.
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("清除已经确认")),
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

describe("the 告警史 tab", () => {
  it("toggles to 告警史 and back through the bar button, folding the history in", async () => {
    const spy = vi
      .spyOn(fleetApi, "getAlerts")
      .mockResolvedValue({ items: [] });
    const wrapper = await mountAlerts();
    const toggle = () =>
      wrapper
        .findAll("button")
        .find((b) => b.text() === "告警史" || b.text() === "消息页");

    // Live tab: the toggle offers 告警史 and the live-only 显示已确认 control is present.
    expect(toggle()?.text()).toBe("告警史");
    expect(wrapper.text()).toContain("显示已确认");

    await toggle()!.trigger("click");
    await flushPromises();

    // History tab: the panel fetched cleared alerts, the URL carries the tab, the toggle
    // now returns to 消息页, and 显示已确认 is gone.
    expect(spy).toHaveBeenCalledWith({ status: "cleared" });
    expect(wrapper.vm.$route.query.view).toBe("history");
    expect(toggle()?.text()).toBe("消息页");
    expect(wrapper.text()).toContain("暂无已清除");
    expect(wrapper.text()).not.toContain("显示已确认");

    await toggle()!.trigger("click");
    await flushPromises();
    expect(wrapper.vm.$route.query.view).toBeUndefined();
    expect(toggle()?.text()).toBe("告警史");
  });
});

describe("useAlertAck — the action layer", () => {
  it("acknowledges through the API and updates the overlay optimistically", async () => {
    seedMixed();
    const ack = useAlertAck();
    const ref = criticalRef();

    const ok = await ack.acknowledge(ref.deviceId, ref.id, "看到了");
    expect(ok).toBe(true);
    expect(ackSpy).toHaveBeenCalledWith(ref.deviceId, ref.id, "看到了");
    expect(ack.isAcknowledged(ref.deviceId, ref.id)).toBe(true);
    expect(ack.acknowledgedBy(ref.deviceId, ref.id)).toBe("op");
  });

  it("rolls back and reports when the write is refused", async () => {
    vi.spyOn(fleetApi, "unackAlert").mockRejectedValue(new Error("not_found"));
    seedMixed();
    const ack = useAlertAck();
    const ref = criticalRef();
    // Put it in the acked state first (its own call succeeds by default mock).
    await ack.acknowledge(ref.deviceId, ref.id);

    const ok = await ack.unacknowledge(ref.deviceId, ref.id);
    expect(ok).toBe(false);
    // The optimistic removal was undone, so it is acknowledged again.
    expect(ack.isAcknowledged(ref.deviceId, ref.id)).toBe(true);
    expect(useNotifications().items.at(-1)?.message).toContain("活跃");
  });

  it("reports only the refs a bulk call actually changed", async () => {
    seedMixed();
    const ack = useAlertAck();
    const [critical, warning] = [
      criticalRef(),
      {
        deviceId: store.groupedAlerts.warning[0]!.deviceId,
        id: store.groupedAlerts.warning[0]!.id,
      },
    ];
    await ack.acknowledge(critical.deviceId, critical.id);

    const changed = await ack.acknowledgeMany([critical, warning]);
    // The already-acked critical is not re-reported; only the warning changed.
    expect(changed).toEqual([warning]);
  });

  it("migrates still-active localStorage acks, then drops the key", async () => {
    seedMixed();
    const ref = criticalRef();
    localStorage.setItem(
      ALERT_ACK_STORAGE_KEY,
      JSON.stringify([ref.id, "long-gone"]),
    );
    // The migration only runs where the caller can actually confirm (apiReady + operator).
    store.state.realtime.apiReady = true;
    const ack = useAlertAck();

    await ack.migrateLegacyAcks([ref]);
    await flushPromises();

    expect(ackSpy).toHaveBeenCalledWith(ref.deviceId, ref.id);
    // The cleared "long-gone" id was not active, so it was dropped, not pushed.
    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ALERT_ACK_STORAGE_KEY)).toBeNull();
  });

  it("clears the legacy key even when there is nothing to migrate", async () => {
    localStorage.setItem(ALERT_ACK_STORAGE_KEY, JSON.stringify([]));
    const ack = useAlertAck();

    await ack.migrateLegacyAcks([]);

    expect(localStorage.getItem(ALERT_ACK_STORAGE_KEY)).toBeNull();
  });
});
