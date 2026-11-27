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
import {
  PERSONAS,
  PROFILES,
  vehicleQuirks,
  vendorProfile,
  VISITORS,
  type Category,
} from "./profiles";
import { buildRoutes, SCENE_SLOTS, sceneGpsOrigin, sceneSlots, type SceneConfig } from "./routes";
import { seedOf } from "./rng";
import { initialState, type Site, type VehicleState } from "./vehicle";

interface VehicleConfig {
  deviceId: string;
  defaultSceneId?: string;
  category?: string;
  gpsEnabled?: boolean;
  tags?: string[];
  vendor?: string;
  model?: string;
  notes?: string;
  commissionedAt?: string;
}

/** Indoor floors people work on, where the safety scanner keeps slowing vehicles for them. */
const PEOPLE_SCENES = new Set(["warehouse-a", "assembly-line"]);

export interface Fleet {
  sites: Site[];
  /** When each vehicle entered service (epoch ms), or null when vehicles.json does not say. */
  commissioned: Map<string, number | null>;
  /** Each vehicle's slot in its scene (`sceneSlots`), for spreading start positions and chargers. */
  placement: Map<string, number>;
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
  // A spare in storage is on the roster but never switched on: there is nothing to simulate.
  const vehicles = readJson<VehicleConfig[]>(path.join(configRoot, "vehicles.json")).filter(
    (vehicle) => !PERSONAS[vehicle.deviceId]?.dormant,
  );
  const scenes = readJson<SceneConfig[]>(path.join(configRoot, "scenes.json"));
  const sceneOf = (sceneId: string) => scenes.find((scene) => scene.sceneId === sceneId);
  // Visitors share the slots of the scene they turn up in, so they do not park on a roster vehicle.
  const members = [
    ...vehicles.map((vehicle) => ({
      deviceId: vehicle.deviceId,
      sceneId: vehicle.defaultSceneId ?? "",
    })),
    ...VISITORS.map((visitor) => ({ deviceId: visitor.deviceId, sceneId: visitor.sceneId })),
  ];
  const placement = sceneSlots(members);
  const nightScenes = vehicles
    .map((vehicle) => PERSONAS[vehicle.deviceId]?.nightScene)
    .filter((sceneId): sceneId is string => !!sceneId);
  const routes = await buildRoutes(configRoot, scenes, [
    ...members.map((member) => ({
      sceneId: member.sceneId,
      slot: placement.get(member.deviceId) ?? 0,
    })),
    // A night round starts from that scene's first slot position, like a vehicle new to it.
    ...nightScenes.map((sceneId) => ({ sceneId, slot: 0 })),
  ]);
  const nightRoutes = new Map(
    nightScenes.map((sceneId, index) => [sceneId, routes[members.length + index]!]),
  );
  const commissioned = new Map<string, number | null>();

  const siteOf = (
    member: { deviceId: string; sceneId: string },
    index: number,
    vehicle: VehicleConfig | null,
  ): Site => {
    const { deviceId, sceneId } = member;
    const slot = placement.get(deviceId) ?? 0;
    const parsed = Date.parse(vehicle?.commissionedAt ?? "");
    commissioned.set(deviceId, Number.isFinite(parsed) ? parsed : null);
    const persona = PERSONAS[deviceId] ?? {};
    const visitor = vehicle ? undefined : VISITORS.find((entry) => entry.deviceId === deviceId);

    const category = (
      vehicle?.category && vehicle.category in PROFILES ? vehicle.category : "搬运"
    ) as Category;
    const route = routes[index]!;
    const L = route.length;
    // The platform's gpsEnabled hides a fix; a vehicle with an antenna reports one regardless.
    const reportsGps = vehicle ? vehicle.gpsEnabled !== false || !!persona.gpsAntenna : true;
    const night = persona.nightScene
      ? {
          sceneId: persona.nightScene,
          route: nightRoutes.get(persona.nightScene)!,
          gps: sceneGpsOrigin(persona.nightScene, sceneOf(persona.nightScene)),
        }
      : undefined;
    const tags = vehicle?.tags ?? [];
    return {
      deviceId,
      sceneId,
      category,
      // A visitor's debug build has no workload of its own beyond an engineer driving it about.
      profile: visitor
        ? { ...PROFILES[category], events: { teleopSession: 0.6 } }
        : PROFILES[category],
      quirks: vehicleQuirks(vehicle?.notes),
      route,
      pick: route.wrap(0.25 * L),
      drop: route.wrap(0.7 * L),
      charger: route.wrap(0.02 * L + slot * 2.5),
      zone: [route.wrap(0.45 * L), route.wrap(0.45 * L + Math.min(20, 0.08 * L))],
      baseLimit: BASE_LIMIT[category],
      gps: reportsGps ? sceneGpsOrigin(sceneId, sceneOf(sceneId)) : null,
      noiseSeed: seedOf(`noise:${deviceId}`),
      vendor: vendorProfile(vehicle?.vendor ?? visitor?.vendor),
      persona,
      traits: {
        people: PEOPLE_SCENES.has(sceneId),
        lifts: /潜伏|Qi-100/.test(vehicle?.model ?? ""),
        cold: sceneId === "cold-store",
        outdoor: tags.includes("室外"),
      },
      ...(night ? { night } : {}),
      ...(visitor ? { visitor } : {}),
    };
  };

  const sites = members.map((member, index) => siteOf(member, index, vehicles[index] ?? null));
  return { sites, commissioned, placement };
};

export const newState = (fleet: Fleet, site: Site, t: number): VehicleState => {
  return initialState(site, t, fleet.placement.get(site.deviceId) ?? 0, SCENE_SLOTS);
};

// ── Checkpoint ────────────────────────────────────────────────────────────────

export interface Checkpoint {
  version: 1;
  /** The second every state describes next (all vehicles move in lockstep). */
  t: number;
  states: VehicleState[];
}

export const checkpointPath = (stateDir: string): string => path.join(stateDir, "checkpoint.json");

/** The checkpoint file exists but cannot be used (empty, truncated, or not this format). */
export class CheckpointCorrupt extends Error {}

/**
 * `null` only when there is no checkpoint file at all. A file that is present but unreadable throws
 * `CheckpointCorrupt` instead: treating it as "no checkpoint" sent catch-up down the first-start path
 * and the operator got a refusal about the database already holding history, which points at the
 * wrong cause.
 */
export const readCheckpoint = (stateDir: string): Checkpoint | null => {
  const file = checkpointPath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let checkpoint: Checkpoint;
  try {
    checkpoint = JSON.parse(raw) as Checkpoint;
  } catch {
    throw new CheckpointCorrupt(
      `${file} is ${raw.length === 0 ? "empty" : "not valid JSON"} — the state volume was cut off ` +
        "mid-write (e.g. the Docker VM stopped). Restore it, or start both the database and the state " +
        "from empty (verify-stack --purge; under dev.sh, remove the dev Mongo container and backend/.demo-sim).",
    );
  }
  if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.states)) {
    throw new CheckpointCorrupt(`${file} is not a version-1 checkpoint`);
  }
  return checkpoint;
};

/**
 * Durable as well as atomic: tmp + fsync + rename + fsync of the directory. The rename alone keeps
 * the previous checkpoint through a process crash, but not through the host or Docker VM stopping
 * — the rename can reach disk before the data, leaving an empty `checkpoint.json`.
 */
export const writeCheckpoint = (stateDir: string, checkpoint: Checkpoint): void => {
  fs.mkdirSync(stateDir, { recursive: true });
  const target = checkpointPath(stateDir);
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(checkpoint));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  // Persist the rename itself. Best effort: some filesystems refuse fsync on a directory handle,
  // and the data is already durable by then.
  try {
    const dir = fs.openSync(stateDir, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    // ignore — see above
  }
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
