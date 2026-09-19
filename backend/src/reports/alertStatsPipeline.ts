/**
 * 告警统计的聚合管道（Phase 17A）——**纯函数，不碰 db、不读 `Date.now()`**。
 *
 * 拆成纯 builder + 纯 mapper 的理由和图表 option builder 一样：jsdom/单测里没有 Mongo，但管道的形状
 * 与 facet→报表的映射恰恰是最该被钉住的部分（一条 `$group` 的 key 写错、median 取错元素，机检不会
 * 报，但数字会错）。persistence 只负责「有 db 就 `.aggregate(pipeline)`、把结果喂给 mapper；没 db 就
 * 诚实空态」，那一层用 fake db 验接线即可。
 *
 * **数据来源口径**：`alerts` 集合里，`firstSeenAt`/`clearedAt` 存的是 Mongo `Date`（`upsertAlerts`
 * 用 `new Date(...)` 写入，TTL 也建在 `lastSeenAt` 这个 Date 上），而 `ts` 是 ISO 字符串。所以按时间
 * 分桶/切日一律用 `firstSeenAt`（首次出现即告警发生的时刻），时长用 `clearedAt - firstSeenAt`。
 */

import type { Document } from "mongodb";
import type {
  AlertStatsReport,
  ReportDailyCount,
  ReportDeviceCount,
  Severity,
} from "@navfleet/shared";

const SEVERITIES: readonly Severity[] = ["critical", "warning", "notice"];

export interface AlertStatsPipelineParams {
  /** 区间下界（含），按 `firstSeenAt` 过滤；null 表示不设下界。 */
  from: Date | null;
  /** 区间上界（含）；null 表示不设上界。 */
  to: Date | null;
  /** Top-N 设备保留几个。 */
  topN: number;
  /** 切日界用的 IANA 时区（如 `Asia/Shanghai`），交给 `$dateToString`。 */
  timezone: string;
}

/**
 * 构造 `alerts` 集合上的 `$facet` 管道：一次扫描算齐严重度分布 / 设备 Top-N / 日频次 / 总数与确认数 /
 * 已清除告警的时长样本。用 `$facet` 而不是发五条独立聚合，是为了只扫一遍 `firstSeenAt` 区间。
 */
export const buildAlertStatsPipeline = (params: AlertStatsPipelineParams): Document[] => {
  const { from, to, topN, timezone } = params;
  const pipeline: Document[] = [];

  // 只在给了边界时才加 `$match`——不给就是「TTL 窗口内全部」。边界打在 `firstSeenAt`（Date）上。
  const range: Record<string, Date> = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  if (from || to) {
    pipeline.push({ $match: { firstSeenAt: range } });
  }

  pipeline.push({
    $facet: {
      bySeverity: [{ $group: { _id: "$severity", count: { $sum: 1 } } }],
      topDevices: [
        { $group: { _id: "$deviceId", count: { $sum: 1 } } },
        // id 做二级键让并列计数的次序稳定（否则 Top-N 的截断点会随机漂）。
        { $sort: { count: -1, _id: 1 } },
        { $limit: topN },
      ],
      daily: [
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$firstSeenAt",
                timezone,
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ],
      totals: [
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            // `ackedBy` 非空即已确认；缺字段/ null 都记 0。
            acked: {
              $sum: { $cond: [{ $ifNull: ["$ackedBy", false] }, 1, 0] },
            },
          },
        },
      ],
      durations: [
        // 只有真正是 Date 的 `clearedAt` 才算时长：活跃告警在 Mongo 里没有这个字段。
        {
          $match: {
            clearedAt: { $type: "date" },
            firstSeenAt: { $type: "date" },
          },
        },
        {
          $project: {
            ms: {
              $dateDiff: {
                startDate: "$firstSeenAt",
                endDate: "$clearedAt",
                unit: "millisecond",
              },
            },
          },
        },
        // 负时长（时钟回拨等）丢弃，别把它算进均值/中位数。
        { $match: { ms: { $gte: 0 } } },
        // 样本量有界（告警远比遥测稀疏），推给应用层算精确的均值+中位数，
        // 免得依赖 `$percentile` 的近似语义。
        { $group: { _id: null, values: { $push: "$ms" } } },
      ],
    },
  });

  return pipeline;
};

/** facet 里一个 `{_id, count}` 桶。`_id` 是被 `$group` 的那个字符串字段（严重度 / deviceId /
 * 切日后的日期串），可能为 null（字段缺失时）。 */
interface CountBucket {
  _id: string | null;
  count: number;
}

/** `$facet` 单文档结果的松形状——每个键是一段子管道的输出数组。 */
export interface AlertStatsFacet {
  bySeverity?: CountBucket[];
  topDevices?: CountBucket[];
  daily?: CountBucket[];
  totals?: { total?: number; acked?: number }[];
  durations?: { values?: number[] }[];
}

const median = (sortedOrNot: readonly number[]): number | null => {
  if (sortedOrNot.length === 0) return null;
  const sorted = [...sortedOrNot].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/** 把未知/缺失的严重度归到最轻一档，和 16B 前端的 `severityOf` 保持一致。 */
const normalizeSeverity = (value: unknown): Severity =>
  SEVERITIES.includes(value as Severity) ? (value as Severity) : "notice";

/**
 * facet 结果 → `AlertStatsReport`（纯映射，`available` 由调用方决定）。这里做三件机检看不出对错的事：
 * 未知严重度归并、确认率的零除保护、时长中位数的取值。
 */
export const mapAlertStatsFacet = (facet: AlertStatsFacet): AlertStatsReport => {
  const bySeverity: Record<Severity, number> = {
    critical: 0,
    warning: 0,
    notice: 0,
  };
  for (const bucket of facet.bySeverity ?? []) {
    bySeverity[normalizeSeverity(bucket._id)] += bucket.count;
  }

  const topDevices: ReportDeviceCount[] = (facet.topDevices ?? []).map((bucket) => ({
    deviceId: String(bucket._id ?? ""),
    count: bucket.count,
  }));

  const daily: ReportDailyCount[] = (facet.daily ?? []).map((bucket) => ({
    day: String(bucket._id ?? ""),
    count: bucket.count,
  }));

  const totals = facet.totals?.[0];
  const total = totals?.total ?? 0;
  const acked = totals?.acked ?? 0;

  const values = facet.durations?.[0]?.values ?? [];
  const mean =
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  return {
    total,
    bySeverity,
    topDevices,
    daily,
    ackRate: total > 0 ? acked / total : null,
    duration: {
      count: values.length,
      meanMs: mean,
      p50Ms: median(values),
    },
    available: true,
  };
};
