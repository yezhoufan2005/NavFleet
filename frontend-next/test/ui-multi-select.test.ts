import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";

/**
 * The multi-select dropdown. The parts worth pinning: the trigger summarises the
 * selection (placeholder when empty, the chosen labels joined otherwise), and toggling
 * an item emits the new set in the options' own order without closing the panel.
 */
const OPTIONS = [
  { value: "a", label: "甲" },
  { value: "b", label: "乙" },
  { value: "c", label: "丙" },
];

describe("UiMultiSelect", () => {
  it("shows the placeholder when nothing is selected", () => {
    const wrapper = mount(UiMultiSelect, {
      props: { modelValue: [], options: OPTIONS, placeholder: "全部状态" },
    });
    expect(wrapper.text()).toContain("全部状态");
  });

  it("summarises the selected labels on the trigger", () => {
    const wrapper = mount(UiMultiSelect, {
      props: {
        modelValue: ["a", "c"],
        options: OPTIONS,
        placeholder: "全部状态",
      },
    });
    expect(wrapper.text()).toContain("甲、丙");
    expect(wrapper.text()).not.toContain("全部状态");
  });

  it("toggles a value and emits the set in options order, staying open", async () => {
    const wrapper = mount(UiMultiSelect, {
      props: { modelValue: ["c"], options: OPTIONS },
      attachTo: document.body,
    });
    await wrapper.find("button").trigger("click"); // open the popover

    const item = document.body.querySelector<HTMLElement>(
      "button[role='checkbox'][aria-checked='false']",
    );
    expect(item).toBeTruthy();
    item!.click();

    // Added "a" to the existing "c"; emitted in options order (a before c).
    const emitted = wrapper.emitted("update:modelValue");
    expect(emitted?.at(-1)).toEqual([["a", "c"]]);
    // The panel is still open — multi-select does not close on pick.
    expect(document.body.querySelector("button[role='checkbox']")).toBeTruthy();
    wrapper.unmount();
  });
});
