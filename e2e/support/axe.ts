/**
 * The accessibility gate, shared by both consoles' audits.
 *
 * It lived twice — once in `specs/accessibility.spec.ts` and once in
 * `specs/console-accessibility.spec.ts` — as ~65 identical lines. A duplicated
 * *gate* is worse than duplicated test code: the day someone adds an impact level
 * to `BLOCKING_IMPACTS` or a tag to `TAGS`, only one console gets the stricter
 * audit, and nothing in either file says the other exists. The two specs still
 * differ in everything that is genuinely different (hash routing versus web
 * history, which routes exist, which viewports matter); what they share is the
 * definition of "accessible", and that belongs in one place.
 *
 * Only `serious` and `critical` findings fail a run. The lighter buckets are still
 * printed, but not asserted on: `moderate` colour-contrast results shift with
 * anti-aliasing and with the theme tokens' small tweaks, and treating them as
 * failures made the suite flake without pointing at a real defect. The failure
 * message always carries the *whole* list — rule id, impact, help text and the
 * selector of every failing node — so a red run is actionable without re-running
 * axe by hand.
 */

import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

export type AxeViolation = Awaited<
  ReturnType<AxeBuilder["analyze"]>
>["violations"][number];

/** Impacts that fail the run; anything lighter is reported only. */
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

/** WCAG 2.1 A + AA — the conformance target, and nothing beyond it. */
const TAGS = ["wcag2a", "wcag2aa"];

export const formatViolations = (
  violations: readonly AxeViolation[],
): string => {
  if (violations.length === 0) {
    return "  (axe reported no violations at all)";
  }
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
 * A navigation click starts the nav pill's 160ms transition, and axe measuring
 * inside that window reads a half-changed foreground against a half-changed
 * background. That produced a genuine intermittent failure — `--muted` on
 * `--brand` at 1.38:1 — which read as flakiness for a day because it depends
 * purely on timing. The pill itself no longer animates (navigation.css explains
 * why), but every other transition in the app is still a candidate, so the audit
 * should not race the UI on principle rather than one rule at a time.
 *
 * Filtered to `CSSTransition`: `getAnimations()` also returns the status dot's
 * infinite `realtime-pulse` keyframes, and awaiting that would never resolve. And
 * `finished` is caught rather than awaited bare, because it **rejects** with
 * `AbortError` when an animation is cancelled — which is exactly what happens to a
 * drawer transition that gets interrupted.
 */
export const settleTransitions = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const running = document
      .getAnimations()
      .filter((animation) => animation instanceof CSSTransition);
    await Promise.all(
      running.map((animation) => animation.finished.catch(() => undefined)),
    );
  });

/** Analyse the current page and fail on any serious/critical violation. */
export const expectAccessible = async (
  page: Page,
  view: string,
): Promise<void> => {
  await settleTransitions(page);

  const { violations } = await new AxeBuilder({ page })
    .withTags(TAGS)
    .analyze();

  const blocking = violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ""),
  );

  // `soft` so one bad view does not hide the others — the test still fails, it just
  // audits all of them first. Asserted on the compact `id (impact)` list so the diff
  // stays readable; the message is what tells you where to look.
  expect
    .soft(
      blocking.map((violation) => `${violation.id} (${violation.impact})`),
      `${view}: ${blocking.length} serious/critical accessibility violation(s).\n` +
        `All ${violations.length} violation(s) axe reported for ${TAGS.join(" + ")}:\n` +
        formatViolations(violations),
    )
    .toEqual([]);
};
