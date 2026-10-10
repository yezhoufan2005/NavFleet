import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw, RouterHistory } from "vue-router";
import type { Capability } from "@navfleet/shared";
import { useAuth } from "@/composables/useAuth";
import { createAuthGuard } from "./guards";

/**
 * Capabilities that grant access to admin-domain surfaces (1.6.1 RBAC). Holding ANY of them admits
 * the 系统 section and its 系统状态 tab (which has no dedicated capability of its own); each other
 * admin page gates on its own. `alerts:ack` / `debug:ingest` are absent — they gate no admin page.
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
 * Capabilities that grant access to the 部署 section (1.6.2 IA). Its three tabs each gate on one of
 * these; holding ANY shows the 部署 nav entry and admits the section (which then redirects to the
 * first tab the caller holds).
 */
export const DEPLOY_CAPABILITIES: readonly Capability[] = [
  "vehicles:write",
  "formations:write",
  "scenes:write",
  "codebook:write",
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
        // The device detail shell: it owns the device header and the tab strip, and
        // renders the active L3 view into its outlet. The four views are **real child
        // routes**, not a `?tab=` on one page — so the breadcrumb reads 设备 › <id> ›
        // 实时, Back/Forward walk the tabs, and each tab is a linkable URL, the same
        // pattern 消息 / 用户 / 部署 use. The parent carries no static title: the
        // breadcrumb fills its segment from the device id (`AppBreadcrumbs` resolves a
        // `:param` leaf), and `meta.tabs` drives `AppSectionTabs`. 实时 is the `""`
        // child, so the 设备 nav item stays lit on every tab (as `/devices` already did).
        path: ":deviceId",
        component: () => import("@/views/DeviceDetailView.vue"),
        meta: {
          tabs: [
            { routeName: "device-detail", label: "实时" },
            { routeName: "device-charts", label: "曲线" },
            { routeName: "device-playback", label: "回放" },
            { routeName: "device-alerts", label: "消息史" },
          ],
        },
        children: [
          {
            path: "",
            name: "device-detail",
            component: () => import("@/components/device/DeviceLiveTab.vue"),
            meta: { title: "实时" },
            props: true,
          },
          {
            path: "charts",
            name: "device-charts",
            component: () => import("@/components/device/DeviceChartsTab.vue"),
            meta: { title: "曲线" },
            props: true,
          },
          {
            path: "playback",
            name: "device-playback",
            component: () =>
              import("@/components/device/DevicePlaybackTab.vue"),
            meta: { title: "回放" },
            props: true,
          },
          {
            path: "alerts",
            name: "device-alerts",
            component: () => import("@/components/device/DeviceAlertsTab.vue"),
            meta: { title: "消息史" },
            props: true,
          },
        ],
      },
    ],
  },
  {
    // 消息 — a section with three tabs (1.6.2 IA): 消息 (live) and 消息史 (cleared) both render
    // AlertsView (it reads live-vs-history off the path), and 消息规则 is RulesView, folded in from
    // 管理. `AppSectionTabs` reads the strip off this parent's `meta.tabs`; the 消息规则 tab is gated
    // on rules:write, so a viewer sees only 消息 / 消息史. 消息 (live) is the `""` child, so the nav
    // item stays lit on every tab, as with /devices.
    path: "/alerts",
    meta: {
      title: "消息",
      tabs: [
        { routeName: "alerts", label: "消息" },
        { routeName: "alerts-history", label: "消息史" },
        {
          routeName: "alerts-rules",
          label: "消息规则",
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
        meta: { title: "消息史" },
      },
      {
        path: "rules",
        name: "alerts-rules",
        component: () => import("@/views/admin/RulesView.vue"),
        meta: { title: "消息规则", capability: "rules:write" },
      },
    ],
  },
  {
    // 消息史 and 消息规则 used to live at these paths; kept as redirects so shared bookmarks land.
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
  // land — same courtesy as 消息史's old top-level path. /admin/roles now points at the 角色 tab.
  { path: "/admin/users", redirect: { name: "access-users" } },
  { path: "/admin/roles", redirect: { name: "access-roles" } },
  {
    // 部署 — deployment config, a top-level section (1.6.2 IA): 车辆 / 编队 / 场景 / 报码字典, folded
    // out of 管理. Its tabs each gate on their own capability (vehicles / formations / scenes /
    // codebook :write); the section admits anyone holding ANY of them (meta.capabilities). 车辆 is
    // the `""` child (renders at /deploy, so the nav item stays lit on every tab, as with /devices)
    // and is gated by the section any-of rather than vehicles:write alone, so a caller holding only
    // one of the other writes still lands rather than being bounced; its own tab stays hidden.
    path: "/deploy",
    meta: {
      title: "部署",
      capabilities: DEPLOY_CAPABILITIES,
      tabs: [
        {
          routeName: "deploy-vehicles",
          label: "车辆",
          capability: "vehicles:write",
        },
        {
          routeName: "deploy-formations",
          label: "编队",
          capability: "formations:write",
        },
        {
          routeName: "deploy-scenes",
          label: "场景",
          capability: "scenes:write",
        },
        {
          routeName: "deploy-codebook",
          label: "报码字典",
          capability: "codebook:write",
        },
      ],
    },
    children: [
      {
        path: "",
        name: "deploy-vehicles",
        component: () => import("@/views/admin/VehiclesView.vue"),
        meta: { capabilities: DEPLOY_CAPABILITIES },
      },
      {
        path: "formations",
        name: "deploy-formations",
        component: () => import("@/views/admin/FormationsView.vue"),
        meta: { title: "编队", capability: "formations:write" },
      },
      {
        path: "scenes",
        name: "deploy-scenes",
        component: () => import("@/views/admin/ScenesView.vue"),
        meta: { title: "场景", capability: "scenes:write" },
      },
      {
        path: "codebook",
        name: "deploy-codebook",
        component: () => import("@/views/admin/CodebookView.vue"),
        meta: { title: "报码字典", capability: "codebook:write" },
      },
    ],
  },
  // The 管理 deep links these pages used to live at, kept as redirects so shared bookmarks land.
  { path: "/admin/onboarding", redirect: { name: "deploy-vehicles" } },
  { path: "/admin/scenes", redirect: { name: "deploy-scenes" } },
  { path: "/admin/codebook", redirect: { name: "deploy-codebook" } },
  {
    // 系统 — the operations section (1.6.2 IA), successor to the old 管理 hub: 系统状态 / 审计 /
    // 外发. The hub went empty once 用户 / 部署 / 消息(消息规则) / 报表(定时报表) split out into their
    // own sections, so it is replaced by this one rather than kept as a landing with nothing on it.
    // 系统状态 has no dedicated capability (it is the "whose fault is it" diagnostics page), so it —
    // and the section — admit anyone holding any admin-area capability; 审计 / 外发 gate on their own.
    path: "/system",
    meta: {
      title: "系统",
      capabilities: ADMIN_AREA_CAPABILITIES,
      tabs: [
        { routeName: "system-status", label: "状态" },
        { routeName: "system-audit", label: "审计", capability: "audit:read" },
        {
          routeName: "system-notify",
          label: "外发",
          capability: "notify:read",
        },
      ],
    },
    children: [
      {
        path: "",
        name: "system-status",
        component: () => import("@/views/admin/SystemStatusView.vue"),
        meta: { capabilities: ADMIN_AREA_CAPABILITIES },
      },
      {
        path: "audit",
        name: "system-audit",
        component: () => import("@/views/admin/AuditView.vue"),
        meta: { title: "审计", capability: "audit:read" },
      },
      {
        path: "notify",
        name: "system-notify",
        component: () => import("@/views/admin/NotifyView.vue"),
        meta: { title: "外发", capability: "notify:read" },
      },
    ],
  },
  // The 管理 hub and its pages' old paths, kept as redirects so shared bookmarks land.
  { path: "/admin", redirect: { name: "system-status" } },
  { path: "/admin/system", redirect: { name: "system-status" } },
  { path: "/admin/audit", redirect: { name: "system-audit" } },
  { path: "/admin/notify", redirect: { name: "system-notify" } },
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
  "overview" | "devices" | "alerts" | "reports" | "users" | "deploy" | "system";

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
    routeName: "deploy-vehicles",
    label: "部署",
    icon: "deploy",
    capabilities: DEPLOY_CAPABILITIES,
  },
  {
    routeName: "system-status",
    label: "系统",
    icon: "system",
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
