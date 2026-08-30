import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useAuth,
  __resetAuth,
  AUTH_REFRESH_INTERVAL_MS,
  AUTH_RETRY_DELAYS_MS,
} from "@/composables/useAuth";
import {
  useNotifications,
  __resetNotifications,
} from "@/composables/useNotifications";

/**
 * The session, including the part v1.0.0 got wrong.
 *
 * The refresh cases are the reason this file is long. In v1.0.0 the refresh call
 * was `void request(...)` with the response discarded, so *every* one of the
 * outcomes below — expired token, backend restarting, network gone — produced
 * exactly the same behaviour: nothing at all, and a console that kept showing
 * stale data with no indication. `frontend-parity.md` 9.23.
 */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ADMIN = { username: "admin", role: "admin" } as const;

let fetchMock: ReturnType<typeof vi.fn>;

const lastCall = (index = 0): [string, RequestInit | undefined] =>
  fetchMock.mock.calls[index] as [string, RequestInit | undefined];

beforeEach(() => {
  __resetAuth();
  __resetNotifications();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchMe", () => {
  it("becomes authenticated when the backend recognises the cookie", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: ADMIN }));
    const auth = useAuth();

    await expect(auth.fetchMe()).resolves.toBe(true);
    expect(auth.state.status).toBe("authenticated");
    expect(auth.state.user).toEqual(ADMIN);
  });

  it("sends the cookie and never an Authorization header", async () => {
    // Tokens are httpOnly, so JavaScript cannot see them; a header here would mean
    // someone had moved them somewhere reachable.
    fetchMock.mockResolvedValue(jsonResponse({ user: ADMIN }));
    await useAuth().fetchMe();

    const [url, init] = lastCall();
    expect(url).toBe("/api/auth/me");
    expect(init?.credentials).toBe("include");
    expect(JSON.stringify(init?.headers)).not.toMatch(/authorization/i);
  });

  it("treats 401 as the ordinary answer for a visitor, with no toast", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const { items } = useNotifications();

    await expect(useAuth().fetchMe()).resolves.toBe(false);
    expect(useAuth().state.status).toBe("anonymous");
    expect(items).toHaveLength(0);
  });

  it("distinguishes an unreachable backend from a missing session", async () => {
    // v1.0.0 rendered both as "you are logged out", which sends someone to retype
    // a password that was never the problem.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { items } = useNotifications();

    await expect(useAuth().fetchMe()).resolves.toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toContain("无法连接服务器");
  });

  it("rejects a 200 whose body is not a user", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: { username: "x" } }));
    await expect(useAuth().fetchMe()).resolves.toBe(false);
    expect(useAuth().state.status).toBe("anonymous");
  });
});

describe("login", () => {
  it("authenticates and clears any earlier error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ user: ADMIN }));
    const auth = useAuth();
    auth.state.error = "上一次的错误";

    await expect(auth.login("admin", "secret")).resolves.toBe(true);
    expect(auth.state.status).toBe("authenticated");
    expect(auth.state.error).toBe("");
  });

  it("reports a wrong password in the words the operator needs", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const auth = useAuth();

    await expect(auth.login("admin", "nope")).resolves.toBe(false);
    expect(auth.state.error).toBe("用户名或密码错误");
    expect(auth.state.status).toBe("anonymous");
  });

  it("does not blame the password for a server fault", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const auth = useAuth();

    await expect(auth.login("admin", "secret")).resolves.toBe(false);
    expect(auth.state.error).toBe("登录失败，请稍后重试");
  });

  it("says so when the server cannot be reached at all", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const auth = useAuth();

    await expect(auth.login("admin", "secret")).resolves.toBe(false);
    expect(auth.state.error).toBe("无法连接服务器，请检查网络");
  });

  it("clears `pending` on every path, including the thrown one", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const auth = useAuth();
    await auth.login("admin", "secret");
    expect(auth.state.pending).toBe(false);
  });
});

describe("logout", () => {
  it("goes anonymous even if the request itself fails", async () => {
    // A logout that appears not to have worked is worse than one that only took
    // effect locally.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const auth = useAuth();
    auth.state.status = "authenticated";
    auth.state.user = { ...ADMIN };

    await auth.logout();
    expect(auth.state.status).toBe("anonymous");
    expect(auth.state.user).toBeNull();
  });
});

describe("token refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const signIn = async (): Promise<ReturnType<typeof useAuth>> => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: ADMIN }));
    const auth = useAuth();
    await auth.fetchMe();
    fetchMock.mockClear();
    return auth;
  };

  it("refreshes on a margin inside the access token's lifetime", async () => {
    const auth = await signIn();
    fetchMock.mockResolvedValue(jsonResponse({ user: ADMIN }));

    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({ method: "POST" }),
    );
    expect(auth.state.status).toBe("authenticated");
  });

  it("keeps refreshing on the normal interval while it succeeds", async () => {
    await signIn();
    fetchMock.mockResolvedValue(jsonResponse({ user: ADMIN }));

    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("signs out and says so when the refresh token itself is rejected", async () => {
    const auth = await signIn();
    const { items } = useNotifications();
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS);

    expect(auth.state.status).toBe("anonymous");
    expect(items[0]?.message).toContain("会话已过期");
    // A 401 means retrying cannot help, so no further attempt is scheduled.
    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on a backoff when the backend is merely unreachable", async () => {
    // A restarting backend is not a reason to throw someone out mid-shift.
    const auth = await signIn();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.state.status).toBe("authenticated");

    for (const [index, delay] of AUTH_RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(fetchMock).toHaveBeenCalledTimes(index + 2);
    }
  });

  it("recovers silently if a retry succeeds", async () => {
    const auth = await signIn();
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(jsonResponse({ user: ADMIN }));

    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAYS_MS[0]);

    expect(auth.state.status).toBe("authenticated");
    // Back on the normal interval, not still on the backoff ladder.
    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up loudly after the whole ladder fails", async () => {
    // This is the wall-display case: the alternative is a screen that stops
    // updating and shows no sign of it.
    const auth = await signIn();
    const { items } = useNotifications();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS);
    for (const delay of AUTH_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(auth.state.status).toBe("anonymous");
    expect(items.at(-1)?.message).toContain("会话续期连续失败");
  });

  it("stops the timer on logout", async () => {
    const auth = await signIn();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await auth.logout();
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_INTERVAL_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
