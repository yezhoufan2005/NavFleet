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
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,vue}"],
      exclude: ["src/main.ts", "src/env.d.ts"],
      // No thresholds yet, on purpose. The scaffold is one button and one page,
      // so any number set now would be measuring the wrong thing and would have
      // to be reset in 12C when real views arrive. Coverage is reported so the
      // trend is visible; the ratchet goes in with the first real view.
    },
  },
});
