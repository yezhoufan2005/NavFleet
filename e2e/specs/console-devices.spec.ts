import { expect, signIn, test } from "../support/fixtures";
import { SEEDED_DEVICES, SEEDED_SCENE } from "../support/seed";

/**
 * The devices page in a real browser, which is the only place three of these things
 * can be checked at all: an SVG that has actually been laid out, a marker whose
 * screen position can be measured, and a preference that survives a real reload.
 *
 * **Why this is a console-only spec rather than `dashboard.spec.ts` joining
 * `SHARED_SPECS`.** The plan said to share that spec, and on inspection that is not
 * possible *or* desirable: it asserts the v1.0.0 layout — `getByRole("article")`
 * cards, a `complementary` panel titled 车辆信息, device rows as buttons in a
 * sidebar — because in v1.0.0 the map was one cell of a single crowded dashboard.
 * The whole point of the IA rebuild is that those are now separate pages. Sharing the
 * spec would force the console to reproduce the layout the rebuild exists to replace.
 *
 * What *is* worth sharing is the behaviour, and the behaviour that matters is
 * asserted here in the same terms: the scene map opens centred on the selected
 * vehicle, and 适应场景 frames the scene instead. Both use the same
 * `.map-surface svg .ros-marker.fusion .ros-marker-core` measurement the old spec
 * uses, so a regression in the ported engine fails in both suites.
 */
const [firstDevice] = SEEDED_DEVICES;

/** Centre-to-centre distance from the map surface's own centre, in CSS pixels. */
const markerOffsetFromCentre = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const svg = document.querySelector(".map-surface svg");
    const core = svg?.querySelector(".ros-marker.fusion .ros-marker-core");
    if (!svg || !core) {
      throw new Error(
        "scene map or the selected vehicle's marker is not rendered",
      );
    }
    const surface = svg.getBoundingClientRect();
    const marker = (core as SVGGraphicsElement).getBoundingClientRect();
    return Math.hypot(
      marker.x + marker.width / 2 - (surface.x + surface.width / 2),
      marker.y + marker.height / 2 - (surface.y + surface.height / 2),
    );
  });

test.describe("console devices", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/devices");
  });

  test("opens on the map for a fleet a map can show", async ({ page }) => {
    // Six seeded vehicles is well under the 40-unit threshold, so `auto` picks the map.
    await expect(page.locator(".map-surface")).toBeVisible();
    await expect(page.getByText("按车队规模自动选择")).toBeVisible();
  });

  test("the scene map opens centred on the selected vehicle", async ({
    page,
  }) => {
    // The defect this guards: opening on the whole scene left the vehicle wherever it
    // happened to be, so the first thing an operator did on every visit was hunt for
    // it and click 定位车辆.
    await page.getByRole("button", { name: "场景", exact: true }).click();
    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();

    expect(await markerOffsetFromCentre(page)).toBeLessThan(24);
  });

  test("适应场景 frames the scene rather than the vehicle", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "场景", exact: true }).click();
    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();
    const focused = await markerOffsetFromCentre(page);

    await page.getByRole("button", { name: "适应场景" }).click();
    // Framing the scene means the vehicle is no longer the thing at the centre.
    expect(await markerOffsetFromCentre(page)).toBeGreaterThan(focused);

    await page.getByRole("button", { name: "定位车辆" }).click();
    expect(await markerOffsetFromCentre(page)).toBeLessThan(24);
  });

  test("the scene map names the scene and its overlays", async ({ page }) => {
    await page.getByRole("button", { name: "场景", exact: true }).click();
    const map = page.locator(".map-surface");

    await expect(map).toContainText(SEEDED_SCENE.sceneName);
    await expect(map.getByText("路网覆盖")).toBeVisible();
  });

  test("the chosen view and surface both survive a reload", async ({
    page,
  }) => {
    // Two independent preferences, which 13A-1's note had conflated into one.
    await page.getByRole("button", { name: "场景", exact: true }).click();
    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();

    await page.getByRole("button", { name: "列表", exact: true }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText("按车队规模自动选择")).toBeHidden();

    await page.reload();
    await expect(page.getByRole("table")).toBeVisible();

    // Back to the map, and it is the surface that was chosen, not the default.
    await page.getByRole("button", { name: "地图", exact: true }).click();
    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();
  });

  test("the list carries every seeded vehicle and its status", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "列表", exact: true }).click();

    for (const device of SEEDED_DEVICES) {
      await expect(
        page.getByRole("row").filter({ hasText: device.deviceName }),
      ).toContainText(device.statusLabel);
    }
  });

  test("picking a vehicle in the list selects it for the map", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "列表", exact: true }).click();
    await page.getByRole("button", { name: firstDevice!.deviceName }).click();

    await page.getByRole("button", { name: "地图", exact: true }).click();
    await page.getByRole("button", { name: "场景", exact: true }).click();
    await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();

    expect(await markerOffsetFromCentre(page)).toBeLessThan(24);
  });
});
