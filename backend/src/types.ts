/**
 * Backend domain types.
 *
 * The contracts **shared with the frontend** live in `@navfleet/shared` (the single
 * source of truth) and are re-exported here so existing `./types` imports keep working.
 * Types that only this process has any use for are declared below.
 */
import type { AuditAction, UserRole } from "@navfleet/shared";

export type * from "@navfleet/shared";

/**
 * One row of the `users` collection.
 *
 * Backend-only on purpose, and it did not start that way: this sat in `@navfleet/shared`
 * between `UserRole` and `PublicUser`, in a package whose own header describes it as the
 * model "shared between the backend and the frontend" — while no frontend file has ever
 * imported it. Nothing leaked, because the package is consumed type-only; what a
 * `passwordHash` field does from over there is invite the next person to plumb the stored
 * shape into a component. `persistence.ts` reads and writes this, and `auth/service.ts`
 * narrows it to `PublicUser` before it can reach a response body.
 */
export interface UserRecord {
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
  /**
   * Fields added by schema migration v2. Existing 1.1.0/1.2.0-pre rows are
   * backfilled by the migration; the in-memory fallback and every write path produce the
   * full shape so a Mongo-less dev run behaves identically.
   */
  /** A disabled account cannot authenticate; enforced per request, so disabling is immediate. */
  enabled: boolean;
  /**
   * Bumped on logout and password change. A token carries the version it was minted at; the
   * auth middleware rejects any token whose version no longer matches. This is what makes
   * "log out" and "change password" invalidate already-issued tokens instead of waiting for
   * them to expire — at the cost of being per-user, so a bump ends every session that user has.
   */
  tokenVersion: number;
  displayName: string;
  email: string | null;
  phone: string | null;
  lastLoginAt: string | null;
  passwordUpdatedAt: string;
  /**
   * Account-level login lockout, backfilled by migration v3. `failedAttempts`
   * counts consecutive failures since the last success; when it reaches `AUTH_LOCK_THRESHOLD`
   * the account is locked until `lockedUntil` (ISO-8601), after which the counter resets on
   * the next attempt. Orthogonal to the per-IP rate limit: this stops one account being
   * brute-forced from many addresses, the limiter stops one address hammering many accounts.
   */
  failedAttempts: number;
  lockedUntil: string | null;
  /**
   * A kiosk account: an unattended wall display's read-only credential. Always
   * `role: "viewer"` (read-only by RBAC), but given a much longer refresh horizon
   * (`KIOSK_REFRESH_TTL`) so the screen stays logged in for months, and tagged here so the audit
   * trail and admin UI can tell it apart from a person. Optional/absent = a normal account (no
   * migration needed: absence means "not a kiosk"). Revocation is unchanged — a kiosk is still
   * subject to `tokenVersion`, session liveness and short access-token TTL.
   */
  kiosk?: boolean;
}

/**
 * One row of the `sessions` collection: a single login, tracked per device so a
 * user can see and revoke their active sessions and an admin can force-log-out an account.
 *
 * A login mints one `sessionId`, carried as the `sid` claim on both that login's access and
 * refresh tokens; a refresh keeps the same `sid` (same session, renewed). The per-request auth
 * check requires the token's `sid` to still name a live row here — deleting the row (logout,
 * self-revoke, force-logout) invalidates every token that names it, at the cost of one indexed
 * lookup per authenticated request (the same trade-off `tokenVersion` already makes).
 *
 * `expiresAt` is a BSON Date carrying a TTL index (expireAfterSeconds: 0), so a session that is
 * never refreshed disappears on its own at the refresh-token horizon; a refresh pushes it out.
 */
export interface SessionRecord {
  sessionId: string;
  username: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
  expiresAt: Date;
}

/** A session as returned to its owner — `expiresAt` serialised, plus whether it is the caller's current one. */
export interface SessionView {
  sessionId: string;
  username: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
  current: boolean;
}

/**
 * A user as returned by the admin API — `UserRecord` minus `passwordHash`. Declared as an
 * explicit `Omit` (not an ad-hoc object) so that if a future field is added to `UserRecord`
 * it shows up here automatically, while the one field that must never reach a response body
 * stays excluded by construction.
 */
export type AdminUserView = Omit<UserRecord, "passwordHash">;

// The auditable-action tuple lives in shared so the console's 审计 labels are typed against it too.
export { AUDIT_ACTIONS, type AuditAction } from "@navfleet/shared";

/** One row of the `audit_log` collection. `ts` is a BSON Date so the TTL index can expire it. */
export interface AuditEntry {
  ts: Date;
  actor: string;
  action: AuditAction;
  target?: string;
  outcome: "success" | "failure";
  requestId?: string;
  detail?: Record<string, unknown>;
}
