import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadFleet, newState, type Fleet } from "../sim/fleet";
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
    expect(state.error?.code).not.toBe(5202);
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
