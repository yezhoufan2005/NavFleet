import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw, RouterHistory } from "vue-router";
import type { Capability } from "@navfleet/shared";
import { useAuth } from "@/composables/useAuth";
import { createAuthGuard } from "./guards";

/**
 * Capabilities that grant access to the 管理 area (1.6.1 RBAC). Holding ANY of them shows the 管理
 * nav entry and admits the /admin landing + 系统状态; each functional admin page then gates on its
 * own capability. `alerts:ack` / `debug:ingest` are absent — they gate no admin page.
 */
export const ADMIN_AREA_CAPABILITIES: readonly Capability[] = [
  "users:manage",
  "audit:read",
  "scenes:write",
  "vehicles:write",
  "formations:write",
  "codebook:write",
  "notify:read",
  "rules:write",
  "reports:write",
];

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
    /**
     * Capability required on this route (1.6.1 RBAC). Absent = any authenticated user (viewer+).
     * The auth guard bounces an authenticated user who lacks it to the landing page.
     */
    capability?: Capability;
    /**
     * Capabilities, any-of (1.6.1 RBAC): admitted if the user holds ANY of them. Used for the 管理
     * area shell (parent, landing, 系统状态), which admits anyone holding any ADMIN_AREA_CAPABILITIES.
     */
    capabilities?: readonly Capability[];
    /**
     * The tab strip for a section, declared on its **parent** route (1.6.2 IA). `AppSectionTabs`
     * reads it off the matched ancestor and renders one link per entry the user may see. Kept here
     * rather than derived from `children`, because a normalized matched record does not expose them.
     */
    tabs?: readonly SectionTab[];
  }
}

/** One entry in a section's secondary-navigation strip (`meta.tabs`). */
export interface SectionTab {
  /** Target route name. */
  routeName: string;
  /** The tab's label. */
  label: string;
  /** Capability that gates the tab; absent = shown to anyone who reached the section. */
  capability?: Capability;
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
    // 消息 — a section with three tabs (1.6.2 IA): 消息 (live) and 告警史 (cleared) both render
    // AlertsView (it reads live-vs-history off the path), and 告警规则 is RulesView, folded in from
    // 管理. `AppSectionTabs` reads the strip off this parent's `meta.tabs`; the 告警规则 tab is gated
    // on rules:write, so a viewer sees only 消息 / 告警史. 消息 (live) is the `""` child, so the nav
    // item stays lit on every tab, as with /devices.
    path: "/alerts",
    meta: {
      title: "消息",
      tabs: [
        { routeName: "alerts", label: "消息" },
        { routeName: "alerts-history", label: "告警史" },
        {
          routeName: "alerts-rules",
          label: "告警规则",
          capability: "rules:write",
        },
      ],
    },
    children: [
      {
        path: "",
        name: "alerts",
        component: () => import("@/views/AlertsView.vue"),
      },
      {
        path: "history",
        name: "alerts-history",
        component: () => import("@/views/AlertsView.vue"),
        meta: { title: "告警史" },
      },
      {
        path: "rules",
        name: "alerts-rules",
        component: () => import("@/views/admin/RulesView.vue"),
        meta: { title: "告警规则", capability: "rules:write" },
      },
    ],
  },
  {
    // 告警史 and 告警规则 used to live at these paths; kept as redirects so shared bookmarks land.
    path: "/alert-history",
    redirect: { name: "alerts-history" },
  },
  { path: "/admin/rules", redirect: { name: "alerts-rules" } },
  {
    // 报表 — a section (1.6.2 IA): 报表 (the live KPI/charts/CSV page) and 定时报表 (the schedule
    // editor, folded in from 管理). `AppSectionTabs` reads the strip off this parent; 定时报表 is
    // gated on reports:write, so a viewer sees only one tab (the strip then hides itself). 报表 is
    // the `""` child, so the nav item stays lit on both tabs, as with /devices.
    path: "/reports",
    meta: {
      title: "报表",
      tabs: [
        { routeName: "reports", label: "报表" },
        {
          routeName: "reports-schedules",
          label: "定时报表",
          capability: "reports:write",
        },
      ],
    },
    children: [
      {
        path: "",
        name: "reports",
        component: () => import("@/views/ReportsView.vue"),
      },
      {
        path: "schedules",
        name: "reports-schedules",
        component: () => import("@/views/admin/ReportSchedulesView.vue"),
        meta: { title: "定时报表", capability: "reports:write" },
      },
    ],
  },
  // The 管理 deep link 定时报表 used to live at, kept as a redirect so shared bookmarks land.
  { path: "/admin/reports", redirect: { name: "reports-schedules" } },
  {
    // 用户 — access control, promoted to a top-level section (1.6.2 IA). Its pages (用户 / 角色 /
    // 用户组) were cards under 管理; they are now tabs of one section, addressed by real child routes
    // so a pasted link, Back/Forward and `router-link-active` all work. `AppSectionTabs` reads the
    // strip off this parent's `meta.tabs`. The first tab is the `""` child (renders at /access), so
    // — as with /devices — the section nav item stays lit on any tab. The first tab is labelled 用户
    // (the accounts page) by request, matching the section name.
    path: "/access",
    meta: {
      title: "用户",
      capability: "users:manage",
      tabs: [
        {
          routeName: "access-users",
          label: "用户",
          capability: "users:manage",
        },
        {
          routeName: "access-roles",
          label: "角色",
          capability: "users:manage",
        },
        {
          routeName: "access-groups",
          label: "用户组",
          capability: "users:manage",
        },
      ],
    },
    children: [
      {
        path: "",
        name: "access-users",
        component: () => import("@/views/admin/UsersView.vue"),
        // No `title`: the breadcrumb at the first tab is the section's own (用户).
        meta: { capability: "users:manage" },
      },
      {
        path: "roles",
        name: "access-roles",
        component: () => import("@/views/admin/RolesView.vue"),
        meta: { title: "角色", capability: "users:manage" },
      },
      {
        path: "groups",
        name: "access-groups",
        component: () => import("@/views/admin/GroupsView.vue"),
        meta: { title: "用户组", capability: "users:manage" },
      },
    ],
  },
  // The 管理 deep links these pages used to live at, kept as redirects so shared bookmarks still
  // land — same courtesy as 告警史's old top-level path. /admin/roles now points at the 角色 tab.
  { path: "/admin/users", redirect: { name: "access-users" } },
  { path: "/admin/roles", redirect: { name: "access-roles" } },
  {
    // An aggregate section, so it gets a real landing page rather than a redirect
    // into its first child (constraint C2). The two children that exist arrive with
    // 13F; the rest (用户 / 用户组 / 审计 / 设备接入 / 报码字典) come with Phase 15–17,
    // and registering empty ones now would put dead entries in the navigation.
    path: "/admin",
    meta: { title: "管理", capabilities: ADMIN_AREA_CAPABILITIES },
    children: [
      {
        path: "",
        name: "admin",
        component: () => import("@/views/AdminView.vue"),
        meta: { capabilities: ADMIN_AREA_CAPABILITIES },
      },
      {
        path: "system",
        name: "admin-system",
        component: () => import("@/views/admin/SystemStatusView.vue"),
        meta: { title: "系统状态", capabilities: ADMIN_AREA_CAPABILITIES },
      },
      {
        path: "scenes",
        name: "admin-scenes",
        component: () => import("@/views/admin/ScenesView.vue"),
        meta: { title: "场景", capability: "scenes:write" },
      },
      {
        path: "onboarding",
        name: "admin-onboarding",
        component: () => import("@/views/admin/DevicesOnboardingView.vue"),
        meta: { title: "设备接入", capability: "vehicles:write" },
      },
      {
        path: "codebook",
        name: "admin-codebook",
        component: () => import("@/views/admin/CodebookView.vue"),
        meta: { title: "报码字典", capability: "codebook:write" },
      },
      {
        path: "notify",
        name: "admin-notify",
        component: () => import("@/views/admin/NotifyView.vue"),
        meta: { title: "外发", capability: "notify:read" },
      },
      {
        path: "audit",
        name: "admin-audit",
        component: () => import("@/views/admin/AuditView.vue"),
        meta: { title: "审计", capability: "audit:read" },
      },
    ],
  },
  {
    // Personal center: any authenticated user (viewer+), so NO `roles`. Change own
    // password, view and revoke own sessions. Reached from the session menu, not the nav.
    path: "/profile",
    name: "profile",
    component: () => import("@/views/ProfileView.vue"),
    meta: { title: "个人中心" },
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
  /** Capabilities that may see this entry, any-of (1.6.1 RBAC). Absent = everyone authenticated. */
  capabilities?: readonly Capability[];
}

export type NavIconName =
  "overview" | "devices" | "alerts" | "reports" | "users" | "admin";

export const NAV_SECTIONS: readonly NavSection[] = [
  { routeName: "overview", label: "总览", icon: "overview" },
  { routeName: "devices", label: "设备", icon: "devices" },
  { routeName: "alerts", label: "消息", icon: "alerts" },
  { routeName: "reports", label: "报表", icon: "reports" },
  {
    routeName: "access-users",
    label: "用户",
    icon: "users",
    capabilities: ["users:manage"],
  },
  {
    routeName: "admin",
    label: "管理",
    icon: "admin",
    capabilities: ADMIN_AREA_CAPABILITIES,
  },
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
