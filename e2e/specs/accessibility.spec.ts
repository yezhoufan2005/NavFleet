/**
 * Accessibility regression net: axe-core over every view the app ships.
 *
 * Only `serious` and `critical` findings fail the run. The lighter buckets are
 * still printed, but not asserted on: `moderate` colour-contrast results shift
 * with anti-aliasing and with the theme tokens' small tweaks, and treating them
 * as failures made the suite flake without pointing at a real defect. The
 * failure message always carries the *whole* list — rule id, impact, help text
 * and the selector of every failing node — so a red run is actionable without
 * re-running axe by hand.
 *
 * Hash routing (createWebHashHistory) means the views are reached by clicking
 * the nav links, exactly as the per-view specs do; awaiting each view's heading
 * first guarantees axe sees a rendered view rather than a lazy-loaded blank.
 */

import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "../support/fixtures";

type AxeViolation = Awaited<
  ReturnType<AxeBuilder["analyze"]>
>["violations"][number];

/** Impacts that fail the run; anything lighter is reported only. */
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

/** WCAG 2.1 A + AA — the conformance target, and nothing beyond it. */
const TAGS = ["wcag2a", "wcag2aa"];

const formatViolations = (violations: readonly AxeViolation[]): string => {
  if (violations.length === 0) {
    return "  (axe reported no violations at all)";
  }
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => {
          // `failureSummary` is what turns "colour contrast" into a number you
          // can act on, but it is multi-line — flattened onto the selector line.
          const why = (node.failureSummary ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .join(" ");
          return `      at ${node.target.flat().join(" ")}${why ? `\n        ${why}` : ""}`;
        })
        .join("\n");
      return `  [${violation.impact ?? "unknown"}] ${violation.id} — ${violation.help}\n${nodes}`;
    })
    .join("\n");
};

/** Analyse the current page and fail on any serious/critical violation. */
const expectAccessible = async (page: Page, view: string): Promise<void> => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(TAGS)
    .analyze();

  const blocking = violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ""),
  );

  // `soft` so one bad view does not hide the others — the test still fails, it
  // just audits all of them first. Asserted on the compact `id (impact)` list so
  // the diff stays readable; the message is what tells you where to look.
  expect
    .soft(
      blocking.map((violation) => `${violation.id} (${violation.impact})`),
      `${view}: ${blocking.length} serious/critical accessibility violation(s).\n` +
        `All ${violations.length} violation(s) axe reported for ${TAGS.join(" + ")}:\n` +
        formatViolations(violations),
    )
    .toEqual([]);
};

/**
 * Walk every signed-in view and audit each one. Shared by the light and dark
 * passes so the two can never drift apart in which views they cover.
 */
const auditSignedInViews = async (page: Page, theme: string): Promise<void> => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "地图视图" })).toBeVisible();
  await expectAccessible(page, `实时监控 (/#/) — ${theme}`);

  await page.getByRole("link", { name: "告警中心" }).click();
  await expect(page.getByRole("heading", { name: "告警中心" })).toBeVisible();
  await expectAccessible(page, `告警中心 (/#/alerts) — ${theme}`);

  await page.getByRole("link", { name: "历史回放" }).click();
  await expect(page.getByRole("heading", { name: "轨迹回放" })).toBeVisible();
  await expectAccessible(page, `历史回放 (/#/history) — ${theme}`);

  await page.getByRole("link", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await expectAccessible(page, `设置 (/#/settings) — ${theme}`);
};

test.describe("accessibility", () => {
  test("the login form has no serious or critical violations", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("请登录以访问车队监控台")).toBeVisible();

    await expectAccessible(page, "登录页");
  });

  test("every signed-in view has no serious or critical violations", async ({
    page,
  }) => {
    await auditSignedInViews(page, "浅色");
  });

  /**
   * The dark palette needs its own pass. Chromium reports
   * `prefers-color-scheme: light` and the app's default preference is `system`,
   * so every other test in this file only ever sees the light tokens — which is
   * half the theme-aware colours unaudited, on the theme this console actually
   * ships as its default look. `useTheme` reads its preference from
   * localStorage, so seeding that key before the app boots is enough; an init
   * script re-runs on every navigation, including the post-login one.
   */
  test("the dark theme has no serious or critical violations", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("navfleet:theme", "dark");
    });

    await page.goto("/");
    await expect(page.getByText("请登录以访问车队监控台")).toBeVisible();
    // Guard the premise: if the preference stopped being honoured this test
    // would silently re-audit the light theme and report a false pass.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectAccessible(page, "登录页 — 深色");

    await auditSignedInViews(page, "深色");
  });
});
