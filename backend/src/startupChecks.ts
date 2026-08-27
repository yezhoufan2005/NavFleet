import type { AppConfig } from "./config";

export interface StartupIssue {
  /** `fatal` refuses to boot; `warn` is logged and startup continues. */
  level: "fatal" | "warn";
  /** The setting at fault, for the log context. */
  setting: string;
  message: string;
}

/**
 * Check a config for settings that are defensible in development but not in a
 * production deployment.
 *
 * A pure function so the rules can be unit-tested without booting a process —
 * and so the composition root stays the only place that decides to exit.
 *
 * The split between fatal and warn is deliberate:
 *
 * - `DEBUG_INGEST_ENABLED` is fatal. That endpoint writes arbitrary device state
 *   into the live fleet; a monitoring system that can be fed fabricated
 *   telemetry is worse than no monitoring system, so this must not be a warning
 *   somebody scrolls past.
 * - `COOKIE_SECURE=false` only warns. It should be true, but the shipped compose
 *   still terminates plain HTTP on the host, so making it fatal would stop every
 *   existing deployment from starting after an upgrade. TLS-by-default in the
 *   deploy stack comes first; this becomes fatal after it.
 * - `AUTH_ENABLED=false` only warns: an unauthenticated kiosk on a closed network
 *   is a deployment choice an operator is allowed to make, loudly.
 * - A wildcard CORS origin is fatal because it cannot work rather than because it
 *   is unwise: browsers reject `*` on credentialed requests outright.
 *
 * JWT_SECRET is not checked here: `AuthService.initialize()` already refuses to
 * start without it in production, and keeping one owner avoids two error paths
 * that could disagree.
 */
export const auditProductionConfig = (config: AppConfig): StartupIssue[] => {
  if (config.nodeEnv !== "production") {
    return [];
  }

  const issues: StartupIssue[] = [];

  if (config.debugIngestEnabled) {
    issues.push({
      level: "fatal",
      setting: "DEBUG_INGEST_ENABLED",
      message:
        "POST /api/debug/ingest writes arbitrary device state into the live fleet and must be off in production.",
    });
  }

  if (!config.authEnabled) {
    issues.push({
      level: "warn",
      setting: "AUTH_ENABLED",
      message:
        "Every REST and WebSocket endpoint is unauthenticated. Only defensible on a closed network.",
    });
  }

  if (config.authEnabled && !config.cookieSecure) {
    issues.push({
      level: "warn",
      setting: "COOKIE_SECURE",
      message:
        "Session cookies are sent over plain HTTP. Terminate TLS at the edge and set COOKIE_SECURE=true.",
    });
  }

  if (config.corsOrigins.some((origin) => origin === "*")) {
    issues.push({
      level: "fatal",
      setting: "CORS_ORIGINS",
      message:
        "A wildcard origin cannot be combined with credentialed requests; list the exact origins instead.",
    });
  }

  return issues;
};
