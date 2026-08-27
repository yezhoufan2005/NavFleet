import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    // The HTTP integration tests log a line per request (and a stack for the
    // deliberate 500), which would drown the reporter output.
    env: { LOG_LEVEL: "silent" },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts"],
      // A ratchet, not a target: set a few points under what the suite covers
      // today (81.5% stmts / 80.5% branches / 83.8% funcs), so a regression
      // fails CI while a small refactor does not. Raise them when coverage
      // climbs; never lower them to make a red build pass.
      thresholds: {
        statements: 77,
        branches: 76,
        functions: 79,
        lines: 77,
      },
    },
  },
});
