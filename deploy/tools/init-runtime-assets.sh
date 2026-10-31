#!/usr/bin/env sh
# Initialise a runtime config directory, outside the repo, from the shipped defaults.
#
# Usage:  sh deploy/tools/init-runtime-assets.sh [target-dir]   (default /srv/navfleet/config-runtime)
#
# Then point compose at it: CONFIG_RUNTIME_HOST_PATH=<target-dir> in deploy/.env. Without that
# the stack keeps mounting the repo's own config-runtime/.
#
# Copies the four files a fleet cannot start without, plus the scene maps, and never overwrites
# an existing file, so re-running it is safe. The four files are the repo's demo fleet (29
# vehicles, 6 formations, 6 scenes): replace them with the site's own. rules.json, codebook.json,
# notify.json and reports.json are optional and are not copied: missing, each falls back to its
# built-in default (default rules, the built-in code table, no outbound sends, no scheduled
# reports).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SOURCE="$REPO_ROOT/config-runtime"
RUNTIME_ROOT=${1:-/srv/navfleet/config-runtime}

mkdir -p "$RUNTIME_ROOT/scene-maps"
RUNTIME_ROOT=$(CDPATH= cd -- "$RUNTIME_ROOT" && pwd)

if [ "$RUNTIME_ROOT" = "$SOURCE" ]; then
  echo "$RUNTIME_ROOT is the repo's own config-runtime; it needs no initialising." >&2
  echo "Give a directory outside the repo, then set CONFIG_RUNTIME_HOST_PATH to it." >&2
  exit 1
fi

for file in fleet.json vehicles.json formations.json scenes.json; do
  if [ ! -f "$RUNTIME_ROOT/$file" ]; then
    cp "$SOURCE/$file" "$RUNTIME_ROOT/$file"
  fi
done

# File by file rather than `cp -R -n`: BSD cp returns 1 when -n skips a file, which under
# `set -e` stopped a re-run on macOS before the summary.
(cd "$SOURCE/scene-maps" && find . -type f) | while IFS= read -r asset; do
  if [ ! -e "$RUNTIME_ROOT/scene-maps/$asset" ]; then
    mkdir -p "$RUNTIME_ROOT/scene-maps/$(dirname "$asset")"
    cp "$SOURCE/scene-maps/$asset" "$RUNTIME_ROOT/scene-maps/$asset"
  fi
done

echo "Runtime assets initialized in: $RUNTIME_ROOT"
echo "Config files:"
echo "  $RUNTIME_ROOT/fleet.json"
echo "  $RUNTIME_ROOT/vehicles.json"
echo "  $RUNTIME_ROOT/formations.json"
echo "  $RUNTIME_ROOT/scenes.json"
echo "Scene maps directory: $RUNTIME_ROOT/scene-maps"
echo
echo "Next:"
echo "  - set CONFIG_RUNTIME_HOST_PATH=$RUNTIME_ROOT in deploy/.env"
echo "  - the backend runs as uid 1000 and writes these files (vehicle wizard, codebook import,"
echo "    scene uploads); on Linux: chown -R 1000:1000 $RUNTIME_ROOT"
echo "  - the four files hold the demo fleet; replace them with this site's vehicles and scenes"
