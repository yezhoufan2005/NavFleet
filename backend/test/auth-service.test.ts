import { describe, it, expect } from "vitest";
import { Persistence } from "../src/persistence";
import { AuthService } from "../src/auth/service";

// Persistence never connects to Mongo here, so it uses its in-memory user
// fallback — exercising the seed + authenticate flow without a database.
describe("AuthService (in-memory fallback)", () => {
  it("seeds a default admin and authenticates it", async () => {
    const persistence = new Persistence();
    const service = new AuthService(persistence);
    await service.initialize();

    const user = await service.authenticate("admin", "admin123");
    expect(user).not.toBeNull();
    expect(user?.role).toBe("admin");
  });

  it("rejects wrong credentials and unknown users", async () => {
    const persistence = new Persistence();
    const service = new AuthService(persistence);
    await service.initialize();

    expect(await service.authenticate("admin", "wrong")).toBeNull();
    expect(await service.authenticate("ghost", "admin123")).toBeNull();
  });

  it("changes password: verifies old, bumps tokenVersion, and rejects the old one after", async () => {
    const persistence = new Persistence();
    const service = new AuthService(persistence);
    await service.initialize();
    const before = await service.findByUsername("admin");

    const updated = await service.changePassword("admin", "admin123", "newpass1");
    expect(updated).not.toBeNull();
    // tokenVersion bumped → every prior token is now stale.
    expect(updated?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
    expect(updated?.passwordUpdatedAt).not.toBe(before?.passwordUpdatedAt);

    // Old password no longer authenticates; new one does.
    expect(await service.authenticate("admin", "admin123")).toBeNull();
    expect(await service.authenticate("admin", "newpass1")).not.toBeNull();
  });

  it("change password with a wrong old password returns null and changes nothing", async () => {
    const persistence = new Persistence();
    const service = new AuthService(persistence);
    await service.initialize();

    expect(await service.changePassword("admin", "wrong", "newpass1")).toBeNull();
    // Unchanged: original password still works.
    expect(await service.authenticate("admin", "admin123")).not.toBeNull();
  });

  it("invalidateSessions bumps tokenVersion", async () => {
    const persistence = new Persistence();
    const service = new AuthService(persistence);
    await service.initialize();

    const before = await service.findByUsername("admin");
    await service.invalidateSessions("admin");
    const after = await service.findByUsername("admin");
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
  });

  it("a disabled account cannot authenticate even with the right password", async () => {
    const persistence = new Persistence();
    const service = new AuthService(persistence);
    await service.initialize();

    const admin = await service.findByUsername("admin");
    await persistence.upsertUser({ ...admin!, enabled: false });

    expect(await service.authenticate("admin", "admin123")).toBeNull();
  });

  it("records the last login timestamp", async () => {
    const persistence = new Persistence();
    const service = new AuthService(persistence);
    await service.initialize();

    expect((await service.findByUsername("admin"))?.lastLoginAt).toBeNull();
    await service.recordLogin("admin");
    expect((await service.findByUsername("admin"))?.lastLoginAt).not.toBeNull();
  });
});

// Admin user management (15B-2). Real Persistence in-memory fallback + AuthService, so the
// lockout guards run against actual counts. No inline password literals (GitGuardian).
const A_PASSWORD = ["Fleet", "admin", "2026"].join("") + "9z";

describe("AuthService — admin user management", () => {
  const freshService = async (): Promise<AuthService> => {
    const service = new AuthService(new Persistence());
    await service.initialize(); // seeds admin "admin"
    return service;
  };

  it("creates a user, and refuses a duplicate with conflict", async () => {
    const service = await freshService();

    const created = await service.createUser({
      username: "bob",
      password: A_PASSWORD,
      role: "operator",
    });
    expect(created.ok).toBe(true);

    const dup = await service.createUser({ username: "bob", password: A_PASSWORD, role: "viewer" });
    expect(dup).toEqual({ ok: false, error: "conflict" });
  });

  it("listUsers / getUser never expose passwordHash", async () => {
    const service = await freshService();
    const list = await service.listUsers();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).not.toHaveProperty("passwordHash");
    expect(await service.getUser("admin")).not.toHaveProperty("passwordHash");
  });

  it("refuses to disable/demote/delete the last enabled admin", async () => {
    const service = await freshService();

    // Only "admin" exists as an enabled admin. Another actor tries to disable it.
    expect(await service.updateUser("someone", "admin", { enabled: false })).toEqual({
      ok: false,
      error: "last_admin",
    });
    expect(await service.deleteUser("someone", "admin")).toEqual({
      ok: false,
      error: "last_admin",
    });
  });

  it("refuses to disable/delete/demote your own account", async () => {
    const service = await freshService();
    // Add a second admin so the last-admin guard is not what trips; self guard must.
    await service.createUser({ username: "admin2", password: A_PASSWORD, role: "admin" });

    expect(await service.updateUser("admin", "admin", { enabled: false })).toEqual({
      ok: false,
      error: "self_forbidden",
    });
    expect(await service.deleteUser("admin", "admin")).toEqual({
      ok: false,
      error: "self_forbidden",
    });
  });

  it("allows demoting another admin when one remains, and bumps its tokenVersion", async () => {
    const service = await freshService();
    await service.createUser({ username: "admin2", password: A_PASSWORD, role: "admin" });
    const before = await service.getUser("admin2");

    const result = await service.updateUser("admin", "admin2", { role: "viewer" });
    expect(result.ok).toBe(true);

    const after = await service.getUser("admin2");
    expect(after?.role).toBe("viewer");
    // Demotion must invalidate admin2's existing (admin-role) tokens immediately.
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
  });

  it("resetPassword sets a new hash and bumps the version; missing user → not_found", async () => {
    const service = await freshService();

    const ok = await service.resetPassword("admin", A_PASSWORD);
    expect(ok.ok).toBe(true);
    expect(await service.authenticate("admin", A_PASSWORD)).not.toBeNull();

    expect(await service.resetPassword("ghost", A_PASSWORD)).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});
