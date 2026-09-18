<script setup lang="ts">
/**
 * 个人中心 — the one authenticated-but-not-admin page (viewer+, no `roles`).
 *
 * Two things a person manages about their own account: their password, and where they are
 * signed in. Both are new in Phase 15E-2. Changing the password invalidates every other
 * session server-side and re-issues fresh cookies for THIS device, so the form stays signed
 * in; the session list lets someone end a device they no longer trust — including this one,
 * which is just "log out" wearing a different name, so revoking the current session logs out.
 */
import { onMounted, ref } from "vue";
import type { SessionRecordView } from "@navfleet/fleet-core";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { useAuth } from "@/composables/useAuth";
import { notify } from "@/composables/useNotifications";

const auth = useAuth();

const INPUT_CLASS =
  "h-10 rounded-sm border border-border-strong bg-surface px-3 text-ink placeholder:text-ink-subtle disabled:opacity-55";

// ── Change password ──────────────────────────────────────────────────────────
const oldPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const formError = ref("");
const changing = ref(false);

const submitPassword = async (): Promise<void> => {
  formError.value = "";
  if (!oldPassword.value || !newPassword.value) {
    formError.value = "请填写当前密码与新密码";
    return;
  }
  // Mirror the backend policy (validation.ts passwordSchema) so the common case fails fast
  // here rather than round-tripping to a 400.
  if (
    newPassword.value.length < 8 ||
    !/[A-Za-z]/.test(newPassword.value) ||
    !/\d/.test(newPassword.value)
  ) {
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
const confirmTarget = ref<SessionRecordView | null>(null);
const revoking = ref(false);

const loadSessions = async (): Promise<void> => {
  status.value = "loading";
  try {
    sessions.value = await auth.getMySessions();
    status.value = "ready";
  } catch {
    status.value = "error";
  }
};

onMounted(() => void loadSessions());

const confirmRevoke = async (): Promise<void> => {
  const target = confirmTarget.value;
  if (!target) return;
  revoking.value = true;
  try {
    const ok = await auth.revokeMySession(target.sessionId);
    if (!ok) {
      notify("下线失败，请稍后重试", { type: "error" });
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
  } finally {
    revoking.value = false;
    confirmTarget.value = null;
  }
};

const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString("zh-CN", { hour12: false });
</script>

<template>
  <PageHeader title="个人中心" scroll-content>
    <section
      class="rounded-md border border-border bg-surface-raised p-4"
      aria-labelledby="profile-password-heading"
    >
      <h3
        id="profile-password-heading"
        class="mb-3 text-md font-semibold text-ink"
      >
        修改密码
      </h3>
      <form
        class="flex max-w-96 flex-col gap-4"
        :aria-busy="changing"
        @submit.prevent="submitPassword"
      >
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-ink">当前密码</span>
          <input
            v-model="oldPassword"
            type="password"
            autocomplete="current-password"
            :disabled="changing"
            :aria-invalid="formError ? 'true' : undefined"
            :class="INPUT_CLASS"
          />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-ink">新密码</span>
          <input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            placeholder="至少 8 位，含字母与数字"
            :disabled="changing"
            :aria-invalid="formError ? 'true' : undefined"
            :class="INPUT_CLASS"
          />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-ink">确认新密码</span>
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            :disabled="changing"
            :aria-invalid="formError ? 'true' : undefined"
            :class="INPUT_CLASS"
          />
        </label>
        <p
          v-if="formError"
          class="rounded-sm bg-critical-wash px-3 py-2 text-sm text-critical-ink"
          role="alert"
        >
          {{ formError }}
        </p>
        <UiButton type="submit" :disabled="changing" class="self-start">
          {{ changing ? "提交中…" : "修改密码" }}
        </UiButton>
      </form>
    </section>
    <!-- SESSIONS_PLACEHOLDER -->
    <section
      class="rounded-md border border-border bg-surface-raised p-4"
      aria-labelledby="profile-sessions-heading"
      :aria-busy="status === 'loading'"
    >
      <h3
        id="profile-sessions-heading"
        class="mb-3 text-md font-semibold text-ink"
      >
        我的会话
      </h3>
      <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
      <p
        v-else-if="status === 'error'"
        class="text-sm text-critical-ink"
        role="alert"
      >
        无法加载会话列表
      </p>
      <p
        v-else-if="sessions.length === 0"
        class="text-sm text-ink-muted"
        role="status"
      >
        暂无活跃会话
      </p>
      <div
        v-else
        class="overflow-auto rounded-sm border border-border"
        tabindex="0"
        role="region"
        aria-label="我的会话列表"
      >
        <table class="w-full border-collapse text-left text-sm">
          <caption class="sr-only">
            当前账号的活跃登录会话
          </caption>
          <thead class="bg-surface-sunken text-2xs text-ink-muted uppercase">
            <tr>
              <th scope="col" class="px-3 py-2">设备</th>
              <th scope="col" class="px-3 py-2">IP</th>
              <th scope="col" class="px-3 py-2">登录时间</th>
              <th scope="col" class="px-3 py-2">最近活跃</th>
              <th scope="col" class="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in sessions"
              :key="s.sessionId"
              class="border-t border-border"
            >
              <td class="px-3 py-2 text-ink">
                <span class="block max-w-64 truncate">{{
                  s.userAgent || "未知设备"
                }}</span>
                <span
                  v-if="s.current"
                  class="mt-0.5 inline-block rounded-sm bg-brand-wash px-1.5 py-0.5 font-mono text-2xs text-brand-ink"
                  >当前会话</span
                >
              </td>
              <td class="px-3 py-2 text-ink-muted">{{ s.ip || "—" }}</td>
              <td class="px-3 py-2 text-ink-muted">
                {{ formatTime(s.createdAt) }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
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
    </section>

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
  </PageHeader>
</template>
