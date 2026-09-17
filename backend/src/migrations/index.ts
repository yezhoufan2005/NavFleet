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
 * anything (see `runner.ts`). Real structural changes start at version 2 in Phase 15B+.
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "baseline-1.1.0",
    up: async () => {
      // No-op: the 1.1.0 schema is owned by `ensureMongoCollections`. This entry exists so
      // that "current version" has a definite value from which 15B+ migrations count.
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
