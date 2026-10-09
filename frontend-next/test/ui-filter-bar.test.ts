import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UiFilterBar from "@/components/ui/UiFilterBar.vue";
import UiFilterField from "@/components/ui/UiFilterField.vue";

/**
 * The two filter-bar layout primitives extracted so every bar (设备 / 消息 / 报表 / 审计 / 外发)
 * stops hand-rolling the same markup. Nothing here has state — the point is the shape they pin:
 * a labelled region, and a caption-over-control field.
 */
describe("UiFilterBar", () => {
  it("is a labelled region defaulting to 筛选, holding its slot", () => {
    const wrapper = mount(UiFilterBar, {
      slots: { default: "<button>甲</button>" },
    });
    const section = wrapper.find("section");
    expect(section.exists()).toBe(true);
    expect(section.attributes("aria-label")).toBe("筛选");
    expect(section.text()).toContain("甲");
  });

  it("takes a custom aria-label so two bars on a page read apart", () => {
    const wrapper = mount(UiFilterBar, {
      props: { ariaLabel: "发送记录筛选" },
    });
    expect(wrapper.find("section").attributes("aria-label")).toBe(
      "发送记录筛选",
    );
  });
});

describe("UiFilterField", () => {
  it("stacks the caption above the slotted control", () => {
    const wrapper = mount(UiFilterField, {
      props: { label: "状态" },
      slots: { default: "<select><option>全部</option></select>" },
    });
    const label = wrapper.find("label");
    expect(label.exists()).toBe(true);
    expect(label.find("span").text()).toBe("状态");
    expect(label.find("select").exists()).toBe(true);
  });
});
