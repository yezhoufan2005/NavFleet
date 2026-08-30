import type { Page } from "@playwright/test";
import { expect, signIn, test } from "../support/fixtures";

/**
 * Chart performance baseline.
 *
 * ROADMAP 12D asks for a *measured* basis for the eventual "keep ECharts or move to
 * uPlot" decision, and this is it: the real component, in a real browser, on the
 * canvas renderer, driven through the development-only harness at
 * `/__charts-perf` (see `views/ChartPerfView.vue` for why that route is safe).
 *
 * The assertions are on deterministic quantities only — series count, point count,
 * a canvas actually present. **Wall-clock is printed, never asserted.** That is the
 * same shape as the Phase 10 virtualisation baseline, for the same reason: a timing
 * assertion on shared CI hardware fails for reasons that have nothing to do with the
 * code, and a test that cries wolf gets deleted. The printed numbers are the record;
 * a human compares them across runs.
 */
const CASES: readonly { series: number; pointsPer: number }[] = [
  { series: 1, pointsPer: 500 },
  { series: 6, pointsPer: 500 },
  { series: 6, pointsPer: 2000 },
  { series: 8, pointsPer: 5000 },
];

/**
 * Open the harness and wait until it can actually be driven.
 *
 * The view is lazy-loaded, so `window.__chartPerf` appears a tick after the
 * navigation resolves. Calling `load` before then is a silent no-op — the chart never
 * renders, and the failure surfaces much later as "the toggle button does not exist",
 * which is a confusing way to learn about a race.
 */
const openHarness = async (page: Page): Promise<void> => {
  await page.goto("/__charts-perf");
  await expect(
    page.getByRole("heading", { name: "图表性能基线（非产品页面）" }),
  ).toBeVisible();
  await page.waitForFunction(() => window.__chartPerf !== undefined);
};

test.describe("chart performance baseline", () => {
  test("renders every size on the scale, and reports how long each took", async ({
    page,
  }) => {
    await signIn(page);
    /**
     * Reduced motion, and this is not incidental — the first run of this test
     * measured 500 points at 25ms and 3,000 points at 1,024ms, which is not a
     * plausible curve. The cause: ECharts fires `finished` after the *entrance
     * animation*, whose default duration is ~1s, so the numbers were reporting an
     * animation constant we chose rather than the drawing cost. Emulating reduced
     * motion makes `useChartTheme` turn animation off, so what is left is the draw.
     * It also exercises the reduced-motion path for free.
     */
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openHarness(page);

    const rendered = page.getByTestId("perf-render");
    const measured: string[] = [];

    for (const size of CASES) {
      await page.evaluate(
        ([seriesCount, pointsPer]) =>
          window.__chartPerf?.load(seriesCount as number, pointsPer as number),
        [size.series, size.pointsPer],
      );

      // The harness prints the duration only once ECharts reports it has finished
      // drawing, so waiting for a number is waiting for a completed render.
      await expect(rendered).not.toHaveText("—");

      const total = size.series * size.pointsPer;
      await expect(page.getByTestId("perf-series")).toHaveText(
        String(size.series),
      );
      await expect(page.getByTestId("perf-points")).toHaveText(String(total));
      // A canvas, not an SVG: the baseline is only meaningful for the renderer we
      // actually ship.
      await expect(
        page.locator("[data-testid='chart-surface'] canvas"),
      ).toHaveCount(1);

      measured.push(
        `  ${String(size.series).padStart(2)} series x ${String(size.pointsPer).padStart(5)} pts ` +
          `(${String(total).padStart(6)} total): ${await rendered.textContent()} ms`,
      );
    }

    console.log(
      `\nchart render baseline (canvas, ECharts):\n${measured.join("\n")}\n`,
    );
  });

  test("the table view is reachable and carries the values", async ({
    page,
  }) => {
    // The relief channel the palette's contrast WARN obliges. It is asserted here as
    // well as in the unit tests because "reachable in a browser" and "renders in
    // jsdom" are different claims.
    await signIn(page);
    await openHarness(page);
    await page.evaluate(() => window.__chartPerf?.load(2, 20));

    await page.getByRole("button", { name: "看数据表" }).click();

    await expect(page.getByRole("table")).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "设备 1 (%)" }),
    ).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(21); // header + 20 samples
  });
});
