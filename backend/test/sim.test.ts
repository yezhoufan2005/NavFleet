import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadFleet, newState, type Fleet } from "../sim/fleet";
import { sceneGpsOrigin } from "../sim/routes";
import { BackfillSink } from "../sim/sink";
import { step, type VehicleState } from "../sim/vehicle";
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
    const ids = ["warehouse-a", "yard-north", "assembly-line", "kangcheng-airy"];
    const origins = ids.map((id) => sceneGpsOrigin(id));
    expect(sceneGpsOrigin("warehouse-a")).toEqual(origins[0]);
    expect(new Set(origins.map((point) => `${point.x},${point.y}`)).size).toBe(ids.length);
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
