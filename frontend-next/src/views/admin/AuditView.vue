<script setup lang="ts">
/**
 * 审计 — the audit log (admin), the read side of Phase 15D's `audit_log`.
 *
 * Filters are server-side (the backend caps and orders the result); pagination over the
 * returned page is client-side, matching 告警's shape. Filter state lives in the URL so a
 * shift can hand a view to the next one, the same reasoning `AlertsView` documents.
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { fleetApi, type AuditRecord } from "@navfleet/fleet-core";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiPager from "@/components/ui/UiPager.vue";
import UiSelect from "@/components/ui/UiSelect.vue";

const route = useRoute();
const router = useRouter();

/** Chinese labels for the closed action vocabulary (backend `AuditAction`). */
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
};

const ACTION_OPTIONS = [
  { value: "", label: "全部动作" },
  ...Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })),
];

const readParam = (key: string): string => {
  const value = route.query[key];
  return typeof value === "string" ? value : "";
};

const actor = ref(readParam("actor"));
const action = ref(readParam("action"));
const from = ref(readParam("from"));
const to = ref(readParam("to"));

const entries = ref<AuditRecord[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");

const PAGE_SIZE_OPTIONS = [
  { value: "10", label: "10 条/页" },
  { value: "20", label: "20 条/页" },
  { value: "50", label: "50 条/页" },
];
const pageSize = ref(20);
const page = ref(1);

/** Changing page size restarts at the first page so the slice offset stays in range. */
const setPageSize = (next: string): void => {
  pageSize.value = Number(next);
  page.value = 1;
};

const load = async (): Promise<void> => {
  status.value = "loading";
  try {
    const result = await fleetApi.getAuditLog({
      actor: actor.value || undefined,
      action: action.value || undefined,
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

const applyFilters = (): void => {
  void router.replace({
    query: {
      ...(actor.value ? { actor: actor.value } : {}),
      ...(action.value ? { action: action.value } : {}),
      ...(from.value ? { from: from.value } : {}),
      ...(to.value ? { to: to.value } : {}),
    },
  });
  void load();
};

const resetFilters = (): void => {
  actor.value = "";
  action.value = "";
  from.value = "";
  to.value = "";
  applyFilters();
};

onMounted(() => void load());

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
  <PageHeader title="审计" scroll-content>
    <template #actions>
      <UiButton variant="secondary" size="sm" @click="load">刷新</UiButton>
    </template>

    <section class="flex flex-wrap items-end gap-3" aria-label="筛选">
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">操作者</span>
        <UiInput
          v-model="actor"
          type="search"
          placeholder="用户名"
          @keyup.enter="applyFilters"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">动作</span>
        <UiSelect
          v-model="action"
          :options="ACTION_OPTIONS"
          aria-label="按动作筛选"
        />
      </label>
      <!-- 起 ≤ 止 enforced with native min/max so an inverted range cannot be picked at all. -->
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">起</span>
        <UiInput v-model="from" type="date" :max="to || undefined" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-2xs text-ink-muted">止</span>
        <UiInput v-model="to" type="date" :min="from || undefined" />
      </label>
      <UiButton size="sm" @click="applyFilters">查询</UiButton>
      <!-- 重置 is quieter than 查询: a ghost button, so the reset never reads as a
           second primary action beside the query. -->
      <UiButton variant="ghost" size="sm" @click="resetFilters">重置</UiButton>
    </section>

    <!-- AUDIT_TABLE_PLACEHOLDER -->
    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载审计日志
    </p>
    <p
      v-else-if="entries.length === 0"
      class="text-sm text-ink-muted"
      role="status"
    >
      没有符合条件的记录
    </p>
    <template v-else>
      <div
        class="overflow-auto rounded-sm border border-border"
        tabindex="0"
        role="region"
        aria-label="审计日志"
      >
        <table class="w-full border-collapse text-left text-sm">
          <caption class="sr-only">
            鉴权与用户管理事件，最新在前
          </caption>
          <thead class="bg-surface-sunken text-2xs text-ink-muted uppercase">
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
              class="border-t border-border"
            >
              <td class="px-3 py-2 whitespace-nowrap text-ink-muted">
                {{ formatTime(entry.ts) }}
              </td>
              <td class="px-3 py-2 text-ink">{{ entry.actor }}</td>
              <td class="px-3 py-2 text-ink">
                {{ ACTION_LABELS[entry.action] ?? entry.action }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
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
      <div class="flex items-center justify-between gap-3 text-sm">
        <label class="flex items-center gap-2">
          <span class="text-ink-muted">每页条数</span>
          <UiSelect
            :model-value="String(pageSize)"
            :options="PAGE_SIZE_OPTIONS"
            aria-label="每页条数"
            @update:model-value="setPageSize"
          />
        </label>
        <UiPager v-model:page="page" :page-count="pageCount" />
      </div>
    </template>
  </PageHeader>
</template>
