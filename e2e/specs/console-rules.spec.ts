import { expect, signIn, test } from "../support/fixtures";

/**
 * 消息规则 (1.6.1; a tab of the 消息 section since 1.6.2) in a real browser. The form's
 * parse/validate/save is unit-tested against mocked data; what only a browser answers is that the
 * route resolves through the real backend (`GET /rules/config` returns the effective rules) and
 * renders the editor. We sign in as admin (who holds `rules:write`) and only read the page back —
 * assert the two rule sections and the 保存 affordance — never writing, so nothing leaks.
 */
test.describe("console rules", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable as a tab of 消息 and renders the rule editor", async ({
    page,
  }) => {
    await page.goto("/alerts");
    await page
      .getByRole("navigation", { name: "分区导航" })
      .getByRole("link", { name: "消息规则" })
      .click();

    await expect(page).toHaveURL(/\/alerts\/rules$/);
    // The section heading is 消息; the active tab names the page.
    await expect(
      page.getByRole("heading", { name: "消息", level: 2 }),
    ).toBeVisible();

    const main = page.getByRole("main");
    // Both built-in rule sections render, and the write affordance is present for an admin.
    await expect(main.getByText("低电量预警")).toBeVisible();
    await expect(main.getByText("设备离线")).toBeVisible();
    await expect(main.getByRole("button", { name: "保存" })).toBeVisible();
  });
});
