<script setup lang="ts">
/**
 * 告警史 — the fleet's cleared alerts, with at-a-glance statistics (Phase 16B).
 *
 * The alert centre (`AlertsView`) shows *live* alerts off the store; this page is the other
 * half — what already happened. It reads `GET /api/alerts?status=cleared` (the endpoint's
 * historical path) and derives severity distribution, per-device Top-N, per-day frequency,
 * acknowledgement rate and clear-time durations client-side (`lib/alertStats.ts`). Heavy
 * time-bucketed aggregation is deliberately left to Phase 17A's aggregation layer; here the
 * numbers are computed over what the endpoint returns, bounded by its 500-row cap, which the
 * page states in words when it is hit.
 *
 * Read-only, so viewer+ — no mutating control lives here.
 *
 * The empty state matters as much as the content: `queryMemoryAlerts` keeps only active
 * alerts, so without MongoDB a `cleared` query returns nothing and a long-running fleet reads
 * like a pristine one. The empty text says what is missing and links to 管理 / 系统状态, the
 * page that can say whether Mongo is connected — the same reasoning as `DeviceAlertsTab`.
 */
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import CategoryBarChart from "@/components/charts/CategoryBarChart.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import { fleetApi, formatDateTime } from "@navfleet/fleet-core";
import type { AlertRecord } from "@navfleet/fleet-core";
import {
  computeAlertStats,
  formatDurationMs,
  severityOf,
  type Severity,
} from "@/lib/alertStats";

/** The endpoint's page size (`MAX_ALERTS_PER_QUERY`); a full page means older rows are cut. */
const RESULT_CAP = 500;

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "告警",
  warning: "预警",
  notice: "提示",
};

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "bg-critical-wash text-critical-ink",
  warning: "bg-warning-wash text-warning-ink",
  notice: "bg-notice-wash text-notice-ink",
};

const SEVERITIES: readonly { value: Severity | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "critical", label: "告警" },
  { value: "warning", label: "预警" },
  { value: "notice", label: "提示" },
];

const route = useRoute();
const router = useRouter();
const { palette } = useChartTheme();

const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");
const records = ref<AlertRecord[]>([]);
let requestId = 0;

const load = async (): Promise<void> => {
  const request = (requestId += 1);
  status.value = "loading";
  errorMessage.value = "";
  try {
    const payload = await fleetApi.getAlerts({ status: "cleared" });
    if (request !== requestId) return;
    records.value = [...(payload.items ?? [])].sort(
      (left, right) => clearedMs(right) - clearedMs(left),
    );
    status.value = "ready";
  } catch (error) {
    if (request !== requestId) return;
    records.value = [];
    status.value = "error";
    errorMessage.value =
      error instanceof Error ? error.message : "告警历史加载失败";
  }
};

/** Clear time in epoch ms, `-Infinity` when absent so undated rows sort last. */
const clearedMs = (record: AlertRecord): number => {
  const parsed = Date.parse(String(record.clearedAt ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const onsetMs = (record: AlertRecord): number =>
  Date.parse(String(record.firstSeenAt ?? record.ts ?? ""));

onMounted(() => void load());

// ── URL-backed filters (shareable, like the alert centre) ───────────────────────────────
const readParam = (key: string): string => {
  const value = route.query[key];
  return typeof value === "string" ? value : "";
};
const severity = computed<Severity | "all">(() => {
  const value = readParam("severity");
  return value === "critical" || value === "warning" || value === "notice"
    ? value
    : "all";
});
const deviceFilter = computed(() => readParam("device"));

const setFilter = (patch: Record<string, string | null>): void => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...route.query, ...patch })) {
    if (typeof value === "string" && value !== "") next[key] = value;
  }
  void router.replace({ query: next });
};

const deviceOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const record of records.value) {
    const id = String(record.deviceId ?? "");
    if (id && !seen.has(id)) seen.set(id, String(record.deviceName || id));
  }
  return [...seen]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
});

const filtered = computed(() =>
  records.value.filter((record) => {
    if (severity.value !== "all" && severityOf(record) !== severity.value)
      return false;
    if (
      deviceFilter.value &&
      String(record.deviceId ?? "") !== deviceFilter.value
    )
      return false;
    return true;
  }),
);

const capped = computed(() => records.value.length >= RESULT_CAP);

// ── Derived statistics + chart inputs ───────────────────────────────────────────────────
const stats = computed(() => computeAlertStats(filtered.value));

const severityData = computed(() =>
  (["critical", "warning", "notice"] as const).map((key) => ({
    label: SEVERITY_LABELS[key],
    value: stats.value.bySeverity[key],
    color: palette.value.status[key],
  })),
);

const deviceData = computed(() =>
  stats.value.topDevices.map((device) => ({
    label: device.deviceName,
    value: device.count,
  })),
);

const dailyData = computed(() =>
  stats.value.daily.map((entry) => ({ label: entry.day, value: entry.count })),
);

const ackRateLabel = computed(() =>
  stats.value.ackRate === null
    ? "--"
    : `${Math.round(stats.value.ackRate * 100)}%`,
);

interface Row {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  code: string;
  deviceId: string;
  deviceName: string;
  started: string;
  cleared: string;
  duration: string;
  ackedBy: string;
}

const rows = computed<Row[]>(() =>
  filtered.value.map((record, index) => {
    const onset = onsetMs(record);
    const clearedAt = clearedMs(record);
    const durationMs =
      Number.isFinite(onset) && Number.isFinite(clearedAt) && clearedAt >= onset
        ? clearedAt - onset
        : null;
    return {
      key: String(
        record.eventKey ?? record.id ?? `${record.deviceId ?? "?"}-${index}`,
      ),
      severity: severityOf(record),
      title: String(record.title || record.info || "未命名告警"),
      detail: String(record.detail || record.info || ""),
      code:
        Number.isFinite(record.code) && record.code ? String(record.code) : "",
      deviceId: String(record.deviceId ?? ""),
      deviceName: String(record.deviceName || record.deviceId || ""),
      started: Number.isFinite(onset) ? formatDateTime(onset) : "--",
      cleared: Number.isFinite(clearedAt) ? formatDateTime(clearedAt) : "--",
      duration: formatDurationMs(durationMs),
      ackedBy: record.ackedBy ? String(record.ackedBy) : "",
    };
  }),
);
</script>
<template>
  <PageHeader title="告警史" scroll-content>
    <p class="max-w-prose text-xs text-ink-muted">
      已清除告警的历史与统计，实时告警在
      <RouterLink
        to="/alerts"
        class="text-brand-ink underline-offset-2 hover:underline"
        >消息</RouterLink
      >
      页
    </p>

    <div class="flex flex-wrap items-end gap-3">
      <div
        class="flex overflow-hidden rounded-sm border border-border-strong"
        role="group"
        aria-label="严重度"
      >
        <button
          v-for="option in SEVERITIES"
          :key="option.value"
          type="button"
          class="px-2.5 py-1 text-xs transition-colors duration-150 ease-standard"
          :class="
            severity === option.value
              ? 'bg-brand text-brand-contrast'
              : 'bg-surface-raised text-ink-muted hover:text-ink'
          "
          :aria-pressed="severity === option.value"
          @click="
            setFilter({
              severity: option.value === 'all' ? null : option.value,
            })
          "
        >
          {{ option.label }}
        </button>
      </div>

      <label class="flex flex-col gap-1">
        <span class="font-mono text-2xs text-ink-subtle">设备</span>
        <UiSelect
          :model-value="deviceFilter"
          :options="[{ value: '', label: '全部设备' }, ...deviceOptions]"
          aria-label="设备筛选"
          @update:model-value="setFilter({ device: $event || null })"
        />
      </label>
    </div>

    <p v-if="status === 'loading'" class="m-0 text-sm text-ink-muted">
      正在加载告警历史…
    </p>

    <p
      v-else-if="status === 'error'"
      class="m-0 text-sm text-critical-ink"
      role="status"
    >
      {{ errorMessage }}
    </p>

    <!-- Without MongoDB a cleared query returns nothing; say what is missing and link to the
         page that can say whether Mongo is connected. -->
    <p
      v-else-if="!records.length"
      class="m-0 max-w-prose rounded-md border border-border bg-surface-raised p-8 text-center text-sm text-ink-muted"
      role="status"
    >
      暂无已清除的告警；已清除告警需要后端连接 MongoDB 才会留存 ——
      <RouterLink
        to="/admin/system"
        class="text-brand-ink underline-offset-2 hover:underline"
        >管理 / 系统状态</RouterLink
      >
      会说明它此刻连上了没有
    </p>

    <p
      v-else-if="!filtered.length"
      class="m-0 rounded-md border border-border bg-surface-raised p-8 text-center text-sm text-ink-muted"
      role="status"
    >
      没有符合当前筛选条件的历史告警
    </p>

    <template v-else>
      <p v-if="capped" class="m-0 text-2xs text-ink-subtle">
        仅统计最近 {{ RESULT_CAP }} 条已清除告警（后端单次查询上限）
      </p>

      <!-- Summary tiles -->
      <dl class="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-md border border-border bg-surface-raised p-3">
          <dt class="text-2xs text-ink-subtle">已清除</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ stats.total }}
          </dd>
        </div>
        <div class="rounded-md border border-border bg-surface-raised p-3">
          <dt class="text-2xs text-ink-subtle">确认率</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ ackRateLabel }}
          </dd>
        </div>
        <div class="rounded-md border border-border bg-surface-raised p-3">
          <dt class="text-2xs text-ink-subtle">平均时长</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ formatDurationMs(stats.duration.meanMs) }}
          </dd>
        </div>
        <div class="rounded-md border border-border bg-surface-raised p-3">
          <dt class="text-2xs text-ink-subtle">时长中位数</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ formatDurationMs(stats.duration.medianMs) }}
          </dd>
        </div>
      </dl>

      <!-- Charts -->
      <div class="grid gap-4 lg:grid-cols-2">
        <section class="rounded-md border border-border bg-surface-raised p-4">
          <CategoryBarChart
            :data="severityData"
            label="按严重度分布"
            unit="条"
            :height="220"
          />
        </section>
        <section class="rounded-md border border-border bg-surface-raised p-4">
          <CategoryBarChart
            :data="deviceData"
            label="设备 Top（按告警条数）"
            unit="条"
            orientation="horizontal"
            :height="220"
          />
        </section>
        <section
          class="rounded-md border border-border bg-surface-raised p-4 lg:col-span-2"
        >
          <CategoryBarChart
            :data="dailyData"
            label="按天频次"
            unit="条"
            :height="220"
          />
        </section>
      </div>

      <!-- Cleared-alert list -->
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        <li
          v-for="row in rows"
          :key="row.key"
          class="flex flex-col gap-1 rounded-md border border-border bg-surface-raised p-3"
          :data-severity="row.severity"
        >
          <div class="flex flex-wrap items-baseline gap-2">
            <span
              class="rounded-xs px-1.5 py-0.5 font-mono text-2xs"
              :class="SEVERITY_BADGE[row.severity]"
              >{{ SEVERITY_LABELS[row.severity] }}</span
            >
            <span
              v-if="row.code"
              class="font-mono text-sm tabular-nums text-ink"
              >{{ row.code }}</span
            >
            <strong class="text-sm text-ink">{{ row.title }}</strong>
            <span
              v-if="row.ackedBy"
              class="ml-auto font-mono text-2xs text-brand-ink"
              >已确认 · {{ row.ackedBy }}</span
            >
          </div>

          <p v-if="row.detail" class="m-0 text-xs text-ink-muted">
            {{ row.detail }}
          </p>

          <dl class="m-0 flex flex-wrap gap-x-4 gap-y-0.5">
            <div class="flex items-baseline gap-1.5">
              <dt class="text-2xs text-ink-subtle">设备</dt>
              <dd class="m-0">
                <RouterLink
                  v-if="row.deviceId"
                  :to="`/devices/${row.deviceId}`"
                  class="text-xs text-brand-ink underline-offset-2 hover:underline"
                  >{{ row.deviceName }}</RouterLink
                >
                <span v-else class="text-xs text-ink">{{
                  row.deviceName
                }}</span>
              </dd>
            </div>
            <div class="flex items-baseline gap-1.5">
              <dt class="text-2xs text-ink-subtle">发生</dt>
              <dd class="m-0 font-mono text-xs text-ink">{{ row.started }}</dd>
            </div>
            <div class="flex items-baseline gap-1.5">
              <dt class="text-2xs text-ink-subtle">清除</dt>
              <dd class="m-0 font-mono text-xs text-ink">{{ row.cleared }}</dd>
            </div>
            <div class="flex items-baseline gap-1.5">
              <dt class="text-2xs text-ink-subtle">时长</dt>
              <dd class="m-0 font-mono text-xs text-ink">{{ row.duration }}</dd>
            </div>
          </dl>
        </li>
      </ul>
    </template>
  </PageHeader>
</template>
