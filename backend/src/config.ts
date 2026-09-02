import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ENV_FILENAMES = [".env.local", ".env"];

const parseEnvValue = (rawValue: string): string => {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n");
  }

  return trimmed;
};

const loadEnvFile = (filePath: string): void => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice(7) : line;
    const separatorIndex = normalizedLine.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = parseEnvValue(normalizedLine.slice(separatorIndex + 1));
  }
};

const loadLocalEnvFiles = (): void => {
  const candidateDirectories = [process.cwd(), path.resolve(process.cwd(), "backend")];

  for (const directory of candidateDirectories) {
    for (const filename of ENV_FILENAMES) {
      loadEnvFile(path.join(directory, filename));
    }
  }
};

const resolveConfigRootPath = (): string => {
  if (process.env.CONFIG_ROOT_PATH) {
    return path.resolve(process.env.CONFIG_ROOT_PATH);
  }

  const candidates = [
    path.resolve(process.cwd(), "config-runtime"),
    path.resolve(process.cwd(), "../config-runtime"),
    path.resolve(__dirname, "../../config-runtime"),
    path.resolve(__dirname, "../../../config-runtime"),
  ];

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) {
    return existing;
  }

  return path.basename(process.cwd()).toLowerCase() === "backend"
    ? path.resolve(process.cwd(), "../config-runtime")
    : path.resolve(process.cwd(), "config-runtime");
};

// Env values are strings; these zod helpers coerce + validate them and FAIL FAST
// on malformed input (e.g. PORT=abc) instead of silently reverting to a default —
// so a typo in a deployment env surfaces at startup rather than as odd behavior.
const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOL_FALSE = new Set(["0", "false", "no", "off"]);

const envBool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return fallback;
      const normalized = value.trim().toLowerCase();
      if (normalized === "") return fallback;
      if (BOOL_TRUE.has(normalized)) return true;
      if (BOOL_FALSE.has(normalized)) return false;
      ctx.addIssue({
        code: "custom",
        message: `expected a boolean (true/false/1/0/yes/no/on/off)`,
      });
      return z.NEVER;
    });

const envInt = (fallback: number, min?: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === "") return fallback;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: "custom", message: `expected a number, received "${value}"` });
        return z.NEVER;
      }
      return min !== undefined ? Math.max(parsed, min) : parsed;
    });

const envStr = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? fallback : value));

const configSchema = z.object({
  PORT: envInt(3000),
  NODE_ENV: envStr("development"),
  LOG_LEVEL: envStr("info"),
  METRICS_ENABLED: envBool(true),
  FLEET_NAME: envStr("智能车队"),
  MQTT_TOPIC_PATTERN: envStr("/fleet/{deviceId}/vehicle_info"),
  MQTT_URL: envStr("mqtt://127.0.0.1:1883"),
  MQTT_USERNAME: envStr(""),
  MQTT_PASSWORD: envStr(""),
  MQTT_CLIENT_ID: z
    .string()
    .optional()
    .transform((value) =>
      value && value !== "" ? value : `fleet-dashboard-${Math.random().toString(16).slice(2, 10)}`,
    ),
  MONGO_URI: envStr("mongodb://127.0.0.1:27017/fleet_monitor"),
  MONGO_DB_NAME: envStr("fleet_monitor"),
  SEED_FILE: envStr(""),
  OFFLINE_AFTER_SECONDS: envInt(60),
  TELEMETRY_RETENTION_SECONDS: envInt(60 * 60 * 24 * 30),
  ALERTS_RETENTION_SECONDS: envInt(60 * 60 * 24 * 180),
  MAX_HISTORY_POINTS: envInt(500),
  MONGO_BUFFER_LIMIT: envInt(2000),
  // P0-b: how many mutations may wait in the store's serial ingest queue before
  // the oldest *sheddable* (i.e. MQTT telemetry) ones are dropped. Sized so that a
  // few seconds of a stalled MongoDB is absorbed rather than shed: at 1 Hz, 1000
  // entries is ~2.5 minutes of a six-vehicle fleet, or ~10 s of a 100-vehicle one.
  INGEST_QUEUE_LIMIT: envInt(1000, 1),
  // P0-d: ceiling on devices held in memory. Devices declared in vehicles.json are
  // exempt (the operator named them); this bounds what arrives from the broker.
  MAX_DEVICES: envInt(1000, 1),
  // P0-d: forget an *undeclared* device after this long without a single frame.
  // 0 disables eviction. A day is well past any live-monitoring interest, and the
  // device's history stays in MongoDB either way.
  DEVICE_RETENTION_SECONDS: envInt(60 * 60 * 24, 0),
  CONFIG_WATCH_USE_POLLING: envBool(false),
  CONFIG_WATCH_DEBOUNCE_MS: envInt(1000, 100),
  AUTH_ENABLED: envBool(true),
  JWT_SECRET: envStr(""),
  JWT_ACCESS_TTL: envStr("15m"),
  JWT_REFRESH_TTL: envStr("7d"),
  BCRYPT_ROUNDS: envInt(10),
  ADMIN_USERNAME: envStr("admin"),
  ADMIN_PASSWORD: envStr(""),
  COOKIE_SECURE: envBool(false),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "http://127.0.0.1:5173,http://localhost:5173")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  DEBUG_INGEST_ENABLED: envBool(false),
  // Number of reverse-proxy hops to trust for the client IP. 0 (the default)
  // means X-Forwarded-For is ignored: a directly exposed backend must not let a
  // client pick its own rate-limit bucket by forging that header. The shipped
  // compose puts one nginx in front and sets 1.
  TRUST_PROXY: envInt(0, 0),
  // Coarse per-IP limit for the whole /api surface, on top of the tighter
  // credential limit on /api/auth. Generous by design: the dashboard's live data
  // arrives over one WebSocket, so a legitimate session issues few REST calls.
  RATE_LIMIT_WINDOW_MS: envInt(60_000, 1_000),
  RATE_LIMIT_MAX: envInt(600, 1),
  // The tighter credential limit on /api/auth. Defaults are the values that used
  // to be hardcoded in app.ts; they are configurable because 50-per-15-minutes is
  // a judgement call about brute-force risk versus a shared-NAT office, and
  // because a test suite that logs in per case has no way to raise a constant.
  AUTH_RATE_LIMIT_WINDOW_MS: envInt(15 * 60_000, 1_000),
  AUTH_RATE_LIMIT_MAX: envInt(50, 1),
});

/**
 * Validate a raw environment into the typed app config. Throws a ZodError with
 * per-field issues on malformed values. Exported for unit testing without the
 * module-level fail-fast side effect.
 */
export const parseConfig = (env: NodeJS.ProcessEnv) => {
  const e = configSchema.parse(env);
  return {
    port: e.PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    metricsEnabled: e.METRICS_ENABLED,
    fleetName: e.FLEET_NAME,
    topicPattern: e.MQTT_TOPIC_PATTERN,
    mqttUrl: e.MQTT_URL,
    mqttUsername: e.MQTT_USERNAME,
    mqttPassword: e.MQTT_PASSWORD,
    mqttClientId: e.MQTT_CLIENT_ID,
    mongoUri: e.MONGO_URI,
    mongoDbName: e.MONGO_DB_NAME,
    seedFile: e.SEED_FILE,
    offlineAfterSeconds: e.OFFLINE_AFTER_SECONDS,
    telemetryRetentionSeconds: e.TELEMETRY_RETENTION_SECONDS,
    alertsRetentionSeconds: e.ALERTS_RETENTION_SECONDS,
    maxHistoryPoints: e.MAX_HISTORY_POINTS,
    mongoBufferLimit: e.MONGO_BUFFER_LIMIT,
    ingestQueueLimit: e.INGEST_QUEUE_LIMIT,
    maxDevices: e.MAX_DEVICES,
    deviceRetentionSeconds: e.DEVICE_RETENTION_SECONDS,
    configRootPath: resolveConfigRootPath(),
    configWatchUsePolling: e.CONFIG_WATCH_USE_POLLING,
    configWatchDebounceMs: e.CONFIG_WATCH_DEBOUNCE_MS,
    authEnabled: e.AUTH_ENABLED,
    jwtSecret: e.JWT_SECRET,
    jwtAccessTtl: e.JWT_ACCESS_TTL,
    jwtRefreshTtl: e.JWT_REFRESH_TTL,
    bcryptRounds: e.BCRYPT_ROUNDS,
    adminUsername: e.ADMIN_USERNAME,
    adminPassword: e.ADMIN_PASSWORD,
    cookieSecure: e.COOKIE_SECURE,
    corsOrigins: e.CORS_ORIGINS,
    debugIngestEnabled: e.DEBUG_INGEST_ENABLED,
    trustProxy: e.TRUST_PROXY,
    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: e.RATE_LIMIT_MAX,
    authRateLimitWindowMs: e.AUTH_RATE_LIMIT_WINDOW_MS,
    authRateLimitMax: e.AUTH_RATE_LIMIT_MAX,
  };
};

export type AppConfig = ReturnType<typeof parseConfig>;

loadLocalEnvFiles();

const loadConfig = (): AppConfig => {
  try {
    return parseConfig(process.env);
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `  ${issue.path.join(".") || "(env)"}: ${issue.message}`)
            .join("\n")
        : String(error);
    console.error(`[config] Invalid environment configuration:\n${detail}`);
    process.exit(1);
  }
};

export const config = loadConfig();

export const runtimePaths = {
  fleetFilePath: path.join(config.configRootPath, "fleet.json"),
  vehiclesFilePath: path.join(config.configRootPath, "vehicles.json"),
  formationsFilePath: path.join(config.configRootPath, "formations.json"),
  scenesFilePath: path.join(config.configRootPath, "scenes.json"),
  sceneMapsPath: path.join(config.configRootPath, "scene-maps"),
};
