<script setup lang="ts">
/**
 * 告警 — equivalence first, depth in Phase 16.
 *
 * What this page owes v1.0.0: severity buckets, a device filter, a search box,
 * acknowledgement, and pagination. What it adds is mostly the 11B audit's list of
 * things that were missing rather than wrong:
 *
 * - **Filter state lives in the URL.** A supervisor who has narrowed the list to one
 *   vehicle's critical alerts can send that link to whoever is on shift. In v1.0.0
 *   the same view could only be described in words.
 * - **The acknowledge control is a toggle that says so** (`aria-pressed`), not a
 *   button whose meaning is carried by its colour.
 * - **The empty state is a live region**, so filtering down to nothing is announced
 *   rather than silently leaving a blank panel.
 * - **A row reaches the vehicle.** Diagnosing an alert used to mean reading the
 *   device id and going to find it.
 *
 * The honest limitation is stated on the page, not buried here: acknowledgements are
 * per-browser. They do not reach the database, carry no who and no when, and the next
 * person on shift sees none of them. Saying so is the difference between a known
 * limitation and a silent one.
 */
import { computed, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import { useFleetStore } from "@/stores/fleet";
import { useAlertAck } from "@/composables/useAlertAck";
import { useNotifications } from "@/composables/useNotifications";
import { formatDateTime } from "@navfleet/fleet-core";
import type { Severity } from "@navfleet/shared";

const PAGE_SIZE = 20;

const SEVERITIES: readonly { value: Severity | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "critical", label: "告警" },
  { value: "warning", label: "预警" },
  { value: "notice", label: "提示" },
];

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

/** Worst first — the order they should be worked, not the order they arrived. */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  notice: 2,
};

const route = useRoute();
const router = useRouter();
const fleet = useFleetStore();
const ack = useAlertAck();
const { notify } = useNotifications();

/**
 * Filters read from the URL and written back to it.
 *
 * The query string is the single source of truth rather than a mirror of local refs:
 * a link someone pastes has to produce the same view, and keeping a second copy in
 * `ref`s is how the two drift.
 */
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
const showAcknowledged = computed(() => readParam("acked") === "1");
const page = computed(() => {
  const value = Number(readParam("page"));
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
});

/** Writes only what differs from the default, so a clean view has a clean URL. */
const setQuery = (patch: Record<string, string | null>): void => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...route.query, ...patch })) {
    if (typeof value === "string" && value !== "") next[key] = value;
  }
  void router.replace({ query: next });
};

const setFilter = (patch: Record<string, string | null>): void => {
  // Any filter change goes back to the first page: staying on page 4 of a list that
  // now has one page shows nothing and looks broken.
  setQuery({ ...patch, page: null });
};

/** Every alert in the fleet, worst severity first and newest first within it. */
const allAlerts = computed(() =>
  (["critical", "warning", "notice"] as const)
    .flatMap((bucket) => fleet.groupedAlerts[bucket])
    .sort(
      (left, right) =>
        SEVERITY_WEIGHT[left.severity] - SEVERITY_WEIGHT[right.severity] ||
        new Date(right.ts).getTime() - new Date(left.ts).getTime(),
    ),
);

const deviceOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const alert of allAlerts.value) {
    if (!seen.has(alert.deviceId)) {
      seen.set(alert.deviceId, alert.deviceName || alert.deviceId);
    }
  }
  return [...seen].map(([value, label]) => ({ value, label }));
});

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return allAlerts.value.filter((alert) => {
    if (severity.value !== "all" && alert.severity !== severity.value)
      return false;
    if (deviceFilter.value && alert.deviceId !== deviceFilter.value)
      return false;
    if (!showAcknowledged.value && ack.isAcknowledged(alert.id)) return false;
    if (!keyword) return true;
    return [
      alert.title,
      alert.detail,
      alert.deviceName,
      alert.deviceId,
      alert.info,
    ]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(keyword));
  });
});

const pageCount = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)),
);
const pageRows = computed(() => {
  const start = (Math.min(page.value, pageCount.value) - 1) * PAGE_SIZE;
  return filtered.value.slice(start, start + PAGE_SIZE);
});

// A list that shrinks under a filter can leave the page number past the end.
watch(pageCount, (count) => {
  if (page.value > count) setQuery({ page: count > 1 ? String(count) : null });
});

const unacknowledgedOnPage = computed(() =>
  pageRows.value
    .filter((alert) => !ack.isAcknowledged(alert.id))
    .map((a) => a.id),
);

/**
 * Acknowledging in bulk offers an undo, because it is the one action here that is both
 * easy to trigger by accident and tedious to reverse by hand.
 */
const acknowledgePage = (): void => {
  const changed = ack.acknowledgeMany(unacknowledgedOnPage.value);
  if (!changed.length) return;
  notify(`已确认 ${changed.length} 条告警`, {
    type: "success",
    action: { label: "撤销", handler: () => ack.unacknowledgeMany(changed) },
  });
};
</script>

<template>
  <PageHeader
    title="告警"
    lede="按严重度分流，筛选状态进 URL，可以把一个视图发给同事。"
  >
    <template #actions>
      <button
        v-if="unacknowledgedOnPage.length"
        type="button"
        class="rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink"
        @click="acknowledgePage"
      >
        确认本页 {{ unacknowledgedOnPage.length }} 条
      </button>
    </template>

    <!-- The limitation, on the page rather than in a comment: a known limitation and a
         silent one look identical to whoever is on shift. -->
    <p class="text-xs text-ink-muted">
      确认状态只保存在当前浏览器 ——
      不入库、不记录操作人与时间，换台机器或换个人都看不到。 落库与历史留到
      Phase 16。
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
        <select
          class="rounded-sm border border-border-strong bg-surface-raised px-2 py-1 text-xs text-ink"
          :value="deviceFilter"
          @change="
            setFilter({
              device: ($event.target as HTMLSelectElement).value || null,
            })
          "
        >
          <option value="">全部设备</option>
          <option
            v-for="option in deviceOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="flex flex-col gap-1">
        <span class="font-mono text-2xs text-ink-subtle">搜索</span>
        <input
          type="search"
          class="rounded-sm border border-border-strong bg-surface-raised px-2 py-1 text-xs text-ink"
          placeholder="标题、详情、设备"
          :value="search"
          @input="
            setFilter({ q: ($event.target as HTMLInputElement).value || null })
          "
        />
      </label>

      <label class="flex items-center gap-2 text-xs text-ink-muted">
        <input
          type="checkbox"
          :checked="showAcknowledged"
          @change="
            setFilter({
              acked: ($event.target as HTMLInputElement).checked ? '1' : null,
            })
          "
        />
        显示已确认
      </label>
    </div>

    <!-- A live region: filtering down to nothing has to be announced, not leave a
         blank panel behind. -->
    <p
      v-if="!pageRows.length"
      class="rounded-md border border-border bg-surface-raised p-8 text-center text-sm text-ink-muted"
      role="status"
    >
      {{
        allAlerts.length
          ? "没有符合当前筛选条件的告警。"
          : "当前车队没有活跃告警。"
      }}
    </p>

    <ul v-else class="m-0 flex list-none flex-col gap-2 p-0">
      <li
        v-for="alert in pageRows"
        :key="alert.id"
        class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3 sm:flex-row sm:items-start"
      >
        <span
          class="shrink-0 rounded-xs px-2 py-0.5 font-mono text-2xs"
          :class="SEVERITY_BADGE[alert.severity]"
          >{{ SEVERITY_LABELS[alert.severity] }}</span
        >

        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong class="text-sm text-ink">{{ alert.title }}</strong>
          <span v-if="alert.detail" class="text-xs text-ink-muted">{{
            alert.detail
          }}</span>
          <span
            class="flex flex-wrap items-center gap-2 text-2xs text-ink-subtle"
          >
            <!-- The row reaches the vehicle: diagnosing an alert used to mean reading
                 the device id and going to find it. -->
            <RouterLink
              :to="`/devices/${alert.deviceId}`"
              class="text-brand-ink underline-offset-2 hover:underline"
              >{{ alert.deviceName || alert.deviceId }}</RouterLink
            >
            <span class="font-mono">{{ formatDateTime(alert.ts) }}</span>
            <span v-if="alert.code" class="font-mono">#{{ alert.code }}</span>
          </span>
        </div>

        <!-- A toggle that says it is one, rather than a button whose meaning is
             carried by its colour. -->
        <button
          type="button"
          class="shrink-0 rounded-sm border px-2.5 py-1 text-xs transition-colors duration-150 ease-standard"
          :class="
            ack.isAcknowledged(alert.id)
              ? 'border-brand bg-brand-wash text-brand-ink'
              : 'border-border-strong bg-surface text-ink-muted hover:text-ink'
          "
          :aria-pressed="ack.isAcknowledged(alert.id)"
          :aria-label="`确认告警：${alert.title}`"
          @click="
            ack.isAcknowledged(alert.id)
              ? ack.unacknowledge(alert.id)
              : ack.acknowledge(alert.id)
          "
        >
          {{ ack.isAcknowledged(alert.id) ? "已确认" : "确认" }}
        </button>
      </li>
    </ul>

    <nav
      v-if="pageCount > 1"
      class="flex items-center justify-between gap-3"
      aria-label="分页"
    >
      <button
        type="button"
        class="rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted disabled:opacity-50"
        :disabled="page <= 1"
        @click="setQuery({ page: page > 2 ? String(page - 1) : null })"
      >
        上一页
      </button>
      <span class="font-mono text-2xs text-ink-muted"
        >第 {{ Math.min(page, pageCount) }} / {{ pageCount }} 页 · 共
        {{ filtered.length }} 条</span
      >
      <button
        type="button"
        class="rounded-sm border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted disabled:opacity-50"
        :disabled="page >= pageCount"
        @click="setQuery({ page: String(Math.min(page + 1, pageCount)) })"
      >
        下一页
      </button>
    </nav>
  </PageHeader>
</template>
