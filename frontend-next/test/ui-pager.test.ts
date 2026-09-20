import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UiPager from "@/components/ui/UiPager.vue";

/**
 * The pager the three paginating views now share. The logic worth pinning is the
 * part that was quietly divergent before: it hides itself at a single page, its
 * edges disable, it emits neighbouring pages, and the position label is a slot so
 * 设备's "· 共 N 台" survives without a second markup.
 */
describe("UiPager", () => {
  it("renders nothing when there is only one page", () => {
    const wrapper = mount(UiPager, { props: { page: 1, pageCount: 1 } });
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("disables the edges at the first and last page", () => {
    const first = mount(UiPager, { props: { page: 1, pageCount: 3 } });
    const firstButtons = first.findAll("button");
    expect(firstButtons[0]!.attributes("disabled")).toBeDefined();
    expect(firstButtons[1]!.attributes("disabled")).toBeUndefined();

    const last = mount(UiPager, { props: { page: 3, pageCount: 3 } });
    const lastButtons = last.findAll("button");
    expect(lastButtons[0]!.attributes("disabled")).toBeUndefined();
    expect(lastButtons[1]!.attributes("disabled")).toBeDefined();
  });

  it("emits the neighbouring page for each direction", async () => {
    const wrapper = mount(UiPager, { props: { page: 2, pageCount: 5 } });
    const buttons = wrapper.findAll("button");

    await buttons[0]!.trigger("click");
    await buttons[1]!.trigger("click");

    expect(wrapper.emitted("update:page")).toEqual([[1], [3]]);
  });

  it("shows the default position label and lets a slot replace it", () => {
    const plain = mount(UiPager, { props: { page: 2, pageCount: 5 } });
    expect(plain.text()).toContain("第 2 / 5 页");

    const slotted = mount(UiPager, {
      props: { page: 2, pageCount: 5 },
      slots: { default: "第 2 / 5 页 · 共 42 台" },
    });
    expect(slotted.text()).toContain("· 共 42 台");
  });
});
