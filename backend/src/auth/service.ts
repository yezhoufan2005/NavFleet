import { config } from "../config";
import type { Persistence } from "../persistence";
import type { AdminUserView, PublicUser, SessionRecord, UserRecord, UserRole } from "../types";
import { hashPassword, verifyPassword } from "./passwords";
import { durationToMs } from "./tokens";
import { moduleLogger } from "../logger";

const logger = moduleLogger("auth");

export const toPublicUser = (user: UserRecord): PublicUser => ({
  username: user.username,
  role: user.role,
});

/** Strip `passwordHash` before a user record can reach a response body. */
export const toAdminUserView = ({
  passwordHash: _passwordHash,
  ...view
}: UserRecord): AdminUserView => view;

/** Why an admin action was refused, mapped to an HTTP status by the route. */
export type AdminActionError = "not_found" | "conflict" | "last_admin" | "self_forbidden";

export type AdminActionResult<T> = { ok: true; value: T } | { ok: false; error: AdminActionError };

/**
 * The result of a login attempt. `lockedJustNow` distinguishes the failing attempt that *tripped*
 * a lockout (its own auditable event) from an ordinary bad password — the route never reveals
 * either to the client, but must audit them differently.
 */
export type AuthResult = { ok: true; user: UserRecord } | { ok: false; lockedJustNow: boolean };

/** Input a route supplies to start tracking a login session; the service stamps the timestamps. */
export interface CreateSessionInput {
  sessionId: string;
  username: string;
  userAgent: string;
  ip: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
  displayName?: string;
  email?: string | null;
  phone?: string | null;
  /** Mint as a kiosk account (Phase 17C): long-lived read-only wall credential. Route enforces viewer. */
  kiosk?: boolean;
}

export interface UpdateUserInput {
  role?: UserRole;
  displayName?: string;
  email?: string | null;
  phone?: string | null;
  enabled?: boolean;
}

export class AuthService {
  constructor(private readonly persistence: Persistence) {}

  /**
   * Seed the initial administrator from ADMIN_USERNAME/ADMIN_PASSWORD. Runs on
   * startup and is idempotent: it upserts the admin's password so operators can
   * rotate it via env. When ADMIN_PASSWORD is unset and no users exist yet, a
   * dev-only default is used and a prominent warning is logged.
   */
  async initialize(): Promise<void> {
    if (!config.authEnabled) {
      logger.warn("AUTH_ENABLED=false — all API and WebSocket access is unauthenticated");
      return;
    }
    const isProduction = config.nodeEnv === "production";
    if (!config.jwtSecret) {
      if (isProduction) {
        throw new Error(
          "JWT_SECRET is required in production (NODE_ENV=production). Set a long random value.",
        );
      }
      logger.warn(
        "JWT_SECRET is not set; using an ephemeral secret. Tokens are invalidated on restart. Set JWT_SECRET in production.",
      );
    }

    let password = config.adminPassword;
    if (!password) {
      const existing = await this.persistence.countUsers();
      if (existing > 0) {
        return;
      }
      if (isProduction) {
        logger.error(
          { username: config.adminUsername },
          "ADMIN_PASSWORD not set in production — refusing to seed a default administrator. Set ADMIN_PASSWORD and restart.",
        );
        return;
      }
      password = "admin123";
      logger.warn(
        { username: config.adminUsername },
        "ADMIN_PASSWORD not set — seeding a dev-only admin with password 'admin123'. Change it immediately via ADMIN_PASSWORD.",
      );
    }

    const now = new Date().toISOString();
    await this.persistence.upsertUser({
      username: config.adminUsername,
      passwordHash: await hashPassword(password),
      role: "admin",
      createdAt: now,
      updatedAt: now,
      enabled: true,
      tokenVersion: 0,
      displayName: config.adminUsername,
      email: null,
      phone: null,
      lastLoginAt: null,
      passwordUpdatedAt: now,
      failedAttempts: 0,
      lockedUntil: null,
    });
    logger.info({ username: config.adminUsername }, "Seeded administrator account");
  }

  /**
   * Verify a credential, enforcing account-level lockout (Phase 15E). A locked account is
   * refused before the password is even checked, and without revealing that it is locked
   * (the route answers an identical 401 either way). A wrong password advances the failure
   * counter and, at `AUTH_LOCK_THRESHOLD`, sets `lockedUntil`; the counter resets once the
   * lock has expired, so a single stray attempt after expiry does not immediately re-lock.
   * A correct password clears any accumulated failures.
   */
  async authenticate(username: string, password: string): Promise<AuthResult> {
    const user = await this.persistence.findUserByUsername(username);
    if (!user || !user.enabled) {
      return { ok: false, lockedJustNow: false };
    }
    const now = Date.now();
    const lockedUntilMs = user.lockedUntil ? Date.parse(user.lockedUntil) : 0;
    if (lockedUntilMs > now) {
      return { ok: false, lockedJustNow: false };
    }
    const at = new Date().toISOString();
    const ok = await verifyPassword(password, user.passwordHash);
    if (ok) {
      if (user.failedAttempts > 0 || user.lockedUntil) {
        await this.persistence.clearLoginFailures(username, at);
        return { ok: true, user: { ...user, failedAttempts: 0, lockedUntil: null } };
      }
      return { ok: true, user };
    }
    // A wrong password. If the previous lock has expired, the counter starts fresh.
    const base = lockedUntilMs > 0 && lockedUntilMs <= now ? 0 : user.failedAttempts;
    const failedAttempts = base + 1;
    if (failedAttempts >= config.authLockThreshold) {
      const lockedUntil = new Date(now + config.authLockWindowMs).toISOString();
      await this.persistence.setLoginFailure(username, failedAttempts, lockedUntil, at);
      return { ok: false, lockedJustNow: true };
    }
    await this.persistence.setLoginFailure(username, failedAttempts, null, at);
    return { ok: false, lockedJustNow: false };
  }

  findByUsername(username: string): Promise<UserRecord | null> {
    return this.persistence.findUserByUsername(username);
  }

  /** Record a successful login timestamp (best-effort). */
  recordLogin(username: string): Promise<void> {
    return this.persistence.recordLogin(username, new Date().toISOString());
  }

  // ── Sessions (Phase 15E) ────────────────────────────────────────────────────────

  /**
   * The refresh-token horizon in ms — the lifetime a session gets before it must be touched.
   * A kiosk account (Phase 17C) gets the much longer `kioskRefreshTtl` so an unattended wall
   * screen is not logged out after a week; everyone else gets the normal refresh horizon.
   */
  private sessionLifetimeMs(kiosk = false): number {
    const ttl = kiosk ? config.kioskRefreshTtl : config.jwtRefreshTtl;
    return durationToMs(ttl) || 7 * 86_400_000;
  }

  /** Start tracking a login session, stamped now and expiring at the (kiosk-aware) refresh horizon. */
  createSession(input: CreateSessionInput, kiosk = false): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    const session: SessionRecord = {
      ...input,
      createdAt: nowIso,
      lastSeenAt: nowIso,
      expiresAt: new Date(now.getTime() + this.sessionLifetimeMs(kiosk)),
    };
    return this.persistence.createSession(session);
  }

  /** Mark a session seen and push its expiry out (on refresh), honouring the kiosk horizon. */
  touchSession(sessionId: string, kiosk = false): Promise<void> {
    const now = new Date();
    return this.persistence.touchSession(
      sessionId,
      now.toISOString(),
      new Date(now.getTime() + this.sessionLifetimeMs(kiosk)),
    );
  }

  isSessionActive(username: string, sessionId: string): Promise<boolean> {
    return this.persistence.isSessionActive(username, sessionId);
  }

  listSessions(username: string): Promise<SessionRecord[]> {
    return this.persistence.listSessions(username);
  }

  /** Revoke one of a user's own sessions (self-service logout of a device). */
  revokeSession(username: string, sessionId: string): Promise<boolean> {
    return this.persistence.deleteSession(username, sessionId);
  }

  /**
   * End every session for a user, on all devices: drop the session rows *and* bump
   * `tokenVersion` (belt and braces — the version bump also kills any legacy sid-less token).
   * Used by admin force-logout and by the all-devices invalidation that a password change,
   * disable or role change triggers.
   */
  async revokeAllSessions(username: string): Promise<void> {
    await this.persistence.deleteAllSessions(username);
    await this.persistence.bumpTokenVersion(username, new Date().toISOString());
  }

  /**
   * Change a user's own password: verify the old one, store the new hash, bump the token
   * version, and drop every session (all devices). Returns the refreshed user on success, or
   * null when the old password is wrong — the caller re-establishes this device's session and
   * re-issues its cookies so the initiating session survives.
   */
  async changePassword(
    username: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<UserRecord | null> {
    const user = await this.persistence.findUserByUsername(username);
    if (!user || !user.enabled) {
      return null;
    }
    const ok = await verifyPassword(oldPassword, user.passwordHash);
    if (!ok) {
      return null;
    }
    const hash = await hashPassword(newPassword);
    await this.persistence.setPasswordAndInvalidate(username, hash, new Date().toISOString());
    await this.persistence.deleteAllSessions(username);
    return this.persistence.findUserByUsername(username);
  }

  // ── Admin user management (15B-2) ──────────────────────────────────────────────
  // All of these assume the caller is already gated to admin by `requireRole` at the route.

  async listUsers(): Promise<AdminUserView[]> {
    const users = await this.persistence.listUsers();
    return users.map(toAdminUserView);
  }

  async getUser(username: string): Promise<AdminUserView | null> {
    const user = await this.persistence.findUserByUsername(username);
    return user ? toAdminUserView(user) : null;
  }

  async createUser(input: CreateUserInput): Promise<AdminActionResult<AdminUserView>> {
    const now = new Date().toISOString();
    const record: UserRecord = {
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      createdAt: now,
      updatedAt: now,
      enabled: true,
      tokenVersion: 0,
      displayName: input.displayName ?? input.username,
      email: input.email ?? null,
      phone: input.phone ?? null,
      lastLoginAt: null,
      passwordUpdatedAt: now,
      failedAttempts: 0,
      lockedUntil: null,
      // Only ever true for a viewer (the route/schema enforce it); absent for a normal account.
      ...(input.kiosk ? { kiosk: true } : {}),
    };
    const created = await this.persistence.createUser(record);
    if (!created) {
      return { ok: false, error: "conflict" };
    }
    return { ok: true, value: toAdminUserView(record) };
  }

  /**
   * Update a user's profile. Guards against lockout: an action that removes an admin's power
   * (disabling, or demoting away from admin) is refused when the target is the caller
   * (`self_forbidden`) or the last enabled admin (`last_admin`). A role change or a disable
   * bumps `tokenVersion` so it takes effect on already-issued tokens immediately.
   */
  async updateUser(
    actor: string,
    username: string,
    fields: UpdateUserInput,
  ): Promise<AdminActionResult<AdminUserView>> {
    const target = await this.persistence.findUserByUsername(username);
    if (!target) {
      return { ok: false, error: "not_found" };
    }

    const demotes = fields.role !== undefined && fields.role !== "admin" && target.role === "admin";
    const disables = fields.enabled === false && target.enabled;
    if (demotes || disables) {
      const guard = await this.guardAdminPower(actor, target);
      if (guard) {
        return { ok: false, error: guard };
      }
    }

    const at = new Date().toISOString();
    await this.persistence.updateUserFields(username, fields, at);
    // Role change or disable must reach already-issued tokens now, not at expiry — bump the
    // version and drop the user's sessions (all devices), the same all-devices semantics a
    // password change uses.
    if ((fields.role !== undefined && fields.role !== target.role) || fields.enabled === false) {
      await this.persistence.bumpTokenVersion(username, at);
      await this.persistence.deleteAllSessions(username);
    }
    const updated = await this.persistence.findUserByUsername(username);
    return { ok: true, value: toAdminUserView(updated ?? { ...target, ...fields }) };
  }

  async resetPassword(
    username: string,
    newPassword: string,
  ): Promise<AdminActionResult<AdminUserView>> {
    const target = await this.persistence.findUserByUsername(username);
    if (!target) {
      return { ok: false, error: "not_found" };
    }
    const hash = await hashPassword(newPassword);
    await this.persistence.setPasswordAndInvalidate(username, hash, new Date().toISOString());
    // A reset invalidates the user everywhere: bump already dropped their tokens, now drop the
    // session rows too so nothing stale lingers in their session list.
    await this.persistence.deleteAllSessions(username);
    const updated = await this.persistence.findUserByUsername(username);
    return { ok: true, value: toAdminUserView(updated ?? target) };
  }

  /** Force-log-out a user from every device (admin). Returns not_found for an unknown user. */
  async forceLogout(username: string): Promise<AdminActionResult<void>> {
    const target = await this.persistence.findUserByUsername(username);
    if (!target) {
      return { ok: false, error: "not_found" };
    }
    await this.revokeAllSessions(username);
    return { ok: true, value: undefined };
  }

  async deleteUser(actor: string, username: string): Promise<AdminActionResult<void>> {
    const target = await this.persistence.findUserByUsername(username);
    if (!target) {
      return { ok: false, error: "not_found" };
    }
    // Deleting an enabled admin removes their power — same lockout guard as disable/demote.
    if (target.role === "admin" && target.enabled) {
      const guard = await this.guardAdminPower(actor, target);
      if (guard) {
        return { ok: false, error: guard };
      }
    }
    await this.persistence.deleteUser(username);
    return { ok: true, value: undefined };
  }

  /**
   * Returns the reason an admin-power-removing action must be refused, or null if it is safe:
   * you cannot lock yourself out, and you cannot remove the last enabled admin.
   */
  private async guardAdminPower(
    actor: string,
    target: UserRecord,
  ): Promise<"self_forbidden" | "last_admin" | null> {
    if (actor === target.username) {
      return "self_forbidden";
    }
    const enabledAdmins = await this.persistence.countEnabledAdmins();
    if (enabledAdmins <= 1) {
      return "last_admin";
    }
    return null;
  }
}
