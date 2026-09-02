import { formatDateTime } from "./fleetNormalize";

/**
 * Display formatters shared by the views.
 *
 * These were duplicated verbatim across DashboardView / HistoryView / AlertsView;
 * they render telemetry for humans and all fall back to an em-dash placeholder
 * rather than showing NaN/undefined.
 */

/**
 * Fixed-precision number with an optional unit suffix; "--" when there is no reading.
 *
 * The guard is on the **type**, not only on `Number.isFinite`, and that is the whole
 * fix for parity 9.1. `Number()` maps four different kinds of "nothing" onto a
 * perfectly finite zero — `null`, `undefined` via a default, `""`, `[]`, `false` — so
 * a battery that never reported rendered as `0.0%` and read like a flat one. Every
 * default telemetry field in this system is `null`, which is exactly the case that hit.
 *
 * A real zero still formats: `formatNumber(0)` is `"0.00"`. The distinction being made
 * is "no reading" versus "a reading of zero", and on a monitoring console those are
 * different facts — one is a vehicle that is stationary, the other is a vehicle that
 * is not talking to us.
 */
export function formatNumber(value: unknown, digits = 2, unit = ""): string {
  if (value === null || value === undefined) {
    return "--";
  }
  // Only numbers and numeric strings are readings. `true` would otherwise format as
  // "1.00", and `[]` as "0.00".
  if (typeof value !== "number" && typeof value !== "string") {
    return "--";
  }
  if (typeof value === "string" && value.trim() === "") {
    return "--";
  }
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
