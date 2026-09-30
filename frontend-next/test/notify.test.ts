import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type {
  NotifyChannelConfig,
  NotifyChannelView,
  NotifySendRecord,
} from "@navfleet/shared";
import NotifyView from "@/views/admin/NotifyView.vue";
import { useAuth, __resetAuth } from "@/composables/useAuth";
import { __resetNotifications } from "@/composables/useNotifications";

/**
 * 外发 — the read-only outbound page (admin, Phase 16D-2b). It renders the effective channels
 * (from `getNotifyConfig`, secrets already redacted server-side) and a filterable send log (from
 * `getNotifyLog`). The role gate lives in the router/e2e; here we cover the two regions, the
 * honest empty state, the error state, and that filters reach the API.
 */
enableAutoUnmount(afterEach);

const CHANNEL: NotifyChannelView = {
  id: "ops-webhook",
  type: "webhook",
  enabled: true,
  severities: ["critical", "warning", "notice"],
  configured: true,
};

const RECORD: NotifySendRecord = {
  ts: "2026-09-19T02:00:00.000Z",
  eventKey: "agv-1:agv-1-offline",
  channelId: "ops-webhook",
  channelType: "webhook",
  deviceId: "agv-1",
  alertId: "agv-1-offline",
  severity: "critical",
  title: "设备离线",
  status: "failed",
  httpStatus: 503,
  attempts: 3,
  latencyMs: 42,
  error: "HTTP 503",
};

const routerFor = (): Router =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/admin/notify", component: NotifyView },
      { path: "/:rest(.*)*", component: { template: "<i />" } },
    ],
  });

const mountView = async (path = "/admin/notify") => {
  const router = routerFor();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(NotifyView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  vi.spyOn(fleetApi, "getNotifyConfig").mockResolvedValue({
    channels: [CHANNEL],
  });
  vi.spyOn(fleetApi, "getNotifyLog").mockResolvedValue({ items: [RECORD] });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetAuth();
  __resetNotifications();
});

describe("NotifyView", () => {
  it("renders the effective channels and the send log", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("ops-webhook");
    expect(wrapper.text()).toContain("已就绪");
    // A failed send row is shown with its error.
    expect(wrapper.text()).toContain("设备离线");
    expect(wrapper.text()).toContain("HTTP 503");
  });

  it("shows the honest empty-channels state (zero-config = no outbound)", async () => {
    vi.spyOn(fleetApi, "getNotifyConfig").mockResolvedValue({ channels: [] });
    vi.spyOn(fleetApi, "getNotifyLog").mockResolvedValue({ items: [] });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("未配置任何渠道");
  });

  it("reports an error when the log cannot be loaded", async () => {
    vi.spyOn(fleetApi, "getNotifyLog").mockRejectedValue(new Error("HTTP 500"));
    const wrapper = await mountView();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  it("reads the status filter from the URL and passes it to the API", async () => {
    const spy = vi
      .spyOn(fleetApi, "getNotifyLog")
      .mockResolvedValue({ items: [] });
    await mountView("/admin/notify?status=failed&deviceId=agv-1");
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", deviceId: "agv-1" }),
    );
  });

  it("auto-refreshes when the tab regains focus (no manual 刷新)", async () => {
    const spy = vi.spyOn(fleetApi, "getNotifyLog").mockResolvedValue({
      items: [RECORD],
    });
    await mountView();
    const before = spy.mock.calls.length;
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    window.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(spy.mock.calls.length).toBe(before + 1);
  });
});

// ── Channel editor (notify:write) ───────────────────────────────────────────────
/** Seed the auth singleton as a writer so the editor section renders. */
const asWriter = (): void => {
  const auth = useAuth();
  auth.state.status = "authenticated";
  auth.state.user = { username: "admin", role: "admin" };
  auth.state.capabilities = ["notify:read", "notify:write"];
};

const RAW_CHANNEL: NotifyChannelConfig = {
  id: "ops-webhook",
  type: "webhook",
  enabled: true,
  urlEnv: "NOTIFY_OPS_URL",
  severities: ["critical", "warning", "notice"],
  // Advanced fields the 精简 form does not surface — they must survive a save.
  digestSeconds: 300,
  escalation: { afterSeconds: 600, channelId: "sms" },
};

const textInputs = () =>
  [
    ...document.body.querySelectorAll("input[type='text']"),
  ] as HTMLInputElement[];
const submitBodyForm = async () => {
  document.body.querySelector("form")?.dispatchEvent(new Event("submit"));
  await flushPromises();
};

describe("NotifyView — channel editor", () => {
  it("hides the editor from callers without notify:write", async () => {
    const wrapper = await mountView(); // anonymous by default
    expect(wrapper.find('[aria-label="配置渠道"]').exists()).toBe(false);
  });

  it("shows the raw channels and env-readiness for a writer", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockResolvedValue({
      config: { channels: [RAW_CHANNEL] },
    });
    const wrapper = await mountView();
    const section = wrapper.find('[aria-label="配置渠道"]');
    expect(section.exists()).toBe(true);
    expect(section.text()).toContain("ops-webhook");
    expect(wrapper.find("button").exists()).toBe(true);
  });

  it("creates a channel and writes the whole file", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockResolvedValue({
      config: { channels: [] },
    });
    const put = vi
      .spyOn(fleetApi, "putNotifyConfig")
      .mockResolvedValue({ config: { channels: [] } });
    const wrapper = await mountView();

    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "新建渠道")!
      .trigger("click");
    await flushPromises();

    const [idInput, urlEnvInput] = textInputs();
    idInput!.value = "new-hook";
    idInput!.dispatchEvent(new Event("input"));
    urlEnvInput!.value = "NOTIFY_NEW_URL";
    urlEnvInput!.dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();

    expect(put).toHaveBeenCalledTimes(1);
    const config = put.mock.calls[0]![0];
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]).toMatchObject({
      id: "new-hook",
      type: "webhook",
      enabled: true,
      urlEnv: "NOTIFY_NEW_URL",
      severities: ["critical", "warning", "notice"],
    });
  });

  it("round-trips advanced fields when editing a channel", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockResolvedValue({
      config: { channels: [RAW_CHANNEL] },
    });
    const put = vi
      .spyOn(fleetApi, "putNotifyConfig")
      .mockResolvedValue({ config: { channels: [RAW_CHANNEL] } });
    const wrapper = await mountView();

    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "编辑")!
      .trigger("click");
    await flushPromises();
    // Flip 启用 off (the checkbox inside the dialog), then save.
    const enabledBox = document.body.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    );
    enabledBox!.checked = false;
    enabledBox!.dispatchEvent(new Event("change"));
    await flushPromises();
    await submitBodyForm();

    const config = put.mock.calls[0]![0];
    expect(config.channels).toHaveLength(1);
    // The form fields the editor surfaces reflect the edit…
    expect(config.channels[0]).toMatchObject({ id: "ops-webhook" });
    // …and the advanced fields it does not surface are carried through untouched.
    expect(config.channels[0]!.digestSeconds).toBe(300);
    expect(config.channels[0]!.escalation).toEqual({
      afterSeconds: 600,
      channelId: "sms",
    });
  });

  it("rejects a malformed silence window before writing", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockResolvedValue({
      config: { channels: [] },
    });
    const put = vi
      .spyOn(fleetApi, "putNotifyConfig")
      .mockResolvedValue({ config: { channels: [] } });
    const wrapper = await mountView();

    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "新建渠道")!
      .trigger("click");
    await flushPromises();
    textInputs()[0]!.value = "hook";
    textInputs()[0]!.dispatchEvent(new Event("input"));
    // Add a silence window, then give it an invalid time.
    [...document.body.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "添加窗口")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    const fromInput = textInputs().find((input) => input.value === "22:00");
    fromInput!.value = "9am";
    fromInput!.dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();

    expect(put).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("HH:MM");
  });

  it("deletes a channel by rewriting the file without it", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockResolvedValue({
      config: { channels: [RAW_CHANNEL] },
    });
    const put = vi
      .spyOn(fleetApi, "putNotifyConfig")
      .mockResolvedValue({ config: { channels: [] } });
    const wrapper = await mountView();

    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "删除")!
      .trigger("click");
    await flushPromises();
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    );
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0].channels).toEqual([]);
  });

  it("prefills and round-trips an email channel's recipients, groups and silence", async () => {
    asWriter();
    const emailChannel: NotifyChannelConfig = {
      id: "ops-mail",
      type: "email",
      enabled: true,
      urlEnv: "SMTP_URL",
      severities: ["critical"],
      recipients: [{ email: "a@x.com" }, { user: "bob" }],
      groups: ["oncall"],
      silenceWindows: [{ days: [1, 2], from: "22:00", to: "06:00" }],
      from: "alerts@fleet.local",
    };
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockResolvedValue({
      config: { channels: [emailChannel] },
    });
    const put = vi
      .spyOn(fleetApi, "putNotifyConfig")
      .mockResolvedValue({ config: { channels: [emailChannel] } });
    const wrapper = await mountView();

    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "编辑")!
      .trigger("click");
    await flushPromises();

    // The recipient textarea renders a user as @bob and an email verbatim.
    const textarea = document.body.querySelector("textarea")!;
    expect(textarea.value).toContain("a@x.com");
    expect(textarea.value).toContain("@bob");

    // Add 警告 to the subscribed severities, then save.
    [...document.body.querySelectorAll("label")]
      .find((label) => label.textContent?.trim().startsWith("警告"))
      ?.querySelector("input")
      ?.dispatchEvent(new Event("change"));
    await flushPromises();
    await submitBodyForm();

    const saved = put.mock.calls[0]![0].channels[0]!;
    expect(saved.recipients).toEqual([{ email: "a@x.com" }, { user: "bob" }]);
    expect(saved.groups).toEqual(["oncall"]);
    expect(saved.silenceWindows).toEqual([
      { days: [1, 2], from: "22:00", to: "06:00" },
    ]);
    // Advanced email `from` is round-tripped; severities now include the toggle.
    expect(saved.from).toBe("alerts@fleet.local");
    expect(saved.severities).toEqual(["critical", "warning"]);
  });

  it("adds then removes a silence window, returning to the empty state", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockResolvedValue({
      config: { channels: [] },
    });
    const wrapper = await mountView();
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "新建渠道")!
      .trigger("click");
    await flushPromises();

    const clickInBody = (label: string) =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === label)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

    clickInBody("添加窗口");
    await flushPromises();
    expect(textInputs().some((input) => input.value === "22:00")).toBe(true);
    clickInBody("移除");
    await flushPromises();
    expect(textInputs().some((input) => input.value === "22:00")).toBe(false);
  });

  it("maps a backend rejection to an inline message and does not close", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockResolvedValue({
      config: { channels: [] },
    });
    vi.spyOn(fleetApi, "putNotifyConfig").mockRejectedValue(
      new Error("invalid_notify"),
    );
    const wrapper = await mountView();
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "新建渠道")!
      .trigger("click");
    await flushPromises();
    textInputs()[0]!.value = "hook";
    textInputs()[0]!.dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();
    expect(document.body.textContent).toContain("配置校验未通过");
  });

  it("keeps the read page working when the raw config cannot be fetched", async () => {
    asWriter();
    vi.spyOn(fleetApi, "getNotifyConfigRaw").mockRejectedValue(
      new Error("HTTP 500"),
    );
    const wrapper = await mountView();
    // The editor section still renders (writer), with the honest empty state.
    expect(wrapper.find('[aria-label="配置渠道"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("还没配置渠道");
  });
});
