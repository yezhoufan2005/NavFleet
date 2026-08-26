/**
 * Navigation guards.
 *
 * `App.vue` already swaps the whole shell for the login form while the session
 * is anonymous, so this guard is defence in depth rather than the primary gate:
 * it stops a deep link such as `#/history` from resolving to a view that has no
 * session behind it, and it keeps that decision in one place instead of relying
 * on a template `v-if`.
 */

import { watch } from "vue";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import type { AuthStatus } from "../composables/useAuth";

/** Minimal structural view of the auth singleton, so tests can pass a fake. */
export interface AuthGuardState {
  status: AuthStatus;
}

/** The only parts of the target route the guard looks at. */
export type AuthGuardTarget = Pick<RouteLocationNormalized, "name" | "fullPath">;

/**
 * Where unauthenticated navigation is sent. `App.vue` renders the login form in
 * place of the shell, so the dashboard route is where an anonymous visitor ends
 * up; it is also the one route the guard always allows, which is what makes a
 * redirect loop impossible.
 */
export const AUTH_FALLBACK_ROUTE_NAME = "dashboard";

/**
 * Upper bound on how long one navigation waits for the session lookup
 * (`/api/auth/me`) to answer. Without it a request that never settles would
 * block the router forever. On timeout the navigation is allowed through, which
 * is safe: while the status is still `unknown`, `App.vue` renders the loading
 * screen and never mounts the routed view.
 */
export const AUTH_RESOLVE_TIMEOUT_MS = 8000;

/**
 * Resolves as soon as the status leaves `unknown`, or with whatever the status
 * is once `timeoutMs` elapses. The watcher flushes synchronously so a status
 * change during navigation is picked up immediately, and it is always stopped
 * before resolving so a blocked navigation cannot leak an effect.
 */
function waitForAuthResolution(state: AuthGuardState, timeoutMs: number): Promise<AuthStatus> {
  if (state.status !== "unknown") {
    return Promise.resolve(state.status);
  }

  return new Promise<AuthStatus>((resolve) => {
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (status: AuthStatus) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stop?.();
      stop = null;
      resolve(status);
    };

    stop = watch(
      () => state.status,
      (status) => {
        if (status !== "unknown") {
          finish(status);
        }
      },
      { flush: "sync" },
    );

    timer = setTimeout(() => finish(state.status), timeoutMs);
  });
}

/**
 * Builds the `beforeEach` guard. Takes the auth state as an argument (rather
 * than reaching for the singleton itself) so it can be driven directly in tests.
 */
export function createAuthGuard(
  state: AuthGuardState,
  options: { timeoutMs?: number } = {},
): (to: AuthGuardTarget) => Promise<true | RouteLocationRaw> {
  const timeoutMs = options.timeoutMs ?? AUTH_RESOLVE_TIMEOUT_MS;

  return async (to) => {
    // Always allow the fallback route — it is where unauthenticated navigation
    // is redirected to, so allowing it unconditionally rules out a loop. It also
    // means the very first navigation never waits on the session lookup.
    if (to.name === AUTH_FALLBACK_ROUTE_NAME) {
      return true;
    }

    const status =
      state.status === "unknown" ? await waitForAuthResolution(state, timeoutMs) : state.status;

    if (status === "anonymous") {
      // `replace` so the rejected deep link does not sit in the history stack.
      return { name: AUTH_FALLBACK_ROUTE_NAME, replace: true };
    }

    if (status === "unknown") {
      // Timed out. Let it through: the shell shows the loading state and mounts
      // nothing, and blocking here would strand the operator on a dead route.
      console.warn("[router] 会话状态在超时前仍未确定，放行导航", to.fullPath);
    }

    return true;
  };
}
