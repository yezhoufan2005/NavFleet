<script setup lang="ts">
/**
 * 报表 — 把已聚合的历史数据变成能交班/汇报的数字（Phase 17B-1）。
 *
 * 消费两个服务端聚合端点（17A）：`/reports/availability`（每设备每桶的在线率与电量）与
 * `/reports/alerts`（严重度分布 / 设备 Top-N / 日频次 / 确认率 / 处理时长）。页面自己不算聚合——
 * 那是 17A 的事；这里只取数、按版式 B（顶部 KPI 带 + 两栏）渲染、导出 CSV。
 *
 * 只读，viewer+。四态里空态最要紧：无 Mongo 时两个报表都回 `available:false`，一个长期运行的车队
 * 会读起来像刚上线。空态说清缺的是 MongoDB 并链到 管理/系统状态（同 消息史 / DeviceAlertsTab 的做法）。
 *
 * 纯逻辑（KPI 汇总、时序序列、CSV）在 `lib/reportsView.ts`，便于单测；这里保持薄。
 */
import { computed, onMounted, ref, useTemplateRef, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSegmented from "@/components/ui/UiSegmented.vue";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";
import UiFilterBar from "@/components/ui/UiFilterBar.vue";
import UiFilterField from "@/components/ui/UiFilterField.vue";
import { SEVERITY_LABELS } from "@/lib/severity";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import CategoryBarChart from "@/components/charts/CategoryBarChart.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import { useScrollbarGutter } from "@/composables/useScrollbarGutter";
import { useFleetStore } from "@/stores/fleet";
import { fleetApi } from "@navfleet/fleet-core";
import type {
  AlertStatsReport,
  AvailabilityReport,
  ReportBucketUnit,
} from "@navfleet/shared";
import {
  buildAlertStatsCsv,
  buildAvailabilityCsv,
  defaultBucketForPreset,
  defaultBucketForSpanMs,
  deviceAvailabilityRows,
  onlineRatioSeries,
  socSeries,
  sparklinePoints,
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
const route = useRoute();
const router = useRouter();
const { palette } = useChartTheme();
const fleet = useFleetStore();
// Keeps the 按设备明细 split header aligned with its scrolling body (shared with the chart tables).
const detailBody = useTemplateRef<HTMLElement>("detailBody");
const detailGutter = useScrollbarGutter(detailBody);

// 可用率与告警是两条独立的后端聚合，慢/错的那条不该连累另一条（可用率宽窗要几十秒，告警是秒级）。
// 所以两者各有自己的加载/错误态，分别渲染；整页不再因一条失败而空白。
type LoadState = "loading" | "ready" | "error";
const availStatus = ref<LoadState>("loading");
const alertStatus = ref<LoadState>("loading");
const availError = ref("");
const alertError = ref("");
const availability = ref<AvailabilityReport | null>(null);
const alertStats = ref<AlertStatsReport | null>(null);
let requestId = 0;
/** The device set the on-screen availability belongs to, so a device change can clear it. */
let lastDeviceKey = "";

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
/**
 * 粒度 (bucket) is **not a user control** — it is derived from the selected window. A separate
 * selector only invited nonsense combinations (按月 over 12 小时) and begged for cascade logic;
 * driving it off the span is simpler and always coherent: 短窗→按小时, 中→按天, 长→按月.
 */
const bucket = computed<ReportBucketUnit>(() => {
  if (isCustom.value) {
    const span =
      new Date(`${customTo.value}T23:59:59.999`).getTime() -
      new Date(`${customFrom.value}T00:00:00`).getTime();
    return defaultBucketForSpanMs(
      Number.isFinite(span) && span > 0 ? span : 86_400_000,
    );
  }
  return defaultBucketForPreset(range.value);
});
/**
 * 设备 is multi-select: a comma-joined `device` key narrows the aggregate to the chosen vehicles
 * (each still its own series on the charts); an empty list is 全部设备. The server parses the same
 * comma list back into a set — see `reportAvailabilityQuerySchema`.
 */
const deviceFilter = computed(() => {
  const raw = readParam("device");
  return raw ? raw.split(",").filter(Boolean) : [];
});

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

const load = (): void => {
  const request = (requestId += 1);
  const window = isCustom.value
    ? {
        from: new Date(`${customFrom.value}T00:00:00`).toISOString(),
        to: new Date(`${customTo.value}T23:59:59.999`).toISOString(),
      }
    : windowForPreset(range.value, Date.now());

  // When the *device set* changes, drop the stale report before refetching. Otherwise the charts
  // would re-render the previous devices under the new per-device/fleet mode for a frame — the
  // 「选单台却闪过全部设备」 flash. A range/bucket change keeps the same devices, so stale-while-
  // loading is fine there and avoids a needless blank.
  const deviceKey = deviceFilter.value.join(",");
  if (deviceKey !== lastDeviceKey) {
    availability.value = null;
    onlineSeries.value = [];
    batterySeries.value = [];
    lastDeviceKey = deviceKey;
  }

  // Two independent fetches — neither awaits the other, and a reject on one leaves the other's
  // result on screen. `requestId` discards any response from a superseded filter round.
  availStatus.value = "loading";
  availError.value = "";
  fleetApi
    .getAvailabilityReport({
      from: window.from,
      to: window.to,
      bucket: bucket.value,
      deviceId: deviceFilter.value.length
        ? deviceFilter.value.join(",")
        : undefined,
    })
    .then((report) => {
      if (request !== requestId) return;
      availability.value = report;
      // Snapshot the series + window now (see the refs' comment for why not computed).
      const perDevice = deviceFilter.value.length > 0;
      onlineSeries.value = onlineRatioSeries(report, nameOf, { perDevice });
      batterySeries.value = socSeries(report, nameOf, { perDevice });
      chartWindow.value = {
        from: Date.parse(window.from),
        to: Date.parse(window.to),
      };
      availStatus.value = "ready";
    })
    .catch((error: unknown) => {
      if (request !== requestId) return;
      availability.value = null;
      onlineSeries.value = [];
      batterySeries.value = [];
      availStatus.value = "error";
      availError.value =
        error instanceof Error ? error.message : "可用率报表加载失败";
    });

  alertStatus.value = "loading";
  alertError.value = "";
  fleetApi
    .getAlertStatsReport({ from: window.from, to: window.to })
    .then((report) => {
      if (request !== requestId) return;
      alertStats.value = report;
      alertStatus.value = "ready";
    })
    .catch((error: unknown) => {
      if (request !== requestId) return;
      alertStats.value = null;
      alertStatus.value = "error";
      alertError.value =
        error instanceof Error ? error.message : "消息报表加载失败";
    });
};

/**
 * Coalesce a burst of filter changes into one fetch (Phase 18). A single user action can touch
 * several URL params at once (选预设 clears the custom dates; 选日期 clears the preset), and each
 * flips a computed this view watches. Queuing the load on a microtask collapses that burst to one
 * request instead of firing — and then discarding via `requestId` — two or three. Still a single
 * tick, so tests that `flushPromises()` after a change see the refetch.
 */
let loadQueued = false;
const scheduleLoad = (): void => {
  if (loadQueued) return;
  loadQueued = true;
  void Promise.resolve().then(() => {
    loadQueued = false;
    void load();
  });
};

onMounted(() => scheduleLoad());
watch([range, bucket, deviceFilter, customFrom, customTo], () =>
  scheduleLoad(),
);

// ── Derived: page-level states ───────────────────────────────────────────────────────────
/** First paint, before either report has returned anything — show the full skeleton once. */
const initialLoading = computed(
  () =>
    availStatus.value === "loading" &&
    alertStatus.value === "loading" &&
    !availability.value &&
    !alertStats.value,
);
/** Both backends answered "no history" (no Mongo) ⇒ the honest-empty page. */
const noHistory = computed(
  () =>
    availability.value?.available === false &&
    alertStats.value?.available === false,
);

// ── Derived: availability / KPI band ────────────────────────────────────────────────────
/** Selecting devices turns the two charts into a per-vehicle comparison (one line each); with
 * none selected they fold to a single fleet-average line so the default is not N tangled lines. */
const comparingDevices = computed(() => deviceFilter.value.length > 0);
const summary = computed(() =>
  availability.value ? summarizeAvailability(availability.value) : null,
);
/**
 * The chart series are a **snapshot taken at fetch time**, not a computed — deliberately. If they
 * recomputed on every reactive read they depend on, the live fleet store (names via `nameOf`)
 * ticking every couple of seconds would hand ECharts a fresh series array each tick and the lines
 * would re-animate left-to-right forever. Set once per load, they animate once and settle.
 */
const onlineSeries = ref<ReturnType<typeof onlineRatioSeries>>([]);
const batterySeries = ref<ReturnType<typeof socSeries>>([]);
/** The selected window in epoch ms, so the chart's time axis spans the whole range (e.g. a full
 * 12h) even when telemetry only covers part of it — otherwise the axis shrinks to the data. */
const chartWindow = ref<{ from: number; to: number } | null>(null);
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

// ── Derived: KPI sparklines + per-device detail (Phase 18 「分析工作台」) ───────────────────
/** Mini trend under 平均在线率/平均电量 — always the fleet-average line (perDevice off) so the
 * sparkline matches the fleet KPI above it even while the big charts are split per device. Empty
 * string when there are fewer than two points, so the template drops the <svg>. */
const SPARK_W = 72;
const SPARK_H = 22;
const onlineSpark = computed(() =>
  availability.value
    ? sparklinePoints(
        onlineRatioSeries(availability.value, nameOf),
        SPARK_W,
        SPARK_H,
      )
    : "",
);
const batterySpark = computed(() =>
  availability.value
    ? sparklinePoints(socSeries(availability.value, nameOf), SPARK_W, SPARK_H)
    : "",
);

/** 确认率 context: 已确认 N / 共 M, derived from ackRate × total (the report carries no raw acked). */
const ackedCount = computed(() =>
  alertStats.value?.ackRate == null
    ? null
    : Math.round(alertStats.value.ackRate * alertTotal.value),
);

/** 严重度占比条（顶部「消息总数」卡）：已取到的分布，按 critical→warning→notice 堆叠。 */
const severityBar = computed(() => {
  const stats = alertStats.value;
  if (!stats || stats.total === 0) return [];
  return (["critical", "warning", "notice"] as const)
    .map((key) => ({
      key,
      label: SEVERITY_LABELS[key],
      count: stats.bySeverity[key],
      pct: (stats.bySeverity[key] / stats.total) * 100,
    }))
    .filter((segment) => segment.count > 0);
});
const SEVERITY_SEGMENT_CLASS: Record<string, string> = {
  critical: "bg-critical",
  warning: "bg-warning",
  notice: "bg-notice",
};

/** 按设备明细行（「可用率与电量」分区可展开表）：每台真实设备一行，无聚合折叠。 */
const availabilityRows = computed(() =>
  availability.value ? deviceAvailabilityRows(availability.value, nameOf) : [],
);
const fmtPct = (value: number | null, digits = 1): string =>
  value == null ? "--" : `${(value * 100).toFixed(digits)}%`;
const fmtSoc = (value: number | null): string =>
  value == null ? "--" : `${value.toFixed(1)}%`;

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

/** 消息统计导出，与可用率对等（1.6.1）——聚合报表用长表装下页面显示的一切。 */
const exportAlertsCsv = (): void => {
  if (!alertStats.value) return;
  const csv = buildAlertStatsCsv(alertStats.value, nameOf);
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `navfleet-消息统计-${range.value}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
};
</script>

<template>
  <PageHeader title="报表">
    <template #actions>
      <UiButton
        variant="secondary"
        size="sm"
        :disabled="availStatus !== 'ready' || !hasAvailabilityData"
        @click="exportCsv"
      >
        导出可用率 ↗
      </UiButton>
      <UiButton
        variant="secondary"
        size="sm"
        :disabled="alertStatus !== 'ready' || !hasAlertData"
        @click="exportAlertsCsv"
      >
        导出消息 ↗
      </UiButton>
    </template>

    <AppSectionTabs />

    <!-- Filters in one row above the charts (data-viz convention), export at the end. -->
    <UiFilterBar>
      <UiFilterField label="范围">
        <UiSegmented
          :model-value="customFrom || customTo ? '' : range"
          :options="RANGES"
          aria-label="时间范围"
          @update:model-value="
            (value) => setFilter({ range: value, from: null, to: null })
          "
        />
      </UiFilterField>

      <!-- 自定义起止：与预设是同一控件的两种形态，选日期即接管，选预设即清空。起 ≤ 止 由
           原生 min/max 约束，另在 isCustom 里兜底。 -->
      <UiFilterField label="起始时间">
        <UiInput
          type="date"
          :model-value="customFrom"
          :max="customTo || undefined"
          aria-label="自定义起始日期"
          @update:model-value="(value) => setCustom({ from: value })"
        />
      </UiFilterField>
      <UiFilterField label="结束时间">
        <UiInput
          type="date"
          :model-value="customTo"
          :min="customFrom || undefined"
          aria-label="自定义结束日期"
          @update:model-value="(value) => setCustom({ to: value })"
        />
      </UiFilterField>

      <UiFilterField label="设备">
        <UiMultiSelect
          :model-value="deviceFilter"
          :options="deviceOptions"
          placeholder="全部设备"
          aria-label="设备筛选"
          @update:model-value="
            (value) =>
              setFilter({ device: value.length ? value.join(',') : null })
          "
        />
      </UiFilterField>
    </UiFilterBar>

    <!-- Loading: a skeleton in the shape of the result (KPI band + two chart columns) rather
         than a bare line, so the wait reads as "this is filling in" — the aggregation can be
         slow. Blocks are decorative; a screen reader hears the sr-only status instead. -->
    <div v-if="initialLoading" class="flex flex-col gap-4">
      <p class="sr-only" role="status">正在加载报表…</p>
      <dl class="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden="true">
        <div
          v-for="n in 4"
          :key="n"
          class="h-[4.5rem] rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
        />
      </dl>
      <div class="grid gap-4 lg:grid-cols-2" aria-hidden="true">
        <div
          class="h-64 rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
        />
        <div
          class="h-64 rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
        />
      </div>
    </div>

    <!-- No Mongo ⇒ both reports honest-empty; say what is missing and link to 系统状态. -->
    <p
      v-else-if="noHistory"
      class="m-0 max-w-prose rounded-md border border-border bg-surface-raised p-8 text-center text-sm text-ink-muted"
      role="status"
    >
      暂无历史可聚合：报表依赖后端连接MongoDB——
      <RouterLink
        to="/system"
        class="text-brand-ink underline underline-offset-2"
        >管理 / 系统状态</RouterLink
      >
      说明连接情况
    </p>

    <template v-else>
      <!-- KPI band: fleet-wide headline numbers, each carrying a scrap of the data behind it
           (a sparkline / a distribution bar / a count) so the strip reads as analysis, not four
           lone digits. All from the data already fetched — no extra request. -->
      <dl class="m-0 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div
          class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
        >
          <dt class="text-2xs text-ink-subtle">平均在线率</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ onlineRatioLabel }}
          </dd>
          <svg
            v-if="onlineSpark"
            class="mt-auto h-6 w-full text-success"
            :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              :points="onlineSpark"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
              stroke-linecap="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div
          class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
        >
          <dt class="text-2xs text-ink-subtle">平均电量</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ socLabel }}
          </dd>
          <svg
            v-if="batterySpark"
            class="mt-auto h-6 w-full text-notice"
            :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              :points="batterySpark"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
              stroke-linecap="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div
          class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
        >
          <dt class="text-2xs text-ink-subtle">消息总数</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ alertTotal }}
          </dd>
          <div
            v-if="severityBar.length"
            class="mt-auto flex h-2 overflow-hidden rounded-xs"
            role="presentation"
          >
            <span
              v-for="segment in severityBar"
              :key="segment.key"
              class="h-full"
              :class="SEVERITY_SEGMENT_CLASS[segment.key]"
              :style="{ width: `${segment.pct}%` }"
              :title="`${segment.label} ${segment.count}`"
            />
          </div>
        </div>
        <div
          class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
        >
          <dt class="text-2xs text-ink-subtle">确认率</dt>
          <dd class="m-0 font-mono text-lg tabular-nums text-ink">
            {{ ackRateLabel }}
          </dd>
          <span
            v-if="ackedCount !== null"
            class="mt-auto text-2xs text-ink-subtle"
          >
            已确认 {{ ackedCount }} / 共 {{ alertTotal }}
          </span>
        </div>
      </dl>

      <!-- Section 可用率与电量: the fleet-average trends, plus a per-device breakdown that opens
           on demand — the comparison surface that turns the page into an analysis workstation
           without crowding the charts with N lines. -->
      <section class="flex flex-col gap-3" aria-labelledby="avail-heading">
        <div
          class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
        >
          <h2 id="avail-heading" class="m-0 text-sm font-semibold text-ink">
            可用率与电量
          </h2>
          <span class="text-2xs text-ink-subtle">
            {{
              comparingDevices
                ? `正在对比 ${deviceFilter.length} 台设备`
                : "选择设备对比数据；默认全部设备均值"
            }}
          </span>
        </div>

        <p
          v-if="availStatus === 'error'"
          class="m-0 rounded-md border border-border bg-surface-raised p-4 text-sm text-critical-ink"
          role="status"
        >
          可用率加载失败：{{ availError }}
        </p>
        <!-- Loading placeholder matches the two charts' footprint (h-[272px] each) so switching
             devices never collapses the card — the 「消息分析」 heading below stays put. -->
        <template v-else-if="availStatus === 'loading' && !hasAvailabilityData">
          <p class="sr-only" role="status">正在加载可用率…</p>
          <div class="grid gap-4 lg:grid-cols-2" aria-hidden="true">
            <div
              class="h-[272px] rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
            />
            <div
              class="h-[272px] rounded-md border border-border bg-surface-raised motion-safe:animate-pulse"
            />
          </div>
        </template>
        <div v-else class="grid gap-4 lg:grid-cols-2">
          <div class="rounded-md border border-border bg-surface-raised p-4">
            <TimeSeriesChart
              v-if="hasAvailabilityData"
              :series="onlineSeries"
              label="在线率趋势"
              unit="%"
              :height="240"
              legend-position="right"
              table-match-height
              y-scale
              :x-min="chartWindow?.from"
              :x-max="chartWindow?.to"
            />
            <p v-else class="m-0 py-8 text-center text-sm text-ink-muted">
              该时间段没有遥测样本
            </p>
          </div>
          <div class="rounded-md border border-border bg-surface-raised p-4">
            <TimeSeriesChart
              v-if="hasAvailabilityData"
              :series="batterySeries"
              label="电量SOC均值"
              unit="%"
              :height="240"
              legend-position="right"
              table-match-height
              y-scale
              :x-min="chartWindow?.from"
              :x-max="chartWindow?.to"
            />
            <p v-else class="m-0 py-8 text-center text-sm text-ink-muted">
              该时间段没有电量样本
            </p>
          </div>
        </div>

        <!-- Per-device detail: collapsed by default so the section stays scannable; open it to
             compare vehicles one row each. -->
        <details
          v-if="availStatus === 'ready' && availabilityRows.length"
          class="group rounded-md border border-border bg-surface-raised"
        >
          <summary
            class="cursor-pointer select-none list-none px-4 py-2 text-xs text-ink-muted marker:content-none hover:text-ink"
          >
            <span class="inline-block transition-transform group-open:rotate-90"
              >▸</span
            >
            按设备明细（{{ availabilityRows.length }} 行）
          </summary>
          <!-- Same split shape as the chart tables: gray header outside the scroll box (covers the
               scrollbar), padded by the body's scrollbar width so columns stay aligned. -->
          <div class="border-t border-border">
            <div
              class="bg-surface-sunken"
              :style="{ paddingRight: `${detailGutter}px` }"
            >
              <table class="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col class="w-[32%]" />
                  <col />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <thead
                  class="bg-surface-sunken text-2xs text-ink-muted uppercase"
                >
                  <tr class="text-left">
                    <th class="px-4 py-2 font-medium">设备</th>
                    <th class="px-4 py-2 text-right font-medium">在线率</th>
                    <th class="px-4 py-2 text-right font-medium">电量均值</th>
                    <th class="px-4 py-2 text-right font-medium">最低电量</th>
                    <th class="px-4 py-2 text-right font-medium">样本数</th>
                  </tr>
                </thead>
              </table>
            </div>
            <div
              ref="detailBody"
              class="max-h-80 overflow-x-hidden overflow-y-auto border-t border-border"
              tabindex="0"
              role="region"
              :aria-label="`按设备明细 数据表`"
            >
              <table class="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col class="w-[32%]" />
                  <col />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <tbody>
                  <tr
                    v-for="row in availabilityRows"
                    :key="row.deviceId"
                    class="border-b border-border/60 text-ink last:border-b-0"
                  >
                    <td class="truncate px-4 py-2" :title="row.name">
                      {{ row.name }}
                    </td>
                    <td class="px-4 py-2 text-right font-mono tabular-nums">
                      {{ fmtPct(row.onlineRatio) }}
                    </td>
                    <td class="px-4 py-2 text-right font-mono tabular-nums">
                      {{ fmtSoc(row.socMean) }}
                    </td>
                    <td class="px-4 py-2 text-right font-mono tabular-nums">
                      {{ fmtSoc(row.socMin) }}
                    </td>
                    <td class="px-4 py-2 text-right font-mono tabular-nums">
                      {{ row.totalSamples }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </details>
      </section>

      <!-- Section 消息分析: severity mix, worst offenders, and the daily trend — the three cuts
           an operator asks of a message history. -->
      <section class="flex flex-col gap-3" aria-labelledby="alerts-heading">
        <h2 id="alerts-heading" class="m-0 text-sm font-semibold text-ink">
          消息分析
        </h2>
        <p
          v-if="alertStatus === 'error'"
          class="m-0 rounded-md border border-border bg-surface-raised p-4 text-sm text-critical-ink"
          role="status"
        >
          消息统计加载失败：{{ alertError }}
        </p>
        <div v-else class="grid gap-4 lg:grid-cols-3">
          <div class="rounded-md border border-border bg-surface-raised p-4">
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
          </div>
          <div class="rounded-md border border-border bg-surface-raised p-4">
            <CategoryBarChart
              v-if="hasAlertData"
              :data="deviceData"
              label="按消息数分布"
              unit="条"
              orientation="horizontal"
              :height="200"
            />
            <p v-else class="m-0 py-8 text-center text-sm text-ink-muted">
              该时间段没有消息
            </p>
          </div>
          <div class="rounded-md border border-border bg-surface-raised p-4">
            <CategoryBarChart
              v-if="hasAlertData"
              :data="dailyData"
              label="按时间天频次"
              unit="条"
              :height="200"
            />
            <p v-else class="m-0 py-8 text-center text-sm text-ink-muted">
              该时间段没有消息
            </p>
          </div>
        </div>
      </section>
    </template>
  </PageHeader>
</template>
