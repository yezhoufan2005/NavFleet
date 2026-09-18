import { describe, it, expect } from "vitest";
import request from "supertest";
import type { SessionRecord } from "../src/types";
import { createTestApp, sessionCookie, sessionCookieWithSid, UPDATED_AT } from "./helpers/testApp";

/**
 * Per-session tracking, revocation and admin force-logout (Phase 15E-1).
 *
 * The auth gate now has a third check beyond "user exists / enabled / tokenVersion matches":
 * when the token names a session (`sid`), that session must still be live. These pin that
 * check and the endpoints that read and end sessions — the routes only translate the service,
 * which is unit-tested against a real store elsewhere, so here the service is stubbed and the
 * assertions are about wiring: which service call fires, and the status it maps to.
 */

const sessionRecord = (sessionId: string, username = "tester"): SessionRecord => ({
  sessionId,
  username,
  createdAt: UPDATED_AT,
  lastSeenAt: UPDATED_AT,
  userAgent: "vitest",
  ip: "127.0.0.1",
  expiresAt: new Date("2026-02-01T00:00:00.000Z"),
});

describe("per-request session validity", () => {
  it("401s a token whose session has been revoked, even though the user is fine", async () => {
    const context = createTestApp();
    // User is enabled and at the token's version; only the session is gone.
    context.authService.isSessionActive.mockResolvedValue(false);

    const response = await request(context.app)
      .get("/api/fleet/snapshot")
      .set("Cookie", sessionCookieWithSid("viewer", "tester", "sid-dead"));

    expect(response.status).toBe(401);
    expect(context.authService.isSessionActive).toHaveBeenCalledWith("tester", "sid-dead");
  });

  it("admits a token whose session is still live", async () => {
    const context = createTestApp();
    context.authService.isSessionActive.mockResolvedValue(true);

    const response = await request(context.app)
      .get("/api/fleet/snapshot")
      .set("Cookie", sessionCookieWithSid("viewer", "tester", "sid-live"));

    expect(response.status).toBe(200);
  });
});

describe("GET /api/auth/sessions", () => {
  it("401s without a session", async () => {
    const { app } = createTestApp();
    expect((await request(app).get("/api/auth/sessions")).status).toBe(401);
  });

  it("lists the caller's own sessions and marks the current one", async () => {
    const context = createTestApp();
    context.authService.listSessions.mockResolvedValue([
      sessionRecord("sid-current"),
      sessionRecord("sid-other"),
    ]);

    const response = await request(context.app)
      .get("/api/auth/sessions")
      .set("Cookie", sessionCookieWithSid("viewer", "tester", "sid-current"));

    expect(response.status).toBe(200);
    expect(context.authService.listSessions).toHaveBeenCalledWith("tester");
    const body = response.body as {
      sessions: Array<{ sessionId: string; current: boolean; expiresAt?: unknown }>;
    };
    expect(body.sessions.map((s) => [s.sessionId, s.current])).toEqual([
      ["sid-current", true],
      ["sid-other", false],
    ]);
    // The stored expiry is not part of the owner-facing view.
    expect(body.sessions[0]).not.toHaveProperty("expiresAt");
  });
});

describe("DELETE /api/auth/sessions/:sessionId", () => {
  it("revokes the caller's own session and audits it", async () => {
    const context = createTestApp();
    context.authService.revokeSession.mockResolvedValue(true);

    const response = await request(context.app)
      .delete("/api/auth/sessions/sid-other")
      .set("Cookie", sessionCookieWithSid("viewer", "tester", "sid-current"));

    expect(response.status).toBe(204);
    expect(context.authService.revokeSession).toHaveBeenCalledWith("tester", "sid-other");
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "tester", action: "session_revoke", target: "sid-other" }),
    );
  });

  it("404s when the session is not the caller's (or does not exist)", async () => {
    const context = createTestApp();
    // The persistence delete is scoped to the caller, so someone else's id simply does not match.
    context.authService.revokeSession.mockResolvedValue(false);

    const response = await request(context.app)
      .delete("/api/auth/sessions/not-mine")
      .set("Cookie", sessionCookieWithSid("viewer", "tester", "sid-current"));

    expect(response.status).toBe(404);
  });
});

describe("POST /api/users/:username/logout (admin force-logout)", () => {
  it("403s a non-admin caller", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .post("/api/users/bob/logout")
      .set("Cookie", sessionCookie("operator"));
    expect(response.status).toBe(403);
  });

  it("force-logs-out the target and audits force_logout", async () => {
    const context = createTestApp();
    context.authService.forceLogout.mockResolvedValue({ ok: true, value: undefined });

    const response = await request(context.app)
      .post("/api/users/bob/logout")
      .set("Cookie", sessionCookie("admin"));

    expect(response.status).toBe(204);
    expect(context.authService.forceLogout).toHaveBeenCalledWith("bob");
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "force_logout", target: "bob" }),
    );
  });

  it("404s when the target user does not exist", async () => {
    const context = createTestApp();
    context.authService.forceLogout.mockResolvedValue({ ok: false, error: "not_found" });

    const response = await request(context.app)
      .post("/api/users/ghost/logout")
      .set("Cookie", sessionCookie("admin"));

    expect(response.status).toBe(404);
  });
});

describe("GET /api/users/:username/sessions (admin views another's sessions)", () => {
  it("403s a non-admin caller", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .get("/api/users/bob/sessions")
      .set("Cookie", sessionCookie("operator"));
    expect(response.status).toBe(403);
  });

  it("lists the target user's sessions (no `current` flag in the admin view)", async () => {
    const context = createTestApp();
    context.authService.listSessions.mockResolvedValue([
      sessionRecord("sid-a", "bob"),
      sessionRecord("sid-b", "bob"),
    ]);

    const response = await request(context.app)
      .get("/api/users/bob/sessions")
      .set("Cookie", sessionCookie("admin"));

    expect(response.status).toBe(200);
    expect(context.authService.listSessions).toHaveBeenCalledWith("bob");
    const body = response.body as { sessions: Array<{ sessionId: string; current?: unknown }> };
    expect(body.sessions.map((s) => s.sessionId)).toEqual(["sid-a", "sid-b"]);
    expect(body.sessions[0]).not.toHaveProperty("current");
  });

  it("404s when the target user does not exist", async () => {
    const context = createTestApp();
    context.authService.getUser.mockResolvedValue(null);

    const response = await request(context.app)
      .get("/api/users/ghost/sessions")
      .set("Cookie", sessionCookie("admin"));

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/users/:username/sessions/:sessionId (admin revokes one)", () => {
  it("403s a non-admin caller", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .delete("/api/users/bob/sessions/sid-a")
      .set("Cookie", sessionCookie("viewer"));
    expect(response.status).toBe(403);
  });

  it("revokes the target's session and audits it with a user:session target", async () => {
    const context = createTestApp();
    context.authService.revokeSession.mockResolvedValue(true);

    const response = await request(context.app)
      .delete("/api/users/bob/sessions/sid-a")
      .set("Cookie", sessionCookie("admin"));

    expect(response.status).toBe(204);
    expect(context.authService.revokeSession).toHaveBeenCalledWith("bob", "sid-a");
    expect(context.auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session_revoke", target: "bob:sid-a" }),
    );
  });

  it("404s when that session is not the target's (or does not exist)", async () => {
    const context = createTestApp();
    context.authService.revokeSession.mockResolvedValue(false);

    const response = await request(context.app)
      .delete("/api/users/bob/sessions/nope")
      .set("Cookie", sessionCookie("admin"));

    expect(response.status).toBe(404);
  });
});
