import {
  Db,
  MongoBulkWriteError,
  MongoClient,
  MongoServerError,
  type MongoClientEvents,
  type WriteError,
} from "mongodb";
import { parseTimeParam } from "./timeParam";
import { config } from "./config";
import {
  ALERT_STATS_TOP_N,
  emptyAlertStatsReport,
  emptyAvailabilityReport,
} from "@navfleet/shared";
import { MongoConnectionSupervisor, type MongoSession, redactMongoUri } from "./mongoConnection";
import {
  AlertStatsReport,
  AuditEntry,
  AvailabilityReport,
  DeviceAlert,
  DeviceSnapshot,
  HistoryQuery,
  NotifySendRecord,
  RbacGroup,
  RbacRole,
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
  mergeAvailabilityRows,
  type AvailabilityRow,
} from "./reports/availabilityPipeline";
import {
  ROLLUP_COLLECTION,
  ROLLUP_RUNS_COLLECTION,
  buildHourRollupPipeline,
  buildRollupReportPipeline,
  closedHours,
  floorToHour,
  planAvailabilityWindow,
} from "./reports/telemetryRollup";
import { moduleLogger } from "./logger";
import { asText } from "./normalize";
import { runMigrations } from "./migrations/runner";
import { reconcileTtls } from "./migrations/ttl";

/** The single RBAC document (custom roles + user groups), addressed by a fixed string `_id`. */
interface RbacStateDoc {
  _id: string;
  roles: RbacRole[];
  groups: RbacGroup[];
}
const RBAC_STATE_ID = "state";
import { MigrationError, type Migration } from "./migrations/types";

const logger = moduleLogger("persistence");

export interface TelemetryDocument {
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
 * A query bound as a Date, read exactly as validation read it (`parseTimeParam`). Null for an
 * absent bound; an unparseable one never gets this far.
 */
const toBoundDate = (value: string | undefined): Date | null => {
  const ms = parseTimeParam(value);
  return ms === null ? null : new Date(ms);
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
  // Acknowledgement. null until an operator+ confirms the occurrence; kept when the occurrence
  // clears (it is history). A re-fire is a new document and starts unacknowledged.
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
export const MAX_ALERTS_PER_QUERY = 500;

/** Most audit rows one `GET /api/audit` returns; the in-memory fallback ring is bounded to it too. */
export const MAX_AUDIT_PER_QUERY = 500;

/** Most notify-send rows one `GET /api/notify/log` returns; the in-memory fallback ring is bounded to it too. */
export const MAX_NOTIFY_PER_QUERY = 500;

/** Report aggregations are read-only views over slowly-changing history, so an in-memory TTL cache
 * collapses repeat loads (filter toggling, several viewers, the dashboard re-opening) onto one Mongo
 * aggregation. Five minutes rather than seconds: the wide (30-day) aggregation itself takes tens of
 * seconds, so a short TTL would pay that again on nearly every load, and a history view minutes
 * stale is fine. Keyed by the fully-resolved query. */
const REPORT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Which documents of a failed unordered `insertMany` did not land, so only those are re-queued.
 *
 * With `ordered: false` the server attempts every document and a `MongoBulkWriteError` names the
 * failures by index in `writeErrors`; everything else in the batch *was* written. Re-queuing the
 * whole batch (the old behaviour) wrote those again on the next flush — duplicate telemetry rows,
 * and history/report sample counts inflated by them.
 *
 * When the outcome is unknown — a network error, or a write-concern error (writes applied but not
 * acknowledged as durable) — fall back to re-queuing everything: a possible duplicate is the price
 * of never silently losing a frame, which is the one loss a monitoring platform must not absorb.
 */
const unwrittenDocuments = <T>(batch: T[], error: unknown): T[] => {
  if (
    !(error instanceof MongoBulkWriteError) ||
    error.err !== undefined ||
    error.result?.getWriteConcernError?.() !== undefined
  ) {
    return batch;
  }
  const writeErrors: WriteError[] = Array.isArray(error.writeErrors)
    ? (error.writeErrors as WriteError[])
    : [error.writeErrors as WriteError];
  const failedIndexes = new Set(writeErrors.map((writeError) => writeError.index));
  if (failedIndexes.size === 0) {
    return batch;
  }
  return batch.filter((_document, index) => failedIndexes.has(index));
};

/** The `telemetry_ts` document for one snapshot — what every stored frame looks like. */
export const toTelemetryDocument = (snapshot: DeviceSnapshot): TelemetryDocument => ({
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
});

export class Persistence {
  private db: Db | null = null;
  /**
   * Connectivity of a `Db` attached by `__setDbForTests`, which has no supervisor behind it to
   * report it; null when the handle came from a real session.
   */
  private testConnectivity: boolean | null = null;
  /**
   * Whether this process persists to MongoDB at all (`connect()` was called). Distinguishes "down,
   * catch up later" from the in-memory mode, where there is nothing to catch up — `this.db` cannot
   * tell them apart, because it is also null while a closed topology is being replaced.
   */
  private mongoEnabled = false;
  private pendingTelemetry: TelemetryDocument[] = [];
  /** Devices whose last alert sync to MongoDB failed, or was skipped while down, and must be replayed. */
  private readonly alertSyncPending = new Set<string>();
  /**
   * The newest `device_latest` snapshot per device that has not reached MongoDB (written while it
   * was down, or a failed upsert). Only the newest matters — the document is replaced, not
   * appended — so this holds one entry per device and replays on the write-behind timer.
   */
  private readonly latestSyncPending = new Map<string, DeviceSnapshot>();
  /** Short-TTL cache for report aggregations (see `REPORT_CACHE_TTL_MS`). Keyed by the resolved
   * query; value carries the report and the epoch-ms it expires at. Bounded by key cardinality
   * (preset×bucket×device combos) and swept lazily on read. */
  private reportCache = new Map<string, { expiresAt: number; value: unknown }>();
  /** Aggregations in flight, by cache key — shared by concurrent identical requests. */
  private readonly reportInFlight = new Map<string, Promise<unknown>>();
  /**
   * How many buffered telemetry documents have been dropped because the buffer was
   * full. The overflow used to `splice` the oldest away silently, so a monitoring
   * platform lost data with **no counter anywhere** — the one loss a monitoring platform
   * must never take quietly. Exposed on `/metrics` and in the buffer's own warn line.
   */
  private droppedTelemetry = 0;
  private rollupRunning = false;
  /**
   * Mongo write operations that succeeded / failed against the driver.
   * Counted per *operation* (one upsert, one insert, one flush batch), not per
   * document. Until now a write that threw was warn-logged and — for telemetry —
   * buffered, but nothing counted it: a database that accepts connections yet
   * rejects every write (bad auth, disk full, a broken index) looked identical to
   * a healthy one on `/metrics`. `navfleet_mongo_write_failures_total` is that gap.
   */
  private mongoWrites = 0;
  private mongoWriteFailures = 0;
  /**
   * Latency sink for successful Mongo writes. Late-bound: the metrics
   * registry is built after this class in the composition root, so `createApp`
   * calls `setWriteObserver(metrics.observeMongoWrite)` — the same wiring the
   * notify-send histogram uses. Null until then (and in tests that do not set it).
   */
  private writeObserver: ((durationSeconds: number) => void) | null = null;
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
  // In-memory RBAC state (custom roles + user groups) for Mongo-less dev runs. Low-cardinality
  // and read/written whole (like the codebook), so one field rather than per-entity maps.
  private fallbackRbac: { roles: RbacRole[]; groups: RbacGroup[] } = { roles: [], groups: [] };
  // Current active alerts per device, always kept in memory so /api/alerts stays
  // useful in local/dev runs without MongoDB (mirrors the telemetry fallback).
  private activeAlerts = new Map<string, StoredAlert[]>();
  // Bounded in-memory audit trail for Mongo-less dev runs (mirrors the other fallbacks).
  private auditFallback: AuditEntry[] = [];
  // Bounded in-memory outbound-send log for Mongo-less dev runs (mirrors the
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
    this.mongoEnabled = true;
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
  __setDbForTests(db: Db | null, { connected = true }: { connected?: boolean } = {}): void {
    this.db = db;
    this.testConnectivity = db === null ? null : connected;
    this.mongoEnabled = db !== null;
    // Swapping the backing db invalidates any cached aggregation keyed to the old one.
    this.reportCache.clear();
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
      this.reportCache.clear();
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
        this.reportCache.clear();
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

    if (!names.has(ROLLUP_COLLECTION)) {
      await this.db.createCollection(ROLLUP_COLLECTION);
    }
    if (!names.has(ROLLUP_RUNS_COLLECTION)) {
      await this.db.createCollection(ROLLUP_RUNS_COLLECTION);
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
    // RBAC custom roles + user groups (1.6.1). One document (`_id: "state"`) holds both arrays —
    // low-cardinality, single-instance, read/written whole like the codebook — so no per-entity
    // collection or index is needed.
    if (!names.has("rbac")) {
      await this.db.createCollection("rbac");
    }

    // TTL indexes carry `expireAfterSeconds`, and MongoDB rejects a `createIndex` that re-asserts a
    // *different* `expireAfterSeconds` on an existing key (IndexOptionsConflict, code 85). Re-running
    // the create unconditionally on every connect therefore throws the moment a `*_RETENTION_SECONDS`
    // changes — and, thrown from here, that fails the connect and strands a healthy database on the
    // in-memory fallback. So, exactly like `telemetry_ts` sets its TTL only at collection creation,
    // create each TTL index only when it is absent (first boot); on every later connect
    // `reconcileTtls` adjusts the value in place via `collMod`. The plain indexes below never change
    // options, so their idempotent re-create stays safe.
    const db = this.db;
    const ensureTtlIndex = async (
      collection: string,
      key: Record<string, 1 | -1>,
      expireAfterSeconds: number,
    ): Promise<void> => {
      const indexName = Object.entries(key)
        .map(([field, direction]) => `${field}_${direction}`)
        .join("_");
      const indexes = await db.collection(collection).indexes();
      if (indexes.some((index) => index.name === indexName)) {
        return;
      }
      await db.collection(collection).createIndex(key, { expireAfterSeconds });
    };

    await this.db.collection("device_latest").createIndex({ deviceId: 1 }, { unique: true });
    await this.db.collection("device_latest").createIndex({ stamp: -1 });
    await this.db.collection("alerts").createIndex({ deviceId: 1, ts: -1 });
    await this.db.collection("alerts").createIndex({ severity: 1, active: 1, ts: -1 });
    // The alert-stats report (`$match`/`$group`/日切日 in reports/alertStatsPipeline) filters and
    // buckets entirely on `firstSeenAt`; without this index a bounded report scanned the whole
    // collection, the slowest path on the reports page.
    await this.db.collection("alerts").createIndex({ firstSeenAt: 1 });
    // One document per **occurrence**: a code that clears and fires again gets a new row, so the
    // history and the report count every occurrence. `eventKey` (`deviceId:alertId`) identifies the
    // *currently active* occurrence — what an ack targets — so it is unique among active rows only.
    // Every per-frame upsert and every ack/clear filters on `{ eventKey, active: true }`.
    await this.db
      .collection("alerts")
      .createIndex(
        { eventKey: 1 },
        { unique: true, partialFilterExpression: { active: true }, name: "eventKey_active_unique" },
      );
    // telemetry_ts is a time-series collection (clustered on `ts`), so the whole-fleet range scan is
    // already covered; this secondary index on the metaField speeds the device-filtered availability
    // report, whose `$match` leads with `meta.deviceId` before the `ts` range.
    await this.db.collection("telemetry_ts").createIndex({ "meta.deviceId": 1, ts: 1 });
    await ensureTtlIndex("alerts", { lastSeenAt: 1 }, config.alertsRetentionSeconds);
    // The hourly summary the reports read (see reports/telemetryRollup). Its TTL and the runs'
    // share one window, so an hour never outlives the record that says it is complete.
    await this.db.collection(ROLLUP_COLLECTION).createIndex({ deviceId: 1, hour: 1 });
    await ensureTtlIndex(ROLLUP_COLLECTION, { hour: 1 }, config.telemetryRollupRetentionSeconds);
    await ensureTtlIndex(
      ROLLUP_RUNS_COLLECTION,
      { hour: 1 },
      config.telemetryRollupRetentionSeconds,
    );
    await this.db.collection("users").createIndex({ username: 1 }, { unique: true });
    await this.db.collection("audit_log").createIndex({ actor: 1, ts: -1 });
    await this.db.collection("audit_log").createIndex({ action: 1, ts: -1 });
    await ensureTtlIndex("audit_log", { ts: -1 }, config.auditRetentionSeconds);
    // notify_log: send records queried by device / channel / status, newest first.
    // TTL is on a dedicated BSON Date (`expireAt`) rather than the display `ts` (an ISO string,
    // which a TTL index would silently never expire); the retention window is the alerts one,
    // since a send record is only meaningful next to the alert that triggered it.
    await this.db.collection("notify_log").createIndex({ deviceId: 1, ts: -1 });
    await this.db.collection("notify_log").createIndex({ channelId: 1, ts: -1 });
    await this.db.collection("notify_log").createIndex({ status: 1, ts: -1 });
    await ensureTtlIndex("notify_log", { expireAt: 1 }, config.alertsRetentionSeconds);
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

  /**
   * Load the whole RBAC state (custom roles + user groups). Empty on a fresh deployment or a
   * Mongo-less run. Read whole and cached by `RbacService`; the resolver never touches the DB.
   */
  async loadRbacState(): Promise<{ roles: RbacRole[]; groups: RbacGroup[] }> {
    if (!this.db) {
      return { roles: [...this.fallbackRbac.roles], groups: [...this.fallbackRbac.groups] };
    }
    const doc = await this.db
      .collection<RbacStateDoc>("rbac")
      .findOne({ _id: RBAC_STATE_ID }, { projection: { _id: 0 } });
    return {
      roles: (doc?.roles ?? []).map((role) => ({ ...role })),
      groups: (doc?.groups ?? []).map((group) => ({ ...group })),
    };
  }

  /** Replace the whole RBAC state (validated + mutated in `RbacService`, persisted here whole). */
  async saveRbacState(state: { roles: RbacRole[]; groups: RbacGroup[] }): Promise<void> {
    if (!this.db) {
      this.fallbackRbac = { roles: [...state.roles], groups: [...state.groups] };
      return;
    }
    await this.db
      .collection<RbacStateDoc>("rbac")
      .updateOne(
        { _id: RBAC_STATE_ID },
        { $set: { roles: state.roles, groups: state.groups } },
        { upsert: true },
      );
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

  /**
   * Count one failed login, atomically, and return the new count. A lock that has already
   * expired (`lockedUntil <= nowIso`) starts the count afresh at 1 and is cleared. The read and
   * the write are one update, so concurrent wrong passwords cannot overwrite each other's count.
   */
  async incrementLoginFailures(username: string, nowIso: string, at: string): Promise<number> {
    const expired = (lockedUntil: string | null | undefined): boolean =>
      typeof lockedUntil === "string" && lockedUntil <= nowIso;
    if (!this.db) {
      const user = this.fallbackUsers.get(username);
      if (!user) return 0;
      const failedAttempts = expired(user.lockedUntil) ? 1 : (user.failedAttempts ?? 0) + 1;
      const lockedUntil = expired(user.lockedUntil) ? null : (user.lockedUntil ?? null);
      this.fallbackUsers.set(username, { ...user, failedAttempts, lockedUntil, updatedAt: at });
      return failedAttempts;
    }
    const lockExpired = {
      $and: [{ $eq: [{ $type: "$lockedUntil" }, "string"] }, { $lte: ["$lockedUntil", nowIso] }],
    };
    const updated = await this.db.collection<UserRecord>("users").findOneAndUpdate(
      { username },
      [
        {
          $set: {
            failedAttempts: {
              $cond: [lockExpired, 1, { $add: [{ $ifNull: ["$failedAttempts", 0] }, 1] }],
            },
            lockedUntil: { $cond: [lockExpired, null, { $ifNull: ["$lockedUntil", null] }] },
            updatedAt: at,
          },
        },
      ],
      { returnDocument: "after", projection: { failedAttempts: 1 } },
    );
    return updated?.failedAttempts ?? 0;
  }

  /** Set the lockout deadline without touching the failure count. */
  async lockLogin(username: string, lockedUntil: string, at: string): Promise<void> {
    const fallback = this.fallbackUsers.get(username);
    if (fallback) {
      this.fallbackUsers.set(username, { ...fallback, lockedUntil, updatedAt: at });
    }
    if (!this.db) {
      return;
    }
    await this.db
      .collection<UserRecord>("users")
      .updateOne({ username }, { $set: { lockedUntil, updatedAt: at } });
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

  // ── Sessions ────────────────────────────────────────────────────────
  // Per-login rows tracked so a user can see/revoke sessions and an admin can force-log-out.
  // The in-memory fallback keeps this working in a Mongo-less dev run.

  /** Create a session row for a fresh login. */
  async createSession(session: SessionRecord): Promise<void> {
    if (!this.db) {
      // In-memory fallback only. When Mongo is the live store the row lives there and nothing ever
      // sweeps this map (only explicit revoke prunes it, never token/TTL expiry), so stamping it on
      // every login — as this used to, before the `!this.db` guard — leaked one SessionRecord per
      // login for the life of the process. `touchSession` already guards the same way.
      this.fallbackSessions.set(session.sessionId, session);
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

  /** Query the audit trail, newest first, filtered by actor / action(s) / time window. */
  async queryAudit(filters: {
    actor?: string;
    action?: string[];
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
        .filter((entry) => !filters.action?.length || filters.action.includes(entry.action))
        .filter((entry) => !fromDate || entry.ts >= fromDate)
        .filter((entry) => !toDate || entry.ts <= toDate)
        .slice(0, MAX_AUDIT_PER_QUERY);
    }

    const query: Record<string, unknown> = {};
    if (filters.actor) query.actor = filters.actor;
    if (filters.action?.length) query.action = { $in: filters.action };
    if (Object.keys(tsBound).length > 0) query.ts = tsBound;

    return this.db
      .collection<AuditEntry>("audit_log")
      .find(query, { projection: { _id: 0 } })
      .sort({ ts: -1 })
      .limit(MAX_AUDIT_PER_QUERY)
      .toArray();
  }

  /**
   * Append an outbound-send record. **Best-effort**, exactly like `appendAudit`:
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

  /**
   * The stored snapshots of the vehicles the roster declares — however long ago each last
   * reported. A declared vehicle that has been parked for days must come back as "offline", not
   * vanish; the time window and the `MAX_DEVICES` cap this used to apply only ever cut declared
   * vehicles, since undeclared ids are not restored at all. Bounded by the roster itself.
   */
  async restoreLatestDevices(deviceIds: readonly string[]): Promise<DeviceSnapshot[]> {
    if (!this.db || deviceIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .collection<DeviceSnapshot>("device_latest")
        .find({ deviceId: { $in: [...deviceIds] } })
        .sort({ stamp: -1 })
        .toArray()
    ).map((item) => ({
      ...item,
      alerts: item.alerts || [],
      extra: item.extra || {},
      tags: item.tags || [],
    }));
  }

  /**
   * Release a device's in-memory footprint. Called when the store evicts a
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
    // A replayed snapshot would bring the departed device back on the next restart.
    this.latestSyncPending.delete(deviceId);
  }

  /**
   * The database handle for the per-frame write paths, or null while MongoDB is unreachable.
   *
   * `this.db` outlives a lost connection: the driver keeps the client and retries each operation
   * until its own timeout, so the frame waited out a full `MONGO_WRITE_TIMEOUT_MS` per write. The
   * writes run in the store's serial ingest queue, two or three per frame, which took the whole
   * fleet from 1 Hz to a frame every few seconds and filled the queue. While the supervisor says
   * the topology is down they go straight to the write-behind buffers instead.
   */
  private writableDb(): Db | null {
    const connected = this.testConnectivity ?? this.mongo.isConnected();
    return this.db && connected ? this.db : null;
  }

  async writeLatestSnapshot(snapshot: DeviceSnapshot): Promise<void> {
    const db = this.writableDb();
    if (!db) {
      // In the in-memory mode there is nothing to catch up later.
      if (this.mongoEnabled) this.latestSyncPending.set(snapshot.deviceId, snapshot);
      return;
    }
    if (await this.upsertLatest(db, snapshot)) {
      this.latestSyncPending.delete(snapshot.deviceId);
    } else {
      this.latestSyncPending.set(snapshot.deviceId, snapshot);
    }
  }

  private async upsertLatest(db: Db, snapshot: DeviceSnapshot): Promise<boolean> {
    const start = Date.now();
    try {
      await db
        .collection<DeviceSnapshot>("device_latest")
        .updateOne(
          { deviceId: snapshot.deviceId },
          { $set: snapshot },
          { upsert: true, timeoutMS: config.mongoWriteTimeoutMs },
        );
      this.mongoWrites += 1;
      this.writeObserver?.((Date.now() - start) / 1000);
      return true;
    } catch (error) {
      this.mongoWriteFailures += 1;
      logger.warn(
        { err: error, deviceId: snapshot.deviceId },
        "Failed to upsert latest device snapshot",
      );
      return false;
    }
  }

  /** Replay the `device_latest` upserts that did not land, newest snapshot per device. */
  private async resyncPendingLatest(): Promise<void> {
    const db = this.writableDb();
    if (!db || this.latestSyncPending.size === 0) return;
    for (const [deviceId, snapshot] of [...this.latestSyncPending]) {
      if (!(await this.upsertLatest(db, snapshot))) return;
      // A newer frame may have replaced the entry during the await; keep that one.
      if (this.latestSyncPending.get(deviceId) === snapshot) {
        this.latestSyncPending.delete(deviceId);
      }
    }
  }

  async writeTelemetry(snapshot: DeviceSnapshot): Promise<void> {
    const document = toTelemetryDocument(snapshot);

    this.appendMemoryTelemetry(document);

    // A disconnected database **buffers** rather than returning. This used to be a
    // bare `return`, so every frame that arrived while MongoDB was down was gone — and
    // the reconnect path only ever flushed what a *failed write* had buffered, which is a
    // set that stays empty while there is no connection to fail against.
    const db = this.writableDb();
    if (!db) {
      this.bufferTelemetry(document);
      return;
    }

    try {
      const start = Date.now();
      await db
        .collection<TelemetryDocument>("telemetry_ts")
        .insertOne(document, { timeoutMS: config.mongoWriteTimeoutMs });
      this.mongoWrites += 1;
      this.writeObserver?.((Date.now() - start) / 1000);
      await this.invalidateRollupFor([document]);
      if (this.pendingTelemetry.length) {
        await this.flushPendingTelemetry();
      }
    } catch (error) {
      this.mongoWriteFailures += 1;
      logger.warn(
        { err: error, deviceId: snapshot.deviceId },
        "Failed to write telemetry to MongoDB; buffering",
      );
      this.bufferTelemetry(document);
    }
  }

  /**
   * Mark summarised hours stale when frames land in them after the fact — the write-behind buffer
   * draining after an outage, a frame that arrived across an hour boundary. A frame in the current
   * hour costs nothing: only hours that have ended can have a run to drop. Never throws: a failed
   * invalidation leaves a slightly stale hour, and a telemetry write must not fail over it.
   */
  private async invalidateRollupFor(documents: readonly TelemetryDocument[]): Promise<void> {
    const db = this.writableDb();
    if (!db) return;
    const currentHour = floorToHour(Date.now(), config.reportTimezone);
    const hours = new Set<number>();
    for (const document of documents) {
      const ts = document.ts.getTime();
      if (Number.isFinite(ts) && ts < currentHour) {
        hours.add(floorToHour(ts, config.reportTimezone));
      }
    }
    if (!hours.size) return;
    try {
      await db
        .collection(ROLLUP_RUNS_COLLECTION)
        .deleteMany(
          { hour: { $in: [...hours].map((hour) => new Date(hour)) } },
          { timeoutMS: config.mongoWriteTimeoutMs },
        );
    } catch (error) {
      logger.warn({ err: error }, "Failed to invalidate telemetry rollup hours");
    }
  }

  /**
   * Summarise closed hours into `telemetry_hourly`, newest first, until none is left or the time
   * budget is spent; returns how many hours were summarised. An hour counts as done only under the
   * threshold and timezone it was computed with, so retuning either recomputes the retention
   * window over the following ticks. Runs one at a time per process.
   */
  async rollupTelemetry(maxGapSeconds: number, budgetMs = 30_000): Promise<number> {
    if (!this.db || this.rollupRunning) return 0;
    this.rollupRunning = true;
    const db = this.db;
    const startedAt = Date.now();
    const maxGapMs = maxGapSeconds * 1000;
    const timezone = config.reportTimezone;
    let done = 0;
    try {
      const oldest = await db
        .collection<TelemetryDocument>("telemetry_ts")
        .find({}, { projection: { ts: 1 } })
        .sort({ ts: 1 })
        .limit(1)
        .next();
      if (!oldest) return 0;
      const pending = closedHours(oldest.ts.getTime(), startedAt, maxGapMs, timezone);
      if (!pending.length) return 0;
      const runs = await db
        .collection<{ hour: Date }>(ROLLUP_RUNS_COLLECTION)
        .find(
          { hour: { $gte: new Date(pending.at(-1) ?? 0) }, maxGapMs, timezone },
          { projection: { hour: 1 } },
        )
        .toArray();
      const covered = new Set(runs.map((run) => run.hour.getTime()));
      for (const hour of pending) {
        if (covered.has(hour)) continue;
        if (Date.now() - startedAt > budgetMs) break;
        const hourStart = new Date(hour);
        await db.collection(ROLLUP_COLLECTION).deleteMany({ hour: hourStart });
        await db
          .collection("telemetry_ts")
          .aggregate(buildHourRollupPipeline({ hourStart, maxGapMs, timezone }), {
            allowDiskUse: true,
            maxTimeMS: config.reportQueryTimeoutMs,
          })
          .toArray();
        await db
          .collection<{ _id: string }>(ROLLUP_RUNS_COLLECTION)
          .updateOne(
            { _id: hourStart.toISOString() },
            { $set: { hour: hourStart, maxGapMs, timezone, computedAt: new Date() } },
            { upsert: true },
          );
        done += 1;
      }
      if (done) {
        logger.info(
          { hours: done, remaining: pending.length - covered.size - done },
          "Rolled up telemetry hours",
        );
      }
      return done;
    } finally {
      this.rollupRunning = false;
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

  /** Cumulative Mongo write operations and failures, for `/metrics`. */
  mongoWriteStats(): { writes: number; failures: number } {
    return { writes: this.mongoWrites, failures: this.mongoWriteFailures };
  }

  /** Late-bind the successful-write latency sink (composition root). */
  setWriteObserver(observe: (durationSeconds: number) => void): void {
    this.writeObserver = observe;
  }

  /**
   * Push whatever is buffered at MongoDB now. Public so the shutdown path can drain
   * before closing the connection, and so a timer can retry while a reconnect is
   * pending — the write path only flushed *after a successful write*, which never comes
   * while the database is down.
   */
  async flushTelemetry(): Promise<void> {
    await this.flushPendingTelemetry();
    await this.resyncPendingAlerts();
    await this.resyncPendingLatest();
  }

  private async flushPendingTelemetry(): Promise<void> {
    const db = this.writableDb();
    if (!db || !this.pendingTelemetry.length) {
      return;
    }
    const copy = [...this.pendingTelemetry];
    this.pendingTelemetry = [];
    try {
      const start = Date.now();
      // Bounded like every other write: this runs on the telemetry write path too, after a
      // successful insert, so an unbounded batch would hold up the ingest queue.
      await db
        .collection<TelemetryDocument>("telemetry_ts")
        .insertMany(copy, { ordered: false, timeoutMS: config.mongoWriteTimeoutMs });
      this.mongoWrites += 1;
      this.writeObserver?.((Date.now() - start) / 1000);
      await this.invalidateRollupFor(copy);
    } catch (error) {
      this.mongoWriteFailures += 1;
      // Some of the batch may have landed; their hours are recomputed either way.
      await this.invalidateRollupFor(copy);
      const failed = unwrittenDocuments(copy, error);
      logger.warn(
        { err: error, attempted: copy.length, requeued: failed.length },
        "Failed to flush buffered telemetry",
      );
      // Re-queue what did not land (older) ahead of anything that arrived during the await
      // (newer), then cap to the newest `mongoBufferLimit`. Count what the cap forces out, the
      // same way `bufferTelemetry` does — otherwise a flush that keeps failing while new frames
      // pile up drops the oldest silently and `navfleet_mongo_buffer_dropped_total` underreports.
      const requeued = [...failed, ...this.pendingTelemetry];
      const overflow = requeued.length - config.mongoBufferLimit;
      if (overflow > 0) {
        this.droppedTelemetry += overflow;
        logger.warn(
          {
            dropped: overflow,
            droppedTotal: this.droppedTelemetry,
            limit: config.mongoBufferLimit,
          },
          "Telemetry buffer full after a failed flush; dropped the oldest documents",
        );
      }
      this.pendingTelemetry = requeued.slice(-config.mongoBufferLimit);
    }
  }

  /**
   * Reconcile a device's stored occurrences with its current active set: an alert still firing
   * updates its active occurrence (or opens one), an active occurrence no longer in the set is
   * closed at `at` — the store's clock, so a replayed history closes occurrences when they
   * ended rather than when the replay ran.
   */
  async upsertAlerts(deviceId: string, alerts: DeviceAlert[], at = new Date()): Promise<void> {
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
          firstSeenAt: alert.firstSeenAt,
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
          firstSeenAt: alert.firstSeenAt ?? ack?.firstSeenAt ?? alert.ts,
          lastSeenAt: at.toISOString(),
          // The in-memory mirror holds active alerts only, so nothing here has cleared.
          clearedAt: null,
          ackedBy: ack?.ackedBy ?? null,
          ackedAt: ack?.ackedAt ?? null,
          comment: ack?.comment ?? null,
        };
      }),
    );

    const db = this.writableDb();
    if (!db) {
      // Replayed from the mirror above once MongoDB is back (see `resyncPendingAlerts`).
      if (this.mongoEnabled) this.alertSyncPending.add(deviceId);
      return;
    }

    const collection = db.collection("alerts");
    const activeKeys = new Set(alerts.map((alert) => `${deviceId}:${alert.id}`));

    try {
      await Promise.all(
        alerts.map((alert) =>
          collection.updateOne(
            // Match the *active* occurrence only. After a clear, the next fire finds no active row
            // and inserts a fresh one (new firstSeenAt, unacknowledged, not cleared) instead of
            // reviving the old row and overwriting its history.
            { eventKey: `${deviceId}:${alert.id}`, active: true },
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
                // The frame this sync is for: an occurrence still firing is still being seen. It
                // used to stay at the onset, and the TTL on it then deleted a long-running active
                // alert (and its acknowledgement) mid-incident.
                lastSeenAt: at,
              },
              $setOnInsert: {
                firstSeenAt: new Date(alert.firstSeenAt ?? alert.ts),
                clearedAt: null,
                // A brand-new occurrence starts unacknowledged. On a re-report this
                // branch is skipped, so an existing ack is preserved.
                ackedBy: null,
                ackedAt: null,
                comment: null,
              },
            },
            { upsert: true, timeoutMS: config.mongoWriteTimeoutMs },
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
          // The occurrence is closed and kept as history, acknowledgement included: who confirmed
          // it is part of what happened. A later re-fire is a separate (unacknowledged) document.
          $set: {
            active: false,
            clearedAt: at,
            lastSeenAt: at,
          },
        },
        { timeoutMS: config.mongoWriteTimeoutMs },
      );
      this.alertSyncPending.delete(deviceId);
    } catch (error) {
      // Counted like every other failed write (it feeds NavFleetMongoWritesFailing), and the
      // device is marked for a re-sync: the sync is a reconciliation of the whole active set, so
      // replaying it later from the in-memory mirror converges on the right documents.
      this.mongoWriteFailures += 1;
      this.alertSyncPending.add(deviceId);
      logger.warn({ err: error, deviceId }, "Failed to persist alerts to MongoDB; will re-sync");
    }
  }

  /**
   * Re-run the alert sync for every device whose last sync failed, from the in-memory active set.
   * Called on the write-behind retry timer, so alerts that changed while MongoDB was unavailable
   * still land (a clear made during the outage is stamped when the re-sync succeeds).
   */
  private async resyncPendingAlerts(): Promise<void> {
    if (!this.writableDb() || this.alertSyncPending.size === 0) return;
    for (const deviceId of [...this.alertSyncPending]) {
      const active = (this.activeAlerts.get(deviceId) ?? []).map((alert) => ({
        id: alert.alertId,
        severity: alert.severity as DeviceAlert["severity"],
        title: alert.title,
        detail: alert.detail,
        source: alert.source,
        ts: alert.ts,
        firstSeenAt: alert.firstSeenAt,
        active: true,
        code: alert.code ?? undefined,
        info: alert.info,
      })) as DeviceAlert[];
      await this.upsertAlerts(deviceId, active);
      // Still failing: stop for this tick rather than hammering a database that is down.
      if (this.alertSyncPending.has(deviceId)) return;
    }
  }

  /** How many devices are waiting for an alert re-sync (for metrics and tests). */
  alertSyncBacklog(): number {
    return this.alertSyncPending.size;
  }

  /**
   * Acknowledge one active alert occurrence. Returns true when a matching
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

  /** Undo an acknowledgement. Same active-only match and 404 contract. */
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

  /**
   * The whole `from`–`to` window, thinned to at most `MAX_HISTORY_POINTS` samples spread evenly
   * over time (newest-first, like `queryHistory`). A window that already fits comes back whole.
   * Otherwise the window is cut into that many equal time buckets and each bucket contributes
   * its earliest frame — a real frame, not an average, so playback only shows poses the vehicle
   * reported; a stretch with no telemetry stays a gap. `total` is the window's full count.
   */
  async sampleHistory(query: {
    deviceId: string;
    from: string;
    to: string;
  }): Promise<{ items: unknown[]; total: number; sampled: boolean }> {
    const cap = config.maxHistoryPoints;
    const fromDate = toBoundDate(query.from);
    const toDate = toBoundDate(query.to);
    if (!fromDate || !toDate) {
      throw new Error("sampleHistory needs both window bounds");
    }
    if (!this.db) {
      // The in-memory ring is itself capped at `MAX_HISTORY_POINTS` per device, so any window
      // of it already fits: it comes back whole.
      const items = this.queryMemoryHistory({ ...query, limit: cap });
      return { items, total: items.length, sampled: false };
    }

    const collection = this.db.collection("telemetry_ts");
    const filter = { "meta.deviceId": query.deviceId, ts: { $gte: fromDate, $lte: toDate } };
    const total = await collection.countDocuments(filter);
    if (total <= cap) {
      const items = await collection.find(filter).sort({ ts: -1 }).limit(cap).toArray();
      return { items, total, sampled: false };
    }
    // Half as many buckets as the cap, and the first *and* last frame of each. With the first
    // frame only, the window's newest frame survived only if it happened to open its bucket, so
    // playback stopped up to a bucket short of now (about three minutes in a 24-hour window), and
    // the last position before a gap was lost the same way. A bucket with one frame yields it once.
    const buckets = Math.max(1, Math.floor(cap / 2));
    const bucketMs = Math.max(1, Math.ceil((toDate.getTime() - fromDate.getTime() + 1) / buckets));
    const items = await collection
      .aggregate(
        [
          { $match: filter },
          { $sort: { ts: 1 } },
          {
            $group: {
              _id: { $floor: { $divide: [{ $subtract: ["$ts", fromDate] }, bucketMs] } },
              first: { $first: "$$ROOT" },
              last: { $last: "$$ROOT" },
            },
          },
          {
            $project: {
              docs: {
                $cond: [{ $eq: ["$first._id", "$last._id"] }, ["$first"], ["$first", "$last"]],
              },
            },
          },
          { $unwind: "$docs" },
          { $replaceRoot: { newRoot: "$docs" } },
          { $sort: { ts: -1 } },
        ],
        { allowDiskUse: true, maxTimeMS: config.reportQueryTimeoutMs },
      )
      .toArray();
    return { items, total, sampled: true };
  }

  async queryAlerts(filters: {
    severity?: string;
    deviceId?: string;
    status?: string;
    from?: string;
    to?: string;
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
    // Onset window, bounds on `firstSeenAt` (a Mongo Date), matching the report aggregates. With a
    // window the MAX_ALERTS_PER_QUERY cap applies within it, so 告警史 can reach a past period whose
    // rows are older than the most-recent page.
    const fromDate = toBoundDate(filters.from);
    const toDate = toBoundDate(filters.to);
    if (fromDate || toDate) {
      const bound: Record<string, Date> = {};
      if (fromDate) bound.$gte = fromDate;
      if (toDate) bound.$lte = toDate;
      query.firstSeenAt = bound;
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
    from?: string;
    to?: string;
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
    // Same onset window as the Mongo path, kept in sync so the in-memory fallback filters the
    // same way. `firstSeenAt` is an ISO string here; compare on epoch ms.
    const fromMs = toBoundDate(filters.from)?.getTime();
    const toMs = toBoundDate(filters.to)?.getTime();
    if (fromMs !== undefined || toMs !== undefined) {
      items = items.filter((alert) => {
        const onset = Date.parse(alert.firstSeenAt ?? alert.ts);
        if (!Number.isFinite(onset)) return false;
        if (fromMs !== undefined && onset < fromMs) return false;
        if (toMs !== undefined && onset > toMs) return false;
        return true;
      });
    }
    return items
      .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))
      .slice(0, MAX_ALERTS_PER_QUERY);
  }

  /**
   * Server-side alert statistics over the whole `alerts` collection.
   *
   * The point of doing this in Mongo rather than in the browser (as the alert-history page does)
   * is to escape the 500-row read cap on `/api/alerts`: a `$facet` aggregate sees every alert in
   * the retention window, not just the newest page. With no Mongo there is no history to
   * aggregate, so this returns an honest-empty report flagged `available:false` — the same
   * contract the cleared-alert paths already keep — rather than a zero-filled one that would
   * read as "there were no alerts".
   */
  async aggregateAlertStats(range: { from?: string; to?: string }): Promise<AlertStatsReport> {
    if (!this.db) {
      return emptyAlertStatsReport(false);
    }
    const db = this.db;
    return this.withReportCache(`alerts:${range.from ?? ""}:${range.to ?? ""}`, async () => {
      const pipeline = buildAlertStatsPipeline({
        from: toBoundDate(range.from),
        to: toBoundDate(range.to),
        topN: ALERT_STATS_TOP_N,
        timezone: config.reportTimezone,
      });
      // `$facet` always yields exactly one document; the `?? {}` only satisfies the type for the
      // (unreachable) empty-cursor case, and the mapper turns it into a zeroed but available report.
      const [facet] = await db
        .collection("alerts")
        .aggregate<AlertStatsFacet>(pipeline, { maxTimeMS: config.reportQueryTimeoutMs })
        .toArray();
      return mapAlertStatsFacet(facet ?? {});
    });
  }

  /**
   * Server-side availability + battery time-series over `telemetry_ts`.
   *
   * Downsamples raw frames into (device × time-bucket) rows — online-frame ratio and soc
   * mean/min — via `$dateTrunc`, so the report page never scans the whole series client-side.
   * No Mongo means no history to aggregate, so this honest-empties with `available:false` like
   * the alert-stats path, rather than returning zero-filled buckets that read as "all offline".
   */
  async aggregateAvailability(params: {
    deviceId?: string[];
    from?: string;
    to?: string;
    bucket: ReportBucketUnit;
    /** How long one frame may stand for; defaults to the env offline threshold. */
    maxGapSeconds?: number;
  }): Promise<AvailabilityReport> {
    if (!this.db) {
      return emptyAvailabilityReport(params.bucket, false);
    }
    const db = this.db;
    const deviceIds = params.deviceId?.length ? params.deviceId : null;
    const maxGapMs = (params.maxGapSeconds ?? config.offlineAfterSeconds) * 1000;
    const key = `avail:${params.from ?? ""}:${params.to ?? ""}:${params.bucket}:${maxGapMs}:${
      deviceIds ? [...deviceIds].sort().join(",") : "*"
    }`;
    return this.withReportCache(key, async () => {
      const from = toBoundDate(params.from);
      const to = toBoundDate(params.to);
      // The window never runs past now: the current bucket counts only up to this moment.
      const nowDate = new Date();
      const horizon = to && to < nowDate ? to : nowDate;
      const timezone = config.reportTimezone;
      const aggregateOptions = { allowDiskUse: true, maxTimeMS: config.reportQueryTimeoutMs };
      // allowDiskUse: the per-device window sort over a long range can exceed the 100 MB
      // in-memory stage limit on a real fleet's frame count.
      const rawRows = (slice: { from: Date | null; to: Date | null; lookaheadMs?: number }) =>
        db
          .collection("telemetry_ts")
          .aggregate<AvailabilityRow>(
            buildAvailabilityPipeline({
              deviceIds,
              from: slice.from,
              to: slice.to,
              bucket: params.bucket,
              timezone,
              // A frame stands for at most the offline threshold: past that, silence is offline.
              maxGapMs,
              horizon,
              lookaheadMs: slice.lookaheadMs,
            }),
            aggregateOptions,
          )
          .toArray();

      if (!from || from >= horizon) {
        return mapAvailabilityRows(await rawRows({ from, to }), params.bucket, { from, horizon });
      }

      // Hours the rollup has summarised under this threshold and timezone are read from it; the
      // rest of the window (partial edge hours, the current hour, hours not yet summarised) from
      // raw frames. See reports/telemetryRollup for why: raw-only does not finish at 1 Hz.
      const runs = await db
        .collection<{ hour: Date }>(ROLLUP_RUNS_COLLECTION)
        .find(
          {
            hour: { $gte: new Date(floorToHour(from.getTime(), timezone)), $lt: horizon },
            maxGapMs,
            timezone,
          },
          { projection: { hour: 1 } },
        )
        .toArray();
      const plan = planAvailabilityWindow(
        from.getTime(),
        horizon.getTime(),
        new Set(runs.map((run) => run.hour.getTime())),
        timezone,
      );
      const parts = await Promise.all([
        plan.hours.length
          ? db
              .collection(ROLLUP_COLLECTION)
              .aggregate<AvailabilityRow>(
                buildRollupReportPipeline({
                  deviceIds,
                  hours: plan.hours.map((hour) => new Date(hour)),
                  bucket: params.bucket,
                  timezone,
                }),
                aggregateOptions,
              )
              .toArray()
          : Promise.resolve([]),
        ...plan.raw.map((slice) =>
          slice.to >= horizon.getTime()
            ? // The window's right edge: exactly the old single-pass query for this stretch.
              rawRows({ from: new Date(slice.from), to })
            : // An inner slice stops where summarised hours resume: read past its end only to give
              // its last frames their real successors.
              rawRows({
                from: new Date(slice.from),
                to: new Date(slice.to - 1),
                lookaheadMs: maxGapMs + 1,
              }),
        ),
      ]);
      return mapAvailabilityRows(mergeAvailabilityRows(parts.flat()), params.bucket, {
        from,
        horizon,
      });
    });
  }

  /**
   * Run `compute` unless a fresh cached value exists for `key`; cache the result for
   * `REPORT_CACHE_TTL_MS`. Sweeps expired keys lazily so the map can't grow unbounded across the
   * day's filter combinations. Errors are not cached — a failed aggregation must be retryable.
   */
  private async withReportCache<T>(key: string, compute: () => Promise<T>): Promise<T> {
    // Window ends rounded to the minute: the console asks for "the last 30 days up to now", so a
    // millisecond-exact key never repeated and the cache was never hit. A minute of staleness is
    // invisible on a report. (Only the key is rounded — the query keeps the exact bounds.)
    const cacheKey = key.replace(
      /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})/g,
      "$1$2",
    );
    const now = Date.now();
    const hit = this.reportCache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      return hit.value as T;
    }
    // Concurrent identical requests share one aggregation instead of each running it.
    const running = this.reportInFlight.get(cacheKey);
    if (running) return running as Promise<T>;
    for (const [cachedKey, entry] of this.reportCache) {
      if (entry.expiresAt <= now) this.reportCache.delete(cachedKey);
    }
    const pending = compute()
      .then((value) => {
        this.reportCache.set(cacheKey, { expiresAt: Date.now() + REPORT_CACHE_TTL_MS, value });
        return value;
      })
      .finally(() => this.reportInFlight.delete(cacheKey));
    this.reportInFlight.set(cacheKey, pending);
    return pending;
  }
}
