<script setup lang="ts">
/**
 * 用户 — user management (admin). The console face of Phase 15B's admin API plus 15E's
 * sessions: list / create / edit (role, profile, enable-disable) / reset password / delete,
 * force-logout, and view-and-revoke a user's individual sessions.
 *
 * Every irreversible action (delete, reset, force-logout, revoke a session) goes through
 * `UiConfirmDialog` — the reason `UiButton`'s `danger` variant waited for this page. The
 * backend's lockout guards (last enabled admin, acting on yourself) come back as stable error
 * codes, which `messageFor` turns into a sentence rather than a bare "HTTP 409".
 */
import { computed, onMounted, ref, watch } from "vue";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import {
  fleetApi,
  type AdminUser,
  type SessionRecordView,
  type UserRoleName,
} from "@navfleet/fleet-core";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { tableClasses } from "@/lib/uiClasses";
import { notify } from "@/composables/useNotifications";

const ROLE_LABELS: Record<UserRoleName, string> = {
  admin: "管理员",
  operator: "操作员",
  viewer: "只读",
};
const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as UserRoleName[]).map(
  (value) => ({
    value,
    label: ROLE_LABELS[value],
  }),
);

const ERROR_MESSAGES: Record<string, string> = {
  conflict: "用户名已存在",
  last_admin: "不能停用、降级或删除最后一个启用的管理员",
  self_forbidden: "不能对自己执行该操作",
  not_found: "用户不存在",
};
const messageFor = (error: unknown): string => {
  const code = error instanceof Error ? error.message : "";
  return ERROR_MESSAGES[code] ?? "操作失败，请稍后重试";
};

const INPUT_CLASS =
  "h-9 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-subtle";

// ── List ─────────────────────────────────────────────────────────────────────
const users = ref<AdminUser[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");

const load = async (): Promise<void> => {
  status.value = "loading";
  try {
    const result = await fleetApi.getUsers();
    users.value = result.users;
    status.value = "ready";
  } catch {
    status.value = "error";
  }
};

onMounted(() => void load());

const isLocked = (user: AdminUser): boolean =>
  user.lockedUntil !== null && Date.parse(user.lockedUntil) > Date.now();

// ── Create / edit / reset dialog ───────────────────────────────────────────────
type FormMode = "create" | "edit" | "reset" | null;
const mode = ref<FormMode>(null);
const selected = ref<AdminUser | null>(null);
const saving = ref(false);
const formError = ref("");

// Shared form fields (a subset is used per mode).
const fUsername = ref("");
const fPassword = ref("");
const fRole = ref<UserRoleName>("viewer");
const fDisplayName = ref("");
const fEmail = ref("");
const fPhone = ref("");
const fEnabled = ref(true);
/**
 * Mint as a long-lived read-only wall-display account (Phase 17C). Create-only: kiosk is a
 * property of how the account is born (a months-long refresh horizon), not something toggled
 * later. A kiosk is read-only by construction, so checking it forces the role to viewer — the
 * backend refuses any other role, and `submitForm` pins it again so the two cannot drift.
 */
const fKiosk = ref(false);
watch(fKiosk, (on) => {
  if (on) fRole.value = "viewer";
});

const dialogTitle = computed(() =>
  mode.value === "create"
    ? "新建用户"
    : mode.value === "edit"
      ? `编辑用户 · ${selected.value?.username ?? ""}`
      : `重置密码 · ${selected.value?.username ?? ""}`,
);

const openCreate = (): void => {
  mode.value = "create";
  selected.value = null;
  formError.value = "";
  fUsername.value = "";
  fPassword.value = "";
  fRole.value = "viewer";
  fDisplayName.value = "";
  fEmail.value = "";
  fPhone.value = "";
  fKiosk.value = false;
};

const openEdit = (user: AdminUser): void => {
  mode.value = "edit";
  selected.value = user;
  formError.value = "";
  fRole.value = user.role;
  fDisplayName.value = user.displayName;
  fEmail.value = user.email ?? "";
  fPhone.value = user.phone ?? "";
  fEnabled.value = user.enabled;
};

const openReset = (user: AdminUser): void => {
  mode.value = "reset";
  selected.value = user;
  formError.value = "";
  fPassword.value = "";
};

const closeDialog = (): void => {
  mode.value = null;
};

const weakPassword = (value: string): boolean =>
  value.length < 8 || !/[A-Za-z]/.test(value) || !/\d/.test(value);

const submitForm = async (): Promise<void> => {
  formError.value = "";
  if (mode.value === "create") {
    if (!fUsername.value) {
      formError.value = "请输入用户名";
      return;
    }
    if (weakPassword(fPassword.value)) {
      formError.value = "密码至少 8 位，且需同时包含字母与数字";
      return;
    }
  }
  if (mode.value === "reset" && weakPassword(fPassword.value)) {
    formError.value = "密码至少 8 位，且需同时包含字母与数字";
    return;
  }
  saving.value = true;
  try {
    if (mode.value === "create") {
      await fleetApi.createUser({
        username: fUsername.value,
        password: fPassword.value,
        // A kiosk is read-only by construction; pin viewer so a stale role selection
        // (e.g. picked before the box was checked) can never reach the backend.
        role: fKiosk.value ? "viewer" : fRole.value,
        displayName: fDisplayName.value || undefined,
        email: fEmail.value || null,
        phone: fPhone.value || null,
        kiosk: fKiosk.value || undefined,
      });
      notify("已创建用户", { type: "success" });
    } else if (mode.value === "edit" && selected.value) {
      await fleetApi.updateUser(selected.value.username, {
        role: fRole.value,
        displayName: fDisplayName.value || undefined,
        email: fEmail.value || null,
        phone: fPhone.value || null,
        enabled: fEnabled.value,
      });
      notify("已更新用户", { type: "success" });
    } else if (mode.value === "reset" && selected.value) {
      await fleetApi.resetPassword(selected.value.username, fPassword.value);
      notify("已重置密码，该用户所有会话已失效", { type: "success" });
    }
    closeDialog();
    await load();
  } catch (error) {
    formError.value = messageFor(error);
  } finally {
    saving.value = false;
  }
};

// ── Destructive actions (confirm) ──────────────────────────────────────────────
type Confirm =
  | { kind: "delete"; user: AdminUser }
  | { kind: "logout"; user: AdminUser }
  | { kind: "revoke"; user: AdminUser; sessionId: string };
const confirm = ref<Confirm | null>(null);
const acting = ref(false);

const confirmCopy = computed(() => {
  const value = confirm.value;
  if (!value) return { title: "", description: "", label: "确认" };
  if (value.kind === "delete")
    return {
      title: `删除用户 ${value.user.username}？`,
      description: "该账号将被永久删除，无法恢复",
      label: "删除",
    };
  if (value.kind === "logout")
    return {
      title: `强制下线 ${value.user.username}？`,
      description: "该用户所有设备将被登出，已签发的令牌立即失效",
      label: "强制下线",
    };
  return {
    title: "下线该会话？",
    description: `将结束 ${value.user.username} 的这个设备会话`,
    label: "下线",
  };
});

const runConfirm = async (): Promise<void> => {
  const value = confirm.value;
  if (!value) return;
  acting.value = true;
  try {
    if (value.kind === "delete") {
      await fleetApi.deleteUser(value.user.username);
      notify("已删除用户", { type: "success" });
      await load();
    } else if (value.kind === "logout") {
      await fleetApi.forceLogout(value.user.username);
      notify("已强制下线", { type: "success" });
      if (sessionsFor.value === value.user.username)
        await loadSessions(value.user.username);
    } else {
      await fleetApi.revokeUserSession(value.user.username, value.sessionId);
      notify("已下线该会话", { type: "success" });
      sessionList.value = sessionList.value.filter(
        (s) => s.sessionId !== value.sessionId,
      );
    }
    confirm.value = null;
  } catch (error) {
    notify(messageFor(error), { type: "error" });
  } finally {
    acting.value = false;
  }
};

// ── Per-user sessions panel ────────────────────────────────────────────────────
const sessionsFor = ref<string | null>(null);
const sessionList = ref<SessionRecordView[]>([]);
const sessionsStatus = ref<"loading" | "ready" | "error">("loading");

const loadSessions = async (username: string): Promise<void> => {
  sessionsStatus.value = "loading";
  try {
    const result = await fleetApi.getUserSessions(username);
    sessionList.value = result.sessions;
    sessionsStatus.value = "ready";
  } catch {
    sessionsStatus.value = "error";
  }
};

const toggleSessions = (username: string): void => {
  if (sessionsFor.value === username) {
    sessionsFor.value = null;
    return;
  }
  sessionsFor.value = username;
  void loadSessions(username);
};

const formatTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";
</script>

<template>
  <PageHeader title="用户">
    <template #actions>
      <UiButton variant="secondary" size="sm" @click="load">刷新</UiButton>
      <UiButton size="sm" @click="openCreate">新建用户</UiButton>
    </template>

    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载用户列表
    </p>
    <div
      v-else
      :class="[tableClasses.wrapper, 'overflow-auto']"
      tabindex="0"
      role="region"
      aria-label="用户列表"
    >
      <table :class="tableClasses.table">
        <caption class="sr-only">
          账号、角色、状态与管理操作
        </caption>
        <thead :class="tableClasses.thead">
          <tr>
            <th scope="col" class="px-3 py-2">用户名</th>
            <th scope="col" class="px-3 py-2">角色</th>
            <th scope="col" class="px-3 py-2">状态</th>
            <th scope="col" class="px-3 py-2">最近登录</th>
            <th scope="col" class="px-3 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="user in users" :key="user.username">
            <tr :class="tableClasses.row">
              <th scope="row" class="px-3 py-2 font-medium text-ink">
                {{ user.username }}
                <span
                  v-if="user.displayName !== user.username"
                  class="text-ink-muted"
                >
                  · {{ user.displayName }}
                </span>
              </th>
              <td class="px-3 py-2 text-ink-muted">
                {{ ROLE_LABELS[user.role] }}
              </td>
              <td class="px-3 py-2">
                <span v-if="!user.enabled" class="text-ink-subtle">已停用</span>
                <span v-else-if="isLocked(user)" class="text-warning-ink"
                  >已锁定</span
                >
                <span v-else class="text-ink-muted">正常</span>
              </td>
              <td class="px-3 py-2 whitespace-nowrap text-ink-muted">
                {{ formatTime(user.lastLoginAt) }}
              </td>
              <td class="px-3 py-2">
                <div class="flex justify-end gap-1">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="toggleSessions(user.username)"
                  >
                    会话
                  </UiButton>
                  <UiButton variant="ghost" size="sm" @click="openEdit(user)"
                    >编辑</UiButton
                  >
                  <UiButton variant="ghost" size="sm" @click="openReset(user)"
                    >重置</UiButton
                  >
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="confirm = { kind: 'logout', user }"
                  >
                    强制下线
                  </UiButton>
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="confirm = { kind: 'delete', user }"
                  >
                    删除
                  </UiButton>
                </div>
              </td>
            </tr>
            <!-- USERS_SESSIONS_ROW_PLACEHOLDER -->
            <tr
              v-if="sessionsFor === user.username"
              :class="[tableClasses.row, 'bg-surface-sunken']"
            >
              <td colspan="5" class="px-3 py-3">
                <p
                  v-if="sessionsStatus === 'loading'"
                  class="text-sm text-ink-muted"
                >
                  加载会话中…
                </p>
                <p
                  v-else-if="sessionsStatus === 'error'"
                  class="text-sm text-critical-ink"
                  role="alert"
                >
                  无法加载该用户的会话
                </p>
                <p
                  v-else-if="sessionList.length === 0"
                  class="text-sm text-ink-muted"
                  role="status"
                >
                  该用户当前无活跃会话
                </p>
                <ul v-else class="m-0 flex list-none flex-col gap-2 p-0">
                  <li
                    v-for="s in sessionList"
                    :key="s.sessionId"
                    class="flex items-center justify-between gap-3 rounded-sm border border-border bg-surface-raised px-3 py-2"
                  >
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate text-sm text-ink">{{
                        s.userAgent || "未知设备"
                      }}</span>
                      <span class="text-2xs text-ink-muted">
                        {{ s.ip || "—" }} · 最近活跃
                        {{ formatTime(s.lastSeenAt) }}
                      </span>
                    </span>
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="
                        confirm = {
                          kind: 'revoke',
                          user,
                          sessionId: s.sessionId,
                        }
                      "
                    >
                      下线
                    </UiButton>
                  </li>
                </ul>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <!-- USERS_DIALOGS_PLACEHOLDER -->
    <DialogRoot
      :open="mode !== null"
      @update:open="
        (open) => {
          if (!open) closeDialog();
        }
      "
    >
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-scrim/55" />
        <DialogContent
          class="fixed top-1/2 left-1/2 z-50 flex w-full max-w-100 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-md border border-border bg-surface-raised p-5 shadow-overlay"
        >
          <DialogTitle class="text-md font-semibold text-ink">{{
            dialogTitle
          }}</DialogTitle>
          <DialogDescription class="sr-only">填写表单后提交</DialogDescription>
          <form
            class="flex flex-col gap-3"
            :aria-busy="saving"
            @submit.prevent="submitForm"
          >
            <label v-if="mode === 'create'" class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">用户名</span>
              <input
                v-model="fUsername"
                type="text"
                :disabled="saving"
                :class="INPUT_CLASS"
              />
            </label>
            <label
              v-if="mode === 'create' || mode === 'reset'"
              class="flex flex-col gap-1"
            >
              <span class="text-sm font-medium text-ink">
                {{ mode === "reset" ? "新密码" : "密码" }}
              </span>
              <input
                v-model="fPassword"
                type="password"
                autocomplete="new-password"
                placeholder="至少 8 位，含字母与数字"
                :disabled="saving"
                :class="INPUT_CLASS"
              />
            </label>
            <label
              v-if="mode === 'create' || mode === 'edit'"
              class="flex flex-col gap-1"
            >
              <span class="text-sm font-medium text-ink">角色</span>
              <UiSelect
                v-model="fRole"
                :options="ROLE_OPTIONS"
                aria-label="角色"
              />
            </label>
            <label
              v-if="mode === 'create' || mode === 'edit'"
              class="flex flex-col gap-1"
            >
              <span class="text-sm font-medium text-ink">显示名</span>
              <input
                v-model="fDisplayName"
                type="text"
                :disabled="saving"
                :class="INPUT_CLASS"
              />
            </label>
            <label
              v-if="mode === 'create' || mode === 'edit'"
              class="flex flex-col gap-1"
            >
              <span class="text-sm font-medium text-ink">邮箱</span>
              <input
                v-model="fEmail"
                type="text"
                :disabled="saving"
                :class="INPUT_CLASS"
              />
            </label>
            <label
              v-if="mode === 'create' || mode === 'edit'"
              class="flex flex-col gap-1"
            >
              <span class="text-sm font-medium text-ink">电话</span>
              <input
                v-model="fPhone"
                type="text"
                :disabled="saving"
                :class="INPUT_CLASS"
              />
            </label>
            <label v-if="mode === 'create'" class="flex flex-col gap-1">
              <span class="flex items-center gap-2">
                <input v-model="fKiosk" type="checkbox" :disabled="saving" />
                <span class="text-sm text-ink"
                  >大屏 kiosk 账号（长效只读）</span
                >
              </span>
              <span class="text-2xs text-ink-subtle">
                固定为只读角色，登录后会话数月不掉线，用于无人值守的墙面大屏
              </span>
            </label>
            <label v-if="mode === 'edit'" class="flex items-center gap-2">
              <input v-model="fEnabled" type="checkbox" :disabled="saving" />
              <span class="text-sm text-ink">启用该账号</span>
            </label>
            <p v-if="formError" class="text-sm text-critical-ink" role="alert">
              {{ formError }}
            </p>
            <div class="mt-1 flex justify-end gap-2">
              <UiButton
                variant="secondary"
                size="sm"
                :disabled="saving"
                @click="closeDialog"
              >
                取消
              </UiButton>
              <UiButton type="submit" size="sm" :disabled="saving">
                {{ saving ? "提交中…" : "保存" }}
              </UiButton>
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <UiConfirmDialog
      :open="confirm !== null"
      :title="confirmCopy.title"
      :description="confirmCopy.description"
      :confirm-label="confirmCopy.label"
      :pending="acting"
      @update:open="
        (open) => {
          if (!open) confirm = null;
        }
      "
      @confirm="runConfirm"
    />
  </PageHeader>
</template>
