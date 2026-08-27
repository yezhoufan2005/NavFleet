import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import vueTsConfigs from "@vue/eslint-config-typescript";
import prettier from "@vue/eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "legacy/**", "coverage/**"],
  },
  js.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  ...vueTsConfigs(),
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
      // Progressive migration: legacy .js/.vue files are not fully typed yet.
      "vue/multi-word-component-names": "off",
      // Allow both JS and TS <script> blocks while components are migrated to TS.
      "vue/block-lang": ["error", { script: { allowNoLang: true } }],
    },
  },
  {
    // Build/test tooling runs in Node, not the browser.
    files: ["*.config.js", "*.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  prettier,
];
