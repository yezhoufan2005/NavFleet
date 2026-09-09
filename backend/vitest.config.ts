import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    // Disables HTTP keep-alive; see the file for the flake it fixes.
    setupFiles: ["test/setup.ts"],
    // The HTTP integration tests log a line per request (and a stack for the
    // deliberate 500), which would drown the reporter output.
    env: { LOG_LEVEL: "silent" },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts"],
      // A ratchet, not a target: set a few points under what the suite covers
      // today, so a regression fails CI while a small refactor does not. Raise
      // them when coverage climbs; never lower them to make a red build pass.
      //
      // First calibration was against 82.1 / 81.4 / 84.8. Raised in P0-f 第 6 批
      // against **89.82 / 85.02 / 90.58 / 89.82**, after `persistence.ts` went from
      // 47.4% to 84.1%: every test there used to run the `if (!this.db)` in-memory
      // fallback, so the half of that file which runs in production had no test at
      // all. Raising the gate is the half of that work that keeps it — otherwise
      // the next change is free to give it back.
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
      // 实测 87.23 / 75.60 / 86.17 / 87.52（vitest 3 下是 89.82 / 85.02 / 90.58 / 89.82）。
      thresholds: {
        statements: 85,
        branches: 73,
        functions: 84,
        lines: 85,
      },
    },
  },
});
