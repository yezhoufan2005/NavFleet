import type { Db } from "mongodb";
import type { Logger } from "pino";
import { migrations as defaultMigrations, assertMigrationsWellFormed } from "./index";
import {
  MigrationError,
  MIGRATIONS_COLLECTION,
  type Migration,
  type MigrationRecord,
} from "./types";

/** Collections whose presence means "this is an existing 1.1.0 database", used for baselining. */
const CORE_COLLECTIONS = ["device_latest", "alerts", "users"];

/** The current schema version = the highest applied marker, or 0 when none have run. */
const currentVersion = async (db: Db): Promise<number> => {
  const marker = await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .find({}, { projection: { _id: 0, version: 1 } })
    .sort({ version: -1 })
    .limit(1)
    .toArray();
  return marker[0]?.version ?? 0;
};

const recordApplied = async (db: Db, version: number, name: string): Promise<void> => {
  await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .updateOne(
      { version },
      { $set: { version, name, appliedAt: new Date().toISOString() } },
      { upsert: true },
    );
};

/**
 * Decide the starting point for a database that has **no** migration markers yet. A fresh,
 * empty database starts at 0 and runs every migration. A database that predates this
 * mechanism (a deployed 1.1.0) already has its structure — created by
 * `ensureMongoCollections` — so it is baselined to the first migration's version without
 * re-running that migration's `up`: we record the marker and continue from there. The
 * discriminator is the presence of any core collection.
 */
const baselineIfPreexisting = async (
  db: Db,
  list: readonly Migration[],
  logger: Logger,
): Promise<number> => {
  const existing = await db.listCollections({}, { nameOnly: true }).toArray();
  const names = new Set(existing.map((item) => item.name));
  const looksPreexisting = CORE_COLLECTIONS.some((name) => names.has(name));
  const baseline = list[0];
  if (!looksPreexisting || !baseline) {
    return 0;
  }
  await recordApplied(db, baseline.version, baseline.name);
  logger.info(
    { version: baseline.version },
    "Existing database detected without migration markers; baselined to the initial schema version",
  );
  return baseline.version;
};

/**
 * Apply every migration whose version is greater than the database's current version, in
 * order, recording each marker only after its `up` resolves. Returns the version the
 * database is at when done.
 *
 * On any `up` failure it throws a {@link MigrationError} and does **not** run later
 * migrations — the composition root turns that into a refuse-to-start (a half-migrated
 * database must not be served). Because there is no transaction spanning `up` and the marker
 * write, each `up` must be idempotent so an interrupted run is safe to repeat.
 *
 * `list` is injectable for tests; production passes the real, load-time-validated list.
 */
export const runMigrations = async (
  db: Db,
  logger: Logger,
  list: readonly Migration[] = defaultMigrations,
): Promise<number> => {
  assertMigrationsWellFormed(list);

  let version = await currentVersion(db);
  if (version === 0) {
    version = await baselineIfPreexisting(db, list, logger);
  }

  const pending = list.filter((migration) => migration.version > version);
  if (pending.length === 0) {
    logger.debug({ version }, "Schema up to date; no migrations to apply");
    return version;
  }

  logger.info(
    { from: version, to: list[list.length - 1]?.version, count: pending.length },
    "Applying schema migrations",
  );

  for (const migration of pending) {
    try {
      await migration.up(db);
    } catch (error) {
      throw new MigrationError(migration.version, migration.name, error);
    }
    await recordApplied(db, migration.version, migration.name);
    version = migration.version;
    logger.info({ version, name: migration.name }, "Applied migration");
  }

  return version;
};
