#!/usr/bin/env python3
"""Import CloudPoint offline map outputs as a NavFleet runtime scene.

CloudPoint produces an occupancy image plus a metadata sidecar in its own shape.
NavFleet reads scenes from ONE place — `config-runtime/scenes.json`, loaded by
`backend/src/configRegistry.ts` — so this copies the image into the scene-map
directory and emits the matching `scenes.json` entry.

Earlier versions wrote a `ros-map.meta.json` next to the image. Nothing ever read
it: the backend takes every scene field from `scenes.json`, and the frontend only
fetches `pointCloudMetaUrl`. That left the operator hand-copying numbers out of a
sidecar into `scenes.json`, which is exactly the step this script exists to avoid,
so the sidecar is gone and `--write-scenes` now edits `scenes.json` in place.

Usage:

    # Print the entry and review it
    python3 deploy/tools/import-cloudpoint-map.py \
        --scene-id plant-b --scene-name "B 厂区" \
        --source-dir ~/cloudpoint/out/plant-b

    # Or splice it straight into the scene registry (replaces a same-id entry)
    python3 deploy/tools/import-cloudpoint-map.py \
        --scene-id plant-b --scene-name "B 厂区" \
        --source-dir ~/cloudpoint/out/plant-b \
        --write-scenes config-runtime/scenes.json

A Lanelet2 road network does NOT need this script: point `osmUrl` at the .osm
file and the backend parses it (see deploy/docs/config-reference.md).

The entry carries no `bounds`. The backend derives them from origin, yaw and size (the rotated
map's bounding box, `mapFootprintBounds`), and a stated `bounds` would take precedence over
that: this script used to state the unrotated rectangle, which cut off a rotated map. The
initial view centres on the middle of the map, placed through the same pose.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sys
from pathlib import Path
from typing import Any

# The backend's rule for a scene id (packages/shared/src/sceneConfig.ts): it names a folder and
# a URL path. One that breaks it makes the backend reject the whole scenes.json.
SCENE_ID = re.compile(r"^[A-Za-z0-9._-]+$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import CloudPoint map outputs as a NavFleet scenes.json entry."
    )
    parser.add_argument("--scene-id", required=True, help="Scene id, also the output folder name.")
    parser.add_argument("--scene-name", default="", help="Display name; defaults to the scene id.")
    parser.add_argument(
        "--source-dir",
        required=True,
        help="CloudPoint output dir holding final_map.png/final_map_meta.json (or the full-map pair).",
    )
    parser.add_argument(
        "--variant",
        choices=["final", "full"],
        default="final",
        help="Cropped final map (default) or the full map.",
    )
    parser.add_argument(
        "--output-root",
        default="config-runtime/scene-maps",
        help="Scene-map asset root; must match the directory the backend serves.",
    )
    parser.add_argument(
        "--write-scenes",
        default="",
        help="Path to scenes.json. Given, the entry is inserted or replaced in place.",
    )
    parser.add_argument(
        "--overlay",
        default="",
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--default-zoom", type=float, default=1.0, help="defaultView.zoom.")
    parser.add_argument("--min-zoom", type=float, default=0.8, help="minZoom for this scene.")
    parser.add_argument("--max-zoom", type=float, default=10.0, help="maxZoom for this scene.")
    return parser.parse_args()


def resolve_cloudpoint_files(source_dir: Path, variant: str) -> tuple[Path, Path]:
    image_name = "final_map.png" if variant == "final" else "final_map_full.png"
    meta_name = "final_map_meta.json" if variant == "final" else "final_map_full_meta.json"
    image_path = source_dir / image_name
    meta_path = source_dir / meta_name

    if not image_path.exists():
        raise FileNotFoundError(f"CloudPoint image not found: {image_path}")
    if not meta_path.exists():
        raise FileNotFoundError(f"CloudPoint metadata not found: {meta_path}")
    return image_path, meta_path


def map_to_world(origin: dict[str, float], u: float, v: float) -> tuple[float, float]:
    """Map metres to world metres through the scene pose (shared's `mapToWorld`)."""
    cos, sin = math.cos(origin["yaw"]), math.sin(origin["yaw"])
    return origin["x"] + u * cos - v * sin, origin["y"] + u * sin + v * cos


def build_scene_entry(args: argparse.Namespace, meta: dict[str, Any]) -> dict[str, Any]:
    """Turn CloudPoint metadata into a scenes.json entry (no `bounds`: see the module note)."""
    width = int(meta["width"])
    height = int(meta["height"])
    resolution = float(meta["resolution"])
    origin = {
        "x": float(meta["origin"]["x"]),
        "y": float(meta["origin"]["y"]),
        "yaw": float(meta["origin"].get("yaw", 0.0)),
    }
    center_x, center_y = map_to_world(origin, width * resolution / 2, height * resolution / 2)

    return {
        "sceneId": args.scene_id,
        "sceneName": args.scene_name or args.scene_id,
        "imageUrl": f"/scene-maps/{args.scene_id}/ros-map.png",
        "mapFrame": "map",
        "resolution": resolution,
        "origin": origin,
        "width": width,
        "height": height,
        "defaultView": {
            "zoom": args.default_zoom,
            "centerX": round(center_x, 4),
            "centerY": round(center_y, 4),
        },
        "minZoom": args.min_zoom,
        "maxZoom": args.max_zoom,
    }


def write_scenes(scenes_path: Path, entry: dict[str, Any]) -> str:
    """Replace a same-id entry in place, or append; the rest of the file keeps its order."""
    scenes: list[dict[str, Any]] = []
    if scenes_path.exists():
        loaded = json.loads(scenes_path.read_text(encoding="utf-8"))
        if not isinstance(loaded, list):
            raise ValueError(f"{scenes_path} must contain a JSON array of scenes")
        scenes = loaded

    replaced = False
    for index, scene in enumerate(scenes):
        if scene.get("sceneId") == entry["sceneId"]:
            scenes[index] = entry
            replaced = True
    if not replaced:
        scenes.append(entry)

    scenes_path.write_text(
        json.dumps(scenes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return "replaced" if replaced else "added"


def main() -> None:
    args = parse_args()
    if args.overlay:
        sys.exit(
            "--overlay is gone: a copied overlay JSON was never referenced by the entry, and "
            "overlayUrl is minted by the backend. Point osmUrl at the Lanelet2 .osm instead."
        )
    if not SCENE_ID.match(args.scene_id) or set(args.scene_id) == {"."}:
        sys.exit(
            f"--scene-id {args.scene_id!r}: use letters, digits, '.', '_' or '-' only; the "
            "backend rejects the whole scenes.json over one bad id"
        )
    source_dir = Path(args.source_dir).expanduser().resolve()
    output_dir = Path(args.output_root).expanduser().resolve() / args.scene_id
    output_dir.mkdir(parents=True, exist_ok=True)

    image_path, meta_path = resolve_cloudpoint_files(source_dir, args.variant)
    entry = build_scene_entry(args, json.loads(meta_path.read_text(encoding="utf-8")))

    shutil.copy2(image_path, output_dir / "ros-map.png")

    if args.write_scenes:
        action = write_scenes(Path(args.write_scenes).expanduser().resolve(), entry)
        print(f"# scenes.json: {action} scene '{entry['sceneId']}'")
        print(
            "# The backend watches this file and reloads it. If the scene does not appear, "
            "the file was rejected: the backend log says why (系统 / 状态 shows the fallback)."
        )
    else:
        print("# Paste this into config-runtime/scenes.json:")

    print(json.dumps(entry, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
