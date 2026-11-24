import type { Request } from "express";
import type { RankedUser, UserRole } from "@navfleet/shared";
import type { RbacService } from "../rbac/service";

/**
 * The two sides of the user-management hierarchy rule (`canManageUser` in shared). `users:manage`
 * can reach a non-admin through a group, so every user and RBAC write compares the caller against
 * its target: the caller as the auth gate resolved it, the target with its own effective
 * capabilities (base role ∪ groups).
 */
export const actorOf = (request: Request): RankedUser => ({
  username: request.user!.username,
  role: request.user!.role,
  capabilities: request.capabilities ?? [],
});

export const rankedUser = (
  rbac: RbacService,
  user: { username: string; role: UserRole; kiosk?: boolean },
): RankedUser => ({
  username: user.username,
  role: user.role,
  capabilities: rbac.resolveCapabilities(user),
});
