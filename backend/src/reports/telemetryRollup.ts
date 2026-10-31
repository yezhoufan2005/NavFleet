/**
 * Telemetry summarised per hour — **pure: no db access, no `Date.now()`**.
 *
 * At one frame a second, a 30-day fleet-wide availability report has to scan tens of millions of
 * frames, and the raw pipeline cannot do that within the report timeout (measured: 29 vehicles ×
 * 30 days = 75M frames, the fleet-wide 30-day query exceeded 150 s; 7 days took 90 s). So closed
 * hours are summarised once into `telemetry_hourly`, one document per (device, hour), and a report
 * reads those for every hour they cover, falling back to raw frames only for the rest — the
 * current hour, a partial first hour, or hours the rollup job has not reached yet.
 *
 * **The same arithmetic as the raw pipeline**, so a bucket reads the same whichever path served
 * it: each frame stands for the time to the next frame of the same vehicle, at most `maxGapMs`
 * (the offline threshold), and is attributed to the hour its own `ts` falls in. Frames up to
 * `maxGapMs` past the hour are read only to find the hour's last frames their successors.
 *
 * `telemetry_hourly_runs` records which hours have been summarised and under which threshold and
 * timezone; an hour whose run is missing or was computed under other parameters is not trusted.
 * Late frames for a closed hour (the write-behind buffer after an outage, a bulk import) delete
 * that hour's run, so the job recomputes it.
 */

import type { Document } from "mongodb";
import type { ReportBucketUnit } from "@navfleet/shared";

export const ROLLUP_COLLECTION = "telemetry_hourly";
export const ROLLUP_RUNS_COLLECTION = "telemetry_hourly_runs";
export const HOUR_MS = 3_600_000;

/** How far past an hour's end the job waits before summarising it, beyond the offline threshold. */
export const ROLLUP_SETTLE_MS = 60_000;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timezone` from UTC at instant `ms`, in milliseconds (east positive). */
export const timezoneOffsetMs = (ms: number, timezone: string): number => {
  let formatter = offsetFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    offsetFormatters.set(timezone, formatter);
  }
  const part = (type: string): number =>
    Number(formatter.formatToParts(new Date(ms)).find((entry) => entry.type === type)?.value);
  const local = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
  );
  return local - Math.floor(ms / 60_000) * 60_000;
};

/**
 * The start of the local hour containing `ms`. Local, not UTC, so the hours tile the report's
 * day buckets even in a timezone whose offset is not a whole number of hours.
 */
export const floorToHour = (ms: number, timezone: string): number => {
  const offset = timezoneOffsetMs(ms, timezone);
  return Math.floor((ms + offset) / HOUR_MS) * HOUR_MS - offset;
};

export interface HourRollupParams {
  hourStart: Date;
  maxGapMs: number;
  timezone: string;
}

/** Summarise one hour of `telemetry_ts` into `telemetry_hourly` (one document per device). */
export const buildHourRollupPipeline = ({
  hourStart,
  maxGapMs,
  timezone,
}: HourRollupParams): Document[] => {
  const hourEnd = new Date(hourStart.getTime() + HOUR_MS);
  const readUntil = new Date(hourEnd.getTime() + maxGapMs);
  return [
    { $match: { ts: { $gte: hourStart, $lt: readUntil } } },
    {
      $project: {
        ts: 1,
        "meta.deviceId": 1,
        "measurements.online": 1,
        "measurements.vehicleInfo.soc": 1,
      },
    },
    {
      $setWindowFields: {
        partitionBy: "$meta.deviceId",
        sortBy: { ts: 1 },
        output: { nextTs: { $shift: { output: "$ts", by: 1 } } },
      },
    },
    { $match: { ts: { $lt: hourEnd } } },
    {
      $addFields: {
        coveredMs: {
          $max: [
            0,
            { $min: [maxGapMs, { $subtract: [{ $ifNull: ["$nextTs", readUntil] }, "$ts"] }] },
          ],
        },
      },
    },
    {
      $group: {
        _id: "$meta.deviceId",
        frames: { $sum: 1 },
        onlineFrames: { $sum: { $cond: ["$measurements.online", 1, 0] } },
        onlineMs: { $sum: { $cond: ["$measurements.online", "$coveredMs", 0] } },
        socSum: { $sum: "$measurements.vehicleInfo.soc" },
        socCount: { $sum: { $cond: [{ $isNumber: "$measurements.vehicleInfo.soc" }, 1, 0] } },
        socMin: { $min: "$measurements.vehicleInfo.soc" },
      },
    },
    {
      $project: {
        _id: { $concat: ["$_id", "|", hourStart.toISOString()] },
        deviceId: "$_id",
        hour: hourStart,
        frames: 1,
        onlineFrames: 1,
        onlineMs: 1,
        socSum: 1,
        socCount: 1,
        socMin: 1,
        maxGapMs: { $literal: maxGapMs },
        timezone: { $literal: timezone },
      },
    },
    {
      $merge: {
        into: ROLLUP_COLLECTION,
        on: "_id",
        whenMatched: "replace",
        whenNotMatched: "insert",
      },
    },
  ];
};

export interface RollupReportParams {
  deviceIds: string[] | null;
  /** The summarised hours to read; each lies wholly inside the report window. */
  hours: Date[];
  bucket: ReportBucketUnit;
  timezone: string;
}

/** Read summarised hours into availability rows of the requested bucket. */
export const buildRollupReportPipeline = ({
  deviceIds,
  hours,
  bucket,
  timezone,
}: RollupReportParams): Document[] => {
  const match: Record<string, unknown> = { hour: { $in: hours } };
  if (deviceIds && deviceIds.length > 0) {
    match.deviceId = deviceIds.length === 1 ? deviceIds[0] : { $in: deviceIds };
  }
  return [
    { $match: match },
    {
      $group: {
        _id: {
          deviceId: "$deviceId",
          bucketStart: { $dateTrunc: { date: "$hour", unit: bucket, timezone } },
        },
        onlineSamples: { $sum: "$onlineFrames" },
        totalSamples: { $sum: "$frames" },
        onlineMs: { $sum: "$onlineMs" },
        socSum: { $sum: "$socSum" },
        socCount: { $sum: "$socCount" },
        socMin: { $min: "$socMin" },
      },
    },
    {
      $addFields: {
        bucketEnd: {
          $dateAdd: { startDate: "$_id.bucketStart", unit: bucket, amount: 1, timezone },
        },
      },
    },
  ];
};

/** A half-open time slice `[from, to)` in epoch ms. */
export interface Slice {
  from: number;
  to: number;
}

/**
 * Split a report window into the hours the rollup can serve and the slices raw frames must.
 * An hour is served from the rollup only when it lies inside `[from, horizon)`, ends before the
 * horizon and has a trusted run; everything else — a partial first hour, the last hour, an
 * unsummarised hour — is a raw slice, adjacent ones merged.
 *
 * The last hour is always raw, even when it ends exactly at the horizon: a summarised hour lets
 * its last frames stand for the time up to their successors in the next hour, while the window's
 * right edge stops them at the horizon. Reading that hour raw keeps the two paths equal.
 */
export const planAvailabilityWindow = (
  from: number,
  horizon: number,
  coveredHours: ReadonlySet<number>,
  timezone: string,
): { hours: number[]; raw: Slice[] } => {
  const hours: number[] = [];
  const raw: Slice[] = [];
  const pushRaw = (slice: Slice): void => {
    if (slice.to <= slice.from) return;
    const last = raw.at(-1);
    if (last && last.to === slice.from) {
      last.to = slice.to;
    } else {
      raw.push({ ...slice });
    }
  };

  let cursor = from;
  let hour = floorToHour(from, timezone);
  while (cursor < horizon) {
    const hourEnd = hour + HOUR_MS;
    if (hour >= from && hourEnd < horizon && coveredHours.has(hour)) {
      hours.push(hour);
    } else {
      pushRaw({ from: cursor, to: Math.min(hourEnd, horizon) });
    }
    cursor = Math.min(hourEnd, horizon);
    hour = hourEnd;
  }
  return { hours, raw };
};

/**
 * The closed hours from `oldestMs` up to the last one ready to summarise at `nowMs` — newest
 * first, because a report reads the recent past most.
 */
export const closedHours = (
  oldestMs: number,
  nowMs: number,
  maxGapMs: number,
  timezone: string,
): number[] => {
  const readyBefore = nowMs - maxGapMs - ROLLUP_SETTLE_MS;
  const hours: number[] = [];
  for (let hour = floorToHour(oldestMs, timezone); hour + HOUR_MS <= readyBefore; hour += HOUR_MS) {
    hours.push(hour);
  }
  return hours.reverse();
};
