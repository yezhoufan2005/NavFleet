import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  it("applies documented defaults when env is empty", () => {
    const c = parseConfig({});
    expect(c.port).toBe(3000);
    expect(c.nodeEnv).toBe("development");
    expect(c.logLevel).toBe("info");
    expect(c.metricsEnabled).toBe(true);
    expect(c.authEnabled).toBe(true);
    expect(c.offlineAfterSeconds).toBe(60);
    expect(c.corsOrigins).toEqual(["http://127.0.0.1:5173", "http://localhost:5173"]);
    expect(c.mqttClientId).toMatch(/^fleet-dashboard-/);
  });

  it("parses explicit values", () => {
    const c = parseConfig({
      PORT: "8080",
      AUTH_ENABLED: "false",
      METRICS_ENABLED: "0",
      CORS_ORIGINS: "https://a.example, https://b.example ,",
      MAX_HISTORY_POINTS: "250",
    });
    expect(c.port).toBe(8080);
    expect(c.authEnabled).toBe(false);
    expect(c.metricsEnabled).toBe(false);
    expect(c.corsOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(c.maxHistoryPoints).toBe(250);
  });

  it("clamps the config-watch debounce to a 100ms floor", () => {
    expect(parseConfig({ CONFIG_WATCH_DEBOUNCE_MS: "10" }).configWatchDebounceMs).toBe(100);
    expect(parseConfig({ CONFIG_WATCH_DEBOUNCE_MS: "2000" }).configWatchDebounceMs).toBe(2000);
  });

  it("fails fast on a non-numeric number field", () => {
    expect(() => parseConfig({ PORT: "not-a-number" })).toThrow(ZodError);
  });

  it("fails fast on an unrecognized boolean field", () => {
    expect(() => parseConfig({ METRICS_ENABLED: "maybe" })).toThrow(ZodError);
  });
});
