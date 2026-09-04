import { expect, signIn, test } from "../support/fixtures";
import { SEEDED_DEVICES } from "../support/seed";

/**
 * 总览, the landing page — and the one page in the new IA with no v1.0.0 counterpart,
 * so there is nothing to compare it against and everything to state outright.
 *
 * What only a browser can answer here: that signing in actually *lands* on this page,
 * that the counts reflect a real backend's real snapshot rather than a fixture, and
 * that the links reach the pages they claim to.
 */
test.describe("console overview", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("is where signing in lands, and counts the seeded fleet", async ({
    page,
  }) => {
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "总览" })).toBeVisible();

    const online = page.getByRole("article").filter({ hasText: "在线设备" });
    await expect(online).toContainText(
      `${SEEDED_DEVICES.length} / ${SEEDED_DEVICES.length}`,
    );
  });

  test("reports GPS coverage, which the backend has always sent and nobody read", async ({
    page,
  }) => {
    const gps = page.getByRole("article").filter({ hasText: "GPS 覆盖" });
    await expect(gps).toContainText(`/ ${SEEDED_DEVICES.length}`);
  });

  test("names the vehicles that need attention and links to them", async ({
    page,
  }) => {
    // The seeded fleet has a faulted vehicle, so the list is not empty — which is
    // also what makes this assertion worth having rather than tautological.
    const attention = page.locator(
      "section[aria-labelledby='attention-heading']",
    );
    await expect(attention).toBeVisible();

    const faulted = SEEDED_DEVICES.find(
      (device) => device.statusLabel !== "正常",
    );
    if (faulted) {
      // The row links, not the section's "查看全部设备" — that one goes to the list.
      await attention.locator("li").first().getByRole("link").click();
      await expect(page).toHaveURL(/\/devices\/.+/);
    }
  });

  test("shows both clocks, and neither of them backwards", async ({ page }) => {
    // Subtracting a server timestamp from a browser clock is how a freshness line
    // ends up reading "更新于 -8 秒前", so the relative age is measured on the
    // browser's own clock and the server's value is shown as an absolute time.
    const freshness = page.getByRole("status").filter({ hasText: "数据" });
    await expect(freshness).toContainText(/数据\s*(刚刚|\d+ 秒前)/);
    await expect(freshness).toContainText("服务端");
    await expect(freshness).not.toContainText("-");
  });

  test("reaches the message centre from the summary", async ({ page }) => {
    await page.getByRole("link", { name: "查看全部消息" }).click();
    // The path stays `/alerts`: a URL is something people paste to each other, and
    // renaming the section is not a reason to break the links already in circulation.
    await expect(page).toHaveURL(/\/alerts$/);
  });
});
