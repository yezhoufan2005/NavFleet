/**
 * Report demo-data seeder (dev.sh --demo) — backfills the Mongo-backed history the report page and
 * 消息史 aggregate, which neither the config files nor the live mock can produce (the mock only ever
 * stamps "now").
 *
 * The history itself comes from `scripts/demo-history.js`, the same generator `verify-stack.sh`
 * pipes into the compose stack's mongosh, so dev and verify show the same fleet story: per-vehicle-
 * profile battery and duty cycles, maintenance windows and comm dropouts, and messages shaped like
 * a real site's — one document per occurrence, with durations, causes and on-shift
 * acknowledgements. Written straight to MongoDB (minute-resolution frames for a whole fleet are
 * millions of documents; replaying them through HTTP ingest would take hours and trip rate limits).
 *
 * Replaces previously seeded history: telemetry and *closed* messages are cleared first; the live
 * active set (whatever the mock is reporting right now) is left alone.
 *
 *   MONGO_URI          the dev Mongo (dev.sh exports it for --demo)
 *   CONFIG_ROOT_PATH   where vehicles.json / rules.json live (default ../config-runtime)
 *   SEED_REPORT_DAYS   days back to backfill (default 30, the report page's widest preset)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient } from "mongodb";

interface DemoVehicle {
  deviceId: string;
  category?: string;
  maxLoadKg?: number;
  model?: string;
}
interface DemoHistory {
  telemetry: Record<string, unknown>[];
  alerts: Record<string, unknown>[];
}
type DemoDeviceHistory = (
  vehicle: DemoVehicle,
  index: number,
  options: { now: number; days: number; offlineAfterSeconds: number; tailMinutes: number },
) => DemoHistory;

// A CommonJS module (shared verbatim with mongosh, which cannot import), loaded with require.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { demoDeviceHistory } = require("../../scripts/demo-history.js") as {
  demoDeviceHistory: DemoDeviceHistory;
};

const MONGO_URI = process.env.MONGO_URI || "";
const CONFIG_ROOT = process.env.CONFIG_ROOT_PATH || "../config-runtime";
const DAYS = Math.max(1, Math.floor(Number(process.env.SEED_REPORT_DAYS || 30)));
const BATCH = 10_000;

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(resolve(process.cwd(), CONFIG_ROOT, file), "utf8")) as unknown;

function loadVehicles(): DemoVehicle[] {
  const raw = readJson("vehicles.json");
  return (Array.isArray(raw) ? raw : []).filter(
    (row): row is DemoVehicle => !!row && typeof (row as DemoVehicle).deviceId === "string",
  );
}

/** The offline threshold in effect, so seeded 设备离线 occurrences match what the backend raises. */
function offlineAfterSeconds(): number {
  try {
    const rules = readJson("rules.json") as { offline?: { afterSeconds?: unknown } };
    const seconds = Number(rules.offline?.afterSeconds);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  } catch {
    // No rules.json: the backend's own default.
  }
  return Number(process.env.OFFLINE_AFTER_SECONDS) || 60;
}

async function main(): Promise<void> {
  if (!MONGO_URI) {
    throw new Error(
      "MONGO_URI is not set — run through `scripts/dev.sh --demo`, which starts a dev Mongo",
    );
  }
  const vehicles = loadVehicles();
  if (vehicles.length === 0) throw new Error(`no vehicles in ${CONFIG_ROOT}/vehicles.json`);

  const client = await MongoClient.connect(MONGO_URI, { serverSelectionTimeoutMS: 5_000 });
  try {
    const db = client.db();
    const now = Date.now();
    const threshold = offlineAfterSeconds();
    console.log(`[seed-reports] ${vehicles.length} 车 × ${DAYS} 天，离线阈值 ${threshold}s`);

    await db.collection("telemetry_ts").deleteMany({});
    await db.collection("alerts").deleteMany({ active: false });

    let frames = 0;
    let messages = 0;
    for (const [index, vehicle] of vehicles.entries()) {
      const history = demoDeviceHistory(vehicle, index, {
        now,
        days: DAYS,
        offlineAfterSeconds: threshold,
        tailMinutes: 5,
      });
      for (let start = 0; start < history.telemetry.length; start += BATCH) {
        await db
          .collection("telemetry_ts")
          .insertMany(history.telemetry.slice(start, start + BATCH), { ordered: false });
      }
      if (history.alerts.length) {
        await db.collection("alerts").insertMany(history.alerts, { ordered: false });
      }
      frames += history.telemetry.length;
      messages += history.alerts.length;
    }
    console.log(`[seed-reports] done — ${frames} 帧遥测，${messages} 条消息`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[seed-reports] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
