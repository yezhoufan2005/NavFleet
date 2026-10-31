/**
 * The live publisher: the same timeline, one second at a time, over the real MQTT path.
 *
 * Resumes from the checkpoint (written by the catch-up, then by this process every second), so
 * the first frame it publishes is the second right after the last one stored. Frames are the
 * vehicle protocol on `/fleet/{id}/vehicle_info`; connectivity is `/fleet/{id}/status`, published
 * when a simulated link drops (standing in for the broker publishing that vehicle's will — one
 * process publishes for the whole fleet, so it cannot hold a will per vehicle) and when it comes
 * back.
 *
 * Injections (`main.ts inject`) are files dropped into `<stateDir>/inject/`; each is applied at
 * the next second and becomes part of the timeline from then on.
 *
 * Also answers webhook deliveries on `SIM_HOOK_HOST:SIM_HOOK_PORT` (loopback by default) with 200, so the demo's outbound-notification
 * channels have a receiver and their send log shows real deliveries.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import mqtt from "mqtt";
import { loadFleet, newState, readCheckpoint, reconcileStates, writeCheckpoint } from "./fleet";
import { INJECTION_KINDS, step, type Injection, type InjectionKind } from "./vehicle";

/** Older backlog than this is stepped without publishing: the backend would not trust its stamps. */
const MAX_BACKLOG_MS = 50_000;

const log = (message: string): void => {
  console.log(`[sim] ${new Date().toISOString().slice(11, 19)} ${message}`);
};

export const injectionDir = (stateDir: string): string => path.join(stateDir, "inject");

/**
 * Queue an injection for the live publisher. The vehicle is checked here, against the roster: the
 * publisher drops an unknown one with a line in its own log, so a mistyped id used to report
 * "queued" and then nothing happened.
 */
export const queueInjection = (
  stateDir: string,
  deviceId: string,
  kind: string,
  minutes: number | undefined,
  knownDeviceIds: readonly string[],
): void => {
  if (!INJECTION_KINDS.includes(kind as InjectionKind)) {
    throw new Error(`unknown injection "${kind}"; one of: ${INJECTION_KINDS.join(", ")}`);
  }
  if (!knownDeviceIds.includes(deviceId)) {
    throw new Error(`unknown vehicle "${deviceId}"; one of: ${knownDeviceIds.join(", ")}`);
  }
  const dir = injectionDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ deviceId, kind, ...(minutes ? { minutes } : {}) }));
};

const takeInjections = (stateDir: string, at: number, known: ReadonlySet<string>): Injection[] => {
  const dir = injectionDir(stateDir);
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const injections: Injection[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8")) as {
        deviceId?: string;
        kind?: string;
        minutes?: number;
      };
      if (
        raw.deviceId &&
        known.has(raw.deviceId) &&
        INJECTION_KINDS.includes(raw.kind as InjectionKind)
      ) {
        injections.push({
          deviceId: raw.deviceId,
          kind: raw.kind as InjectionKind,
          at,
          minutes: raw.minutes,
        });
        log(
          `injected ${raw.kind} into ${raw.deviceId}${raw.minutes ? ` for ${raw.minutes} min` : ""}`,
        );
      } else {
        log(`ignored injection ${file}: unknown vehicle or kind`);
      }
    } catch {
      log(`ignored unreadable injection ${file}`);
    }
    fs.rmSync(full, { force: true });
  }
  return injections;
};

const startHookReceiver = (host: string, port: number): http.Server => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(request.method === "POST" ? 200 : 204, {
        "content-type": "application/json",
      });
      // 企业微信 / 钉钉 robots answer `{"errcode":0}`; a generic webhook ignores the body.
      response.end(request.method === "POST" ? '{"errcode":0,"errmsg":"ok"}' : undefined);
    });
  });
  server.listen(port, host, () => log(`webhook receiver on ${host}:${port}`));
  return server;
};

export const runLive = async (options: {
  configRoot: string;
  stateDir: string;
  broker: string;
}): Promise<void> => {
  const fleet = await loadFleet(options.configRoot);
  const sites = new Map(fleet.sites.map((site) => [site.deviceId, site]));
  const now = Math.floor(Date.now() / 1000) * 1000;
  const checkpoint = readCheckpoint(options.stateDir);
  if (!checkpoint)
    log("no checkpoint: starting a fresh timeline now (run `catchup` first for history)");
  const states = checkpoint
    ? reconcileStates(fleet, checkpoint.states, Math.max(checkpoint.t, now))
    : fleet.sites.map((site) => newState(fleet, site, now));
  let cursor = checkpoint?.t ?? now;
  const known = new Set(sites.keys());

  const client = mqtt.connect(options.broker, {
    // A fixed id: the broker evicts any other publisher using it, so two timelines can never
    // interleave on the same vehicles. MQTT 5, so that takeover arrives with a reason code, and the
    // evicted one stands down for good (see the `disconnect` handler).
    clientId: "navfleet-demo-publisher",
    protocolVersion: 5,
    username: process.env.MQTT_PUBLISHER_USERNAME || process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PUBLISHER_PASSWORD || process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 3000,
  });
  const hookPort = Number(process.env.SIM_HOOK_PORT || 0);
  // Loopback unless told otherwise: in compose it listens on the internal network only.
  const hooks = hookPort
    ? startHookReceiver(process.env.SIM_HOOK_HOST || "127.0.0.1", hookPort)
    : null;

  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  let published = 0;
  let lastLog = Date.now();

  const tick = (): void => {
    const target = Math.floor(Date.now() / 1000) * 1000;
    if (!client.connected) return;
    while (cursor <= target) {
      const injections = takeInjections(options.stateDir, cursor, known);
      const publish = target - cursor < MAX_BACKLOG_MS;
      for (const state of states) {
        if (state.t !== cursor) continue;
        const site = sites.get(state.deviceId);
        if (!site) continue;
        const { frame, status } = step(
          site,
          state,
          injections.filter((injection) => injection.deviceId === state.deviceId),
          publish,
        );
        if (status !== null && publish) {
          client.publish(
            `/fleet/${state.deviceId}/status`,
            JSON.stringify({ online: status, ts: cursor }),
          );
        }
        if (frame) {
          client.publish(`/fleet/${state.deviceId}/vehicle_info`, JSON.stringify(frame));
          published += 1;
        }
      }
      cursor += 1000;
    }
    writeCheckpoint(options.stateDir, { version: 1, t: cursor, states });
    // The container's health: live and publishing (the catch-up before it does not touch this).
    fs.writeFileSync(path.join(options.stateDir, "live.heartbeat"), String(cursor));
    if (Date.now() - lastLog > 300_000) {
      lastLog = Date.now();
      log(`${published} frames published; at ${new Date(cursor).toISOString()}`);
    }
  };

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    writeCheckpoint(options.stateDir, { version: 1, t: cursor, states });
    hooks?.close();
    const force = setTimeout(() => process.exit(0), 1500);
    force.unref();
    client.end(true, () => process.exit(0));
  };

  /**
   * Stop publishing and stay stopped, without exiting: under compose's `restart: unless-stopped`
   * or dev.sh's supervisor an exit, even 0, starts a new publisher that evicts the other one, and
   * the two take turns indefinitely. The heartbeat goes, so the container reports unhealthy.
   */
  const standDown = (): void => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    writeCheckpoint(options.stateDir, { version: 1, t: cursor, states });
    fs.rmSync(path.join(options.stateDir, "live.heartbeat"), { force: true });
    hooks?.close();
    client.end(true);
    // Nothing else keeps the event loop alive now; SIGINT / SIGTERM still end the process.
    setInterval(() => undefined, 3_600_000);
    const exit = (): void => process.exit(0);
    process.on("SIGINT", exit);
    process.on("SIGTERM", exit);
  };

  client.on("connect", () => {
    log(
      `connected to ${options.broker}; ${states.length} vehicles from ${new Date(cursor).toISOString()} (${os.hostname()})`,
    );
    for (const state of states) {
      if (state.online)
        client.publish(
          `/fleet/${state.deviceId}/status`,
          JSON.stringify({ online: true, ts: cursor }),
        );
    }
    if (!timer) timer = setInterval(tick, 250);
  });
  client.on("disconnect", (packet) => {
    if (packet?.reasonCode === 142) {
      log(
        "superseded by another publisher (session taken over); standing down. Not exiting: a " +
          "restart policy would bring this one back to take the session over again, and the two " +
          "timelines would alternate. Stop the other publisher, or this one, by hand.",
      );
      standDown();
    }
  });
  client.on("error", (error) => {
    log(`broker error: ${error.message}`);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};
