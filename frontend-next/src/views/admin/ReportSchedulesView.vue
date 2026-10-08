<script setup lang="ts">
/**
 * 定时报表 — the scheduled-report editor (admin, 1.6.1; a tab of the 报表 section since 1.6.2),
 * the console face of `reports.json`.
 *
 * A schedule mails a periodic report (24h / 7d / 30d look-back) at a wall-clock time — every day,
 * or one weekday a week — to inline recipients and/or notify.json recipient groups. The list is
 * variable-length, so this mirrors the 外发 channel editor: a table + a create/edit dialog, and
 * every save is a whole-file `PUT` (a removed schedule is just an array without it). The backend
 * is the authority (`parseReportsConfig` re-validates); a refused write comes back as
 * `invalid_reports` and is mapped to a sentence.
 *
 * 只读红线：choosing when a report is mailed is deployment-domain config, not vehicle command
 * dispatch. SMTP secrets never enter this page — a schedule records only the *name* of the env var
 * holding its connection string (`smtpEnv`) — so the whole-file write persists no credential.
 */
import { computed, onMounted, ref } from "vue";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { fleetApi } from "@navfleet/fleet-core";
import {
  REPORT_RANGE_PRESETS,
  type NotifyRecipient,
  type ReportRangePreset,
  type ReportScheduleConfig,
  type ReportsConfig,
} from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import { tableClasses } from "@/lib/uiClasses";
import { useAuth } from "@/composables/useAuth";
import { makeMessageFor } from "@/lib/errorMessages";
import { notify as toast } from "@/composables/useNotifications";

const auth = useAuth();
const canWrite = computed(() => auth.can("reports:write"));

const RANGE_LABELS: Record<ReportRangePreset, string> = {
  "24h": "近 24 小时",
  "7d": "近 7 天",
  "30d": "近 30 天",
};
const RANGE_OPTIONS = REPORT_RANGE_PRESETS.map((value) => ({
  value,
  label: RANGE_LABELS[value],
}));
/** "" = 每天; otherwise 0(周日)–6(周六). */
const WEEKDAY_OPTIONS = [
  { value: "", label: "每天" },
  { value: "0", label: "周日" },
  { value: "1", label: "周一" },
  { value: "2", label: "周二" },
  { value: "3", label: "周三" },
  { value: "4", label: "周四" },
  { value: "5", label: "周五" },
  { value: "6", label: "周六" },
];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const ERROR_MESSAGES: Record<string, string> = {
  invalid_reports: "配置校验未通过，请检查各字段后重试",
  conflict: "报表 ID 已存在",
};
const messageFor = makeMessageFor(ERROR_MESSAGES);

const config = ref<ReportsConfig | null>(null);
const status = ref<"loading" | "ready" | "error">("loading");

const schedules = computed(() => config.value?.schedules ?? []);

const load = async (): Promise<void> => {
  status.value = "loading";
  try {
    config.value = (await fleetApi.getReportsConfig()).config;
    status.value = "ready";
  } catch {
    status.value = "error";
  }
};
onMounted(() => void load());

// ── Dialog state ──────────────────────────────────────────────────────────────────
const mode = ref<"create" | "edit" | null>(null);
const editingId = ref<string | null>(null);
const sId = ref("");
const sEnabled = ref(true);
const sRange = ref<ReportRangePreset>("24h");
const sTime = ref("08:00");
const sWeekday = ref("");
const sSmtpEnv = ref("");
const sFrom = ref("");
const sRecipientsText = ref("");
const sGroupsText = ref("");
const saving = ref(false);
const formError = ref("");

const recipientToLine = (recipient: NotifyRecipient): string =>
  recipient.user ? `@${recipient.user}` : (recipient.email ?? "");
const linesToRecipients = (text: string): NotifyRecipient[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.startsWith("@") ? { user: line.slice(1) } : { email: line },
    );

const openCreate = (): void => {
  editingId.value = null;
  sId.value = "";
  sEnabled.value = true;
  sRange.value = "24h";
  sTime.value = "08:00";
  sWeekday.value = "";
  sSmtpEnv.value = "";
  sFrom.value = "";
  sRecipientsText.value = "";
  sGroupsText.value = "";
  formError.value = "";
  mode.value = "create";
};

const openEdit = (schedule: ReportScheduleConfig): void => {
  editingId.value = schedule.id;
  sId.value = schedule.id;
  sEnabled.value = schedule.enabled;
  sRange.value = schedule.range;
  sTime.value = schedule.time;
  sWeekday.value =
    schedule.weekday === undefined ? "" : String(schedule.weekday);
  sSmtpEnv.value = schedule.smtpEnv;
  sFrom.value = schedule.from;
  sRecipientsText.value = (schedule.recipients ?? [])
    .map(recipientToLine)
    .join("\n");
  sGroupsText.value = (schedule.groups ?? []).join(", ");
  formError.value = "";
  mode.value = "edit";
};

const closeDialog = (): void => {
  mode.value = null;
};

const buildSchedule = (): ReportScheduleConfig => {
  const schedule: ReportScheduleConfig = {
    id: sId.value.trim(),
    enabled: sEnabled.value,
    range: sRange.value,
    time: sTime.value.trim(),
    smtpEnv: sSmtpEnv.value.trim(),
    from: sFrom.value.trim(),
  };
  if (sWeekday.value !== "") schedule.weekday = Number(sWeekday.value);
  const recipients = linesToRecipients(sRecipientsText.value);
  const groups = sGroupsText.value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (recipients.length) schedule.recipients = recipients;
  if (groups.length) schedule.groups = groups;
  return schedule;
};

const localValidationError = (schedule: ReportScheduleConfig): string => {
  if (!schedule.id) return "报表 ID 不能为空";
  if (
    schedules.value.some(
      (s) => s.id === schedule.id && s.id !== editingId.value,
    )
  ) {
    return "报表 ID 已存在";
  }
  if (!TIME_RE.test(schedule.time)) return "发送时刻需为 HH:MM（24 小时制）";
  if (!schedule.smtpEnv) return "SMTP 环境变量名不能为空";
  if (!schedule.from) return "发件人地址不能为空";
  return "";
};

const persist = async (next: ReportScheduleConfig[]): Promise<void> => {
  const result = await fleetApi.putReportsConfig({ schedules: next });
  config.value = result.config;
};

const submit = async (): Promise<void> => {
  const schedule = buildSchedule();
  const problem = localValidationError(schedule);
  if (problem) {
    formError.value = problem;
    return;
  }
  const current = schedules.value;
  const next =
    mode.value === "edit" && editingId.value
      ? current.map((existing) =>
          existing.id === editingId.value ? schedule : existing,
        )
      : [...current, schedule];
  saving.value = true;
  formError.value = "";
  try {
    await persist(next);
    toast("定时报表已保存", { type: "success" });
    closeDialog();
  } catch (error) {
    formError.value = messageFor(error);
  } finally {
    saving.value = false;
  }
};

const confirmDelete = ref<ReportScheduleConfig | null>(null);
const deleteSchedule = async (): Promise<void> => {
  const target = confirmDelete.value;
  if (!target) return;
  const next = schedules.value.filter((s) => s.id !== target.id);
  try {
    await persist(next);
    toast("定时报表已删除", { type: "success" });
  } catch (error) {
    toast(messageFor(error), { type: "error" });
  } finally {
    confirmDelete.value = null;
  }
};

const dialogTitle = computed(() =>
  mode.value === "edit" ? "编辑定时报表" : "新建定时报表",
);
const weekdayLabel = (weekday?: number): string =>
  weekday === undefined
    ? "每天"
    : (WEEKDAY_OPTIONS.find((o) => o.value === String(weekday))?.label ??
      "每天");
</script>

<template>
  <PageHeader title="报表">
    <template #actions>
      <UiButton v-if="canWrite" size="sm" @click="openCreate"
        >新建报表</UiButton
      >
    </template>

    <AppSectionTabs />

    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载定时报表配置
    </p>

    <template v-else>
      <p class="m-0 text-2xs text-ink-subtle">报表按周期生成并邮件推送</p>
      <p v-if="!schedules.length" class="text-sm text-ink-muted" role="status">
        还没有定时报表
      </p>
      <div v-else :class="[tableClasses.wrapper, 'overflow-hidden']">
        <table :class="[tableClasses.table, 'table-fixed']">
          <!-- Fixed widths, every column pinned (none width-less) so the columns grow evenly on a
               wide table — modelled on the device list. 发件人 carries the slack. -->
          <colgroup>
            <col class="w-40" />
            <col class="w-28" />
            <col class="w-32" />
            <col class="w-64" />
            <col v-if="canWrite" class="w-28" />
          </colgroup>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">报表</th>
              <th scope="col" class="px-3 py-2">回看</th>
              <th scope="col" class="px-3 py-2">发送</th>
              <th scope="col" class="px-3 py-2">发件人</th>
              <th v-if="canWrite" scope="col" class="py-2 pr-6 pl-3 text-right">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="schedule in schedules"
              :key="schedule.id"
              :class="tableClasses.row"
            >
              <td class="truncate px-3 py-2 text-ink">
                {{ schedule.id }}
                <span class="text-2xs text-ink-subtle">{{
                  schedule.enabled ? "启用" : "停用"
                }}</span>
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ RANGE_LABELS[schedule.range] ?? schedule.range }}
              </td>
              <td class="px-3 py-2 text-ink-muted tabular-nums">
                {{ weekdayLabel(schedule.weekday) }} {{ schedule.time }}
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ schedule.from }}
              </td>
              <td v-if="canWrite" class="px-3 py-2">
                <span class="flex justify-end gap-2">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="openEdit(schedule)"
                    >编辑</UiButton
                  >
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="confirmDelete = schedule"
                    >删除</UiButton
                  >
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- Schedule editor (reports:write). -->
    <DialogRoot
      :open="mode !== null"
      @update:open="
        (open) => {
          if (!open) closeDialog();
        }
      "
    >
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-scrim/55" />
        <DialogContent
          class="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-140 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-auto rounded-md border border-border bg-surface-raised p-5 shadow-overlay"
        >
          <DialogTitle class="text-md font-semibold text-ink">{{
            dialogTitle
          }}</DialogTitle>
          <DialogDescription class="sr-only"
            >填写报表的回看窗口、发送时刻与收件人后提交</DialogDescription
          >
          <form
            class="flex flex-col gap-3"
            :aria-busy="saving"
            @submit.prevent="submit"
          >
            <div class="grid grid-cols-2 gap-3">
              <label class="flex flex-col gap-1">
                <span class="text-sm font-medium text-ink">报表 ID</span>
                <UiInput
                  v-model="sId"
                  type="text"
                  :disabled="saving"
                  size="sm"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-sm font-medium text-ink">回看窗口</span>
                <UiSelect
                  :model-value="sRange"
                  :options="RANGE_OPTIONS"
                  aria-label="回看窗口"
                  @update:model-value="
                    (value) => (sRange = value as ReportRangePreset)
                  "
                />
              </label>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <label class="flex flex-col gap-1">
                <span class="text-sm font-medium text-ink">发送时刻</span>
                <UiInput
                  v-model="sTime"
                  type="text"
                  placeholder="08:00"
                  :disabled="saving"
                  size="sm"
                  class="font-mono"
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-sm font-medium text-ink">发送频率</span>
                <UiSelect
                  :model-value="sWeekday"
                  :options="WEEKDAY_OPTIONS"
                  aria-label="发送频率"
                  @update:model-value="(value) => (sWeekday = value)"
                />
              </label>
            </div>
            <label class="flex items-center gap-2 text-sm text-ink">
              <input
                v-model="sEnabled"
                type="checkbox"
                class="size-4"
                :disabled="saving"
              />
              启用该报表
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">SMTP 环境变量名</span>
              <UiInput
                v-model="sSmtpEnv"
                type="text"
                placeholder="如 REPORTS_SMTP_URL"
                :disabled="saving"
                size="sm"
                class="font-mono"
              />
              <span class="text-2xs text-ink-subtle"
                >装 SMTP 连接串的环境变量名；连接串本身不落配置文件</span
              >
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">发件人地址</span>
              <UiInput
                v-model="sFrom"
                type="text"
                placeholder="reports@example.com"
                :disabled="saving"
                size="sm"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">收件人</span>
              <textarea
                v-model="sRecipientsText"
                rows="3"
                placeholder="每行一个：邮箱地址，或 @用户名（发送时取该用户邮箱）"
                :disabled="saving"
                class="w-full rounded-sm border border-border-strong bg-surface px-2 py-2 text-sm leading-5 text-ink placeholder:text-ink-subtle"
              ></textarea>
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">收件人组（可选）</span>
              <UiInput
                v-model="sGroupsText"
                type="text"
                placeholder="逗号分隔的组名，引用 notify.json 里的命名收件人组"
                :disabled="saving"
                size="sm"
              />
            </label>
            <p
              v-if="formError"
              class="m-0 text-sm text-critical-ink"
              role="alert"
            >
              {{ formError }}
            </p>
            <div class="flex justify-end gap-2">
              <UiButton
                variant="secondary"
                size="sm"
                type="button"
                @click="closeDialog"
                >取消</UiButton
              >
              <UiButton
                size="sm"
                type="submit"
                :disabled="saving || !sId.trim()"
                >保存</UiButton
              >
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <UiConfirmDialog
      :open="confirmDelete !== null"
      :title="`删除定时报表「${confirmDelete?.id ?? ''}」？`"
      description="删除后该报表立即停止推送；此操作会重写 reports.json"
      confirm-label="删除"
      @update:open="
        (open) => {
          if (!open) confirmDelete = null;
        }
      "
      @confirm="deleteSchedule"
    />
  </PageHeader>
</template>
