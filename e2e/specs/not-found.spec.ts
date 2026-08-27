import { expect, signIn, test } from "../support/fixtures";

const BOGUS_ROUTE = "/#/no-such-page";

test.describe("unknown routes", () => {
  test("renders the not-found view inside an intact shell", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(BOGUS_ROUTE);

    await expect(
      page.getByRole("heading", { name: "页面不存在" }),
    ).toBeVisible();
    // The address is echoed back as typed, hash included.
    await expect(
      page.getByText("#/no-such-page", { exact: true }),
    ).toBeVisible();

    // Header, navigation and the session chip survive the unknown route.
    await expect(page.getByRole("banner")).toContainText("智能车队监控平台");
    await expect(
      page.getByRole("link", { name: "实时监控", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "历史回放" })).toBeVisible();
    await expect(page.getByRole("link", { name: "告警中心" })).toBeVisible();

    await page.getByRole("link", { name: "返回实时监控" }).click();
    await expect(page.getByRole("heading", { name: "地图视图" })).toBeVisible();
  });
});
