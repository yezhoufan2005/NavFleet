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
        // Raised in 13A-0 (85/79 → 86/81) to absorb what moved in from the
        // frontend: `deviceTone.ts` arrived at 100%, taking the measurement to
        // 87.30 / 82.05 / 89.36 / 87.30. Raising here is the other half of
        // lowering the frontend's gate by the same move — without it, relocating
        // covered code would be a way to quietly shed coverage.
        //
        // A note for whoever raises these: `dataDefaults.ts` sits at 0% and that
        // is honest rather than lazy — it is two inert literals that no test
        // imports, and both are slated to be either filled or deleted
        // (frontend-parity.md, 8.7). Excluding it would inflate the global
        // number for a file that genuinely has no coverage.
        statements: 86,
        branches: 81,
        functions: 87,
        lines: 86,
      },
    },
  },
});
