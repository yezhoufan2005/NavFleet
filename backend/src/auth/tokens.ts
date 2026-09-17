import jwt from "jsonwebtoken";
import { config } from "../config";
import type { PublicUser, UserRole } from "../types";

export type TokenType = "access" | "refresh";

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
): string =>
  jwt.sign(
    { role: user.role, type, ver: tokenVersion } satisfies Omit<TokenClaims, "sub">,
    secret(),
    {
      subject: user.username,
      algorithm: "HS256",
      expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
    },
  );

export const signAccessToken = (user: PublicUser, tokenVersion: number): string =>
  signToken(user, tokenVersion, "access", config.jwtAccessTtl);

export const signRefreshToken = (user: PublicUser, tokenVersion: number): string =>
  signToken(user, tokenVersion, "refresh", config.jwtRefreshTtl);

export const verifyToken = (token: string, expectedType: TokenType): TokenClaims | null => {
  try {
    const decoded = jwt.verify(token, secret(), { algorithms: ["HS256"] });
    if (typeof decoded === "string" || !decoded.sub) {
      return null;
    }
    const claims = decoded as jwt.JwtPayload & { role?: UserRole; type?: TokenType; ver?: number };
    if (claims.type !== expectedType || !claims.role) {
      return null;
    }
    return {
      sub: String(claims.sub),
      role: claims.role,
      type: claims.type,
      ver: typeof claims.ver === "number" ? claims.ver : 0,
    };
  } catch {
    return null;
  }
};
