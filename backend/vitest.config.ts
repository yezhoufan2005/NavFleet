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
      thresholds: {
        statements: 87,
        branches: 83,
        functions: 88,
        lines: 87,
      },
    },
  },
});
