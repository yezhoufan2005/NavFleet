import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import type { PublicUser, UserRecord, UserRole } from "../types";
import { capabilitiesForRole, type Capability } from "@navfleet/shared";
import { verifyToken } from "./tokens";

/**
 * Resolves a user's effective capabilities (1.6.1 RBAC). Takes only the fields the resolution
 * needs — the username (group membership), the base role (preset), and the kiosk flag (kiosk
 * accounts are never augmented by groups) — so both the JWT-derived identity and a full
 * `UserRecord` satisfy it.
 */
export type CapabilityResolver = (user: {
  username: string;
  role: UserRole;
  kiosk?: boolean;
}) => readonly Capability[];

declare module "express-serve-static-core" {
  interface Request {
    user?: PublicUser;
    /** The `sid` of the token that authenticated this request (Phase 15E), when it carried one. */
    sessionId?: string;
    /**
     * Effective capabilities of the authenticated user (1.6.1 RBAC). Resolved once here in the
     * auth gate — for now from the role preset; groups/custom-roles will fold in later — so
     * `requireCapability` and `GET /me` read one already-computed set rather than each deriving it.
     */
    capabilities?: readonly Capability[];
  }
}

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";

/** Look up the stored user, so the middleware can check `enabled` and `tokenVersion`. */
export type UserLookup = (username: string) => Promise<UserRecord | null>;

/**
 * Is this session still live? (Phase 15E.) Answered against the `sessions` collection; a
 * revoked session (logout / self-revoke / force-logout) returns false, which 401s the request
 * even though the token's signature, `enabled` and `tokenVersion` all still check out.
 */
export type SessionCheck = (username: string, sessionId: string) => Promise<boolean>;

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
 * Build the "require a valid session" middleware.
 *
 * Unlike a bare JWT check, this verifies the token **against the stored user** on every
 * request: it 401s when the account is gone, disabled, or the token's `ver` no longer matches
 * `tokenVersion`. That is what makes logout / password change / disable take effect
 * immediately rather than at token expiry. The cost is one indexed user read per authenticated
 * request — acceptable here because live data flows over one WebSocket, not REST polling.
 *
 * When AUTH_ENABLED=false, a synthetic admin is attached and no lookup happens (fully open
 * mode for local/dev — deliberately preserved).
 *
 * `isSessionActive` adds the Phase 15E per-session check: when the token names a session
 * (`sid`), that session must still exist. A token with no `sid` (minted before 15E) is
 * governed by `tokenVersion` alone, unchanged — so the upgrade forces no re-login.
 */
export const createAuthenticate =
  (
    lookupUser: UserLookup,
    isSessionActive?: SessionCheck,
    resolveCapabilities?: CapabilityResolver,
  ) =>
  (request: Request, response: Response, next: NextFunction): void => {
    // Effective-capability resolver. Defaults to the role preset alone (1.6.1 base); the app wires
    // in a group-aware resolver (custom roles + user groups) so grants take effect on the next
    // request without a re-login, mirroring the enabled/tokenVersion check already done here.
    const resolve: CapabilityResolver =
      resolveCapabilities ?? ((user) => capabilitiesForRole(user.role));
    if (!config.authEnabled) {
      request.user = { username: "anonymous", role: "admin" };
      request.capabilities = capabilitiesForRole("admin");
      next();
      return;
    }

    const token = extractAccessToken(request);
    const claims = token ? verifyToken(token, "access") : null;
    if (!claims) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }

    lookupUser(claims.sub)
      .then(async (user) => {
        if (!user || !user.enabled || user.tokenVersion !== claims.ver) {
          response.status(401).json({ error: "unauthorized" });
          return;
        }
        // Per-session revocation (Phase 15E): a token that names a session must still name a
        // live one. Only checked when the token carries a `sid` and a checker is wired.
        if (claims.sid && isSessionActive && !(await isSessionActive(claims.sub, claims.sid))) {
          response.status(401).json({ error: "unauthorized" });
          return;
        }
        // Role comes from the token, which we signed at login from the user's role — the
        // lookup above only gates revocation (account gone / disabled / version bumped).
        request.user = { username: claims.sub, role: claims.role };
        request.sessionId = claims.sid;
        // Effective capabilities for this request (1.6.1): base role preset ∪ the user's groups'
        // roles. Role + username come from the token (a role change bumps tokenVersion → re-login,
        // so the token is authoritative here); kiosk comes from the reloaded record.
        request.capabilities = resolve({
          username: claims.sub,
          role: claims.role,
          kiosk: user.kiosk,
        });
        next();
      })
      .catch(next);
  };

export const requireCapability =
  (capability: Capability) =>
  (request: Request, response: Response, next: NextFunction): void => {
    if (!request.user) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!request.capabilities?.includes(capability)) {
      response.status(403).json({ error: "forbidden", requiredCapability: capability });
      return;
    }
    next();
  };
