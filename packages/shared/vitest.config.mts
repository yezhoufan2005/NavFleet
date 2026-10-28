import { defineConfig } from "vitest/config";

/**
 * The domain package both the backend and the consoles build on: its parsers decide what config a
 * deployment may load, its rule engine what messages a vehicle raises. Its tests used to live in
 * fleet-core (which only re-exported a few of these), so a change here was gated by the coverage
 * of a different package. Node environment: nothing here touches a DOM.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // 首次实测 94.24 / 89.26 / 100 / 96.18，门槛取其下方一两个点；只上不下。
      // 两套归一化的纯 helper 收进来并补测后 94.94 / 91.13 / 100 / 96.67，分支上抬。
      thresholds: {
        statements: 93,
        branches: 90,
        functions: 99,
        lines: 95,
      },
    },
  },
});
