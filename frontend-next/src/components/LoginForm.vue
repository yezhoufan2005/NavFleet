<script setup lang="ts">
/**
 * Sign-in.
 *
 * The accessible names here are matched verbatim by the existing Playwright suite
 * (用户名 / 密码 / 登录 / 请登录以访问车队监控台), and that is on purpose: the login
 * flow is the one part of the console whose IA did not change, so it is the first
 * place the equivalence net can prove the new frontend behaves like the old one.
 * Do not reword these without changing `e2e/support/fixtures.ts` in the same commit.
 *
 * Rendered *instead of* the shell rather than inside it — that is what makes
 * `getByRole("navigation")).toHaveCount(0)` a real assertion about the session
 * rather than about CSS.
 *
 * Differences from v1.0.0, all small and all deliberate:
 *
 * - The empty-field submit says something. The old form returned silently from its
 *   handler, so on a browser that had not enforced `required` the button appeared
 *   dead.
 * - `aria-busy` on the form, `:disabled` on both inputs and the button while a
 *   request is in flight, so a second Enter does not queue a second login.
 */
import { onMounted, ref, useTemplateRef } from "vue";
import UiButton from "@/components/ui/UiButton.vue";

const { pending = false, error = "" } = defineProps<{
  pending?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  submit: [{ username: string; password: string }];
}>();

const username = ref("");
const password = ref("");
const localError = ref("");
const usernameInput = useTemplateRef<HTMLInputElement>("usernameInput");

onMounted(() => usernameInput.value?.focus());

const handleSubmit = (): void => {
  if (!username.value || !password.value) {
    localError.value = "请输入用户名和密码";
    return;
  }
  localError.value = "";
  emit("submit", { username: username.value, password: password.value });
};
</script>

<template>
  <div class="grid min-h-dvh place-items-center bg-surface p-6">
    <form
      class="flex w-full max-w-96 flex-col gap-4 rounded-md border border-border bg-surface-raised p-6 shadow-raised"
      aria-labelledby="login-heading"
      :aria-busy="pending"
      @submit.prevent="handleSubmit"
    >
      <div class="flex flex-col gap-1">
        <span
          class="font-mono text-2xs tracking-[0.16em] text-ink-subtle uppercase"
          >NavFleet</span
        >
        <h1 id="login-heading" class="text-xl font-semibold text-ink">
          智能车队监控平台
        </h1>
        <p class="text-sm text-ink-muted">请登录以访问车队监控台</p>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-ink">用户名</span>
        <input
          ref="usernameInput"
          v-model="username"
          type="text"
          name="username"
          autocomplete="username"
          required
          placeholder="请输入用户名"
          :disabled="pending"
          :aria-invalid="error || localError ? 'true' : undefined"
          :aria-describedby="error || localError ? 'login-error' : undefined"
          class="h-10 rounded-sm border border-border-strong bg-surface px-3 text-ink placeholder:text-ink-subtle disabled:opacity-55"
        />
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-sm font-medium text-ink">密码</span>
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          required
          placeholder="请输入密码"
          :disabled="pending"
          :aria-invalid="error || localError ? 'true' : undefined"
          :aria-describedby="error || localError ? 'login-error' : undefined"
          class="h-10 rounded-sm border border-border-strong bg-surface px-3 text-ink placeholder:text-ink-subtle disabled:opacity-55"
        />
      </label>

      <p
        v-if="error || localError"
        id="login-error"
        class="rounded-sm bg-critical-wash px-3 py-2 text-sm text-critical-ink"
        role="alert"
      >
        {{ error || localError }}
      </p>

      <UiButton type="submit" :disabled="pending" class="w-full">
        {{ pending ? "登录中…" : "登录" }}
      </UiButton>
    </form>
  </div>
</template>
