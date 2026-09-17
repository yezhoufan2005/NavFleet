import type { Db } from "mongodb";
import type { Logger } from "pino";

/** The two retention windows this reconciler enforces, in seconds. */
export interface TtlConfig {
  telemetryRetentionSeconds: number;
  alertsRetentionSeconds: number;
}

/**
 * Bring the two data-retention TTLs in line with the current config on a database whose
 * collections already exist.
 *
 * The bug this fixes: `expireAfterSeconds` for `telemetry_ts` and for the `alerts.lastSeenAt`
 * index was only ever set in the create branch of `ensureMongoCollections`. On any database
 * that already had the collections — i.e. every real deployment after first boot — changing
 * `TELEMETRY_RETENTION_SECONDS` or `ALERTS_RETENTION_SECONDS` did nothing, while the docs said
 * it did. Reconciling here (called from `ensureMongoCollections`, so on every connect) makes a
 * retention change take effect on the next restart.
 *
 * Idempotent and safe to run whether or not the collections exist: a missing collection or a
 * value that already matches is left alone, so no `collMod` is issued unless something differs.
 *
 * `alerts` uses `collMod` on the existing TTL index rather than a second `createIndex` with a
 * new `expireAfterSeconds`: MongoDB rejects the latter as an `IndexOptionsConflict`, which —
 * thrown from `ensureMongoCollections` — would fail the connect and drop the backend into its
 * in-memory fallback. `collMod` changes the TTL in place.
 */
export const reconcileTtls = async (db: Db, ttl: TtlConfig, logger: Logger): Promise<void> => {
  const telemetryCurrent = await timeseriesExpireSeconds(db);
  if (telemetryCurrent !== null && telemetryCurrent !== ttl.telemetryRetentionSeconds) {
    await db.command({
      collMod: "telemetry_ts",
      expireAfterSeconds: ttl.telemetryRetentionSeconds,
    });
    logger.info(
      { from: telemetryCurrent, to: ttl.telemetryRetentionSeconds },
      "Reconciled telemetry_ts TTL to configured retention",
    );
  }

  const alertsCurrent = await alertsIndexExpireSeconds(db);
  if (alertsCurrent !== null && alertsCurrent !== ttl.alertsRetentionSeconds) {
    await db.command({
      collMod: "alerts",
      index: { keyPattern: { lastSeenAt: 1 }, expireAfterSeconds: ttl.alertsRetentionSeconds },
    });
    logger.info(
      { from: alertsCurrent, to: ttl.alertsRetentionSeconds },
      "Reconciled alerts lastSeenAt TTL to configured retention",
    );
  }
};

/** The `expireAfterSeconds` set on the `telemetry_ts` timeseries collection, or null if absent/unset. */
const timeseriesExpireSeconds = async (db: Db): Promise<number | null> => {
  const [info] = await db.listCollections({ name: "telemetry_ts" }).toArray();
  const value = (info as { options?: { expireAfterSeconds?: number } } | undefined)?.options
    ?.expireAfterSeconds;
  return typeof value === "number" ? value : null;
};

/** The `expireAfterSeconds` on the `alerts.lastSeenAt_1` TTL index, or null if the index is absent. */
const alertsIndexExpireSeconds = async (db: Db): Promise<number | null> => {
  const indexes = await db.collection("alerts").indexes();
  const ttlIndex = indexes.find((index) => index.name === "lastSeenAt_1");
  const value = (ttlIndex as { expireAfterSeconds?: number } | undefined)?.expireAfterSeconds;
  return typeof value === "number" ? value : null;
};
