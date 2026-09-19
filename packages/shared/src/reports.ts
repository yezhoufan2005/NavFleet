/**
 * 报表聚合的共享契约（Phase 17A）。
 *
 * 只放**后端算、前端渲染**的聚合结果形状——和 `notify.ts` 同样的分家理由：聚合管道的构造与执行
 * 是后端独有逻辑（`backend/src/reports/`），不进这个两个前端都 import 的包。
 *
 * **口径**：这些数字**只在有 Mongo 时才算得出来**。时序库与 `alerts` 集合是历史的唯一来源，内存
 * 回退只有活跃告警、没有历史（同 16B 的先例）。所以每个报表都带一个 `available` 标志：`false` 表示
 * 这个部署没有历史后端，页面据此显示诚实空态，而不是把「零条」画成「一切正常」。
 *
 * 时间戳一律是 ISO-8601 字符串（Mongo 的 `Date` 经 JSON 序列化后就是它）。
 */

import type { Severity } from "./index";

/**
 * 告警统计按「首次出现时间」（`firstSeenAt`）分桶。日频次按**部署配置的时区**切日界（见
 * `REPORT_TIMEZONE`），而不是 UTC——UTC+8 的部署若按 UTC 切日，午夜后的告警会落到"昨天"，那是错的。
 */
export interface ReportDeviceCount {
  deviceId: string;
  count: number;
}

export interface ReportDailyCount {
  /** 本地日历日 `YYYY-MM-DD`，按部署时区切界。 */
  day: string;
  count: number;
}

export interface ReportDurationStats {
  /** 同时有起点（`firstSeenAt`）与清除时间（`clearedAt`）、因而算得出时长的告警条数。 */
  count: number;
  meanMs: number | null;
  /** 中位数（p50）；样本为空时 null。 */
  p50Ms: number | null;
}

/**
 * `alerts` 集合上的服务端聚合。不受 `/api/alerts` 那 500 条读取上限约束——这正是把统计从 16B 的
 * 前端就地算下沉到服务端聚合的理由（16B 的注释已预告本阶段）。
 *
 * `topDevices` 只带 `deviceId`：`alerts` 文档不存 `deviceName`（它属于实时设备状态，不属于告警），
 * 前端渲染时用在线设备列表把 id 映射成名字即可，两边都不必让告警文档冗余一份会过期的名字。
 */
export interface AlertStatsReport {
  total: number;
  bySeverity: Record<Severity, number>;
  /** 按告警条数降序的设备 Top-N。 */
  topDevices: ReportDeviceCount[];
  /** 按天升序。 */
  daily: ReportDailyCount[];
  /** 已确认数 / 总数，落在 [0,1]；无记录时 null。 */
  ackRate: number | null;
  duration: ReportDurationStats;
  /** 是否有历史后端（Mongo）。false ⇒ 诚实空态，其余字段是零值而非"真的没有告警"。 */
  available: boolean;
}

/** 空报表：无 Mongo（`available:false`）或区间内确无告警（`available:true`）时的零值形状。 */
export const emptyAlertStatsReport = (
  available: boolean,
): AlertStatsReport => ({
  total: 0,
  bySeverity: { critical: 0, warning: 0, notice: 0 },
  topDevices: [],
  daily: [],
  ackRate: null,
  duration: { count: 0, meanMs: null, p50Ms: null },
  available,
});

/** 可用率/电量时序的分桶粒度（Phase 17A-2）。时序库按此 `$dateTrunc` 降采样。 */
export type ReportBucketUnit = "hour" | "day";
export const REPORT_BUCKET_UNITS: readonly ReportBucketUnit[] = ["hour", "day"];

/**
 * 一个时间桶内、单台设备的可用率与电量（Phase 17A-2）。
 *
 * `onlineRatio = onlineSamples / totalSamples`：这段时间里上报的帧中有多少标着在线，即可用率的直接
 * 度量。`socMean`/`socMin` 来自 `vehicleInfo.soc`；桶内没有任何数值样本时为 null（`$avg`/`$min`
 * 会跳过缺失/非数值，不会把 null 当 0）。
 */
export interface AvailabilityBucket {
  /** 桶起点 ISO（`$dateTrunc` 的结果，按部署时区切界）。 */
  bucketStart: string;
  onlineSamples: number;
  totalSamples: number;
  onlineRatio: number;
  socMean: number | null;
  socMin: number | null;
}

export interface AvailabilityDeviceSeries {
  deviceId: string;
  /** 按桶起点升序。 */
  buckets: AvailabilityBucket[];
}

export interface AvailabilityReport {
  bucket: ReportBucketUnit;
  devices: AvailabilityDeviceSeries[];
  /** 是否有历史后端（Mongo）。false ⇒ 诚实空态（同 16B「无 Mongo 无历史」先例）。 */
  available: boolean;
}

/** 空的可用率报表：无 Mongo 或区间内无遥测时的零值形状。 */
export const emptyAvailabilityReport = (
  bucket: ReportBucketUnit,
  available: boolean,
): AvailabilityReport => ({
  bucket,
  devices: [],
  available,
});
