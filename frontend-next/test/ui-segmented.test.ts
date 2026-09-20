import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UiSegmented from "@/components/ui/UiSegmented.vue";

/**
 * The segmented control shared by 报表's time range and 设备's 底图 / 视图 toggles.
 * What is worth pinning: the pressed option is marked (so identity is not colour
 * alone), and clicking one emits its value.
 */
describe("UiSegmented", () => {
  const OPTIONS = [
    { value: "list", label: "列表" },
    { value: "map", label: "地图" },
  ] as const;

  it("marks the selected option as pressed and the rest not", () => {
    const wrapper = mount(UiSegmented, {
      props: { modelValue: "map", options: [...OPTIONS], ariaLabel: "视图" },
    });
    const [list, map] = wrapper.findAll("button");
    expect(list!.attributes("aria-pressed")).toBe("false");
    expect(map!.attributes("aria-pressed")).toBe("true");
    expect(wrapper.find("[aria-label='视图']").exists()).toBe(true);
  });

  it("emits the clicked option's value", async () => {
    const wrapper = mount(UiSegmented, {
      props: { modelValue: "map", options: [...OPTIONS], ariaLabel: "视图" },
    });
    await wrapper.findAll("button")[0]!.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]).toEqual(["list"]);
  });
});
