<script setup lang="ts">
/**
 * 报表 — 把已聚合的历史数据变成能交班/汇报的数字（Phase 17B-1）。
 *
 * 消费两个服务端聚合端点（17A）：`/reports/availability`（每设备每桶的在线率与电量）与
 * `/reports/alerts`（严重度分布 / 设备 Top-N / 日频次 / 确认率 / 处理时长）。页面自己不算聚合——
 * 那是 17A 的事；这里只取数、按版式 B（顶部 KPI 带 + 两栏）渲染、导出 CSV。
 *
 * 只读，viewer+。四态里空态最要紧：无 Mongo 时两个报表都回 `available:false`，一个长期运行的车队
 * 会读起来像刚上线。空态说清缺的是 MongoDB 并链到 管理/系统状态（同 告警史 / DeviceAlertsTab 的做法）。
 *
 * 纯逻辑（KPI 汇总、时序序列、CSV）在 `lib/reportsView.ts`，便于单测；这里保持薄。
 */
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import CategoryBarChart from "@/components/charts/CategoryBarChart.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import { useFleetStore } from "@/stores/fleet";
import { fleetApi } from "@navfleet/fleet-core";
import type {
  AlertStatsReport,
  AvailabilityReport,
  ReportBucketUnit,
} from "@navfleet/shared";
import {
  buildAvailabilityCsv,
  onlineRatioSeries,
  socSeries,
  summarizeAvailability,
  windowForPreset,
  type RangePreset,
} from "@/lib/reportsView";

const RANGES: readonly { value: RangePreset; label: string }[] = [
  { value: "12h", label: "近 12 小时" },
  { value: "24h", label: "近 1 天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];
const RANGE_VALUES: readonly RangePreset[] = ["12h", "24h", "7d", "30d"];
const BUCKETS: readonly { value: ReportBucketUnit; label: string }[] = [
  { value: "hour", label: "按小时" },
  { value: "day", label: "按天" },
  { value: "month", label: "按月" },
];
/** Date inputs share the audit page's field styling so the controls line up across pages. */
const DATE_INPUT_CLASS =
  "h-7 rounded-sm border border-border-strong bg-surface px-2 text-xs text-ink";
const SEVERITY_LABELS = {
  critical: "告警",
  warning: "预警",
  notice: "提示",
} as const;

const route = useRoute();
const router = useRouter();
const { palette } = useChartTheme();
const fleet = useFleetStore();

const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");
const availability = ref<AvailabilityReport | null>(null);
const alertStats = ref<AlertStatsReport | null>(null);
let requestId = 0;

// ── URL-backed filters (shareable) ──────────────────────────────────────────────────────
const readParam = (key: string): string => {
  const value = route.query[key];
  return typeof value === "string" ? value : "";
};
const range = computed<RangePreset>(() => {
  const value = readParam("range");
  return RANGE_VALUES.includes(value as RangePreset)
    ? (value as RangePreset)
    : "12h";
});
const bucket = computed<ReportBucketUnit>(() => {
  const value = readParam("bucket");
  return value === "hour" || value === "month" ? value : "day";
});
const deviceFilter = computed(() => readParam("device"));

/**
 * Custom window: two `YYYY-MM-DD` params. Active only when both are set and 起 ≤ 止 — an
 * inverted or half-filled range falls back to the preset rather than fetching nonsense.
 * Selecting a preset clears them; picking dates clears the preset (they are one control in
 * two shapes). The backend already takes `from`/`to`, so this needs no new endpoint.
 */
const customFrom = computed(() => readParam("from"));
const customTo = computed(() => readParam("to"));
const isCustom = computed(
  () =>
    Boolean(customFrom.value) &&
    Boolean(customTo.value) &&
    customFrom.value <= customTo.value,
);

const setCustom = (patch: { from?: string; to?: string }): void => {
  const nextFrom = patch.from ?? customFrom.value;
  const nextTo = patch.to ?? customTo.value;
  setFilter({ from: nextFrom || null, to: nextTo || null, range: null });
};

const setFilter = (patch: Record<string, string | null>): void => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...route.query, ...patch })) {
    if (typeof value === "string" && value !== "") next[key] = value;
  }
  void router.replace({ query: next });
};

/** deviceId → 名称，取自实时车队；没有则回退到 id。 */
const nameOf = (deviceId: string): string =>
  fleet.devices.find((device) => device.deviceId === deviceId)?.deviceName ||
  deviceId;

const load = async (): Promise<void> => {
  const request = (requestId += 1);
  status.value = "loading";
  errorMessage.value = "";
  const window = isCustom.value
    ? {
        from: new Date(`${customFrom.value}T00:00:00`).toISOString(),
        to: new Date(`${customTo.value}T23:59:59.999`).toISOString(),
      }
    : windowForPreset(range.value, Date.now());
  try {
    const [avail, alerts] = await Promise.all([
      fleetApi.getAvailabilityReport({
        from: window.from,
        to: window.to,
        bucket: bucket.value,
        deviceId: deviceFilter.value || undefined,
      }),
      fleetApi.getAlertStatsReport({ from: window.from, to: window.to }),
    ]);
    if (request !== requestId) return;
    availability.value = avail;
    alertStats.value = alerts;
    status.value = "ready";
  } catch (error) {
    if (request !== requestId) return;
    availability.value = null;
    alertStats.value = null;
    status.value = "error";
    errorMessage.value =
      error instanceof Error ? error.message : "报表加载失败";
  }
};

onMounted(() => void load());
watch([range, bucket, deviceFilter, customFrom, customTo], () => void load());

// ── Derived: availability / KPI band ────────────────────────────────────────────────────
const noHistory = computed(
  () =>
    availability.value?.available === false &&
    alertStats.value?.available === false,
);
const summary = computed(() =>
  availability.value ? summarizeAvailability(availability.value) : null,
);
const onlineSeries = computed(() =>
  availability.value ? onlineRatioSeries(availability.value, nameOf) : [],
);
const batterySeries = computed(() =>
  availability.value ? socSeries(availability.value, nameOf) : [],
);
const hasAvailabilityData = computed(() =>
  onlineSeries.value.some((series) => series.points.length > 0),
);

const onlineRatioLabel = computed(() =>
  summary.value?.onlineRatio == null
    ? "--"
    : `${(summary.value.onlineRatio * 100).toFixed(1)}%`,
);
const socLabel = computed(() =>
  summary.value?.socMean == null
    ? "--"
    : `${summary.value.socMean.toFixed(1)}%`,
);
const ackRateLabel = computed(() =>
  alertStats.value?.ackRate == null
    ? "--"
    : `${Math.round(alertStats.value.ackRate * 100)}%`,
);
const alertTotal = computed(() => alertStats.value?.total ?? 0);

// ── Derived: alert charts ───────────────────────────────────────────────────────────────
const severityData = computed(() =>
  alertStats.value
    ? (["critical", "warning", "notice"] as const).map((key) => ({
        label: SEVERITY_LABELS[key],
        value: alertStats.value!.bySeverity[key],
        color: palette.value.status[key],
      }))
    : [],
);
const deviceData = computed(() =>
  alertStats.value
    ? alertStats.value.topDevices.map((device) => ({
        label: nameOf(device.deviceId),
        value: device.count,
      }))
    : [],
);
const dailyData = computed(() =>
  alertStats.value
    ? alertStats.value.daily.map((entry) => ({
        label: entry.day,
        value: entry.count,
      }))
    : [],
);
const hasAlertData = computed(() => alertTotal.value > 0);

// ── Device filter options (union of live fleet + whatever the report carries) ────────────
const deviceOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const device of fleet.devices) {
    if (device.deviceId)
      seen.set(device.deviceId, device.deviceName || device.deviceId);
  }
  for (const device of availability.value?.devices ?? []) {
    if (!seen.has(device.deviceId))
      seen.set(device.deviceId, nameOf(device.deviceId));
  }
  return [...seen]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
});

// ── CSV export (client-side, no dependency; BOM so Excel reads the Chinese header) ───────
const exportCsv = (): void => {
  if (!availability.value) return;
  const csv = buildAvailabilityCsv(availability.value, nameOf);
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `navfleet-可用率-${range.value}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
};
</script>

<template>
  <PageHeader title="报表" scroll-content>
    <p class="max-w-prose text-xs text-ink-muted">
      车队可用率、电量与消息的聚合视图，可导出交班/汇报
    </p>

    <!-- Filters in one row above the charts (data-viz convention), export at the end. -->
    <div class="flex flex-wrap items-end gap-3">
      <div
        class="flex overflow-hidden rounded-sm border border-border-strong"
        role="group"
        aria-label="时间范围"
      >
        <button
          v-for="option in RANGES"
          :key="option.value"
          type="button"
          class="px-2.5 py-1 text-xs transition-colors duration-150 ease-standard"
          :class="
            !isCustom && range === option.value
              ? 'bg-brand text-brand-contrast'
              : 'bg-surface-raised text-ink-muted hover:text-ink'
          "
          :aria-pressed="!isCustom && range === option.value"
          @click="setFilter({ range: option.value, from: null, to: null })"
        >
          {{ option.label }}
        </button>
      </div>

      <!-- 自定义起止：与预设是同一控件的两种形态，选日期即接管，选预设即清空。起 ≤ 止 由
           原生 min/max 约束，另在 isCustom 里兜底。 -->
      <label class="flex flex-col gap-1">
        <span class="font-mono text-2xs text-ink-subtle">起</span>
        <input
          type="date"
          :class="DATE_INPUT_CLASS"
          :value="customFrom"
          :max="customTo || undefined"
          aria-label="自定义起始日期"
          @change="
            setCustom({ from: ($event.target as HTMLInputElement).value })
          "
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="font-mono text-2xs text-ink-subtle">止</span>
        <input
          type="date"
          :class="DATE_INPUT_CLASS"
          :value="customTo"
          :min="customFrom || undefined"
          aria-label="自定义结束日期"
          @change="setCustom({ to: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="font-mono text-2xs text-ink-subtle">粒度</span>
        <UiSelect
          :model-value="bucket"
          :options="BUCKETS"
          aria-label="分桶粒度"
          @update:model-value="setFilter({ bucket: $event })"
        />
      </label>

      <label class="flex flex-col gap-1">
        <span class="font-mono text-2xs text-ink-subtle">设备</span>
        <UiSelect
          :model-value="deviceFilter"
          :options="[{ value: '', label: '全部设备' }, ...deviceOptions]"
          aria-label="设备筛选"
          @update:model-value="setFilter({ device: $event || null })"
        />
      </label>

      <button
        type="button"
        class="ml-auto rounded-sm border border-border-strong bg-surface-raised px-3 py-1 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="status !== 'ready' || !hasAvailabilityData"
        @click="exportCsv"
      >
        导出 CSV ↗
      </button>
    </div>

    <!-- Loading: a skeleton in the shape of the result (KPI band + two chart columns) rather
         than a bare line, so the wait reads as "this is filling in" — the aggregation can be
         slow. Blocks are decorative; a screen reader hears the sr-only status instead. -->
    <div v-if="status === 'loading'" class="flex flex-col gap-4">
      <p class="sr-only" role="status">正在加载报表…</p>
      <dl class="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
        <div
          v-for="n in 4"
          :key="n"
          class="h-[4.5rem] rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
        />
      </dl>
      <div class="grid gap-4 lg:grid-cols-[2fr_1fr]" aria-hidden="true">
        <div class="flex flex-col gap-4">
          <div
            class="h-64 rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
          />
          <div
            class="h-64 rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
          />
        </div>
        <div
          class="h-64 rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
        />
      </div>
    </div>

    <p
      v-else-if="status === 'error'"
      class="m-0 text-sm text-critical-ink"
      role="status"
    >
      {{ errorMessage }}
    </p>

    <!-- No Mongo ⇒ both reports honest-empty; say what is missing and link to 系统状态. -->
    <p
      v-else-if="noHistory"
      class="m-0 max-w-prose rounded-md border border-border bg-surface-raised p-8 text-center text-sm text-ink-muted"
      role="status"
    >
      暂无历史可聚合；报表依赖后端连接 MongoDB ——
      <RouterLink
        to="/admin/system"
        class="text-brand-ink underline underline-offset-2"
        >管理 / 系统状态</RouterLink
      >
      会说明它此刻连上了没有
    </p>

    <template v-else>
      <!-- KPI band (layout B): fleet-wide headline numbers across both reports. -->
      <dl class="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-md border border-border bg-surface-raised p-3">
          <dt class="text-2xs text-ink-subtle">平均在线率</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ onlineRatioLabel }}
          </dd>
        </div>
        <div class="rounded-md border border-border bg-surface-raised p-3">
          <dt class="text-2xs text-ink-subtle">平均电量</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ socLabel }}
          </dd>
        </div>
        <div class="rounded-md border border-border bg-surface-raised p-3">
          <dt class="text-2xs text-ink-subtle">消息总数</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ alertTotal }}
          </dd>
        </div>
        <div class="rounded-md border border-border bg-surface-raised p-3">
          <dt class="text-2xs text-ink-subtle">确认率</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ ackRateLabel }}
          </dd>
        </div>
      </dl>

      <!-- Two columns: left = availability/battery over time (wider), right = message
           breakdown, narrowed to the 消息摘要 proportion so its empty state is not a wide slab. -->
      <div class="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div class="flex flex-col gap-4">
          <section
            class="rounded-md border border-border bg-surface-raised p-4"
          >
            <TimeSeriesChart
              v-if="hasAvailabilityData"
              :series="onlineSeries"
              label="在线率趋势"
              unit="%"
              :height="240"
              legend-position="right"
            />
            <p v-else class="m-0 py-8 text-center text-sm text-ink-muted">
              该时间段没有遥测样本
            </p>
          </section>
          <section
            class="rounded-md border border-border bg-surface-raised p-4"
          >
            <TimeSeriesChart
              v-if="hasAvailabilityData"
              :series="batterySeries"
              label="电量SOC均值"
              unit="%"
              :height="240"
              legend-position="right"
            />
            <p v-else class="m-0 py-8 text-center text-sm text-ink-muted">
              该时间段没有电量样本
            </p>
          </section>
        </div>

        <div class="flex flex-col gap-4">
          <section
            class="rounded-md border border-border bg-surface-raised p-4"
          >
            <CategoryBarChart
              v-if="hasAlertData"
              :data="severityData"
              label="按严重度分布"
              unit="条"
              :height="200"
            />
            <p v-else class="m-0 py-8 text-center text-sm text-ink-muted">
              该时间段没有消息
            </p>
          </section>
          <section
            v-if="hasAlertData"
            class="rounded-md border border-border bg-surface-raised p-4"
          >
            <CategoryBarChart
              :data="deviceData"
              label="按消息数分布"
              unit="条"
              orientation="horizontal"
              :height="200"
            />
          </section>
          <section
            v-if="hasAlertData"
            class="rounded-md border border-border bg-surface-raised p-4"
          >
            <CategoryBarChart
              :data="dailyData"
              label="按时间天频次"
              unit="条"
              :height="200"
            />
          </section>
        </div>
      </div>
    </template>
  </PageHeader>
</template>
