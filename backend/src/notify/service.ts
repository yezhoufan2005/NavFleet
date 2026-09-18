/**
 * The outbound-notification service (Phase 16D-1): it turns a freshly-created alert into zero or
 * more channel sends, records each, and answers the read-only 外发 page's two questions (recent
 * sends, effective channels).
 *
 * **It runs fire-and-forget, off the store's `alert.created` event, and never on the ingest
 * path.** `alert.created` is emitted synchronously inside the store's serial mutation queue, so
 * awaiting a slow webhook there would stall *all* ingest. The composition root subscribes
 * `dispatch` un-awaited (like the WebSocket bridge), and `dispatch` catches everything — an
 * escaping rejection would otherwise land on `unhandledRejection`.
 *
 * **Idempotency rests on the single-fire hook, not a dedupe store.** `alert.created` fires
 * exactly once per alert id appearance, the offline sweep reuses a stable id (no re-fire), and a
 * restart repopulates devices without re-emitting — so under the single-instance deployment the
 * project targets, one alert produces one send per matching channel without any "already sent"
 * bookkeeping. Cross-replica dedupe would be needed only for >1 backend, which is out of scope.
 */
import { moduleLogger } from "../logger";
import type { Persistence } from "../persistence";
import type {
  DeviceAlert,
  DeviceSnapshot,
  NotifyChannelView,
  NotifyConfig,
  NotifySendRecord,
} from "../types";
import { sendToChannel, type NotifyAlertContext } from "./channels";
import { selectChannelsForAlert } from "./routing";

const logger = moduleLogger("notify");

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
  /** The config in effect; read per alert (a reload swaps it atomically). */
  getNotifyConfig: () => NotifyConfig;
  /** Resolve a device for scope matching + display name; null if unknown (fleet-wide channels still fire). */
  resolveDevice: (deviceId: string) => NotifyDevice | null;
  maxAttempts: number;
  timeoutMs: number;
  /** Injectable for tests; production omits it and reads `process.env`. */
  resolveEnv?: (name: string) => string | undefined;
  /** Injectable for tests; production omits it and uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for the send record's `ts`; production omits it. */
  now?: () => Date;
}

export class NotifyService {
  private readonly resolveEnv: (name: string) => string | undefined;
  private readonly now: () => Date;

  constructor(private readonly deps: NotifyServiceDeps) {
    this.resolveEnv = deps.resolveEnv ?? ((name) => process.env[name]);
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Fan an alert out to every channel that should receive it. Un-awaited by the caller and
   * total: any failure is contained and turned into a "failed" send record (or a log line),
   * never re-thrown.
   */
  async dispatch(event: AlertCreatedEvent): Promise<void> {
    try {
      const config = this.deps.getNotifyConfig();
      // Fast path and the zero-config red line: no channels means nothing is ever sent.
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

      const context: NotifyAlertContext = {
        deviceId,
        deviceName: device?.deviceName || deviceId,
        alertId: alert.id,
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
        source: alert.source,
        ts: alert.ts,
      };

      await Promise.all(channels.map((channel) => this.sendOne(channel, context)));
    } catch (error) {
      logger.error({ err: error, deviceId: event.deviceId }, "Notify dispatch failed");
    }
  }

  private async sendOne(
    channel: NotifyConfig["channels"][number],
    context: NotifyAlertContext,
  ): Promise<void> {
    const url = this.resolveEnv(channel.urlEnv)?.trim();
    if (!url) {
      // Enabled but its endpoint env is unset. Honor the red line: don't send, and don't write a
      // failure record on every alert — that config state is surfaced by `effectiveConfig`'s
      // `configured: false`, not by flooding the send log.
      logger.debug(
        { channelId: channel.id, urlEnv: channel.urlEnv },
        "Notify channel endpoint env is unset; skipping send",
      );
      return;
    }

    const outcome = await sendToChannel(channel.type, url, context, {
      maxAttempts: this.deps.maxAttempts,
      timeoutMs: this.deps.timeoutMs,
      fetchImpl: this.deps.fetchImpl,
    });

    const record: NotifySendRecord = {
      ts: this.now().toISOString(),
      eventKey: `${context.deviceId}:${context.alertId}`,
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

    if (!outcome.ok) {
      logger.warn(
        { channelId: channel.id, channelType: channel.type, httpStatus: outcome.httpStatus },
        "Notify send failed after retries",
      );
    }
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
   * `configured` boolean saying whether that env var is set. **Never exposes the URL** (it embeds
   * a bot secret); `configured` is all the page needs to tell "enabled and wired up" from "enabled
   * but missing its endpoint".
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
