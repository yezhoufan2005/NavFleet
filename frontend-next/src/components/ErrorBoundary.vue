<script setup lang="ts">
/**
 * Catches a render error from the view below and replaces *only* that view.
 *
 * Ported from the v1.0.0 frontend. The shape is unchanged because it was right:
 * `onErrorCaptured` returning `false` stops propagation, so one broken page cannot
 * blank the whole console, and the navigation stays usable so the operator can go
 * somewhere that works.
 *
 * `resetKey` is the route path. Vue keeps the fallback until something clears it,
 * and a person whose instinct is "go somewhere else and come back" would otherwise
 * find the error still sitting there on a page that is fine now.
 *
 * The `console.error` is deliberate and stays: the raw error and the component
 * stack are the only way to diagnose this after the fact, and the Playwright suite
 * treats a `console.error` as a failure — which is exactly the right outcome for a
 * view that threw during a test.
 */
import { ref, watch, onErrorCaptured } from "vue";
import UiButton from "@/components/ui/UiButton.vue";

const { resetKey = "" } = defineProps<{ resetKey?: string }>();

interface Failure {
  summary: string;
  info: string;
}

const failure = ref<Failure | null>(null);

onErrorCaptured((error: unknown, _instance, info: string) => {
  console.error("[ErrorBoundary] 视图渲染失败", error, info);
  failure.value = {
    summary:
      error instanceof Error ? error.message || error.name : String(error),
    info,
  };
  return false;
});

/** Clearing the failure remounts a fresh child; the broken tree is long gone. */
const retry = (): void => {
  failure.value = null;
};

watch(() => resetKey, retry);
</script>

<template>
  <section
    v-if="failure"
    class="mx-auto flex max-w-prose flex-col items-start gap-3 rounded-md border border-border bg-surface-raised p-5 shadow-raised"
    role="alert"
  >
    <span
      class="grid size-8 place-items-center rounded-full bg-critical-wash font-semibold text-critical-ink"
      aria-hidden="true"
      >!</span
    >
    <h2 class="text-lg font-semibold text-ink">页面渲染失败</h2>
    <p class="text-ink-muted">
      当前页面在渲染时出现异常，其他页面仍可正常使用。可先点击「重试」重新加载，若反复失败请联系值班工程师。
    </p>
    <p class="font-mono text-xs break-all text-ink-subtle">
      {{ failure.summary
      }}<span v-if="failure.info"> · {{ failure.info }}</span>
    </p>
    <UiButton variant="secondary" size="sm" @click="retry">重试</UiButton>
  </section>
  <slot v-else />
</template>
