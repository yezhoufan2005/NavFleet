import { ADMIN } from "../support/harness";
import { expect, signIn, test } from "../support/fixtures";

/**
 * Sign-in, on both frontends.
 *
 * Everything here is behaviour neither frontend gets to change: a wrong password
 * says so and mounts nothing, a right one reaches the shell with the session
 * visible, and signing out puts the login form back. The only per-frontend details
 * are the landing section's names and how sign-out is reached — both from
 * `support/ia.ts`.
 */
test.describe("authentication", () => {
  test("rejects a wrong password and stays on the login form", async ({
    page,
    browserIssues,
  }) => {
    browserIssues.allowHttpFailure(401, /\/api\/auth\/login$/);

    await page.goto("/");
    await expect(page.getByText("请登录以访问车队监控台")).toBeVisible();

    await page.getByLabel("用户名").fill(ADMIN.username);
    await page.getByLabel("密码").fill("wrong-password");
    await page.getByRole("button", { name: "登录" }).click();

    await expect(page.getByText("用户名或密码错误")).toBeVisible();
    // Still the form, and the monitoring shell was never mounted.
    await expect(page.getByLabel("密码")).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });

  test("signs in with valid credentials and reaches the landing page", async ({
    page,
    ia,
  }) => {
    await signIn(page);

    await expect(page.getByRole("banner")).toContainText("智能车队监控平台");
    await expect(page.getByRole("banner")).toContainText(ADMIN.username);
    await expect(page.getByRole("banner")).toContainText("管理员");
    await expect(
      page.getByRole("link", { name: ia.landing.link, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: ia.landing.heading }).first(),
    ).toBeVisible();
  });

  test("logout returns to the login form", async ({ page, ia }) => {
    await signIn(page);

    await ia.signOut(page);

    await expect(page.getByRole("button", { name: "登录" })).toBeVisible();
    await expect(page.getByText("请登录以访问车队监控台")).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
  });
});
