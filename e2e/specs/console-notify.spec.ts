import { expect, signIn, test } from "../support/fixtures";

/**
 * 外发 (Phase 16D-2b / 1.6.1; a tab of the 系统 section since 1.6.2) in a real browser. The channel
 * cards, the send table, the filters and the editor are unit-tested against mocked data; what only
 * a browser answers is that the route resolves through the real backend and renders the regions.
 *
 * The seeded deployment ships a demo `notify.json` whose channels name `urlEnv` variables that are
 * left unset, so the effective-channel cards render in a "configured but not ready" (未配 env)
 * state — visible on the page, yet nothing is ever sent, preserving the "no outbound without an
 * endpoint" red line. We sign in as admin (who holds `notify:write`), so the config editor is
 * present; this test only reads it back (asserts the 新建渠道 affordance) and never writes, so
 * nothing leaks into later tests.
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
    // The 生效渠道 region lists the demo channels; their urlEnv is unset, so each reads 未配 env
    // (configured but not ready — nothing is sent).
    await expect(main.getByText("生效渠道")).toBeVisible();
    await expect(main.getByText("ops-wecom").first()).toBeVisible();
    await expect(main.getByText(/未配 env/).first()).toBeVisible();
    // The send-log filters apply live (no 查询 button) — the 筛选 region is still there.
    await expect(main.getByRole("region", { name: "筛选" })).toBeVisible();
    // An admin (notify:write) sees the config editor's create affordance (now a header action).
    await expect(main.getByRole("button", { name: /新建渠道/ })).toBeVisible();
  });
});
