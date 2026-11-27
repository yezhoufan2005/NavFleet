<script setup lang="ts">
/**
 * 个人中心 — the one authenticated-but-not-admin page (viewer+, no `roles`).
 *
 * What a person needs to know and manage about their own account, top-down:
 * - 账户: who they are (display name, username, role) and their contact fields, which they may
 *   edit themselves (`PATCH /api/auth/profile`); role and enabled stay with `users:manage`.
 * - 我的权限: their role, the groups they are in, and what that lets them do — the capabilities
 *   the console already gates on, in words.
 * - 修改密码: changing it invalidates every other session server-side and re-issues fresh cookies
 *   for THIS device, so the form stays signed in. The rules tick as you type.
 * - 我的会话: where they are signed in; end one device, or every device but this one. Revoking
 *   the current session is "log out" wearing a different name, so it logs out.
 * - 账户活动: their recent sign-ins (with where from), password and profile changes, and what an
 *   administrator did to their account — a failed sign-in from an unknown address is the thing
 *   this exists to surface. Not the audit trail: no `audit:read` needed, nothing about others.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  CAPABILITIES,
  type AccountActivity,
  type AccountProfile,
} from "@navfleet/shared";
import { formatStamp, type SessionRecordView } from "@navfleet/fleet-core";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiCard from "@/components/ui/UiCard.vue";
import UiLoading from "@/components/ui/UiLoading.vue";
import UiBusyRegion from "@/components/ui/UiBusyRegion.vue";
import UiModal from "@/components/ui/UiModal.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { tableClasses, textClasses } from "@/lib/uiClasses";
import { vOverflowTitle } from "@/directives/overflowTitle";
import { useAuth } from "@/composables/useAuth";
import { useFieldErrors } from "@/composables/useFieldErrors";
import { useDirtySnapshot } from "@/composables/useDirtySnapshot";
import { notify } from "@/composables/useNotifications";
import { CAPABILITY_LABELS, ROLE_LABELS } from "@/lib/accessLabels";
import { actionLabel } from "@/lib/auditLog";
import { describeUserAgent } from "@/lib/userAgent";

const auth = useAuth();

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString("zh-CN", { hour12: false });

// ── Account ──────────────────────────────────────────────────────────────────
const profile = ref<AccountProfile | null>(null);
const profileStatus = ref<"loading" | "ready" | "error">("loading");

const loadProfile = async (): Promise<void> => {
  profileStatus.value = "loading";
  try {
    profile.value = await auth.getProfile();
    profileStatus.value = "ready";
  } catch {
    profileStatus.value = "error";
  }
};

const roleLabel = computed(() => {
  const role = profile.value?.role ?? auth.state.user?.role;
  return role ? ROLE_LABELS[role] : "";
});

/** The avatar letter: the first character of the display name (or username). */
const initial = computed(() =>
  (profile.value?.displayName || profile.value?.username || "?")
    .slice(0, 1)
    .toUpperCase(),
);

/** `今天` / `N 天前` — how stale a password is, at a glance. */
const ageLabel = (iso: string): string => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "今天" : `${days} 天前`;
};

const accountFields = computed(() => {
  const account = profile.value;
  if (!account) return [];
  return [
    { label: "邮箱", value: account.email || "未填写" },
    { label: "手机", value: account.phone || "未填写" },
    { label: "最近登录", value: formatStamp(account.lastLoginAt) },
    {
      label: "密码更新",
      value: `${formatStamp(account.passwordUpdatedAt)}（${ageLabel(account.passwordUpdatedAt)}）`,
    },
  ];
});

// ── Edit profile ─────────────────────────────────────────────────────────────
const editing = ref(false);
const saving = ref(false);
const editError = ref("");
const fDisplayName = ref("");
const fEmail = ref("");
const fPhone = ref("");
const { errors, clearOn, setErrors, report } = useFieldErrors();
clearOn(fDisplayName, "displayName");
clearOn(fEmail, "email");
clearOn(fPhone, "phone");

const editSnapshot = useDirtySnapshot(() => [
  fDisplayName.value,
  fEmail.value,
  fPhone.value,
]);

const openEdit = (): void => {
  const account = profile.value;
  if (!account) return;
  fDisplayName.value = account.displayName;
  fEmail.value = account.email ?? "";
  fPhone.value = account.phone ?? "";
  editError.value = "";
  setErrors({});
  editing.value = true;
  void nextTick(editSnapshot.mark);
};

const submitProfile = async (): Promise<void> => {
  const displayName = fDisplayName.value.trim();
  if (report(displayName ? {} : { displayName: "显示名不能为空" })) return;
  saving.value = true;
  editError.value = "";
  try {
    const result = await auth.updateProfile({
      displayName,
      email: fEmail.value.trim() || null,
      phone: fPhone.value.trim() || null,
    });
    if (result.ok) {
      profile.value = result.profile;
      editing.value = false;
      notify("资料已保存", { type: "success" });
      void loadActivity();
    } else if (!report(result.fieldErrors)) {
      editError.value = result.message;
    }
  } finally {
    saving.value = false;
  }
};

// ── Permissions ──────────────────────────────────────────────────────────────
/** What the caller may change, in the shared capability order; empty for a read-only account. */
const capabilityLabels = computed(() =>
  CAPABILITIES.filter((capability) =>
    auth.state.capabilities.includes(capability),
  ).map((capability) => CAPABILITY_LABELS[capability]),
);
// ── Change password ──────────────────────────────────────────────────────────
const oldPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const showPasswords = ref(false);
const formError = ref("");
const changing = ref(false);

/**
 * The backend policy (validation.ts passwordSchema), ticked as the new password is typed, so the
 * rule is visible before a submit fails on it rather than only in the error after.
 */
const passwordRules = computed(() => [
  { label: "至少 8 位", met: newPassword.value.length >= 8 },
  { label: "含字母", met: /[A-Za-z]/.test(newPassword.value) },
  { label: "含数字", met: /\d/.test(newPassword.value) },
  {
    label: "两次输入一致",
    met:
      confirmPassword.value !== "" &&
      newPassword.value === confirmPassword.value,
  },
]);

const submitPassword = async (): Promise<void> => {
  formError.value = "";
  if (!oldPassword.value || !newPassword.value) {
    formError.value = "请填写当前密码与新密码";
    return;
  }
  // Mirror the backend policy so the common case fails fast here rather than round-tripping.
  if (!passwordRules.value.slice(0, 3).every((rule) => rule.met)) {
    formError.value = "新密码至少 8 位，且需同时包含字母与数字";
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    formError.value = "两次输入的新密码不一致";
    return;
  }
  changing.value = true;
  try {
    const result = await auth.changePassword(
      oldPassword.value,
      newPassword.value,
    );
    if (result.ok) {
      notify("密码已修改，其他设备的登录已失效", { type: "success" });
      oldPassword.value = "";
      newPassword.value = "";
      confirmPassword.value = "";
      // The backend ended every session and opened a new one for this device, so the list
      // below is now wrong: every row in it is gone, and the current one is not among them.
      void loadSessions();
      void loadProfile();
      void loadActivity();
    } else {
      formError.value = result.message;
    }
  } finally {
    changing.value = false;
  }
};

// ── My sessions ──────────────────────────────────────────────────────────────
const sessions = ref<SessionRecordView[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");
/** A re-query of data already on screen (see `UiBusyRegion`); the first load is `status`. */
const refreshing = ref(false);
const confirmTarget = ref<SessionRecordView | null>(null);
const confirmOthers = ref(false);
const revoking = ref(false);

const otherCount = computed(
  () => sessions.value.filter((session) => !session.current).length,
);

const loadSessions = async (): Promise<void> => {
  if (status.value === "ready") refreshing.value = true;
  else status.value = "loading";
  try {
    sessions.value = await auth.getMySessions();
    refreshing.value = false;
    status.value = "ready";
  } catch {
    refreshing.value = false;
    status.value = "error";
  }
};

const confirmRevoke = async (): Promise<void> => {
  const target = confirmTarget.value;
  if (!target) return;
  revoking.value = true;
  try {
    const ok = await auth.revokeMySession(target.sessionId);
    if (!ok) {
      notify("下线失败，请稍后重试", { type: "error" });
      // Most often the session had already ended (another device, an admin); show what is left.
      void loadSessions();
      return;
    }
    if (target.current) {
      // Revoking our own current session is just logging out — reflect that locally so the
      // shell drops to the login screen instead of showing a session the server has ended.
      await auth.logout();
      return;
    }
    sessions.value = sessions.value.filter(
      (s) => s.sessionId !== target.sessionId,
    );
    notify("已下线该设备", { type: "success" });
    void loadActivity();
  } finally {
    revoking.value = false;
    confirmTarget.value = null;
  }
};

const confirmRevokeOthers = async (): Promise<void> => {
  revoking.value = true;
  try {
    const ended = await auth.revokeOtherSessions();
    notify(ended ? `已下线其他 ${ended} 台设备` : "没有其他设备在线", {
      type: "success",
    });
  } catch {
    notify("下线失败，请稍后重试", { type: "error" });
  } finally {
    revoking.value = false;
    confirmOthers.value = false;
    void loadSessions();
    void loadActivity();
  }
};

// ── Account activity ─────────────────────────────────────────────────────────
const activity = ref<AccountActivity[]>([]);
const activityStatus = ref<"loading" | "ready" | "error">("loading");

const loadActivity = async (): Promise<void> => {
  if (activityStatus.value !== "ready") activityStatus.value = "loading";
  try {
    activity.value = await auth.getAccountActivity();
    activityStatus.value = "ready";
  } catch {
    activityStatus.value = "error";
  }
};

/** 本人 for the caller's own rows; an administrator's username for what was done to them. */
const actorLabel = (actor: string): string =>
  actor === (profile.value?.username ?? auth.state.user?.username)
    ? "本人"
    : actor;

const originLabel = (row: AccountActivity): string =>
  [row.ip, row.userAgent ? describeUserAgent(row.userAgent) : ""]
    .filter(Boolean)
    .join(" · ") || "—";

onMounted(() => {
  void loadProfile();
  void loadSessions();
  void loadActivity();
});

// A dirty edit dialog asks before Esc / a backdrop click throws the edits away.
const editDirty = editSnapshot.dirty;
watch(editing, (open) => {
  if (!open) setErrors({});
});
</script>

<template>
  <PageHeader title="个人中心">
    <!-- 账户: who this is, then the contact fields and account dates under a hairline. -->
    <UiCard
      as="section"
      class="@container"
      aria-labelledby="profile-account-heading"
      :aria-busy="profileStatus === 'loading'"
    >
      <UiLoading
        v-if="profileStatus === 'loading'"
        kind="fields"
        :rows="1"
        :columns="4"
        label="正在加载账户信息"
      />
      <p
        v-else-if="profileStatus === 'error' || !profile"
        class="m-0 text-sm text-critical-ink"
        role="alert"
      >
        无法加载账户信息
      </p>
      <template v-else>
        <div class="flex items-start gap-4">
          <span
            class="grid size-12 shrink-0 place-items-center rounded-full bg-brand-wash text-lg font-semibold text-brand-ink"
            aria-hidden="true"
            >{{ initial }}</span
          >
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <h3
                id="profile-account-heading"
                v-overflow-title
                class="m-0 text-md font-semibold text-ink"
                :class="textClasses.title"
              >
                {{ profile.displayName || profile.username }}
              </h3>
              <span
                class="rounded-xs bg-brand-wash px-1.5 py-0.5 text-2xs font-medium text-brand-ink"
                :class="textClasses.fixed"
                >{{ roleLabel }}</span
              >
              <span
                v-if="profile.kiosk"
                class="rounded-xs border border-border bg-surface-sunken px-1.5 py-0.5 text-2xs text-ink-muted"
                :class="textClasses.fixed"
                >大屏账号</span
              >
            </div>
            <p class="m-0 text-xs text-ink-subtle" :class="textClasses.body">
              <span class="font-mono" :class="textClasses.id">{{
                profile.username
              }}</span>
              · 创建于 {{ formatStamp(profile.createdAt) }}
            </p>
          </div>
          <UiButton
            variant="secondary"
            size="sm"
            class="shrink-0"
            @click="openEdit"
            >编辑资料</UiButton
          >
        </div>
        <dl
          class="m-0 mt-4 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-border pt-4 @md:grid-cols-2 @4xl:grid-cols-4"
        >
          <div
            v-for="field in accountFields"
            :key="field.label"
            class="flex min-w-0 flex-col gap-0.5"
          >
            <dt class="text-2xs text-ink-subtle">{{ field.label }}</dt>
            <dd
              class="m-0 text-sm text-ink tabular-nums"
              :class="textClasses.body"
            >
              {{ field.value }}
            </dd>
          </div>
        </dl>
      </template>
    </UiCard>

    <!-- Two cards in a row, equal height: what the account may do, and its password. -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <UiCard as="section" aria-labelledby="profile-access-heading">
        <template #header>
          <h3
            id="profile-access-heading"
            class="text-md font-semibold text-ink"
          >
            我的权限
          </h3>
        </template>
        <dl class="m-0 flex flex-col gap-3 text-sm">
          <div class="flex min-w-0 items-baseline gap-3">
            <dt class="w-16 shrink-0 text-2xs text-ink-subtle">角色</dt>
            <dd class="m-0 text-ink">{{ roleLabel || "--" }}</dd>
          </div>
          <div class="flex min-w-0 items-baseline gap-3">
            <dt class="w-16 shrink-0 text-2xs text-ink-subtle">所属用户组</dt>
            <dd class="m-0 min-w-0 text-ink" :class="textClasses.body">
              {{
                profile?.groups.length ? profile.groups.join("、") : "未加入"
              }}
            </dd>
          </div>
          <div class="flex min-w-0 items-baseline gap-3">
            <dt class="w-16 shrink-0 text-2xs text-ink-subtle">可执行</dt>
            <dd class="m-0 min-w-0">
              <ul
                v-if="capabilityLabels.length"
                class="m-0 flex list-none flex-wrap gap-1.5 p-0"
                aria-label="已授予的能力"
              >
                <li
                  v-for="label in capabilityLabels"
                  :key="label"
                  class="rounded-xs border border-border bg-surface-sunken px-1.5 py-0.5 text-2xs text-ink-muted"
                >
                  {{ label }}
                </li>
              </ul>
              <span v-else class="text-ink-muted"
                >只读：可查看全部监控数据，不能修改配置或处置消息</span
              >
            </dd>
          </div>
        </dl>
        <p class="m-0 mt-3 text-2xs text-ink-subtle">
          角色与用户组由管理员在「用户」中调整
        </p>
      </UiCard>
      <UiCard as="section" aria-labelledby="profile-password-heading">
        <template #header>
          <h3
            id="profile-password-heading"
            class="text-md font-semibold text-ink"
          >
            修改密码
          </h3>
        </template>
        <template #actions>
          <label class="flex items-center gap-1.5 text-xs text-ink-muted">
            <input
              id="profile-show-passwords"
              v-model="showPasswords"
              type="checkbox"
              class="accent-brand"
            />
            显示密码
          </label>
        </template>
        <form
          class="flex flex-col gap-3"
          :aria-busy="changing"
          @submit.prevent="submitPassword"
        >
          <label class="flex flex-col gap-1.5">
            <span class="text-sm font-medium text-ink">当前密码</span>
            <UiInput
              id="profile-old-password"
              v-model="oldPassword"
              :type="showPasswords ? 'text' : 'password'"
              autocomplete="current-password"
              :disabled="changing"
              :aria-invalid="formError ? 'true' : undefined"
              size="md"
            />
          </label>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="flex min-w-0 flex-col gap-1.5">
              <span class="text-sm font-medium text-ink">新密码</span>
              <UiInput
                id="profile-new-password"
                v-model="newPassword"
                :type="showPasswords ? 'text' : 'password'"
                autocomplete="new-password"
                aria-describedby="profile-password-rules"
                :disabled="changing"
                :aria-invalid="formError ? 'true' : undefined"
                size="md"
              />
            </label>
            <label class="flex min-w-0 flex-col gap-1.5">
              <span class="text-sm font-medium text-ink">确认新密码</span>
              <UiInput
                id="profile-confirm-password"
                v-model="confirmPassword"
                :type="showPasswords ? 'text' : 'password'"
                autocomplete="new-password"
                :disabled="changing"
                :aria-invalid="formError ? 'true' : undefined"
                size="md"
              />
            </label>
          </div>
          <ul
            id="profile-password-rules"
            class="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs"
            aria-label="密码要求"
          >
            <li
              v-for="rule in passwordRules"
              :key="rule.label"
              class="flex items-center gap-1"
              :class="rule.met ? 'text-brand-ink' : 'text-ink-subtle'"
            >
              <span aria-hidden="true">{{ rule.met ? "✓" : "○" }}</span>
              {{ rule.label
              }}<span class="sr-only">{{
                rule.met ? "，已满足" : "，未满足"
              }}</span>
            </li>
          </ul>
          <p
            v-if="formError"
            class="m-0 rounded-sm bg-critical-wash px-3 py-2 text-sm text-critical-ink"
            role="alert"
          >
            {{ formError }}
          </p>
          <UiButton
            type="submit"
            :disabled="changing"
            class="mt-auto self-start"
          >
            {{ changing ? "提交中…" : "修改密码" }}
          </UiButton>
          <p class="m-0 text-2xs text-ink-subtle">
            修改后其他设备上的登录会立即失效，本机保持登录
          </p>
        </form>
      </UiCard>
    </div>

    <UiCard
      as="section"
      aria-labelledby="profile-sessions-heading"
      :aria-busy="status === 'loading'"
    >
      <template #header>
        <h3
          id="profile-sessions-heading"
          class="text-md font-semibold text-ink"
        >
          我的会话
        </h3>
      </template>
      <template v-if="status === 'ready' && otherCount > 0" #actions>
        <UiButton variant="secondary" size="sm" @click="confirmOthers = true"
          >下线其他设备</UiButton
        >
      </template>
      <UiLoading
        v-if="status === 'loading'"
        label="正在加载会话"
        :rows="2"
        :columns="5"
        action
      />
      <p
        v-else-if="status === 'error'"
        class="m-0 text-sm text-critical-ink"
        role="alert"
      >
        无法加载会话列表
      </p>
      <p
        v-else-if="sessions.length === 0"
        class="m-0 text-sm text-ink-muted"
        role="status"
      >
        暂无活跃会话
      </p>
      <UiBusyRegion v-else :busy="refreshing">
        <div
          :class="tableClasses.wrapper"
          tabindex="0"
          role="region"
          aria-label="我的会话列表"
        >
          <table :class="[tableClasses.table, 'table-fixed', 'min-w-[44rem]']">
            <caption class="sr-only">
              当前账号的活跃登录会话
            </caption>
            <!-- Shared column-width standard (`tableClasses`): bases are measured content widths,
               slack spread proportionally. 设备 names the browser and system; the raw
               user-agent string is on hover. -->
            <colgroup>
              <col class="w-48" />
              <col class="w-28" />
              <col class="w-40" />
              <col class="w-40" />
              <col class="w-20" />
            </colgroup>
            <thead :class="tableClasses.thead">
              <tr>
                <th scope="col" class="px-3 py-2">设备</th>
                <th scope="col" class="px-3 py-2">IP</th>
                <th scope="col" class="px-3 py-2">登录时间</th>
                <th scope="col" class="px-3 py-2">最近活跃</th>
                <th scope="col" class="py-2 pr-6 pl-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="s in sessions"
                :key="s.sessionId"
                :class="tableClasses.row"
              >
                <td class="px-3 py-2 text-ink">
                  <span class="flex min-w-0 items-center gap-2">
                    <span
                      class="min-w-0"
                      :class="textClasses.cell"
                      :title="s.userAgent || undefined"
                      >{{ describeUserAgent(s.userAgent) }}</span
                    >
                    <span
                      v-if="s.current"
                      class="shrink-0 rounded-sm bg-brand-wash px-1.5 py-0.5 text-2xs whitespace-nowrap text-brand-ink"
                      >本机</span
                    >
                  </span>
                </td>
                <td
                  v-overflow-title
                  class="px-3 py-2 font-mono text-xs text-ink-muted"
                  :class="textClasses.cell"
                >
                  {{ s.ip || "—" }}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-ink-muted">
                  {{ formatTime(s.createdAt) }}
                </td>
                <td class="px-3 py-2 whitespace-nowrap text-ink-muted">
                  {{ formatTime(s.lastSeenAt) }}
                </td>
                <td class="px-3 py-2 text-right">
                  <UiButton variant="ghost" size="sm" @click="confirmTarget = s"
                    >下线</UiButton
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiBusyRegion>
    </UiCard>
    <UiCard
      as="section"
      aria-labelledby="profile-activity-heading"
      :aria-busy="activityStatus === 'loading'"
    >
      <template #header>
        <div class="flex flex-col gap-0.5">
          <h3
            id="profile-activity-heading"
            class="text-md font-semibold text-ink"
          >
            账户活动
          </h3>
          <p class="m-0 text-2xs text-ink-subtle">
            最近 20 条：登录、密码与资料修改、会话下线，以及管理员对本账号的操作
          </p>
        </div>
      </template>
      <UiLoading
        v-if="activityStatus === 'loading'"
        label="正在加载账户活动"
        :columns="5"
      />
      <p
        v-else-if="activityStatus === 'error'"
        class="m-0 text-sm text-critical-ink"
        role="alert"
      >
        无法加载账户活动
      </p>
      <p
        v-else-if="activity.length === 0"
        class="m-0 text-sm text-ink-muted"
        role="status"
      >
        暂无记录
      </p>
      <div
        v-else
        :class="tableClasses.wrapper"
        tabindex="0"
        role="region"
        aria-label="账户活动列表"
      >
        <table :class="[tableClasses.table, 'table-fixed', 'min-w-[44rem]']">
          <caption class="sr-only">
            当前账号最近的账户活动
          </caption>
          <colgroup>
            <col class="w-44" />
            <col class="w-32" />
            <col class="w-20" />
            <col class="w-24" />
            <col class="w-56" />
          </colgroup>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">时间</th>
              <th scope="col" class="px-3 py-2">事件</th>
              <th scope="col" class="px-3 py-2">结果</th>
              <th scope="col" class="px-3 py-2">操作人</th>
              <th scope="col" class="px-3 py-2">来源</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in activity"
              :key="`${row.ts}-${row.action}-${index}`"
              :class="tableClasses.row"
            >
              <td
                class="px-3 py-2 whitespace-nowrap text-ink-muted tabular-nums"
              >
                {{ formatTime(row.ts) }}
              </td>
              <td class="px-3 py-2 text-ink" :class="textClasses.cell">
                {{ actionLabel(row.action) }}
              </td>
              <td class="px-3 py-2">
                <span
                  class="rounded-xs px-1.5 py-0.5 text-2xs whitespace-nowrap"
                  :class="
                    row.outcome === 'success'
                      ? 'bg-surface-sunken text-ink-muted'
                      : 'bg-critical-wash text-critical-ink'
                  "
                  >{{ row.outcome === "success" ? "成功" : "失败" }}</span
                >
              </td>
              <td
                v-overflow-title
                class="px-3 py-2 text-ink-muted"
                :class="textClasses.cell"
              >
                {{ actorLabel(row.actor) }}
              </td>
              <td
                v-overflow-title
                class="px-3 py-2 text-xs text-ink-muted"
                :class="textClasses.cell"
              >
                {{ originLabel(row) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiModal
      :open="editing"
      :pending="saving"
      :dirty="editDirty"
      :autofocus="false"
      title="编辑资料"
      description="修改显示名与联系方式；角色和用户组由管理员调整"
      @update:open="
        (open) => {
          if (!open) editing = false;
        }
      "
    >
      <form
        class="flex flex-col gap-3"
        :aria-busy="saving"
        @submit.prevent="submitProfile"
      >
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink"
            >显示名 <span class="text-critical-ink">*</span></span
          >
          <UiInput
            id="profile-display-name"
            v-model="fDisplayName"
            type="text"
            maxlength="200"
            :disabled="saving"
            :invalid="!!errors.displayName"
            size="sm"
          />
          <p v-if="errors.displayName" class="m-0 text-xs text-critical-ink">
            {{ errors.displayName }}
          </p>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">邮箱</span>
          <UiInput
            id="profile-email"
            v-model="fEmail"
            type="email"
            maxlength="200"
            placeholder="用于接收消息外发与定时报表"
            :disabled="saving"
            :invalid="!!errors.email"
            size="sm"
          />
          <p v-if="errors.email" class="m-0 text-xs text-critical-ink">
            {{ errors.email }}
          </p>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">手机</span>
          <UiInput
            id="profile-phone"
            v-model="fPhone"
            type="tel"
            maxlength="200"
            :disabled="saving"
            :invalid="!!errors.phone"
            size="sm"
          />
          <p v-if="errors.phone" class="m-0 text-xs text-critical-ink">
            {{ errors.phone }}
          </p>
        </label>
        <p
          v-if="editError"
          class="m-0 rounded-sm bg-critical-wash px-3 py-2 text-sm text-critical-ink"
          role="alert"
        >
          {{ editError }}
        </p>
        <div class="flex justify-end gap-2">
          <UiButton
            variant="ghost"
            size="sm"
            type="button"
            :disabled="saving"
            @click="editing = false"
            >取消</UiButton
          >
          <UiButton size="sm" type="submit" :disabled="saving">{{
            saving ? "保存中…" : "保存"
          }}</UiButton>
        </div>
      </form>
    </UiModal>

    <UiConfirmDialog
      :open="confirmTarget !== null"
      :title="confirmTarget?.current ? '下线当前会话？' : '下线该设备？'"
      :description="
        confirmTarget?.current
          ? '这会结束你在本设备上的登录，需要重新登录'
          : '该设备将被登出，需要重新登录才能继续使用'
      "
      confirm-label="下线"
      :pending="revoking"
      @update:open="
        (open) => {
          if (!open) confirmTarget = null;
        }
      "
      @confirm="confirmRevoke"
    />
    <UiConfirmDialog
      :open="confirmOthers"
      title="下线其他设备？"
      :description="`除本机外的 ${otherCount} 个会话将被登出，本机保持登录`"
      confirm-label="全部下线"
      :pending="revoking"
      @update:open="
        (open) => {
          if (!open) confirmOthers = false;
        }
      "
      @confirm="confirmRevokeOthers"
    />
  </PageHeader>
</template>
