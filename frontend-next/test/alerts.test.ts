import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi, ApiError } from "@navfleet/fleet-core";
import {
  capabilitiesForRole,
  type UserRole,
  type AlertDispositionPayload,
} from "@navfleet/shared";
import AlertsView from "@/views/AlertsView.vue";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";
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
 * The alert centre. Most of these cover the task-flow audit's list — the things that were
 * missing rather than wrong: filter state in the URL, a toggle that says it is one,
 * an empty state that is announced, and a row that reaches the vehicle.
 *
 * Acknowledgement is server-backed: `fleetApi.ack/unackAlert` are mocked,
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
/** Captured so an assertion reads the spy variable, not `fleetApi.ignoreAlert` unbound. */
let ackSpy: ReturnType<typeof vi.spyOn>;
let claimSpy: ReturnType<typeof vi.spyOn>;

/** A disposition payload for the action mocks; override per state. */
const payload = (
  over: Partial<AlertDispositionPayload> = {},
): AlertDispositionPayload => ({
  deviceId: "agv-01",
  alertId: "err-1",
  version: 1,
  disposition: "ignored",
  claimedBy: null,
  claimedAt: null,
  ignoredBy: "op",
  ignoredAt: "2026-01-01T00:00:00.000Z",
  ignoreReason: null,
  ...over,
});
const dispoPayload = (): AlertDispositionPayload => payload();
const investigatingPayload = (): AlertDispositionPayload =>
  payload({
    disposition: "investigating",
    claimedBy: "op",
    claimedAt: "2026-01-01T00:00:00.000Z",
    ignoredBy: null,
    ignoredAt: null,
  });
const unhandledPayload = (): AlertDispositionPayload =>
  payload({
    disposition: "unhandled",
    claimedBy: null,
    claimedAt: null,
    ignoredBy: null,
    ignoredAt: null,
  });

/** Click a segment of the 处置 filter by its visible label. The control is a `UiSegmented`
 *  (role="group", buttons carry aria-pressed), shared with 报表's 范围. */
const segment = (wrapper: AlertsWrapper, label: string) =>
  wrapper
    .get("[role='group'][aria-label='处置态筛选']")
    .findAll("button")
    .find((b) => b.text() === label)!;

/** Sign in so `canAck` is true (operator+) unless a test asks for another role. */
const signIn = (role: UserRole = "operator"): void => {
  const auth = useAuth();
  auth.state.status = "authenticated";
  auth.state.user = { username: "op", role };
  // Ack visibility is capability-based (1.6.1): seed the role's preset so operator/admin can ack.
  auth.state.capabilities = [...capabilitiesForRole(role)];
};

const mountAlerts = async (query = "") => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/alerts", component: AlertsView },
      // 消息史 is a sibling route now (1.6.2 IA): AlertsView reads live-vs-history off the path.
      { path: "/alerts/history", component: AlertsView },
      { path: "/devices/:deviceId", component: { template: "<i />" } },
    ],
  });
  await router.push(`/alerts${query}`);
  await router.isReady();

  const wrapper = mount(AlertsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

/** The bar now has two `UiMultiSelect`s (严重度 + 设备); pick one by its aria-label. */
type AlertsWrapper = Awaited<ReturnType<typeof mountAlerts>>;
const multiByLabel = (wrapper: AlertsWrapper, label: string) =>
  wrapper
    .findAllComponents(UiMultiSelect)
    .find((component) => component.props("ariaLabel") === label)!;
const deviceSelect = (wrapper: AlertsWrapper) =>
  multiByLabel(wrapper, "设备筛选");
const severitySelect = (wrapper: AlertsWrapper) =>
  multiByLabel(wrapper, "严重度筛选");

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
  // Disposition writes succeed by default; tests that need a failure/conflict re-mock.
  ackSpy = vi.spyOn(fleetApi, "ignoreAlert").mockResolvedValue(dispoPayload());
  vi.spyOn(fleetApi, "unignoreAlert").mockResolvedValue(unhandledPayload());
  claimSpy = vi
    .spyOn(fleetApi, "claimAlert")
    .mockResolvedValue(investigatingPayload());
  vi.spyOn(fleetApi, "releaseAlert").mockResolvedValue(unhandledPayload());
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
    expect(empty.find("[role='status']").text()).toContain("没有活跃消息");
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

    severitySelect(wrapper).vm.$emit("update:modelValue", ["critical"]);
    await flushPromises();

    expect(router.currentRoute.value.query.severity).toBe("critical");
    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("puts both lists back on their first page when a filter changes", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?page=3&hpage=4");
    severitySelect(wrapper).vm.$emit("update:modelValue", ["critical"]);
    await flushPromises();
    expect(router.currentRoute.value.query.page).toBeUndefined();
    expect(router.currentRoute.value.query.hpage).toBeUndefined();
  });

  it("keeps a clean URL for the default view", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?severity=critical");

    severitySelect(wrapper).vm.$emit("update:modelValue", []);
    await flushPromises();

    expect(router.currentRoute.value.query.severity).toBeUndefined();
  });

  it("reflects the active severities in the 严重度 control and narrows to them", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?severity=critical,warning");

    expect(severitySelect(wrapper).props("modelValue")).toEqual([
      "critical",
      "warning",
    ]);
    // critical + warning rows survive; the notice one does not.
    expect(wrapper.findAll("li")).toHaveLength(2);
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
  it("filters by the device multi-select", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    // Driven through the component's own contract rather than a DOM control: the filter is
    // a `UiMultiSelect` now (multi-device), and its panel lives in a portal jsdom cannot open
    // meaningfully. What this case owns is the *wiring* — that the view turns the chosen set
    // into the comma-joined `device` query param — and the component's own toggle/summary
    // behaviour is covered in ui-multi-select.
    deviceSelect(wrapper).vm.$emit("update:modelValue", ["agv-02"]);
    await flushPromises();

    expect(router.currentRoute.value.query.device).toBe("agv-02");
    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("joins several picked devices into one query key", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    deviceSelect(wrapper).vm.$emit("update:modelValue", ["agv-01", "agv-02"]);
    await flushPromises();

    expect(router.currentRoute.value.query.device).toBe("agv-01,agv-02");
    // Both vehicles' alerts survive the filter (critical + warning), nothing else.
    expect(wrapper.findAll("li")).toHaveLength(2);
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

    const select = deviceSelect(wrapper);
    const options = select.props("options");
    expect(options.map((option) => option.value)).toContain("agv-02");
    // The trigger summarises the still-selected device, so it does not look unset.
    expect(select.text()).toContain("B07 巡检车");
  });

  it("narrows the device options to match the other filters (faceted)", async () => {
    // agv-01 critical, agv-02 warning, agv-03 notice. Under 严重度=预警 only the warning
    // vehicle has a matching alert, so the device dropdown offers just that one.
    seedMixed();
    const wrapper = await mountAlerts("?severity=warning");

    const options = deviceSelect(wrapper).props("options");
    expect(options.map((option) => option.value)).toEqual(["agv-02"]);
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

  it("filters by the 处置 segment, writing it to the URL", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    // Ignore the first row; under 全部 all three stay visible.
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(3);

    await segment(wrapper, "待处理").trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.query.handling).toBe("unhandled");
    expect(wrapper.findAll("li")).toHaveLength(2);
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
    expect(wrapper.findAll("li")).toHaveLength(10);

    const next = wrapper.findAll("button").find((b) => b.text() === "下一页");
    await next?.trigger("click");
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(10);
    expect(wrapper.text()).toContain("第 2 / 3 页");

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
    expect(wrapper.findAll("li")).toHaveLength(10);

    deviceSelect(wrapper).vm.$emit("update:modelValue", ["agv-01"]);
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

describe("handling (server-backed)", () => {
  it("ignores a row through its 忽略 button and writes through to the backend", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    const row = wrapper.findAll("li")[0]!;
    // An unhandled row offers 我来处理 + 忽略; the ignore button is last.
    const ignore = row.findAll("button").at(-1)!;
    expect(ignore.text()).toContain("忽略");

    const ref = criticalRef();
    await ignore.trigger("click");
    await flushPromises();

    expect(ackSpy).toHaveBeenCalledWith(
      ref.deviceId,
      ref.id,
      undefined,
      undefined,
    );
    // The row now reads 已忽略 and offers 取消忽略.
    const after = wrapper.findAll("li")[0]!;
    expect(after.text()).toContain("已忽略");
    expect(after.findAll("button").at(-1)!.text()).toContain("取消忽略");
  });

  it("claims a row through its 我来处理 button and shows 处理中", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    const claim = wrapper.findAll("li")[0]!.findAll("button")[0]!;
    expect(claim.text()).toContain("我来处理");

    const ref = criticalRef();
    await claim.trigger("click");
    await flushPromises();

    expect(claimSpy).toHaveBeenCalledWith(ref.deviceId, ref.id, undefined);
    const row = wrapper.findAll("li")[0]!;
    expect(row.text()).toContain("处理中");
    expect(row.attributes("data-disposition")).toBe("investigating");
  });

  it("toasts with an undo when a single row is ignored", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    const toast = useNotifications().items.at(-1);
    expect(toast?.message).toContain("已忽略 1 条消息");
    expect(toast?.action?.label).toBe("撤销");
  });

  it("the 待处理 segment hides an ignored row; 已忽略 shows only it", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    expect(wrapper.findAll("li")).toHaveLength(3);

    // Ignore the first row — it stays visible (faded) under 全部.
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(3);

    await segment(wrapper, "待处理").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(2);

    await segment(wrapper, "已忽略").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("li")).toHaveLength(1);
  });

  it("shows who handled a row", async () => {
    // The whole point of moving off localStorage: the name is the same on every console.
    seedMixed();
    const wrapper = await mountAlerts();
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    expect(wrapper.findAll("li")[0]!.text()).toContain("已忽略 · op");
  });

  it("rolls the row back and warns when the write fails", async () => {
    vi.spyOn(fleetApi, "ignoreAlert").mockRejectedValue(new Error("forbidden"));
    seedMixed();
    const wrapper = await mountAlerts();
    const row = wrapper.findAll("li")[0]!;

    await row.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    // Back to 待处理 (the optimistic ignore was rolled back) and a permission toast.
    expect(wrapper.findAll("li")[0]!.attributes("data-disposition")).toBe(
      "unhandled",
    );
    expect(useNotifications().items.at(-1)?.message).toContain("权限");
  });

  it("reflects a disposition made on another console", async () => {
    // A cross-console `alert.disposition` lands in the store overlay; the open view follows.
    seedMixed();
    const wrapper = await mountAlerts();
    const ref = criticalRef();

    store.applyDisposition(`${ref.deviceId}:${ref.id}`, {
      claimedBy: null,
      claimedAt: null,
      ignoredBy: "someone-else",
      ignoredAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    });
    await flushPromises();

    const row = wrapper
      .findAll("li")
      .find((li) => li.attributes("data-disposition") === "ignored");
    expect(row?.text()).toContain("已忽略 · someone-else");
  });

  it("surfaces a claim conflict as a toast naming who holds it", async () => {
    seedMixed();
    const conflict = Object.assign(new ApiError("already_claimed", 409), {
      data: {
        current: {
          deviceId: criticalRef().deviceId,
          alertId: criticalRef().id,
          version: 2,
          disposition: "investigating",
          claimedBy: "zhaoyun",
          claimedAt: "2026-01-01T00:00:00.000Z",
          ignoredBy: null,
          ignoredAt: null,
          ignoreReason: null,
        },
      },
    });
    vi.spyOn(fleetApi, "claimAlert").mockRejectedValue(conflict);
    const wrapper = await mountAlerts();

    await wrapper.findAll("li")[0]!.findAll("button")[0]!.trigger("click");
    await flushPromises();

    const toast = useNotifications().items.at(-1);
    expect(toast?.type).toBe("warning");
    expect(toast?.message).toContain("zhaoyun");
    // The overlay reconciles to the backend's holder.
    expect(wrapper.findAll("li")[0]!.text()).toContain("处理中 · zhaoyun");
  });

  it("offers an undo after a bulk ignore, and the undo works", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    const bulk = wrapper
      .findAll("button")
      .find((button) => button.text().includes("忽略当前筛选"));
    await bulk?.trigger("click");
    await flushPromises();

    // All three are now ignored (faded), still shown under 全部.
    expect(
      wrapper
        .findAll("li")
        .every((li) => li.attributes("data-disposition") === "ignored"),
    ).toBe(true);
    const toast = useNotifications().items.at(-1);
    expect(toast?.message).toContain("已忽略 3 条");
    expect(toast?.action?.label).toBe("撤销");

    toast!.action!.handler();
    await flushPromises();
    expect(
      wrapper
        .findAll("li")
        .every((li) => li.attributes("data-disposition") === "unhandled"),
    ).toBe(true);
  });

  it("collapses a whole-batch ignore failure into a single error toast", async () => {
    // A bulk ignore fans out with `Promise.all`; if the backend is down, every ref fails.
    seedMixed();
    const ignoreAlert = vi
      .spyOn(fleetApi, "ignoreAlert")
      .mockRejectedValue(new Error("HTTP 503"));
    const wrapper = await mountAlerts();

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("忽略当前筛选"))
      ?.trigger("click");
    await flushPromises();

    expect(ignoreAlert.mock.calls.length).toBeGreaterThan(1);
    const errors = useNotifications().items.filter(
      (item) => item.type === "error",
    );
    expect(errors).toHaveLength(1);
  });

  it("hides every handling control from a viewer", async () => {
    __resetAuth();
    signIn("viewer");
    seedMixed();
    const wrapper = await mountAlerts();

    const rowButtons = wrapper.findAll("li")[0]!.findAll("button");
    expect(rowButtons).toHaveLength(0);
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("忽略当前筛选")),
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

  it("fades an ignored row instead of making it identical", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    const ignored = wrapper
      .findAll("li")
      .filter((row) => row.attributes("data-disposition") === "ignored");
    expect(ignored).toHaveLength(1);
  });

  it("names where the row came from", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    const rows = wrapper.findAll("li");

    // The title names the channel; the source says the vehicle reported it, once, not the
    // channel a second time.
    for (const row of rows.slice(0, 3)) {
      expect(row.text()).toContain("车端报码");
    }
    expect(rows[0]!.text().match(/告警报码/g)).toHaveLength(1);
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
  it("ignores the whole filtered set, not just the visible page", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    const bulk = wrapper
      .findAll("button")
      .find((button) => button.text().includes("忽略当前筛选"));

    expect(bulk?.text()).toContain("3");
  });

  it("respects the filter it says it respects", async () => {
    seedMixed();
    const wrapper = await mountAlerts("?severity=critical");
    const bulk = wrapper
      .findAll("button")
      .find((button) => button.text().includes("忽略当前筛选"));

    expect(bulk?.text()).toContain("1");
  });

  it("offers 取消忽略 with a count, and an undo", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("忽略当前筛选"))!
      .trigger("click");
    await flushPromises();
    __resetNotifications();

    const clear = wrapper
      .findAll("button")
      .find((button) => button.text().includes("取消忽略"));
    expect(clear?.text()).toContain("3");

    await clear!.trigger("click");
    await flushPromises();

    expect(
      wrapper
        .findAll("li")
        .every((li) => li.attributes("data-disposition") === "unhandled"),
    ).toBe(true);
    const toast = useNotifications().items.at(-1);
    expect(toast?.message).toContain("已取消忽略 3 条");
    expect(toast?.action?.label).toBe("撤销");
  });

  it("counts the ignored alerts present, not a stale overlay", async () => {
    seedMixed();
    const wrapper = await mountAlerts();

    // Nothing present is ignored yet, so the 取消忽略 control does not appear.
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("取消忽略")),
    ).toBe(false);
  });

  it("shows the 取消忽略 count once rows are ignored", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    await wrapper.findAll("li")[0]!.findAll("button").at(-1)!.trigger("click");
    await flushPromises();

    const clear = wrapper
      .findAll("button")
      .find((button) => button.text().includes("取消忽略"));
    expect(clear?.text()).toContain("1");
  });
});

describe("selecting rows to ignore (忽略选中)", () => {
  const selectBoxes = (wrapper: AlertsWrapper) =>
    wrapper
      .findAll("input[type='checkbox']")
      .filter((box) => box.attributes("aria-label")?.startsWith("选择消息"));

  it("ignores only the rows ticked via their checkbox, then clears the selection", async () => {
    seedMixed();
    const wrapper = await mountAlerts();
    const ref = criticalRef(); // worst-first, so the first row is the critical one

    await selectBoxes(wrapper)[0]!.setValue(true);
    await flushPromises();

    const confirm = wrapper
      .findAll("button")
      .find((button) => button.text().includes("忽略选中"));
    expect(confirm?.text()).toContain("1");

    await confirm!.trigger("click");
    await flushPromises();

    // Exactly the ticked occurrence was written, and the button is gone (selection cleared).
    expect(ackSpy).toHaveBeenCalledWith(ref.deviceId, ref.id);
    expect(
      wrapper.findAll("button").some((b) => b.text().includes("忽略选中")),
    ).toBe(false);
  });

  it("shows no select checkbox to a viewer", async () => {
    __resetAuth();
    signIn("viewer");
    seedMixed();
    const wrapper = await mountAlerts();
    expect(selectBoxes(wrapper)).toHaveLength(0);
  });
});

describe("the 消息史 tab", () => {
  it("shows the history panel on the /alerts/history route and hides the live-only controls", async () => {
    const spy = vi
      .spyOn(fleetApi, "getAlerts")
      .mockResolvedValue({ items: [] });
    const wrapper = await mountAlerts();

    // Live tab: the live-only 处置 segmented filter is present.
    expect(wrapper.text()).toContain("处置");

    // The tab is the route now (no toggle button): navigating to /alerts/history folds in the
    // cleared-alert history and drops the live-only control.
    await router.push("/alerts/history");
    await flushPromises();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cleared", limit: 10000 }),
    );
    expect(wrapper.text()).toContain("暂无已清除");
    expect(wrapper.text()).not.toContain("处置");

    await router.push("/alerts");
    await flushPromises();
    expect(wrapper.text()).toContain("处置");
  });

  it("在消息史默认把最近 10 天窗口回填到起止输入，而不是留空", async () => {
    vi.spyOn(fleetApi, "getAlerts").mockResolvedValue({ items: [] });
    const wrapper = await mountAlerts();
    await router.push("/alerts/history");
    await flushPromises();

    const dates = wrapper.findAll('input[type="date"]');
    expect(dates).toHaveLength(2);
    const from = (dates[0]!.element as HTMLInputElement).value;
    const to = (dates[1]!.element as HTMLInputElement).value;
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The default window the panel actually queries: the last ~10 days.
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(9);
    expect(days).toBeLessThanOrEqual(11);
  });
});

describe("useAlertAck — the bulk ignore + legacy migration layer", () => {
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
    await ack.acknowledgeMany([critical]);

    const changed = await ack.acknowledgeMany([critical, warning]);
    // The already-ignored critical is not re-reported; only the warning changed.
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
