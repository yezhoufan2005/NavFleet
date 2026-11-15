<script setup lang="ts">
/**
 * The search input — `UiInput type="search"` fixed at one shared width.
 *
 * Every filter bar had rolled its own `type="search"` box (消息 / 设备 / 审计 / 外发), each sized by
 * whatever sat around it, so they lined up at different widths down the page. This is that box
 * once, bounded `min-w-36`…`max-w-72` (9–18rem): it never collapses below a readable floor nor
 * grows past 18rem, so every search field reads within the same band. Native `type="search"` keeps
 * the `searchbox` role and the browser's clear button; `enter` is forwarded so a caller that
 * debounces can commit immediately on Enter.
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
    class="w-full min-w-36 max-w-72"
    :model-value="modelValue"
    :placeholder="placeholder"
    :aria-label="ariaLabel"
    @update:model-value="(value) => $emit('update:modelValue', value)"
    @keydown.enter.prevent="$emit('enter')"
  />
</template>
