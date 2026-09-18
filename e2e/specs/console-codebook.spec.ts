import { expect, signIn, test } from "../support/fixtures";

/**
 * 报码字典 (Phase 16C-2) in a real browser. The merge, validation, import and export are
 * unit-tested against mocked data; what only a browser answers is that the admin route
 * resolves through the real backend and renders the table **in effect** — here the built-in
 * reference table, since the seeded deployment ships no `codebook.json`.
 *
 * Deliberately read-only: an import would write `codebook.json` on the one long-lived backend
 * and leak into every later test (the single-worker isolation rule), so import is left to the
 * unit tests and this only asserts the page reads and renders.
 */
test.describe("console codebook", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable from the admin landing page and renders the table in effect", async ({
    page,
  }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: /报码字典/ }).click();

    await expect(page).toHaveURL(/\/admin\/codebook$/);
    await expect(
      page.getByRole("heading", { name: "报码字典", level: 2 }),
    ).toBeVisible();

    // A built-in code and its meaning render (the seed ships no deployment codebook).
    const main = page.getByRole("main");
    await expect(main.getByText("5102")).toBeVisible();
    await expect(main.getByText("路径规划超时")).toBeVisible();

    // Export is offered; import is present but not exercised here (see file header).
    await expect(main.getByRole("button", { name: /导出/ })).toBeVisible();
    await expect(main.getByRole("button", { name: /导入/ })).toBeVisible();
  });
});
