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
  mergeCodebook,
  parseCodebook,
} from "@navfleet/shared";
import { config, runtimePaths } from "./config";
import { parseLaneletOsmFile } from "./laneletOsm";
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

const deriveBounds = (scene: SceneMapDefinition): NonNullable<SceneMapDefinition["bounds"]> => ({
  minX: scene.origin.x,
  maxX: scene.origin.x + scene.width * scene.resolution,
  minY: scene.origin.y,
  maxY: scene.origin.y + scene.height * scene.resolution,
});

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

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content) as T;
}

/**
 * Like `readJsonFile`, but a **missing** file is not an error — it resolves to `null`.
 * `rules.json` is optional: a deployment that does not retune anything ships without one
 * and runs on `DEFAULT_ALERT_RULES`. A file that exists but is malformed still throws, so
 * a typo is a validation failure (old snapshot kept), not a silent fall-back to defaults.
 */
async function readOptionalJsonFile<T>(filePath: string): Promise<T | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return JSON.parse(content) as T;
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
  { min = 0, allowMinInclusive = true }: { min?: number; allowMinInclusive?: boolean } = {},
): number | undefined => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number: ${RULES_FILE}`);
  }
  if (allowMinInclusive ? value < min : value <= min) {
    throw new Error(`${label} must be ${allowMinInclusive ? ">=" : ">"} ${min}: ${RULES_FILE}`);
  }
  return value;
};

/**
 * Merge a deployment's (partial, untrusted) `rules.json` over the built-in defaults into a
 * fully-populated, validated `AlertRulesConfig`. Anything the file omits keeps its default;
 * anything malformed throws, so `reload` keeps the previous snapshot. Unknown top-level keys
 * are ignored rather than rejected, so a newer file stays loadable by an older build.
 */
const parseAlertRules = (raw: unknown): AlertRulesConfig => {
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
const parseRecipient = (raw: unknown, label: string): NotifyRecipient => {
  if (!isRecord(raw)) {
    throw new Error(`${label} must be a JSON object: ${NOTIFY_FILE}`);
  }
  const email = parseOptionalString(raw.email, `${label}.email`);
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
  if (typeof raw.from !== "string" || typeof raw.to !== "string") {
    throw new Error(`${label} must have string from/to ("HH:MM"): ${NOTIFY_FILE}`);
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
  if (!urlEnv) {
    // The endpoint URL / SMTP string carries a secret, so a channel names the env var that holds
    // it rather than the value itself — this field is that name and is required.
    throw new Error(
      `${label}.urlEnv must be a non-empty environment variable name: ${NOTIFY_FILE} (${id})`,
    );
  }

  return {
    id,
    type: type as NotifyChannelType,
    enabled: parseBoolean(raw.enabled, true, `${label}.enabled`, NOTIFY_FILE),
    urlEnv,
    severities: parseSeverities(raw.severities, label),
    scope: parseRuleScope(raw.scope, label, NOTIFY_FILE),
    from: parseOptionalString(raw.from, `${label}.from`),
    recipients: parseRecipients(raw.recipients, `${label}.recipients`),
    groups: parseStringList(raw.groups, `${label}.groups`),
    digestSeconds: parsePositiveNumber(raw.digestSeconds, undefined, `${label}.digestSeconds`),
    digestSeverities:
      raw.digestSeverities === undefined
        ? undefined
        : parseSeverities(raw.digestSeverities, `${label}.digest`),
    renotifySeconds: parsePositiveNumber(
      raw.renotifySeconds,
      undefined,
      `${label}.renotifySeconds`,
    ),
    silenceWindows: parseSilenceWindows(raw.silenceWindows, `${label}.silenceWindows`),
    escalation: parseEscalation(raw.escalation, `${label}.escalation`),
  };
};

/**
 * Merge a deployment's (partial, untrusted) `notify.json` into a validated `NotifyConfig`.
 * A missing file → `DEFAULT_NOTIFY_CONFIG` (no channels, so nothing is ever sent — the
 * zero-config red line). A present-but-malformed file throws, so `reload` keeps the previous
 * snapshot. Channel ids must be unique. Unknown top-level keys are ignored (forward-compat).
 */
const parseNotifyConfig = (raw: unknown): NotifyConfig => {
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

  return groups ? { channels, groups } : { channels };
};

/** `HH:MM`, 24-hour. The scheduler compares this to the wall clock in the deployment timezone. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  const from = parseOptionalString(raw.from, `${label}.from`);
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
  return {
    id,
    enabled: parseBoolean(raw.enabled, true, `${label}.enabled`, REPORTS_FILE),
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
const parseReportsConfig = (raw: unknown): ReportsConfig => {
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
  private reloadQueue: Promise<void> = Promise.resolve();
  private pendingReloadReason = "startup";

  private async loadSnapshot(): Promise<LoadedConfigSnapshot> {
    const [
      fleetRaw,
      vehiclesRaw,
      formationsRaw,
      scenesRaw,
      rulesRaw,
      codebookRaw,
      notifyRaw,
      reportsRaw,
    ] = await Promise.all([
      readJsonFile<unknown>(FLEET_FILE),
      readJsonFile<unknown>(VEHICLES_FILE),
      readJsonFile<unknown>(FORMATIONS_FILE),
      readJsonFile<unknown>(SCENES_FILE),
      readOptionalJsonFile<unknown>(RULES_FILE),
      readOptionalJsonFile<unknown>(CODEBOOK_FILE),
      readOptionalJsonFile<unknown>(NOTIFY_FILE),
      readOptionalJsonFile<unknown>(REPORTS_FILE),
    ]);

    const alertRules = parseAlertRules(rulesRaw);
    // A deployment's codebook.json (if any) is validated then layered over the built-in
    // table; the merged result is what `getCodebook` 下发s. Missing file = the built-in table.
    const codebook = mergeCodebook(
      DEFAULT_REPORT_CODES,
      codebookRaw === null ? [] : parseCodebook(codebookRaw),
    );
    // Missing notify.json = no channels = nothing is ever sent (the zero-config red line).
    const notifyConfig = parseNotifyConfig(notifyRaw);
    // Missing reports.json = no schedules = no scheduled email (same red line, Phase 17B-2).
    const reportsConfig = parseReportsConfig(reportsRaw);

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

  async load(): Promise<void> {
    const snapshot = await this.loadSnapshot();
    this.applySnapshot(snapshot);
    this.logLoad("startup");
  }

  async reload(reason = "manual"): Promise<boolean> {
    try {
      const snapshot = await this.loadSnapshot();
      this.applySnapshot(snapshot);
      this.logLoad(reason);
      return true;
    } catch (error) {
      logger.error(
        { err: error, reason, configRoot: CONFIG_ROOT },
        "Failed to reload backend config registry",
      );
      return false;
    }
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
        path.join(runtimePaths.sceneMapsPath, "**/*.osm"),
      ],
      {
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
        this.reloadQueue = this.reloadQueue
          .then(async () => {
            const didReload = await this.reload(reason);
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
   * The alert rules ingest evaluates against (Phase 16C-1). Returns the live snapshot
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
   * `codebook.json` layered over it (Phase 16C-2). Like `getAlertRules`, does not require
   * the registry to be loaded: it defaults to the built-in table, so a code lookup before
   * `load()` still resolves. Returns a copy so a caller cannot mutate the live snapshot.
   */
  getCodebook(): ReportCodeEntry[] {
    return this.codebook.map((entry) => ({ ...entry }));
  }

  /**
   * The outbound-notification config in effect (Phase 16D-1) — the deployment's `notify.json`,
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
   * The effective scheduled-report config (Phase 17B-2). Safe default before `load()`: no
   * schedules, so nothing is ever sent — the zero-config red line, same as `getNotifyConfig`.
   * Returns the live reference; a reload swaps the whole object atomically.
   */
  getReportsConfig(): ReportsConfig {
    return this.reportsConfig;
  }

  /**
   * Persist a deployment codebook (the import endpoint's payload) as `codebook.json`, then
   * reload so `getCodebook` reflects it. Validates first via `parseCodebook`, so an invalid
   * payload throws *before* anything is written and the live snapshot is untouched. The
   * config volume must be writable for this to succeed (see deploy/docker-compose.yml).
   */
  async importCodebook(rawEntries: unknown): Promise<ReportCodeEntry[]> {
    const entries = parseCodebook(rawEntries);
    await fs.writeFile(CODEBOOK_FILE, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await this.reload("codebook-import");
    return this.getCodebook();
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
