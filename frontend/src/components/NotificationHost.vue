<script setup>
import { useNotifications } from "../composables/useNotifications";

const { items, dismiss } = useNotifications();

const iconMap = {
  info: "ℹ",
  success: "✓",
  warning: "!",
  error: "✕",
};
</script>

<template>
  <div class="notification-host" aria-live="polite">
    <transition-group name="toast">
      <div v-for="item in items" :key="item.id" class="toast" :data-type="item.type" role="status">
        <span class="toast-icon">{{ iconMap[item.type] }}</span>
        <span class="toast-message">{{ item.message }}</span>
        <button type="button" class="toast-close" aria-label="关闭" @click="dismiss(item.id)">
          ×
        </button>
      </div>
    </transition-group>
  </div>
</template>
