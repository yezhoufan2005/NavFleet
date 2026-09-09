import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    /**
     * Pin the timezone, because otherwise the suite's result depends on where it runs.
     *
     * This was not a precaution: a single assertion on a `toLocaleString` output passed
     * on a UTC+8 laptop and failed on both CI legs, which run UTC — deterministically,
     * and with a log I could not read from here. Pinning is what makes that class of
     * failure reproducible locally instead of only in CI.
     *
     * **Asia/Shanghai rather than UTC**, deliberately. Under UTC a timezone offset is
     * zero, so the local-wall-clock arithmetic in the playback window
     * (`toLocalInput` / the end-of-minute rounding) would be exercised only in the one
     * case where getting it wrong is invisible. A non-zero offset keeps that path
     * honest, and it is also the locale this console is deployed into.
     */
    env: { TZ: "Asia/Shanghai" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,vue}"],
      exclude: [
        "src/main.ts",
        "src/env.d.ts",
        // A development-only harness, absent from the production bundle. Counting it
        // would drag the ratchet down and put pressure on someone to write tests for
        // a measuring instrument.
        "src/views/ChartPerfView.vue",
      ],
      // Calibrated from the first real measurement rather than guessed —
      // 94.07 / 88.07 / 89.23 / 94.07 — with a couple of points of headroom, the
      // same way the fleet-core thresholds were set. 12B deliberately left these
      // empty: with one button and one page, any number would have been measuring
      // the scaffold rather than the code.
      //
      // 13A-1 raised statements/lines 92 → 93 to hold the data layer's own coverage
      // (93.99 measured). Branches and functions are left where they are on purpose:
      // at 85.26 and 89.28 they have too little headroom to ratchet without making
      // an unrelated PR go red for a single uncovered `else`.
      //
      // 13A-2a raised statements/lines again (93 → 94) and functions (86 → 90):
      // measured 94.66 / 85.29 / 92.61 / 94.66 after the map stack arrived with
      // tests, and `useSvgViewport` in particular went from 1.07% to 98.16%. Branches
      // still stays at 85 for the reason above — 85.29 is the thinnest margin here.
      /*
       * 旧值是 95 / 85 / 90 / 95，其中 branches 与 functions 是刻意不动的：
       *
       * > 12B deliberately left these empty: with one button and one page, any number
       * > would have been measuring the scaffold rather than the code.
       * > 13A-1 raised statements/lines 92 → 93 to hold the data layer's own coverage.
       * > Branches and functions are left where they are on purpose: at 85.26 and 89.28
       * > they have too little headroom to ratchet without making an unrelated PR go red
       * > for a single uncovered `else`.
       * > P0-f 第 6 批 raised statements/lines 94 → 95 against 96.24 measured.
       *
       * 「余量太小就不要上抬，否则会教人去降门禁」这条判据在新尺子下同样适用。
       */
      /*
       * **重定于 vitest 5（P0-f 第 5 批）。跨这次升级，数字不可比。**
       *
       * 同一份代码，只换 vitest 3 → 5，四个 workspace 的读数全部移动，而且方向不一致 ——
       * 这是计数方式变了，不是覆盖率变了。两条证据：
       *
       * 1. **分支的分母变大。** backend `store.ts` 95.68% → 81.63%、`normalize.ts`
       *    81.57% → 73.97%，而语句几乎没动。P0-f 第 2、3 批为了类型安全加进来的大量 `?.`
       *    与 `??` 每一个都是分支，vitest 5 把它们算进去了。
       * 2. **未被 import 的文件从「100% functions」变成 0%。** 冻结前端的
       *    `useSceneOverlay.ts` / `lib/globalErrorHandlers.ts` / `router/index.ts` /
       *    `utils/amap.ts` / `AlertsView.vue` / `HistoryView.vue` 全部报 0% —— 这正是本仓
       *    记过的「v8 的虚假 100%」，只不过这次是从被修正的那一侧看见它。
       *
       * 所以旧门槛里有一部分从来不是关于这个 workspace 的真实断言。重定之后仍然是 ratchet：
       * 取当前读数下方一两个点，只上不下 —— 但「只上不下」的前提是同一把尺子，而这次换了尺子。
       */
      // 实测 92.03 / 82.77 / 90.90 / 94.29（vitest 3 下是 96.24 / 86.47 / 90.44 / 96.24）。
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 88,
        lines: 92,
      },
    },
  },
});
