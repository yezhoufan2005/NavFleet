/**
 * 报表页的纯逻辑（Phase 17B-1）——从服务端聚合结果推出 KPI、图表序列与 CSV。
 *
 * 抽出成纯函数的理由和图表 option builder 一样：视图里塞不进单测的分支（时间窗口换算、样本加权的
 * 均值、`onlineRatio` 汇总的零除、CSV 转义）恰恰最该被钉住。视图只负责取数、接线、渲染四态。
 *
 * 口径：可用率/电量来自 `/reports/availability`（每设备每桶），告警来自 `/reports/alerts`。桶起点是
 * ISO 串，时序图要 `[epochMs, value]` 且旧点在前——mapper 已按桶起点升序，这里原样转。
 */

import type { AvailabilityReport } from "@navfleet/shared";
import type { TimeSeries } from "@/components/charts/timeSeriesOption";

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

/** deviceId → display name; falls back to the id when the fleet store has no name for it. */
export type DeviceNameOf = (deviceId: string) => string;

export interface AvailabilitySummary {
  /** 全队在线帧比 = Σonline / Σtotal，跨所有设备与桶；无样本时 null。 */
  onlineRatio: number | null;
  /** 样本加权的平均 soc（跳过没有 soc 的桶）；无样本时 null。 */
  socMean: number | null;
  deviceCount: number;
}

/**
 * 报表顶部 KPI 带用的全队汇总。在线率按帧数加权（长桶不该和短桶等权），soc 同理按 totalSamples 加权
 * 并跳过 socMean 为 null 的桶。两者都做零除保护。
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
      online += bucket.onlineSamples;
      total += bucket.totalSamples;
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
  online: number;
  total: number;
  socWeighted: number;
  socWeight: number;
}

/**
 * 把（设备 × 桶）折叠成「每个时间桶一格」的车队汇总。
 *
 * 为什么折叠成一条线：原来每设备一条线，车队一多，图例挤成一片、数据表被压成竖排完全没法读
 * （17B 验收原话）。而这两张图的标题本就是「趋势 / 均值」——要的是车队层面的一条曲线，不是
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
      fold.online += bucket.onlineSamples;
      fold.total += bucket.totalSamples;
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

/** 单台时用设备名，多台时是车队均值——一条线，图例与数据表都清爽。 */
const seriesName = (
  report: AvailabilityReport,
  nameOf: DeviceNameOf,
): string =>
  report.devices.length === 1
    ? nameOf(report.devices[0]!.deviceId)
    : "全部设备均值";

/** 在线率时序（百分比 0–100）：车队按帧加权的一条均值线，旧点在前。 */
export const onlineRatioSeries = (
  report: AvailabilityReport,
  nameOf: DeviceNameOf,
): TimeSeries[] => {
  const points = [...foldByBucket(report).entries()]
    .filter(([, fold]) => fold.total > 0)
    .sort((left, right) => left[0] - right[0])
    .map(
      ([ms, fold]) =>
        [ms, (fold.online / fold.total) * 100] as [number, number],
    );
  return points.length ? [{ name: seriesName(report, nameOf), points }] : [];
};

/** 电量 soc 均值时序：车队按帧加权的一条均值线；无 soc 的桶跳过（不画成 0）。 */
export const socSeries = (
  report: AvailabilityReport,
  nameOf: DeviceNameOf,
): TimeSeries[] => {
  const points = [...foldByBucket(report).entries()]
    .filter(([, fold]) => fold.socWeight > 0)
    .sort((left, right) => left[0] - right[0])
    .map(
      ([ms, fold]) =>
        [ms, fold.socWeighted / fold.socWeight] as [number, number],
    );
  return points.length ? [{ name: seriesName(report, nameOf), points }] : [];
};

/** RFC-4180 转义：含逗号/引号/换行的字段用引号包起来，内部引号翻倍。 */
const csvField = (value: string | number): string => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

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
