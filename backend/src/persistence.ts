import { Db, MongoClient, MongoServerError, type MongoClientEvents } from "mongodb";
import { config } from "./config";
import { emptyAlertStatsReport, emptyAvailabilityReport } from "@navfleet/shared";
import { MongoConnectionSupervisor, type MongoSession, redactMongoUri } from "./mongoConnection";
import {
  AlertStatsReport,
  AuditEntry,
  AvailabilityReport,
  DeviceAlert,
  DeviceSnapshot,
  HistoryQuery,
  NotifySendRecord,
  ReportBucketUnit,
  SessionRecord,
  UserRecord,
} from "./types";
import {
  buildAlertStatsPipeline,
  mapAlertStatsFacet,
  type AlertStatsFacet,
} from "./reports/alertStatsPipeline";
import {
  buildAvailabilityPipeline,
  mapAvailabilityRows,
  type AvailabilityRow,
} from "./reports/availabilityPipeline";
import { moduleLogger } from "./logger";
import { asText } from "./normalize";
import { runMigrations } from "./migrations/runner";
import { reconcileTtls } from "./migrations/ttl";
import { MigrationError, type Migration } from "./migrations/types";

const logger = moduleLogger("persistence");

interface TelemetryDocument {
  ts: Date;
  meta: {
    deviceId: string;
    fleetId: string;
    vehicleModel: string;
  };
  measurements: {
    online: boolean;
    stamp: string;
    sceneId: string;
    runtimeSceneId: string;
    defaultSceneId: string;
    gps: DeviceSnapshot["gps"];
    fusionLoc: DeviceSnapshot["fusionLoc"];
    lidarLoc: DeviceSnapshot["lidarLoc"];
    vehicleInfo: DeviceSnapshot["vehicleInfo"];
    taskStatus: DeviceSnapshot["taskStatus"];
    platformTaskStatus: DeviceSnapshot["platformTaskStatus"];
    infoCode: DeviceSnapshot["infoCode"];
    warningCode: DeviceSnapshot["warningCode"];
    errorCode: DeviceSnapshot["errorCode"];
    speedLimit: DeviceSnapshot["speedLimit"];
    extra: Record<string, unknown>;
  };
}

/**
 * Coerce a history bound to a Date. Accepts ISO-8601 strings and numeric epoch
 * values (seconds or milliseconds), matching what the query schema advertises.
 * Returns null for unparseable input so callers can skip the bound.
 */
const toBoundDate = (value: string | undefined): Date | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const epoch = Number(trimmed);
    return new Date(epoch < 1e12 ? epoch * 1000 : epoch);
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/** Projected alert shape returned by /api/alerts (kept identical across the
 * MongoDB and in-memory fallback paths, and mirrored by the OpenAPI schema). */
interface StoredAlert {
  eventKey: string;
  deviceId: string;
  alertId: string;
  severity: string;
  title: string;
  detail: string;
  source: string;
  code: number | null;
  info: string;
  ts: string;
  active: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  // When the alert cleared (active→false), or null while it is still active. Written only on
  // the clear path in Mongo; the in-memory mirror holds active alerts only, so it is always
  // null there. Declared here to match the OpenAPI Alert schema, which already carries it.
  clearedAt: string | null;
  // Acknowledgement (Phase 16A). null until an operator+ confirms the occurrence;
  // cleared back to null when the alert clears, because a re-fire is a new occurrence.
  ackedBy: string | null;
  ackedAt: string | null;
  comment: string | null;
}

/**
 * Most alerts `GET /api/alerts` will return in one response.
 *
 * One constant because there are two query paths — the MongoDB one and the in-memory
 * fallback — and the contract they publish has to be the same number. It was written as a
 * bare `500` in each, so the fallback's page size was coupled to the primary path's by
 * nothing but coincidence, and the OpenAPI description of the endpoint could only ever
 * quote one of them.
 *
 * Not an env var, unlike `MAX_HISTORY_POINTS`: history is what a deployment tunes for its
 * retention window, whereas this is a response-size guard on an endpoint the console reads
 * in fixed pages of 20.
 */
const MAX_ALERTS_PER_QUERY = 500;

/** Most audit rows one `GET /api/audit` returns; the in-memory fallback ring is bounded to it too. */
const MAX_AUDIT_PER_QUERY = 500;

/** Most notify-send rows one `GET /api/notify/log` returns; the in-memory fallback ring is bounded to it too. */
const MAX_NOTIFY_PER_QUERY = 500;

/** How many devices the alert-stats Top-N ranking keeps (Phase 17A). Matches 16B's client-side default. */
const ALERT_STATS_TOP_N = 8;

export class Persistence {
  private db: Db | null = null;
  private pendingTelemetry: TelemetryDocument[] = [];
  /**
   * How many buffered telemetry documents have been dropped because the buffer was
   * full. P0-c: the overflow used to `splice` the oldest away silently, so a monitoring
   * platform lost data with **no counter anywhere** — the one loss a monitoring platform
   * must never take quietly. Exposed on `/metrics` and in the buffer's own warn line.
   */
  private droppedTelemetry = 0;
  // Bounded in-memory telemetry ring buffer, kept per device so history playback
  // and the /history endpoint work in local/dev runs where MongoDB is absent
  // (fulfils the "in-memory history fallback" the connect path already advertises).
  private telemetryBuffer = new Map<string, TelemetryDocument[]>();
  // In-memory user store used when MongoDB is unavailable, so auth still works
  // for local/dev runs (mirrors the telemetry in-memory fallback).
  private fallbackUsers = new Map<string, UserRecord>();
  // In-memory session store for Mongo-less dev runs (mirrors the user fallback), keyed by
  // sessionId. A dev run without Mongo still tracks and revokes per-device sessions.
  private fallbackSessions = new Map<string, SessionRecord>();
  // Current active alerts per device, always kept in memory so /api/alerts stays
  // useful in local/dev runs without MongoDB (mirrors the telemetry fallback).
  private activeAlerts = new Map<string, StoredAlert[]>();
  // Bounded in-memory audit trail for Mongo-less dev runs (mirrors the other fallbacks).
  private auditFallback: AuditEntry[] = [];
  // Bounded in-memory outbound-send log for Mongo-less dev runs (Phase 16D-1; mirrors the
  // audit fallback). Send records are best-effort telemetry about notifications, never on the
  // path of the action being audited, so like audit a write failure is swallowed.
  private notifyFallback: NotifySendRecord[] = [];
  // Schema migrations run at most once per process, on the first connect that has a live
  // db. This flag makes reconnects skip them, and `migrationFailure` carries a migration
  // that *errored* so the composition root can refuse to start — kept distinct from a plain
  // "MongoDB unreachable", which stays a degrade-and-retry, not a fatal.
  private migrationsApplied = false;
  private migrationFailure: MigrationError | null = null;
  // Owns connect/retry and the authoritative connectivity flag; constructing it
  // starts nothing, so `new Persistence()` stays side-effect free.
  private readonly mongo = new MongoConnectionSupervisor({
    open: () => this.openMongoSession(),
    logger,
    // Never log config.mongoUri directly: it embeds the password.
    logContext: { db: config.mongoDbName, uri: redactMongoUri(config.mongoUri) },
  });

  async connect(): Promise<void> {
    await this.mongo.start();
  }

  /**
   * Attach a MongoDB handle directly. **Tests only** — production publishes `this.db`
   * from `openMongoSession()`.
   *
   * Why a seam and not a real MongoDB in CI: nearly every method here is a two-branch
   * function — `if (!this.db)` takes the in-memory fallback, otherwise the driver — and
   * only the fallback branch was ever executed by a test. That is what left this file at
   * **47% statements / 72% functions**, and the untested half is the half that runs in
   * production. A fake `Db` reaches it without adding a service to CI, and the questions
   * worth asking are about the *queries* (does the alert-clearing `$nin` name the right
   * set? does a failed flush put the documents back?), which a fake answers exactly as
   * well as a server would.
   *
   * The `__` prefix is the house marker for a test seam (see the console's
   * `dead-exports` gate, which recognises it by that prefix).
   */
  __setDbForTests(db: Db | null): void {
    this.db = db;
  }

  /**
   * Release MongoDB and stop the reconnect loop. Safe to call without a prior
   * connect() and safe to call twice; used by the process shutdown path.
   */
  async close(): Promise<void> {
    await this.mongo.stop();
  }

  /**
   * Open one MongoDB connection for the supervisor. Publishes `this.db` (so the
   * data paths leave the in-memory fallback) and re-runs the index/TTL setup on
   * every successful (re)connect. Rejects — after cleaning up — when the server
   * is unreachable, which is what drives the backoff retry loop.
   */
  private async openMongoSession(): Promise<MongoSession> {
    const client = new MongoClient(config.mongoUri, {
      serverSelectionTimeoutMS: 3000,
    });
    try {
      await client.connect();
      this.db = client.db(config.mongoDbName);
      await this.ensureMongoCollections();
      // Run schema migrations on the first connect that has a live db. A migration that
      // *errors* rejects this session (so we never serve a half-migrated database) and is
      // recorded on `migrationFailure` for the composition root to turn into a refuse-to-
      // start. Reconnects skip it via `migrationsApplied`.
      await this.migrate();
    } catch (error) {
      this.db = null;
      await client.close().catch(() => undefined);
      throw error;
    }

    return {
      onEvent: (event, listener) => {
        // Compile-time guard: the supervised event names must stay a subset of
        // the events this driver version emits (the driver exposes no runtime
        // list). A typo or a rename fails `npm run typecheck` here instead of
        // silently freezing the connectivity flag at its last value.
        const clientEvent: keyof MongoClientEvents = event;
        client.on(clientEvent, listener);
      },
      close: async () => {
        // Back to the in-memory fallback for as long as there is no client.
        this.db = null;
        await client.close();
      },
    };
  }

  private async ensureMongoCollections(): Promise<void> {
    if (!this.db) {
      return;
    }

    const existing = await this.db.listCollections().toArray();
    const names = new Set(existing.map((item) => item.name));

    if (!names.has("telemetry_ts")) {
      await this.db.createCollection("telemetry_ts", {
        timeseries: {
          timeField: "ts",
          metaField: "meta",
          granularity: "seconds",
        },
        expireAfterSeconds: config.telemetryRetentionSeconds,
      });
    }

    if (!names.has("device_latest")) {
      await this.db.createCollection("device_latest");
    }
    if (!names.has("alerts")) {
      await this.db.createCollection("alerts");
    }
    if (!names.has("users")) {
      await this.db.createCollection("users");
    }
    if (!names.has("audit_log")) {
      await this.db.createCollection("audit_log");
    }
    if (!names.has("notify_log")) {
      await this.db.createCollection("notify_log");
    }
    if (!names.has("sessions")) {
      await this.db.createCollection("sessions");
    }

    await this.db.collection("device_latest").createIndex({ deviceId: 1 }, { unique: true });
    await this.db.collection("device_latest").createIndex({ stamp: -1 });
    await this.db.collection("alerts").createIndex({ deviceId: 1, ts: -1 });
    await this.db.collection("alerts").createIndex({ severity: 1, active: 1, ts: -1 });
    await this.db
      .collection("alerts")
      .createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: config.alertsRetentionSeconds });
    await this.db.collection("users").createIndex({ username: 1 }, { unique: true });
    await this.db.collection("audit_log").createIndex({ actor: 1, ts: -1 });
    await this.db.collection("audit_log").createIndex({ action: 1, ts: -1 });
    await this.db
      .collection("audit_log")
      .createIndex({ ts: -1 }, { expireAfterSeconds: config.auditRetentionSeconds });
    // notify_log (Phase 16D-1): send records queried by device / channel / status, newest first.
    // TTL is on a dedicated BSON Date (`expireAt`) rather than the display `ts` (an ISO string,
    // which a TTL index would silently never expire); the retention window is the alerts one,
    // since a send record is only meaningful next to the alert that triggered it.
    await this.db.collection("notify_log").createIndex({ deviceId: 1, ts: -1 });
    await this.db.collection("notify_log").createIndex({ channelId: 1, ts: -1 });
    await this.db.collection("notify_log").createIndex({ status: 1, ts: -1 });
    await this.db
      .collection("notify_log")
      .createIndex({ expireAt: 1 }, { expireAfterSeconds: config.alertsRetentionSeconds });
    await this.db.collection("sessions").createIndex({ sessionId: 1 }, { unique: true });
    await this.db.collection("sessions").createIndex({ username: 1, createdAt: -1 });
    // TTL on the session's own expiry timestamp: a session never refreshed disappears at the
    // refresh horizon on its own, and each refresh pushes `expiresAt` out. `expireAfterSeconds:
    // 0` is the "expire at the date in this field" idiom, so there is no config-driven window to
    // reconcile — the window lives in `expiresAt`, computed from JWT_REFRESH_TTL at write time.
    await this.db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

    // Reconcile TTLs on an existing database, not just at creation: both retention windows
    // are env-configurable, but the `expireAfterSeconds` was only ever set in the create
    // branch above, so on any database that already had the collections a retention change
    // silently did nothing. See `reconcileTtls`.
    await reconcileTtls(this.db, config, logger);
  }

  /**
   * Run schema migrations once per process. No-op without a live db (the degraded/in-memory
   * path — migrations run instead on the first connect that has one) or once already applied.
   * A {@link MigrationError} is recorded on `migrationFailure` and rethrown; a plain
   * connection error is left to the supervisor's backoff.
   *
   * `list` is injectable for tests (symmetric with `runMigrations`); production omits it and
   * gets the real, load-time-validated list.
   */
  async migrate(list?: readonly Migration[]): Promise<void> {
    if (!this.db || this.migrationsApplied) {
      return;
    }
    try {
      await runMigrations(this.db, logger, list);
      this.migrationsApplied = true;
    } catch (error) {
      if (error instanceof MigrationError) {
        this.migrationFailure = error;
      }
      throw error;
    }
  }

  /**
   * A migration that errored, or null. The composition root checks this after connect() and
   * refuses to start if set — a half-migrated schema must not be served.
   */
  get migrationError(): MigrationError | null {
    return this.migrationFailure;
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    if (!this.db) {
      return this.fallbackUsers.get(username) ?? null;
    }
    return this.db
      .collection<UserRecord>("users")
      .findOne({ username }, { projection: { _id: 0 } });
  }

  async upsertUser(user: UserRecord): Promise<void> {
    if (!this.db) {
      this.fallbackUsers.set(user.username, user);
      return;
    }
    await this.db.collection<UserRecord>("users").updateOne(
      { username: user.username },
      {
        // Only the credential/role fields are refreshed on an existing row: this path is
        // the startup admin seed, which re-runs on every boot when ADMIN_PASSWORD is set.
        // `tokenVersion` and `enabled` are deliberately left to `$setOnInsert` so a restart
        // does not bump the version (which would log the admin out every boot) or re-enable
        // a deliberately disabled account. Real password changes go through
        // `setPasswordAndInvalidate`, which does bump the version.
        $set: {
          passwordHash: user.passwordHash,
          role: user.role,
          updatedAt: user.updatedAt,
        },
        $setOnInsert: {
          username: user.username,
          createdAt: user.createdAt,
          enabled: user.enabled,
          tokenVersion: user.tokenVersion,
          displayName: user.displayName,
          email: user.email,
          phone: user.phone,
          lastLoginAt: user.lastLoginAt,
          passwordUpdatedAt: user.passwordUpdatedAt,
          failedAttempts: user.failedAttempts,
          lockedUntil: user.lockedUntil,
        },
      },
      { upsert: true },
    );
  }

  async countUsers(): Promise<number> {
    if (!this.db) {
      return this.fallbackUsers.size;
    }
    return this.db.collection("users").countDocuments();
  }

  /** Every user, projected without `_id` (callers strip `passwordHash` for responses). */
  async listUsers(): Promise<UserRecord[]> {
    if (!this.db) {
      return [...this.fallbackUsers.values()];
    }
    return this.db
      .collection<UserRecord>("users")
      .find({}, { projection: { _id: 0 } })
      .sort({ username: 1 })
      .toArray();
  }

  /** Insert a new user. Returns false if the username already exists (unique index / fallback). */
  async createUser(user: UserRecord): Promise<boolean> {
    if (!this.db) {
      if (this.fallbackUsers.has(user.username)) {
        return false;
      }
      this.fallbackUsers.set(user.username, user);
      return true;
    }
    try {
      await this.db.collection<UserRecord>("users").insertOne({ ...user });
      return true;
    } catch (error) {
      // Duplicate key on the unique `username` index means "already exists"; anything else
      // is a real failure worth surfacing.
      if (error instanceof MongoServerError && error.code === 11000) {
        return false;
      }
      throw error;
    }
  }

  /** Patch a user's mutable profile fields (never the password — that path bumps the version). */
  async updateUserFields(
    username: string,
    fields: Partial<Pick<UserRecord, "role" | "displayName" | "email" | "phone" | "enabled">>,
    at: string,
  ): Promise<void> {
    const fallback = this.fallbackUsers.get(username);
    if (fallback) {
      this.fallbackUsers.set(username, { ...fallback, ...fields, updatedAt: at });
    }
    if (!this.db) {
      return;
    }
    await this.db
      .collection<UserRecord>("users")
      .updateOne({ username }, { $set: { ...fields, updatedAt: at } });
  }

  /** Hard-delete a user. Returns false when no such user existed. */
  async deleteUser(username: string): Promise<boolean> {
    if (!this.db) {
      return this.fallbackUsers.delete(username);
    }
    const result = await this.db.collection<UserRecord>("users").deleteOne({ username });
    return result.deletedCount > 0;
  }

  /** How many enabled admins exist — the guard against locking everyone out. */
  async countEnabledAdmins(): Promise<number> {
    if (!this.db) {
      return [...this.fallbackUsers.values()].filter(
        (user) => user.role === "admin" && user.enabled,
      ).length;
    }
    return this.db.collection("users").countDocuments({ role: "admin", enabled: true });
  }

  /**
   * Set a new password hash and **invalidate every existing token** for the user by bumping
   * `tokenVersion`. Used by the change-password flow (and, later, admin reset). The caller is
   * responsible for re-issuing that user's own cookies if it wants them to stay signed in.
   */
  async setPasswordAndInvalidate(
    username: string,
    passwordHash: string,
    at: string,
  ): Promise<void> {
    const fallback = this.fallbackUsers.get(username);
    if (fallback) {
      this.fallbackUsers.set(username, {
        ...fallback,
        passwordHash,
        passwordUpdatedAt: at,
        updatedAt: at,
        tokenVersion: fallback.tokenVersion + 1,
      });
    }
    if (!this.db) {
      return;
    }
    await this.db
      .collection<UserRecord>("users")
      .updateOne(
        { username },
        { $set: { passwordHash, passwordUpdatedAt: at, updatedAt: at }, $inc: { tokenVersion: 1 } },
      );
  }

  /** Bump `tokenVersion`, ending every existing session for the user (used by logout). */
  async bumpTokenVersion(username: string, at: string): Promise<void> {
    const fallback = this.fallbackUsers.get(username);
    if (fallback) {
      this.fallbackUsers.set(username, {
        ...fallback,
        updatedAt: at,
        tokenVersion: fallback.tokenVersion + 1,
      });
    }
    if (!this.db) {
      return;
    }
    await this.db
      .collection<UserRecord>("users")
      .updateOne({ username }, { $set: { updatedAt: at }, $inc: { tokenVersion: 1 } });
  }

  /** Record a successful login timestamp. Best-effort; never blocks the login response. */
  async recordLogin(username: string, at: string): Promise<void> {
    const fallback = this.fallbackUsers.get(username);
    if (fallback) {
      this.fallbackUsers.set(username, { ...fallback, lastLoginAt: at });
    }
    if (!this.db) {
      return;
    }
    await this.db
      .collection<UserRecord>("users")
      .updateOne({ username }, { $set: { lastLoginAt: at } });
  }

  /**
   * Record a failed-login count and, when the threshold trips, a lockout deadline. Written
   * together so the two never diverge. `lockedUntil` is null while below the threshold.
   */
  async setLoginFailure(
    username: string,
    failedAttempts: number,
    lockedUntil: string | null,
    at: string,
  ): Promise<void> {
    const fallback = this.fallbackUsers.get(username);
    if (fallback) {
      this.fallbackUsers.set(username, { ...fallback, failedAttempts, lockedUntil, updatedAt: at });
    }
    if (!this.db) {
      return;
    }
    await this.db
      .collection<UserRecord>("users")
      .updateOne({ username }, { $set: { failedAttempts, lockedUntil, updatedAt: at } });
  }

  /** Clear the failure counter and any lockout after a successful login. */
  async clearLoginFailures(username: string, at: string): Promise<void> {
    const fallback = this.fallbackUsers.get(username);
    if (fallback) {
      this.fallbackUsers.set(username, {
        ...fallback,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: at,
      });
    }
    if (!this.db) {
      return;
    }
    await this.db
      .collection<UserRecord>("users")
      .updateOne({ username }, { $set: { failedAttempts: 0, lockedUntil: null, updatedAt: at } });
  }

  // ── Sessions (Phase 15E) ────────────────────────────────────────────────────────
  // Per-login rows tracked so a user can see/revoke sessions and an admin can force-log-out.
  // The in-memory fallback keeps this working in a Mongo-less dev run.

  /** Create a session row for a fresh login. */
  async createSession(session: SessionRecord): Promise<void> {
    this.fallbackSessions.set(session.sessionId, session);
    if (!this.db) {
      return;
    }
    await this.db
      .collection<SessionRecord>("sessions")
      .updateOne({ sessionId: session.sessionId }, { $set: { ...session } }, { upsert: true });
  }

  /** Bump a session's `lastSeenAt` and push its `expiresAt` out (called on refresh). */
  async touchSession(sessionId: string, lastSeenAt: string, expiresAt: Date): Promise<void> {
    const fallback = this.fallbackSessions.get(sessionId);
    if (fallback) {
      this.fallbackSessions.set(sessionId, { ...fallback, lastSeenAt, expiresAt });
    }
    if (!this.db) {
      return;
    }
    await this.db
      .collection<SessionRecord>("sessions")
      .updateOne({ sessionId }, { $set: { lastSeenAt, expiresAt } });
  }

  /** Whether a live session with this id exists for the user. */
  async isSessionActive(username: string, sessionId: string): Promise<boolean> {
    if (!this.db) {
      const session = this.fallbackSessions.get(sessionId);
      return !!session && session.username === username && session.expiresAt.getTime() > Date.now();
    }
    const count = await this.db
      .collection<SessionRecord>("sessions")
      .countDocuments({ sessionId, username });
    return count > 0;
  }

  /** List a user's sessions, newest first. */
  async listSessions(username: string): Promise<SessionRecord[]> {
    if (!this.db) {
      return [...this.fallbackSessions.values()]
        .filter((session) => session.username === username)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    }
    return this.db
      .collection<SessionRecord>("sessions")
      .find({ username }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
  }

  /** Delete one of a user's sessions. Returns false when no such session belonged to them. */
  async deleteSession(username: string, sessionId: string): Promise<boolean> {
    if (!this.db) {
      const session = this.fallbackSessions.get(sessionId);
      if (session && session.username === username) {
        this.fallbackSessions.delete(sessionId);
        return true;
      }
      return false;
    }
    const result = await this.db
      .collection<SessionRecord>("sessions")
      .deleteOne({ sessionId, username });
    return result.deletedCount > 0;
  }

  /** Delete every session for a user (logout-all / force-logout / all-devices invalidation). */
  async deleteAllSessions(username: string): Promise<void> {
    for (const [id, session] of this.fallbackSessions) {
      if (session.username === username) {
        this.fallbackSessions.delete(id);
      }
    }
    if (!this.db) {
      return;
    }
    await this.db.collection<SessionRecord>("sessions").deleteMany({ username });
  }

  /**
   * Append an audit entry. **Best-effort**: a failure to record must never turn into a failure
   * of the action being audited (auth, user management), so a write error is logged and
   * swallowed. The in-memory ring keeps dev runs queryable without Mongo.
   */
  async appendAudit(entry: AuditEntry): Promise<void> {
    if (!this.db) {
      this.auditFallback.unshift(entry);
      if (this.auditFallback.length > MAX_AUDIT_PER_QUERY) {
        this.auditFallback.length = MAX_AUDIT_PER_QUERY;
      }
      return;
    }
    try {
      await this.db.collection<AuditEntry>("audit_log").insertOne({ ...entry });
    } catch (error) {
      logger.warn({ err: error, action: entry.action }, "Failed to write audit entry");
    }
  }

  /** Query the audit trail, newest first, filtered by actor / action / time window. */
  async queryAudit(filters: {
    actor?: string;
    action?: string;
    from?: string;
    to?: string;
  }): Promise<AuditEntry[]> {
    const tsBound: Record<string, Date> = {};
    const fromDate = toBoundDate(filters.from);
    const toDate = toBoundDate(filters.to);
    if (fromDate) tsBound.$gte = fromDate;
    if (toDate) tsBound.$lte = toDate;

    if (!this.db) {
      return this.auditFallback
        .filter((entry) => !filters.actor || entry.actor === filters.actor)
        .filter((entry) => !filters.action || entry.action === filters.action)
        .filter((entry) => !fromDate || entry.ts >= fromDate)
        .filter((entry) => !toDate || entry.ts <= toDate)
        .slice(0, MAX_AUDIT_PER_QUERY);
    }

    const query: Record<string, unknown> = {};
    if (filters.actor) query.actor = filters.actor;
    if (filters.action) query.action = filters.action;
    if (Object.keys(tsBound).length > 0) query.ts = tsBound;

    return this.db
      .collection<AuditEntry>("audit_log")
      .find(query, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(MAX_AUDIT_PER_QUERY)
      .toArray();
  }

  /**
   * Append an outbound-send record (Phase 16D-1). **Best-effort**, exactly like `appendAudit`:
   * the notification pipeline runs fire-and-forget off the alert-created event and must never
   * turn a logging failure into anything the ingest path sees, so a write error is logged and
   * swallowed. The Mongo document carries a parallel `expireAt` BSON Date so the TTL index can
   * expire it; the wire shape (string `ts`) is what `queryNotify` returns.
   */
  async appendNotify(record: NotifySendRecord): Promise<void> {
    if (!this.db) {
      this.notifyFallback.unshift(record);
      if (this.notifyFallback.length > MAX_NOTIFY_PER_QUERY) {
        this.notifyFallback.length = MAX_NOTIFY_PER_QUERY;
      }
      return;
    }
    try {
      await this.db
        .collection("notify_log")
        .insertOne({ ...record, expireAt: new Date(record.ts) });
    } catch (error) {
      logger.warn(
        { err: error, channelId: record.channelId, eventKey: record.eventKey },
        "Failed to write notify-send record",
      );
    }
  }

  /** Query the outbound-send log, newest first, filtered by device / channel / status / time. */
  async queryNotify(filters: {
    deviceId?: string;
    channelId?: string;
    status?: string;
    from?: string;
    to?: string;
  }): Promise<NotifySendRecord[]> {
    const fromDate = toBoundDate(filters.from);
    const toDate = toBoundDate(filters.to);

    if (!this.db) {
      return this.notifyFallback
        .filter((record) => !filters.deviceId || record.deviceId === filters.deviceId)
        .filter((record) => !filters.channelId || record.channelId === filters.channelId)
        .filter((record) => !filters.status || record.status === filters.status)
        .filter((record) => !fromDate || Date.parse(record.ts) >= fromDate.getTime())
        .filter((record) => !toDate || Date.parse(record.ts) <= toDate.getTime())
        .slice(0, MAX_NOTIFY_PER_QUERY);
    }

    const tsBound: Record<string, string> = {};
    if (fromDate) tsBound.$gte = fromDate.toISOString();
    if (toDate) tsBound.$lte = toDate.toISOString();

    const query: Record<string, unknown> = {};
    if (filters.deviceId) query.deviceId = filters.deviceId;
    if (filters.channelId) query.channelId = filters.channelId;
    if (filters.status) query.status = filters.status;
    // `ts` is an ISO-8601 string, which compares lexicographically in timestamp order, so a
    // string range is a time range here (the same idiom `restoreLatestDevices` relies on).
    if (Object.keys(tsBound).length > 0) query.ts = tsBound;

    return this.db
      .collection<NotifySendRecord>("notify_log")
      .find(query, { projection: { _id: 0, expireAt: 0 } })
      .sort({ ts: -1 })
      .limit(MAX_NOTIFY_PER_QUERY)
      .toArray();
  }

  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    if (!this.db) {
      return [];
    }
    // P0-d: bounded on both axes. This used to be `find({})` — every row
    // `device_latest` had ever accumulated came back into memory at startup, which
    // is the same unbounded growth the eviction sweep exists to prevent, only
    // reinstated on every restart. Restoring within the retention window also means
    // nothing that comes back is immediately evictable, so there is no
    // restore-then-evict churn.
    //
    // `stamp` is stored as an ISO-8601 UTC string, and those compare
    // lexicographically in timestamp order, so a string bound is a time bound here.
    const cutoff = new Date(Date.now() - config.deviceRetentionSeconds * 1000).toISOString();
    const query = config.deviceRetentionSeconds > 0 ? { stamp: { $gte: cutoff } } : {};
    return (
      await this.db
        .collection<DeviceSnapshot>("device_latest")
        .find(query)
        .sort({ stamp: -1 })
        .limit(config.maxDevices)
        .toArray()
    ).map((item) => ({
      ...item,
      alerts: item.alerts || [],
      extra: item.extra || {},
      tags: item.tags || [],
    }));
  }

  /**
   * Release a device's in-memory footprint (P0-d). Called when the store evicts a
   * device: without this, eviction would reclaim two snapshots and leave behind the
   * much larger per-device telemetry ring (up to `MAX_HISTORY_POINTS` documents).
   *
   * Deliberately does **not** touch `pendingTelemetry`: those documents are real
   * samples on their way to MongoDB, already bounded by `MONGO_BUFFER_LIMIT`, and
   * dropping them would turn an eviction into data loss. Nothing is deleted from
   * MongoDB either — `device_latest` keeps its row, so the device returns intact if
   * it ever reports again.
   */
  forgetDevice(deviceId: string): void {
    this.telemetryBuffer.delete(deviceId);
    this.activeAlerts.delete(deviceId);
  }

  async writeLatestSnapshot(snapshot: DeviceSnapshot): Promise<void> {
    if (this.db) {
      try {
        await this.db
          .collection<DeviceSnapshot>("device_latest")
          .updateOne({ deviceId: snapshot.deviceId }, { $set: snapshot }, { upsert: true });
      } catch (error) {
        logger.warn(
          { err: error, deviceId: snapshot.deviceId },
          "Failed to upsert latest device snapshot",
        );
      }
    }
  }

  async writeTelemetry(snapshot: DeviceSnapshot): Promise<void> {
    const document: TelemetryDocument = {
      ts: new Date(snapshot.stamp),
      meta: {
        deviceId: snapshot.deviceId,
        fleetId: "default-fleet",
        vehicleModel: asText(snapshot.extra.vehicleModel, "generic-agv") || "generic-agv",
      },
      measurements: {
        online: snapshot.online,
        stamp: snapshot.stamp,
        sceneId: snapshot.sceneId,
        runtimeSceneId: snapshot.runtimeSceneId,
        defaultSceneId: snapshot.defaultSceneId,
        gps: snapshot.gps,
        fusionLoc: snapshot.fusionLoc,
        lidarLoc: snapshot.lidarLoc,
        vehicleInfo: snapshot.vehicleInfo,
        taskStatus: snapshot.taskStatus,
        platformTaskStatus: snapshot.platformTaskStatus,
        infoCode: snapshot.infoCode,
        warningCode: snapshot.warningCode,
        errorCode: snapshot.errorCode,
        speedLimit: snapshot.speedLimit,
        extra: snapshot.extra,
      },
    };

    this.appendMemoryTelemetry(document);

    // P0-c: a disconnected database **buffers** rather than returning. This used to be a
    // bare `return`, so every frame that arrived while MongoDB was down was gone — and
    // the reconnect path only ever flushed what a *failed write* had buffered, which is a
    // set that stays empty while there is no connection to fail against.
    if (!this.db) {
      this.bufferTelemetry(document);
      return;
    }

    try {
      await this.db.collection<TelemetryDocument>("telemetry_ts").insertOne(document);
      if (this.pendingTelemetry.length) {
        await this.flushPendingTelemetry();
      }
    } catch (error) {
      logger.warn(
        { err: error, deviceId: snapshot.deviceId },
        "Failed to write telemetry to MongoDB; buffering",
      );
      this.bufferTelemetry(document);
    }
  }

  /** Appends to the write-behind buffer, counting what the cap forces out. */
  private bufferTelemetry(document: TelemetryDocument): void {
    this.pendingTelemetry.push(document);
    const overflow = this.pendingTelemetry.length - config.mongoBufferLimit;
    if (overflow > 0) {
      this.pendingTelemetry.splice(0, overflow);
      this.droppedTelemetry += overflow;
      logger.warn(
        { dropped: overflow, droppedTotal: this.droppedTelemetry, limit: config.mongoBufferLimit },
        "Telemetry buffer full; dropped the oldest documents",
      );
    }
  }

  /** Buffer depth and cumulative drops, for `/metrics` and the readiness probe. */
  telemetryBufferStats(): { pending: number; dropped: number; limit: number } {
    return {
      pending: this.pendingTelemetry.length,
      dropped: this.droppedTelemetry,
      limit: config.mongoBufferLimit,
    };
  }

  /**
   * Push whatever is buffered at MongoDB now. Public so the shutdown path can drain
   * before closing the connection, and so a timer can retry while a reconnect is
   * pending — the write path only flushed *after a successful write*, which never comes
   * while the database is down.
   */
  async flushTelemetry(): Promise<void> {
    await this.flushPendingTelemetry();
  }

  private async flushPendingTelemetry(): Promise<void> {
    if (!this.db || !this.pendingTelemetry.length) {
      return;
    }
    const copy = [...this.pendingTelemetry];
    this.pendingTelemetry = [];
    try {
      await this.db
        .collection<TelemetryDocument>("telemetry_ts")
        .insertMany(copy, { ordered: false });
    } catch (error) {
      logger.warn({ err: error }, "Failed to flush buffered telemetry");
      this.pendingTelemetry = [
        ...copy.slice(-config.mongoBufferLimit),
        ...this.pendingTelemetry,
      ].slice(-config.mongoBufferLimit);
    }
  }

  async upsertAlerts(deviceId: string, alerts: DeviceAlert[]): Promise<void> {
    // Always mirror the current active set into memory so the /api/alerts
    // fallback works without MongoDB and stays consistent with the live snapshot.
    // Carry any existing acknowledgement forward for an eventKey that is still active,
    // so a re-report does not silently drop a confirmation (mirrors the Mongo path,
    // whose $set leaves the ack fields untouched). A cleared eventKey simply falls out
    // of the new set, which is the same as nulling its ack.
    const priorAcks = new Map(
      (this.activeAlerts.get(deviceId) ?? []).map((alert) => [
        alert.eventKey,
        {
          ackedBy: alert.ackedBy,
          ackedAt: alert.ackedAt,
          comment: alert.comment,
        },
      ]),
    );
    this.activeAlerts.set(
      deviceId,
      alerts.map((alert) => {
        const eventKey = `${deviceId}:${alert.id}`;
        const ack = priorAcks.get(eventKey);
        return {
          eventKey,
          deviceId,
          alertId: alert.id,
          severity: alert.severity,
          title: alert.title,
          detail: alert.detail,
          source: alert.source,
          code: alert.code ?? null,
          info: alert.info ?? "",
          ts: alert.ts,
          active: true,
          firstSeenAt: alert.ts,
          lastSeenAt: alert.ts,
          // The in-memory mirror holds active alerts only, so nothing here has cleared.
          clearedAt: null,
          ackedBy: ack?.ackedBy ?? null,
          ackedAt: ack?.ackedAt ?? null,
          comment: ack?.comment ?? null,
        };
      }),
    );

    if (!this.db) {
      return;
    }

    const collection = this.db.collection("alerts");
    const activeKeys = new Set(alerts.map((alert) => `${deviceId}:${alert.id}`));

    try {
      await Promise.all(
        alerts.map((alert) =>
          collection.updateOne(
            { eventKey: `${deviceId}:${alert.id}` },
            {
              $set: {
                eventKey: `${deviceId}:${alert.id}`,
                deviceId,
                alertId: alert.id,
                severity: alert.severity,
                title: alert.title,
                detail: alert.detail,
                source: alert.source,
                ts: alert.ts,
                active: true,
                code: alert.code ?? null,
                info: alert.info ?? "",
                lastSeenAt: new Date(alert.ts),
              },
              $setOnInsert: {
                firstSeenAt: new Date(alert.ts),
                // A brand-new occurrence starts unacknowledged. On a re-report this
                // branch is skipped, so an existing ack is preserved.
                ackedBy: null,
                ackedAt: null,
                comment: null,
              },
            },
            { upsert: true },
          ),
        ),
      );

      await collection.updateMany(
        {
          deviceId,
          active: true,
          eventKey: { $nin: [...activeKeys] },
        },
        {
          $set: {
            active: false,
            clearedAt: new Date(),
            lastSeenAt: new Date(),
            // You acknowledged one occurrence; a later re-fire is a new one and must
            // come back unacknowledged.
            ackedBy: null,
            ackedAt: null,
            comment: null,
          },
        },
      );
    } catch (error) {
      logger.warn({ err: error, deviceId }, "Failed to persist alerts to MongoDB");
    }
  }

  /**
   * Acknowledge one active alert occurrence (Phase 16A). Returns true when a matching
   * active row was found and updated, false otherwise (unknown eventKey, or already
   * cleared) so the route can answer 404. Only active rows are touched — you cannot
   * acknowledge an occurrence that is no longer happening.
   */
  async ackAlert(
    eventKey: string,
    ackedBy: string,
    comment: string | null,
    at: Date,
  ): Promise<boolean> {
    const iso = at.toISOString();
    if (!this.db) {
      const alert = this.findMemoryActiveAlert(eventKey);
      if (!alert) {
        return false;
      }
      alert.ackedBy = ackedBy;
      alert.ackedAt = iso;
      alert.comment = comment;
      return true;
    }

    const result = await this.db
      .collection("alerts")
      .updateOne(
        { eventKey, active: true },
        { $set: { ackedBy, ackedAt: new Date(iso), comment } },
      );
    return result.matchedCount > 0;
  }

  /** Undo an acknowledgement (Phase 16A). Same active-only match and 404 contract. */
  async unackAlert(eventKey: string): Promise<boolean> {
    if (!this.db) {
      const alert = this.findMemoryActiveAlert(eventKey);
      if (!alert) {
        return false;
      }
      alert.ackedBy = null;
      alert.ackedAt = null;
      alert.comment = null;
      return true;
    }

    const result = await this.db
      .collection("alerts")
      .updateOne(
        { eventKey, active: true },
        { $set: { ackedBy: null, ackedAt: null, comment: null } },
      );
    return result.matchedCount > 0;
  }

  private findMemoryActiveAlert(eventKey: string): StoredAlert | undefined {
    for (const alerts of this.activeAlerts.values()) {
      const match = alerts.find((alert) => alert.eventKey === eventKey);
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  private appendMemoryTelemetry(document: TelemetryDocument): void {
    const deviceId = document.meta.deviceId;
    const existing = this.telemetryBuffer.get(deviceId) ?? [];
    existing.push(document);
    // Keep newest samples, bounded to the same cap used for Mongo queries.
    const cap = config.maxHistoryPoints;
    if (existing.length > cap) {
      existing.splice(0, existing.length - cap);
    }
    this.telemetryBuffer.set(deviceId, existing);
  }

  private queryMemoryHistory(query: HistoryQuery): TelemetryDocument[] {
    const all = this.telemetryBuffer.get(query.deviceId) ?? [];
    const fromMs = toBoundDate(query.from)?.getTime();
    const toMs = toBoundDate(query.to)?.getTime();
    const filtered = all.filter((document) => {
      const ts = document.ts.getTime();
      if (Number.isFinite(fromMs) && ts < (fromMs as number)) {
        return false;
      }
      if (Number.isFinite(toMs) && ts > (toMs as number)) {
        return false;
      }
      return true;
    });
    // Newest-first, matching the Mongo query contract.
    const sorted = [...filtered].sort((left, right) => right.ts.getTime() - left.ts.getTime());
    // Kept even though `historyQuerySchema` now bounds `limit` by the same value:
    // that schema only guards the HTTP path, and `HistoryQuery` is a plain type any
    // in-process caller can build. The cap belongs where the rows are read.
    const limit = Math.min(query.limit || config.maxHistoryPoints, config.maxHistoryPoints);
    return sorted.slice(0, limit);
  }

  /**
   * Real connectivity, driven by the driver's topology heartbeats — not merely
   * "we once built a Db handle". False whenever there is no client at all.
   * Surfaced as the `mongo` check of /health/ready and `navfleet_mongo_connected`.
   */
  isMongoConnected(): boolean {
    return this.mongo.isConnected();
  }

  async queryHistory(query: HistoryQuery): Promise<unknown[]> {
    if (!this.db) {
      return this.queryMemoryHistory(query);
    }

    const filter: Record<string, unknown> = {
      "meta.deviceId": query.deviceId,
    };
    const fromDate = toBoundDate(query.from);
    const toDate = toBoundDate(query.to);
    if (fromDate || toDate) {
      const range: Record<string, unknown> = {};
      if (fromDate) {
        range.$gte = fromDate;
      }
      if (toDate) {
        range.$lte = toDate;
      }
      filter.ts = range;
    }

    return this.db
      .collection("telemetry_ts")
      .find(filter)
      .sort({ ts: -1 })
      .limit(Math.min(query.limit || config.maxHistoryPoints, config.maxHistoryPoints))
      .toArray();
  }

  async queryAlerts(filters: {
    severity?: string;
    deviceId?: string;
    status?: string;
  }): Promise<unknown[]> {
    if (!this.db) {
      return this.queryMemoryAlerts(filters);
    }

    const query: Record<string, unknown> = {};
    if (filters.severity) {
      query.severity = filters.severity;
    }
    if (filters.deviceId) {
      query.deviceId = filters.deviceId;
    }
    if (filters.status === "active") {
      query.active = true;
    } else if (filters.status === "cleared") {
      query.active = false;
    }

    return this.db
      .collection("alerts")
      .find(query, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(MAX_ALERTS_PER_QUERY)
      .toArray();
  }

  private queryMemoryAlerts(filters: {
    severity?: string;
    deviceId?: string;
    status?: string;
  }): StoredAlert[] {
    // Only active alerts are retained in memory; a "cleared" filter yields none.
    if (filters.status === "cleared") {
      return [];
    }
    let items = [...this.activeAlerts.values()].flat();
    if (filters.severity) {
      items = items.filter((alert) => alert.severity === filters.severity);
    }
    if (filters.deviceId) {
      items = items.filter((alert) => alert.deviceId === filters.deviceId);
    }
    return items
      .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
      .slice(0, MAX_ALERTS_PER_QUERY);
  }

  /**
   * Server-side alert statistics over the whole `alerts` collection (Phase 17A).
   *
   * The point of doing this in Mongo rather than in the browser (as 16B does) is to escape the
   * 500-row read cap on `/api/alerts`: a `$facet` aggregate sees every alert in the retention
   * window, not just the newest page. With no Mongo there is no history to aggregate, so this
   * returns an honest-empty report flagged `available:false` — the same contract the
   * cleared-alert paths already keep — rather than a zero-filled one that would read as
   * "there were no alerts".
   */
  async aggregateAlertStats(range: { from?: string; to?: string }): Promise<AlertStatsReport> {
    if (!this.db) {
      return emptyAlertStatsReport(false);
    }
    const pipeline = buildAlertStatsPipeline({
      from: toBoundDate(range.from),
      to: toBoundDate(range.to),
      topN: ALERT_STATS_TOP_N,
      timezone: config.reportTimezone,
    });
    // `$facet` always yields exactly one document; the `?? {}` only satisfies the type for the
    // (unreachable) empty-cursor case, and the mapper turns it into a zeroed but available report.
    const [facet] = await this.db
      .collection("alerts")
      .aggregate<AlertStatsFacet>(pipeline)
      .toArray();
    return mapAlertStatsFacet(facet ?? {});
  }

  /**
   * Server-side availability + battery time-series over `telemetry_ts` (Phase 17A-2).
   *
   * Downsamples raw frames into (device × time-bucket) rows — online-frame ratio and soc
   * mean/min — via `$dateTrunc`, so the report page never scans the whole series client-side.
   * No Mongo means no history to aggregate, so this honest-empties with `available:false` like
   * the alert-stats path, rather than returning zero-filled buckets that read as "all offline".
   */
  async aggregateAvailability(params: {
    deviceId?: string;
    from?: string;
    to?: string;
    bucket: ReportBucketUnit;
  }): Promise<AvailabilityReport> {
    if (!this.db) {
      return emptyAvailabilityReport(params.bucket, false);
    }
    const pipeline = buildAvailabilityPipeline({
      deviceId: params.deviceId ?? null,
      from: toBoundDate(params.from),
      to: toBoundDate(params.to),
      bucket: params.bucket,
      timezone: config.reportTimezone,
    });
    const rows = await this.db
      .collection("telemetry_ts")
      .aggregate<AvailabilityRow>(pipeline)
      .toArray();
    return mapAvailabilityRows(rows, params.bucket);
  }
}
