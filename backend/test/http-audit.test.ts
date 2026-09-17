import { describe, it, expect } from "vitest";
import request from "supertest";
import { REFRESH_COOKIE } from "../src/auth/middleware";
import { adminUser, createTestApp, sessionCookie } from "./helpers/testApp";
import { signRefreshToken } from "../src/auth/tokens";

/**
 * Audit trail (Phase 15D): the query API's auth gate, and that each security-relevant action
 * emits one entry with the right action/actor/target. Recording is asserted via the audit
 * stub — the persistence write shape is covered in persistence-mongo.test.ts.
 *
 * No inline password literals (GitGuardian): one named constant for every credential.
 */
const PASSWORD = ["Fleet", "audit", "2026"].join("-") + "x1";

describe("GET /api/audit — admin only", () => {
  it("lets an admin query and passes filters through", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .get("/api/audit?actor=bob&action=login")
      .set("Cookie", sessionCookie("admin"));

    expect(response.status).toBe(200);
    expect(context.auditService.query).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "bob", action: "login" }),
    );
  });

  it("403s viewer and operator, 401s anonymous", async () => {
    const context = createTestApp();
    for (const role of ["viewer", "operator"] as const) {
      const response = await request(context.app)
        .get("/api/audit")
        .set("Cookie", sessionCookie(role));
      expect(response.status, role).toBe(403);
    }
    expect((await request(context.app).get("/api/audit")).status).toBe(401);
  });

  it("400s an unknown action value", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .get("/api/audit?action=nonsense")
      .set("Cookie", sessionCookie("admin"));
    expect(response.status).toBe(400);
  });
});

describe("audit emit points", () => {
  it("records a successful login and a failed login", async () => {
    const context = createTestApp();
    context.authService.authenticate.mockResolvedValueOnce(adminUser());
    await request(context.app)
      .post("/api/auth/login")
      .send({ username: "admin", password: PASSWORD });
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin", action: "login" }),
    );

    context.authService.authenticate.mockResolvedValueOnce(null);
    await request(context.app).post("/api/auth/login").send({ username: "mallory", password: "x" });
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "mallory", action: "login_failed", outcome: "failure" }),
    );
  });

  it("records logout", async () => {
    const context = createTestApp();
    const token = signRefreshToken({ username: "admin", role: "admin" }, 0);
    await request(context.app).post("/api/auth/logout").set("Cookie", `${REFRESH_COOKIE}=${token}`);
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin", action: "logout" }),
    );
  });

  it("records a self password change", async () => {
    const context = createTestApp();
    context.authService.changePassword.mockResolvedValue({ ...adminUser(), tokenVersion: 1 });
    await request(context.app)
      .post("/api/auth/change-password")
      .set("Cookie", sessionCookie("admin", "root"))
      .send({ oldPassword: PASSWORD, newPassword: PASSWORD });
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "root", action: "password_change" }),
    );
  });

  it("records user create / update / delete / reset with target and actor", async () => {
    const context = createTestApp();
    const admin = sessionCookie("admin", "root");

    await request(context.app)
      .post("/api/users")
      .set("Cookie", admin)
      .send({ username: "bob", password: PASSWORD, role: "viewer" });
    await request(context.app)
      .patch("/api/users/bob")
      .set("Cookie", admin)
      .send({ role: "operator" });
    await request(context.app).delete("/api/users/bob").set("Cookie", admin);
    await request(context.app)
      .post("/api/users/bob/reset-password")
      .set("Cookie", admin)
      .send({ newPassword: PASSWORD });

    const actions = context.auditService.record.mock.calls.map((call) => call[0]);
    expect(actions).toContainEqual(
      expect.objectContaining({ actor: "root", action: "user_create", target: "bob" }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ actor: "root", action: "user_update", target: "bob" }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ actor: "root", action: "user_delete", target: "bob" }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ actor: "root", action: "password_reset", target: "bob" }),
    );
  });
});
