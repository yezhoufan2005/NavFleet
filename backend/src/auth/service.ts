import { config } from "../config";
import type { Persistence } from "../persistence";
import type { PublicUser, UserRecord } from "../types";
import { hashPassword, verifyPassword } from "./passwords";
import { moduleLogger } from "../logger";

const logger = moduleLogger("auth");

export const toPublicUser = (user: UserRecord): PublicUser => ({
  username: user.username,
  role: user.role,
});

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
    });
    logger.info({ username: config.adminUsername }, "Seeded administrator account");
  }

  async authenticate(username: string, password: string): Promise<UserRecord | null> {
    const user = await this.persistence.findUserByUsername(username);
    if (!user || !user.enabled) {
      return null;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? user : null;
  }

  findByUsername(username: string): Promise<UserRecord | null> {
    return this.persistence.findUserByUsername(username);
  }

  /** Record a successful login timestamp (best-effort). */
  recordLogin(username: string): Promise<void> {
    return this.persistence.recordLogin(username, new Date().toISOString());
  }

  /** End every session for a user by bumping its token version (logout). */
  invalidateSessions(username: string): Promise<void> {
    return this.persistence.bumpTokenVersion(username, new Date().toISOString());
  }

  /**
   * Change a user's own password: verify the old one, then store the new hash and bump the
   * token version so all existing sessions are invalidated. Returns the refreshed user (with
   * the new `tokenVersion`) on success, or null when the old password is wrong — the caller
   * re-issues that user's cookies so the initiating session survives.
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
    return this.persistence.findUserByUsername(username);
  }
}
