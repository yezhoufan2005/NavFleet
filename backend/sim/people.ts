/**
 * The people side of the history: who signed in, from where, and what they changed — the audit
 * trail a site accumulates around its fleet, over the same window the backfill generates.
 *
 * Deterministic per local day (a hash of the date picks what happens that day), so a catch-up that
 * resumes over a window already written produces the same entries — and only entries inside the
 * window it is asked for, so no day is written twice.
 *
 * What a month at the site holds:
 * - every working day both shift operators sign in at shift change, from their workstations
 *   (and sometimes their phones), and sign out at the end of it;
 * - the admin signs in most weekdays; the supervisor, the auditor and IT now and then;
 * - configuration is maintained: the codebook, rules, the outbound channels, report schedules,
 *   scenes (and an uploaded floor plan), vehicles and formations — a handful of writes a week;
 * - accounts are kept: a role or group adjusted, a password reset for someone who forgot it, a
 *   session ended on a lost phone, a temporary account created and removed;
 * - the odd password change, a 个人中心 contact edit, and a failed sign-in from a typo; once in the
 *   month a guessing script from outside the office trips the lockout on the contractor account.
 *
 * Claims, releases and ignores of messages are written with the messages (`sink.ts`), at the
 * moment they happen.
 */
import { MongoClient } from "mongodb";
import { config } from "../src/config";
import { Rng, seedOf } from "./rng";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Midnight on the site's clock (UTC+8) of the day containing `ms`. */
const localMidnight = (ms: number): number => Math.floor((ms + 8 * HOUR) / DAY) * DAY - 8 * HOUR;

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
};

/** Each person's usual devices: [user-agent, office address]. The first is their workstation. */
const DEVICES: Record<string, Array<[string, string]>> = {
  lifang: [
    [UA.chromeMac, "10.20.1.15"],
    [UA.safariIpad, "10.20.9.41"],
  ],
  zhaoyun: [
    [UA.edgeWindows, "10.20.3.21"],
    [UA.chromeAndroid, "10.20.9.77"],
  ],
  qianwei: [[UA.firefoxLinux, "10.20.3.22"]],
  liuqiang: [[UA.chromeAndroid, "10.20.9.103"]],
  chenjing: [[UA.edgeWindows, "10.20.5.8"]],
  huangmin: [[UA.safariMac, "10.20.1.33"]],
  sunli: [[UA.chromeMac, "10.20.1.52"]],
};

export interface AuditEntryDoc {
  ts: Date;
  actor: string;
  action: string;
  outcome: "success" | "failure";
  target?: string;
  detail?: Record<string, unknown>;
}

type Entry = AuditEntryDoc;
const ok = (
  ts: Date,
  actor: string,
  action: string,
  extra: Partial<AuditEntryDoc> = {},
): Entry => ({ ts, actor, action, outcome: "success", ...extra });
const later = (ts: Date, minutes: number): Date => new Date(ts.getTime() + minutes * 60_000);

/** The admin's and IT's maintenance work, one task a working day (see `dayOf`). */
const MAINTENANCE: ReadonlyArray<(at: Date) => Entry[]> = [
  (at) => [
    ok(at, "lifang", "rules_write", {
      detail: { lowBatteryThreshold: 20, offlineAfterSeconds: 90 },
    }),
  ],
  (at) => [ok(at, "lifang", "notify_write", { detail: { channelCount: 7 } })],
  (at) => [ok(at, "zhaoyun", "codebook_import", { detail: { entryCount: 5 } })],
  (at) => [ok(at, "lifang", "reports_write", { detail: { scheduleCount: 4 } })],
  (at) => [ok(at, "chenjing", "vehicles_write", { detail: { vehicleCount: 32 } })],
  (at) => [ok(at, "chenjing", "formations_write", { detail: { formationCount: 8 } })],
  (at) => [
    ok(at, "chenjing", "scene_asset_upload", {
      target: "cold-store",
      detail: { kind: "image", bytes: 6624, url: "/scene-maps/cold-store/cold-store.png" },
    }),
    ok(later(at, 1.5), "chenjing", "scenes_write", { detail: { sceneCount: 9 } }),
  ],
  (at) => [ok(at, "chenjing", "password_reset", { target: "liuqiang" })],
  (at) => [
    ok(at, "lifang", "role_update", {
      target: "role-report-maint",
      detail: { name: "报表维护", renamedFrom: "报表管理", added: ["rules:write"], removed: [] },
    }),
  ],
  (at) => [
    ok(at, "lifang", "role_update", {
      target: "role-deploy",
      detail: { name: "部署维护", added: ["scenes:write"], removed: ["codebook:write"] },
    }),
  ],
  // The field dispatcher takes on message handling: viewer → operator.
  (at) => [
    ok(at, "chenjing", "user_update", {
      target: "liuqiang",
      detail: { fields: ["role"], changes: { role: { from: "viewer", to: "operator" } } },
    }),
  ],
  (at) => [
    ok(at, "lifang", "group_update", {
      target: "group-dispatch",
      detail: {
        name: "调度组",
        renamedFrom: "调度员组",
        rolesAdded: ["外发查看"],
        rolesRemoved: [],
        membersAdded: ["huangmin"],
        membersRemoved: ["liuqiang"],
      },
    }),
  ],
  // A lost phone: the admin ends the session on it.
  (at) => [ok(at, "lifang", "session_revoke", { target: "zhaoyun:lost-phone" })],
  (at) => [
    ok(at, "chenjing", "user_update", {
      target: "huangmin",
      detail: {
        fields: ["displayName", "email"],
        changes: { displayName: { from: "黄敏", to: "黄敏 · 调度主管" } },
      },
    }),
  ],
  // The leaver's account still had a session open on the day it was disabled.
  (at) => [ok(at, "lifang", "force_logout", { target: "zhouming" })],
];

/** Everything that happened on the local day starting at `midnight`. */
const dayOf = (midnight: number): AuditEntryDoc[] => {
  const rng = new Rng(seedOf(`people:${new Date(midnight).toISOString().slice(0, 10)}`));
  const weekday = new Date(midnight + 8 * HOUR).getUTCDay();
  /** Days since the epoch on the site's clock: what spaces the monthly events 30 days apart. */
  const dayNumber = Math.round((midnight + 8 * HOUR) / DAY);
  const workday = weekday >= 1 && weekday <= 5;
  const entries: AuditEntryDoc[] = [];
  const at = (hour: number, spreadMinutes = 20): Date =>
    new Date(midnight + hour * HOUR + Math.round(rng.between(0, spreadMinutes)) * 60_000);
  const device = (who: string, index = 0) => {
    const [userAgent, ip] = DEVICES[who]![Math.min(index, DEVICES[who]!.length - 1)]!;
    return { userAgent, ip };
  };
  const signIn = (who: string, when: Date, index = 0) =>
    entries.push({
      ts: when,
      actor: who,
      action: "login",
      outcome: "success",
      detail: device(who, index),
    });
  const write = (actor: string, action: string, when: Date, extra: Partial<AuditEntryDoc> = {}) =>
    entries.push({ ts: when, actor, action, outcome: "success", ...extra });

  // Shift change: the day operator from 07:50, the night operator from 19:50 (round the clock).
  signIn("zhaoyun", at(7.83, 15), rng.chance(0.15) ? 1 : 0);
  write("zhaoyun", "logout", at(20.1, 25));
  signIn("qianwei", at(19.83, 15));
  write("qianwei", "logout", at(8.05, 20));
  // Weekdays: the admin, the supervisor, and now and then the auditor and IT.
  if (workday) {
    signIn("lifang", at(8.75, 40), rng.chance(0.2) ? 1 : 0);
    if (rng.chance(0.6)) signIn("huangmin", at(9.5, 90));
    if (rng.chance(0.3)) signIn("sunli", at(14, 120));
    if (rng.chance(0.35)) signIn("chenjing", at(10, 180));
    if (rng.chance(0.4)) signIn("liuqiang", at(8.5, 300));
  }
  // A typo at the shift change, corrected at once.
  if (rng.chance(0.25)) {
    const who = rng.chance(0.5) ? "zhaoyun" : "qianwei";
    const when = at(who === "zhaoyun" ? 7.8 : 19.8, 5);
    entries.push({
      ts: when,
      actor: who,
      action: "login_failed",
      outcome: "failure",
      detail: device(who),
    });
  }

  // Configuration and accounts on weekdays: one maintenance task most working days, taken in turn
  // from the list below (offset by a hash of the date), so a month sees every kind of change.
  if (workday) {
    // Counted in working days (1970-01-05 was a Monday), so the list runs through without gaps:
    // any 30-day window holds 20 or more working days, enough for every task.
    const workdayNumber = Math.floor((dayNumber - 4) / 7) * 5 + (weekday - 1);
    const task = MAINTENANCE[workdayNumber % MAINTENANCE.length]!;
    for (const entry of task(at(10.5, 300))) entries.push(entry);
  }
  // Someone's own account, now and then — any day.
  const own = rng.next();
  const ownAt = at(11, 480);
  if (own < 0.05) {
    write(rng.pick(["zhaoyun", "qianwei", "huangmin"]) ?? "zhaoyun", "password_change", ownAt);
  } else if (own < 0.1) {
    const who = rng.pick(["zhaoyun", "liuqiang", "huangmin"]) ?? "zhaoyun";
    write(who, "profile_update", ownAt, {
      target: who,
      detail: { fields: ["phone"], changes: {} },
    });
  } else if (own < 0.13) {
    // 下线其他设备 from 个人中心.
    write("zhaoyun", "session_revoke", ownAt, { detail: { others: 1 } });
  } else if (own < 0.16) {
    // One device signed out from 个人中心 (the session's own id).
    const id = `${new Date(midnight).toISOString().slice(0, 10).replaceAll("-", "")}a7`;
    write("qianwei", "session_revoke", ownAt, { target: id });
  }

  // Once a month: a temporary account for a commissioning engineer, removed a few days later.
  if (dayNumber % 30 === 4) {
    const name = `temp-${new Date(midnight + 8 * HOUR).toISOString().slice(5, 10).replace("-", "")}`;
    write("chenjing", "user_create", at(9.5, 60), { target: name, detail: { role: "viewer" } });
    write("chenjing", "user_delete", new Date(midnight + 3 * DAY + 10 * HOUR), { target: name });
  }
  // Once a month: a role and group set up for a vendor's visit and taken down again.
  if (dayNumber % 30 === 11) {
    write("lifang", "role_create", at(15, 60), {
      target: "role-trial",
      detail: { name: "试用查看", capabilities: ["notify:read"] },
    });
    write("lifang", "group_create", at(15.2, 30), {
      target: "group-trial",
      detail: { name: "厂商驻场", roles: ["试用查看"], members: [] },
    });
    write("lifang", "group_delete", new Date(midnight + 2 * DAY + 16 * HOUR), {
      target: "group-trial",
      detail: { name: "厂商驻场" },
    });
    write("lifang", "role_delete", new Date(midnight + 2 * DAY + 16.1 * HOUR), {
      target: "role-trial",
      detail: { name: "试用查看" },
    });
  }
  // Once a month: a guessing script from outside the office against the contractor account.
  if (dayNumber % 30 === 19) {
    const start = midnight + 2.5 * HOUR;
    const stranger = { userAgent: "python-requests/2.32.3", ip: "172.31.44.19" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      entries.push({
        ts: new Date(start + attempt * 4000),
        actor: "wugang",
        action: "login_failed",
        outcome: "failure",
        detail: stranger,
      });
    }
    entries.push({
      ts: new Date(start + 16_500),
      actor: "wugang",
      action: "account_locked",
      outcome: "failure",
      detail: stranger,
    });
  }
  return entries;
};

/** The audit entries for `[from, to)`, in time order. */
export const peopleActivity = (from: number, to: number): AuditEntryDoc[] => {
  const entries: AuditEntryDoc[] = [];
  // From the day before `from`: a delayed entry (a deletion days after a creation) may fall inside.
  for (let midnight = localMidnight(from) - 3 * DAY; midnight < to; midnight += DAY) {
    for (const entry of dayOf(midnight)) {
      const ms = entry.ts.getTime();
      if (ms >= from && ms < to) entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.ts.getTime() - b.ts.getTime());
};

/** Write `[from, to)`'s people activity to the audit trail; returns how many entries. */
export const writePeopleActivity = async (from: number, to: number): Promise<number> => {
  const entries = peopleActivity(from, to);
  if (!entries.length) return 0;
  const client = await MongoClient.connect(config.mongoUri);
  try {
    await client.db(config.mongoDbName).collection("audit_log").insertMany(entries);
  } finally {
    await client.close();
  }
  return entries.length;
};
