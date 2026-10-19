#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Neo Gallery — Offline preprocessor: scan presets, generate thumbnails + index.json
#
# Usage:
#   python gallery_preprocess.py --presets <presets_dir> --output <output_dir> [--size 320]
#   cd <dir_with_new_dirs> && python gallery_preprocess.py --output <output_dir> --dirs dir1 dir2
#       (incremental add/update; --presets omitted: cwd is used)
#   python gallery_preprocess.py --output <output_dir> --publish dir1 dir2
#   python gallery_preprocess.py --output <output_dir> --split-legacy
#   python gallery_preprocess.py --output <output_dir> --tag-dirs dir1 dir2 --tag character-sheet
#       (--tag-dirs edits tags of existing index directories: no media scan, no new entries)
#
# Without --dirs: full scan of all subdirectories, the master index is rebuilt from scratch.
# With --dirs DIR...: only those subdirectories are (re)scanned — new directories are added,
#   existing ones updated (orphan thumbnails/copies pruned) — and merged into the latest
#   master index fetched from OSS (configs/oss_presets.json -> index_url), leaving other
#   directories untouched. Use --no-fetch-index to merge into a local index.json instead.
# --draft writes the directory indexes without publishing them in the master index;
#   --publish publishes already written directory indexes later without rescanning media.
#   --split-legacy converts a legacy full index.json into per-directory indexes.
# --tag/--clear-tags writes the per-directory "tags" list in the master index. "tags" is a
#   label on the directory (a directory can carry many) and never moves the card: every index
#   directory is one Cloud Presets card. The plugin reads tags for directory defaults,
#   e.g. "character-sheet" = 角色图目录.
#
# The output directory will contain:
#   index.json          — v2 master index: per-directory count / index path / rev / covers
#   <subdir>/index.json — the full item list of that directory
#   thumbnails/         — pre-generated JPEG thumbnails
#   <subdir>/           — copies of media + txt files (ready for OSS upload)

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"}
ALL_MEDIA_EXTENSIONS = IMG_EXTENSIONS | VIDEO_EXTENSIONS
THUMB_SIZE = 320


def generate_image_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    try:
        from PIL import Image
        with Image.open(source_path) as img:
            if img.mode not in ("RGB", "L", "RGBA"):
                img = img.convert("RGB")
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            if img.mode == "RGBA":
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            img.save(cache_path, "JPEG", quality=85)
            return True
    except Exception as e:
        print(f"  [WARN] Failed to generate thumbnail for {source_path.name}: {e}")
        return False


def generate_video_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    try:
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            print("  [WARN] ffmpeg not found, skipping video thumbnail")
            return False
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            ffmpeg_path, "-ss", "00:00:00.500",
            "-i", str(source_path),
            "-vframes", "1", "-y", str(cache_path)
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode != 0:
            cmd = [ffmpeg_path, "-i", str(source_path), "-vframes", "1", "-y", str(cache_path)]
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0:
                return False
        if cache_path.stat().st_size < 1024:
            cache_path.unlink(missing_ok=True)
            return False
        return True
    except Exception:
        return False


def generate_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    if source_path.suffix.lower() in VIDEO_EXTENSIONS:
        return generate_video_thumbnail(source_path, cache_path, size)
    return generate_image_thumbnail(source_path, cache_path, size)


def parse_txt_preview(txt_path: Path, max_chars: int = 500) -> str:
    if not txt_path or not txt_path.exists():
        return ""
    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            raw = f.read(max_chars)
        lines = raw.strip().splitlines()[:2]
        result = []
        for line in lines:
            m = re.match(r"^\d+\s*\|\s*(.*)", line)
            result.append(m.group(1).strip() if m else line.strip())
        return "\n".join(result)
    except Exception:
        return ""


def load_existing_index(index_path: Path):
    """Load an existing index.json for incremental merge, or None."""
    if not index_path.exists():
        return None
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data.get("directories"), dict):
            return data
    except Exception as e:
        print(f"[WARN] Failed to load existing index {index_path}: {e}")
    return None


def fetch_index_from_url(url: str, dest_path: Path):
    """Download the latest index.json from OSS and save it locally for merge."""
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not isinstance(data.get("directories"), dict):
            raise ValueError("no 'directories' field")
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with open(dest_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"  Fetched:  {url} ({len(data['directories'])} directories)")
        return data
    except Exception as e:
        print(f"[ERROR] Failed to fetch index from {url}: {e}")
        sys.exit(1)


def get_oss_config() -> dict:
    """Read the plugin's configs/oss_presets.json (empty dict if unset)."""
    cfg_path = Path(__file__).resolve().parent.parent / "studio" / "configs" / "oss_presets.json"
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def get_oss_index_url() -> str:
    """Read index_url from configs/oss_presets.json (empty if unset)."""
    return get_oss_config().get("index_url", "") or ""


def prune_directory(output_dir: Path, dir_name: str, keep_files: set[str], keep_thumbs: set[str], copy_media: bool):
    """Remove output thumbnails/copies no longer present in the source directory (update mode)."""
    thumb_subdir = output_dir / "thumbnails" / dir_name
    if thumb_subdir.is_dir():
        for f in thumb_subdir.iterdir():
            if f.suffix.lower() == ".jpg" and f.stem not in keep_thumbs:
                f.unlink(missing_ok=True)
    if copy_media:
        media_dir = output_dir / dir_name
        if media_dir.is_dir():
            for f in media_dir.iterdir():
                if f.name not in keep_files:
                    f.unlink(missing_ok=True)


def _stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_dir_index(output_dir: Path, dir_name: str, entries: list[dict]) -> str:
    """Write <dir>/index.json — the item index of one directory — and return its rev stamp.

    rev 是插件判断本地目录缓存是否过期的依据：主索引里的 rev 与目录索引里的 generated_at
    对不上才重新下载，否则每次进目录都白拉一份几百 KB 的 items。"""
    rev = _stamp()
    payload = {"version": 2, "name": dir_name, "generated_at": rev, "items": entries}
    path = output_dir / dir_name / "index.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    return rev


def load_dir_index(output_dir: Path, dir_name: str) -> tuple[list[dict], str] | None:
    """Read a written <dir>/index.json as (items, rev); None when missing or malformed."""
    path = output_dir / dir_name / "index.json"
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data.get("items"), list):
        return None
    return data["items"], str(data.get("generated_at", ""))


def master_entry(dir_name: str, entries: list[dict], rev: str, tags: list[str] | None = None) -> dict:
    """Master-index entry: count, directory index path, rev, card covers — no items.

    tags 是可选的目录标签（与卡片位置无关），不传就不写 tags 字段。"""
    covers = [{"filename": e["filename"], "thumbnail": e["thumbnail"]}
              for e in entries if e.get("thumbnail")][:2]
    entry = {
        "count": len(entries),
        "index": f"{dir_name}/index.json",
        "rev": rev,
        "covers": covers,
    }
    if tags:
        entry["tags"] = sorted({str(t).strip().lower() for t in tags if str(t).strip()})
    return entry


def master_items(master: dict) -> int:
    return sum(int(d.get("count", 0)) for d in master.get("directories", {}).values())


def write_master_index(path: Path, master: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(master, f, ensure_ascii=False, indent=2)


def split_legacy_index(output_dir: Path, legacy: dict) -> dict:
    """Convert a legacy full index.json (items inside) into per-directory indexes + master."""
    master = {"version": 2, "generated_at": _stamp(),
              "base_url": legacy.get("base_url", ""), "directories": {}}
    for dir_name, data in legacy.get("directories", {}).items():
        entries = data.get("items", [])
        rev = write_dir_index(output_dir, dir_name, entries)
        master["directories"][dir_name] = master_entry(dir_name, entries, rev)
        print(f"  {dir_name}: {len(entries)} items -> {dir_name}/index.json")
    if isinstance(legacy.get("categories"), dict):
        master["categories"] = legacy["categories"]
    return master


def build_master_index(existing: dict | None, fragment: dict, base_url: str,
                       category: str | None, scanned: list[str],
                       tags: list[str] | None = None, clear_tags: bool = False) -> dict:
    """Merge new directory entries into the master index and re-assign categories.

    合并基准里没扫到的目录条目原样保留，这就是分批发布：--draft 写出的目录索引不进
    主索引，--publish 才把它们挂到素材库上。tags 只挂在 scanned 这批目录上（整体替换，
    不累积），未扫目录的标签原样留着。category=None 表示只改标签，不动 categories。
    categories 是旧版插件挑目录用的字段：现版插件把索引里每个目录都当成 Cloud Presets
    卡，写这个字段只让旧版插件看到同一份清单。"""
    directories = dict(existing.get("directories", {})) if existing else {}
    directories.update(fragment)
    for name in scanned:
        entry = dict(directories.get(name, {}))
        if clear_tags:
            entry.pop("tags", None)
        elif tags:
            entry["tags"] = sorted({str(t).strip().lower() for t in tags if str(t).strip()})
        directories[name] = entry
    master = {"version": 2, "generated_at": _stamp(), "base_url": base_url, "directories": directories}
    if not category:
        # 只改标签时原样保留 categories：标签通路不碰这个字段
        if existing and existing.get("categories"):
            master["categories"] = existing["categories"]
        return master

    categories = {}
    if existing:
        for cat, names in (existing.get("categories") or {}).items():
            if isinstance(names, list):
                categories[str(cat)] = [n for n in names if isinstance(n, str)]
    for cat in list(categories):
        categories[cat] = [n for n in categories[cat] if n not in scanned]
    for name in scanned:
        categories.setdefault(category, [])
        if name not in categories[category]:
            categories[category].append(name)
    categories = {cat: names for cat, names in categories.items() if names}
    if categories:
        master["categories"] = categories
    return master


def scan_directory(subdir: Path, output_dir: Path, thumb_size: int, copy_media: bool, prune: bool) -> tuple[list[dict], int]:
    """Scan one preset subdirectory: thumbnails, media copies, and its per-directory index."""
    dir_name = subdir.name
    print(f"\n[{dir_name}] Scanning...")

    thumb_dir = output_dir / "thumbnails"
    dir_entries = []
    total_thumbs = 0
    stems: dict[str, list[Path]] = {}

    for p in subdir.iterdir():
        if not p.is_file():
            continue
        lower = p.suffix.lower()
        if lower not in ALL_MEDIA_EXTENSIONS and lower != ".txt":
            continue
        stems.setdefault(p.stem, []).append(p)

    for stem, files in sorted(stems.items()):
        media_file = None
        media_type = None
        txt_file = None

        for f in files:
            if f.suffix.lower() in VIDEO_EXTENSIONS:
                media_file = f
                media_type = "video"
            elif f.suffix.lower() in IMG_EXTENSIONS:
                if media_file is None:
                    media_file = f
                    media_type = "image"
            elif f.suffix.lower() == ".txt":
                txt_file = f

        if not media_file:
            continue

        # Generate thumbnail
        thumb_subdir = thumb_dir / dir_name
        thumb_path = thumb_subdir / f"{stem}.jpg"
        thumb_ok = False
        if not thumb_path.exists():
            thumb_ok = generate_thumbnail(media_file, thumb_path, thumb_size)
            if thumb_ok:
                total_thumbs += 1
        else:
            thumb_ok = True

        # Relative thumbnail path (for OSS URL construction)
        thumb_rel = f"thumbnails/{dir_name}/{stem}.jpg" if thumb_ok else ""

        # Parse txt preview
        txt_content = parse_txt_preview(txt_file)

        entry = {
            "filename": media_file.name,
            "type": media_type,
            "size": media_file.stat().st_size,
            "mtime": media_file.stat().st_mtime,
            "txt_content": txt_content,
            "thumbnail": thumb_rel,
        }
        dir_entries.append(entry)

        # Copy media + txt to output
        if copy_media:
            dest_subdir = output_dir / dir_name
            dest_subdir.mkdir(parents=True, exist_ok=True)
            dest_media = dest_subdir / media_file.name
            if not dest_media.exists():
                shutil.copy2(media_file, dest_media)
            if txt_file:
                dest_txt = dest_subdir / txt_file.name
                if not dest_txt.exists():
                    shutil.copy2(txt_file, dest_txt)

    # Update mode: drop output files that no longer exist in the source directory
    if prune:
        # 旁车 txt 与图同名，只按 media 文件名建 keep 集合会把它们当孤儿删掉，
        # 云端灯箱的提示词就只剩索引中 500 字的预览。
        keep_files = {e["filename"] for e in dir_entries}
        keep_files |= {Path(e["filename"]).stem + ".txt" for e in dir_entries}
        keep_thumbs = {Path(e["thumbnail"]).stem for e in dir_entries if e["thumbnail"]}
        prune_directory(output_dir, dir_name, keep_files, keep_thumbs, copy_media)

    print(f"  {len(dir_entries)} items, {sum(1 for e in dir_entries if e['thumbnail'])} thumbnails")
    return dir_entries, total_thumbs

def scan_root_files(presets_dir: Path, output_dir: Path, thumb_size: int) -> tuple[list[dict], int]:
    """Scan root-level preset files (not in any subdirectory) — full mode only."""
    thumb_dir = output_dir / "thumbnails"
    dir_entries = []
    total_thumbs = 0
    root_stems: dict[str, list[Path]] = {}
    for p in presets_dir.iterdir():
        if not p.is_file():
            continue
        lower = p.suffix.lower()
        if lower not in ALL_MEDIA_EXTENSIONS and lower != ".txt":
            continue
        root_stems.setdefault(p.stem, []).append(p)

    for stem, files in sorted(root_stems.items()):
        media_file = None
        media_type = None
        txt_file = None
        for f in files:
            if f.suffix.lower() in VIDEO_EXTENSIONS:
                media_file = f
                media_type = "video"
            elif f.suffix.lower() in IMG_EXTENSIONS:
                if media_file is None:
                    media_file = f
                    media_type = "image"
            elif f.suffix.lower() == ".txt":
                txt_file = f
        if not media_file:
            continue

        thumb_path = thumb_dir / f"{stem}.jpg"
        thumb_ok = False
        if not thumb_path.exists():
            thumb_ok = generate_thumbnail(media_file, thumb_path, thumb_size)
            if thumb_ok:
                total_thumbs += 1
        else:
            thumb_ok = True

        thumb_rel = f"thumbnails/{stem}.jpg" if thumb_ok else ""
        txt_content = parse_txt_preview(txt_file)

        dir_entries.append({
            "filename": media_file.name,
            "type": media_type,
            "size": media_file.stat().st_size,
            "mtime": media_file.stat().st_mtime,
            "txt_content": txt_content,
            "thumbnail": thumb_rel,
        })

    return dir_entries, total_thumbs


def scan_presets_directory(presets_dir: Path, output_dir: Path, thumb_size: int, copy_media: bool, only_dirs=None) -> dict:
    """Scan presets directories and return the master-index fragment of the scanned dirs.

    only_dirs: list of subdirectory names to (re)scan; None means full scan."""
    (output_dir / "thumbnails").mkdir(parents=True, exist_ok=True)

    if only_dirs:
        subdirs = []
        for d in only_dirs:
            p = presets_dir / d
            if not p.is_dir():
                print(f"[WARN] Directory not found, skipped: {p}")
                continue
            subdirs.append(p)
        if not subdirs:
            print("[ERROR] No valid directories to process")
            sys.exit(1)
    else:
        subdirs = sorted([p for p in presets_dir.iterdir() if p.is_dir()])
        if not subdirs:
            print(f"[WARN] No subdirectories found in {presets_dir}")

    fragment: dict[str, dict] = {}
    total_items = 0
    total_thumbs = 0

    for subdir in subdirs:
        entries, thumbs = scan_directory(subdir, output_dir, thumb_size, copy_media, bool(only_dirs))
        rev = write_dir_index(output_dir, subdir.name, entries)
        fragment[subdir.name] = master_entry(subdir.name, entries, rev)
        total_items += len(entries)
        total_thumbs += thumbs

    if not only_dirs:
        entries, thumbs = scan_root_files(presets_dir, output_dir, thumb_size)
        if entries:
            rev = write_dir_index(output_dir, "_root", entries)
            fragment["_root"] = master_entry("_root", entries, rev)
            total_items += len(entries)
            total_thumbs += thumbs

    print(f"\n{'='*50}")
    print(f"Total: {total_items} items, {total_thumbs} thumbnails generated")
    print(f"Output: {output_dir}")

    return fragment


def main():
    parser = argparse.ArgumentParser(
        description="Neo Gallery preprocessor — generate index.json and thumbnails for OSS deployment"
    )
    parser.add_argument(
        "--presets", type=str, default=None,
        help="Path to the local presets directory "
             "(default in --dirs mode: current working directory; required for a full scan)"
    )
    parser.add_argument(
        "--output", type=str, required=True,
        help="Output directory for index.json + thumbnails + media copies"
    )
    parser.add_argument(
        "--size", type=int, default=THUMB_SIZE,
        help=f"Thumbnail size in pixels (default: {THUMB_SIZE})"
    )
    parser.add_argument(
        "--no-copy", action="store_true",
        help="Skip copying media files to output (only generate index + thumbnails)"
    )
    parser.add_argument(
        "--dirs", nargs="+", default=None, metavar="DIR",
        help="Only (re)scan these subdirectories and merge into the existing index.json "
             "(incremental add/update); omit for a full scan"
    )
    parser.add_argument(
        "--fetch-index", type=str, default="",
        help="Download the latest index.json from this URL as the merge base "
             "(default in --dirs mode: configs/oss_presets.json -> index_url)"
    )
    parser.add_argument(
        "--no-fetch-index", action="store_true",
        help="Do not fetch the OSS index; merge into a local index.json if present"
    )
    parser.add_argument(
        "--base-url", type=str, default="",
        help="Base URL prefix for OSS (written into index.json; "
             "default in --dirs mode: configs/oss_presets.json -> base_url)"
    )
    parser.add_argument(
        "--draft", action="store_true",
        help="With --dirs: write the directory indexes only, leave the master index untouched "
             "(staged release; publish later with --publish)"
    )
    parser.add_argument(
        "--publish", nargs="+", default=None, metavar="DIR",
        help="Publish existing <dir>/index.json entries into the master index without rescanning media"
    )
    parser.add_argument(
        "--split-legacy", action="store_true",
        help="Convert a legacy full index.json (items inside) in the output directory into "
             "per-directory indexes plus a v2 master index"
    )
    parser.add_argument(
        "--tag", action="append", default=None, metavar="TAG",
        help="Attach a virtual label (e.g. character-sheet) to the scanned/--publish directories in the "
             "master index; repeatable, labels never move a card"
    )
    parser.add_argument(
        "--clear-tags", action="store_true",
        help="Remove every tag from the scanned/--publish directories (instead of setting --tag)"
    )
    parser.add_argument(
        "--tag-dirs", nargs="+", default=None, metavar="DIR",
        help="Tag-only pass: set --tag (or clear with --clear-tags) on these existing index "
             "directories without rescanning media and without adding new entries"
    )

    args = parser.parse_args()

    tags = [str(t).strip().lower() for t in (args.tag or []) if str(t).strip()]
    if any(not re.fullmatch(r"[a-z0-9_-]+", t) for t in tags):
        print("[ERROR] --tag accepts lowercase letters, digits, - and _")
        sys.exit(1)
    if args.tag_dirs and not (tags or args.clear_tags):
        print("[ERROR] --tag-dirs needs --tag or --clear-tags")
        sys.exit(1)

    if args.draft and not args.dirs:
        print("[ERROR] --draft only applies to an incremental --dirs run")
        sys.exit(1)

    if not args.presets:
        if not (args.dirs or args.publish or args.tag_dirs or args.split_legacy):
            print("[ERROR] --presets is required for a full scan (or use --dirs / --publish for incremental mode)")
            sys.exit(1)
        presets_dir = Path.cwd().resolve()
    else:
        presets_dir = Path(args.presets).resolve()
    output_dir = Path(args.output).resolve()
    index_path = output_dir / "index.json"

    if not (args.publish or args.split_legacy) and not presets_dir.exists():
        print(f"[ERROR] Presets directory does not exist: {presets_dir}")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Neo Gallery Preprocessor")
    if not args.split_legacy:
        print(f"  Presets:  {presets_dir}")
    print(f"  Output:   {output_dir}")
    print(f"  Size:     {args.size}px")
    print(f"  Copy:     {'no' if args.no_copy else 'yes'}")

    if args.split_legacy:
        legacy = load_existing_index(index_path)
        if not legacy:
            print(f"[ERROR] No index.json to split in {output_dir}")
            sys.exit(1)
        master = split_legacy_index(output_dir, legacy)
        write_master_index(index_path, master)
        print(f"\n[DONE] {len(master['directories'])} directories split into per-directory indexes "
              f"({master_items(master)} items)")
        print(f"       master index: {index_path}")
        return

    incremental = bool(args.dirs or args.publish or args.tag_dirs)
    if args.dirs:
        print(f"  Dirs:     {', '.join(args.dirs)} (incremental)")
    if args.publish:
        print(f"  Publish:  {', '.join(args.publish)} (no media scan)")
    if args.tag_dirs:
        print(f"  Tag-only: {', '.join(args.tag_dirs)}")

    # Merge base: in incremental mode default to the latest master index on OSS
    existing = None
    fetch_url = ""
    if incremental and not args.draft:
        fetch_url = args.fetch_index
        if not args.no_fetch_index and not fetch_url:
            fetch_url = get_oss_index_url()
            if fetch_url:
                print(f"  OSS:      {fetch_url} (auto from configs/oss_presets.json)")
        if fetch_url:
            existing = fetch_index_from_url(fetch_url, index_path)
        else:
            existing = load_existing_index(index_path)
        if existing:
            print(f"  Merge:    into {len(existing['directories'])} directories from "
                  f"{'OSS' if fetch_url else 'existing index'}")

    if args.tag_dirs:
        known = set((existing or {}).get("directories", {}))
        unknown = [d for d in args.tag_dirs if d not in known]
        if unknown:
            print("[ERROR] Directory is not in the index (tags live in the master index): "
                  + ", ".join(unknown))
            sys.exit(1)
        fragment = {}
        scanned = list(args.tag_dirs)
    elif args.publish:
        fragment = {}
        for d in args.publish:
            loaded = load_dir_index(output_dir, d)
            if loaded is None:
                print(f"[ERROR] No directory index for '{d}': run --dirs {d} --no-fetch-index first")
                sys.exit(1)
            items, rev = loaded
            fragment[d] = master_entry(d, items, rev)
            print(f"  {d}: {len(items)} items published")
        scanned = list(args.publish)
    else:
        fragment = scan_presets_directory(presets_dir, output_dir, args.size, not args.no_copy, args.dirs)
        scanned = [d for d in (args.dirs or []) if d in fragment]
        if args.draft:
            print("\n[DRAFT] directory indexes written, master index left untouched")
            print(f"        publish later with: --publish {' '.join(args.dirs)}")
            return

    # Preserve the base_url of the fetched OSS index unless explicitly overridden
    base_url = args.base_url
    if not base_url and existing and existing.get("base_url"):
        base_url = existing["base_url"]
    if not base_url:
        base_url = get_oss_config().get("base_url", "") or ""

    master = build_master_index(existing, fragment, base_url,
                                None if args.tag_dirs else "presets", scanned,
                                tags=tags, clear_tags=args.clear_tags)
    write_master_index(index_path, master)
    print(f"\n[DONE] master index written to {index_path} "
          f"({len(master['directories'])} directories, {master_items(master)} items)")
    if tags:
        print(f"  Tags:     {', '.join(sorted(tags))} -> {len(scanned)} directories")
    elif args.clear_tags:
        print(f"  Tags:     cleared on {len(scanned)} directories")


if __name__ == "__main__":
    main()
