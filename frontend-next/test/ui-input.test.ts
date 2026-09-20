import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UiInput from "@/components/ui/UiInput.vue";

/**
 * The input that ended the four `INPUT_CLASS` heights. Placement and focus live in
 * a browser; what is worth pinning here is the pure contract: the two sizes render
 * their heights, `v-model` round-trips, and fallthrough attributes reach the
 * `<input>` (the reason the component can stay a drop-in for the old raw element).
 */
describe("UiInput", () => {
  it("defaults to the dense size and switches to the tall one on demand", () => {
    const sm = mount(UiInput, { props: { modelValue: "" } });
    expect(sm.classes()).toContain("h-8");

    const md = mount(UiInput, { props: { modelValue: "", size: "md" } });
    expect(md.classes()).toContain("h-10");
  });

  it("shows its model value and emits the next one on input", async () => {
    const wrapper = mount(UiInput, { props: { modelValue: "W05" } });
    const input = wrapper.get("input");
    expect((input.element as HTMLInputElement).value).toBe("W05");

    await input.setValue("A01");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["A01"]);
  });

  it("passes type, placeholder and aria attributes through to the input", () => {
    // inheritAttrs is off so the class stays ours; the point of turning it off is
    // that these still land on the element rather than vanishing.
    const wrapper = mount(UiInput, {
      props: { modelValue: "" },
      attrs: { type: "date", placeholder: "用户名", "aria-label": "操作者" },
    });
    const input = wrapper.get("input");
    expect(input.attributes("type")).toBe("date");
    expect(input.attributes("placeholder")).toBe("用户名");
    expect(input.attributes("aria-label")).toBe("操作者");
  });
});
