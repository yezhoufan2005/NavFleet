import { expect, signIn, test } from "../support/fixtures";

/**
 * Shell behaviour that only exists on the v3 console, in a real browser.
 *
 * These are not equivalence tests — v1.0.0 has none of this — so they live in their
 * own spec rather than being bolted onto a shared one. What they cover is
 * specifically the part unit tests cannot: focus actually moving, Escape actually
 * dismissing, a preference actually surviving a page load, and a deep link actually
 * resolving rather than 404ing.
 */
test.describe("console shell", () => {
  test("the realtime indicator reaches 实时 against a real backend", async ({
    page,
  }) => {
    // The unit tests drive a stubbed socket, so what they cannot answer is whether
    // the link actually connects: same-origin `/ws` through the dev server's proxy,
    // accepted by the real backend, answering the app-level ping. If any of that is
    // wrong the indicator sits at 连接中 forever and every page shows stale data
    // while claiming to be live.
    await signIn(page);

    const indicator = page
      .getByRole("status")
      .filter({ hasText: /实时|连接中/ });
    await expect(indicator).toHaveText("实时");
    // The fleet's configured name, not the product name again.
    await expect(page.getByRole("banner")).toContainText("综合示范车队");
  });

  test("the skip link jumps straight to the content", async ({ page }) => {
    // Five nav links sit between the top of the document and the content on every
    // page. Whether the link is *reachable* is what a unit test cannot answer: it is
    // visually hidden until focused, so this needs a real Tab.
    await signIn(page);

    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "跳到主内容" });
    await expect(skip).toBeFocused();

    await skip.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("the sidebar remembers being collapsed across a reload", async ({
    page,
  }) => {
    await signIn(page);
    const toggle = page.getByRole("button", { name: "收起侧栏" });
    await toggle.click();

    // Collapsed: labels are out of sight but the links keep their names.
    await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "设备", exact: true }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
  });

  test("below lg the sidebar becomes a drawer that traps focus and closes on Escape", async ({
    page,
  }) => {
    // The whole reason the drawer is a Reka `Dialog` rather than a `v-if` and a
    // scrim. None of this is visible in jsdom.
    await signIn(page);
    await page.setViewportSize({ width: 834, height: 1000 });

    const trigger = page.getByRole("button", { name: "打开导航" });
    await trigger.click();

    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("link", { name: "告警", exact: true }),
    ).toBeVisible();

    // Focus is inside the drawer, not left behind on the trigger.
    await expect(drawer.locator(":focus")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    // …and it comes back to where it started, which is the part that is easy to get
    // wrong and impossible to notice with a mouse.
    await expect(trigger).toBeFocused();
  });

  test("navigating closes the drawer rather than leaving it over the new page", async ({
    page,
  }) => {
    await signIn(page);
    await page.setViewportSize({ width: 834, height: 1000 });

    await page.getByRole("button", { name: "打开导航" }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("link", { name: "告警", exact: true }).click();

    await expect(drawer).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "告警" }).first(),
    ).toBeVisible();
  });

  test("a deep link into a nested route resolves and keeps its section lit", async ({
    page,
  }) => {
    await signIn(page);
    // A full page load at a nested path — the thing hash routing never had to
    // handle, and the reason the image needs an SPA fallback.
    await page.goto("/devices/agv-c12");

    await expect(page.getByRole("heading", { name: /agv-c12/ })).toBeVisible();

    // The trail is built from the nesting, and 设备 stays the current section even
    // though the current *page* is the detail page.
    const trail = page.getByRole("navigation", { name: "面包屑" });
    await expect(trail.getByRole("link", { name: "设备" })).toBeVisible();
    await expect(trail.getByText("设备详情")).toBeVisible();

    const section = page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "设备", exact: true });
    await expect(section).toHaveAttribute("href", "/devices");
    // Highlighted as the section, but not announced as the current page.
    await expect(section).not.toHaveAttribute("aria-current", "page");
  });

  test("the theme chosen in the session menu survives a reload", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: /admin/ }).click();
    await page.getByRole("menuitemradio", { name: "深色" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.reload();
    // Stamped before the first paint by the inline script in index.html, so this
    // also covers "no flash of the light baseline".
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("the wall display renders without the shell", async ({ page }) => {
    await signIn(page);
    await page.goto("/wall");

    await expect(
      page.getByRole("heading", { name: "大屏值班模式" }),
    ).toBeVisible();
    // Non-interactive by requirement (C7): no navigation, no session control.
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("banner")).toHaveCount(0);
  });
});
