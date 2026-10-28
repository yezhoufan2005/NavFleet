import { describe, it, expect } from "vitest";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { useLatestRequest } from "@/composables/useLatestRequest";

describe("useLatestRequest", () => {
  it("makes every earlier load stale once a newer one begins", () => {
    const { begin } = useLatestRequest();
    const first = begin();
    expect(first()).toBe(true);
    const second = begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("makes an in-flight load stale when its component unmounts", () => {
    let pending: (() => boolean) | null = null;
    const wrapper = mount(
      defineComponent({
        setup() {
          pending = useLatestRequest().begin();
          return () => h("i");
        },
      }),
    );
    expect(pending!()).toBe(true);
    wrapper.unmount();
    expect(pending!()).toBe(false);
  });
});
