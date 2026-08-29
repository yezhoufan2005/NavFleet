import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs["flat/recommended"],
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { parser: tseslint.parser, extraFileExtensions: [".vue"] },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "vue/multi-word-component-names": "off",
      // The v1.0.0 frontend has this at `allowNoLang: true` because all 12 of its
      // SFCs predate the TypeScript migration. This workspace starts clean, so
      // there is no reason to leave the door open: every SFC declares lang="ts"
      // or lint fails.
      "vue/block-lang": ["error", { script: { lang: "ts" } }],
    },
  },
  prettier,
);
