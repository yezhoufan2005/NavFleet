import { expect, signIn, test } from "../support/fixtures";
import {
  CONFIGURED_FORMATION_COUNT,
  SEEDED_ALERTING,
  SEEDED_DEVICES,
} from "../support/seed";

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
    const gps = page.getByRole("article").filter({ hasText: "GPS覆盖" });
    // Both halves. Asserting only the denominator passes for `0 / 3`, which is exactly
    // the failure this tile exists to surface — every seeded device publishes GPS
    // (`support/seed.ts` derives lat/lng for all of them), so the numerator is
    // knowable and leaving it unasserted was the whole check missing.
    await expect(gps).toContainText(
      `${SEEDED_DEVICES.length} / ${SEEDED_DEVICES.length}`,
    );
  });

  test("names the vehicles that need attention and links to them", async ({
    page,
  }) => {
    const attention = page.locator(
      "section[aria-labelledby='attention-heading']",
    );
    await expect(attention).toBeVisible();

    // Named, not merely present: the test's own title promises a *name*, and it used
    // to assert only that some row linked somewhere. The seed's alerting vehicle is
    // resolved in `support/seed.ts`, so the `if (faulted)` that used to wrap this —
    // and could never be false — is gone with it.
    await expect(attention).toContainText(SEEDED_ALERTING.deviceName);

    // The row links, not the section's "查看全部设备" — that one goes to the list.
    await attention
      .locator("li")
      .filter({ hasText: SEEDED_ALERTING.deviceName })
      .first()
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/devices/${SEEDED_ALERTING.deviceId}$`),
    );
  });

  test("shows both clocks, and neither of them backwards", async ({ page }) => {
    // Subtracting a server timestamp from a browser clock is how a freshness line
    // ends up reading "更新于 -8 秒前", so the relative age is measured on the
    // browser's own clock and the server's value is shown as an absolute time.
    const freshness = page.getByRole("status").filter({ hasText: "数据" });
    await expect(freshness).toContainText(/数据\s*(刚刚|\d+ 秒前)/);
    await expect(freshness).toContainText("服务端");
  });

  test("sizes the formation panel to exactly three rows", async ({ page }) => {
    /*
     * Measured in a real layout engine, because the defect was arithmetic rather than
     * appearance. The cap used to be a round `max-h-52` — 208px, which is not three of
     * anything — and because a formation's description is optional a row is one of two
     * heights, so one round number held a different number of rows per deployment. Pinning the
     * row is what makes "three" mean three, and this is the assertion that fails if the type
     * scale ever moves underneath the constant.
     *
     * Nothing is dropped past the third: unlike 待处理项, this panel has no 查看全部 link to
     * defer to, so the rest are reachable by scrolling.
     */
    const list = page.locator(".formation-list");
    const rows = list.locator("li");
    // Three, because that is what `config-runtime/formations.json` declares — the
    // count comes from the file (see `CONFIGURED_FORMATION_COUNT`) so a fourth
    // formation fails here with a reason instead of a bare number mismatch.
    expect(CONFIGURED_FORMATION_COUNT).toBe(3);
    await expect(rows).toHaveCount(CONFIGURED_FORMATION_COUNT);

    const heights = await Promise.all(
      (await rows.all()).map(async (row) => (await row.boundingBox())?.height),
    );
    expect(heights.every((height) => height === 50)).toBe(true);

    // 3 × 50px of row plus 2 × 8px of `gap-2`.
    await expect(list).toHaveCSS("max-height", "166px");

    // Three fit exactly, so there is nothing to scroll yet — the bar arrives with a fourth.
    expect(
      await list.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    ).toBe(0);
  });

  test("reaches the message centre from the summary", async ({ page }) => {
    await page.getByRole("link", { name: "查看全部消息" }).click();
    // The path stays `/alerts`: a URL is something people paste to each other, and
    // renaming the section is not a reason to break the links already in circulation.
    await expect(page).toHaveURL(/\/alerts$/);
  });
});
