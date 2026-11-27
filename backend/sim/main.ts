/**
 * Demo fleet simulator.
 *
 *   catchup                   bring the stored history up to now (first run: the retention window)
 *   live                      publish the timeline over MQTT, one frame per vehicle per second
 *   inject <id> <kind> [min]  make something happen to a vehicle on the live timeline
 *   scenario [name] [target]  stage a drill (fleet-wide e-stop, a scene's AP restart …); no name lists them
 *   coverage [days]           run the timeline offline and report which states it reaches
 *   shard <job> <result>      internal: one catch-up shard
 *
 * Environment: CONFIG_ROOT_PATH (config-runtime), SIM_STATE_DIR (checkpoint + injections),
 * MONGO_URI / MONGO_DB_NAME (catchup), MQTT_URL + MQTT_PUBLISHER_USERNAME / _PASSWORD (live),
 * SIM_HOOK_PORT / SIM_HOOK_HOST (live: answer webhook deliveries, loopback by default),
 * SIM_SHARDS (catchup parallelism), SIM_HISTORY_DAYS (first catchup: generate at most this many days).
 */
import fs from "node:fs";
import path from "node:path";
import { CatchUpRefused, catchUp, runShard } from "./catchup";
import { CheckpointCorrupt, loadFleet, resolveConfigRoot } from "./fleet";
import { queueInjection, runLive } from "./live";
import { INJECTION_KINDS } from "./vehicle";
import { findScenario, SCENARIOS } from "./scenarios";
import { formatCoverage, measureCoverage } from "./coverage";

const stateDir = path.resolve(process.env.SIM_STATE_DIR || path.join(process.cwd(), ".demo-sim"));

const usage = (): never => {
  console.error(
    [
      "usage: sim <catchup | live | inject <deviceId> <kind> [minutes] | scenario [name] [target] | coverage [days]>",
      `kinds: ${INJECTION_KINDS.join(", ")}`,
      `scenarios: ${SCENARIOS.map((scenario) => scenario.name).join(", ")}`,
    ].join("\n"),
  );
  process.exit(2);
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "catchup":
      await catchUp({
        configRoot: resolveConfigRoot(),
        stateDir,
        shards: process.env.SIM_SHARDS ? Number(process.env.SIM_SHARDS) : undefined,
        historyDays: process.env.SIM_HISTORY_DAYS
          ? Number(process.env.SIM_HISTORY_DAYS)
          : undefined,
      });
      process.exit(0);
      break;
    case "live":
      await runLive({
        configRoot: resolveConfigRoot(),
        stateDir,
        broker: process.env.MQTT_URL || "mqtt://127.0.0.1:1883",
      });
      break;
    case "inject": {
      const [deviceId, kind, minutes] = args;
      if (!deviceId || !kind) usage();
      // The vehicles the live publisher runs: the roster less a spare that is never switched on,
      // plus a visiting vehicle — so an id it would drop is refused here, not reported as queued.
      const fleet = await loadFleet(resolveConfigRoot());
      queueInjection(
        stateDir,
        deviceId!,
        kind!,
        minutes ? Number(minutes) : undefined,
        fleet.sites.map((site) => site.deviceId),
      );
      console.log(`queued ${kind} for ${deviceId}; the live publisher applies it within a second`);
      break;
    }
    case "scenario": {
      const [name, target] = args;
      if (!name) {
        for (const scenario of SCENARIOS) {
          const takes = scenario.target
            ? ` [${scenario.target.what === "vehicle" ? "车号" : "场景号"}，默认 ${scenario.target.default}]`
            : "";
          console.log(`${scenario.name}  ${scenario.title}${takes}\n  ${scenario.description}\n`);
        }
        break;
      }
      const scenario = findScenario(name);
      if (!scenario) {
        console.error(
          `unknown scenario "${name}"; one of: ${SCENARIOS.map((item) => item.name).join(", ")}`,
        );
        process.exit(2);
      }
      const fleet = await loadFleet(resolveConfigRoot());
      const steps = scenario.steps(fleet, target || scenario.target?.default || "");
      if (!steps.length) {
        console.error(`scenario ${name}: nothing to do for "${target}"`);
        process.exit(2);
      }
      const known = fleet.sites.map((site) => site.deviceId);
      for (const step of steps) {
        queueInjection(stateDir, step.deviceId, step.kind, step.minutes || undefined, known);
      }
      console.log(
        `staged ${scenario.title}: ${steps.length} injections on ${new Set(steps.map((step) => step.deviceId)).size} vehicles; the live publisher applies them within a second\n${scenario.description}`,
      );
      break;
    }
    case "coverage": {
      const days = Number(args[0] || 30);
      const report = await measureCoverage(resolveConfigRoot(), days);
      console.log(formatCoverage(report));
      process.exit(report.missing.length ? 1 : 0);
      break;
    }
    case "shard": {
      const [jobFile, resultFile] = args;
      if (!jobFile || !resultFile) usage();
      const result = await runShard(
        JSON.parse(fs.readFileSync(jobFile!, "utf8")) as Parameters<typeof runShard>[0],
      );
      fs.writeFileSync(resultFile!, JSON.stringify(result));
      process.exit(0);
      break;
    }
    default:
      usage();
  }
};

main().catch((error: unknown) => {
  if (error instanceof CatchUpRefused || error instanceof CheckpointCorrupt) {
    console.error(`[sim] refused: ${error.message}`);
    // A distinct code: dev.sh stops restarting on it, since a retry would refuse the same way.
    process.exit(3);
  }
  console.error(`[sim] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
