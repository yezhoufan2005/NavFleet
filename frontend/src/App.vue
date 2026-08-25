<script setup>
import { computed, onMounted, ref } from "vue";
import { RouterView, RouterLink } from "vue-router";
import { storeToRefs } from "pinia";
import LoginForm from "./components/LoginForm.vue";
import NotificationHost from "./components/NotificationHost.vue";
import { useFleetStore } from "./stores/fleet";
import { useAuth } from "./composables/useAuth";
import { useTheme } from "./composables/useTheme";

const store = useFleetStore();
const state = store.state;
const { summary } = storeToRefs(store);
const { bootstrap, registerWindowApi, retryBootstrap, disconnectRealtime } = store;

const auth = useAuth();
const authState = auth.state;
const { state: themeState, cycleTheme } = useTheme();

const themeIconMap = { dark: "🌙", light: "☀", system: "🖥" };
const themeLabelMap = { dark: "深色", light: "浅色", system: "跟随系统" };
const roleLabelMap = { admin: "管理员", operator: "操作员", viewer: "只读" };

let dashboardStarted = false;

const realtimeOnline = computed(() => state.realtime.wsReady);
const backendUnavailable = computed(() => !state.realtime.apiReady);
const isRetrying = ref(false);

async function handleRetry() {
  if (isRetrying.value) {
    return;
  }
  isRetrying.value = true;
  try {
    await retryBootstrap();
  } finally {
    isRetrying.value = false;
  }
}

async function startDashboard() {
  if (dashboardStarted) {
    return;
  }
  dashboardStarted = true;
  registerWindowApi();
  await bootstrap();
}

async function handleLogin(credentials) {
  const ok = await auth.login(credentials.username, credentials.password);
  if (ok) {
    await startDashboard();
  }
}

async function handleLogout() {
  disconnectRealtime();
  dashboardStarted = false;
  await auth.logout();
}

onMounted(async () => {
  const authenticated = await auth.fetchMe();
  if (authenticated) {
    await startDashboard();
  }
});
</script>

<template>
  <div v-if="authState.status === 'unknown'" class="app-loading">
    <span>正在加载…</span>
  </div>

  <LoginForm
    v-else-if="authState.status === 'anonymous'"
    :pending="authState.pending"
    :error="authState.error"
    @submit="handleLogin"
  />

  <div v-else class="app-shell">
    <header class="panel page-header">
      <div class="page-header-top">
        <div class="brand-block">
          <span class="brand-kicker">NavFleet</span>
          <h1>智能车队监控平台</h1>
          <span class="brand-meta">{{ state.fleetName || "默认车队" }}</span>
        </div>

        <nav class="app-nav">
          <RouterLink to="/" class="nav-link">实时监控</RouterLink>
          <RouterLink to="/history" class="nav-link">历史回放</RouterLink>
          <RouterLink to="/alerts" class="nav-link">
            <span>告警中心</span>
            <span v-if="summary.alertTotal" class="nav-badge">{{ summary.alertTotal }}</span>
          </RouterLink>
        </nav>

        <div class="header-actions">
          <button
            type="button"
            class="theme-toggle"
            :aria-label="`切换主题，当前：${themeLabelMap[themeState.preference]}`"
            :title="`主题：${themeLabelMap[themeState.preference]}（点击切换）`"
            @click="cycleTheme"
          >
            <span class="theme-toggle-icon">{{ themeIconMap[themeState.preference] }}</span>
          </button>

          <div v-if="authState.user" class="session-chip">
            <span
              class="realtime-dot"
              :data-online="realtimeOnline"
              :title="realtimeOnline ? '实时连接正常' : '实时连接中断，正在重连'"
            ></span>
            <div class="session-meta">
              <span class="session-user">{{ authState.user.username }}</span>
              <span class="session-role">{{ roleLabelMap[authState.user.role] }}</span>
            </div>
            <button type="button" class="session-logout" title="退出登录" @click="handleLogout">
              退出
            </button>
          </div>
        </div>
      </div>
    </header>

    <div v-if="backendUnavailable" class="offline-banner">
      <span>后端服务当前不可用，展示的数据可能不是最新。</span>
      <button type="button" :disabled="isRetrying" @click="handleRetry">
        {{ isRetrying ? "重试中…" : "重试连接" }}
      </button>
    </div>

    <RouterView />
  </div>

  <NotificationHost />
</template>
