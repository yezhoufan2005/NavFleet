import { expect, signIn, test } from "../support/fixtures";

/**
 * 报码字典 (Phase 16C-2; a tab of the 部署 section since 1.6.2) in a real browser. The merge,
 * validation, import and export are unit-tested against mocked data; what only a browser answers is
 * that the route resolves through the real backend and renders the table **in effect** — here the
 * built-in reference table, since the seeded deployment ships no `codebook.json`.
 *
 * Deliberately read-only: an import or a row edit would write `codebook.json` on the one
 * long-lived backend and leak into every later test (the single-worker isolation rule), so
 * writes are left to the unit tests and this only asserts the page reads and renders.
 */
test.describe("console codebook", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable as a tab of 部署 and renders the table in effect", async ({
    page,
  }) => {
    await page.goto("/deploy");
    await page
      .getByRole("navigation", { name: "分区导航" })
      .getByRole("link", { name: "报码字典" })
      .click();

    await expect(page).toHaveURL(/\/deploy\/codebook$/);
    // The section heading is 部署; the active tab names the page.
    await expect(
      page.getByRole("heading", { name: "部署", level: 2 }),
    ).toBeVisible();

    // A built-in code and its meaning render (the seed ships no deployment codebook).
    const main = page.getByRole("main");
    await expect(main.getByText("5102")).toBeVisible();
    await expect(main.getByText("路径规划超时")).toBeVisible();

    // Export/import and the row-level 新建报码 affordance are offered; not exercised here (writes
    // would leak into later tests — see the file header).
    await expect(main.getByRole("button", { name: /导出/ })).toBeVisible();
    await expect(main.getByRole("button", { name: /导入/ })).toBeVisible();
    await expect(main.getByRole("button", { name: /新建报码/ })).toBeVisible();
  });
});
