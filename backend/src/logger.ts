import pino from "pino";
import { config } from "./config";

/**
 * Paths scrubbed from every log line. Defence in depth: call sites already avoid
 * logging credentials (e.g. persistence redacts the Mongo URI before logging
 * it), but a future `logger.info({ err })` on a driver error or a request dump
 * could still carry a session cookie, an Authorization header or a URI with an
 * embedded password. Redaction here means no single careless call site can leak
 * one. Wildcards cover nested shapes (`{ err: { config: { password } } }`).
 *
 * `uri` is deliberately absent: `persistence` logs an already-redacted Mongo URI
 * under that key, and censoring it would throw away the host/port that makes a
 * connection failure diagnosable. The raw-value key `mongoUri` is covered instead.
 */
const REDACTED_PATHS = [
  "password",
  "*.password",
  "*.*.password",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "accessToken",
  "refreshToken",
  "jwtSecret",
  "*.jwtSecret",
  "secret",
  "*.secret",
  "mongoUri",
  "*.mongoUri",
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  "headers['set-cookie']",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
];

/** Root application logger. */
export const logger = pino({
  name: "fleet-backend",
  level: config.logLevel,
  redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
});

/**
 * A logger for one subsystem, e.g. `moduleLogger("persistence")`.
 *
 * Derived from the root logger rather than a fresh `pino({ name })`, so a module
 * cannot opt out of LOG_LEVEL or of redaction. Four modules previously built
 * their own: with `LOG_LEVEL=warn` they still emitted info lines (verified
 * against a running process), which made the setting look broken and left their
 * output unredacted. The emitted shape is unchanged — the child's `name` binding
 * overrides the root's.
 */
export const moduleLogger = (name: string): pino.Logger => logger.child({ name });
