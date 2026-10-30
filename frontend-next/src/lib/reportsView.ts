/**
 * 报表页的纯逻辑——从服务端聚合结果推出 KPI、图表序列与 CSV。
 *
 * 抽出成纯函数的理由和图表 option builder 一样：视图里塞不进单测的分支（时间窗口换算、样本加权的
 * 均值、`onlineRatio` 汇总的零除、CSV 转义）恰恰最该被钉住。视图只负责取数、接线、渲染四态。
 *
 * 口径：可用率/电量来自 `/reports/availability`（每设备每桶），告警来自 `/reports/alerts`。桶起点是
 * ISO 串，时序图要 `[epochMs, value]` 且旧点在前——mapper 已按桶起点升序，这里原样转。
 */

import { csvField } from "@navfleet/shared";
import type { AlertStatsReport, AvailabilityReport } from "@navfleet/shared";
import type { TimeSeries } from "@/components/charts/timeSeriesOption";
import { SEVERITY_LABELS } from "@/lib/severity";

export type RangePreset = "12h" | "24h" | "7d" | "30d";

export interface RangeWindow {
  from: string;
  to: string;
}

const PRESET_HOURS: Record<RangePreset, number> = {
  "12h": 12,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

/** ISO from/to window ending at `now` (epoch ms, injected so the window is unit-testable). */
export const windowForPreset = (
  preset: RangePreset,
  now: number,
): RangeWindow => ({
  from: new Date(now - PRESET_HOURS[preset] * 3_600_000).toISOString(),
  to: new Date(now).toISOString(),
});

/**
 * 粒度的「随窗口自适应」默认值。此前默认一律「按天」——12 小时窗按天切只有一个
 * 桶，趋势图几乎是空的，是加载后"看着没数据"的主因之一。短窗用「按小时」才有曲线，宽窗用「按天」才不
 * 至于上千桶拖慢。仅作默认：用户在 URL 里显式选了 bucket 就照它来，这个函数不参与。
 */
export const defaultBucketForSpanMs = (
  spanMs: number,
): "hour" | "day" | "month" => {
  const days = spanMs / 86_400_000;
  if (days <= 2) return "hour";
  if (days <= 92) return "day";
  return "month";
};

/** 预设范围对应的默认粒度。 */
export const defaultBucketForPreset = (
  preset: RangePreset,
): "hour" | "day" | "month" =>
  defaultBucketForSpanMs(PRESET_HOURS[preset] * 3_600_000);

/** deviceId → display name; falls back to the id when the fleet store has no name for it. */
export type DeviceNameOf = (deviceId: string) => string;

export interface AvailabilitySummary {
  /** 全队在线率 = Σ在线时长 / Σ统计时长，跨所有设备与桶（按时间加权）；无数据时 null。 */
  onlineRatio: number | null;
  /** 样本加权的平均 soc（跳过没有 soc 的桶）；无样本时 null。 */
  socMean: number | null;
  deviceCount: number;
}

/**
 * 报表顶部 KPI 带用的全队汇总。在线率按时间加权（Σ onlineSeconds / Σ spanSeconds——离线时段车不上报，
 * 按帧数算会把它漏掉）；soc 按 totalSamples 加权并跳过 socMean 为 null 的桶。两者都做零除保护。
 */
export const summarizeAvailability = (
  report: AvailabilityReport,
): AvailabilitySummary => {
  let online = 0;
  let total = 0;
  let socWeighted = 0;
  let socWeight = 0;
  for (const device of report.devices) {
    for (const bucket of device.buckets) {
      online += bucket.onlineSeconds;
      total += bucket.spanSeconds;
      if (bucket.socMean !== null && bucket.totalSamples > 0) {
        socWeighted += bucket.socMean * bucket.totalSamples;
        socWeight += bucket.totalSamples;
      }
    }
  }
  return {
    onlineRatio: total > 0 ? online / total : null,
    socMean: socWeight > 0 ? socWeighted / socWeight : null,
    deviceCount: report.devices.length,
  };
};

/** 一个 ISO 桶起点 → epoch ms；无法解析时返回 NaN（调用方过滤掉）。 */
const bucketMs = (iso: string): number => Date.parse(iso);

interface BucketFold {
  /** 在线秒数与统计秒数（按时间加权）。 */
  online: number;
  total: number;
  socWeighted: number;
  socWeight: number;
}

/**
 * 把（设备 × 桶）折叠成「每个时间桶一格」的车队汇总。
 *
 * 为什么折叠成一条线：原来每设备一条线，车队一多，图例挤成一片、数据表被压成竖排完全没法读
 * （验收原话）。而这两张图的标题本就是「趋势 / 均值」——要的是车队层面的一条曲线，不是
 * N 条设备线。筛选到单台设备时 report 只有一台，汇总即那台本身，语义不变。
 */
const foldByBucket = (report: AvailabilityReport): Map<number, BucketFold> => {
  const byBucket = new Map<number, BucketFold>();
  for (const device of report.devices) {
    for (const bucket of device.buckets) {
      const ms = bucketMs(bucket.bucketStart);
      if (!Number.isFinite(ms)) continue;
      const fold = byBucket.get(ms) ?? {
        online: 0,
        total: 0,
        socWeighted: 0,
        socWeight: 0,
      };
      fold.online += bucket.onlineSeconds;
      fold.total += bucket.spanSeconds;
      // 电量按帧数加权，null 桶不参与（不画成 0）。
      if (bucket.socMean !== null && bucket.totalSamples > 0) {
        fold.socWeighted += bucket.socMean * bucket.totalSamples;
        fold.socWeight += bucket.totalSamples;
      }
      byBucket.set(ms, fold);
    }
  }
  return byBucket;
};

/** 单台时用设备名，多台折叠时是车队均值——一条线，图例与数据表都清爽。 */
const foldedName = (
  report: AvailabilityReport,
  nameOf: DeviceNameOf,
): string =>
  report.devices.length === 1
    ? nameOf(report.devices[0]!.deviceId)
    : "全部设备均值";

/** 一台设备的在线率点列（百分比 0–100），按桶起点升序，空桶跳过。 */
const deviceOnlinePoints = (
  device: AvailabilityReport["devices"][number],
): [number, number][] =>
  device.buckets
    .filter((bucket) => bucket.spanSeconds > 0)
    .map(
      (bucket) =>
        [bucketMs(bucket.bucketStart), bucket.onlineRatio * 100] as [
          number,
          number,
        ],
    )
    .filter(([ms]) => Number.isFinite(ms))
    .sort((left, right) => left[0] - right[0]);

/** 一台设备的电量均值点列，按桶起点升序；无 soc 的桶跳过（不画成 0）。 */
const deviceSocPoints = (
  device: AvailabilityReport["devices"][number],
): [number, number][] =>
  device.buckets
    .filter((bucket) => bucket.socMean !== null)
    .map(
      (bucket) =>
        [bucketMs(bucket.bucketStart), bucket.socMean!] as [number, number],
    )
    .filter(([ms]) => Number.isFinite(ms))
    .sort((left, right) => left[0] - right[0]);

/**
 * 在线率时序（百分比 0–100）。`perDevice` 时每台设备各一条线（选了设备就是在做横向对比，一人一条才
 * 读得出差异）；否则折成车队按帧加权的一条均值线（不选设备时全队 N 条会糊成一片）。
 */
export const onlineRatioSeries = (
  report: AvailabilityReport,
  nameOf: DeviceNameOf,
  options: { perDevice?: boolean } = {},
): TimeSeries[] => {
  if (options.perDevice) {
    return report.devices
      .map((device) => ({
        name: nameOf(device.deviceId),
        points: deviceOnlinePoints(device),
      }))
      .filter((series) => series.points.length > 0);
  }
  const points = [...foldByBucket(report).entries()]
    .filter(([, fold]) => fold.total > 0)
    .sort((left, right) => left[0] - right[0])
    .map(
      ([ms, fold]) =>
        [ms, (fold.online / fold.total) * 100] as [number, number],
    );
  return points.length ? [{ name: foldedName(report, nameOf), points }] : [];
};

/** 电量 soc 均值时序。`perDevice` 时每台一条线；否则车队按帧加权的一条均值线。 */
export const socSeries = (
  report: AvailabilityReport,
  nameOf: DeviceNameOf,
  options: { perDevice?: boolean } = {},
): TimeSeries[] => {
  if (options.perDevice) {
    return report.devices
      .map((device) => ({
        name: nameOf(device.deviceId),
        points: deviceSocPoints(device),
      }))
      .filter((series) => series.points.length > 0);
  }
  const points = [...foldByBucket(report).entries()]
    .filter(([, fold]) => fold.socWeight > 0)
    .sort((left, right) => left[0] - right[0])
    .map(
      ([ms, fold]) =>
        [ms, fold.socWeighted / fold.socWeight] as [number, number],
    );
  return points.length ? [{ name: foldedName(report, nameOf), points }] : [];
};

/** 「可用率与电量」分区可展开的按设备明细行。 */
export interface DeviceAvailabilityRow {
  deviceId: string;
  /** 展示名（取自实时车队，无则回退 id）。 */
  name: string;
  /** 跨桶在线率 = Σ在线时长 / Σ统计时长（按时间加权）；无数据时 null。 */
  onlineRatio: number | null;
  /** 样本加权电量均值；无 soc 样本时 null。 */
  socMean: number | null;
  /** 期内最低电量；无样本时 null。 */
  socMin: number | null;
  totalSamples: number;
}

/**
 * 把（设备 × 桶）的可用率报表压成「每台一行」的明细，供分区下方的明细表做横向对比。在线率跨桶按时间
 * 汇总、电量按帧加权，和顶部 KPI 的口径一致；按样本数降序。每台都是真实设备，不做任何聚合折叠。
 */
export const deviceAvailabilityRows = (
  report: AvailabilityReport,
  nameOf: DeviceNameOf,
): DeviceAvailabilityRow[] => {
  const rows = report.devices.map((device) => {
    let online = 0;
    let total = 0;
    let socWeighted = 0;
    let socWeight = 0;
    let socMin: number | null = null;
    for (const bucket of device.buckets) {
      online += bucket.onlineSeconds;
      total += bucket.spanSeconds;
      if (bucket.socMean !== null && bucket.totalSamples > 0) {
        socWeighted += bucket.socMean * bucket.totalSamples;
        socWeight += bucket.totalSamples;
      }
      if (bucket.socMin !== null) {
        socMin =
          socMin === null ? bucket.socMin : Math.min(socMin, bucket.socMin);
      }
    }
    return {
      deviceId: device.deviceId,
      name: nameOf(device.deviceId),
      onlineRatio: total > 0 ? online / total : null,
      socMean: socWeight > 0 ? socWeighted / socWeight : null,
      socMin,
      totalSamples: total,
    };
  });
  // 样本数降序。
  return rows.sort((left, right) => right.totalSamples - left.totalSamples);
};

/**
 * 一条折线序列 → 迷你 sparkline 的 SVG `points` 串。把顶部 KPI 从一个孤零零的数字变成
 * 「数字 + 趋势缩影」，用的还是已经取到的数据，不发额外请求。纯函数：按值域归一化到 `width×height`
 * 的盒子里，y 轴翻转（SVG 原点在左上）。点少于 2 个画不成线，返回空串由模板决定不渲染。
 */
export const sparklinePoints = (
  series: readonly TimeSeries[],
  width: number,
  height: number,
): string => {
  const points = series[0]?.points ?? [];
  if (points.length < 2) return "";
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  // Keep a 2px vertical inset so the stroke never sits on the box edge (where half of it is
  // clipped and the line reads as a hairline — the 平均在线率/电量 卡 symptom). A flat line then
  // lands on the lower inset line, drawn at full width.
  const pad = 2;
  const usable = Math.max(1, height - pad * 2);
  return points
    .map(([x, y]) => {
      const px = ((x - minX) / spanX) * width;
      const py = height - pad - ((y - minY) / spanY) * usable;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
};

/** RFC-4180 转义：含逗号/引号/换行的字段用引号包起来，内部引号翻倍。 */

/**
 * 可用率/电量按（设备 × 桶）导出为 CSV（交班/汇报的刚需）。BOM 由下载时加，不进这里。
 * `null` 的 soc 留空而不是写 0——空单元格是"这段没有电量样本"，0 会被读成"没电"。
 */
export const buildAvailabilityCsv = (
  report: AvailabilityReport,
  nameOf: DeviceNameOf,
): string => {
  const header = [
    "设备ID",
    "设备名称",
    "时间桶",
    "在线帧",
    "总帧",
    "在线秒数",
    "统计秒数",
    "在线率",
    "电量均值",
    "电量最低",
  ];
  const lines = [header.map(csvField).join(",")];
  for (const device of report.devices) {
    for (const bucket of device.buckets) {
      lines.push(
        [
          device.deviceId,
          nameOf(device.deviceId),
          bucket.bucketStart,
          bucket.onlineSamples,
          bucket.totalSamples,
          bucket.onlineSeconds,
          bucket.spanSeconds,
          bucket.onlineRatio.toFixed(4),
          bucket.socMean ?? "",
          bucket.socMin ?? "",
        ]
          .map(csvField)
          .join(","),
      );
    }
  }
  return lines.join("\n");
};

/**
 * 消息统计（`/reports/alerts`）导出为 CSV，补齐与可用率导出的对等能力（1.6.1）。
 *
 * 报表是聚合而非逐行明细，所以用长表（分组/项/数值）把页面显示的一切都装进一个文件：严重度分布、
 * 设备 Top-N、按天频次，加上顶部 KPI（总数 / 确认率 / 时长）。`ackRate` 为 null（无记录）时留空，
 * 不写 0——空单元格是「没有可算确认率的样本」，0 会被读成「一条都没确认」。设备名用实时车队解析
 * （`topDevices` 只带 id），无则回退 id。
 */
export const buildAlertStatsCsv = (
  report: AlertStatsReport,
  nameOf: DeviceNameOf,
): string => {
  const lines = [["分组", "项", "数值"].map(csvField).join(",")];
  const push = (group: string, item: string, value: string | number): void => {
    lines.push([group, item, value].map(csvField).join(","));
  };

  push("汇总", "消息总数", report.total);
  push("汇总", "确认率", report.ackRate ?? "");
  push("汇总", "平均处理时长(ms)", report.duration.meanMs ?? "");
  push("汇总", "处理时长中位数(ms)", report.duration.p50Ms ?? "");

  for (const key of ["critical", "warning", "notice"] as const) {
    push("严重度", SEVERITY_LABELS[key], report.bySeverity[key]);
  }
  for (const device of report.topDevices) {
    push("设备", nameOf(device.deviceId), device.count);
  }
  for (const entry of report.daily) {
    push("按天", entry.day, entry.count);
  }

  return lines.join("\n");
};
