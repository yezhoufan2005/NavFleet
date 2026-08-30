import { expect, signIn, test } from "../support/fixtures";
import {
  SAMPLES_PER_DEVICE,
  SEEDED_DEVICES,
  SEEDED_SCENE,
} from "../support/seed";

/**
 * History playback in a real browser.
 *
 * **Why this is a console-only spec rather than `history.spec.ts` joining
 * `SHARED_SPECS`.** That spec asserts v1.0.0's page: a device `<select>` labelled 设备,
 * a 加载轨迹 button you must press, and a `complementary` panel of `article` cells. All
 * three are gone on purpose — the device comes from the route, the window loads on
 * arrival, and the panel is a definition list inside the tab. Sharing the spec would
 * force the console to rebuild the page the IA rebuild exists to replace.
 *
 * What is worth sharing is the behaviour, and it is asserted here in the same terms:
 * the persisted samples come back, the map draws the frame under the cursor, and
 * playback walks to the end and stops.
 */
const [device] = SEEDED_DEVICES;

/** The tab is in the URL, which is the whole reason a playback can be linked. */
const PLAYBACK_URL = `/devices/${device.deviceId}?tab=playback`;

test.describe("console playback", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("opens straight from a URL and has already loaded the window", async ({
    page,
  }) => {
    // Two v1.0.0 dead ends in one assertion: the page opened empty, and getting here
    // meant picking a vehicle you had just been looking at.
    await page.goto(PLAYBACK_URL);

    await expect(
      page.getByRole("tab", { name: "历史回放", selected: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`1 / ${SAMPLES_PER_DEVICE}`, { exact: true }),
    ).toBeVisible();
    // No button was pressed, and the span actually covered is stated rather than the
    // number of points requested.
    await expect(
      page.getByText(`已载入 ${SAMPLES_PER_DEVICE} 条采样`),
    ).toBeVisible();
  });

  test("draws the frame under the cursor on the scene map", async ({
    page,
  }) => {
    await page.goto(PLAYBACK_URL);

    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();
    const detail = page.locator("section", { hasText: "采样详情" });
    await expect(detail).toContainText(String(device.start.x));
    await expect(detail).toContainText(SEEDED_SCENE.sceneName);
  });

  test("walks to the last sample and stops there", async ({ page }) => {
    await page.goto(PLAYBACK_URL);
    await page.getByRole("button", { name: "播放" }).click();

    await expect(
      page.getByText(`${SAMPLES_PER_DEVICE} / ${SAMPLES_PER_DEVICE}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 20_000 });
    // Back to 播放 on arrival — v1.0.0 stayed on 暂停 until the following tick.
    await expect(page.getByRole("button", { name: "播放" })).toBeVisible();
  });

  test("keeps the playback controls named, and the trail behind the cursor", async ({
    page,
  }) => {
    // The slider and the speed control carry no visible label by design, so their
    // accessible names are the only ones they have — the axe critical Phase 10 found.
    await page.goto(PLAYBACK_URL);

    const progress = page.getByLabel("回放进度");
    await expect(progress).toBeVisible();
    await expect(page.getByLabel("回放速度")).toBeVisible();

    // Scrubbing to the end draws the whole track; the trail is one path, and it only
    // exists once there is more than a single pose behind the cursor.
    await progress.fill(String(SAMPLES_PER_DEVICE - 1));
    await expect(
      page.getByText(`${SAMPLES_PER_DEVICE} / ${SAMPLES_PER_DEVICE}`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator(".map-surface svg path.device-trail.selected"),
    ).toBeVisible();
  });

  test("switching tabs is a link, not a step", async ({ page }) => {
    await page.goto(`/devices/${device.deviceId}`);
    await expect(
      page.getByRole("tab", { name: "实时", selected: true }),
    ).toBeVisible();

    await page.getByRole("tab", { name: "历史回放" }).click();
    await expect(page).toHaveURL(new RegExp(`tab=playback$`));

    // And it survives a reload, because the tab is state the URL owns.
    await page.reload();
    await expect(
      page.getByRole("tab", { name: "历史回放", selected: true }),
    ).toBeVisible();
  });
});
