import type { Severity } from "@navfleet/shared";

/**
 * House labels for the three severity tiers, shared across 消息 / 告警史 / 报表 / 大屏 / 外发.
 *
 * `critical` reads **告警**, not 严重: per the house term rule, 消息 is the umbrella and 告警 is its
 * critical tier (预警 = warning, 提示 = notice). This map is the single source so the same alert never
 * shows as 告警 on one surface and 严重 on another.
 */
export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "告警",
  warning: "预警",
  notice: "提示",
};

/**
 * Label for a severity that arrives as a plain string (a send-log row, a config list), where the
 * value is not statically a `Severity`. An unrecognized value falls back to itself.
 */
export const severityLabel = (value: string): string =>
  SEVERITY_LABELS[value as Severity] ?? value;
