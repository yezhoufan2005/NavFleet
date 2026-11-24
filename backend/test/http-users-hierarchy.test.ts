import { describe, it, expect } from "vitest";
import request from "supertest";
import type { UserRole } from "@navfleet/shared";
import type { AdminUserView } from "../src/types";
import { createTestApp, sessionCookie, type TestAppContext } from "./helpers/testApp";

/**
 * The user-management hierarchy rule. `users:manage` can reach a non-admin through a group, and
 * before this rule its holder could promote itself or anyone else to admin. Now a non-admin acts
 * only on users ranked strictly below it whose capabilities are a subset of its own, assigns only
 * roles below its own, and grants only capabilities it holds. Admins are unaffected.
 */
const ADMIN = sessionCookie("admin", "boss");
const OPS = sessionCookie("operator", "ops");

const view = (username: string, role: UserRole): AdminUserView => ({
  username,
  role,
  enabled: true,
  tokenVersion: 0,
  displayName: username,
  email: null,
  phone: null,
  lastLoginAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  passwordUpdatedAt: "2026-11-01T00:00:00.000Z",
  failedAttempts: 0,
  lockedUntil: null,
  protected: false,
});

/** The directory every case runs against: one of each role, plus the delegated operator `ops`. */
const USERS: Record<string, UserRole> = {
  boss: "admin",
  ops: "operator",
  peer: "operator",
  vic: "viewer",
  aud: "viewer",
};

const createRole = async (ctx: TestAppContext, name: string, capabilities: string[]) => {
  const response = await request(ctx.app)
    .post("/api/rbac/roles")
    .set("Cookie", ADMIN)
    .send({ name, capabilities });
  return (response.body as { role: { id: string } }).role.id;
};

const createGroup = (ctx: TestAppContext, name: string, roleIds: string[], members: string[]) =>
  request(ctx.app)
    .post("/api/rbac/groups")
    .set("Cookie", ADMIN)
    .send({ name, roleIds, memberUsernames: members });

/** `ops` (an operator) holds `users:manage` through a group; `aud` (a viewer) holds `audit:read`. */
const setup = async (): Promise<TestAppContext> => {
  const ctx = createTestApp();
  ctx.authService.getUser.mockImplementation((username: string) =>
    Promise.resolve(USERS[username] ? view(username, USERS[username]) : null),
  );
  ctx.authService.listUsers.mockImplementation(() =>
    Promise.resolve(Object.entries(USERS).map(([username, role]) => view(username, role))),
  );
  const managers = await createRole(ctx, "Managers", ["users:manage"]);
  await createGroup(ctx, "Delegated", [managers], ["ops"]);
  const auditors = await createRole(ctx, "Auditors", ["audit:read"]);
  await createGroup(ctx, "Audit", [auditors], ["aud"]);
  return ctx;
};

const resetPassword = (ctx: TestAppContext, cookie: string, username: string) =>
  request(ctx.app)
    .post(`/api/users/${username}/reset-password`)
    .set("Cookie", cookie)
    .send({ newPassword: "Passw0rd123" });

describe("user hierarchy — acting on users", () => {
  it("lets a delegated operator act on a viewer below it", async () => {
    const ctx = await setup();
    expect((await resetPassword(ctx, OPS, "vic")).status).toBe(204);
    expect(ctx.authService.resetPassword).toHaveBeenCalledWith("ops", "vic", "Passw0rd123");
  });

  it.each(["peer", "boss", "ops"])(
    "refuses %s (same rank, higher rank, or itself)",
    async (who) => {
      const ctx = await setup();
      const response = await resetPassword(ctx, OPS, who);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "rank_forbidden" });
      expect(ctx.authService.resetPassword).not.toHaveBeenCalled();
    },
  );

  it("refuses a lower-ranked user who holds a capability the actor lacks", async () => {
    const ctx = await setup();
    expect((await resetPassword(ctx, OPS, "aud")).status).toBe(403);
  });

  it("guards edit, delete and force-logout the same way", async () => {
    const ctx = await setup();
    const patch = await request(ctx.app)
      .patch("/api/users/peer")
      .set("Cookie", OPS)
      .send({ enabled: false });
    const del = await request(ctx.app).delete("/api/users/boss").set("Cookie", OPS);
    const logout = await request(ctx.app).post("/api/users/peer/logout").set("Cookie", OPS);
    expect([patch.status, del.status, logout.status]).toEqual([403, 403, 403]);
    expect(ctx.authService.updateUser).not.toHaveBeenCalled();
    expect(ctx.authService.deleteUser).not.toHaveBeenCalled();
    expect(ctx.authService.forceLogout).not.toHaveBeenCalled();
  });

  it("does not let a delegated operator promote a viewer to its own rank", async () => {
    const ctx = await setup();
    const response = await request(ctx.app)
      .patch("/api/users/vic")
      .set("Cookie", OPS)
      .send({ role: "operator" });
    expect(response.status).toBe(403);
    const ok = await request(ctx.app)
      .patch("/api/users/vic")
      .set("Cookie", OPS)
      .send({ role: "viewer", displayName: "Vic" });
    expect(ok.status).toBe(200);
  });

  it("creates only roles below the actor's own", async () => {
    const ctx = await setup();
    const create = (role: UserRole) =>
      request(ctx.app)
        .post("/api/users")
        .set("Cookie", OPS)
        .send({ username: `new-${role}`, password: "Passw0rd123", role });
    expect((await create("admin")).status).toBe(403);
    expect((await create("operator")).status).toBe(403);
    expect((await create("viewer")).status).toBe(201);
  });

  it("marks each listed user with whether the caller may manage it", async () => {
    const ctx = await setup();
    const list = async (cookie: string) => {
      const response = await request(ctx.app).get("/api/users").set("Cookie", cookie);
      const users = (response.body as { users: Array<{ username: string; manageable: boolean }> })
        .users;
      return Object.fromEntries(users.map((user) => [user.username, user.manageable]));
    };
    expect(await list(OPS)).toEqual({
      boss: false,
      ops: false,
      peer: false,
      vic: true,
      aud: false,
    });
    expect(Object.values(await list(ADMIN)).every(Boolean)).toBe(true);
  });

  it("leaves an admin unrestricted", async () => {
    const ctx = await setup();
    expect((await resetPassword(ctx, ADMIN, "peer")).status).toBe(204);
  });
});

describe("user hierarchy — roles and groups", () => {
  it("grants only capabilities the actor holds", async () => {
    const ctx = await setup();
    const create = (capabilities: string[]) =>
      request(ctx.app)
        .post("/api/rbac/roles")
        .set("Cookie", OPS)
        .send({ name: capabilities.join("+"), capabilities });
    expect((await create(["audit:read"])).status).toBe(403);
    expect((await create(["alerts:ack", "users:manage"])).status).toBe(201);
  });

  it("refuses a group that would raise the actor itself or someone it cannot manage", async () => {
    const ctx = await setup();
    const ackers = (
      (
        await request(ctx.app)
          .post("/api/rbac/roles")
          .set("Cookie", OPS)
          .send({ name: "Ackers", capabilities: ["alerts:ack"] })
      ).body as { role: { id: string } }
    ).role.id;
    const group = (members: string[]) =>
      request(ctx.app)
        .post("/api/rbac/groups")
        .set("Cookie", OPS)
        .send({ name: members.join("+"), roleIds: [ackers], memberUsernames: members });
    expect((await group(["ops"])).status).toBe(403);
    expect((await group(["peer"])).status).toBe(403);
    expect((await group(["vic"])).status).toBe(201);
  });

  it("refuses editing a role that groups above the actor rely on", async () => {
    const ctx = await setup();
    const roles = await request(ctx.app).get("/api/rbac/roles").set("Cookie", OPS);
    const managers = (roles.body as { roles: Array<{ id: string; name: string }> }).roles.find(
      (role) => role.name === "Managers",
    )!;
    const response = await request(ctx.app)
      .patch(`/api/rbac/roles/${managers.id}`)
      .set("Cookie", OPS)
      .send({ name: "Managers", capabilities: [] });
    expect(response.status).toBe(403);
  });
});
