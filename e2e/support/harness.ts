/**
 * Shared constants for the end-to-end harness.
 *
 * The suite drives the real backend and the real vite dev server, but needs
 * neither MongoDB nor an MQTT broker: the backend degrades to its in-memory
 * telemetry/alert/user fallbacks when both are unreachable, and the fleet is
 * seeded over `POST /api/debug/ingest` (see `specs/fleet.setup.ts`) instead of
 * being published to a broker.
 *
 * The vite dev server — not `vite preview` — serves the UI, because only the dev
 * server proxies `/api`, `/ws`, `/health` and `/scene-maps` to the backend
 * (frontend/vite.config.js).
 */

import { randomBytes } from "node:crypto";
import path from "node:path";

/** Repo root, resolved from `e2e/support/`. Both web servers run from here. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Dedicated ports, deliberately not the 3000/5173 a developer's `npm run dev`
 * occupies. The suite mints throw-away credentials per run (below), so a server
 * it did not start cannot authenticate its requests — reusing a dev backend
 * produced a baffling 401 during seeding. Separate ports let the suite run
 * alongside a dev session instead, and make a leftover listener a clear port
 * conflict rather than a silent credential mismatch.
 */
export const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 3199);
export const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5299);
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;

/**
 * Per-run throw-away credentials.
 *
 * Generated rather than hardcoded so no credential-shaped literal is ever
 * committed (secret scanners rightly flag those, and a checked-in JWT secret is
 * a bad example to copy). The value is created once in the Playwright main
 * process while the config loads, then published on `process.env` — the spawned
 * servers get it through their explicit env, and worker processes inherit it, so
 * every part of a run agrees on the same secret.
 */
const perRunSecret = (name: string, bytes: number): string => {
  const existing = process.env[name];
  if (existing) {
    return existing;
  }
  const value = randomBytes(bytes).toString("hex");
  process.env[name] = value;
  return value;
};

/** Throw-away administrator seeded by the backend on startup. */
export const ADMIN = {
  username: "admin",
  password: perRunSecret("E2E_ADMIN_PASSWORD", 18),
};

const JWT_SECRET = perRunSecret("E2E_JWT_SECRET", 32);

/**
 * Backend environment. Everything that would otherwise reach outside the test
 * process is pointed at port 1 (nothing listens there, and the connection is
 * refused immediately): that keeps the in-memory fallbacks active and stops a
 * developer's local MongoDB / MQTT broker from feeding extra devices into a run.
 */
export const backendEnv: Record<string, string> = {
  NODE_ENV: "test",
  PORT: String(BACKEND_PORT),
  LOG_LEVEL: "warn",
  CONFIG_ROOT_PATH: path.join(REPO_ROOT, "config-runtime"),
  MONGO_URI: "mongodb://127.0.0.1:1/navfleet_e2e",
  MQTT_URL: "mqtt://127.0.0.1:1",
  SEED_FILE: "",
  AUTH_ENABLED: "true",
  JWT_SECRET,
  ADMIN_USERNAME: ADMIN.username,
  ADMIN_PASSWORD: ADMIN.password,
  COOKIE_SECURE: "false",
  // Cheaper than the production default so the admin seed and each login do not
  // spend ~0.7s in pure-JS bcrypt; still a real hash+verify round trip.
  BCRYPT_ROUNDS: "6",
  DEBUG_INGEST_ENABLED: "true",
  METRICS_ENABLED: "true",
  // The suite outlives the 60s default. Letting seeded devices age out mid-run
  // would flip their status to 离线 and raise extra critical alerts.
  OFFLINE_AFTER_SECONDS: "86400",
};

/**
 * Frontend environment. A developer's `frontend/.env` may carry a real AMap key,
 * which makes the GPS panel pull the AMap SDK over the network — behaviour that
 * differs from CI (no `.env` there) and adds console noise. Blanking both keys
 * pins the panel to its "no key configured" placeholder everywhere.
 *
 * `BACKEND_ORIGIN` points the dev-server proxy at this run's backend rather than
 * the 3000 default (see vite.config.js).
 */
export const frontendEnv: Record<string, string> = {
  VITE_AMAP_KEY: "",
  VITE_AMAP_SECURITY_JS_CODE: "",
  BACKEND_ORIGIN: BACKEND_URL,
};
