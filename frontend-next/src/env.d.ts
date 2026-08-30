/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /**
   * Set at build time to include the chart performance harness in a production
   * build. Only ever used to measure the chart bundle cost reproducibly — see
   * `router/index.ts`.
   */
  readonly VITE_CHART_PERF?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
