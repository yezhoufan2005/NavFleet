<script setup lang="ts">
/**
 * The multi-select dropdown — the second kind of dropdown beside `UiSelect`.
 *
 * `UiSelect` is single-choice and closes on pick (状态=settings like 粒度/每页条数, and
 * single-value filters). This one is for filters where several values make sense at once —
 * 状态 / 场景 — so the model is a `string[]` and, crucially, **it does not close when you
 * tick an item**: picking one almost always means you are about to pick another. It closes
 * on outside-click or Escape, like any popover.
 *
 * Built on Reka's `Popover` rather than `Select` because `Select` is single-value by
 * contract and closes on choose. The options contract mirrors `UiSelect`'s
 * `{ value, label }[]`, so a call site swaps one tag for the other.
 */
import { computed } from "vue";
import {
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from "reka-ui";

export interface UiMultiSelectOption {
  value: string;
  label: string;
}

const {
  modelValue,
  options,
  ariaLabel,
  placeholder = "全部",
  disabled = false,
  fluid = false,
} = defineProps<{
  modelValue: readonly string[];
  options: readonly UiMultiSelectOption[];
  ariaLabel?: string;
  /** Shown on the trigger when nothing is selected — e.g. 全部状态 / 全部场景. */
  placeholder?: string;
  disabled?: boolean;
  /**
   * Fill the container (`w-full`) instead of sizing to content capped at `max-w-56`. The cap keeps
   * a many-item selection from stretching a filter bar; a scope grid cell wants the control to fill
   * its track like the 标签 input beside it, so that layout opts into `fluid`.
   */
  fluid?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [string[]] }>();

const selected = computed(() => new Set(modelValue));

/** The trigger label: the placeholder when empty, otherwise the chosen labels joined. */
const summary = computed(() => {
  if (!modelValue.length) return placeholder;
  return options
    .filter((option) => selected.value.has(option.value))
    .map((option) => option.label)
    .join("、");
});

/** Toggle one value, emitting the new set in the options' own order (stable). */
const toggle = (value: string): void => {
  const next = new Set(selected.value);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  emit(
    "update:modelValue",
    options
      .filter((option) => next.has(option.value))
      .map((option) => option.value),
  );
};
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger
      type="button"
      :disabled="disabled"
      :aria-label="ariaLabel"
      :class="[
        'ui-field flex h-8 items-center justify-between gap-2 rounded-sm border border-border-strong bg-surface-raised px-2 text-sm text-ink transition-colors duration-150 ease-standard hover:border-brand disabled:opacity-50 data-[state=open]:border-brand',
        fluid ? 'w-full' : 'min-w-28 max-w-56',
      ]"
    >
      <!--
        `min-w-0` lets the label shrink below its content so `truncate` can bite; without
        it a flex child keeps its intrinsic width and the trigger grows past `max-w-56`
        instead of ellipsising. The cap keeps a many-item selection (状态/场景 ticked several
        at once) from stretching the filter bar — the panel still lists every choice.
      -->
      <span
        class="min-w-0 truncate"
        :class="{ 'text-ink-subtle': !modelValue.length }"
      >
        {{ summary }}
      </span>
      <svg
        class="size-3 shrink-0 text-ink-subtle"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        side="bottom"
        :side-offset="4"
        align="start"
        class="z-50 max-h-69 min-w-(--reka-popover-trigger-width) overflow-y-auto rounded-md border border-border bg-surface-raised p-1 shadow-overlay"
      >
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          role="checkbox"
          :aria-checked="selected.has(option.value)"
          class="flex w-full cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:bg-surface-sunken hover:text-ink"
          :class="{ 'text-ink': selected.has(option.value) }"
          @click="toggle(option.value)"
        >
          <span class="truncate">{{ option.label }}</span>
          <svg
            v-if="selected.has(option.value)"
            class="size-3.5 shrink-0 text-brand-ink"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>
        <p v-if="!options.length" class="px-2 py-1.5 text-xs text-ink-subtle">
          无可选项
        </p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
