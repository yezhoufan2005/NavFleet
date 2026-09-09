import js from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Neither config file is in the app tsconfig (`include` is src + test), and neither
        // should be — they are build inputs, not app sources.
        projectService: {
          allowDefaultProject: ["vite.config.ts", "vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
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
      /**
       * Off, and this is an argument rather than a dodge.
       *
       * eslint-plugin-vue 10 extended this rule to destructured `defineProps<{…}>()`, which
       * is how every SFC here declares props. It then asks for a runtime default on
       * `unit?: string` / `ariaLabel?: string` / `placeholder?: string` — and the only
       * default available is `""`, which **means something different**: an empty unit, an
       * empty accessible name, an empty placeholder, rather than the absence of one. The
       * type already says the prop is optional and `undefined` is the value that carries
       * "not provided".
       *
       * It stays off only for that reason. A prop whose absence has no meaning should still
       * carry a default, and the destructure is where you can see whether it does.
       */
      "vue/require-default-prop": "off",
    },
  },
  {
    // Build-time scripts run in Node, not the browser. Kept as a separate block
    // rather than adding Node globals everywhere: a `process` reference inside a
    // component is a bug, and this workspace should keep saying so.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    /**
     * The four `no-unsafe-*` rules are off in `test/**`, and the reason is a limit of the
     * tooling rather than a concession about test quality.
     *
     * Type-aware lint runs on typescript-eslint's project service, which does **not** load
     * Vue's TS language plugin. So an `import Foo from "@/components/Foo.vue"` — which
     * `vue-tsc` resolves fine, and which `npm run typecheck` checks — is an unresolvable
     * module here. Every `wrapper.findComponent(Foo).props().points` in these files then
     * reports as「unsafe member access on a type that cannot be resolved」: 45 of the
     * console's 60 findings, none of them about the code.
     *
     * The rules stay **on** in `src/**`, where they caught a real one (`stores/fleet.ts`).
     * And the value of the batch is not in these four: `no-unnecessary-type-assertion`,
     * `await-thenable`, `no-base-to-string` and `require-await` all still run here, and
     * between them found 12 dead assertions and two awaits on non-promises.
     *
     * **A gate that needs 45 exemptions on its first run is not a gate**, and the honest
     * response is to say which of its questions this toolchain cannot answer.
     */
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Test files build throwaway components inline — a fixture that throws during
    // render, a stub that renders one line — and each is clearer beside the case
    // that uses it than in a file of its own.
    files: ["test/**/*.ts"],
    rules: { "vue/one-component-per-file": "off" },
  },
  prettier,
);
