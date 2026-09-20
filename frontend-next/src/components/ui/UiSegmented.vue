<script setup lang="ts">
/**
 * The segmented control — a row of buttons where exactly one is pressed.
 *
 * Three of these had been hand-written (报表 time range, 设备 底图 / 视图), each with
 * its own copy of the same `flex … rounded-sm border` shell and per-button classes,
 * and they drifted — different heights from the inputs beside them. This is that
 * control once, at the shared `h-8` so it lines up with `UiInput` and `UiSelect`.
 *
 * Like `UiSelect`, the value is a plain `string` rather than a generic: the call
 * site maps it back to its own union with a cast, which is less total complexity
 * than making every consumer's test resolve a generic component.
 */
export interface UiSegmentedOption {
  value: string;
  label: string;
}

const { modelValue, options, ariaLabel } = defineProps<{
  modelValue: string;
  options: readonly UiSegmentedOption[];
  /** Accessible name for the group. Follows `UiSelect`: optional at the type level,
   *  passed by every call site as the control has no visible `<label>` of its own. */
  ariaLabel?: string;
}>();

defineEmits<{ "update:modelValue": [string] }>();
</script>

<template>
  <div
    class="flex h-8 overflow-hidden rounded-sm border border-border-strong"
    role="group"
    :aria-label="ariaLabel"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="flex items-center px-3 text-sm transition-colors duration-150 ease-standard"
      :class="
        modelValue === option.value
          ? 'bg-brand text-brand-contrast'
          : 'bg-surface-raised text-ink-muted hover:text-ink'
      "
      :aria-pressed="modelValue === option.value"
      @click="$emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
