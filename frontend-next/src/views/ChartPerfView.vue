<script setup lang="ts">
/**
 * Performance harness for the chart base — **not a product page**.
 *
 * It exists because ROADMAP 12D asks for a measured baseline rather than a feeling:
 * the decision "keep ECharts or move to uPlot" should rest on numbers taken from the
 * real component, in a real browser, on the canvas renderer. `console-charts.spec.ts`
 * drives this page and prints the table.
 *
 * It is not shipped. The route is registered only when `import.meta.env.DEV` is true
 * or `VITE_CHART_PERF` is set, so the production bundle contains neither this view
 * nor — until Phase 13C uses it for real — ECharts itself. Setting the flag at build
 * time is also how the bundle cost gets measured reproducibly.
 *
 * Assertions live in the spec, and they are on deterministic quantities (series
 * count, point count, canvas present). The wall-clock numbers are printed, never
 * asserted — the Phase 10 virtualisation baseline was built the same way, because a
 * timing assertion on shared CI hardware fails for reasons that have nothing to do
 * with the code.
 */
import { ref } from "vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import type { TimeSeries } from "@/components/charts/timeSeriesOption";
import UiButton from "@/components/ui/UiButton.vue";

/** Deterministic pseudo-random walk: the same inputs always give the same series. */
const walk = (seed: number, count: number): [number, number][] => {
  const start = Date.UTC(2026, 7, 30, 8, 0, 0);
  let state = seed * 9301 + 49297;
  let value = 50;
  return Array.from({ length: count }, (_unused, index) => {
    state = (state * 9301 + 49297) % 233280;
    value = Math.max(0, Math.min(100, value + (state / 233280 - 0.5) * 6));
    return [start + index * 1000, Number(value.toFixed(3))];
  });
};

const series = ref<TimeSeries[]>([]);
const lastRenderMs = ref<number | null>(null);
const pointTotal = ref(0);

const load = (seriesCount: number, pointsPer: number): void => {
  lastRenderMs.value = null;
  series.value = Array.from({ length: seriesCount }, (_unused, index) => ({
    name: `设备 ${index + 1}`,
    points: walk(index + 1, pointsPer),
  }));
  pointTotal.value = seriesCount * pointsPer;
};

const onRendered = (durationMs: number): void => {
  lastRenderMs.value = Math.round(durationMs * 100) / 100;
};

/**
 * Exposed on `window` so the spec can drive the harness without typing into inputs —
 * fewer moving parts between the measurement and the thing measured.
 */
declare global {
  interface Window {
    __chartPerf?: {
      load: (seriesCount: number, pointsPer: number) => void;
    };
  }
}
window.__chartPerf = { load };
</script>

<template>
  <main class="flex min-h-dvh flex-col gap-4 bg-surface p-6">
    <h1 class="text-xl font-semibold text-ink">图表性能基线（非产品页面）</h1>
    <p class="max-w-prose text-sm text-ink-muted">
      这一页只在 dev 或
      <code class="font-mono">VITE_CHART_PERF</code>
      构建里注册，用于给「继续用 ECharts 还是换 uPlot」提供实测依据。
    </p>

    <div class="flex flex-wrap gap-2">
      <UiButton
        v-for="preset in [
          { s: 1, p: 500 },
          { s: 6, p: 500 },
          { s: 6, p: 2000 },
          { s: 8, p: 5000 },
        ]"
        :key="`${preset.s}x${preset.p}`"
        variant="secondary"
        size="sm"
        @click="load(preset.s, preset.p)"
      >
        {{ preset.s }} × {{ preset.p }}
      </UiButton>
    </div>

    <p class="font-mono text-sm text-ink">
      series=<b data-testid="perf-series">{{ series.length }}</b> · points=<b
        data-testid="perf-points"
        >{{ pointTotal }}</b
      >
      · render=<b data-testid="perf-render">{{ lastRenderMs ?? "—" }}</b> ms
    </p>

    <div class="rounded-md border border-border bg-surface-raised p-4">
      <TimeSeriesChart
        v-if="series.length > 0"
        :series="series"
        :height="360"
        label="性能基线样本"
        unit="%"
        @rendered="onRendered"
      />
      <p v-else class="text-sm text-ink-muted">选一个预设开始。</p>
    </div>
  </main>
</template>
