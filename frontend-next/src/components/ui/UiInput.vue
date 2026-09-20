<script setup lang="ts">
/**
 * The text input.
 *
 * It exists for the same reason `UiButton` does: before it, every view declared
 * its own `INPUT_CLASS` constant, and they drifted to four different heights
 * (h-7/h-8/h-9/h-10) with three padding/text combinations. A filter input then
 * sat visibly taller or shorter than the `UiSelect` beside it. One component,
 * two principled sizes, ends that.
 *
 * - `sm` (default, h-8) is the dense size for filter bars and toolbars, and is
 *   the height `UiSelect`'s trigger is tuned to match so the two line up.
 * - `md` (h-10) is for real data entry — the login and profile forms, dialog
 *   fields — where a taller target reads as "type here".
 *
 * Everything else (`type`, `placeholder`, `min`/`max`, `@keyup.enter`, `aria-*`)
 * flows through as fallthrough attributes, so the call site stays a plain
 * `<UiInput v-model="x" type="date" />`. `inheritAttrs` is off only so those
 * attributes land on the `<input>` and not on nothing — the class is ours.
 */
type Size = "sm" | "md";

const { modelValue, size = "sm" } = defineProps<{
  modelValue: string;
  size?: Size;
}>();

defineEmits<{ "update:modelValue": [string] }>();

defineOptions({ inheritAttrs: false });

const SIZES: Record<Size, string> = {
  sm: "h-8 px-2 text-sm",
  md: "h-10 px-3 text-base",
};
</script>

<template>
  <input
    :value="modelValue"
    v-bind="$attrs"
    :class="[
      'rounded-sm border border-border-strong bg-surface-raised text-ink',
      'placeholder:text-ink-subtle transition-colors duration-150 ease-standard',
      'hover:border-brand',
      'disabled:cursor-not-allowed disabled:opacity-55',
      SIZES[size],
    ]"
    @input="
      $emit('update:modelValue', ($event.target as HTMLInputElement).value)
    "
  />
</template>
