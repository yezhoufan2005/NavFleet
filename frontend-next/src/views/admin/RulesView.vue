<script setup lang="ts">
/**
 * 消息规则 — the alert-rule editor (admin, 1.6.1; a tab of the 消息 section since 1.6.2), the
 * console face of `rules.json`.
 *
 * The rules config is a fixed shape — a low-battery rule and an offline rule — so this is one
 * whole-config form (read-modify-write the whole object, like the codebook/vehicles writes), not a
 * list with dialogs. Each rule carries: 启用, a 作用范围 (设备 / 编队 / 标签, empty = whole fleet),
 * and its own knob (low-battery: 阈值% + 防抖秒; offline: 离线判定秒). The backend is the authority
 * (`PUT /rules/config` re-validates and merges over the built-in defaults); a refused write comes
 * back as `invalid_rules` and is mapped to a sentence.
 *
 * 只读红线：retuning thresholds / toggling a rule is deployment-domain config, not vehicle command
 * dispatch — this writes a config file, it does not steer a vehicle.
 */
import { computed, onMounted, ref } from "vue";
import { fleetApi } from "@navfleet/fleet-core";
import {
  DEFAULT_ALERT_RULES,
  type AlertRulesConfig,
  type RuleScope,
} from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";
import { useFleetStore } from "@/stores/fleet";
import { makeMessageFor } from "@/lib/errorMessages";
import { notify as toast } from "@/composables/useNotifications";

const fleet = useFleetStore();

const ERROR_MESSAGES: Record<string, string> = {
  invalid_rules: "规则校验未通过，请检查阈值与时间后重试",
};
const messageFor = makeMessageFor(ERROR_MESSAGES);

const status = ref<"loading" | "ready" | "error">("loading");
const saving = ref(false);
const formError = ref("");

// ── Editable form state (flattened from the config; 设备/编队 scope as id arrays, 标签 as comma text) ──
const lbEnabled = ref(true);
const lbThreshold = ref("20");
const lbDebounce = ref("0");
const offEnabled = ref(true);
const offAfter = ref("");

/**
 * 设备 / 编队 are picked from the live fleet (multi-select) rather than typed, so a scope can only
 * name things that exist; 标签 stays free text because tags are arbitrary and have no roster. A
 * scope id configured for a device/formation that has since left the fleet is kept selectable (see
 * `mergeOptions`) so it can still be removed.
 */
interface ScopeModel {
  deviceIds: string[];
  formationIds: string[];
  tags: string;
}
const lbScope = ref<ScopeModel>({ deviceIds: [], formationIds: [], tags: "" });
const offScope = ref<ScopeModel>({ deviceIds: [], formationIds: [], tags: "" });

const scopeToModel = (scope?: RuleScope): ScopeModel => ({
  deviceIds: [...(scope?.deviceIds ?? [])],
  formationIds: [...(scope?.formationIds ?? [])],
  tags: (scope?.tags ?? []).join(", "),
});
const splitList = (text: string): string[] =>
  text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
/** Only include a `scope` when some dimension is listed — an empty scope means whole-fleet. */
const modelToScope = (model: ScopeModel): RuleScope | undefined => {
  const scope: RuleScope = {};
  const tags = splitList(model.tags);
  if (model.deviceIds.length) scope.deviceIds = [...model.deviceIds];
  if (model.formationIds.length) scope.formationIds = [...model.formationIds];
  if (tags.length) scope.tags = tags;
  return model.deviceIds.length || model.formationIds.length || tags.length
    ? scope
    : undefined;
};

/** Options from the live fleet, name-labelled; sorted lists already come from the store. */
const deviceOptions = computed(() =>
  fleet.sortedDevices.map((device) => ({
    value: device.deviceId,
    label: device.deviceName || device.deviceId,
  })),
);
const formationOptions = computed(() =>
  fleet.sortedFormations.map((formation) => ({
    value: formation.formationId,
    label: formation.formationName || formation.formationId,
  })),
);
/** Keep already-selected ids listed even if they are no longer in the fleet, so they can be unset. */
const mergeOptions = (
  base: { value: string; label: string }[],
  selected: readonly string[],
): { value: string; label: string }[] => {
  const known = new Set(base.map((option) => option.value));
  return [
    ...base,
    ...selected
      .filter((value) => !known.has(value))
      .map((value) => ({ value, label: value })),
  ];
};

/** The last config the server confirmed — the thing 撤销 restores to. */
const lastSaved = ref<AlertRulesConfig | null>(null);

const applyConfig = (config: AlertRulesConfig): void => {
  lbEnabled.value = config.lowBattery.enabled;
  lbThreshold.value = String(config.lowBattery.thresholdPct);
  lbDebounce.value = String(config.lowBattery.debounceSeconds ?? 0);
  lbScope.value = scopeToModel(config.lowBattery.scope);
  offEnabled.value = config.offline.enabled;
  offAfter.value =
    config.offline.afterSeconds === undefined
      ? ""
      : String(config.offline.afterSeconds);
  offScope.value = scopeToModel(config.offline.scope);
};

const load = async (): Promise<void> => {
  status.value = "loading";
  try {
    const config = (await fleetApi.getAlertRules()).config;
    applyConfig(config);
    lastSaved.value = config;
    status.value = "ready";
  } catch {
    status.value = "error";
  }
};
onMounted(() => void load());

// ── Build + validate + save ──────────────────────────────────────────────────────
/** A positive number from a text field, or an error string naming the field. */
const parsePositive = (
  text: string,
  label: string,
): { value: number } | { error: string } => {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `${label}需为大于 0 的数字` };
  }
  return { value };
};

const submit = async (): Promise<void> => {
  formError.value = "";
  const threshold = parsePositive(lbThreshold.value, "低电量阈值");
  if ("error" in threshold) {
    formError.value = threshold.error;
    return;
  }
  const debounceRaw = Number(lbDebounce.value);
  if (!Number.isFinite(debounceRaw) || debounceRaw < 0) {
    formError.value = "低电量防抖窗口需为不小于 0 的数字";
    return;
  }
  let offlineAfter: number | undefined;
  // `type="number"` inputs can hand back a number rather than the string the ref started as,
  // so coerce before trimming: an empty field means "use the server default" (no afterSeconds).
  const offAfterText = String(offAfter.value).trim();
  if (offAfterText !== "") {
    const after = parsePositive(offAfterText, "离线判定时间");
    if ("error" in after) {
      formError.value = after.error;
      return;
    }
    offlineAfter = after.value;
  }

  const config: AlertRulesConfig = {
    lowBattery: {
      enabled: lbEnabled.value,
      thresholdPct: threshold.value,
      debounceSeconds: debounceRaw,
      ...(modelToScope(lbScope.value)
        ? { scope: modelToScope(lbScope.value) }
        : {}),
    },
    offline: {
      enabled: offEnabled.value,
      ...(offlineAfter === undefined ? {} : { afterSeconds: offlineAfter }),
      ...(modelToScope(offScope.value)
        ? { scope: modelToScope(offScope.value) }
        : {}),
    },
  };

  saving.value = true;
  try {
    const previous = lastSaved.value;
    const saved = (await fleetApi.putAlertRules(config)).config;
    applyConfig(saved);
    lastSaved.value = saved;
    toast("消息规则已保存", {
      type: "success",
      // Undo restores the config the server last held — a config write is easy to misfire and
      // tedious to retype, so it gets the same undo the bulk-ack actions do.
      ...(previous
        ? { action: { label: "撤销", handler: () => void undoSave(previous) } }
        : {}),
    });
  } catch (error) {
    formError.value = messageFor(error);
  } finally {
    saving.value = false;
  }
};

/** Re-save a prior config (the 撤销 of a save). Keeps `lastSaved` in step so a second undo is a no-op. */
const undoSave = async (previous: AlertRulesConfig): Promise<void> => {
  saving.value = true;
  try {
    const restored = (await fleetApi.putAlertRules(previous)).config;
    applyConfig(restored);
    lastSaved.value = restored;
    toast("已撤销，恢复上一版消息规则", { type: "info" });
  } catch (error) {
    formError.value = messageFor(error);
  } finally {
    saving.value = false;
  }
};

const resetToDefaults = (): void => applyConfig(DEFAULT_ALERT_RULES);
</script>

<template>
  <PageHeader title="消息">
    <template #actions>
      <UiButton
        variant="secondary"
        size="sm"
        :disabled="saving || status !== 'ready'"
        @click="resetToDefaults"
        >恢复默认</UiButton
      >
      <UiButton
        size="sm"
        :disabled="saving || status !== 'ready'"
        @click="submit"
        >保存</UiButton
      >
    </template>

    <AppSectionTabs />

    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载消息规则
    </p>

    <form
      v-else
      class="flex flex-col gap-5"
      :aria-busy="saving"
      @submit.prevent="submit"
    >
      <!-- 低电量预警 -->
      <section
        class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
        aria-label="低电量预警"
      >
        <label class="flex items-center gap-2 text-md font-semibold text-ink">
          <input
            v-model="lbEnabled"
            type="checkbox"
            class="size-4"
            :disabled="saving"
          />
          低电量预警
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">触发阈值（%）</span>
            <UiInput
              v-model="lbThreshold"
              type="number"
              min="1"
              max="100"
              :disabled="saving || !lbEnabled"
              size="sm"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">防抖窗口（秒）</span>
            <UiInput
              v-model="lbDebounce"
              type="number"
              min="0"
              :disabled="saving || !lbEnabled"
              size="sm"
            />
          </label>
        </div>
        <fieldset class="grid grid-cols-3 gap-2 border-0 p-0">
          <legend class="mb-1 text-sm font-medium text-ink">作用范围</legend>
          <label class="flex flex-col gap-1">
            <span class="text-2xs text-ink-muted">设备</span>
            <UiMultiSelect
              :model-value="lbScope.deviceIds"
              :options="mergeOptions(deviceOptions, lbScope.deviceIds)"
              placeholder="不限"
              aria-label="低电量作用范围：设备"
              :disabled="saving"
              @update:model-value="(value) => (lbScope.deviceIds = value)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-2xs text-ink-muted">编队</span>
            <UiMultiSelect
              :model-value="lbScope.formationIds"
              :options="mergeOptions(formationOptions, lbScope.formationIds)"
              placeholder="不限"
              aria-label="低电量作用范围：编队"
              :disabled="saving"
              @update:model-value="(value) => (lbScope.formationIds = value)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-2xs text-ink-muted">标签</span>
            <UiInput
              v-model="lbScope.tags"
              type="text"
              placeholder="逗号分隔"
              :disabled="saving"
              size="sm"
            />
          </label>
        </fieldset>
      </section>

      <!-- 设备离线 -->
      <section
        class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
        aria-label="设备离线"
      >
        <label class="flex items-center gap-2 text-md font-semibold text-ink">
          <input
            v-model="offEnabled"
            type="checkbox"
            class="size-4"
            :disabled="saving"
          />
          设备离线
        </label>
        <label class="flex max-w-xs flex-col gap-1">
          <span class="text-sm font-medium text-ink">离线判定（秒）</span>
          <UiInput
            v-model="offAfter"
            type="number"
            min="1"
            placeholder="留空用系统默认"
            :disabled="saving || !offEnabled"
            size="sm"
          />
        </label>
        <fieldset class="grid grid-cols-3 gap-2 border-0 p-0">
          <legend class="mb-1 text-sm font-medium text-ink">作用范围</legend>
          <label class="flex flex-col gap-1">
            <span class="text-2xs text-ink-muted">设备</span>
            <UiMultiSelect
              :model-value="offScope.deviceIds"
              :options="mergeOptions(deviceOptions, offScope.deviceIds)"
              placeholder="不限"
              aria-label="离线作用范围：设备"
              :disabled="saving"
              @update:model-value="(value) => (offScope.deviceIds = value)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-2xs text-ink-muted">编队</span>
            <UiMultiSelect
              :model-value="offScope.formationIds"
              :options="mergeOptions(formationOptions, offScope.formationIds)"
              placeholder="不限"
              aria-label="离线作用范围：编队"
              :disabled="saving"
              @update:model-value="(value) => (offScope.formationIds = value)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-2xs text-ink-muted">标签</span>
            <UiInput
              v-model="offScope.tags"
              type="text"
              placeholder="逗号分隔"
              :disabled="saving"
              size="sm"
            />
          </label>
        </fieldset>
      </section>

      <p v-if="formError" class="m-0 text-sm text-critical-ink" role="alert">
        {{ formError }}
      </p>
    </form>
  </PageHeader>
</template>
