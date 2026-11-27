import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadFleet, newState, type Fleet } from "../sim/fleet";
import { CAMPUS_ANCHOR, sceneGpsOrigin } from "../sim/routes";
import { BackfillSink } from "../sim/sink";
import { INJECTION_KINDS, step, type VehicleState } from "../sim/vehicle";
import { findScenario, SCENARIOS } from "../sim/scenarios";
import { formatCoverage, measureCoverage } from "../sim/coverage";
import { peopleActivity, readStory, writePeopleActivity, writeStory } from "../sim/people";
import { AUDIT_ACTIONS } from "@navfleet/shared";
import { mqttTelemetrySchema } from "../src/validation";
import { normalizeDevice } from "../src/normalize";
import type { DeviceAlert } from "../src/types";

/**
 * The demo simulator's contract. The history backfill and the live publisher compute the same
 * timeline independently, from a checkpoint, so everything rests on determinism: the same state
 * stepped through the same seconds must give the same states and frames, whether or not frames
 * were built, and whether the run was split at a checkpoint or not. If that breaks, the stored
 * history and what goes live stop meeting at the seam.
 */

const CONFIG_ROOT = path.resolve(__dirname, "../../config-runtime");
const START = Date.parse("2026-09-01T00:00:00Z");

let cached: Fleet | null = null;
const fleet = async (): Promise<Fleet> => (cached ??= await loadFleet(CONFIG_ROOT));

const clone = (state: VehicleState): VehicleState =>
  JSON.parse(JSON.stringify(state)) as VehicleState;

const codesOf = (state: VehicleState): number[] =>
  [state.info?.code, state.warning?.code, state.error?.code].filter(
    (code): code is number => typeof code === "number",
  );

const run = async (seconds: number, deviceIndex: number, withFrame = true) => {
  const f = await fleet();
  const site = f.sites[deviceIndex]!;
  const state = newState(f, site, START);
  const frames: string[] = [];
  for (let k = 0; k < seconds; k += 1) {
    const { frame } = step(site, state, [], withFrame);
    if (frame) frames.push(JSON.stringify(frame));
  }
  return { site, state, frames };
};

describe("simulator determinism", () => {
  it("resuming from a checkpoint continues the same timeline", async () => {
    const f = await fleet();
    const site = f.sites[3]!;
    const continuous = newState(f, site, START);
    const split = newState(f, site, START);
    const a: string[] = [];
    const b: string[] = [];
    for (let k = 0; k < 4 * 3600; k += 1) {
      const frame = step(site, continuous).frame;
      if (frame) a.push(JSON.stringify(frame));
    }
    for (let k = 0; k < 2 * 3600; k += 1) step(site, split);
    // A checkpoint is the state serialised and read back.
    const resumed = clone(split);
    for (let k = 0; k < 2 * 3600; k += 1) {
      const frame = step(site, resumed).frame;
      if (frame) b.push(JSON.stringify(frame));
    }
    expect(resumed).toEqual(continuous);
    expect(b).toEqual(a.slice(-b.length));
  });

  it("skipping frames (fast-forward) does not change the timeline", async () => {
    const withFrames = await run(3 * 3600, 10, true);
    const without = await run(3 * 3600, 10, false);
    expect(without.state).toEqual(withFrames.state);
    expect(without.frames).toEqual([]);
  });
});

describe("simulator frames", () => {
  it("speak the vehicle protocol the backend ingests, with pose, scene and codes", async () => {
    const { site, frames } = await run(600, 0);
    expect(frames.length).toBeGreaterThan(500);
    const frame = JSON.parse(frames.at(-1)!) as Record<string, unknown>;
    expect(mqttTelemetrySchema.safeParse(frame).success).toBe(true);
    const snapshot = normalizeDevice({ ...frame, deviceId: site.deviceId });
    expect(snapshot.sceneId).toBe(site.sceneId);
    expect(Number.isFinite(snapshot.fusionLoc.x)).toBe(true);
    expect(Number.isFinite(snapshot.lidarLoc.x)).toBe(true);
    expect(Number.isFinite(snapshot.vehicleInfo.soc)).toBe(true);
    expect(snapshot.gps.lat === null).toBe(site.gps === null);
  });

  it("stamp a report code with when it began, not with every frame", async () => {
    const f = await fleet();
    const site = f.sites[0]!;
    const state = newState(f, site, START);
    step(site, state, [{ deviceId: site.deviceId, at: START, kind: "estop", minutes: 2 }]);
    const later = step(site, state).frame!;
    expect(later.error_code).toMatchObject({ code: 5701, stamp: START });
    expect((later.vehicle_info as { control_mode: number }).control_mode).toBe(3);
  });

  it("an injected fault ends, and the vehicle carries on", async () => {
    const f = await fleet();
    const site = f.sites[12]!;
    const state = newState(f, site, START);
    step(site, state, [{ deviceId: site.deviceId, at: START, kind: "obstacle", minutes: 1 }]);
    for (let k = 0; k < 120; k += 1) step(site, state);
    expect(state.error?.code).not.toBe(5703);
  });

  it("a comm loss goes quiet, reports offline after the broker's keepalive, and comes back", async () => {
    const f = await fleet();
    const site = f.sites[5]!;
    const state = newState(f, site, START);
    const results = [
      step(site, state, [{ deviceId: site.deviceId, at: START, kind: "comm-loss", minutes: 2 }]),
    ];
    for (let k = 0; k < 180; k += 1) results.push(step(site, state));
    const statuses = results.map((result) => result.status).filter((value) => value !== null);
    expect(statuses).toEqual([false, true]);
    expect(results.slice(1, 100).every((result) => result.frame === null)).toBe(true);
    expect(results.at(-1)?.frame).not.toBeNull();
  });
});

describe("simulator layout", () => {
  /** A copy of config-runtime with vehicles.json / scenes.json rewritten by `edit`. */
  const editedConfig = (edit: (file: string, items: unknown[]) => unknown[]): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sim-layout-"));
    fs.cpSync(CONFIG_ROOT, root, { recursive: true });
    for (const file of ["vehicles.json", "scenes.json"]) {
      const full = path.join(root, file);
      const items = JSON.parse(fs.readFileSync(full, "utf8")) as unknown[];
      fs.writeFileSync(full, JSON.stringify(edit(file, items)));
    }
    return root;
  };
  const layout = (f: Fleet) =>
    new Map(
      f.sites.map((site) => [
        site.deviceId,
        {
          gps: site.gps,
          start: site.route.pose(0),
          charger: site.charger,
          length: site.route.length,
        },
      ]),
    );

  it("does not move a vehicle when the editors reorder vehicles.json or scenes.json", async () => {
    // The scene editor rewrites scenes.json sorted with the edited scene last, and deleting a
    // vehicle shifts the ones after it. Both used to move vehicles: GPS by scene position (3 km),
    // loop start and charger by roster position.
    const before = layout(await fleet());
    const root = editedConfig((_file, items) => [...items].reverse());
    try {
      expect(layout(await loadFleet(root))).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not move the others when one vehicle is removed", async () => {
    const before = layout(await fleet());
    const removed = (await fleet()).sites[0]!.deviceId;
    const root = editedConfig((file, items) =>
      file === "vehicles.json"
        ? items.filter((item) => (item as { deviceId: string }).deviceId !== removed)
        : items,
    );
    try {
      const after = layout(await loadFleet(root));
      const moved = [...after].filter(
        ([id, place]) => JSON.stringify(place) !== JSON.stringify(before.get(id)),
      );
      // At most the one vehicle that had been pushed to the next slot by the removed one.
      expect(moved.length).toBeLessThanOrEqual(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts each scene at its own place on the globe", () => {
    const scenes = JSON.parse(
      fs.readFileSync(path.join(CONFIG_ROOT, "scenes.json"), "utf8"),
    ) as Array<{
      sceneId: string;
      osmProjectionOrigin?: { lat: number; lng: number };
    }>;
    const origins = scenes.map((scene) => sceneGpsOrigin(scene.sceneId, scene));
    // Each site its own place, except the two maps of one building (装配一车间).
    expect(new Set(origins.map((point) => `${point.x},${point.y}`)).size).toBe(scenes.length - 1);
    // A road network's vehicles report the latitude/longitude its own nodes carry.
    const kangcheng = scenes.find((scene) => scene.sceneId === "kangcheng-airy")!;
    expect(sceneGpsOrigin("kangcheng-airy", kangcheng)).toEqual({
      y: kangcheng.osmProjectionOrigin!.lat,
      x: kangcheng.osmProjectionOrigin!.lng,
    });
    // The campus anchor the other sites hang off is that network's origin.
    expect(CAMPUS_ANCHOR).toEqual(sceneGpsOrigin("kangcheng-airy", kangcheng));
    // An unknown scene still gets a stable place of its own.
    expect(sceneGpsOrigin("new-site")).toEqual(sceneGpsOrigin("new-site"));
  });

  it("drives a vehicle without a scene on GPS alone, along the campus fence", async () => {
    const patrol = (await fleet()).sites.find((site) => !site.sceneId)!;
    expect(patrol.gps).toEqual(CAMPUS_ANCHOR);
    expect(patrol.route.length).toBeGreaterThan(1000);
  });

  it("reads a hand-authored loop in map metres whatever the scene's yaw", async () => {
    // At yaw 0 the loop used to be taken as world coordinates, so a scene whose origin is not 0
    // (the point cloud's corner, or assembly-line set to yaw 0) put the loop off its map.
    const rotated = (await fleet()).sites.find((site) => site.sceneId === "assembly-line")!;
    const root = editedConfig((file, items) =>
      file === "scenes.json"
        ? items.map((item) =>
            (item as { sceneId: string }).sceneId === "assembly-line"
              ? { ...(item as object), origin: { x: 20.41, y: 0, yaw: 0 } }
              : item,
          )
        : items,
    );
    try {
      const flat = (await loadFleet(root)).sites.find(
        (site) => site.deviceId === rotated.deviceId,
      )!;
      // The first authored corner (9, 25.5) lands at origin + corner, not at (9, 25.5).
      const corner = flat.route.pose(0);
      expect(corner.x).toBeCloseTo(20.41 + 9, 1);
      expect(corner.y).toBeCloseTo(25.5, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("simulator events", () => {
  it("starts an obstacle, a guard stop, a planning timeout or a speed zone only on a moving vehicle", async () => {
    const f = await fleet();
    const MOVING_ONLY = new Set([5703, 5702, 5102, 2203]);
    let started = 0;
    // The whole fleet over five days: these events are rare, a few per vehicle-week.
    for (const site of f.sites) {
      const state = newState(f, site, START);
      for (let k = 0; k < 5 * 86_400; k += 1) {
        const before = { phase: state.phase, speed: state.speed, codes: codesOf(state) };
        step(site, state, [], false);
        for (const code of codesOf(state)) {
          if (!MOVING_ONLY.has(code) || before.codes.includes(code)) continue;
          started += 1;
          expect(["toPick", "toDrop", "toCharger"], `${site.deviceId} ${code}`).toContain(
            before.phase,
          );
          expect(before.speed, `${site.deviceId} ${code}`).toBeGreaterThan(0.2);
        }
      }
    }
    expect(started).toBeGreaterThan(0);
  }, 60_000);

  it("never drives faster than the speed limit it reports, once the slowdown has passed", async () => {
    // Localisation degraded used to scale cruise by 0.6 only: a tug ran ~0.96 m/s under the
    // navigation limit of 0.8 it reported in the same frame.
    const f = await fleet();
    let checked = 0;
    for (const site of f.sites) {
      const state = newState(f, site, START);
      // Degraded for the whole run (what a 2101 sets), from a standing start.
      state.degradedUntil = START + 3_600_000;
      for (let k = 0; k < 1800; k += 1) {
        const { frame } = step(site, state);
        const limit = frame?.speed_limit as
          { limit: number; slowdown_time: number; stamp: number; module_name: string } | undefined;
        if (!frame || limit?.module_name !== "navigation") continue;
        if (state.t - limit.stamp < (limit.slowdown_time + 2) * 1000) continue;
        checked += 1;
        const speed = (frame.vehicle_info as { speed: number }).speed;
        expect(speed, site.deviceId).toBeLessThanOrEqual(limit.limit + 1e-6);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("backfill sink alert occurrences", () => {
  // The sink replays Persistence.upsertAlerts in memory. One occurrence per firing: an alert
  // still in the set keeps its occurrence, one that leaves the set closes at the store's clock.
  const alert = (id: string, ts: string): DeviceAlert => ({
    id,
    title: "告警报码",
    detail: "",
    severity: "critical",
    source: "error_code",
    ts,
    active: true,
    code: 5202,
    info: "",
  });

  it("opens, keeps and closes occurrences like the live write path", async () => {
    const sink = new BackfillSink(new Set(["agv-1"]), {
      config: { channels: [], groups: {} },
      device: (deviceId) => ({ deviceId, tags: [], formationIds: [] }),
    });
    const onset = "2026-09-01T00:00:00.000Z";
    await sink.upsertAlerts("agv-1", [alert("agv-1-error-code-5202", onset)], new Date(onset));
    await sink.upsertAlerts(
      "agv-1",
      [alert("agv-1-error-code-5202", onset)],
      new Date("2026-09-01T00:01:00Z"),
    );
    const cleared = new Date("2026-09-01T00:05:00Z");
    await sink.upsertAlerts("agv-1", [], cleared);
    // A second firing of the same code is a new occurrence.
    await sink.upsertAlerts(
      "agv-1",
      [alert("agv-1-error-code-5202", "2026-09-01T01:00:00.000Z")],
      new Date(),
    );

    const closed = (sink as unknown as { closed: Array<Record<string, unknown>> }).closed;
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      eventKey: "agv-1:agv-1-error-code-5202",
      active: false,
      firstSeenAt: new Date(onset),
      clearedAt: cleared,
    });
    expect(sink.stats).toMatchObject({ closed: 1 });
  });
});

describe("backfill sink telemetry", () => {
  it("marks summarised hours stale when it writes frames into them, like Persistence", async () => {
    const calls: Array<{ collection: string; op: string; arg: unknown }> = [];
    const db = {
      collection: (collection: string) => ({
        insertMany: async (docs: unknown) =>
          calls.push({ collection, op: "insertMany", arg: docs }),
        deleteMany: async (filter: unknown) =>
          calls.push({ collection, op: "deleteMany", arg: filter }),
      }),
    };
    const sink = new BackfillSink(new Set(["agv-1"]), {
      config: { channels: [], groups: {} },
      device: (deviceId) => ({ deviceId, tags: [], formationIds: [] }),
    });
    (sink as unknown as { db: unknown }).db = db;
    // Two frames an hour apart, both in hours that have ended.
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000;
    const { frames } = await run(1, 0);
    const frame = JSON.parse(frames[0]!) as Record<string, unknown>;
    const snapshot = normalizeDevice({ ...frame, deviceId: "agv-1" });
    for (const at of [hour + 1_000, hour + 3_601_000]) {
      await sink.writeTelemetry({ ...snapshot, stamp: new Date(at).toISOString() });
    }
    await (sink as unknown as { flushTelemetry: () => Promise<void> }).flushTelemetry();

    expect(calls.map((call) => `${call.collection}.${call.op}`)).toEqual([
      "telemetry_ts.insertMany",
      "telemetry_hourly_runs.deleteMany",
    ]);
    const filter = calls[1]!.arg as { hour: { $in: Date[] } };
    expect(filter.hour.$in).toHaveLength(2);
  });
});

describe("simulator tasks", () => {
  /** Every distinct task a vehicle reports over a stretch, with the frames that carried it. */
  const tasksOver = async (seconds: number, deviceIndex: number) => {
    const { site, frames } = await run(seconds, deviceIndex);
    const byId = new Map<string, Record<string, unknown>[]>();
    let withoutTask = 0;
    for (const raw of frames) {
      const task = (JSON.parse(raw) as { task: Record<string, unknown> | null }).task;
      if (!task) {
        withoutTask += 1;
        continue;
      }
      const list = byId.get(String(task.id)) ?? [];
      list.push(task);
      byId.set(String(task.id), list);
    }
    return { site, byId, withoutTask };
  };

  it("reports the task it is on, one id per task, its step never past the total", async () => {
    const f = await fleet();
    const carrier = f.sites.findIndex((site) => site.profile.carries);
    const { byId } = await tasksOver(6 * 3600, carrier);
    expect(byId.size).toBeGreaterThan(1);
    for (const [id, frames] of byId) {
      expect(id).toMatch(/^.+-\d{8}-\d{4}$/);
      // One task keeps one start time and one type for its whole life.
      expect(new Set(frames.map((task) => task.started_at)).size).toBe(1);
      expect(new Set(frames.map((task) => task.type)).size).toBe(1);
      for (const task of frames) {
        expect(task.step as number).toBeLessThanOrEqual(task.steps as number);
        expect(typeof task.step_name).toBe("string");
      }
    }
    // Ids count up per vehicle.
    const seqs = [...byId.keys()].map((id) => Number(id.slice(-4)));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("walks a patrol through its stops as one task, and goes back to no task between rounds", async () => {
    const f = await fleet();
    const patrol = f.sites.findIndex((site) => !site.profile.carries);
    const { byId, withoutTask } = await tasksOver(6 * 3600, patrol);
    const work = [...byId.values()].find((frames) => frames[0]!.type !== "充电")!;
    const steps = new Set(work.map((task) => task.step));
    expect(steps.size).toBeGreaterThan(1);
    expect(withoutTask).toBeGreaterThan(0);
  });

  it("lands in the snapshot read-only, the same task across frames", async () => {
    const f = await fleet();
    const carrier = f.sites.findIndex((site) => site.profile.carries);
    const { site, frames } = await run(3 * 3600, carrier);
    const frame = frames
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((candidate) => candidate.task);
    expect(frame).toBeDefined();
    const snapshot = normalizeDevice({ ...frame!, deviceId: site.deviceId });
    expect(snapshot.task?.id).toBe((frame!.task as { id: string }).id);
    expect(snapshot.task?.startedAt).toMatch(/Z$/);
  });

  it("loads a checkpoint written before tasks existed, and numbers the next task", async () => {
    const f = await fleet();
    const site = f.sites[0]!;
    const state = newState(f, site, START);
    const legacy = clone(state) as Partial<VehicleState>;
    delete legacy.taskKind;
    delete legacy.taskId;
    delete legacy.taskStartedAt;
    delete legacy.taskSeq;
    const resumed = legacy as VehicleState;
    let first: Record<string, unknown> | null = null;
    for (let k = 0; k < 6 * 3600 && !first; k += 1) {
      const frame = step(site, resumed).frame as { task?: Record<string, unknown> | null } | null;
      first = frame?.task ?? null;
    }
    expect(String(first?.id)).toMatch(/-0001$/);
  });
});

describe("simulator vendors and site behaviour", () => {
  const siteOf = async (deviceId: string) => {
    const f = await fleet();
    const site = f.sites.find((candidate) => candidate.deviceId === deviceId);
    if (!site) throw new Error(`no site ${deviceId}`);
    return { f, site };
  };
  /** Frames over `seconds` from the start, parsed. */
  const framesOf = async (deviceId: string, seconds: number, from = START) => {
    const { f, site } = await siteOf(deviceId);
    const state = newState(f, site, from);
    const frames: Array<Record<string, unknown>> = [];
    const late: Array<Record<string, unknown>> = [];
    for (let k = 0; k < seconds; k += 1) {
      const result = step(site, state);
      if (result.frame) frames.push(result.frame);
      if (result.lateFrame) late.push(result.lateFrame);
    }
    return { site, state, frames, late };
  };
  const vehicleInfo = (frame: Record<string, unknown>) =>
    frame.vehicle_info as Record<string, unknown>;

  it("sends only what each vendor's firmware sends", async () => {
    // 快仓: no angular velocity.
    const kuai = (await framesOf("agv-w04", 120)).frames.at(-1)!;
    expect(vehicleInfo(kuai)).not.toHaveProperty("omega");
    expect(vehicleInfo(kuai)).toHaveProperty("gear");
    // 极智嘉: lidar pose only, no gear.
    const geek = (await framesOf("agv-p01", 120)).frames.at(-1)!;
    expect(geek).not.toHaveProperty("fusion_loc");
    expect(geek).toHaveProperty("lidar_loc");
    expect(vehicleInfo(geek)).not.toHaveProperty("gear");
    // 未来机器人: no speed-limit block, poses without a heading.
    const future = (await framesOf("agv-p04", 120)).frames.at(-1)!;
    expect(future).not.toHaveProperty("speed_limit");
    expect(future.lidar_loc).not.toHaveProperty("yaw");
    expect(future.fusion_loc).not.toHaveProperty("yaw");
    // 亿嘉和: a GNSS fix without heading.
    const yijiahe = (await framesOf("agv-a04", 120)).frames.at(-1)!;
    expect(yijiahe.gps).toMatchObject({ lat: expect.any(Number) as number });
    expect(yijiahe.gps).not.toHaveProperty("heading");
    // The snapshot shows the missing fields as missing — and a lidar-only vehicle's fused pose
    // follows its lidar pose rather than standing where the first frame put it.
    const snapshot = normalizeDevice({ ...kuai, deviceId: "agv-w04" });
    expect(snapshot.vehicleInfo.omega).toBeNull();
    const geekFrames = (await framesOf("agv-p01", 3600)).frames.filter(
      (frame) => (vehicleInfo(frame).speed as number) > 0.3,
    );
    const firstSeen = normalizeDevice({ ...geekFrames[0]!, deviceId: "agv-p01" });
    const lastSeen = normalizeDevice({ ...geekFrames.at(-1)!, deviceId: "agv-p01" }, firstSeen);
    expect(lastSeen.fusionLoc).toEqual(lastSeen.lidarLoc);
    expect(lastSeen.fusionLoc).not.toEqual(firstSeen.fusionLoc);
  });

  it("passes the task on as each firmware does: untyped, brief, or with the step past the total", async () => {
    const tasks = async (deviceId: string) =>
      (await framesOf(deviceId, 8 * 3600)).frames
        .map((frame) => frame.task as Record<string, unknown> | null)
        .filter((task): task is Record<string, unknown> => !!task);
    expect((await tasks("agv-w01")).every((task) => !("type" in task))).toBe(true);
    expect((await tasks("agv-p01")).some((task) => task.type === "配料")).toBe(true);
    const brief = await tasks("agv-p03");
    expect(brief.length).toBeGreaterThan(0);
    expect(brief.every((task) => !("steps" in task) && !("started_at" in task))).toBe(true);
    // 斯坦德 counts the completed step past the total; the platform clamps it on the way in.
    const overrun = (await tasks("agv-w04")).length; // 快仓: never overruns
    const stander = await tasks("agv-r01");
    expect(overrun).toBeGreaterThan(0);
    const past = stander.find((task) => (task.step as number) > (task.steps as number));
    expect(past).toBeDefined();
    const clamped = normalizeDevice({ task: past, deviceId: "agv-r01", stamp: START });
    expect(clamped.task!.step).toBe(clamped.task!.steps);
  });

  it("stamps a vehicle with an unsynchronised clock ahead of real time", async () => {
    const { frames } = await framesOf("agv-p03", 30);
    const frame = frames.at(-1)!;
    expect((frame.stamp as number) - (START + 29_000)).toBe(125_000);
  });

  it("reports GPS alone for the perimeter patrol, and a fix the platform hides for the cold-store carrier", async () => {
    const patrol = (await framesOf("agv-s01", 60)).frames.at(-1)!;
    expect(patrol).not.toHaveProperty("fusion_loc");
    expect(patrol).not.toHaveProperty("lidar_loc");
    expect(patrol.gps).toBeDefined();
    expect(patrol.scene_id).toBe("");
    const cold = (await framesOf("agv-c01", 60)).frames.at(-1)!;
    expect(cold.gps).toBeDefined();
  });

  it("flushes a buffered frame late on a weak link, which the platform refuses as out of order", async () => {
    const { site, f } = await siteOf("agv-a08");
    const state = newState(f, site, START);
    step(site, state, [{ deviceId: site.deviceId, at: START, kind: "speed-zone", minutes: 1 }]);
    // Degrade the link for long enough to cross a flush second.
    state.warning = { code: 2601, since: START, until: START + 120_000 };
    let late: Record<string, unknown> | undefined;
    let current: Record<string, unknown> | undefined;
    for (let k = 0; k < 60 && !late; k += 1) {
      const result = step(site, state);
      late = result.lateFrame;
      current = result.frame ?? undefined;
    }
    expect(late).toBeDefined();
    expect((late!.stamp as number) < (current!.stamp as number)).toBe(true);
  });

  it("leaves the spare in storage out, and switches the visiting test vehicle on only in its hours", async () => {
    const f = await fleet();
    expect(f.sites.some((site) => site.deviceId === "agv-y09")).toBe(false);
    const visitor = f.sites.find((site) => site.visitor)!;
    expect(visitor.deviceId).toBe("seer-test-07");
    // Tuesday 2026-09-01 15:00 local (07:00Z) is in its hours; 06:00Z (14:00 local) the start.
    const on = Date.parse("2026-09-01T07:00:00Z");
    const off = Date.parse("2026-09-01T12:00:00Z");
    const state = newState(f, visitor, on);
    const onFrame = step(visitor, state).frame!;
    // It reports the vendor's own lab map, which the site's scene catalogue does not have.
    expect(onFrame.scene_id).toBe("seer-lab-03");
    expect(onFrame).not.toHaveProperty("vehicle_info");
    expect(onFrame).not.toHaveProperty("fusion_loc");
    expect(Array.isArray(onFrame.alarmList)).toBe(true);
    const later = newState(f, visitor, off);
    later.online = true;
    const result = step(visitor, later);
    expect(result.frame).toBeNull();
    expect(result.status).toBe(false);
  });

  it("takes the occasional night round in another scene, and comes back", async () => {
    const { site, f } = await siteOf("agv-a06");
    const state = newState(f, site, START);
    const scenes = new Set<string>();
    for (let k = 0; k < 5 * 86_400; k += 1) {
      const { frame } = step(site, state, [], k % 60 === 0);
      if (frame) scenes.add(frame.scene_id as string);
    }
    expect(scenes).toEqual(new Set(["kangcheng-airy", "yard-north"]));
  }, 60_000);

  it("reports a vendor's own alarm list next to the codes, in its own severity words", async () => {
    const { site, f } = await siteOf("agv-y02");
    const state = newState(f, site, START);
    state.soc = 11;
    state.phase = "toPick";
    state.target = site.pick;
    const { frame } = step(site, state);
    const alarms = frame!.alarmList as Array<Record<string, unknown>>;
    expect(alarms.map((alarm) => alarm.code)).toContain(52301);
    const snapshot = normalizeDevice({ ...frame!, deviceId: site.deviceId });
    const vendor = snapshot.alerts.find((alert) => alert.source === "device-alert");
    expect(vendor).toMatchObject({ title: "电量低", severity: "notice" });
  });
});

describe("backfill sink outbound policy", () => {
  /** A sink with a fake db, the given channels, every endpoint env set. */
  const sinkWith = (channels: unknown[]) => {
    for (const env of ["SINK_TEST_A_URL", "SINK_TEST_B_URL"]) process.env[env] = "http://receiver";
    const sink = new BackfillSink(new Set(["agv-1"]), {
      config: { channels, groups: {} } as never,
      device: (deviceId) => ({ deviceId, tags: [], formationIds: [] }),
    });
    const sends = () =>
      (sink as unknown as { sends: Array<Record<string, unknown>> }).sends.map((send) => ({
        channelId: send.channelId,
        title: send.title,
        status: send.status,
      }));
    return { sink, sends };
  };
  const occurrence = (id: string, severity: "critical" | "warning", ts: string): DeviceAlert => ({
    id,
    title: severity === "critical" ? "告警报码" : "预警报码",
    detail: "",
    severity,
    source: severity === "critical" ? "error_code" : "warning_code",
    ts,
    active: true,
    code: severity === "critical" ? 5701 : 2101,
    info: "",
  });

  it("holds digested severities for the channel's flush, and sends one summary", async () => {
    const { sink, sends } = sinkWith([
      {
        id: "mail",
        type: "webhook",
        enabled: true,
        urlEnv: "SINK_TEST_A_URL",
        severities: ["critical", "warning"],
        digestSeconds: 900,
        digestSeverities: ["warning"],
      },
    ]);
    const t0 = Date.parse("2026-09-01T02:00:00Z");
    await sink.upsertAlerts(
      "agv-1",
      [
        occurrence("a", "warning", new Date(t0).toISOString()),
        occurrence("b", "warning", new Date(t0 + 60_000).toISOString()),
        occurrence("c", "critical", new Date(t0 + 120_000).toISOString()),
      ],
      new Date(t0 + 120_000),
    );
    // The critical goes at once; the warnings wait.
    expect(sends().map((send) => send.title)).toEqual(["告警报码"]);
    sink.tickNotify(t0 + 10 * 60_000);
    expect(sends()).toHaveLength(1);
    sink.tickNotify(t0 + 16 * 60_000);
    expect(sends().map((send) => send.title)).toEqual(["告警报码", "2 条消息汇总"]);
  });

  it("escalates a critical nobody attended to, and not one that was claimed or cleared", async () => {
    const { sink, sends } = sinkWith([
      {
        id: "first",
        type: "webhook",
        enabled: true,
        urlEnv: "SINK_TEST_A_URL",
        severities: ["critical"],
        escalation: { afterSeconds: 600, channelId: "second" },
      },
      { id: "second", type: "webhook", enabled: true, urlEnv: "SINK_TEST_B_URL", severities: [] },
    ]);
    const t0 = Date.parse("2026-09-01T02:00:00Z");
    await sink.upsertAlerts(
      "agv-1",
      [
        occurrence("left-alone", "critical", new Date(t0).toISOString()),
        occurrence("cleared", "critical", new Date(t0).toISOString()),
      ],
      new Date(t0),
    );
    // One clears before the escalation is due.
    await sink.upsertAlerts(
      "agv-1",
      [occurrence("left-alone", "critical", new Date(t0).toISOString())],
      new Date(t0 + 5 * 60_000),
    );
    sink.tickNotify(t0 + 11 * 60_000);
    const escalated = sends().filter((send) => send.channelId === "second");
    expect(escalated.map((send) => send.title)).toEqual(["【升级】告警报码"]);
  });

  it("does not re-send the same occurrence inside the channel's re-notify window", async () => {
    const { sink, sends } = sinkWith([
      {
        id: "robot",
        type: "dingtalk",
        enabled: true,
        urlEnv: "SINK_TEST_A_URL",
        severities: ["warning"],
        renotifySeconds: 600,
      },
    ]);
    const t0 = Date.parse("2026-09-01T02:00:00Z");
    const at = (ms: number) => new Date(ms).toISOString();
    // The same alert id fires, clears and fires again two minutes later.
    await sink.upsertAlerts("agv-1", [occurrence("flap", "warning", at(t0))], new Date(t0));
    await sink.upsertAlerts("agv-1", [], new Date(t0 + 60_000));
    await sink.upsertAlerts(
      "agv-1",
      [occurrence("flap", "warning", at(t0 + 120_000))],
      new Date(t0 + 120_000),
    );
    expect(sends()).toHaveLength(1);
  });
});

describe("simulator drills", () => {
  /** Every vehicle's platform alerts one second after the drill's injections, from its frame. */
  const afterDrill = async (name: string, target = "") => {
    const f = await fleet();
    const scenario = findScenario(name)!;
    const steps = scenario.steps(f, target || scenario.target?.default || "");
    // A weekday afternoon, with every vehicle well into its day.
    const at = Date.parse("2026-09-02T06:00:00Z");
    const alerts = new Map<string, DeviceAlert[]>();
    for (const site of f.sites) {
      const state = newState(f, site, at - 3600_000);
      while (state.t < at) step(site, state, [], false);
      const injections = steps
        .filter((entry) => entry.deviceId === site.deviceId)
        .map((entry) => ({
          deviceId: site.deviceId,
          at,
          kind: entry.kind,
          minutes: entry.minutes,
        }));
      step(site, state, injections);
      const { frame } = step(site, state);
      if (frame)
        alerts.set(site.deviceId, normalizeDevice({ ...frame, deviceId: site.deviceId }).alerts);
    }
    return { steps, alerts };
  };

  it("fire-drill puts more than 99 messages on the fleet, four or more on every vehicle", async () => {
    const { alerts } = await afterDrill("fire-drill");
    const counts = [...alerts.entries()]
      .filter(([deviceId]) => deviceId !== "seer-test-07")
      .map(([, list]) => list.length);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBeGreaterThan(99);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(4);
    // The controller's own alarm list carries the interlock.
    const y01 = alerts.get("agv-y01")!;
    expect(y01.map((alert) => alert.title)).toContain("安全回路断开");
  }, 60_000);

  it("cascade gives one vehicle six messages at once", async () => {
    const { alerts } = await afterDrill("cascade");
    expect(alerts.get("agv-y02")!.length).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it("ap-restart takes every vehicle of the scene off the link at once", async () => {
    const { steps } = await afterDrill("ap-restart");
    const f = await fleet();
    const inScene = f.sites.filter((site) => site.sceneId === "kangcheng-airy").length;
    expect(steps).toHaveLength(inScene);
    expect(new Set(steps.map((entry) => entry.kind))).toEqual(new Set(["comm-loss"]));
  }, 60_000);

  it("names every drill's injections with kinds the live publisher accepts", async () => {
    const f = await fleet();
    for (const scenario of SCENARIOS) {
      for (const entry of scenario.steps(f, scenario.target?.default ?? "")) {
        expect(INJECTION_KINDS, `${scenario.name}`).toContain(entry.kind);
        expect(f.sites.some((site) => site.deviceId === entry.deviceId)).toBe(true);
      }
    }
  });
});

describe("simulator coverage report", () => {
  it("runs the timeline offline and lists the drills for what it cannot reach", async () => {
    const report = await measureCoverage(CONFIG_ROOT, 0.5);
    const staged = report.items.filter((item) => item.via);
    expect(staged.map((item) => item.via)).toContain("sim scenario fire-drill");
    // Half a day already reaches the everyday states: codes, enum values, the vendors' omissions.
    expect(report.items.find((item) => item.label === "不报角速度")!.count).toBeGreaterThan(0);
    expect(formatCoverage(report)).toMatch(/出现 \d+ 项/);
  }, 120_000);
});

describe("people activity", () => {
  const anchor = Date.parse("2026-10-29T00:00:00Z");
  const now = anchor + 30 * 86_400_000;
  const storyDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-story-"));
    writeStory(dir, { anchor, span: now - anchor, writtenUntil: anchor });
    return dir;
  };
  const collect = () => {
    const written: Array<{ action: string; actor: string; ts: Date; detail?: unknown }> = [];
    return {
      written,
      db: {
        insertMany: (entries: typeof written) => {
          written.push(...entries);
          return Promise.resolve();
        },
      },
    };
  };

  it("writes the same trail in pieces as in one go, and never a stretch twice", async () => {
    const dir = storyDir();
    const { written, db } = collect();
    await writePeopleActivity(dir, anchor + 9 * 86_400_000, db);
    await writePeopleActivity(dir, anchor + 9 * 86_400_000, db);
    for (let hour = 0; hour < 48; hour += 1) {
      await writePeopleActivity(dir, now - 48 * 3_600_000 + hour * 3_600_000, db);
    }
    const whole = peopleActivity(anchor, now - 3_600_000, readStory(dir));
    expect(JSON.stringify(written)).toBe(JSON.stringify(whole));
  });

  it("covers every audit action a person takes, the once-only events exactly once", async () => {
    const dir = storyDir();
    const { written, db } = collect();
    await writePeopleActivity(dir, now, db);
    const actions = new Set(written.map((entry) => entry.action));
    const byMessages = new Set(["alert_claim", "alert_release", "alert_ignore", "alert_unignore"]);
    const legacy = new Set(["alert_ack", "alert_unack"]);
    expect(
      AUDIT_ACTIONS.filter(
        (action) => !actions.has(action) && !byMessages.has(action) && !legacy.has(action),
      ),
    ).toEqual([]);
    expect(written.filter((entry) => entry.action === "force_logout")).toHaveLength(1);
    // The stranger trying the shift lead's account, from outside the office.
    expect(
      written.filter(
        (entry) =>
          entry.actor === "zhaoyun" &&
          entry.action === "login_failed" &&
          (entry.detail as { ip?: string }).ip === "172.31.20.5",
      ),
    ).toHaveLength(2);
  });

  it("writes nothing without a story (a state from before it existed)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-story-"));
    const { written, db } = collect();
    expect(await writePeopleActivity(dir, now, db)).toBe(0);
    expect(written).toHaveLength(0);
  });
});
