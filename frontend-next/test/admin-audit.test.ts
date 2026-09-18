import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi, type AuditRecord } from "@navfleet/fleet-core";
import AuditView from "@/views/admin/AuditView.vue";

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
    expect(wrapper.text()).toContain("没有符合条件的记录");
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

  it("passes the actor filter through to the backend on 查询", async () => {
    const wrapper = await mountView([entry()]);
    const spy = vi
      .spyOn(fleetApi, "getAuditLog")
      .mockResolvedValue({ entries: [entry()] });

    await wrapper.find("input[type=search]").setValue("root");
    const queryButton = wrapper
      .findAll("button")
      .find((b) => b.text() === "查询");
    await queryButton!.trigger("click");
    await flushPromises();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "root" }),
    );
  });

  it("paginates client-side past the page size", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry({ actor: `u${i}` }),
    );
    const wrapper = await mountView(many);
    expect(wrapper.text()).toContain("第 1 / 2 页");

    const next = wrapper.findAll("button").find((b) => b.text() === "下一页");
    await next!.trigger("click");
    expect(wrapper.text()).toContain("第 2 / 2 页");
  });
});
