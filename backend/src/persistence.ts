import { Db, MongoClient, type MongoClientEvents } from "mongodb";
import { config } from "./config";
import { MongoConnectionSupervisor, type MongoSession, redactMongoUri } from "./mongoConnection";
import { DeviceAlert, DeviceSnapshot, HistoryQuery, UserRecord } from "./types";
import { moduleLogger } from "./logger";

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
}

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
  // Current active alerts per device, always kept in memory so /api/alerts stays
  // useful in local/dev runs without MongoDB (mirrors the telemetry fallback).
  private activeAlerts = new Map<string, StoredAlert[]>();
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

    await this.db.collection("device_latest").createIndex({ deviceId: 1 }, { unique: true });
    await this.db.collection("device_latest").createIndex({ stamp: -1 });
    await this.db.collection("alerts").createIndex({ deviceId: 1, ts: -1 });
    await this.db.collection("alerts").createIndex({ severity: 1, active: 1, ts: -1 });
    await this.db
      .collection("alerts")
      .createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: config.alertsRetentionSeconds });
    await this.db.collection("users").createIndex({ username: 1 }, { unique: true });
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
        $set: {
          passwordHash: user.passwordHash,
          role: user.role,
          updatedAt: user.updatedAt,
        },
        $setOnInsert: { username: user.username, createdAt: user.createdAt },
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

  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    if (!this.db) {
      return [];
    }
    return (await this.db.collection<DeviceSnapshot>("device_latest").find({}).toArray()).map(
      (item) => ({
        ...item,
        alerts: item.alerts || [],
        extra: item.extra || {},
        tags: item.tags || [],
      }),
    );
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
        vehicleModel: String(snapshot.extra.vehicleModel || "generic-agv"),
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
    this.activeAlerts.set(
      deviceId,
      alerts.map((alert) => ({
        eventKey: `${deviceId}:${alert.id}`,
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
      })),
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
          },
        },
      );
    } catch (error) {
      logger.warn({ err: error, deviceId }, "Failed to persist alerts to MongoDB");
    }
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

  pendingTelemetryCount(): number {
    return this.pendingTelemetry.length;
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
      .limit(500)
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
    return items.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts)).slice(0, 500);
  }
}
