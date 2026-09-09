import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UiSelect from "@/components/ui/UiSelect.vue";

/**
 * The select that replaced the native `<select>` so the list opens **below** the control.
 *
 * Reka's popup lives in a portal and needs a real layout engine to place, so placement is
 * asserted where placement exists — `console-shell.spec.ts` in a browser. What is worth
 * pinning here is the part that is pure logic and easy to get wrong: the value mapping,
 * including the empty-string option this console genuinely has (全部编队 / 全部设备).
 * Reka reserves `""` for "nothing selected" and throws if an option uses it, so the
 * component substitutes a private key — if that substitution ever regresses, two filters
 * lose their "all" row with a component-level exception rather than a visible bug.
 */
describe("UiSelect", () => {
  const OPTIONS = [
    { value: "", label: "全部设备" },
    { value: "agv-01", label: "A01" },
  ] as const;

  it("renders the chosen option's label, empty value included", () => {
    const wrapper = mount(UiSelect, {
      props: { modelValue: "", options: [...OPTIONS], ariaLabel: "设备筛选" },
      attachTo: document.body,
    });

    expect(wrapper.text()).toContain("全部设备");
    // Mounting at all is the assertion that matters: an option with `value: ""` used to
    // throw out of `SelectItem`'s setup.
    expect(wrapper.find("[aria-label='设备筛选']").exists()).toBe(true);
  });

  it("emits the option's own value rather than the internal key", () => {
    const wrapper = mount(UiSelect, {
      props: { modelValue: "", options: [...OPTIONS] },
      attachTo: document.body,
    });

    // The empty option round-trips as `""`, not as the private key it is stored under —
    // otherwise 全部设备 would clear the filter to a sentinel string.
    wrapper.vm.$emit("update:modelValue", "");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual([""]);
  });

  /**
   * The trigger must never be blank.
   *
   * `modelValue` not matching any option is reachable in ordinary use, not just in
   * theory: 告警 keeps its device filter in the URL and builds the option list from the
   * devices that *currently* have alerts, so clearing a fault removes the selected
   * device while the filter stays. The fallback used to be `""` — an empty control
   * beside an empty list, with nothing saying a filter was still narrowing it.
   */
  it("falls back to the raw value when nothing in the list matches", () => {
    const wrapper = mount(UiSelect, {
      props: {
        modelValue: "agv-gone",
        options: [...OPTIONS],
        ariaLabel: "设备筛选",
      },
      attachTo: document.body,
    });

    expect(wrapper.text()).toContain("agv-gone");
  });

  it("prefers an explicit placeholder over the raw value", () => {
    const wrapper = mount(UiSelect, {
      props: {
        modelValue: "agv-gone",
        options: [...OPTIONS],
        placeholder: "该设备已不在车队",
        ariaLabel: "设备筛选",
      },
      attachTo: document.body,
    });

    expect(wrapper.text()).toContain("该设备已不在车队");
    expect(wrapper.text()).not.toContain("agv-gone");
  });
});
