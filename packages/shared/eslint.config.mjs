import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * `@navfleet/shared` 的 lint 配置。
 *
 * 补这一份的理由不是「统一」，而是这个包**恰好是最不该没有门禁的那个**：它是前后端共同引用的
 * 领域类型单一来源，一处笔误会同时进两个 bundle 的类型视野。而在此之前它是全仓唯一没有 lint 的
 * workspace —— 根配置 ignore 了 `packages/**`（那条 ignore 是为 fleet-core 自带配置写的），
 * 于是 shared 从两边同时漏了下去。
 *
 * 内容与 fleet-core 那份一致，只去掉它不需要的部分：这个包是纯类型，没有运行时代码，
 * 所以不需要任何环境 globals。
 */
export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  prettier,
);
