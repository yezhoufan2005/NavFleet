import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * `packages/shared` has never been linted — the root config ignores `packages/**`
 * and the package carries no config of its own, which is filed as a P0-f gap. A
 * package added today should not join it, so fleet-core brings its own.
 *
 * `no-explicit-any` is an error here, matching the frontend rather than the
 * backend: this code is the shared domain layer, and `unknown` plus a narrowing
 * guard is the house style for loose payloads (see fleetNormalize).
 *
 * Browser globals, not Node: `fleetApi` uses `fetch` and `URLSearchParams`. There
 * is deliberately nothing else here that touches a runtime API — that is what
 * keeps the package usable from two frontends and from a test runner in node.
 */
export default tseslint.config(
  {
    ignores: ["node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  prettier,
);
