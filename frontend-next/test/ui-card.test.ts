import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import UiCard from "@/components/ui/UiCard.vue";

/**
 * The shared card frame. Worth pinning: the padding scale resolves to a class, the
 * optional header only renders when there's a title or header slot (so bare cards stay
 * bare), and `as` lets a card become a labelled landmark.
 */
describe("UiCard", () => {
  it("is a bare framed div with default padding and no header", () => {
    const wrapper = mount(UiCard, { slots: { default: "body" } });
    const root = wrapper.get("div");
    expect(root.classes()).toEqual(
      expect.arrayContaining([
        "rounded-md",
        "border",
        "border-border",
        "bg-surface-raised",
        "p-4",
      ]),
    );
    expect(wrapper.find("h3").exists()).toBe(false);
  });

  it("renders a title into a header only when asked", () => {
    const wrapper = mount(UiCard, {
      props: { title: "编队情况" },
      slots: { default: "body" },
    });
    expect(wrapper.get("h3").text()).toBe("编队情况");
  });

  it("maps the padding scale and can drop padding for full-bleed content", () => {
    expect(
      mount(UiCard, { props: { padding: "sm" } })
        .get("div")
        .classes(),
    ).toContain("p-3");
    const none = mount(UiCard, { props: { padding: "none" } }).get("div");
    expect(none.classes()).not.toContain("p-4");
    expect(none.classes()).not.toContain("p-3");
  });

  it("becomes a labelled landmark through `as` with fallthrough attrs", () => {
    const wrapper = mount(UiCard, {
      props: { as: "section" },
      attrs: { "aria-label": "待处理项" },
    });
    const section = wrapper.get("section");
    expect(section.attributes("aria-label")).toBe("待处理项");
  });
});
