#!/usr/bin/env bash
# Restore drill: prove the newest backup archive is actually restorable.
#
# "We take backups" and "we can restore" are different claims. This script only
# establishes the second one, and does it without touching live data: the archive
# is restored into a scratch database, the per-collection document counts are
# compared against the live database, and the scratch database is dropped again.
#
# Usage:
#   deploy/tools/restore-drill.sh [archive]     # default: newest in deploy/backups
#
# Exit status is 0 only if the restore succeeded and every collection in the
# archive came back with at least one document.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
BACKUP_DIR="$DEPLOY_DIR/backups"

if [[ -f "$DEPLOY_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$DEPLOY_DIR/.env"
  set +a
fi

MONGO_USER="${MONGO_INITDB_ROOT_USERNAME:-root}"
MONGO_PASS="${MONGO_INITDB_ROOT_PASSWORD:-example}"
MONGO_DB="${MONGO_DB_NAME:-fleet_monitor}"
DRILL_DB="${MONGO_DB}_restore_drill"
COMPOSE="${COMPOSE:-docker compose}"

ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE="$(ls -t "$BACKUP_DIR"/*.gz 2>/dev/null | head -1 || true)"
fi
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "no backup archive found (looked in $BACKUP_DIR). Run deploy/tools/mongo-backup.sh first." >&2
  exit 1
fi

echo "drill archive : $(basename "$ARCHIVE") ($(wc -c <"$ARCHIVE" | tr -d ' ') bytes)"
echo "scratch target: $DRILL_DB (live $MONGO_DB is never written)"

mongosh_eval() {
  $COMPOSE --env-file "$DEPLOY_DIR/.env" -f "$COMPOSE_FILE" exec -T mongo \
    mongosh --quiet -u "$MONGO_USER" -p "$MONGO_PASS" --authenticationDatabase admin \
    "$1" --eval "$2"
}

cleanup() {
  mongosh_eval "$DRILL_DB" 'db.dropDatabase()' >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Start from a clean scratch database so counts cannot be inherited from a
# previous drill.
cleanup

# --nsFrom/--nsTo redirect the archive's namespace into the scratch database,
# which is what keeps the live data out of reach even if the restore misbehaves.
$COMPOSE --env-file "$DEPLOY_DIR/.env" -f "$COMPOSE_FILE" exec -T mongo \
  mongorestore --uri "mongodb://${MONGO_USER}:${MONGO_PASS}@127.0.0.1:27017/?authSource=admin" \
  --archive --gzip --quiet \
  --nsFrom "${MONGO_DB}.*" --nsTo "${DRILL_DB}.*" <"$ARCHIVE"

echo
echo "collection            restored     live"
echo "-------------------- --------- --------"

REPORT=$(mongosh_eval admin "
const drill = db.getSiblingDB('$DRILL_DB');
const live = db.getSiblingDB('$MONGO_DB');
const names = drill.getCollectionNames().filter((n) => !n.startsWith('system.'));
let empty = 0;
for (const name of names) {
  const restored = drill.getCollection(name).countDocuments();
  let liveCount = '-';
  try { liveCount = live.getCollection(name).countDocuments(); } catch (e) { liveCount = 'n/a'; }
  if (restored === 0) empty += 1;
  print(name.padEnd(20) + ' ' + String(restored).padStart(9) + ' ' + String(liveCount).padStart(8));
}
print('COLLECTIONS=' + names.length);
print('EMPTY=' + empty);
")

echo "$REPORT" | grep -v '^COLLECTIONS=\|^EMPTY='
COLLECTIONS=$(echo "$REPORT" | sed -n 's/^COLLECTIONS=//p')
EMPTY=$(echo "$REPORT" | sed -n 's/^EMPTY=//p')

echo
if [[ "${COLLECTIONS:-0}" -eq 0 ]]; then
  echo "DRILL FAILED: the archive restored no collections at all." >&2
  exit 1
fi
if [[ "${EMPTY:-0}" -ne 0 ]]; then
  echo "DRILL FAILED: $EMPTY restored collection(s) are empty." >&2
  exit 1
fi

echo "DRILL PASSED: $COLLECTIONS collection(s) restored, none empty. Scratch database dropped."
