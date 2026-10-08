import { describe, it, expect, afterEach } from "vitest";
import { createMemoryHistory } from "vue-router";
import { mount } from "@vue/test-utils";
import { createAppRouter } from "@/router";
import { useAuth, __resetAuth } from "@/composables/useAuth";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";

/**
 * The section tab strip (1.6.2 IA). It reads `meta.tabs` off the matched ancestor, so these
 * cases drive the real router rather than a hand-built one — a tab that stops resolving to a
 * route is exactly the drift worth catching. 用户 is the first section to use it.
 */
afterEach(() => {
  __resetAuth();
});

const mountAt = async (
  path: string,
  capabilities: string[] = ["users:manage"],
) => {
  const auth = useAuth();
  auth.state.status = "authenticated";
  auth.state.user = { username: "admin", role: "admin" };
  auth.state.capabilities = capabilities as never;
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  return mount(AppSectionTabs, { global: { plugins: [router] } });
};

const tabAt = (wrapper: Awaited<ReturnType<typeof mountAt>>, label: string) =>
  wrapper.findAll("a").find((anchor) => anchor.text() === label);

describe("AppSectionTabs", () => {
  it("renders one tab per page of the 用户 section", async () => {
    const wrapper = await mountAt("/access");
    const labels = wrapper.findAll("a").map((a) => a.text());
    expect(labels).toEqual(["用户", "角色", "用户组"]);
  });

  it("marks the current tab, and only that one", async () => {
    const wrapper = await mountAt("/access/roles");
    expect(tabAt(wrapper, "角色")?.attributes("aria-current")).toBe("page");
    expect(tabAt(wrapper, "用户")?.attributes("aria-current")).toBeUndefined();
    expect(
      tabAt(wrapper, "用户组")?.attributes("aria-current"),
    ).toBeUndefined();
  });

  it("moves the active mark to the first tab on that tab", async () => {
    const wrapper = await mountAt("/access");
    expect(tabAt(wrapper, "用户")?.attributes("aria-current")).toBe("page");
    expect(tabAt(wrapper, "角色")?.attributes("aria-current")).toBeUndefined();
  });

  it("renders nothing on a page that is not part of a tabbed section", async () => {
    const wrapper = await mountAt("/reports");
    expect(wrapper.find("nav").exists()).toBe(false);
  });

  it("is a named navigation landmark, because the shell has others", async () => {
    const wrapper = await mountAt("/access");
    expect(wrapper.find("nav").attributes("aria-label")).toBe("分区导航");
  });

  it("hides tabs the caller lacks the capability for (部署)", async () => {
    // 部署's three tabs each gate on their own capability. An admin with all three sees them all…
    const all = await mountAt("/deploy", [
      "vehicles:write",
      "scenes:write",
      "codebook:write",
    ]);
    expect(all.findAll("a").map((a) => a.text())).toEqual([
      "设备接入",
      "场景",
      "报码字典",
    ]);

    // …while a caller holding only one write capability sees a single tab — and a one-tab strip
    // is no choice, so it renders nothing.
    const one = await mountAt("/deploy", ["scenes:write"]);
    expect(one.find("nav").exists()).toBe(false);
  });
});
