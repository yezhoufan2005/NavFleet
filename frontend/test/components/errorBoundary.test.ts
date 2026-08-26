import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import ErrorBoundary from "../../src/components/ErrorBoundary.vue";

// Flipped per test to decide whether the child blows up on its next render.
const shouldThrow = ref(true);

const Boom = defineComponent({
  name: "Boom",
  setup() {
    return () => {
      if (shouldThrow.value) {
        throw new Error("视图炸了");
      }
      return h("p", { class: "boom-ok" }, "恢复正常");
    };
  },
});

// The child throws during the boundary's own mount render, so the fallback only
// appears on the boundary's next tick — always await the mount.
const mountBoundary = async () => {
  const wrapper = mount(ErrorBoundary, { slots: { default: () => h(Boom) } });
  await nextTick();
  return wrapper;
};

describe("ErrorBoundary", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow.value = true;
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("renders the slot content while nothing throws", async () => {
    shouldThrow.value = false;
    const wrapper = await mountBoundary();
    expect(wrapper.find(".boom-ok").exists()).toBe(true);
    expect(wrapper.find(".fallback-view").exists()).toBe(false);
  });

  it("shows the fallback panel with the error summary when a child throws", async () => {
    const wrapper = await mountBoundary();
    const fallback = wrapper.get(".fallback-view");
    expect(fallback.attributes("role")).toBe("alert");
    expect(fallback.text()).toContain("页面渲染失败");
    expect(fallback.text()).toContain("视图炸了");
    expect(wrapper.find(".boom-ok").exists()).toBe(false);
  });

  it("still logs the raw error to the console", async () => {
    await mountBoundary();
    expect(consoleError).toHaveBeenCalled();
    const [message, error] = consoleError.mock.calls[0];
    expect(message).toContain("ErrorBoundary");
    expect(error).toBeInstanceOf(Error);
  });

  it("re-renders the child after 重试 once the cause is gone", async () => {
    const wrapper = await mountBoundary();
    expect(wrapper.find(".fallback-view").exists()).toBe(true);

    shouldThrow.value = false;
    await wrapper.get(".fallback-actions button").trigger("click");

    expect(wrapper.find(".fallback-view").exists()).toBe(false);
    expect(wrapper.get(".boom-ok").text()).toBe("恢复正常");
  });

  it("shows the fallback again if 重试 hits the same failure", async () => {
    const wrapper = await mountBoundary();
    await wrapper.get(".fallback-actions button").trigger("click");
    await nextTick();
    expect(wrapper.find(".fallback-view").exists()).toBe(true);
  });

  it("clears itself when the reset key changes (navigating away)", async () => {
    const wrapper = await mountBoundary();
    expect(wrapper.find(".fallback-view").exists()).toBe(true);

    shouldThrow.value = false;
    await wrapper.setProps({ resetKey: "/alerts" });
    await nextTick();

    expect(wrapper.find(".fallback-view").exists()).toBe(false);
    expect(wrapper.find(".boom-ok").exists()).toBe(true);
  });
});
