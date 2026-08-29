import { formatDateTime } from "./fleetNormalize";

/**
 * Display formatters shared by the views.
 *
 * These were duplicated verbatim across DashboardView / HistoryView / AlertsView;
 * they render telemetry for humans and all fall back to an em-dash placeholder
 * rather than showing NaN/undefined.
 */

/** Fixed-precision number with an optional unit suffix; "--" when not finite. */
export function formatNumber(value: unknown, digits = 2, unit = ""): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${numeric.toFixed(digits)}${unit}`;
}

/** Raw value as text; "--" for null / undefined / empty string. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "--";
  }
  return String(value);
}

/** Localised timestamp; "--" when absent. */
export function formatStamp(value: unknown): string {
  if (!value) {
    return "--";
  }
  return formatDateTime(value);
}
