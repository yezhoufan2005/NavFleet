#!/usr/bin/env bash
# Restore drill: prove the newest backup archive is actually restorable.
#
# "We take backups" and "we can restore" are different claims. This script only
# establishes the second one, and does it without touching live data: the archive
# is restored into a scratch database, the per-collection document counts are
# compared against the live database, and the scratch database is dropped again.
#
# Usage:
#   deploy/tools/restore-drill.sh [archive]     # default: newest archive the
#                                               # backup overlay writes to
#
# Exit status is 0 only if the restore succeeded with no failed documents, the
# archive held at least one collection and at least one document, and the
# config archive of the same timestamp (when there is one) can be read.
#
# An empty collection on its own is not a failure. The backend creates every
# collection at startup, so a deployment that has never sent a notification
# backs up an empty `notify_log`, and the drill used to call that a broken backup.
# Empty collections are listed so a reader can tell whether that is expected.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

if [[ -f "$DEPLOY_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$DEPLOY_DIR/.env"
  set +a
fi

# Where the archives actually are.
#
# This used to be a hardcoded `$DEPLOY_DIR/backups`, assigned *before* .env was
# sourced — so a deployment that pointed BACKUP_HOST_PATH at a NAS or a separate
# volume (the reason that variable exists) had a drill that searched an empty
# directory and reported "no backup archive found" while the backups were fine.
# The default matches docker-compose.backup.yml's own `${BACKUP_HOST_PATH:-./backups}`,
# and a relative value is resolved against deploy/ for the same reason compose
# resolves it against the compose file's directory.
BACKUP_DIR="${BACKUP_HOST_PATH:-./backups}"
if [[ "$BACKUP_DIR" != /* ]]; then
  BACKUP_DIR="$DEPLOY_DIR/${BACKUP_DIR#./}"
fi

MONGO_USER="${MONGO_INITDB_ROOT_USERNAME:-root}"
MONGO_PASS="${MONGO_INITDB_ROOT_PASSWORD:-example}"
MONGO_DB="${MONGO_DB_NAME:-fleet_monitor}"
DRILL_DB="${MONGO_DB}_restore_drill"
COMPOSE="${COMPOSE:-docker compose}"
# shellcheck source=compose-project.sh
source "$SCRIPT_DIR/compose-project.sh"
resolve_compose_project

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

# The password reaches the container as an environment variable and is read there, as in
# mongo-backup.sh: on the command line it showed in `ps` to every user on the host, and spliced
# into a URI it broke on `@`, `:`, `/` or `%`.
mongo_exec() {
  $COMPOSE --env-file "$DEPLOY_DIR/.env" -f "$COMPOSE_FILE" exec -T \
    -e MONGO_USER="$MONGO_USER" -e MONGO_PASS="$MONGO_PASS" "$@"
}

mongosh_eval() {
  mongo_exec -e DRILL_DB_ARG="$1" -e DRILL_JS="$2" mongo sh -c \
    'mongosh --quiet --username "$MONGO_USER" --password "$MONGO_PASS" --authenticationDatabase admin "$DRILL_DB_ARG" --eval "$DRILL_JS"'
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
# Not --quiet: its closing line counts the documents restored and the ones that failed.
if ! RESTORE_LOG="$(mongo_exec -e NS_FROM="${MONGO_DB}.*" -e NS_TO="${DRILL_DB}.*" mongo sh -c \
  'mongorestore --username "$MONGO_USER" --password "$MONGO_PASS" --authenticationDatabase admin --archive --gzip --nsFrom "$NS_FROM" --nsTo "$NS_TO" 2>&1' \
  <"$ARCHIVE")"; then
  echo "$RESTORE_LOG" | tail -20 >&2
  echo "DRILL FAILED: mongorestore exited with an error." >&2
  exit 1
fi
FAILED_DOCS="$(echo "$RESTORE_LOG" | sed -n 's/.* \([0-9][0-9]*\) document(s) failed to restore.*/\1/p' | tail -1)"

echo
echo "collection            restored     live"
echo "-------------------- --------- --------"

REPORT=$(mongosh_eval admin "
const drill = db.getSiblingDB('$DRILL_DB');
const live = db.getSiblingDB('$MONGO_DB');
const names = drill.getCollectionNames().filter((n) => !n.startsWith('system.'));
let empty = [];
let total = 0;
for (const name of names) {
  const restored = drill.getCollection(name).countDocuments();
  let liveCount = '-';
  try { liveCount = live.getCollection(name).countDocuments(); } catch (e) { liveCount = 'n/a'; }
  if (restored === 0) empty.push(name);
  total += restored;
  print(name.padEnd(20) + ' ' + String(restored).padStart(9) + ' ' + String(liveCount).padStart(8));
}
print('COLLECTIONS=' + names.length);
print('DOCUMENTS=' + total);
print('EMPTY=' + empty.join(' '));
")

echo "$REPORT" | grep -v '^COLLECTIONS=\|^DOCUMENTS=\|^EMPTY='
COLLECTIONS=$(echo "$REPORT" | sed -n 's/^COLLECTIONS=//p')
DOCUMENTS=$(echo "$REPORT" | sed -n 's/^DOCUMENTS=//p')
EMPTY=$(echo "$REPORT" | sed -n 's/^EMPTY=//p')

echo
if [[ "${COLLECTIONS:-0}" -eq 0 ]]; then
  echo "DRILL FAILED: the archive restored no collections at all." >&2
  exit 1
fi
if [[ "${DOCUMENTS:-0}" -eq 0 ]]; then
  echo "DRILL FAILED: every restored collection is empty." >&2
  exit 1
fi
if [[ "${FAILED_DOCS:-0}" -ne 0 ]]; then
  echo "DRILL FAILED: mongorestore reported $FAILED_DOCS document(s) that failed to restore." >&2
  exit 1
fi
if [[ -n "$EMPTY" ]]; then
  echo "note: empty in the archive (normal for a feature that has not been used yet): $EMPTY"
fi

# The config archive of the same timestamp is the other half of a restore (see mongo-backup.sh).
CONFIG_ARCHIVE="${ARCHIVE%.gz}.config.tgz"
if [[ -f "$CONFIG_ARCHIVE" ]]; then
  if ! tar -tzf "$CONFIG_ARCHIVE" >/dev/null 2>&1; then
    echo "DRILL FAILED: $(basename "$CONFIG_ARCHIVE") cannot be read." >&2
    exit 1
  fi
  echo "config archive: $(basename "$CONFIG_ARCHIVE") ($(tar -tzf "$CONFIG_ARCHIVE" | grep -vc '/$') files)"
else
  echo "warning: no config archive $(basename "$CONFIG_ARCHIVE") next to this backup; a restore would have the database without vehicles, scenes or rules." >&2
fi

echo "DRILL PASSED: $COLLECTIONS collection(s), $DOCUMENTS document(s) restored. Scratch database dropped."
