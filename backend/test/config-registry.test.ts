import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DeviceSnapshot, FleetConfig, SceneConfig } from "../src/types";
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

const DEFAULT_SCENES: Array<Partial<SceneConfig>> = [
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
    expect(scenes[0].bounds).toEqual({ minX: 1, maxX: 6, minY: 2, maxY: 12 });
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

describe("ConfigRegistry scene-map path resolution", () => {
  const sceneWithOsm = (osmUrl: string): Array<Partial<SceneConfig>> => [
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
