import { Router, type CookieOptions, type Response } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { changePasswordSchema, loginSchema } from "../validation";
import type { UserRecord } from "../types";
import type { AuthService } from "./service";
import { toPublicUser } from "./service";
import type { AuditService } from "../audit/service";
import { ACCESS_COOKIE, REFRESH_COOKIE, createAuthenticate } from "./middleware";
import { durationToMs, signAccessToken, signRefreshToken, verifyToken } from "./tokens";

const baseCookie = (): CookieOptions => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.cookieSecure,
});

/**
 * Issue fresh access + refresh cookies for a user, both carrying the session id `sid` (Phase
 * 15E) so the per-request auth check can tie them to a live session row. The refresh cookie is
 * scoped to `/api/auth` so it is not sent with every API call, and both carry the user's
 * current `tokenVersion` so a later bump invalidates them. Called on login, on refresh
 * (rotation, same `sid`), and after a self password change (a fresh `sid`).
 */
const issueSessionCookies = (response: Response, user: UserRecord, sessionId: string): void => {
  const publicUser = toPublicUser(user);
  response.cookie(ACCESS_COOKIE, signAccessToken(publicUser, user.tokenVersion, sessionId), {
    ...baseCookie(),
    path: "/",
    maxAge: durationToMs(config.jwtAccessTtl) || undefined,
  });
  response.cookie(REFRESH_COOKIE, signRefreshToken(publicUser, user.tokenVersion, sessionId), {
    ...baseCookie(),
    path: "/api/auth",
    maxAge: durationToMs(config.jwtRefreshTtl) || undefined,
  });
};

const clearSessionCookies = (response: Response): void => {
  response.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: "/" });
  response.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: "/api/auth" });
};

export const buildAuthRouter = (authService: AuthService, audit: AuditService): Router => {
  const router = Router();
  const authenticate = createAuthenticate(
    (username) => authService.findByUsername(username),
    (username, sessionId) => authService.isSessionActive(username, sessionId),
  );

  /** The device context recorded on a session, from the request that created it. */
  const sessionContext = (request: {
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
  }): { userAgent: string; ip: string } => {
    const raw = request.headers["user-agent"];
    const userAgent = (Array.isArray(raw) ? raw.join(" ") : (raw ?? "")).slice(0, 400);
    return { userAgent, ip: request.ip ?? "" };
  };

  router.post("/login", async (request, response, next) => {
    try {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_request" });
        return;
      }
      const result = await authService.authenticate(parsed.data.username, parsed.data.password);
      if (!result.ok) {
        void audit.record({
          actor: parsed.data.username,
          action: "login_failed",
          outcome: "failure",
          requestId: request.requestId,
        });
        // A lockout tripped by *this* attempt is its own auditable event, distinct from the
        // failure that caused it. We never tell the client an account is locked (that leaks
        // which usernames exist) — the 401 body is identical to a wrong password.
        if (result.lockedJustNow) {
          void audit.record({
            actor: parsed.data.username,
            action: "account_locked",
            outcome: "failure",
            requestId: request.requestId,
          });
        }
        response.status(401).json({ error: "invalid_credentials" });
        return;
      }
      const user = result.user;
      const sessionId = randomUUID();
      await authService.createSession({
        sessionId,
        username: user.username,
        ...sessionContext(request),
      });
      await authService.recordLogin(user.username);
      void audit.record({ actor: user.username, action: "login", requestId: request.requestId });
      issueSessionCookies(response, user, sessionId);
      response.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/refresh", async (request, response, next) => {
    try {
      const token = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
      const claims = token ? verifyToken(token, "refresh") : null;
      if (!claims) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      const user = await authService.findByUsername(claims.sub);
      // Same three checks the access middleware makes: gone, disabled, or a stale version
      // (password change / force-logout bumped the version since this token was minted).
      if (!user || !user.enabled || user.tokenVersion !== claims.ver) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      // Keep the same session across a refresh (a renewal, not a new login), touching it so
      // its idle-expiry moves out. A refresh token that names a *revoked* session mints nothing.
      // A legacy token with no `sid` (minted before 15E) is upgraded here: it gets a tracked
      // session on its first refresh rather than being forced to re-login.
      let sessionId = claims.sid;
      if (sessionId) {
        if (!(await authService.isSessionActive(user.username, sessionId))) {
          response.status(401).json({ error: "unauthorized" });
          return;
        }
        await authService.touchSession(sessionId);
      } else {
        sessionId = randomUUID();
        await authService.createSession({
          sessionId,
          username: user.username,
          ...sessionContext(request),
        });
      }
      // Rotate both cookies, not just the access token: a refresh that only re-minted access
      // left the same refresh token valid for its full 7 days regardless of activity.
      issueSessionCookies(response, user, sessionId);
      response.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", async (request, response, next) => {
    try {
      // Revoke *this* session only (Phase 15E): delete the row its `sid` names, so the tokens
      // that carry it stop verifying, while the user's other devices stay signed in. This no
      // longer bumps tokenVersion — that "all devices" hammer now belongs to force-logout.
      // Identify the session from whichever token is still presented.
      const cookies = request.cookies as Record<string, string> | undefined;
      const refresh = cookies?.[REFRESH_COOKIE];
      const access = cookies?.[ACCESS_COOKIE];
      const claims =
        (refresh ? verifyToken(refresh, "refresh") : null) ??
        (access ? verifyToken(access, "access") : null);
      if (claims?.sid) {
        await authService.revokeSession(claims.sub, claims.sid);
      }
      if (claims) {
        void audit.record({ actor: claims.sub, action: "logout", requestId: request.requestId });
      }
      clearSessionCookies(response);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/change-password", authenticate, async (request, response, next) => {
    try {
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_request", detail: parsed.error.issues });
        return;
      }
      // `authenticate` guarantees request.user.
      const username = request.user!.username;
      const updated = await authService.changePassword(
        username,
        parsed.data.oldPassword,
        parsed.data.newPassword,
      );
      if (!updated) {
        response.status(400).json({ error: "invalid_credentials" });
        return;
      }
      // The change bumped tokenVersion and dropped every session (all devices). Re-establish a
      // fresh session for the initiating device and issue cookies at the new version, so the
      // caller stays signed in here while every other device is logged out.
      const sessionId = randomUUID();
      await authService.createSession({ sessionId, username, ...sessionContext(request) });
      issueSessionCookies(response, updated, sessionId);
      void audit.record({
        actor: username,
        action: "password_change",
        requestId: request.requestId,
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", authenticate, (request, response) => {
    response.json({ user: request.user });
  });

  // ── Own sessions (Phase 15E) ──────────────────────────────────────────────────
  router.get("/sessions", authenticate, async (request, response, next) => {
    try {
      const username = request.user!.username;
      const current = request.sessionId;
      const sessions = await authService.listSessions(username);
      response.json({
        sessions: sessions.map((session) => ({
          sessionId: session.sessionId,
          username: session.username,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          userAgent: session.userAgent,
          ip: session.ip,
          current: session.sessionId === current,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/sessions/:sessionId", authenticate, async (request, response, next) => {
    try {
      const username = request.user!.username;
      const sessionId = String(request.params.sessionId);
      const revoked = await authService.revokeSession(username, sessionId);
      if (!revoked) {
        response.status(404).json({ error: "not_found" });
        return;
      }
      void audit.record({
        actor: username,
        action: "session_revoke",
        target: sessionId,
        requestId: request.requestId,
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
