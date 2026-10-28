import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DeviceSnapshot, FleetConfig, SceneMapDefinition } from "../src/types";
import { DEFAULT_ALERT_RULES, DEFAULT_REPORT_CODES } from "@navfleet/shared";
import { SAMPLE_OSM, sampleDevice } from "./helpers/fixtures";

/**
 * ConfigRegistry resolves its file paths from src/config at module load time, so
 * CONFIG_ROOT_PATH is pointed at a throwaway directory before the module is
 * imported (hence the dynamic import). The repo's real config-runtime is never
 * touched.
 */
let configRoot = "";
let ConfigRegistry: typeof import("../src/configRegistry").ConfigRegistry;
type ConfigRegistryType = import("../src/configRegistry").ConfigRegistry;
let SceneAssetValidationError: typeof import("../src/configRegistry").SceneAssetValidationError;
let ConfigApplyError: typeof import("../src/configRegistry").ConfigApplyError;
let ConfigConflictError: typeof import("../src/configRegistry").ConfigConflictError;

const DEFAULT_FLEET: FleetConfig = {
  fleetName: "临时车队",
  topicPattern: "/tmp/{deviceId}/vehicle_info",
  defaultSceneId: "scene-a",
  defaultGpsEnabled: false,
  defaultRosMapEnabled: true,
};

const DEFAULT_VEHICLES = [
  {
    deviceId: "agv-1",
    deviceName: "临时车 1",
    tags: ["a", "b"],
    gpsEnabled: false,
  },
  { deviceId: "agv-2" },
];

const DEFAULT_FORMATIONS = [
  { formationId: "formation-a", formationName: "编队 A", deviceIds: ["agv-1", "agv-2"] },
];

const DEFAULT_SCENES: Array<Partial<SceneMapDefinition>> = [
  {
    sceneId: "scene-a",
    sceneName: "场景 A",
    resolution: 0.05,
    width: 100,
    height: 200,
    origin: { x: 1, y: 2, yaw: 0 },
  },
];

interface ConfigFiles {
  fleet?: unknown;
  vehicles?: unknown;
  formations?: unknown;
  scenes?: unknown;
  /** `rules.json` is optional. Pass a value to write it; omit to leave none on disk. */
  rules?: unknown;
  /** `codebook.json` is optional. Pass a value to write it; omit to leave none on disk. */
  codebook?: unknown;
  /** `notify.json` is optional. Pass a value to write it; omit to leave none on disk. */
  notify?: unknown;
  /** `reports.json` is optional. Pass a value to write it; omit to leave none on disk. */
  reports?: unknown;
}

const writeConfig = async (files: ConfigFiles = {}): Promise<void> => {
  const entries: Array<[string, unknown]> = [
    ["fleet.json", files.fleet ?? DEFAULT_FLEET],
    ["vehicles.json", files.vehicles ?? DEFAULT_VEHICLES],
    ["formations.json", files.formations ?? DEFAULT_FORMATIONS],
    ["scenes.json", files.scenes ?? DEFAULT_SCENES],
  ];
  await Promise.all(
    entries.map(([filename, value]) =>
      fs.writeFile(path.join(configRoot, filename), JSON.stringify(value), "utf8"),
    ),
  );
  // rules.json is optional: write it only when the case supplies one, and otherwise make
  // sure a file left by an earlier case in this shared temp dir does not leak forward.
  const rulesPath = path.join(configRoot, "rules.json");
  if (files.rules === undefined) {
    await fs.rm(rulesPath, { force: true });
  } else if (typeof files.rules === "string") {
    await fs.writeFile(rulesPath, files.rules, "utf8");
  } else {
    await fs.writeFile(rulesPath, JSON.stringify(files.rules), "utf8");
  }
  // codebook.json is optional too, same rules as rules.json.
  const codebookPath = path.join(configRoot, "codebook.json");
  if (files.codebook === undefined) {
    await fs.rm(codebookPath, { force: true });
  } else if (typeof files.codebook === "string") {
    await fs.writeFile(codebookPath, files.codebook, "utf8");
  } else {
    await fs.writeFile(codebookPath, JSON.stringify(files.codebook), "utf8");
  }
  // notify.json is optional too, same rules as rules.json.
  const notifyPath = path.join(configRoot, "notify.json");
  if (files.notify === undefined) {
    await fs.rm(notifyPath, { force: true });
  } else if (typeof files.notify === "string") {
    await fs.writeFile(notifyPath, files.notify, "utf8");
  } else {
    await fs.writeFile(notifyPath, JSON.stringify(files.notify), "utf8");
  }
  // reports.json is optional too, same rules as rules.json.
  const reportsPath = path.join(configRoot, "reports.json");
  if (files.reports === undefined) {
    await fs.rm(reportsPath, { force: true });
  } else if (typeof files.reports === "string") {
    await fs.writeFile(reportsPath, files.reports, "utf8");
  } else {
    await fs.writeFile(reportsPath, JSON.stringify(files.reports), "utf8");
  }
};

beforeAll(async () => {
  configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "navfleet-config-registry-"));
  await fs.mkdir(path.join(configRoot, "scene-maps"), { recursive: true });
  process.env.CONFIG_ROOT_PATH = configRoot;
  // The ".js" specifier is the TS/Node16 convention for a relative ESM import.
  ({ ConfigRegistry, SceneAssetValidationError, ConfigApplyError, ConfigConflictError } =
    await import("../src/configRegistry.js"));
});

// Each case starts with no remembered good configuration: a broken file must be judged on its own,
// not rescued by a copy an earlier case left behind in this shared temp dir.
beforeEach(async () => {
  await fs.rm(path.join(configRoot, ".last-good"), { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.CONFIG_ROOT_PATH;
  await fs.rm(configRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeConfig();
});

/**
 * An optional config file that does not validate no longer stops the backend: it is held back,
 * its built-in defaults (or last-good copy) take effect, and the status names the file and why.
 */
const expectFileRejected = async (file: string, message?: RegExp): Promise<ConfigRegistryType> => {
  const registry = new ConfigRegistry();
  await registry.load();
  const status = registry.getConfigStatus();
  expect(status.ok).toBe(false);
  const issue = status.issues.find((entry) => entry.file === file);
  expect(issue, `an issue for ${file}`).toBeDefined();
  if (message) expect(issue!.message).toMatch(message);
  return registry;
};

describe("ConfigRegistry.load", () => {
  it("loads fleet, vehicle, formation and scene config from disk", async () => {
    const registry = new ConfigRegistry();
    await registry.load();

    expect(registry.getFleetConfig()).toMatchObject({
      fleetName: "临时车队",
      topicPattern: "/tmp/{deviceId}/vehicle_info",
      defaultGpsEnabled: false,
    });

    expect(registry.getDeviceConfig("agv-1")).toMatchObject({
      deviceId: "agv-1",
      deviceName: "临时车 1",
      tags: ["a", "b"],
    });
    // deviceName falls back to the id, tags to an empty list.
    expect(registry.getDeviceConfig("agv-2")).toMatchObject({ deviceName: "agv-2", tags: [] });
    expect(registry.getDeviceConfig("unknown")).toBeNull();

    expect(registry.listFormations()).toHaveLength(1);
    const scenes = registry.listScenes();
    expect(scenes).toHaveLength(1);
    // bounds are derived from origin + width/height * resolution.
    expect(scenes[0]?.bounds).toEqual({ minX: 1, maxX: 6, minY: 2, maxY: 12 });
    expect(registry.getScene("scene-a")?.sceneName).toBe("场景 A");
    expect(registry.getScene("missing")).toBeNull();
    // No osmUrl, so there is no overlay to serve.
    expect(registry.getSceneOverlay("scene-a")).toBeNull();
  });

  it("tolerates config naming a non-existent scene — loads, blanks the dangling reference", async () => {
    await writeConfig({
      vehicles: [{ deviceId: "agv-1", defaultSceneId: "ghost" }, { deviceId: "agv-2" }],
      formations: [
        { formationId: "f", formationName: "F", deviceIds: ["agv-1"], sceneId: "ghost" },
      ],
    });
    const registry = new ConfigRegistry();
    // A hand-edited typo must not crash the stack — load resolves, not rejects.
    await registry.load();

    // The dangling vehicle default scene is treated as unset…
    expect(registry.getDeviceConfig("agv-1")?.defaultSceneId).toBeUndefined();
    // …and the formation's ghost scene never surfaces on its snapshot.
    const formation = registry.listFormations().find((f) => f.formationId === "f");
    expect(formation?.sceneId).not.toBe("ghost");
  });

  it("applies device config and formation membership to a snapshot", async () => {
    const registry = new ConfigRegistry();
    await registry.load();

    const raw: DeviceSnapshot = {
      ...sampleDevice(),
      deviceId: "agv-1",
      deviceName: "",
      tags: [],
      formationIds: [],
      runtimeSceneId: "",
      defaultSceneId: "",
      sceneId: "",
    };
    const applied = registry.applyDeviceConfig(raw);

    expect(applied.deviceName).toBe("临时车 1");
    expect(applied.tags).toEqual(["a", "b"]);
    expect(applied.formationIds).toEqual(["formation-a"]);
    // Falls back to the fleet-wide default scene.
    expect(applied.defaultSceneId).toBe("scene-a");
    expect(applied.sceneId).toBe("scene-a");
    // Device config wins over the reported snapshot value, which in turn wins
    // over the fleet-wide default.
    expect(applied.gpsEnabled).toBe(false);

    const [formation] = registry.buildFormationSnapshots([applied]);
    expect(formation).toMatchObject({
      formationId: "formation-a",
      deviceCount: 2,
      onlineCount: 1,
      sceneId: "scene-a",
    });
  });

  it("refuses to serve config before load()", () => {
    const registry = new ConfigRegistry();
    expect(() => registry.getFleetConfig()).toThrow(/has not been loaded/);
    expect(() => registry.listScenes()).toThrow(/has not been loaded/);
  });
});

describe("ConfigRegistry validation", () => {
  it.each([
    {
      name: "fleet.json is not an object",
      files: { fleet: [] } satisfies ConfigFiles,
      message: /fleet\.json must be a JSON object/,
    },
    {
      name: "vehicles.json is not an array",
      files: { vehicles: {} } satisfies ConfigFiles,
      message: /vehicles\.json must be a JSON array/,
    },
    {
      name: "a vehicles.json entry is not an object",
      files: { vehicles: ["agv-1"] } satisfies ConfigFiles,
      message: /vehicles\.json entry must be a JSON object/,
    },
    {
      name: "a vehicle has no deviceId",
      files: { vehicles: [{ deviceName: "no id" }] } satisfies ConfigFiles,
      message: /missing deviceId/,
    },
    {
      name: "a deviceId is duplicated",
      files: { vehicles: [{ deviceId: "agv-1" }, { deviceId: "agv-1" }] } satisfies ConfigFiles,
      message: /Duplicate deviceId/,
    },
    {
      name: "a formation has no deviceIds",
      files: {
        formations: [{ formationId: "formation-a", deviceIds: [] }],
      } satisfies ConfigFiles,
      message: /missing deviceIds/,
    },
    {
      name: "a formation references an unknown device",
      files: {
        formations: [{ formationId: "formation-a", deviceIds: ["ghost"] }],
      } satisfies ConfigFiles,
      message: /references unknown deviceId ghost/,
    },
    {
      name: "a scene is missing its geometry",
      files: { scenes: [{ sceneId: "scene-a" }] } satisfies ConfigFiles,
      message: /missing width\/height\/resolution\/origin/,
    },
    {
      name: "a sceneId is duplicated",
      files: { scenes: [...DEFAULT_SCENES, ...DEFAULT_SCENES] } satisfies ConfigFiles,
      message: /Duplicate sceneId/,
    },
  ])("rejects the config when $name", async ({ files, message }) => {
    await writeConfig(files);
    const registry = new ConfigRegistry();
    await expect(registry.load()).rejects.toThrow(message);
  });

  it("starts on the last-good copy when a required file breaks after a clean load", async () => {
    await writeConfig();
    await new ConfigRegistry().load(); // records the last-good copies
    await fs.writeFile(path.join(configRoot, "scenes.json"), "{ not json", "utf8");

    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.listScenes()).toHaveLength(1);
    expect(registry.getConfigStatus().issues).toEqual([
      expect.objectContaining({ file: "scenes.json", using: "last-good" }),
    ]);
  });

  it("rejects unparseable JSON", async () => {
    await fs.writeFile(path.join(configRoot, "scenes.json"), "{ not json", "utf8");
    await expect(new ConfigRegistry().load()).rejects.toThrow();
  });

  it("keeps the previous snapshot when a reload fails", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.listScenes()).toHaveLength(1);

    await writeConfig({ vehicles: {} });
    // The broken vehicles.json is held back on its last-good copy, everything else reloads.
    await expect(registry.reload("test")).resolves.toBe(true);
    expect(registry.getDeviceConfig("agv-1")).not.toBeNull();
    expect(registry.listScenes()).toHaveLength(1);
    expect(registry.getConfigStatus().issues).toEqual([
      expect.objectContaining({ file: "vehicles.json", using: "last-good" }),
    ]);

    await writeConfig({ vehicles: [{ deviceId: "agv-1" }, { deviceId: "agv-2" }] });
    await expect(registry.reload("test")).resolves.toBe(true);
  });
});

describe("ConfigRegistry.getAlertRules (Phase 16C-1)", () => {
  it("returns the built-in defaults before load() and when no rules.json exists", async () => {
    const registry = new ConfigRegistry();
    // Unlike the other getters, this one has a safe default and does not throw pre-load —
    // a frame arriving before the first load still evaluates against the built-in rules.
    expect(registry.getAlertRules()).toEqual({
      lowBattery: { enabled: true, thresholdPct: 20, debounceSeconds: 0 },
      offline: { enabled: true },
    });

    await writeConfig();
    await registry.load();
    expect(registry.getAlertRules().lowBattery.thresholdPct).toBe(20);
  });

  it("merges a deployment's rules.json over the defaults", async () => {
    await writeConfig({
      rules: {
        lowBattery: {
          enabled: true,
          thresholdPct: 30,
          scope: { formationIds: ["formation-a"], tags: ["cold"] },
          debounceSeconds: 45,
        },
        offline: { enabled: false, afterSeconds: 90, scope: { deviceIds: ["agv-1"] } },
      },
    });
    const registry = new ConfigRegistry();
    await registry.load();

    expect(registry.getAlertRules()).toEqual({
      lowBattery: {
        enabled: true,
        thresholdPct: 30,
        scope: { deviceIds: undefined, formationIds: ["formation-a"], tags: ["cold"] },
        debounceSeconds: 45,
      },
      offline: {
        enabled: false,
        afterSeconds: 90,
        scope: { deviceIds: ["agv-1"], formationIds: undefined, tags: undefined },
        debounceSeconds: undefined,
      },
    });
  });

  it("keeps every default a partial rules.json omits", async () => {
    await writeConfig({ rules: { offline: { enabled: false } } });
    const registry = new ConfigRegistry();
    await registry.load();

    const rules = registry.getAlertRules();
    // Only offline.enabled was set; low battery is untouched.
    expect(rules.lowBattery).toEqual({ enabled: true, thresholdPct: 20, debounceSeconds: 0 });
    expect(rules.offline.enabled).toBe(false);
  });

  it("ignores unknown top-level keys so a newer file stays loadable", async () => {
    await writeConfig({ rules: { speeding: { enabled: true }, offline: { afterSeconds: 120 } } });
    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.getAlertRules().offline.afterSeconds).toBe(120);
  });

  it.each([
    {
      name: "rules.json is not an object",
      rules: [],
      message: /rules\.json must be a JSON object/,
    },
    {
      name: "a rule is not an object",
      rules: { lowBattery: 20 },
      message: /rules\.lowBattery must be a JSON object/,
    },
    {
      name: "enabled is not a boolean",
      rules: { lowBattery: { enabled: "yes" } },
      message: /rules\.lowBattery\.enabled must be a boolean/,
    },
    {
      name: "a threshold is not a number",
      rules: { lowBattery: { thresholdPct: "low" } },
      message: /rules\.lowBattery\.thresholdPct must be a finite number/,
    },
    {
      name: "a threshold is not positive",
      rules: { lowBattery: { thresholdPct: 0 } },
      message: /rules\.lowBattery\.thresholdPct must be > 0/,
    },
    {
      name: "a debounce is negative",
      rules: { lowBattery: { debounceSeconds: -1 } },
      message: /rules\.lowBattery\.debounceSeconds must be >= 0/,
    },
    {
      name: "a scope is not an object",
      rules: { offline: { scope: [] } },
      message: /rules\.offline\.scope must be a JSON object/,
    },
    {
      name: "a scope dimension is not a string array",
      rules: { offline: { scope: { deviceIds: [1, 2] } } },
      message: /rules\.offline\.scope\.deviceIds must be an array of strings/,
    },
  ])("holds back rules.json when $name, running on the defaults", async ({ rules, message }) => {
    await writeConfig({ rules });
    const registry = await expectFileRejected("rules.json", message);
    expect(registry.getAlertRules()).toEqual(DEFAULT_ALERT_RULES);
    expect(registry.getConfigStatus().issues[0]?.using).toBe("default");
  });

  it("holds back out-of-range rules (a percentage over 100, a window over a day)", async () => {
    await writeConfig({ rules: { lowBattery: { thresholdPct: 120 } } });
    await expectFileRejected("rules.json", /<= 100/);
    await writeConfig({ rules: { offline: { afterSeconds: 90_000 } } });
    await expectFileRejected("rules.json", /<= 86400/);
  });

  it("holds back unparseable rules.json", async () => {
    await writeConfig({ rules: "{ not json" });
    await expectFileRejected("rules.json", /not valid JSON/);
  });

  it("keeps the previous rules when a rules.json reload fails", async () => {
    await writeConfig({ rules: { lowBattery: { thresholdPct: 25 } } });
    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.getAlertRules().lowBattery.thresholdPct).toBe(25);

    await writeConfig({ rules: { lowBattery: { thresholdPct: "bad" } } });
    // The broken file is held back on its last-good copy; the reload itself still succeeds.
    await expect(registry.reload("test")).resolves.toBe(true);
    expect(registry.getAlertRules().lowBattery.thresholdPct).toBe(25);
    expect(registry.getConfigStatus().issues).toEqual([
      expect.objectContaining({ file: "rules.json", using: "last-good" }),
    ]);

    await writeConfig({ rules: { lowBattery: { thresholdPct: 40 } } });
    await expect(registry.reload("test")).resolves.toBe(true);
    expect(registry.getAlertRules().lowBattery.thresholdPct).toBe(40);
    expect(registry.getConfigStatus().ok).toBe(true);
  });
});

describe("ConfigRegistry.getCodebook / importCodebook (Phase 16C-2)", () => {
  const override = {
    code: 2301,
    channel: "warning",
    subsystem: "power",
    label: "本厂电量低",
    description: "低于本厂阈值",
    hint: "推去充电区",
    impact: "urgent",
  };

  it("returns the built-in table before load() and when no codebook.json exists", async () => {
    const registry = new ConfigRegistry();
    expect(registry.getCodebook()).toHaveLength(DEFAULT_REPORT_CODES.length);

    await writeConfig();
    await registry.load();
    expect(registry.getCodebook()).toHaveLength(DEFAULT_REPORT_CODES.length);
  });

  it("layers a deployment codebook.json over the built-in table", async () => {
    await writeConfig({ codebook: [override, { ...override, code: 9001, label: "本厂新码" }] });
    const registry = new ConfigRegistry();
    await registry.load();

    const byCode = new Map(registry.getCodebook().map((entry) => [entry.code, entry]));
    expect(byCode.get(2301)?.label).toBe("本厂电量低"); // override wins
    expect(byCode.get(9001)?.label).toBe("本厂新码"); // new code added
    expect(byCode.get(1101)?.label).toBe("定位稳定"); // untouched built-in survives
    // Merged table is longer than the built-in by exactly the one net-new code.
    expect(registry.getCodebook()).toHaveLength(DEFAULT_REPORT_CODES.length + 1);
  });

  it("rejects a malformed codebook.json on load", async () => {
    await writeConfig({ codebook: [{ ...override, code: 0 }] });
    await expectFileRejected("codebook.json", /code must be a positive integer/);
  });

  it("keeps the previous codebook when a reload fails", async () => {
    await writeConfig({ codebook: [override] });
    const registry = new ConfigRegistry();
    await registry.load();
    expect(new Map(registry.getCodebook().map((e) => [e.code, e])).get(2301)?.label).toBe(
      "本厂电量低",
    );

    await writeConfig({ codebook: [{ ...override, impact: "nope" }] });
    await expect(registry.reload("test")).resolves.toBe(true);
    expect(registry.getConfigStatus().issues[0]).toMatchObject({
      file: "codebook.json",
      using: "last-good",
    });
    // Old snapshot kept.
    expect(new Map(registry.getCodebook().map((e) => [e.code, e])).get(2301)?.label).toBe(
      "本厂电量低",
    );
  });

  it("persists an imported codebook and reflects it in getCodebook", async () => {
    await writeConfig();
    const registry = new ConfigRegistry();
    await registry.load();

    const merged = await registry.importCodebook([override]);
    expect(new Map(merged.map((e) => [e.code, e])).get(2301)?.label).toBe("本厂电量低");
    // Written to disk as codebook.json.
    const onDisk: unknown = JSON.parse(
      await fs.readFile(path.join(configRoot, "codebook.json"), "utf8"),
    );
    expect(onDisk).toEqual([override]);
    // A fresh registry loading the same dir sees it.
    const reloaded = new ConfigRegistry();
    await reloaded.load();
    expect(new Map(reloaded.getCodebook().map((e) => [e.code, e])).get(2301)?.label).toBe(
      "本厂电量低",
    );
  });

  it("writes only the deployment's own entries, never freezing unchanged built-ins", async () => {
    await writeConfig();
    const registry = new ConfigRegistry();
    await registry.load();

    // What the console sends on a row edit: the whole merged table, with one built-in re-defined.
    const fullTable = registry
      .getCodebook()
      .map((entry) => (entry.code === override.code ? override : entry));
    await registry.importCodebook(fullTable);

    const onDisk: unknown = JSON.parse(
      await fs.readFile(path.join(configRoot, "codebook.json"), "utf8"),
    );
    expect(onDisk).toEqual([override]);
    // Dropping the override from the table and writing again restores the built-in meaning.
    const restored = await registry.importCodebook(
      registry.getCodebook().filter((entry) => entry.code !== override.code),
    );
    expect(restored.find((entry) => entry.code === override.code)?.label).not.toBe("本厂电量低");
    expect(
      JSON.parse(await fs.readFile(path.join(configRoot, "codebook.json"), "utf8")) as unknown,
    ).toEqual([]);
  });

  it("rejects an invalid import without writing anything", async () => {
    await writeConfig();
    const registry = new ConfigRegistry();
    await registry.load();
    await expect(registry.importCodebook([{ ...override, code: -1 }])).rejects.toThrow(
      /code must be a positive integer/,
    );
    // Nothing written.
    await expect(fs.readFile(path.join(configRoot, "codebook.json"), "utf8")).rejects.toThrow();
  });
});

describe("ConfigRegistry.getNotifyConfig (Phase 16D-1)", () => {
  const webhook = {
    id: "ops-webhook",
    type: "webhook",
    enabled: true,
    urlEnv: "NAVFLEET_TEST_WEBHOOK_URL",
    severities: ["critical"],
  };

  it("returns no channels before load() and when no notify.json exists (zero-config red line)", async () => {
    const registry = new ConfigRegistry();
    expect(registry.getNotifyConfig()).toEqual({ channels: [] });

    await writeConfig();
    await registry.load();
    expect(registry.getNotifyConfig()).toEqual({ channels: [] });
  });

  it("loads channels and defaults severities to all three when absent", async () => {
    await writeConfig({
      notify: {
        channels: [
          webhook,
          { id: "wecom-bot", type: "wecom", enabled: false, urlEnv: "NAVFLEET_TEST_WECOM_URL" },
        ],
      },
    });
    const registry = new ConfigRegistry();
    await registry.load();

    const { channels } = registry.getNotifyConfig();
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({ id: "ops-webhook", type: "webhook", enabled: true });
    expect(channels[0]?.severities).toEqual(["critical"]);
    // severities absent → all three; enabled absent → true.
    expect(channels[1]?.severities).toEqual(["critical", "warning", "notice"]);
    expect(channels[1]?.enabled).toBe(false);
  });

  it("ignores unknown top-level keys but rejects a malformed channel", async () => {
    await writeConfig({ notify: { channels: [webhook], somethingNew: 42 } });
    await expect(new ConfigRegistry().load()).resolves.toBeUndefined();

    await writeConfig({ notify: { channels: [{ id: "x", type: "sms", urlEnv: "E" }] } });
    await expectFileRejected("notify.json", /type must be one of/);
  });

  it("rejects a channel missing urlEnv, and duplicate ids", async () => {
    await writeConfig({ notify: { channels: [{ id: "x", type: "webhook", enabled: true }] } });
    await expectFileRejected("notify.json", /urlEnv must be a non-empty/);

    await writeConfig({ notify: { channels: [webhook, { ...webhook }] } });
    await expectFileRejected("notify.json", /Duplicate channel id/);
  });

  it("keeps the previous notify config when a reload fails", async () => {
    await writeConfig({ notify: { channels: [webhook] } });
    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.getNotifyConfig().channels).toHaveLength(1);

    await writeConfig({ notify: { channels: [{ ...webhook, severities: ["nope"] }] } });
    await expect(registry.reload("test")).resolves.toBe(true);
    expect(registry.getConfigStatus().issues[0]).toMatchObject({
      file: "notify.json",
      using: "last-good",
    });
    // Old snapshot kept.
    expect(registry.getNotifyConfig().channels[0]?.id).toBe("ops-webhook");
  });

  it("parses an email channel, recipient groups, and the digest/renotify/silence/escalation policy", async () => {
    await writeConfig({
      notify: {
        groups: { oncall: [{ user: "alice" }, { email: "ops@x.io" }] },
        channels: [
          { ...webhook, id: "primary", digestSeconds: 60, renotifySeconds: 300 },
          {
            id: "mail",
            type: "email",
            enabled: true,
            urlEnv: "NAVFLEET_TEST_SMTP_URL",
            from: "alerts@x.io",
            groups: ["oncall"],
            silenceWindows: [{ from: "22:00", to: "06:00" }],
            escalation: { afterSeconds: 300, channelId: "primary" },
          },
        ],
      },
    });
    const registry = new ConfigRegistry();
    await registry.load();
    const config = registry.getNotifyConfig();

    expect(config.groups?.oncall).toEqual([{ user: "alice" }, { email: "ops@x.io" }]);
    expect(config.channels[0]).toMatchObject({ digestSeconds: 60, renotifySeconds: 300 });
    const mail = config.channels[1];
    expect(mail).toMatchObject({ type: "email", from: "alerts@x.io", groups: ["oncall"] });
    expect(mail?.silenceWindows).toEqual([{ days: undefined, from: "22:00", to: "06:00" }]);
    expect(mail?.escalation).toEqual({ afterSeconds: 300, channelId: "primary" });
  });

  it("holds back silence windows that are not HH:MM (they used to be ignored silently)", async () => {
    await writeConfig({
      notify: { channels: [{ ...webhook, silenceWindows: [{ from: "22", to: "7:00" }] }] },
    });
    await expectFileRejected("notify.json", /"HH:MM"/);
  });

  it("holds back a channel that could never send, and dangling references", async () => {
    await writeConfig({ notify: { channels: [{ ...webhook, severities: [] }] } });
    await expectFileRejected("notify.json", /would never send/);

    await writeConfig({
      notify: { channels: [{ ...webhook, id: "m", type: "email", from: "n@x.io" }] },
    });
    await expectFileRejected("notify.json", /no recipients or groups/);

    await writeConfig({ notify: { channels: [{ ...webhook, groups: ["ghost"] }] } });
    await expectFileRejected("notify.json", /unknown group ghost/);

    await writeConfig({
      notify: { channels: [{ ...webhook, escalation: { afterSeconds: 60, channelId: "nope" } }] },
    });
    await expectFileRejected("notify.json", /unknown channel nope/);
  });

  it("checks email addresses and env var names", async () => {
    await writeConfig({
      notify: {
        channels: [
          { ...webhook, id: "m", type: "email", recipients: [{ email: "ops at example" }] },
        ],
      },
    });
    await expectFileRejected("notify.json", /email address/);
    await writeConfig({ notify: { channels: [{ ...webhook, urlEnv: "my url" }] } });
    await expectFileRejected("notify.json", /environment variable name/);
  });

  it("rejects a recipient with neither email nor user, and a bad escalation", async () => {
    await writeConfig({
      notify: { channels: [{ ...webhook, id: "m", type: "email", recipients: [{}] }] },
    });
    await expectFileRejected("notify.json", /must set an email or a user/);

    await writeConfig({
      notify: { channels: [{ ...webhook, escalation: { channelId: "x" } }] },
    });
    await expectFileRejected("notify.json", /afterSeconds/);
  });
});

describe("ConfigRegistry scene-map path resolution", () => {
  const sceneWithOsm = (osmUrl: string): Array<Partial<SceneMapDefinition>> => [
    { ...DEFAULT_SCENES[0], osmUrl },
  ];

  it.each([
    { osmUrl: "/scene-maps/../../etc/passwd", message: /escapes scene-maps root/ },
    { osmUrl: "/scene-maps/nested/../../../secret.osm", message: /escapes scene-maps root/ },
    { osmUrl: "../../etc/passwd", message: /must start with \/scene-maps\// },
    { osmUrl: "/etc/passwd", message: /must start with \/scene-maps\// },
  ])("rejects the osm asset path $osmUrl", async ({ osmUrl, message }) => {
    await writeConfig({ scenes: sceneWithOsm(osmUrl) });
    await expect(new ConfigRegistry().load()).rejects.toThrow(message);
  });

  it("resolves an in-root osm asset and exposes it as an overlay", async () => {
    await fs.mkdir(path.join(configRoot, "scene-maps", "nested"), { recursive: true });
    await fs.writeFile(
      path.join(configRoot, "scene-maps", "nested", "scene-a.osm"),
      SAMPLE_OSM,
      "utf8",
    );
    await writeConfig({ scenes: sceneWithOsm("/scene-maps/nested/scene-a.osm") });

    const registry = new ConfigRegistry();
    await registry.load();

    const scene = registry.getScene("scene-a");
    expect(scene?.overlayType).toBe("lanelet2");
    expect(scene?.overlayUrl).toBe("/api/scenes/scene-a/overlay");
    const overlay = registry.getSceneOverlay("scene-a");
    expect(overlay?.stats).toEqual({ nodeCount: 4, wayCount: 2, laneletCount: 1 });
    // Scene bounds come from the parsed overlay rather than the raster geometry.
    expect(scene?.bounds).toEqual(overlay?.bounds);
  });

  it("stays inside the root for a normalized sub-path", async () => {
    await fs.writeFile(path.join(configRoot, "scene-maps", "scene-a.osm"), SAMPLE_OSM, "utf8");
    await writeConfig({ scenes: sceneWithOsm("/scene-maps/nested/../scene-a.osm") });

    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.getSceneOverlay("scene-a")).not.toBeNull();
  });
});

describe("ConfigRegistry.getReportsConfig (Phase 17B-2)", () => {
  const schedule = (over: Record<string, unknown> = {}) => ({
    id: "daily",
    range: "7d",
    time: "08:30",
    smtpEnv: "NAVFLEET_SMTP_URL",
    from: "reports@navfleet.local",
    groups: ["ops"],
    ...over,
  });

  it("returns no schedules before load() and when reports.json is absent", async () => {
    const registry = new ConfigRegistry();
    expect(registry.getReportsConfig()).toEqual({ schedules: [] });

    await writeConfig({ reports: undefined });
    await registry.load();
    expect(registry.getReportsConfig()).toEqual({ schedules: [] });
  });

  it("parses a valid schedule, defaulting enabled to true", async () => {
    // The schedule's group lives in notify.json, which must declare it.
    await writeConfig({
      reports: { schedules: [schedule({ weekday: 1 })] },
      notify: { groups: { ops: [{ email: "ops@navfleet.local" }] } },
    });
    const registry = new ConfigRegistry();
    await registry.load();

    const [parsed] = registry.getReportsConfig().schedules;
    expect(parsed).toMatchObject({
      id: "daily",
      enabled: true,
      range: "7d",
      time: "08:30",
      weekday: 1,
      smtpEnv: "NAVFLEET_SMTP_URL",
      from: "reports@navfleet.local",
      groups: ["ops"],
    });
  });

  it("keeps the SMTP URL out of the parsed config — only the env var name is named", async () => {
    // The red line: a connection string with credentials must never live in reports.json.
    await writeConfig({
      reports: { schedules: [schedule()] },
      notify: { groups: { ops: [{ email: "ops@navfleet.local" }] } },
    });
    const registry = new ConfigRegistry();
    await registry.load();
    const serialized = JSON.stringify(registry.getReportsConfig());
    expect(serialized).toContain("NAVFLEET_SMTP_URL");
    expect(serialized).not.toMatch(/smtps?:\/\//);
  });

  const rejects = async (reports: unknown, message: RegExp): Promise<void> => {
    await writeConfig({ reports });
    await expectFileRejected("reports.json", message);
  };

  it("rejects an unknown range, a bad time, an out-of-range weekday, and missing smtpEnv/from", async () => {
    await rejects({ schedules: [schedule({ range: "1y" })] }, /range must be one of/);
    await rejects({ schedules: [schedule({ time: "8:30" })] }, /time must be "HH:MM"/);
    await rejects({ schedules: [schedule({ weekday: 9 })] }, /weekday must be an integer 0-6/);
    await rejects({ schedules: [schedule({ smtpEnv: undefined })] }, /must set smtpEnv/);
    await rejects({ schedules: [schedule({ from: undefined })] }, /must set from/);
  });

  it("holds back a schedule nobody would receive, or one naming an unknown group", async () => {
    await rejects({ schedules: [schedule({ groups: undefined })] }, /never be delivered/);
    await writeConfig({ reports: { schedules: [schedule({ groups: ["ghost"] })] } });
    await expectFileRejected("reports.json", /unknown recipient group ghost/);
  });

  it("checks the sender address and the SMTP env var name", async () => {
    await rejects({ schedules: [schedule({ from: "not-an-address" })] }, /email address/);
    await rejects({ schedules: [schedule({ smtpEnv: "SMTP URL" })] }, /environment variable name/);
  });

  it("rejects duplicate schedule ids", async () => {
    await rejects(
      { schedules: [schedule(), schedule({ time: "09:00" })] },
      /Duplicate schedule id/,
    );
  });
});

describe("ConfigRegistry 写入（Phase 18 设备接入向导）", () => {
  it("writeVehicles 落盘 + 重载，写出的文件能被再次读回", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    // Clear the seed formations first — they reference agv-1/agv-2, and writeVehicles refuses
    // to orphan a formation (that would break the next load).
    await registry.writeFormations([]);

    const saved = await registry.writeVehicles([
      { deviceId: "agv-9", deviceName: "九号车", tags: ["新"] },
    ]);
    expect(saved.map((v) => v.deviceId)).toEqual(["agv-9"]);
    expect(registry.getDeviceConfig("agv-9")?.deviceName).toBe("九号车");

    // The file on disk is valid JSON that parses back to what we wrote.
    const onDisk: unknown = JSON.parse(
      await fs.readFile(path.join(configRoot, "vehicles.json"), "utf8"),
    );
    expect(onDisk).toEqual([{ deviceId: "agv-9", deviceName: "九号车", tags: ["新"] }]);
  });

  it("writeFormations 校验编队→车辆引用完整性，未知车辆时拒绝且不落盘", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await registry.writeFormations([]); // clear seed formations
    await registry.writeVehicles([{ deviceId: "agv-1", deviceName: "一号" }]);

    // A formation referencing a device that is not configured must throw before writing.
    await expect(
      registry.writeFormations([{ formationId: "f1", formationName: "F1", deviceIds: ["ghost"] }]),
    ).rejects.toThrow(/unknown deviceId ghost/);

    // A formation over the configured device succeeds.
    const saved = await registry.writeFormations([
      { formationId: "f1", formationName: "F1", deviceIds: ["agv-1"] },
    ]);
    expect(saved.map((f) => f.formationId)).toEqual(["f1"]);
  });

  it("writeVehicles 拒绝移除仍被编队引用的车辆", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    // Seed formation-a references agv-1/agv-2; dropping agv-2 would orphan it.
    await expect(
      registry.writeVehicles([{ deviceId: "agv-1", deviceName: "一号" }]),
    ).rejects.toThrow(/still referenced by formation formation-a/);
  });

  it("writeVehicles 拒绝非法载荷（校验先行），不写坏文件", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await expect(registry.writeVehicles([{ deviceId: "" }])).rejects.toThrow(
      /deviceId must be a non-empty string/,
    );
  });
});

describe("ConfigRegistry.writeAlertRules (1.6.1 告警规则写)", () => {
  it("writeAlertRules 校验先行 + 原子落盘 + 重载，写出的文件能再次读回", async () => {
    const registry = new ConfigRegistry();
    await registry.load();

    const saved = await registry.writeAlertRules({
      lowBattery: { enabled: true, thresholdPct: 15, debounceSeconds: 30 },
      offline: { enabled: false, afterSeconds: 120 },
    });
    expect(saved.lowBattery.thresholdPct).toBe(15);
    expect(saved.offline.enabled).toBe(false);
    // The live getter reflects the write…
    expect(registry.getAlertRules().offline.afterSeconds).toBe(120);
    // …and the file on disk parses back to a config carrying what we wrote.
    const onDisk = JSON.parse(await fs.readFile(path.join(configRoot, "rules.json"), "utf8")) as {
      lowBattery: { thresholdPct: number };
      offline: { enabled: boolean };
    };
    expect(onDisk.lowBattery.thresholdPct).toBe(15);
    expect(onDisk.offline.enabled).toBe(false);
  });

  it("writeAlertRules 拒绝非法载荷（校验先行），不落坏文件", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await expect(registry.writeAlertRules({ lowBattery: { thresholdPct: "low" } })).rejects.toThrow(
      /thresholdPct must be a finite number/,
    );
  });
});

describe("ConfigRegistry.writeReportsConfig (1.6.1 定时报表写)", () => {
  it("writeReportsConfig 校验先行 + 原子落盘 + 重载，写出的文件能再次读回", async () => {
    const registry = new ConfigRegistry();
    await registry.load();

    const saved = await registry.writeReportsConfig({
      schedules: [
        {
          id: "daily-ops",
          enabled: true,
          range: "24h",
          time: "08:30",
          smtpEnv: "REPORTS_SMTP_URL",
          from: "reports@fleet.local",
          recipients: [{ email: "ops@fleet.local" }, { user: "bob" }],
        },
      ],
    });
    expect(saved.schedules).toHaveLength(1);
    expect(saved.schedules[0]?.time).toBe("08:30");
    // The live getter reflects the write…
    expect(registry.getReportsConfig().schedules[0]?.id).toBe("daily-ops");
    // …and the file on disk parses back to what we wrote.
    const onDisk = JSON.parse(await fs.readFile(path.join(configRoot, "reports.json"), "utf8")) as {
      schedules: Array<{ id: string; time: string }>;
    };
    expect(onDisk.schedules[0]?.id).toBe("daily-ops");
    expect(onDisk.schedules[0]?.time).toBe("08:30");
  });

  it("writeReportsConfig 拒绝非法载荷（校验先行），不落坏文件", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await expect(
      registry.writeReportsConfig({
        schedules: [{ id: "x", enabled: true, range: "24h", time: "8am", smtpEnv: "E", from: "a" }],
      }),
    ).rejects.toThrow(/time must be "HH:MM"/);
  });
});

describe("ConfigRegistry.writeScenes / writeSceneAsset (Phase 18 场景地图上传)", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
  const assetPath = (rel: string): string => path.join(configRoot, "scene-maps", rel);

  it("writeScenes 全量落盘 + 重载，返回配置的场景", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    const saved = await registry.writeScenes([
      { sceneId: "new-1", resolution: 0.1, width: 10, height: 20 },
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.sceneId).toBe("new-1");
    // Full-array write replaced scene-a, and it survives a fresh load from disk.
    const onDisk: unknown = JSON.parse(
      await fs.readFile(path.join(configRoot, "scenes.json"), "utf8"),
    );
    expect(onDisk).toEqual([expect.objectContaining({ sceneId: "new-1" })]);
    expect(registry.listScenes().map((s) => s.sceneId)).toEqual(["new-1"]);
  });

  it("未写 bounds 的旋转场景按 origin.yaw 派生外接框", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    // 4 × 2 m 的图绕左下角转 90°：占 x ∈ [-2, 0]、y ∈ [0, 4]（ROS map_server 约定）。
    const [scene] = await registry.writeScenes([
      {
        sceneId: "rot",
        resolution: 0.1,
        width: 40,
        height: 20,
        origin: { x: 0, y: 0, yaw: Math.PI / 2 },
      },
    ]);
    expect(scene?.bounds?.minX).toBeCloseTo(-2, 9);
    expect(scene?.bounds?.maxX).toBeCloseTo(0, 9);
    expect(scene?.bounds?.minY).toBeCloseTo(0, 9);
    expect(scene?.bounds?.maxY).toBeCloseTo(4, 9);
  });

  it("writeScenes 校验先行，非法几何直接抛不落盘", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await expect(
      registry.writeScenes([{ sceneId: "x", resolution: 0, width: 1, height: 1 }]),
    ).rejects.toThrow(/resolution must be greater than 0/);
  });

  it("写入能单独校验通过、但与现有配置一起加载失败时回滚文件并抛 ConfigApplyError", async () => {
    await writeConfig();
    const registry = new ConfigRegistry();
    await registry.load();
    const scenesPath = path.join(configRoot, "scenes.json");
    const before = await fs.readFile(scenesPath, "utf8");

    // Shape-valid, but the .osm it points at does not exist, so the load cannot apply it.
    await expect(
      registry.writeScenes([
        {
          sceneId: "scene-a",
          resolution: 0.1,
          width: 10,
          height: 10,
          osmUrl: "/scene-maps/missing.osm",
        },
      ]),
    ).rejects.toThrow(ConfigApplyError);
    expect(await fs.readFile(scenesPath, "utf8")).toBe(before);
    expect(registry.listScenes().map((scene) => scene.sceneId)).toEqual(["scene-a"]);
    expect(registry.getConfigStatus().ok).toBe(true);
  });

  it("另一份文件处于回退时，其余文件照常可写可生效", async () => {
    await writeConfig({ rules: { lowBattery: { thresholdPct: "bad" } } });
    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.getConfigStatus().issues[0]?.file).toBe("rules.json");

    const saved = await registry.writeVehicles([
      { deviceId: "agv-1" },
      { deviceId: "agv-2" },
      { deviceId: "agv-9" },
    ]);
    expect(saved.map((vehicle) => vehicle.deviceId)).toContain("agv-9");
    // rules.json is still the one held back.
    expect(registry.getConfigStatus().issues.map((issue) => issue.file)).toEqual(["rules.json"]);
  });

  it("并发写入串行执行，后到者基于先到者生效后的配置校验", async () => {
    await writeConfig();
    const registry = new ConfigRegistry();
    await registry.load();
    const [, second] = await Promise.allSettled([
      registry.writeVehicles([{ deviceId: "agv-1" }, { deviceId: "agv-2" }, { deviceId: "agv-3" }]),
      registry.writeFormations([
        { formationId: "f-new", formationName: "新编队", deviceIds: ["agv-3"] },
      ]),
    ]);
    // agv-3 only exists once the first write has applied; serialized, the second sees it.
    expect(second.status).toBe("fulfilled");
  });

  it("同时编辑：带旧版本号的写入被拒（ConfigConflictError），不落盘；带当前版本号的写入通过", async () => {
    await writeConfig();
    const registry = new ConfigRegistry();
    await registry.load();
    const loadedVersion = registry.getConfigVersion("vehicles");

    // Admin A saves first, against the version both loaded.
    await registry.writeVehicles(
      [{ deviceId: "agv-1" }, { deviceId: "agv-2" }, { deviceId: "agv-a" }],
      loadedVersion,
    );
    const afterA = registry.getConfigVersion("vehicles");
    expect(afterA).not.toBe(loadedVersion);
    const onDiskAfterA = await fs.readFile(path.join(configRoot, "vehicles.json"), "utf8");

    // Admin B still holds the old version: refused, A's change survives untouched.
    await expect(
      registry.writeVehicles(
        [{ deviceId: "agv-1" }, { deviceId: "agv-2" }, { deviceId: "agv-b" }],
        loadedVersion,
      ),
    ).rejects.toThrow(ConfigConflictError);
    expect(await fs.readFile(path.join(configRoot, "vehicles.json"), "utf8")).toBe(onDiskAfterA);

    // After reloading (new version), B's save goes through.
    await registry.writeVehicles(
      [{ deviceId: "agv-1" }, { deviceId: "agv-2" }, { deviceId: "agv-a" }, { deviceId: "agv-b" }],
      afterA,
    );
    expect(registry.listVehicleConfigs().map((vehicle) => vehicle.deviceId)).toContain("agv-b");
  });

  it("同时编辑：文件被手工改过也算冲突（版本按磁盘内容计算）", async () => {
    await writeConfig();
    const registry = new ConfigRegistry();
    await registry.load();
    const version = registry.getConfigVersion("rules");
    await fs.writeFile(
      path.join(configRoot, "rules.json"),
      JSON.stringify({ lowBattery: { thresholdPct: 30 } }),
      "utf8",
    );
    await expect(
      registry.writeAlertRules({ lowBattery: { thresholdPct: 25 } }, version),
    ).rejects.toThrow(ConfigConflictError);
  });

  it("writeSceneAsset 为无现有底图的场景落到 <sceneId>/<kind>.<ext>", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    const url = await registry.writeSceneAsset("scene-a", "image", svg);
    expect(url).toBe("/scene-maps/scene-a/image.svg");
    expect(await fs.readFile(assetPath("scene-a/image.svg"))).toEqual(svg);
  });

  it("writeSceneAsset 就地覆盖场景已引用的底图路径（不产生孤儿）", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await registry.writeScenes([
      {
        sceneId: "s2",
        resolution: 0.1,
        width: 10,
        height: 20,
        imageUrl: "/scene-maps/s2/custom.svg",
      },
    ]);
    const svg2 = Buffer.from('<svg id="v2"></svg>', "utf8");
    const url = await registry.writeSceneAsset("s2", "image", svg2);
    expect(url).toBe("/scene-maps/s2/custom.svg");
    expect(await fs.readFile(assetPath("s2/custom.svg"))).toEqual(svg2);
  });

  it("writeSceneAsset 校验内容：不是图片的字节被拒（抛 SceneAssetValidationError）", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await expect(
      registry.writeSceneAsset("scene-a", "image", Buffer.from("definitely not an image")),
    ).rejects.toThrow(SceneAssetValidationError);
  });

  it("writeSceneAsset 拒绝内容不是 .pcd 的点云（抛 SceneAssetValidationError）", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await expect(
      registry.writeSceneAsset("scene-a", "pointcloud", Buffer.from("nope not a point cloud")),
    ).rejects.toThrow(SceneAssetValidationError);
  });

  it("writeSceneAsset 接受有效 .osm 并落盘", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    const url = await registry.writeSceneAsset("scene-a", "osm", Buffer.from(SAMPLE_OSM, "utf8"));
    expect(url).toBe("/scene-maps/scene-a/osm.osm");
    expect(await fs.readFile(assetPath("scene-a/osm.osm"), "utf8")).toBe(SAMPLE_OSM);
  });

  it("writeSceneAsset 拒绝路径不安全的 sceneId（抛 SceneAssetValidationError）", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    await expect(registry.writeSceneAsset("../x", "image", svg)).rejects.toThrow(
      SceneAssetValidationError,
    );
  });
});
