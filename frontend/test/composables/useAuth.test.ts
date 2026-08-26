/**
 * Session composable: `/api/auth/*` calls, status transitions and the silent
 * refresh timer.
 *
 * `useAuth` owns module-level reactive state, so every case re-imports the module
 * after `vi.resetModules()` to get a clean session instead of leaking status,
 * errors or a live refresh timer into the next test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type AuthModule = typeof import("../../src/composables/useAuth");

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const ADMIN = { username: "admin", role: "admin" as const };

/** A route answer: an HTTP reply, or a rejected request ("network-error"). */
type Reply = { status: number; body?: unknown } | "network-error";

let routes: Map<string, Reply>;
let fetchStub: ReturnType<typeof createFetchStub>;

const createFetchStub = () =>
  vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const reply = routes.get(url) ?? { status: 200, body: {} };
    if (reply === "network-error") {
      return Promise.reject(new Error(`network down: ${url}`));
    }
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    } as unknown as Response);
  });

const loadAuth = async (): Promise<AuthModule> => {
  vi.resetModules();
  return import("../../src/composables/useAuth");
};

const requestedPaths = (): string[] => fetchStub.mock.calls.map(([input]) => String(input));

const initFor = (path: string): RequestInit =>
  fetchStub.mock.calls.find(([input]) => String(input) === path)?.[1] ?? {};

beforeEach(() => {
  vi.useFakeTimers();
  routes = new Map<string, Reply>();
  fetchStub = createFetchStub();
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useAuth fetchMe", () => {
  it("marks the session authenticated from the current user", async () => {
    routes.set("/api/auth/me", { status: 200, body: { user: ADMIN } });
    const { useAuth } = await loadAuth();
    const auth = useAuth();

    await expect(auth.fetchMe()).resolves.toBe(true);

    expect(auth.state.status).toBe("authenticated");
    expect(auth.state.user).toEqual(ADMIN);
    expect(auth.state.error).toBe("");
    expect(initFor("/api/auth/me").credentials).toBe("include");
  });

  it("falls back to anonymous when the session cookie is rejected", async () => {
    routes.set("/api/auth/me", { status: 401 });
    const { useAuth } = await loadAuth();
    const auth = useAuth();

    await expect(auth.fetchMe()).resolves.toBe(false);

    expect(auth.state.status).toBe("anonymous");
    expect(auth.state.user).toBeNull();
  });

  it("falls back to anonymous when the request fails outright", async () => {
    routes.set("/api/auth/me", "network-error");
    const { useAuth } = await loadAuth();
    const auth = useAuth();

    await expect(auth.fetchMe()).resolves.toBe(false);
    expect(auth.state.status).toBe("anonymous");
  });
});

describe("useAuth login", () => {
  it("posts the credentials as JSON and stores the returned user", async () => {
    routes.set("/api/auth/login", { status: 200, body: { user: ADMIN } });
    const { useAuth } = await loadAuth();
    const auth = useAuth();

    await expect(auth.login("admin", "secret")).resolves.toBe(true);

    expect(auth.state.status).toBe("authenticated");
    expect(auth.state.user).toEqual(ADMIN);
    expect(auth.state.error).toBe("");
    expect(auth.state.pending).toBe(false);

    const init = initFor("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ username: "admin", password: "secret" }));
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("reports bad credentials without authenticating", async () => {
    routes.set("/api/auth/login", { status: 401 });
    const { useAuth } = await loadAuth();
    const auth = useAuth();

    await expect(auth.login("admin", "wrong")).resolves.toBe(false);

    expect(auth.state.error).toBe("用户名或密码错误");
    expect(auth.state.status).toBe("unknown");
    expect(auth.state.user).toBeNull();
    expect(auth.state.pending).toBe(false);
  });

  it("reports a generic failure for other error statuses", async () => {
    routes.set("/api/auth/login", { status: 500 });
    const { useAuth } = await loadAuth();
    const auth = useAuth();

    await expect(auth.login("admin", "secret")).resolves.toBe(false);
    expect(auth.state.error).toBe("登录失败，请稍后重试");
  });

  it("reports a connectivity problem when the request fails", async () => {
    routes.set("/api/auth/login", "network-error");
    const { useAuth } = await loadAuth();
    const auth = useAuth();

    await expect(auth.login("admin", "secret")).resolves.toBe(false);
    expect(auth.state.error).toBe("无法连接服务器，请检查网络");
    expect(auth.state.pending).toBe(false);
  });
});

describe("useAuth refresh timer", () => {
  it("silently refreshes the access token while authenticated", async () => {
    routes.set("/api/auth/me", { status: 200, body: { user: ADMIN } });
    const { useAuth } = await loadAuth();
    const auth = useAuth();
    await auth.fetchMe();

    expect(requestedPaths()).not.toContain("/api/auth/refresh");

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(requestedPaths().filter((path) => path === "/api/auth/refresh")).toHaveLength(1);
    expect(initFor("/api/auth/refresh").method).toBe("POST");

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(requestedPaths().filter((path) => path === "/api/auth/refresh")).toHaveLength(2);
  });

  it("stops refreshing and clears the session on logout", async () => {
    routes.set("/api/auth/me", { status: 200, body: { user: ADMIN } });
    const { useAuth } = await loadAuth();
    const auth = useAuth();
    await auth.fetchMe();
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);

    await auth.logout();

    expect(auth.state.status).toBe("anonymous");
    expect(auth.state.user).toBeNull();
    expect(requestedPaths()).toContain("/api/auth/logout");

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
    expect(requestedPaths().filter((path) => path === "/api/auth/refresh")).toHaveLength(1);
  });

  it("does not refresh for an anonymous session", async () => {
    routes.set("/api/auth/me", { status: 401 });
    const { useAuth } = await loadAuth();
    const auth = useAuth();
    await auth.fetchMe();

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 2);
    expect(requestedPaths()).not.toContain("/api/auth/refresh");
  });

  it("clears the session even when the logout request fails", async () => {
    routes.set("/api/auth/me", { status: 200, body: { user: ADMIN } });
    routes.set("/api/auth/logout", "network-error");
    const { useAuth } = await loadAuth();
    const auth = useAuth();
    await auth.fetchMe();

    await expect(auth.logout()).resolves.toBeUndefined();
    expect(auth.state.status).toBe("anonymous");
  });
});
