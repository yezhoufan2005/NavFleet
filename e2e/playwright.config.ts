import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import {
  BACKEND_PORT,
  BACKEND_URL,
  CONSOLE_PORT,
  CONSOLE_URL,
  FRONTEND_PORT,
  FRONTEND_URL,
  REPO_ROOT,
  backendEnv,
  frontendEnv,
} from "./support/harness";

/**
 * Specs that describe behaviour **both** consoles owe the operator, and therefore
 * run against both. Where the two differ, they consult `support/ia.ts` rather than
 * forking — see that file for why, and for the complete list of differences.
 *
 * This list stopped growing when the switch landed: the v3 console is now the one
 * in service, and its own `console-*` specs cover it page by page. What stays here
 * is what must keep working in **both** — i.e. what the rollback still owes.
 */
const SHARED_SPECS = [/login\.spec\.ts$/, /not-found\.spec\.ts$/];

/** Specs that only make sense against the v3 console. */
const CONSOLE_ONLY = /console-.*\.spec\.ts$/;

/**
 * Escape hatch for a machine whose bundled-browser download will not complete — set
 * `E2E_BROWSER_CHANNEL=chrome` to run against an installed Chrome instead. Left
 * unset everywhere it matters (CI included), so the pinned build stays the one the
 * suite is judged on; this exists only so a stalled download does not mean "cannot
 * verify locally", which has now cost two investigations.
 */
const BROWSER_CHANNEL = process.env.E2E_BROWSER_CHANNEL ?? undefined;

/**
 * End-to-end suite: real backend + real vite dev server, driven through
 * chromium.
 *
 * `@playwright/test` is pinned to an exact version in the root manifest, not a
 * caret range. Playwright downloads a browser build matched to its own version,
 * so a patch bump silently invalidates the local browser cache and every run
 * then fails with "Executable doesn't exist" until someone re-runs
 * `playwright install`. The `e2e` script also installs chromium first (a no-op
 * once cached), so a fresh checkout and a version bump both self-heal. Playwright owns both processes (`webServer` below), so
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
  // The `github` reporter is what makes a CI failure diagnosable at all. Job
  // logs and the uploaded HTML report both need repository admin rights to
  // download, so without it a red E2E job reports nothing beyond "Process
  // completed with exit code 1" — which is exactly the wall an intermittent
  // failure on 2026-08-29 ran into. This reporter emits `::error::` workflow
  // commands, and GitHub turns those into check annotations carrying the spec
  // file, line and assertion message, readable by anyone who can see the repo.
  reporter: [
    ["list"],
    ...(process.env.CI ? ([["github"]] as const) : []),
    [
      "html",
      {
        outputFolder: path.join(REPO_ROOT, "playwright-report"),
        open: "never",
      },
    ],
  ],
  use: {
    // The console, because it is the one compose deploys. A spec that forgets to
    // say which console it means should get the one that is in service — before
    // the switch this defaulted to the v1.0.0 frontend, which now would silently
    // point new specs at the retired half.
    baseURL: CONSOLE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    // Ingests the demo telemetry once, before any spec runs. `fleet.setup.ts`
    // issues relative `/api/...` calls, so it needs a baseURL that proxies to the
    // backend — both consoles' dev servers do. Pinned rather than inherited so a
    // later change to the file-level default cannot silently move the seed.
    {
      name: "seed",
      testMatch: /.*\.setup\.ts/,
      use: { baseURL: CONSOLE_URL },
    },
    {
      // The v1.0.0 frontend. **Retired but kept**: it is no longer what compose
      // deploys (see deploy/docker-compose.legacy-frontend.yml), and its suite
      // runs for exactly one reason — the rollback is only real if this half
      // still works. `@navfleet/fleet-core` is shared, so a change there can
      // break it without touching a single file under `frontend/`. Deleting this
      // project would make the escape hatch rot invisibly.
      name: "frontend",
      // Everything except the console's own specs — the retired frontend keeps
      // its full suite, because a rollback restores all of those pages at once.
      testIgnore: CONSOLE_ONLY,
      use: {
        ...devices["Desktop Chrome"],
        // Overrides the file-level default, which is now the console.
        baseURL: FRONTEND_URL,
        viewport: { width: 1440, height: 900 },
        channel: BROWSER_CHANNEL,
      },
      dependencies: ["seed"],
    },
    {
      /**
       * The v3 console — **the one in service** since the Phase 14 switch.
       *
       * Its spec list stayed shorter than the frontend's, and that is not a gap:
       * the shared specs cover what both consoles owe, the eight `console-*` ones
       * cover this console's own pages, and the frontend's remaining specs assert
       * an IA this console deliberately replaced (see `support/ia.ts`). Pointing
       * them here would test the old information architecture, not this one.
       *
       * Shared specs on the net today: login (3) + unknown routes (1).
       */
      name: "console",
      testMatch: [
        ...SHARED_SPECS,
        /console-shell\.spec\.ts$/,
        /console-accessibility\.spec\.ts$/,
        /console-charts\.spec\.ts$/,
        /console-devices\.spec\.ts$/,
        /console-overview\.spec\.ts$/,
        /console-alerts\.spec\.ts$/,
        /console-playback\.spec\.ts$/,
        /console-admin\.spec\.ts$/,
      ],
      use: {
        ...devices["Desktop Chrome"],
        baseURL: CONSOLE_URL,
        viewport: { width: 1440, height: 900 },
        channel: BROWSER_CHANNEL,
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
    {
      // Both consoles proxy to the same backend, so one seeded fleet serves both.
      command: `npm run dev -w navfleet-console -- --port ${CONSOLE_PORT}`,
      cwd: REPO_ROOT,
      url: CONSOLE_URL,
      env: frontendEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  metadata: {
    ports: {
      backend: BACKEND_PORT,
      frontend: FRONTEND_PORT,
      console: CONSOLE_PORT,
    },
  },
});
