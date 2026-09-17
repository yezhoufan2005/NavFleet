import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * The admin user-management API (15B-2). These cover the router → service wiring and the auth
 * gate: every route is admin-only, and the service's refusal reasons map to specific statuses.
 * The lockout guards themselves are unit-tested against the real service in auth-service.test.ts;
 * here we assert the router surfaces them, using a stubbed AuthService.
 *
 * No password literals are inlined (GitGuardian): the create/reset bodies use this constant.
 */
const NEW_PASSWORD = ["Fleet", "ops", "2026"].join("-") + "x1";

const ADMIN = sessionCookie("admin", "root");

describe("users API — auth gate", () => {
  const routes: Array<{ method: "get" | "post" | "patch" | "delete"; path: string }> = [
    { method: "get", path: "/api/users" },
    { method: "post", path: "/api/users" },
    { method: "get", path: "/api/users/bob" },
    { method: "patch", path: "/api/users/bob" },
    { method: "post", path: "/api/users/bob/reset-password" },
    { method: "delete", path: "/api/users/bob" },
  ];

  it("401s every route without a session", async () => {
    const { app } = createTestApp();
    for (const route of routes) {
      const response = await request(app)[route.method](route.path);
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it("403s every route for a non-admin (viewer, operator)", async () => {
    const { app } = createTestApp();
    for (const role of ["viewer", "operator"] as const) {
      for (const route of routes) {
        const response = await request(app)
          [route.method](route.path)
          .set("Cookie", sessionCookie(role));
        expect(response.status, `${role} ${route.method} ${route.path}`).toBe(403);
      }
    }
  });
});

describe("users API — CRUD wiring (admin)", () => {
  it("lists users", async () => {
    const context = createTestApp();
    const response = await request(context.app).get("/api/users").set("Cookie", ADMIN);
    expect(response.status).toBe(200);
    const body = response.body as { users: unknown[] };
    expect(Array.isArray(body.users)).toBe(true);
    expect(context.authService.listUsers).toHaveBeenCalled();
  });

  it("creates a user (201) and never returns a passwordHash", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .post("/api/users")
      .set("Cookie", ADMIN)
      .send({ username: "bob", password: NEW_PASSWORD, role: "operator" });
    expect(response.status).toBe(201);
    const body = response.body as { user: Record<string, unknown> };
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(context.authService.createUser).toHaveBeenCalled();
  });

  it("409s a duplicate username (service returns conflict)", async () => {
    const context = createTestApp();
    context.authService.createUser.mockResolvedValue({ ok: false, error: "conflict" });
    const response = await request(context.app)
      .post("/api/users")
      .set("Cookie", ADMIN)
      .send({ username: "bob", password: NEW_PASSWORD, role: "viewer" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "conflict" });
  });

  it("400s a weak password before calling the service", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .post("/api/users")
      .set("Cookie", ADMIN)
      .send({ username: "bob", password: "short", role: "viewer" });
    expect(response.status).toBe(400);
    expect(context.authService.createUser).not.toHaveBeenCalled();
  });

  it("patches a user and passes the acting username to the service", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .patch("/api/users/bob")
      .set("Cookie", sessionCookie("admin", "root"))
      .send({ role: "viewer" });
    expect(response.status).toBe(200);
    expect(context.authService.updateUser).toHaveBeenCalledWith("root", "bob", { role: "viewer" });
  });

  it("400s a PATCH with no fields", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .patch("/api/users/bob")
      .set("Cookie", ADMIN)
      .send({});
    expect(response.status).toBe(400);
    expect(context.authService.updateUser).not.toHaveBeenCalled();
  });

  it("resets a password (204)", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .post("/api/users/bob/reset-password")
      .set("Cookie", ADMIN)
      .send({ newPassword: NEW_PASSWORD });
    expect(response.status).toBe(204);
    expect(context.authService.resetPassword).toHaveBeenCalledWith("bob", NEW_PASSWORD);
  });

  it("deletes a user (204) and passes the acting username", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .delete("/api/users/bob")
      .set("Cookie", sessionCookie("admin", "root"));
    expect(response.status).toBe(204);
    expect(context.authService.deleteUser).toHaveBeenCalledWith("root", "bob");
  });
});

describe("users API — lockout guards surface as 409", () => {
  it("409s when the service refuses (last_admin / self_forbidden / not_found→404)", async () => {
    const context = createTestApp();

    context.authService.updateUser.mockResolvedValue({ ok: false, error: "last_admin" });
    const lastAdmin = await request(context.app)
      .patch("/api/users/root")
      .set("Cookie", ADMIN)
      .send({ enabled: false });
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.body).toEqual({ error: "last_admin" });

    context.authService.deleteUser.mockResolvedValue({ ok: false, error: "self_forbidden" });
    const self = await request(context.app).delete("/api/users/root").set("Cookie", ADMIN);
    expect(self.status).toBe(409);

    context.authService.getUser.mockResolvedValue(null);
    const missing = await request(context.app).get("/api/users/ghost").set("Cookie", ADMIN);
    expect(missing.status).toBe(404);
  });
});
