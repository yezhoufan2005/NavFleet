import { Router, type CookieOptions, type Response } from "express";
import { config } from "../config";
import { changePasswordSchema, loginSchema } from "../validation";
import type { UserRecord } from "../types";
import type { AuthService } from "./service";
import { toPublicUser } from "./service";
import { ACCESS_COOKIE, REFRESH_COOKIE, createAuthenticate } from "./middleware";
import { signAccessToken, signRefreshToken, verifyToken } from "./tokens";

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a duration like "15m" / "7d" into milliseconds; falls back to 0. */
const durationToMs = (value: string): number => {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    return 0;
  }
  const [, amount = "0", unit = ""] = match;
  // The `undefined` arm is reachable only if the pattern and the table above ever
  // disagree on the unit vocabulary — which is a bug worth a branch, not a cast.
  const scale = DURATION_UNITS[unit];
  return scale === undefined ? 0 : Number(amount) * scale;
};

const baseCookie = (): CookieOptions => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.cookieSecure,
});

/**
 * Issue fresh access + refresh cookies for a user. The refresh cookie is scoped to
 * `/api/auth` so it is not sent with every API call, and both carry the user's current
 * `tokenVersion` so a later bump invalidates them. Called on login, on refresh (rotation),
 * and after a self password change (so the initiating session survives its own bump).
 */
const issueSessionCookies = (response: Response, user: UserRecord): void => {
  const publicUser = toPublicUser(user);
  response.cookie(ACCESS_COOKIE, signAccessToken(publicUser, user.tokenVersion), {
    ...baseCookie(),
    path: "/",
    maxAge: durationToMs(config.jwtAccessTtl) || undefined,
  });
  response.cookie(REFRESH_COOKIE, signRefreshToken(publicUser, user.tokenVersion), {
    ...baseCookie(),
    path: "/api/auth",
    maxAge: durationToMs(config.jwtRefreshTtl) || undefined,
  });
};

const clearSessionCookies = (response: Response): void => {
  response.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: "/" });
  response.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: "/api/auth" });
};

export const buildAuthRouter = (authService: AuthService): Router => {
  const router = Router();
  const authenticate = createAuthenticate((username) => authService.findByUsername(username));

  router.post("/login", async (request, response, next) => {
    try {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_request" });
        return;
      }
      const user = await authService.authenticate(parsed.data.username, parsed.data.password);
      if (!user) {
        response.status(401).json({ error: "invalid_credentials" });
        return;
      }
      await authService.recordLogin(user.username);
      issueSessionCookies(response, user);
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
      // (logout / password change happened since this refresh token was minted).
      if (!user || !user.enabled || user.tokenVersion !== claims.ver) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      // Rotate both cookies, not just the access token: a refresh that only re-minted access
      // left the same refresh token valid for its full 7 days regardless of activity.
      issueSessionCookies(response, user);
      response.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", async (request, response, next) => {
    try {
      // Bump the version so the just-cleared tokens cannot be replayed if they were captured.
      // Identify the user from whichever token is still presented; if neither verifies there is
      // nothing to invalidate. This ends *all* of that user's sessions (tokenVersion is
      // per-user) — per-session logout is Phase 15E.
      const cookies = request.cookies as Record<string, string> | undefined;
      const refresh = cookies?.[REFRESH_COOKIE];
      const access = cookies?.[ACCESS_COOKIE];
      const claims =
        (refresh ? verifyToken(refresh, "refresh") : null) ??
        (access ? verifyToken(access, "access") : null);
      if (claims) {
        await authService.invalidateSessions(claims.sub);
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
      // The change bumped tokenVersion, invalidating the caller's current cookies too —
      // re-issue at the new version so the initiating session stays signed in.
      issueSessionCookies(response, updated);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", authenticate, (request, response) => {
    response.json({ user: request.user });
  });

  return router;
};
