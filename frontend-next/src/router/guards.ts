import { watch } from "vue";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import type { AuthStatus } from "@/composables/useAuth";

/**
 * Route guard for the authenticated area.
 *
 * Defence in depth, not the primary gate. `App.vue` renders the login form
 * *instead of* the shell when the session is anonymous, so an unauthenticated
 * visitor never sees a route's component either way. This guard exists so that a
 * future change to the shell cannot quietly turn a deep link into an open door.
 *
 * Ported from the v1.0.0 frontend. Two things about it are load-bearing and worth
 * keeping in mind before editing:
 *
 * - The landing route is allowed through unconditionally. It is also the redirect
 *   target, so gating it would be a redirect loop, and letting it through means
 *   the very first navigation of a cold load never blocks on the session probe.
 * - State is an argument rather than an import. That is the seam the tests use;
 *   the guard never needs to know that the real state is a module singleton.
 */
export interface AuthGuardState {
  status: AuthStatus;
}

export type AuthGuardTarget = Pick<
  RouteLocationNormalized,
  "name" | "fullPath"
>;

/** Where an anonymous visitor is sent, and the one route that is never gated. */
export const AUTH_FALLBACK_ROUTE_NAME = "overview";

/**
 * How long a navigation waits for the session probe before giving up and letting
 * it through. Letting it through is the right failure mode: the shell is still
 * gated, so the worst case is a component mounting with no data, whereas blocking
 * forever is a permanently blank page.
 */
export const AUTH_RESOLVE_TIMEOUT_MS = 8000;

const waitForAuthResolution = (
  state: AuthGuardState,
  timeoutMs: number,
): Promise<AuthStatus> =>
  new Promise((resolve) => {
    if (state.status !== "unknown") {
      resolve(state.status);
      return;
    }

    let settled = false;
    const finish = (status: AuthStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(status);
    };

    const timer = setTimeout(() => finish(state.status), timeoutMs);
    // Sync flush: a status that resolves in the middle of this navigation has to
    // be seen in the same tick, not after the next render.
    const stop = watch(
      () => state.status,
      (status) => {
        if (status !== "unknown") finish(status);
      },
      { flush: "sync" },
    );
  });

export const createAuthGuard = (
  state: AuthGuardState,
  options: { timeoutMs?: number } = {},
) => {
  const timeoutMs = options.timeoutMs ?? AUTH_RESOLVE_TIMEOUT_MS;

  return async (to: AuthGuardTarget): Promise<true | RouteLocationRaw> => {
    if (to.name === AUTH_FALLBACK_ROUTE_NAME) return true;

    const status =
      state.status === "unknown"
        ? await waitForAuthResolution(state, timeoutMs)
        : state.status;

    if (status === "anonymous") {
      // `replace` so a rejected deep link does not sit in history, where Back
      // would walk straight back into the same redirect.
      return { name: AUTH_FALLBACK_ROUTE_NAME, replace: true };
    }

    if (status === "unknown") {
      console.warn("[router] 会话状态在超时前仍未确定，放行导航", to.fullPath);
    }

    return true;
  };
};
