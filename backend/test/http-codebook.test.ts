import { describe, it, expect } from "vitest";
import request from "supertest";
import type { ReportCodeEntry } from "@navfleet/shared";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * Report-code dictionary API (Phase 16C-2). The role gate (PUT is admin-only, GET is
 * read-for-everyone) is pinned in http-rbac; here we cover the router → store wiring: GET
 * returns the table in effect, a valid PUT validates + imports + audits, and an invalid PUT
 * is a 400 that never touches the store.
 */
const ADMIN = sessionCookie("admin", "admin-1");
const VIEWER = sessionCookie("viewer", "v-1");
const ENTRY: ReportCodeEntry = {
  code: 2301,
  channel: "warning",
  subsystem: "power",
  label: "本厂电量低",
  description: "低于本厂阈值",
  hint: "推去充电区",
  impact: "urgent",
};

describe("GET /api/codebook", () => {
  it("returns the table in effect to any authenticated user", async () => {
    const context = createTestApp();
    const response = await request(context.app).get("/api/codebook").set("Cookie", VIEWER);

    expect(response.status).toBe(200);
    const body = response.body as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(context.store.getCodebook).toHaveBeenCalled();
  });
});

describe("PUT /api/codebook", () => {
  it("validates, imports, audits, and returns the merged table", async () => {
    const context = createTestApp();
    context.store.importCodebook.mockResolvedValue([ENTRY]);

    const response = await request(context.app)
      .put("/api/codebook")
      .set("Cookie", ADMIN)
      .send({ items: [ENTRY] });

    expect(response.status).toBe(200);
    expect((response.body as { items: unknown[] }).items).toEqual([ENTRY]);
    expect(context.store.importCodebook).toHaveBeenCalledWith([ENTRY]);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin-1", action: "codebook_import" }),
    );
  });

  it("accepts a bare array body too", async () => {
    const context = createTestApp();
    context.store.importCodebook.mockResolvedValue([ENTRY]);

    const response = await request(context.app)
      .put("/api/codebook")
      .set("Cookie", ADMIN)
      .send([ENTRY]);

    expect(response.status).toBe(200);
    expect(context.store.importCodebook).toHaveBeenCalledWith([ENTRY]);
  });

  it("400s an invalid codebook without importing or auditing", async () => {
    const context = createTestApp();

    const response = await request(context.app)
      .put("/api/codebook")
      .set("Cookie", ADMIN)
      .send({ items: [{ ...ENTRY, code: 0 }] });

    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe("invalid_codebook");
    expect(context.store.importCodebook).not.toHaveBeenCalled();
    expect(context.auditService.record).not.toHaveBeenCalled();
  });
});
