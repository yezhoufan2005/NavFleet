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
}

/**
 * 构造 `telemetry_ts` 上的降采样管道：按（设备 × 时间桶）聚合在线帧数/总帧数与电量均值/最低。
 * `$dateTrunc` 按部署时区切桶界，末尾按设备、桶起点升序，让 mapper 可以顺序切成每台设备一条序列。
 * `deviceIds` 多选时用 `$in` 收窄到选中的若干台，每台仍各自成一条序列。
 */
export const buildAvailabilityPipeline = (params: AvailabilityPipelineParams): Document[] => {
  const { deviceIds, from, to, bucket, timezone } = params;
  const pipeline: Document[] = [];

  const match: Record<string, unknown> = {};
  if (deviceIds && deviceIds.length > 0) {
    match["meta.deviceId"] = deviceIds.length === 1 ? deviceIds[0] : { $in: deviceIds };
  }
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

/** `deviceId` used for the folded "everyone past the Top-N" series. Chosen to never collide with a
 * real vendor id (those are plain names); the frontend relabels it to 「其余 N 台」. */
export const OTHERS_DEVICE_ID = "__others__";

/**
 * 已排序的行 → `AvailabilityReport`（纯映射，`available` 由调用方决定）。按 deviceId 顺序切段成每台
 * 一条序列，算出 `onlineRatio`（零除保护），并把 soc 收敛精度。
 *
 * `topN` 给定时**限制返回的设备序列数**（Phase 18 报表重做的性能项）：按总样本数排前 N 台各自成列，
 * 其余全部折进一条 `__others__` 序列——按 `bucketStart` 把多台的同一时间桶样本加权合并。为什么在
 * mapper 折而不在 Mongo 折：这里要砍的是**响应体大小**（30 天 × 按小时 × 全车队会上兆），而桶内按
 * `totalSamples` 加权合 soc，恰好让前端 `foldByBucket` 的车队加权和一字不差——折叠对图/汇总都无损。
 */
export const mapAvailabilityRows = (
  rows: readonly AvailabilityRow[],
  bucket: ReportBucketUnit,
  options: { topN?: number } = {},
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

  const capped = capToTopN(devices, options.topN);
  return { bucket, devices: capped, available: true };
};

/** 一台设备的总样本数——Top-N 排名用（样本越多越"主力"，越该单独成列）。 */
const totalSamplesOf = (series: AvailabilityDeviceSeries): number =>
  series.buckets.reduce((sum, bucket) => sum + bucket.totalSamples, 0);

/**
 * 把设备序列裁到前 `topN` 台，其余折进一条 `__others__`。无 `topN` 或设备数未超限时原样返回。
 * 折叠按 `bucketStart` 合并：帧数直接相加，soc 按 `totalSamples` 加权求均（null soc 的样本不计权，
 * 和 `$avg` 跳过缺失的口径一致），`socMin` 取各台之最小。
 */
const capToTopN = (
  devices: AvailabilityDeviceSeries[],
  topN: number | undefined,
): AvailabilityDeviceSeries[] => {
  if (!topN || devices.length <= topN) return devices;

  const ranked = [...devices].sort((left, right) => totalSamplesOf(right) - totalSamplesOf(left));
  const kept = ranked.slice(0, topN);
  const folded = ranked.slice(topN);

  // bucketStart → 合并累加器（soc 带权，便于最后还原加权均值）。
  const merged = new Map<
    string,
    {
      onlineSamples: number;
      totalSamples: number;
      socWeighted: number;
      socWeight: number;
      socMin: number | null;
    }
  >();
  for (const device of folded) {
    for (const bucket of device.buckets) {
      const acc = merged.get(bucket.bucketStart) ?? {
        onlineSamples: 0,
        totalSamples: 0,
        socWeighted: 0,
        socWeight: 0,
        socMin: null,
      };
      acc.onlineSamples += bucket.onlineSamples;
      acc.totalSamples += bucket.totalSamples;
      if (bucket.socMean !== null && bucket.totalSamples > 0) {
        acc.socWeighted += bucket.socMean * bucket.totalSamples;
        acc.socWeight += bucket.totalSamples;
      }
      if (bucket.socMin !== null) {
        acc.socMin = acc.socMin === null ? bucket.socMin : Math.min(acc.socMin, bucket.socMin);
      }
      merged.set(bucket.bucketStart, acc);
    }
  }

  const othersBuckets: AvailabilityBucket[] = [...merged.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([bucketStart, acc]) => ({
      bucketStart,
      onlineSamples: acc.onlineSamples,
      totalSamples: acc.totalSamples,
      onlineRatio: acc.totalSamples > 0 ? acc.onlineSamples / acc.totalSamples : 0,
      socMean: acc.socWeight > 0 ? round3(acc.socWeighted / acc.socWeight) : null,
      socMin: round3(acc.socMin),
    }));

  return [...kept, { deviceId: OTHERS_DEVICE_ID, buckets: othersBuckets }];
};
