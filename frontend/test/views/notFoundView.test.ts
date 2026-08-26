import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createRouter, createWebHashHistory } from "vue-router";
import NotFoundView from "../../src/views/NotFoundView.vue";

// Mirrors the real router (hash history + catch-all) so the view sees the same
// `fullPath` it would see in the app.
const createTestRouter = () =>
  createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: "/", name: "dashboard", component: { template: "<div />" } },
      { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundView },
    ],
  });

const mountAt = async (path: string) => {
  const router = createTestRouter();
  await router.push(path);
  await router.isReady();
  return mount(NotFoundView, { global: { plugins: [router] } });
};

describe("NotFoundView", () => {
  it("states that the page was not found", async () => {
    const wrapper = await mountAt("/histroy");
    expect(wrapper.text()).toContain("页面不存在");
    expect(wrapper.find(".fallback-view").exists()).toBe(true);
  });

  it("echoes the address that was not found, hash included", async () => {
    const wrapper = await mountAt("/histroy");
    expect(wrapper.get(".fallback-detail").text()).toBe("#/histroy");
  });

  it("offers a link back to the dashboard", async () => {
    const wrapper = await mountAt("/nope");
    const link = wrapper.get("a.fallback-link");
    expect(link.text()).toBe("返回实时监控");
    expect(link.attributes("href")).toBe("#/");
  });
});
