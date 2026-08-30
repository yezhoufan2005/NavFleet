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
      thresholds: {
        statements: 92,
        branches: 85,
        functions: 86,
        lines: 92,
      },
    },
  },
});
