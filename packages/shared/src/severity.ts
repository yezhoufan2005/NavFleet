import type { Severity } from "./index";

/**
 * House labels for the three severity tiers: the console's 消息 / 消息史 / 报表 / 大屏 / 外发 pages and
 * the outbound messages (企业微信 / 钉钉 / 邮件) all read them from here.
 *
 * `critical` reads **告警**, not 严重: 消息 is the umbrella and 告警 is its critical tier (预警 = warning,
 * 提示 = notice). The outbound channels kept a table of their own (严重 / 警告) after the console's
 * moved here, so the same alert said 告警 on screen and 【严重】 in the group chat.
 */
export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "告警",
  warning: "预警",
  notice: "提示",
};
