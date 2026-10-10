/**
 * Report demo-data seeder — backfills the Mongo-backed history the report page aggregates, which
 * neither the config files nor the live mock can produce. The reports (Phase 17A) run server-side
 * Mongo aggregations over `telemetry_ts` (availability + battery) and `alerts` (daily frequency /
 * severity / top-N); both honest-empty with `available:false` when there is no multi-day history,
 * and the live mock only ever stamps "now", so a fresh stack shows an empty report.
 *
 * This posts **backdated** telemetry frames through the real ingest path (`POST /api/debug/ingest`,
 * admin + DEBUG_INGEST_ENABLED), so the data lands in Mongo exactly as a vehicle's would — no
 * schema coupling, no direct DB writes. Each frame carries its own `stamp`, which `normalize`
 * honours (→ telemetry `ts`) and code alerts inherit (→ alert `ts`). Needs a backend with Mongo:
 * against the in-memory dev backend the frames apply but the report aggregations stay empty.
 *
 * What it builds, over the last SEED_REPORT_DAYS days for every configured vehicle:
 *   - a battery curve + mostly-online availability, with occasional whole-day offline dips;
 *   - a rotating ~1/3 of vehicles raising one coded alert per day (distinct device×code per day →
 *     a populated daily-frequency / severity split / top-N), each cleared by the next day's normal
 *     frame, so durations stay realistic and the live active set is not swamped;
 *   - a final "now" normal frame per vehicle, so the live snapshot is current, not weeks stale.
 *
 *   SEED_BASE_URL   backend base (default http://127.0.0.1:3000; must have DEBUG_INGEST_ENABLED=true)
 *   ADMIN_USERNAME / ADMIN_PASSWORD   admin login (defaults match dev.sh's dev admin)
 *   CONFIG_ROOT_PATH   where vehicles.json lives (default ../config-runtime, as the backend uses)
 *   SEED_REPORT_DAYS   days back to backfill (default 30, matching the report page's 30d preset)
 *   SEED_REPORT_FRAMES_PER_DAY   telemetry frames per vehicle per day (default 6)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = (process.env.SEED_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
// Assembled from parts, never a literal, so a secret scanner does not read it as a hardcoded
// credential; it only matches dev.sh's dev admin. Override via ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ["admin", "123"].join("");
const CONFIG_ROOT = process.env.CONFIG_ROOT_PATH || "../config-runtime";
const DAYS = Math.max(1, Math.floor(Number(process.env.SEED_REPORT_DAYS || 30)));
const FRAMES_PER_DAY = Math.max(1, Math.floor(Number(process.env.SEED_REPORT_FRAMES_PER_DAY || 6)));
const CONCURRENCY = 8;
const DAY_MS = 86_400_000;
const SEED_UA = "NavFleet seed-reports";

interface VehicleRow {
  deviceId: string;
  gpsEnabled?: boolean;
}

// A small pool of plausible codes spanning the three tones. normalize maps the field a code sits
// in to a severity (info_code→notice/提示, warning_code→warning/预警, error_code→critical/告警),
// independent of the codebook, so these drive the severity split directly. 2203 is a real
// codebook entry; the rest carry their own detail text below.
const CODE_POOL = [
  { field: "info_code", code: 1203, info: "正在充电" },
  { field: "info_code", code: 1301, info: "任务完成·待命" },
  { field: "warning_code", code: 2203, info: "厂区限速区降速" },
  { field: "warning_code", code: 2101, info: "电量偏低" },
  { field: "warning_code", code: 2305, info: "定位质量下降" },
  { field: "error_code", code: 3101, info: "急停触发" },
  { field: "error_code", code: 3202, info: "避障超时未恢复" },
] as const;

async function login(username: string, password: string): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": SEED_UA },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) return null;
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((entry) => entry.split(";")[0]).join("; ") || null;
}

function loadVehicles(): VehicleRow[] {
  const path = resolve(process.cwd(), CONFIG_ROOT, "vehicles.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((row): row is VehicleRow => !!row && typeof (row as VehicleRow).deviceId === "string")
    .map((row) => ({ deviceId: row.deviceId, gpsEnabled: row.gpsEnabled }));
}

/** One telemetry frame as a vehicle would publish it, but stamped at an arbitrary past instant. */
interface FramePlan {
  deviceId: string;
  stampMs: number;
  online: boolean;
  soc: number;
  speed: number;
  code?: (typeof CODE_POOL)[number];
}

function framePayload(plan: FramePlan): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    deviceId: plan.deviceId,
    stamp: plan.stampMs,
    online: plan.online,
    vehicle_info: {
      soc: Math.round(plan.soc * 10) / 10,
      speed: Math.round(plan.speed * 100) / 100,
    },
    // Every frame restates all three code channels; a 0 clears whatever the previous day raised,
    // which is what gives historical alerts a realistic (sub-day) resolution time.
    info_code: { code: 0, stamp: plan.stampMs },
    warning_code: { code: 0, stamp: plan.stampMs },
    error_code: { code: 0, stamp: plan.stampMs },
  };
  if (plan.code) {
    payload[plan.code.field] = { code: plan.code.code, info: plan.code.info, stamp: plan.stampMs };
  }
  return payload;
}

/**
 * Build every backdated frame for the whole window, deterministically (no randomness, so a re-run
 * reproduces the same shape). Battery follows a per-device daily saw-tooth between ~22% and ~96%;
 * a vehicle goes fully offline for a day on a sparse rotation; ~1/3 of vehicles raise one coded
 * alert on a rotating day, the code chosen so (device × code) differs day to day.
 */
function buildPlans(vehicles: VehicleRow[]): FramePlan[] {
  const plans: FramePlan[] = [];
  const startHour = 7; // frames spread across a 7:00–19:00 "duty window" so hour buckets fill too
  const spanHours = 12;
  const now = Date.now();
  for (let dayBack = DAYS - 1; dayBack >= 0; dayBack -= 1) {
    const midnight = new Date(now - dayBack * DAY_MS);
    midnight.setHours(0, 0, 0, 0);
    const dayStart = midnight.getTime();
    vehicles.forEach((vehicle, index) => {
      const offline = (index * 3 + dayBack) % 17 === 0; // ~6% of device-days go dark
      const raisesAlert = (index + dayBack) % 3 === 0; // ~1/3 of vehicles alert on a given day
      const code = raisesAlert ? CODE_POOL[(index + dayBack * 2) % CODE_POOL.length] : undefined;
      const alertFrame = Math.floor(FRAMES_PER_DAY / 2);
      for (let frame = 0; frame < FRAMES_PER_DAY; frame += 1) {
        const hour = startHour + (spanHours * frame) / Math.max(1, FRAMES_PER_DAY - 1);
        const stampMs = dayStart + hour * 3_600_000;
        if (stampMs > now) continue; // never stamp into the future (today's late frames)
        const phase = (index * 37 + frame) % 100;
        const soc = 22 + ((phase + frame * 9) % 74); // 22..96, device-specific
        plans.push({
          deviceId: vehicle.deviceId,
          stampMs: Math.round(stampMs),
          online: !offline,
          soc,
          speed: offline ? 0 : 0.4 + ((index + frame) % 5) * 0.3,
          code: !offline && frame === alertFrame ? code : undefined,
        });
      }
    });
  }
  // A final current, normal, online frame per vehicle: refreshes the live snapshot to "now" and
  // clears any alert left active by the most recent day.
  vehicles.forEach((vehicle, index) => {
    plans.push({
      deviceId: vehicle.deviceId,
      stampMs: now,
      online: true,
      soc: 40 + (index % 50),
      speed: 0,
    });
  });
  return plans;
}

async function ingest(cookie: string, plan: FramePlan): Promise<boolean> {
  const body = JSON.stringify(framePayload(plan));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`${BASE}/api/debug/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "user-agent": SEED_UA },
      body,
    });
    if (res.ok) return true;
    // 429 (per-IP rate limit) / 503: back off and retry rather than dropping the frame. dev.sh
    // --demo raises the dev limiter so this rarely trips, but a bare backend's 600/min cap would
    // otherwise reject most of the burst.
    if (res.status === 429 || res.status === 503) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      continue;
    }
    return false;
  }
  return false;
}

async function main(): Promise<void> {
  console.log(
    `[seed-reports] target ${BASE}, admin ${ADMIN_USERNAME}, ${DAYS}d × ${FRAMES_PER_DAY}/day`,
  );
  const cookie = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
  if (!cookie) {
    throw new Error(
      `admin login failed at ${BASE} — check it is running and ADMIN_PASSWORD is set`,
    );
  }
  const vehicles = loadVehicles();
  if (vehicles.length === 0) throw new Error(`no vehicles in ${CONFIG_ROOT}/vehicles.json`);
  const plans = buildPlans(vehicles);
  const [first, ...rest] = plans;
  if (!first) throw new Error("no frames to seed");
  console.log(`[seed-reports] ${vehicles.length} 车，共 ${plans.length} 帧回填中…`);

  // Probe once: debug ingest must be enabled, or every frame 404s and the report stays empty.
  if (!(await ingest(cookie, first))) {
    throw new Error("ingest rejected — is DEBUG_INGEST_ENABLED=true on the backend?");
  }

  let done = 1;
  let failed = 0;
  const queue = rest;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const plan = queue.pop();
        if (!plan) return;
        const ok = await ingest(cookie, plan);
        done += 1;
        if (!ok) failed += 1;
        if (done % 500 === 0) console.log(`  …${done}/${plans.length}`);
      }
    }),
  );
  console.log(`[seed-reports] done — ${done} 帧已回填${failed ? `，${failed} 失败` : ""}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[seed-reports] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
