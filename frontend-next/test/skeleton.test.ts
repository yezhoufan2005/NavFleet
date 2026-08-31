import { describe, it, expect, afterEach } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import UiSkeleton from "@/components/ui/UiSkeleton.vue";

/**
 * The loading placeholder, restored in 13T-B.
 *
 * v1.0.0 had it; `frontend-next` had zero `*keleton*` files while `stores/fleet.ts`
 * still claimed "Views render skeletons while it is set" — a comment asserting a fact
 * the code had stopped providing. These cases pin the two properties that make it worth
 * having rather than just decorative.
 */
enableAutoUnmount(afterEach);

describe("the skeleton placeholder", () => {
  it("renders one bar per requested row", () => {
    expect(
      mount(UiSkeleton, { props: { rows: 4 } }).findAll(".skeleton"),
    ).toHaveLength(4);
  });

  it("is hidden from assistive tech, because the region says `aria-busy` instead", () => {
    // The half that is easy to get wrong. The shimmer means "loading" *visually*; a
    // screen reader reading out four empty boxes learns nothing about why they are
    // empty, so the announcement belongs on the region that owns the placeholders.
    const wrapper = mount(UiSkeleton, { props: { rows: 2 } });

    expect(wrapper.get(".skeleton-stack").attributes("aria-hidden")).toBe(
      "true",
    );
    // And no bar carries a role or label of its own that would leak through.
    for (const bar of wrapper.findAll(".skeleton")) {
      expect(bar.attributes("role")).toBeUndefined();
      expect(bar.attributes("aria-label")).toBeUndefined();
    }
  });

  it("offers the three shapes the callers need, and defaults to a line", () => {
    expect(mount(UiSkeleton).find(".skeleton-line").exists()).toBe(true);
    expect(
      mount(UiSkeleton, { props: { variant: "value" } })
        .find(".skeleton-value")
        .exists(),
    ).toBe(true);
    expect(
      mount(UiSkeleton, { props: { variant: "card" } })
        .find(".skeleton-card")
        .exists(),
    ).toBe(true);
  });
});
