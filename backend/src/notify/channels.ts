/**
 * Per-channel message bodies for the outbound HTTP channels.
 *
 * Three channel types, three body shapes, all "POST one JSON": a generic webhook gets the
 * alert as a flat JSON object; 企业微信 and 钉钉 group-robot webhooks each get their documented
 * markdown envelope. The builders are **pure** (context in, body out) so they are unit-tested
 * without any network, and the one function that touches the wire (`sendToChannel`) only
 * resolves the endpoint from env and delegates to `postWithRetry`.
 *
 * **Secrets never appear here.** The endpoint URL (which for 企业微信/钉钉 embeds the bot key) is
 * read from the env var the channel names, at send time — never logged, never in a record.
 *
 * Security modes: 企业微信 and 钉钉 group robots that use the plain webhook URL (钉钉「自定义关键词」
 * or「IP 白名单」, 企业微信 key-in-URL) work as-is. 钉钉「加签」(per-request HMAC) needs a second
 * secret and is an extension — out of scope here, and noted so it is a decision, not a gap.
 */
import { SEVERITY_LABELS, type NotifyChannelType, type Severity } from "@navfleet/shared";
import { formatInstantInZone } from "../localTime";
import { postWithRetry, type AttemptOutcome, type RetryOptions } from "./retry";

/** The channel types whose body is an HTTP JSON POST. `email` is not one — it has its own path. */
export type HttpChannelType = Exclude<NotifyChannelType, "email">;

/** Everything a channel body may template from — the alert plus its device's display name. */
export interface NotifyAlertContext {
  deviceId: string;
  deviceName: string;
  alertId: string;
  severity: Severity;
  title: string;
  detail: string;
  source: string;
  /** ISO-8601, as the alert carries it; the generic webhook passes it on unchanged. */
  ts: string;
  /**
   * The deployment time zone (`REPORT_TIMEZONE`) the human-readable bodies show `ts` in. A bare UTC
   * string made the on-call reader add eight hours in their head; the report emails already said
   * local time.
   */
  timeZone: string;
}

const label = (severity: Severity): string => SEVERITY_LABELS[severity];

const when = (context: NotifyAlertContext): string => {
  const at = new Date(context.ts);
  return Number.isFinite(at.getTime()) ? formatInstantInZone(at, context.timeZone) : context.ts;
};

/** One markdown block, shared by the two group-robot channels so their wording stays identical. */
const markdownLines = (context: NotifyAlertContext): string[] => [
  `**【${label(context.severity)}】${context.title}**`,
  `设备：${context.deviceName}（${context.deviceId}）`,
  `详情：${context.detail}`,
  `时间：${when(context)}`,
];

/** Plain-text lines for the email body (no markdown emphasis). Also reused for digest items. */
export const plainLines = (context: NotifyAlertContext): string[] => [
  `【${label(context.severity)}】${context.title}`,
  `设备：${context.deviceName}（${context.deviceId}）`,
  `详情：${context.detail}`,
  `时间：${when(context)}`,
];

/** The email subject for a single alert. */
export const emailSubject = (context: NotifyAlertContext): string =>
  `【${label(context.severity)}】${context.deviceName} ${context.title}`;

/** The generic webhook body: the alert as a flat JSON object a receiver can map however it likes. */
export const buildWebhookBody = (context: NotifyAlertContext): Record<string, unknown> => ({
  deviceId: context.deviceId,
  deviceName: context.deviceName,
  alertId: context.alertId,
  severity: context.severity,
  title: context.title,
  detail: context.detail,
  source: context.source,
  ts: context.ts,
});

/** 企业微信 群机器人 markdown 消息。 */
export const buildWecomBody = (context: NotifyAlertContext): Record<string, unknown> => ({
  msgtype: "markdown",
  markdown: { content: markdownLines(context).join("\n") },
});

/** 钉钉 群机器人 markdown 消息。 */
export const buildDingtalkBody = (context: NotifyAlertContext): Record<string, unknown> => ({
  msgtype: "markdown",
  markdown: {
    title: `【${label(context.severity)}】${context.title}`,
    text: markdownLines(context).join("\n\n"),
  },
});

/** Build the request body for an HTTP channel type. Exhaustive over `HttpChannelType`. */
export const buildChannelBody = (
  type: HttpChannelType,
  context: NotifyAlertContext,
): Record<string, unknown> => {
  switch (type) {
    case "webhook":
      return buildWebhookBody(context);
    case "wecom":
      return buildWecomBody(context);
    case "dingtalk":
      return buildDingtalkBody(context);
  }
};

/**
 * The group robots' own verdict: both answer `{ errcode, errmsg }` with HTTP 200, and `errcode` 0
 * is the only acceptance. A body without an `errcode` (an unexpected proxy page) is not counted as
 * delivered either — the send log must not report a message nobody received.
 */
export const robotRejection = (payload: unknown): string | null => {
  const { errcode, errmsg } = (payload ?? {}) as { errcode?: unknown; errmsg?: unknown };
  if (errcode === 0) return null;
  if (typeof errcode !== "number") return "响应中没有 errcode";
  return `errcode ${errcode}${typeof errmsg === "string" && errmsg ? `：${errmsg}` : ""}`;
};

/**
 * Send one alert to one HTTP channel's resolved endpoint. Pure of policy — the caller has already
 * decided this channel should receive this alert and resolved its URL from env — this only
 * builds the body and posts it with bounded retry, returning the attempt outcome to record.
 */
export const sendToChannel = (
  type: HttpChannelType,
  url: string,
  context: NotifyAlertContext,
  options: RetryOptions,
): Promise<AttemptOutcome> =>
  postWithRetry(url, buildChannelBody(type, context), {
    ...options,
    ...(type === "webhook" ? {} : { rejection: robotRejection }),
  });
