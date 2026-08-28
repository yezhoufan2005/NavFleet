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
      thresholds: {
        statements: 58,
        branches: 84,
        functions: 81,
        lines: 58,
      },
    },
  },
});
