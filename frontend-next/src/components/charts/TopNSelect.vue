<script setup lang="ts">
/**
 * A compact "Top 几" selector for the ranking charts' header row.
 *
 * Every Top-N chart (消息史 的设备排行，后续其他排行同理) used to hard-code its cut-off; this lets the
 * operator pick it instead. The model is a number — `Infinity` stands for 全部, so a caller slices
 * with `slice(0, modelValue)` and gets everything when 全部 is chosen. Built on `UiSelect` (string
 * values internally), so it inherits the console's one dropdown behaviour and styling.
 */
import { computed } from "vue";
import UiSelect from "@/components/ui/UiSelect.vue";

const {
  modelValue,
  choices = [5, 10, 20],
  ariaLabel = "显示的数量",
} = defineProps<{
  /** Current cut-off; `Infinity` means 全部. */
  modelValue: number;
  /** Numeric presets offered before the 全部 option. */
  choices?: readonly number[];
  ariaLabel?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [number] }>();

const ALL_KEY = "all";

const options = computed(() => [
  ...choices.map((count) => ({ value: String(count), label: `Top ${count}` })),
  { value: ALL_KEY, label: "全部" },
]);

const selected = computed(() =>
  Number.isFinite(modelValue) ? String(modelValue) : ALL_KEY,
);

const onUpdate = (value: string): void => {
  emit(
    "update:modelValue",
    value === ALL_KEY ? Number.POSITIVE_INFINITY : Number(value),
  );
};
</script>

<template>
  <UiSelect
    :model-value="selected"
    :options="options"
    :aria-label="ariaLabel"
    @update:model-value="onUpdate"
  />
</template>
