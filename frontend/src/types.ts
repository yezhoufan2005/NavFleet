/**
 * Frontend domain types.
 *
 * The canonical definitions now live in `@navfleet/shared` (the single source
 * of truth shared with the backend). This module re-exports them so existing
 * `../types` imports keep working, ending the previous hand-mirrored duplicate.
 */
export type * from "@navfleet/shared";
