/**
 * 告警统计的聚合管道——**纯函数，不碰 db、不读 `Date.now()`**。
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
import { DURATION_BUCKETS, SEVERITIES, emptyDurationBuckets } from "@navfleet/shared";
import type {
  AlertStatsReport,
  DurationBucketKey,
  ReportDailyDisposition,
  ReportDeviceCount,
  ReportMessageType,
  Severity,
} from "@navfleet/shared";

/** 消息类型最多返回几类（按条数降序）；前端的 Top-N 选择在这之内截取。 */
export const MESSAGE_TYPES_CAP = 50;

/**
 * 处置三态的判定表达式，`totals` 与按天的 `daily` 共用，保证两处口径一字不差。三者互不重叠：
 * claimed = 认领且未忽略；ignored = 已忽略（忽略盖过认领）；autoRecovered = 已清除且无人处置。
 */
const IS_CLAIMED = {
  $and: [{ $ifNull: ["$claimedBy", false] }, { $not: [{ $ifNull: ["$ignoredBy", false] }] }],
};
const IS_IGNORED = { $ifNull: ["$ignoredBy", false] };
const IS_AUTO_RECOVERED = {
  $and: [
    { $eq: [{ $type: "$clearedAt" }, "date"] },
    { $not: [{ $ifNull: ["$claimedBy", false] }] },
    { $not: [{ $ifNull: ["$ignoredBy", false] }] },
  ],
};
const countIf = (condition: Document): Document => ({ $sum: { $cond: [condition, 1, 0] } });

/** 严重度的轻重次序，用来取一类消息里最重的一档。 */
const SEVERITY_RANK = {
  $switch: {
    branches: [
      { case: { $eq: ["$severity", "critical"] }, then: 2 },
      { case: { $eq: ["$severity", "warning"] }, then: 1 },
    ],
    default: 0,
  },
};

/** 时长（`$ms`）落在 `DURATION_BUCKETS` 的哪一档；与 shared 的 `durationBucketOf` 同一张表。 */
const DURATION_BUCKET_OF = {
  $switch: {
    branches: DURATION_BUCKETS.filter((bucket) => Number.isFinite(bucket.maxMs)).map((bucket) => ({
      case: { $lt: ["$ms", bucket.maxMs] },
      then: bucket.key,
    })),
    default: DURATION_BUCKETS[DURATION_BUCKETS.length - 1]!.key,
  },
};

/** 已清除消息的处置时长（毫秒），`durations` 与 `durationBuckets` 共用。 */
const CLEARED_DURATION: Document[] = [
  // 只有真正是 Date 的 `clearedAt` 才算时长：活跃告警在 Mongo 里没有这个字段。
  { $match: { clearedAt: { $type: "date" }, firstSeenAt: { $type: "date" } } },
  {
    $project: {
      severity: 1,
      ms: {
        $dateDiff: { startDate: "$firstSeenAt", endDate: "$clearedAt", unit: "millisecond" },
      },
    },
  },
  // 负时长（时钟回拨等）丢弃，别把它算进均值/中位数。
  { $match: { ms: { $gte: 0 } } },
];

export interface AlertStatsPipelineParams {
  /** 区间下界（含），按 `firstSeenAt` 过滤；null 表示不设下界。 */
  from: Date | null;
  /** 区间上界（含）；null 表示不设上界。 */
  to: Date | null;
  /** 限定到这些设备（空/缺省 = 全车队）；与在线率报表同口径，让设备筛选同时收窄这半页。 */
  deviceIds?: string[] | null;
  /** Top-N 设备保留几个。 */
  topN: number;
  /** 切日界用的 IANA 时区（如 `Asia/Shanghai`），交给 `$dateToString`。 */
  timezone: string;
}

/**
 * 构造 `alerts` 集合上的 `$facet` 管道：一次扫描算齐严重度分布 / 设备 Top-N / 日频次 / 总数与处置计数 /
 * 已清除告警的时长样本。用 `$facet` 而不是发五条独立聚合，是为了只扫一遍 `firstSeenAt` 区间。
 */
export const buildAlertStatsPipeline = (params: AlertStatsPipelineParams): Document[] => {
  const { from, to, deviceIds, topN, timezone } = params;
  const pipeline: Document[] = [];

  // 设备过滤先行：给了设备列表就只统计这些车，否则全车队。放在时间 `$match` 之前，和在线率报表一致。
  if (deviceIds && deviceIds.length > 0) {
    pipeline.push({ $match: { deviceId: { $in: [...deviceIds] } } });
  }

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
            claimed: countIf(IS_CLAIMED),
            ignored: countIf(IS_IGNORED),
            autoRecovered: countIf(IS_AUTO_RECOVERED),
          },
        },
        { $sort: { _id: 1 } },
      ],
      topTypes: [
        {
          $group: {
            _id: { title: "$title", code: { $ifNull: ["$code", null] } },
            count: { $sum: 1 },
            rank: { $max: SEVERITY_RANK },
            // 报码消息的 detail 是报码字典里的含义（同码同义），比通用标题「提示报码」更能说明是哪类。
            detail: { $first: "$detail" },
          },
        },
        // 标题做二级键让并列计数的次序稳定。
        { $sort: { count: -1, "_id.title": 1 } },
        { $limit: MESSAGE_TYPES_CAP },
      ],
      durationBuckets: [
        ...CLEARED_DURATION,
        {
          $group: {
            _id: { bucket: DURATION_BUCKET_OF, severity: "$severity" },
            count: { $sum: 1 },
          },
        },
      ],
      totals: [
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            // 处置三指标的计数，分母统一用 total（见 shared `AlertStatsReport`）。
            claimed: countIf(IS_CLAIMED),
            ignored: countIf(IS_IGNORED),
            autoRecovered: countIf(IS_AUTO_RECOVERED),
          },
        },
      ],
      durations: [
        ...CLEARED_DURATION,
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
  daily?: (CountBucket & { claimed?: number; ignored?: number; autoRecovered?: number })[];
  topTypes?: {
    _id: { title?: string | null; code?: number | null };
    count: number;
    rank?: number;
    detail?: string | null;
  }[];
  durationBuckets?: { _id: { bucket?: string; severity?: string | null }; count: number }[];
  totals?: {
    total?: number;
    claimed?: number;
    ignored?: number;
    autoRecovered?: number;
  }[];
  durations?: { values?: number[] }[];
}

const median = (sortedOrNot: readonly number[]): number | null => {
  if (sortedOrNot.length === 0) return null;
  const sorted = [...sortedOrNot].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/** 把未知/缺失的严重度归到最轻一档，和前端的 `severityOf` 保持一致。 */
const normalizeSeverity = (value: unknown): Severity =>
  (SEVERITIES as readonly string[]).includes(value as string) ? (value as Severity) : "notice";

/**
 * facet 结果 → `AlertStatsReport`（纯映射，`available` 由调用方决定）。这里做三件机检看不出对错的事：
 * 未知严重度归并、处置三率的零除保护、时长中位数的取值。
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

  const daily: ReportDailyDisposition[] = (facet.daily ?? []).map((bucket) => ({
    day: String(bucket._id ?? ""),
    count: bucket.count,
    claimed: bucket.claimed ?? 0,
    ignored: bucket.ignored ?? 0,
    autoRecovered: bucket.autoRecovered ?? 0,
  }));

  const RANKED: Severity[] = ["notice", "warning", "critical"];
  const topTypes: ReportMessageType[] = (facet.topTypes ?? []).map((bucket) => ({
    title: String(bucket._id?.title ?? "") || "（无标题）",
    code: typeof bucket._id?.code === "number" ? bucket._id.code : null,
    detail: typeof bucket._id?.code === "number" ? String(bucket.detail ?? "") : "",
    severity: RANKED[bucket.rank ?? 0] ?? "notice",
    count: bucket.count,
  }));

  // 每档都在（空档为 0），顺序按 DURATION_BUCKETS；未知档位的桶丢弃。
  const durationBuckets = emptyDurationBuckets();
  for (const bucket of facet.durationBuckets ?? []) {
    const slot = durationBuckets.find(
      (entry) => entry.bucket === (bucket._id?.bucket as DurationBucketKey),
    );
    if (slot) slot.bySeverity[normalizeSeverity(bucket._id?.severity)] += bucket.count;
  }

  const totals = facet.totals?.[0];
  const total = totals?.total ?? 0;
  const rate = (count: number | undefined): number | null =>
    total > 0 ? (count ?? 0) / total : null;

  const values = facet.durations?.[0]?.values ?? [];
  const mean =
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  return {
    total,
    bySeverity,
    topDevices,
    daily,
    topTypes,
    durationBuckets,
    claimRate: rate(totals?.claimed),
    ignoreRate: rate(totals?.ignored),
    autoRecoverRate: rate(totals?.autoRecovered),
    duration: {
      count: values.length,
      meanMs: mean,
      p50Ms: median(values),
    },
    available: true,
  };
};
