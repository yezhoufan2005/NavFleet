import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
    },
  },
  {
    /**
     * `require-await` does not apply to test doubles.
     *
     * The fakes here implement interfaces whose methods return promises —
     * `open(): Promise<void>`, `restoreLatestDevices(): Promise<…>` — and `async open() {
     * this.opened = true; }` is how you satisfy that without writing
     * `return Promise.resolve()` fourteen times. The rule reads a missing `await` as an
     * oversight; in a stub it is the point.
     *
     * Scoped off rather than rewritten: 14 of the backend's 18 `require-await` reports were
     * this, and the other 4 — `emitChangeEvents`, `reloadConfigInternal`, `startWatching`,
     * `drain` — were real and are fixed in `src/`.
     */
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  prettier,
);
