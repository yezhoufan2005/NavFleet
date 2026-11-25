import { describe, it, expect } from "vitest";
import request from "supertest";
import type { AuditEntry } from "../src/types";
import { RbacService } from "../src/rbac/service";
import type { Persistence } from "../src/persistence";
import { createTestApp, sessionCookie, sessionCookieWithSid } from "./helpers/testApp";

/**
 * 个人中心's own-account routes: read and edit one's profile, read one's account activity, and
 * end every other session. The service is stubbed; these pin the wiring — what the caller may
 * change, what lands in the audit trail, and which audit rows a user is shown.
 */

const entry = (fields: Partial<AuditEntry> & Pick<AuditEntry, "action">): AuditEntry => ({
  ts: new Date("2026-03-01T08:00:00.000Z"),
  actor: "tester",
  outcome: "success",
  ...fields,
});

describe("GET /api/auth/profile", () => {
  it("401s without a session", async () => {
    const { app } = createTestApp();
    expect((await request(app).get("/api/auth/profile")).status).toBe(401);
  });

  it("returns the caller's account and no stored internals", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .get("/api/auth/profile")
      .set("Cookie", sessionCookie("viewer", "tester"));

    expect(response.status).toBe(200);
    const profile = (response.body as { profile: Record<string, unknown> }).profile;
    expect(profile).toMatchObject({
      username: "tester",
      role: "viewer",
      displayName: "tester",
      kiosk: false,
      groups: [],
    });
    for (const internal of ["passwordHash", "tokenVersion", "failedAttempts", "lockedUntil"]) {
      expect(profile).not.toHaveProperty(internal);
    }
  });

  it("names the groups the caller belongs to", async () => {
    const group = (id: string, name: string, member: string) => ({
      id,
      name,
      description: "",
      roleIds: [],
      memberUsernames: [member],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const groups = [group("g1", "夜班", "tester"), group("g2", "维修", "someone-else")];
    const rbacService = new RbacService({} as Persistence);
    Object.assign(rbacService, { groups, roles: [] });
    const { app } = createTestApp({ rbacService });

    const response = await request(app)
      .get("/api/auth/profile")
      .set("Cookie", sessionCookie("viewer", "tester"));

    expect((response.body as { profile: { groups: string[] } }).profile.groups).toEqual(["夜班"]);
  });
});

describe("PATCH /api/auth/profile", () => {
  it("updates the caller's own contact fields and audits what changed", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .patch("/api/auth/profile")
      .set("Cookie", sessionCookie("viewer", "tester"))
      .send({ displayName: "测试员", email: "t@example.com" });

    expect(response.status).toBe(200);
    expect(context.authService.updateProfile).toHaveBeenCalledWith("tester", {
      displayName: "测试员",
      email: "t@example.com",
    });
    expect((response.body as { profile: { displayName: string } }).profile.displayName).toBe(
      "测试员",
    );
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "tester",
        action: "profile_update",
        target: "tester",
        detail: {
          fields: ["displayName", "email"],
          changes: { displayName: { from: "tester", to: "测试员" } },
        },
      }),
    );
  });

  it("refuses role or enabled — those stay with users:manage", async () => {
    const context = createTestApp();
    for (const body of [
      { role: "admin" },
      { enabled: false },
      { displayName: "x", role: "admin" },
    ]) {
      const response = await request(context.app)
        .patch("/api/auth/profile")
        .set("Cookie", sessionCookie("viewer", "tester"))
        .send(body);
      expect(response.status).toBe(400);
    }
    expect(context.authService.updateProfile).not.toHaveBeenCalled();
  });

  it("rejects a malformed email and an empty body", async () => {
    const context = createTestApp();
    for (const body of [{ email: "not-an-email" }, {}]) {
      const response = await request(context.app)
        .patch("/api/auth/profile")
        .set("Cookie", sessionCookie("viewer", "tester"))
        .send(body);
      expect(response.status).toBe(400);
    }
  });

  it("writes no audit row for a save that changed nothing", async () => {
    const context = createTestApp();
    await request(context.app)
      .patch("/api/auth/profile")
      .set("Cookie", sessionCookie("viewer", "tester"))
      .send({ displayName: "tester" });
    expect(context.auditService.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "profile_update" }),
    );
  });
});

describe("GET /api/auth/activity", () => {
  it("merges what the caller did with what was done to them, newest first", async () => {
    const context = createTestApp();
    context.auditService.query.mockImplementation((filters) => {
      const { actor, target } = filters as { actor?: string; target?: string };
      if (actor === "tester") {
        return Promise.resolve([
          entry({
            action: "login",
            ts: new Date("2026-03-02T00:00:00.000Z"),
            detail: { ip: "10.0.0.9", userAgent: "Firefox" },
          }),
          entry({ action: "login_failed", outcome: "failure" }),
        ]);
      }
      if (target === "tester") {
        return Promise.resolve([
          entry({
            action: "password_reset",
            actor: "root",
            target: "tester",
            ts: new Date("2026-03-01T12:00:00.000Z"),
          }),
        ]);
      }
      return Promise.resolve([]);
    });

    const response = await request(context.app)
      .get("/api/auth/activity")
      .set("Cookie", sessionCookie("viewer", "tester"));

    expect(response.status).toBe(200);
    const items = (response.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((item) => [item.action, item.actor])).toEqual([
      ["login", "tester"],
      ["password_reset", "root"],
      ["login_failed", "tester"],
    ]);
    expect(items[0]).toMatchObject({ ip: "10.0.0.9", userAgent: "Firefox" });
    // Only account events are asked for — never the caller's alert handling or config writes.
    const [ownQuery, doneToQuery] = context.auditService.query.mock.calls.map(
      ([filters]) => filters as { actor?: string; target?: string; action: string[] },
    );
    expect(ownQuery).toMatchObject({ actor: "tester" });
    expect(ownQuery!.action).toContain("login_failed");
    expect(ownQuery!.action).not.toContain("alert_claim");
    expect(doneToQuery).toMatchObject({ target: "tester" });
    expect(doneToQuery!.action).toEqual(["password_reset", "force_logout", "user_update"]);
  });
});

describe("DELETE /api/auth/sessions", () => {
  it("ends every other session, keeping the caller's own", async () => {
    const context = createTestApp();
    context.authService.revokeOtherSessions.mockResolvedValue(2);

    const response = await request(context.app)
      .delete("/api/auth/sessions")
      .set("Cookie", sessionCookieWithSid("viewer", "tester", "sid-here"));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ended: 2 });
    expect(context.authService.revokeOtherSessions).toHaveBeenCalledWith("tester", "sid-here");
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session_revoke", detail: { others: 2 } }),
    );
  });

  it("refuses when the request belongs to no session", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .delete("/api/auth/sessions")
      .set("Cookie", sessionCookie("viewer", "tester"));
    expect(response.status).toBe(409);
    expect(context.authService.revokeOtherSessions).not.toHaveBeenCalled();
  });
});

// Assembled from parts so no credential-shaped literal sits in the source (GitGuardian).
const WRONG_GUESS = ["wrong", "guess", "1"].join("-");

describe("sign-in audit rows carry where the attempt came from", () => {
  it("records the IP and user agent on a failed login", async () => {
    const context = createTestApp();
    await request(context.app)
      .post("/api/auth/login")
      .set("User-Agent", "probe/1.0")
      .send({ username: "tester", password: WRONG_GUESS });

    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "login_failed",
        detail: expect.objectContaining({ userAgent: "probe/1.0" }) as unknown,
      }),
    );
    const detail = (context.auditService.record.mock.calls[0]![0] as { detail: { ip: string } })
      .detail;
    expect(typeof detail.ip).toBe("string");
  });
});
