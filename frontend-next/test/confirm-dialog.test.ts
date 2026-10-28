import { describe, it, expect, afterEach } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";

enableAutoUnmount(afterEach);

const overlay = (): HTMLElement =>
  document.body.querySelector(".bg-scrim\\/55") as HTMLElement;

describe("UiConfirmDialog", () => {
  it("cancels on a click outside, like every other dialog", async () => {
    const wrapper = mount(UiConfirmDialog, {
      props: { open: true, title: "下线该设备？" },
      attachTo: document.body,
    });
    await flushPromises();
    overlay().click();
    await flushPromises();
    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
    expect(wrapper.emitted("confirm")).toBeUndefined();
  });

  it("stays up while the action is in flight", async () => {
    const wrapper = mount(UiConfirmDialog, {
      props: { open: true, title: "下线该设备？", pending: true },
      attachTo: document.body,
    });
    await flushPromises();
    overlay().click();
    await flushPromises();
    expect(wrapper.emitted("update:open")).toBeUndefined();
  });
});
