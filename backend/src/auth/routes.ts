import { Router, type CookieOptions, type Response } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { changePasswordSchema, loginSchema, profileUpdateSchema } from "../validation";
import type { AuditEntry, UserRecord } from "../types";
import {
  capabilitiesForRole,
  type AccountActivity,
  type AccountProfile,
  type AuditAction,
} from "@navfleet/shared";
import type { AuthService } from "./service";
import { toPublicUser } from "./service";
import type { AuditService } from "../audit/service";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  createAuthenticate,
  type CapabilityResolver,
} from "./middleware";
import { durationToMs, signAccessToken, signRefreshToken, verifyToken } from "./tokens";
import { respondValidationError } from "../routes/helpers";

const baseCookie = (): CookieOptions => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.cookieSecure,
});

/**
 * Issue fresh access + refresh cookies for a user, both carrying the session id `sid` so the
 * per-request auth check can tie them to a live session row. The refresh cookie is
 * scoped to `/api/auth` so it is not sent with every API call, and both carry the user's
 * current `tokenVersion` so a later bump invalidates them. Called on login, on refresh
 * (rotation, same `sid`), and after a self password change (a fresh `sid`).
 */
/** The refresh horizon for a user: a kiosk account lives far longer than 7d. */
const refreshTtlFor = (user: UserRecord): string =>
  user.kiosk ? config.kioskRefreshTtl : config.jwtRefreshTtl;

const issueSessionCookies = (response: Response, user: UserRecord, sessionId: string): void => {
  const publicUser = toPublicUser(user);
  const refreshTtl = refreshTtlFor(user);
  response.cookie(ACCESS_COOKIE, signAccessToken(publicUser, user.tokenVersion, sessionId), {
    ...baseCookie(),
    path: "/",
    maxAge: durationToMs(config.jwtAccessTtl) || undefined,
  });
  response.cookie(
    REFRESH_COOKIE,
    signRefreshToken(publicUser, user.tokenVersion, sessionId, refreshTtl),
    {
      ...baseCookie(),
      path: "/api/auth",
      maxAge: durationToMs(refreshTtl) || undefined,
    },
  );
};

/** 个人中心's account view of a stored user (no hash, no lockout or token internals). */
const toAccountProfile = (user: UserRecord, groups: string[]): AccountProfile => ({
  ...toPublicUser(user),
  displayName: user.displayName,
  email: user.email,
  phone: user.phone,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
  passwordUpdatedAt: user.passwordUpdatedAt,
  kiosk: user.kiosk === true,
  groups,
});

/** Account events a user did themselves, shown in their 账户活动. */
const OWN_ACCOUNT_ACTIONS: AuditAction[] = [
  "login",
  "login_failed",
  "account_locked",
  "logout",
  "password_change",
  "session_revoke",
  "profile_update",
];
/** Account events an administrator did *to* a user, shown in that user's 账户活动 as well. */
const DONE_TO_ACCOUNT_ACTIONS: AuditAction[] = ["password_reset", "force_logout", "user_update"];
/** How many 账户活动 rows the page gets — a recent window, not the audit trail. */
export const ACCOUNT_ACTIVITY_LIMIT = 20;

const toActivity = (entry: AuditEntry): AccountActivity => {
  const detail = entry.detail ?? {};
  return {
    ts: entry.ts.toISOString(),
    action: entry.action,
    outcome: entry.outcome,
    actor: entry.actor,
    ...(typeof detail.ip === "string" && detail.ip ? { ip: detail.ip } : {}),
    ...(typeof detail.userAgent === "string" && detail.userAgent
      ? { userAgent: detail.userAgent }
      : {}),
  };
};

/** Fields whose old and new values go into a `profile_update` row. Contact details are named only. */
const PROFILE_VALUE_FIELDS = new Set(["displayName"]);

const clearSessionCookies = (response: Response): void => {
  response.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: "/" });
  response.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: "/api/auth" });
};

export const buildAuthRouter = (
  authService: AuthService,
  audit: AuditService,
  resolveCapabilities?: CapabilityResolver,
  /** The names of the groups a user belongs to, for 个人中心; none when the app wires no RBAC. */
  groupsOf: (username: string) => string[] = () => [],
): Router => {
  const router = Router();
  // Effective-capability resolver, threaded into the /me gate and the login/refresh responses so
  // the client's capabilities include group grants, not just the base role preset. Defaults to the
  // role preset when the app wires none (keeps tests and the base case working).
  const resolveCaps: CapabilityResolver =
    resolveCapabilities ?? ((user) => capabilitiesForRole(user.role));
  const authenticate = createAuthenticate(
    (username) => authService.findByUsername(username),
    (username, sessionId) => authService.isSessionActive(username, sessionId),
    resolveCapabilities,
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

  router.post("/login", async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const result = await authService.authenticate(parsed.data.username, parsed.data.password);
    // Where the attempt came from, on every sign-in row: it is what lets someone reading their own
    // 账户活动 tell their own failed attempt from a stranger's.
    const origin = sessionContext(request);
    if (!result.ok) {
      void audit.record({
        actor: parsed.data.username,
        action: "login_failed",
        outcome: "failure",
        requestId: request.requestId,
        detail: origin,
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
          detail: origin,
        });
      }
      response.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const user = result.user;
    const sessionId = randomUUID();
    await authService.createSession(
      {
        sessionId,
        username: user.username,
        ...origin,
      },
      user.kiosk,
    );
    await authService.recordLogin(user.username);
    // Tag a kiosk login so the audit trail can tell an unattended wall screen from a person.
    void audit.record({
      actor: user.username,
      action: "login",
      requestId: request.requestId,
      detail: { ...origin, ...(user.kiosk ? { kiosk: true } : {}) },
    });
    issueSessionCookies(response, user, sessionId);
    response.json({ user: toPublicUser(user), capabilities: resolveCaps(user) });
  });

  router.post("/refresh", async (request, response) => {
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
    // A legacy token with no `sid` (minted before sessions were tracked) is upgraded here: it
    // gets a tracked session on its first refresh rather than being forced to re-login.
    let sessionId = claims.sid;
    if (sessionId) {
      if (!(await authService.isSessionActive(user.username, sessionId))) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      await authService.touchSession(sessionId, user.kiosk);
    } else {
      sessionId = randomUUID();
      await authService.createSession(
        {
          sessionId,
          username: user.username,
          ...sessionContext(request),
        },
        user.kiosk,
      );
    }
    // Rotate both cookies, not just the access token: a refresh that only re-minted access
    // left the same refresh token valid for its full 7 days regardless of activity.
    issueSessionCookies(response, user, sessionId);
    response.json({ user: toPublicUser(user), capabilities: resolveCaps(user) });
  });

  router.post("/logout", async (request, response) => {
    // Revoke *this* session only: delete the row its `sid` names, so the tokens
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
  });

  router.post("/change-password", authenticate, async (request, response) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
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
  });

  router.get("/me", authenticate, (request, response) => {
    // `authenticate` resolved the effective capabilities (1.6.1); hand them to the client so it
    // can gate controls with `can(...)` rather than re-deriving them from the role.
    response.json({ user: request.user, capabilities: request.capabilities ?? [] });
  });

  // ── Own account (个人中心) ──────────────────────────────────────────
  router.get("/profile", authenticate, async (request, response) => {
    const username = request.user!.username;
    const user = await authService.findByUsername(username);
    if (!user) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    response.json({ profile: toAccountProfile(user, groupsOf(username)) });
  });

  // A user edits their own contact fields; role and enabled stay with `users:manage`.
  router.patch("/profile", authenticate, async (request, response) => {
    const parsed = profileUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      respondValidationError(response, parsed.error);
      return;
    }
    const username = request.user!.username;
    const result = await authService.updateProfile(username, parsed.data);
    if (!result) {
      response.status(404).json({ error: "not_found" });
      return;
    }
    const { before, after } = result;
    const changed = (Object.keys(parsed.data) as Array<keyof typeof parsed.data>).filter(
      (key) => (before[key] ?? null) !== (parsed.data[key] ?? null),
    );
    if (changed.length > 0) {
      void audit.record({
        actor: username,
        action: "profile_update",
        target: username,
        requestId: request.requestId,
        detail: {
          fields: changed,
          changes: Object.fromEntries(
            changed
              .filter((key) => PROFILE_VALUE_FIELDS.has(key))
              .map((key) => [key, { from: before[key] ?? null, to: parsed.data[key] ?? null }]),
          ),
        },
      });
    }
    response.json({ profile: toAccountProfile(after, groupsOf(username)) });
  });

  // The user's own recent account events: what they did, and what an administrator did to them.
  // Not the audit trail — no `audit:read` needed, and nothing about anyone else.
  router.get("/activity", authenticate, async (request, response) => {
    const username = request.user!.username;
    const [own, doneTo] = await Promise.all([
      audit.query({ actor: username, action: OWN_ACCOUNT_ACTIONS }),
      audit.query({ target: username, action: DONE_TO_ACCOUNT_ACTIONS }),
    ]);
    const items = [...own, ...doneTo]
      .sort((left, right) => right.ts.getTime() - left.ts.getTime())
      .slice(0, ACCOUNT_ACTIVITY_LIMIT)
      .map(toActivity);
    response.json({ items });
  });

  // ── Own sessions ──────────────────────────────────────────────────
  router.get("/sessions", authenticate, async (request, response) => {
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
  });

  // 下线其他设备: end every session but the one making the request.
  router.delete("/sessions", authenticate, async (request, response) => {
    const username = request.user!.username;
    const current = request.sessionId;
    if (!current) {
      // A token with no session id (auth disabled, or a pre-session token): there is no "this
      // device" to keep, and ending everything is what 退出 is for.
      response.status(409).json({ error: "no_current_session" });
      return;
    }
    const ended = await authService.revokeOtherSessions(username, current);
    if (ended > 0) {
      void audit.record({
        actor: username,
        action: "session_revoke",
        requestId: request.requestId,
        detail: { others: ended },
      });
    }
    response.json({ ended });
  });

  router.delete("/sessions/:sessionId", authenticate, async (request, response) => {
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
  });

  return router;
};
