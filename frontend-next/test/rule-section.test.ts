import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import RuleSection from "@/components/admin/RuleSection.vue";

/**
 * The extracted per-rule block (启用 + 作用范围 + a knobs slot). The integration is exercised in
 * rules-view.test; this pins the parts the parent relies on: the slot gets a `disabled` that folds
 * in the enabled state, enable toggles emit, and the union-scope hint is present.
 */
const base = {
  title: "低电量预警",
  scopeLabel: "低电量",
  scope: { deviceIds: [], formationIds: [], tags: "" },
  deviceOptions: [{ value: "agv-1", label: "A01" }],
  formationOptions: [{ value: "line-a", label: "A 线" }],
};

describe("RuleSection", () => {
  it("hands the knobs slot a disabled that is true when the rule is off", () => {
    const wrapper = mount(RuleSection, {
      props: { ...base, enabled: false },
      slots: {
        default: `<template #default="{ disabled }"><span class="knob" :data-disabled="disabled" /></template>`,
      },
    });
    expect(wrapper.find(".knob").attributes("data-disabled")).toBe("true");
  });

  it("keeps the knobs enabled when the rule is on and not saving", () => {
    const wrapper = mount(RuleSection, {
      props: { ...base, enabled: true, disabled: false },
      slots: {
        default: `<template #default="{ disabled }"><span class="knob" :data-disabled="disabled" /></template>`,
      },
    });
    expect(wrapper.find(".knob").attributes("data-disabled")).toBe("false");
  });

  it("emits the enabled toggle and shows the union-scope hint", async () => {
    const wrapper = mount(RuleSection, { props: { ...base, enabled: true } });
    await wrapper.find("input[type='checkbox']").setValue(false);
    expect(wrapper.emitted("update:enabled")?.at(-1)).toEqual([false]);
    expect(wrapper.text()).toContain("任一命中即纳入");
    expect(wrapper.text()).toContain("全车队");
  });
});
