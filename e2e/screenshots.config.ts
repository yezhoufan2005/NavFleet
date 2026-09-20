import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import {
  BACKEND_PORT,
  BACKEND_URL,
  CONSOLE_PORT,
  CONSOLE_URL,
  REPO_ROOT,
  backendEnv,
  frontendEnv,
} from "./support/harness";

/**
 * README screenshot capture — deliberately separate from `playwright.config.ts`
 * so it is never part of the graded e2e suite or CI. Run via `npm run
 * screenshots`.
 *
 * It boots only the backend + the v3 console (the frozen frontend is not needed
 * here), against the same in-memory backend the e2e harness uses: no MongoDB,
 * no MQTT broker. The single spec under `./screenshots` seeds the demo fleet
 * itself and writes PNGs into `docs/screenshots/`.
 */
export default defineConfig({
  testDir: "./screenshots",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // Under the already-gitignored test-results/ so run artifacts never get committed.
  outputDir: path.join(REPO_ROOT, "test-results", "screenshots"),
  reporter: [["list"]],
  use: {
    baseURL: CONSOLE_URL,
    trace: "off",
    video: "off",
  },
  projects: [
    {
      name: "screenshots",
      use: { ...devices["Desktop Chrome"], baseURL: CONSOLE_URL },
    },
  ],
  webServer: [
    {
      command: "npx tsx src/index.ts",
      cwd: path.join(REPO_ROOT, "backend"),
      url: `${BACKEND_URL}/health/ready`,
      env: backendEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run dev -w navfleet-console -- --port ${CONSOLE_PORT}`,
      cwd: REPO_ROOT,
      url: CONSOLE_URL,
      env: frontendEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  metadata: {
    ports: { backend: BACKEND_PORT, console: CONSOLE_PORT },
  },
});
