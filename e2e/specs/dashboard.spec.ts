import { expect, signIn, test } from "../support/fixtures";
import { SEEDED_DEVICES, SEEDED_SCENE } from "../support/seed";

const [firstDevice, , faultedDevice] = SEEDED_DEVICES;

test.describe("dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("lists every seeded device with its configured name and status", async ({
    page,
  }) => {
    for (const device of SEEDED_DEVICES) {
      const row = page.getByRole("button", { name: device.deviceName });
      await expect(row).toBeVisible();
      await expect(row).toContainText(device.statusLabel);
    }

    await expect(
      page.getByRole("article").filter({ hasText: "在线设备" }),
    ).toContainText(`${SEEDED_DEVICES.length} / ${SEEDED_DEVICES.length}`);
  });

  test("selecting a device shows its telemetry in the detail panel", async ({
    page,
  }) => {
    // The store auto-selects the first device, so pick another one to prove the
    // panel follows the selection.
    await page.getByRole("button", { name: faultedDevice.deviceName }).click();

    const detail = page
      .getByRole("complementary")
      .filter({ hasText: "车辆信息" });
    await expect(
      detail.getByRole("heading", { name: faultedDevice.deviceName }),
    ).toBeVisible();
    await expect(detail).toContainText(faultedDevice.deviceId);
    await expect(detail).toContainText(String(faultedDevice.errorCode?.code));
    await expect(detail).toContainText(String(faultedDevice.errorCode?.info));
    // Seeded poses reach the ROS section rather than falling back to "无数据".
    await expect(detail.getByText("已定位").first()).toBeVisible();
  });

  test("the map toggle switches between the GPS and ROS views", async ({
    page,
  }) => {
    const rosMap = page.getByRole("img", { name: "ROS 场景地图" });
    // GPS is the default mode.
    await expect(rosMap).toBeHidden();
    await expect(
      page.getByRole("article").filter({ hasText: "当前场景" }),
    ).toContainText(SEEDED_SCENE.sceneName);

    await page.getByRole("button", { name: "ROS", exact: true }).click();

    await expect(rosMap).toBeVisible();
    // The scene's Lanelet2 road network rendered, and the HUD names the scene.
    await expect(page.getByText("路网覆盖", { exact: true })).toBeVisible();
    await expect(page.getByText(SEEDED_SCENE.sceneName).last()).toBeVisible();

    await page.getByRole("button", { name: "GPS", exact: true }).click();
    await expect(rosMap).toBeHidden();
    await expect(
      page.getByRole("button", { name: firstDevice.deviceName }),
    ).toBeVisible();
  });
});
