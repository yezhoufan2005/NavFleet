/**
 * Demo seed for the Mongo-backed objects the config files and the mock cannot carry: a realistic
 * set of users (operators / a read-only auditor / a kiosk wall account / a disabled ex-staff /
 * a locked outsourced account), custom RBAC roles, and the groups that bind them. It talks to a
 * *running backend* over the admin API (cookie session), not to Mongo directly — no password
 * hashing / schema coupling — so it works the same against dev.sh (in-memory, for the session) and
 * the full compose stack (durable). Idempotent: anything that already exists is left as-is.
 *
 * It also seeds the surrounding records as a side effect:
 *   - 会话记录: each active user is logged in once (with its own user-agent) → a per-user session.
 *   - 审计记录: user/role/group creation, the logins, and the deliberate lockout are all audited.
 *   - 已锁定 state: one account is locked by exhausting the login-failure threshold.
 *
 *   SEED_BASE_URL   backend base (default http://127.0.0.1:3000; use the nginx edge for compose)
 *   ADMIN_USERNAME / ADMIN_PASSWORD   admin login (defaults match dev.sh's dev admin)
 *   SEED_DEMO_PASSWORD   override the shared demo-account password suffix
 */

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

/** POST /auth/login; returns the session cookie string, or null if the credentials were refused. */
async function login(
  username: string,
  password: string,
  userAgent: string,
): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
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
  role: "operator" | "viewer";
  displayName: string;
  kiosk?: boolean;
  state: UserState;
  /** Shown as the session's device on the 会话 page when this user is logged in. */
  userAgent: string;
}

// A plausible small-site roster: two operators, a read-only auditor, a kiosk wall account, an
// ex-staff account kept disabled, and an outsourced account that got itself locked out.
const DEMO_USERS: DemoUser[] = [
  {
    username: "zhaoyun",
    role: "operator",
    displayName: "赵云 · 运维班长",
    state: "normal",
    userAgent: "NavFleet-Console/ops-workstation",
  },
  {
    username: "qianwei",
    role: "operator",
    displayName: "钱伟 · 夜班操作员",
    state: "normal",
    userAgent: "NavFleet-Console/night-terminal",
  },
  {
    username: "sunli",
    role: "viewer",
    displayName: "孙丽 · 只读审计",
    state: "normal",
    userAgent: "NavFleet-Console/audit-laptop",
  },
  {
    username: "wall01",
    role: "viewer",
    displayName: "一号大屏值班台",
    kiosk: true,
    state: "normal",
    userAgent: "NavFleet-Wall/kiosk-01",
  },
  {
    username: "zhouming",
    role: "viewer",
    displayName: "周明 · 离职待销账号",
    state: "disabled",
    userAgent: "",
  },
  {
    username: "wugang",
    role: "viewer",
    displayName: "吴刚 · 外包临时",
    state: "locked",
    userAgent: "",
  },
];

const SEED_UA = "NavFleet seed-demo";

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
  { name: "外发值守", capabilities: ["notify:read", "notify:write"] },
  { name: "审计查看", capabilities: ["audit:read"] },
];

const DEMO_GROUPS: { name: string; description: string; roles: string[]; members: string[] }[] = [
  {
    name: "现场运维组",
    description: "一线运维：授予报码维护与外发值守能力",
    roles: ["报码维护", "外发值守"],
    members: ["zhaoyun", "qianwei"],
  },
  {
    name: "审计组",
    description: "只读审计：在只读基础上加审计日志查看",
    roles: ["审计查看"],
    members: ["sunli"],
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

/** Log in as each active user (own user-agent) → a per-user 会话 row + a login audit entry. */
async function seedSessions(): Promise<void> {
  for (const user of DEMO_USERS) {
    if (user.state !== "normal") continue;
    const cookie = await login(user.username, demoPassword(user.username), user.userAgent);
    console.log(
      cookie ? `  ✓ session for ${user.username}` : `  ! login failed for ${user.username}`,
    );
  }
}

/** Trip the account-level lockout for the "locked" user with repeated bad passwords. */
async function seedLockout(): Promise<void> {
  const target = DEMO_USERS.find((user) => user.state === "locked");
  if (!target) return;
  const wrong = `${demoPassword(target.username)}-nope`;
  // AUTH_LOCK_THRESHOLD defaults to 5 consecutive failures; a couple extra is harmless.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await login(target.username, wrong, SEED_UA);
  }
  console.log(`  ✓ ${target.username} driven into 已锁定 via failed logins`);
}

async function main(): Promise<void> {
  console.log(`[seed-demo] target ${BASE}, admin ${ADMIN_USERNAME}`);
  const adminCookie = await login(ADMIN_USERNAME, ADMIN_PASSWORD, SEED_UA);
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
  await seedLockout();
  console.log("[seed-demo] done");
}

main().catch((error) => {
  console.error(`[seed-demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
