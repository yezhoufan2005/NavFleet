import { reactive } from "vue";

export type AuthStatus = "unknown" | "authenticated" | "anonymous";

export interface AuthUser {
  username: string;
  role: "admin" | "operator" | "viewer";
}

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  error: string;
  pending: boolean;
}

// Access token lifetime is short; refresh well before it expires so long-lived
// dashboard sessions keep working without interrupting the operator.
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

const request = async (path: string, options: RequestInit = {}): Promise<Response> =>
  fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });

export function useAuth() {
  const state = reactive<AuthState>({
    status: "unknown",
    user: null,
    error: "",
    pending: false,
  });

  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const stopRefreshTimer = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  const startRefreshTimer = () => {
    stopRefreshTimer();
    refreshTimer = setInterval(() => {
      void request("/api/auth/refresh", { method: "POST" });
    }, REFRESH_INTERVAL_MS);
  };

  const setAuthenticated = (user: AuthUser) => {
    state.user = user;
    state.status = "authenticated";
    state.error = "";
    startRefreshTimer();
  };

  const setAnonymous = () => {
    state.user = null;
    state.status = "anonymous";
    stopRefreshTimer();
  };

  const fetchMe = async (): Promise<boolean> => {
    try {
      const response = await request("/api/auth/me");
      if (response.ok) {
        const body = (await response.json()) as { user: AuthUser };
        setAuthenticated(body.user);
        return true;
      }
    } catch {
      // Network error — treated as not authenticated below.
    }
    setAnonymous();
    return false;
  };

  const login = async (username: string, password: string): Promise<boolean> => {
    state.pending = true;
    state.error = "";
    try {
      const response = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        const body = (await response.json()) as { user: AuthUser };
        setAuthenticated(body.user);
        return true;
      }
      state.error = response.status === 401 ? "用户名或密码错误" : "登录失败，请稍后重试";
    } catch {
      state.error = "无法连接服务器，请检查网络";
    } finally {
      state.pending = false;
    }
    return false;
  };

  const logout = async (): Promise<void> => {
    try {
      await request("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignore network errors on logout; clear local state regardless.
    }
    setAnonymous();
  };

  return { state, fetchMe, login, logout };
}
