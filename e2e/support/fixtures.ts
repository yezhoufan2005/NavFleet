/**
 * Test fixtures: a browser-issue guard plus the shared sign-in helper.
 *
 * Every test gets the guard automatically. It fails the test during teardown if
 * the page logged a console error, threw an uncaught exception, or received a
 * non-2xx response that the test did not declare — which is how a broken view
 * or a dead endpoint shows up even when the assertions themselves still pass.
 */

import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ADMIN } from "./harness";
import { profileFor, type IaProfile } from "./ia";

/** A non-2xx response the run is allowed to produce. */
interface AllowedFailure {
  status: number;
  url: RegExp;
}

/**
 * The shell asks who is signed in before it can render the login form, so a 401
 * on `/api/auth/me` is part of every cold start.
 */
const DEFAULT_ALLOWED_FAILURES: AllowedFailure[] = [
  { status: 401, url: /\/api\/auth\/me$/ },
];

export interface BrowserIssues {
  /** Declare a non-2xx response this test triggers on purpose. */
  allowHttpFailure(status: number, url: RegExp): void;
  /** Everything recorded so far, for assertions inside a test. */
  list(): readonly string[];
}

export const test = base.extend<{
  browserIssues: BrowserIssues;
  ia: IaProfile;
}>({
  /**
   * Which frontend this test is running against, and the handful of things the IA
   * rebuild changed about it. Derived from the project name so a spec never has to
   * know — see `support/ia.ts` for why the deltas live in one table.
   */
  // Playwright parses the first parameter to work out which fixtures this one
  // depends on, and rejects anything that is not a destructuring pattern — so the
  // empty pattern is required here rather than a placeholder name. It also says
  // exactly the right thing: this fixture depends on nothing.
  // eslint-disable-next-line no-empty-pattern
  ia: async ({}, use, testInfo) => {
    await use(profileFor(testInfo.project.name));
  },
  browserIssues: [
    async ({ page }, use) => {
      const issues: string[] = [];
      const allowed = [...DEFAULT_ALLOWED_FAILURES];

      page.on("console", (message) => {
        // Chromium also logs a bare "Failed to load resource: …" for every
        // non-2xx response, with no URL in the text. Those are reported by the
        // response listener below instead, where the allowlist can match a URL.
        if (
          message.type() === "error" &&
          !message.text().startsWith("Failed to load resource")
        ) {
          issues.push(`console.error: ${message.text()}`);
        }
      });

      page.on("pageerror", (error) => {
        issues.push(`uncaught: ${error.message}`);
      });

      // A request that never got a response at all (DNS/connection/TLS). An
      // aborted one is normal: navigating away cancels in-flight requests.
      page.on("requestfailed", (request) => {
        const failure = request.failure()?.errorText ?? "unknown";
        if (failure === "net::ERR_ABORTED") {
          return;
        }
        issues.push(`request failed (${failure}): ${request.url()}`);
      });

      page.on("response", (response) => {
        const status = response.status();
        if (status < 400) {
          return;
        }
        const url = response.url();
        if (
          allowed.some(
            (entry) => entry.status === status && entry.url.test(url),
          )
        ) {
          return;
        }
        issues.push(`HTTP ${status}: ${url}`);
      });

      await use({
        allowHttpFailure: (status, url) => allowed.push({ status, url }),
        list: () => issues,
      });

      expect(issues, "the page must report no errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Sign in through the login form and wait for the monitoring shell. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("用户名").fill(ADMIN.username);
  await page.getByLabel("密码").fill(ADMIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  // Named rather than a bare role query. The v3 console has two navigation
  // landmarks — the primary nav and the breadcrumb trail — and a bare
  // `getByRole("navigation")` would be a strict-mode violation there rather than a
  // failed assertion, which is a confusing way to find out. The v1.0.0 shell names
  // its nav the same way, so this is compatible with both.
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
}
