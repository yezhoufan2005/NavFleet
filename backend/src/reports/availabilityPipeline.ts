/**
 * 可用率/电量时序的聚合管道（Phase 17A-2）——**纯函数，不碰 db、不读 `Date.now()`**。
 *
 * 和告警统计（`alertStatsPipeline.ts`）同样拆成纯 builder + 纯 mapper：`telemetry_ts` 是原生时序集合
 * （timeField `ts`、metaField `meta`），正适合 `$dateTrunc` 降采样。什么会悄悄错——按 UTC 而不是部署
 * 时区切日、把缺失的 soc 当 0 算进均值、`onlineRatio` 零除——机检看不出，所以钉在单测里。
 *
 * **数据来源口径**：`ts` 是 Mongo `Date`（`writeTelemetry` 用 `new Date(snapshot.stamp)` 写入，TTL
 * 也建在它上面）；`measurements.online` 是布尔，`measurements.vehicleInfo.soc` 是电量百分比（可能
 * 缺失/非数值，`$avg`/`$min` 会自动跳过）。
 */

import type { Document } from "mongodb";
import type {
  AvailabilityBucket,
  AvailabilityDeviceSeries,
  AvailabilityReport,
  ReportBucketUnit,
} from "@navfleet/shared";

export interface AvailabilityPipelineParams {
  /** 只看这一台；null 表示全车队。 */
  deviceId: string | null;
  /** 区间下界（含），按 `ts` 过滤；null 表示不设下界。 */
  from: Date | null;
  /** 区间上界（含）；null 表示不设上界。 */
  to: Date | null;
  /** 分桶粒度（时/日）。 */
  bucket: ReportBucketUnit;
  /** 切桶界用的 IANA 时区，交给 `$dateTrunc`。 */
  timezone: string;
}

/**
 * 构造 `telemetry_ts` 上的降采样管道：按（设备 × 时间桶）聚合在线帧数/总帧数与电量均值/最低。
 * `$dateTrunc` 按部署时区切桶界，末尾按设备、桶起点升序，让 mapper 可以顺序切成每台设备一条序列。
 */
export const buildAvailabilityPipeline = (params: AvailabilityPipelineParams): Document[] => {
  const { deviceId, from, to, bucket, timezone } = params;
  const pipeline: Document[] = [];

  const match: Record<string, unknown> = {};
  if (deviceId) match["meta.deviceId"] = deviceId;
  const range: Record<string, Date> = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  if (from || to) match.ts = range;
  if (Object.keys(match).length > 0) {
    pipeline.push({ $match: match });
  }

  pipeline.push(
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
        // `$avg`/`$min` 跳过缺失或非数值的 soc；桶内一个数值都没有时结果是 null，而不是 0。
        socMean: { $avg: "$measurements.vehicleInfo.soc" },
        socMin: { $min: "$measurements.vehicleInfo.soc" },
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

/**
 * 已排序的行 → `AvailabilityReport`（纯映射，`available` 由调用方决定）。按 deviceId 顺序切段成每台
 * 一条序列，算出 `onlineRatio`（零除保护），并把 soc 收敛精度。
 */
export const mapAvailabilityRows = (
  rows: readonly AvailabilityRow[],
  bucket: ReportBucketUnit,
): AvailabilityReport => {
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
    const entry: AvailabilityBucket = {
      bucketStart: toIso(row._id.bucketStart),
      onlineSamples: online,
      totalSamples: total,
      onlineRatio: total > 0 ? online / total : 0,
      socMean: round3(row.socMean),
      socMin: round3(row.socMin),
    };
    current.buckets.push(entry);
  }

  return { bucket, devices, available: true };
};
