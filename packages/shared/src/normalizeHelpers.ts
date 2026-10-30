import type { CodeState, DeviceSnapshot, Severity } from "./index";

/**
 * The pure coercions both normalisers apply to an arriving frame — the backend's (`normalize.ts`,
 * on ingest) and fleet-core's (`fleetNormalize.ts`, in the consoles). They used to be two copies
 * kept identical by hand, with tests on both sides asserting the pair still agreed. One copy here
 * makes the agreement structural instead of policed.
 */

/**
 * A JSON scalar as text; anything else becomes `fallback`.
 *
 * Not `String(value)`: on a field typed `unknown` that turns `{}` into `"[object Object]"` (a
 * vehicle publishing `"deviceName": {}` once got exactly that as its name), and `null` /
 * `undefined` / `NaN` into the words themselves. Those all render as `fallback` here.
 */
export const asText = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
};

/** A finite number from a number or numeric string; `fallback` for empty, absent or garbage. */
export const toNumeric = (
  value: unknown,
  fallback: number | null = null,
): number | null => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

/**
 * A timestamp in epoch milliseconds, or `null` when the value carries no time.
 *
 * The primitive, so that every caller has to say what "no timestamp" means *there*:
 *
 * - **A receiver** (the backend normalising an arriving MQTT frame) legitimately uses its own
 *   clock: the message did just arrive — `toTimestampMsOrNow` / `toIsoString`.
 * - **A reader** (a console sorting stored alerts) must not. There, "now" turns "we do not know
 *   when this happened" into "it happened this instant", which sorts an undated alert above every
 *   real one and re-sorts it on every tick — `toIsoStringOrNull`, or `?? 0` when sorting.
 *
 * A number is read by magnitude: below `1e12` as seconds (the convention the vehicles publish),
 * then milliseconds, and from `1e14` and `1e17` up as micro- and nanoseconds, which ROS-based
 * stacks publish. Anything outside what a `Date` can hold is `null`, so `toIsoString` never
 * throws on a frame.
 */
const MAX_DATE_MS = 8.64e15;

const epochNumberToMs = (value: number): number | null => {
  const ms =
    Math.abs(value) < 1e12
      ? value * 1000
      : Math.abs(value) < 1e14
        ? value
        : Math.abs(value) < 1e17
          ? value / 1e3
          : value / 1e6;
  return Math.abs(ms) <= MAX_DATE_MS ? ms : null;
};

export const parseTimestampMs = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? epochNumberToMs(value) : null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && asText(value).trim() !== "") {
    return epochNumberToMs(numeric);
  }
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Epoch milliseconds, falling back to **now**. Receivers only — see `parseTimestampMs`. */
export const toTimestampMsOrNow = (value: unknown): number =>
  parseTimestampMs(value) ?? Date.now();

/** ISO string, falling back to **now**. Receivers only — see `parseTimestampMs`. */
export const toIsoString = (value: unknown): string =>
  new Date(toTimestampMsOrNow(value)).toISOString();

/** Reader-side ISO string: an absent or unparseable stamp stays `null`, never "now". */
export const toIsoStringOrNull = (value: unknown): string | null => {
  const ms = parseTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
};

/**
 * A vendor severity word folded onto the three the platform knows. Without it a frame carrying
 * `severity: "ERROR"` kept that string, and a console indexing alerts by severity got an
 * `undefined` bucket rather than a critical alert.
 */
export const normalizeSeverity = (value: unknown): Severity => {
  const normalized = asText(value || "").toLowerCase();
  if (
    normalized.includes("critical") ||
    normalized.includes("fatal") ||
    normalized.includes("error")
  ) {
    return "critical";
  }
  if (normalized.includes("warn") || normalized.includes("low")) {
    return "warning";
  }
  return "notice";
};

/** The "nothing reported" state of one report-code channel. */
export const createDefaultCode = (): CodeState => ({
  code: 0,
  info: "",
  stamp: null,
});

/** Whether a pose has both coordinates as finite numbers. */
export const hasPose = (
  pose: Partial<DeviceSnapshot["fusionLoc"]> | null | undefined,
): boolean => Number.isFinite(pose?.x) && Number.isFinite(pose?.y);

/** Whether a GPS fix has both coordinates as finite numbers. */
export const hasGps = (
  gps: Partial<DeviceSnapshot["gps"]> | null | undefined,
): boolean => Number.isFinite(gps?.lat) && Number.isFinite(gps?.lng);

/**
 * One alert per `id|severity|title`, newest first. An alert with no timestamp sorts **last**
 * (`?? 0`), never first: a "now" fallback would promote every undated alert to the top and
 * re-sort it on each tick, because the fabricated stamp keeps moving.
 */
export const dedupeAlerts = <
  T extends { id: string; severity: string; title: string; ts: string },
>(
  alerts: T[],
): T[] => {
  const deduped = new Map<string, T>();
  alerts.forEach((alert) => {
    const key = `${alert.id}|${alert.severity}|${alert.title}`;
    if (!deduped.has(key)) {
      deduped.set(key, alert);
    }
  });
  return [...deduped.values()].sort(
    (left, right) =>
      (parseTimestampMs(right.ts) ?? 0) - (parseTimestampMs(left.ts) ?? 0),
  );
};
