import { expect, signIn, test } from "../support/fixtures";
import { SEEDED_ALERTING } from "../support/seed";

/**
 * The alert centre in a real browser. Two of these can only be checked here: a URL
 * that survives a reload, and an acknowledgement that survives one.
 *
 * The equivalence question ("does it do what v1.0.0 did") is answered by the shared
 * `alerts.spec.ts` staying green on the old frontend plus the console's own unit
 * tests; what a browser adds is the state that lives outside the app.
 */
/**
 * The seeded vehicle with something to report. Resolved and asserted in
 * `support/seed.ts`, so this spec no longer opens each test with a
 * `test.skip(!faulted, …)` that could never fire — a guard that turned "the seed lost
 * its alerting vehicle" from a red test into a silently skipped one.
 */
const faulted = SEEDED_ALERTING;

test.describe("console alerts", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/alerts");
  });

  test("narrows by severity and puts that in the URL", async ({ page }) => {
    // The point of filter-state-in-the-URL: a supervisor can send this link to
    // whoever is on shift. In v1.0.0 the same view could only be described in words.
    await page.getByRole("button", { name: "告警", exact: true }).click();
    await expect(page).toHaveURL(/severity=critical/);

    await page.reload();
    await expect(
      page.getByRole("button", { name: "告警", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("an acknowledgement survives a reload", async ({ page }) => {
    const row = page.locator("li").filter({ hasText: faulted.deviceName });
    await row.getByRole("button", { name: /确认告警/ }).click();

    // Acknowledged alerts are hidden by default, which is itself the assertion.
    await expect(row).toBeHidden();

    await page.reload();
    await expect(
      page.locator("li").filter({ hasText: faulted.deviceName }),
    ).toBeHidden();

    await page.getByRole("checkbox").check();
    await expect(
      page
        .locator("li")
        .filter({ hasText: faulted.deviceName })
        .getByRole("button", { name: /确认告警/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("a row reaches the vehicle it came from", async ({ page }) => {
    await page
      .locator("li")
      .filter({ hasText: faulted.deviceName })
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(new RegExp(`/devices/${faulted.deviceId}$`));
  });

  test("says the acknowledgement is browser-local rather than leaving it implied", async ({
    page,
  }) => {
    await expect(page.getByText("只保存在本浏览器")).toBeVisible();
  });

  test("the search box waits for the typing to stop before it navigates", async ({
    page,
  }) => {
    // The debounce is unit-tested; what only a browser answers is whether the box keeps
    // the caret and the characters while the URL stays put. Typed one key at a time
    // because `fill` sets the value in a single event and would prove nothing.
    const box = page.getByRole("searchbox");

    await box.pressSequentially(faulted.deviceName.slice(0, 3), { delay: 30 });
    await expect(box).toHaveValue(faulted.deviceName.slice(0, 3));
    await expect(page).not.toHaveURL(/[?&]q=/);

    // And it does arrive, without another keystroke to push it.
    await expect(page).toHaveURL(/[?&]q=/, { timeout: 2_000 });
  });

  test("the navigation carries the alert count on every page", async ({
    page,
  }) => {
    // The capability the badge exists for: knowing whether to switch pages without
    // switching pages. Checked from 设备, i.e. not from 告警 itself.
    await page.goto("/devices");
    const alerts = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: /^消息/ });

    // The digits are `aria-hidden`; the sentence beside them is what a screen reader
    // gets, and it is the half v1.0.0's bare number was missing.
    await expect(alerts).toContainText(/待处理 \d+ 条/);
    await expect(alerts).toContainText("最高");
  });
});
