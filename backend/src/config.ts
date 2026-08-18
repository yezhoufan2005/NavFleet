import fs from "node:fs";
import path from "node:path";

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

loadLocalEnvFiles();

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
};

export const config = {
  port: toNumber(process.env.PORT, 3000),
  fleetName: process.env.FLEET_NAME || "多车监控平台",
  topicPattern: process.env.MQTT_TOPIC_PATTERN || "/fleet/{deviceId}/vehicle_info",
  mqttUrl: process.env.MQTT_URL || "mqtt://127.0.0.1:1883",
  mqttUsername: process.env.MQTT_USERNAME || "",
  mqttPassword: process.env.MQTT_PASSWORD || "",
  mqttClientId: process.env.MQTT_CLIENT_ID || `fleet-dashboard-${Math.random().toString(16).slice(2, 10)}`,
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fleet_monitor",
  mongoDbName: process.env.MONGO_DB_NAME || "fleet_monitor",
  seedFile: process.env.SEED_FILE || "",
  offlineAfterSeconds: toNumber(process.env.OFFLINE_AFTER_SECONDS, 60),
  telemetryRetentionSeconds: toNumber(process.env.TELEMETRY_RETENTION_SECONDS, 60 * 60 * 24 * 30),
  alertsRetentionSeconds: toNumber(process.env.ALERTS_RETENTION_SECONDS, 60 * 60 * 24 * 180),
  maxHistoryPoints: toNumber(process.env.MAX_HISTORY_POINTS, 500),
  mongoBufferLimit: toNumber(process.env.MONGO_BUFFER_LIMIT, 2000),
  configRootPath: resolveConfigRootPath(),
  configWatchUsePolling: toBoolean(process.env.CONFIG_WATCH_USE_POLLING, false),
  configWatchDebounceMs: Math.max(toNumber(process.env.CONFIG_WATCH_DEBOUNCE_MS, 1000), 100),
};

export const runtimePaths = {
  fleetFilePath: path.join(config.configRootPath, "fleet.json"),
  vehiclesFilePath: path.join(config.configRootPath, "vehicles.json"),
  formationsFilePath: path.join(config.configRootPath, "formations.json"),
  scenesFilePath: path.join(config.configRootPath, "scenes.json"),
  sceneMapsPath: path.join(config.configRootPath, "scene-maps"),
};
