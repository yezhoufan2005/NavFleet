import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw, RouterHistory } from "vue-router";
import { useAuth } from "@/composables/useAuth";
import { createAuthGuard } from "./guards";

/**
 * Application router.
 *
 * Two departures from the v1.0.0 frontend, both decided in `docs/frontend-ia.md`:
 *
 * 1. **Web history, not hash** (decision 3). The reason is not tidiness: Phase 16D
 *    sends alert notifications whose links must open one specific alert, and the
 *    alert centre's filter state has to live in the URL so a shift can hand a view
 *    to the next one. Both need real paths. The cost is a server-side fallback,
 *    which `frontend-next/nginx.conf` carries and which was verified in the image
 *    (`/devices/agv-01` returns index.html; `/assets/nope.js` still 404s).
 * 2. **The hierarchy is candidate B** (decision 1): the landing page is 总览, and
 *    the map is one of two projections of 设备 rather than the whole application.
 *
 * `/devices/:deviceId` is a *child* of `/devices` rather than a sibling, and that
 * is deliberate. `router-link-active` is decided by matched route records, so
 * nesting is what keeps the 设备 nav item lit while a device detail page is open.
 * A sibling route would leave the whole sidebar looking inactive on the page an
 * engineer spends the most time on. `test/router.test.ts` pins the behaviour,
 * because it is the kind of thing a later refactor flattens without noticing.
 */
declare module "vue-router" {
  interface RouteMeta {
    /** Breadcrumb segment and document title. Absent on a record = inherit. */
    title?: string;
    /**
     * Render without the app shell — no sidebar, no top bar, no session chip.
     * The wall display is the only user: it must be non-interactive (C7).
     */
    bare?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "overview",
    component: () => import("@/views/OverviewView.vue"),
    meta: { title: "总览" },
  },
  {
    path: "/devices",
    // No component: the children render straight into the shell's outlet. The
    // record exists so that both children share one breadcrumb ancestor and one
    // active nav item.
    meta: { title: "设备" },
    children: [
      {
        path: "",
        name: "devices",
        component: () => import("@/views/DevicesView.vue"),
      },
      {
        path: ":deviceId",
        name: "device-detail",
        component: () => import("@/views/DeviceDetailView.vue"),
        meta: { title: "设备详情" },
      },
    ],
  },
  {
    path: "/alerts",
    name: "alerts",
    component: () => import("@/views/AlertsView.vue"),
    meta: { title: "告警" },
  },
  {
    path: "/reports",
    name: "reports",
    component: () => import("@/views/ReportsView.vue"),
    meta: { title: "报表" },
  },
  {
    // An aggregate section, so it gets a real landing page rather than a redirect
    // into its first child (constraint C2). The two children that exist arrive with
    // 13F; the rest (用户 / 用户组 / 审计 / 设备接入 / 报码字典) come with Phase 15–17,
    // and registering empty ones now would put dead entries in the navigation.
    path: "/admin",
    meta: { title: "管理" },
    children: [
      {
        path: "",
        name: "admin",
        component: () => import("@/views/AdminView.vue"),
      },
      {
        path: "system",
        name: "admin-system",
        component: () => import("@/views/admin/SystemStatusView.vue"),
        meta: { title: "系统状态" },
      },
      {
        path: "scenes",
        name: "admin-scenes",
        component: () => import("@/views/admin/ScenesView.vue"),
        meta: { title: "场景" },
      },
    ],
  },
  {
    path: "/wall",
    name: "wall",
    component: () => import("@/views/WallView.vue"),
    meta: { title: "大屏值班", bare: true },
  },
  /**
   * The chart performance harness — a development tool, not a page.
   *
   * Registered only in dev, or in a build with `VITE_CHART_PERF` set. Both the view
   * and (until Phase 13C uses a chart for real) ECharts itself are therefore absent
   * from a normal production bundle — `scripts/assert-no-dev-only-chunks.mjs` runs
   * as part of `npm run build` and fails if the harness chunk ever appears. Setting
   * the flag is also how the chart bundle cost gets measured reproducibly.
   */
  ...(import.meta.env.DEV || import.meta.env.VITE_CHART_PERF
    ? [
        {
          path: "/__charts-perf",
          name: "charts-perf",
          component: () => import("@/views/ChartPerfView.vue"),
          meta: { title: "图表性能基线", bare: true },
        } satisfies RouteRecordRaw,
      ]
    : []),
  {
    // A mistyped deep link says so rather than being redirected to the landing
    // page, which reads as "the address was ignored".
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: () => import("@/views/NotFoundView.vue"),
    meta: { title: "页面不存在" },
  },
];

/**
 * The primary navigation, in display order.
 *
 * Kept next to the route table rather than inside `meta`, because a list is the
 * honest shape for something that is ordered and is not one-per-route: `/wall`,
 * `/devices/:deviceId` and the 404 are all routes with no nav entry. Drift is
 * caught by a test that resolves every name below against the real router.
 */
export interface NavSection {
  routeName: string;
  label: string;
  icon: NavIconName;
}

export type NavIconName =
  "overview" | "devices" | "alerts" | "reports" | "admin";

export const NAV_SECTIONS: readonly NavSection[] = [
  { routeName: "overview", label: "总览", icon: "overview" },
  { routeName: "devices", label: "设备", icon: "devices" },
  { routeName: "alerts", label: "告警", icon: "alerts" },
  { routeName: "reports", label: "报表", icon: "reports" },
  { routeName: "admin", label: "管理", icon: "admin" },
];

/**
 * Builds a router over the real route table. The history is a parameter so tests
 * can pass `createMemoryHistory()` — a jsdom test that drives the browser history
 * shares one URL across every case in the file, and the first `push` that leaks
 * makes the next test start somewhere unexpected.
 */
export const createAppRouter = (history: RouterHistory = createWebHistory()) =>
  createRouter({
    history,
    routes,
    // Every section is its own page; landing halfway down one because the previous
    // page was scrolled is disorienting. Anchors still win when present.
    scrollBehavior: (_to, _from, savedPosition) =>
      savedPosition ?? { top: 0, left: 0 },
  });

export const router = createAppRouter();

router.beforeEach(createAuthGuard(useAuth().state));

export { routes };
