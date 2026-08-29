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
      thresholds: {
        // Calibrated from the first real measurement (86.86 / 80.73 / 88.37 /
        // 86.86), a point or two below it. The ratchet only ever goes up.
        //
        // A note for whoever raises these: `dataDefaults.ts` sits at 0% and that
        // is honest rather than lazy — it is two inert literals that no test
        // imports, and both are slated to be either filled or deleted
        // (frontend-parity.md, 8.7). Excluding it would inflate the global
        // number for a file that genuinely has no coverage.
        statements: 85,
        branches: 79,
        functions: 87,
        lines: 85,
      },
    },
  },
});
