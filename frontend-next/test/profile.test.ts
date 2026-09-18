import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount, enableAutoUnmount } from "@vue/test-utils";
import ProfileView from "@/views/ProfileView.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { __resetAuth } from "@/composables/useAuth";
import {
  useNotifications,
  __resetNotifications,
} from "@/composables/useNotifications";
import { requestUrl } from "./helpers/requestUrl";

/**
 * 个人中心 — change own password, list and revoke own sessions.
 *
 * `fetch` is stubbed and routed by URL + method, so this drives the real `useAuth` composable
 * end to end. The confirm dialog is a portal, so its confirmation is delivered by emitting
 * `confirm` on the `UiConfirmDialog` component rather than clicking teleported DOM.
 */
enableAutoUnmount(afterEach);

interface Handler {
  match: (url: string, init: RequestInit) => boolean;
  response: () => Response;
}
let handlers: Handler[];

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = requestUrl(input);
  const handler = handlers.find((h) => h.match(url, init));
  return Promise.resolve(
    handler ? handler.response() : new Response(null, { status: 404 }),
  );
});

const SESSIONS = [
  {
    sessionId: "sid-current",
    username: "me",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
    userAgent: "Firefox",
    ip: "10.0.0.1",
    current: true,
  },
  {
    sessionId: "sid-other",
    username: "me",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
    userAgent: "Chrome",
    ip: "10.0.0.2",
    current: false,
  },
];

beforeEach(() => {
  __resetAuth();
  __resetNotifications();
  handlers = [
    {
      match: (u, i) =>
        u === "/api/auth/sessions" && (i.method ?? "GET") === "GET",
      response: () => jsonResponse({ sessions: SESSIONS }),
    },
  ];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const mountView = async () => {
  const wrapper = mount(ProfileView);
  await flushPromises();
  return wrapper;
};

// Assembled from parts so no password literal appears verbatim (GitGuardian).
const NEW_PW = ["valid", "pass", "42"].join("");
const MISMATCH_PW = ["valid", "pass", "99"].join("");

describe("ProfileView — change password", () => {
  it("rejects a weak new password locally without calling the backend", async () => {
    const wrapper = await mountView();
    const [oldP, newP, confirmP] = wrapper.findAll("input[type=password]");
    await oldP!.setValue("current-1");
    await newP!.setValue("short");
    await confirmP!.setValue("short");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("新密码至少 8 位");
    expect(
      fetchMock.mock.calls.some(
        ([u]) => requestUrl(u) === "/api/auth/change-password",
      ),
    ).toBe(false);
  });

  it("flags a confirmation mismatch", async () => {
    const wrapper = await mountView();
    const [oldP, newP, confirmP] = wrapper.findAll("input[type=password]");
    await oldP!.setValue("current-1");
    await newP!.setValue(NEW_PW);
    await confirmP!.setValue(MISMATCH_PW);
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("两次输入的新密码不一致");
  });

  it("submits a valid change, then clears the form and toasts success", async () => {
    handlers.push({
      match: (u, i) => u === "/api/auth/change-password" && i.method === "POST",
      response: () => new Response(null, { status: 204 }),
    });
    const wrapper = await mountView();
    const [oldP, newP, confirmP] = wrapper.findAll("input[type=password]");
    await oldP!.setValue("current-1");
    await newP!.setValue(NEW_PW);
    await confirmP!.setValue(NEW_PW);
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(useNotifications().items.at(-1)?.message).toContain("密码已修改");
    expect((oldP!.element as HTMLInputElement).value).toBe("");
  });

  it("surfaces a wrong current password from the backend", async () => {
    handlers.push({
      match: (u) => u === "/api/auth/change-password",
      response: () =>
        new Response(JSON.stringify({ error: "invalid_credentials" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const wrapper = await mountView();
    const [oldP, newP, confirmP] = wrapper.findAll("input[type=password]");
    await oldP!.setValue("wrong-1a");
    await newP!.setValue(NEW_PW);
    await confirmP!.setValue(NEW_PW);
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("当前密码不正确");
  });
});

describe("ProfileView — my sessions", () => {
  it("lists sessions and marks the current one", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("Firefox");
    expect(wrapper.text()).toContain("Chrome");
    expect(wrapper.text()).toContain("当前会话");
  });

  it("shows an error state when the session list fails to load", async () => {
    handlers = [
      {
        match: (u) => u === "/api/auth/sessions",
        response: () => new Response(null, { status: 500 }),
      },
    ];
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("无法加载会话列表");
  });

  it("revokes a non-current session and drops it from the list", async () => {
    handlers.push({
      match: (u, i) =>
        u.startsWith("/api/auth/sessions/") && i.method === "DELETE",
      response: () => new Response(null, { status: 204 }),
    });
    const wrapper = await mountView();
    // Click 下线 on the non-current (Chrome) row — it is the second row's button.
    const buttons = wrapper.findAll("tbody button");
    await buttons[1]!.trigger("click");
    wrapper.findComponent(UiConfirmDialog).vm.$emit("confirm");
    await flushPromises();

    expect(wrapper.text()).not.toContain("Chrome");
    expect(useNotifications().items.at(-1)?.message).toContain("已下线该设备");
  });

  it("revoking the current session logs out", async () => {
    const logout = vi.fn(() => new Response(null, { status: 204 }));
    handlers.push({
      match: (u, i) =>
        u.startsWith("/api/auth/sessions/") && i.method === "DELETE",
      response: () => new Response(null, { status: 204 }),
    });
    handlers.push({
      match: (u, i) => u === "/api/auth/logout" && i.method === "POST",
      response: logout,
    });
    const wrapper = await mountView();
    const buttons = wrapper.findAll("tbody button");
    await buttons[0]!.trigger("click"); // current (Firefox)
    wrapper.findComponent(UiConfirmDialog).vm.$emit("confirm");
    await flushPromises();

    expect(logout).toHaveBeenCalled();
  });
});
