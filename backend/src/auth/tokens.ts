import jwt from "jsonwebtoken";
import { config } from "../config";
import type { PublicUser, UserRole } from "../types";

export type TokenType = "access" | "refresh";

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a duration like "15m" / "7d" into milliseconds; falls back to 0 on a malformed value.
 * Shared by the cookie `maxAge` (routes) and the session `expiresAt` (service) so the token,
 * its cookie and its session row all expire on the same clock.
 */
export const durationToMs = (value: string): number => {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    return 0;
  }
  const [, amount = "0", unit = ""] = match;
  const scale = DURATION_UNITS[unit];
  return scale === undefined ? 0 : Number(amount) * scale;
};

export interface TokenClaims {
  sub: string;
  role: UserRole;
  type: TokenType;
  /**
   * The user's `tokenVersion` at mint time. The auth middleware rejects a token whose `ver`
   * no longer matches the stored user, which is how logout / password change / a version bump
   * invalidate already-issued tokens. Tokens minted before this field existed decode as 0,
   * matching a freshly-migrated user's `tokenVersion: 0`, so a deploy does not force re-login.
   */
  ver: number;
  /**
   * The session id (Phase 15E): one per login, shared by that login's access and refresh
   * tokens and preserved across refresh. The auth middleware requires it to still name a live
   * `sessions` row, which is how per-session logout / self-revoke / force-logout invalidate a
   * specific token rather than every token the user holds. Optional because tokens minted
   * before this field existed carry none — those are governed by `ver` alone, exactly as
   * before, and expire within a refresh TTL of the deploy (mirrors how `ver` defaults to 0).
   */
  sid?: string;
}

const secret = (): string => {
  if (config.jwtSecret) {
    return config.jwtSecret;
  }
  // Ephemeral secret: tokens survive within a single process only. Acceptable
  // for local/dev; production is required to set JWT_SECRET (enforced at startup
  // by AuthService.initialize()).
  return EPHEMERAL_SECRET;
};

const EPHEMERAL_SECRET = `ephemeral-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const signToken = (
  user: PublicUser,
  tokenVersion: number,
  type: TokenType,
  expiresIn: string,
  sessionId?: string,
): string =>
  jwt.sign(
    {
      role: user.role,
      type,
      ver: tokenVersion,
      ...(sessionId ? { sid: sessionId } : {}),
    } satisfies Omit<TokenClaims, "sub">,
    secret(),
    {
      subject: user.username,
      algorithm: "HS256",
      expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
    },
  );

export const signAccessToken = (
  user: PublicUser,
  tokenVersion: number,
  sessionId?: string,
): string => signToken(user, tokenVersion, "access", config.jwtAccessTtl, sessionId);

export const signRefreshToken = (
  user: PublicUser,
  tokenVersion: number,
  sessionId?: string,
): string => signToken(user, tokenVersion, "refresh", config.jwtRefreshTtl, sessionId);

export const verifyToken = (token: string, expectedType: TokenType): TokenClaims | null => {
  try {
    const decoded = jwt.verify(token, secret(), { algorithms: ["HS256"] });
    if (typeof decoded === "string" || !decoded.sub) {
      return null;
    }
    const claims = decoded as jwt.JwtPayload & {
      role?: UserRole;
      type?: TokenType;
      ver?: number;
      sid?: string;
    };
    if (claims.type !== expectedType || !claims.role) {
      return null;
    }
    return {
      sub: String(claims.sub),
      role: claims.role,
      type: claims.type,
      ver: typeof claims.ver === "number" ? claims.ver : 0,
      ...(typeof claims.sid === "string" && claims.sid ? { sid: claims.sid } : {}),
    };
  } catch {
    return null;
  }
};
