import { expect, signIn, test } from "../support/fixtures";

/**
 * 定时报表 (1.6.1) in a real browser. The schedule editor's create/edit/delete + whole-file write
 * is unit-tested against mocked data; what only a browser answers is that the admin route resolves
 * through the real backend (`GET /reports/config` returns the schedule config) and renders the
 * editor. We sign in as admin (who holds `reports:write`) and only read the page back — assert the
 * empty state and the 新建报表 affordance — never writing, so nothing leaks into later tests.
 */
test.describe("console report schedules", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable from the admin landing page and renders the schedule editor", async ({
    page,
  }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: /定时报表/ }).click();

    await expect(page).toHaveURL(/\/admin\/reports$/);
    await expect(
      page.getByRole("heading", { name: "定时报表", level: 2 }),
    ).toBeVisible();

    const main = page.getByRole("main");
    // The seeded deployment ships no reports.json, so the honest empty state shows.
    await expect(main.getByText(/还没有定时报表/)).toBeVisible();
    // An admin (reports:write) sees the create affordance.
    await expect(main.getByRole("button", { name: /新建报表/ })).toBeVisible();
  });
});
