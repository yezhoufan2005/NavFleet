import { z } from "zod";
import { config } from "./config";

/** A timestamp expressed as an ISO-8601 string or a numeric epoch (ms or s). */
const timestampString = z
  .string()
  .min(1)
  .refine(
    (value) => Number.isFinite(Date.parse(value)) || Number.isFinite(Number(value)),
    "must be an ISO-8601 datetime or a numeric epoch",
  );

export const historyQuerySchema = z.object({
  from: timestampString.optional(),
  to: timestampString.optional(),
  /**
   * Bounded by what the server will actually return, not by a round number.
   *
   * This used to accept up to 5000 while both query paths clamp to
   * `MAX_HISTORY_POINTS` (default 500) — and because `openapi.ts` generates this
   * parameter *from this schema*, the published contract promised 5000 for a server
   * that never returns more than 500. A client sizing its buffers off the spec was
   * being told the wrong number by the spec's own source of truth.
   *
   * Reading `config` means the document each deployment serves states that
   * deployment's real cap, which is the only version of this number that is true.
   */
  limit: z.coerce.number().int().positive().max(config.maxHistoryPoints).optional(),
});

export const alertsQuerySchema = z.object({
  severity: z.enum(["critical", "warning", "notice"]).optional(),
  deviceId: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "cleared"]).optional(),
});

/**
 * Debug-ingest bodies are intentionally heterogeneous (the normalizer accepts
 * many shapes), so this only rejects primitives up front with a clean 400
 * instead of letting them fall through to a 500.
 */
export const ingestBodySchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);

/**
 * Ingest gate for MQTT telemetry frames. Real frames are intentionally
 * heterogeneous (normalize.ts deliberately accepts many vendor shapes), so this
 * asserts nothing beyond "a non-null JSON object" and leaves field-level shape
 * to the normalizer. That still stops the clearly-unusable cases: an unparseable
 * broker payload reaches us as the raw text (a string), and null / arrays /
 * primitives carry no device fields the normalizer could read — feeding those to
 * the store only produces junk device state.
 */
export const mqttTelemetrySchema = z.record(z.string(), z.unknown());

/**
 * Plain-text status encodings, mirrored from DashboardStore.parseOnline(): its
 * string branch trims + lowercases and treats exactly "offline", "0" and "false"
 * as offline, resolving anything else to online via its default. The three
 * positive counterparts are whitelisted alongside them so the documented
 * plain-text encoding keeps working; every other string stays rejected, since an
 * unparseable payload also reaches the gate as a string.
 */
const PLAIN_TEXT_STATUS_VALUES = new Set(["offline", "0", "false", "online", "1", "true"]);

const plainTextStatusSchema = z
  .string()
  .refine(
    (value) => PLAIN_TEXT_STATUS_VALUES.has(value.trim().toLowerCase()),
    `plain-text status must be one of ${[...PLAIN_TEXT_STATUS_VALUES].join(", ")} (case-insensitive)`,
  );

/**
 * Ingest gate for MQTT status frames. Usually an object (`{ online: true }` or
 * `{ status: "offline" }`); a bare `true`/`false` and the plain-text encodings
 * understood by the store are accepted too. Validation never rewrites the value —
 * mqtt.ts forwards the original parsed payload, and `DashboardStore.parseOnline`
 * does the interpretation for all three shapes.
 */
export const mqttStatusSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.boolean(),
  plainTextStatusSchema,
]);

/**
 * Device ids in the URL path. Bounded but charset-free: device ids come from the
 * customer's fleet config and may use arbitrary vendor conventions; they are
 * only ever used as map keys / query filters, never as file paths.
 */
export const deviceIdParamSchema = z.string().min(1).max(200);

/** Same length bound as `deviceIdParamSchema`, shared so the two cannot drift. */
const DEVICE_ID_MAX_LENGTH = 200;

/**
 * Characters a single MQTT topic segment cannot legitimately carry: the topic
 * separator and both wildcards, plus whitespace and C0/DEL control characters. A
 * device id containing any of them did not come from a vendor convention, it came
 * from a malformed frame — or from an attempt to write something else into a log.
 * Hyphens, dots, colons and the rest stay legal; `agv-a01` is a real id here.
 */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const FORBIDDEN_DEVICE_ID_CHARS = /[\s/+#\u0000-\u001f\u007f]/;

/**
 * Whether a device id from the broker may **create** an in-memory device (P0-d).
 *
 * Deliberately weaker than a charset whitelist, for the reason
 * `deviceIdParamSchema` gives: real device ids come from the customer's fleet and
 * follow arbitrary vendor conventions. What this asserts is only what an ingest
 * gate must — a bounded length, so one frame cannot plant a megabyte-long map key,
 * and no characters that could not have been in the topic to begin with.
 */
export const isIngestableDeviceId = (deviceId: string): boolean =>
  deviceId.length >= 1 &&
  deviceId.length <= DEVICE_ID_MAX_LENGTH &&
  !FORBIDDEN_DEVICE_ID_CHARS.test(deviceId);

/**
 * Scene ids in the URL path. Stricter than device ids: a scene id resolves a
 * scene-map asset on disk, so it is limited to a safe id charset — and dot-only
 * ids ("." / "..") are refused outright — as defense-in-depth behind the
 * existing path-traversal guard in configRegistry.
 */
export const sceneIdParamSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, "must contain only letters, digits, '-', '_' or '.'")
  .refine((value) => !/^\.+$/.test(value), "must not be a dot-only path segment");

export const loginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
});

/**
 * Password complexity for any *new* password (self change-password now; admin reset/create in
 * 15B-2). Deliberately modest — at least 8 chars, with both a letter and a digit — because a
 * single-instance intranet tool gains little from ornate rules that mostly push operators
 * toward `Password1!` on a sticky note. Login is intentionally NOT held to this (existing
 * accounts predate any policy); it only guards passwords being set.
 */
export const passwordSchema = z
  .string()
  .min(8, "密码至少 8 位")
  .max(200)
  .refine((value) => /[A-Za-z]/.test(value), "密码需包含字母")
  .refine((value) => /\d/.test(value), "密码需包含数字");

export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

/** Admin API — shared field shapes for a user record. */
const usernameSchema = z.string().min(1).max(200);
const roleSchema = z.enum(["admin", "operator", "viewer"]);
// Lenient contact fields: this is an ops tool, not a CRM. A non-empty string capped for
// safety, or explicit null to clear. Format is not enforced beyond length.
const contactSchema = z.string().max(200).nullable();

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema,
  displayName: z.string().min(1).max(200).optional(),
  email: contactSchema.optional(),
  phone: contactSchema.optional(),
});

export const updateUserSchema = z
  .object({
    role: roleSchema.optional(),
    displayName: z.string().min(1).max(200).optional(),
    email: contactSchema.optional(),
    phone: contactSchema.optional(),
    enabled: z.boolean().optional(),
  })
  // A PATCH with an empty body is a client error, not a no-op success.
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

export const resetPasswordSchema = z.object({
  newPassword: passwordSchema,
});

/** Query filters for `GET /api/audit` (admin). All optional; unbounded result is capped server-side. */
export const auditQuerySchema = z.object({
  actor: z.string().min(1).max(200).optional(),
  action: z
    .enum([
      "login",
      "login_failed",
      "logout",
      "password_change",
      "password_reset",
      "user_create",
      "user_update",
      "user_delete",
      "session_revoke",
      "force_logout",
      "account_locked",
    ])
    .optional(),
  from: timestampString.optional(),
  to: timestampString.optional(),
});
