<script setup lang="ts">
/**
 * 消息史 — this vehicle's messages as a day-by-day chronology.
 *
 * The fourth tab `docs/frontend-ia.md` asks for at L3, and the first consumer of
 * `/api/v1/alerts` anywhere in the console.
 *
 * ## Grouped by day, collapsed on arrival
 *
 * A month of a busy vehicle's messages is a long scroll, and what an operator wants first is
 * "which days were bad", not every row at once. So the list folds into one collapsible card per
 * calendar day, each closed on arrival with a summary — the date, how many, and the severity
 * tally — so the shape of the month reads before a single row is opened.
 *
 * ## The row, and what it does not carry
 *
 * Each row mirrors 消息·消息史's (same two-line shape and type sizes) minus the two facts that
 * make no sense here: the device (you are already on it) and the duration. Unlike that panel —
 * which queries cleared alerts only — this history includes messages that are still active, so a
 * row's second line ends either with when it cleared or with 仍活跃. The loud per-row
 * active/cleared chip is gone: the fact lives once, in that 结束 field, not also as a colour.
 *
 * ## The empty state is the interesting part
 *
 * `queryMemoryAlerts` keeps only active alerts, so with no MongoDB a cleared message is simply
 * absent — a vehicle with a long troubled history reads like one that never faulted. The empty
 * text says what is missing and links to 系统 / 状态, the page that can say whether Mongo is up.
 */
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { fleetApi, formatDateTime } from "@navfleet/fleet-core";
import type { AlertRecord } from "@navfleet/fleet-core";
import { SEVERITY_BADGE, SEVERITY_LABELS } from "@/lib/severity";
import UiDisclosureArrow from "@/components/ui/UiDisclosureArrow.vue";
import { useLatestRequest } from "@/composables/useLatestRequest";
import { loadErrorMessage } from "@/lib/errorMessages";

const { deviceId } = defineProps<{ deviceId: string }>();

type Severity = "critical" | "warning" | "notice";

/** The window this history covers, and the row cap asked of the server within it. */
const HISTORY_DAYS = 30;
const HISTORY_LIMIT = 1000;

const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");
const records = ref<AlertRecord[]>([]);
/** The server's row cap when the list was cut at it (older matches exist), else null. */
const cappedAt = ref<number | null>(null);
/** Day keys currently expanded; empty on arrival, so every day starts collapsed. */
const openDays = ref<Set<string>>(new Set());

const latestRequest = useLatestRequest();

/**
 * When the occurrence began. Each occurrence is one record whose `ts` moves with every report, so
 * `ts` read as 发生 made a three-hour warning look seconds long. `-Infinity` for an undated
 * record, so it sorts last instead of claiming to be now.
 */
const stampOf = (record: AlertRecord): number => {
  const parsed = Date.parse(String(record.firstSeenAt ?? record.ts ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const load = async (id: string): Promise<void> => {
  if (!id) return;
  const isCurrent = latestRequest.begin();
  status.value = "loading";
  errorMessage.value = "";
  openDays.value = new Set();

  try {
    // The last 30 days, up to 1000 rows within it (the server clamps to its own ceiling). The
    // onset window is what reaches a period older than the server's default page.
    const from = new Date(
      Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const payload = await fleetApi.getAlerts({
      deviceId: id,
      from,
      limit: HISTORY_LIMIT,
    });
    // A slow response for a device you have navigated away from must not land.
    if (!isCurrent()) return;

    cappedAt.value = payload.truncated
      ? (payload.limit ?? (payload.items ?? []).length)
      : null;
    // Newest first: a chronology is read backwards from now. Sorted here rather than trusted from
    // the endpoint, whose Mongo and in-memory paths order independently.
    records.value = [...(payload.items ?? [])].sort(
      (left, right) => stampOf(right) - stampOf(left),
    );
    status.value = "ready";
  } catch (error) {
    if (!isCurrent()) return;
    records.value = [];
    cappedAt.value = null;
    status.value = "error";
    errorMessage.value = loadErrorMessage(
      error,
      "消息历史加载失败，请稍后重试",
    );
  }
};

watch(
  () => deviceId,
  (id) => void load(id),
  { immediate: true },
);

interface Row {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  code: string;
  started: number;
  startedLabel: string;
  /** When it cleared, or 仍活跃 — this history, unlike 消息·消息史, holds active rows. */
  endedLabel: string;
}

const rows = computed<Row[]>(() =>
  records.value.map((record, index) => {
    const started = stampOf(record);
    const cleared = record.clearedAt
      ? Date.parse(String(record.clearedAt))
      : NaN;
    // `active` is what the backend says; a record with no `clearedAt` is also still running.
    const active = record.active !== false && !Number.isFinite(cleared);
    return {
      // One row per occurrence: an eventKey recurs once per time the code fired, so the onset
      // makes the key unique (the index is the last resort for a record with neither).
      key: `${String(record.eventKey ?? record.id ?? record.source ?? "alert")}@${
        Number.isFinite(started) ? started : `#${index}`
      }`,
      severity: (record.severity ?? "notice") as Severity,
      title: String(record.title || record.info || "未命名消息"),
      detail: String(record.detail || record.info || ""),
      code:
        Number.isFinite(record.code) && record.code ? String(record.code) : "",
      started,
      startedLabel: Number.isFinite(started) ? formatDateTime(started) : "--",
      endedLabel: active
        ? "仍活跃"
        : Number.isFinite(cleared)
          ? formatDateTime(cleared)
          : "已清除",
    };
  }),
);

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad2 = (value: number): string => String(value).padStart(2, "0");

/** A stable per-calendar-day key (local time); `"unknown"` for an undated row. */
const dayKeyOf = (started: number): string => {
  if (!Number.isFinite(started)) return "unknown";
  const date = new Date(started);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

interface DayGroup {
  dayKey: string;
  label: string;
  count: number;
  severity: Record<Severity, number>;
  rows: Row[];
}

/**
 * One group per calendar day, newest day first. `rows` is already newest-first with undated rows
 * last, so a day's first appearance fixes the order and the undated bucket falls to the end.
 */
const groups = computed<DayGroup[]>(() => {
  const byDay = new Map<string, DayGroup>();
  const order: string[] = [];
  for (const row of rows.value) {
    const dayKey = dayKeyOf(row.started);
    let group = byDay.get(dayKey);
    if (!group) {
      const date = new Date(row.started);
      group = {
        dayKey,
        label:
          dayKey === "unknown"
            ? "未知时间"
            : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${WEEKDAYS[date.getDay()]}`,
        count: 0,
        severity: { critical: 0, warning: 0, notice: 0 },
        rows: [],
      };
      byDay.set(dayKey, group);
      order.push(dayKey);
    }
    group.rows.push(row);
    group.count += 1;
    group.severity[row.severity] += 1;
  }
  return order.map((dayKey) => byDay.get(dayKey)!);
});

/** A day's severity tally for its summary — only the non-zero bands, worst first. */
const severityTally = (
  group: DayGroup,
): Array<{ severity: Severity; count: number }> =>
  (["critical", "warning", "notice"] as const)
    .map((severity) => ({ severity, count: group.severity[severity] }))
    .filter((entry) => entry.count > 0);

const isOpen = (dayKey: string): boolean => openDays.value.has(dayKey);
const toggleDay = (dayKey: string): void => {
  const next = new Set(openDays.value);
  if (next.has(dayKey)) next.delete(dayKey);
  else next.add(dayKey);
  openDays.value = next;
};
</script>
<template>
  <section
    class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
    aria-labelledby="alert-history-heading"
  >
    <header class="flex flex-wrap items-baseline gap-2">
      <h3 id="alert-history-heading" class="text-md font-semibold text-ink">
        消息史
      </h3>
      <span
        v-if="status === 'ready' && rows.length"
        class="font-mono text-2xs text-ink-muted"
        >最近 {{ HISTORY_DAYS }} 天 · {{ rows.length }} 条</span
      >
      <span
        v-if="status === 'ready' && cappedAt !== null"
        class="text-2xs text-ink-subtle"
        >只显示最近 {{ cappedAt }} 条，更早的记录可在「消息 /
        消息史」按时间范围查看</span
      >
    </header>

    <p v-if="status === 'loading'" class="m-0 text-sm text-ink-muted">
      正在加载消息历史…
    </p>

    <p
      v-else-if="status === 'error'"
      class="m-0 text-sm text-critical-ink"
      role="alert"
    >
      {{ errorMessage }}
    </p>

    <!--
      Not a shrug. Without MongoDB the endpoint can only answer with active alerts, so a vehicle
      with a long troubled history looks exactly like one that has never faulted — and the page
      that can tell you which is which is linked from here.
    -->
    <p v-else-if="!rows.length" class="m-0 max-w-prose text-sm text-ink-muted">
      这台设备没有可显示的消息；已清除的消息需要后端连接 MongoDB 才会留存 ——
      <RouterLink
        to="/system"
        class="text-brand-ink underline-offset-2 hover:underline"
        >系统 / 状态</RouterLink
      >
      会说明它此刻连上了没有
    </p>

    <ul v-else class="m-0 flex list-none flex-col gap-2 p-0">
      <li
        v-for="group in groups"
        :key="group.dayKey"
        class="overflow-hidden rounded-sm border border-border bg-surface"
      >
        <!-- Day summary: the fold handle plus the at-a-glance — date, count, severity tally —
             so the month's shape reads with every day closed. -->
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised"
          :aria-expanded="isOpen(group.dayKey)"
          @click="toggleDay(group.dayKey)"
        >
          <UiDisclosureArrow
            :open="isOpen(group.dayKey)"
            class="text-ink-subtle"
          />
          <span class="font-mono text-sm text-ink">{{ group.label }}</span>
          <span class="font-mono text-2xs text-ink-muted"
            >{{ group.count }} 条</span
          >
          <span class="ml-auto flex flex-wrap items-center gap-1">
            <span
              v-for="entry in severityTally(group)"
              :key="entry.severity"
              class="rounded-xs px-1.5 py-0.5 font-mono text-2xs"
              :class="SEVERITY_BADGE[entry.severity]"
              >{{ SEVERITY_LABELS[entry.severity] }} {{ entry.count }}</span
            >
          </span>
        </button>

        <!-- Rows only while open: a busy month runs to many hundreds, and the closed card is the
             point. The open day is a recessed tray, each record a raised card on it — the same
             shape as a user's expanded sessions. Two lines, mirroring 消息·消息史 minus 设备/时长. -->
        <ul
          v-if="isOpen(group.dayKey)"
          class="m-0 flex list-none flex-col gap-2 border-t border-border bg-surface-sunken p-3"
        >
          <li
            v-for="row in group.rows"
            :key="row.key"
            class="flex flex-col gap-1 rounded-sm border border-border bg-surface-raised p-3"
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
              <span v-if="row.detail" class="text-xs text-ink-muted">{{
                row.detail
              }}</span>
            </div>

            <dl class="m-0 flex flex-wrap gap-x-4 gap-y-0.5">
              <div class="flex items-baseline gap-1.5">
                <dt class="text-2xs text-ink-subtle">发生</dt>
                <dd class="m-0 font-mono text-xs text-ink">
                  {{ row.startedLabel }}
                </dd>
              </div>
              <div class="flex items-baseline gap-1.5">
                <dt class="text-2xs text-ink-subtle">结束</dt>
                <dd class="m-0 font-mono text-xs text-ink">
                  {{ row.endedLabel }}
                </dd>
              </div>
            </dl>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
