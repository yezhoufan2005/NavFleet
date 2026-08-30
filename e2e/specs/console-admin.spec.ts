import { expect, signIn, test } from "../support/fixtures";
import { SEEDED_DEVICES, SEEDED_SCENE } from "../support/seed";

/**
 * 管理 and its two built children, in a real browser.
 *
 * Three things can only be checked here. `/health/ready` has to actually be reachable
 * through the proxy — it is not under `/api/v1`, so nothing else in the suite proves
 * the route exists. The scene resource probe has to make real requests, because its
 * whole purpose is to distinguish a configured URL that resolves from one that 404s.
 * And the local-state inventory is a claim about `localStorage`, which unit tests can
 * only simulate.
 */
const [device] = SEEDED_DEVICES;

test.describe("console admin", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("the landing page links the built areas and marks the rest unbuilt", async ({
    page,
  }) => {
    // An aggregate section gets a real landing page rather than a redirect into
    // whichever child happens to be first (constraint C2).
    await page.goto("/admin");

    await expect(page.getByRole("link", { name: /系统状态/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /场景/ })).toBeVisible();
    // Unbuilt areas are not links — a card that looks clickable and is not would be
    // worse than a plain list.
    await expect(page.getByRole("link", { name: /用户组/ })).toHaveCount(0);
    await expect(page.getByText("PR 15B")).toBeVisible();
  });

  test("a child keeps 管理 lit and shows up in the breadcrumb", async ({
    page,
  }) => {
    // The reason /admin gained children rather than siblings: `router-link-active`
    // follows matched records, so nesting is what keeps the section lit.
    await page.goto("/admin");
    await page.getByRole("link", { name: /系统状态/ }).click();

    await expect(page).toHaveURL(/\/admin\/system$/);
    const trail = page.getByRole("navigation", { name: "面包屑" });
    await expect(trail.getByRole("link", { name: "管理" })).toBeVisible();
    await expect(trail.getByText("系统状态")).toBeVisible();

    // Highlighted as the section, but not announced as the current page — the same
    // distinction `console-shell` pins for 设备/设备详情.
    const section = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "管理", exact: true });
    await expect(section).toHaveAttribute("href", "/admin");
    await expect(section).not.toHaveAttribute("aria-current", "page");
  });

  test("system status reaches /health/ready and reports both ends", async ({
    page,
  }) => {
    await page.goto("/admin/system");

    // The backend is up in this suite, and that answer has to come from the endpoint
    // rather than from the console's own socket.
    const backend = page.locator("section", { hasText: "后端与它的依赖" });
    await expect(backend).toContainText("可访问");
    await expect(backend).toContainText("就绪");
    // Mongo and the broker are informational here — the suite drives telemetry over
    // debug ingest, so either state is legitimate; what matters is that each is named
    // in words rather than only coloured.
    await expect(backend).toContainText("MongoDB");
    await expect(backend).toContainText("MQTT broker");

    const link = page.locator("section", { hasText: "这个标签页的链路" });
    await expect(link).toContainText("实时");
    await expect(link).toContainText("已取得");
  });

  test("the local-state inventory finds a key nobody declared", async ({
    page,
  }) => {
    // The prefix scan is the point: a hand-kept list is exactly what goes stale on a
    // diagnostics page, so an undocumented key must still be listed — under its own
    // name, because that is the interesting case.
    await page.goto("/admin/system");
    await page.evaluate(() =>
      localStorage.setItem("navfleet:e2e-undeclared", "42"),
    );
    await page.reload();

    const row = page.locator("tbody tr", {
      hasText: "navfleet:e2e-undeclared",
    });
    await expect(row).toContainText("42");
    await expect(row).toContainText("长期");
  });

  test("scenes report each configured resource as reachable or not", async ({
    page,
  }) => {
    await page.goto("/admin/scenes");

    const scene = page.locator("section", { hasText: SEEDED_SCENE.sceneName });
    await expect(scene).toBeVisible();
    // Every vehicle in the seed lives on this one scene, which is why a broken map
    // here would matter.
    await expect(scene).toContainText(device.deviceName);

    // Each probe must resolve to an answer rather than sitting at 检查中 — the state
    // that would mean the page never finished asking.
    const badges = scene.locator("li span", { hasText: /可取得|取不到/ });
    await expect(badges.first()).toBeVisible();
    await expect(scene.locator("li span", { hasText: "检查中" })).toHaveCount(
      0,
    );
  });

  test("scenes are read-only, because a map is what a vehicle localises against", async ({
    page,
  }) => {
    // The red line, asserted rather than assumed: no form, no editing control.
    await page.goto("/admin/scenes");

    await expect(page.locator("form")).toHaveCount(0);
    await expect(page.locator("input, textarea, select")).toHaveCount(0);
    await expect(page.getByText("只读")).toBeVisible();
  });
});
