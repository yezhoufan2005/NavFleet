import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useNotifications,
  notify,
  dismissNotification,
} from "../../src/composables/useNotifications";

const { items } = useNotifications();

describe("useNotifications", () => {
  beforeEach(() => {
    // Clear any notifications left by previous tests.
    [...items].forEach((item) => dismissNotification(item.id));
  });

  it("adds a notification with the given type and message", () => {
    notify("hello", { type: "success", timeout: 0 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "success", message: "hello" });
  });

  it("de-duplicates by dedupeKey while one is active", () => {
    notify("down", { type: "warning", timeout: 0, dedupeKey: "ws-down" });
    notify("down again", { type: "warning", timeout: 0, dedupeKey: "ws-down" });
    expect(items.filter((i) => i.dedupeKey === "ws-down")).toHaveLength(1);
  });

  it("allows the same dedupeKey again after dismissal", () => {
    const id = notify("x", { timeout: 0, dedupeKey: "k" });
    dismissNotification(id);
    notify("y", { timeout: 0, dedupeKey: "k" });
    expect(items.filter((i) => i.dedupeKey === "k")).toHaveLength(1);
  });

  it("auto-dismisses after the timeout", () => {
    vi.useFakeTimers();
    notify("temp", { timeout: 1000 });
    expect(items).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(items).toHaveLength(0);
    vi.useRealTimers();
  });
});
