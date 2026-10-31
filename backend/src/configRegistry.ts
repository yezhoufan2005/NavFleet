import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { FSWatcher } from "chokidar";
import {
  AlertRulesConfig,
  DEFAULT_ALERT_RULES,
  DEFAULT_NOTIFY_CONFIG,
  DEFAULT_REPORT_CODES,
  DEFAULT_REPORTS_CONFIG,
  NOTIFY_CHANNEL_TYPES,
  NOTIFY_SEVERITIES,
  NotifyChannelConfig,
  NotifyChannelType,
  NotifyConfig,
  NotifyEscalation,
  NotifyRecipient,
  NotifySilenceWindow,
  REPORT_RANGE_PRESETS,
  ReportCodeEntry,
  ReportScheduleConfig,
  ReportsConfig,
  RuleScope,
  Severity,
  codebookOverrides,
  mapFootprintBounds,
  mergeCodebook,
  parseCodebook,
  parseFormations,
  parseScenes,
  parseVehicles,
} from "@navfleet/shared";
import { config, runtimePaths } from "./config";
import { MERGE_SPECS, mergeConfig } from "./configMerge";
import { parseLaneletOsmFile, parseLaneletOsmText } from "./laneletOsm";
import { moduleLogger } from "./logger";
import {
  DeviceConfig,
  DeviceSnapshot,
  FleetConfig,
  FormationConfig,
  FormationSnapshot,
  LaneletOverlay,
  SceneMapDefinition,
} from "./types";

const logger = moduleLogger("config-registry");

const CONFIG_ROOT = config.configRootPath;
const FLEET_FILE = runtimePaths.fleetFilePath;
const VEHICLES_FILE = runtimePaths.vehiclesFilePath;
const FORMATIONS_FILE = runtimePaths.formationsFilePath;
const SCENES_FILE = runtimePaths.scenesFilePath;
const RULES_FILE = runtimePaths.rulesFilePath;
const CODEBOOK_FILE = runtimePaths.codebookFilePath;
const NOTIFY_FILE = runtimePaths.notifyFilePath;
const REPORTS_FILE = runtimePaths.reportsFilePath;

const DEFAULT_FLEET_CONFIG: FleetConfig = {
  fleetName: "智能车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultSceneId: "",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

interface LoadedConfigSnapshot {
  fleetConfig: FleetConfig;
  deviceConfigs: Map<string, DeviceConfig>;
  formationConfigs: Map<string, FormationConfig>;
  deviceFormationIds: Map<string, string[]>;
  sceneConfigs: Map<string, SceneMapDefinition>;
  sceneOverlays: Map<string, LaneletOverlay>;
  alertRules: AlertRulesConfig;
  codebook: ReportCodeEntry[];
  notifyConfig: NotifyConfig;
  reportsConfig: ReportsConfig;
}

/**
 * Bounds of a scene that does not state them: the box around its map rectangle, rotated by
 * `origin.yaw` about the lower-left corner (ROS map_server convention, see `sceneGeometry`).
 */
const deriveBounds = (scene: SceneMapDefinition): NonNullable<SceneMapDefinition["bounds"]> =>
  mapFootprintBounds(scene.origin, scene.width * scene.resolution, scene.height * scene.resolution);

const cloneOverlay = (overlay: LaneletOverlay): LaneletOverlay =>
  JSON.parse(JSON.stringify(overlay)) as LaneletOverlay;

const resolveSceneMapsFilePath = (assetUrl: string): string => {
  const normalizedUrl = String(assetUrl || "").trim();
  if (!normalizedUrl.startsWith("/scene-maps/")) {
    throw new Error(`OSM asset path must start with /scene-maps/: ${normalizedUrl}`);
  }

  const relativePath = normalizedUrl.slice("/scene-maps/".length);
  const resolvedPath = path.resolve(runtimePaths.sceneMapsPath, relativePath);
  const sceneMapsRoot = path.resolve(runtimePaths.sceneMapsPath);
  const relativeFromRoot = path.relative(sceneMapsRoot, resolvedPath);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw new Error(`OSM asset path escapes scene-maps root: ${normalizedUrl}`);
  }

  return resolvedPath;
};

/** The four uploadable scene backdrop kinds and which `SceneMapDefinition` URL field each fills. */
export type SceneAssetKind = "image" | "pointcloud" | "osm" | "pointcloudmeta";
const SCENE_ASSET_URL_FIELD: Record<SceneAssetKind, keyof SceneMapDefinition> = {
  image: "imageUrl",
  pointcloud: "pointCloudUrl",
  osm: "osmUrl",
  pointcloudmeta: "pointCloudMetaUrl",
};

/** Scene-map files whose change reloads the configuration; anything else there (temp files) is ignored. */
const SCENE_MAP_WATCH_EXTENSIONS = new Set([
  ".osm",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".pcd",
  ".json",
]);

const isWithin = (root: string, filePath: string): boolean => {
  const relative = path.relative(root, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** How far into a .pcd to look for its `DATA` line — the same bound the console's parser uses. */
const PCD_HEADER_SCAN_BYTES = 64 * 1024;

/** A URL's extension as `validateSceneAsset` would name it (`.jpeg` is stored as `jpg`). */
const normalizedExtension = (url: string): string => {
  const ext = path.extname(url).slice(1).toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
};

/**
 * Write a sibling temp file then rename it over the target, so a crash mid-write never leaves a
 * half-written file for the next load to trip on. A failed rename removes the temp file.
 */
const writeFileAtomic = async (filePath: string, data: string | Buffer): Promise<void> => {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * A scene-asset upload the caller got wrong — bad id, or content that is not the kind it claims.
 * Thrown by `writeSceneAsset` / `validateSceneAsset` so the route can map it to a 400 by type
 * instead of regex-matching the message text (which silently turned a reworded message into a 500).
 * Anything else out of the write path (disk, reload) stays a plain Error → 500.
 */
export class SceneAssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneAssetValidationError";
  }
}

/**
 * Validate an uploaded backdrop's *content* (not just its declared kind) and return the file
 * extension to store it under. Content sniffing is defence-in-depth: the upload is admin-only
 * and the id/path are already guarded, but a file that is not what it claims would render as a
 * broken map rather than fail loudly, so we reject it at the door.
 */
const validateSceneAsset = (kind: SceneAssetKind, buffer: Buffer): string => {
  if (buffer.length === 0) throw new SceneAssetValidationError("uploaded file is empty");
  const head = buffer.subarray(0, 512).toString("latin1");
  switch (kind) {
    case "image": {
      const withoutBom = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
      const trimmed = withoutBom.trimStart();
      if (trimmed.startsWith("<?xml") || trimmed.toLowerCase().startsWith("<svg")) return "svg";
      if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      )
        return "png";
      if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        return "jpg";
      throw new SceneAssetValidationError("image must be an SVG, PNG, or JPEG");
    }
    case "pointcloud": {
      // PCD text/binary files carry an ASCII header; the version/field lines are always near the top.
      if (!/(^|\n)\s*#|VERSION|FIELDS/i.test(head)) {
        throw new SceneAssetValidationError("point cloud does not look like a .pcd file");
      }
      // The console reads `DATA binary` only. A compressed or ASCII body would parse as garbage
      // and draw an empty backdrop with no error, so it is refused here instead.
      const data = /(?:^|\n)DATA[ \t]+(\S+)/i
        .exec(buffer.subarray(0, PCD_HEADER_SCAN_BYTES).toString("latin1"))?.[1]
        ?.toLowerCase();
      if (data !== "binary") {
        throw new SceneAssetValidationError(
          data
            ? `point cloud is DATA ${data}; only DATA binary is supported`
            : "point cloud has no DATA line",
        );
      }
      return "pcd";
    }
    case "osm": {
      // Feed the real parser: an .osm with no usable nodes throws, exactly as a load would. Its
      // failure is still the caller's bad file, so re-cast it as a validation error (→ 400).
      try {
        parseLaneletOsmText(buffer.toString("utf8"), "upload", "upload");
      } catch (error) {
        throw new SceneAssetValidationError(
          error instanceof Error ? error.message : "invalid .osm",
        );
      }
      return "osm";
    }
    case "pointcloudmeta": {
      try {
        JSON.parse(buffer.toString("utf8"));
      } catch {
        throw new SceneAssetValidationError("point-cloud metadata must be valid JSON");
      }
      return "json";
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ensureObject = (value: unknown, filePath: string, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object: ${filePath}`);
  }

  return value;
};

const ensureArray = (
  value: unknown,
  filePath: string,
  label: string,
): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array: ${filePath}`);
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`${label} entry must be a JSON object: ${filePath} [${index}]`);
    }

    return entry;
  });
};

/**
 * The eight config files, in load order. `optional` ones may be absent (built-in defaults apply);
 * a required one missing is a load error.
 */
const CONFIG_FILES = {
  fleet: { path: FLEET_FILE, optional: false },
  vehicles: { path: VEHICLES_FILE, optional: false },
  formations: { path: FORMATIONS_FILE, optional: false },
  scenes: { path: SCENES_FILE, optional: false },
  rules: { path: RULES_FILE, optional: true },
  codebook: { path: CODEBOOK_FILE, optional: true },
  notify: { path: NOTIFY_FILE, optional: true },
  reports: { path: REPORTS_FILE, optional: true },
} as const;
export type ConfigFileKey = keyof typeof CONFIG_FILES;
const CONFIG_FILE_KEYS = Object.keys(CONFIG_FILES) as ConfigFileKey[];
/** Raw text of each config file; null = absent. */
type RawConfig = Record<ConfigFileKey, string | null>;

/** Where a copy of the last configuration that loaded cleanly is kept, file by file. */
const LAST_GOOD_DIR = path.join(CONFIG_ROOT, ".last-good");
const lastGoodPath = (key: ConfigFileKey): string =>
  path.join(LAST_GOOD_DIR, path.basename(CONFIG_FILES[key].path));

/** File text, or null when the file does not exist. Any other read error propagates. */
async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Parse one config file's text. A required file that is absent is an error; an optional one
 * resolves to null (built-in defaults). Malformed JSON names the file.
 */
function parseConfigText(key: ConfigFileKey, text: string | null): unknown {
  const { path: filePath, optional } = CONFIG_FILES[key];
  if (text === null) {
    if (optional) return null;
    throw new Error(`${path.basename(filePath)} is missing: ${filePath}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${path.basename(filePath)} is not valid JSON (${error instanceof Error ? error.message : String(error)}): ${filePath}`,
      { cause: error },
    );
  }
}

/** Absolute config paths out of an error message shown to an admin. */
const describeConfigError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .split(`${CONFIG_ROOT}${path.sep}`)
    .join("");

/**
 * A config write that validated on its own but could not be applied together with the rest of
 * the configuration (e.g. a scene pointing at an .osm that does not parse). The file has been
 * restored to what it was; the route answers 409 with this message.
 */
export class ConfigApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigApplyError";
  }
}

/**
 * A config write made against a version of the file that is no longer the one on disk — someone
 * else saved (or hand-edited) it in the meantime. Nothing was written; the route answers 409 so the
 * editor reloads instead of silently overwriting the other change.
 */
export class ConfigConflictError extends Error {
  constructor(file: string) {
    super(`${file} 已被他人修改`);
    this.name = "ConfigConflictError";
  }
}

/** How many past versions of each file are kept as merge bases. */
const VERSION_HISTORY = 20;

/** Version token of a config file's on-disk text (what an editor's If-Match refers to). */
const versionOf = (text: string | null): string =>
  text === null ? "absent" : createHash("sha256").update(text).digest("hex").slice(0, 16);

/** One problem with the configuration currently in effect. */
export interface ConfigIssue {
  /** The file at fault (basename), when it could be singled out. */
  file: string | null;
  message: string;
  /**
   * What is in effect instead: the last copy of that file that loaded cleanly, the built-in
   * defaults (an optional file never loaded cleanly before), or — when nothing could be
   * isolated on a hot reload — the whole previous configuration kept in memory.
   */
  using: "last-good" | "default" | "previous";
}

export interface ConfigStatus {
  ok: boolean;
  issues: ConfigIssue[];
  /** When the configuration in effect was (re)evaluated. */
  checkedAt: string | null;
}

/** Coerce the optional `scope` of a rule/channel, rejecting anything but string arrays. */
const parseRuleScope = (
  value: unknown,
  label: string,
  file: string = RULES_FILE,
): RuleScope | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label}.scope must be a JSON object: ${file}`);
  }
  const stringArray = (raw: unknown, field: string): string[] | undefined => {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      throw new Error(`${label}.scope.${field} must be an array of strings: ${file}`);
    }
    return raw as string[];
  };
  return {
    deviceIds: stringArray(value.deviceIds, "deviceIds"),
    formationIds: stringArray(value.formationIds, "formationIds"),
    tags: stringArray(value.tags, "tags"),
  };
};

const parseBoolean = (
  value: unknown,
  fallback: boolean,
  label: string,
  file: string = RULES_FILE,
): boolean => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean: ${file}`);
  }
  return value;
};

const parsePositiveNumber = (
  value: unknown,
  fallback: number | undefined,
  label: string,
  {
    min = 0,
    allowMinInclusive = true,
    file = RULES_FILE,
  }: { min?: number; allowMinInclusive?: boolean; file?: string } = {},
): number | undefined => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number: ${file}`);
  }
  if (allowMinInclusive ? value < min : value <= min) {
    throw new Error(`${label} must be ${allowMinInclusive ? ">=" : ">"} ${min}: ${file}`);
  }
  return value;
};

/**
 * Merge a deployment's (partial, untrusted) `rules.json` over the built-in defaults into a
 * fully-populated, validated `AlertRulesConfig`. Anything the file omits keeps its default;
 * anything malformed throws, so `reload` keeps the previous snapshot. Unknown top-level keys
 * are ignored rather than rejected, so a newer file stays loadable by an older build.
 */
export const parseAlertRules = (raw: unknown): AlertRulesConfig => {
  if (raw === null) {
    return DEFAULT_ALERT_RULES;
  }
  if (!isRecord(raw)) {
    throw new Error(`rules.json must be a JSON object: ${RULES_FILE}`);
  }

  const lowBatteryRaw = raw.lowBattery;
  if (lowBatteryRaw !== undefined && !isRecord(lowBatteryRaw)) {
    throw new Error(`rules.lowBattery must be a JSON object: ${RULES_FILE}`);
  }
  const offlineRaw = raw.offline;
  if (offlineRaw !== undefined && !isRecord(offlineRaw)) {
    throw new Error(`rules.offline must be a JSON object: ${RULES_FILE}`);
  }

  const lb = lowBatteryRaw ?? {};
  const off = offlineRaw ?? {};
  const defaults = DEFAULT_ALERT_RULES;
  // Upper bounds: a percentage cannot exceed 100, and windows longer than a day are almost
  // certainly a unit mistake (minutes / ms typed as seconds).
  const atMost = (value: number | undefined, max: number, label: string): void => {
    if (value !== undefined && value > max) {
      throw new Error(`${label} must be <= ${max}: ${RULES_FILE}`);
    }
  };
  atMost(lb.thresholdPct as number | undefined, 100, "rules.lowBattery.thresholdPct");
  atMost(lb.debounceSeconds as number | undefined, 86_400, "rules.lowBattery.debounceSeconds");
  atMost(off.afterSeconds as number | undefined, 86_400, "rules.offline.afterSeconds");

  return {
    lowBattery: {
      enabled: parseBoolean(lb.enabled, defaults.lowBattery.enabled, "rules.lowBattery.enabled"),
      thresholdPct:
        parsePositiveNumber(
          lb.thresholdPct,
          defaults.lowBattery.thresholdPct,
          "rules.lowBattery.thresholdPct",
          {
            min: 0,
            allowMinInclusive: false,
          },
        ) ?? defaults.lowBattery.thresholdPct,
      scope: parseRuleScope(lb.scope, "rules.lowBattery"),
      debounceSeconds: parsePositiveNumber(
        lb.debounceSeconds,
        defaults.lowBattery.debounceSeconds,
        "rules.lowBattery.debounceSeconds",
      ),
    },
    offline: {
      enabled: parseBoolean(off.enabled, defaults.offline.enabled, "rules.offline.enabled"),
      afterSeconds: parsePositiveNumber(
        off.afterSeconds,
        defaults.offline.afterSeconds,
        "rules.offline.afterSeconds",
        {
          min: 0,
          allowMinInclusive: false,
        },
      ),
      scope: parseRuleScope(off.scope, "rules.offline"),
      debounceSeconds: parsePositiveNumber(
        off.debounceSeconds,
        defaults.offline.debounceSeconds,
        "rules.offline.debounceSeconds",
      ),
    },
  };
};

const CHANNEL_TYPES = new Set<string>(NOTIFY_CHANNEL_TYPES);
const SEVERITY_VALUES = new Set<string>(NOTIFY_SEVERITIES);

/** The severities a channel receives: absent = all three, a list = only those (validated). */
const parseSeverities = (value: unknown, label: string): Severity[] => {
  if (value === undefined || value === null) {
    return [...NOTIFY_SEVERITIES];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label}.severities must be an array of strings: ${NOTIFY_FILE}`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !SEVERITY_VALUES.has(entry)) {
      throw new Error(
        `${label}.severities[${index}] must be one of ${[...SEVERITY_VALUES].join("/")}: ${NOTIFY_FILE}`,
      );
    }
    return entry as Severity;
  });
};

const parseOptionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string: ${NOTIFY_FILE}`);
  }
  return value.trim() || undefined;
};

const parseStringList = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings: ${NOTIFY_FILE}`);
  }
  return value as string[];
};

/** A recipient is a literal `email` or a `user` reference; at least one is required. */
/** `HH:MM`, 24-hour — silence windows and report send times, against the deployment's wall clock. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** An environment variable name as a shell or compose file would accept it. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A plain mailbox `local@domain.tld`: what an SMTP RCPT/FROM accepts without guesswork. */
const EMAIL_ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

const parseEmail = (value: unknown, label: string): string | undefined => {
  const email = parseOptionalString(value, label)?.trim();
  if (email === undefined || email === "") return undefined;
  if (!EMAIL_ADDRESS.test(email)) {
    throw new Error(`${label} must be an email address like ops@example.com: ${NOTIFY_FILE}`);
  }
  return email;
};

const parseRecipient = (raw: unknown, label: string): NotifyRecipient => {
  if (!isRecord(raw)) {
    throw new Error(`${label} must be a JSON object: ${NOTIFY_FILE}`);
  }
  const email = parseEmail(raw.email, `${label}.email`);
  const user = parseOptionalString(raw.user, `${label}.user`);
  if (!email && !user) {
    throw new Error(`${label} must set an email or a user: ${NOTIFY_FILE}`);
  }
  return { email, user };
};

const parseRecipients = (value: unknown, label: string): NotifyRecipient[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array: ${NOTIFY_FILE}`);
  }
  return value.map((entry, index) => parseRecipient(entry, `${label}[${index}]`));
};

const parseSilenceWindow = (raw: unknown, label: string): NotifySilenceWindow => {
  if (!isRecord(raw)) {
    throw new Error(`${label} must be a JSON object: ${NOTIFY_FILE}`);
  }
  // Checked here rather than at send time: a malformed window used to be silently ignored when
  // the dispatcher parsed it, so a channel the admin believed muted kept sending.
  if (
    typeof raw.from !== "string" ||
    typeof raw.to !== "string" ||
    !TIME_OF_DAY.test(raw.from) ||
    !TIME_OF_DAY.test(raw.to)
  ) {
    throw new Error(`${label} must have from/to as "HH:MM" (24-hour): ${NOTIFY_FILE}`);
  }
  let days: number[] | undefined;
  if (raw.days !== undefined && raw.days !== null) {
    if (
      !Array.isArray(raw.days) ||
      raw.days.some(
        (day) => typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6,
      )
    ) {
      throw new Error(`${label}.days must be integers 0-6 (0=Sun): ${NOTIFY_FILE}`);
    }
    days = raw.days as number[];
  }
  return { days, from: raw.from, to: raw.to };
};

const parseSilenceWindows = (value: unknown, label: string): NotifySilenceWindow[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array: ${NOTIFY_FILE}`);
  }
  return value.map((entry, index) => parseSilenceWindow(entry, `${label}[${index}]`));
};

const parseEscalation = (value: unknown, label: string): NotifyEscalation | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object: ${NOTIFY_FILE}`);
  }
  const afterSeconds = parsePositiveNumber(value.afterSeconds, undefined, `${label}.afterSeconds`, {
    min: 0,
    allowMinInclusive: false,
    file: NOTIFY_FILE,
  });
  const channelId = parseOptionalString(value.channelId, `${label}.channelId`);
  if (afterSeconds === undefined || !channelId) {
    throw new Error(`${label} must set afterSeconds (>0) and channelId: ${NOTIFY_FILE}`);
  }
  return { afterSeconds, channelId };
};

const parseNotifyChannel = (raw: Record<string, unknown>, index: number): NotifyChannelConfig => {
  const label = `notify.channels[${index}]`;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    throw new Error(`${label}.id must be a non-empty string: ${NOTIFY_FILE}`);
  }

  const type = raw.type;
  if (typeof type !== "string" || !CHANNEL_TYPES.has(type)) {
    throw new Error(
      `${label}.type must be one of ${[...CHANNEL_TYPES].join("/")}: ${NOTIFY_FILE} (${id})`,
    );
  }

  const urlEnv = typeof raw.urlEnv === "string" ? raw.urlEnv.trim() : "";
  if (urlEnv && !ENV_VAR_NAME.test(urlEnv)) {
    throw new Error(
      `${label}.urlEnv must be an environment variable name (letters, digits, _): ${NOTIFY_FILE} (${id})`,
    );
  }
  if (!urlEnv) {
    // The endpoint URL / SMTP string carries a secret, so a channel names the env var that holds
    // it rather than the value itself — this field is that name and is required.
    throw new Error(
      `${label}.urlEnv must be a non-empty environment variable name: ${NOTIFY_FILE} (${id})`,
    );
  }

  const channel: NotifyChannelConfig = {
    id,
    type: type as NotifyChannelType,
    enabled: parseBoolean(raw.enabled, true, `${label}.enabled`, NOTIFY_FILE),
    urlEnv,
    severities: parseSeverities(raw.severities, label),
    scope: parseRuleScope(raw.scope, label, NOTIFY_FILE),
    from: parseEmail(raw.from, `${label}.from`),
    recipients: parseRecipients(raw.recipients, `${label}.recipients`),
    groups: parseStringList(raw.groups, `${label}.groups`),
    digestSeconds: parsePositiveNumber(raw.digestSeconds, undefined, `${label}.digestSeconds`, {
      file: NOTIFY_FILE,
    }),
    digestSeverities:
      raw.digestSeverities === undefined
        ? undefined
        : parseSeverities(raw.digestSeverities, `${label}.digest`),
    renotifySeconds: parsePositiveNumber(
      raw.renotifySeconds,
      undefined,
      `${label}.renotifySeconds`,
      { file: NOTIFY_FILE },
    ),
    silenceWindows: parseSilenceWindows(raw.silenceWindows, `${label}.silenceWindows`),
    escalation: parseEscalation(raw.escalation, `${label}.escalation`),
  };
  // An enabled channel that can never send anything is a misconfiguration, not a quiet channel.
  if (channel.enabled && channel.severities.length === 0) {
    throw new Error(
      `${label} subscribes to no severity, so it would never send: ${NOTIFY_FILE} (${id})`,
    );
  }
  if (
    channel.enabled &&
    channel.type === "email" &&
    !channel.recipients?.length &&
    !channel.groups?.length
  ) {
    throw new Error(
      `${label} is an email channel with no recipients or groups: ${NOTIFY_FILE} (${id})`,
    );
  }
  return channel;
};

/**
 * Merge a deployment's (partial, untrusted) `notify.json` into a validated `NotifyConfig`.
 * A missing file → `DEFAULT_NOTIFY_CONFIG` (no channels, so nothing is ever sent — the
 * zero-config red line). A present-but-malformed file throws, so `reload` keeps the previous
 * snapshot. Channel ids must be unique. Unknown top-level keys are ignored (forward-compat).
 *
 * Exported so the write route (1.6.1) can validate-first (parse → 400 before touching disk),
 * mirroring how `routes/codebook.ts` uses `parseCodebook`.
 */
export const parseNotifyConfig = (raw: unknown): NotifyConfig => {
  if (raw === null) {
    return DEFAULT_NOTIFY_CONFIG;
  }
  if (!isRecord(raw)) {
    throw new Error(`notify.json must be a JSON object: ${NOTIFY_FILE}`);
  }

  const channelsRaw = raw.channels;
  const channels =
    channelsRaw === undefined
      ? []
      : (() => {
          const records = ensureArray(channelsRaw, NOTIFY_FILE, "notify.channels");
          const seenIds = new Set<string>();
          return records.map((entry, index) => {
            const channel = parseNotifyChannel(entry, index);
            if (seenIds.has(channel.id)) {
              throw new Error(`Duplicate channel id in notify.json: ${channel.id}`);
            }
            seenIds.add(channel.id);
            return channel;
          });
        })();

  let groups: NotifyConfig["groups"];
  if (raw.groups !== undefined && raw.groups !== null) {
    if (!isRecord(raw.groups)) {
      throw new Error(`notify.groups must be a JSON object: ${NOTIFY_FILE}`);
    }
    groups = {};
    for (const [name, list] of Object.entries(raw.groups)) {
      groups[name] = parseRecipients(list, `notify.groups.${name}`) ?? [];
    }
  }

  // References inside the file must resolve: a channel's groups, an escalation target. A dangling
  // one used to be skipped silently at send time.
  const channelIds = new Set(channels.map((channel) => channel.id));
  for (const channel of channels) {
    for (const group of channel.groups ?? []) {
      if (!groups || !(group in groups)) {
        throw new Error(
          `notify channel ${channel.id} references unknown group ${group}: ${NOTIFY_FILE}`,
        );
      }
    }
    const target = channel.escalation?.channelId;
    if (target !== undefined && (target === channel.id || !channelIds.has(target))) {
      throw new Error(
        `notify channel ${channel.id} escalates to ${target === channel.id ? "itself" : `unknown channel ${target}`}: ${NOTIFY_FILE}`,
      );
    }
  }

  return groups ? { channels, groups } : { channels };
};

const parseReportSchedule = (raw: unknown, index: number): ReportScheduleConfig => {
  const label = `reports.schedules[${index}]`;
  if (!isRecord(raw)) {
    throw new Error(`${label} must be a JSON object: ${REPORTS_FILE}`);
  }
  const id = parseOptionalString(raw.id, `${label}.id`);
  if (!id) {
    throw new Error(`${label} must set an id: ${REPORTS_FILE}`);
  }
  const range = raw.range;
  if (!REPORT_RANGE_PRESETS.includes(range as (typeof REPORT_RANGE_PRESETS)[number])) {
    throw new Error(
      `${label}.range must be one of ${REPORT_RANGE_PRESETS.join(", ")}: ${REPORTS_FILE}`,
    );
  }
  if (typeof raw.time !== "string" || !TIME_OF_DAY.test(raw.time)) {
    throw new Error(`${label}.time must be "HH:MM" (24-hour): ${REPORTS_FILE}`);
  }
  let weekday: number | undefined;
  if (raw.weekday !== undefined && raw.weekday !== null) {
    if (
      typeof raw.weekday !== "number" ||
      !Number.isInteger(raw.weekday) ||
      raw.weekday < 0 ||
      raw.weekday > 6
    ) {
      throw new Error(`${label}.weekday must be an integer 0-6 (0=Sun): ${REPORTS_FILE}`);
    }
    weekday = raw.weekday;
  }
  const smtpEnv = parseOptionalString(raw.smtpEnv, `${label}.smtpEnv`);
  if (!smtpEnv) {
    throw new Error(
      `${label} must set smtpEnv (env var name holding the SMTP URL): ${REPORTS_FILE}`,
    );
  }
  if (!ENV_VAR_NAME.test(smtpEnv)) {
    throw new Error(`${label}.smtpEnv must be an environment variable name: ${REPORTS_FILE}`);
  }
  const from = parseEmail(raw.from, `${label}.from`);
  if (!from) {
    throw new Error(`${label} must set from (sender address): ${REPORTS_FILE}`);
  }
  const recipients = parseRecipients(raw.recipients, `${label}.recipients`);
  let groups: string[] | undefined;
  if (raw.groups !== undefined && raw.groups !== null) {
    if (!Array.isArray(raw.groups) || raw.groups.some((name) => typeof name !== "string")) {
      throw new Error(`${label}.groups must be an array of group names: ${REPORTS_FILE}`);
    }
    groups = raw.groups as string[];
  }
  const enabled = parseBoolean(raw.enabled, true, `${label}.enabled`, REPORTS_FILE);
  if (enabled && !recipients?.length && !groups?.length) {
    throw new Error(
      `${label} has no recipients or groups, so it would never be delivered: ${REPORTS_FILE}`,
    );
  }
  return {
    id,
    enabled,
    range: range as ReportScheduleConfig["range"],
    time: raw.time,
    weekday,
    smtpEnv,
    from,
    recipients,
    groups,
  };
};

/**
 * Merge a deployment's (partial, untrusted) `reports.json` into a validated `ReportsConfig`.
 * A missing file → `DEFAULT_REPORTS_CONFIG` (no schedules, so nothing is ever sent — the same
 * zero-config red line as notify.json). Malformed → throw so `reload` keeps the previous snapshot.
 * Schedule ids must be unique. The SMTP URL lives only in the env var `smtpEnv` names, never here.
 */
export const parseReportsConfig = (raw: unknown): ReportsConfig => {
  if (raw === null) {
    return DEFAULT_REPORTS_CONFIG;
  }
  if (!isRecord(raw)) {
    throw new Error(`reports.json must be a JSON object: ${REPORTS_FILE}`);
  }
  const schedulesRaw = raw.schedules;
  if (schedulesRaw === undefined) {
    return { schedules: [] };
  }
  const records = ensureArray(schedulesRaw, REPORTS_FILE, "reports.schedules");
  const seenIds = new Set<string>();
  const schedules = records.map((entry, index) => {
    const schedule = parseReportSchedule(entry, index);
    if (seenIds.has(schedule.id)) {
      throw new Error(`Duplicate schedule id in reports.json: ${schedule.id}`);
    }
    seenIds.add(schedule.id);
    return schedule;
  });
  return { schedules };
};

/**
 * Each editable file's parser, as the writers apply it — used to normalize the three sides of a
 * concurrent-edit merge. `fleet.json` has no editor, so no entry.
 */
const CONFIG_NORMALIZERS: Partial<Record<ConfigFileKey, (raw: unknown) => unknown>> = {
  vehicles: (raw) => parseVehicles(raw ?? []),
  formations: (raw) => parseFormations(raw ?? []),
  scenes: (raw) => parseScenes(raw ?? []),
  codebook: (raw) => codebookOverrides(DEFAULT_REPORT_CODES, parseCodebook(raw ?? [])),
  notify: (raw) => parseNotifyConfig(raw),
  rules: (raw) => parseAlertRules(raw),
  reports: (raw) => parseReportsConfig(raw),
};

export class ConfigRegistry {
  private fleetConfig: FleetConfig = { ...DEFAULT_FLEET_CONFIG };
  private deviceConfigs = new Map<string, DeviceConfig>();
  private formationConfigs = new Map<string, FormationConfig>();
  private deviceFormationIds = new Map<string, string[]>();
  private sceneConfigs = new Map<string, SceneMapDefinition>();
  private sceneOverlays = new Map<string, LaneletOverlay>();
  private alertRules: AlertRulesConfig = DEFAULT_ALERT_RULES;
  private codebook: ReportCodeEntry[] = [...DEFAULT_REPORT_CODES];
  private notifyConfig: NotifyConfig = DEFAULT_NOTIFY_CONFIG;
  private reportsConfig: ReportsConfig = DEFAULT_REPORTS_CONFIG;
  private loaded = false;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private configQueue: Promise<void> = Promise.resolve();
  private pendingReloadReason = "startup";
  private status: ConfigStatus = { ok: true, issues: [], checkedAt: null };
  /** Version of each config file's on-disk text as of the last load (see `getConfigVersion`). */
  private fileVersions: Partial<Record<ConfigFileKey, string>> = {};
  /**
   * Recent texts of each file by version — the merge base for an editor that saved against an
   * older version. In memory and bounded: after a restart (or once a version ages out) there is no
   * base, and a stale save is refused as a plain conflict, which is always safe.
   */
  private versionTexts = new Map<ConfigFileKey, Map<string, string | null>>();

  private async readRawConfig(): Promise<RawConfig> {
    const texts = await Promise.all(
      CONFIG_FILE_KEYS.map((key) => readTextIfExists(CONFIG_FILES[key].path)),
    );
    return Object.fromEntries(
      CONFIG_FILE_KEYS.map((key, i) => [key, texts[i] ?? null]),
    ) as RawConfig;
  }

  /** The last-good copies; `undefined` for a file that has none. */
  private async readLastGood(): Promise<Record<ConfigFileKey, string | null | undefined>> {
    const texts = await Promise.all(
      CONFIG_FILE_KEYS.map(async (key) => {
        try {
          return await readTextIfExists(lastGoodPath(key));
        } catch {
          return null;
        }
      }),
    );
    return Object.fromEntries(
      CONFIG_FILE_KEYS.map((key, i) => [
        key,
        // An optional file with no saved copy falls back to "absent" (its defaults).
        texts[i] ?? (CONFIG_FILES[key].optional ? null : undefined),
      ]),
    ) as Record<ConfigFileKey, string | null | undefined>;
  }

  /**
   * Remember the files that just loaded as part of a good configuration, so a later broken edit
   * can fall back to them file by file. Best-effort: a read-only config volume only loses the
   * fallback, never the load.
   */
  private async saveLastGood(raw: RawConfig, keys: readonly ConfigFileKey[]): Promise<void> {
    try {
      await fs.mkdir(LAST_GOOD_DIR, { recursive: true });
      await Promise.all(
        keys.map(async (key) => {
          const target = lastGoodPath(key);
          const text = raw[key];
          if (text === null) {
            await fs.rm(target, { force: true });
            return;
          }
          if ((await readTextIfExists(target)) === text) return;
          const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
          await fs.writeFile(tmp, text, "utf8");
          await fs.rename(tmp, target);
        }),
      );
    } catch (error) {
      logger.warn({ err: error, dir: LAST_GOOD_DIR }, "Could not save last-good config copies");
    }
  }

  /**
   * Load the configuration on disk, isolating a broken file instead of failing as a whole.
   *
   * 1. Everything as it is on disk.
   * 2. Failing that, each changed file on its own reverted to its last-good copy (an optional file
   *    with none: its built-in defaults) — the first that loads wins, so the other files' edits
   *    still take effect and only the culprit is held back.
   * 3. Failing that, every changed file reverted together.
   * Throws the original error when none of that loads.
   */
  private async loadWithFallback(): Promise<{
    snapshot: LoadedConfigSnapshot;
    raw: RawConfig;
    current: RawConfig;
    issues: ConfigIssue[];
  }> {
    const current = await this.readRawConfig();
    let firstError: unknown;
    try {
      return { snapshot: await this.buildSnapshot(current), raw: current, current, issues: [] };
    } catch (error) {
      firstError = error;
    }
    const lastGood = await this.readLastGood();
    const changed = CONFIG_FILE_KEYS.filter(
      (key) => lastGood[key] !== undefined && lastGood[key] !== current[key],
    );
    const issueFor = (key: ConfigFileKey): ConfigIssue => ({
      file: path.basename(CONFIG_FILES[key].path),
      message: describeConfigError(firstError),
      using: lastGood[key] === null ? "default" : "last-good",
    });
    const attempts: ConfigFileKey[][] = [
      ...changed.map((key) => [key]),
      ...(changed.length > 1 ? [changed] : []),
    ];
    for (const reverted of attempts) {
      const raw = { ...current };
      for (const key of reverted) raw[key] = lastGood[key] ?? null;
      try {
        return {
          snapshot: await this.buildSnapshot(raw),
          raw,
          current,
          issues: reverted.map(issueFor),
        };
      } catch {
        // Not this one; try the next combination.
      }
    }
    throw firstError;
  }

  /** Apply a loaded configuration and record what it says about the files on disk. */
  private async commitLoaded(loaded: {
    snapshot: LoadedConfigSnapshot;
    raw: RawConfig;
    current: RawConfig;
    issues: ConfigIssue[];
  }): Promise<void> {
    this.applySnapshot(loaded.snapshot);
    for (const key of CONFIG_FILE_KEYS) {
      const version = versionOf(loaded.current[key]);
      this.fileVersions[key] = version;
      const texts = this.versionTexts.get(key) ?? new Map<string, string | null>();
      texts.delete(version);
      texts.set(version, loaded.current[key]);
      while (texts.size > VERSION_HISTORY) texts.delete(texts.keys().next().value as string);
      this.versionTexts.set(key, texts);
    }
    this.status = {
      ok: loaded.issues.length === 0,
      issues: loaded.issues,
      checkedAt: new Date().toISOString(),
    };
    for (const issue of loaded.issues) {
      logger.error(
        { file: issue.file, using: issue.using, detail: issue.message },
        "Config file rejected; running on its fallback",
      );
    }
    // Only files whose on-disk text actually loaded become the new last-good.
    const loadedAsIs = CONFIG_FILE_KEYS.filter((key) => loaded.raw[key] === loaded.current[key]);
    await this.saveLastGood(loaded.current, loadedAsIs);
  }

  /** Run config mutations (writes, reloads) one at a time, so no two validate against a stale view. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.configQueue.then(work, work);
    this.configQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async buildSnapshot(raw: RawConfig): Promise<LoadedConfigSnapshot> {
    const fleetRaw = parseConfigText("fleet", raw.fleet);
    const vehiclesRaw = parseConfigText("vehicles", raw.vehicles);
    const formationsRaw = parseConfigText("formations", raw.formations);
    const scenesRaw = parseConfigText("scenes", raw.scenes);
    const rulesRaw = parseConfigText("rules", raw.rules);
    const codebookRaw = parseConfigText("codebook", raw.codebook);
    const notifyRaw = parseConfigText("notify", raw.notify);
    const reportsRaw = parseConfigText("reports", raw.reports);

    const alertRules = parseAlertRules(rulesRaw);
    // A deployment's codebook.json (if any) is validated then layered over the built-in
    // table; the merged result is what `getCodebook` 下发s. Missing file = the built-in table.
    const codebook = mergeCodebook(
      DEFAULT_REPORT_CODES,
      codebookRaw === null ? [] : parseCodebook(codebookRaw),
    );
    // Missing notify.json = no channels = nothing is ever sent (the zero-config red line).
    const notifyConfig = parseNotifyConfig(notifyRaw);
    // Missing reports.json = no schedules = no scheduled email (same red line).
    const reportsConfig = parseReportsConfig(reportsRaw);
    // A schedule's groups are notify.json's recipient groups: they must exist, or the report is
    // silently skipped at send time. (Deleting a group a schedule still uses is refused the same way.)
    for (const schedule of reportsConfig.schedules) {
      for (const group of schedule.groups ?? []) {
        if (!notifyConfig.groups || !(group in notifyConfig.groups)) {
          throw new Error(
            `report schedule ${schedule.id} references unknown recipient group ${group}: ${REPORTS_FILE}`,
          );
        }
      }
    }

    const fleetConfig = ensureObject(fleetRaw, FLEET_FILE, "fleet.json") as Partial<FleetConfig>;
    const vehicleRecords = ensureArray(vehiclesRaw, VEHICLES_FILE, "vehicles.json") as Array<
      Partial<DeviceConfig>
    >;
    const formationRecords = ensureArray(
      formationsRaw,
      FORMATIONS_FILE,
      "formations.json",
    ) as Array<Partial<FormationConfig>>;
    const sceneRecords = ensureArray(scenesRaw, SCENES_FILE, "scenes.json") as Array<
      Partial<SceneMapDefinition>
    >;

    const nextFleetConfig: FleetConfig = {
      ...DEFAULT_FLEET_CONFIG,
      ...fleetConfig,
    };

    const nextDeviceConfigs = new Map<string, DeviceConfig>();
    for (const value of vehicleRecords) {
      const deviceId = String(value.deviceId || "").trim();
      if (!deviceId) {
        throw new Error(`Vehicle config missing deviceId: ${VEHICLES_FILE}`);
      }
      if (nextDeviceConfigs.has(deviceId)) {
        throw new Error(`Duplicate deviceId in vehicles.json: ${deviceId}`);
      }

      nextDeviceConfigs.set(deviceId, {
        ...value,
        deviceId,
        deviceName: String(value.deviceName || deviceId),
        tags: Array.isArray(value.tags) ? value.tags.map((tag) => String(tag)) : [],
      });
    }

    const nextFormationConfigs = new Map<string, FormationConfig>();
    const nextDeviceFormationIds = new Map<string, string[]>();
    for (const value of formationRecords) {
      const formationId = String(value.formationId || "").trim();
      if (!formationId) {
        throw new Error(`Formation config missing formationId: ${FORMATIONS_FILE}`);
      }
      if (nextFormationConfigs.has(formationId)) {
        throw new Error(`Duplicate formationId in formations.json: ${formationId}`);
      }

      const deviceIds = Array.isArray(value.deviceIds)
        ? value.deviceIds.map((deviceId) => String(deviceId).trim()).filter(Boolean)
        : [];
      if (!deviceIds.length) {
        throw new Error(`Formation config missing deviceIds: ${FORMATIONS_FILE} (${formationId})`);
      }

      for (const deviceId of deviceIds) {
        if (!nextDeviceConfigs.has(deviceId)) {
          throw new Error(
            `Formation references unknown deviceId ${deviceId}: ${FORMATIONS_FILE} (${formationId})`,
          );
        }
      }

      nextFormationConfigs.set(formationId, {
        formationId,
        formationName: String(value.formationName || formationId),
        deviceIds,
        sceneId: value.sceneId ? String(value.sceneId) : undefined,
        description: value.description ? String(value.description) : "",
        color: value.color ? String(value.color) : "",
      });

      deviceIds.forEach((deviceId) => {
        const existing = nextDeviceFormationIds.get(deviceId) || [];
        existing.push(formationId);
        nextDeviceFormationIds.set(deviceId, existing);
      });
    }

    const nextSceneConfigs = new Map<string, SceneMapDefinition>();
    const nextSceneOverlays = new Map<string, LaneletOverlay>();
    for (const value of sceneRecords) {
      const sceneId = String(value.sceneId || "").trim();
      if (!sceneId) {
        throw new Error(`Scene config missing sceneId: ${SCENES_FILE}`);
      }
      if (nextSceneConfigs.has(sceneId)) {
        throw new Error(`Duplicate sceneId in scenes.json: ${sceneId}`);
      }
      if (
        !Number.isFinite(value.width ?? Number.NaN) ||
        !Number.isFinite(value.height ?? Number.NaN) ||
        !Number.isFinite(value.resolution ?? Number.NaN) ||
        !Number.isFinite(value.origin?.x ?? Number.NaN) ||
        !Number.isFinite(value.origin?.y ?? Number.NaN) ||
        !Number.isFinite(value.origin?.yaw ?? Number.NaN)
      ) {
        throw new Error(
          `Scene config missing width/height/resolution/origin: ${SCENES_FILE} (${sceneId})`,
        );
      }

      const normalizedScene: SceneMapDefinition = {
        ...value,
        sceneId,
        sceneName: String(value.sceneName || sceneId),
        mapFrame: String(value.mapFrame || "map"),
        resolution: Number(value.resolution),
        origin: {
          x: Number(value.origin?.x),
          y: Number(value.origin?.y),
          yaw: Number(value.origin?.yaw),
        },
        width: Number(value.width),
        height: Number(value.height),
        overlayType: value.overlayType ?? (value.overlayUrl ? "lanelet2" : undefined),
      };

      if (value.osmUrl) {
        const osmFilePath = resolveSceneMapsFilePath(String(value.osmUrl));
        const projectionOrigin =
          Number.isFinite(value.osmProjectionOrigin?.lat ?? Number.NaN) &&
          Number.isFinite(value.osmProjectionOrigin?.lng ?? Number.NaN)
            ? {
                lat: Number(value.osmProjectionOrigin?.lat),
                lng: Number(value.osmProjectionOrigin?.lng),
              }
            : undefined;
        const overlay = await parseLaneletOsmFile(osmFilePath, sceneId, projectionOrigin);
        nextSceneOverlays.set(sceneId, overlay);
        normalizedScene.osmUrl = String(value.osmUrl);
        normalizedScene.overlayType = "lanelet2";
        normalizedScene.overlayUrl = `/api/scenes/${encodeURIComponent(sceneId)}/overlay`;
        normalizedScene.bounds = value.bounds || overlay.bounds;
      } else {
        normalizedScene.bounds = value.bounds || deriveBounds(normalizedScene);
      }

      nextSceneConfigs.set(sceneId, normalizedScene);
    }

    // Scene referential integrity (load path is tolerant). A formation / vehicle / fleet default
    // that names a scene which does not exist would resolve to a dangling id at runtime. The write
    // API rejects that up front; a hand-edited file must not crash the stack, so here we only warn
    // and blank the dangling reference, letting the effective-scene fallback take over.
    const sceneMissing = (id: string | undefined): id is string =>
      !!id && !nextSceneConfigs.has(id);
    for (const formation of nextFormationConfigs.values()) {
      if (sceneMissing(formation.sceneId)) {
        logger.warn(
          { formationId: formation.formationId, sceneId: formation.sceneId },
          "Formation references unknown scene; treating as unset",
        );
        formation.sceneId = undefined;
      }
    }
    for (const device of nextDeviceConfigs.values()) {
      if (sceneMissing(device.defaultSceneId)) {
        logger.warn(
          { deviceId: device.deviceId, sceneId: device.defaultSceneId },
          "Vehicle references unknown default scene; treating as unset",
        );
        device.defaultSceneId = undefined;
      }
    }
    if (sceneMissing(nextFleetConfig.defaultSceneId)) {
      logger.warn(
        { sceneId: nextFleetConfig.defaultSceneId },
        "Fleet default scene does not exist; treating as unset",
      );
      nextFleetConfig.defaultSceneId = undefined;
    }

    return {
      fleetConfig: nextFleetConfig,
      deviceConfigs: nextDeviceConfigs,
      formationConfigs: nextFormationConfigs,
      deviceFormationIds: nextDeviceFormationIds,
      sceneConfigs: nextSceneConfigs,
      sceneOverlays: nextSceneOverlays,
      alertRules,
      codebook,
      notifyConfig,
      reportsConfig,
    };
  }

  private applySnapshot(snapshot: LoadedConfigSnapshot): void {
    this.fleetConfig = { ...snapshot.fleetConfig };
    this.deviceConfigs = snapshot.deviceConfigs;
    this.formationConfigs = snapshot.formationConfigs;
    this.deviceFormationIds = snapshot.deviceFormationIds;
    this.sceneConfigs = snapshot.sceneConfigs;
    this.sceneOverlays = snapshot.sceneOverlays;
    this.alertRules = snapshot.alertRules;
    this.codebook = snapshot.codebook;
    this.notifyConfig = snapshot.notifyConfig;
    this.reportsConfig = snapshot.reportsConfig;
    this.loaded = true;
  }

  private logLoad(reason: string): void {
    logger.info(
      {
        reason,
        configRoot: CONFIG_ROOT,
        deviceCount: this.deviceConfigs.size,
        formationCount: this.formationConfigs.size,
        sceneCount: this.sceneConfigs.size,
      },
      "Loaded backend config registry",
    );
  }

  private describeWatchPath(filePath: string): string {
    const relative = path.relative(CONFIG_ROOT, filePath);
    return relative && !relative.startsWith("..")
      ? relative.replace(/\\/g, "/")
      : path.basename(filePath);
  }

  /**
   * Initial load. A broken file falls back to its last-good copy (or, for an optional file, the
   * built-in defaults) and is reported through `getConfigStatus`; only a configuration with no
   * usable fallback at all throws — and then the process must not start.
   */
  async load(): Promise<void> {
    await this.serialize(async () => {
      await this.commitLoaded(await this.loadWithFallback());
      this.logLoad("startup");
    });
  }

  /**
   * Re-read the configuration (file watcher, writers). Returns false when nothing loadable could be
   * assembled; the previous configuration then stays in effect and the status says so.
   */
  reload(reason = "manual"): Promise<boolean> {
    return this.serialize(() => this.reloadInternal(reason));
  }

  private async reloadInternal(reason: string): Promise<boolean> {
    try {
      await this.commitLoaded(await this.loadWithFallback());
      this.logLoad(reason);
      return true;
    } catch (error) {
      logger.error(
        { err: error, reason, configRoot: CONFIG_ROOT },
        "Failed to reload backend config registry",
      );
      this.status = {
        ok: false,
        issues: [{ file: null, message: describeConfigError(error), using: "previous" }],
        checkedAt: new Date().toISOString(),
      };
      return false;
    }
  }

  /**
   * The version of a config file as last loaded — sent to editors as an ETag and checked against
   * their If-Match on write (optimistic concurrency).
   */
  getConfigVersion(key: ConfigFileKey): string {
    return this.fileVersions[key] ?? "absent";
  }

  /** Health of the configuration in effect — for the system status page and readiness. */
  getConfigStatus(): ConfigStatus {
    return { ...this.status, issues: this.status.issues.map((issue) => ({ ...issue })) };
  }

  /**
   * Write one config file and make it take effect, or leave everything as it was.
   *
   * The payload is already validated on its own; what can still fail is loading it *together*
   * with the rest (cross-file references, an asset it points at). If the file cannot be applied
   * as written, the previous text is restored and a `ConfigApplyError` explains why — the API
   * never again answers 200 for a change that did not take effect.
   */
  private async writeConfigAndApply(
    key: ConfigFileKey,
    value: unknown,
    reason: string,
    expectedVersion?: string,
  ): Promise<void> {
    const filePath = CONFIG_FILES[key].path;
    const previous = await readTextIfExists(filePath);
    // Checked against the file as it is on disk *now*, inside the serialized write: the editor
    // loaded version X, and if anything (another admin, a hand edit) changed the file since, this
    // write would overwrite that change without anyone seeing it.
    if (expectedVersion !== undefined && versionOf(previous) !== expectedVersion) {
      // Someone saved in between. Merge entry by entry when the two edits do not overlap; any
      // overlap — or no known base to merge from — is refused, exactly as without merging.
      const merged = this.mergeConcurrentEdit(key, value, expectedVersion, previous);
      if (merged === undefined) throw new ConfigConflictError(path.basename(filePath));
      value = merged;
    }
    await this.writeConfigFileAtomic(filePath, value);
    let failure: string;
    try {
      const loaded = await this.loadWithFallback();
      const rejected = loaded.issues.find((issue) => issue.file === path.basename(filePath));
      if (rejected) {
        failure = rejected.message;
      } else {
        await this.commitLoaded(loaded);
        this.logLoad(reason);
        return;
      }
    } catch (error) {
      failure = describeConfigError(error);
    }
    await this.restoreFile(filePath, previous);
    throw new ConfigApplyError(
      `${path.basename(filePath)} 保存后无法与现有配置一起生效，已回滚：${failure}`,
    );
  }

  /**
   * Three-way merge of our edit (made against `baseVersion`) with the file as it is now. Returns the
   * merged value, or undefined when it cannot be merged safely (see `configMerge`). All three sides
   * are normalized by the file's own parser, so formatting and defaulted fields never read as edits,
   * and the merged result is validated by the same parser before it is written.
   */
  private mergeConcurrentEdit(
    key: ConfigFileKey,
    ours: unknown,
    baseVersion: string,
    currentText: string | null,
  ): unknown {
    const normalize = CONFIG_NORMALIZERS[key];
    const spec = key in MERGE_SPECS ? MERGE_SPECS[key as keyof typeof MERGE_SPECS] : undefined;
    const baseText = this.versionTexts.get(key)?.get(baseVersion);
    if (!normalize || !spec || baseText === undefined) return undefined;
    try {
      const read = (text: string | null): unknown =>
        text === null ? normalize(null) : normalize(JSON.parse(text) as unknown);
      const result = mergeConfig(
        spec,
        read(baseText),
        JSON.parse(JSON.stringify(ours)) as unknown,
        read(currentText),
      );
      if (!result.ok) return undefined;
      const merged = normalize(result.value);
      logger.info(
        { file: path.basename(CONFIG_FILES[key].path) },
        "Merged a concurrent config edit",
      );
      return merged;
    } catch {
      return undefined;
    }
  }

  private async restoreFile(filePath: string, previous: string | null): Promise<void> {
    if (previous === null) {
      await fs.rm(filePath, { force: true });
      return;
    }
    const tmp = `${filePath}.${process.pid}.${Date.now()}.restore.tmp`;
    await fs.writeFile(tmp, previous, "utf8");
    await fs.rename(tmp, filePath);
  }

  /**
   * Register the config-file watcher. Synchronous — setting up chokidar and the debounce
   * timer is all that happens here; the reload work runs later, on `this.reloadQueue`.
   *
   * It used to be `async` with nothing to await, and `index.ts` awaited it, which read as
   * 「等监听建立好」. What that await actually waited for was nothing.
   */
  startWatching(onReload: () => Promise<void> | void): void {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(
      [
        FLEET_FILE,
        VEHICLES_FILE,
        FORMATIONS_FILE,
        SCENES_FILE,
        RULES_FILE,
        CODEBOOK_FILE,
        NOTIFY_FILE,
        REPORTS_FILE,
        // Scene-map assets: `.osm` feeds the overlay parser, and the raster / point-cloud
        // / point-cloud-meta backdrops, so a host-side swap hot-reloads like the JSON config does
        // (the upload endpoint applies its own write). chokidar 4 dropped glob support, so the
        // directory is watched as a whole and `ignored` keeps only these extensions.
        runtimePaths.sceneMapsPath,
      ],
      {
        ignored: (filePath, stats) =>
          Boolean(stats?.isFile()) &&
          isWithin(runtimePaths.sceneMapsPath, filePath) &&
          !SCENE_MAP_WATCH_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
        ignoreInitial: true,
        persistent: true,
        usePolling: config.configWatchUsePolling,
        awaitWriteFinish: {
          stabilityThreshold: Math.max(config.configWatchDebounceMs, 200),
          pollInterval: 100,
        },
      },
    );

    const scheduleReload = (eventName: string, filePath: string): void => {
      this.pendingReloadReason = `${eventName}:${this.describeWatchPath(filePath)}`;
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
      }

      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        const reason = this.pendingReloadReason;
        void this.reload(reason)
          .then(async (didReload) => {
            if (didReload) {
              await onReload();
            }
          })
          .catch((error) => {
            logger.error({ err: error, reason }, "Unexpected config reload callback failure");
          });
      }, config.configWatchDebounceMs);
    };

    const registerWatchEvent = (eventName: "add" | "change" | "unlink"): void => {
      this.watcher?.on(eventName, (filePath: string) => scheduleReload(eventName, filePath));
    };

    registerWatchEvent("add");
    registerWatchEvent("change");
    registerWatchEvent("unlink");
    this.watcher.on("error", (error) => {
      logger.error({ err: error, configRoot: CONFIG_ROOT }, "Config watcher error");
    });

    logger.info(
      {
        configRoot: CONFIG_ROOT,
        usePolling: config.configWatchUsePolling,
        debounceMs: config.configWatchDebounceMs,
      },
      "Started backend config watcher",
    );
  }

  async closeWatcher(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) {
      await watcher.close();
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("Config registry has not been loaded");
    }
  }

  getFleetConfig(): FleetConfig {
    this.ensureLoaded();
    return { ...this.fleetConfig };
  }

  /**
   * The alert rules ingest evaluates against. Returns the live snapshot
   * *reference*, not a copy: it is read once per incoming frame and only ever handed to the
   * pure `evaluateRuleAlerts`, which never mutates it, and a reload swaps the whole object
   * atomically — so a caller holding a reference keeps a consistent snapshot rather than
   * seeing a half-applied change. Unlike the other getters this does **not** require the
   * registry to be loaded: `this.alertRules` starts at `DEFAULT_ALERT_RULES`, so a frame
   * that arrives before `load()` (or a test store that never loads config) still evaluates
   * against the built-in rules rather than throwing.
   */
  getAlertRules(): AlertRulesConfig {
    return this.alertRules;
  }

  /**
   * The report-code dictionary in effect — the built-in table with the deployment's
   * `codebook.json` layered over it. Like `getAlertRules`, does not require
   * the registry to be loaded: it defaults to the built-in table, so a code lookup before
   * `load()` still resolves. Returns a copy so a caller cannot mutate the live snapshot.
   */
  getCodebook(): ReportCodeEntry[] {
    return this.codebook.map((entry) => ({ ...entry }));
  }

  /**
   * The outbound-notification config in effect — the deployment's `notify.json`,
   * or `DEFAULT_NOTIFY_CONFIG` (no channels) when there is none. Like `getAlertRules`, does
   * **not** require the registry to be loaded: it defaults to "no channels", so the dispatcher
   * subscribing before `load()` (or a test that never loads config) simply sends nothing rather
   * than throwing. Returns the live reference: the dispatcher reads it per alert and only hands
   * it to the pure channel selector, and a reload swaps the whole object atomically.
   */
  getNotifyConfig(): NotifyConfig {
    return this.notifyConfig;
  }

  /**
   * The effective scheduled-report config. Safe default before `load()`: no
   * schedules, so nothing is ever sent — the zero-config red line, same as `getNotifyConfig`.
   * Returns the live reference; a reload swaps the whole object atomically.
   */
  getReportsConfig(): ReportsConfig {
    return this.reportsConfig;
  }

  /**
   * Persist a deployment codebook (the import endpoint's payload) as `codebook.json`, then reload
   * so `getCodebook` reflects it. The config volume must be writable (see deploy/docker-compose.yml).
   */
  importCodebook(rawEntries: unknown, expectedVersion?: string): Promise<ReportCodeEntry[]> {
    // Persist only the deployment's own entries: a built-in code sent back unchanged (the console
    // re-sends the merged table on every row edit; an exported table re-imported does the same)
    // is dropped, so built-in meanings are never frozen into the file.
    return this.writeWholeConfig(
      rawEntries,
      (raw) => codebookOverrides(DEFAULT_REPORT_CODES, parseCodebook(raw)),
      "codebook",
      "codebook-import",
      () => this.getCodebook(),
      expectedVersion,
    );
  }

  /**
   * Atomically write JSON config: write a sibling temp file then rename over the target, so
   * a crash mid-write can never leave a half-written config that the next load rejects. All
   * config writers (codebook / vehicles / formations / scenes / notify / rules / reports) go
   * through this one path.
   */
  private async writeConfigFileAtomic(filePath: string, value: unknown): Promise<void> {
    await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  /**
   * The shared body of every "replace a whole config file" writer: validate the raw payload (so a
   * malformed body throws *before* anything is written and the live snapshot is untouched),
   * atomically write it, reload so the getters reflect it, and return the fresh view. Each caller
   * supplies only what differs — its parser, target file, reload reason, and read-back getter — so
   * the validate→write→reload→read shape lives here once instead of in each writer.
   */
  private async writeWholeConfig<R>(
    raw: unknown,
    parse: (raw: unknown) => unknown,
    file: ConfigFileKey,
    reloadReason: string,
    read: () => R,
    expectedVersion?: string,
  ): Promise<R> {
    const value = parse(raw);
    return this.serialize(async () => {
      await this.writeConfigAndApply(file, value, reloadReason, expectedVersion);
      return read();
    });
  }

  /** All configured vehicles, for the onboarding wizard's read side. */
  listVehicleConfigs(): DeviceConfig[] {
    this.ensureLoaded();
    return [...this.deviceConfigs.values()].map((vehicle) => ({
      ...vehicle,
      tags: [...(vehicle.tags || [])],
    }));
  }

  /**
   * Persist `vehicles.json` from the onboarding wizard, then reload. Validates shape first
   * (`parseVehicles`); then refuses to remove a vehicle a formation still references, because
   * that would orphan `formations.json` and make the next load fail (the load enforces
   * formation→vehicle integrity). Writing config is operator-domain, not vehicle control —
   * the read-only red line (no command dispatch) holds. The config volume must be writable.
   */
  async writeVehicles(raw: unknown, expectedVersion?: string): Promise<DeviceConfig[]> {
    const vehicles = parseVehicles(raw);
    return this.serialize(() => this.writeVehiclesInternal(vehicles, expectedVersion));
  }

  private async writeVehiclesInternal(
    vehicles: DeviceConfig[],
    expectedVersion?: string,
  ): Promise<DeviceConfig[]> {
    this.ensureLoaded();
    const nextIds = new Set(vehicles.map((vehicle) => vehicle.deviceId));
    for (const formation of this.formationConfigs.values()) {
      for (const deviceId of formation.deviceIds) {
        if (!nextIds.has(deviceId)) {
          throw new Error(
            `deviceId ${deviceId} is still referenced by formation ${formation.formationId}`,
          );
        }
      }
    }
    for (const vehicle of vehicles) {
      if (vehicle.defaultSceneId && !this.sceneConfigs.has(vehicle.defaultSceneId)) {
        throw new Error(
          `vehicle ${vehicle.deviceId} references unknown scene ${vehicle.defaultSceneId}`,
        );
      }
    }
    await this.writeConfigAndApply("vehicles", vehicles, "vehicles-write", expectedVersion);
    return this.listVehicleConfigs();
  }

  /**
   * Persist `formations.json` from the wizard, then reload. Validates shape, then enforces
   * referential integrity against the **currently configured** vehicles — every `deviceId` a
   * formation names must be a known vehicle — *before* writing, so a bad reference can never
   * reach disk (a cold start would otherwise fail to load it). Mirrors the load-time check.
   */
  async writeFormations(raw: unknown, expectedVersion?: string): Promise<FormationConfig[]> {
    const formations = parseFormations(raw);
    return this.serialize(() => this.writeFormationsInternal(formations, expectedVersion));
  }

  private async writeFormationsInternal(
    formations: FormationConfig[],
    expectedVersion?: string,
  ): Promise<FormationConfig[]> {
    this.ensureLoaded();
    for (const formation of formations) {
      for (const deviceId of formation.deviceIds) {
        if (!this.deviceConfigs.has(deviceId)) {
          throw new Error(
            `formation ${formation.formationId} references unknown deviceId ${deviceId}`,
          );
        }
      }
      if (formation.sceneId && !this.sceneConfigs.has(formation.sceneId)) {
        throw new Error(
          `formation ${formation.formationId} references unknown scene ${formation.sceneId}`,
        );
      }
    }
    await this.writeConfigAndApply("formations", formations, "formations-write", expectedVersion);
    return this.listFormations();
  }

  /**
   * Persist `scenes.json` from the scene-management page, then reload. Writing scene config is
   * operator/deployment domain — the console renders these backdrops, it does not push maps to
   * vehicles — so the read-only red line holds. The config volume must be writable.
   */
  writeScenes(raw: unknown, expectedVersion?: string): Promise<SceneMapDefinition[]> {
    return this.writeWholeConfig(
      raw,
      parseScenes,
      "scenes",
      "scenes-write",
      () => this.listScenes(),
      expectedVersion,
    );
  }

  /**
   * Persist `notify.json` from the outbound-config editor (1.6.1), then reload. Channels + routing
   * only; endpoint secrets stay in env, the file holds just their `urlEnv` variable *names* — so
   * this is operator/deployment domain, not vehicle control, and the read-only red line holds.
   */
  writeNotifyConfig(raw: unknown, expectedVersion?: string): Promise<NotifyConfig> {
    return this.writeWholeConfig(
      raw,
      parseNotifyConfig,
      "notify",
      "notify-write",
      () => this.getNotifyConfig(),
      expectedVersion,
    );
  }

  /**
   * Persist `rules.json` from the 告警规则 editor (1.6.1), then reload. Retuning thresholds /
   * toggling a rule / scoping it is deployment-domain config, not vehicle control — the read-only
   * red line holds. The config volume must be writable.
   */
  writeAlertRules(raw: unknown, expectedVersion?: string): Promise<AlertRulesConfig> {
    return this.writeWholeConfig(
      raw,
      parseAlertRules,
      "rules",
      "rules-write",
      () => this.getAlertRules(),
      expectedVersion,
    );
  }

  /**
   * Persist `reports.json` from the 定时报表 editor (1.6.1), then reload. The scheduler reads the
   * config live each tick, so a write takes effect on the next poll with no restart. SMTP strings
   * (with credentials) stay in the env vars `smtpEnv` names — only those *names* live in the file —
   * so this is deployment-domain config, not command dispatch.
   */
  writeReportsConfig(raw: unknown, expectedVersion?: string): Promise<ReportsConfig> {
    return this.writeWholeConfig(
      raw,
      parseReportsConfig,
      "reports",
      "reports-write",
      () => this.getReportsConfig(),
      expectedVersion,
    );
  }

  /**
   * Store an uploaded backdrop file for a scene and return the `/scene-maps/…` URL it now lives
   * at, then reload (an `.osm` swap re-parses its overlay; a raster/point-cloud is just re-served
   * with `no-store`). Content is validated by kind. When the scene already references a file of
   * this kind *with the same extension*, that path is overwritten in place (no orphan, no
   * `scenes.json` change). Otherwise — no file yet, or an SVG replaced by a PNG, which the static
   * server would keep serving as `image/svg+xml` — the file lands at a server-chosen
   * `<sceneId>/<kind>.<ext>` and the caller saves the new URL into `scenes.json`. The filename is
   * never taken from the client, and the resolved path is re-checked against the scene-maps root.
   *
   * Runs in the config queue like every other config write, and takes effect or not at all: if the
   * configuration cannot load with the new file, the previous bytes are put back and a
   * `ConfigApplyError` says why.
   */
  async writeSceneAsset(sceneId: string, kind: SceneAssetKind, buffer: Buffer): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(sceneId) || /^\.+$/.test(sceneId)) {
      throw new SceneAssetValidationError(`invalid sceneId: ${sceneId}`);
    }
    const ext = validateSceneAsset(kind, buffer);
    return this.serialize(async () => {
      this.ensureLoaded();
      const existingUrl = this.sceneConfigs.get(sceneId)?.[SCENE_ASSET_URL_FIELD[kind]];
      const url =
        typeof existingUrl === "string" &&
        existingUrl.startsWith("/scene-maps/") &&
        normalizedExtension(existingUrl) === ext
          ? existingUrl
          : `/scene-maps/${sceneId}/${kind}.${ext}`;
      const targetPath = resolveSceneMapsFilePath(url);
      const previous = await fs.readFile(targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await writeFileAtomic(targetPath, buffer);
      // A file that was already degraded stays the operator's known problem; a file this upload
      // knocks back to its last-good copy (scenes.json, when the scene cannot load with the new
      // file) means the upload did not take effect.
      const degradedBefore = new Set(this.status.issues.map((issue) => issue.file));
      let failure: string;
      try {
        const loaded = await this.loadWithFallback();
        const rejected = loaded.issues.find((issue) => !degradedBefore.has(issue.file));
        if (rejected) {
          failure = rejected.message;
        } else {
          await this.commitLoaded(loaded);
          this.logLoad("scene-asset-upload");
          return url;
        }
      } catch (error) {
        failure = describeConfigError(error);
      }
      if (previous === null) {
        await fs.rm(targetPath, { force: true });
      } else {
        await writeFileAtomic(targetPath, previous);
      }
      throw new ConfigApplyError(`${path.basename(url)} 上传后无法生效，已回滚：${failure}`);
    });
  }

  getDeviceConfig(deviceId: string): DeviceConfig | null {
    this.ensureLoaded();
    if (!deviceId) {
      return null;
    }
    const configEntry = this.deviceConfigs.get(deviceId);
    return configEntry ? { ...configEntry, tags: [...(configEntry.tags || [])] } : null;
  }

  /**
   * Whether `vehicles.json` declares this device. Separate from
   * `getDeviceConfig` because the ingest admission gate asks this per message and
   * has no use for the copy that one allocates.
   */
  hasDeviceConfig(deviceId: string): boolean {
    this.ensureLoaded();
    return deviceId ? this.deviceConfigs.has(deviceId) : false;
  }

  listFormations(): FormationConfig[] {
    this.ensureLoaded();
    return [...this.formationConfigs.values()].map((formation) => ({
      ...formation,
      deviceIds: [...formation.deviceIds],
    }));
  }

  listScenes(): SceneMapDefinition[] {
    this.ensureLoaded();
    return [...this.sceneConfigs.values()].map((scene) => ({
      ...scene,
      origin: { ...scene.origin },
      bounds: scene.bounds ? { ...scene.bounds } : undefined,
      defaultView: scene.defaultView ? { ...scene.defaultView } : undefined,
    }));
  }

  getScene(sceneId: string): SceneMapDefinition | null {
    this.ensureLoaded();
    if (!sceneId) {
      return null;
    }
    const scene = this.sceneConfigs.get(sceneId);
    return scene
      ? {
          ...scene,
          origin: { ...scene.origin },
          bounds: scene.bounds ? { ...scene.bounds } : undefined,
          defaultView: scene.defaultView ? { ...scene.defaultView } : undefined,
        }
      : null;
  }

  getSceneOverlay(sceneId: string): LaneletOverlay | null {
    this.ensureLoaded();
    if (!sceneId) {
      return null;
    }

    const overlay = this.sceneOverlays.get(sceneId);
    return overlay ? cloneOverlay(overlay) : null;
  }

  applyDeviceConfig(snapshot: DeviceSnapshot): DeviceSnapshot {
    this.ensureLoaded();

    const deviceConfig = this.deviceConfigs.get(snapshot.deviceId);
    const fleetConfig = this.fleetConfig;
    const runtimeSceneId = snapshot.runtimeSceneId || snapshot.sceneId || "";
    const defaultSceneId =
      deviceConfig?.defaultSceneId || snapshot.defaultSceneId || fleetConfig.defaultSceneId || "";
    const sceneId = runtimeSceneId || defaultSceneId || "";
    const deviceName =
      deviceConfig?.deviceName?.trim() ||
      snapshot.deviceName?.trim() ||
      `设备 ${snapshot.deviceId}`;

    return {
      ...snapshot,
      deviceName,
      defaultSceneId,
      runtimeSceneId,
      sceneId,
      gpsEnabled: deviceConfig?.gpsEnabled ?? snapshot.gpsEnabled ?? fleetConfig.defaultGpsEnabled,
      rosMapEnabled:
        deviceConfig?.rosMapEnabled ?? snapshot.rosMapEnabled ?? fleetConfig.defaultRosMapEnabled,
      tags: [...(deviceConfig?.tags || snapshot.tags || [])],
      formationIds: [
        ...(this.deviceFormationIds.get(snapshot.deviceId) || snapshot.formationIds || []),
      ],
      // Identity / spec metadata (optional, display-only); config overrides any carried value.
      vendor: deviceConfig?.vendor ?? snapshot.vendor,
      model: deviceConfig?.model ?? snapshot.model,
      serialNumber: deviceConfig?.serialNumber ?? snapshot.serialNumber,
      category: deviceConfig?.category ?? snapshot.category,
      maxLoadKg: deviceConfig?.maxLoadKg ?? snapshot.maxLoadKg,
      commissionedAt: deviceConfig?.commissionedAt ?? snapshot.commissionedAt,
      notes: deviceConfig?.notes ?? snapshot.notes,
    };
  }

  buildFormationSnapshots(devices: Iterable<DeviceSnapshot>): FormationSnapshot[] {
    this.ensureLoaded();

    const devicesById = new Map<string, DeviceSnapshot>();
    for (const device of devices) {
      devicesById.set(device.deviceId, device);
    }

    return [...this.formationConfigs.values()].map((formation) => {
      const memberDevices = formation.deviceIds
        .map((deviceId) => devicesById.get(deviceId))
        .filter((device): device is DeviceSnapshot => !!device);
      const sceneCandidates = memberDevices
        .map((device) => device.sceneId || device.runtimeSceneId || device.defaultSceneId || "")
        .filter(Boolean);
      const uniqueScenes = [...new Set(sceneCandidates)];
      const sceneId =
        formation.sceneId ||
        (uniqueScenes.length === 1
          ? uniqueScenes[0]
          : memberDevices[0]?.sceneId || memberDevices[0]?.defaultSceneId) ||
        "";

      return {
        formationId: formation.formationId,
        formationName: formation.formationName,
        deviceIds: [...formation.deviceIds],
        deviceCount: formation.deviceIds.length,
        onlineCount: memberDevices.filter((device) => device.online).length,
        sceneId,
        description: formation.description || "",
        color: formation.color || "",
      };
    });
  }
}
