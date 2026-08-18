#!/usr/bin/env python3
"""Import CloudPoint offline outputs into the unified runtime scene map directory."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import CloudPoint map outputs and convert them to the frontend ROS map resource format."
    )
    parser.add_argument("--scene-id", required=True, help="Target scene id, used as the output folder name.")
    parser.add_argument("--scene-name", default="", help="Display name written into ros-map.meta.json.")
    parser.add_argument(
        "--source-dir",
        required=True,
        help="CloudPoint output directory containing final_map.png/final_map_meta.json or full-map variants.",
    )
    parser.add_argument(
        "--variant",
        choices=["final", "full"],
        default="final",
        help="Choose cropped final map or full map outputs from CloudPoint.",
    )
    parser.add_argument(
        "--output-root",
        default="config-runtime/scene-maps",
        help="Project scene map root directory.",
    )
    parser.add_argument(
        "--overlay",
        default="",
        help="Optional lanelet overlay json file to copy as lanelet-overlay.json.",
    )
    parser.add_argument(
        "--default-zoom",
        type=float,
        default=1.0,
        help="Default zoom multiplier written into metadata.",
    )
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


def build_output_meta(scene_id: str, scene_name: str, meta: dict, default_zoom: float) -> dict:
    width = int(meta["width"])
    height = int(meta["height"])
    resolution = float(meta["resolution"])
    origin = {
        "x": float(meta["origin"]["x"]),
        "y": float(meta["origin"]["y"]),
        "yaw": float(meta["origin"].get("yaw", 0.0)),
    }
    bounds = {
        "minX": origin["x"],
        "maxX": origin["x"] + width * resolution,
        "minY": origin["y"],
        "maxY": origin["y"] + height * resolution,
    }

    return {
        "sceneId": scene_id,
        "sceneName": scene_name or scene_id,
        "imageUrl": f"/scene-maps/{scene_id}/ros-map.png",
        "width": width,
        "height": height,
        "resolution": resolution,
        "origin": origin,
        "bounds": bounds,
        "defaultView": {
            "zoom": default_zoom,
            "centerX": round((bounds["minX"] + bounds["maxX"]) / 2, 4),
            "centerY": round((bounds["minY"] + bounds["maxY"]) / 2, 4),
        },
        "source": "cloudpoint",
        "variant": meta.get("image", ""),
        "worldToPixel": meta.get("world_to_pixel"),
        "pixelToWorld": meta.get("pixel_to_world"),
        "crop": meta.get("crop"),
    }


def main() -> None:
    args = parse_args()
    source_dir = Path(args.source_dir).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    output_dir = output_root / args.scene_id
    output_dir.mkdir(parents=True, exist_ok=True)

    image_path, meta_path = resolve_cloudpoint_files(source_dir, args.variant)

    raw_meta = json.loads(meta_path.read_text(encoding="utf-8"))
    output_meta = build_output_meta(args.scene_id, args.scene_name, raw_meta, args.default_zoom)

    shutil.copy2(image_path, output_dir / "ros-map.png")
    (output_dir / "ros-map.meta.json").write_text(
        json.dumps(output_meta, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if args.overlay:
        overlay_path = Path(args.overlay).expanduser().resolve()
        if not overlay_path.exists():
            raise FileNotFoundError(f"Overlay file not found: {overlay_path}")
        shutil.copy2(overlay_path, output_dir / "lanelet-overlay.json")

    print(
        json.dumps(
            {
                "sceneId": args.scene_id,
                "sceneName": output_meta["sceneName"],
                "outputDir": str(output_dir),
                "image": str(output_dir / "ros-map.png"),
                "meta": str(output_dir / "ros-map.meta.json"),
                "bounds": output_meta["bounds"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
