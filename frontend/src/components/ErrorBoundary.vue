<script setup>
import { onErrorCaptured, ref, watch } from "vue";

const props = defineProps({
  /**
   * Anything that identifies what is currently rendered inside the boundary —
   * in practice the active route path. When it changes the boundary clears
   * itself, so navigating away from a broken view (the app nav stays visible
   * because only the routed region is replaced) does not keep the fallback on
   * screen.
   */
  resetKey: { type: String, default: "" },
});

// `null` while the child tree renders normally; a { summary, info } pair once a
// child render/lifecycle/watcher threw.
const failure = ref(null);

onErrorCaptured((error, _instance, info) => {
  // Keep the raw error (and its stack) in the console: the panel below only
  // shows a one-line summary, which is not enough to debug from.
  console.error("[ErrorBoundary] 视图渲染失败", error, info);
  failure.value = {
    summary: error instanceof Error ? error.message || error.name : String(error),
    info,
  };
  // Handled here — stop it from propagating to the app-level handler.
  return false;
});

function retry() {
  // The child tree was unmounted while the fallback was showing, so simply
  // clearing the failure mounts a fresh instance of the routed view.
  failure.value = null;
}

watch(() => props.resetKey, retry);
</script>

<template>
  <section v-if="failure" class="panel fallback-view" data-tone="error" role="alert">
    <span class="fallback-badge" aria-hidden="true">!</span>
    <h2>页面渲染失败</h2>
    <p class="fallback-hint">
      当前页面在渲染时出现异常，其他页面仍可正常使用。可先点击「重试」重新加载，若反复失败请联系值班工程师。
    </p>
    <p class="fallback-detail">
      {{ failure.summary }}<span v-if="failure.info"> · {{ failure.info }}</span>
    </p>
    <div class="fallback-actions">
      <button type="button" class="primary-btn" @click="retry">重试</button>
    </div>
  </section>

  <slot v-else />
</template>
