<script setup lang="ts">
/**
 * Phase 12B scaffold. This is not the shell from the IA — that arrives in 12C.
 * What it is: the smallest thing that proves the token mechanism works, because
 * 11D flagged `@theme` overriding as the highest-risk assumption in the whole
 * frontend plan. If it does not hold, this is the cheapest possible moment to
 * find out.
 */
import { computed } from "vue";
import { useTheme, type ThemePreference } from "@/composables/useTheme";
import UiButton from "@/components/ui/UiButton.vue";

const { preference, resolved, cycleTheme } = useTheme();

const PREFERENCE_LABELS: Record<ThemePreference, string> = {
  dark: "深色",
  light: "浅色",
  system: "跟随系统",
};

const label = computed(() => PREFERENCE_LABELS[preference.value]);

/*
 * Class names are written out in full rather than built from the token name.
 * Tailwind scans source text for literal class strings — a template that
 * interpolates `bg-${token}` produces no CSS at all, and the failure is silent:
 * the element simply has no background. Which would have made this whole slice
 * report a false negative about the token mechanism.
 */
const SEMANTIC_SURFACES = [
  { label: "surface", surfaceClass: "bg-surface", testId: "surface-surface" },
  {
    label: "surface-raised",
    surfaceClass: "bg-surface-raised",
    testId: "surface-raised",
  },
  {
    label: "surface-sunken",
    surfaceClass: "bg-surface-sunken",
    testId: "surface-sunken",
  },
] as const;

const STATUS_TONES = [
  {
    label: "brand",
    chipClass: "bg-brand-wash text-brand-ink",
    testId: "chip-brand",
  },
  {
    label: "notice",
    chipClass: "bg-notice-wash text-notice-ink",
    testId: "chip-notice",
  },
  {
    label: "warning",
    chipClass: "bg-warning-wash text-warning-ink",
    testId: "chip-warning",
  },
  {
    label: "critical",
    chipClass: "bg-critical-wash text-critical-ink",
    testId: "chip-critical",
  },
  {
    label: "offline",
    chipClass: "bg-offline-wash text-offline-ink",
    testId: "chip-offline",
  },
] as const;
</script>

<template>
  <main class="mx-auto flex max-w-3xl flex-col gap-8 p-6">
    <header class="flex flex-col gap-3">
      <p class="font-mono text-xs tracking-[0.16em] text-ink-subtle uppercase">
        NavFleet Console · Phase 12B
      </p>
      <h1 class="text-3xl font-semibold text-ink">Token 切片</h1>
      <p class="max-w-prose text-ink-muted">
        这一页只为验证一件事：语义 token 进
        <code class="rounded-xs bg-surface-sunken px-1 font-mono text-sm"
          >@theme</code
        >
        且不加
        <code class="rounded-xs bg-surface-sunken px-1 font-mono text-sm"
          >inline</code
        >
        时，按主题重定义能让所有工具类同时切换。下面每一处颜色都来自
        token，<strong
          >没有一个
          <code class="rounded-xs bg-surface-sunken px-1 font-mono text-sm"
            >dark:</code
          >
          前缀</strong
        >。
      </p>
    </header>

    <section class="flex flex-wrap items-center gap-3">
      <UiButton data-testid="theme-toggle" @click="cycleTheme"
        >切换主题（{{ label }}）</UiButton
      >
      <span class="font-mono text-sm text-ink-muted">
        preference=<b data-testid="preference">{{ preference }}</b> ·
        resolved=<b data-testid="resolved">{{ resolved }}</b>
      </span>
    </section>

    <section class="flex flex-wrap gap-3">
      <UiButton variant="primary">主操作</UiButton>
      <UiButton variant="secondary">次操作</UiButton>
      <UiButton variant="ghost">幽灵</UiButton>
      <UiButton variant="danger">危险</UiButton>
      <UiButton variant="primary" size="sm">小号</UiButton>
      <UiButton variant="primary" disabled>禁用</UiButton>
    </section>

    <section class="grid gap-3 md:grid-cols-3">
      <div
        v-for="surface in SEMANTIC_SURFACES"
        :key="surface.label"
        class="rounded-md border border-border p-4 shadow-raised"
        :class="surface.surfaceClass"
        :data-testid="surface.testId"
      >
        <p class="font-mono text-sm text-ink">{{ surface.label }}</p>
        <p class="text-sm text-ink-subtle">ink-subtle 在此表面上</p>
      </div>
    </section>

    <section class="flex flex-wrap gap-2">
      <span
        v-for="tone in STATUS_TONES"
        :key="tone.label"
        class="rounded-full px-3 py-1 font-mono text-xs"
        :class="tone.chipClass"
        :data-testid="tone.testId"
      >
        {{ tone.label }}
      </span>
    </section>
  </main>
</template>
