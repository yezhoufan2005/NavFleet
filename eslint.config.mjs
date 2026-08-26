import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Root ESLint config — the end-to-end suite only.
 *
 * `backend/` and `frontend/` own their own flat configs and are linted from
 * inside their workspace (`npm run lint -w …`), so they are ignored here: the
 * e2e specs are the one source tree that lives outside a workspace. They run in
 * node (Playwright's runner) and lean on Playwright's own types, hence node
 * globals and the backend's rule set rather than the browser-oriented frontend
 * one — whose `@typescript-eslint/no-explicit-any: error` would otherwise apply
 * to files it was never scoped for.
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "backend/**",
      "frontend/**",
      "packages/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["e2e/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
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
  prettier,
);
