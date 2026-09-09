<script setup lang="ts">
/**
 * A select whose list opens **below** the control instead of over it.
 *
 * A native `<select>` cannot do that. Its popup is drawn by the operating system: on
 * macOS it opens centred on the current value, so the chosen option sits exactly on top
 * of the control that was clicked and the label disappears behind the list. Acceptance
 * reported that as the list covering the box, which is precisely what it does. Nothing in
 * CSS reaches it — the only fix is to stop using the native popup.
 *
 * So this is Reka's `Select` in `popper` position, anchored to the bottom edge with a
 * small offset, `avoidCollisions` left on so a control near the bottom of the viewport
 * flips rather than opening off-screen. What that buys beyond placement is the reason to
 * prefer the primitive over a hand-rolled listbox: typeahead, roving focus, Escape,
 * outside-click, `aria-activedescendant`, and the scroll-into-view behaviour of a long
 * list — the parts that are tedious to get right and easy to get subtly wrong.
 *
 * What it costs is a real popup layer, so it is `<Teleport>`ed to the body: inside the
 * devices header the list would otherwise be clipped by the toolbar's own
 * `overflow-hidden`.
 *
 * The value is a **string**, not a generic. It was generic for one call site (回放速度
 * selects numbers), and the cost turned up immediately: `findComponent` cannot resolve a
 * generic SFC to a component definition, so it fell through to the string-selector
 * overload and four test files needed casts to read a prop. One `Number($event)` at the
 * one numeric call site is less total complexity than that.
 */
import { computed } from "vue";
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectViewport,
} from "reka-ui";

export interface UiSelectOption {
  value: string;
  label: string;
}

const {
  modelValue,
  options,
  ariaLabel,
  placeholder,
  disabled = false,
} = defineProps<{
  modelValue: string;
  options: readonly UiSelectOption[];
  /** Required when the control has no visible `<label>` wired to it. */
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [string] }>();

/**
 * Reka models the value as a string internally, so map both ways rather than casting:
 * the option list is the source of truth for which concrete value a string stands for,
 * and an unrecognised one leaves the model untouched.
 *
 * `EMPTY_KEY` is not decoration. Reka (like Radix before it) reserves the empty string
 * for "nothing is selected" and **throws** from `SelectItem` if an option uses it — while
 * this console deliberately has options whose value *is* empty: 全部编队 and 全部设备 are
 * real choices, not sentinels, which is a decision `DevicesView` documents. Substituting a
 * private key here keeps both true: callers pass `""`, the primitive never sees it.
 */
const EMPTY_KEY = "\u0000ui-select-empty";

const asKey = (value: string): string => (value === "" ? EMPTY_KEY : value);

/**
 * What the trigger reads.
 *
 * The last resort used to be `""`, i.e. **a blank control**, and that is reachable in
 * ordinary use rather than only in theory: 告警 keeps its device filter in the URL while
 * building the option list from the devices that *currently have alerts*. Clear the fault
 * and the selected device leaves the list while the filter stays — the operator is then
 * looking at an empty alert list next to a dropdown that looks unset, with nothing saying
 * a filter is in force. (The same shape reaches 编队筛选 when a formation is dropped from
 * `formations.json`, which hot-reloads.)
 *
 * Falling back to the raw `modelValue` is the component's honest answer: it knows the
 * value is not in `options`, and showing it says so. Callers who can phrase it better pass
 * `placeholder` — and `AlertsView` now avoids the case entirely by keeping the filtered
 * device in its own list. `placeholder` had been declared here since 12D with **no caller
 * at all**, which is what left the blank state unfixed.
 */
const selectedLabel = computed(
  () =>
    options.find((option) => option.value === modelValue)?.label ??
    placeholder ??
    modelValue,
);

const onUpdate = (next: unknown): void => {
  const match = options.find((option) => asKey(option.value) === String(next));
  if (match) emit("update:modelValue", match.value);
};
</script>

<template>
  <SelectRoot
    :model-value="asKey(modelValue)"
    :disabled="disabled"
    @update:model-value="onUpdate"
  >
    <SelectTrigger
      :aria-label="ariaLabel"
      class="flex items-center justify-between gap-2 rounded-sm border border-border-strong bg-surface-raised px-2 py-1 text-xs text-ink transition-colors duration-150 ease-standard hover:border-brand disabled:opacity-50 data-[state=open]:border-brand"
    >
      <!--
        Our own text rather than `SelectValue`. Reka resolves the selected label from the
        *item* node, which only exists after the content has mounted once — so before the
        first open the trigger renders empty, and the formation filter would come up blank
        instead of saying 全部编队. The option list is already the source of truth here.
      -->
      <span class="truncate">{{ selectedLabel }}</span>
      <svg
        class="size-3 shrink-0 text-ink-subtle"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        side="bottom"
        :side-offset="4"
        align="start"
        class="z-50 max-h-64 min-w-(--reka-select-trigger-width) overflow-hidden rounded-md border border-border bg-surface-raised shadow-overlay"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="option in options"
            :key="asKey(option.value)"
            :value="asKey(option.value)"
            class="flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-xs text-ink-muted select-none data-[highlighted]:bg-surface-sunken data-[highlighted]:text-ink data-[state=checked]:text-ink"
          >
            <SelectItemText>{{ option.label }}</SelectItemText>
            <SelectItemIndicator class="text-brand-ink" aria-hidden="true">
              ✓
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
