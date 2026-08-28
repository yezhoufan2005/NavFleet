import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import vueTsConfigs from "@vue/eslint-config-typescript";
import prettier from "@vue/eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
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
      // Single-word component names are fine here: every component is in
      // `src/components` or `src/views`, so there is no global-registration
      // collision to guard against.
      "vue/multi-word-component-names": "off",
      // `src/**` is TypeScript, but the SFCs still carry plain `<script setup>`;
      // allow both until they are migrated.
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
