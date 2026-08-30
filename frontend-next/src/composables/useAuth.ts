import { reactive } from "vue";
import { notify } from "@/composables/useNotifications";

/**
 * Session state.
 *
 * A module-level `reactive` singleton rather than a Pinia store, and deliberately
 * so: `router/index.ts` registers its guard at import time, before any app exists,
 * so anything the guard reads has to be usable outside an active Pinia instance.
 * Auth is also the one piece of state with exactly one instance per tab by
 * definition, which is the case a store buys nothing for.
 *
 * Nothing here touches localStorage. Tokens live in httpOnly cookies and are never
 * visible to JavaScript, which is why every call passes `credentials: "include"`
 * and none of them sets an `Authorization` header.
 *
 * ## What changed from the v1.0.0 port
 *
 * The old refresh was `void request("/api/auth/refresh", …)` on a plain
 * `setInterval`: the response was ignored, a failure did nothing at all, and the
 * timer kept firing into a session that was already gone. `frontend-parity.md`
 * 9.23 files that as a defect, and `frontend-ia.md` §4 explains why it matters
 * most for the wall display: a screen mounted for three months goes stale after
 * one silently failed refresh, and **shows no sign that it has**.
 *
 * So the timer is now a self-scheduling chain that reacts to the outcome:
 *
 * - success → schedule the next one at the normal interval
 * - 401 → the refresh token itself is gone; go anonymous and say so
 * - network error or 5xx → the backend may be restarting, which is not a reason
 *   to throw the operator out. Retry on a short backoff, and only give up (going
 *   anonymous, with a sticky toast) after the whole ladder fails.
 */
export type AuthStatus = "unknown" | "authenticated" | "anonymous";
export type AuthRole = "admin" | "operator" | "viewer";

export interface AuthUser {
  username: string;
  role: AuthRole;
}

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  error: string;
  pending: boolean;
}

/**
 * Ten minutes against the backend's 15-minute access token (`JWT_ACCESS_TTL`), so
 * there is a five-minute margin for a slow or once-failed refresh. Changing either
 * side without the other is how you get sessions that expire mid-shift.
 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** Backoff for a refresh that failed for a reason other than "no session". */
const RETRY_DELAYS_MS = [15_000, 45_000, 120_000] as const;

const state = reactive<AuthState>({
  status: "unknown",
  user: null,
  error: "",
  pending: false,
});

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let failedRefreshes = 0;

const request = (path: string, options: RequestInit = {}): Promise<Response> =>
  fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });

const isAuthUser = (value: unknown): value is AuthUser => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { username?: unknown; role?: unknown };
  return (
    typeof candidate.username === "string" &&
    (candidate.role === "admin" ||
      candidate.role === "operator" ||
      candidate.role === "viewer")
  );
};

/** `{ user }` or nothing — a malformed body must not read as a valid session. */
const readUser = async (response: Response): Promise<AuthUser | null> => {
  try {
    const body: unknown = await response.json();
    const user = (body as { user?: unknown } | null)?.user;
    return isAuthUser(user) ? user : null;
  } catch {
    return null;
  }
};

const stopRefreshTimer = (): void => {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
};

const scheduleRefresh = (delayMs: number): void => {
  stopRefreshTimer();
  refreshTimer = setTimeout(() => {
    void runRefresh();
  }, delayMs);
};

const setAnonymous = (): void => {
  stopRefreshTimer();
  failedRefreshes = 0;
  state.user = null;
  state.status = "anonymous";
  // `state.error` is left alone on purpose: a failed login sets it and then calls
  // through to here, and clearing it would wipe the message the person needs.
};

const setAuthenticated = (user: AuthUser): void => {
  state.user = user;
  state.status = "authenticated";
  state.error = "";
  failedRefreshes = 0;
  scheduleRefresh(REFRESH_INTERVAL_MS);
};

const runRefresh = async (): Promise<void> => {
  let response: Response;
  try {
    response = await request("/api/auth/refresh", { method: "POST" });
  } catch {
    giveUpOrRetry("无法连接服务器");
    return;
  }

  if (response.ok) {
    const user = await readUser(response);
    if (user) state.user = user;
    failedRefreshes = 0;
    scheduleRefresh(REFRESH_INTERVAL_MS);
    return;
  }

  if (response.status === 401) {
    // The refresh token is gone or rejected. Retrying cannot help.
    setAnonymous();
    notify("会话已过期，请重新登录。", {
      type: "warning",
      timeout: 0,
      dedupeKey: "session-expired",
    });
    return;
  }

  giveUpOrRetry(`服务器返回 ${response.status}`);
};

const giveUpOrRetry = (reason: string): void => {
  const delay = RETRY_DELAYS_MS[failedRefreshes];
  failedRefreshes += 1;

  if (delay !== undefined) {
    scheduleRefresh(delay);
    return;
  }

  setAnonymous();
  notify(`会话续期连续失败（${reason}），请重新登录。`, {
    type: "error",
    timeout: 0,
    dedupeKey: "session-refresh-failed",
  });
};

export const useAuth = () => {
  /**
   * Ask the backend who we are. A 401 is the expected answer for a visitor with
   * no cookie, so it is not an error and raises no toast — but a *network* failure
   * is a different thing wearing the same clothes, and the old frontend rendered
   * both as "you are logged out". Saying which one it was is the difference
   * between "log in again" and "the backend is down".
   */
  const fetchMe = async (): Promise<boolean> => {
    try {
      const response = await request("/api/auth/me");
      if (response.ok) {
        const user = await readUser(response);
        if (user) {
          setAuthenticated(user);
          return true;
        }
      }
    } catch {
      setAnonymous();
      notify("无法连接服务器，请检查网络后重试。", {
        type: "error",
        dedupeKey: "session-probe-offline",
      });
      return false;
    }
    setAnonymous();
    return false;
  };

  const login = async (
    username: string,
    password: string,
  ): Promise<boolean> => {
    state.pending = true;
    state.error = "";
    try {
      const response = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        const user = await readUser(response);
        if (user) {
          setAuthenticated(user);
          return true;
        }
        state.error = "登录失败，请稍后重试";
        setAnonymous();
        return false;
      }

      state.error =
        response.status === 401 ? "用户名或密码错误" : "登录失败，请稍后重试";
      setAnonymous();
      return false;
    } catch {
      state.error = "无法连接服务器，请检查网络";
      setAnonymous();
      return false;
    } finally {
      state.pending = false;
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie may survive, but the local session must not: a logout that
      // appears not to have worked is worse than one that only worked locally.
    }
    setAnonymous();
  };

  return { state, fetchMe, login, logout };
};

/** Test-only reset for the module singleton. */
export const __resetAuth = (): void => {
  stopRefreshTimer();
  failedRefreshes = 0;
  state.status = "unknown";
  state.user = null;
  state.error = "";
  state.pending = false;
};

export const AUTH_REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MS;
export const AUTH_RETRY_DELAYS_MS = RETRY_DELAYS_MS;
