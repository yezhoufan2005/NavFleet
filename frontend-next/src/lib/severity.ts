import {
  SEVERITY_LABELS,
  type CodeChannel,
  type Severity,
} from "@navfleet/shared";

// The labels live in shared, so the outbound messages the backend sends read the same three words.
export { SEVERITY_LABELS };

/**
 * Tailwind classes for a severity badge — a wash background with matching ink — shared by every
 * surface that chips an alert by severity (消息 / 消息史 / 大屏 / 设备消息). One source so the three
 * tiers look identical everywhere; it was copy-pasted verbatim into four components before this.
 */
export const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "bg-critical-wash text-critical-ink",
  warning: "bg-warning-wash text-warning-ink",
  notice: "bg-notice-wash text-notice-ink",
};

/** Worst first: the order messages should be read in. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  notice: 2,
};

/**
 * Label for a severity that arrives as a plain string (a send-log row, a config list), where the
 * value is not statically a `Severity`. An unrecognized value falls back to itself.
 */
export const severityLabel = (value: string): string =>
  SEVERITY_LABELS[value as Severity] ?? value;

/**
 * Labels for a report code's channel (error / warning / info), which mirror the severity tiers —
 * a code's error channel reads 告警, warning 预警, info 提示. Kept beside {@link SEVERITY_LABELS} as
 * the one source for this vocabulary across 设备消息 and 报码字典, where it was duplicated.
 */
export const CODE_CHANNEL_LABELS: Record<CodeChannel, string> = {
  error: "告警",
  warning: "预警",
  info: "提示",
};
