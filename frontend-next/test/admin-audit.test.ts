import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi, type AuditRecord } from "@navfleet/fleet-core";
import AuditView from "@/views/admin/AuditView.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";

/**
 * 审计 — the audit log page. Filters are server-side (assert the params reach `getAuditLog`),
 * pagination is client-side (assert a second page appears past the page size).
 */
enableAutoUnmount(afterEach);

const routerFor = (): Router =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/admin/audit", component: AuditView as never },
      { path: "/:rest(.*)*", component: { template: "<i />" } },
    ],
  });

const entry = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  ts: "2026-01-01T00:00:00.000Z",
  actor: "root",
  action: "login",
  outcome: "success",
  ...over,
});

const mountView = async (entries: AuditRecord[]) => {
  vi.spyOn(fleetApi, "getAuditLog").mockResolvedValue({ entries });
  const router = routerFor();
  await router.push("/admin/audit");
  await router.isReady();
  const wrapper = mount(AuditView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuditView", () => {
  it("renders entries with Chinese action labels and a failure marker", async () => {
    const wrapper = await mountView([
      entry({ actor: "alice", action: "user_create", target: "bob" }),
      entry({ actor: "mallory", action: "login_failed", outcome: "failure" }),
    ]);
    expect(wrapper.text()).toContain("创建用户");
    expect(wrapper.text()).toContain("登录失败");
    expect(wrapper.text()).toContain("失败");
    expect(wrapper.text()).toContain("bob");
  });

  it("shows the empty state when there are no records", async () => {
    const wrapper = await mountView([]);
    expect(wrapper.text()).toContain("没有符合当前筛选条件的记录");
  });

  it("auto-refreshes when the tab regains focus (no manual 刷新)", async () => {
    const spy = vi
      .spyOn(fleetApi, "getAuditLog")
      .mockResolvedValue({ entries: [entry()] });
    const router = routerFor();
    await router.push("/admin/audit");
    await router.isReady();
    mount(AuditView, { global: { plugins: [router] } });
    await flushPromises();
    const before = spy.mock.calls.length;
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    window.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(spy.mock.calls.length).toBe(before + 1);
  });

  it("shows an error state when the request fails", async () => {
    vi.spyOn(fleetApi, "getAuditLog").mockRejectedValue(new Error("HTTP 503"));
    const router = routerFor();
    await router.push("/admin/audit");
    await router.isReady();
    const wrapper = mount(AuditView, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.text()).toContain("无法加载审计日志");
  });

  it("re-queries the backend as the actor filter changes (debounced, no 查询 button)", async () => {
    const wrapper = await mountView([entry()]);
    const spy = vi
      .spyOn(fleetApi, "getAuditLog")
      .mockResolvedValue({ entries: [entry()] });

    expect(wrapper.findAll("button").some((b) => b.text() === "查询")).toBe(
      false,
    );
    await wrapper.find("input[type=search]").setValue("root");
    // The free-text filter is debounced (~300ms); wait past it, then let the fetch resolve.
    await new Promise((resolve) => setTimeout(resolve, 320));
    await flushPromises();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "root" }),
    );
  });

  it("sends the picked actions as one comma-joined key, and mirrors it to the URL", async () => {
    const wrapper = await mountView([entry()]);
    const spy = vi
      .spyOn(fleetApi, "getAuditLog")
      .mockResolvedValue({ entries: [entry()] });

    // The 动作 filter is a multi-select now; emitting its set should query with the actions
    // comma-joined — the single `action` key the backend parses back into a list.
    wrapper
      .findComponent(UiMultiSelect)
      .vm.$emit("update:modelValue", ["user_create", "user_delete"]);
    await flushPromises();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_create,user_delete" }),
    );
  });

  it("constrains 起/止 so an inverted range cannot be picked", async () => {
    const wrapper = await mountView([entry()]);
    const dates = wrapper.findAll("input[type=date]");
    const from = dates[0]!;
    const to = dates[1]!;
    await from.setValue("2026-03-05");
    await to.setValue("2026-03-10");
    // 止 cannot go before the chosen 起, and 起 cannot go past the chosen 止.
    expect(to.attributes("min")).toBe("2026-03-05");
    expect(from.attributes("max")).toBe("2026-03-10");
  });

  it("paginates client-side past the page size", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry({ actor: `u${i}` }),
    );
    const wrapper = await mountView(many);
    expect(wrapper.text()).toContain("第 1 / 3 页");

    const next = wrapper.findAll("button").find((b) => b.text() === "下一页");
    await next!.trigger("click");
    expect(wrapper.text()).toContain("第 2 / 3 页");
  });

  it("re-paginates when the per-page dropdown changes and returns to page 1", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry({ actor: `u${i}` }),
    );
    const wrapper = await mountView(many);
    expect(wrapper.text()).toContain("第 1 / 3 页"); // default 10/page

    const sizeSelect = wrapper
      .findAllComponents(UiSelect)
      .find((component) => component.props("ariaLabel") === "每页条数");
    expect(sizeSelect).toBeTruthy();

    sizeSelect!.vm.$emit("update:modelValue", "50");
    await flushPromises();
    // 25 rows on one page of 50: the pager stays (jump) but 下一页 is disabled.
    const next = wrapper.findAll("button").find((b) => b.text() === "下一页");
    expect(next?.attributes("disabled")).toBeDefined();
  });
});
