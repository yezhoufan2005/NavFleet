import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  notify,
  useNotifications,
  __resetNotifications,
} from "@/composables/useNotifications";

describe("useNotifications", () => {
  beforeEach(() => {
    __resetNotifications();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds a toast and returns its id", () => {
    const { items } = useNotifications();
    const id = notify("已连接");
    expect(id).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 1, type: "info", message: "已连接" });
  });

  it("auto-dismisses after the per-type default", () => {
    const { items } = useNotifications();
    notify("好了", { type: "success" });
    vi.advanceTimersByTime(2999);
    expect(items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(items).toHaveLength(0);
  });

  it("gives errors longer on screen than successes", () => {
    const { items } = useNotifications();
    notify("坏了", { type: "error" });
    vi.advanceTimersByTime(4000);
    expect(items).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(items).toHaveLength(0);
  });

  it("keeps a toast with timeout 0 until it is dismissed", () => {
    const { items } = useNotifications();
    const id = notify("会话已过期", { timeout: 0 });
    vi.advanceTimersByTime(60_000);
    expect(items).toHaveLength(1);
    useNotifications().dismiss(id);
    expect(items).toHaveLength(0);
  });

  it("suppresses a duplicate while one with the same key is on screen", () => {
    // The case this exists for: a reconnect loop that fails every two seconds
    // would otherwise stack one toast per attempt.
    const { items } = useNotifications();
    const first = notify("连接失败", { dedupeKey: "ws" });
    const second = notify("连接失败", { dedupeKey: "ws" });

    expect(first).toBe(1);
    expect(second).toBe(-1);
    expect(items).toHaveLength(1);
  });

  it("releases a dedupe key on dismissal so the next failure still reports", () => {
    const first = notify("连接失败", { dedupeKey: "ws" });
    useNotifications().dismiss(first);
    expect(notify("连接失败", { dedupeKey: "ws" })).toBeGreaterThan(0);
  });

  it("ignores a dismissal for an id that is not on screen", () => {
    const { items } = useNotifications();
    notify("在的");
    expect(() => useNotifications().dismiss(9999)).not.toThrow();
    expect(items).toHaveLength(1);
  });

  it("clears the pending timer when dismissed early", () => {
    const { items } = useNotifications();
    const id = notify("提示");
    useNotifications().dismiss(id);
    // Without the clearTimeout this would splice a second time and, before the
    // id check, could remove whatever had taken index 0 by then.
    notify("另一条");
    vi.advanceTimersByTime(10_000);
    expect(items).toHaveLength(0);
  });
});
