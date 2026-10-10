import { expect, signIn, test } from "../support/fixtures";

/**
 * 定时报表 (1.6.1; a tab of the 报表 section since 1.6.2) in a real browser. The schedule editor's
 * create/edit/delete + whole-file write is unit-tested against mocked data; what only a browser
 * answers is that the route resolves through the real backend (`GET /reports/config` returns the
 * schedule config) and renders the editor. We sign in as admin (who holds `reports:write`) and only
 * read the page back — assert the seeded demo schedules and the 新建报表 affordance — never writing.
 */
test.describe("console report schedules", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable as a tab of 报表 and renders the schedule editor", async ({
    page,
  }) => {
    await page.goto("/reports");
    await page
      .getByRole("navigation", { name: "分区导航" })
      .getByRole("link", { name: "定时报表" })
      .click();

    await expect(page).toHaveURL(/\/reports\/schedules$/);
    // The section heading is 报表; the active tab names the page.
    await expect(
      page.getByRole("heading", { name: "报表", level: 2 }),
    ).toBeVisible();

    const main = page.getByRole("main");
    // The seeded demo ships a reports.json with two schedules; the table lists them by id.
    await expect(main.getByText("daily-availability")).toBeVisible();
    // An admin (reports:write) sees the create affordance.
    await expect(main.getByRole("button", { name: /新建报表/ })).toBeVisible();
  });
});
