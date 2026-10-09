import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UiPager from "@/components/ui/UiPager.vue";

/**
 * The shared pager. Two behaviours are new (设备 opts into them via `jump`): staying
 * visible on a single page, and a page-number jump input. Everything else — the
 * disabled edges and the `update:page` emit — is the long-standing shape.
 */
describe("UiPager", () => {
  it("renders nothing on a single page without `jump` (the default)", () => {
    const wrapper = mount(UiPager, { props: { page: 1, pageCount: 1 } });
    expect(wrapper.find("button").exists()).toBe(false);
  });

  it("stays visible on a single page when `jump` is set, with edges disabled", () => {
    const wrapper = mount(UiPager, {
      props: { page: 1, pageCount: 1, jump: true },
    });
    const next = wrapper
      .findAll("button")
      .find((button) => button.text() === "下一页");
    expect(next).toBeTruthy();
    expect(next!.attributes("disabled")).toBeDefined();
    // No jump input while there is only one page — there is nowhere to jump.
    expect(wrapper.find("input[aria-label='跳转到页码']").exists()).toBe(false);
  });

  it("jumps to a typed page, clamped to range", async () => {
    const wrapper = mount(UiPager, {
      props: { page: 1, pageCount: 5, jump: true },
    });
    const input = wrapper.find("input[aria-label='跳转到页码']");
    expect(input.exists()).toBe(true);

    await input.setValue("3");
    await input.trigger("change");
    expect(wrapper.emitted("update:page")?.at(-1)).toEqual([3]);

    // Out of range is clamped rather than emitted raw.
    await input.setValue("99");
    await input.trigger("change");
    expect(wrapper.emitted("update:page")?.at(-1)).toEqual([5]);
  });
});
