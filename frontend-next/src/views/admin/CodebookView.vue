<script setup lang="ts">
/**
 * 部署 / 报码字典 — the code→meaning table in effect, edited row by row or swapped as a file.
 *
 * The console describes a vehicle's report codes against the table **in effect**: the built-in
 * reference table with the deployment's `codebook.json` layered over it. This page shows that
 * merged table and lets an admin change it two ways, both writing `PUT /api/v1/codebook`
 * (admin-only, audited, whole-table replace — the config volume must be writable):
 * - **row-level** (1.6.1): 新建 / 编辑 / 删除 a single code through a form, then the whole table
 *   is re-sent. The quick path for a one-off correction.
 * - **file** (16C): export the current table as a starting point, edit the JSON, import it back.
 *   The bulk path.
 * Both go through the same shared `parseCodebook` (client-side for fast feedback, then the backend
 * re-validates as the authority).
 */
import { computed, onMounted, ref } from "vue";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import UiModal from "@/components/ui/UiModal.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import { tableClasses } from "@/lib/uiClasses";
import { makeMessageFor } from "@/lib/errorMessages";
import { notify } from "@/composables/useNotifications";
import { useAuth } from "@/composables/useAuth";
import { useCodebook } from "@/composables/useCodebook";
import { useFieldErrors } from "@/composables/useFieldErrors";
import {
  CODE_IMPACTS,
  CODE_SUBSYSTEMS,
  parseCodebook,
  type CodeChannel,
  type CodeImpact,
  type CodeSubsystem,
  type ReportCodeEntry,
} from "@navfleet/shared";

const auth = useAuth();
const canWrite = computed(() => auth.can("codebook:write"));

const codebook = useCodebook();
const entries = codebook.entries;
const status = codebook.status;

onMounted(() => {
  // Force a fresh read: a prior device-detail visit may have populated the shared cache,
  // and an admin opening this page wants what the backend has now.
  void codebook.load(true);
});

const CHANNEL_LABELS: Record<CodeChannel, string> = {
  error: "告警",
  warning: "预警",
  info: "提示",
};

/** Download the current table as a codebook.json — a valid starting point to edit + re-import. */
const exportCodebook = (): void => {
  const blob = new Blob([`${JSON.stringify(entries.value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "codebook.json";
  anchor.click();
  URL.revokeObjectURL(url);
};

const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const importError = ref("");

const pickFile = (): void => {
  importError.value = "";
  fileInput.value?.click();
};

const onFileChosen = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // let the same file be chosen again after a fix
  if (!file) return;

  importError.value = "";
  let parsed: ReportCodeEntry[];
  try {
    const text = await file.text();
    // Validate client-side first so a bad file is caught before the round-trip; the backend
    // validates again with the same shared parser and is the real authority.
    parsed = parseCodebook(JSON.parse(text));
  } catch (error) {
    importError.value =
      error instanceof Error ? error.message : "文件不是有效的码表 JSON";
    return;
  }

  importing.value = true;
  try {
    await codebook.importCodebook(parsed);
    notify(`已导入 ${parsed.length} 条报码`, { type: "success" });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    importError.value =
      code === "invalid_codebook"
        ? "后端拒绝了这份码表，请检查内容"
        : code === "forbidden"
          ? "没有导入码表的权限"
          : "导入失败，请稍后重试";
  } finally {
    importing.value = false;
  }
};

const overrideHint = computed(() =>
  entries.value.length ? `共 ${entries.value.length} 条报码` : "",
);

// ── Row-level editing (codebook:write, 1.6.1) ─────────────────────────────────────
const INPUT_BASE =
  "h-9 w-full rounded-sm border bg-surface px-2 text-sm text-ink placeholder:text-ink-subtle";
/** The raw field's classes, with the border turning red when that field is in error. */
const fieldClass = (invalid: boolean): string[] => [
  INPUT_BASE,
  invalid ? "border-critical" : "border-border-strong",
];

const CHANNEL_OPTIONS = (["error", "warning", "info"] as CodeChannel[]).map(
  (value) => ({ value, label: CHANNEL_LABELS[value] }),
);
const IMPACT_OPTIONS = (Object.keys(CODE_IMPACTS) as CodeImpact[]).map(
  (value) => ({ value, label: CODE_IMPACTS[value].label }),
);
const SUBSYSTEM_OPTIONS = (Object.keys(CODE_SUBSYSTEMS) as CodeSubsystem[]).map(
  (value) => ({ value, label: CODE_SUBSYSTEMS[value] }),
);

const writeError = makeMessageFor({
  invalid_codebook: "后端拒绝了这份码表，请检查内容",
  forbidden: "没有编辑码表的权限",
});

const mode = ref<"create" | "edit" | null>(null);
const editingCode = ref<number | null>(null);
const fCode = ref("");
const fLabel = ref("");
const fChannel = ref<CodeChannel>("error");
const fImpact = ref<CodeImpact>("watch");
const fSubsystem = ref<CodeSubsystem>("navigation");
const fDescription = ref("");
const fHint = ref("");
const rowSaving = ref(false);
const rowError = ref("");
const { errors, clearOn, setErrors, report } = useFieldErrors();
clearOn(fCode, "code");
clearOn(fLabel, "label");
clearOn(fDescription, "description");
clearOn(fHint, "hint");

const openCreateRow = (): void => {
  editingCode.value = null;
  fCode.value = "";
  fLabel.value = "";
  fChannel.value = "error";
  fImpact.value = "watch";
  fSubsystem.value = "navigation";
  fDescription.value = "";
  fHint.value = "";
  rowError.value = "";
  setErrors({});
  mode.value = "create";
};

const openEditRow = (entry: ReportCodeEntry): void => {
  editingCode.value = entry.code;
  fCode.value = String(entry.code);
  fLabel.value = entry.label;
  fChannel.value = entry.channel;
  fImpact.value = entry.impact;
  fSubsystem.value = entry.subsystem;
  fDescription.value = entry.description;
  fHint.value = entry.hint;
  rowError.value = "";
  setErrors({});
  mode.value = "edit";
};

const closeRowDialog = (): void => {
  mode.value = null;
};

/** Build the entry from the form, or return per-field errors for the invalid fields. */
const buildEntry = ():
  { entry: ReportCodeEntry } | { errors: Record<string, string> } => {
  const fieldErrors: Record<string, string> = {};
  const code = Number(fCode.value);
  if (!Number.isInteger(code) || code <= 0) {
    fieldErrors.code = "报码需为正整数";
  } else if (
    entries.value.some((e) => e.code === code && e.code !== editingCode.value)
  ) {
    fieldErrors.code = `报码 ${code} 已存在`;
  }
  const label = fLabel.value.trim();
  const description = fDescription.value.trim();
  const hint = fHint.value.trim();
  if (!label) fieldErrors.label = "名称不能为空";
  if (!description) fieldErrors.description = "说明不能为空";
  if (!hint) fieldErrors.hint = "处理建议不能为空";
  if (Object.keys(fieldErrors).length) return { errors: fieldErrors };
  return {
    entry: {
      code,
      channel: fChannel.value,
      subsystem: fSubsystem.value,
      label,
      description,
      hint,
      impact: fImpact.value,
    },
  };
};

/** Re-send the whole table with `next` swapped in — the same whole-table write import uses. */
const persistRows = async (next: ReportCodeEntry[]): Promise<void> => {
  // Validate the whole table client-side (mirrors import) before the round-trip.
  await codebook.importCodebook(parseCodebook(next));
};

const submitRow = async (): Promise<void> => {
  const built = buildEntry();
  if ("errors" in built) {
    report(built.errors);
    return;
  }
  const current = entries.value;
  const next =
    mode.value === "edit" && editingCode.value !== null
      ? current.map((e) => (e.code === editingCode.value ? built.entry : e))
      : [...current, built.entry];
  rowSaving.value = true;
  rowError.value = "";
  try {
    await persistRows(next);
    notify("报码已保存", { type: "success" });
    closeRowDialog();
  } catch (error) {
    rowError.value = writeError(error);
  } finally {
    rowSaving.value = false;
  }
};

const confirmDelete = ref<ReportCodeEntry | null>(null);
const deleteRow = async (): Promise<void> => {
  const target = confirmDelete.value;
  if (!target) return;
  const next = entries.value.filter((e) => e.code !== target.code);
  try {
    await persistRows(next);
    notify("报码已删除", { type: "success" });
  } catch (error) {
    notify(writeError(error), { type: "error" });
  } finally {
    confirmDelete.value = null;
  }
};

const rowDialogTitle = computed(() =>
  mode.value === "edit" ? "编辑报码" : "新建报码",
);
</script>

<template>
  <PageHeader title="部署">
    <template #actions>
      <UiButton v-if="canWrite" size="sm" @click="openCreateRow"
        >新建报码</UiButton
      >
      <UiButton
        variant="secondary"
        size="sm"
        :disabled="!entries.length"
        @click="exportCodebook"
      >
        导出 JSON
      </UiButton>
      <UiButton size="sm" :disabled="importing" @click="pickFile">
        {{ importing ? "导入中…" : "导入 JSON" }}
      </UiButton>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        class="hidden"
        @change="onFileChosen"
      />
    </template>

    <AppSectionTabs />

    <p
      v-if="importError"
      class="m-0 rounded-sm border border-critical bg-critical-wash px-3 py-2 text-sm text-critical-ink"
      role="alert"
    >
      {{ importError }}
    </p>

    <p v-if="status === 'loading'" class="text-sm text-ink-muted" role="status">
      正在读取报码字典…
    </p>

    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="status"
    >
      报码字典加载失败，请稍后重试
    </p>

    <template v-else>
      <p class="m-0 text-xs text-ink-subtle">{{ overrideHint }}</p>

      <div :class="[tableClasses.wrapper, 'overflow-x-auto']">
        <table :class="[tableClasses.table, 'table-fixed']">
          <!-- Fixed widths, every column pinned (none width-less) so the columns grow evenly on a
               wide table — modelled on the device list. 说明 (the longest field) carries the slack
               and wraps; the rest truncate. -->
          <colgroup>
            <col class="w-20" />
            <col class="w-40" />
            <col class="w-24" />
            <col class="w-24" />
            <col class="w-28" />
            <col class="w-80" />
            <col v-if="canWrite" class="w-28" />
          </colgroup>
          <caption class="sr-only">
            生效的报码字典：报码、名称、通道、等级、子系统、说明与处理建议
          </caption>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">报码</th>
              <th scope="col" class="px-3 py-2 whitespace-nowrap">名称</th>
              <th scope="col" class="px-4 py-2 whitespace-nowrap">通道</th>
              <th scope="col" class="px-3 py-2 whitespace-nowrap">等级</th>
              <th scope="col" class="px-3 py-2 whitespace-nowrap">子系统</th>
              <th scope="col" class="px-3 py-2">说明与处理建议</th>
              <th v-if="canWrite" scope="col" class="py-2 pr-6 pl-3 text-right">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in entries"
              :key="entry.code"
              :class="[tableClasses.row, 'align-top']"
            >
              <td class="truncate px-3 py-2 font-mono text-ink">
                {{ entry.code }}
              </td>
              <td class="truncate px-3 py-2 text-ink">
                {{ entry.label }}
              </td>
              <td class="truncate px-4 py-2 text-ink-muted">
                {{ CHANNEL_LABELS[entry.channel] }}
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ CODE_IMPACTS[entry.impact].label }}
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ CODE_SUBSYSTEMS[entry.subsystem] }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                <span class="text-ink">{{ entry.description }}</span>
                <br />
                {{ entry.hint }}
              </td>
              <td v-if="canWrite" class="px-3 py-2 whitespace-nowrap">
                <span class="flex justify-end gap-2">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="openEditRow(entry)"
                    >编辑</UiButton
                  >
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="confirmDelete = entry"
                    >删除</UiButton
                  >
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Row editor (codebook:write). -->
    <UiModal
      :open="mode !== null"
      :title="rowDialogTitle"
      description="填写报码、名称、通道、等级、子系统与说明后提交"
      max-width="xl"
      @update:open="
        (open) => {
          if (!open) closeRowDialog();
        }
      "
    >
      <form
        class="flex flex-col gap-3"
        :aria-busy="rowSaving"
        @submit.prevent="submitRow"
      >
        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink"
              >报码 <span class="text-critical-ink">*</span></span
            >
            <input
              v-model="fCode"
              type="number"
              min="1"
              :disabled="rowSaving"
              :aria-invalid="errors.code ? 'true' : undefined"
              :class="[fieldClass(!!errors.code), 'font-mono']"
            />
            <p v-if="errors.code" class="m-0 text-xs text-critical-ink">
              {{ errors.code }}
            </p>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink"
              >名称 <span class="text-critical-ink">*</span></span
            >
            <input
              v-model="fLabel"
              type="text"
              :disabled="rowSaving"
              :aria-invalid="errors.label ? 'true' : undefined"
              :class="fieldClass(!!errors.label)"
            />
            <p v-if="errors.label" class="m-0 text-xs text-critical-ink">
              {{ errors.label }}
            </p>
          </label>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">通道</span>
            <UiSelect
              :model-value="fChannel"
              :options="CHANNEL_OPTIONS"
              aria-label="通道"
              @update:model-value="(v) => (fChannel = v as CodeChannel)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">等级</span>
            <UiSelect
              :model-value="fImpact"
              :options="IMPACT_OPTIONS"
              aria-label="等级"
              @update:model-value="(v) => (fImpact = v as CodeImpact)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">子系统</span>
            <UiSelect
              :model-value="fSubsystem"
              :options="SUBSYSTEM_OPTIONS"
              aria-label="子系统"
              @update:model-value="(v) => (fSubsystem = v as CodeSubsystem)"
            />
          </label>
        </div>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink"
            >说明 <span class="text-critical-ink">*</span></span
          >
          <textarea
            v-model="fDescription"
            rows="2"
            :disabled="rowSaving"
            :aria-invalid="errors.description ? 'true' : undefined"
            :class="[fieldClass(!!errors.description), 'h-auto py-2 leading-5']"
          ></textarea>
          <p v-if="errors.description" class="m-0 text-xs text-critical-ink">
            {{ errors.description }}
          </p>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink"
            >处理建议 <span class="text-critical-ink">*</span></span
          >
          <textarea
            v-model="fHint"
            rows="2"
            :disabled="rowSaving"
            :aria-invalid="errors.hint ? 'true' : undefined"
            :class="[fieldClass(!!errors.hint), 'h-auto py-2 leading-5']"
          ></textarea>
          <p v-if="errors.hint" class="m-0 text-xs text-critical-ink">
            {{ errors.hint }}
          </p>
        </label>
        <p v-if="rowError" class="m-0 text-sm text-critical-ink" role="alert">
          {{ rowError }}
        </p>
        <div class="flex justify-end gap-2">
          <UiButton
            variant="secondary"
            size="sm"
            type="button"
            @click="closeRowDialog"
            >取消</UiButton
          >
          <UiButton size="sm" type="submit" :disabled="rowSaving"
            >保存</UiButton
          >
        </div>
      </form>
    </UiModal>

    <UiConfirmDialog
      :open="confirmDelete !== null"
      :title="`删除报码「${confirmDelete?.code ?? ''}」？`"
      description="删除后该报码回退到内置含义（若内置有），此操作会重写 codebook.json"
      confirm-label="删除"
      @update:open="
        (open) => {
          if (!open) confirmDelete = null;
        }
      "
      @confirm="deleteRow"
    />
  </PageHeader>
</template>
