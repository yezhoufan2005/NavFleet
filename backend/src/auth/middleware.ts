import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import type { PublicUser, UserRole } from "../types";
import { verifyToken } from "./tokens";

declare module "express-serve-static-core" {
  interface Request {
    user?: PublicUser;
  }
}

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";

const extractAccessToken = (request: Request): string => {
  const cookieToken = (request.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  if (cookieToken) {
    return cookieToken;
  }
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return "";
};

/**
 * Require a valid access token. When AUTH_ENABLED=false, a synthetic admin is
 * attached so downstream role checks pass (fully open mode for local/dev).
 */
export const authenticate = (request: Request, response: Response, next: NextFunction): void => {
  if (!config.authEnabled) {
    request.user = { username: "anonymous", role: "admin" };
    next();
    return;
  }

  const token = extractAccessToken(request);
  const claims = token ? verifyToken(token, "access") : null;
  if (!claims) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  request.user = { username: claims.sub, role: claims.role };
  next();
};

export const requireRole =
  (...roles: UserRole[]) =>
  (request: Request, response: Response, next: NextFunction): void => {
    if (!request.user) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!roles.includes(request.user.role)) {
      response.status(403).json({ error: "forbidden", requiredRoles: roles });
      return;
    }
    next();
  };
