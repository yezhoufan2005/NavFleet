import pino from "pino";
import { config } from "../config";
import type { Persistence } from "../persistence";
import type { PublicUser, UserRecord } from "../types";
import { hashPassword, verifyPassword } from "./passwords";

const logger = pino({ name: "auth" });

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
    if (!config.jwtSecret) {
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
      password = "admin123";
      logger.warn(
        { username: config.adminUsername },
        "ADMIN_PASSWORD not set — seeding a default admin with password 'admin123'. Change it immediately via ADMIN_PASSWORD.",
      );
    }

    const now = new Date().toISOString();
    await this.persistence.upsertUser({
      username: config.adminUsername,
      passwordHash: await hashPassword(password),
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
    logger.info({ username: config.adminUsername }, "Seeded administrator account");
  }

  async authenticate(username: string, password: string): Promise<UserRecord | null> {
    const user = await this.persistence.findUserByUsername(username);
    if (!user) {
      return null;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? user : null;
  }

  findByUsername(username: string): Promise<UserRecord | null> {
    return this.persistence.findUserByUsername(username);
  }
}
