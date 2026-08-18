<script setup>
import { ref } from "vue";

defineProps({
  pending: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["submit"]);

const username = ref("");
const password = ref("");

function handleSubmit() {
  if (!username.value || !password.value) {
    return;
  }
  emit("submit", { username: username.value, password: password.value });
}
</script>

<template>
  <div class="login-shell">
    <form class="login-card panel" @submit.prevent="handleSubmit">
      <div class="login-brand">
        <span class="brand-kicker">NavFleet</span>
        <h1>多车监控平台</h1>
        <p>请登录以访问车队监控台</p>
      </div>

      <label class="login-field">
        <span>用户名</span>
        <input
          v-model="username"
          type="text"
          autocomplete="username"
          placeholder="请输入用户名"
          :disabled="pending"
        />
      </label>

      <label class="login-field">
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="请输入密码"
          :disabled="pending"
        />
      </label>

      <p v-if="error" class="login-error">{{ error }}</p>

      <button type="submit" class="login-submit" :disabled="pending">
        {{ pending ? "登录中…" : "登录" }}
      </button>
    </form>
  </div>
</template>
