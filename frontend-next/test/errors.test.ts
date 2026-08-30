import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick, type Component } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ErrorBoundary from "@/components/ErrorBoundary.vue";
import {
  installGlobalErrorHandlers,
  __resetGlobalErrorHandlers,
} from "@/lib/globalErrorHandlers";
import {
  useNotifications,
  __resetNotifications,
} from "@/composables/useNotifications";

/**
 * What happens when something breaks.
 *
 * Two layers, and they answer different questions. The boundary keeps one broken
 * *view* from taking the console down with it. The global handlers exist for
 * everything the boundary cannot see — a rejected promise, an error thrown from an
 * event handler outside the render — which otherwise produce a console line nobody
 * is looking at and a UI that has quietly stopped working.
 */
enableAutoUnmount(afterEach);

const Boom = defineComponent({
  setup() {
    return () => {
      throw new Error("渲染炸了");
    };
  },
});

const Fine = defineComponent({
  setup: () => () => h("p", "内容正常"),
});

/**
 * A throw during the child's first render leaves the boundary mid-update: the
 * handler has already run, but the fallback is only on screen after the next tick.
 * Every case below therefore waits one tick rather than asserting on the render
 * that just failed.
 */
const mountBoundary = async (
  child: Component,
  props: { resetKey?: string } = {},
) => {
  const wrapper = mount(ErrorBoundary, { props, slots: { default: h(child) } });
  await nextTick();
  return wrapper;
};

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetNotifications();
  __resetGlobalErrorHandlers();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("ErrorBoundary", () => {
  it("passes the child through when nothing is wrong", () => {
    const wrapper = mount(ErrorBoundary, { slots: { default: h(Fine) } });
    expect(wrapper.text()).toContain("内容正常");
    expect(wrapper.text()).not.toContain("页面渲染失败");
  });

  it("replaces a throwing view with an explanation, not a blank area", async () => {
    const wrapper = await mountBoundary(Boom);

    expect(wrapper.find("[role='alert']").exists()).toBe(true);
    expect(wrapper.text()).toContain("页面渲染失败");
    // The message is shown, because "something went wrong" is not a bug report.
    expect(wrapper.text()).toContain("渲染炸了");
  });

  it("keeps the error and the component stack in the console", () => {
    // The only way to diagnose this after the fact — and it is also what makes a
    // Playwright run go red, which is the right outcome for a view that threw.
    mount(ErrorBoundary, { slots: { default: h(Boom) } });
    expect(consoleError).toHaveBeenCalledWith(
      "[ErrorBoundary] 视图渲染失败",
      expect.any(Error),
      expect.any(String),
    );
  });

  it("offers a retry that remounts the view", async () => {
    let shouldThrow = true;
    const Flaky = defineComponent({
      setup() {
        return () => {
          if (shouldThrow) throw new Error("第一次失败");
          return h("p", "第二次成功");
        };
      },
    });

    const wrapper = await mountBoundary(Flaky);
    expect(wrapper.text()).toContain("页面渲染失败");

    shouldThrow = false;
    await wrapper.find("button").trigger("click");
    expect(wrapper.text()).toContain("第二次成功");
  });

  it("clears itself when the route changes", async () => {
    // Otherwise someone whose instinct is "go somewhere else and come back" finds
    // the error still sitting on a page that is fine now. The child stops throwing
    // partway through, which is what a route change actually does: `RouterView`
    // renders a different view into the same slot.
    let broken = true;
    const PerRoute = defineComponent({
      setup() {
        return () => {
          if (broken) throw new Error("这一页坏了");
          return h("p", "另一页正常");
        };
      },
    });

    const wrapper = await mountBoundary(PerRoute, { resetKey: "/broken" });
    expect(wrapper.text()).toContain("页面渲染失败");

    broken = false;
    await wrapper.setProps({ resetKey: "/devices" });
    await nextTick();

    expect(wrapper.text()).toContain("另一页正常");
    expect(wrapper.text()).not.toContain("页面渲染失败");
  });

  it("comes back if the next view also throws", async () => {
    // Clearing on navigation must not mean swallowing: two broken pages in a row
    // should report twice, not once.
    const wrapper = await mountBoundary(Boom, { resetKey: "/one" });
    await wrapper.setProps({ resetKey: "/two" });
    await nextTick();
    expect(wrapper.text()).toContain("页面渲染失败");
  });

  it("does not report a non-Error throw as `undefined`", async () => {
    const StringThrow = defineComponent({
      setup() {
        return () => {
          throw "只是一个字符串";
        };
      },
    });
    const wrapper = await mountBoundary(StringThrow);
    expect(wrapper.text()).toContain("只是一个字符串");
  });
});

describe("installGlobalErrorHandlers", () => {
  it("turns an unhandled rejection into something the operator can see", async () => {
    const { items } = useNotifications();
    installGlobalErrorHandlers();

    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: new Error("后台请求失败"),
      }),
    );
    await nextTick();

    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe("后台任务失败：后台请求失败");
    expect(items[0]?.type).toBe("error");
  });

  it("collapses a repeating failure into one toast", async () => {
    // A loop that fails every two seconds would otherwise bury the screen.
    const { items } = useNotifications();
    installGlobalErrorHandlers();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      window.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: new Error("同一个失败"),
        }),
      );
    }
    await nextTick();

    expect(items).toHaveLength(1);
  });

  it("still reports a different failure while the first is on screen", async () => {
    const { items } = useNotifications();
    installGlobalErrorHandlers();

    for (const message of ["第一个", "第二个"]) {
      window.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: new Error(message),
        }),
      );
    }
    await nextTick();

    expect(items).toHaveLength(2);
  });

  it("reports a thrown window error and leaves the browser's own reporting alone", () => {
    const { items } = useNotifications();
    installGlobalErrorHandlers();

    const handled = window.onerror?.call(
      window,
      "Uncaught Error: 页面炸了",
      "app.js",
      1,
      1,
      new Error("页面炸了"),
    );

    expect(items[0]?.message).toBe("页面出现异常：页面炸了");
    // `false` means "not handled", which is what keeps the stack in the console.
    expect(handled).toBe(false);
  });

  it("chains to a handler that was already installed", () => {
    const previous = vi.fn();
    window.onerror = previous;
    installGlobalErrorHandlers();

    window.onerror?.call(window, "boom", "app.js", 1, 1, new Error("boom"));
    expect(previous).toHaveBeenCalled();
  });

  it("installs only once however many times it is called", () => {
    const { items } = useNotifications();
    installGlobalErrorHandlers();
    installGlobalErrorHandlers();

    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: new Error("一次就好"),
      }),
    );

    expect(items).toHaveLength(1);
  });

  it("describes a rejection that carries no Error at all", () => {
    const { items } = useNotifications();
    installGlobalErrorHandlers();

    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: undefined }),
    );

    expect(items[0]?.message).toBe("后台任务失败：未知错误");
  });
});
