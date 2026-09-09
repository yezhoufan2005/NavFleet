import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,js}", "test/**/*.{test,spec}.{ts,js}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,js,vue}"],
      exclude: ["src/main.ts", "src/**/*.d.ts"],
      // A ratchet, not a target: set a few points under what the suite covers
      // today (62.5% stmts / 86.8% branches / 84.1% funcs), so a regression
      // fails CI while a small refactor does not.
      //
      // `functions` was 87 and is now 81, which needs explaining, because the
      // rule here is never to lower a threshold to make a red build pass. It was
      // lowered because the *measurement* changed, not the code: v8 reports a
      // file no test ever imports as 100% functions (nothing was instrumented,
      // so nothing is missing), and `DashboardView.vue` used to be one of those.
      // Mounting and operating it in jsdom replaced that vacuous 100% with a
      // real 75%, which pulled the global figure down at the same time as
      // statement coverage doubled (31% -> 62.5%). `AlertsView`/`HistoryView`
      // still report the vacuous 100%, so expect functions to dip again — and
      // statements to jump again — when they get the same treatment.
      //
      // Statement coverage stays well under 100 because the map and point-cloud
      // rendering are exercised end-to-end (e2e/) rather than in jsdom. Raise
      // these when coverage climbs.
      /*
       * 这一段的历史保留在这里，因为它记的是「什么时候降门槛是对的」这个判据本身：
       *
       * > 58 → 57 because tone derivation moved OUT of this workspace into
       * > `@navfleet/fleet-core` (13A-0). Those lines were well covered here, so removing
       * > them lowered the ratio even though total coverage went up: the logic is now at
       * > 100% in fleet-core, whose own gate rose to absorb it. This is the Phase 10
       * > "vacuous 100%" lesson running in the other direction, and it is the one case
       * > where lowering a ratchet is correct — the number fell because covered code left,
       * > not because coverage got worse. Any other reason to lower it should be refused.
       *
       * 旧值是 57 / 84 / 81 / 57。**这次降低属于同一个判据的第二种情形**：数字掉了不是因为
       * 覆盖变差，而是因为量它的工具换了 —— 而且换成了更诚实的那把（见下）。
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
      // 实测 42.70 / 32.94 / 42.13 / 42.67（vitest 3 下是 60.75 / 85.65 / 84.68 / 60.75）。
      // **这个 workspace 的降幅最大，而它恰好是证据最清楚的那个**：`functions` 从 84.68 掉到
      // 42.13，因为它有六个文件根本没有任何测试 import，vitest 3 把它们报成 100% functions。
      // 也就是说旧的 `functions: 81` 从来不是关于这份代码的断言。冻结前端不再开发，这个门禁
      // 的作用只是「不要更差」，所以按新尺子重设即可。
      thresholds: {
        statements: 40,
        branches: 30,
        functions: 40,
        lines: 40,
      },
    },
  },
});
