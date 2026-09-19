<script setup lang="ts">
/**
 * 告警史面板 — cleared alerts with at-a-glance statistics, shown as the 消息 页 history tab.
 *
 * Phase 18 folded 告警史 from a top-level page into a tab of `AlertsView`. The shared filter
 * bar (severity / device / search) lives in `AlertsView` and writes the URL; this panel reads
 * the same query params, fetches cleared alerts once on mount, and derives severity
 * distribution, per-device counts, per-day frequency, acknowledgement rate and clear-time
 * durations client-side (`lib/alertStats.ts`) — the split and the 500-row cap unchanged from
 * the former `AlertHistoryView`.
 *
 * Read-only. Without MongoDB a `cleared` query returns nothing, so the empty state links to
 * 管理 / 系统状态, the page that can say whether Mongo is connected.
 */
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import CategoryBarChart from "@/components/charts/CategoryBarChart.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import { useFleetStore } from "@/stores/fleet";
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

const route = useRoute();
const fleet = useFleetStore();
const { palette } = useChartTheme();

const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");
const records = ref<AlertRecord[]>([]);
let requestId = 0;

/** Clear time in epoch ms, `-Infinity` when absent so undated rows sort last. */
const clearedMs = (record: AlertRecord): number => {
  const parsed = Date.parse(String(record.clearedAt ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const onsetMs = (record: AlertRecord): number =>
  Date.parse(String(record.firstSeenAt ?? record.ts ?? ""));

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

onMounted(() => void load());

// ── Filters, read from the URL that AlertsView's shared bar writes ────────────────────────
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
const search = computed(() => readParam("q"));

/** Prefer the fleet's current name for a device, then the record's, then the raw id. */
const deviceNameOf = (id: string, fallback?: string): string => {
  const known = fleet.devices.find((device) => device.deviceId === id);
  return known?.deviceName || fallback || id;
};

const filtered = computed(() =>
  records.value.filter((record) => {
    if (severity.value !== "all" && severityOf(record) !== severity.value)
      return false;
    if (
      deviceFilter.value &&
      String(record.deviceId ?? "") !== deviceFilter.value
    )
      return false;
    const keyword = search.value.trim().toLowerCase();
    if (!keyword) return true;
    return [
      record.title,
      record.detail,
      record.deviceName,
      record.deviceId,
      record.info,
      record.code,
    ]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(keyword));
  }),
);

const capped = computed(() => records.value.length >= RESULT_CAP);

// ── Derived statistics + chart inputs ─────────────────────────────────────────────────────
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
    label: deviceNameOf(device.deviceId, device.deviceName),
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
      deviceName: deviceNameOf(
        String(record.deviceId ?? ""),
        String(record.deviceName || ""),
      ),
      started: Number.isFinite(onset) ? formatDateTime(onset) : "--",
      cleared: Number.isFinite(clearedAt) ? formatDateTime(clearedAt) : "--",
      duration: formatDurationMs(durationMs),
      ackedBy: record.ackedBy ? String(record.ackedBy) : "",
    };
  }),
);
</script>

<template>
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
    暂无已清除的消息；已清除的消息需要后端连接 MongoDB 才会留存 ——
    <RouterLink
      to="/admin/system"
      class="text-brand-ink underline underline-offset-2"
      >管理 / 系统状态</RouterLink
    >
    会说明它此刻连上了没有
  </p>

  <p
    v-else-if="!filtered.length"
    class="m-0 rounded-md border border-border bg-surface-raised p-8 text-center text-sm text-ink-muted"
    role="status"
  >
    没有符合当前筛选条件的历史消息
  </p>

  <template v-else>
    <p v-if="capped" class="m-0 text-2xs text-ink-subtle">
      仅统计最近 {{ RESULT_CAP }} 条已清除消息（后端单次查询上限）
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
    <!-- Three charts, one row, equal height; the two that can grow past the frame scroll. -->
    <div class="grid gap-4 lg:grid-cols-3">
      <section class="rounded-md border border-border bg-surface-raised p-4">
        <CategoryBarChart
          :data="severityData"
          label="按严重度分布"
          unit="条"
          :height="240"
        />
      </section>
      <section class="rounded-md border border-border bg-surface-raised p-4">
        <CategoryBarChart
          :data="deviceData"
          label="按消息数分布"
          unit="条"
          orientation="horizontal"
          :height="240"
          scroll
        />
      </section>
      <section class="rounded-md border border-border bg-surface-raised p-4">
        <CategoryBarChart
          :data="dailyData"
          label="按时间天频次"
          unit="条"
          :height="240"
          scroll
        />
      </section>
    </div>

    <!-- Cleared-alert list, newest clear first -->
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
                class="text-xs text-brand-ink underline underline-offset-2"
                >{{ row.deviceName }}</RouterLink
              >
              <span v-else class="text-xs text-ink">{{ row.deviceName }}</span>
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
</template>
