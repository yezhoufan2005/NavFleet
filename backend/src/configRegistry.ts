import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { FSWatcher } from "chokidar";
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
  SceneConfig,
  SceneMapDefinition,
} from "./types";

const logger = moduleLogger("config-registry");

const CONFIG_ROOT = config.configRootPath;
const FLEET_FILE = runtimePaths.fleetFilePath;
const VEHICLES_FILE = runtimePaths.vehiclesFilePath;
const FORMATIONS_FILE = runtimePaths.formationsFilePath;
const SCENES_FILE = runtimePaths.scenesFilePath;

const DEFAULT_FLEET_CONFIG: FleetConfig = {
  fleetName: "智能车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  defaultSceneId: "",
  defaultMapProfile: "lanelet",
  defaultGpsEnabled: true,
  defaultRosMapEnabled: true,
};

interface LoadedConfigSnapshot {
  fleetConfig: FleetConfig;
  deviceConfigs: Map<string, DeviceConfig>;
  formationConfigs: Map<string, FormationConfig>;
  deviceFormationIds: Map<string, string[]>;
  sceneConfigs: Map<string, SceneConfig>;
  sceneOverlays: Map<string, LaneletOverlay>;
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

export class ConfigRegistry {
  private fleetConfig: FleetConfig = { ...DEFAULT_FLEET_CONFIG };
  private deviceConfigs = new Map<string, DeviceConfig>();
  private formationConfigs = new Map<string, FormationConfig>();
  private deviceFormationIds = new Map<string, string[]>();
  private sceneConfigs = new Map<string, SceneConfig>();
  private sceneOverlays = new Map<string, LaneletOverlay>();
  private loaded = false;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private reloadQueue: Promise<void> = Promise.resolve();
  private pendingReloadReason = "startup";

  private async loadSnapshot(): Promise<LoadedConfigSnapshot> {
    const [fleetRaw, vehiclesRaw, formationsRaw, scenesRaw] = await Promise.all([
      readJsonFile<unknown>(FLEET_FILE),
      readJsonFile<unknown>(VEHICLES_FILE),
      readJsonFile<unknown>(FORMATIONS_FILE),
      readJsonFile<unknown>(SCENES_FILE),
    ]);

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
      Partial<SceneConfig>
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

    const nextSceneConfigs = new Map<string, SceneConfig>();
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

      const normalizedScene: SceneConfig = {
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
        occupiedThresh: value.occupiedThresh ?? 0.65,
        freeThresh: value.freeThresh ?? 0.2,
        negate: value.negate ?? 0,
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
    };
  }

  private applySnapshot(snapshot: LoadedConfigSnapshot): void {
    this.fleetConfig = { ...snapshot.fleetConfig };
    this.deviceConfigs = snapshot.deviceConfigs;
    this.formationConfigs = snapshot.formationConfigs;
    this.deviceFormationIds = snapshot.deviceFormationIds;
    this.sceneConfigs = snapshot.sceneConfigs;
    this.sceneOverlays = snapshot.sceneOverlays;
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

  async startWatching(onReload: () => Promise<void> | void): Promise<void> {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(
      [
        FLEET_FILE,
        VEHICLES_FILE,
        FORMATIONS_FILE,
        SCENES_FILE,
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

  getDeviceConfig(deviceId: string): DeviceConfig | null {
    this.ensureLoaded();
    if (!deviceId) {
      return null;
    }
    const configEntry = this.deviceConfigs.get(deviceId);
    return configEntry ? { ...configEntry, tags: [...(configEntry.tags || [])] } : null;
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
      mapProfile: deviceConfig?.mapProfile || snapshot.mapProfile || fleetConfig.defaultMapProfile,
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
          : memberDevices[0]?.sceneId || memberDevices[0]?.defaultSceneId || "");

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
