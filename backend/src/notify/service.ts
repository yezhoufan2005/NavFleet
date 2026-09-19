/**
 * The outbound-notification service. It turns a freshly-created alert into zero or more channel
 * sends, applies the delivery policy (silence / re-notify dedup / digest / escalation), records
 * each send, and answers the read-only 外发 page's two questions (recent sends, effective channels).
 *
 * **Fire-and-forget, off `alert.created`, never on the ingest path** (16D-1): that event is emitted
 * synchronously inside the store's serial mutation queue, so the composition root subscribes
 * `dispatch` un-awaited and `dispatch` catches everything — an escaping rejection would land on
 * `unhandledRejection`.
 *
 * Policy (16D-2a), all off by default (zero-config sends immediately to every matching channel):
 * - **silence**: an alert falling in a channel's quiet-hours window is dropped (logged, not recorded).
 * - **re-notify dedup**: the same `(eventKey, channel)` is not re-sent within `renotifySeconds`.
 * - **digest**: a channel's `digestSeverities` are buffered and flushed as one combined send every
 *   `digestSeconds`; **critical is never digested** (always immediate).
 * - **escalation**: a critical alert unacked/uncleared for `afterSeconds` is re-sent to another channel.
 *   Timers are in-memory (single-instance); a restart forgets pending escalations (documented).
 */
import { moduleLogger } from "../logger";
import type { Persistence } from "../persistence";
import type {
  DeviceAlert,
  DeviceSnapshot,
  NotifyChannelView,
  NotifyConfig,
  NotifySendRecord,
  Severity,
} from "../types";
import { emailSubject, plainLines, sendToChannel, type NotifyAlertContext } from "./channels";
import { sendEmail, type EmailSendOptions } from "./email";
import { resolveRecipients } from "./recipients";
import { selectChannelsForAlert } from "./routing";
import { isWithinSilence } from "./silence";
import type { AttemptOutcome } from "./retry";

const logger = moduleLogger("notify");

/** Ranks severities so a digest's synthetic severity is the most serious one it carries. */
const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, notice: 1 };

/** Default digested severities when a channel sets `digestSeconds` but not `digestSeverities`. */
const DIGESTABLE_BY_DEFAULT: Severity[] = ["warning", "notice"];

/** Cap on the re-notify bookkeeping map, so a long-running process cannot grow it without bound. */
const MAX_LAST_SENT = 5000;

/** The device fields the service needs: scope matching plus a display name for the message body. */
export type NotifyDevice = Pick<
  DeviceSnapshot,
  "deviceId" | "deviceName" | "formationIds" | "tags"
>;

/** The `alert.created` event payload the store emits (`{ source, deviceId, alert }`). */
export interface AlertCreatedEvent {
  source: string;
  deviceId: string;
  alert: DeviceAlert;
}

export interface NotifyServiceDeps {
  persistence: Pick<Persistence, "appendNotify" | "queryNotify">;
  /** The config in effect; read per alert / per flush (a reload swaps it atomically). */
  getNotifyConfig: () => NotifyConfig;
  /** Resolve a device for scope matching + display name; null if unknown (fleet-wide channels still fire). */
  resolveDevice: (deviceId: string) => NotifyDevice | null;
  /** Resolve a username to its email for `user:` recipients; null if unknown / no email. */
  resolveUserEmail: (username: string) => Promise<string | null>;
  maxAttempts: number;
  timeoutMs: number;
  /** Injectable for tests; production omits it and reads `process.env`. */
  resolveEnv?: (name: string) => string | undefined;
  /** Injectable for tests; production omits it and uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable email sender for tests; production omits it and uses nodemailer. */
  emailSendImpl?: EmailSendOptions["sendImpl"];
  /** Injectable delay for the retry backoff; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock; production omits it. */
  now?: () => Date;
}

export class NotifyService {
  private readonly resolveEnv: (name: string) => string | undefined;
  private readonly now: () => Date;
  /** Optional metrics hook, wired by the composition root after the registry exists (16D-2b). */
  private sendObserver?: (channelType: string, status: string, latencyMs: number | null) => void;
  /** Last-sent epoch ms per `${eventKey}::${channelId}`, for re-notify dedup. Bounded. */
  private readonly lastSentAt = new Map<string, number>();
  /** Buffered alert contexts per channelId, with the epoch ms the buffer opened, awaiting flush. */
  private readonly digestBuffers = new Map<
    string,
    { since: number; contexts: NotifyAlertContext[] }
  >();
  /** Pending escalation timers per eventKey (an alert may arm one per escalating channel). */
  private readonly escalationTimers = new Map<string, NodeJS.Timeout[]>();

  constructor(private readonly deps: NotifyServiceDeps) {
    this.resolveEnv = deps.resolveEnv ?? ((name) => process.env[name]);
    this.now = deps.now ?? (() => new Date());
  }

  private key(eventKey: string, channelId: string): string {
    return `${eventKey}::${channelId}`;
  }

  /** Wire the Prometheus send observer (called by `createApp` once the metrics registry exists). */
  setSendObserver(
    observer: (channelType: string, status: string, latencyMs: number | null) => void,
  ): void {
    this.sendObserver = observer;
  }

  /**
   * Fan an alert out to every channel that should receive it. Un-awaited by the caller and total:
   * any failure is contained and turned into a "failed" send record (or a log line), never re-thrown.
   */
  async dispatch(event: AlertCreatedEvent): Promise<void> {
    try {
      const config = this.deps.getNotifyConfig();
      if (config.channels.length === 0) {
        return;
      }
      const { alert, deviceId } = event;
      const device = this.deps.resolveDevice(deviceId);
      const scopeDevice = {
        deviceId,
        formationIds: device?.formationIds ?? [],
        tags: device?.tags ?? [],
      };
      const channels = selectChannelsForAlert(config, alert, scopeDevice);
      if (channels.length === 0) {
        return;
      }
      const context = this.contextOf(deviceId, device?.deviceName || deviceId, alert);
      await Promise.all(channels.map((channel) => this.route(channel, context, config)));
    } catch (error) {
      logger.error({ err: error, deviceId: event.deviceId }, "Notify dispatch failed");
    }
  }

  private contextOf(deviceId: string, deviceName: string, alert: DeviceAlert): NotifyAlertContext {
    return {
      deviceId,
      deviceName,
      alertId: alert.id,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      source: alert.source,
      ts: alert.ts,
    };
  }

  /** Apply per-channel policy (silence → dedup → digest vs immediate) to one alert. */
  private async route(
    channel: NotifyConfig["channels"][number],
    context: NotifyAlertContext,
    config: NotifyConfig,
  ): Promise<void> {
    const eventKey = `${context.deviceId}:${context.alertId}`;
    if (isWithinSilence(this.now(), channel.silenceWindows)) {
      logger.debug({ channelId: channel.id, eventKey }, "Notify suppressed by silence window");
      return;
    }
    if (this.suppressedByRenotify(eventKey, channel)) {
      logger.debug({ channelId: channel.id, eventKey }, "Notify suppressed by re-notify window");
      return;
    }
    if (this.shouldDigest(channel, context.severity)) {
      this.bufferForDigest(channel.id, context);
      return;
    }
    await this.sendNow(channel, context, config);
  }
  // PLACEHOLDER_2

  private suppressedByRenotify(
    eventKey: string,
    channel: NotifyConfig["channels"][number],
  ): boolean {
    const window = channel.renotifySeconds ?? 0;
    if (window <= 0) {
      return false;
    }
    const last = this.lastSentAt.get(this.key(eventKey, channel.id));
    return last !== undefined && this.now().getTime() - last < window * 1000;
  }

  private shouldDigest(channel: NotifyConfig["channels"][number], severity: Severity): boolean {
    if ((channel.digestSeconds ?? 0) <= 0 || severity === "critical") {
      return false;
    }
    return (channel.digestSeverities ?? DIGESTABLE_BY_DEFAULT).includes(severity);
  }

  private bufferForDigest(channelId: string, context: NotifyAlertContext): void {
    const existing = this.digestBuffers.get(channelId);
    if (existing) {
      existing.contexts.push(context);
    } else {
      this.digestBuffers.set(channelId, { since: this.now().getTime(), contexts: [context] });
    }
  }

  /** Send one alert to one channel immediately, record it, and arm escalation for a critical. */
  private async sendNow(
    channel: NotifyConfig["channels"][number],
    context: NotifyAlertContext,
    config: NotifyConfig,
  ): Promise<void> {
    const url = this.resolveEnv(channel.urlEnv)?.trim();
    if (!url) {
      // Enabled but endpoint/SMTP env unset — the red line: don't send, don't record a failure
      // per alert; `effectiveConfig().configured` surfaces the misconfiguration instead.
      logger.debug({ channelId: channel.id, urlEnv: channel.urlEnv }, "Notify env unset; skipping");
      return;
    }
    const outcome = await this.performSend(channel, url, context, config);
    const eventKey = `${context.deviceId}:${context.alertId}`;
    this.lastSentAt.set(this.key(eventKey, channel.id), this.now().getTime());
    this.pruneLastSent();
    await this.record(channel, context, eventKey, outcome);
    if (!outcome.ok) {
      logger.warn(
        { channelId: channel.id, channelType: channel.type, httpStatus: outcome.httpStatus },
        "Notify send failed after retries",
      );
    }
    if (channel.escalation && context.severity === "critical") {
      this.armEscalation(eventKey, channel, context);
    }
  }

  private performSend(
    channel: NotifyConfig["channels"][number],
    url: string,
    context: NotifyAlertContext,
    config: NotifyConfig,
  ): Promise<AttemptOutcome> {
    if (channel.type === "email") {
      return this.sendEmailForChannel(channel, url, context, config);
    }
    return sendToChannel(channel.type, url, context, {
      maxAttempts: this.deps.maxAttempts,
      timeoutMs: this.deps.timeoutMs,
      fetchImpl: this.deps.fetchImpl,
    });
  }

  private async sendEmailForChannel(
    channel: NotifyConfig["channels"][number],
    smtpUrl: string,
    context: NotifyAlertContext,
    config: NotifyConfig,
  ): Promise<AttemptOutcome> {
    const from = channel.from?.trim();
    if (!from) {
      return {
        ok: false,
        httpStatus: null,
        attempts: 0,
        latencyMs: 0,
        error: "email channel missing 'from'",
      };
    }
    const to = await resolveRecipients(channel, config.groups, this.deps.resolveUserEmail);
    if (to.length === 0) {
      return {
        ok: false,
        httpStatus: null,
        attempts: 0,
        latencyMs: 0,
        error: "no recipients resolved",
      };
    }
    return sendEmail(
      smtpUrl,
      { from, to, subject: emailSubject(context), text: plainLines(context).join("\n") },
      {
        maxAttempts: this.deps.maxAttempts,
        timeoutMs: this.deps.timeoutMs,
        sendImpl: this.deps.emailSendImpl,
        sleep: this.deps.sleep,
      },
    );
  }

  private async record(
    channel: NotifyConfig["channels"][number],
    context: Pick<NotifyAlertContext, "deviceId" | "alertId" | "severity" | "title">,
    eventKey: string,
    outcome: AttemptOutcome,
  ): Promise<void> {
    const record: NotifySendRecord = {
      ts: this.now().toISOString(),
      eventKey,
      channelId: channel.id,
      channelType: channel.type,
      deviceId: context.deviceId,
      alertId: context.alertId,
      severity: context.severity,
      title: context.title,
      status: outcome.ok ? "sent" : "failed",
      httpStatus: outcome.httpStatus,
      attempts: outcome.attempts,
      latencyMs: outcome.latencyMs,
      error: outcome.error,
    };
    await this.deps.persistence.appendNotify(record);
    this.sendObserver?.(record.channelType, record.status, record.latencyMs);
  }

  private pruneLastSent(): void {
    if (this.lastSentAt.size <= MAX_LAST_SENT) {
      return;
    }
    for (const k of this.lastSentAt.keys()) {
      this.lastSentAt.delete(k);
      if (this.lastSentAt.size <= MAX_LAST_SENT) {
        break;
      }
    }
  }
  // PLACEHOLDER_3

  /**
   * Flush ripe digest buffers — those open at least their channel's `digestSeconds` — as one
   * combined send each (Phase 16D-2a). Called on a poll timer by the composition root (so digest
   * granularity is that poll interval); `force` flushes every buffer regardless of age, for
   * shutdown. Total and self-contained like `dispatch`. A channel removed/disabled since buffering,
   * or whose endpoint env is now unset, has its buffered items dropped (not sent).
   */
  async flushDigests(force = false): Promise<void> {
    if (this.digestBuffers.size === 0) {
      return;
    }
    const config = this.deps.getNotifyConfig();
    const nowMs = this.now().getTime();
    for (const [channelId, buffer] of [...this.digestBuffers.entries()]) {
      const channel = config.channels.find((entry) => entry.id === channelId && entry.enabled);
      if (!channel) {
        this.digestBuffers.delete(channelId);
        continue;
      }
      const windowMs = (channel.digestSeconds ?? 0) * 1000;
      if (!force && nowMs - buffer.since < windowMs) {
        continue;
      }
      this.digestBuffers.delete(channelId);
      try {
        const url = this.resolveEnv(channel.urlEnv)?.trim();
        if (!url || buffer.contexts.length === 0) {
          continue;
        }
        const digestContext = this.buildDigestContext(buffer.contexts);
        const outcome = await this.performSend(channel, url, digestContext, config);
        await this.record(channel, digestContext, `digest:${channelId}:${nowMs}`, outcome);
        if (!outcome.ok) {
          logger.warn({ channelId, count: buffer.contexts.length }, "Notify digest send failed");
        }
      } catch (error) {
        logger.error({ err: error, channelId }, "Notify digest flush failed");
      }
    }
  }

  /** Coalesce buffered alerts into one synthetic context, sent through the channel's normal formatter. */
  private buildDigestContext(contexts: NotifyAlertContext[]): NotifyAlertContext {
    const severity = contexts.reduce<Severity>(
      (worst, current) =>
        SEVERITY_RANK[current.severity] > SEVERITY_RANK[worst] ? current.severity : worst,
      "notice",
    );
    const devices = new Set(contexts.map((entry) => entry.deviceId));
    const detail = contexts.map((entry) => `${entry.title}（${entry.deviceName}）`).join("；");
    return {
      deviceId: devices.size === 1 ? contexts[0]!.deviceId : "-",
      deviceName: devices.size === 1 ? contexts[0]!.deviceName : `${devices.size} 台设备`,
      alertId: "digest",
      severity,
      title: `${contexts.length} 条告警汇总`,
      detail,
      source: "notify-digest",
      ts: this.now().toISOString(),
    };
  }

  private armEscalation(
    eventKey: string,
    channel: NotifyConfig["channels"][number],
    context: NotifyAlertContext,
  ): void {
    const escalation = channel.escalation;
    if (!escalation) {
      return;
    }
    const timer = setTimeout(
      () => {
        void this.fireEscalation(eventKey, escalation.channelId, context);
      },
      Math.max(1, escalation.afterSeconds) * 1000,
    );
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    const timers = this.escalationTimers.get(eventKey) ?? [];
    timers.push(timer);
    this.escalationTimers.set(eventKey, timers);
  }

  private async fireEscalation(
    eventKey: string,
    targetChannelId: string,
    context: NotifyAlertContext,
  ): Promise<void> {
    try {
      const config = this.deps.getNotifyConfig();
      const target = config.channels.find((entry) => entry.id === targetChannelId && entry.enabled);
      const url = target ? this.resolveEnv(target.urlEnv)?.trim() : undefined;
      if (!target || !url) {
        logger.warn({ eventKey, targetChannelId }, "Notify escalation target unavailable");
        return;
      }
      const escalated: NotifyAlertContext = { ...context, title: `【升级】${context.title}` };
      const outcome = await this.performSend(target, url, escalated, config);
      await this.record(target, escalated, eventKey, outcome);
    } catch (error) {
      logger.error({ err: error, eventKey, targetChannelId }, "Notify escalation failed");
    }
  }

  /** Cancel any pending escalation for an alert once it is acknowledged or cleared. */
  onAlertResolved(eventKey: string): void {
    const timers = this.escalationTimers.get(eventKey);
    if (!timers) {
      return;
    }
    for (const timer of timers) {
      clearTimeout(timer);
    }
    this.escalationTimers.delete(eventKey);
  }

  /** Cancel all pending escalation timers (graceful shutdown). */
  dispose(): void {
    for (const timers of this.escalationTimers.values()) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    }
    this.escalationTimers.clear();
  }

  /** Recent send records, newest first (Phase 16D-1). Delegates to persistence. */
  queryLog(filters: {
    deviceId?: string;
    channelId?: string;
    status?: string;
    from?: string;
    to?: string;
  }): Promise<NotifySendRecord[]> {
    return this.deps.persistence.queryNotify(filters);
  }

  /**
   * The effective channels for the read-only 外发 page — each channel minus its `urlEnv`, plus a
   * `configured` boolean saying whether that env var is set. **Never exposes the URL / SMTP string.**
   */
  effectiveConfig(): NotifyChannelView[] {
    return this.deps.getNotifyConfig().channels.map((channel) => ({
      id: channel.id,
      type: channel.type,
      enabled: channel.enabled,
      severities: [...channel.severities],
      scope: channel.scope,
      configured: Boolean(this.resolveEnv(channel.urlEnv)?.trim()),
    }));
  }
}
