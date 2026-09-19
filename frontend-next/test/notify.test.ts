import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { NotifyChannelView, NotifySendRecord } from "@navfleet/shared";
import NotifyView from "@/views/admin/NotifyView.vue";

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
});
