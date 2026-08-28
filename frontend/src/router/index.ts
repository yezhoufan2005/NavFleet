/**
 * Application router.
 *
 * Hash history is deliberate: the SPA is served behind a chain of nginx proxies
 * (edge → frontend container) with no history-mode fallback configured, so hash
 * routing keeps deep links and page refreshes working on any static host without
 * extra server config. Views are lazy-loaded to keep the initial bundle lean.
 */

import { createRouter, createWebHashHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { createAuthGuard } from "./guards";

// Annotated explicitly so each record is checked against `RouteRecordRaw` here
// rather than widened to whatever shape the literals happen to share.
const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "dashboard",
    component: () => import("../views/DashboardView.vue"),
    meta: { title: "实时监控" },
  },
  {
    path: "/history",
    name: "history",
    component: () => import("../views/HistoryView.vue"),
    meta: { title: "历史回放" },
  },
  {
    path: "/alerts",
    name: "alerts",
    component: () => import("../views/AlertsView.vue"),
    meta: { title: "告警中心" },
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("../views/SettingsView.vue"),
    meta: { title: "设置" },
  },
  {
    // A mistyped deep link used to be redirected to "/" silently, which looked
    // like the app had ignored the address; say so instead.
    path: "/:pathMatch(.*)*",
    name: "not-found",
    component: () => import("../views/NotFoundView.vue"),
    meta: { title: "页面不存在" },
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.beforeEach(createAuthGuard(useAuth().state));
