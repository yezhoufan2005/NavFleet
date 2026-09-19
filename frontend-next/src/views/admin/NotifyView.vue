<script setup lang="ts">
/**
 * 外发 — the outbound-notification page (admin, read-only), the read side of Phase 16D.
 *
 * Two regions: the effective channels (cards, from `GET /notify/config` — secrets redacted, a
 * `configured` badge says whether each channel's endpoint env is set) and the send log (a
 * filterable table, from `GET /notify/log`). Channels and routing are file-managed in
 * `notify.json`; there is nothing to edit here, only to read back what is configured and sent.
 *
 * Filters are server-side; pagination over the returned page is client-side, and filter state
 * lives in the URL — the same shape 审计 / 告警 use.
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fleetApi } from "@navfleet/fleet-core";
import type { NotifyChannelView, NotifySendRecord } from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiSelect from "@/components/ui/UiSelect.vue";

const route = useRoute();
const router = useRouter();

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  webhook: "Webhook",
  wecom: "企业微信",
  dingtalk: "钉钉",
  email: "邮件",
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: "严重",
  warning: "警告",
  notice: "提示",
};

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "sent", label: "成功" },
  { value: "failed", label: "失败" },
];

const INPUT_CLASS =
  "h-8 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-subtle";

const readParam = (key: string): string => {
  const value = route.query[key];
  return typeof value === "string" ? value : "";
};
// SCRIPT_PLACEHOLDER
const deviceId = ref(readParam("deviceId"));
const channelId = ref(readParam("channelId"));
const statusFilter = ref(readParam("status"));

const channels = ref<NotifyChannelView[]>([]);
const records = ref<NotifySendRecord[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");

const PAGE_SIZE = 20;
const page = ref(1);

const load = async (): Promise<void> => {
  status.value = "loading";
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

const resetFilters = (): void => {
  deviceId.value = "";
  channelId.value = "";
  statusFilter.value = "";
  applyFilters();
};

onMounted(() => void load());

const pageCount = computed(() =>
  Math.max(1, Math.ceil(records.value.length / PAGE_SIZE)),
);
const pageRows = computed(() =>
  records.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString("zh-CN", { hour12: false });

const severitiesLabel = (severities: string[]): string =>
  severities.map((s) => SEVERITY_LABELS[s] ?? s).join(" / ") || "无";
</script>

<template>
  <PageHeader title="外发" scroll-content>
    <template #actions>
      <UiButton variant="secondary" size="sm" @click="load">刷新</UiButton>
    </template>

    <p class="text-sm text-ink-muted">
      渠道与分级路由在部署侧 notify.json 配置，密钥走环境变量，这里只读
    </p>

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

    <section class="flex flex-wrap items-end gap-3" aria-label="筛选">
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">设备</span>
        <input
          v-model="deviceId"
          type="search"
          placeholder="设备 ID"
          :class="INPUT_CLASS"
          @keyup.enter="applyFilters"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">渠道</span>
        <input
          v-model="channelId"
          type="search"
          placeholder="渠道 ID"
          :class="INPUT_CLASS"
          @keyup.enter="applyFilters"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">状态</span>
        <UiSelect
          v-model="statusFilter"
          :options="STATUS_OPTIONS"
          aria-label="按状态筛选"
        />
      </label>
      <UiButton size="sm" @click="applyFilters">查询</UiButton>
      <UiButton variant="ghost" size="sm" @click="resetFilters">重置</UiButton>
    </section>
    <!-- NOTIFY_TABLE_PLACEHOLDER -->
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
        class="overflow-auto rounded-sm border border-border"
        tabindex="0"
        role="region"
        aria-label="发送记录"
      >
        <table class="w-full border-collapse text-left text-sm">
          <caption class="sr-only">
            告警外发的发送记录，最新在前
          </caption>
          <thead class="bg-surface-sunken text-2xs text-ink-muted uppercase">
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
              class="border-t border-border"
            >
              <td class="px-3 py-2 whitespace-nowrap text-ink-muted">
                {{ formatTime(record.ts) }}
              </td>
              <td class="px-3 py-2 text-ink">{{ record.deviceId }}</td>
              <td class="px-3 py-2 text-ink">{{ record.title }}</td>
              <td class="px-3 py-2 text-ink">
                {{ record.channelId }}
                <span class="text-2xs text-ink-subtle">{{
                  CHANNEL_TYPE_LABELS[record.channelType] ?? record.channelType
                }}</span>
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ SEVERITY_LABELS[record.severity] ?? record.severity }}
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
              <td class="px-3 py-2 text-ink-muted">
                {{ record.error ?? "—" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div
        v-if="pageCount > 1"
        class="flex items-center justify-end gap-3 text-sm"
      >
        <UiButton
          variant="ghost"
          size="sm"
          :disabled="page <= 1"
          @click="page -= 1"
        >
          上一页
        </UiButton>
        <span class="text-ink-muted">第 {{ page }} / {{ pageCount }} 页</span>
        <UiButton
          variant="ghost"
          size="sm"
          :disabled="page >= pageCount"
          @click="page += 1"
        >
          下一页
        </UiButton>
      </div>
    </template>
  </PageHeader>
</template>
