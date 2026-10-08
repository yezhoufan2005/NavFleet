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

  test("the landing page links every built area", async ({ page }) => {
    // An aggregate section gets a real landing page rather than a redirect into
    // whichever child happens to be first (constraint C2).
    await page.goto("/admin");

    await expect(page.getByRole("link", { name: /系统状态/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /审计/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /外发/ })).toBeVisible();
    // 用户 (1.6.2) and 部署 — 设备接入 / 场景 / 报码字典 — (also 1.6.2) left the 管理 hub for their
    // own top-level sections, so the landing no longer offers those as cards.
    const content = page.getByRole("main");
    await expect(content.getByRole("link", { name: /设备接入/ })).toHaveCount(
      0,
    );
    await expect(content.getByRole("link", { name: /报码字典/ })).toHaveCount(
      0,
    );
    await expect(page.getByText(/^PR /)).toHaveCount(0);
  });

  test("用户 is its own section, reached from the primary nav and split into tabs", async ({
    page,
  }) => {
    // 1.6.2 IA: 用户 / 角色 / 用户组 are tabs of a top-level 用户 section, addressed by real routes.
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "用户", exact: true })
      .click();
    await expect(page).toHaveURL(/\/access$/);

    const tabs = page.getByRole("navigation", { name: "分区导航" });
    // `exact` throughout because 用户 is a substring of 用户组 (and the primary nav also has 用户).
    await expect(
      tabs.getByRole("link", { name: "用户", exact: true }),
    ).toBeVisible();
    await tabs.getByRole("link", { name: "用户组", exact: true }).click();
    await expect(page).toHaveURL(/\/access\/groups$/);
    const accessSection = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "用户", exact: true });
    await expect(accessSection).toHaveAttribute("href", "/access");
  });

  test("部署 is its own section, reached from the primary nav and split into tabs", async ({
    page,
  }) => {
    // 1.6.2 IA: 设备接入 / 场景 / 报码字典 are tabs of a top-level 部署 section, addressed by routes.
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "部署", exact: true })
      .click();
    await expect(page).toHaveURL(/\/deploy$/);

    const tabs = page.getByRole("navigation", { name: "分区导航" });
    await expect(
      tabs.getByRole("link", { name: "设备接入", exact: true }),
    ).toBeVisible();
    await tabs.getByRole("link", { name: "场景", exact: true }).click();
    await expect(page).toHaveURL(/\/deploy\/scenes$/);
    const section = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "部署", exact: true });
    await expect(section).toHaveAttribute("href", "/deploy");
  });

  test("the old /admin/users and /admin/roles deep links still land", async ({
    page,
  }) => {
    // Kept as redirects so shared bookmarks survive the move to /access.
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/access$/);
    await page.goto("/admin/roles");
    await expect(page).toHaveURL(/\/access\/roles$/);
  });

  test("the old /admin deploy deep links still land", async ({ page }) => {
    // Kept as redirects so shared bookmarks survive the move to /deploy.
    await page.goto("/admin/onboarding");
    await expect(page).toHaveURL(/\/deploy$/);
    await page.goto("/admin/scenes");
    await expect(page).toHaveURL(/\/deploy\/scenes$/);
    await page.goto("/admin/codebook");
    await expect(page).toHaveURL(/\/deploy\/codebook$/);
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
    const backend = page.locator("section", { hasText: "后端与依赖" });
    await expect(backend).toContainText("可访问");
    await expect(backend).toContainText("就绪");
    // Mongo and the broker are informational here — the suite drives telemetry over
    // debug ingest, so either state is legitimate; what matters is that each is named
    // in words rather than only coloured.
    await expect(backend).toContainText("MongoDB");
    await expect(backend).toContainText("MQTT broker");

    const link = page.locator("section", { hasText: "标签页链路" });
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
    await page.goto("/deploy/scenes");

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

  test("scenes can be managed: the create control opens a geometry + upload form", async ({
    page,
  }) => {
    // Phase 18 reversed the read-only stance (same reasoning as the onboarding wizard): the
    // console renders these backdrops, it does not push maps to vehicles, so editing scene
    // config is operator/deployment domain and the red line (no command dispatch) holds. The
    // page now offers 新增场景, and the dialog carries the geometry fields + a file upload.
    await page.goto("/deploy/scenes");

    await page.getByRole("button", { name: "新增场景" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("场景 ID")).toBeVisible();
    await expect(dialog.locator('input[type="file"]')).toHaveCount(1);
  });
});
