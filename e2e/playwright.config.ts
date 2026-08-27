import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import {
  BACKEND_PORT,
  BACKEND_URL,
  FRONTEND_PORT,
  FRONTEND_URL,
  REPO_ROOT,
  backendEnv,
  frontendEnv,
} from "./support/harness";

/**
 * End-to-end suite: real backend + real vite dev server, driven through
 * chromium. Playwright owns both processes (`webServer` below), so
 * `npm run e2e` works from a clean checkout with no MongoDB and no MQTT broker
 * running — see `support/harness.ts` for why that is safe.
 *
 * Serial by design: the two servers hold shared state (one in-memory fleet), so
 * parallel workers would race over the seeded devices.
 */
export default defineConfig({
  testDir: "./specs",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // Kept at the repo root so CI can archive them with a stable path.
  outputDir: path.join(REPO_ROOT, "test-results"),
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.join(REPO_ROOT, "playwright-report"),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: FRONTEND_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    // Ingests the demo telemetry once, before any spec runs.
    { name: "seed", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
      dependencies: ["seed"],
    },
  ],
  webServer: [
    {
      // `npx tsx src/index.ts` rather than the workspace `dev` script: no file
      // watcher to restart the fleet state mid-run.
      command: "npx tsx src/index.ts",
      cwd: path.join(REPO_ROOT, "backend"),
      url: `${BACKEND_URL}/health/ready`,
      env: backendEnv,
      // Never reuse: this run's throw-away credentials only exist in a server
      // this run started (see support/harness.ts).
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The dev server, not `vite preview`: only dev proxies /api, /ws, /health
      // and /scene-maps to the backend. The trailing --port wins over the one in
      // the workspace `dev` script.
      command: `npm run dev -w navfleet-frontend -- --port ${FRONTEND_PORT}`,
      cwd: REPO_ROOT,
      url: FRONTEND_URL,
      env: frontendEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  metadata: { ports: { backend: BACKEND_PORT, frontend: FRONTEND_PORT } },
});
