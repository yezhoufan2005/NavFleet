/**
 * Backend domain types.
 *
 * The contracts **shared with the frontend** live in `@navfleet/shared` (the single
 * source of truth) and are re-exported here so existing `./types` imports keep working.
 * Types that only this process has any use for are declared below.
 */
import type { UserRole } from "@navfleet/shared";

export type * from "@navfleet/shared";

/**
 * One row of the `users` collection.
 *
 * Backend-only on purpose, and it did not start that way: this sat in `@navfleet/shared`
 * between `UserRole` and `PublicUser`, in a package whose own header describes it as the
 * model "shared between the backend and the frontend" — while no frontend file has ever
 * imported it. Nothing leaked, because the package is consumed type-only; what a
 * `passwordHash` field does from over there is invite the next person to plumb the stored
 * shape into a component. `persistence.ts` reads and writes this, and `auth/service.ts`
 * narrows it to `PublicUser` before it can reach a response body.
 */
export interface UserRecord {
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}
