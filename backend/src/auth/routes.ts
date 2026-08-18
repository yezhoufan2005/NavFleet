import { Router, type CookieOptions } from "express";
import { config } from "../config";
import { loginSchema } from "../validation";
import type { AuthService } from "./service";
import { toPublicUser } from "./service";
import { ACCESS_COOKIE, REFRESH_COOKIE, authenticate } from "./middleware";
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
  return Number(match[1]) * DURATION_UNITS[match[2]];
};

const baseCookie = (): CookieOptions => ({
  httpOnly: true,
  sameSite: "lax",
  secure: config.cookieSecure,
});

export const buildAuthRouter = (authService: AuthService): Router => {
  const router = Router();

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
      const publicUser = toPublicUser(user);
      response.cookie(ACCESS_COOKIE, signAccessToken(publicUser), {
        ...baseCookie(),
        path: "/",
        maxAge: durationToMs(config.jwtAccessTtl) || undefined,
      });
      response.cookie(REFRESH_COOKIE, signRefreshToken(publicUser), {
        ...baseCookie(),
        path: "/api/auth",
        maxAge: durationToMs(config.jwtRefreshTtl) || undefined,
      });
      response.json({ user: publicUser });
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
      if (!user) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      const publicUser = toPublicUser(user);
      response.cookie(ACCESS_COOKIE, signAccessToken(publicUser), {
        ...baseCookie(),
        path: "/",
        maxAge: durationToMs(config.jwtAccessTtl) || undefined,
      });
      response.json({ user: publicUser });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", (_request, response) => {
    response.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: "/" });
    response.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: "/api/auth" });
    response.status(204).end();
  });

  router.get("/me", authenticate, (request, response) => {
    response.json({ user: request.user });
  });

  return router;
};
