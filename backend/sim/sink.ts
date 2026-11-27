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

/** The next shift change (08:00 or 20:00 on the site's clock) after `ms`. */
export const shiftChangeAfter = (ms: number): number => {
  const local = ms + 8 * 3_600_000;
  const day = Math.floor(local / 86_400_000) * 86_400_000;
  for (const hour of [8, 20, 32]) {
    const at = day + hour * 3_600_000 - 8 * 3_600_000;
    if (at > ms) return at;
  }
  return ms + 12 * 3_600_000;
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
  /** Re-notify dedup: when each (occurrence, channel) was last delivered. */
  private readonly lastSentAt = new Map<string, number>();
  /** Digest buffers per channel, flushed by `tickNotify`. */
  private readonly digests = new Map<
    string,
    { since: number; items: Array<{ deviceId: string; title: string; severity: string }> }
  >();
  /** Escalations armed by a critical send, by occurrence; fired by `tickNotify` unless cancelled. */
  private readonly escalations = new Map<
    string,
    {
      dueAt: number;
      channelId: string;
      deviceId: string;
      alertId: string;
      severity: string;
      title: string;
    }
  >();
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
      this.escalations.delete(eventKey);
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
    if (roll < claimP) {
      this.claim(doc, actor, actAt);
      this.followUpClaim(doc, actor, actAt, boundMs, rng);
      return;
    }
    if (roll < claimP + ignoreP) {
      const pool =
        IGNORE_REASONS[planned ? "planned" : offline ? "offline" : String(doc.code)] ?? [];
      const reason = pool.length && (planned || rng.chance(0.6)) ? (rng.pick(pool) ?? null) : null;
      this.ignore(doc, actor, actAt, reason);
      // Now and then an ignore was a mistake — a critical one especially gets a second look —
      // and is withdrawn a few minutes later (取消忽略), after which someone may still claim it.
      const undoP = doc.severity === "critical" ? 0.25 : 0.04;
      const undoAt = actAt + rng.between(2, 10) * 60_000;
      if (!planned && rng.chance(undoP) && undoAt < boundMs) {
        this.audit(actor, "alert_unignore", doc, undoAt);
        doc.ignoredBy = null;
        doc.ignoredAt = null;
        doc.ignoreReason = null;
        doc.version += 1;
        const claimAt = undoAt + rng.between(0.5, 3) * 60_000;
        if (rng.chance(0.6) && claimAt < boundMs) {
          this.claim(doc, operatorAt(claimAt), claimAt);
        }
      }
    }
  }

  /**
   * What happens to a claim before the occurrence clears: the claimant hands it back at the end of
   * a shift (释放认领) and the next shift claims it; or the investigation finds it expected and it
   * is ignored on top of the claim (认领后忽略 — the claim stays, as the live write path keeps it).
   */
  private followUpClaim(
    doc: AlertDoc,
    actor: string,
    claimedAt: number,
    boundMs: number,
    rng: Rng,
  ): void {
    const handover = shiftChangeAfter(claimedAt);
    if (handover < boundMs && rng.chance(0.85)) {
      const releaseAt = handover - rng.between(1, 10) * 60_000;
      if (releaseAt > claimedAt) {
        this.audit(actor, "alert_release", doc, releaseAt);
        doc.claimedBy = null;
        doc.claimedAt = null;
        doc.version += 1;
        const reclaimAt = handover + rng.between(2, 15) * 60_000;
        if (reclaimAt < boundMs) this.claim(doc, operatorAt(reclaimAt), reclaimAt);
        return;
      }
    }
    const ignoreAt = claimedAt + rng.between(3, 20) * 60_000;
    if (doc.severity !== "critical" && rng.chance(0.08) && ignoreAt < boundMs) {
      this.ignore(doc, actor, ignoreAt, "现场确认为预期，转忽略");
    }
  }

  private claim(doc: AlertDoc, actor: string, at: number): void {
    doc.claimedBy = actor;
    doc.claimedAt = new Date(at).toISOString();
    doc.version += 1;
    this.audit(actor, "alert_claim", doc, at);
    this.stats.claimed += 1;
    // Attended to: an armed escalation for it is cancelled, as `onAlertResolved` does live.
    this.escalations.delete(doc.eventKey);
  }

  private ignore(doc: AlertDoc, actor: string, at: number, reason: string | null): void {
    doc.ignoredBy = actor;
    doc.ignoredAt = new Date(at).toISOString();
    doc.ignoreReason = reason;
    doc.version += 1;
    this.audit(actor, "alert_ignore", doc, at, reason ? { reason } : undefined);
    this.stats.ignored += 1;
    this.escalations.delete(doc.eventKey);
  }

  private audit(
    actor: string,
    action: string,
    doc: AlertDoc,
    at: number,
    detail?: Record<string, unknown>,
  ): void {
    this.audits.push({
      ts: new Date(at),
      actor,
      action,
      target: doc.eventKey,
      outcome: "success",
      ...(detail ? { detail } : {}),
    });
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
      // The same occurrence re-sent within the channel's window is suppressed, as live.
      const renotify = (channel.renotifySeconds ?? 0) * 1000;
      const dedupKey = `${eventKey}::${channel.id}`;
      const lastSent = this.lastSentAt.get(dedupKey);
      if (renotify > 0 && lastSent !== undefined && onset - lastSent < renotify) continue;
      // Digested severities wait for the channel's next flush (a critical never does).
      if (
        (channel.digestSeconds ?? 0) > 0 &&
        alert.severity !== "critical" &&
        (channel.digestSeverities ?? ["warning", "notice"]).includes(alert.severity)
      ) {
        this.bufferDigest(channel, deviceId, alert, onset);
        continue;
      }
      const delivered = this.pushSend(channel, {
        at: onset,
        eventKey,
        deviceId,
        alertId: alert.id,
        severity: alert.severity,
        title: alert.title,
      });
      if (delivered) this.lastSentAt.set(dedupKey, onset);
      if (channel.escalation && alert.severity === "critical") {
        this.escalations.set(eventKey, {
          dueAt: onset + Math.max(1, channel.escalation.afterSeconds) * 1000,
          channelId: channel.escalation.channelId,
          deviceId,
          alertId: alert.id,
          severity: alert.severity,
          title: alert.title,
        });
      }
    }
  }

  /**
   * One delivery as `NotifyService` would record it: timing by channel kind, and the occasional
   * failure an endpoint answers — a group robot's rate limit, the ticket system's gateway timing
   * out (retried up to `NOTIFY_MAX_ATTEMPTS`, usually getting through), the mail relay refusing a
   * connection. Deterministic per send. Returns whether it was delivered.
   */
  private pushSend(
    channel: NotifyConfig["channels"][number],
    send: {
      at: number;
      eventKey: string;
      deviceId: string;
      alertId: string;
      severity: string;
      title: string;
    },
  ): boolean {
    const rng = new Rng(seedOf(`send:${send.eventKey}:${channel.id}:${send.at}`));
    const maxAttempts = Math.max(1, config.notifyMaxAttempts);
    const email = channel.type === "email";
    const robot = channel.type === "wecom" || channel.type === "dingtalk";
    const once = (): number => Math.round(email ? rng.between(300, 1500) : rng.between(60, 400));
    let attempts = 1;
    let latencyMs = once();
    let status: "sent" | "failed" = "sent";
    let httpStatus: number | null = email ? null : 200;
    let error: string | null = null;
    const roll = rng.next();
    if (robot && roll < 0.006) {
      // The robot answers HTTP 200 but refuses: too many messages this minute. Not retried.
      status = "failed";
      error =
        channel.type === "wecom"
          ? "errcode 45009：api freq out of limit"
          : "errcode 130101：send too fast, exceed 20 times per minute";
    } else if (channel.type === "webhook" && roll < 0.05) {
      // The receiving gateway times out: retried with a linear backoff, usually through.
      attempts = rng.chance(0.75) ? 2 : maxAttempts;
      const through = attempts < maxAttempts || rng.chance(0.4);
      latencyMs = through ? once() : Math.round(rng.between(3000, config.notifyTimeoutMs));
      if (!through) {
        status = "failed";
        httpStatus = rng.chance(0.5) ? 502 : 504;
        error = `HTTP ${httpStatus}`;
      }
    } else if (email && roll < 0.01) {
      status = "failed";
      attempts = maxAttempts;
      error = "connect ECONNREFUSED 10.20.0.25:1025";
    }
    // Backoff between attempts (200 ms × n) is part of when the record is written.
    const backoff = ((attempts - 1) * attempts * 200) / 2;
    const ts = new Date(send.at + backoff + latencyMs);
    this.sends.push({
      ts: ts.toISOString(),
      expireAt: ts,
      eventKey: send.eventKey,
      channelId: channel.id,
      channelType: channel.type,
      deviceId: send.deviceId,
      alertId: send.alertId,
      severity: send.severity,
      title: send.title,
      status,
      httpStatus,
      attempts,
      latencyMs,
      error,
    });
    this.stats.sends += 1;
    return status === "sent";
  }

  /** Hold a digested alert for its channel's next flush (`NotifyService.bufferForDigest`). */
  private bufferDigest(
    channel: NotifyConfig["channels"][number],
    deviceId: string,
    alert: DeviceAlert,
    onset: number,
  ): void {
    const buffer = this.digests.get(channel.id) ?? { since: onset, items: [] };
    buffer.items.push({ deviceId, title: alert.title, severity: alert.severity });
    this.digests.set(channel.id, buffer);
  }

  /**
   * Flush ripe digests and fire due escalations, at the simulated clock (`NotifyService` runs both
   * on timers). An escalation is cancelled when its occurrence is claimed, ignored or cleared first.
   */
  tickNotify(now: number): void {
    for (const [channelId, buffer] of this.digests) {
      const channel = this.notify.config.channels.find((entry) => entry.id === channelId);
      if (!channel || now - buffer.since < (channel.digestSeconds ?? 0) * 1000) continue;
      this.digests.delete(channelId);
      const devices = new Set(buffer.items.map((item) => item.deviceId));
      const worst = buffer.items.some((item) => item.severity === "warning") ? "warning" : "notice";
      this.pushSend(channel, {
        at: now,
        eventKey: `digest:${channelId}:${now}`,
        deviceId: devices.size === 1 ? buffer.items[0]!.deviceId : "-",
        alertId: "digest",
        severity: worst,
        title: `${buffer.items.length} 条消息汇总`,
      });
    }
    for (const [eventKey, due] of this.escalations) {
      if (now < due.dueAt) continue;
      this.escalations.delete(eventKey);
      const target = this.notify.config.channels.find(
        (entry) => entry.id === due.channelId && entry.enabled,
      );
      if (!target || !process.env[target.urlEnv]) continue;
      this.pushSend(target, {
        at: due.dueAt,
        eventKey,
        deviceId: due.deviceId,
        alertId: due.alertId,
        severity: due.severity,
        title: `【升级】${due.title}`,
      });
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
