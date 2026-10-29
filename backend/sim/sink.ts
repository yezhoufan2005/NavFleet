/**
 * Where the history backfill's `DashboardStore` writes: the same documents the backend's
 * `Persistence` writes, batched.
 *
 * The backfill runs a month of frames through a real `DashboardStore` — normalisation, merge,
 * rule evaluation, debounce, the offline sweep — so what lands is exactly what the live path
 * would have produced. Only the writes differ: `Persistence` does one round trip per frame,
 * which at 1 Hz × 29 vehicles × 30 days is days of work. This sink keeps the per-frame semantics
 * and turns them into bulk inserts:
 *
 * - telemetry: `toTelemetryDocument`, inserted in batches; a frame at or before the last one
 *   already stored for the vehicle is skipped (the timeline is deterministic, so a replay from a
 *   checkpoint that is a second behind produces the very frames that are already there);
 * - alerts: `Persistence.upsertAlerts`'s reconciliation replayed in memory — an alert still in
 *   the set keeps its occurrence, one that left it is closed at the store's clock, a new one
 *   opens an occurrence — so closed occurrences are inserted once, complete, and the ones still
 *   open at the end are handed over to the live backend as active documents;
 * - device_latest: the last snapshot per vehicle, written at the end.
 *
 * Each new occurrence is also routed the way `NotifyService` routes `alert.created` — channel
 * severities, device scope, silence windows — and a delivered send is recorded in `notify_log`,
 * so the outbound history matches the messages it is about.
 *
 * Closed occurrences are acknowledged the way a staffed site acknowledges them: by whoever is
 * on shift, mostly for faults, sometimes for warnings, rarely for notices, a few minutes after
 * onset, with an `alert_ack` audit entry at that moment. Occurrences still open at the hand-over
 * are left unacknowledged for the people using the console.
 */
import { MongoClient, type Db } from "mongodb";
import { config } from "../src/config";
import { toTelemetryDocument, type TelemetryDocument } from "../src/persistence";
import { selectChannelsForAlert, type ScopeDevice } from "../src/notify/routing";
import { isWithinSilence } from "../src/notify/silence";
import type { DeviceAlert, DeviceSnapshot, NotifyConfig } from "../src/types";
import { Rng, seedOf } from "./rng";
import { localHour } from "./profiles";

interface AlertDoc {
  eventKey: string;
  deviceId: string;
  alertId: string;
  severity: string;
  title: string;
  detail: string;
  source: string;
  ts: string;
  active: boolean;
  code: number | null;
  info: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  clearedAt: Date | null;
  ackedBy: string | null;
  ackedAt: Date | null;
  comment: string | null;
}

const BATCH = 5000;

const COMMENTS: Record<string, string[]> = {
  "5101": ["已人工重定位", "现场确认后恢复"],
  "5202": ["障碍已清除", "通道已清理"],
  "5203": ["已断电重启驱动器", "已通知维修"],
  "5301": ["已人工推回充电位"],
  "5401": ["已清洁雷达并重启", "雷达线缆松动，已紧固"],
  "5501": ["调度已重派", "已人工补料"],
  "5701": ["现场已复位", "已通知维修，复位后恢复"],
  "5702": ["已排查，误触发", "现场已确认"],
  offline: ["网络已恢复", "已通知网络运维"],
};

/** Day shift 08–20 and night shift — the two operators `seed-demo` creates. */
export const operatorAt = (ms: number): string => {
  const hour = localHour(ms);
  return hour >= 8 && hour < 20 ? "zhaoyun" : "qianwei";
};

export interface SinkStats {
  frames: number;
  skippedFrames: number;
  closed: number;
  handedOver: number;
  acks: number;
  sends: number;
}

export class BackfillSink {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private readonly storedUntil = new Map<string, number>();
  private telemetry: TelemetryDocument[] = [];
  private closed: AlertDoc[] = [];
  private audits: Record<string, unknown>[] = [];
  private sends: Record<string, unknown>[] = [];
  /** deviceId → eventKey → the open occurrence (and whether it already exists in MongoDB). */
  private readonly open = new Map<string, Map<string, { doc: AlertDoc; stored: boolean }>>();
  private readonly latest = new Map<string, DeviceSnapshot>();
  readonly stats: SinkStats = {
    frames: 0,
    skippedFrames: 0,
    closed: 0,
    handedOver: 0,
    acks: 0,
    sends: 0,
  };

  constructor(
    private readonly deviceIds: ReadonlySet<string>,
    private readonly notify: { config: NotifyConfig; device: (deviceId: string) => ScopeDevice },
  ) {}

  // ── The surface DashboardStore calls ──────────────────────────────────────────

  async connect(): Promise<void> {
    this.client = await MongoClient.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
    this.db = this.client.db(config.mongoDbName);
    for (const deviceId of this.deviceIds) {
      const last = await this.db
        .collection<TelemetryDocument>("telemetry_ts")
        .find({ "meta.deviceId": deviceId }, { projection: { ts: 1 } })
        .sort({ ts: -1 })
        .limit(1)
        .next();
      if (last) this.storedUntil.set(deviceId, last.ts.getTime());
    }
    const active = await this.db
      .collection<AlertDoc>("alerts")
      .find({ active: true, deviceId: { $in: [...this.deviceIds] } }, { projection: { _id: 0 } })
      .toArray();
    for (const doc of active) this.openFor(doc.deviceId).set(doc.eventKey, { doc, stored: true });
  }

  /** The snapshots the live backend left, for this shard's vehicles only. */
  async restoreLatestDevices(): Promise<DeviceSnapshot[]> {
    const rows = await this.requireDb()
      .collection<DeviceSnapshot>("device_latest")
      .find({ deviceId: { $in: [...this.deviceIds] } }, { projection: { _id: 0 } })
      .toArray();
    return rows.map((row) => ({
      ...row,
      alerts: row.alerts || [],
      extra: row.extra || {},
      tags: row.tags || [],
    }));
  }

  writeLatestSnapshot(snapshot: DeviceSnapshot): Promise<void> {
    if (this.deviceIds.has(snapshot.deviceId)) this.latest.set(snapshot.deviceId, snapshot);
    return Promise.resolve();
  }

  async writeTelemetry(snapshot: DeviceSnapshot): Promise<void> {
    if (!this.deviceIds.has(snapshot.deviceId)) return;
    const document = toTelemetryDocument(snapshot);
    if (document.ts.getTime() <= (this.storedUntil.get(snapshot.deviceId) ?? -Infinity)) {
      this.stats.skippedFrames += 1;
      return;
    }
    this.telemetry.push(document);
    this.stats.frames += 1;
    if (this.telemetry.length >= BATCH) await this.flushTelemetry();
  }

  /** `Persistence.upsertAlerts`, in memory. */
  async upsertAlerts(deviceId: string, alerts: DeviceAlert[], at: Date): Promise<void> {
    if (!this.deviceIds.has(deviceId)) return;
    const open = this.openFor(deviceId);
    const current = new Set<string>();
    for (const alert of alerts) {
      const eventKey = `${deviceId}:${alert.id}`;
      current.add(eventKey);
      const fields = {
        eventKey,
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
      };
      const existing = open.get(eventKey);
      if (existing) {
        Object.assign(existing.doc, fields);
      } else {
        open.set(eventKey, {
          doc: {
            ...fields,
            firstSeenAt: new Date(alert.ts),
            clearedAt: null,
            ackedBy: null,
            ackedAt: null,
            comment: null,
          },
          stored: false,
        });
        this.recordSends(deviceId, alert, eventKey);
      }
    }
    for (const [eventKey, entry] of open) {
      if (current.has(eventKey)) continue;
      open.delete(eventKey);
      entry.doc.active = false;
      entry.doc.clearedAt = at;
      entry.doc.lastSeenAt = at;
      this.acknowledge(entry.doc);
      if (entry.stored) {
        await this.requireDb()
          .collection("alerts")
          .updateOne(
            { eventKey, active: true },
            {
              $set: { active: false, clearedAt: at, lastSeenAt: at, ...this.ackFields(entry.doc) },
            },
          );
      } else {
        this.closed.push(entry.doc);
      }
      this.stats.closed += 1;
    }
    if (this.closed.length >= BATCH) await this.flushAlerts();
  }

  forgetDevice(): void {}

  // ── Hand-over ────────────────────────────────────────────────────────────────

  /** Write everything still buffered, the open occurrences and the latest snapshots. */
  async finish(): Promise<void> {
    await this.flushTelemetry();
    await this.flushAlerts();
    const db = this.requireDb();
    for (const open of this.open.values()) {
      for (const { doc, stored } of open.values()) {
        if (stored) continue;
        const { firstSeenAt, clearedAt, ackedBy, ackedAt, comment, ...rest } = doc;
        await db
          .collection("alerts")
          .updateOne(
            { eventKey: doc.eventKey, active: true },
            { $set: rest, $setOnInsert: { firstSeenAt, clearedAt, ackedBy, ackedAt, comment } },
            { upsert: true },
          );
        this.stats.handedOver += 1;
      }
    }
    for (const snapshot of this.latest.values()) {
      await db
        .collection<DeviceSnapshot>("device_latest")
        .updateOne({ deviceId: snapshot.deviceId }, { $set: snapshot }, { upsert: true });
    }
    await this.client?.close();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private requireDb(): Db {
    if (!this.db) throw new Error("BackfillSink used before connect()");
    return this.db;
  }

  private openFor(deviceId: string) {
    let open = this.open.get(deviceId);
    if (!open) {
      open = new Map();
      this.open.set(deviceId, open);
    }
    return open;
  }

  private ackFields(doc: AlertDoc) {
    return { ackedBy: doc.ackedBy, ackedAt: doc.ackedAt, comment: doc.comment };
  }

  /** Decide whether, by whom and when a closed occurrence was acknowledged; deterministic per occurrence. */
  private acknowledge(doc: AlertDoc): void {
    if (doc.ackedBy) return;
    const onset = doc.firstSeenAt.getTime();
    const end = doc.clearedAt?.getTime() ?? onset;
    const rng = new Rng(seedOf(`ack:${doc.eventKey}:${onset}`));
    const offline = doc.alertId.endsWith("-offline");
    const planned = offline && end - onset >= 90 * 60_000;
    const chance = planned
      ? 1
      : doc.severity === "critical"
        ? 0.92
        : doc.severity === "warning"
          ? 0.4
          : 0.03;
    const ackAt = onset + rng.between(0.5, planned ? 5 : 8) * 60_000;
    if (!rng.chance(chance) || ackAt >= end) return;
    const pool = planned
      ? ["计划内维护"]
      : (COMMENTS[offline ? "offline" : String(doc.code)] ?? []);
    doc.ackedBy = planned ? "admin" : operatorAt(ackAt);
    doc.ackedAt = new Date(ackAt);
    doc.comment = pool.length && (planned || rng.chance(0.4)) ? (rng.pick(pool) ?? null) : null;
    this.audits.push({
      ts: doc.ackedAt,
      actor: doc.ackedBy,
      action: "alert_ack",
      target: doc.eventKey,
      outcome: "success",
      ...(doc.comment ? { detail: { comment: doc.comment } } : {}),
    });
    this.stats.acks += 1;
  }

  /** What `NotifyService` would have delivered for this new occurrence. */
  private recordSends(deviceId: string, alert: DeviceAlert, eventKey: string): void {
    const onset = Date.parse(alert.ts);
    if (!Number.isFinite(onset)) return;
    const channels = selectChannelsForAlert(
      this.notify.config,
      { severity: alert.severity },
      this.notify.device(deviceId),
    );
    for (const channel of channels) {
      // No endpoint configured means the live service sends nothing, so neither does history.
      if (!process.env[channel.urlEnv]) continue;
      if (isWithinSilence(new Date(onset), channel.silenceWindows)) continue;
      const rng = new Rng(seedOf(`send:${eventKey}:${channel.id}:${onset}`));
      const latencyMs = Math.round(
        channel.type === "email" ? rng.between(300, 1500) : rng.between(60, 400),
      );
      const ts = new Date(onset + latencyMs);
      this.sends.push({
        ts: ts.toISOString(),
        expireAt: ts,
        eventKey,
        channelId: channel.id,
        channelType: channel.type,
        deviceId,
        alertId: alert.id,
        severity: alert.severity,
        title: alert.title,
        status: "sent",
        httpStatus: channel.type === "email" ? null : 200,
        attempts: 1,
        latencyMs,
        error: null,
      });
      this.stats.sends += 1;
    }
  }

  private async flushTelemetry(): Promise<void> {
    if (!this.telemetry.length) return;
    const batch = this.telemetry;
    this.telemetry = [];
    await this.requireDb().collection("telemetry_ts").insertMany(batch, { ordered: false });
  }

  private async flushAlerts(): Promise<void> {
    const db = this.requireDb();
    if (this.closed.length) {
      const batch = this.closed;
      this.closed = [];
      await db.collection("alerts").insertMany(batch, { ordered: false });
    }
    if (this.sends.length) {
      const batch = this.sends;
      this.sends = [];
      await db.collection("notify_log").insertMany(batch, { ordered: false });
    }
    if (this.audits.length) {
      const batch = this.audits;
      this.audits = [];
      await db.collection("audit_log").insertMany(batch, { ordered: false });
    }
  }
}
