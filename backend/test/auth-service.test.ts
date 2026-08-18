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
});
