/**
 * 定时报表调度器——按 reports.json 的时刻把报表生成并邮件推送。
 *
 * **无新依赖**：不用 node-cron，靠 index.ts 的一个 60s 轮询调用 {@link ReportScheduler.tick}，同
 * 外发 digest 的 15s 轮询先例。判定「到点」用的是**「本地日历日内、已过发送时刻且今天还没发过」**，而不是
 * 精确匹配到分钟——60s tick 会因抖动错过某一分钟，而「过点即发、每天一次」对抖动免疫。
 *
 * **重启不补发**：`lastFired` 是内存态（同外发的升级定时器）。首个 tick 会把「启动时已过点」的日子标成
 * 已发而**不真发**，这样重启不会让当天的报表重发一遍；代价是进程恰在发送时刻前后重启可能漏发一次，对
 * 单实例内网监控可接受。
 *
 * **红线**：出厂零配置（reports.json 缺省）= 无 schedule = 不发。SMTP 串走 env（schedule 只记
 * `smtpEnv`），缺失或收件人为空 ⇒ 该条静默跳过（记一次日志，不发、不编造成功）。
 */

import type {
  AlertStatsReport,
  AvailabilityReport,
  NotifyConfig,
  ReportRangePreset,
  ReportScheduleConfig,
} from "@navfleet/shared";
import { resolveRecipients } from "../notify/recipients";
import { buildReportEmail } from "./reportEmail";
import { sendEmail, type EmailMessage } from "../notify/email";
import type { AttemptOutcome } from "../notify/retry";
import { moduleLogger } from "../logger";
import { localParts } from "../localTime";

const logger = moduleLogger("reports-scheduler");

export interface ReportSchedulerDeps {
  /** 生效的 schedule 列表（configRegistry getReportsConfig().schedules）。 */
  getSchedules: () => readonly ReportScheduleConfig[];
  /** notify.json 的用户组（收件人 groups 引用它）。 */
  getNotifyGroups: () => NotifyConfig["groups"];
  aggregateAlertStats: (range: { from: string; to: string }) => Promise<AlertStatsReport>;
  aggregateAvailability: (params: {
    from: string;
    to: string;
    bucket: "hour" | "day";
  }) => Promise<AvailabilityReport>;
  resolveUserEmail: (username: string) => Promise<string | null>;
  /** deviceId → 名称（取自实时车队快照）。 */
  nameOf: (deviceId: string) => string;
  /** env 变量名 → SMTP 连接串（缺失返回 undefined）。缺省用 process.env。 */
  readSmtpUrl?: (envName: string) => string | undefined;
  /** 切日/切时刻用的 IANA 时区（config.reportTimezone）。 */
  timezone: string;
  maxAttempts: number;
  timeoutMs: number;
  /** 可注入时钟（毫秒）；缺省 Date.now。 */
  now?: () => number;
  /** 可注入的发送实现（测试用，避免真发 SMTP）。 */
  sendEmailImpl?: (
    smtpUrl: string,
    message: EmailMessage,
    options: { maxAttempts: number; timeoutMs: number },
  ) => Promise<AttemptOutcome>;
}

const RANGE_HOURS: Record<ReportRangePreset, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export class ReportScheduler {
  private readonly deps: ReportSchedulerDeps;
  private readonly clock: () => number;
  private readonly readSmtpUrl: (envName: string) => string | undefined;
  /** schedule id → 最近已发送（或启动时判为已过点而跳过）的本地日期串。 */
  private readonly lastFired = new Map<string, string>();
  /**
   * schedule id → 上次 tick 看到的发送时刻（`time` + `weekday`）。没见过或刚改过时刻的条目，
   * 当天已过点的那一次不补发：重启、控制台新建、改发送时刻、重新启用都一样。
   */
  private readonly seenTiming = new Map<string, string>();

  constructor(deps: ReportSchedulerDeps) {
    this.deps = deps;
    this.clock = deps.now ?? (() => Date.now());
    this.readSmtpUrl = deps.readSmtpUrl ?? ((name) => process.env[name]);
  }

  /**
   * Called on each poll (index.ts, ~60s). Fires every schedule that is now due. Synchronous: the
   * per-schedule generate+send is dispatched fire-and-forget via {@link fire}, so a slow SMTP
   * never holds up the tick or the schedules behind it.
   */
  tick(): void {
    const nowMs = this.clock();
    const schedules = this.deps.getSchedules();
    for (const schedule of schedules) {
      if (!schedule.enabled) {
        // Re-enabling one later in the day counts as first sight too.
        this.seenTiming.delete(schedule.id);
        continue;
      }
      const timing = `${schedule.time}|${schedule.weekday ?? ""}`;
      const firstSight = this.seenTiming.get(schedule.id) !== timing;
      this.seenTiming.set(schedule.id, timing);
      const local = localParts(nowMs, this.deps.timezone);
      // 每周：只在指定星期发。每天：任意星期。
      if (typeof schedule.weekday === "number" && schedule.weekday !== local.weekday) {
        continue;
      }
      // 「过点即发、每天一次」：本地时刻已到/过 schedule.time，且今天还没发过。
      const due = local.hm >= schedule.time && this.lastFired.get(schedule.id) !== local.date;
      if (!due) continue;

      // 第一次见到这个发送时刻时已经过点（重启后的首个 tick、运行中新建或改了时刻）：标记为
      // 已处理但不真发。否则 15:00 新建一条每天 09:00 的报表，下一个 tick 就会发出一封。
      if (firstSight) {
        this.lastFired.set(schedule.id, local.date);
        continue;
      }
      // 先占位再异步发送：防止同一分钟内下一次 tick 重复触发。
      this.lastFired.set(schedule.id, local.date);
      void this.fire(schedule, nowMs);
    }
  }

  /** Generate + send one schedule's report. Never throws (a bad schedule must not kill the loop). */
  private async fire(schedule: ReportScheduleConfig, nowMs: number): Promise<void> {
    try {
      const recipients = await resolveRecipients(
        { recipients: schedule.recipients, groups: schedule.groups },
        this.deps.getNotifyGroups(),
        this.deps.resolveUserEmail,
      );
      if (recipients.length === 0) {
        logger.warn({ schedule: schedule.id }, "定时报表无收件人，跳过（不发）");
        return;
      }
      const smtpUrl = this.readSmtpUrl(schedule.smtpEnv);
      if (!smtpUrl) {
        logger.warn(
          { schedule: schedule.id, smtpEnv: schedule.smtpEnv },
          "定时报表 SMTP 环境变量未配置，跳过（不发）",
        );
        return;
      }

      const to = new Date(nowMs).toISOString();
      const from = new Date(nowMs - RANGE_HOURS[schedule.range] * 3_600_000).toISOString();
      const [availability, alertStats] = await Promise.all([
        this.deps.aggregateAvailability({ from, to, bucket: "day" }),
        this.deps.aggregateAlertStats({ from, to }),
      ]);

      const content = buildReportEmail({
        scheduleId: schedule.id,
        range: schedule.range,
        generatedAt: to,
        timeZone: this.deps.timezone,
        availability,
        alertStats,
        nameOf: this.deps.nameOf,
      });

      const message: EmailMessage = {
        from: schedule.from,
        to: recipients,
        subject: content.subject,
        text: content.text,
        html: content.html,
        attachments: content.attachments,
      };
      const send = this.deps.sendEmailImpl ?? sendEmail;
      const outcome = await send(smtpUrl, message, {
        maxAttempts: this.deps.maxAttempts,
        timeoutMs: this.deps.timeoutMs,
      });
      if (outcome.ok) {
        logger.info(
          { schedule: schedule.id, recipients: recipients.length, attempts: outcome.attempts },
          "定时报表已发送",
        );
      } else {
        logger.warn(
          { schedule: schedule.id, attempts: outcome.attempts, err: outcome.error },
          "定时报表发送失败",
        );
      }
    } catch (error) {
      logger.warn({ schedule: schedule.id, err: error }, "定时报表生成/发送异常");
    }
  }
}
