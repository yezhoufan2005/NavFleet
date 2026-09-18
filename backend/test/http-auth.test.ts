import { describe, it, expect } from "vitest";
import request from "supertest";
import { REFRESH_COOKIE } from "../src/auth/middleware";
import { signAccessToken, signRefreshToken } from "../src/auth/tokens";
import {
  adminUser,
  createTestApp,
  sessionCookie,
  sessionCookieWithSid,
  DEVICE_ID,
  SCENE_ID,
} from "./helpers/testApp";

/**
 * Every authenticated surface behind app.use(authenticate). The debug ingest
 * route is included: the auth gate runs before its role check and feature flag,
 * so an anonymous caller must see 401 rather than 403/404.
 */
const GUARDED_ROUTES: Array<{ method: "get" | "post"; path: string }> = [
  { method: "get", path: "/api/fleet/snapshot" },
  { method: "get", path: "/api/formations" },
  { method: "get", path: "/api/scenes" },
  { method: "get", path: `/api/scenes/${SCENE_ID}` },
  { method: "get", path: `/api/scenes/${SCENE_ID}/overlay` },
  { method: "get", path: `/api/devices/${DEVICE_ID}/history` },
  { method: "get", path: "/api/alerts" },
  { method: "get", path: "/api/auth/me" },
  { method: "post", path: "/api/debug/ingest" },
];

describe("auth gate", () => {
  it.each(GUARDED_ROUTES)("rejects $method $path without a session", async ({ method, path }) => {
    const { app } = createTestApp();
    const response = await (method === "get" ? request(app).get(path) : request(app).post(path));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "unauthorized" });
  });

  it.each(GUARDED_ROUTES.filter((route) => route.method === "get"))(
    "admits $path with a session cookie",
    async ({ path }) => {
      const { app } = createTestApp();
      const response = await request(app).get(path).set("Cookie", sessionCookie());

      expect(response.status).toBe(200);
    },
  );

  it("admits the debug ingest route with an admin session and the flag enabled", async () => {
    const { app } = createTestApp({ configOverrides: { debugIngestEnabled: true } });
    const response = await request(app)
      .post("/api/debug/ingest")
      .set("Cookie", sessionCookie("admin"))
      .send({ deviceId: DEVICE_ID, stamp: 1 });

    expect(response.status).toBe(200);
  });

  it("accepts a bearer access token as well as the cookie", async () => {
    const { app } = createTestApp();
    const token = signAccessToken({ username: "tester", role: "viewer" }, 0);
    const response = await request(app)
      .get("/api/fleet/snapshot")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
  });

  it("rejects a tampered token and a refresh token used as an access token", async () => {
    const { app } = createTestApp();
    const access = signAccessToken({ username: "tester", role: "viewer" }, 0);

    const tampered = await request(app)
      .get("/api/fleet/snapshot")
      .set("Cookie", `access_token=${access}x`);
    expect(tampered.status).toBe(401);

    const refresh = signRefreshToken({ username: "tester", role: "viewer" }, 0);
    const wrongType = await request(app)
      .get("/api/fleet/snapshot")
      .set("Cookie", `access_token=${refresh}`);
    expect(wrongType.status).toBe(401);
  });

  it("guards unknown /api paths too, so the 404 catch-all stays behind the gate", async () => {
    const { app } = createTestApp();
    const anonymous = await request(app).get("/api/does-not-exist");
    expect(anonymous.status).toBe(401);

    const authenticated = await request(app)
      .get("/api/does-not-exist")
      .set("Cookie", sessionCookie());
    expect(authenticated.status).toBe(404);
  });
});

describe("POST /api/auth/login", () => {
  it("rejects a malformed body with 400", async () => {
    const { app } = createTestApp();
    const response = await request(app).post("/api/auth/login").send({ username: "admin" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_request" });
  });

  it("rejects unknown credentials with 401", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "nope" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "invalid_credentials" });
  });

  it("issues httpOnly access and refresh cookies on success", async () => {
    const context = createTestApp();
    context.authService.authenticate.mockResolvedValue({ ok: true, user: adminUser() });

    const response = await request(context.app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "secret" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: { username: "admin", role: "admin" } });
    // Login opens a tracked session (Phase 15E).
    expect(context.authService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ username: "admin" }),
    );

    const cookies = response.headers["set-cookie"] as unknown as string[];
    const access = cookies.find((cookie) => cookie.startsWith("access_token="));
    const refresh = cookies.find((cookie) => cookie.startsWith("refresh_token="));
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/Path=\//);
    expect(refresh).toMatch(/Path=\/api\/auth/);

    // The issued access token is accepted by the gate.
    const token = /access_token=([^;]+)/.exec(access ?? "")?.[1] ?? "";
    const reuse = await request(context.app)
      .get("/api/auth/me")
      .set("Cookie", `access_token=${token}`);
    expect(reuse.status).toBe(200);
    expect(reuse.body).toEqual({ user: { username: "admin", role: "admin" } });
  });
});

describe("POST /api/auth/refresh", () => {
  it("rejects a missing or unknown refresh token with 401", async () => {
    const context = createTestApp();

    const missing = await request(context.app).post("/api/auth/refresh");
    expect(missing.status).toBe(401);

    // Valid signature, but the user no longer exists.
    context.authService.findByUsername.mockResolvedValue(null);
    const token = signRefreshToken({ username: "ghost", role: "viewer" }, 0);
    const unknownUser = await request(context.app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${token}`);
    expect(unknownUser.status).toBe(401);
  });

  it("mints a fresh access cookie for a valid refresh token", async () => {
    const context = createTestApp();
    context.authService.findByUsername.mockResolvedValue(adminUser());

    const token = signRefreshToken({ username: "admin", role: "admin" }, 0);
    const response = await request(context.app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: { username: "admin", role: "admin" } });
    const cookies = response.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((cookie) => cookie.startsWith("access_token="))).toBe(true);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears both cookies and answers 204 without a session", async () => {
    const { app } = createTestApp();
    const response = await request(app).post("/api/auth/logout");

    expect(response.status).toBe(204);
    const cookies = response.headers["set-cookie"] as unknown as string[];
    expect(cookies).toHaveLength(2);
    expect(cookies.every((cookie) => /Expires=Thu, 01 Jan 1970/.test(cookie))).toBe(true);
  });

  it("revokes only the presented session when a valid token is presented", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .post("/api/auth/logout")
      .set("Cookie", sessionCookieWithSid("viewer", "tester", "sid-logout"));

    expect(response.status).toBe(204);
    // Per-session logout (Phase 15E): the session the token names is revoked, and — unlike the
    // pre-15E logout — the user's tokenVersion is left alone so their other devices stay in.
    expect(context.authService.revokeSession).toHaveBeenCalledWith("tester", "sid-logout");
  });
});

describe("POST /api/auth/refresh — rotation", () => {
  it("re-issues BOTH the access and refresh cookies, not just access", async () => {
    const context = createTestApp();
    context.authService.findByUsername.mockResolvedValue(adminUser());

    const token = signRefreshToken({ username: "admin", role: "admin" }, 0);
    const response = await request(context.app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${token}`);

    expect(response.status).toBe(200);
    const cookies = response.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((cookie) => cookie.startsWith("access_token="))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("refresh_token="))).toBe(true);
  });

  it("rejects a refresh token whose version is stale (logout happened since)", async () => {
    const context = createTestApp();
    // Token minted at version 0, but the stored user has moved on to version 1.
    context.authService.findByUsername.mockResolvedValue({ ...adminUser(), tokenVersion: 1 });

    const token = signRefreshToken({ username: "admin", role: "admin" }, 0);
    const response = await request(context.app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${token}`);

    expect(response.status).toBe(401);
  });

  it("keeps the same session id across a refresh and touches it", async () => {
    const context = createTestApp();
    context.authService.findByUsername.mockResolvedValue(adminUser());
    context.authService.isSessionActive.mockResolvedValue(true);

    const token = signRefreshToken({ username: "admin", role: "admin" }, 0, "sid-keep");
    const response = await request(context.app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${token}`);

    expect(response.status).toBe(200);
    // Same session renewed, not a new one.
    expect(context.authService.touchSession).toHaveBeenCalledWith("sid-keep");
    expect(context.authService.createSession).not.toHaveBeenCalled();
  });

  it("rejects a refresh whose named session has been revoked", async () => {
    const context = createTestApp();
    context.authService.findByUsername.mockResolvedValue(adminUser());
    context.authService.isSessionActive.mockResolvedValue(false);

    const token = signRefreshToken({ username: "admin", role: "admin" }, 0, "sid-gone");
    const response = await request(context.app)
      .post("/api/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${token}`);

    expect(response.status).toBe(401);
    expect(context.authService.touchSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/change-password", () => {
  it("401s without a session", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .post("/api/auth/change-password")
      .send({ oldPassword: "old", newPassword: "newpass1" });
    expect(response.status).toBe(401);
  });

  it("rejects a weak new password with 400 before touching the service", async () => {
    const context = createTestApp();
    const response = await request(context.app)
      .post("/api/auth/change-password")
      .set("Cookie", sessionCookie())
      .send({ oldPassword: "old", newPassword: "short" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "invalid_request" });
    expect(context.authService.changePassword).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_credentials when the old password is wrong", async () => {
    const context = createTestApp();
    context.authService.changePassword.mockResolvedValue(null);

    const response = await request(context.app)
      .post("/api/auth/change-password")
      .set("Cookie", sessionCookie())
      .send({ oldPassword: "wrong", newPassword: "newpass1" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_credentials" });
  });

  it("on success re-issues cookies at the new version so the caller stays signed in", async () => {
    const context = createTestApp();
    context.authService.changePassword.mockResolvedValue({ ...adminUser(), tokenVersion: 1 });

    const response = await request(context.app)
      .post("/api/auth/change-password")
      .set("Cookie", sessionCookie())
      .send({ oldPassword: "admin123", newPassword: "newpass1" });

    expect(response.status).toBe(204);
    const cookies = response.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((cookie) => cookie.startsWith("access_token="))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("refresh_token="))).toBe(true);
  });
});
