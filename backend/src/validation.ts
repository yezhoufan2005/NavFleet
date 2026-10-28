import { z } from "zod";
import { config } from "./config";
import { AUDIT_ACTIONS } from "./types";
import { CAPABILITIES } from "@navfleet/shared";

/** A timestamp expressed as an ISO-8601 string or a numeric epoch (ms or s). */
const timestampString = z
  .string()
  .min(1)
  .refine(
    (value) => Number.isFinite(Date.parse(value)) || Number.isFinite(Number(value)),
    "must be an ISO-8601 datetime or a numeric epoch",
  );

/** Milliseconds for ordering, preferring ISO parsing and falling back to a numeric epoch. */
const toEpochMs = (value: string): number =>
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number(value);

/**
 * `from` must not be after `to`. The frontend already blocks this before it issues the
 * request, so this is the matching server-side guard — a hand-built query (or a stale
 * client) that inverts the window gets a clean 400 rather than a silently empty result
 * that reads the same as "no telemetry in range". Only checked when both bounds are
 * present; a one-sided (open-ended) window is still valid for the filter endpoints.
 */
const rejectInvertedWindow = <T extends { from?: string; to?: string }>(
  value: T,
  ctx: z.RefinementCtx,
): void => {
  if (value.from && value.to && toEpochMs(value.from) > toEpochMs(value.to)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["to"],
      message: "结束时间不能早于起始时间",
    });
  }
};

/** Inverted windows, and (for aggregations) windows wider than `REPORT_MAX_RANGE_DAYS`. */
const rejectOversizedWindow = <T extends { from?: string; to?: string }>(
  value: T,
  ctx: z.RefinementCtx,
): void => {
  rejectInvertedWindow(value, ctx);
  if (value.from && value.to) {
    const days = (toEpochMs(value.to) - toEpochMs(value.from)) / 86_400_000;
    if (days > config.reportMaxRangeDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: `时间范围不能超过 ${config.reportMaxRangeDays} 天`,
      });
    }
  }
};

export const historyQuerySchema = z
  .object({
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
    /**
     * `latest` (default): the newest `limit` samples — what a live chart wants. `even`: the
     * whole `from`–`to` window, thinned to at most `MAX_HISTORY_POINTS` samples spread evenly
     * over time — what playback of a long window wants, since the newest 500 frames of a
     * 24-hour window are its last few minutes. Thinning picks real frames, never averages, so
     * every pose played back is one the vehicle reported.
     */
    sampling: z.enum(["latest", "even"]).optional(),
  })
  .superRefine((value, ctx) => {
    rejectInvertedWindow(value, ctx);
    if (value.sampling === "even" && (!value.from || !value.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.from ? "to" : "from"],
        message: "均匀抽样需要同时给出起始和结束时间",
      });
    }
  });

export const alertsQuerySchema = z
  .object({
    severity: z.enum(["critical", "warning", "notice"]).optional(),
    deviceId: z.string().min(1).max(200).optional(),
    status: z.enum(["active", "cleared"]).optional(),
    // Time window, bounds on `firstSeenAt` (onset) — the same field the report aggregates filter on,
    // so a window means the same thing here and there. Added in 1.6.1 so 告警史 can reach a specific
    // past period: the query is capped at MAX_ALERTS_PER_QUERY rows, and without a window that cap
    // always returned the most-recent page, leaving older cleared alerts unreachable.
    from: timestampString.optional(),
    to: timestampString.optional(),
  })
  .superRefine(rejectInvertedWindow);

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
 * Whether a device id from the broker may **create** an in-memory device.
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

/**
 * Admin API — shared field shapes for a user record.
 *
 * A username is an identifier other config refers to (group members, `@user` recipients), so it is
 * trimmed and limited to a plain charset: letters, digits, `. _ -`. Uniqueness is checked
 * case-insensitively in the service, so "Admin" and "admin" cannot both exist.
 */
const usernameSchema = z
  .string()
  .trim()
  .min(1, "用户名不能为空")
  .max(64, "用户名最多 64 个字符")
  .regex(/^[A-Za-z0-9._-]+$/, "用户名只能包含字母、数字和 . _ -");
const roleSchema = z.enum(["admin", "operator", "viewer"]);
// Contact fields are optional and nullable (null clears). Email is checked for shape because the
// notification system mails it (an `@user` recipient resolves to it); phone stays free text.
const contactSchema = z.string().max(200).nullable();
const emailSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) => value === "" || /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(value),
    {
      message: "邮箱格式不正确",
    },
  )
  .transform((value) => (value === "" ? null : value))
  .nullable();

export const createUserSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    role: roleSchema,
    displayName: z.string().trim().min(1).max(200).optional(),
    email: emailSchema.optional(),
    phone: contactSchema.optional(),
    // A kiosk account is a long-lived read-only credential for a wall display. It is
    // read-only by construction, so it must be a viewer — reject any other role rather than mint
    // a long-lived operator/admin token by mistake.
    kiosk: z.boolean().optional(),
  })
  .refine((value) => !value.kiosk || value.role === "viewer", {
    message: "kiosk 账号必须是 viewer（只读）",
    path: ["kiosk"],
  });

export const updateUserSchema = z
  .object({
    role: roleSchema.optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    email: emailSchema.optional(),
    phone: contactSchema.optional(),
    enabled: z.boolean().optional(),
  })
  // A PATCH with an empty body is a client error, not a no-op success.
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

export const resetPasswordSchema = z.object({
  newPassword: passwordSchema,
});

/** Query filters for `GET /api/audit` (admin). All optional; unbounded result is capped server-side. */
export const auditQuerySchema = z
  .object({
    actor: z.string().min(1).max(200).optional(),
    // `action` is a **comma-joined list** (the 审计 page's 动作 filter is multi-select since 1.6.x),
    // e.g. `user_create,user_delete`. Each item must be in the canonical `AUDIT_ACTIONS` tuple, so an
    // unknown action still 400s — see the tuple's note in `types.ts` for the drift this closes. An
    // empty value parses to `[]`, which the persistence layer treats as "no action filter".
    action: z
      .string()
      .transform((raw) =>
        raw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(AUDIT_ACTIONS)))
      .optional(),
    from: timestampString.optional(),
    to: timestampString.optional(),
  })
  .superRefine(rejectInvertedWindow);

/** Query filters for `GET /api/reports/alerts` (viewer+). Both optional; the aggregate
 * spans the whole retention window when neither bound is given. Bounds filter on `firstSeenAt`. */
export const reportRangeSchema = z
  .object({
    from: timestampString.optional(),
    to: timestampString.optional(),
  })
  .superRefine(rejectOversizedWindow);

/** Query filters for `GET /api/reports/availability` (viewer+). `bucket` defaults to
 * day; `deviceId` is a comma-joined list that narrows to those vehicles (multi-select since the
 * filter-polish sweep), otherwise the whole fleet. Bounds filter on `ts`. */
export const reportAvailabilityQuerySchema = z
  .object({
    from: timestampString.optional(),
    to: timestampString.optional(),
    deviceId: z
      .string()
      .transform((raw) =>
        raw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().min(1).max(200)))
      .optional(),
    bucket: z.enum(["hour", "day", "month"]).default("day"),
  })
  .superRefine(rejectOversizedWindow);

/** Query filters for `GET /api/notify/log` (admin). All optional; unbounded result is capped server-side. */
export const notifyLogQuerySchema = z
  .object({
    deviceId: z.string().min(1).max(200).optional(),
    channelId: z.string().min(1).max(200).optional(),
    status: z.enum(["sent", "failed"]).optional(),
    from: timestampString.optional(),
    to: timestampString.optional(),
  })
  .superRefine(rejectInvertedWindow);
// Alert acknowledgement. `eventKey` is assembled server-side from these two —
// deviceId can contain arbitrary vendor characters, so it never goes into a path segment.
// The comment is optional operator context, length-bounded like other free text.
const alertRefSchema = {
  deviceId: z.string().min(1).max(200),
  alertId: z.string().min(1).max(200),
};

export const alertAckSchema = z.object({
  ...alertRefSchema,
  comment: z.string().max(500).optional(),
});

export const alertUnackSchema = z.object(alertRefSchema);

/**
 * Custom-role + user-group write bodies (1.6.1 RBAC). `capabilities` is bounded to the known set
 * (the `RbacService` orders/dedupes); `roleIds` reference custom roles (existence is a runtime
 * check in the service, not something a static schema can assert). Free text is length-bounded.
 */
const capabilitySchema = z.enum(CAPABILITIES);

export const rbacRoleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  capabilities: z.array(capabilitySchema).max(CAPABILITIES.length),
});

export const rbacGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  roleIds: z.array(z.string().min(1).max(200)).max(200),
  memberUsernames: z.array(z.string().trim().min(1).max(200)).max(1000),
});
