import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { config } from "../src/config";
import { logger, moduleLogger } from "../src/logger";

/**
 * Four subsystems used to build their own `pino({ name })`, which inherits
 * neither LOG_LEVEL nor the redaction config. The visible symptom was that
 * `LOG_LEVEL=warn` still produced info lines from `config-registry`,
 * `dashboard-store` and `auth`, making the setting look broken.
 */
describe("moduleLogger", () => {
  it("honours the configured level, unlike a freshly constructed pino logger", () => {
    expect(logger.level).toBe(config.logLevel);
    expect(moduleLogger("persistence").level).toBe(config.logLevel);
  });

  it("filters below the configured level", () => {
    // The suite runs at LOG_LEVEL=silent (vitest.config.ts), so nothing passes.
    const subsystem = moduleLogger("dashboard-store");

    expect(subsystem.isLevelEnabled("info")).toBe(false);
    expect(subsystem.isLevelEnabled("fatal")).toBe(false);
  });

  it("keeps the log shape a named logger produced: name is the subsystem", () => {
    expect(moduleLogger("config-registry").bindings().name).toBe("config-registry");
  });
});

/** Output actually written by a subsystem logger, one parsed line per entry. */
const probeOutput = (logLevel: string): Array<Record<string, unknown>> => {
  const stdout = execFileSync("npx", ["tsx", path.join(__dirname, "helpers", "logger-probe.ts")], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: logLevel },
  });
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("subsystem log output", () => {
  it("drops info lines when LOG_LEVEL=warn", () => {
    const lines = probeOutput("warn");

    expect(lines.map((line) => line.msg)).toEqual(["warn line"]);
    expect(lines[0].name).toBe("probe-subsystem");
  });

  it("redacts credential-shaped fields, including nested ones", () => {
    const info = probeOutput("info").find((line) => line.msg === "info line");

    expect(info).toBeDefined();
    expect(info?.password).toBe("[redacted]");
    expect(info?.nested).toEqual({ passwordHash: "[redacted]" });
    expect(info?.keep).toBe("visible");
  });
});
