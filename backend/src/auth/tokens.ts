import jwt from "jsonwebtoken";
import { config } from "../config";
import type { PublicUser, UserRole } from "../types";

export type TokenType = "access" | "refresh";

export interface TokenClaims {
  sub: string;
  role: UserRole;
  type: TokenType;
}

const secret = (): string => {
  if (config.jwtSecret) {
    return config.jwtSecret;
  }
  // Ephemeral secret: tokens survive within a single process only. Acceptable
  // for local/dev; production must set JWT_SECRET (validated at startup).
  return EPHEMERAL_SECRET;
};

const EPHEMERAL_SECRET = `ephemeral-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const signToken = (user: PublicUser, type: TokenType, expiresIn: string): string =>
  jwt.sign({ role: user.role, type } satisfies Omit<TokenClaims, "sub">, secret(), {
    subject: user.username,
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
  });

export const signAccessToken = (user: PublicUser): string =>
  signToken(user, "access", config.jwtAccessTtl);

export const signRefreshToken = (user: PublicUser): string =>
  signToken(user, "refresh", config.jwtRefreshTtl);

export const verifyToken = (token: string, expectedType: TokenType): TokenClaims | null => {
  try {
    const decoded = jwt.verify(token, secret());
    if (typeof decoded === "string" || !decoded.sub) {
      return null;
    }
    const claims = decoded as jwt.JwtPayload & { role?: UserRole; type?: TokenType };
    if (claims.type !== expectedType || !claims.role) {
      return null;
    }
    return { sub: String(claims.sub), role: claims.role, type: claims.type };
  } catch {
    return null;
  }
};
