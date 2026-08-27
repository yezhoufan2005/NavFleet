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
      // today (82.1% stmts / 81.4% branches / 84.8% funcs), so a regression
      // fails CI while a small refactor does not. Raise them when coverage
      // climbs; never lower them to make a red build pass.
      thresholds: {
        statements: 80,
        branches: 79,
        functions: 82,
        lines: 80,
      },
    },
  },
});
