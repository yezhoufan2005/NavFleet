import { expect, signIn, test } from "../support/fixtures";
import {
  SAMPLES_PER_DEVICE,
  SEEDED_DEVICES,
  SEEDED_SCENE,
} from "../support/seed";

const [device] = SEEDED_DEVICES;

test.describe("history playback", () => {
  test("loads the persisted samples for a device and replays them", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("link", { name: "历史回放" }).click();

    await expect(page.getByRole("heading", { name: "轨迹回放" })).toBeVisible();

    await page.getByLabel("设备").selectOption(device.deviceId);
    await page.getByRole("button", { name: "加载轨迹" }).click();

    // Every ingested frame comes back from the in-memory telemetry buffer.
    await expect(
      page.getByText(`1 / ${SAMPLES_PER_DEVICE}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();

    const detail = page
      .getByRole("complementary")
      .filter({ hasText: "采样详情" });
    await expect(
      detail.getByRole("article").filter({ hasText: "融合 X" }),
    ).toContainText(String(device.start.x));
    await expect(
      detail.getByRole("article").filter({ hasText: "场景" }),
    ).toContainText(SEEDED_SCENE.sceneName);

    // Playback advances the cursor and stops on the last sample.
    await page.getByRole("button", { name: "播放" }).click();
    await expect(
      page.getByText(`${SAMPLES_PER_DEVICE} / ${SAMPLES_PER_DEVICE}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "播放" })).toBeVisible();
  });
});
