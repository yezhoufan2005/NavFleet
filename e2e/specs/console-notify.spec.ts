import { expect, signIn, test } from "../support/fixtures";

/**
 * 外发 (Phase 16D-2b / 1.6.1; a tab of the 系统 section since 1.6.2) in a real browser. The channel
 * cards, the send table, the filters and the editor are unit-tested against mocked data; what only
 * a browser answers is that the route resolves through the real backend and renders the regions.
 *
 * The seeded deployment ships no `notify.json`, so the effective-channel list is empty — which is
 * the "zero-config = no outbound" red line, and exactly what the page must say honestly. We sign
 * in as admin (who holds `notify:write`), so the config editor is present; this test only reads it
 * back (asserts the 新建渠道 affordance) and never writes, so nothing leaks into later tests.
 */
test.describe("console notify", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is reachable as a tab of 系统 and renders the outbound page", async ({
    page,
  }) => {
    await page.goto("/system");
    await page
      .getByRole("navigation", { name: "分区导航" })
      .getByRole("link", { name: "外发", exact: true })
      .click();

    await expect(page).toHaveURL(/\/system\/notify$/);
    // The section heading is 系统; the active tab names the page.
    await expect(
      page.getByRole("heading", { name: "系统", level: 2 }),
    ).toBeVisible();

    const main = page.getByRole("main");
    // The 生效渠道 region is present; with no notify.json the honest empty state shows.
    await expect(main.getByText("生效渠道")).toBeVisible();
    await expect(main.getByText(/未配置任何渠道/)).toBeVisible();
    // The send-log filters are offered.
    await expect(main.getByRole("button", { name: /查询/ })).toBeVisible();
    // An admin (notify:write) also sees the config editor's create affordance.
    await expect(main.getByRole("button", { name: /新建渠道/ })).toBeVisible();
  });
});
