<script setup lang="ts">
/**
 * The search input — `UiInput type="search"` fixed at one shared width.
 *
 * Every filter bar had rolled its own `type="search"` box (消息 / 设备 / 审计 / 外发), each sized by
 * whatever sat around it, so they lined up at different widths down the page. This is that box
 * once, at a single fixed `w-72` (18rem) with `shrink-0` so a crowded filter bar cannot squeeze it
 * narrower and the width never tracks the placeholder length — every search field is exactly the
 * same width. Native `type="search"` keeps the `searchbox` role and the browser's clear button;
 * `enter` is forwarded so a caller that debounces can commit immediately on Enter.
 */
import UiInput from "@/components/ui/UiInput.vue";

const { modelValue, placeholder, ariaLabel } = defineProps<{
  modelValue: string;
  placeholder?: string;
  ariaLabel?: string;
}>();

defineEmits<{ "update:modelValue": [string]; enter: [] }>();
</script>

<template>
  <UiInput
    type="search"
    class="w-72 shrink-0"
    :model-value="modelValue"
    :placeholder="placeholder"
    :aria-label="ariaLabel"
    @update:model-value="(value) => $emit('update:modelValue', value)"
    @keydown.enter.prevent="$emit('enter')"
  />
</template>
