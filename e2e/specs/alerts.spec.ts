import { expect, signIn, test } from "../support/fixtures";
import { SEEDED_DEVICES } from "../support/seed";

const [noticeDevice, warningDevice, criticalDevice] = SEEDED_DEVICES;

test.describe("alerts centre", () => {
  test("lists the alerts derived from the seeded report codes", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("link", { name: "告警中心" }).click();

    await expect(page.getByRole("heading", { name: "告警中心" })).toBeVisible();
    // One alert per non-zero report code across the seeded fleet.
    await expect(page.getByRole("article")).toHaveCount(SEEDED_DEVICES.length);

    const critical = page.getByRole("article").filter({ hasText: "告警报码" });
    await expect(critical).toContainText("严重");
    await expect(critical).toContainText(criticalDevice.deviceName);
    await expect(critical).toContainText(
      String(criticalDevice.errorCode?.info),
    );
    await expect(critical).toContainText(
      `报码 ${criticalDevice.errorCode?.code}`,
    );

    const warning = page.getByRole("article").filter({ hasText: "预警报码" });
    await expect(warning).toContainText("预警");
    await expect(warning).toContainText(warningDevice.deviceName);

    const notice = page.getByRole("article").filter({ hasText: "提示报码" });
    await expect(notice).toContainText("提示");
    await expect(notice).toContainText(noticeDevice.deviceName);
  });

  test("filtering by severity narrows the list to that severity", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("link", { name: "告警中心" }).click();

    await page.getByRole("button", { name: /^严重/ }).click();

    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article")).toContainText(
      criticalDevice.deviceName,
    );
  });
});
