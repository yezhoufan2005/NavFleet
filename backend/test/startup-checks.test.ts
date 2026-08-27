import { describe, it, expect } from "vitest";
import { parseConfig, type AppConfig } from "../src/config";
import { auditProductionConfig } from "../src/startupChecks";

const configFor = (env: Record<string, string>): AppConfig =>
  parseConfig({ NODE_ENV: "production", ...env });

const settings = (config: AppConfig): string[] =>
  auditProductionConfig(config).map((issue) => issue.setting);

const levelOf = (config: AppConfig, setting: string): string | undefined =>
  auditProductionConfig(config).find((issue) => issue.setting === setting)?.level;

describe("auditProductionConfig", () => {
  it("says nothing outside production, however loose the settings", () => {
    const development = parseConfig({
      NODE_ENV: "development",
      DEBUG_INGEST_ENABLED: "true",
      AUTH_ENABLED: "false",
      COOKIE_SECURE: "false",
    });

    expect(auditProductionConfig(development)).toEqual([]);
  });

  it("passes a properly locked-down production config", () => {
    expect(
      auditProductionConfig(
        configFor({
          AUTH_ENABLED: "true",
          COOKIE_SECURE: "true",
          DEBUG_INGEST_ENABLED: "false",
          CORS_ORIGINS: "https://fleet.internal",
        }),
      ),
    ).toEqual([]);
  });

  it("refuses to boot with the debug ingest endpoint open", () => {
    const config = configFor({ DEBUG_INGEST_ENABLED: "true", COOKIE_SECURE: "true" });

    expect(levelOf(config, "DEBUG_INGEST_ENABLED")).toBe("fatal");
  });

  it("refuses to boot with a wildcard CORS origin, which cannot work with cookies", () => {
    const config = configFor({ CORS_ORIGINS: "https://fleet.internal,*", COOKIE_SECURE: "true" });

    expect(levelOf(config, "CORS_ORIGINS")).toBe("fatal");
  });

  it("warns but still boots without secure cookies, because the shipped stack is plain HTTP", () => {
    const config = configFor({ COOKIE_SECURE: "false", AUTH_ENABLED: "true" });

    expect(levelOf(config, "COOKIE_SECURE")).toBe("warn");
    expect(auditProductionConfig(config).every((issue) => issue.level === "warn")).toBe(true);
  });

  it("warns but still boots with authentication off, an operator's call on a closed network", () => {
    const config = configFor({ AUTH_ENABLED: "false", COOKIE_SECURE: "true" });

    expect(levelOf(config, "AUTH_ENABLED")).toBe("warn");
  });

  it("does not nag about cookie flags when authentication is off entirely", () => {
    const config = configFor({ AUTH_ENABLED: "false", COOKIE_SECURE: "false" });

    expect(settings(config)).toEqual(["AUTH_ENABLED"]);
  });

  it("reports every problem at once rather than one per restart", () => {
    const config = configFor({
      DEBUG_INGEST_ENABLED: "true",
      COOKIE_SECURE: "false",
      CORS_ORIGINS: "*",
    });

    expect(settings(config).sort()).toEqual(
      ["CORS_ORIGINS", "COOKIE_SECURE", "DEBUG_INGEST_ENABLED"].sort(),
    );
  });
});
