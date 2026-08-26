import { describe, it, expect, afterEach, vi } from "vitest";
import { reactive } from "vue";
import {
  createAuthGuard,
  AUTH_FALLBACK_ROUTE_NAME,
  type AuthGuardState,
  type AuthGuardTarget,
} from "../../src/router/guards";

const fakeState = (status: AuthGuardState["status"]) => reactive<AuthGuardState>({ status });

const target = (name: string): AuthGuardTarget => ({ name, fullPath: `/${name}` });

const HISTORY = target("history");
const DASHBOARD: AuthGuardTarget = { name: AUTH_FALLBACK_ROUTE_NAME, fullPath: "/" };

describe("createAuthGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows navigation for an authenticated session", async () => {
    const guard = createAuthGuard(fakeState("authenticated"));
    await expect(guard(HISTORY)).resolves.toBe(true);
  });

  it("redirects anonymous navigation to the dashboard route", async () => {
    const guard = createAuthGuard(fakeState("anonymous"));
    await expect(guard(HISTORY)).resolves.toEqual({
      name: AUTH_FALLBACK_ROUTE_NAME,
      replace: true,
    });
  });

  it("always allows the fallback route so the redirect cannot loop", async () => {
    const guard = createAuthGuard(fakeState("anonymous"));
    await expect(guard(DASHBOARD)).resolves.toBe(true);
  });

  it("allows the fallback route without waiting for the session lookup", async () => {
    const guard = createAuthGuard(fakeState("unknown"), { timeoutMs: 10_000 });
    await expect(guard(DASHBOARD)).resolves.toBe(true);
  });

  it("waits while the session is unknown, then allows once authenticated", async () => {
    const state = fakeState("unknown");
    const guard = createAuthGuard(state);

    let settled = false;
    const pending = guard(HISTORY).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    state.status = "authenticated";
    await expect(pending).resolves.toBe(true);
  });

  it("waits while the session is unknown, then redirects once anonymous", async () => {
    const state = fakeState("unknown");
    const guard = createAuthGuard(state);
    const pending = guard(HISTORY);

    state.status = "anonymous";
    await expect(pending).resolves.toEqual({
      name: AUTH_FALLBACK_ROUTE_NAME,
      replace: true,
    });
  });

  it("gives up waiting after the timeout instead of blocking forever", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const guard = createAuthGuard(fakeState("unknown"), { timeoutMs: 50 });

    const pending = guard(HISTORY);
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
