import type { Page } from "@playwright/test";
import { expect, signIn, test } from "../support/fixtures";
import { ADMIN } from "../support/harness";
import { SEEDED_ALERTING } from "../support/seed";

/**
 * The alert centre in a real browser. Two of these can only be checked here: a URL that
 * survives a reload, and an acknowledgement that survives one — the latter now because it is
 * written to the backend, not because a localStorage entry outlived the tab.
 *
 * The equivalence question ("does it do what v1.0.0 did") is answered by the shared
 * `alerts.spec.ts` staying green on the old frontend plus the console's own unit
 * tests; what a browser adds is the round trip through the server.
 */
/**
 * The seeded vehicle with something to report. Resolved and asserted in
 * `support/seed.ts`, so this spec no longer opens each test with a
 * `test.skip(!faulted, …)` that could never fire — a guard that turned "the seed lost
 * its alerting vehicle" from a red test into a silently skipped one.
 */
const faulted = SEEDED_ALERTING;

/**
 * Undo any acknowledgement left on the backend by an earlier test.
 *
 * Acknowledgement is server-backed, and this suite runs `workers: 1` against
 * one long-lived backend — so, unlike the old per-browser localStorage, an ack made in one
 * test would otherwise stay for the next and hide the vehicle it expects to find. Reading the
 * active alerts back and unacking each restores the pristine, unacked fleet every test assumes.
 * Uses `page.request`, which shares the signed-in context's cookies (unack is operator+).
 */
const resetAcks = async (page: Page): Promise<void> => {
  const response = await page.request.get("/api/v1/alerts?status=active");
  if (!response.ok()) return;
  const { items } = (await response.json()) as {
    items: { deviceId: string; alertId: string; ignoredBy: string | null }[];
  };
  for (const alert of items) {
    if (alert.ignoredBy) {
      await page.request.post("/api/v1/alerts/unignore", {
        data: { deviceId: alert.deviceId, alertId: alert.alertId },
      });
    }
  }
};

test.describe("console alerts", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    // Clear any ack a prior test wrote to the shared backend, then open a clean list.
    await resetAcks(page);
    await page.goto("/alerts");
  });

  // Leave the shared backend as we found it, so a later spec file does not inherit a
  // hidden (acknowledged) alert.
  test.afterEach(async ({ page }) => {
    await resetAcks(page);
  });

  test("narrows by severity and puts that in the URL", async ({ page }) => {
    // The point of filter-state-in-the-URL: a supervisor can send this link to
    // whoever is on shift. In v1.0.0 the same view could only be described in words.
    // 严重度 is a multi-select now: open it and tick 告警.
    await page.getByRole("button", { name: "严重度筛选" }).click();
    await page.getByRole("checkbox", { name: "告警", exact: true }).click();
    await expect(page).toHaveURL(/severity=critical/);

    await page.reload();
    await page.getByRole("button", { name: "严重度筛选" }).click();
    await expect(
      page.getByRole("checkbox", { name: "告警", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("an ignore survives a reload", async ({ page }) => {
    const row = page.locator("li").filter({ hasText: faulted.deviceName });
    await row.getByRole("button", { name: /忽略消息/ }).click();

    // Ignored rows stay visible (faded) under 全部, now reading 已忽略 and offering 取消忽略.
    await expect(row).toContainText("已忽略");
    await expect(row.getByRole("button", { name: /取消忽略/ })).toBeVisible();

    await page.reload();
    await expect(
      page.locator("li").filter({ hasText: faulted.deviceName }),
    ).toContainText("已忽略");
  });

  test("records who handled it, not just that it is handled", async ({
    page,
  }) => {
    // The point of moving handling off localStorage: it carries a who.
    const row = page.locator("li").filter({ hasText: faulted.deviceName });
    await row.getByRole("button", { name: /忽略消息/ }).click();

    await expect(
      page.locator("li").filter({ hasText: faulted.deviceName }),
    ).toContainText(`已忽略 · ${ADMIN.username}`);
  });

  test("no longer claims acknowledgement is browser-local", async ({
    page,
  }) => {
    // The limitation the page used to state out loud is gone; the sentence would now be a lie.
    await expect(page.getByText("只保存在本浏览器")).toHaveCount(0);
  });

  test("a row reaches the vehicle it came from", async ({ page }) => {
    await page
      .locator("li")
      .filter({ hasText: faulted.deviceName })
      .getByRole("link")
      .click();
    await expect(page).toHaveURL(new RegExp(`/devices/${faulted.deviceId}$`));
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
