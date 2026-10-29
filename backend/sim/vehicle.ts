/**
 * One vehicle, one second at a time.
 *
 * A deterministic state machine over a work cycle — wait for a task, drive to the pick point,
 * load, drive to the drop point, unload (a tug reverses onto the dock, a line feeder waits for a
 * person to take over), report the task complete, and go to charge when the battery is below this
 * cycle's threshold. Inspection vehicles patrol their stops instead of carrying. Around that cycle
 * run the things that interrupt real fleets: localisation degrading and being lost, obstacles
 * that do not clear, safety stops, e-stops that need a person, drive and sensor faults, comms
 * dropping out, planned maintenance. Each one has a duration and an end, and some cause the next
 * (a degraded localisation is sometimes lost, a lost one is relocalised, an obstacle stop is
 * sometimes resolved by remote takeover, a degraded link sometimes drops).
 *
 * **Determinism is the contract.** Everything random comes from the vehicle's `Rng`, whose state
 * is part of `VehicleState`; pose noise is a hash of time, so building a frame or not consumes no
 * randomness. Stepping the same state through the same seconds — with the same injections —
 * yields the same states and frames, whether it is the live publisher or the history backfill
 * doing it. Frames have the shape of the vehicle protocol (`/fleet/{id}/vehicle_info`).
 */
import { Rng, seedOf } from "./rng";
import {
  CODE_TEXT,
  isNight,
  localHour,
  type Category,
  type EventKind,
  type Profile,
} from "./profiles";
import { sceneToGps, type Point, type Pose, type Route } from "./routes";

export type Phase =
  | "idle"
  | "toPick"
  | "loading"
  | "toDrop"
  | "docking"
  | "unloading"
  | "handover"
  | "complete"
  | "toCharger"
  | "charging"
  | "parked"
  | "maintenance";

export interface ActiveCode {
  code: number;
  since: number;
  until: number;
}

type FollowUp = "locLost" | "relocalised" | "teleop" | "commDrop" | "lidarDead" | "batteryHeat";

export interface VehicleState {
  deviceId: string;
  /** The second this state describes (epoch ms). */
  t: number;
  rng: number;
  s: number;
  speed: number;
  soc: number;
  phase: Phase;
  phaseUntil: number;
  target: number;
  loaded: boolean;
  /** Inspection stop index (patrol vehicles). */
  stop: number;
  chargeAt: number;
  chargeTo: number;
  info: ActiveCode | null;
  warning: ActiveCode | null;
  error: ActiveCode | null;
  estop: boolean;
  teleopUntil: number;
  degradedUntil: number;
  zoneUntil: number;
  silentSince: number;
  silentUntil: number;
  online: boolean;
  nextMaintenanceAt: number;
  maintenanceUntil: number;
  waitingSince: number;
  limitKey: string;
  limitSince: number;
  pending: Array<{ at: number; kind: FollowUp }>;
}

export interface Site {
  deviceId: string;
  sceneId: string;
  category: Category;
  profile: Profile;
  quirks: Partial<Record<EventKind | "batteryHeat", number>>;
  route: Route;
  pick: number;
  drop: number;
  /** This vehicle's own charging spot on the loop. */
  charger: number;
  /** A permanent slow zone on the route, as [from, to] arc lengths. */
  zone: [number, number];
  baseLimit: number;
  /** Scene GPS origin, or null when the vehicle reports no GPS. */
  gps: Point | null;
  noiseSeed: number;
}

/** What an operator can make happen to a vehicle (see `main.ts inject`). */
export type InjectionKind =
  | "estop"
  | "obstacle"
  | "loc-lost"
  | "drive-fault"
  | "lidar-fault"
  | "task-failed"
  | "collision-guard"
  | "comm-loss"
  | "maintenance"
  | "teleop"
  | "low-battery"
  | "battery-heat"
  | "payload"
  | "speed-zone";

export const INJECTION_KINDS: readonly InjectionKind[] = [
  "estop",
  "obstacle",
  "loc-lost",
  "drive-fault",
  "lidar-fault",
  "task-failed",
  "collision-guard",
  "comm-loss",
  "maintenance",
  "teleop",
  "low-battery",
  "battery-heat",
  "payload",
  "speed-zone",
];

export interface Injection {
  deviceId: string;
  /** The second it takes effect (epoch ms, whole seconds). */
  at: number;
  kind: InjectionKind;
  minutes?: number;
}

export interface StepResult {
  /** The telemetry frame, or null while the vehicle is silent or in maintenance. */
  frame: Record<string, unknown> | null;
  /** A status-topic report (`{ online }`) when connectivity changed this second. */
  status: boolean | null;
}

const HOUR = 3_600_000;

/** The next planned-maintenance start: `days` from `from`, on a weekday-agnostic 09–14 local slot. */
const maintenanceSlot = (from: number, days: number, rng: Rng): number => {
  const day = Math.floor((from + 8 * HOUR) / (24 * HOUR)) + Math.round(days);
  return day * 24 * HOUR - 8 * HOUR + rng.between(9, 14) * HOUR;
};

/**
 * A vehicle as it is when it joins the simulation at `t`. `ordinal / countInScene` spreads
 * vehicles that share a loop, so they neither stack up nor move in lockstep.
 */
export const initialState = (
  site: Site,
  t: number,
  ordinal: number,
  countInScene: number,
): VehicleState => {
  const rng = new Rng(seedOf(`vehicle:${site.deviceId}`));
  const state: VehicleState = {
    deviceId: site.deviceId,
    t,
    rng: 0,
    s: site.route.wrap((ordinal / Math.max(1, countInScene)) * site.route.length),
    speed: 0,
    soc: rng.between(45, 95),
    phase: "idle",
    phaseUntil: t + rng.between(0, 600) * 1000,
    target: 0,
    loaded: false,
    stop: 0,
    chargeAt: rng.between(15, 35),
    chargeTo: rng.between(92, 100),
    info: null,
    warning: null,
    error: null,
    estop: false,
    teleopUntil: 0,
    degradedUntil: 0,
    zoneUntil: 0,
    silentSince: 0,
    silentUntil: 0,
    online: true,
    nextMaintenanceAt: 0,
    maintenanceUntil: 0,
    waitingSince: t,
    limitKey: "",
    limitSince: t,
    pending: [],
  };
  state.nextMaintenanceAt = maintenanceSlot(t, rng.between(2, 12), rng);
  state.rng = rng.save();
  return state;
};

const setCode = (
  state: VehicleState,
  slot: "info" | "warning" | "error",
  code: number,
  t: number,
  seconds: number,
  replace = false,
): boolean => {
  if (state[slot] && !replace) return false;
  state[slot] = { code, since: t, until: t + Math.round(seconds) * 1000 };
  return true;
};

const working = (state: VehicleState): boolean =>
  !["charging", "parked", "maintenance"].includes(state.phase);

const onShift = (site: Site, t: number): boolean => {
  const shift = site.profile.shift;
  if (!shift) return true;
  const hour = localHour(t);
  return hour >= shift[0] && hour < shift[1];
};

/** The link goes quiet; the vehicle keeps working, it just cannot report. */
const loseComms = (state: VehicleState, t: number, seconds: number): void => {
  if (t >= state.silentUntil) state.silentSince = t;
  state.silentUntil = Math.max(state.silentUntil, t + Math.round(seconds) * 1000);
};

/** Stop for a fault: the vehicle holds where it is until the error clears. */
const fault = (state: VehicleState, code: number, t: number, seconds: number): boolean =>
  setCode(state, "error", code, t, seconds);

/** Start one event; returns whether it took (a busy slot or a wrong phase skips it). */
const startEvent = (
  state: VehicleState,
  kind: EventKind,
  t: number,
  rng: Rng,
  forcedSeconds?: number,
): boolean => {
  const secs = (lo: number, hi: number): number => forcedSeconds ?? rng.between(lo, hi);
  switch (kind) {
    case "locDegraded": {
      const seconds = secs(60, 480);
      if (!setCode(state, "warning", 2101, t, seconds)) return false;
      state.degradedUntil = t + seconds * 1000;
      return true;
    }
    case "commDegraded":
      return setCode(state, "warning", 2601, t, secs(120, 360));
    case "commLoss":
      loseComms(state, t, secs(60, 600));
      return true;
    case "obstacle":
      return fault(state, 5202, t, secs(120, 720));
    case "collisionGuard":
      return fault(state, 5702, t, secs(30, 180));
    case "estop": {
      const seconds = secs(300, 1800) * (isNight(t) ? 1.5 : 1);
      if (!fault(state, 5701, t, seconds)) return false;
      state.estop = true;
      return true;
    }
    case "trackingDeviation":
      return state.loaded && state.speed > 0.2 && setCode(state, "warning", 2204, t, secs(60, 180));
    case "lidarDirty":
      return setCode(state, "warning", 2401, t, secs(600, 3600));
    case "driveFault":
      return fault(state, 5203, t, secs(600, 3600));
    case "planTimeout":
      return fault(state, 5102, t, secs(60, 300));
    case "taskFailed":
      if (!["toPick", "toDrop", "loading", "unloading"].includes(state.phase)) return false;
      return fault(state, 5501, t, secs(60, 300));
    case "payloadOffset":
      return state.loaded && setCode(state, "warning", 2801, t, secs(60, 300));
    case "payloadShift":
      return state.loaded && setCode(state, "warning", 2902, t, secs(60, 480));
    case "tempLimitZone": {
      const seconds = secs(120, 600);
      if (!setCode(state, "warning", 2203, t, seconds)) return false;
      state.zoneUntil = t + seconds * 1000;
      return true;
    }
    case "teleopSession": {
      const seconds = secs(300, 900);
      setCode(state, "info", 1601, t, seconds, true);
      state.teleopUntil = t + seconds * 1000;
      return true;
    }
  }
};

/** What follows when a code clears — the causal chains described in the file comment. */
const onCleared = (state: VehicleState, site: Site, code: number, t: number, rng: Rng): void => {
  if (code === 2101 && rng.chance(0.15)) state.pending.push({ at: t, kind: "locLost" });
  if (code === 5101) state.pending.push({ at: t, kind: "relocalised" });
  if (code === 5202 && rng.chance(0.4)) state.pending.push({ at: t, kind: "teleop" });
  if (code === 2601 && rng.chance(0.4)) state.pending.push({ at: t, kind: "commDrop" });
  if (code === 2401 && rng.chance(0.1)) state.pending.push({ at: t, kind: "lidarDead" });
  if (code === 5701) state.estop = false;
  if (code === 5301) {
    // Released by hand with what is left in the pack: straight to the charger, and the protection
    // stays out of the way until it has charged (`chargeAt` is redrawn then).
    state.phase = "toCharger";
    state.target = site.charger;
    state.chargeAt = -1;
  }
  if (code === 5501) {
    // The dispatcher withdraws the failed task; the vehicle is free for the next one.
    state.loaded = false;
    state.phase = "idle";
    state.phaseUntil = t + rng.between(30, 120) * 1000;
    state.waitingSince = t;
  }
};

const runFollowUp = (state: VehicleState, kind: FollowUp, t: number, rng: Rng): void => {
  switch (kind) {
    case "locLost":
      fault(state, 5101, t, rng.between(180, 900));
      break;
    case "relocalised":
      setCode(state, "info", 1102, t, rng.between(60, 120), true);
      break;
    case "teleop": {
      const seconds = rng.between(120, 360);
      setCode(state, "info", 1601, t, seconds, true);
      state.teleopUntil = t + seconds * 1000;
      break;
    }
    case "commDrop":
      loseComms(state, t, rng.between(120, 1200));
      break;
    case "lidarDead":
      fault(state, 5401, t, rng.between(300, 1200));
      break;
    case "batteryHeat":
      if (state.phase === "charging") setCode(state, "warning", 2302, t, rng.between(360, 1200));
      break;
  }
};

/** How long the broker takes to notice a silent link and publish the vehicle's will (1.5 × 30 s keepalive). */
export const WILL_DELAY_MS = 45_000;
const PATROL_STOPS = [0.2, 0.45, 0.7, 0.9];
const ZONE_LIMIT = 0.6;

const drawChargeAt = (rng: Rng): number =>
  // Now and then a vehicle is kept on a job past its usual threshold and runs nearly flat.
  rng.chance(0.03) ? rng.between(4, 8) : rng.between(15, 35);

/** Planned maintenance: a clean shutdown, so the vehicle says goodbye before going quiet. */
const enterMaintenance = (state: VehicleState, t: number, rng: Rng, hours?: number): void => {
  state.phase = "maintenance";
  state.maintenanceUntil = t + Math.round((hours ?? rng.between(2, 4)) * 3600) * 1000;
  state.speed = 0;
  state.info = null;
  state.warning = null;
  state.error = null;
  state.estop = false;
  state.teleopUntil = 0;
  state.pending = [];
};

const startCharging = (state: VehicleState, site: Site, t: number, rng: Rng): void => {
  state.phase = "charging";
  state.chargeTo = rng.between(92, 100);
  setCode(state, "info", 1301, t, 12 * 3600, true);
  if (rng.chance(0.05 * (site.quirks.batteryHeat ?? 1))) {
    state.pending.push({ at: t + Math.round(rng.between(600, 2400)) * 1000, kind: "batteryHeat" });
  }
};

/** A patrol reports its round; a carrier just reports the task done (the status, not a message). */
const finishTask = (state: VehicleState, site: Site, t: number, rng: Rng): void => {
  const seconds = rng.between(30, 90);
  state.phase = "complete";
  state.phaseUntil = t + Math.round(seconds) * 1000;
  if (!site.profile.carries) setCode(state, "info", 1501, t, seconds);
};

/** Wait for the next task; a carrier with nothing coming for a while reports standing by. */
const waitForTask = (state: VehicleState, site: Site, t: number, rng: Rng): void => {
  const mean = site.profile.taskWait * (isNight(t) && !site.profile.shift ? 3 : 1);
  const seconds = Math.round(-Math.log(1 - rng.next()) * mean);
  state.phase = "idle";
  state.phaseUntil = t + seconds * 1000;
  state.waitingSince = t;
  if (site.profile.carries && seconds > 1200) setCode(state, "info", 1302, t, seconds);
};

const patrolStop = (site: Site, index: number): number =>
  site.route.wrap((PATROL_STOPS[index] ?? 0) * site.route.length);

/** The work cycle, one second: decide what the vehicle is doing next (motion is separate). */
const advancePhase = (state: VehicleState, site: Site, t: number, rng: Rng): void => {
  const p = site.profile;
  switch (state.phase) {
    case "idle":
      if (!onShift(site, t) || state.soc <= state.chargeAt) {
        state.phase = "toCharger";
        state.target = site.charger;
      } else if (t >= state.phaseUntil) {
        state.phase = "toPick";
        state.stop = 0;
        state.target = p.carries ? site.pick : patrolStop(site, 0);
      }
      break;
    case "loading":
      if (t < state.phaseUntil) break;
      if (p.carries) {
        state.loaded = true;
        state.phase = "toDrop";
        state.target = site.drop;
      } else if (state.stop + 1 >= PATROL_STOPS.length) {
        finishTask(state, site, t, rng);
      } else {
        state.stop += 1;
        state.phase = "toPick";
        state.target = patrolStop(site, state.stop);
      }
      break;
    case "docking":
      if (t >= state.phaseUntil) {
        state.phase = "unloading";
        state.phaseUntil = t + Math.round(rng.between(...p.dwell)) * 1000;
      }
      break;
    case "unloading":
    case "handover":
      if (t >= state.phaseUntil) {
        state.loaded = false;
        finishTask(state, site, t, rng);
      }
      break;
    case "complete":
      if (t >= state.phaseUntil) waitForTask(state, site, t, rng);
      break;
    case "charging":
      if (state.soc >= state.chargeTo) {
        if (state.info?.code === 1301) state.info = null;
        state.chargeAt = drawChargeAt(rng);
        if (onShift(site, t)) waitForTask(state, site, t, rng);
        else state.phase = "parked";
      }
      break;
    case "parked":
      if (onShift(site, t)) waitForTask(state, site, t, rng);
      // Shift-bound vehicles top up overnight rather than start the morning half-empty.
      else if (state.soc < 70) startCharging(state, site, t, rng);
      break;
    default:
      break;
  }
};

/** A driving phase reached its target this second. */
const arrive = (state: VehicleState, site: Site, t: number, rng: Rng): void => {
  const p = site.profile;
  state.speed = 0;
  state.s = state.target;
  switch (state.phase) {
    case "toPick":
      state.phase = "loading";
      state.phaseUntil = t + Math.round(rng.between(...p.dwell)) * 1000;
      break;
    case "toDrop":
      if (site.category === "牵引") {
        // A tug backs its trailer onto the dock.
        state.phase = "docking";
        state.phaseUntil = t + Math.round(rng.between(10, 20)) * 1000;
      } else if (site.category === "配料" && rng.chance(0.25)) {
        // Now and then the line side takes the parts by hand and has to confirm it.
        const seconds = rng.between(60, 300);
        state.phase = "handover";
        state.phaseUntil = t + Math.round(seconds) * 1000;
        setCode(state, "info", 1901, t, seconds);
      } else {
        state.phase = "unloading";
        state.phaseUntil = t + Math.round(rng.between(...p.dwell)) * 1000;
      }
      break;
    case "toCharger":
      if (!onShift(site, t) && state.soc >= 70) state.phase = "parked";
      else startCharging(state, site, t, rng);
      break;
    default:
      break;
  }
};

const EVENT_KINDS = (site: Site): Array<[EventKind, number]> => {
  const rates: Partial<Record<EventKind, number>> = { ...site.profile.events };
  for (const [kind, factor] of Object.entries(site.quirks)) {
    if (kind === "batteryHeat") continue;
    const key = kind as EventKind;
    rates[key] = key === "teleopSession" ? 0.15 * factor : (rates[key] ?? 0) * factor;
  }
  return Object.entries(rates).filter(([, rate]) => (rate ?? 0) > 0) as Array<[EventKind, number]>;
};
const eventTables = new WeakMap<Site, { kinds: Array<[EventKind, number]>; total: number }>();

/** At most one new event a second, drawn with one random number in the common case. */
const maybeStartEvent = (state: VehicleState, site: Site, t: number, rng: Rng): void => {
  let table = eventTables.get(site);
  if (!table) {
    const kinds = EVENT_KINDS(site);
    table = { kinds, total: kinds.reduce((sum, [, rate]) => sum + rate, 0) };
    eventTables.set(site, table);
  }
  const perSecond = (table.total * (isNight(t) && !site.profile.shift ? 0.6 : 1)) / 3600;
  if (rng.next() >= perSecond) return;
  let pick = rng.next() * table.total;
  for (const [kind, rate] of table.kinds) {
    pick -= rate;
    if (pick <= 0) {
      startEvent(state, kind, t, rng);
      return;
    }
  }
};

const INJECTED: Record<
  InjectionKind,
  { minutes: number; apply: (state: VehicleState, t: number, seconds: number, rng: Rng) => void }
> = {
  estop: {
    minutes: 15,
    apply: (state, t, seconds) => {
      setCode(state, "error", 5701, t, seconds, true);
      state.estop = true;
    },
  },
  obstacle: {
    minutes: 8,
    apply: (state, t, seconds) => setCode(state, "error", 5202, t, seconds, true),
  },
  "loc-lost": {
    minutes: 6,
    apply: (state, t, seconds) => setCode(state, "error", 5101, t, seconds, true),
  },
  "drive-fault": {
    minutes: 20,
    apply: (state, t, seconds) => setCode(state, "error", 5203, t, seconds, true),
  },
  "lidar-fault": {
    minutes: 10,
    apply: (state, t, seconds) => setCode(state, "error", 5401, t, seconds, true),
  },
  "task-failed": {
    minutes: 3,
    apply: (state, t, seconds) => setCode(state, "error", 5501, t, seconds, true),
  },
  "collision-guard": {
    minutes: 2,
    apply: (state, t, seconds) => setCode(state, "error", 5702, t, seconds, true),
  },
  "comm-loss": { minutes: 5, apply: (state, t, seconds) => loseComms(state, t, seconds) },
  maintenance: {
    minutes: 120,
    apply: (state, t, seconds, rng) => enterMaintenance(state, t, rng, seconds / 3600),
  },
  teleop: {
    minutes: 10,
    apply: (state, t, seconds) => {
      setCode(state, "info", 1601, t, seconds, true);
      state.teleopUntil = t + Math.round(seconds) * 1000;
    },
  },
  "low-battery": {
    minutes: 0,
    apply: (state) => {
      state.soc = Math.min(state.soc, 14);
      state.chargeAt = Math.min(state.chargeAt, 11);
    },
  },
  "battery-heat": {
    minutes: 15,
    apply: (state, t, seconds) => setCode(state, "warning", 2302, t, seconds, true),
  },
  payload: {
    minutes: 5,
    apply: (state, t, seconds) => setCode(state, "warning", 2902, t, seconds, true),
  },
  "speed-zone": {
    minutes: 5,
    apply: (state, t, seconds) => {
      setCode(state, "warning", 2203, t, seconds, true);
      state.zoneUntil = t + Math.round(seconds) * 1000;
    },
  },
};

/** Integer hash → [-1, 1]: pose noise that consumes no randomness, so frames are optional. */
const noise = (seed: number, t: number, channel: number): number => {
  let h =
    (seed ^ Math.imul(Math.floor(t / 1000), 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
};

const r3 = (value: number): number => Math.round(value * 1000) / 1000;

const inPermanentZone = (site: Site, s: number): boolean =>
  site.route.ahead(site.zone[0], s) <= site.route.ahead(site.zone[0], site.zone[1]);

const DRIVING: ReadonlySet<Phase> = new Set(["toPick", "toDrop", "toCharger"]);
const TASK_PHASES: ReadonlySet<Phase> = new Set([
  "toPick",
  "loading",
  "toDrop",
  "docking",
  "unloading",
  "handover",
]);

/**
 * Advance one vehicle by one second: apply `injections` due now, run the second at `state.t`,
 * and return what the vehicle reported during it. `withFrame: false` skips building the frame —
 * fast-forwarding a month — and changes nothing else.
 */
export const step = (
  site: Site,
  state: VehicleState,
  injections: readonly Injection[] = [],
  withFrame = true,
): StepResult => {
  const rng = new Rng(state.rng);
  const t = state.t;
  const p = site.profile;
  let status: boolean | null = null;
  const finish = (frame: Record<string, unknown> | null): StepResult => {
    state.t = t + 1000;
    state.rng = rng.save();
    return { frame, status };
  };

  for (const injection of injections) {
    const spec = INJECTED[injection.kind];
    spec.apply(state, t, (injection.minutes ?? spec.minutes) * 60, rng);
  }

  // Planned maintenance: a clean goodbye, hours of silence, then back with fresh localisation.
  if (
    state.phase !== "maintenance" &&
    t >= state.nextMaintenanceAt &&
    !state.error &&
    (state.phase === "idle" || state.phase === "parked" || state.phase === "charging")
  ) {
    enterMaintenance(state, t, rng);
  }
  if (state.phase === "maintenance") {
    if (t < state.maintenanceUntil) {
      if (state.online) {
        state.online = false;
        status = false;
      }
      return finish(null);
    }
    state.online = true;
    status = true;
    state.nextMaintenanceAt = maintenanceSlot(t, rng.between(10, 16), rng);
    waitForTask(state, site, t, rng);
    setCode(state, "info", 1101, t, rng.between(60, 180), true);
  }

  for (const slot of ["info", "warning", "error"] as const) {
    const code = state[slot];
    if (code && code.until <= t) {
      state[slot] = null;
      onCleared(state, site, code.code, t, rng);
    }
  }
  if (state.pending.length) {
    const due = state.pending.filter((item) => item.at <= t);
    if (due.length) {
      state.pending = state.pending.filter((item) => item.at > t);
      for (const item of due) runFollowUp(state, item.kind, t, rng);
    }
  }
  if (state.teleopUntil && t >= state.teleopUntil) state.teleopUntil = 0;

  // Connectivity: a silent link is noticed by the broker after the keepalive, which publishes the
  // vehicle's will; coming back, the vehicle announces itself.
  const silent = t < state.silentUntil;
  if (silent && state.online && t - state.silentSince >= WILL_DELAY_MS) {
    state.online = false;
    status = false;
  } else if (!silent && !state.online) {
    state.online = true;
    status = true;
  }

  if (working(state) && !silent) maybeStartEvent(state, site, t, rng);

  const halted = !!state.error || state.estop;
  if (halted) {
    // Timed work pauses while the vehicle is stopped.
    if (state.phaseUntil > t) state.phaseUntil += 1000;
  } else {
    advancePhase(state, site, t, rng);
  }

  // Motion: accelerate towards what the route, the load, the zone and the remaining distance allow.
  let vmax = 0;
  if (!halted && DRIVING.has(state.phase)) {
    vmax = p.speed * (state.loaded ? p.loadedSpeedFactor : 1);
    vmax *= 1 + 0.04 * Math.sin(t / 9000 + site.noiseSeed);
    if (t < state.degradedUntil) vmax *= 0.6;
    if (t < state.zoneUntil || inPermanentZone(site, state.s)) vmax = Math.min(vmax, ZONE_LIMIT);
    if (state.teleopUntil) vmax = Math.min(vmax, 0.5);
    const turn = Math.abs(site.route.turnAhead(state.s, 1.5));
    vmax *= 0.35 + 0.65 * (1 - Math.min(1, turn / (Math.PI / 2)));
    const remaining = site.route.ahead(state.s, state.target);
    vmax = Math.min(vmax, Math.sqrt(2 * p.decel * Math.max(0, remaining - 0.05)));
  }
  if (!halted && state.phase === "docking") {
    state.speed = Math.max(-0.3, state.speed - p.accel);
  } else if (state.speed < vmax) {
    state.speed = Math.min(vmax, state.speed + p.accel);
  } else {
    state.speed =
      state.speed > 0 ? Math.max(vmax, state.speed - p.decel) : Math.min(0, state.speed + p.decel);
  }
  const previousS = state.s;
  state.s = site.route.wrap(state.s + state.speed);
  if (
    !halted &&
    DRIVING.has(state.phase) &&
    (site.route.ahead(previousS, state.target) <= Math.max(0.05, state.speed) ||
      (vmax < 0.02 && state.speed < 0.02))
  ) {
    arrive(state, site, t, rng);
  }

  // Battery: charge tapers above 80 %; driving drains with speed and load.
  const moving = Math.abs(state.speed) > 0.05;
  if (state.phase === "charging") {
    const rate =
      state.soc < 80 ? p.chargeRate : p.chargeRate * Math.max(0.15, (100 - state.soc) / 20);
    state.soc = Math.min(100, state.soc + rate / 3600);
  } else {
    const drain = moving
      ? p.drainDriving * (Math.abs(state.speed) / p.speed) * (state.loaded ? 1.25 : 1)
      : state.phase === "parked"
        ? 0.3
        : p.drainStanding;
    state.soc = Math.max(1, state.soc - drain / 3600);
    if (state.soc <= 5 && state.chargeAt >= 0 && working(state) && !state.error) {
      fault(state, 5301, t, rng.between(1200, 3600));
    }
  }

  // Speed limit in force, and since when.
  const zone = t < state.zoneUntil || inPermanentZone(site, state.s);
  const limit = zone
    ? { limit: ZONE_LIMIT, module: "safety", slowdown: 5 }
    : t < state.degradedUntil
      ? { limit: 0.8, module: "navigation", slowdown: 3 }
      : state.teleopUntil
        ? { limit: 0.5, module: "teleop", slowdown: 0 }
        : { limit: site.baseLimit, module: "dispatcher", slowdown: 0 };
  const limitKey = `${limit.module}:${limit.limit}`;
  if (limitKey !== state.limitKey) {
    state.limitKey = limitKey;
    state.limitSince = t;
  }

  if (!withFrame || silent) return finish(null);

  const pose = site.route.pose(state.s);
  const before = site.route.pose(state.s - state.speed);
  let yawRate = pose.yaw - before.yaw;
  while (yawRate > Math.PI) yawRate -= Math.PI * 2;
  while (yawRate <= -Math.PI) yawRate += Math.PI * 2;
  const jitter = t < state.degradedUntil ? 0.08 : 0.01;
  const fusion: Pose = {
    x: pose.x + noise(site.noiseSeed, t, 0) * jitter,
    y: pose.y + noise(site.noiseSeed, t, 1) * jitter,
    yaw: pose.yaw + noise(site.noiseSeed, t, 2) * 0.002,
  };
  const cos = Math.cos(fusion.yaw);
  const sin = Math.sin(fusion.yaw);
  const code = (slot: ActiveCode | null) =>
    slot
      ? { code: slot.code, info: CODE_TEXT[slot.code] ?? "", stamp: slot.since }
      : { code: 0, info: "", stamp: t };
  const parkedOrCharging = state.phase === "charging" || state.phase === "parked";
  const inTask = TASK_PHASES.has(state.phase);
  const frame: Record<string, unknown> = {
    stamp: t,
    scene_id: site.sceneId,
    ...(site.gps ? { gps: sceneToGps(site.gps, fusion) } : {}),
    fusion_loc: { x: r3(fusion.x), y: r3(fusion.y), yaw: r3(fusion.yaw) },
    // The lidar sits 0.15 m ahead of the reference point and localises a little noisier.
    lidar_loc: {
      x: r3(fusion.x + 0.15 * cos + noise(site.noiseSeed, t, 3) * 0.02),
      y: r3(fusion.y + 0.15 * sin + noise(site.noiseSeed, t, 4) * 0.02),
      yaw: r3(fusion.yaw + noise(site.noiseSeed, t, 5) * 0.004),
    },
    vehicle_info: {
      control_mode: state.estop ? 3 : state.teleopUntil ? 2 : parkedOrCharging ? 0 : 1,
      gear: parkedOrCharging ? 2 : state.speed < -0.02 ? -1 : moving ? 1 : 0,
      speed: r3(state.speed),
      omega: r3(Math.max(-0.8, Math.min(0.8, yawRate))),
      soc: Math.round(state.soc * 10) / 10,
    },
    task_status:
      state.error && inTask
        ? 3
        : state.phase === "charging"
          ? 4
          : state.phase === "complete"
            ? 2
            : inTask || state.phase === "toCharger"
              ? 1
              : 0,
    platform_task_status:
      state.error && inTask
        ? 3
        : state.phase === "complete"
          ? 4
          : state.phase === "toPick"
            ? 1
            : inTask
              ? 2
              : 0,
    info_code: code(state.info),
    warning_code: code(state.warning),
    error_code: code(state.error),
    speed_limit: {
      limit: limit.limit,
      slowdown_time: limit.slowdown,
      stamp: state.limitSince,
      module_name: limit.module,
    },
  };
  return finish(frame);
};
