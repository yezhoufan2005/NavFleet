import { describe, it, expect, afterEach } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import UiHoverMenu from "@/components/ui/UiHoverMenu.vue";

/**
 * The export button's dropdown: hover opens it (and the pointer can cross into the panel without
 * it closing — that bridge is the panel's own padding, exercised in the browser), a click pins it
 * open so the pointer can leave, and a second click / outside click / Escape unpins it.
 */
enableAutoUnmount(afterEach);

const mountMenu = () =>
  mount(UiHoverMenu, {
    props: { label: "导出" },
    slots: { trigger: "导出 ↗", default: "<button>项A</button>" },
    attachTo: document.body,
  });

const menu = (wrapper: ReturnType<typeof mountMenu>) =>
  wrapper.get('[role="menu"]');
const trigger = (wrapper: ReturnType<typeof mountMenu>) =>
  wrapper.findAll("button")[0]!;

describe("UiHoverMenu", () => {
  it("悬停展开、移出收起", async () => {
    const wrapper = mountMenu();
    expect(menu(wrapper).isVisible()).toBe(false);

    await wrapper.trigger("mouseenter");
    expect(menu(wrapper).isVisible()).toBe(true);
    expect(trigger(wrapper).attributes("aria-expanded")).toBe("true");

    await wrapper.trigger("mouseleave");
    expect(menu(wrapper).isVisible()).toBe(false);
  });

  it("点击固定后移出仍开，再点关闭", async () => {
    const wrapper = mountMenu();

    await trigger(wrapper).trigger("click");
    await wrapper.trigger("mouseleave");
    // Pinned: leaving the hover does not close it.
    expect(menu(wrapper).isVisible()).toBe(true);

    await trigger(wrapper).trigger("click");
    expect(menu(wrapper).isVisible()).toBe(false);
  });

  it("固定后点击外部或按 Esc 收起", async () => {
    const wrapper = mountMenu();
    await trigger(wrapper).trigger("click");
    expect(menu(wrapper).isVisible()).toBe(true);

    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    await wrapper.vm.$nextTick();
    expect(menu(wrapper).isVisible()).toBe(false);

    // And Escape closes a re-pinned menu.
    await trigger(wrapper).trigger("click");
    expect(menu(wrapper).isVisible()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    expect(menu(wrapper).isVisible()).toBe(false);
  });
});
