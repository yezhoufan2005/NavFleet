import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ADMIN } from "./harness";

/**
 * Where the two frontends differ, and nothing else.
 *
 * 11A found that all 17 e2e specs match on roles and Chinese accessible names with
 * zero `data-testid`, and concluded they could be reused verbatim on the new
 * frontend. That is *almost* right, and the gap matters: 11C then decided to rebuild
 * the information architecture, which necessarily changes the navigation's wording.
 * A spec that asserts `实时监控` is asserting the old IA, not the behaviour.
 *
 * So the deltas live here, in one readable table, rather than as a forked suite. The
 * value of that is precise: everything *not* in this file is behaviour both
 * frontends must share, and every entry that is here is a deliberate decision with
 * a reason recorded next to it. A second copy of the specs would have hidden both.
 *
 * The table is short on purpose. If it starts growing during Phase 13, that is a
 * signal the new frontend is drifting rather than being rebuilt.
 */
export type TargetName = "frontend" | "console";

export interface IaProfile {
  target: TargetName;
  /** The landing section: its primary-nav link, and the heading its page renders. */
  landing: { link: string; heading: string };
  /**
   * Primary-nav links that must be present in the signed-in shell, as anchored
   * patterns rather than plain strings. Both reasons are concrete: the 告警 item
   * carries a badge count in its accessible name, so an exact string would not
   * match; and a bare substring for 实时监控 would also match the not-found view's
   * 返回实时监控.
   *
   * Both front ends now leave that one entry open at the end. The console's was
   * anchored for a while — not by choice, but because 13T-C is where it got its badge
   * back; the anchor was a fossil of the missing feature.
   */
  navLinks: readonly RegExp[];
  /** How an unknown address is requested and echoed back, plus the way home. */
  notFound: {
    /** The address to navigate to, as the router expects it. */
    route: string;
    /** The text the view echoes — the address as the user would read it. */
    echo: string;
    backLink: string;
  };
  /**
   * Sign out. One extra step on the console, and it is not an accident: 11C §1 moved
   * personal preferences into the session menu, and 退出 went with them rather than
   * being the one thing left as a bare button in the header.
   */
  signOut: (page: Page) => Promise<void>;
}

const FRONTEND: IaProfile = {
  target: "frontend",
  landing: { link: "实时监控", heading: "地图视图" },
  navLinks: [/^实时监控$/, /^历史回放$/, /^告警中心/, /^设置$/],
  // Hash routing, so the echoed address carries the `#`.
  notFound: {
    route: "/#/no-such-page",
    echo: "#/no-such-page",
    backLink: "返回实时监控",
  },
  signOut: async (page) => {
    await page.getByRole("button", { name: "退出" }).click();
  },
};

const CONSOLE: IaProfile = {
  target: "console",
  // Candidate B: the landing page is 总览 and answers "which few need me now",
  // rather than a full-width map answering "where is everyone".
  landing: { link: "总览", heading: "总览" },
  navLinks: [/^总览$/, /^设备$/, /^消息/, /^报表$/, /^管理$/],
  // Web history, so there is no `#` to echo — printing one would show an address
  // that does not exist.
  notFound: {
    route: "/no-such-page",
    echo: "/no-such-page",
    backLink: "返回总览",
  },
  signOut: async (page) => {
    // The trigger's accessible name is the username plus the role label, so match on
    // the username: it is the one part guaranteed to be there and to be unique.
    await page
      .getByRole("button", { name: new RegExp(ADMIN.username) })
      .click();
    await page.getByRole("menuitem", { name: "退出" }).click();
  },
};

const PROFILES: Record<TargetName, IaProfile> = {
  frontend: FRONTEND,
  console: CONSOLE,
};

/** Resolve the profile from the Playwright project name. */
export const profileFor = (projectName: string): IaProfile => {
  const profile = PROFILES[projectName as TargetName];
  // A new project with no profile would silently audit the wrong frontend, so say
  // so loudly instead.
  expect(
    profile,
    `no IA profile for playwright project "${projectName}" — add one in support/ia.ts`,
  ).toBeDefined();
  return profile;
};
