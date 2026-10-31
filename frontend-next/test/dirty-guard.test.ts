import { describe, it, expect, afterEach } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import UiModal from "@/components/ui/UiModal.vue";
import { useDirtySnapshot } from "@/composables/useDirtySnapshot";

enableAutoUnmount(afterEach);

const pressEscape = async (): Promise<void> => {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  await flushPromises();
};

const mountModal = (dirty: boolean, pending = false) => {
  const open = ref(true);
  const wrapper = mount(
    {
      components: { UiModal },
      setup: () => ({ open, dirty, pending }),
      template:
        '<UiModal title="编辑" :open="open" :dirty="dirty" :pending="pending" @update:open="open = $event"><input /></UiModal>',
    },
    { attachTo: document.body },
  );
  return { wrapper, open };
};

describe("UiModal — unsaved-changes guard", () => {
  it("closes on Esc when there is nothing to lose", async () => {
    const { open } = mountModal(false);
    await flushPromises();
    await pressEscape();
    expect(open.value).toBe(false);
  });

  it("stays up on Esc and a backdrop click while a save is in flight", async () => {
    const { open } = mountModal(false, true);
    await flushPromises();
    await pressEscape();
    expect(open.value).toBe(true);
    (
      document.body.querySelector(".bg-scrim\\/55") as HTMLElement
    ).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(open.value).toBe(true);
    expect(document.body.textContent).not.toContain("有未保存的修改");
  });

  it("asks before discarding on Esc, and keeps editing or discards as chosen", async () => {
    const { open } = mountModal(true);
    await flushPromises();
    await pressEscape();
    expect(open.value).toBe(true);
    expect(document.body.textContent).toContain("有未保存的修改");

    const button = (label: string) =>
      [...document.body.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      )!;
    button("继续编辑").click();
    await nextTick();
    expect(document.body.textContent).not.toContain("有未保存的修改");
    expect(open.value).toBe(true);

    await pressEscape();
    button("放弃修改").click();
    await nextTick();
    expect(open.value).toBe(false);
  });
});

describe("useDirtySnapshot", () => {
  it("is clean until marked, dirty after an edit, clean again after re-marking", () => {
    const name = ref("a");
    const tags = ref<string[]>([]);
    const { dirty, mark } = useDirtySnapshot(() => [name.value, tags.value]);
    expect(dirty.value).toBe(false);
    mark();
    expect(dirty.value).toBe(false);
    tags.value = ["x"];
    expect(dirty.value).toBe(true);
    mark();
    expect(dirty.value).toBe(false);
  });
});
