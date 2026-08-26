<script setup>
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";

const route = useRoute();

// Hash history: show the address as the operator typed it, e.g. "#/histroy".
const attemptedPath = computed(() => `#${route.fullPath}`);
</script>

<template>
  <section class="panel fallback-view" data-tone="missing">
    <span class="fallback-badge" aria-hidden="true">?</span>
    <h2>页面不存在</h2>
    <p class="fallback-hint">没有找到该地址对应的页面，可能是链接输入有误，或该页面已经下线。</p>
    <p class="fallback-detail">{{ attemptedPath }}</p>
    <div class="fallback-actions">
      <RouterLink to="/" class="primary-btn fallback-link">返回实时监控</RouterLink>
    </div>
  </section>
</template>
