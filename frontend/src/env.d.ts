/**
 * Ambient declarations for the frontend TypeScript project.
 *
 * `vue-tsc` resolves `.vue` SFCs natively, but the plain TypeScript language
 * service (editor, bare `tsc`) does not, so `import App from "./App.vue"` fails
 * with TS2307 without this shim. Actual `.vue` files still win during module
 * resolution — wildcard ambient modules are only consulted when resolution
 * fails — so per-component prop typing under `vue-tsc` is unaffected.
 */

/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<object, object, any>;
  export default component;
}
