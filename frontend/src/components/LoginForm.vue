<script setup>
import { onMounted, ref } from "vue";

defineProps({
  pending: { type: Boolean, default: false },
  error: { type: String, default: "" },
});

const emit = defineEmits(["submit"]);

const username = ref("");
const password = ref("");
const usernameInput = ref(null);

// Land the caret on the first field. The login screen has exactly one task, so
// making a keyboard or screen-reader user tab into it first is pure friction.
onMounted(() => {
  usernameInput.value?.focus();
});

function handleSubmit() {
  if (!username.value || !password.value) {
    return;
  }
  emit("submit", { username: username.value, password: password.value });
}
</script>

<template>
  <div class="login-shell">
    <!--
      `aria-labelledby` gives the form its accessible name, and `aria-busy` tells
      assistive tech the submit is in flight rather than leaving it silent while
      the button reads "登录中…".
    -->
    <form
      class="login-card panel"
      aria-labelledby="login-heading"
      :aria-busy="pending"
      @submit.prevent="handleSubmit"
    >
      <div class="login-brand">
        <span class="brand-kicker">NavFleet</span>
        <h1 id="login-heading">智能车队监控平台</h1>
        <p>请登录以访问车队监控台</p>
      </div>

      <label class="login-field" for="login-username">
        <span>用户名</span>
        <input
          id="login-username"
          ref="usernameInput"
          v-model="username"
          type="text"
          name="username"
          autocomplete="username"
          required
          :aria-invalid="error ? 'true' : undefined"
          :aria-describedby="error ? 'login-error' : undefined"
          placeholder="请输入用户名"
          :disabled="pending"
        />
      </label>

      <label class="login-field" for="login-password">
        <span>密码</span>
        <input
          id="login-password"
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          required
          :aria-invalid="error ? 'true' : undefined"
          :aria-describedby="error ? 'login-error' : undefined"
          placeholder="请输入密码"
          :disabled="pending"
        />
      </label>

      <!--
        `role="alert"` so a rejected login is announced. Without it the only
        feedback is a colour change a screen reader never mentions.
      -->
      <p v-if="error" id="login-error" class="login-error" role="alert">{{ error }}</p>

      <button type="submit" class="login-submit" :disabled="pending">
        {{ pending ? "登录中…" : "登录" }}
      </button>
    </form>
  </div>
</template>
