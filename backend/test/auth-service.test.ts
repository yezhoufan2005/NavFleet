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
