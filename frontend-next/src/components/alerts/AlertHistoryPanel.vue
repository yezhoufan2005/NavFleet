<script setup lang="ts">
/**
 * 消息史面板 — cleared alerts with at-a-glance statistics, shown as the 消息 页 history tab.
 *
 * Phase 18 folded 消息史 from a top-level page into a tab of `AlertsView`. The shared filter
 * bar (severity / device / search) lives in `AlertsView` and writes the URL; this panel reads
 * the same query params, fetches cleared alerts once on mount, and derives severity
 * distribution, per-device counts, per-day frequency, acknowledgement rate and clear-time
 * durations client-side (`lib/alertStats.ts`) — the split and the 500-row cap unchanged from
 * the former `AlertHistoryView`.
 *
 * Read-only. Without MongoDB a `cleared` query returns nothing, so the empty state links to
 * 管理 / 系统状态, the page that can say whether Mongo is connected.
 */
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import CategoryBarChart from "@/components/charts/CategoryBarChart.vue";
import UiListPagination from "@/components/ui/UiListPagination.vue";
import { useChartTheme } from "@/composables/useChartTheme";
import { useListPagination } from "@/composables/useListPagination";
import { useFleetStore } from "@/stores/fleet";
import { fleetApi, formatDateTime } from "@navfleet/fleet-core";
import type { AlertRecord } from "@navfleet/fleet-core";
import {
  computeAlertStats,
  formatDurationMs,
  severityOf,
  type Severity,
} from "@/lib/alertStats";
import { SEVERITY_LABELS } from "@/lib/severity";
import { compileSearch } from "@/lib/searchQuery";

/** The endpoint's page size (`MAX_ALERTS_PER_QUERY`); a full page means older rows are cut. */
const RESULT_CAP = 500;

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
    const payload = await fleetApi.getAlerts({
      status: "cleared",
      ...queryWindow.value,
    });
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
      error instanceof Error ? error.message : "消息历史加载失败";
  }
};

onMounted(() => void load());

// ── Filters, read from the URL that AlertsView's shared bar writes ────────────────────────
const readParam = (key: string): string => {
  const value = route.query[key];
  return typeof value === "string" ? value : "";
};
// 严重度 is comma-joined in `severity` (multi-select since the filter-polish sweep); empty = 全部.
const severity = computed<Severity[]>(() => {
  const raw = readParam("severity");
  const valid = ["critical", "warning", "notice"];
  return raw
    ? (raw.split(",").filter((value) => valid.includes(value)) as Severity[])
    : [];
});
// 设备 is comma-joined in the one `device` key (multi-select since the filter-polish sweep);
// an empty list means 全部设备, matching AlertsView's shared bar.
const deviceFilter = computed(() => {
  const raw = readParam("device");
  return raw ? raw.split(",").filter(Boolean) : [];
});
const search = computed(() => readParam("q"));

/**
 * Onset window (`from`/`to`, `YYYY-MM-DD`) — the one filter applied **server-side**, unlike
 * severity/device/search which narrow the fetched page in the browser. Without it the query
 * returns the most-recent `RESULT_CAP` cleared alerts, so a window is the only way to reach a
 * past period whose rows are older than that page. Bounds are independent (either or both) and
 * expanded to day edges; the bar's native min/max keeps 起 ≤ 止. Changing it re-queries (below).
 */
const fromParam = computed(() => readParam("from"));
const toParam = computed(() => readParam("to"));
const queryWindow = computed<{ from?: string; to?: string }>(() => {
  const result: { from?: string; to?: string } = {};
  if (fromParam.value)
    result.from = new Date(`${fromParam.value}T00:00:00`).toISOString();
  if (toParam.value)
    result.to = new Date(`${toParam.value}T23:59:59.999`).toISOString();
  return result;
});
watch([fromParam, toParam], () => void load());

/** Prefer the fleet's current name for a device, then the record's, then the raw id. */
const deviceNameOf = (id: string, fallback?: string): string => {
  const known = fleet.devices.find((device) => device.deviceId === id);
  return known?.deviceName || fallback || id;
};

const searchMatches = computed(() => compileSearch(search.value));
const filtered = computed(() =>
  records.value.filter((record) => {
    if (severity.value.length && !severity.value.includes(severityOf(record)))
      return false;
    if (
      deviceFilter.value.length &&
      !deviceFilter.value.includes(String(record.deviceId ?? ""))
    )
      return false;
    // Same boolean search language as the live tab (shared box) — see `compileSearch`.
    return searchMatches.value(
      [
        record.title,
        record.detail,
        record.deviceName,
        record.deviceId,
        record.info,
        record.code,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }),
);

const capped = computed(() => records.value.length >= RESULT_CAP);

// ── Derived statistics + chart inputs ─────────────────────────────────────────────────────
// `topN: Infinity` — the per-device chart shows *every* device with cleared messages, not a Top-8.
// The chart card has a fixed height and scrolls (see the grid comment), so "all of them" costs a
// scrollbar, never an ever-taller card.
const stats = computed(() =>
  computeAlertStats(filtered.value, { topN: Number.POSITIVE_INFINITY }),
);

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

/**
 * The record list paginates like every other list (shared `useListPagination` + `UiListPagination`,
 * default 10/页). Its own URL keys (`hpage` / `hsize`) so it does not collide with the live tab's
 * `page` / `pageSize` — both views live under the same `/alerts*` route tree.
 */
const { page, pageCount, pageSize, pageItems, setPage, setPageSize } =
  useListPagination(rows, { pageParam: "hpage", pageSizeParam: "hsize" });
</script>

<template>
  <p v-if="status === 'loading'" class="m-0 text-sm text-ink-muted">
    正在加载消息历史…
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
    <RouterLink to="/system" class="text-brand-ink underline underline-offset-2"
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
    <!-- Three charts, one row, equal 240px height (the original). 「按消息数分布」lists every
         device (no Top-N cap) and scrolls inside its fixed-height card, so the full fleet is
         reachable without the card growing; the day-frequency chart likewise keeps `scroll`. The
         fixed height is the whole point — a scrollbar, never an ever-taller card. -->
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

    <!-- Cleared-message list, newest clear first, paged like the other lists. Each row is two
         lines: the code+title (with the detail inline to its right) over the device/时间/时长 facts. -->
    <ul class="m-0 flex list-none flex-col gap-2 p-0">
      <li
        v-for="row in pageItems"
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
          <!-- The detail sits inline after the title (was its own line), so a row is two lines. -->
          <span v-if="row.detail" class="text-xs text-ink-muted">{{
            row.detail
          }}</span>
          <span
            v-if="row.ackedBy"
            class="ml-auto font-mono text-2xs text-brand-ink"
            >已确认 · {{ row.ackedBy }}</span
          >
        </div>

        <dl class="m-0 flex flex-wrap gap-x-4 gap-y-0.5">
          <div class="flex items-baseline gap-1.5">
            <dt class="text-2xs text-ink-subtle">设备</dt>
            <dd class="m-0">
              <RouterLink
                v-if="row.deviceId"
                :to="`/devices/${row.deviceId}/alerts`"
                class="text-xs text-brand-ink underline-offset-2 hover:underline"
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

    <UiListPagination
      :page="page"
      :page-count="pageCount"
      :page-size="pageSize"
      :total="rows.length"
      unit="条"
      @update:page="setPage"
      @update:page-size="setPageSize"
    />
  </template>
</template>
