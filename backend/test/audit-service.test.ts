import { describe, it, expect, vi } from "vitest";
import type { Persistence } from "../src/persistence";
import { AuditService } from "../src/audit/service";
import type { AuditEntry } from "../src/types";

/**
 * `AuditService` is a thin timestamping wrapper; the substance (write shape, best-effort,
 * query filters) is tested against the fake `Db` in persistence-mongo.test.ts. Here we only
 * pin that `record` stamps `ts` and defaults `outcome`, and that `query` passes filters through.
 */
const fakePersistence = () => {
  const appended: AuditEntry[] = [];
  const appendAudit = vi.fn((entry: AuditEntry) => {
    appended.push(entry);
    return Promise.resolve();
  });
  const queryAudit = vi.fn(() => Promise.resolve<AuditEntry[]>([]));
  const persistence = { appendAudit, queryAudit } as unknown as Persistence;
  return { persistence, appended, queryAudit };
};

describe("AuditService", () => {
  it("record stamps ts, defaults outcome to success, and forwards optional fields", async () => {
    const { persistence, appended } = fakePersistence();
    const service = new AuditService(persistence);

    const before = Date.now();
    await service.record({ actor: "root", action: "user_delete", target: "bob", requestId: "r1" });
    const entry = appended[0];

    expect(entry?.actor).toBe("root");
    expect(entry?.action).toBe("user_delete");
    expect(entry?.target).toBe("bob");
    expect(entry?.requestId).toBe("r1");
    expect(entry?.outcome).toBe("success");
    expect(entry?.ts.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("record keeps an explicit failure outcome", async () => {
    const { persistence, appended } = fakePersistence();
    const service = new AuditService(persistence);
    await service.record({ actor: "mallory", action: "login_failed", outcome: "failure" });
    expect(appended[0]?.outcome).toBe("failure");
  });

  it("query forwards filters to persistence", async () => {
    const { persistence, queryAudit } = fakePersistence();
    const service = new AuditService(persistence);
    await service.query({ actor: "root", action: "login" });
    expect(queryAudit).toHaveBeenCalledWith({ actor: "root", action: "login" });
  });
});
