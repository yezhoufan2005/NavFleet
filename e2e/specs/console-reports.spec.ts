import { expect, signIn, test } from "../support/fixtures";

/**
 * 报表 (Phase 17B-1) in a real browser. The KPI band, charts and CSV export are unit-tested
 * against mocked aggregates; what only a browser answers is that the nav entry resolves, the
 * page loads through the real backend, and its charts' bundle (ECharts) does not break the route.
 *
 * The e2e backend runs without MongoDB, so both aggregation endpoints answer `available:false`
 * and the page lands on its honest-empty state — the same deterministic anchor the alert-history
 * spec uses, and the one an operator sees when no history backend is attached.
 */
test.describe("console reports", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable from the primary navigation", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "报表" })
      .click();

    await expect(page).toHaveURL(/\/reports$/);
    await expect(
      page.getByRole("heading", { name: "报表", level: 2 }),
    ).toBeVisible();
  });

  test("explains the empty aggregation and links to 系统状态", async ({
    page,
  }) => {
    await page.goto("/reports");

    const main = page.getByRole("main");
    await expect(main.getByText("暂无历史可聚合")).toBeVisible();
    await expect(main.getByRole("link", { name: /系统状态/ })).toHaveAttribute(
      "href",
      "/admin/system",
    );
  });
});
