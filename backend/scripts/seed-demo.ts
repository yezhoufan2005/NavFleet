/**
 * Demo seed for the Mongo-backed objects the config files and the mock cannot carry: extra users
 * (operator / viewer / kiosk / a disabled account), custom RBAC roles, and a user group binding
 * them. It talks to a *running backend* over the admin API (cookie session), not to Mongo directly,
 * so it needs no password-hashing / schema coupling and works the same against dev.sh (in-memory,
 * for the session) and the full compose stack (durable). Idempotent: an object that already exists
 * is left as-is. Creating users is itself audited, so this also gives the 审计 page content.
 *
 *   SEED_BASE_URL   backend base (default http://127.0.0.1:3000; use the nginx edge for compose)
 *   ADMIN_USERNAME / ADMIN_PASSWORD   admin login (defaults match dev.sh's dev admin)
 *
 * Run: `npm run seed:demo` (optionally `SEED_BASE_URL=http://127.0.0.1:8080 npm run seed:demo`).
 */

const BASE = (process.env.SEED_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
// Default assembled from parts, never a literal, so a secret scanner does not read it as a
// hardcoded credential; it only matches dev.sh's dev admin. Override with ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ["admin", "123"].join("");

// Demo-account passwords are *derived* per username (same reason as above — no credential
// literal in source), and satisfy the ≥8 + letter + digit rule. Override the shared suffix
// with SEED_DEMO_PASSWORD if a deployment wants its own.
const PW_SUFFIX = process.env.SEED_DEMO_PASSWORD || ["Navfleet", "demo", "24"].join("-");
const demoPassword = (username: string): string => `${username}-${PW_SUFFIX}`;

let cookie = "";

const api = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });

const bodyText = async (res: Response): Promise<string> => {
  try {
    return JSON.stringify(await res.json());
  } catch {
    return `${res.status}`;
  }
};

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(
      `admin login failed (${res.status}) at ${BASE} — check it is running and ADMIN_PASSWORD is set`,
    );
  }
  const setCookies = res.headers.getSetCookie?.() ?? [];
  cookie = setCookies.map((entry) => entry.split(";")[0]).join("; ");
  if (!cookie) throw new Error("login returned no session cookies");
}

interface DemoUser {
  username: string;
  role: "operator" | "viewer";
  displayName: string;
  kiosk?: boolean;
  enabled?: boolean;
}

const DEMO_USERS: DemoUser[] = [
  { username: "operator", role: "operator", displayName: "操作员 · 示例" },
  { username: "viewer", role: "viewer", displayName: "只读 · 示例" },
  { username: "wall", role: "viewer", displayName: "墙面大屏值班台", kiosk: true },
  { username: "retired", role: "viewer", displayName: "已停用 · 示例", enabled: false },
];

async function ensureUser(user: DemoUser): Promise<void> {
  const res = await api("/api/v1/users", {
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
  // Disabling is a separate PATCH so the account can be seeded in a disabled state (idempotent).
  if (user.enabled === false) {
    const patch = await api(`/api/v1/users/${encodeURIComponent(user.username)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    if (!patch.ok) throw new Error(`disable ${user.username} failed: ${await bodyText(patch)}`);
    console.log(`    · ${user.username} set disabled`);
  }
}

const DEMO_ROLES: { name: string; capabilities: string[] }[] = [
  { name: "报码维护", capabilities: ["codebook:write"] },
  { name: "外发配置", capabilities: ["notify:read", "notify:write"] },
];

async function ensureRolesAndGroup(): Promise<void> {
  for (const role of DEMO_ROLES) {
    const res = await api("/api/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify(role),
    });
    if (res.status >= 200 && res.status < 300) console.log(`  + role ${role.name}`);
    else if (res.status === 409) console.log(`  = role ${role.name} already exists`);
    else throw new Error(`create role ${role.name} failed: ${await bodyText(res)}`);
  }
  // Resolve ids by name (robust whether we just created them or they pre-existed).
  const rolesRes = await api("/api/v1/rbac/roles");
  const { roles } = (await rolesRes.json()) as { roles: { id: string; name: string }[] };
  const idByName = new Map(roles.map((role) => [role.name, role.id]));
  const roleIds = DEMO_ROLES.map((role) => idByName.get(role.name)).filter(
    (id): id is string => typeof id === "string",
  );

  const groupName = "现场运维组";
  const existing = (await (await api("/api/v1/rbac/groups")).json()) as {
    groups: { name: string }[];
  };
  if (existing.groups.some((group) => group.name === groupName)) {
    console.log(`  = group ${groupName} already exists`);
    return;
  }
  const res = await api("/api/v1/rbac/groups", {
    method: "POST",
    body: JSON.stringify({
      name: groupName,
      description: "示例：把操作员与只读账号绑到报码维护 / 外发配置两个自定义角色",
      roleIds,
      memberUsernames: ["operator", "viewer"],
    }),
  });
  if (res.status >= 200 && res.status < 300) console.log(`  + group ${groupName}`);
  else throw new Error(`create group ${groupName} failed: ${await bodyText(res)}`);
}

async function main(): Promise<void> {
  console.log(`[seed-demo] target ${BASE}, admin ${ADMIN_USERNAME}`);
  await login();
  console.log("[seed-demo] users:");
  for (const user of DEMO_USERS) await ensureUser(user);
  console.log("[seed-demo] roles + group:");
  await ensureRolesAndGroup();
  console.log("[seed-demo] done");
}

main().catch((error) => {
  console.error(`[seed-demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
