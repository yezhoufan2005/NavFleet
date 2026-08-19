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

// Annotated explicitly: without it TypeScript widens the array to a union of the
// literal shapes (each carrying `redirect?: undefined` or `component?: undefined`),
// which no longer matches `RouteRecordRaw`.
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
    path: "/:pathMatch(.*)*",
    redirect: "/",
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
