/**
 * The demo fleet: the vehicles in config-runtime, each with its site (route, work points, profile)
 * and its state, plus the checkpoint that carries that state across restarts.
 *
 * The checkpoint is what makes the demo continuous. It holds every vehicle's state at one second;
 * the live publisher rewrites it every second, so whoever starts next — the live publisher after
 * a restart, or the catch-up after the stack was down — resumes the same timeline from where it
 * stopped instead of inventing a new one.
 */
import fs from "node:fs";
import path from "node:path";
import { PROFILES, vehicleQuirks, type Category } from "./profiles";
import { buildRoutes, sceneGpsOrigin, type SceneConfig } from "./routes";
import { seedOf } from "./rng";
import { initialState, type Site, type VehicleState } from "./vehicle";

interface VehicleConfig {
  deviceId: string;
  defaultSceneId?: string;
  category?: string;
  gpsEnabled?: boolean;
  notes?: string;
  commissionedAt?: string;
}

export interface Fleet {
  sites: Site[];
  /** When each vehicle entered service (epoch ms), or null when vehicles.json does not say. */
  commissioned: Map<string, number | null>;
  /** Vehicles sharing a scene, in roster order, for spreading their start positions. */
  placement: Map<string, { ordinal: number; count: number }>;
}

const BASE_LIMIT: Record<Category, number> = { 巡检: 2.0, 搬运: 1.5, 牵引: 2.0, 配料: 1.2 };

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;

export const resolveConfigRoot = (): string => {
  const candidates = [
    process.env.CONFIG_ROOT_PATH,
    path.resolve(process.cwd(), "config-runtime"),
    path.resolve(process.cwd(), "../config-runtime"),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "vehicles.json")),
  );
  if (!found) throw new Error("config-runtime/vehicles.json not found; set CONFIG_ROOT_PATH");
  return path.resolve(found);
};

export const loadFleet = async (configRoot: string): Promise<Fleet> => {
  const vehicles = readJson<VehicleConfig[]>(path.join(configRoot, "vehicles.json"));
  const scenes = readJson<SceneConfig[]>(path.join(configRoot, "scenes.json"));
  const routes = await buildRoutes(
    configRoot,
    scenes,
    vehicles.map((vehicle, index) => ({ sceneId: vehicle.defaultSceneId ?? "", index })),
  );
  const counts = new Map<string, number>();
  for (const vehicle of vehicles) {
    const scene = vehicle.defaultSceneId ?? "";
    counts.set(scene, (counts.get(scene) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const placement = new Map<string, { ordinal: number; count: number }>();
  const commissioned = new Map<string, number | null>();

  const sites = vehicles.map((vehicle, index): Site => {
    const sceneId = vehicle.defaultSceneId ?? "";
    const ordinal = seen.get(sceneId) ?? 0;
    seen.set(sceneId, ordinal + 1);
    placement.set(vehicle.deviceId, { ordinal, count: counts.get(sceneId) ?? 1 });
    const parsed = Date.parse(vehicle.commissionedAt ?? "");
    commissioned.set(vehicle.deviceId, Number.isFinite(parsed) ? parsed : null);

    const category = (
      vehicle.category && vehicle.category in PROFILES ? vehicle.category : "搬运"
    ) as Category;
    const route = routes[index]!;
    const L = route.length;
    return {
      deviceId: vehicle.deviceId,
      sceneId,
      category,
      profile: PROFILES[category],
      quirks: vehicleQuirks(vehicle.notes),
      route,
      pick: route.wrap(0.25 * L),
      drop: route.wrap(0.7 * L),
      charger: route.wrap(0.02 * L + ordinal * 2.5),
      zone: [route.wrap(0.45 * L), route.wrap(0.45 * L + Math.min(20, 0.08 * L))],
      baseLimit: BASE_LIMIT[category],
      gps:
        vehicle.gpsEnabled === false
          ? null
          : sceneGpsOrigin(scenes.findIndex((scene) => scene.sceneId === sceneId)),
      noiseSeed: seedOf(`noise:${vehicle.deviceId}`),
    };
  });
  return { sites, commissioned, placement };
};

export const newState = (fleet: Fleet, site: Site, t: number): VehicleState => {
  const place = fleet.placement.get(site.deviceId) ?? { ordinal: 0, count: 1 };
  return initialState(site, t, place.ordinal, place.count);
};

// ── Checkpoint ────────────────────────────────────────────────────────────────

export interface Checkpoint {
  version: 1;
  /** The second every state describes next (all vehicles move in lockstep). */
  t: number;
  states: VehicleState[];
}

export const checkpointPath = (stateDir: string): string => path.join(stateDir, "checkpoint.json");

export const readCheckpoint = (stateDir: string): Checkpoint | null => {
  try {
    const checkpoint = readJson<Checkpoint>(checkpointPath(stateDir));
    return checkpoint.version === 1 && Array.isArray(checkpoint.states) ? checkpoint : null;
  } catch {
    return null;
  }
};

/** Atomic (tmp + rename), so a crash mid-write leaves the previous checkpoint intact. */
export const writeCheckpoint = (stateDir: string, checkpoint: Checkpoint): void => {
  fs.mkdirSync(stateDir, { recursive: true });
  const target = checkpointPath(stateDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(checkpoint));
  fs.renameSync(tmp, target);
};

/**
 * Line the checkpoint up with the roster in effect: a vehicle removed from vehicles.json drops
 * out, a vehicle added since joins at `t` — it enters service now and has no history before.
 */
export const reconcileStates = (
  fleet: Fleet,
  states: readonly VehicleState[],
  t: number,
): VehicleState[] => {
  const byId = new Map(states.map((state) => [state.deviceId, state]));
  return fleet.sites.map((site) => byId.get(site.deviceId) ?? newState(fleet, site, t));
};
