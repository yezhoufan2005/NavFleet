/**
 * 定时报表的邮件正文与附件构造——**纯函数，不碰 db / 不读 `Date.now()` / 不发送**。
 *
 * 输入是服务端的两个聚合报表（可用率/电量 + 告警统计），输出一封邮件的 `subject`/`text`/`html` 与
 * 一份可用率 CSV 附件。抽成纯函数的理由和图表 option builder、报表页纯逻辑一样：HTML 转义、KPI 汇总
 * 的样本加权与零除、CSV 转义——机检看不出对错，钉在单测里最稳。scheduler 只负责取数、算收件人、发送。
 *
 * CSV 列与前端 `buildAvailabilityCsv` 保持一致，但**在后端各写一份**：backend 不能 import
 * frontend 代码，而把它下沉到 shared 又要牵动两个前端的测试，不值当为这十几行做那次重构。
 */

import { csvField, REPORT_RANGE_LABELS } from "@navfleet/shared";
import type { AlertStatsReport, AvailabilityReport, ReportRangePreset } from "@navfleet/shared";
import { formatInstantInZone } from "../localTime";
import type { EmailAttachment } from "../notify/email";

/** deviceId → 展示名；取不到名字时回退 id（告警/聚合文档只带 id）。 */
export type DeviceNameOf = (deviceId: string) => string;

export interface ReportEmailInput {
  scheduleId: string;
  range: ReportRangePreset;
  /** 生成时刻的 ISO 串（由调用方注入，便于测试）。 */
  generatedAt: string;
  /**
   * 本地化用的 IANA 时区（来自 `config.reportTimezone`，与聚合切日的时区同源）。标题/文件名的日期
   * 与正文「截至」时刻都按它换算，否则 UTC+8 的运维在 23:00 UTC 触发时，标题日期会写成「前一天」、
   * 正文还印着生 UTC 串。
   */
  timeZone: string;
  availability: AvailabilityReport;
  alertStats: AlertStatsReport;
  nameOf: DeviceNameOf;
}

export interface ReportEmailContent {
  subject: string;
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

/** HTML 转义：设备名/发件配置都可能含 `<`、`&`，进 HTML 前必须转义，别让报表邮件成为注入点。 */
const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 全队按时间加权的在线率与帧数加权的平均电量（跳过无 soc 的桶，零除返回 null）。 */
const summarize = (
  report: AvailabilityReport,
): { onlineRatio: number | null; socMean: number | null } => {
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
  };
};

const pct = (ratio: number | null): string =>
  ratio === null ? "--" : `${(ratio * 100).toFixed(1)}%`;

/** 生成时刻在指定时区的日历日（YYYY-MM-DD）。`en-CA` 的 2-digit 数字格式恰为 ISO 风格日期。 */
const formatDayInZone = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** RFC-4180 CSV 转义。 */

/** 可用率/电量按（设备 × 桶）的 CSV（与前端导出同列）。BOM 让 Excel 正确读中文表头。 */
const buildAvailabilityCsv = (report: AvailabilityReport, nameOf: DeviceNameOf): string => {
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
  // Prepend the UTF-8 BOM (built from its code point so no irregular-whitespace char sits in
  // source) so Excel reads the Chinese header as UTF-8 rather than mojibake.
  return `${String.fromCharCode(0xfeff)}${lines.join("\n")}`;
};

/**
 * 一封定时报表邮件：HTML 摘要（KPI + 告警 Top）作正文，可用率明细 CSV 作附件，纯文本作降级正文。
 * 无 Mongo（两报表 `available:false`）时仍生成一封「本区间无可聚合历史」的邮件——收件人该知道任务在跑
 * 但没有历史后端，而不是收到一封空邮件或干脆不发（不发只留给「零收件人」）。
 */
export const buildReportEmail = (input: ReportEmailInput): ReportEmailContent => {
  const { range, generatedAt, timeZone, availability, alertStats, nameOf } = input;
  const rangeLabel = REPORT_RANGE_LABELS[range];
  const generatedAtDate = new Date(generatedAt);
  const day = formatDayInZone(generatedAtDate, timeZone);
  const generatedAtLabel = formatInstantInZone(generatedAtDate, timeZone);
  const subject = `NavFleet 车队报表 · ${rangeLabel} · ${day}`;

  const noHistory = !availability.available && !alertStats.available;
  const { onlineRatio, socMean } = summarize(availability);
  const ackRate = alertStats.ackRate;

  // 「消息」：total 数的是三档全部（告警只是 critical 一档），与报表页、CSV 同口径。没有历史后端时
  // 写「--」而不是 0，0 会读成「这段时间什么都没发生」。
  const kpis: [string, string][] = [
    ["平均在线率", pct(onlineRatio)],
    ["平均电量", pct(socMean === null ? null : socMean / 100)],
    ["消息总数", alertStats.available ? String(alertStats.total) : "--"],
    ["确认率", !alertStats.available || ackRate === null ? "--" : `${Math.round(ackRate * 100)}%`],
  ];

  const topDevices = alertStats.topDevices.slice(0, 5);

  const textLines = [
    `NavFleet 车队报表（${rangeLabel}，截至 ${generatedAtLabel}）`,
    "",
    ...kpis.map(([label, value]) => `${label}：${value}`),
  ];
  if (topDevices.length > 0) {
    textLines.push("", "消息最多的设备：");
    for (const device of topDevices) {
      textLines.push(`  ${nameOf(device.deviceId)}：${device.count} 条`);
    }
  }
  if (noHistory) {
    textLines.push("", "注意：本部署未连接历史后端（MongoDB），无历史数据，以上指标不可用。");
  }
  textLines.push("", "可用率与电量明细见附件 CSV。");
  const text = textLines.join("\n");

  const kpiRows = kpis
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0;font-weight:600">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const topRows = topDevices
    .map((device) => `<li>${escapeHtml(nameOf(device.deviceId))}：${device.count} 条</li>`)
    .join("");
  const html = [
    `<h2 style="margin:0 0 4px">NavFleet 车队报表</h2>`,
    `<p style="margin:0 0 12px;color:#555">区间：${escapeHtml(rangeLabel)}（截至 ${escapeHtml(generatedAtLabel)}）</p>`,
    `<table style="border-collapse:collapse">${kpiRows}</table>`,
    topRows
      ? `<h3 style="margin:16px 0 4px">消息最多的设备</h3><ol style="margin:0">${topRows}</ol>`
      : "",
    noHistory
      ? `<p style="color:#a00">注意：本部署未连接历史后端（MongoDB），无历史数据，以上指标不可用。</p>`
      : "",
    `<p style="margin-top:16px;color:#555">可用率与电量明细见附件 CSV。</p>`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject,
    text,
    html,
    attachments: [
      {
        filename: `navfleet-可用率-${range}-${day}.csv`,
        content: buildAvailabilityCsv(availability, nameOf),
      },
    ],
  };
};
