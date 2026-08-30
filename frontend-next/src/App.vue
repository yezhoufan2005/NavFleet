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
 *
 * The fleet data layer starts here rather than inside a view, because the top bar
 * reports the realtime link on *every* page — including `/wall`, which renders
 * without the shell. Tying the socket to one page's lifecycle would mean the
 * indicator lies wherever that page is not mounted.
 */
import { computed, onMounted, watch, watchEffect } from "vue";
import { RouterView, useRoute } from "vue-router";
import AppShell from "@/components/shell/AppShell.vue";
import LoginForm from "@/components/LoginForm.vue";
import NotificationHost from "@/components/NotificationHost.vue";
import { useAuth } from "@/composables/useAuth";
import { useFleetStore } from "@/stores/fleet";
import { useAlertSound } from "@/composables/useAlertSound";

const PRODUCT_NAME = "智能车队监控平台";

const route = useRoute();
const auth = useAuth();
const authState = auth.state;
const fleet = useFleetStore();
const sound = useAlertSound();

/** `/wall` renders without the shell — see `WallView.vue` for why. */
const bare = computed(() => route.meta.bare === true);

onMounted(() => {
  void auth.fetchMe();
});

/**
 * Follow the session: connect when it becomes known, and drop the socket on the way
 * out. Signing out without disconnecting would leave an authenticated socket open
 * behind the login screen, which is both a live subscription nobody is watching and
 * a claim about access that the session no longer supports.
 */
watch(
  () => authState.status,
  (status, previous) => {
    if (status === "authenticated" && previous !== "authenticated") {
      void fleet.bootstrap();
    }
    if (status === "anonymous") fleet.disconnectRealtime();
  },
);

const handleLogin = async (credentials: {
  username: string;
  password: string;
}): Promise<void> => {
  await auth.login(credentials.username, credentials.password);
};

/**
 * Audible criticals, watched here rather than on the alert page — an operator looking
 * at the map still needs to hear one, and `/wall` renders without the shell at all.
 *
 * Only the ids are watched, so a telemetry tick that changes nothing about *which*
 * conditions are critical does no work. Whether it actually sounds is entirely
 * `useAlertSound`'s decision: first observation seeds, bursts collapse, and muted /
 * quiet / not-yet-unlocked all stay silent while still consuming the ids.
 */
watch(
  () => fleet.groupedAlerts.critical.map((alert) => alert.id).join(","),
  (joined) => {
    sound.announce(joined ? joined.split(",") : []);
  },
);

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
