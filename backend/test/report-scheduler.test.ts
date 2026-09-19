import { describe, it, expect } from "vitest";
import type { AlertStatsReport, AvailabilityReport, ReportScheduleConfig } from "@navfleet/shared";
import { ReportScheduler, localParts, type ReportSchedulerDeps } from "../src/reports/scheduler";
import type { EmailMessage } from "../src/notify/email";
import type { AttemptOutcome } from "../src/notify/retry";

/**
 * The scheduled-report tick (Phase 17B-2). What matters and what a machine check misses: the
 * "past the local send time, once per day" due-ness, the first-tick catch-up suppression (a
 * restart must not re-send today's report), the weekday gate, and the two silent skips (no
 * recipients, no SMTP env). The clock, SMTP env, send, and aggregation are all injected, so the
 * whole thing runs without a real timer, SMTP server, or Mongo.
 */

const TZ = "Asia/Shanghai";
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** An ms value that reads as `hh:mm` on 2026-09-10 in Asia/Shanghai (UTC+8, no DST). */
const shanghai = (hh: number, mm: number) => Date.UTC(2026, 8, 10, hh - 8, mm);

const emptyAvailability = (): AvailabilityReport => ({
  bucket: "day",
  devices: [],
  available: true,
});
const emptyAlerts = (): AlertStatsReport => ({
  total: 0,
  bySeverity: { critical: 0, warning: 0, notice: 0 },
  topDevices: [],
  daily: [],
  ackRate: null,
  duration: { count: 0, meanMs: null, p50Ms: null },
  available: true,
});

const schedule = (over: Partial<ReportScheduleConfig> = {}): ReportScheduleConfig => ({
  id: "daily",
  enabled: true,
  range: "7d",
  time: "08:00",
  smtpEnv: "SMTP_URL",
  from: "reports@navfleet.local",
  recipients: [{ email: "ops@navfleet.local" }],
  ...over,
});

interface Harness {
  scheduler: ReportScheduler;
  sent: { smtpUrl: string; message: EmailMessage }[];
  now: { ms: number };
}

const makeScheduler = (
  schedules: ReportScheduleConfig[],
  over: Partial<ReportSchedulerDeps> = {},
): Harness => {
  const sent: { smtpUrl: string; message: EmailMessage }[] = [];
  const now = { ms: shanghai(7, 0) };
  const deps: ReportSchedulerDeps = {
    getSchedules: () => schedules,
    getNotifyGroups: () => ({}),
    aggregateAlertStats: () => Promise.resolve(emptyAlerts()),
    aggregateAvailability: () => Promise.resolve(emptyAvailability()),
    resolveUserEmail: () => Promise.resolve(null),
    nameOf: (id) => id,
    readSmtpUrl: (name) => (name === "SMTP_URL" ? "smtp://user:pass@host:25" : undefined),
    timezone: TZ,
    maxAttempts: 1,
    timeoutMs: 1000,
    now: () => now.ms,
    sendEmailImpl: (smtpUrl, message): Promise<AttemptOutcome> => {
      sent.push({ smtpUrl, message });
      return Promise.resolve({
        ok: true,
        httpStatus: null,
        attempts: 1,
        latencyMs: 1,
        error: null,
      });
    },
    ...over,
  };
  return { scheduler: new ReportScheduler(deps), sent, now };
};

describe("localParts", () => {
  it("reads the wall clock in the configured timezone", () => {
    const parts = localParts(shanghai(8, 30), TZ);
    expect(parts.date).toBe("2026-09-10");
    expect(parts.hm).toBe("08:30");
    // 08:30 Shanghai on 2026-09-10 is 00:30 UTC the same date, so the UTC weekday matches.
    expect(parts.weekday).toBe(new Date(Date.UTC(2026, 8, 10)).getUTCDay());
  });
});

describe("ReportScheduler.tick", () => {
  it("fires once when the local time has passed the schedule, then not again that day", async () => {
    const { scheduler, sent, now } = makeScheduler([schedule()]);

    now.ms = shanghai(7, 0); // before 08:00
    scheduler.tick();
    await flush();
    expect(sent).toHaveLength(0);

    now.ms = shanghai(8, 30); // past 08:00, same local day
    scheduler.tick();
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message.to).toEqual(["ops@navfleet.local"]);
    expect(sent[0]!.message.subject).toContain("车队报表");
    expect(sent[0]!.message.html).toContain("NavFleet");
    expect(sent[0]!.message.attachments?.[0]?.filename).toMatch(/\.csv$/);

    scheduler.tick(); // same day, already fired
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("does not catch up on startup — a first tick past the time marks it handled without sending", async () => {
    const { scheduler, sent, now } = makeScheduler([schedule()]);
    now.ms = shanghai(9, 0); // already past 08:00 on the very first tick
    scheduler.tick();
    await flush();
    // A restart after the send time must not re-send today's report.
    expect(sent).toHaveLength(0);
    // And it does not fire later the same day either.
    now.ms = shanghai(23, 0);
    scheduler.tick();
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("only fires on the configured weekday for a weekly schedule", async () => {
    const weekday = localParts(shanghai(8, 30), TZ).weekday;
    const other = makeScheduler([schedule({ weekday: (weekday + 1) % 7 })]);
    other.now.ms = shanghai(7, 0);
    other.scheduler.tick();
    other.now.ms = shanghai(8, 30);
    other.scheduler.tick();
    await flush();
    expect(other.sent).toHaveLength(0); // wrong weekday

    const match = makeScheduler([schedule({ weekday })]);
    match.now.ms = shanghai(7, 0);
    match.scheduler.tick();
    match.now.ms = shanghai(8, 30);
    match.scheduler.tick();
    await flush();
    expect(match.sent).toHaveLength(1);
  });

  it("skips a disabled schedule, one with no recipients, and one with no SMTP env — silently", async () => {
    const disabled = makeScheduler([schedule({ enabled: false })]);
    const noRecipients = makeScheduler([schedule({ recipients: [], groups: [] })]);
    const noSmtp = makeScheduler([schedule({ smtpEnv: "MISSING_ENV" })]);

    for (const h of [disabled, noRecipients, noSmtp]) {
      h.now.ms = shanghai(7, 0);
      h.scheduler.tick();
      h.now.ms = shanghai(8, 30);
      h.scheduler.tick();
      await flush();
      expect(h.sent).toHaveLength(0);
    }
  });
});
