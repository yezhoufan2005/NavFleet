import type { Db } from "mongodb";

/**
 * One forward schema migration.
 *
 * Forward-only on purpose: this is a single-instance, read-only monitoring system, and the
 * documented upgrade path is "back up, then upgrade" (see `deploy/docs/deployment.md`).
 * A restore from that backup is a more reliable rollback than a hand-written `down` that
 * has to anticipate every partial-failure state — so we do not maintain one.
 *
 * `up` MUST be idempotent. There is no cross-document transaction wrapping the `up` call and
 * the version-marker write (see `runner.ts`), so a process killed between the two re-runs the
 * same `up` on the next start. Writing each `up` to tolerate "already done" is what makes that
 * safe, and it is also what lets the very first migration double as a baseline for an existing
 * 1.1.0 database whose collections were created by `ensureMongoCollections`.
 */
export interface Migration {
  /** Monotonic, gap-free, starting at 1. Asserted at load time in `index.ts`. */
  readonly version: number;
  /** Short human label, recorded alongside the version. */
  readonly name: string;
  up(db: Db): Promise<void>;
}

/** A document in the `schema_migrations` collection: one per applied migration. */
export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
}

/**
 * Thrown when a migration's `up` fails. Carries the offending version/name so the
 * composition root can log which migration blocked startup. Distinct from a plain
 * connection failure so `index.ts` can treat "migration errored" (fatal: refuse to
 * start) differently from "MongoDB unreachable" (degrade + retry).
 */
export class MigrationError extends Error {
  constructor(
    readonly version: number,
    readonly migrationName: string,
    cause: unknown,
  ) {
    super(
      `Migration ${version} (${migrationName}) failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "MigrationError";
  }
}

/** The collection holding the applied-migration markers. */
export const MIGRATIONS_COLLECTION = "schema_migrations";
