<script setup lang="ts">
/**
 * 告警史 — this vehicle's alerts as a chronology.
 *
 * The fourth tab `docs/frontend-ia.md` asks for at L3, and the **first consumer of
 * `/api/v1/alerts`** anywhere in the console: 13D-1 shipped the alert centre on the
 * store's live alerts and left that endpoint at zero calls.
 *
 * ## Why this is not the alert centre's row
 *
 * It looked like a candidate for a shared component and it is not, because the two
 * have different data. The alert centre renders **live** alerts — active by
 * definition — so it never shows `ts`, `clearedAt` or `active`. Those three are
 * exactly what a history is: when it started, when it ended, whether it is still
 * running. Two more things there make no sense here: the row's link back to the device
 * page (you are on that device), and the acknowledge toggle (acknowledging a cleared
 * alert acknowledges nothing). A shared component would need every one of those
 * parameterised off, which is a component each caller half-disables.
 *
 * ## The empty state is the interesting part
 *
 * `queryMemoryAlerts` keeps only *active* alerts, so with no MongoDB attached a
 * `cleared` query returns nothing at all — a vehicle with a long troubled history
 * reads identically to one that has never faulted. That is not a state to render as a
 * shrug: the empty text says what is missing and links to 管理 / 系统状态, which is
 * the page that can actually say whether Mongo is connected right now.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { fleetApi, formatDateTime } from "@navfleet/fleet-core";
import type { AlertRecord } from "@navfleet/fleet-core";

const { deviceId } = defineProps<{ deviceId: string }>();

type Severity = "critical" | "warning" | "notice";

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

const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");
const records = ref<AlertRecord[]>([]);

let requestId = 0;

const load = async (id: string): Promise<void> => {
  if (!id) return;
  const request = (requestId += 1);
  status.value = "loading";
  errorMessage.value = "";

  try {
    const payload = await fleetApi.getAlerts({ deviceId: id });
    // A slow response for a device you have navigated away from must not land.
    if (request !== requestId) return;

    // Newest first: a chronology is read backwards from now. Sorted here rather than
    // trusted from the endpoint, whose two code paths (Mongo and the in-memory
    // fallback) order independently.
    records.value = [...(payload.items ?? [])].sort(
      (left, right) => stampOf(right) - stampOf(left),
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

/** `-Infinity` for an undated record, so it sorts last instead of claiming to be now. */
const stampOf = (record: AlertRecord): number => {
  const parsed = Date.parse(String(record.ts ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

watch(
  () => deviceId,
  (id) => void load(id),
  { immediate: true },
);

onBeforeUnmount(() => {
  requestId += 1;
});

interface Row {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  code: string;
  started: string;
  /** Either when it cleared, or the fact that it has not. */
  ended: string;
  active: boolean;
}

const rows = computed<Row[]>(() =>
  records.value.map((record, index) => {
    const started = stampOf(record);
    const cleared = record.clearedAt
      ? Date.parse(String(record.clearedAt))
      : NaN;
    // `active` is what the backend says; a record with no `clearedAt` is also still
    // running. Either is enough — the two disagree only on malformed records.
    const active = record.active !== false && !Number.isFinite(cleared);
    return {
      key: String(record.id ?? `${record.source ?? "alert"}-${index}`),
      severity: (record.severity ?? "notice") as Severity,
      title: String(record.title || record.info || "未命名告警"),
      detail: String(record.detail || record.info || ""),
      code:
        Number.isFinite(record.code) && record.code ? String(record.code) : "",
      // `--` rather than a formatted `undefined`: `formatDateTime` falls back to
      // `Date.now()`, which would date an undated record to this second.
      started: Number.isFinite(started) ? formatDateTime(started) : "--",
      ended: active
        ? "仍活跃"
        : Number.isFinite(cleared)
          ? formatDateTime(cleared)
          : "已清除",
      active,
    };
  }),
);

const activeCount = computed(
  () => rows.value.filter((row) => row.active).length,
);
</script>

<template>
  <section
    class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
    aria-labelledby="alert-history-heading"
  >
    <header class="flex flex-wrap items-baseline gap-2">
      <h3 id="alert-history-heading" class="text-lg font-semibold text-ink">
        告警史
      </h3>
      <span
        v-if="status === 'ready' && rows.length"
        class="font-mono text-2xs text-ink-muted"
        >{{ rows.length }} 条 · {{ activeCount }} 条仍活跃</span
      >
    </header>

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

    <!--
      Not a shrug. Without MongoDB the endpoint can only answer with active alerts, so
      a vehicle with a long troubled history looks exactly like one that has never
      faulted — and the page that can tell you which is which is linked from here.
    -->
    <p v-else-if="!rows.length" class="m-0 max-w-prose text-sm text-ink-muted">
      这台设备没有可显示的告警。已清除的告警需要后端连接 MongoDB 才会留存 ——
      <RouterLink
        to="/admin/system"
        class="text-brand-ink underline-offset-2 hover:underline"
        >管理 / 系统状态</RouterLink
      >
      会说明它此刻连上了没有。
    </p>

    <ul v-else class="m-0 flex list-none flex-col gap-2 p-0">
      <li
        v-for="row in rows"
        :key="row.key"
        class="flex flex-col gap-1 rounded-sm border border-border bg-surface p-3"
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
          <!-- In words, because "still running" is the thing that decides whether
               anyone needs to act on this row. -->
          <span
            class="ml-auto font-mono text-2xs"
            :class="row.active ? 'text-critical-ink' : 'text-ink-muted'"
            >{{ row.active ? "仍活跃" : "已清除" }}</span
          >
        </div>

        <p v-if="row.detail" class="m-0 text-xs text-ink-muted">
          {{ row.detail }}
        </p>

        <dl class="m-0 flex flex-wrap gap-x-4 gap-y-0.5">
          <div class="flex items-baseline gap-1.5">
            <dt class="text-2xs text-ink-subtle">发生</dt>
            <dd class="m-0 font-mono text-xs text-ink">{{ row.started }}</dd>
          </div>
          <div class="flex items-baseline gap-1.5">
            <dt class="text-2xs text-ink-subtle">结束</dt>
            <dd class="m-0 font-mono text-xs text-ink">{{ row.ended }}</dd>
          </div>
        </dl>
      </li>
    </ul>
  </section>
</template>
