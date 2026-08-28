import type { Page } from "@playwright/test";
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

  /**
   * Distance in CSS pixels from the selected vehicle's pose to the centre of the
   * ROS panel. `.ros-marker-core` is the circle drawn exactly on the pose — the
   * marker *group* also spans a heading indicator and a label, so its bounding
   * box centre is not the pose and would report a constant false offset.
   */
  const poseOffsetFromPanelCentre = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const svg = document.querySelector(".map-surface svg");
      const core = svg?.querySelector(".ros-marker.fusion .ros-marker-core");
      if (!svg || !core) {
        throw new Error(
          "ROS map or the selected vehicle's marker is not rendered",
        );
      }
      const panel = svg.getBoundingClientRect();
      const marker = core.getBoundingClientRect();
      return Math.hypot(
        marker.left + marker.width / 2 - (panel.left + panel.width / 2),
        marker.top + marker.height / 2 - (panel.top + panel.height / 2),
      );
    });

  test("the ROS map opens centred on the selected vehicle", async ({
    page,
  }) => {
    // The map used to open on the whole scene, leaving the vehicle wherever it
    // happened to fall — measured 276px off-centre, 59px from the panel edge —
    // so the first thing an operator did was hunt for it and click 定位车辆.
    await page.getByRole("button", { name: "ROS", exact: true }).click();
    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();

    expect(await poseOffsetFromPanelCentre(page)).toBeLessThan(24);
  });

  test("the ROS view and its framing survive a reload", async ({ page }) => {
    const rosMap = page.getByRole("img", { name: "ROS 场景地图" });
    await page.getByRole("button", { name: "ROS", exact: true }).click();
    await expect(rosMap).toBeVisible();

    await page.reload();

    // The surface used to reset to GPS on every refresh, and the framing used to
    // drift further off-centre with each one.
    await expect(rosMap).toBeVisible();
    expect(await poseOffsetFromPanelCentre(page)).toBeLessThan(24);
  });

  test("适应场景 frames the scene rather than the vehicle", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "ROS", exact: true }).click();
    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();

    await page.getByRole("button", { name: "适应场景" }).click();

    // Guards the Phase 9 fix in the other direction: this button must keep
    // meaning "fit the whole scene", so the vehicle is no longer centred.
    expect(await poseOffsetFromPanelCentre(page)).toBeGreaterThan(24);
  });
});
