<script setup lang="ts">
/**
 * 审计 — the audit log (admin), the read side of Phase 15D's `audit_log`.
 *
 * Filters are server-side (the backend caps and orders the result); pagination over the
 * returned page is client-side, matching 告警's shape. Filter state lives in the URL so a
 * shift can hand a view to the next one, the same reasoning `AlertsView` documents.
 */
import { computed, onMounted, ref, watch } from "vue";
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
import { useAutoRefresh } from "@/composables/useAutoRefresh";

const route = useRoute();
const router = useRouter();

/**
 * Chinese labels for the closed action vocabulary (backend `AuditAction` / `AUDIT_ACTIONS`).
 * Keep in step with that tuple: every action the backend can emit needs a label, or the 动作
 * dropdown cannot select it and the row falls back to the raw key. The five config-write actions
 * and the two alert actions were missing until 1.6.1.
 */
const ACTION_LABELS: Record<string, string> = {
  login: "登录",
  login_failed: "登录失败",
  logout: "登出",
  password_change: "修改密码",
  password_reset: "重置密码",
  user_create: "创建用户",
  user_update: "更新用户",
  user_delete: "删除用户",
  session_revoke: "下线会话",
  force_logout: "强制下线",
  account_locked: "账号锁定",
  alert_ack: "确认告警",
  alert_unack: "取消确认",
  codebook_import: "导入报码字典",
  vehicles_write: "写入车辆配置",
  formations_write: "写入编队配置",
  scenes_write: "写入场景配置",
  scene_asset_upload: "上传场景资源",
};

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
const status = ref<"loading" | "ready" | "error">("loading");

const pageSize = ref(10);
const page = ref(1);

/** Changing page size restarts at the first page so the slice offset stays in range. */
const setPageSize = (next: string): void => {
  pageSize.value = Number(next);
  page.value = 1;
};

const load = async (): Promise<void> => {
  // Only flash the skeleton before the first successful load; filter changes and the focus
  // refresh re-query live, so blanking the table to 加载中… on every keystroke would be noise.
  if (status.value !== "ready") status.value = "loading";
  try {
    const result = await fleetApi.getAuditLog({
      actor: actor.value || undefined,
      action: action.value.length ? action.value.join(",") : undefined,
      from: from.value || undefined,
      to: to.value || undefined,
    });
    entries.value = result.entries;
    page.value = 1;
    status.value = "ready";
  } catch {
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

const pageCount = computed(() =>
  Math.max(1, Math.ceil(entries.value.length / pageSize.value)),
);
const pageRows = computed(() =>
  entries.value.slice(
    (page.value - 1) * pageSize.value,
    page.value * pageSize.value,
  ),
);

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
      没有符合当前筛选条件的记录
    </UiEmptyState>
    <template v-else>
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
                {{ ACTION_LABELS[entry.action] ?? entry.action }}
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ entry.target ?? "—" }}
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
        @update:page="(value) => (page = value)"
        @update:page-size="setPageSize"
      />
    </template>
  </PageHeader>
</template>
