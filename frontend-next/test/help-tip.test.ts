import { describe, it, expect, afterEach } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import UiHelpTip from "@/components/ui/UiHelpTip.vue";
import { FIELD_HELP } from "@/lib/fieldHelp";

enableAutoUnmount(afterEach);

const tipText = (): string =>
  document.body.querySelector('[role="tooltip"]')?.textContent?.trim() ?? "";

describe("UiHelpTip", () => {
  it("is a focusable button that carries the text as its accessible description", () => {
    const wrapper = mount(UiHelpTip, {
      props: { text: "底图每个像素代表的实际长度（米）" },
      attachTo: document.body,
    });
    const button = wrapper.get("button");
    expect(button.attributes("type")).toBe("button");
    expect(button.attributes("aria-label")).toBe("字段说明");
    // Screen readers get the explanation with the button, independent of the visible tip.
    expect(button.attributes("aria-description")).toBe(
      "底图每个像素代表的实际长度（米）",
    );
  });

  it("toggles the tip on click (touch has no hover) without submitting a surrounding form", async () => {
    let submitted = false;
    const wrapper = mount(
      {
        components: { UiHelpTip },
        template:
          '<form @submit.prevent="onSubmit"><UiHelpTip text="说明文字" /></form>',
        methods: {
          onSubmit() {
            submitted = true;
          },
        },
      },
      { attachTo: document.body },
    );
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(tipText()).toContain("说明文字");
    expect(submitted).toBe(false);
  });
});

describe("FIELD_HELP", () => {
  it("has a non-empty sentence for every field", () => {
    for (const [page, fields] of Object.entries(FIELD_HELP)) {
      for (const [field, text] of Object.entries(fields)) {
        expect(text.trim().length, `${page}.${field}`).toBeGreaterThan(4);
      }
    }
  });
});
