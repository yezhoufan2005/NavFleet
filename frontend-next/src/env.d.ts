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
  /**
   * AMap (高德地图) Web credentials for the GPS map. Both are build-time values —
   * see `.env.example`. Absent, the map renders a configuration notice instead;
   * `lib/amap.ts` decides that, and it says which file to edit.
   */
  readonly VITE_AMAP_KEY?: string;
  readonly VITE_AMAP_SECURITY_JS_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
