/**
 * The accounts' own dates — 创建于, 最近登录, 密码更新, 会话 — made consistent with the history.
 *
 * `seed:demo` creates the accounts through the admin API, so they are all "created now", "password
 * set now"; but the history the catch-up generated has them signing in, resetting and claiming for
 * a month before that. This aligns the stored dates with that story, as a site's would be: each
 * account created when it joined (most well before the history, the new hire last week), the
 * password set when it was last changed or reset in the trail, the last sign-in its latest one, and
 * a few older sessions from the devices people actually use — not only the ones the seed just
 * opened.
 *
 *   sim accounts      run after `seed:demo` (verify-stack and dev.sh --demo do)
 *
 * Writes only dates and sessions of the demo accounts it knows; leaves the bootstrap admin, every
 * other account and every credential alone. Idempotent.
 */
import { MongoClient } from "mongodb";
import { config } from "../src/config";
import { readStory } from "./people";

const DAY = 86_400_000;

/** When each account joined, in days before the story's anchor (negative: after it). */
const JOINED_DAYS_BEFORE: Record<string, number> = {
  lifang: 420,
  zhaoyun: 380,
  qianwei: 365,
  sunli: 300,
  huangmin: 240,
  chenjing: 210,
  liuqiang: 150,
  wall01: 360,
  zhouming: 260,
  wugang: 45,
  // The new hire joined a few days before today, inside the history.
  xujie: -25,
};

/** Password last set, in days before the anchor, for accounts whose trail does not reset it. */
const PASSWORD_DAYS_BEFORE: Record<string, number> = {
  lifang: 62,
  zhaoyun: 88,
  sunli: 140,
  huangmin: 33,
  chenjing: 75,
  wall01: 360,
  zhouming: 260,
  wugang: 45,
};

/** Older sessions people still have open, on devices the seed did not sign in from. */
const OLD_SESSIONS: ReadonlyArray<{
  username: string;
  sessionId: string;
  userAgent: string;
  ip: string;
  daysAgo: number;
  seenHoursAgo: number;
}> = [
  {
    username: "lifang",
    sessionId: "demo-lifang-home",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    ip: "10.20.250.14",
    daysAgo: 4,
    seenHoursAgo: 30,
  },
  {
    username: "zhaoyun",
    sessionId: "demo-zhaoyun-pad",
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    ip: "10.20.9.64",
    daysAgo: 6,
    seenHoursAgo: 52,
  },
  {
    // A client the console cannot name: its raw user-agent shows.
    username: "huangmin",
    sessionId: "demo-huangmin-wecom",
    userAgent: "WeCom/4.1.30 (iPhone; iOS 18.1; Scale/3.00)",
    ip: "10.20.9.130",
    daysAgo: 2,
    seenHoursAgo: 5,
  },
  {
    // A session from a script with no user-agent at all (未知设备).
    username: "chenjing",
    sessionId: "demo-chenjing-script",
    userAgent: "",
    ip: "10.20.5.8",
    daysAgo: 1,
    seenHoursAgo: 20,
  },
];

export const alignAccounts = async (stateDir: string): Promise<string[]> => {
  const story = readStory(stateDir);
  const now = Date.now();
  const anchor = story?.anchor ?? now - 30 * DAY;
  const client = await MongoClient.connect(config.mongoUri);
  const done: string[] = [];
  try {
    const db = client.db(config.mongoDbName);
    const users = db.collection<{ username: string; lastLoginAt?: string | null }>("users");
    const audit = db.collection<{ ts: Date; actor: string; action: string; target?: string }>(
      "audit_log",
    );
    for (const [username, joinedBefore] of Object.entries(JOINED_DAYS_BEFORE)) {
      const user = await users.findOne({ username });
      if (!user) continue;
      // The latest sign-in, and the latest password change or reset, the trail holds for them.
      const lastLogin = await audit
        .find({ actor: username, action: "login" })
        .sort({ ts: -1 })
        .limit(1)
        .next();
      const lastPassword = await audit
        .find({
          $or: [
            { actor: username, action: "password_change" },
            { target: username, action: "password_reset" },
          ],
        })
        .sort({ ts: -1 })
        .limit(1)
        .next();
      const createdAt = new Date(anchor - joinedBefore * DAY);
      const passwordAt =
        lastPassword?.ts ??
        new Date(
          Math.max(
            createdAt.getTime(),
            anchor - (PASSWORD_DAYS_BEFORE[username] ?? joinedBefore) * DAY,
          ),
        );
      const set: Record<string, string> = {
        createdAt: createdAt.toISOString(),
        passwordUpdatedAt: passwordAt.toISOString(),
      };
      // An account the seed signs in keeps the seed's sign-in (it is the latest); one it does not —
      // the leaver, the locked contractor, the new hire — is dated from the trail or left unset.
      if (lastLogin && username !== "xujie") {
        const stored = user.lastLoginAt;
        if (!stored || Date.parse(stored) < lastLogin.ts.getTime()) {
          set.lastLoginAt = lastLogin.ts.toISOString();
        }
      }
      await users.updateOne({ username }, { $set: set });
      done.push(username);
    }
    const sessions = db.collection("sessions");
    for (const session of OLD_SESSIONS) {
      if (!(await users.findOne({ username: session.username }))) continue;
      const createdAt = new Date(now - session.daysAgo * DAY);
      await sessions.updateOne(
        { sessionId: session.sessionId },
        {
          $set: {
            sessionId: session.sessionId,
            username: session.username,
            userAgent: session.userAgent,
            ip: session.ip,
            createdAt: createdAt.toISOString(),
            lastSeenAt: new Date(now - session.seenHoursAgo * 3_600_000).toISOString(),
            // Within the refresh horizon, so the session reads as live until it lapses on its own.
            expiresAt: new Date(now + 6 * DAY),
          },
        },
        { upsert: true },
      );
    }
  } finally {
    await client.close();
  }
  return done;
};
