/**
 * Probe used by `logger.test.ts` to observe real logger output.
 *
 * Run as a subprocess (`tsx test/helpers/logger-probe.ts`) because pino writes
 * through sonic-boom straight to file descriptor 1 — stubbing
 * `process.stdout.write` in-process would not see a thing, and the root logger's
 * level and redaction are fixed when the module is first imported.
 */
import { moduleLogger } from "../../src/logger";

const log = moduleLogger("probe-subsystem");

log.info(
  { password: "top-secret", nested: { passwordHash: "hash" }, keep: "visible" },
  "info line",
);
log.warn("warn line");
