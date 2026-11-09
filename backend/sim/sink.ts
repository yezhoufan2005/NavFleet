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
 *   checkpoint that is a second behind produces the very frames that are already there); an hour
 *   that already has a report summary is marked stale, as `Persistence` does for late frames;
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
 * Both open and closed occurrences carry a **disposition** the way a staffed site handles them —
 * the human axis orthogonal to the signal (see `@navfleet/shared` `alertDisposition`). A few
 * minutes after onset an on-shift operator either claims it (认领, investigating) or ignores it as
 * expected noise (忽略), mostly claiming faults and ignoring notices; otherwise no one engages and
 * it is left unhandled. For a closed occurrence that disposition decides its close kind
 * (claimed→处理后消除, ignored→已忽略后消除, neither→自动恢复); for one still open at the hand-over
 * it is the live state the console shows (处理中 / 已忽略 / 待处理). Each claim/ignore writes an
 * `alert_claim` / `alert_ignore` audit entry at that moment and bumps the optimistic-lock version.
 */
import { MongoClient, type Db } from "mongodb";
import { config } from "../src/config";
import { toTelemetryDocument, type TelemetryDocument } from "../src/persistence";
import { floorToHour, ROLLUP_RUNS_COLLECTION } from "../src/reports/telemetryRollup";
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
  // Disposition (human axis). `claimedAt`/`ignoredAt` are ISO strings like the live write path;
  // `version` is the optimistic-lock counter (0 = untouched, bumped on each disposition write).
  claimedBy: string | null;
  claimedAt: string | null;
  ignoredBy: string | null;
  ignoredAt: string | null;
  ignoreReason: string | null;
  version: number;
}

const BATCH = 5000;

/**
 * Why an occurrence was ignored (忽略) — dismissed as expected/noise, keyed by report code, with a
 * planned-maintenance and an offline pool. A claim (认领) carries no reason: the console records
 * only that someone is investigating, not an off-line resolution note (read-only monitoring).
 */
const IGNORE_REASONS: Record<string, string[]> = {
  "5101": ["定位漂移，已复核"],
  "5703": ["误触发，现场无障碍"],
  "5203": ["瞬时报错，已自恢复"],
  "5301": ["低电量，调度已知"],
  "5401": ["雷达瞬时噪声"],
  "5501": ["排产间隙，预期内"],
  "5701": ["演练触发，非真实"],
  "5702": ["误触发，已确认"],
  offline: ["网络抖动，已知", "弱覆盖区，正常"],
  planned: ["计划内维护"],
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
  claimed: number;
  ignored: number;
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
    claimed: 0,
    ignored: 0,
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
        lastSeenAt: at,
      };
      const existing = open.get(eventKey);
      if (existing) {
        Object.assign(existing.doc, fields);
      } else {
        open.set(eventKey, {
          doc: {
            ...fields,
            firstSeenAt: new Date(alert.firstSeenAt ?? alert.ts),
            clearedAt: null,
            claimedBy: null,
            claimedAt: null,
            ignoredBy: null,
            ignoredAt: null,
            ignoreReason: null,
            version: 0,
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
      this.dispose(entry.doc, at.getTime());
      if (entry.stored) {
        await this.requireDb()
          .collection("alerts")
          .updateOne(
            { eventKey, active: true },
            {
              $set: {
                active: false,
                clearedAt: at,
                lastSeenAt: at,
                ...this.dispositionFields(entry.doc),
              },
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
        // Still firing at the hand-over: give it a live disposition (处理中 / 已忽略 / 待处理) the
        // same way, bounded by the last frame we saw it in, then hand it to the live backend.
        this.dispose(doc, doc.lastSeenAt.getTime());
        const {
          firstSeenAt,
          clearedAt,
          claimedBy,
          claimedAt,
          ignoredBy,
          ignoredAt,
          ignoreReason,
          version,
          ...rest
        } = doc;
        await db.collection("alerts").updateOne(
          { eventKey: doc.eventKey, active: true },
          {
            $set: rest,
            $setOnInsert: {
              firstSeenAt,
              clearedAt,
              claimedBy,
              claimedAt,
              ignoredBy,
              ignoredAt,
              ignoreReason,
              version,
            },
          },
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

  private dispositionFields(doc: AlertDoc) {
    return {
      claimedBy: doc.claimedBy,
      claimedAt: doc.claimedAt,
      ignoredBy: doc.ignoredBy,
      ignoredAt: doc.ignoredAt,
      ignoreReason: doc.ignoreReason,
      version: doc.version,
    };
  }

  /**
   * Give an occurrence its human disposition, deterministic per occurrence: a few minutes after
   * onset an on-shift operator claims it (认领) or ignores it (忽略), or no one engages and it is
   * left unhandled. The split follows a staffed site — faults mostly claimed, notices mostly
   * ignored or left alone; a long planned offline is ignored as 计划内维护. `boundMs` caps the
   * action time (clearedAt for a closed occurrence, the last frame seen for one still open): past
   * it, no one got to it in time, so it stays unhandled (→ 自动恢复 once closed).
   */
  private dispose(doc: AlertDoc, boundMs: number): void {
    if (doc.claimedBy || doc.ignoredBy) return;
    const onset = doc.firstSeenAt.getTime();
    const rng = new Rng(seedOf(`disp:${doc.eventKey}:${onset}`));
    const offline = doc.alertId.endsWith("-offline");
    const planned = offline && boundMs - onset >= 90 * 60_000;
    const actAt = onset + rng.between(0.5, planned ? 5 : 8) * 60_000;
    if (actAt >= boundMs) return;

    // claim / ignore probabilities by severity; the remainder is left unhandled. A planned outage
    // is always ignored (计划内维护). Draw `roll` once and split the unit interval between the two.
    const [claimP, ignoreP] = planned
      ? [0, 1]
      : doc.severity === "critical"
        ? [0.55, 0.12]
        : doc.severity === "warning"
          ? [0.3, 0.28]
          : [0.08, 0.32];
    const roll = rng.next();
    const actor = operatorAt(actAt);
    const atIso = new Date(actAt).toISOString();
    if (roll < claimP) {
      doc.claimedBy = actor;
      doc.claimedAt = atIso;
      doc.version = 1;
      this.audits.push({
        ts: new Date(actAt),
        actor,
        action: "alert_claim",
        target: doc.eventKey,
        outcome: "success",
      });
      this.stats.claimed += 1;
      return;
    }
    // __IGNORE_BRANCH__
    if (roll < claimP + ignoreP) {
      const pool =
        IGNORE_REASONS[planned ? "planned" : offline ? "offline" : String(doc.code)] ?? [];
      const reason = pool.length && (planned || rng.chance(0.6)) ? (rng.pick(pool) ?? null) : null;
      doc.ignoredBy = actor;
      doc.ignoredAt = atIso;
      doc.ignoreReason = reason;
      doc.version = 1;
      this.audits.push({
        ts: new Date(actAt),
        actor,
        action: "alert_ignore",
        target: doc.eventKey,
        outcome: "success",
        ...(reason ? { detail: { reason } } : {}),
      });
      this.stats.ignored += 1;
    }
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
      if (isWithinSilence(new Date(onset), channel.silenceWindows, config.reportTimezone)) continue;
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
    const db = this.requireDb();
    await db.collection("telemetry_ts").insertMany(batch, { ordered: false });
    // Like `Persistence`: frames that land in an hour already summarised make that hour stale.
    // The catch-up summarises after its big round, then writes the time that took — whose first
    // hour was summarised from the frames up to the round's end.
    const currentHour = floorToHour(Date.now(), config.reportTimezone);
    const hours = new Set<number>();
    for (const document of batch) {
      const ts = document.ts.getTime();
      if (ts < currentHour) hours.add(floorToHour(ts, config.reportTimezone));
    }
    if (hours.size) {
      await db
        .collection(ROLLUP_RUNS_COLLECTION)
        .deleteMany({ hour: { $in: [...hours].map((hour) => new Date(hour)) } });
    }
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
