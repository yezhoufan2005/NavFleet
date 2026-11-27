import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import UiLoading from "@/components/ui/UiLoading.vue";
import UiBusyRegion from "@/components/ui/UiBusyRegion.vue";
import {
  __resetPageProgress,
  pageProgressActive,
} from "@/composables/usePageProgress";

/**
 * The loading standard: a first load shows a skeleton in the content's shape, a re-query keeps
 * the content and marks the region busy — and neither shows anything for a response faster than
 * 200ms, so a quick answer never flickers.
 */
beforeEach(() => {
  vi.useFakeTimers();
  __resetPageProgress();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("UiLoading", () => {
  it("is busy at once but draws nothing for the first 200ms", async () => {
    const wrapper = mount(UiLoading, { props: { label: "正在加载用户" } });
    expect(wrapper.attributes("aria-busy")).toBe("true");
    expect(wrapper.find('[role="status"]').exists()).toBe(false);

    vi.advanceTimersByTime(200);
    await nextTick();
    expect(wrapper.find('[role="status"]').text()).toBe("正在加载用户");
  });

  it("draws a table skeleton with the requested rows and columns", async () => {
    const wrapper = mount(UiLoading, {
      props: { label: "x", rows: 3, columns: 5 },
    });
    vi.advanceTimersByTime(200);
    await nextTick();
    const lines = wrapper.findAll(".grid");
    // A header strip plus three body rows, five cells each.
    expect(lines).toHaveLength(4);
    expect(lines[1]!.findAll(".skeleton-bar")).toHaveLength(5);
  });
});

describe("UiBusyRegion", () => {
  it("keeps its content, marks itself busy and holds the page progress line", async () => {
    const wrapper = mount(UiBusyRegion, {
      props: { busy: true },
      slots: { default: "<p>旧数据</p>" },
    });
    expect(wrapper.text()).toContain("旧数据");
    expect(wrapper.attributes("aria-busy")).toBe("true");
    expect(pageProgressActive.value).toBe(true);
    // Nothing is drawn inside the region, so its content never moves.
    expect(wrapper.element.children).toHaveLength(1);

    await wrapper.setProps({ busy: false });
    expect(wrapper.attributes("aria-busy")).toBeUndefined();
    expect(pageProgressActive.value).toBe(false);
  });

  it("releases its hold when it unmounts mid-query", () => {
    const wrapper = mount(UiBusyRegion, { props: { busy: true } });
    expect(pageProgressActive.value).toBe(true);
    wrapper.unmount();
    expect(pageProgressActive.value).toBe(false);
  });

  it("shows one line while two regions re-query at once", async () => {
    const a = mount(UiBusyRegion, { props: { busy: true } });
    const b = mount(UiBusyRegion, { props: { busy: true } });
    await a.setProps({ busy: false });
    expect(pageProgressActive.value).toBe(true);
    await b.setProps({ busy: false });
    expect(pageProgressActive.value).toBe(false);
  });
});
