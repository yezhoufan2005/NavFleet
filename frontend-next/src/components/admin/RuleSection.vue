<script setup lang="ts">
/**
 * One rule's editor block — the shape the 低电量预警 and 设备离线 rules share: an 启用 toggle, the
 * rule's own knobs (the default slot), and a 作用范围 (设备 / 编队 multi-select + 标签 free text).
 *
 * Extracted because the two rules were two near-identical `<section>`s in `RulesView`, and the
 * 作用范围 block was copied verbatim — so a tweak to one drifted from the other. The knobs are the
 * only part that differs between rules, so they come in through the slot, which is handed a
 * `disabled` flag (true while saving *or* the rule is off) so a rule's inputs grey out together.
 *
 * `scope` is a plain model object (not the wire `RuleScope`): 设备/编队 as id arrays, 标签 as comma
 * text. Empty across all three means whole-fleet; the three dimensions are a **union** (a vehicle
 * matched by any of them is in scope) — the hint under the fieldset says so.
 */
import UiInput from "@/components/ui/UiInput.vue";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";

export interface RuleScopeModel {
  deviceIds: string[];
  formationIds: string[];
  tags: string;
}
export interface ScopeOption {
  value: string;
  label: string;
}

const {
  enabled,
  scope,
  scopeLabel,
  deviceOptions,
  formationOptions,
  disabled,
} = defineProps<{
  title: string;
  enabled: boolean;
  scope: RuleScopeModel;
  /** aria-label prefix so two sections' controls read apart, e.g. 低电量 / 离线. */
  scopeLabel: string;
  deviceOptions: readonly ScopeOption[];
  formationOptions: readonly ScopeOption[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:enabled": [boolean];
  "update:scope": [RuleScopeModel];
}>();

/** Keep an already-selected id listed even if it has left the fleet, so it can still be removed. */
const mergeOptions = (
  base: readonly ScopeOption[],
  selected: readonly string[],
): ScopeOption[] => {
  const known = new Set(base.map((option) => option.value));
  return [
    ...base,
    ...selected
      .filter((value) => !known.has(value))
      .map((value) => ({ value, label: value })),
  ];
};

const patchScope = (patch: Partial<RuleScopeModel>): void =>
  emit("update:scope", { ...scope, ...patch });
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
    :aria-label="title"
  >
    <label class="flex items-center gap-2 text-md font-semibold text-ink">
      <input
        type="checkbox"
        class="size-4"
        :checked="enabled"
        :disabled="disabled"
        @change="
          emit('update:enabled', ($event.target as HTMLInputElement).checked)
        "
      />
      {{ title }}
    </label>

    <!-- The rule's own knobs; greyed out together with the rule. -->
    <slot :disabled="disabled || !enabled" />

    <fieldset class="flex flex-col gap-2 border-0 p-0">
      <legend class="mb-1 text-sm font-medium text-ink">作用范围</legend>
      <div class="grid grid-cols-3 gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-2xs text-ink-muted">设备</span>
          <UiMultiSelect
            :model-value="scope.deviceIds"
            :options="mergeOptions(deviceOptions, scope.deviceIds)"
            placeholder="不限"
            :aria-label="`${scopeLabel}作用范围：设备`"
            :disabled="disabled"
            fluid
            @update:model-value="(value) => patchScope({ deviceIds: value })"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-2xs text-ink-muted">编队</span>
          <UiMultiSelect
            :model-value="scope.formationIds"
            :options="mergeOptions(formationOptions, scope.formationIds)"
            placeholder="不限"
            :aria-label="`${scopeLabel}作用范围：编队`"
            :disabled="disabled"
            fluid
            @update:model-value="(value) => patchScope({ formationIds: value })"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-2xs text-ink-muted">标签</span>
          <UiInput
            :model-value="scope.tags"
            type="text"
            placeholder="逗号分隔"
            :disabled="disabled"
            size="sm"
            @update:model-value="(value) => patchScope({ tags: value })"
          />
        </label>
      </div>
      <p class="m-0 text-2xs text-ink-subtle">
        设备 / 编队 / 标签 任一命中即纳入；三者全部留空＝全车队
      </p>
    </fieldset>
  </section>
</template>
