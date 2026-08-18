import { Db, MongoClient } from "mongodb";
import pino from "pino";
import { config } from "./config";
import { DeviceAlert, DeviceSnapshot, HistoryQuery, UserRecord } from "./types";

const logger = pino({ name: "persistence" });

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

export class Persistence {
  private mongoClient: MongoClient | null = null;
  private db: Db | null = null;
  private pendingTelemetry: TelemetryDocument[] = [];
  // In-memory user store used when MongoDB is unavailable, so auth still works
  // for local/dev runs (mirrors the telemetry in-memory fallback).
  private fallbackUsers = new Map<string, UserRecord>();

  async connect(): Promise<void> {
    await this.connectMongo();
  }

  private async connectMongo(): Promise<void> {
    try {
      this.mongoClient = new MongoClient(config.mongoUri, {
        serverSelectionTimeoutMS: 3000,
      });
      await this.mongoClient.connect();
      this.db = this.mongoClient.db(config.mongoDbName);
      await this.ensureMongoCollections();
      logger.info({ uri: config.mongoUri, db: config.mongoDbName }, "MongoDB connected");
    } catch (error) {
      this.mongoClient = null;
      this.db = null;
      logger.warn(
        { err: error, uri: config.mongoUri },
        "MongoDB unavailable; running with in-memory history fallback",
      );
    }
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

    if (!this.db) {
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
      this.pendingTelemetry.push(document);
      if (this.pendingTelemetry.length > config.mongoBufferLimit) {
        this.pendingTelemetry.splice(0, this.pendingTelemetry.length - config.mongoBufferLimit);
      }
    }
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
    if (!this.db) {
      return;
    }

    const collection = this.db.collection("alerts");
    const activeKeys = new Set(alerts.map((alert) => `${deviceId}:${alert.id}`));

    await Promise.all(
      alerts.map((alert) =>
        collection.updateOne(
          { eventKey: `${deviceId}:${alert.id}` },
          {
            $set: {
              eventKey: `${deviceId}:${alert.id}`,
              deviceId,
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
  }

  async queryHistory(query: HistoryQuery): Promise<unknown[]> {
    if (!this.db) {
      return [];
    }

    const filter: Record<string, unknown> = {
      "meta.deviceId": query.deviceId,
    };
    if (query.from || query.to) {
      filter.ts = {};
      if (query.from) {
        (filter.ts as Record<string, unknown>).$gte = new Date(query.from);
      }
      if (query.to) {
        (filter.ts as Record<string, unknown>).$lte = new Date(query.to);
      }
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
      return [];
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

    return this.db.collection("alerts").find(query).sort({ ts: -1 }).limit(500).toArray();
  }
}
