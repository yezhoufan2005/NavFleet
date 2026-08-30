<script setup lang="ts">
/**
 * Root component. Its whole job is deciding which of three things to render.
 *
 * | session state   | renders                                            |
 * | --------------- | -------------------------------------------------- |
 * | `unknown`       | a loading line while `/api/auth/me` is in flight    |
 * | `anonymous`     | the login form, *instead of* the shell              |
 * | `authenticated` | the shell, or the bare view for `/wall`             |
 *
 * "Instead of", not "with the shell hidden": that is the primary access gate, and
 * it is why `getByRole("navigation")).toHaveCount(0)` on the login screen is a real
 * assertion about the session rather than a statement about CSS. The route guard in
 * `router/guards.ts` is the second, independent gate.
 *
 * `NotificationHost` sits outside the three-way switch on purpose. A failed login
 * and a backend that cannot be reached both need to say so, and both happen while
 * the shell does not exist.
 */
import { computed, onMounted, watchEffect } from "vue";
import { RouterView, useRoute } from "vue-router";
import AppShell from "@/components/shell/AppShell.vue";
import LoginForm from "@/components/LoginForm.vue";
import NotificationHost from "@/components/NotificationHost.vue";
import { useAuth } from "@/composables/useAuth";

const PRODUCT_NAME = "智能车队监控平台";

const route = useRoute();
const auth = useAuth();
const authState = auth.state;

/** `/wall` renders without the shell — see `WallView.vue` for why. */
const bare = computed(() => route.meta.bare === true);

onMounted(() => {
  void auth.fetchMe();
});

const handleLogin = async (credentials: {
  username: string;
  password: string;
}): Promise<void> => {
  await auth.login(credentials.username, credentials.password);
};

/**
 * The document title, in one place. v1.0.0 declared `meta.title` on every route
 * and then never read it, so every page in the browser's history reads the same.
 * Doing it here rather than in a router hook keeps the login screen honest: while
 * nobody is signed in, the tab should not claim to be showing 总览.
 */
watchEffect(() => {
  const section = route.meta.title;
  document.title =
    authState.status === "authenticated" && typeof section === "string"
      ? `${section} · ${PRODUCT_NAME}`
      : PRODUCT_NAME;
});
</script>

<template>
  <div
    v-if="authState.status === 'unknown'"
    class="grid min-h-dvh place-items-center bg-surface text-ink-muted"
  >
    <span role="status">正在加载…</span>
  </div>

  <LoginForm
    v-else-if="authState.status === 'anonymous'"
    :pending="authState.pending"
    :error="authState.error"
    @submit="handleLogin"
  />

  <RouterView v-else-if="bare" />

  <AppShell v-else :user="authState.user" @logout="auth.logout" />

  <NotificationHost />
</template>
