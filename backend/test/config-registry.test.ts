import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DeviceSnapshot, FleetConfig, SceneMapDefinition } from "../src/types";
import { DEFAULT_REPORT_CODES } from "@navfleet/shared";
import { SAMPLE_OSM, sampleDevice } from "./helpers/fixtures";

/**
 * ConfigRegistry resolves its file paths from src/config at module load time, so
 * CONFIG_ROOT_PATH is pointed at a throwaway directory before the module is
 * imported (hence the dynamic import). The repo's real config-runtime is never
 * touched.
 */
let configRoot = "";
let ConfigRegistry: typeof import("../src/configRegistry").ConfigRegistry;

const DEFAULT_FLEET: FleetConfig = {
  fleetName: "临时车队",
  topicPattern: "/tmp/{deviceId}/vehicle_info",
  defaultSceneId: "scene-a",
  // Deliberately **not** one of `MapProfile`'s named values: the registry passes any
  // string through, and this asserts that. If it ever gets "corrected" to `rosRaster`,
  // the open-endedness stops being covered — which is how the value ended up in the
  // union itself, where it did not belong.
  defaultMapProfile: "rosRaster+lanelet",
  defaultGpsEnabled: false,
  defaultRosMapEnabled: true,
};

const DEFAULT_VEHICLES = [
  {
    deviceId: "agv-1",
    deviceName: "临时车 1",
    tags: ["a", "b"],
    gpsEnabled: false,
    mapProfile: "pointCloud",
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
};

beforeAll(async () => {
  configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "navfleet-config-registry-"));
  await fs.mkdir(path.join(configRoot, "scene-maps"), { recursive: true });
  process.env.CONFIG_ROOT_PATH = configRoot;
  // The ".js" specifier is the TS/Node16 convention for a relative ESM import.
  ({ ConfigRegistry } = await import("../src/configRegistry.js"));
});

afterAll(async () => {
  delete process.env.CONFIG_ROOT_PATH;
  await fs.rm(configRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeConfig();
});

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

  it("applies device config and formation membership to a snapshot", async () => {
    const registry = new ConfigRegistry();
    await registry.load();

    const raw: DeviceSnapshot = {
      ...sampleDevice(),
      deviceId: "agv-1",
      deviceName: "",
      mapProfile: "",
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
    expect(applied.mapProfile).toBe("pointCloud");
    expect(registry.applyDeviceConfig({ ...raw, deviceId: "agv-2" }).mapProfile).toBe(
      "rosRaster+lanelet",
    );

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

  it("rejects unparseable JSON", async () => {
    await fs.writeFile(path.join(configRoot, "scenes.json"), "{ not json", "utf8");
    await expect(new ConfigRegistry().load()).rejects.toThrow();
  });

  it("keeps the previous snapshot when a reload fails", async () => {
    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.listScenes()).toHaveLength(1);

    await writeConfig({ vehicles: {} });
    // reload() swallows the failure and reports it instead of throwing.
    await expect(registry.reload("test")).resolves.toBe(false);
    expect(registry.getDeviceConfig("agv-1")).not.toBeNull();
    expect(registry.listScenes()).toHaveLength(1);

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
  ])("rejects rules.json when $name", async ({ rules, message }) => {
    await writeConfig({ rules });
    await expect(new ConfigRegistry().load()).rejects.toThrow(message);
  });

  it("rejects unparseable rules.json", async () => {
    await writeConfig({ rules: "{ not json" });
    await expect(new ConfigRegistry().load()).rejects.toThrow();
  });

  it("keeps the previous rules when a rules.json reload fails", async () => {
    await writeConfig({ rules: { lowBattery: { thresholdPct: 25 } } });
    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.getAlertRules().lowBattery.thresholdPct).toBe(25);

    await writeConfig({ rules: { lowBattery: { thresholdPct: "bad" } } });
    await expect(registry.reload("test")).resolves.toBe(false);
    expect(registry.getAlertRules().lowBattery.thresholdPct).toBe(25);

    await writeConfig({ rules: { lowBattery: { thresholdPct: 40 } } });
    await expect(registry.reload("test")).resolves.toBe(true);
    expect(registry.getAlertRules().lowBattery.thresholdPct).toBe(40);
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
    await expect(new ConfigRegistry().load()).rejects.toThrow(/code must be a positive integer/);
  });

  it("keeps the previous codebook when a reload fails", async () => {
    await writeConfig({ codebook: [override] });
    const registry = new ConfigRegistry();
    await registry.load();
    expect(new Map(registry.getCodebook().map((e) => [e.code, e])).get(2301)?.label).toBe(
      "本厂电量低",
    );

    await writeConfig({ codebook: [{ ...override, impact: "nope" }] });
    await expect(registry.reload("test")).resolves.toBe(false);
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
    await expect(new ConfigRegistry().load()).rejects.toThrow(/type must be one of/);
  });

  it("rejects a channel missing urlEnv, and duplicate ids", async () => {
    await writeConfig({ notify: { channels: [{ id: "x", type: "webhook", enabled: true }] } });
    await expect(new ConfigRegistry().load()).rejects.toThrow(/urlEnv must be a non-empty/);

    await writeConfig({ notify: { channels: [webhook, { ...webhook }] } });
    await expect(new ConfigRegistry().load()).rejects.toThrow(/Duplicate channel id/);
  });

  it("keeps the previous notify config when a reload fails", async () => {
    await writeConfig({ notify: { channels: [webhook] } });
    const registry = new ConfigRegistry();
    await registry.load();
    expect(registry.getNotifyConfig().channels).toHaveLength(1);

    await writeConfig({ notify: { channels: [{ ...webhook, severities: ["nope"] }] } });
    await expect(registry.reload("test")).resolves.toBe(false);
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

  it("rejects a recipient with neither email nor user, and a bad escalation", async () => {
    await writeConfig({
      notify: { channels: [{ ...webhook, id: "m", type: "email", recipients: [{}] }] },
    });
    await expect(new ConfigRegistry().load()).rejects.toThrow(/must set an email or a user/);

    await writeConfig({
      notify: { channels: [{ ...webhook, escalation: { channelId: "x" } }] },
    });
    await expect(new ConfigRegistry().load()).rejects.toThrow(/afterSeconds/);
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
