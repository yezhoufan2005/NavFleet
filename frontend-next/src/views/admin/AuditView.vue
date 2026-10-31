<script setup lang="ts">
/**
 * 审计 — the audit log (admin), the read side of `audit_log`.
 *
 * Filters are server-side (the backend caps and orders the result); pagination over the
 * returned page is client-side, matching 告警's shape. Filter state lives in the URL so a
 * shift can hand a view to the next one, the same reasoning `AlertsView` documents.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fleetApi, type AuditRecord } from "@navfleet/fleet-core";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiListPagination from "@/components/ui/UiListPagination.vue";
import UiMultiSelect from "@/components/ui/UiMultiSelect.vue";
import UiFilterBar from "@/components/ui/UiFilterBar.vue";
import UiFilterField from "@/components/ui/UiFilterField.vue";
import UiEmptyState from "@/components/ui/UiEmptyState.vue";
import { tableClasses } from "@/lib/uiClasses";
import { useLatestRequest } from "@/composables/useLatestRequest";
import { useAutoRefresh } from "@/composables/useAutoRefresh";
import { useListPagination } from "@/composables/useListPagination";
import { ACTION_LABELS, actionLabel, auditObject } from "@/lib/auditLog";

const route = useRoute();
const router = useRouter();

/** The 动作 filter is multi-select, so there is no 全部动作 sentinel — an empty set means "all". */
const ACTION_OPTIONS = Object.entries(ACTION_LABELS).map(([value, label]) => ({
  value,
  label,
}));

const readParam = (key: string): string => {
  const value = route.query[key];
  return typeof value === "string" ? value : "";
};
/** A comma-joined query key (动作 is multi) read back as a list; empty when absent. */
const readParamList = (key: string): string[] => {
  const raw = readParam(key);
  return raw ? raw.split(",").filter(Boolean) : [];
};

const actor = ref(readParam("actor"));
const action = ref<string[]>(readParamList("action"));
const from = ref(readParam("from"));
const to = ref(readParam("to"));

const entries = ref<AuditRecord[]>([]);
/** The server's row cap when it cut the list (older matches exist), else null. */
const cappedAt = ref<number | null>(null);
const status = ref<"loading" | "ready" | "error">("loading");

// URL-synced pagination over the returned page, shared with 设备 / 消息 / 外发 (see useListPagination).
const { page, pageSize, pageCount, pageItems, setPage, setPageSize } =
  useListPagination(computed(() => entries.value));
const pageRows = pageItems;

/**
 * Discard a stale response: a slow query must not overwrite the table after a newer filter change
 * (or after this view unmounts). The increment-before / re-check-after-await / bump-on-unmount guard
 * is the house pattern the 设备 tabs and 告警 history already use.
 */
const latestRequest = useLatestRequest();

const load = async (): Promise<void> => {
  // Only flash the skeleton before the first successful load; filter changes and the focus
  // refresh re-query live, so blanking the table to 加载中… on every keystroke would be noise.
  if (status.value !== "ready") status.value = "loading";
  const isCurrent = latestRequest.begin();
  try {
    const result = await fleetApi.getAuditLog({
      actor: actor.value || undefined,
      action: action.value.length ? action.value.join(",") : undefined,
      // The date inputs give local calendar days; sent bare, the backend read them as UTC midnight,
      // so in UTC+8 the 止 day was cut off at 08:00. Same local bounds as 消息史 and 报表.
      from: from.value
        ? new Date(`${from.value}T00:00:00`).toISOString()
        : undefined,
      to: to.value
        ? new Date(`${to.value}T23:59:59.999`).toISOString()
        : undefined,
    });
    if (!isCurrent()) return;
    entries.value = result.entries;
    cappedAt.value = result.truncated
      ? (result.limit ?? result.entries.length)
      : null;
    status.value = "ready";
  } catch {
    if (!isCurrent()) return;
    status.value = "error";
  }
};

/** Mirror the filters into the URL (so a pasted link reproduces the view) and re-query. */
const applyFilters = (): void => {
  void router.replace({
    query: {
      ...(actor.value ? { actor: actor.value } : {}),
      ...(action.value.length ? { action: action.value.join(",") } : {}),
      ...(from.value ? { from: from.value } : {}),
      ...(to.value ? { to: to.value } : {}),
      // A filter change resets to page 1 (page param dropped) but keeps the chosen density.
      ...(route.query.pageSize ? { pageSize: route.query.pageSize } : {}),
    },
  });
  void load();
};

// Filters apply as you change them — no 查询 / 重置 buttons, matching the other tables. The free-text
// 操作者 box is debounced so a query does not fire on every keystroke; the selects and dates apply at
// once. Clearing a field (the search box's native ✕, or 全部动作) is what "reset" is now.
let actorTimer: ReturnType<typeof setTimeout> | undefined;
watch(actor, () => {
  clearTimeout(actorTimer);
  actorTimer = setTimeout(applyFilters, 300);
});
watch([action, from, to], () => applyFilters());

onMounted(() => void load());
// Re-fetch when the operator returns to the tab, rather than via a manual 刷新 button.
useAutoRefresh(() => void load());

// Drop a pending debounced apply (and ignore any in-flight load) once this view goes away, so the
// timer cannot fire `router.replace` against whatever route replaced it.
onBeforeUnmount(() => {
  clearTimeout(actorTimer);
});

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString("zh-CN", { hour12: false });
</script>

<template>
  <PageHeader title="系统">
    <AppSectionTabs />

    <UiFilterBar>
      <UiFilterField label="操作者">
        <UiInput v-model="actor" type="search" placeholder="用户名" />
      </UiFilterField>
      <UiFilterField label="动作">
        <UiMultiSelect
          v-model="action"
          :options="ACTION_OPTIONS"
          placeholder="全部动作"
          aria-label="按动作筛选"
        />
      </UiFilterField>
      <!-- 起 ≤ 止 enforced with native min/max so an inverted range cannot be picked at all. -->
      <UiFilterField label="起始时间">
        <UiInput v-model="from" type="date" :max="to || undefined" />
      </UiFilterField>
      <UiFilterField label="结束时间">
        <UiInput v-model="to" type="date" :min="from || undefined" />
      </UiFilterField>
    </UiFilterBar>

    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载审计日志
    </p>
    <UiEmptyState v-else-if="entries.length === 0">
      没有符合当前筛选条件的审计记录
    </UiEmptyState>
    <template v-else>
      <p v-if="cappedAt !== null" class="m-0 text-2xs text-ink-subtle">
        仅显示最近
        {{ cappedAt }} 条（后端单次查询上限），缩小时间范围可查看更早的记录
      </p>
      <!-- Same shell as the device list: the table itself does not scroll (`overflow-hidden`
           clips its corners), the page scrolls. -->
      <div :class="[tableClasses.wrapper, 'overflow-hidden']">
        <table :class="[tableClasses.table, 'table-fixed']">
          <!-- Fixed column widths so the geometry does not shift as rows change between queries
               (same reason 设备 pins its columns). An over-long value wraps inside its cell rather
               than widening the column; `truncate` keeps the common case to one tidy line. -->
          <colgroup>
            <col class="w-44" />
            <col class="w-28" />
            <col class="w-28" />
            <col class="w-56" />
            <col class="w-20" />
          </colgroup>
          <caption class="sr-only">
            鉴权与用户管理事件，最新在前
          </caption>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">时间</th>
              <th scope="col" class="px-3 py-2">操作者</th>
              <th scope="col" class="px-3 py-2">动作</th>
              <th scope="col" class="px-3 py-2">对象</th>
              <th scope="col" class="px-3 py-2">结果</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(entry, index) in pageRows"
              :key="`${entry.ts}-${index}`"
              :class="tableClasses.row"
            >
              <td class="px-3 py-2 whitespace-nowrap text-ink-muted">
                {{ formatTime(entry.ts) }}
              </td>
              <td class="truncate px-3 py-2 text-ink">{{ entry.actor }}</td>
              <td class="truncate px-3 py-2 text-ink">
                {{ actionLabel(entry.action) }}
              </td>
              <td
                class="truncate px-3 py-2 text-ink-muted"
                :title="auditObject(entry)"
              >
                {{ auditObject(entry) }}
              </td>
              <td class="px-3 py-2">
                <span
                  :class="
                    entry.outcome === 'failure'
                      ? 'text-critical-ink'
                      : 'text-ink-muted'
                  "
                  >{{ entry.outcome === "failure" ? "失败" : "成功" }}</span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <UiListPagination
        :page="page"
        :page-count="pageCount"
        :page-size="pageSize"
        :total="entries.length"
        @update:page="setPage"
        @update:page-size="setPageSize"
      />
    </template>
  </PageHeader>
</template>
