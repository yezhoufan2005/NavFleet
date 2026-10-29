/**
 * Catch-up: bring the stored history up to now along the simulated timeline.
 *
 * First start (no checkpoint): every vehicle joins at the start of the retention window — or at
 * its `commissionedAt`, if that is later — and the whole window is generated. Every later start:
 * the timeline resumes from the checkpoint and only the gap since then is generated. A gap
 * longer than the retention window is fast-forwarded (state only, no frames) up to the window.
 *
 * Frames go through a real `DashboardStore` on the simulated clock (see `sink.ts`), sharded over
 * a few child processes because the store is single-threaded: vehicles are independent, so each
 * shard runs its own store over its own vehicles. The parent then writes the checkpoint the live
 * publisher resumes from, the shift logins that go with the acknowledgements, and summarises the
 * new hours for the reports — so the backend starts on a complete, consistent history.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config";
import { ConfigRegistry } from "../src/configRegistry";
import { Persistence } from "../src/persistence";
import { DashboardStore } from "../src/store";
import {
  checkpointPath,
  loadFleet,
  newState,
  readCheckpoint,
  reconcileStates,
  writeCheckpoint,
  type Fleet,
} from "./fleet";
import { operatorAt, BackfillSink, type SinkStats } from "./sink";
import { step, type VehicleState } from "./vehicle";
import { MongoClient } from "mongodb";

const SECOND = 1000;
const SWEEP_EVERY_MS = 15_000;

const log = (message: string): void => {
  console.log(`[sim] ${new Date().toISOString().slice(11, 19)} ${message}`);
};

const floorSecond = (ms: number): number => Math.floor(ms / SECOND) * SECOND;

interface ShardJob {
  configRoot: string;
  /** Where each state starts; a state with `t` past `from` joins the loop when it is due. */
  states: VehicleState[];
  from: number;
  to: number;
}

interface ShardResult {
  states: VehicleState[];
  stats: SinkStats;
}

/** One shard: run `job.states` from `from` to `to` through a store on the simulated clock. */
export const runShard = async (job: ShardJob): Promise<ShardResult> => {
  const fleet = await loadFleet(job.configRoot);
  const sites = new Map(fleet.sites.map((site) => [site.deviceId, site]));
  const ids = new Set(job.states.map((state) => state.deviceId));
  const registry = new ConfigRegistry();
  await registry.load();
  const tags = new Map(
    registry.listVehicleConfigs().map((vehicle) => [vehicle.deviceId, vehicle.tags ?? []]),
  );
  const formations = registry.listFormations();
  const sink = new BackfillSink(ids, {
    config: registry.getNotifyConfig(),
    device: (deviceId) => ({
      deviceId,
      tags: tags.get(deviceId) ?? [],
      formationIds: formations
        .filter((formation) => formation.deviceIds.includes(deviceId))
        .map((formation) => formation.formationId),
    }),
  });
  let clock = job.from;
  const store = new DashboardStore(sink as unknown as Persistence, registry, () => clock);
  await store.initialize();

  const states = job.states;
  let nextSweep = job.from + SWEEP_EVERY_MS;
  let lastLog = Date.now();
  for (let t = job.from; t < job.to; t += SECOND) {
    clock = t;
    for (const state of states) {
      if (state.t !== t) continue;
      const site = sites.get(state.deviceId);
      if (!site) continue;
      const { frame, status } = step(site, state);
      if (status !== null) await store.applyStatus(state.deviceId, { online: status });
      if (frame) {
        await store.applyPayload(
          { topic: `/fleet/${state.deviceId}/vehicle_info`, payload: frame },
          "mqtt",
          { checkDeviceClock: true },
        );
      }
    }
    if (t >= nextSweep) {
      await store.evaluateOfflineDevices();
      nextSweep += SWEEP_EVERY_MS;
    }
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      log(`shard ${[...ids][0]}…: ${new Date(t).toISOString()} (${sink.stats.frames} frames)`);
    }
  }
  await store.drain();
  await sink.finish();
  return { states, stats: sink.stats };
};

/** Run shards in child processes (the same CLI, `shard <job file>`), in parallel. */
const runShards = async (jobs: ShardJob[], workDir: string): Promise<ShardResult[]> => {
  fs.mkdirSync(workDir, { recursive: true });
  return Promise.all(
    jobs.map(
      (job, index) =>
        new Promise<ShardResult>((resolve, reject) => {
          const jobFile = path.join(workDir, `shard-${index}.job.json`);
          const resultFile = path.join(workDir, `shard-${index}.result.json`);
          fs.writeFileSync(jobFile, JSON.stringify(job));
          const entry = process.argv[1] ?? "";
          const child = spawn(
            process.execPath,
            [...process.execArgv, entry, "shard", jobFile, resultFile],
            {
              stdio: "inherit",
              env: process.env,
            },
          );
          child.on("error", reject);
          child.on("exit", (code) => {
            if (code !== 0) {
              reject(new Error(`shard ${index} exited with ${code}`));
              return;
            }
            const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as ShardResult;
            fs.rmSync(jobFile, { force: true });
            fs.rmSync(resultFile, { force: true });
            resolve(result);
          });
        }),
    ),
  );
};

/** Shift logins over `[from, to)`: the operators whose acknowledgements the history carries. */
const writeShiftLogins = async (from: number, to: number): Promise<number> => {
  const entries: Record<string, unknown>[] = [];
  const day = 24 * 3_600_000;
  const firstDay = Math.floor((from + 8 * 3_600_000) / day) * day - 8 * 3_600_000;
  for (let midnight = firstDay; midnight < to; midnight += day) {
    for (const hour of [7.9, 19.9]) {
      const offset = ((midnight / day) % 7) * 37_000;
      const at = midnight + hour * 3_600_000 + offset;
      if (at < from || at >= to) continue;
      entries.push({
        ts: new Date(at),
        actor: operatorAt(at + 10 * 60_000),
        action: "login",
        outcome: "success",
      });
    }
  }
  if (!entries.length) return 0;
  const client = await MongoClient.connect(config.mongoUri);
  try {
    await client.db(config.mongoDbName).collection("audit_log").insertMany(entries);
  } finally {
    await client.close();
  }
  return entries.length;
};

const waitForMongo = async (persistence: Persistence): Promise<void> => {
  await persistence.connect();
  for (let attempt = 0; attempt < 600 && !persistence.isMongoConnected(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!persistence.isMongoConnected())
    throw new Error(`MongoDB not reachable at ${config.mongoDbName}`);
};

/** Fast-forward a state with no frames — a stretch older than anything the database keeps. */
const fastForward = (fleet: Fleet, state: VehicleState, until: number): void => {
  const site = fleet.sites.find((item) => item.deviceId === state.deviceId);
  if (!site) return;
  while (state.t < until) step(site, state, [], false);
};

export const catchUp = async (options: {
  configRoot: string;
  stateDir: string;
  shards?: number;
  historyDays?: number;
}): Promise<void> => {
  const started = Date.now();
  // Not live until this catch-up hands over: the container's health is the live heartbeat.
  fs.rmSync(path.join(options.stateDir, "live.heartbeat"), { force: true });
  const persistence = new Persistence();
  await waitForMongo(persistence);
  const fleet = await loadFleet(options.configRoot);
  // History never reaches further back than the database keeps it; a first start may be told to
  // generate less (`SIM_HISTORY_DAYS`, dev.sh uses a week) and the report presets beyond that
  // simply start where the fleet did.
  const retentionMs = config.telemetryRetentionSeconds * SECOND;
  const historyMs = options.historyDays
    ? Math.min(retentionMs, options.historyDays * 86_400_000)
    : retentionMs;
  const windowStart = floorSecond(Date.now() - historyMs) + 60_000;

  const checkpoint = readCheckpoint(options.stateDir);
  let states: VehicleState[];
  let from: number;
  if (!checkpoint) {
    const client = await MongoClient.connect(config.mongoUri);
    const existing = await client
      .db(config.mongoDbName)
      .collection("telemetry_ts")
      .estimatedDocumentCount();
    await client.close();
    if (existing > 0) {
      // Frames already stored for a vehicle are never written twice, so history generated into a
      // database that holds another timeline would come out full of holes.
      log(
        `WARNING: no checkpoint, but the database already holds ${existing} telemetry frames from ` +
          "another source; generated history skips what is already stored. Start from an empty " +
          "database (verify-stack --purge) for a complete demo history.",
      );
    }
    log(
      `no checkpoint in ${options.stateDir}: generating the retention window from ${new Date(windowStart).toISOString()}`,
    );
    states = fleet.sites.map((site) =>
      newState(
        fleet,
        site,
        Math.max(windowStart, floorSecond(fleet.commissioned.get(site.deviceId) ?? 0)),
      ),
    );
    from = windowStart;
  } else {
    states = reconcileStates(fleet, checkpoint.states, checkpoint.t);
    from = checkpoint.t;
    if (from < windowStart) {
      log(
        `checkpoint is older than the retention window: fast-forwarding to ${new Date(windowStart).toISOString()}`,
      );
      for (const state of states) fastForward(fleet, state, windowStart);
      from = windowStart;
    }
  }
  const totals: SinkStats = {
    frames: 0,
    skippedFrames: 0,
    closed: 0,
    handedOver: 0,
    acks: 0,
    sends: 0,
  };
  let logins = 0;
  const shardCount = Math.max(
    1,
    Math.min(options.shards ?? Math.min(4, os.cpus().length), states.length),
  );

  /** Generate `[from, to)` and move the checkpoint to `to`. */
  const round = async (to: number): Promise<void> => {
    log(
      `catching up ${fleet.sites.length} vehicles over ${((to - from) / 3_600_000).toFixed(2)} h`,
    );
    const jobs: ShardJob[] = Array.from({ length: shardCount }, (_, index) => ({
      configRoot: options.configRoot,
      states: states.filter((_state, position) => position % shardCount === index),
      from,
      to,
    }));
    const results = await runShards(jobs, path.join(options.stateDir, "work"));
    const merged = new Map(
      results.flatMap((result) => result.states).map((state) => [state.deviceId, state]),
    );
    states = fleet.sites
      .map((site) => merged.get(site.deviceId))
      .filter((state): state is VehicleState => !!state);
    writeCheckpoint(options.stateDir, { version: 1, t: to, states });
    logins += await writeShiftLogins(from, to);
    for (const { stats } of results) {
      for (const key of Object.keys(totals) as Array<keyof SinkStats>) totals[key] += stats[key];
    }
    from = to;
  };

  const registry = new ConfigRegistry();
  await registry.load();
  const threshold = registry.getAlertRules().offline.afterSeconds ?? config.offlineAfterSeconds;
  let hours = 0;
  // The big round, then the reports' summary, then short rounds for the time those took, until
  // the history ends within seconds of now — the live publisher picks up from there, and a gap
  // longer than the offline threshold would read as the whole fleet dropping out.
  for (let pass = 0; pass < 6; pass += 1) {
    const to = floorSecond(Date.now());
    if (to - from < 5 * SECOND) break;
    await round(to);
    if (pass === 0) {
      for (
        let done = await persistence.rollupTelemetry(threshold, 600_000);
        done > 0;
        done = await persistence.rollupTelemetry(threshold, 600_000)
      ) {
        hours += done;
      }
    }
  }
  log(
    `wrote ${totals.frames} frames (${totals.skippedFrames} already stored), ${totals.closed} closed messages ` +
      `(${totals.acks} acknowledged), ${totals.handedOver} still active, ${totals.sends} notifications, ` +
      `${logins} shift logins`,
  );
  log(
    `summarised ${hours} hours for the reports; checkpoint ${checkpointPath(options.stateDir)}; ${Math.round((Date.now() - started) / 1000)} s`,
  );
  await persistence.close();
};
