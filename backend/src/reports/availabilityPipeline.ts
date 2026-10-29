/**
 * 可用率/电量时序的聚合管道——**纯函数，不碰 db、不读 `Date.now()`**。
 *
 * 和告警统计（`alertStatsPipeline.ts`）同样拆成纯 builder + 纯 mapper：`telemetry_ts` 是原生时序集合
 * （timeField `ts`、metaField `meta`），正适合 `$dateTrunc` 降采样。什么会悄悄错——按 UTC 而不是部署
 * 时区切日、把缺失的 soc 当 0 算进均值、`onlineRatio` 零除——机检看不出，所以钉在单测里。
 *
 * **数据来源口径**：`ts` 是 Mongo `Date`（`writeTelemetry` 用 `new Date(snapshot.stamp)` 写入，TTL
 * 也建在它上面）；`measurements.online` 是布尔，`measurements.vehicleInfo.soc` 是电量百分比（可能
 * 缺失/非数值，`$avg`/`$min` 会自动跳过）。
 *
 * **在线率按时间加权，不按帧数**：车离线时不上报，按帧数算（在线帧/总帧）会把离线时段整段漏掉——离线
 * 23 小时、在线 1 小时的车读出来接近 100%。这里让每一帧「覆盖」它到同一台车下一帧之间的时长，但最多
 * 覆盖 `maxGapMs`（离线判定阈值）：间隔超过阈值的部分没有任何帧作证，按离线计。在线率 = 在线覆盖时长 ÷
 * 桶在窗口内的时长（桶与 [from, horizon] 求交），所以没有帧的时段天然算作离线。
 */

import type { Document } from "mongodb";
import type {
  AvailabilityBucket,
  AvailabilityDeviceSeries,
  AvailabilityReport,
  ReportBucketUnit,
} from "@navfleet/shared";

export interface AvailabilityPipelineParams {
  /** 只看这些设备；null 或空表示全车队。 */
  deviceIds: string[] | null;
  /** 区间下界（含），按 `ts` 过滤；null 表示不设下界。 */
  from: Date | null;
  /** 区间上界（含）；null 表示不设上界。 */
  to: Date | null;
  /** 分桶粒度（时/日）。 */
  bucket: ReportBucketUnit;
  /** 切桶界用的 IANA 时区，交给 `$dateTrunc`。 */
  timezone: string;
  /** 一帧最多覆盖多久（毫秒）：离线判定阈值。超过的间隔按离线计。 */
  maxGapMs: number;
  /** 窗口的实际右端（`min(to, now)`）：最后一帧覆盖到这里为止，桶时长也截到这里。 */
  horizon: Date;
  /**
   * How far past `to` to read frames only to learn each in-range frame's successor (ms). A slice
   * that stops at an hour the rollup already covers needs it: otherwise the slice's last frame
   * would stand for `horizon − ts` instead of the gap to the frame that really follows it.
   * Omitted (0) for a slice that ends at the window's right edge, where nothing follows yet.
   */
  lookaheadMs?: number;
}

/**
 * 构造 `telemetry_ts` 上的降采样管道：按（设备 × 时间桶）聚合在线帧数/总帧数与电量均值/最低。
 * `$dateTrunc` 按部署时区切桶界，末尾按设备、桶起点升序，让 mapper 可以顺序切成每台设备一条序列。
 * `deviceIds` 多选时用 `$in` 收窄到选中的若干台，每台仍各自成一条序列。
 */
export const buildAvailabilityPipeline = (params: AvailabilityPipelineParams): Document[] => {
  const { deviceIds, from, to, bucket, timezone, maxGapMs, horizon } = params;
  const lookaheadMs = to ? Math.max(0, params.lookaheadMs ?? 0) : 0;
  const pipeline: Document[] = [];

  const match: Record<string, unknown> = {};
  if (deviceIds && deviceIds.length > 0) {
    match["meta.deviceId"] = deviceIds.length === 1 ? deviceIds[0] : { $in: deviceIds };
  }
  const range: Record<string, Date> = {};
  if (from) range.$gte = from;
  if (to) range.$lte = lookaheadMs ? new Date(to.getTime() + lookaheadMs) : to;
  if (from || to) match.ts = range;
  if (Object.keys(match).length > 0) {
    pipeline.push({ $match: match });
  }

  pipeline.push(
    // Only what the report reads: the window stage below sorts every frame in range, so keeping
    // the full measurements document would multiply its memory for nothing.
    {
      $project: {
        ts: 1,
        "meta.deviceId": 1,
        "measurements.online": 1,
        "measurements.vehicleInfo.soc": 1,
      },
    },
    // Each frame's successor on the same vehicle, to know how long the frame stands for.
    {
      $setWindowFields: {
        partitionBy: "$meta.deviceId",
        sortBy: { ts: 1 },
        output: { nextTs: { $shift: { output: "$ts", by: 1 } } },
      },
    },
    // The lookahead frames were read only to give the slice's last frames a successor.
    ...(lookaheadMs && to ? [{ $match: { ts: { $lte: to } } }] : []),
    {
      $addFields: {
        coveredMs: {
          $max: [
            0,
            {
              $min: [maxGapMs, { $subtract: [{ $ifNull: ["$nextTs", horizon] }, "$ts"] }],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          deviceId: "$meta.deviceId",
          bucketStart: {
            $dateTrunc: { date: "$ts", unit: bucket, timezone },
          },
        },
        onlineSamples: {
          $sum: { $cond: ["$measurements.online", 1, 0] },
        },
        totalSamples: { $sum: 1 },
        onlineMs: {
          $sum: { $cond: ["$measurements.online", "$coveredMs", 0] },
        },
        // `$sum`/`$min` 跳过缺失或非数值的 soc；桶内一个数值都没有时 socMin 是 null，而不是 0。
        // Sum and count rather than `$avg`, so a bucket split between raw frames and the hourly
        // rollup can be merged into one exact mean.
        socSum: { $sum: "$measurements.vehicleInfo.soc" },
        socCount: { $sum: { $cond: [{ $isNumber: "$measurements.vehicleInfo.soc" }, 1, 0] } },
        socMin: { $min: "$measurements.vehicleInfo.soc" },
      },
    },
    {
      $addFields: {
        bucketEnd: {
          $dateAdd: { startDate: "$_id.bucketStart", unit: bucket, amount: 1, timezone },
        },
      },
    },
    { $sort: { "_id.deviceId": 1, "_id.bucketStart": 1 } },
  );

  return pipeline;
};

/** `$group` 出来的一行（桶已按设备、时间排序）。`bucketStart` 是 `$dateTrunc` 的 Date。 */
export interface AvailabilityRow {
  _id: { deviceId?: string | null; bucketStart?: Date | string | null };
  onlineSamples?: number;
  totalSamples?: number;
  /** 在线帧覆盖的时长（毫秒）。 */
  onlineMs?: number;
  /** 桶的右界（`$dateAdd`，按时区算月长）。缺省时按左界推不出，视为空桶。 */
  bucketEnd?: Date | string | null;
  /** Numeric soc readings summed / counted; the mean is `socSum / socCount`. */
  socSum?: number;
  socCount?: number;
  /** A precomputed mean, for rows that carry no sum/count. */
  socMean?: number | null;
  socMin?: number | null;
}

/** 把 soc 均值/最低这类浮点收敛到 3 位小数，别让报表里出现 79.99999999996。null 原样透传。 */
const round3 = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.round(value * 1000) / 1000;

/** 桶起点统一成 ISO 字符串：Mongo 回 Date，fake db/单测可能已是字符串。 */
const toIso = (value: Date | string | null | undefined): string => {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
};

const toMs = (value: Date | string | null | undefined): number =>
  value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));

/** The bucket's mean soc: from sum/count when the row carries them, else its own mean. */
const socMeanOf = (row: AvailabilityRow): number | null | undefined =>
  row.socCount !== undefined
    ? row.socCount > 0
      ? (row.socSum ?? 0) / row.socCount
      : null
    : row.socMean;

/**
 * Fold rows describing the same (device, bucket) into one — the raw slices and the hourly rollup
 * each report their part of a bucket. Counts and covered time add, soc sums add, the minimum is
 * the smaller one; a bucket with a single row passes through untouched. Output is sorted by device
 * then bucket, as `mapAvailabilityRows` expects.
 */
export const mergeAvailabilityRows = (rows: readonly AvailabilityRow[]): AvailabilityRow[] => {
  const groups = new Map<string, AvailabilityRow[]>();
  for (const row of rows) {
    const key = `${String(row._id.deviceId ?? "")}|${toIso(row._id.bucketStart)}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const merged = [...groups.values()].map((group): AvailabilityRow => {
    const [first] = group;
    if (group.length === 1 && first) return first;
    const mins = group.map((row) => row.socMin).filter((v): v is number => typeof v === "number");
    const sum = (pick: (row: AvailabilityRow) => number | undefined): number =>
      group.reduce((total, row) => total + (pick(row) ?? 0), 0);
    return {
      _id: first?._id ?? {},
      bucketEnd: group.find((row) => row.bucketEnd)?.bucketEnd ?? null,
      onlineSamples: sum((row) => row.onlineSamples),
      totalSamples: sum((row) => row.totalSamples),
      onlineMs: sum((row) => row.onlineMs),
      socSum: sum((row) => row.socSum),
      socCount: sum((row) => row.socCount),
      socMin: mins.length ? Math.min(...mins) : null,
    };
  });
  return merged.sort((left, right) => {
    const byDevice = String(left._id.deviceId ?? "").localeCompare(
      String(right._id.deviceId ?? ""),
    );
    return byDevice || toMs(left._id.bucketStart) - toMs(right._id.bucketStart);
  });
};

/** 窗口：桶时长与 [from, horizon] 求交，左端未给即不截。 */
export interface AvailabilityWindow {
  from: Date | null;
  horizon: Date;
}

/**
 * 已排序的行 → `AvailabilityReport`（纯映射，`available` 由调用方决定）。按 deviceId 顺序切段成每台
 * 一条序列，算出按时间加权的 `onlineRatio`（零除保护），并把 soc 收敛精度。每台设备原样成列——报表要的就是逐台
 * 可对比的明细，不做任何折叠。
 */
export const mapAvailabilityRows = (
  rows: readonly AvailabilityRow[],
  bucket: ReportBucketUnit,
  window: AvailabilityWindow,
): AvailabilityReport => {
  const windowStart = window.from ? window.from.getTime() : Number.NEGATIVE_INFINITY;
  const windowEnd = window.horizon.getTime();
  const devices: AvailabilityDeviceSeries[] = [];
  let current: AvailabilityDeviceSeries | null = null;

  for (const row of rows) {
    const deviceId = String(row._id.deviceId ?? "");
    if (!current || current.deviceId !== deviceId) {
      current = { deviceId, buckets: [] };
      devices.push(current);
    }
    const total = row.totalSamples ?? 0;
    const online = row.onlineSamples ?? 0;
    const start = Math.max(toMs(row._id.bucketStart), windowStart);
    const end = Math.min(toMs(row.bucketEnd), windowEnd);
    const spanMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    // A frame's coverage can run past its bucket's right edge (it is attributed to the bucket the
    // frame sits in, and a gap is at most the offline threshold), so clamp to 100%.
    const onlineMs = Math.min(row.onlineMs ?? 0, spanMs);
    const entry: AvailabilityBucket = {
      bucketStart: toIso(row._id.bucketStart),
      onlineSamples: online,
      totalSamples: total,
      onlineSeconds: Math.round(onlineMs / 1000),
      spanSeconds: Math.round(spanMs / 1000),
      onlineRatio: spanMs > 0 ? onlineMs / spanMs : 0,
      socMean: round3(socMeanOf(row)),
      socMin: round3(row.socMin),
    };
    current.buckets.push(entry);
  }

  return { bucket, devices, available: true };
};
