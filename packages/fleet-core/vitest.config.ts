import { defineConfig } from "vitest/config";

/**
 * Node environment, not jsdom: everything in this package is framework-free and
 * DOM-free by definition — that is the property that lets both frontends share
 * it. A test that needs a document belongs in the frontend that owns the
 * component, not here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      /*
       * 这一段的历史保留在这里，因为它记的是几次「为什么上抬」，而那些理由仍然成立：
       *
       * > Calibrated from the first real measurement (86.86 / 80.73 / 88.37 / 86.86), a
       * > point or two below it. The ratchet only ever goes up.
       * > Raised in 13A-0 (85/79 → 86/81) to absorb what moved in from the frontend:
       * > `deviceTone.ts` arrived at 100%. Raising here is the other half of lowering the
       * > frontend's gate by the same move — without it, relocating covered code would be
       * > a way to quietly shed coverage.
       * > Raised again in 13A-2a: the point-cloud pipeline moved in from the frontend
       * > (where it had no tests at all) and arrived at 100% statements / 90% branches.
       * > Raised again in P0-f 第 6 批 (89/83/89 → 91/85/91) against 93.43 / 87.03 /
       * > 93.44: four cases added while proving a fix covered the vendor-supplied `alerts`
       * > branch, which had had no test at all.
       *
       * 给下一个上抬的人的提醒仍然有效：`dataDefaults.ts` 停在 0% 是诚实而不是偷懒 —— 它是
       * 两个没有任何测试 import 的惰性字面量，排除它会为一个真的没有覆盖的文件抬高全局数字。
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
      // 实测 96.96 / 82.84 / 91.02 / 96.80（vitest 3 下是 93.42 / 87.03 / 93.44 / 93.42）——
      // 语句升、分支降，同一份代码，这就是尺子换了的样子。
      thresholds: {
        statements: 94,
        branches: 80,
        functions: 89,
        lines: 94,
      },
    },
  },
});
