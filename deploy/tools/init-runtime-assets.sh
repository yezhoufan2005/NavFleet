#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
RUNTIME_ROOT=${1:-/opt/navfleet/config-runtime}

mkdir -p "$RUNTIME_ROOT/scene-maps"

if [ ! -f "$RUNTIME_ROOT/fleet.json" ]; then
  cp "$REPO_ROOT/config-runtime/fleet.json" "$RUNTIME_ROOT/fleet.json"
fi

if [ ! -f "$RUNTIME_ROOT/vehicles.json" ]; then
  cp "$REPO_ROOT/config-runtime/vehicles.json" "$RUNTIME_ROOT/vehicles.json"
fi

if [ ! -f "$RUNTIME_ROOT/formations.json" ]; then
  cp "$REPO_ROOT/config-runtime/formations.json" "$RUNTIME_ROOT/formations.json"
fi

if [ ! -f "$RUNTIME_ROOT/scenes.json" ]; then
  cp "$REPO_ROOT/config-runtime/scenes.json" "$RUNTIME_ROOT/scenes.json"
fi

cp -R -n "$REPO_ROOT/config-runtime/scene-maps/." "$RUNTIME_ROOT/scene-maps/"

echo "Runtime assets initialized in: $RUNTIME_ROOT"
echo "Config files:"
echo "  $RUNTIME_ROOT/fleet.json"
echo "  $RUNTIME_ROOT/vehicles.json"
echo "  $RUNTIME_ROOT/formations.json"
echo "  $RUNTIME_ROOT/scenes.json"
echo "Scene maps directory: $RUNTIME_ROOT/scene-maps"
