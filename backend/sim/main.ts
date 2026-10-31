/**
 * Demo fleet simulator.
 *
 *   catchup                   bring the stored history up to now (first run: the retention window)
 *   live                      publish the timeline over MQTT, one frame per vehicle per second
 *   inject <id> <kind> [min]  make something happen to a vehicle on the live timeline
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
import { resolveConfigRoot } from "./fleet";
import { queueInjection, runLive } from "./live";
import { INJECTION_KINDS } from "./vehicle";

const stateDir = path.resolve(process.env.SIM_STATE_DIR || path.join(process.cwd(), ".demo-sim"));

const usage = (): never => {
  console.error(
    [
      "usage: sim <catchup | live | inject <deviceId> <kind> [minutes]>",
      `kinds: ${INJECTION_KINDS.join(", ")}`,
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
      queueInjection(stateDir, deviceId!, kind!, minutes ? Number(minutes) : undefined);
      console.log(`queued ${kind} for ${deviceId}; the live publisher applies it within a second`);
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
  if (error instanceof CatchUpRefused) {
    console.error(`[sim] refused: ${error.message}`);
    // A distinct code: dev.sh stops restarting on it, since a retry would refuse the same way.
    process.exit(3);
  }
  console.error(`[sim] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
