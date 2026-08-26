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
      // today (31.1% stmts / 86.8% branches / 91.5% funcs), so a regression
      // fails CI while a small refactor does not. Statement coverage is low
      // because the large single-file views (Dashboard/History/Alerts) and the
      // map/point-cloud rendering are exercised end-to-end (e2e/) rather than
      // in jsdom. Raise these when coverage climbs; never lower them to make a
      // red build pass.
      thresholds: {
        statements: 27,
        branches: 82,
        functions: 87,
        lines: 27,
      },
    },
  },
});
