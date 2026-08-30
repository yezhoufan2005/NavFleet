import { expect, signIn, test } from "../support/fixtures";

/**
 * An unknown address, on both frontends.
 *
 * The shared promise is that a mistyped or stale link *says so* rather than being
 * redirected to the landing page — a silent redirect reads as "the application
 * ignored what I typed" and hides the cause — and that the shell around it stays
 * usable. How the address is written differs (hash routing on v1.0.0, real paths on
 * the console), so both come from `support/ia.ts`.
 */
test.describe("unknown routes", () => {
  test("renders the not-found view inside an intact shell", async ({
    page,
    ia,
  }) => {
    await signIn(page);
    await page.goto(ia.notFound.route);

    await expect(
      page.getByRole("heading", { name: "页面不存在" }),
    ).toBeVisible();
    // The address is echoed back as the user would read it.
    await expect(
      page.getByText(ia.notFound.echo, { exact: true }),
    ).toBeVisible();

    // Header, navigation and the session control survive the unknown route.
    await expect(page.getByRole("banner")).toContainText("智能车队监控平台");
    for (const link of ia.navLinks) {
      await expect(
        page.getByRole("link", { name: link }),
        `nav link ${String(link)}`,
      ).toBeVisible();
    }

    await page.getByRole("link", { name: ia.notFound.backLink }).click();
    await expect(
      page.getByRole("heading", { name: ia.landing.heading }).first(),
    ).toBeVisible();
  });
});
