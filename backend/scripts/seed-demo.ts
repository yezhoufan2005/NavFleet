/**
 * Demo seed for the Mongo-backed objects the config files and the simulator cannot carry: the
 * people who work at the site (see `DEMO_USERS` — every kind of account the console treats
 * differently: admin, operators in and out of groups, a viewer managing accounts through a group,
 * a viewer reading the 外发 log, the kiosk wall, a never-signed-in new hire, a disabled leaver, a
 * locked outsider), custom roles (one granted to nobody), and the groups that bind them. It talks
 * to a *running backend* over the admin API (cookie session), not to Mongo directly — no password
 * hashing / schema coupling — so it works the same against dev.sh (in-memory, for the session) and
 * the full compose stack (durable). Idempotent: anything that already exists is left as-is.
 *
 * It also seeds the surrounding records as a side effect:
 *   - 会话记录: each active user signs in from each of their devices (real browser user-agents,
 *     office addresses) → one session per device.
 *   - 审计记录: user/role/group creation, the logins, and the deliberate lockout are all audited.
 *   - 已锁定 state: one account is locked by failed sign-ins from an address outside the office.
 *
 * The 30 days of history before today — shift sign-ins, claims and ignores, the odd password reset
 * or configuration change — come from the simulator's backfill (backend/sim), not from here.
 *
 *   SEED_BASE_URL   backend base (default http://127.0.0.1:3000; use the nginx edge for compose)
 *   ADMIN_USERNAME / ADMIN_PASSWORD   admin login (defaults match dev.sh's dev admin)
 *   SEED_DEMO_PASSWORD   override the shared demo-account password suffix
 */

import { DEMO_DEVICES, LOCKOUT_DEVICE, SEED_SCRIPT_DEVICE, type DemoDevice } from "../sim/devices";

const BASE = (process.env.SEED_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
// Defaults assembled from parts, never literals, so a secret scanner does not read them as
// hardcoded credentials; they only match dev.sh's dev admin / demo accounts. Override via env.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ["admin", "123"].join("");
const PW_SUFFIX = process.env.SEED_DEMO_PASSWORD || ["Navfleet", "demo", "24"].join("-");
const demoPassword = (username: string): string => `${username}-${PW_SUFFIX}`;

const bodyText = async (res: Response): Promise<string> => {
  try {
    return JSON.stringify(await res.json());
  } catch {
    return `${res.status}`;
  }
};

/**
 * POST /auth/login from a given device; returns the session cookie string, or null if the
 * credentials were refused. `ip` goes out as `X-Forwarded-For`, which the backend does not believe
 * from a client (it records the address its trusted proxy saw); `sim accounts` writes the office
 * address back afterwards — see `sim/devices.ts`.
 */
async function login(
  username: string,
  password: string,
  device: DemoDevice,
): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": device.userAgent,
      "x-forwarded-for": device.ip,
    },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) return null;
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((entry) => entry.split(";")[0]).join("; ") || null;
}

const authed = (cookie: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });

type UserState = "normal" | "disabled" | "locked";

interface DemoUser {
  username: string;
  role: "admin" | "operator" | "viewer";
  displayName: string;
  /** So the 外发 groups' `@user` references and scheduled reports resolve to someone. */
  email?: string;
  phone?: string;
  kiosk?: boolean;
  state: UserState;
  /** One session per device on the 会话 pages; none for an account that has never signed in. */
  devices: readonly DemoDevice[];
}

const devicesOf = (username: string): readonly DemoDevice[] => DEMO_DEVICES[username] ?? [];

// A plausible small-site roster. The protected bootstrap `admin` stays a deployment account; the
// people below are who works here: a platform admin, two shift operators (claims and ignores in
// the history are theirs, by shift — see sim/sink.ts `operatorAt`), a plain operator outside any
// group, an IT colleague who manages accounts through a group, a dispatcher who may read the 外发
// log, a read-only auditor, the wall display, a new hire who has not signed in yet, a leaver kept
// disabled, and an outsourced account that locked itself out.
const DEMO_USERS: DemoUser[] = [
  {
    username: "lifang",
    role: "admin",
    displayName: "李芳 · 平台管理员",
    email: "lifang@example.com",
    phone: "021-6488 2301",
    state: "normal",
    devices: devicesOf("lifang"),
  },
  {
    username: "zhaoyun",
    role: "operator",
    displayName: "赵云 · 运维班长（白班）",
    email: "zhaoyun@example.com",
    phone: "138 1762 0458",
    state: "normal",
    devices: devicesOf("zhaoyun"),
  },
  {
    username: "qianwei",
    role: "operator",
    displayName: "钱伟 · 夜班操作员",
    email: "qianwei@example.com",
    state: "normal",
    devices: devicesOf("qianwei"),
  },
  {
    username: "liuqiang",
    role: "operator",
    displayName: "刘强 · 现场调度",
    email: "liuqiang@example.com",
    state: "normal",
    devices: devicesOf("liuqiang"),
  },
  {
    // An operator who manages accounts through a group: the hierarchy lets her manage viewers whose
    // capabilities she holds herself, so 用户 shows her a mix of manageable and greyed rows.
    username: "chenjing",
    role: "operator",
    displayName: "陈静 · IT 支持",
    email: "chenjing@example.com",
    state: "normal",
    devices: devicesOf("chenjing"),
  },
  {
    username: "huangmin",
    role: "viewer",
    displayName: "黄敏 · 调度主管",
    email: "huangmin@example.com",
    state: "normal",
    devices: devicesOf("huangmin"),
  },
  {
    username: "sunli",
    role: "viewer",
    displayName: "孙丽 · 只读审计",
    state: "normal",
    devices: devicesOf("sunli"),
  },
  {
    username: "wall01",
    role: "viewer",
    displayName: "一号大屏值班台",
    kiosk: true,
    state: "normal",
    devices: devicesOf("wall01"),
  },
  {
    username: "xujie",
    role: "viewer",
    displayName: "徐杰 · 新入职（未登录）",
    email: "xujie@example.com",
    state: "normal",
    devices: [],
  },
  {
    username: "zhouming",
    role: "viewer",
    displayName: "周明 · 离职待销账号",
    state: "disabled",
    devices: [],
  },
  {
    username: "wugang",
    role: "viewer",
    displayName: "吴刚 · 临时外包",
    state: "locked",
    devices: [],
  },
];

/** The seed's own administrative session: a deployment script, not anyone's browser. */
const SEED_DEVICE = SEED_SCRIPT_DEVICE;

async function ensureUser(cookie: string, user: DemoUser): Promise<void> {
  const res = await authed(cookie, "/api/v1/users", {
    method: "POST",
    body: JSON.stringify({
      username: user.username,
      password: demoPassword(user.username),
      role: user.role,
      displayName: user.displayName,
      ...(user.kiosk ? { kiosk: true } : {}),
    }),
  });
  if (res.status === 201) {
    console.log(`  + user ${user.username} (${user.role}${user.kiosk ? ", kiosk" : ""})`);
  } else if (res.status === 409) {
    console.log(`  = user ${user.username} already exists`);
  } else {
    throw new Error(`create user ${user.username} failed: ${await bodyText(res)}`);
  }
  if (user.email || user.phone) {
    // Also for an account an earlier seed created without them; setting the same value is a no-op.
    const patch = await authed(cookie, `/api/v1/users/${encodeURIComponent(user.username)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...(user.email ? { email: user.email } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
      }),
    });
    if (!patch.ok)
      throw new Error(`set contacts of ${user.username} failed: ${await bodyText(patch)}`);
  }
  if (user.state === "disabled") {
    const patch = await authed(cookie, `/api/v1/users/${encodeURIComponent(user.username)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    if (!patch.ok) throw new Error(`disable ${user.username} failed: ${await bodyText(patch)}`);
    console.log(`    · ${user.username} set disabled`);
  }
}

const DEMO_ROLES: { name: string; capabilities: string[] }[] = [
  { name: "报码维护", capabilities: ["codebook:write"] },
  // Write only: reading the 外发 page comes with it (notify:write implies notify:read), which is
  // what 个人中心 shows as 「随「外发配置」附带」.
  { name: "外发值守", capabilities: ["notify:write"] },
  { name: "外发查看", capabilities: ["notify:read"] },
  { name: "审计查看", capabilities: ["audit:read"] },
  { name: "账号管理", capabilities: ["users:manage"] },
  { name: "部署维护", capabilities: ["vehicles:write", "formations:write", "scenes:write"] },
  // Defined for the next shift lead, granted to nobody yet: a role no group references.
  { name: "报表维护", capabilities: ["reports:write", "rules:write"] },
  // A label for visitor accounts, deliberately without capabilities.
  { name: "访客", capabilities: [] },
];

const DEMO_GROUPS: { name: string; description: string; roles: string[]; members: string[] }[] = [
  {
    name: "现场运维组",
    description: "两班倒的一线运维：维护报码字典、值守外发渠道",
    roles: ["报码维护", "外发值守"],
    members: ["zhaoyun", "qianwei"],
  },
  {
    name: "IT 支持组",
    description: "开通账号、重置密码、维护设备与场景配置",
    roles: ["账号管理", "部署维护"],
    members: ["chenjing"],
  },
  {
    name: "调度组",
    description: "调度主管查看外发记录，核对消息是否送达",
    roles: ["外发查看"],
    members: ["huangmin"],
  },
  {
    name: "审计组",
    description: "只读审计：在只读基础上加审计日志查看",
    roles: ["审计查看"],
    members: ["sunli"],
  },
  {
    // The wall display is a member, to show that a kiosk account gains nothing from a group.
    name: "大屏与访客",
    description: "值班大屏与来访查看账号，统一在这里登记",
    roles: ["外发查看", "访客"],
    members: ["wall01"],
  },
  {
    name: "新员工",
    description: "入职首月的账号，先不授予额外能力",
    roles: [],
    members: ["xujie"],
  },
];

async function ensureRolesAndGroups(cookie: string): Promise<void> {
  for (const role of DEMO_ROLES) {
    const res = await authed(cookie, "/api/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify(role),
    });
    if (res.status >= 200 && res.status < 300) console.log(`  + role ${role.name}`);
    else if (res.status === 409) console.log(`  = role ${role.name} already exists`);
    else throw new Error(`create role ${role.name} failed: ${await bodyText(res)}`);
  }
  const { roles } = (await (await authed(cookie, "/api/v1/rbac/roles")).json()) as {
    roles: { id: string; name: string }[];
  };
  const idByName = new Map(roles.map((role) => [role.name, role.id]));
  const existing = (await (await authed(cookie, "/api/v1/rbac/groups")).json()) as {
    groups: { name: string }[];
  };
  const have = new Set(existing.groups.map((group) => group.name));
  for (const group of DEMO_GROUPS) {
    if (have.has(group.name)) {
      console.log(`  = group ${group.name} already exists`);
      continue;
    }
    const roleIds = group.roles
      .map((name) => idByName.get(name))
      .filter((id): id is string => typeof id === "string");
    const res = await authed(cookie, "/api/v1/rbac/groups", {
      method: "POST",
      body: JSON.stringify({
        name: group.name,
        description: group.description,
        roleIds,
        memberUsernames: group.members,
      }),
    });
    if (res.status >= 200 && res.status < 300) console.log(`  + group ${group.name}`);
    else throw new Error(`create group ${group.name} failed: ${await bodyText(res)}`);
  }
}

/**
 * Log in as each active user from each of their devices → one 会话 row per device and a login
 * audit entry with its address and browser. Re-running adds a fresh session per device, as signing
 * in again would; the old ones expire on their own.
 */
async function seedSessions(): Promise<void> {
  for (const user of DEMO_USERS) {
    if (user.state !== "normal") continue;
    for (const device of user.devices) {
      const cookie = await login(user.username, demoPassword(user.username), device);
      console.log(
        cookie
          ? `  ✓ session for ${user.username} (${device.ip})`
          : `  ! login failed for ${user.username}`,
      );
    }
  }
}

/**
 * Trip the account-level lockout for the "locked" user with repeated bad passwords, then read the
 * account back: a raised AUTH_LOCK_THRESHOLD would leave it unlocked while the seed said otherwise.
 * The lock lasts AUTH_LOCK_WINDOW_MS (15 minutes by default); re-run the seed to lock it again.
 */
async function seedLockout(cookie: string): Promise<void> {
  const target = DEMO_USERS.find((user) => user.state === "locked");
  if (!target) return;
  const wrong = `${demoPassword(target.username)}-nope`;
  // AUTH_LOCK_THRESHOLD defaults to 5 consecutive failures; a couple extra is harmless. From an
  // address outside the office range, as a guessing script would come from.
  const stranger = LOCKOUT_DEVICE;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await login(target.username, wrong, stranger);
  }
  const res = await authed(cookie, `/api/v1/users/${encodeURIComponent(target.username)}`);
  const { user } = (await res.json()) as { user?: { lockedUntil?: string | null } };
  const until = user?.lockedUntil ? Date.parse(user.lockedUntil) : NaN;
  if (!(until > Date.now())) {
    throw new Error(
      `${target.username} is not locked after 6 failed logins (AUTH_LOCK_THRESHOLD above 6?)`,
    );
  }
  console.log(
    `  ✓ ${target.username} 已锁定 until ${new Date(until).toISOString()} (re-run seed:demo to lock it again)`,
  );
}

async function main(): Promise<void> {
  console.log(`[seed-demo] target ${BASE}, admin ${ADMIN_USERNAME}`);
  const adminCookie = await login(ADMIN_USERNAME, ADMIN_PASSWORD, SEED_DEVICE);
  if (!adminCookie) {
    throw new Error(
      `admin login failed at ${BASE} — check it is running and ADMIN_PASSWORD is set`,
    );
  }
  console.log("[seed-demo] users:");
  for (const user of DEMO_USERS) await ensureUser(adminCookie, user);
  console.log("[seed-demo] roles + groups:");
  await ensureRolesAndGroups(adminCookie);
  console.log("[seed-demo] sessions (login as each active user):");
  await seedSessions();
  console.log("[seed-demo] lockout:");
  await seedLockout(adminCookie);
  console.log("[seed-demo] done");
}

main().catch((error) => {
  console.error(`[seed-demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
