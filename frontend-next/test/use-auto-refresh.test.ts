import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { useAutoRefresh } from "@/composables/useAutoRefresh";

/**
 * useAutoRefresh — re-fetch on tab focus/visibility instead of a manual 刷新 button (1.6.1).
 * We drive the real `visibilitychange` / `focus` events and assert when `refresh` runs.
 */
enableAutoUnmount(afterEach);

const host = (refresh: () => void, enabled?: () => boolean) =>
  defineComponent({
    setup() {
      useAutoRefresh(refresh, enabled ? { enabled } : {});
      return () => h("div");
    },
  });

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  setVisibility("visible");
});

describe("useAutoRefresh", () => {
  it("refreshes when the window regains focus", async () => {
    const refresh = vi.fn();
    mount(host(refresh));
    await nextTick();
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the tab becomes visible again", async () => {
    const refresh = vi.fn();
    mount(host(refresh));
    await nextTick();
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh while the tab is hidden", async () => {
    const refresh = vi.fn();
    mount(host(refresh));
    await nextTick();
    setVisibility("hidden");
    window.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("throttles a focus + visibility burst to one refresh", async () => {
    const refresh = vi.fn();
    mount(host(refresh));
    await nextTick();
    window.dispatchEvent(new Event("focus"));
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("skips the refresh when `enabled` returns false", async () => {
    const refresh = vi.fn();
    mount(host(refresh, () => false));
    await nextTick();
    window.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("detaches its listeners on unmount", async () => {
    const refresh = vi.fn();
    const wrapper = mount(host(refresh));
    await nextTick();
    wrapper.unmount();
    window.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();
  });
});
