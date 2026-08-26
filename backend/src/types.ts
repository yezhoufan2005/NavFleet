/**
 * Backend domain types.
 *
 * The canonical definitions now live in `@navfleet/shared` (the single source
 * of truth shared with the frontend). This module re-exports them so existing
 * `./types` imports keep working. Add backend-only types here if ever needed.
 */
export type * from "@navfleet/shared";
