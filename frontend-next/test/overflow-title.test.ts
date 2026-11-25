import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, h, ref, withDirectives, nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { vOverflowTitle } from "@/directives/overflowTitle";

enableAutoUnmount(afterEach);

/** jsdom lays nothing out, so each case states the box and content sizes it needs. */
const sized = (el: HTMLElement, box: number, content: number): void => {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: box });
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    value: content,
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 20 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 20 });
};

const host = (text: () => string, override?: () => string | undefined) =>
  defineComponent({
    setup: () => () =>
      withDirectives(h("span", text()), [[vOverflowTitle, override?.()]]),
  });

describe("v-overflow-title", () => {
  it("shows the full text on hover only while the text is cut", async () => {
    const text = ref("一个很长很长的设备名称");
    const wrapper = mount(host(() => text.value));
    const el = wrapper.element as HTMLElement;

    sized(el, 200, 200);
    text.value = "一个很长很长的设备名称 ";
    await nextTick();
    expect(el.hasAttribute("title")).toBe(false);

    sized(el, 80, 200);
    text.value = "一个很长很长的设备名称";
    await nextTick();
    expect(el.getAttribute("title")).toBe("一个很长很长的设备名称");
  });

  it("counts a clamped (multi-line) block as cut too", async () => {
    const text = ref("x");
    const wrapper = mount(host(() => text.value));
    const el = wrapper.element as HTMLElement;
    sized(el, 200, 200);
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      value: 60,
    });
    text.value = "两行之后还有第三行";
    await nextTick();
    expect(el.getAttribute("title")).toBe("两行之后还有第三行");
  });

  it("can show a value other than the element's own text", async () => {
    const text = ref("agv-r01-…-0001");
    const wrapper = mount(
      host(
        () => text.value,
        () => "agv-r01-20261125-0001",
      ),
    );
    const el = wrapper.element as HTMLElement;
    sized(el, 80, 200);
    text.value = "agv-r01-…-0001 ";
    await nextTick();
    expect(el.getAttribute("title")).toBe("agv-r01-20261125-0001");
  });
});
