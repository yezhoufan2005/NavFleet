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
  FIRMWARE_CODES,
  isNight,
  localHour,
  localHourFraction,
  localWeekday,
  VENDOR_ALARMS,
  type Category,
  type EventKind,
  type Persona,
  type Profile,
  type VendorProfile,
  type VisitorConfig,
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

type FollowUp =
  "locLost" | "relocalised" | "teleop" | "commDrop" | "lidarDead" | "batteryHeat" | "backupLink";

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
  /**
   * The task the dispatcher has the vehicle on, as reported in the frame's `task` (see `taskOf`).
   * Optional so a checkpoint written before these fields existed still loads: missing reads as
   * "no task yet", and the next task the vehicle starts gets an id.
   */
  taskKind?: TaskKind | null;
  taskId?: string | null;
  taskStartedAt?: number;
  /** Tasks issued to this vehicle so far, for the sequence part of the id. */
  taskSeq?: number;
  /**
   * Fields added with the vendor and site behaviour (all optional, so an older checkpoint loads):
   * the vendor's own active alarms, the speed caps of a person nearby and of a cold battery, and
   * whether the vehicle is out on its night round in another scene (and which night it last was).
   */
  alarms?: ActiveCode[];
  peopleUntil?: number;
  powerLimitUntil?: number;
  away?: boolean;
  awayDay?: string;
}

/** A work task (巡检 round / 搬运·牵引·配料 job) or a trip to the charger. */
export type TaskKind = "work" | "charge";

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
  /** What this vendor's firmware sends (see `VendorProfile`). */
  vendor: VendorProfile;
  /** How this one vehicle differs from its kind (see `Persona`). */
  persona: Persona;
  /**
   * Where it works: a floor shared with people (2701), a lifting chassis (5801), the cold store
   * (2303), outdoors (where a weak Wi-Fi link falls back to 4G, 1602).
   */
  traits: { people: boolean; lifts: boolean; cold: boolean; outdoor: boolean };
  /** The scene of its occasional night round: id, loop and GPS origin. */
  night?: { sceneId: string; route: Route; gps: Point | null };
  /** A visiting vehicle's switched-on hours; absent for the roster. */
  visitor?: VisitorConfig;
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
  | "speed-zone"
  | "people"
  | "lift-jam"
  | "cold-battery"
  | "unknown-code"
  | "vendor-alarm"
  | "safety-loop"
  | "comm-degraded"
  | "bms-comm";

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
  "people",
  "lift-jam",
  "cold-battery",
  "unknown-code",
  "vendor-alarm",
  "safety-loop",
  "comm-degraded",
  "bms-comm",
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
  /**
   * A stale frame a buffering 4G gateway flushes after this second's (stamped seconds earlier), to
   * be published right after `frame`. The backend refuses it as out of order.
   */
  lateFrame?: Record<string, unknown>;
}

const HOUR = 3_600_000;

/** The next planned-maintenance start: `days` from `from`, on a weekday-agnostic 09–14 local slot. */
const maintenanceSlot = (from: number, days: number, rng: Rng): number => {
  const day = Math.floor((from + 8 * HOUR) / (24 * HOUR)) + Math.round(days);
  return day * 24 * HOUR - 8 * HOUR + rng.between(9, 14) * HOUR;
};

/**
 * A vehicle as it is when it joins the simulation at `t`. `slot / slots` spreads vehicles that
 * share a loop, so they neither stack up nor move in lockstep.
 */
export const initialState = (site: Site, t: number, slot: number, slots: number): VehicleState => {
  const rng = new Rng(seedOf(`vehicle:${site.deviceId}`));
  const state: VehicleState = {
    deviceId: site.deviceId,
    t,
    rng: 0,
    s: site.route.wrap((slot / Math.max(1, slots)) * site.route.length),
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
    taskKind: null,
    taskId: null,
    taskStartedAt: 0,
    taskSeq: 0,
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
  // An obstacle, a guard stop, a planning timeout or a speed zone happens to a vehicle on the move;
  // drawn for one standing at its post, the console showed 「避障等待超时」 at 0 m/s.
  const driving = DRIVING.has(state.phase) && state.speed > 0.2;
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
      return driving && fault(state, 5703, t, secs(120, 720));
    case "collisionGuard":
      return driving && fault(state, 5702, t, secs(30, 180));
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
      return driving && fault(state, 5102, t, secs(60, 300));
    case "taskFailed":
      if (!["toPick", "toDrop", "loading", "unloading"].includes(state.phase)) return false;
      return fault(state, 5501, t, secs(60, 300));
    case "payloadOffset":
      return state.loaded && setCode(state, "warning", 2801, t, secs(60, 300));
    case "payloadShift":
      return state.loaded && setCode(state, "warning", 2802, t, secs(60, 480));
    case "tempLimitZone": {
      const seconds = secs(120, 600);
      if (!driving || !setCode(state, "warning", 2203, t, seconds)) return false;
      state.zoneUntil = t + seconds * 1000;
      return true;
    }
    case "teleopSession": {
      const seconds = secs(300, 900);
      setCode(state, "info", 1601, t, seconds, true);
      state.teleopUntil = t + seconds * 1000;
      return true;
    }
    case "peopleNearby": {
      // People are on the floor in the working day; the safety scanner slows the vehicle for them.
      const hour = localHour(t);
      if (!driving || hour < 7 || hour >= 22) return false;
      const seconds = secs(20, 90);
      if (!setCode(state, "warning", 2701, t, seconds)) return false;
      state.peopleUntil = t + seconds * 1000;
      return true;
    }
    case "liftJam":
      // The lift jams while raising or lowering a rack.
      if (!["loading", "unloading"].includes(state.phase)) return false;
      return fault(state, 5801, t, secs(600, 2400));
    case "coldBattery": {
      if (state.phase === "charging") return false;
      const seconds = secs(600, 1800);
      if (!setCode(state, "warning", 2303, t, seconds)) return false;
      state.powerLimitUntil = t + seconds * 1000;
      return true;
    }
    case "vendorAlarm": {
      const total = VENDOR_ALARMS.reduce((sum, alarm) => sum + alarm.weight, 0);
      let pick = rng.next() * total;
      const alarm =
        VENDOR_ALARMS.find((candidate) => (pick -= candidate.weight) <= 0) ?? VENDOR_ALARMS[0]!;
      const active = state.alarms ?? [];
      if (active.some((entry) => entry.code === alarm.code)) return false;
      const seconds = forcedSeconds ?? rng.between(...alarm.seconds);
      state.alarms = [
        ...active,
        { code: alarm.code, since: t, until: t + Math.round(seconds) * 1000 },
      ];
      return true;
    }
    case "firmwareCode": {
      const entry = FIRMWARE_CODES[Math.floor(rng.next() * FIRMWARE_CODES.length)]!;
      return setCode(state, entry.slot, entry.code, t, secs(...entry.seconds));
    }
  }
};

/** What follows when a code clears — the causal chains described in the file comment. */
const onCleared = (state: VehicleState, site: Site, code: number, t: number, rng: Rng): void => {
  if (code === 2101 && rng.chance(0.15)) state.pending.push({ at: t, kind: "locLost" });
  if (code === 5101) state.pending.push({ at: t, kind: "relocalised" });
  if (code === 5703 && rng.chance(0.4)) state.pending.push({ at: t, kind: "teleop" });
  if (code === 2601) {
    // A degraded link either drops, or — outdoors, where the router has a 4G uplink — falls back.
    if (rng.chance(0.4)) state.pending.push({ at: t, kind: "commDrop" });
    else if (site.traits.outdoor && rng.chance(0.5))
      state.pending.push({ at: t, kind: "backupLink" });
  }
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
    case "backupLink":
      setCode(state, "info", 1602, t, rng.between(120, 600));
      break;
  }
};

/** How long the broker takes to notice a silent link and publish the vehicle's will (1.5 × 30 s keepalive). */
export const WILL_DELAY_MS = 45_000;
const PATROL_STOPS = [0.2, 0.45, 0.7, 0.9];
const ZONE_LIMIT = 0.6;
/** Localisation degraded (2101): navigation caps the speed. */
const DEGRADED_LIMIT = 0.8;
/** Under remote control (1601). */
const TELEOP_LIMIT = 0.5;
/** A person inside the safety scanner's slow field (2701). */
const PEOPLE_LIMIT = 0.3;
/** The battery management system limits power in the cold (2303). */
const POWER_LIMIT = 0.6;

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
  state.alarms = [];
  state.peopleUntil = 0;
  state.powerLimitUntil = 0;
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
  if (site.profile.carries && seconds > 1200) setCode(state, "info", 1502, t, seconds);
};

const patrolStop = (route: Route, index: number): number =>
  route.wrap((PATROL_STOPS[index] ?? 0) * route.length);

/** The loop the vehicle is on now: its own, or its night round's. */
const routeOf = (site: Site, state: VehicleState): Route =>
  state.away && site.night ? site.night.route : site.route;

/**
 * A patrol vehicle with a night round sometimes takes its next round in the other scene, once a
 * night between 01:00 and 04:00 and only with charge to spare. It is driven there and back off the
 * maps, so it leaves one scene and appears in the other (the console resets its trail).
 */
const maybeGoAway = (state: VehicleState, site: Site, t: number, rng: Rng): void => {
  if (!site.night || site.profile.carries || state.away || state.soc < 60) return;
  const hour = localHour(t);
  if (hour < 1 || hour >= 4 || state.awayDay === localDay(t) || !rng.chance(0.5)) return;
  state.away = true;
  state.awayDay = localDay(t);
  state.s = 0;
};

/** The work cycle, one second: decide what the vehicle is doing next (motion is separate). */
const advancePhase = (state: VehicleState, site: Site, t: number, rng: Rng): void => {
  const p = site.profile;
  switch (state.phase) {
    case "idle":
      if (!onShift(site, t) || state.soc <= state.chargeAt) {
        state.phase = "toCharger";
        state.target = site.charger;
      } else if (t >= state.phaseUntil) {
        maybeGoAway(state, site, t, rng);
        state.phase = "toPick";
        state.stop = 0;
        state.target = p.carries ? site.pick : patrolStop(routeOf(site, state), 0);
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
        state.target = patrolStop(routeOf(site, state), state.stop);
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
      if (t >= state.phaseUntil) {
        if (state.away) {
          // The round done, back to its own scene, at its charger.
          state.away = false;
          state.s = site.charger;
        }
        waitForTask(state, site, t, rng);
      }
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
        setCode(state, "info", 1503, t, seconds);
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

/**
 * Event rates per working hour for one vehicle: its category's, times the quirks in its notes,
 * plus what its place and make add — people on the floor, a lifting chassis, the cold, a vendor
 * alarm list, a trial firmware, a weak 4G area.
 */
const EVENT_KINDS = (site: Site): Array<[EventKind, number]> => {
  const rates: Partial<Record<EventKind, number>> = { ...site.profile.events };
  for (const [kind, factor] of Object.entries(site.quirks)) {
    if (kind === "batteryHeat") continue;
    const key = kind as EventKind;
    rates[key] = key === "teleopSession" ? 0.15 * factor : (rates[key] ?? 0) * factor;
  }
  if (site.traits.people) rates.peopleNearby = 0.12;
  if (site.traits.lifts) rates.liftJam = 0.015;
  if (site.traits.cold) rates.coldBattery = 0.6;
  if (site.vendor.alarms) rates.vendorAlarm = site.visitor ? 0.4 : 0.04;
  if (site.persona.trialFirmware) rates.firmwareCode = 0.06;
  if (site.persona.lateFrames) rates.commDegraded = (rates.commDegraded ?? 0) * 3;
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
  // Running nearly flat on the move, the pack's voltage sags and the drives pull more current: they
  // run hot (a controller with its own alarm list says so) and a loaded vehicle tracks its line less
  // well. This is how one vehicle ends up with four or five messages at once — low battery, hot
  // drives, a tracking deviation, then the battery protection stopping it.
  if (state.soc < 12 && DRIVING.has(state.phase) && rng.next() < 6 / 3600) {
    if (site.vendor.alarms && !(state.alarms ?? []).some((alarm) => alarm.code === 54003)) {
      state.alarms = [
        ...(state.alarms ?? []),
        { code: 54003, since: t, until: t + Math.round(rng.between(600, 2400)) * 1000 },
      ];
    } else {
      startEvent(state, "trackingDeviation", t, rng);
    }
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
    apply: (state, t, seconds) => setCode(state, "error", 5703, t, seconds, true),
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
    apply: (state, t, seconds) => setCode(state, "warning", 2802, t, seconds, true),
  },
  "speed-zone": {
    minutes: 5,
    apply: (state, t, seconds) => {
      setCode(state, "warning", 2203, t, seconds, true);
      state.zoneUntil = t + Math.round(seconds) * 1000;
    },
  },
  people: {
    minutes: 2,
    apply: (state, t, seconds) => {
      setCode(state, "warning", 2701, t, seconds, true);
      state.peopleUntil = t + Math.round(seconds) * 1000;
    },
  },
  "lift-jam": {
    minutes: 10,
    apply: (state, t, seconds) => setCode(state, "error", 5801, t, seconds, true),
  },
  "cold-battery": {
    minutes: 15,
    apply: (state, t, seconds) => {
      setCode(state, "warning", 2303, t, seconds, true);
      state.powerLimitUntil = t + Math.round(seconds) * 1000;
    },
  },
  // What a trial firmware reports: a code no dictionary has, and no text with it.
  "unknown-code": {
    minutes: 5,
    apply: (state, t, seconds) => setCode(state, "error", 5299, t, seconds, true),
  },
  // The vendor's own alarm list (any vehicle: an injection is a demonstration).
  "vendor-alarm": {
    minutes: 10,
    apply: (state, t, seconds) => raiseAlarm(state, 54003, t, seconds),
  },
  // The fire-alarm interlock opening the vehicle's safety loop: an e-stop the controller reports in
  // its alarm list too (see the 消防联动演练 scenario).
  "safety-loop": {
    minutes: 10,
    apply: (state, t, seconds) => {
      setCode(state, "error", 5701, t, seconds, true);
      state.estop = true;
      raiseAlarm(state, 51001, t, seconds);
    },
  },
  "comm-degraded": {
    minutes: 5,
    apply: (state, t, seconds) => setCode(state, "warning", 2601, t, seconds, true),
  },
  // The controller loses its battery management system's heartbeat (its alarm list only).
  "bms-comm": { minutes: 5, apply: (state, t, seconds) => raiseAlarm(state, 52101, t, seconds) },
};

/** Add (or renew) one entry of the vehicle's own alarm list. */
const raiseAlarm = (state: VehicleState, code: number, t: number, seconds: number): void => {
  const others = (state.alarms ?? []).filter((alarm) => alarm.code !== code);
  state.alarms = [...others, { code, since: t, until: t + Math.round(seconds) * 1000 }];
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

/** Which task the current phase belongs to; null while idle, charging, parked or in maintenance. */
const taskKindOf = (phase: Phase): TaskKind | null =>
  TASK_PHASES.has(phase) || phase === "complete" ? "work" : phase === "toCharger" ? "charge" : null;

/** `YYYYMMDD` in the deployment's local time (UTC+8, as `localHour`). */
const localDay = (ms: number): string =>
  new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10).replaceAll("-", "");

/**
 * Keep the task bookkeeping in step with the phase: a new kind of task (or a fresh one after an
 * idle spell) gets the next id and its start time; no task clears it. A patrol moving between its
 * stops, or a job going from 装货 to 卸货, stays one task.
 */
const syncTask = (state: VehicleState, t: number): void => {
  const kind = taskKindOf(state.phase);
  if (kind === (state.taskKind ?? null) && (kind === null || state.taskId)) return;
  state.taskKind = kind;
  if (kind === null) {
    state.taskId = null;
    return;
  }
  state.taskSeq = (state.taskSeq ?? 0) + 1;
  state.taskId = `${state.deviceId}-${localDay(t)}-${String(state.taskSeq).padStart(4, "0")}`;
  state.taskStartedAt = t;
};

/** A station name the vehicle's job runs between, stable per vehicle. */
const station = (prefix: string, letter: string, seed: number): string =>
  `${prefix} ${letter}${String((seed % 12) + 1).padStart(2, "0")}`;

/**
 * The frame's `task`: what the dispatcher has the vehicle doing, step by step. Read-only on the
 * platform side — the console shows it, nothing is sent back.
 */
export const taskOf = (state: VehicleState, site: Site): Record<string, unknown> | null => {
  if (!state.taskKind || !state.taskId) return null;
  const base = { id: state.taskId, started_at: state.taskStartedAt ?? state.t };
  if (state.taskKind === "charge") {
    return {
      ...base,
      type: "充电",
      from: null,
      to: "充电位",
      step: 1,
      steps: 1,
      step_name: "前往充电位",
    };
  }
  const done = state.phase === "complete";
  if (!site.profile.carries) {
    const steps = PATROL_STOPS.length;
    const stop = Math.min(state.stop, steps - 1) + 1;
    return {
      ...base,
      type: site.category,
      from: null,
      to: `巡检点 ${stop}`,
      step: done ? steps : stop,
      steps,
      step_name: done
        ? "巡检完成"
        : state.phase === "loading"
          ? `巡检点 ${stop} 检测中`
          : `前往巡检点 ${stop}`,
    };
  }
  const STEP: Partial<Record<Phase, [number, string]>> = {
    toPick: [1, "前往取货位"],
    loading: [2, site.category === "牵引" ? "挂车" : "装货"],
    toDrop: [3, "前往卸货位"],
    docking: [4, "倒车入位"],
    unloading: [4, site.category === "牵引" ? "摘挂" : "卸货"],
    handover: [4, "等待人工交接"],
    complete: [4, "任务完成"],
  };
  const [step, stepName] = STEP[state.phase] ?? [1, "前往取货位"];
  return {
    ...base,
    type: site.category,
    from: station("取货位", "P", site.noiseSeed),
    to: station("卸货位", "D", site.noiseSeed >>> 4),
    step,
    steps: 4,
    step_name: stepName,
  };
};

/**
 * Advance one vehicle by one second: apply `injections` due now, run the second at `state.t`,
 * and return what the vehicle reported during it. `withFrame: false` skips building the frame —
 * fast-forwarding a month — and changes nothing else.
 */
/** Whether a visiting vehicle is switched on at `t` (its days and hours, on the site's clock). */
const visitorOn = (visitor: VisitorConfig, t: number): boolean => {
  const hour = localHourFraction(t);
  return (
    visitor.days.includes(localWeekday(t)) && hour >= visitor.hours[0] && hour < visitor.hours[1]
  );
};

/** The speed caps in force, the strictest first — what navigation applies and the frame reports. */
const speedCaps = (
  site: Site,
  state: VehicleState,
  t: number,
): Array<{ limit: number; module: string; slowdown: number }> => {
  const caps: Array<{ limit: number; module: string; slowdown: number }> = [];
  if (t < (state.peopleUntil ?? 0))
    caps.push({ limit: PEOPLE_LIMIT, module: "safety", slowdown: 2 });
  if (t < state.zoneUntil || (!state.away && inPermanentZone(site, state.s))) {
    caps.push({ limit: ZONE_LIMIT, module: "safety", slowdown: 5 });
  }
  if (t < state.degradedUntil) {
    caps.push({ limit: DEGRADED_LIMIT, module: "navigation", slowdown: 3 });
  }
  if (t < (state.powerLimitUntil ?? 0))
    caps.push({ limit: POWER_LIMIT, module: "bms", slowdown: 4 });
  if (state.teleopUntil) caps.push({ limit: TELEOP_LIMIT, module: "teleop", slowdown: 0 });
  return caps.sort((a, b) => a.limit - b.limit);
};

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
  const finish = (
    frame: Record<string, unknown> | null,
    lateFrame?: Record<string, unknown>,
  ): StepResult => {
    state.t = t + 1000;
    state.rng = rng.save();
    return lateFrame ? { frame, status, lateFrame } : { frame, status };
  };

  for (const injection of injections) {
    const spec = INJECTED[injection.kind];
    spec.apply(state, t, (injection.minutes ?? spec.minutes) * 60, rng);
  }

  // A visiting vehicle is simply off outside its hours: it says goodbye and goes quiet.
  if (site.visitor) {
    if (!visitorOn(site.visitor, t)) {
      if (state.online) {
        state.online = false;
        status = false;
      }
      return finish(null);
    }
    if (!state.online) {
      state.online = true;
      status = true;
    }
  }

  // Planned maintenance: a clean goodbye, hours of silence, then back with fresh localisation.
  if (
    !site.visitor &&
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
    // A controller with its own alarm list often comes back with a map older than the dispatcher's.
    if (site.vendor.alarms && rng.chance(0.5)) {
      state.alarms = [
        { code: 50601, since: t, until: t + Math.round(rng.between(300, 900)) * 1000 },
      ];
    }
  }

  for (const slot of ["info", "warning", "error"] as const) {
    const code = state[slot];
    if (code && code.until <= t) {
      state[slot] = null;
      onCleared(state, site, code.code, t, rng);
    }
  }
  if (state.alarms?.length) state.alarms = state.alarms.filter((alarm) => alarm.until > t);
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

  // Motion: accelerate towards what the route, the load, the caps and the remaining distance allow.
  const route = routeOf(site, state);
  let vmax = 0;
  if (!halted && DRIVING.has(state.phase)) {
    vmax = p.speed * (state.loaded ? p.loadedSpeedFactor : 1);
    vmax *= 1 + 0.04 * Math.sin(t / 9000 + site.noiseSeed);
    // Localisation degraded also scales cruise down, under its cap.
    if (t < state.degradedUntil) vmax *= 0.6;
    // The same caps the frame reports below, so a vehicle never runs over its own speed_limit.
    for (const cap of speedCaps(site, state, t)) vmax = Math.min(vmax, cap.limit);
    const turn = Math.abs(route.turnAhead(state.s, 1.5));
    vmax *= 0.35 + 0.65 * (1 - Math.min(1, turn / (Math.PI / 2)));
    const remaining = route.ahead(state.s, state.target);
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
  state.s = route.wrap(state.s + state.speed);
  if (
    !halted &&
    DRIVING.has(state.phase) &&
    (route.ahead(previousS, state.target) <= Math.max(0.05, state.speed) ||
      (vmax < 0.02 && state.speed < 0.02))
  ) {
    arrive(state, site, t, rng);
  }

  // Battery: charge tapers above 80 %; driving drains with speed and load, faster in the cold.
  const moving = Math.abs(state.speed) > 0.05;
  if (state.phase === "charging") {
    const rate =
      state.soc < 80 ? p.chargeRate : p.chargeRate * Math.max(0.15, (100 - state.soc) / 20);
    state.soc = Math.min(100, state.soc + rate / 3600);
  } else {
    const drain =
      (moving
        ? p.drainDriving * (Math.abs(state.speed) / p.speed) * (state.loaded ? 1.25 : 1)
        : state.phase === "parked"
          ? 0.3
          : p.drainStanding) * (site.traits.cold ? 1.25 : 1);
    state.soc = Math.max(1, state.soc - drain / 3600);
    if (state.soc <= 5 && state.chargeAt >= 0 && working(state) && !state.error) {
      const seconds = rng.between(1200, 3600);
      fault(state, 5301, t, seconds);
      // A controller with its own alarm list reports the protection there too, for as long.
      if (site.vendor.alarms && !(state.alarms ?? []).some((alarm) => alarm.code === 52203)) {
        state.alarms = [
          ...(state.alarms ?? []),
          { code: 52203, since: t, until: t + Math.round(seconds) * 1000 },
        ];
      }
    }
  }

  // A controller with its own alarm list keeps a low-charge entry while the pack is under 12 %
  // and not on the charger — on top of the platform's own low-battery rule, which fires at 20 %.
  if (site.vendor.alarms) {
    const low = state.soc < 12 && state.phase !== "charging";
    const entry = state.alarms?.find((alarm) => alarm.code === 52301);
    if (low && entry) entry.until = t + 2000;
    else if (low)
      state.alarms = [...(state.alarms ?? []), { code: 52301, since: t, until: t + 2000 }];
  }

  // Speed limit in force, and since when.
  const limit = speedCaps(site, state, t)[0] ?? {
    limit: site.baseLimit,
    module: "dispatcher",
    slowdown: 0,
  };
  const limitKey = `${limit.module}:${limit.limit}`;
  if (limitKey !== state.limitKey) {
    state.limitKey = limitKey;
    state.limitSince = t;
  }

  syncTask(state, t);

  if (!withFrame || silent) return finish(null);
  const frame = site.visitor ? visitorFrame(site, state, t) : buildFrame(site, state, t, limit);
  // A 4G gateway on a weak link flushes what it buffered: a frame from a few seconds ago arrives
  // after this one.
  const late =
    site.persona.lateFrames && state.warning?.code === 2601 && Math.floor(t / 1000) % 17 === 0
      ? { ...frame, stamp: (frame.stamp as number) - 4000 }
      : undefined;
  return finish(frame, late);
};

/**
 * The vendor's own alarms, as its controller lists them (`alarmList`). The id carries the vehicle,
 * as the controller's does: a list entry is one condition on one vehicle, and the console keys a
 * message by its id across the fleet.
 */
const alarmList = (site: Site, state: VehicleState, skew: number): Array<Record<string, unknown>> =>
  (state.alarms ?? []).map((active) => {
    const alarm = VENDOR_ALARMS.find((entry) => entry.code === active.code);
    return {
      id: `${site.deviceId}-alarm-${active.code}`,
      code: active.code,
      title: alarm?.title ?? `报警 ${active.code}`,
      detail: alarm?.detail ?? "",
      level: alarm?.level ?? "WARN",
      timestamp: active.since + skew,
    };
  });

/** What a visiting debug build reports: where it is, its codes and alarms — nothing else. */
const visitorFrame = (site: Site, state: VehicleState, t: number): Record<string, unknown> => {
  const pose = site.route.pose(state.s);
  const code = (slot: ActiveCode | null) =>
    slot
      ? { code: slot.code, info: CODE_TEXT[slot.code] ?? "", stamp: slot.since }
      : { code: 0, info: "", stamp: t };
  return {
    stamp: t,
    scene_id: site.visitor?.reportedSceneId ?? site.sceneId,
    ...(site.gps ? { gps: sceneToGps(site.gps, pose) } : {}),
    info_code: code(state.info),
    warning_code: code(state.warning),
    error_code: code(state.error),
    alarmList: alarmList(site, state, 0),
  };
};

/** The full vehicle-protocol frame, minus what this vendor's firmware does not send. */
const buildFrame = (
  site: Site,
  state: VehicleState,
  t: number,
  limit: { limit: number; module: string; slowdown: number },
): Record<string, unknown> => {
  const route = routeOf(site, state);
  const omits = new Set(site.vendor.omits);
  // The vehicle stamps everything with its own clock, which may run ahead (see `Persona`).
  const skew = site.persona.clockSkewMs ?? 0;
  const pose = route.pose(state.s);
  const before = route.pose(state.s - state.speed);
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
      ? { code: slot.code, info: CODE_TEXT[slot.code] ?? "", stamp: slot.since + skew }
      : { code: 0, info: "", stamp: t + skew };
  const parkedOrCharging = state.phase === "charging" || state.phase === "parked";
  const inTask = TASK_PHASES.has(state.phase);
  const moving = Math.abs(state.speed) > 0.05;
  const gpsOrigin = state.away && site.night ? site.night.gps : site.gps;
  const gpsNoise = site.persona.gpsNoise ?? 0;
  const gpsPose = gpsNoise
    ? {
        ...fusion,
        x: fusion.x + noise(site.noiseSeed, t, 6) * gpsNoise,
        y: fusion.y + noise(site.noiseSeed, t, 7) * gpsNoise,
      }
    : fusion;
  const gps = gpsOrigin ? sceneToGps(gpsOrigin, gpsPose) : null;
  const lidar: Record<string, number> = {
    // The lidar sits 0.15 m ahead of the reference point and localises a little noisier.
    x: r3(fusion.x + 0.15 * cos + noise(site.noiseSeed, t, 3) * 0.02),
    y: r3(fusion.y + 0.15 * sin + noise(site.noiseSeed, t, 4) * 0.02),
    ...(omits.has("poseYaw") ? {} : { yaw: r3(fusion.yaw + noise(site.noiseSeed, t, 5) * 0.004) }),
  };
  const task = taskOf(state, site);
  return {
    stamp: t + skew,
    scene_id: state.away && site.night ? site.night.sceneId : site.sceneId,
    ...(gps
      ? {
          gps: omits.has("gpsHeading") ? { lat: gps.lat, lng: gps.lng } : gps,
        }
      : {}),
    ...(site.persona.poseless || omits.has("fusionLoc")
      ? {}
      : {
          fusion_loc: {
            x: r3(fusion.x),
            y: r3(fusion.y),
            ...(omits.has("poseYaw") ? {} : { yaw: r3(fusion.yaw) }),
          },
        }),
    ...(site.persona.poseless ? {} : { lidar_loc: lidar }),
    vehicle_info: {
      control_mode: state.estop ? 3 : state.teleopUntil ? 2 : parkedOrCharging ? 0 : 1,
      ...(omits.has("gear")
        ? {}
        : { gear: parkedOrCharging ? 2 : state.speed < -0.02 ? -1 : moving ? 1 : 0 }),
      speed: r3(state.speed),
      ...(omits.has("omega") ? {} : { omega: r3(Math.max(-0.8, Math.min(0.8, yawRate))) }),
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
    task: task ? vendorTask(task, site, state, skew) : null,
    info_code: code(state.info),
    warning_code: code(state.warning),
    error_code: code(state.error),
    ...(omits.has("speedLimit")
      ? {}
      : {
          speed_limit: {
            limit: limit.limit,
            slowdown_time: limit.slowdown,
            stamp: state.limitSince + skew,
            module_name: limit.module,
          },
        }),
    // A vendor with its own alarm list always sends it; any other only while one was injected.
    ...(site.vendor.alarms || state.alarms?.length
      ? { alarmList: alarmList(site, state, skew) }
      : {}),
  };
};

/** The dispatcher's task as this vendor's firmware passes it on. */
const vendorTask = (
  task: Record<string, unknown>,
  site: Site,
  state: VehicleState,
  skew: number,
): Record<string, unknown> => {
  const stamped: Record<string, unknown> = {
    ...task,
    started_at: (task.started_at as number) + skew,
  };
  if (site.vendor.task === "brief") {
    return { id: task.id, to: task.to, step_name: task.step_name };
  }
  if (site.vendor.task === "untyped") delete stamped.type;
  if (site.vendor.stepOverrun && state.phase === "complete" && site.profile.carries) {
    stamped.step = (task.steps as number) + 1;
  }
  return stamped;
};
