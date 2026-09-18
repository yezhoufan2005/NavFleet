/**
 * Per-channel message bodies for the outbound HTTP channels (Phase 16D-1).
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
 * secret and is a 16D-2 extension — out of scope here, and noted so it is a decision, not a gap.
 */
import type { NotifyChannelType, Severity } from "@navfleet/shared";
import { postWithRetry, type AttemptOutcome, type RetryOptions } from "./retry";

/** Everything a channel body may template from — the alert plus its device's display name. */
export interface NotifyAlertContext {
  deviceId: string;
  deviceName: string;
  alertId: string;
  severity: Severity;
  title: string;
  detail: string;
  source: string;
  ts: string;
}

/** Human-readable severity, for the group-chat message bodies. */
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "严重",
  warning: "警告",
  notice: "提示",
};

/** One markdown block, shared by the two group-robot channels so their wording stays identical. */
const markdownLines = (context: NotifyAlertContext): string[] => [
  `**【${SEVERITY_LABEL[context.severity]}】${context.title}**`,
  `设备：${context.deviceName}（${context.deviceId}）`,
  `详情：${context.detail}`,
  `时间：${context.ts}`,
];

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
    title: `【${SEVERITY_LABEL[context.severity]}】${context.title}`,
    text: markdownLines(context).join("\n\n"),
  },
});

/** Build the request body for a channel type. Exhaustive over `NotifyChannelType`. */
export const buildChannelBody = (
  type: NotifyChannelType,
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
 * Send one alert to one channel's resolved endpoint. Pure of policy — the caller has already
 * decided this channel should receive this alert and resolved its URL from env — this only
 * builds the body and posts it with bounded retry, returning the attempt outcome to record.
 */
export const sendToChannel = (
  type: NotifyChannelType,
  url: string,
  context: NotifyAlertContext,
  options: RetryOptions,
): Promise<AttemptOutcome> => postWithRetry(url, buildChannelBody(type, context), options);
