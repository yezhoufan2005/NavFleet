/**
 * README screenshot capture — NOT part of the CI e2e suite.
 *
 * Run with `npm run screenshots` (which loads `e2e/screenshots.config.ts`, a
 * separate config so this never joins the graded suite). It boots the same real
 * backend + real console dev server the e2e harness uses — no MongoDB, no MQTT
 * broker — seeds the demo fleet over `POST /api/debug/ingest`, then walks the
 * console page by page and writes a PNG per view into `docs/screenshots/`.
 *
 * These are documentation artifacts, so this file deliberately does NOT use the
 * `browserIssues` guard from `support/fixtures.ts`: a screenshot run should not
 * fail because a page logged a benign console warning. Correctness of the pages
 * themselves is what the real `console-*` specs are for.
 *
 * Some pages render an honest empty/degraded state here because the harness has
 * no MongoDB (reports aggregate from `telemetry_ts`; system-status shows Mongo
 * as 未连接). That is the real UI for that state, captured truthfully.
 */

import { test, expect, chromium } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, CONSOLE_URL, REPO_ROOT, THEME_KEY } from "../support/harness";
import { buildSeedFrames, SEEDED_DEVICES } from "../support/seed";

const OUT_DIR = join(REPO_ROOT, "docs", "screenshots");
const [firstDevice] = SEEDED_DEVICES;

/** Let the shell settle (fonts, layout, any chart paint) before the shutter. */
const settle = async (page: Page): Promise<void> => {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
};

const shoot = async (page: Page, name: string): Promise<void> => {
  await settle(page);
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
};

/** Sign in through the login form and wait for the monitoring shell. */
const signIn = async (page: Page): Promise<void> => {
  await page.goto("/");
  await page.getByLabel("用户名").fill(ADMIN.username);
  await page.getByLabel("密码").fill(ADMIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
};

test("capture console screenshots for the README", async ({ request }) => {
  mkdirSync(OUT_DIR, { recursive: true });

  // 1) Seed the demo fleet exactly as the e2e suite does.
  const login = await request.post("/api/auth/login", { data: ADMIN });
  expect(login.status(), "admin login for seeding").toBe(200);
  for (const frame of buildSeedFrames()) {
    const res = await request.post("/api/debug/ingest", { data: frame });
    expect(res.status(), `ingest ${frame.deviceId}`).toBe(200);
  }

  // 2) Drive the console in a single desktop context.
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: CONSOLE_URL,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  await signIn(page);
  await shoot(page, "overview");

  await page.goto("/devices");
  await page.getByRole("button", { name: "列表", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await shoot(page, "devices-list");

  await page.getByRole("button", { name: "地图", exact: true }).click();
  await page.getByRole("button", { name: "ROS", exact: true }).click();
  await expect(page.getByRole("img", { name: "ROS 场景地图" })).toBeVisible();
  await page.getByRole("button", { name: "定位车辆" }).click();
  await shoot(page, "devices-map");

  await page.goto(`/devices/${firstDevice.deviceId}`);
  await expect(page.getByRole("tab", { name: "实时" })).toBeVisible();
  await shoot(page, "device-detail");

  await page.goto(`/devices/${firstDevice.deviceId}?tab=charts`);
  await expect(page.getByRole("tab", { name: "曲线" })).toBeVisible();
  await shoot(page, "device-charts");

  await page.goto("/alerts");
  await shoot(page, "alerts");

  await page.goto("/admin/codebook");
  await shoot(page, "admin-codebook");

  // Dark theme (GitHub Primer dark_dimmed): flip the stored preference and
  // reload so useTheme re-reads it at module init.
  await page.evaluate((key) => localStorage.setItem(key, "dark"), THEME_KEY);
  await page.goto("/");
  await shoot(page, "overview-dark");

  await context.close();
  await browser.close();
});
