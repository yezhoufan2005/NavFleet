import { expect, signIn, test } from "../support/fixtures";

/**
 * 告警史 in a real browser. Since Phase 18 it is a tab of 消息 (`?view=history`) rather than a
 * top-level page: the statistics and list are unit-tested against mocked data, so what only a
 * browser answers is that the tab toggle works, the page loads through the real backend, its
 * charts' bundle (ECharts) does not break the route, and the old `/alert-history` deep link
 * still resolves via the redirect.
 *
 * The seeded fleet carries only *active* alerts, so there is no cleared history to show — which
 * makes the empty state the deterministic thing to assert here (and it is the interesting one:
 * it is what an operator sees when nothing has cleared yet, or when Mongo is not attached).
 */
test.describe("console alert history", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable from the 消息 page as a tab", async ({ page }) => {
    await page.goto("/alerts");
    await page.getByRole("button", { name: "告警史" }).click();

    await expect(page).toHaveURL(/view=history/);
    // The tab toggle now offers the way back, and the live-only bulk controls are gone.
    await expect(page.getByRole("button", { name: "消息页" })).toBeVisible();
  });

  test("keeps the old /alert-history deep link working via a redirect", async ({
    page,
  }) => {
    // No cleared alerts in the seed, so the tab lands on its empty state — which names what
    // is missing and links to the page that can say whether Mongo is connected.
    await page.goto("/alert-history");
    await expect(page).toHaveURL(/\/alerts\?view=history$/);

    const main = page.getByRole("main");
    await expect(main.getByText("MongoDB")).toBeVisible();
    await expect(main.getByRole("link", { name: /系统状态/ })).toHaveAttribute(
      "href",
      "/admin/system",
    );
  });
});
