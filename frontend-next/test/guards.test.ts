import { describe, it, expect, vi } from "vitest";
import { reactive } from "vue";
import type { RouteMeta } from "vue-router";
import type { Capability } from "@navfleet/shared";
import {
  createAuthGuard,
  AUTH_FALLBACK_ROUTE_NAME,
  type AuthGuardState,
} from "@/router/guards";
import type { AuthStatus } from "@/composables/useAuth";

/**
 * The second gate. `App.vue` is the first one — it renders the login form instead
 * of the shell — so these cases are about the guard holding on its own, which is
 * the only property that survives a future change to the shell.
 *
 * State is passed in rather than imported, which is the seam that makes this
 * testable without a running app or a real session.
 */
const stateWith = (
  status: AuthStatus,
  capabilities: Capability[] = [],
): AuthGuardState => reactive({ status, user: null, capabilities });

const target = (name: string, fullPath = `/${name}`, meta: RouteMeta = {}) => ({
  name,
  fullPath,
  meta,
});

describe("createAuthGuard", () => {
  it("lets an authenticated navigation through", async () => {
    const guard = createAuthGuard(stateWith("authenticated"));
    await expect(guard(target("alerts"))).resolves.toBe(true);
  });

  it("sends an anonymous visitor to the landing route", async () => {
    const guard = createAuthGuard(stateWith("anonymous"));
    await expect(guard(target("alerts"))).resolves.toEqual({
      name: AUTH_FALLBACK_ROUTE_NAME,
      replace: true,
    });
  });

  it("replaces rather than pushes, so Back does not re-enter the redirect", async () => {
    const guard = createAuthGuard(stateWith("anonymous"));
    const result = await guard(target("reports"));
    expect(result).toMatchObject({ replace: true });
  });

  it("never gates the landing route itself", async () => {
    // It is also the redirect target, so gating it would be a loop — and letting it
    // through is what stops a cold load from blocking on the session probe.
    const guard = createAuthGuard(stateWith("anonymous"));
    await expect(guard(target(AUTH_FALLBACK_ROUTE_NAME, "/"))).resolves.toBe(
      true,
    );
  });

  it("waits for an in-flight session probe before deciding", async () => {
    const state = stateWith("unknown");
    const guard = createAuthGuard(state, { timeoutMs: 1000 });

    const pending = guard(target("alerts"));
    let settled = false;
    void pending.then(() => (settled = true));

    await Promise.resolve();
    expect(settled).toBe(false);

    state.status = "authenticated";
    await expect(pending).resolves.toBe(true);
  });

  it("picks up a status that resolves to anonymous mid-navigation", async () => {
    const state = stateWith("unknown");
    const guard = createAuthGuard(state, { timeoutMs: 1000 });

    const pending = guard(target("alerts"));
    state.status = "anonymous";

    await expect(pending).resolves.toMatchObject({
      name: AUTH_FALLBACK_ROUTE_NAME,
    });
  });

  it("lets the navigation through if the probe never answers", async () => {
    // Failing open is right here: the shell is still gated, so the worst case is a
    // page with no data, while failing closed is a permanently blank console.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const guard = createAuthGuard(stateWith("unknown"), { timeoutMs: 50 });

    const pending = guard(target("alerts"));
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    vi.useRealTimers();
  });

  it("stops watching once it has an answer", async () => {
    // A guard that leaked its watcher would accumulate one per blocked navigation.
    const state = stateWith("unknown");
    const guard = createAuthGuard(state, { timeoutMs: 1000 });

    const pending = guard(target("alerts"));
    state.status = "authenticated";
    await pending;

    // Flipping the status again must not reject an already-settled navigation, and
    // there is nothing left listening to notice.
    state.status = "anonymous";
    await expect(pending).resolves.toBe(true);
  });

  // ── Capability gate (1.6.1 RBAC) ────────────────────────────────────────────
  const codebookOnly: RouteMeta = { capability: "codebook:write" };
  const adminArea: RouteMeta = { capabilities: ["users:manage", "audit:read"] };

  it("lets a capability holder into a route that requires it", async () => {
    const guard = createAuthGuard(
      stateWith("authenticated", ["codebook:write"]),
    );
    await expect(
      guard(target("admin-codebook", "/admin/codebook", codebookOnly)),
    ).resolves.toBe(true);
  });

  it("bounces an authenticated user lacking the required capability", async () => {
    const guard = createAuthGuard(stateWith("authenticated", ["audit:read"]));
    await expect(
      guard(target("admin-codebook", "/admin/codebook", codebookOnly)),
    ).resolves.toEqual({ name: AUTH_FALLBACK_ROUTE_NAME, replace: true });
  });

  it("admits an any-of (admin-area) route when the user holds any listed capability", async () => {
    const guard = createAuthGuard(stateWith("authenticated", ["audit:read"]));
    await expect(guard(target("admin", "/admin", adminArea))).resolves.toBe(
      true,
    );
  });

  it("bounces an any-of route when the user holds none of the listed capabilities", async () => {
    const guard = createAuthGuard(stateWith("authenticated", ["alerts:ack"]));
    await expect(guard(target("admin", "/admin", adminArea))).resolves.toEqual({
      name: AUTH_FALLBACK_ROUTE_NAME,
      replace: true,
    });
  });

  it("lets any authenticated user through a route with no capability restriction", async () => {
    const guard = createAuthGuard(stateWith("authenticated"));
    await expect(guard(target("alerts"))).resolves.toBe(true);
  });
});
