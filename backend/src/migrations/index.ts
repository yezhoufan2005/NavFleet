import type { Migration } from "./types";

/**
 * The ordered migration list — the single source of truth for schema versions.
 *
 * **Append only, never edit or reorder a shipped entry.** A deployed database records the
 * versions it has applied; changing the meaning of an already-applied version would leave
 * those databases silently on a definition that no longer matches the code.
 *
 * Version 1 is the **baseline**: the schema as it stood at 1.1.0, already materialised by
 * `ensureMongoCollections` (collections + indexes + TTL). Its `up` therefore does nothing —
 * a fresh empty database has its structure created by `ensureMongoCollections` on the same
 * connect, and an existing 1.1.0 database is baselined to version 1 without re-running
 * anything (see `runner.ts`). Real structural changes start at version 2.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "baseline-1.1.0",
    up: async () => {
      // No-op: the 1.1.0 schema is owned by `ensureMongoCollections`. This entry exists so
      // that "current version" has a definite value from which later migrations count.
    },
  },
  {
    version: 2,
    name: "expand-user-model",
    up: async (db) => {
      // Backfill the expanded user fields onto rows that predate them. Scoped to rows
      // missing `tokenVersion` so a re-run touches nothing, and written as an aggregation
      // pipeline so each default can derive from an existing field (`displayName` from
      // `username`, `passwordUpdatedAt` from `createdAt`) in one pass.
      await db.collection("users").updateMany({ tokenVersion: { $exists: false } }, [
        {
          $set: {
            enabled: { $ifNull: ["$enabled", true] },
            tokenVersion: { $ifNull: ["$tokenVersion", 0] },
            displayName: { $ifNull: ["$displayName", "$username"] },
            email: { $ifNull: ["$email", null] },
            phone: { $ifNull: ["$phone", null] },
            lastLoginAt: { $ifNull: ["$lastLoginAt", null] },
            passwordUpdatedAt: { $ifNull: ["$passwordUpdatedAt", "$createdAt"] },
          },
        },
      ]);
    },
  },
  {
    version: 3,
    name: "add-login-lockout-fields",
    up: async (db) => {
      // Backfill the account-lockout fields onto rows that predate them. Scoped to
      // rows missing `failedAttempts` so a re-run touches nothing, and written as an aggregation
      // pipeline with `$ifNull` so the defaults are set only where absent — the same idempotent
      // shape as v2.
      await db.collection("users").updateMany({ failedAttempts: { $exists: false } }, [
        {
          $set: {
            failedAttempts: { $ifNull: ["$failedAttempts", 0] },
            lockedUntil: { $ifNull: ["$lockedUntil", null] },
          },
        },
      ]);
    },
  },
  {
    version: 4,
    name: "add-alert-ack-fields",
    up: async (db) => {
      // Backfill the acknowledgement fields onto alert rows that predate them.
      // Scoped to rows missing `ackedBy` so a re-run touches nothing; `$ifNull` sets each
      // default only where absent — the same idempotent shape as v2/v3. Existing rows are
      // historical, so they backfill as unacknowledged (null).
      await db.collection("alerts").updateMany({ ackedBy: { $exists: false } }, [
        {
          $set: {
            ackedBy: { $ifNull: ["$ackedBy", null] },
            ackedAt: { $ifNull: ["$ackedAt", null] },
            comment: { $ifNull: ["$comment", null] },
          },
        },
      ]);
    },
  },
  {
    version: 5,
    name: "rename-alert-ack-to-disposition",
    up: async (db) => {
      // The message redesign splits acknowledgement into a disposition axis. The old
      // `ackedBy`/`ackedAt`/`comment` (whose meaning was "confirmed") become the **ignore** fields;
      // `claimedBy`/`claimedAt` (the new "investigating" state) and the optimistic-lock `version`
      // are added. Scoped to rows missing `version` so a re-run touches nothing (idempotent, the
      // same shape as earlier migrations); `$ifNull` carries each old value across and defaults the
      // new fields.
      await db.collection("alerts").updateMany({ version: { $exists: false } }, [
        {
          $set: {
            ignoredBy: { $ifNull: ["$ackedBy", null] },
            ignoredAt: { $ifNull: ["$ackedAt", null] },
            ignoreReason: { $ifNull: ["$comment", null] },
            claimedBy: { $ifNull: ["$claimedBy", null] },
            claimedAt: { $ifNull: ["$claimedAt", null] },
            version: { $ifNull: ["$version", 0] },
          },
        },
        { $unset: ["ackedBy", "ackedAt", "comment"] },
      ]);
    },
  },
];

/**
 * Fail fast at module load if the list is ever left in a shape the runner relies on:
 * versions must start at 1, increase by exactly 1, and be unique. A gap or a duplicate is a
 * programming error that would otherwise surface as a confusing runtime skip.
 */
export const assertMigrationsWellFormed = (list: readonly Migration[]): void => {
  list.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `Migration list is malformed at index ${index}: expected version ${expected}, got ${migration.version} (${migration.name}). Versions must start at 1 and be gap-free.`,
      );
    }
  });
};

assertMigrationsWellFormed(migrations);
