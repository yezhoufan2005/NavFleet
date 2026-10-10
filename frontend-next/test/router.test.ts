import { describe, it, expect, afterEach } from "vitest";
import { createMemoryHistory } from "vue-router";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { capabilitiesForRole, type UserRole } from "@navfleet/shared";
import { createAppRouter, NAV_SECTIONS, routes } from "@/router";
import { useAuth, __resetAuth } from "@/composables/useAuth";
import AppSidebarNav from "@/components/shell/AppSidebarNav.vue";

/**
 * The route table and the navigation that renders from it.
 *
 * The nested-active cases are the ones worth having. Whether a section stays lit
 * while you are on one of its sub-pages is decided by matched route *records*, so it
 * follows from `/devices/:deviceId` being a child of `/devices` rather than a
 * sibling — which is invisible in the route table and is exactly the kind of thing a
 * later tidy-up flattens. It also differs between vue-router majors (3 compared
 * paths, 4 onwards compares records), so it is not safe to carry in anyone's head.
 */
const flatten = (
  records: typeof routes,
  parent = "",
): { path: string; name?: string; title?: string }[] =>
  records.flatMap((record) => {
    const path = record.path.startsWith("/")
      ? record.path
      : `${parent}/${record.path}`.replace(/\/{2,}/g, "/");
    const self = {
      path: path.replace(/(.)\/$/, "$1"),
      name: record.name as string | undefined,
      title: record.meta?.title,
    };
    return [self, ...flatten(record.children ?? [], path)];
  });

describe("route table", () => {
  it("declares the candidate-B hierarchy", () => {
    // The landing page is 总览, not the map. That is the whole IA decision, in one
    // assertion: if this line ever reads "dashboard" again, candidate B was undone.
    expect(flatten(routes)).toEqual([
      { path: "/", name: "overview", title: "总览" },
      { path: "/devices", name: undefined, title: "设备" },
      { path: "/devices", name: "devices", title: undefined },
      // 设备详情 is a shell whose four L3 views are real child routes (Phase 18). The
      // `:deviceId` parent carries no title — the breadcrumb fills it from the id — and
      // 实时 is the `""` child, so the 设备 nav item stays lit on every tab.
      { path: "/devices/:deviceId", name: undefined, title: undefined },
      { path: "/devices/:deviceId", name: "device-detail", title: "实时" },
      {
        path: "/devices/:deviceId/charts",
        name: "device-charts",
        title: "曲线",
      },
      {
        path: "/devices/:deviceId/playback",
        name: "device-playback",
        title: "回放",
      },
      {
        path: "/devices/:deviceId/alerts",
        name: "device-alerts",
        title: "消息史",
      },
      // 消息 is a section (1.6.2 IA): 消息 (live) and 消息史 both render AlertsView, 告警规则 is
      // RulesView folded in from 管理. Live is the `""` child, sharing the parent's path.
      { path: "/alerts", name: undefined, title: "消息" },
      { path: "/alerts", name: "alerts", title: undefined },
      { path: "/alerts/history", name: "alerts-history", title: "消息史" },
      { path: "/alerts/rules", name: "alerts-rules", title: "告警规则" },
      // Old top-level paths, kept as redirects so shared bookmarks still land.
      { path: "/alert-history", name: undefined, title: undefined },
      { path: "/admin/rules", name: undefined, title: undefined },
      // 报表 is a section (1.6.2 IA): 报表 (live) is the `""` child, 定时报表 is the schedule
      // editor folded in from 管理.
      { path: "/reports", name: undefined, title: "报表" },
      { path: "/reports", name: "reports", title: undefined },
      {
        path: "/reports/schedules",
        name: "reports-schedules",
        title: "定时报表",
      },
      { path: "/admin/reports", name: undefined, title: undefined },
      // 用户 promoted to a top-level section (1.6.2 IA): 用户 / 角色 / 用户组 are tabs behind real
      // child routes. The first tab is the `""` child (renders at /access), so it shares the
      // parent's path and carries no title of its own — its breadcrumb is the section's 用户.
      { path: "/access", name: undefined, title: "用户" },
      { path: "/access", name: "access-users", title: undefined },
      { path: "/access/roles", name: "access-roles", title: "角色" },
      { path: "/access/groups", name: "access-groups", title: "用户组" },
      // The 管理 deep links the two pages used to live at, kept as redirects for old bookmarks.
      { path: "/admin/users", name: undefined, title: undefined },
      { path: "/admin/roles", name: undefined, title: undefined },
      // 部署 — deployment config (1.6.2 IA): 车辆 / 编队 / 场景 / 报码字典, each gated on its own
      // capability. 车辆 is the `""` child (shares /deploy), so the nav item stays lit on all tabs;
      // the section admits any-of the four write capabilities.
      { path: "/deploy", name: undefined, title: "部署" },
      { path: "/deploy", name: "deploy-vehicles", title: undefined },
      { path: "/deploy/formations", name: "deploy-formations", title: "编队" },
      { path: "/deploy/scenes", name: "deploy-scenes", title: "场景" },
      { path: "/deploy/codebook", name: "deploy-codebook", title: "报码字典" },
      { path: "/admin/onboarding", name: undefined, title: undefined },
      { path: "/admin/scenes", name: undefined, title: undefined },
      { path: "/admin/codebook", name: undefined, title: undefined },
      // 系统 — the operations section (1.6.2 IA), successor to the emptied-out 管理 hub: 系统状态 /
      // 审计 / 外发. 系统状态 is the `""` child (shares /system), so the nav item stays lit on all
      // tabs. The old 管理 paths are kept as redirects.
      { path: "/system", name: undefined, title: "系统" },
      { path: "/system", name: "system-status", title: undefined },
      { path: "/system/audit", name: "system-audit", title: "审计" },
      { path: "/system/notify", name: "system-notify", title: "外发" },
      { path: "/admin", name: undefined, title: undefined },
      { path: "/admin/system", name: undefined, title: undefined },
      { path: "/admin/audit", name: undefined, title: undefined },
      { path: "/admin/notify", name: undefined, title: undefined },
      // Personal center: any authenticated user, so it carries no roles and is
      // reached from the session menu rather than the primary nav.
      { path: "/profile", name: "profile", title: "个人中心" },
      { path: "/wall", name: "wall", title: "大屏值班" },
      // Present here because vitest runs with `import.meta.env.DEV` true. It is a
      // development tool, not a page: the production build drops it, and
      // `scripts/assert-no-dev-only-chunks.mjs` fails the build if its chunk ever
      // appears in `dist/`.
      { path: "/__charts-perf", name: "charts-perf", title: "图表性能基线" },
      { path: "/:pathMatch(.*)*", name: "not-found", title: "页面不存在" },
    ]);
  });

  it("resolves every primary navigation entry to a real route", () => {
    // The nav list lives beside the table rather than inside it, so this is what
    // keeps a renamed route from leaving a dead link in the sidebar.
    const router = createAppRouter(createMemoryHistory());
    const names = new Set(
      router.getRoutes().map((record) => record.name as string | undefined),
    );
    for (const section of NAV_SECTIONS) {
      expect(names, section.label).toContain(section.routeName);
    }
  });

  it("keeps the wall display out of the navigation and out of the shell", () => {
    const router = createAppRouter(createMemoryHistory());
    const wall = router.getRoutes().find((record) => record.name === "wall");

    expect(wall?.meta.bare).toBe(true);
    expect(NAV_SECTIONS.map((section) => section.routeName)).not.toContain(
      "wall",
    );
  });

  it("keeps the chart harness out of the navigation and out of the shell", async () => {
    // If it ever gained a nav entry, a development tool would be one click from an
    // operator's dashboard.
    const router = createAppRouter(createMemoryHistory());
    await router.push("/__charts-perf");

    expect(router.currentRoute.value.meta.bare).toBe(true);
    expect(NAV_SECTIONS.map((section) => section.routeName)).not.toContain(
      "charts-perf",
    );
  });

  it("answers an unknown address with the not-found view rather than a redirect", async () => {
    const router = createAppRouter(createMemoryHistory());
    await router.push("/no-such-page");
    expect(router.currentRoute.value.name).toBe("not-found");
    // The address survives so the page can show what was not found.
    expect(router.currentRoute.value.fullPath).toBe("/no-such-page");
  });
});

describe("primary navigation", () => {
  const ACTIVE = "bg-brand";

  afterEach(() => {
    __resetAuth();
  });

  /**
   * A Pinia is needed now that the nav reads the alert count for its badge. Fresh per
   * mount so a count set in one case cannot leak into the next. Signed in as `admin` by
   * default so every nav entry (incl. the admin-only 管理) is present — role filtering has
   * its own cases below.
   */
  const mountNav = async (path: string, role: UserRole = "admin") => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuth();
    auth.state.status = "authenticated";
    auth.state.user = { username: "tester", role };
    // Nav visibility is now capability-based (1.6.1): seed the role's preset capabilities so the
    // 管理 entry (any admin-area capability) shows for admin and hides for viewer/operator.
    auth.state.capabilities = [...capabilitiesForRole(role)];
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    return mount(AppSidebarNav, { global: { plugins: [router, pinia] } });
  };

  const link = (wrapper: Awaited<ReturnType<typeof mountNav>>, label: string) =>
    wrapper.findAll("a").find((anchor) => anchor.text() === label);

  it("marks the current section and only that one", async () => {
    const wrapper = await mountNav("/alerts");

    expect(link(wrapper, "消息")?.classes().join(" ")).toContain(ACTIVE);
    expect(link(wrapper, "设备")?.classes().join(" ")).not.toContain(ACTIVE);
    expect(link(wrapper, "消息")?.attributes("aria-current")).toBe("page");
  });

  it("keeps 设备 lit while a device detail page is open", async () => {
    // The page an engineer spends the most time on must not look like nowhere.
    const wrapper = await mountNav("/devices/agv-c12");
    expect(link(wrapper, "设备")?.classes().join(" ")).toContain(ACTIVE);
  });

  it("keeps 用户 lit on any of its tabs (1.6.2 IA)", async () => {
    // The section item stays the highlight while you switch between 用户 / 角色 / 用户组,
    // for the same nested-record reason 设备 does.
    for (const path of ["/access", "/access/roles", "/access/groups"]) {
      const wrapper = await mountNav(path);
      expect(link(wrapper, "用户")?.classes().join(" "), path).toContain(
        ACTIVE,
      );
    }
  });

  it("keeps 部署 lit on any of its tabs (1.6.2 IA)", async () => {
    for (const path of ["/deploy", "/deploy/scenes", "/deploy/codebook"]) {
      const wrapper = await mountNav(path);
      expect(link(wrapper, "部署")?.classes().join(" "), path).toContain(
        ACTIVE,
      );
    }
  });

  it("does not claim the section is the current page on a sub-page", async () => {
    // Highlight and `aria-current` answer different questions: one is "which
    // section", the other is "which page". Announcing both as current is a lie.
    const wrapper = await mountNav("/devices/agv-c12");
    expect(link(wrapper, "设备")?.attributes("aria-current")).toBeUndefined();
  });

  it("keeps every label reachable when collapsed to icons", async () => {
    const wrapper = await mountNav("/");
    await wrapper.setProps({ labelled: false });

    for (const section of NAV_SECTIONS) {
      const anchor = link(wrapper, section.label);
      // Still in the accessibility tree, and recoverable with a mouse too.
      expect(anchor, section.label).toBeDefined();
      expect(anchor?.attributes("title")).toBe(section.label);
      expect(anchor?.find("span").classes()).toContain("sr-only");
    }
  });

  it("is a navigation landmark with a name, because it is not the only one", async () => {
    // The breadcrumbs are a landmark too, so an unnamed `nav` would make "jump to
    // navigation" ambiguous.
    const wrapper = await mountNav("/");
    expect(wrapper.find("nav").attributes("aria-label")).toBe("主导航");
  });

  it("shows 系统 to an admin but hides it from viewer and operator (15C)", async () => {
    const adminNav = await mountNav("/", "admin");
    expect(link(adminNav, "系统"), "admin sees 系统").toBeDefined();

    for (const role of ["viewer", "operator"] as const) {
      const nav = await mountNav("/", role);
      expect(link(nav, "系统"), `${role} must not see 系统`).toBeUndefined();
      // The read sections stay visible for everyone.
      expect(link(nav, "总览"), `${role} sees 总览`).toBeDefined();
    }
  });
});
