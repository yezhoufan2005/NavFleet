import { describe, it, expect, afterEach } from "vitest";
import { createMemoryHistory } from "vue-router";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { UserRole } from "@navfleet/shared";
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
      { path: "/devices/:deviceId", name: "device-detail", title: "设备详情" },
      { path: "/alerts", name: "alerts", title: "消息" },
      // 告警史: cleared-alert history + stats (Phase 16B). Its own top-level section, read-only
      // (viewer+), so it carries no roles.
      { path: "/alert-history", name: "alert-history", title: "告警史" },
      { path: "/reports", name: "reports", title: "报表" },
      // 管理 is nested for the same reason 设备 is: `router-link-active` follows
      // matched records, so a child page has to keep the section lit. Its landing
      // page is a real page rather than a redirect into the first child (C2), which
      // is why the parent carries no component and the `""` child does.
      { path: "/admin", name: undefined, title: "管理" },
      { path: "/admin", name: "admin", title: undefined },
      { path: "/admin/system", name: "admin-system", title: "系统状态" },
      { path: "/admin/scenes", name: "admin-scenes", title: "场景" },
      { path: "/admin/users", name: "admin-users", title: "用户" },
      { path: "/admin/audit", name: "admin-audit", title: "审计" },
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

  it("shows 管理 to an admin but hides it from viewer and operator (15C)", async () => {
    const adminNav = await mountNav("/", "admin");
    expect(link(adminNav, "管理"), "admin sees 管理").toBeDefined();

    for (const role of ["viewer", "operator"] as const) {
      const nav = await mountNav("/", role);
      expect(link(nav, "管理"), `${role} must not see 管理`).toBeUndefined();
      // The read sections stay visible for everyone.
      expect(link(nav, "总览"), `${role} sees 总览`).toBeDefined();
    }
  });
});
