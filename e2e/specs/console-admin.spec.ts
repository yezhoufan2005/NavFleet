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

  test("系统 is its own section, reached from the primary nav and split into tabs", async ({
    page,
  }) => {
    // 1.6.2 IA: 系统状态 / 审计 / 外发 are tabs of a top-level 系统 section, successor to the 管理 hub.
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "系统", exact: true })
      .click();
    await expect(page).toHaveURL(/\/system$/);

    const tabs = page.getByRole("navigation", { name: "分区导航" });
    await expect(
      tabs.getByRole("link", { name: "系统状态", exact: true }),
    ).toBeVisible();
    await tabs.getByRole("link", { name: "外发", exact: true }).click();
    await expect(page).toHaveURL(/\/system\/notify$/);
    const section = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "系统", exact: true });
    await expect(section).toHaveAttribute("href", "/system");
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
    // 1.6.2 IA: 车辆 / 编队 / 场景 / 报码字典 are tabs of a top-level 部署 section.
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "部署", exact: true })
      .click();
    await expect(page).toHaveURL(/\/deploy$/);

    const tabs = page.getByRole("navigation", { name: "分区导航" });
    await expect(
      tabs.getByRole("link", { name: "车辆", exact: true }),
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

  test("the old /admin deep links still land", async ({ page }) => {
    // The emptied 管理 hub and its pages are kept as redirects so shared bookmarks survive.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/system$/);
    await page.goto("/admin/system");
    await expect(page).toHaveURL(/\/system$/);
    await page.goto("/admin/audit");
    await expect(page).toHaveURL(/\/system\/audit$/);
    await page.goto("/admin/notify");
    await expect(page).toHaveURL(/\/system\/notify$/);
  });

  test("a child keeps 系统 lit and shows up in the breadcrumb", async ({
    page,
  }) => {
    // `router-link-active` follows matched records, so nesting keeps the section lit while a tab
    // is open, and the breadcrumb reads 系统 › 审计.
    await page.goto("/system");
    await page
      .getByRole("navigation", { name: "分区导航" })
      .getByRole("link", { name: "审计", exact: true })
      .click();

    await expect(page).toHaveURL(/\/system\/audit$/);
    const trail = page.getByRole("navigation", { name: "面包屑" });
    await expect(trail.getByRole("link", { name: "系统" })).toBeVisible();
    await expect(trail.getByText("审计")).toBeVisible();

    // Highlighted as the section, but not announced as the current page.
    const section = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "系统", exact: true });
    await expect(section).toHaveAttribute("href", "/system");
    await expect(section).not.toHaveAttribute("aria-current", "page");
  });

  test("system status reaches /health/ready and reports both ends", async ({
    page,
  }) => {
    await page.goto("/system");

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
    await page.goto("/system");
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
