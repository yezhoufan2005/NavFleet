<script setup lang="ts">
/**
 * A dropdown that opens on hover and can be pinned open by a click — the pattern the 报表 export
 * button wanted and a plain `group-hover` could not give: a CSS hover menu drops the moment the
 * pointer crosses the gap to its items, so you can see the options but never reach them.
 *
 * Two independent "open" reasons, OR'd together:
 * - **hover**: pointer over the trigger *or* the panel. The panel is a DOM child of the root and
 *   sits flush under the trigger (the gap is the panel's own padding, so it is hoverable), so
 *   moving from button to item never leaves the root and never closes.
 * - **pinned**: a click on the trigger latches it open so the pointer can roam anywhere; a second
 *   click, an outside click, or Escape unlatches it.
 *
 * Keyboard: the trigger is a real button — Enter/Space pins it open, then Tab reaches the items;
 * Escape closes. Mouse users get hover. `aria-haspopup`/`aria-expanded` describe it either way.
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";

const { align = "end", label } = defineProps<{
  /** Which edge of the trigger the panel aligns to. */
  align?: "start" | "end";
  /** Accessible name for the trigger. */
  label: string;
}>();

const root = useTemplateRef<HTMLElement>("root");
const hovering = ref(false);
const pinned = ref(false);
const open = computed(() => hovering.value || pinned.value);

const togglePin = (): void => {
  pinned.value = !pinned.value;
};
/** Items call this to dismiss after acting; also used by Escape / outside-click. */
const close = (): void => {
  pinned.value = false;
  hovering.value = false;
};

// An outside click or Escape only needs listening to while pinned (hover closes itself).
const onDocPointerDown = (event: MouseEvent): void => {
  if (!root.value?.contains(event.target as Node)) close();
};
const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") close();
};
watch(pinned, (isPinned) => {
  if (isPinned) {
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKeydown);
  } else {
    document.removeEventListener("pointerdown", onDocPointerDown);
    document.removeEventListener("keydown", onKeydown);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div
    ref="root"
    class="relative inline-block"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
  >
    <button
      type="button"
      class="inline-flex h-8 items-center gap-1.5 rounded-sm border border-border-strong bg-surface-raised px-3 text-sm font-medium whitespace-nowrap text-ink transition-colors duration-150 ease-standard hover:bg-surface-sunken"
      :aria-haspopup="'menu'"
      :aria-expanded="open"
      @click="togglePin"
    >
      <slot name="trigger">{{ label }}</slot>
    </button>

    <!-- The panel sits flush under the trigger (`top-full`); the visible gap is its own `pt-1`
         padding, so the pointer never crosses a non-hoverable void between the two. -->
    <div
      v-show="open"
      class="absolute top-full z-20 pt-1"
      :class="align === 'end' ? 'right-0' : 'left-0'"
    >
      <div
        role="menu"
        :aria-label="label"
        class="flex min-w-36 flex-col gap-0.5 rounded-md border border-border bg-surface-raised p-1 shadow-lg"
      >
        <slot :close="close" />
      </div>
    </div>
  </div>
</template>
