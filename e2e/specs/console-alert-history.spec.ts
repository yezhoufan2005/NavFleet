import { expect, signIn, test } from "../support/fixtures";

/**
 * 告警史 (Phase 16B) in a real browser. The statistics and list are unit-tested against mocked
 * data; what only a browser answers is that the new top-level nav entry resolves, the page
 * loads through the real backend, and its charts' bundle (ECharts) does not break the route.
 *
 * The seeded fleet carries only *active* alerts, so there is no cleared history to show — which
 * makes the empty state the deterministic thing to assert here (and it is the interesting one:
 * it is what an operator sees when nothing has cleared yet, or when Mongo is not attached).
 */
test.describe("console alert history", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable from the primary navigation", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "告警史" })
      .click();

    await expect(page).toHaveURL(/\/alert-history$/);
    await expect(
      page.getByRole("heading", { name: "告警史", level: 2 }),
    ).toBeVisible();
  });

  test("explains the empty history and links to 系统状态", async ({ page }) => {
    // No cleared alerts in the seed, so the page lands on its empty state — which names what
    // is missing and links to the page that can say whether Mongo is connected.
    await page.goto("/alert-history");

    const main = page.getByRole("main");
    await expect(main.getByText("MongoDB")).toBeVisible();
    await expect(main.getByRole("link", { name: /系统状态/ })).toHaveAttribute(
      "href",
      "/admin/system",
    );
  });
});
