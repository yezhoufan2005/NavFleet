#!/bin/sh
# Backup loop for the mongo-backup service (deploy/docker-compose.backup.yml).
#
# Runs one dump immediately, then every BACKUP_INTERVAL_SECONDS, pruning
# archives older than BACKUP_RETENTION_DAYS. Deliberately dumb: no locking, no
# incremental logic. A single-host deployment's whole database is a handful of
# collections, and a plain periodic archive is the thing an operator can actually
# restore under pressure.
set -eu

DB="${MONGO_DB_NAME:-fleet_monitor}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
OUT_DIR=/backups
# The operator's config (vehicles, formations, scenes and their backdrops, codebook, rules,
# notify, reports) lives on disk, not in Mongo, and a database restored without it names
# devices and scenes nobody can find. Mounted read-only by docker-compose.backup.yml.
CONFIG_DIR=/config-runtime

log() { echo "[mongo-backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if [ -z "${MONGO_URI:-}" ]; then
  log "MONGO_URI is required" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

while true; do
  STAMP="$(date -u +%Y%m%d-%H%M%S)"
  ARCHIVE="$OUT_DIR/${DB}-${STAMP}.gz"
  # `.tgz`, not `.gz`: restore-drill.sh picks the newest `*.gz` as the database archive.
  CONFIG_ARCHIVE="$OUT_DIR/${DB}-${STAMP}.config.tgz"

  # `|| true`-free on purpose: a failed dump should be loud in the container log
  # rather than leaving the loop looking healthy, but it must not kill the loop —
  # hence the explicit if/else instead of `set -e` doing the exiting.
  if mongodump --uri "$MONGO_URI" --db "$DB" --archive="$ARCHIVE" --gzip --quiet; then
    log "wrote $(basename "$ARCHIVE") ($(wc -c <"$ARCHIVE" | tr -d ' ') bytes)"
  else
    log "DUMP FAILED — leaving previous archives untouched" >&2
    rm -f "$ARCHIVE"
  fi

  # Same timestamp as the dump, so the pair that belongs together is obvious. `.last-good/`
  # is the backend's own fallback copy of the files above, rebuilt on the next good load.
  if [ -d "$CONFIG_DIR" ]; then
    if tar -czf "$CONFIG_ARCHIVE" --exclude=./.last-good -C "$CONFIG_DIR" .; then
      log "wrote $(basename "$CONFIG_ARCHIVE") ($(wc -c <"$CONFIG_ARCHIVE" | tr -d ' ') bytes)"
    else
      log "CONFIG ARCHIVE FAILED" >&2
      rm -f "$CONFIG_ARCHIVE"
    fi
  fi

  # Prune by age, and only ever files matching our own naming pattern: the
  # directory is a host bind mount and may hold things this loop did not write.
  PRUNED=$(find "$OUT_DIR" -maxdepth 1 -type f \( -name "${DB}-*.gz" -o -name "${DB}-*.config.tgz" \) -mtime "+${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')
  if [ "$PRUNED" != "0" ]; then
    log "pruned $PRUNED archive(s) older than ${RETENTION_DAYS}d"
  fi

  log "sleeping ${INTERVAL}s"
  sleep "$INTERVAL"
done
