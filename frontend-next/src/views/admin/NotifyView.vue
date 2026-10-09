<script setup lang="ts">
/**
 * 外发 — the outbound-notification page (admin), both sides of Phase 16D.
 *
 * Read (everyone with `notify:read`): the effective channels (cards, from `GET /notify/config` —
 * secrets redacted, a `configured` badge says whether each channel's endpoint env is set) and the
 * send log (a filterable table, from `GET /notify/log`).
 *
 * Write (`notify:write`, 1.6.1): a channel editor over the *raw* config (`GET /notify/config/raw`
 * → `PUT /notify/config`). The form is deliberately 精简 — id / 类型 / 启用 / urlEnv / 严重度,
 * plus email 收件人与收件人组, plus 静默窗口. The advanced routing fields (scope / digest / renotify
 * / escalation / email `from`) are **round-tripped**: each save rebuilds the channel from the form
 * and re-carries those fields off the original by id, so editing one channel never drops another's
 * advanced setup. Endpoint secrets never enter this page — only their `urlEnv` variable *names* —
 * so the whole-file PUT is operator-domain config, not a credential write.
 *
 * Filters are server-side; pagination over the returned page is client-side, and filter state
 * lives in the URL — the same shape 审计 / 告警 use.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fleetApi } from "@navfleet/fleet-core";
import {
  NOTIFY_CHANNEL_TYPES,
  NOTIFY_SEVERITIES,
  type NotifyChannelConfig,
  type NotifyChannelType,
  type NotifyChannelView,
  type NotifyConfig,
  type NotifyRecipient,
  type NotifySendRecord,
  type NotifySilenceWindow,
  type Severity,
} from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import UiModal from "@/components/ui/UiModal.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiListPagination from "@/components/ui/UiListPagination.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import { tableClasses } from "@/lib/uiClasses";
import { useAuth } from "@/composables/useAuth";
import { makeMessageFor } from "@/lib/errorMessages";
import { severityLabel } from "@/lib/severity";
import { notify as toast } from "@/composables/useNotifications";
import { useAutoRefresh } from "@/composables/useAutoRefresh";

const route = useRoute();
const router = useRouter();
const auth = useAuth();
const canWrite = computed(() => auth.can("notify:write"));

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  webhook: "Webhook",
  wecom: "企业微信",
  dingtalk: "钉钉",
  email: "邮件",
};

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "sent", label: "成功" },
  { value: "failed", label: "失败" },
];

const readParam = (key: string): string => {
  const value = route.query[key];
  return typeof value === "string" ? value : "";
};
const deviceId = ref(readParam("deviceId"));
const channelId = ref(readParam("channelId"));
const statusFilter = ref(readParam("status"));

const channels = ref<NotifyChannelView[]>([]);
const records = ref<NotifySendRecord[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");

/** The full editable config (raw `urlEnv` names, routing, groups) — writers only. */
const rawConfig = ref<NotifyConfig | null>(null);

const pageSize = ref(10);
const page = ref(1);

/** Changing page size restarts at page 1 so the slice offset stays in range. */
const setPageSize = (next: string): void => {
  pageSize.value = Number(next);
  page.value = 1;
};

const load = async (): Promise<void> => {
  // Only flash the skeleton before the first successful load; filter changes re-query live, so
  // blanking the page to 加载中… on every keystroke would be noise.
  if (status.value !== "ready") status.value = "loading";
  try {
    const [config, log] = await Promise.all([
      fleetApi.getNotifyConfig(),
      fleetApi.getNotifyLog({
        deviceId: deviceId.value || undefined,
        channelId: channelId.value || undefined,
        status: (statusFilter.value || undefined) as
          "sent" | "failed" | undefined,
      }),
    ]);
    channels.value = config.channels;
    records.value = log.items;
    page.value = 1;
    // Writers also pull the raw editable config; a failure here doesn't fail the read page.
    if (canWrite.value) {
      try {
        rawConfig.value = (await fleetApi.getNotifyConfigRaw()).config;
      } catch {
        rawConfig.value = null;
      }
    }
    status.value = "ready";
  } catch {
    status.value = "error";
  }
};

const applyFilters = (): void => {
  void router.replace({
    query: {
      ...(deviceId.value ? { deviceId: deviceId.value } : {}),
      ...(channelId.value ? { channelId: channelId.value } : {}),
      ...(statusFilter.value ? { status: statusFilter.value } : {}),
    },
  });
  void load();
};

// Filters apply as you change them — no 查询 / 重置 buttons, matching the other tables. The two
// free-text boxes are debounced; the status select applies at once. Clearing a field is the reset.
let filterTimer: ReturnType<typeof setTimeout> | undefined;
watch([deviceId, channelId], () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilters, 300);
});
watch(statusFilter, () => applyFilters());

onMounted(() => void load());

const pageCount = computed(() =>
  Math.max(1, Math.ceil(records.value.length / pageSize.value)),
);
const pageRows = computed(() =>
  records.value.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
);

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString("zh-CN", { hour12: false });

const severitiesLabel = (severities: string[]): string =>
  severities.map((s) => severityLabel(s)).join(" / ") || "无";

// ── Channel editor (notify:write) ────────────────────────────────────────────────
/** The advanced routing fields the 精简 form does not surface but must not drop on save. */
type AdvancedKeys =
  | "scope"
  | "from"
  | "digestSeconds"
  | "digestSeverities"
  | "renotifySeconds"
  | "escalation";
const ADVANCED_KEYS: readonly AdvancedKeys[] = [
  "scope",
  "from",
  "digestSeconds",
  "digestSeverities",
  "renotifySeconds",
  "escalation",
];

const CHANNEL_TYPE_OPTIONS = NOTIFY_CHANNEL_TYPES.map((type) => ({
  value: type,
  label: CHANNEL_TYPE_LABELS[type] ?? type,
}));
/** 0=周日..6=周六, in display order; empty selection means 每天. */
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const ERROR_MESSAGES: Record<string, string> = {
  invalid_notify: "配置校验未通过，请检查各字段后重试",
  conflict: "渠道 ID 已存在",
};
const messageFor = makeMessageFor(ERROR_MESSAGES);

/** Look up the redacted view's env-readiness badge for a raw channel by id. */
const configuredById = computed(() => {
  const map = new Map<string, boolean>();
  for (const channel of channels.value) map.set(channel.id, channel.configured);
  return map;
});

interface SilenceRow {
  days: number[];
  from: string;
  to: string;
}

const chMode = ref<"create" | "edit" | null>(null);
const chEditingId = ref<string | null>(null);
const chAdvanced = ref<Partial<NotifyChannelConfig>>({});
const cId = ref("");
const cType = ref<NotifyChannelType>("webhook");
const cEnabled = ref(true);
const cUrlEnv = ref("");
const cSeverities = ref<Severity[]>([]);
const cRecipientsText = ref("");
const cGroupsText = ref("");
const cSilence = ref<SilenceRow[]>([]);
const chSaving = ref(false);
const chError = ref("");

const isEmail = computed(() => cType.value === "email");

/** A recipient renders as `@username` (a user reference) or the bare email. */
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

const openCreateChannel = (): void => {
  chEditingId.value = null;
  chAdvanced.value = {};
  cId.value = "";
  cType.value = "webhook";
  cEnabled.value = true;
  cUrlEnv.value = "";
  cSeverities.value = [...NOTIFY_SEVERITIES];
  cRecipientsText.value = "";
  cGroupsText.value = "";
  cSilence.value = [];
  chError.value = "";
  chMode.value = "create";
};

const openEditChannel = (channel: NotifyChannelConfig): void => {
  chEditingId.value = channel.id;
  // Carry every advanced field the form does not surface, verbatim, back onto the save.
  const advanced: Partial<NotifyChannelConfig> = {};
  for (const key of ADVANCED_KEYS) {
    if (channel[key] !== undefined) {
      (advanced as Record<string, unknown>)[key] = channel[key];
    }
  }
  chAdvanced.value = advanced;
  cId.value = channel.id;
  cType.value = channel.type;
  cEnabled.value = channel.enabled;
  cUrlEnv.value = channel.urlEnv;
  cSeverities.value = [...channel.severities];
  cRecipientsText.value = (channel.recipients ?? [])
    .map(recipientToLine)
    .join("\n");
  cGroupsText.value = (channel.groups ?? []).join(", ");
  cSilence.value = (channel.silenceWindows ?? []).map((window) => ({
    days: [...(window.days ?? [])],
    from: window.from,
    to: window.to,
  }));
  chError.value = "";
  chMode.value = "edit";
};

const closeChannelDialog = (): void => {
  chMode.value = null;
};

const toggleSeverity = (severity: Severity): void => {
  cSeverities.value = cSeverities.value.includes(severity)
    ? cSeverities.value.filter((value) => value !== severity)
    : [...cSeverities.value, severity];
};
const addSilenceRow = (): void => {
  cSilence.value = [
    ...cSilence.value,
    { days: [], from: "22:00", to: "06:00" },
  ];
};
const removeSilenceRow = (index: number): void => {
  cSilence.value = cSilence.value.filter((_, i) => i !== index);
};
const toggleSilenceDay = (row: SilenceRow, day: number): void => {
  row.days = row.days.includes(day)
    ? row.days.filter((value) => value !== day)
    : [...row.days, day].sort((a, b) => a - b);
};

/** Build the channel to persist: form fields ⊕ round-tripped advanced fields. */
const buildChannel = (): NotifyChannelConfig => {
  const channel: NotifyChannelConfig = {
    ...chAdvanced.value,
    id: cId.value.trim(),
    type: cType.value,
    enabled: cEnabled.value,
    urlEnv: cUrlEnv.value.trim(),
    severities: NOTIFY_SEVERITIES.filter((s) => cSeverities.value.includes(s)),
  };
  const windows: NotifySilenceWindow[] = cSilence.value.map((row) => ({
    ...(row.days.length ? { days: [...row.days] } : {}),
    from: row.from.trim(),
    to: row.to.trim(),
  }));
  if (windows.length) channel.silenceWindows = windows;
  if (isEmail.value) {
    const recipients = linesToRecipients(cRecipientsText.value);
    const groups = cGroupsText.value
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (recipients.length) channel.recipients = recipients;
    if (groups.length) channel.groups = groups;
  }
  return channel;
};

const localValidationError = (channel: NotifyChannelConfig): string => {
  if (!channel.id) return "渠道 ID 不能为空";
  const clashes = (rawConfig.value?.channels ?? []).some(
    (existing) =>
      existing.id === channel.id && existing.id !== chEditingId.value,
  );
  if (clashes) return "渠道 ID 已存在";
  for (const window of channel.silenceWindows ?? []) {
    if (!TIME_RE.test(window.from) || !TIME_RE.test(window.to)) {
      return "静默窗口时间需为 HH:MM（24 小时制）";
    }
  }
  return "";
};

/** Persist a whole-file write, preserving the top-level recipient `groups` map untouched. */
const persist = async (nextChannels: NotifyChannelConfig[]): Promise<void> => {
  const config: NotifyConfig = {
    channels: nextChannels,
    ...(rawConfig.value?.groups ? { groups: rawConfig.value.groups } : {}),
  };
  const result = await fleetApi.putNotifyConfig(config);
  rawConfig.value = result.config;
};

const submitChannel = async (): Promise<void> => {
  const channel = buildChannel();
  const problem = localValidationError(channel);
  if (problem) {
    chError.value = problem;
    return;
  }
  const current = rawConfig.value?.channels ?? [];
  const next =
    chMode.value === "edit" && chEditingId.value
      ? current.map((existing) =>
          existing.id === chEditingId.value ? channel : existing,
        )
      : [...current, channel];
  chSaving.value = true;
  chError.value = "";
  try {
    await persist(next);
    // Refresh the redacted cards + log so `configured` / effective view track the write.
    await load();
    toast("渠道已保存", { type: "success" });
    closeChannelDialog();
  } catch (error) {
    chError.value = messageFor(error);
  } finally {
    chSaving.value = false;
  }
};

const confirmDelete = ref<NotifyChannelConfig | null>(null);
const deleteChannel = async (): Promise<void> => {
  const target = confirmDelete.value;
  if (!target) return;
  const next = (rawConfig.value?.channels ?? []).filter(
    (channel) => channel.id !== target.id,
  );
  try {
    await persist(next);
    await load();
    toast("渠道已删除", { type: "success" });
  } catch (error) {
    toast(messageFor(error), { type: "error" });
  } finally {
    confirmDelete.value = null;
  }
};

const channelDialogTitle = computed(() =>
  chMode.value === "edit" ? "编辑渠道" : "新建渠道",
);

// Re-fetch when the operator returns to the tab (no manual 刷新 button), but not while the channel
// editor or a delete confirm is open — a refresh must not discard an in-progress edit.
useAutoRefresh(() => void load(), {
  enabled: () => chMode.value === null && confirmDelete.value === null,
});
</script>

<template>
  <PageHeader title="系统">
    <template v-if="canWrite" #actions>
      <UiButton size="sm" @click="openCreateChannel">新建渠道</UiButton>
    </template>

    <AppSectionTabs />

    <section aria-label="生效渠道" class="flex flex-col gap-2">
      <h2 class="text-2xs text-ink-muted uppercase">生效渠道</h2>
      <p
        v-if="status === 'ready' && channels.length === 0"
        class="text-sm text-ink-muted"
        role="status"
      >
        未配置任何渠道，当前不会外发
      </p>
      <ul
        v-else
        class="grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 3xl:grid-cols-3"
      >
        <li
          v-for="channel in channels"
          :key="channel.id"
          class="flex flex-col gap-1 rounded-md border border-border bg-surface-raised p-3"
        >
          <span class="flex items-baseline gap-2">
            <span class="text-sm font-semibold text-ink">{{ channel.id }}</span>
            <span class="font-mono text-2xs text-ink-subtle">{{
              CHANNEL_TYPE_LABELS[channel.type] ?? channel.type
            }}</span>
            <span
              class="ml-auto font-mono text-2xs"
              :class="channel.configured ? 'text-brand-ink' : 'text-ink-subtle'"
              >{{ channel.configured ? "● 已就绪" : "○ 未配 env" }}</span
            >
          </span>
          <span class="text-2xs text-ink-muted">
            {{ channel.enabled ? "启用" : "停用" }} ·
            {{ severitiesLabel(channel.severities) }}
          </span>
        </li>
      </ul>
    </section>

    <section v-if="canWrite" class="flex flex-col gap-2" aria-label="配置渠道">
      <h2 class="m-0 text-2xs text-ink-muted uppercase">配置渠道</h2>
      <p
        v-if="!rawConfig?.channels.length"
        class="text-sm text-ink-muted"
        role="status"
      >
        还没配置渠道
      </p>
      <div v-else :class="[tableClasses.wrapper, 'overflow-hidden']">
        <table :class="[tableClasses.table, 'table-fixed']">
          <!-- Fixed widths, every column pinned (none width-less) so the columns grow evenly on a
               wide table — modelled on the device list. 严重度 carries the slack. -->
          <colgroup>
            <col class="w-40" />
            <col class="w-24" />
            <col class="w-48" />
            <col class="w-32" />
            <col class="w-28" />
          </colgroup>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">渠道</th>
              <th scope="col" class="px-3 py-2">类型</th>
              <th scope="col" class="px-3 py-2">严重度</th>
              <th scope="col" class="px-3 py-2">env</th>
              <th scope="col" class="py-2 pr-6 pl-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="channel in rawConfig?.channels ?? []"
              :key="channel.id"
              :class="tableClasses.row"
            >
              <td class="px-3 py-2 text-ink">
                {{ channel.id }}
                <span class="text-2xs text-ink-subtle">{{
                  channel.enabled ? "启用" : "停用"
                }}</span>
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ CHANNEL_TYPE_LABELS[channel.type] ?? channel.type }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ severitiesLabel(channel.severities) }}
              </td>
              <td class="px-3 py-2 font-mono text-2xs">
                <span
                  :class="
                    configuredById.get(channel.id)
                      ? 'text-brand-ink'
                      : 'text-ink-subtle'
                  "
                  >{{
                    configuredById.get(channel.id) ? "● 已就绪" : "○ 未配 env"
                  }}</span
                >
              </td>
              <td class="px-3 py-2">
                <span class="flex justify-end gap-2">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="openEditChannel(channel)"
                    >编辑</UiButton
                  >
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="confirmDelete = channel"
                    >删除</UiButton
                  >
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="flex flex-wrap items-end gap-3" aria-label="筛选">
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">设备</span>
        <UiInput v-model="deviceId" type="search" placeholder="设备 ID" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">渠道</span>
        <UiInput v-model="channelId" type="search" placeholder="渠道 ID" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">状态</span>
        <UiSelect
          v-model="statusFilter"
          :options="STATUS_OPTIONS"
          aria-label="按状态筛选"
        />
      </label>
    </section>
    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载外发记录
    </p>
    <p
      v-else-if="records.length === 0"
      class="text-sm text-ink-muted"
      role="status"
    >
      没有符合条件的发送记录
    </p>
    <template v-else>
      <div
        :class="[tableClasses.wrapper, 'overflow-auto']"
        tabindex="0"
        role="region"
        aria-label="发送记录"
      >
        <table :class="[tableClasses.table, 'table-fixed']">
          <!-- Fixed widths so the geometry does not shift as the log reloads under a filter; the
               region scrolls sideways when the columns do not fit, text cells truncate. -->
          <colgroup>
            <col class="w-40" />
            <col class="w-28" />
            <col class="w-56" />
            <col class="w-32" />
            <col class="w-20" />
            <col class="w-20" />
            <col class="w-16" />
            <col class="w-20" />
            <col class="w-48" />
          </colgroup>
          <caption class="sr-only">
            告警外发的发送记录，最新在前
          </caption>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">时间</th>
              <th scope="col" class="px-3 py-2">设备</th>
              <th scope="col" class="px-3 py-2">标题</th>
              <th scope="col" class="px-3 py-2">渠道</th>
              <th scope="col" class="px-3 py-2">严重度</th>
              <th scope="col" class="px-3 py-2">状态</th>
              <th scope="col" class="px-3 py-2">尝试</th>
              <th scope="col" class="px-3 py-2">延时</th>
              <th scope="col" class="px-3 py-2">错误</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(record, index) in pageRows"
              :key="`${record.ts}-${record.channelId}-${index}`"
              :class="tableClasses.row"
            >
              <td class="px-3 py-2 whitespace-nowrap text-ink-muted">
                {{ formatTime(record.ts) }}
              </td>
              <td class="truncate px-3 py-2 text-ink">{{ record.deviceId }}</td>
              <td class="truncate px-3 py-2 text-ink">{{ record.title }}</td>
              <td class="truncate px-3 py-2 text-ink">
                {{ record.channelId }}
                <span class="text-2xs text-ink-subtle">{{
                  CHANNEL_TYPE_LABELS[record.channelType] ?? record.channelType
                }}</span>
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ severityLabel(record.severity) }}
              </td>
              <td class="px-3 py-2">
                <span
                  :class="
                    record.status === 'failed'
                      ? 'text-critical-ink'
                      : 'text-ink-muted'
                  "
                  >{{ record.status === "failed" ? "失败" : "成功" }}</span
                >
              </td>
              <td class="px-3 py-2 text-ink-muted">{{ record.attempts }}</td>
              <td class="px-3 py-2 text-ink-muted">
                {{ record.latencyMs === null ? "—" : `${record.latencyMs}ms` }}
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ record.error ?? "—" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <UiListPagination
        :page="page"
        :page-count="pageCount"
        :page-size="pageSize"
        :total="records.length"
        @update:page="(value) => (page = value)"
        @update:page-size="setPageSize"
      />
    </template>

    <!-- Channel editor (notify:write). -->
    <UiModal
      :open="chMode !== null"
      :title="channelDialogTitle"
      description="填写渠道的类型、订阅严重度与静默窗口后提交"
      max-width="xl"
      @update:open="
        (open) => {
          if (!open) closeChannelDialog();
        }
      "
    >
      <form
        class="flex flex-col gap-3"
        :aria-busy="chSaving"
        @submit.prevent="submitChannel"
      >
        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">渠道 ID</span>
            <UiInput v-model="cId" type="text" :disabled="chSaving" size="sm" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">类型</span>
            <UiSelect
              :model-value="cType"
              :options="CHANNEL_TYPE_OPTIONS"
              aria-label="渠道类型"
              @update:model-value="
                (value) => (cType = value as NotifyChannelType)
              "
            />
          </label>
        </div>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">端点环境变量名</span>
          <UiInput
            v-model="cUrlEnv"
            type="text"
            placeholder="如 NOTIFY_OPS_WEBHOOK_URL"
            :disabled="chSaving"
            size="sm"
            class="font-mono"
          />
          <span class="text-2xs text-ink-subtle"
            >留空表示未就绪：不发送不记失败</span
          >
        </label>
        <label class="flex items-center gap-2 text-sm text-ink">
          <input
            v-model="cEnabled"
            type="checkbox"
            class="size-4"
            :disabled="chSaving"
          />
          启用该渠道
        </label>
        <fieldset class="flex flex-col gap-1 border-0 p-0">
          <legend class="mb-1 text-sm font-medium text-ink">订阅严重度</legend>
          <div class="flex flex-wrap gap-3">
            <label
              v-for="severity in NOTIFY_SEVERITIES"
              :key="severity"
              class="flex items-center gap-2 text-xs text-ink-muted"
            >
              <input
                type="checkbox"
                class="size-4"
                :checked="cSeverities.includes(severity)"
                :disabled="chSaving"
                @change="toggleSeverity(severity)"
              />
              {{ severityLabel(severity) }}
            </label>
          </div>
        </fieldset>
        <template v-if="isEmail">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">收件人</span>
            <textarea
              v-model="cRecipientsText"
              rows="3"
              placeholder="每行一个：邮箱地址，或 @用户名（发送时取该用户邮箱）"
              :disabled="chSaving"
              class="w-full rounded-sm border border-border-strong bg-surface px-2 py-2 text-sm leading-5 text-ink placeholder:text-ink-subtle"
            ></textarea>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">收件人组（可选）</span>
            <UiInput
              v-model="cGroupsText"
              type="text"
              placeholder="逗号分隔的组名，引用配置里的命名收件人组"
              :disabled="chSaving"
              size="sm"
            />
          </label>
        </template>
        <fieldset class="flex flex-col gap-2 border-0 p-0">
          <legend class="mb-1 flex w-full items-center justify-between">
            <span class="text-sm font-medium text-ink">静默窗口</span>
            <UiButton
              variant="secondary"
              size="sm"
              type="button"
              @click="addSilenceRow"
              >添加窗口</UiButton
            >
          </legend>
          <p v-if="!cSilence.length" class="m-0 text-2xs text-ink-subtle">
            留空表示任意时段；落在窗口内的告警对本渠道静默
          </p>
          <div
            v-for="(row, index) in cSilence"
            :key="index"
            class="flex flex-col gap-2 rounded-sm border border-border p-2"
          >
            <div class="flex flex-wrap items-center gap-2">
              <UiInput
                v-model="row.from"
                type="text"
                placeholder="22:00"
                :disabled="chSaving"
                size="sm"
                class="w-20 font-mono"
              />
              <span class="text-ink-muted">至</span>
              <UiInput
                v-model="row.to"
                type="text"
                placeholder="06:00"
                :disabled="chSaving"
                size="sm"
                class="w-20 font-mono"
              />
              <UiButton
                variant="ghost"
                size="sm"
                type="button"
                class="ml-auto"
                @click="removeSilenceRow(index)"
                >移除</UiButton
              >
            </div>
            <div class="flex flex-wrap gap-2">
              <label
                v-for="(label, day) in WEEKDAYS"
                :key="day"
                class="flex items-center gap-1 text-2xs text-ink-muted"
              >
                <input
                  type="checkbox"
                  class="size-3.5"
                  :checked="row.days.includes(day)"
                  :disabled="chSaving"
                  @change="toggleSilenceDay(row, day)"
                />
                周{{ label }}
              </label>
              <span class="text-2xs text-ink-subtle">（不选=每天）</span>
            </div>
          </div>
        </fieldset>
        <p v-if="chError" class="m-0 text-sm text-critical-ink" role="alert">
          {{ chError }}
        </p>
        <div class="flex justify-end gap-2">
          <UiButton
            variant="secondary"
            size="sm"
            type="button"
            @click="closeChannelDialog"
            >取消</UiButton
          >
          <UiButton size="sm" type="submit" :disabled="chSaving || !cId.trim()"
            >保存</UiButton
          >
        </div>
      </form>
    </UiModal>

    <UiConfirmDialog
      :open="confirmDelete !== null"
      :title="`删除渠道「${confirmDelete?.id ?? ''}」？`"
      description="删除后该渠道立即停止外发；此操作会重写 notify.json"
      confirm-label="删除"
      @update:open="
        (open) => {
          if (!open) confirmDelete = null;
        }
      "
      @confirm="deleteChannel"
    />
  </PageHeader>
</template>
