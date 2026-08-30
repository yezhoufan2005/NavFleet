import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "../support/fixtures";

/**
 * Accessibility net for the v3 console.
 *
 * Separate from `accessibility.spec.ts` because the two frontends ship different
 * surfaces — a shared spec would have to describe both lists and would buy nothing,
 * since a11y is not a parity question. What it *does* share is the standard: WCAG
 * 2.1 A + AA, serious and critical only.
 *
 * Two things here go beyond what the v1.0.0 pass does, both because 11C §3.3 asked
 * for them and both because they found real defects the first time they ran:
 *
 * - **Four viewports**, not one. The old pass only ever audited 1440×900, which
 *   leaves the two ends of the scale — a tablet at the duty desk and a 2560 wall —
 *   entirely unchecked.
 * - **Transient states.** An open drawer and an open menu are surfaces too, and the
 *   menu is exactly where the `aria-hidden-focus` defect lived: Reka's default
 *   `modal` told a screen reader the shell was gone while a keyboard could still
 *   tab into it.
 */
type AxeViolation = Awaited<
  ReturnType<AxeBuilder["analyze"]>
>["violations"][number];

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const TAGS = ["wcag2a", "wcag2aa"];

/** Signed-in routes, and the heading that proves each one actually rendered. */
const ROUTES: readonly { path: string; heading: string | RegExp }[] = [
  { path: "/", heading: "总览" },
  { path: "/devices", heading: "设备" },
  // Case-insensitive because the detail page titles itself with the *vehicle's
  // name* ("C12 巡检车") once the fleet is loaded, and falls back to "设备 agv-c12"
  // for an id the fleet does not carry. Either is a resolved page.
  { path: "/devices/agv-c12", heading: /c12/i },
  // The playback tab, by URL rather than by clicking through — it is the surface that
  // carries the unlabelled-by-design controls (a range slider and a speed combobox),
  // and an unnamed slider is exactly the critical Phase 10 found on the old history
  // page. Auditing 实时 would never reach it.
  { path: "/devices/agv-c12?tab=playback", heading: /c12/i },
  { path: "/alerts", heading: "告警" },
  { path: "/reports", heading: "报表" },
  { path: "/admin", heading: "管理" },
  // The two built children. 系统状态 carries a data table and a row of state badges;
  // 场景 carries a badge per map resource. Auditing only the landing page would check
  // a list of cards and nothing else.
  { path: "/admin/system", heading: "系统状态" },
  { path: "/admin/scenes", heading: "场景" },
  { path: "/no-such-page", heading: "页面不存在" },
  { path: "/wall", heading: "大屏值班模式" },
];

/**
 * The 11C scale, both ends included. `wall` (2560) is where the large type scale is
 * meant to take over, and 1024 is the first width where the sidebar is still a rail.
 */
const VIEWPORTS: readonly { label: string; width: number; height: number }[] = [
  { label: "平板 1024", width: 1024, height: 768 },
  { label: "笔记本 1440", width: 1440, height: 900 },
  { label: "值班台 1920", width: 1920, height: 1080 },
  { label: "墙面 2560", width: 2560, height: 1440 },
];

const formatViolations = (violations: readonly AxeViolation[]): string => {
  if (violations.length === 0) return "  (axe reported no violations at all)";
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => {
          // `failureSummary` is what turns "colour contrast" into a number you can
          // act on, but it is multi-line — flattened onto the selector line.
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

/**
 * Wait until no CSS transition is still running before sampling colours.
 *
 * Auditing inside a transition reads a half-changed foreground against a
 * half-changed background — that is what made an intermittent 1.38:1 failure look
 * like flakiness for a day (ROADMAP, 2026-08-29).
 *
 * Two details that are easy to get wrong: filter to `CSSTransition`, because
 * `getAnimations()` also returns infinite keyframe animations that never settle; and
 * catch on `finished`, because it **rejects** with `AbortError` when an animation is
 * cancelled — which is exactly what happens to a drawer transition that is
 * interrupted.
 */
const settleTransitions = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const running = document
      .getAnimations()
      .filter((animation) => animation instanceof CSSTransition);
    await Promise.all(
      running.map((animation) => animation.finished.catch(() => undefined)),
    );
  });

const expectAccessible = async (page: Page, view: string): Promise<void> => {
  await settleTransitions(page);

  const { violations } = await new AxeBuilder({ page })
    .withTags(TAGS)
    .analyze();
  const blocking = violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ""),
  );

  // `soft` so one bad surface does not hide the others — the test still fails, it
  // just audits everything first.
  expect
    .soft(
      blocking.map((violation) => `${violation.id} (${violation.impact})`),
      `${view}: ${blocking.length} serious/critical accessibility violation(s).\n` +
        `All ${violations.length} violation(s) axe reported for ${TAGS.join(" + ")}:\n` +
        formatViolations(violations),
    )
    .toEqual([]);
};

/** Seed the theme before boot; an init script re-runs on every navigation. */
const useTheme = async (page: Page, theme: "light" | "dark"): Promise<void> => {
  await page.addInitScript(
    (value) => window.localStorage.setItem("navfleet:theme", value),
    theme,
  );
};

for (const theme of ["light", "dark"] as const) {
  const label = theme === "dark" ? "深色" : "浅色";

  test.describe(`console accessibility — ${label}`, () => {
    test("the login form has no serious or critical violations", async ({
      page,
    }) => {
      await useTheme(page, theme);
      await page.goto("/");
      await expect(page.getByText("请登录以访问车队监控台")).toBeVisible();
      // Guard the premise: without this a broken theme preference would silently
      // audit the light tokens twice and report a false pass.
      if (theme === "dark") {
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          "dark",
        );
      }

      await expectAccessible(page, `登录页 — ${label}`);
    });

    /**
     * One test per viewport rather than one test for the whole grid.
     *
     * Eight routes x four viewports is 32 axe analyses, and axe is not fast: as one
     * test that is a couple of minutes against a 45s budget, and on a cold CI runner
     * it started timing out — a timeout that says nothing about which route or which
     * width was slow. Split, each test does eight analyses, gets its own budget, and
     * names the viewport in its own title when it fails.
     */
    for (const viewport of VIEWPORTS) {
      test(`every route is clean at ${viewport.label}`, async ({ page }) => {
        await useTheme(page, theme);
        await signIn(page);
        await page.setViewportSize({
          width: viewport.width,
          height: viewport.height,
        });

        for (const route of ROUTES) {
          await page.goto(route.path);
          await expect(
            page.getByRole("heading", { name: route.heading }).first(),
          ).toBeVisible();
          await expectAccessible(
            page,
            `${route.path} @ ${viewport.label} — ${label}`,
          );
        }
      });
    }

    test("the open drawer and the open session menu are clean", async ({
      page,
    }) => {
      await useTheme(page, theme);
      await signIn(page);

      // The drawer only exists below `lg`.
      await page.setViewportSize({ width: 834, height: 1000 });
      await page.goto("/devices");
      await page.getByRole("button", { name: "打开导航" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectAccessible(page, `抽屉打开 — ${label}`);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await page.getByRole("button", { name: /admin/ }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expectAccessible(page, `会话菜单打开 — ${label}`);
    });
  });
}
