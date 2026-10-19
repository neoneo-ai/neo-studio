# SPDX-License-Identifier: Apache-2.0
# Neo Studio — Gallery Module (preset-based: image + .txt by same name)

import os
import re
import json
import base64
import asyncio
import hashlib
import random
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import aiohttp
from aiohttp import web
routes = web.RouteTableDef()
import folder_paths
import mimetypes
from PIL import Image

from .util import (
    IMG_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, ALL_MEDIA_EXTENSIONS,
    _has_media_recursive, _has_media_in_dir_any, _extract_media_metadata, _collect_prompt_texts,
    _load_settings, _save_settings, _json_safe,
)
# 收藏相关常量统一由 bookmark 模块提供（收藏后端逻辑收敛到 bookmark.py）。
# bookmark 不反向导入本模块，避免循环导入。
from . import civitai, plugin_paths
from .bookmark import (
    CIVITAI_BOOKMARK_DIR,
    CIVITAI_DIR_KEY,
    _is_civitai_bookmark_enabled,
)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
CURRENT_DIR = Path(__file__).parent.resolve()
CONFIGS_DIR = plugin_paths.CONFIGS_DIR
GALLERY_DIR = plugin_paths.GALLERY_DIR
PRESETS_DIR = GALLERY_DIR / "presets"
CUSTOM_DIR = GALLERY_DIR / "custom"
THUMBNAIL_DIR = GALLERY_DIR / "thumbnails"
LORA_CACHE_DIR = GALLERY_DIR / "lora_cache"
WAVEFORM_DIR = GALLERY_DIR / "waveform_cache"  # decoded audio waveform peaks (JSON)
# Main dirs (StoryBoard / CharacterSheet): browsable output subdirs. Character images land
# in output/CharacterSheet, storyboard sheets in output/StoryBoard. Cloud presets are
# cached in the Gallery oss_cache, never inside these dirs.
OUTPUT_DIR = Path(folder_paths.output_directory).resolve()
GRID_DIR = OUTPUT_DIR / "StoryBoard"
CHARACTER_DIR = OUTPUT_DIR / "CharacterSheet"
THUMBNAIL_SIZE = 320  # Fixed thumbnail size in pixels


def _get_system_dirs():
    """Return system directories (input/output) that are auto-provided by ComfyUI.

    Returns a list of dicts: [{\"path\": Path, \"name\": str, \"read_only\": True}, ...]
    Only includes dirs that actually exist on disk.
    """
    result = []
    for label in ("output", "input"):
        try:
            base_dir = getattr(folder_paths, f"{label}_directory")
            p = Path(base_dir).resolve()
            if p.exists():
                result.append({"path": p, "name": label.capitalize(), "read_only": True})
        except Exception:
            pass
    return result


def _resolve_system_dir(dir_name: str):
    """Resolve a dir_name/subfolder against the auto-provided Input/Output dirs.

    Returns (base_dir, relative_path) for names like "input" or "input/sub1",
    or None when dir_name does not reference a system dir.
    Bare relative paths (e.g. "sub1") are NOT resolved here; callers that need
    them must probe every system dir explicitly after custom dirs fail.
    """
    name = (dir_name or "").strip()
    if not name:
        return None
    name_lower = name.lower()
    for info in _get_system_dirs():
        sys_name = info["name"]
        if name_lower == sys_name.lower():
            return info["path"], ""
        if name_lower.startswith(sys_name.lower() + "/"):
            return info["path"], name[len(sys_name):].strip("/")
    return None


# 自定义目录列表在首页 list 与每一个封面缩略图请求里都要读一遍：settings 文件
# 要重新解析，NAS 目录的 exists()/resolve() 各是一次网络往返。整份结果以配置
# 文件的 mtime+size 为键缓存，目录的探测只在配置变化后付一次。
_CUSTOM_DIRS_CACHE: list[Path] | None = None
_CUSTOM_DIRS_KEY: tuple | None = None


def _settings_stamp() -> tuple:
    try:
        st = (CONFIGS_DIR / "gallery_settings.json").stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return (0, 0)


def _invalidate_user_custom_dirs() -> None:
    """Drop the cached custom dirs. The mtime stamp covers a normal save; this
    covers a filesystem with coarse mtime granularity, where a same-size save
    inside one tick leaves the stamp unchanged."""
    global _CUSTOM_DIRS_CACHE, _CUSTOM_DIRS_KEY
    _CUSTOM_DIRS_CACHE = None
    _CUSTOM_DIRS_KEY = None


def _scan_user_custom_dirs() -> list[Path]:
    """Read the configured dirs, dropping hidden ones and the ComfyUI system dirs."""
    picked: list[tuple[Path, str]] = []
    hidden: set[str] = set()
    try:
        settings_path = CONFIGS_DIR / "gallery_settings.json"
        if settings_path.exists():
            with open(settings_path, "r") as f:
                settings = json.load(f)
            user_dirs = settings.get("custom_directories", [])
            hidden_raw = settings.get("hidden_directories", [])
            if isinstance(hidden_raw, list):
                for h in hidden_raw:
                    if not h:
                        continue
                    hidden.add(str(h).lower())
                    try:
                        hidden.add(str(Path(h).resolve()).lower())
                    except OSError:
                        pass
            if isinstance(user_dirs, list):
                candidates = [d for d in user_dirs if d]
            elif user_dirs:
                candidates = [user_dirs] if isinstance(user_dirs, str) else []
            else:
                candidates = []
            for d in candidates:
                p = Path(d)
                if not p.exists():
                    continue
                # 每个目录只 resolve() 一次：旧代码在系统目录过滤和隐藏过滤里各
                # 解析一遍，NAS 路径就是两次往返。
                resolved_key = str(p).lower()
                try:
                    resolved_key = str(p.resolve()).lower()
                except OSError:
                    pass
                if str(p).lower() in hidden or resolved_key in hidden:
                    continue
                picked.append((p, resolved_key))
    except Exception:
        return []

    system_paths = {str(info["path"]).lower() for info in _get_system_dirs()}
    if system_paths:
        picked = [(p, key) for (p, key) in picked if key not in system_paths]
    return [p for (p, _key) in picked]


def _get_user_custom_dirs() -> list[Path]:
    """Get all user-configured custom directory paths from settings.

    Input/Output dirs are auto-provided by ComfyUI, so configured duplicates
    of them are skipped to avoid double-listing. Dirs hidden in the Manage
    Directories modal stay in the config but are not listed.
    """
    global _CUSTOM_DIRS_CACHE, _CUSTOM_DIRS_KEY
    key = _settings_stamp()
    if _CUSTOM_DIRS_CACHE is not None and key == _CUSTOM_DIRS_KEY:
        return list(_CUSTOM_DIRS_CACHE)
    dirs = _scan_user_custom_dirs()
    _CUSTOM_DIRS_CACHE = dirs
    _CUSTOM_DIRS_KEY = key
    return list(dirs)


# Home grid entries: built-in cards share one sort/hide list with the custom dirs.
HOME_BUILTINS = ("Output", "Input", "local_bookmarks", "civitai_bookmarks", "Lora")
DEFAULT_HOME_ORDER = ("Output", "Input", "local_bookmarks", "civitai_bookmarks")


def _get_hidden_entries() -> set:
    """Lowercased hidden entries: custom dir paths and built-in home keys."""
    hidden = set()
    raw = _load_settings().get("hidden_directories", [])
    if isinstance(raw, list):
        for h in raw:
            if not h:
                continue
            hidden.add(str(h).lower())
            try:
                hidden.add(str(Path(h).resolve()).lower())
            except OSError:
                pass
    return hidden


def _is_home_entry_hidden(key, hidden: set) -> bool:
    return str(key).lower() in hidden


def _oss_home_dir_tokens() -> list:
    """Cloud preset dirs as home-order tokens; reads the local index cache only, no network."""
    if not _is_oss_enabled():
        return []
    index = _load_oss_index_from_disk()
    if not index:
        return []
    return [f"{OSS_NAV_PREFIX}/{d}" for d in _oss_index_dirs(index)]


def _is_home_entry_token(token: str, dirs: list) -> bool:
    """顺序表与隐藏开关接受的 token：内置卡、自定义目录、云端预设目录。"""
    return token in dirs or token in HOME_BUILTINS or token in _oss_home_dir_tokens()


def _character_token_list(raw) -> list:
    """角色图目录的 token 列表 → 小写去重；配置里写成单个字符串也要能用。"""
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return list(dict.fromkeys(str(c).strip().lower() for c in raw if str(c or "").strip()))


def _purge_token_prefix(tokens: list, lowered: str) -> list:
    """剔掉 token 本身和它的子目录 token：角色图标记是逐段继承的，删目录要一起删干净。"""
    return [t for t in tokens if t != lowered and not t.startswith(lowered + "/")]


def _oss_character_dir_tokens() -> list:
    """索引里打了 character 标签的云端目录 token；只读本地索引缓存，不联网。"""
    if not _is_oss_enabled():
        return []
    index = _load_oss_index_from_disk()
    if not index:
        return []
    return [t.lower() for t in _oss_tagged_dir_tokens(index, OSS_TAG_CHARACTER_SHEET)]


def _effective_character_dirs(settings: dict) -> list:
    """角色图目录的有效 token：用户标记的目录 + 索引里打 character-sheet 标签的云端目录。

    标签是目录属性、和卡片在首页的位置无关：发布者给设定图目录打上 character-sheet 标签，别人拿到
    索引就自带角色图默认值（多选建配方走全参考），不用逐个点 👤。用户显式取消过的目录记在
    character_dirs_off 里，读取时剔掉，默认值不会把它顶回来。
    """
    marked = _character_token_list(settings.get("character_dirs"))
    cloud = _oss_character_dir_tokens()
    off = set(_character_token_list(settings.get("character_dirs_off")))
    return [t for t in dict.fromkeys(marked + cloud) if t not in off]


def _get_home_order() -> list:
    """Unified home order: built-in cards, custom dirs and cloud preset dirs in one list."""
    settings = _load_settings()
    dirs = settings.get("custom_directories", [])
    if not isinstance(dirs, list):
        dirs = [dirs] if isinstance(dirs, str) else []
    dirs = [d for d in dirs if d]
    stored = settings.get("home_order")
    if not isinstance(stored, list):
        return list(DEFAULT_HOME_ORDER) + dirs + ["Lora"] + _oss_home_dir_tokens()
    order = [t for t in stored if t]
    for d in dirs:
        if d not in order:
            order.append(d)
    for b in list(HOME_BUILTINS) + _oss_home_dir_tokens():
        if b not in order:
            order.append(b)
    return order


def _order_home_dirs(directories: list, home_order: list) -> list:
    """Sort the home listing by the unified order; entries outside the list keep their place."""
    remaining = list(directories)
    ordered = []
    for token in home_order:
        key = str(token).lower()
        if key in ("local_bookmarks", "civitai_bookmarks"):
            continue
        if key == "lora":
            group = [d for d in remaining if d["name"].lower() == "lora"
                     or d["name"].lower().startswith("lora/")]
        else:
            name = Path(str(token)).name.lower()
            group = [d for d in remaining if d["name"].lower() == name]
        ordered.extend(group)
        for d in group:
            remaining.remove(d)
    ordered.extend(remaining)
    return ordered


def _ensure_dirs() -> None:
    for d in (GALLERY_DIR, PRESETS_DIR, CUSTOM_DIR, THUMBNAIL_DIR, LORA_CACHE_DIR,
              CIVITAI_BOOKMARK_DIR):
        d.mkdir(parents=True, exist_ok=True)
    _repair_mislabeled_media()


def _repair_mislabeled_media() -> None:
    """Rename cached media whose extension doesn't match its real format.

    Older sync runs stored video samples as .png (MP4 bytes with a .png name),
    which image viewers and the gallery thumbnails cannot decode. Renaming to
    the real extension makes them playable without re-downloading.
    """
    if not LORA_CACHE_DIR.is_dir():
        return
    for p in LORA_CACHE_DIR.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in IMG_EXTENSIONS:
            continue
        try:
            with open(p, "rb") as f:
                head = f.read(16)
        except OSError:
            continue
        if len(head) >= 8 and head[4:8] == b"ftyp":
            target = p.with_suffix(".mp4")
            if not target.exists():
                try:
                    p.rename(target)
                except OSError:
                    pass



# ---------------------------------------------------------------------------
# OSS / Lora modules (split out of this file)
# ---------------------------------------------------------------------------
from .gallery_oss import (
    OSS_NAV_PREFIX,
    _is_oss_enabled,
    _load_oss_index_from_disk,
    _fetch_oss_index,
    _oss_index_dirs,
    _oss_directories_to_gallery_dirs,
    _collect_oss_covers,
    _handle_oss_gallery_list,
    _find_in_oss_index,
    _find_thumbnail_in_oss_index,
    _download_oss_file,
    _oss_dir_cards,
    _oss_dir_items,
    OSS_TAG_CHARACTER_SHEET,
    _oss_tagged_dir_tokens,
)

# 云端预设卡的三种导航前缀：首页的 Cloud Presets 卡与 StoryBoard/CharacterSheet 主目录里
# 只读的 presets 卡指向同一份索引，前缀只决定卡片出现在哪，不决定文件落在哪。
_OSS_NAV_PREFIXES = (OSS_NAV_PREFIX, "StoryBoard/presets", "CharacterSheet/presets")


def _oss_dir_from_subfolder(subfolder: str) -> str:
    """导航 subfolder 里的云端预设目录名；空串表示这是本地目录，不走云端索引。"""
    stripped = (subfolder or "").strip().rstrip("/")
    lowered = stripped.lower()
    for prefix in _OSS_NAV_PREFIXES:
        if lowered == prefix.lower():
            return ""
        if lowered.startswith(prefix.lower() + "/"):
            return stripped[len(prefix) + 1:]
    return ""


from .gallery_lora import (
    _lora_pending_subdirs,
    _attach_lora_meta,
    _attach_lora_subdir_paths,
    _ensure_auto_cache,
    _normalize_lora_dir,
)

# ---------------------------------------------------------------------------
# Directory enumeration
#
# Every gallery scan below runs through these helpers. os.scandir hands over
# the entry type and the stat data of one directory enumeration for free;
# Path.is_file() / Path.stat() re-query per entry, which on a network share
# (\\NAS\...) is a round trip per file and dominated the cost of opening a
# gallery directory.
# ---------------------------------------------------------------------------

def _scandir_files(directory: Path) -> list[os.DirEntry]:
    """Files of a directory, from a single enumeration."""
    try:
        with os.scandir(directory) as it:
            return [entry for entry in it if entry.is_file(follow_symlinks=False)]
    except OSError:
        return []


def _scandir_dirs(directory: Path) -> list[os.DirEntry]:
    """First-level subdirectories of a directory, in name order."""
    try:
        with os.scandir(directory) as it:
            return sorted((entry for entry in it if entry.is_dir(follow_symlinks=False)),
                          key=lambda entry: entry.name)
    except OSError:
        return []


def _scandir_split(directory: Path) -> tuple[list[os.DirEntry], list[os.DirEntry]]:
    """Files and first-level subdirs of a directory from a single enumeration."""
    files: list[os.DirEntry] = []
    dirs: list[os.DirEntry] = []
    try:
        with os.scandir(directory) as it:
            for entry in it:
                if entry.is_file(follow_symlinks=False):
                    files.append(entry)
                elif entry.is_dir(follow_symlinks=False):
                    dirs.append(entry)
    except OSError:
        return [], []
    return files, sorted(dirs, key=lambda entry: entry.name)


def _entry_stem(entry: os.DirEntry) -> str:
    return Path(entry.name).stem


def _entry_ext(entry: os.DirEntry) -> str:
    return Path(entry.name).suffix.lower()


def _parallel_map(fn, items: list, threshold: int = 8) -> list:
    """Map over items on a small pool once the count justifies one.

    A network share charges a round trip per file open, so the per-file
    header and sidecar reads are the part of a gallery scan that parallelizes.
    Sixteen requests is where the share stops pipelining any further.
    """
    if len(items) <= threshold:
        return [fn(item) for item in items]
    with ThreadPoolExecutor(16) as pool:
        return list(pool.map(fn, items))


def _read_text_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as tf:
            return tf.read()
    except OSError:
        return ""


def _pick_media_entries(directory: Path, files: list[os.DirEntry] | None = None) -> list[tuple[os.DirEntry, str, os.DirEntry | None]]:
    """Reduce a directory to (media entry, media type, paired txt entry) triples.

    Media and .txt files are grouped by stem and sorted by stem, the same
    order the old Path-based scan produced.
    """
    stems: dict[str, list[os.DirEntry]] = {}
    for entry in _scandir_files(directory) if files is None else files:
        ext = _entry_ext(entry)
        if ext not in ALL_MEDIA_EXTENSIONS and ext != ".txt":
            continue
        stems.setdefault(_entry_stem(entry), []).append(entry)

    picked: list[tuple[os.DirEntry, str, os.DirEntry | None]] = []
    for stem in sorted(stems):
        media_file = None
        media_type = None
        txt_file = None
        for entry in stems[stem]:
            ext = _entry_ext(entry)
            if ext in VIDEO_EXTENSIONS:
                media_file = entry
                media_type = "video"
            elif ext in IMG_EXTENSIONS:
                if media_file is None:
                    media_file = entry
                    media_type = "image"
            elif ext in AUDIO_EXTENSIONS:
                if media_file is None:
                    media_file = entry
                    media_type = "audio"
            elif ext == ".txt":
                txt_file = entry
        if media_file is not None:
            picked.append((media_file, media_type, txt_file))
    return picked


def _scan_gallery_entries_lightweight(directory: Path, files: list[os.DirEntry] | None = None) -> list[dict]:
    """Lightweight gallery entry scan - only filename + name + style + content for search.
    
    Minimal txt parsing (only first 2 lines), no full field extraction.
    Used by /neo_gallery/list when search_mode=1 to avoid heavy txt parsing.
    """
    entries: list[dict] = []
    picked = _pick_media_entries(directory, files)
    raw_txts = _parallel_map(lambda pair: _read_text_file(pair[2].path)[:500] if pair[2] is not None else "", picked)
    for (media_file, media_type, txt_file), raw_txt in zip(picked, raw_txts):
        entry: dict[str, object] = {
            "name": _entry_stem(media_file),
            "filename": media_file.name,
            "type": media_type,
            "style": "",
            "content": "",
            "mtime": media_file.stat(follow_symlinks=False).st_mtime,
        }

        # Extract style and content from first 2 lines only
        if raw_txt:
            try:
                lines = raw_txt.strip().splitlines()[:2]
                for i, line in enumerate(lines):
                    m = re.match(r"^\d+\s*\|\s*(.*)", line)
                    cleaned = m.group(1).strip() if m else line.strip()
                    if i == 0:
                        entry["style"] = cleaned
                    elif i == 1:
                        entry["content"] = cleaned
            except Exception:
                pass

        entries.append(entry)

    return entries


def _scan_directory_structure_only(directory: Path, dirs: list[os.DirEntry] | None = None) -> dict:
    """Scan directory and return only first-level subdirectory structure with image counts.

    Each subdirectory's image_count is a simple 0/1 flag indicating whether any media
    file exists within its subtree (including nested subdirectories), so deeply nested
    trees stay navigable without a full recursive file enumeration.

    This is the fastest possible scan - one scandir pass per level, no full txt parsing.
    Returns:
        {
            "subdirs": [{name: str, image_count: int(0|1), path: str}]
        }
    """
    subdirs = _scandir_dirs(directory) if dirs is None else dirs
    has_media = _parallel_map(lambda entry: _has_media_recursive(Path(entry.path)), subdirs)
    return {"subdirs": [{"name": entry.name,
                         "image_count": 1 if flag else 0,
                         "path": entry.name}
                        for entry, flag in zip(subdirs, has_media)]}


# Grid / Character are output subdirs this plugin browses (storyboard sheets /
# character images). Their cards are ordered by the newest media they hold, so
# what was just produced shows up first. Everything else (custom dirs, presets,
# lora cache, input, OSS) keeps its scan order.
_RECENT_DIR_KEYS = {"output", "storyboard", "charactersheet"}


def _is_recent_dir(dir_name: str) -> bool:
    """True for the plugin-updated dirs, including sub paths ("Grid/2026-09-24")."""
    return (dir_name or "").split("/", 1)[0].strip().lower() in _RECENT_DIR_KEYS


def _media_mtime(entry: os.DirEntry) -> float:
    """Media file mtime from a scandir entry (0.0 for other files)."""
    if Path(entry.name).suffix.lower() not in ALL_MEDIA_EXTENSIONS:
        return 0.0
    try:
        return entry.stat(follow_symlinks=False).st_mtime
    except OSError:
        return 0.0


def _add_recent_media(bucket: dict, entry: os.DirEntry, rel_dir: str, limit: int):
    """Track the newest mtime and the newest ``limit`` media files of one bucket.

    ``rel_dir`` is the path of the file's directory relative to the scanned root
    ("" for root-level files), which is what the cover subfolder is built from.
    """
    mtime = _media_mtime(entry)
    if not mtime:
        return
    if mtime > bucket["mtime"]:
        bucket["mtime"] = mtime
    covers = bucket["covers"]
    covers.append({
        "mtime": mtime,
        "filename": entry.name,
        "name": Path(entry.name).stem,
        "rel": rel_dir,
    })
    if len(covers) > limit:
        covers.sort(key=lambda c: c["mtime"], reverse=True)
        del covers[limit:]


def _scan_recent_media(directory: Path, limit: int) -> tuple[dict, dict[str, dict]]:
    """Newest media of a directory and of each of its direct children.

    One scandir pass per call: every bucket (the dir itself and each first-level
    child) keeps its newest ``limit`` media files, and nested files are attributed
    to the first-level child they sit under. A level listing therefore gets both
    the card order and the covers without walking once per card (entry.stat() is
    served from the directory enumeration cache on Windows).
    """
    own = {"mtime": 0.0, "covers": []}
    children: dict[str, dict] = {}
    if not directory.exists():
        return own, children

    try:
        with os.scandir(directory) as it:
            entries = list(it)
    except OSError:
        return own, children

    buckets = {"": own}
    pending: list[tuple[str, str]] = []
    for entry in entries:
        if entry.is_dir(follow_symlinks=False):
            children[entry.name] = {"mtime": 0.0, "covers": []}
            buckets[entry.name] = children[entry.name]
            pending.append((entry.path, entry.name))
        elif entry.is_file(follow_symlinks=False):
            _add_recent_media(own, entry, "", limit)

    while pending:
        current, rel_dir = pending.pop()
        bucket = buckets[rel_dir.split("/", 1)[0]]
        try:
            with os.scandir(current) as it:
                for entry in it:
                    if entry.is_dir(follow_symlinks=False):
                        pending.append((entry.path, f"{rel_dir}/{entry.name}"))
                    elif entry.is_file(follow_symlinks=False):
                        _add_recent_media(bucket, entry, rel_dir, limit)
        except OSError:
            continue

    for bucket in buckets.values():
        bucket["covers"].sort(key=lambda c: c["mtime"], reverse=True)
    return own, children


def _recent_media_buckets(directory: Path, limit: int) -> list[dict]:
    """Buckets of a plugin-updated dir: the dir itself plus each direct child.

    The read-only ``presets/`` subdir is a legacy cloud-preset cache left behind by
    the old category layout; it is a download, not generated content, so it never
    counts as an update of the dir that hosts it.
    """
    own, children = _scan_recent_media(directory, limit)
    children.pop("presets", None)
    return [own, *children.values()]


_COVER_KIND_RANK = {"image": 0, "video": 1, "audio": 2}


def _cover_kind(filename: str) -> str:
    """Cover tile kind for a media filename; drives frontend rendering (audio != <img>)."""
    ext = Path(filename).suffix.lower()
    if ext in IMG_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    return "other"


def _order_covers_by_kind(entries: list[dict]) -> list[dict]:
    """Stable-partition cover entries so images beat videos beat audio.

    Within a kind the original order (recency for recent dirs, name order otherwise)
    is preserved, so higher-priority media fills the limited cover slots first.
    """
    return sorted(entries, key=lambda e: _COVER_KIND_RANK.get(e.get("kind", "other"), 9))


def _cover_entry(entry: os.DirEntry, subfolder: str) -> dict:
    """Cover entry for a sampled dir entry.

    mtime only feeds the frontend cache-buster, so the caller stats the sampled
    pool and not the whole directory: a NAS folder with 400 files used to pay a
    round trip per file just to pick 2 covers.
    """
    try:
        mtime = entry.stat(follow_symlinks=False).st_mtime
    except OSError:
        mtime = 0.0
    return {
        "filename": entry.name,
        "name": _entry_stem(entry),
        "subfolder": subfolder,
        "kind": _cover_kind(entry.name),
        "mtime": mtime,
    }


def _recent_cover_entries(directory: Path, subfolder_prefix: str, count: int) -> list[dict]:
    """Newest media files anywhere under a plugin-updated dir, as cover entries.

    Each subfolder is anchored with ``subfolder_prefix`` so the thumbnail route
    resolves it the same way listing items do. Covers prefer image > video > audio
    at the same level (newest first within a kind) and carry a ``kind`` field so the
    frontend renders audio as a tile instead of a broken <img>.
    """
    candidates = [c for bucket in _recent_media_buckets(directory, count) for c in bucket["covers"]]
    for c in candidates:
        c["kind"] = _cover_kind(c["filename"])
    candidates.sort(key=lambda c: (_COVER_KIND_RANK.get(c["kind"], 9), -c["mtime"]))
    return [{
        "filename": c["filename"],
        "name": c["name"],
        "subfolder": "/".join(p for p in (subfolder_prefix, c["rel"]) if p),
        "kind": c["kind"],
        "mtime": c["mtime"],
    } for c in candidates[:count]]


def _sort_subdirs_by_recency(subdirs: dict, directory: Path):
    """Reorder plugin-updated subdir cards so the most recently written one is first.

    Ties (subdirs without media) keep the name order they were scanned in.
    """
    _, children = _scan_recent_media(directory, 1)
    ordered = sorted(subdirs.items(),
                     key=lambda kv: children.get(kv[0], {}).get("mtime", 0.0), reverse=True)
    subdirs.clear()
    subdirs.update(ordered)


_DIM_CACHE: dict[tuple[str, int, int], tuple[int, int]] = {}
_DIM_CACHE_LIMIT = 6000
_DIM_CACHE_LOADED = False


def _dim_cache_file() -> Path:
    return CONFIGS_DIR / "gallery_dim_cache.json"


def _load_dim_cache() -> None:
    global _DIM_CACHE_LOADED
    _DIM_CACHE_LOADED = True
    try:
        with open(_dim_cache_file(), "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return
    for key, size in raw.items():
        path, _, rest = key.partition("\u001f")
        mtime, _, sz = rest.partition("\u001f")
        try:
            _DIM_CACHE[(path, int(mtime), int(sz))] = (size[0], size[1])
        except (TypeError, IndexError, ValueError):
            continue


def _save_dim_cache() -> None:
    path = _dim_cache_file()
    raw = {f"{key[0]}{key[1]}{key[2]}": list(size) for key, size in _DIM_CACHE.items()}
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(raw, f)
        tmp.replace(path)
    except OSError:
        tmp.unlink(missing_ok=True)


def _media_dimensions(path: Path) -> tuple[int, int] | None:
    """Pixel size of an image, read from the file header without decoding it."""
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        return None


def _media_dimensions_batch(items: list[tuple[Path, os.stat_result]]) -> dict[Path, tuple[int, int] | None]:
    """Header sizes of many images at once, keyed by path.

    Each header is a separate open on the share, so serial reads cost one
    round trip per card; they run on a small pool instead. Sizes are memoized
    by (path, mtime_ns, size) in a file, so re-opening a directory - even
    after a restart, when the share's own cache is cold - reads nothing.
    """
    sizes: dict[Path, tuple[int, int] | None] = {}
    todo: list[tuple[Path, tuple[str, int, int]]] = []
    if not _DIM_CACHE_LOADED:
        _load_dim_cache()
    for path, st in items:
        key = (str(path), st.st_mtime_ns, st.st_size)
        cached = _DIM_CACHE.get(key)
        if cached is None:
            todo.append((path, key))
        sizes[path] = cached

    if todo:
        found = _parallel_map(_media_dimensions, [path for path, _ in todo])
        added = False
        for (path, key), size in zip(todo, found):
            sizes[path] = size
            if size:
                _DIM_CACHE[key] = size
                added = True
        if added:
            if len(_DIM_CACHE) > _DIM_CACHE_LIMIT:
                for stale in list(_DIM_CACHE)[:_DIM_CACHE_LIMIT // 2]:
                    del _DIM_CACHE[stale]
            _save_dim_cache()
    return sizes


def _scan_gallery_entries(directory: Path, subfolder: str = "",
                          files: list[os.DirEntry] | None = None) -> list[dict]:
    """Scan directory (non-recursive) and return gallery entries.
    
    Supports both image and video files, paired with .txt by same stem.
    The 'filename' field always contains the media filename, not .txt.
    Video entries have 'type': 'video', image entries have 'type': 'image'.
    
    NOTE: Parses .txt files to include txt_content for lightbox display.
    
    Args:
        directory: The directory to scan.
        subfolder: Optional relative path from the custom directory root.
            Used to set the 'subfolder' field for correct thumbnail URL resolution.
    """
    entries: list[dict] = []

    # Determine category and subfolder from the subfolder parameter
    # When subfolder is provided, we're scanning a specific subdirectory,
    # so don't use subfolder name as category (that would group all entries under it)
    category = ""

    rows: list[tuple[os.DirEntry, str, os.DirEntry | None, os.stat_result]] = []
    for media_file, media_type, txt_file in _pick_media_entries(directory, files):
        try:
            rows.append((media_file, media_type, txt_file, media_file.stat(follow_symlinks=False)))
        except OSError:
            continue

    # Card aspect ratio straight from the header: the frontend lays the grid out
    # before any thumbnail is fetched.
    dims = _media_dimensions_batch([(Path(media_file.path), st)
                                   for media_file, media_type, _, st in rows if media_type == "image"])

    txt_rows = [i for i, row in enumerate(rows) if row[2] is not None]
    raw_txts: list[str] = [""] * len(rows)
    for i, raw in zip(txt_rows, _parallel_map(_read_text_file, [rows[i][2].path for i in txt_rows])):
        raw_txts[i] = raw

    for idx, (media_file, media_type, txt_file, st) in enumerate(rows):
        # Parse .txt file for lightbox display (only when txt exists)
        raw_txt = raw_txts[idx]

        # Build entry with txt_content when available
        entry: dict[str, object] = {
            "name": _entry_stem(media_file),
            "filename": media_file.name,
            "type": media_type,
            "category": category,
            "subfolder": subfolder,
            "mtime": st.st_mtime,
        }
        size = dims.get(Path(media_file.path))
        if size:
            entry["w"], entry["h"] = size
        if raw_txt:
            cleaned_lines = [""] * 8
            try:
                lines = raw_txt.strip().splitlines()
                for i, line in enumerate(lines):
                    if i >= 8:
                        break
                    m = re.match(r"^\d+\s*\|\s*(.*)", line)
                    cleaned_lines[i] = m.group(1) if m else line
            except Exception:
                pass
            txt_content = "\n".join(cleaned_lines).strip()
            if txt_content:
                entry["txt_content"] = txt_content

        entries.append(entry)

    return entries


def _scan_gallery_entries_with_subdirs(directory: Path, subfolder: str = "") -> dict:
    """Scan directory and return entries grouped by FIRST-LEVEL subdirectory only.
    
    Only returns immediate children directories (one level), does NOT recurse into nested dirs.
    This ensures the presets home page shows only one level of subdirectories.
    
    NOTE: Does NOT parse .txt files - only returns filename + type info for performance.
    
    Supports both image and video files.
    """
    result = {"root": [], "subdirs": {}}

    # Lightweight entry - no txt parsing for performance
    for media_file, media_type, _txt_file in _pick_media_entries(directory):
        result["root"].append({
            "name": _entry_stem(media_file),
            "filename": media_file.name,
            "type": media_type,
            "category": "",
            "subfolder": "",
            "mtime": media_file.stat(follow_symlinks=False).st_mtime,
        })

    # Only scan FIRST-LEVEL subdirectories (no recursion)
    for entry in _scandir_dirs(directory):
        subdir_entries = _scan_gallery_entries(Path(entry.path), entry.name)
        if subdir_entries:
            result["subdirs"][entry.name] = subdir_entries

    return result



# ---------------------------------------------------------------------------
# Helper Functions for Directory Processing
# ---------------------------------------------------------------------------

def _build_dir_response(dir_info: dict, scan_result: dict, include_dirs: bool, include_items: bool) -> dict:
    """Build a single directory response dict based on requested fields."""
    resp = {
        "name": dir_info["name"],
        "path": dir_info["path"],
        "read_only": dir_info.get("read_only", False),
    }
    
    if include_dirs:
        resp["subdirs"] = scan_result.get("subdirs", {})
        # Prefer an explicit count (needed when items are lazy-loaded and not scanned),
        # otherwise derive it from the loaded root items.
        resp["root_count"] = scan_result.get("root_count", len(scan_result.get("root", [])))
    
    if include_items:
        resp["items"] = scan_result.get("root", [])
    
    return resp


def _process_single_directory(dir_path: Path, dir_name: str, rel_path: str, read_only: bool, 
                               include_dirs: bool, include_items: bool, search_mode: bool,
                               scan_entries: tuple[list[os.DirEntry], list[os.DirEntry]] | None = None) -> dict:
    """Process a single directory: scan based on fields and build response."""
    # Resolve target directory
    if rel_path:
        parts = [p for p in rel_path.split("/") if p]
        target_dir = dir_path
        for part in parts:
            target_dir = target_dir / part
    else:
        target_dir = dir_path
    
    # Scan based on fields requested
    scan_result = {}
    if include_dirs or include_items:
        # One enumeration feeds the item scan, the subdir structure and the root count.
        if scan_entries is None:
            scan_entries = _scandir_split(target_dir)
        file_entries, dir_entries = scan_entries
        if search_mode and include_items:
            entries = _scan_gallery_entries_lightweight(target_dir, file_entries)
            scan_result["root"] = entries
            scan_result["subdirs"] = {}
        elif include_items:
            # Use non-recursive scan for current directory only
            entries = _scan_gallery_entries(target_dir, rel_path, file_entries)
            scan_result["root"] = entries
            # Only get subdirs structure if requested (not needed when include_dirs=False)
            if include_dirs:
                structure = _scan_directory_structure_only(target_dir, dir_entries)
                scan_result["subdirs"] = {s["name"]: {"image_count": s["image_count"]} for s in structure.get("subdirs", [])}
            else:
                scan_result["subdirs"] = {}
        else:
            # Only dirs needed, use lightweight scan
            structure = _scan_directory_structure_only(target_dir, dir_entries)
            scan_result["subdirs"] = {s["name"]: {"image_count": s["image_count"]} for s in structure.get("subdirs", [])}
            scan_result["root"] = []
            scan_result["root_count"] = sum(
                1 for entry in file_entries
                if _entry_ext(entry) in ALL_MEDIA_EXTENSIONS
            )

    # Plugin-updated dirs (Output / Grid / Character) show the most recently written
    # subdir card first; other dirs keep their scanned name order.
    if scan_result.get("subdirs") and _is_recent_dir(dir_name):
        _sort_subdirs_by_recency(scan_result["subdirs"], target_dir)

    # Build directory info
    dir_info = {
        "name": dir_name,
        "path": f"{dir_name}/{rel_path}" if rel_path else dir_name,
        "read_only": read_only,
    }
    
    # Build response
    resp_dir = _build_dir_response(dir_info, scan_result, include_dirs, include_items)
    
    # Add custom_source for items
    if include_items and "items" in resp_dir:
        for entry in resp_dir["items"]:
            entry["custom_source"] = dir_name
    
    return resp_dir


def _process_home_directory(dir_path: Path, dir_name: str, read_only: bool,
                            include_dirs: bool, include_items: bool, search_mode: bool):
    """Scan one home directory once and return the enumeration with its response.

    The home page needs the same first-level enumeration for the directory card and
    for the cover picks; on a network share each extra scandir is a round trip, so
    the cover pass reuses this one instead of opening the directory again.
    """
    scan_entries = _scandir_split(dir_path)
    resp_dir = _process_single_directory(dir_path, dir_name, "", read_only,
                                         include_dirs, include_items, search_mode, scan_entries)
    return resp_dir, scan_entries


# ---------------------------------------------------------------------------
# Main dirs (StoryBoard / CharacterSheet): output subdirs holding generated results
# (<date>/ subfolders). Their read-only "Cloud Presets" card lists the remote preset
# dirs; the preset files themselves are cached in the Gallery oss_cache, not here.
# ---------------------------------------------------------------------------
_MAIN_DIRS = {
    "StoryBoard": GRID_DIR,
    "CharacterSheet": CHARACTER_DIR,
}


async def _handle_main_dir_list(dir_name_param: str, rel_path_param: str, base: Path,
                                include_dirs: bool, include_items: bool,
                                include_covers: bool) -> web.Response:
    """Handle /neo_gallery/list for the StoryBoard/CharacterSheet main dirs.

    Local generated results are scanned normally (the presets/ cache is skipped);
    a read-only "Cloud Presets" card is injected at the top level and
    path=presets[/<oss-dir>] lists the remote preset dirs under this main dir.
    """
    # Deep links may carry the sub path in dir_name ("StoryBoard/presets/<dir>"); names and
    # navigation prefixes are always built from the main dir label.
    main_label = dir_name_param.split("/", 1)[0]
    presets_prefix = f"{main_label}/presets"
    rel_lower = rel_path_param.lower()

    if rel_lower == "presets":
        oss_index = await _fetch_oss_index()
        if not oss_index:
            return web.json_response({"error": "OSS not configured or index unavailable"}, status=404)
        resp_dir = {
            "name": presets_prefix,
            "path": presets_prefix,
            "read_only": True,
            "source": "oss",
            "subdirs": _oss_dir_cards(oss_index),
            "root_count": 0,
            "items": [],
        }
        response_data = {"directories": [resp_dir], "total": 0}
        if include_covers:
            covers: dict[str, list[dict]] = {}
            _collect_oss_covers(covers, oss_index, presets_prefix)
            response_data["covers"] = covers
        return web.json_response(response_data)

    if rel_lower.startswith("presets/"):
        oss_dir = rel_path_param[len("presets/"):]
        oss_index = await _fetch_oss_index()
        if not oss_index or oss_dir not in _oss_dir_cards(oss_index):
            return web.json_response({"error": f"OSS directory not found: {oss_dir}"}, status=404)
        items = await _oss_dir_items(oss_index, oss_dir, presets_prefix)
        resp_dir = {
            "name": f"{presets_prefix}/{oss_dir}",
            "path": f"{presets_prefix}/{oss_dir}",
            "read_only": True,
            "source": "oss",
            "subdirs": {},
            "root_count": len(items),
            "items": items,
        }
        response_data = {"directories": [resp_dir], "total": len(items)}
        if include_covers:
            covers = {}
            _collect_oss_covers(covers, oss_index, presets_prefix)
            response_data["covers"] = covers
        return web.json_response(response_data)

    resp_dir = await asyncio.to_thread(_process_single_directory, base, dir_name_param, rel_path_param, False,
                                       include_dirs, include_items, False)
    if "subdirs" in resp_dir:
        resp_dir["subdirs"].pop("presets", None)  # read-only cache is surfaced via the injected card
    if not rel_path_param and _is_oss_enabled():
        oss_index = _load_oss_index_from_disk() or await _fetch_oss_index()
        if oss_index:
            cards = _oss_dir_cards(oss_index)
            if cards:
                resp_dir.setdefault("subdirs", {})["Cloud Presets"] = {
                    "image_count": sum(c.get("image_count", 0) for c in cards.values()),
                    "path": "presets",
                    "read_only": True,
                    "source": "oss",
                }

    response_data = {"directories": [resp_dir], "total": len(resp_dir.get("items", []))}
    if include_covers:
        covers: dict[str, list[dict]] = {}
        target_dir = base
        for part in [p for p in rel_path_param.split("/") if p]:
            target_dir = target_dir / part
        # Covers are keyed by the navigation path of the card they belong to
        # ("Character/2026-09-24"), with subfolders carrying the same main-dir
        # anchored prefix so the thumbnail route picks the right main dir.
        full_key = f"{main_label}/{rel_path_param}" if rel_path_param else main_label

        def _collect_dir_covers():
            _collect_all_dir_covers(covers, target_dir, full_key, 3, base_subfolder=full_key)
            # Immediate child subdirs need covers of their own, otherwise their cards
            # render as bare folder placeholders when this level is displayed.
            for subdir_name in resp_dir.get("subdirs", {}):
                if subdir_name == "Cloud Presets":
                    continue
                child_key = f"{full_key}/{subdir_name}"
                _collect_all_dir_covers(covers, target_dir / subdir_name, child_key, 3,
                                        base_subfolder=child_key)

        await asyncio.to_thread(_collect_dir_covers)

        oss_index = _load_oss_index_from_disk() or await _fetch_oss_index()
        if oss_index:
            _collect_oss_covers(covers, oss_index, presets_prefix)
            # The injected read-only entry aggregates the OSS presets: borrow the
            # first preset cover so the card is not an empty placeholder.
            if not rel_path_param:
                first_oss_key = next((k for k in covers if k.startswith(f"{main_label}/presets/")), "")
                if first_oss_key:
                    covers[f"{main_label}/presets"] = covers[first_oss_key]
        response_data["covers"] = covers
    return web.json_response(response_data)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@routes.get("/neo_gallery/list")
async def get_gallery_list(request):
    """Return unified gallery listing (all directories, presets subdirs treated as read-only dirs).
    
    Query parameters:
    - fields: comma-separated list of fields to return. Supported values: dirs, items, covers
      Default: "dirs" when dir_name is provided, "dirs,items,covers" otherwise
    - dir_name: name of the custom directory or 'presets' (optional)
      If provided, returns data for that specific directory only (merges subdirs functionality)
    - path: relative subdirectory path within that directory (optional, "/" separated)
    
    Examples:
    - /neo_gallery/list -> full listing with dirs, items, covers
    - /neo_gallery/list?fields=dirs -> only directory structure (fast)
    - /neo_gallery/list?fields=items&dir_name=presets -> only items for presets
    - /neo_gallery/list?fields=dirs,covers&dir_name=myfolder&path=sub1/sub2
    
    Supports lightweight search mode via 'search_mode=1':
    - Returns only filename + name + style + content for each entry (no txt parsing overhead)
    
    Automatically includes cover images (samples: 3 per directory) to avoid a separate request.
    """
    fields_param = request.rel_url.query.get("fields", "")
    dir_name_param = request.rel_url.query.get("dir_name", "")
    rel_path_param = request.rel_url.query.get("path", "")
    search_mode = request.rel_url.query.get("search_mode", "0") == "1"
    
    # Parse fields parameter (comma-separated)
    if fields_param:
        requested_fields = {f.strip().lower() for f in fields_param.split(",") if f.strip()}
    else:
        requested_fields = set()
    
    user_custom_dirs = _get_user_custom_dirs()
    
    # Determine which fields to return
    has_dir_name = bool(dir_name_param)
    if has_dir_name:
        # When dir_name is provided, default to all fields
        include_dirs = "dirs" in requested_fields or not requested_fields
        include_items = "items" in requested_fields or not requested_fields
        include_covers = "covers" in requested_fields or not requested_fields
    else:
        # Default behavior for full listing
        include_dirs = "dirs" in requested_fields or not requested_fields
        include_items = "items" in requested_fields or not requested_fields
        include_covers = "covers" in requested_fields or not requested_fields
    
    directories = []
    
    # Handle dir_name parameter (merged subdirs functionality)
    if has_dir_name:
        # Resolve base directory from dir_name
        base: Path | None = None
        dir_name_lower = dir_name_param.lower()

        # Main dirs (StoryBoard / CharacterSheet): plugin-owned generated results.
        # dir_name may carry the sub path ("StoryBoard/presets/26-06-25") for deep links.
        main_key = dir_name_lower.split("/", 1)[0]
        main_base = next((d for k, d in _MAIN_DIRS.items() if k.lower() == main_key), None)
        if main_base:
            if not rel_path_param and "/" in dir_name_param:
                rel_path_param = dir_name_param.split("/", 1)[1]
            return await _handle_main_dir_list(dir_name_param, rel_path_param, main_base,
                                               include_dirs, include_items, include_covers)

        if dir_name_lower == "presets" or dir_name_lower.startswith("presets/"):
            base = PRESETS_DIR
            if not rel_path_param and dir_name_lower != "presets":
                rel_path_param = dir_name_lower[len("presets/"):]
        elif dir_name_lower == "lora" or dir_name_lower.startswith("lora/"):
            if not _load_settings().get("civitai_lora_enabled") or _is_home_entry_hidden("Lora", _get_hidden_entries()):
                return web.json_response({"directories": [], "total": 0})
            base = LORA_CACHE_DIR
            if not rel_path_param:
                rel_path_param = dir_name_param[len("lora/"):]
            await _ensure_auto_cache()
        elif dir_name_lower == CIVITAI_DIR_KEY.lower() or dir_name_lower.startswith(CIVITAI_DIR_KEY.lower() + "/"):
            if not _is_civitai_bookmark_enabled() or _is_home_entry_hidden(CIVITAI_DIR_KEY, _get_hidden_entries()):
                return web.json_response({"directories": [], "total": 0})
            base = CIVITAI_BOOKMARK_DIR
            if not rel_path_param and dir_name_lower != CIVITAI_DIR_KEY.lower():
                rel_path_param = dir_name_param[len(CIVITAI_DIR_KEY) + 1:]
        else:
            if _is_home_entry_hidden(dir_name_lower.split("/", 1)[0], _get_hidden_entries()):
                return web.json_response({"directories": [], "total": 0})
            system = _resolve_system_dir(dir_name_param)
            if system:
                base = system[0]
                if not rel_path_param:
                    rel_path_param = system[1]
            else:
                for dir_path in user_custom_dirs:
                    d_name = dir_path.name if dir_path.name else str(dir_path)
                    if d_name.lower() == dir_name_lower:
                        base = dir_path
                        break
        
        # Handle Cloud Presets (OSS remote)
        if dir_name_lower == "cloud presets" or dir_name_lower.startswith("cloud presets/"):
            return await _handle_oss_gallery_list(dir_name_param, rel_path_param,
                                                   include_dirs, include_items, include_covers, search_mode,
                                                   _get_hidden_entries())

        if base is None or not base.exists():
            return web.json_response({"error": "Directory not found"}, status=404)

        is_presets = dir_name_lower == "presets" or dir_name_lower.startswith("presets/")
        is_lora = dir_name_lower == "lora" or dir_name_lower.startswith("lora/")
        is_system = _resolve_system_dir(dir_name_param) is not None
        is_civitai = dir_name_lower == CIVITAI_DIR_KEY.lower() or dir_name_lower.startswith(CIVITAI_DIR_KEY.lower() + "/")
        
        # For presets subdirectories (e.g., Presets/10秒), only show images without nested subdir cards
        # This prevents showing two levels of subdirectory structure on the home page
        is_presets_subdir = dir_name_lower.startswith("presets/") and not rel_path_param
        
        # Process single directory using unified function
        if is_presets_subdir:
            # For presets subdirs, only return items (no subdirs structure)
            resp_dir = await asyncio.to_thread(_process_single_directory, base, dir_name_param, rel_path_param, True, 
                                                  include_dirs=False, include_items=True, search_mode=search_mode)
            # Override to ensure no subdirs are shown
            if "subdirs" not in resp_dir:
                resp_dir["subdirs"] = {}
        else:
            resp_dir = await asyncio.to_thread(_process_single_directory, base, dir_name_param, rel_path_param, is_presets or is_lora or is_system or is_civitai, 
                                                  include_dirs, include_items, search_mode)
        
        # Civitai bookmark example cache: anchor item subfolders to the stable
        # "civitai_bookmarks/<key>" prefix so the image/thumbnail routes resolve them.
        if is_civitai and include_items and resp_dir.get("items"):
            for it in resp_dir["items"]:
                it["subfolder"] = f"civitai_bookmarks/{rel_path_param}"

        if is_lora and include_items:
            await asyncio.to_thread(_attach_lora_meta, resp_dir, rel_path_param)

        # Give leaf lora subdir cards their exact lora_path so the workflow filter
        # ("工作流已用") can match them against loras on the canvas.
        if is_lora:
            await asyncio.to_thread(_attach_lora_subdir_paths, resp_dir, rel_path_param)

        # Show configured lora dirs with no cached examples yet as pending cards
        # (empty subdirs are otherwise filtered out by the UI).
        if is_lora and not rel_path_param:
            for sub_name, meta in (await asyncio.to_thread(_lora_pending_subdirs)).items():
                subdirs = resp_dir.setdefault("subdirs", {})
                entry = subdirs.setdefault(sub_name, {"image_count": 0, "path": sub_name})
                entry.update(meta)
        
        # Add covers if requested
        if include_covers:
            covers: dict[str, list[dict]] = {}
            # When has_dir_name, we need to use the actual target directory for covers
            # If rel_path is provided, use the target directory (e.g., Ai舞蹈素材/10秒)
            # If no rel_path, use the base directory (e.g., Ai舞蹈素材)
            target_dir = base
            if rel_path_param:
                parts = [p for p in rel_path_param.split("/") if p]
                for part in parts:
                    target_dir = target_dir / part
            
            # Use the full path as the key for covers
            full_key = f"{dir_name_param}/{rel_path_param}" if rel_path_param else dir_name_param
            # Lora covers must resolve inside LORA_CACHE_DIR, so their subfolder is
            # anchored with a "Lora/" prefix (same prefix _find_source_media expects).
            lora_anchor = f"Lora/{rel_path_param}" if (is_lora and rel_path_param) else ("Lora" if is_lora else "")
            # Anchor the current level's covers to the dir root as well, so they resolve
            # when browsing below the top level (e.g. Output/StoryBoard).
            await asyncio.to_thread(_collect_all_dir_covers, covers, target_dir, full_key, 2,
                                    lora_anchor or rel_path_param)
            
            # Also collect covers for immediate child subdirectories (like homepage does)
            # This ensures subdir cards show cover images when entering a directory
            if include_dirs and "subdirs" in resp_dir:
                for subdir_name, subdir_info in resp_dir.get("subdirs", {}).items():
                    subdir_path = target_dir / subdir_name
                    child_key = f"{full_key}/{subdir_name}"
                    # Anchor base_subfolder to the custom-dir root so returned subfolders
                    # are full relative paths the thumbnail endpoint can resolve.
                    if lora_anchor:
                        child_base_subfolder = f"{lora_anchor}/{subdir_name}"
                    else:
                        child_base_subfolder = (
                            f"{rel_path_param}/{subdir_name}" if rel_path_param else subdir_name
                        )
                    await asyncio.to_thread(_collect_all_dir_covers, covers, subdir_path, child_key, 2, child_base_subfolder)
            
            return web.json_response({
                "directories": [resp_dir],
                "total": len(resp_dir.get("items", [])),
                "covers": covers
            })
        
        return web.json_response({
            "directories": [resp_dir],
            "total": len(resp_dir.get("items", []))
        })
    
    # Original behavior: full listing (no dir_name) - process all directories using unified function
    hidden_entries = _get_hidden_entries()
    # 首页目录卡与封面共用同一次一级枚举：网络盘上一次 scandir 就是一次往返，
    # 封面阶段再扫一遍等于把这段开销付两次。
    home_scans: dict[str, tuple[list[os.DirEntry], list[os.DirEntry]]] = {}

    # System dirs (input/output) — auto-provided by ComfyUI, read-only
    for info in _get_system_dirs():
        if _is_home_entry_hidden(info["name"], hidden_entries):
            continue
        resp_dir, home_scans[info["name"]] = await asyncio.to_thread(
            _process_home_directory, info["path"], info["name"], True, include_dirs, include_items, search_mode)
        directories.append(resp_dir)

    # Custom dirs (writable)
    for dir_path in user_custom_dirs:
        dir_name = dir_path.name if dir_path.name else str(dir_path)
        resp_dir, home_scans[dir_name] = await asyncio.to_thread(
            _process_home_directory, dir_path, dir_name, False, include_dirs, include_items, search_mode)
        directories.append(resp_dir)

    # Presets: process root and subdirs using unified function
    if (include_dirs or include_items):
        # PERFORMANCE: When lazy-loaded (no items), use lightweight scan that only returns structure + counts.
        # This avoids scanning all .txt files on home page load.
        if include_items:
            presets_structure = await asyncio.to_thread(_scan_gallery_entries_with_subdirs, PRESETS_DIR)
        else:
            # Lightweight mode: only directory names and image counts, no txt parsing
            lightweight_result = _scan_directory_structure_only(PRESETS_DIR)
            presets_structure = {"root": [], "subdirs": {}}
            for sd in lightweight_result.get("subdirs", []):
                presets_structure["subdirs"][sd["name"]] = []  # Empty list triggers card display
        
        presets_root = presets_structure.get("root", [])
        presets_subdirs = presets_structure.get("subdirs", {})

        # Root-level presets items go into a "Presets" read-only directory (lazy-loaded too when no items requested)
        resp_dir = await asyncio.to_thread(_process_single_directory, PRESETS_DIR, "Presets", "", True, 
                                              include_dirs, include_items, search_mode)
        directories.append(resp_dir)

        # Each presets subdir becomes its own read-only directory (only first-level subdirs)
        # NOTE: Only show presets subdirectory cards when include_items=True.
        # When lazy-loaded (include_items=False), only show the root "Presets" dir.
        for subdir_name in sorted(presets_subdirs.keys()):
            subdir_items = presets_subdirs[subdir_name]
            if subdir_items or include_items:
                # For presets subdirectories, only return items when requested
                resp_dir = await asyncio.to_thread(_process_single_directory, PRESETS_DIR, 
                                                      f"Presets/{subdir_name}", subdir_name, True,
                                                      include_dirs=False, include_items=include_items, search_mode=search_mode)
                # Ensure no subdirs are shown for presets children
                if "subdirs" not in resp_dir:
                    resp_dir["subdirs"] = {}
                directories.append(resp_dir)

    # Lora example cache (read-only; one directory per lora, mirrors the presets model)
    # 关闭「启用 C 站 LORA」或在排序列表里隐藏 Lora 时，整个 Lora 板块不出现（已缓存目录、状态卡、封面都不加载）。
    lora_home = bool(_load_settings().get("civitai_lora_enabled")) and not _is_home_entry_hidden("Lora", hidden_entries)
    if lora_home and LORA_CACHE_DIR.exists():
        if include_items:
            lora_structure = await asyncio.to_thread(_scan_gallery_entries_with_subdirs, LORA_CACHE_DIR)
        else:
            lora_lightweight = await asyncio.to_thread(_scan_directory_structure_only, LORA_CACHE_DIR)
            lora_structure = {"root": [], "subdirs": {}}
            for sd in lora_lightweight.get("subdirs", []):
                lora_structure["subdirs"][sd["name"]] = []

        resp_dir = await asyncio.to_thread(_process_single_directory, LORA_CACHE_DIR, "Lora", "", True,
                                              include_dirs, include_items, search_mode)
        if include_items:
            await asyncio.to_thread(_attach_lora_meta, resp_dir, "")
        directories.append(resp_dir)

        for subdir_name in sorted(lora_structure.get("subdirs", {}).keys()):
            subdir_items = lora_structure["subdirs"][subdir_name]
            if subdir_items or include_items:
                resp_dir = await asyncio.to_thread(_process_single_directory, LORA_CACHE_DIR,
                                                      f"Lora/{subdir_name}", subdir_name, True,
                                                      include_dirs=False, include_items=include_items, search_mode=search_mode)
                # Ensure no subdirs are shown for lora children (navigation goes through dir_name=lora&path=...)
                if "subdirs" not in resp_dir:
                    resp_dir["subdirs"] = {}
                if include_items:
                    await asyncio.to_thread(_attach_lora_meta, resp_dir, subdir_name)
                directories.append(resp_dir)

        # Configured lora dirs with no cached examples yet show up as pending cards,
        # so the full listing matches the sync selection instead of hiding empty dirs.
        for sub_name, meta in sorted((await asyncio.to_thread(_lora_pending_subdirs)).items()):
            if sub_name in lora_structure.get("subdirs", {}):
                continue
            resp_dir = {
                "name": f"Lora/{sub_name}",
                "path": f"Lora/{sub_name}",
                "read_only": True,
                "subdirs": {},
                "root_count": 0,
                "pending": True,
                "civitai": meta.get("civitai"),
            }
            directories.append(resp_dir)

    # OSS remote directories
    oss_index = None
    if _is_oss_enabled():
        oss_index = _load_oss_index_from_disk()
        if oss_index is None:
            oss_index = await _fetch_oss_index()
        if oss_index:
            oss_dirs = _oss_directories_to_gallery_dirs(oss_index)
            # 云端预设目录在「目录管理」里逐卡隐藏，隐藏后首页不出这张卡。
            directories.extend(d for d in oss_dirs
                               if not _is_home_entry_hidden(d["path"], hidden_entries))

    directories = _order_home_dirs(directories, _get_home_order())

    total = sum(len(d.get("items", [])) for d in directories)

    # Build response with covers if requested
    response_data: dict = {"directories": directories, "total": total}

    if include_covers:
        covers: dict[str, list[dict]] = {}
        await asyncio.to_thread(_collect_home_covers, covers, user_custom_dirs, hidden_entries, lora_home, oss_index, home_scans)
        response_data["covers"] = covers

    return web.json_response(response_data)


CURRENT_WEB_DIR = CURRENT_DIR / "web"

_PLACEHOLDER_PNG = bytes([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
    0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
])


@routes.get("/neo_gallery/css")
async def serve_css(request):
    css_path = CURRENT_WEB_DIR / "gallery.css"
    if css_path.exists():
        with open(css_path, "r", encoding="utf-8") as f:
            css_content = f.read()
        return web.Response(text=css_content, content_type="text/css")
    return web.Response(status=404)


@routes.get("/neo_gallery/placeholder.png")
async def serve_placeholder(request):
    return web.Response(body=_PLACEHOLDER_PNG, content_type="image/png")


def _copy_media_to_input(source_path: Path, filename: str) -> tuple[str, bool]:
    """Copy a media file into Comfy's input directory, deduplicating by content and
    renaming on collision. Returns (resolved_input_filename, skipped).

    `skipped` is True when the exact file already lives in the input directory,
    so callers can reuse the existing Comfy filename without another copy.
    """
    import shutil
    import hashlib

    input_dir = Path(folder_paths.input_directory).resolve()
    resolved_source = source_path.resolve()
    if resolved_source.parent == input_dir:
        return filename, True

    source_size = source_path.stat().st_size
    source_hash = hashlib.md5()
    with source_path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            source_hash.update(chunk)
    source_md5 = source_hash.hexdigest()

    found_existing = None
    for f in input_dir.iterdir():
        if not f.is_file():
            continue
        ext = f.suffix.lower()
        if ext not in IMG_EXTENSIONS and ext not in VIDEO_EXTENSIONS and ext not in AUDIO_EXTENSIONS:
            continue
        if f.stat().st_size != source_size:
            continue
        h = hashlib.md5()
        with open(f, "rb") as fh:
            for chunk in iter(lambda: fh.read(8192), b""):
                h.update(chunk)
        if h.hexdigest() == source_md5:
            found_existing = f
            break

    if found_existing:
        return found_existing.name, True

    dest_path = input_dir / filename
    if dest_path.exists():
        stem = Path(filename).stem
        ext = Path(filename).suffix
        counter = 1
        while (input_dir / f"{stem}_{counter}{ext}").exists():
            counter += 1
        dest_path = input_dir / f"{stem}_{counter}{ext}"

    shutil.copy2(source_path, dest_path)
    return dest_path.name, False


@routes.get("/neo_gallery/copy_to_input")
async def copy_to_input(request):
    try:
        filename = request.rel_url.query.get("filename", "")
        subfolder = request.rel_url.query.get("subfolder", "")

        if not filename or ".." in filename or "/" in filename:
            return web.json_response({"success": False, "error": "Invalid filename"}, status=400)

        source_path = None
        user_custom_dirs = _get_user_custom_dirs()

        if subfolder:
            dir_parts = [p for p in subfolder.split("/") if p]
            system = _resolve_system_dir(subfolder)
            if system and ".." not in dir_parts:
                candidate = system[0]
                for part in [p for p in system[1].split("/") if p]:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
            elif dir_parts[0].lower() == "lora" and ".." not in dir_parts:
                candidate = LORA_CACHE_DIR
                for part in dir_parts[1:]:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
            elif dir_parts[0].lower() == "civitai_bookmarks" and ".." not in dir_parts:
                candidate = CIVITAI_BOOKMARK_DIR
                for part in dir_parts[1:]:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
            elif dir_parts[0].lower() in ("storyboard", "charactersheet") and ".." not in dir_parts:
                # Main dirs (StoryBoard / CharacterSheet): generated results + OSS preset cache
                main_base = GRID_DIR if dir_parts[0].lower() == "storyboard" else CHARACTER_DIR
                candidate = main_base
                for part in dir_parts[1:]:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
            elif dir_parts[0] == "presets":
                candidate = PRESETS_DIR
                for part in dir_parts[1:]:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
            else:
                for dir_path in user_custom_dirs:
                    d_name = dir_path.name if dir_path.name else str(dir_path)
                    if dir_parts[0] == d_name:
                        candidate = dir_path
                        for part in dir_parts[1:]:
                            candidate = candidate / part
                        candidate = candidate / filename
                        if candidate.exists():
                            source_path = candidate
                            break

        # 先按 subfolder 精确解析（系统目录，再自定义目录）：卡片只带「相对子路径」
        # （如自定义目录下的 "刘亦菲"、input 下的 "pasted"），必须优先于下面「按文件名」的
        # 宽松兜底——否则 input/output 根目录里同名的另一张图会盖过用户选中的那张，
        # 复制出的参考图与 /neo_gallery/thumbnail 预览看到的不一致。
        if not source_path and subfolder and ".." not in subfolder:
            for info in _get_system_dirs():
                candidate = info["path"]
                for part in dir_parts:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
                    break

        # Main dirs: bare relative subfolders (cards inside Grid/Character carry
        # only the path below the main dir, e.g. "2026-09-24").
        if not source_path and subfolder and ".." not in subfolder:
            for main_base in (GRID_DIR, CHARACTER_DIR):
                candidate = main_base
                for part in dir_parts:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
                    break

        if not source_path and subfolder:
            for dir_path in user_custom_dirs:
                candidate = dir_path / subfolder / filename
                if candidate.exists():
                    source_path = candidate
                    break

        # 宽松兜底：忽略 subfolder，按文件名在自定义目录 / 系统目录根查找
        if not source_path:
            for dir_path in user_custom_dirs:
                candidate = dir_path / filename
                if candidate.exists():
                    source_path = candidate
                    break

        if not source_path:
            for info in _get_system_dirs():
                candidate = info["path"] / filename
                if candidate.exists():
                    source_path = candidate
                    break

        if not source_path:
            candidate = PRESETS_DIR / filename
            if candidate.exists():
                source_path = candidate

        if not source_path:
            candidate = CUSTOM_DIR / filename
            if candidate.exists():
                source_path = candidate

        # OSS fallback: 云端预设目录，按需下载到 Gallery 缓存
        if not source_path and _is_oss_enabled() and subfolder:
            oss_subdir = _oss_dir_from_subfolder(subfolder)
            if oss_subdir:
                oss_rel = await _find_in_oss_index(filename, oss_subdir)
                if not oss_rel:
                    from urllib.parse import unquote as _uq
                    oss_rel = await _find_in_oss_index(_uq(filename), oss_subdir)
                if oss_rel:
                    cached = await _download_oss_file(oss_rel)
                    if cached and cached.exists():
                        source_path = cached

        if not source_path:
            return web.json_response({"success": False, "error": "Image not found"}, status=404)

        resolved_filename, _ = await asyncio.to_thread(_copy_media_to_input, source_path, filename)
        return web.json_response({"success": True, "filename": resolved_filename})
    except Exception as e:
        print(f"[Neo Gallery] Error copying to input: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)


def _collect_all_dir_covers(covers: dict, base_dir: Path, dir_name: str, sample_count: int, base_subfolder: str = "",
                            files: list[os.DirEntry] | None = None, dirs: list[os.DirEntry] | None = None):
    """Collect cover images for a directory.

    Plugin-updated dirs (Output / Grid / Character) use their newest files, so their
    cards keep up with what was just produced instead of freezing on the oldest ones.
    Everything else scans the root level first, then descends into subdirectories.
    Total cover images limited to sample_count (default 3).

    Args:
        covers: Dict to populate with results (keyed by "dir_name")
        base_dir: Root directory path
        dir_name: Display name of the root directory
        sample_count: Number of samples per directory (max cover images)
        base_subfolder: Base subfolder prefix for correct thumbnail URL resolution
        files / dirs: First-level enumeration of base_dir when the caller already has
            one - the home list request scans these dirs for the cards too, and a
            second scandir on a network share is a second round trip
    """
    if _is_recent_dir(dir_name):
        covers[dir_name] = _recent_cover_entries(base_dir, base_subfolder, sample_count)
        return

    result: list[dict] = []

    # Level 1: Scan root level files (image > video > audio), randomly sampled.
    # A pool wider than the cover slots keeps the image-over-video preference
    # meaningful while keeping the stats bounded by the pool, not the file count.
    media = [entry for entry in (files if files is not None else _scandir_files(base_dir))
             if _entry_ext(entry) in ALL_MEDIA_EXTENSIONS]
    random.shuffle(media)
    pool = [_cover_entry(entry, base_subfolder) for entry in media[:sample_count * 4]]
    result.extend(_order_covers_by_kind(pool)[:sample_count])

    # Level 2+: Recursively scan subdirectories if not enough at root level
    _collect_covers_recursive(base_dir, sample_count - len(result), result, sample_count, base_subfolder, dirs)

    covers[f"{dir_name}"] = result


def _collect_home_covers(covers: dict, user_custom_dirs: list, hidden_entries: set, lora_home: bool,
                         oss_index: dict | None, home_scans: dict[str, tuple[list[os.DirEntry], list[os.DirEntry]]]):
    """Collect cover images for every home entry (max 2 per directory).
    
    Root level first, then the first subdir with media. Runs off the event loop.
    home_scans carries the first-level enumeration the directory cards already did.
    """
    _collect_all_dir_covers(covers, PRESETS_DIR, "presets", 2)
    if lora_home and LORA_CACHE_DIR.exists():
        _collect_all_dir_covers(covers, LORA_CACHE_DIR, "Lora", 2, base_subfolder="Lora")
        # Each first-level lora subdir gets its own directory card with a cover
        # (first example image; pure dirs fall back to the next level, like custom dirs).
        try:
            lora_subdirs = sorted(p.name for p in LORA_CACHE_DIR.iterdir() if p.is_dir())
        except OSError:
            lora_subdirs = []
        for subdir_name in lora_subdirs:
            _collect_all_dir_covers(covers, LORA_CACHE_DIR / subdir_name,
                                    f"Lora/{subdir_name}", 2,
                                    base_subfolder=f"Lora/{subdir_name}")
    for dir_path in user_custom_dirs:
        dir_name = dir_path.name if dir_path.name else str(dir_path)
        files, dirs = home_scans.get(dir_name, ([], []))
        _collect_all_dir_covers(covers, dir_path, dir_name, 2, "", files, dirs)
    for info in _get_system_dirs():
        if _is_home_entry_hidden(info["name"], hidden_entries):
            continue
        files, dirs = home_scans.get(info["name"], ([], []))
        _collect_all_dir_covers(covers, info["path"], info["name"], 3, "", files, dirs)
    if oss_index:
        _collect_oss_covers(covers, oss_index)


def _collect_covers_recursive(parent_dir: Path, needed: int, result: list[dict], sample_count: int, base_subfolder: str = "",
                              subdirs: list[os.DirEntry] | None = None):
    """Recursively scan subdirectories for cover media (images + videos).
    
    Args:
        parent_dir: Directory to scan
        needed: How many more samples we need (decrements with recursion)
        result: List to append results to
        sample_count: Maximum number of samples total (CONSTANT, never changes during recursion)
        base_subfolder: Base subfolder prefix for correct thumbnail URL resolution
        subdirs: First-level subdirs of parent_dir when the caller already enumerated
            them; deeper levels always enumerate on demand
    """
    if needed <= 0 or len(result) >= sample_count:
        return

    subdirs = list(subdirs) if subdirs is not None else _scandir_dirs(parent_dir)
    random.shuffle(subdirs)

    for subdir in subdirs:
        if len(result) >= sample_count:
            break

        # Build full subfolder path by prepending base_subfolder
        if base_subfolder:
            new_subfolder = f"{base_subfolder}/{subdir.name}"
        else:
            new_subfolder = subdir.name

        # Check direct media files at this subdirectory level (image > video > audio,
        # limited to what's still needed). Only the sampled pool is stat'd - a NAS
        # subdir charges a round trip per stat.
        remaining = sample_count - len(result)
        media = [entry for entry in _scandir_files(Path(subdir.path))
                 if _entry_ext(entry) in ALL_MEDIA_EXTENSIONS]
        random.shuffle(media)
        pool = [_cover_entry(entry, new_subfolder) for entry in media[:remaining * 4]]
        found_direct = _order_covers_by_kind(pool)[:remaining]

        # If we found media at this level, add them and stop recursing deeper for this subdir
        if found_direct:
            result.extend(found_direct)
        else:
            # No direct media - recurse into nested subdirectory. Keep base_subfolder
            # (so returned subfolder paths stay anchored to the custom-dir root that
            # /neo_gallery/image can resolve) and keep `needed` so the search is
            # bounded only by sample_count, not by recursion depth.
            _collect_covers_recursive(Path(subdir.path), needed, result, sample_count, new_subfolder)

        # Check if we've collected enough after processing this subdir
        if len(result) >= sample_count:
            break


def _collect_subdirs_with_media(directory: Path, prefix: str = "") -> list[str]:
    """Collect first-level subdirectory paths that contain media (images or videos).

    Returns a flat list of relative directory names (e.g., ["dir1", "dir2"]).
    Only returns immediate children directories, does NOT recurse into nested dirs.
    This ensures the home page only shows one level of subdirectories.
    """
    subdirs = _scandir_dirs(directory)
    has_media = _parallel_map(lambda entry: _has_media_in_dir_any(Path(entry.path)), subdirs)
    result = []
    for entry, flag in zip(subdirs, has_media):
        if flag:
            result.append(prefix + "/" + entry.name if prefix else entry.name)

    return result


# Keep old name as alias for backward compatibility
def _collect_subdirs_with_images(directory: Path, prefix: str = "") -> list[str]:
    """Alias to _collect_subdirs_with_media for backward compatibility."""
    return _collect_subdirs_with_media(directory, prefix)


def _collect_sample_images_recursive(directory: Path, prefix: str, max_samples: int, result: list):
    """Recursively collect up to max_samples media entries from any depth.

    Lightweight version - only collects filename + subfolder for cover thumbnails.
    No txt parsing overhead. Includes both images and videos.
    
    The prefix should be a complete relative path (e.g., "mygallery/child/grandchild/images")
    so that the returned entry's subfolder field can be used to correctly construct image URLs.
    """
    if len(result) >= max_samples:
        return

    # Collect lightweight entries (filename + subfolder only, no txt parsing)
    try:
        with os.scandir(directory) as it:
            entries = sorted(it, key=lambda entry: entry.name)
    except OSError:
        return

    for entry in entries:
        if len(result) >= max_samples:
            return

        if entry.is_file(follow_symlinks=False):
            if _entry_ext(entry) in ALL_MEDIA_EXTENSIONS:
                result.append({
                    "filename": entry.name,
                    "name": _entry_stem(entry),
                    "subfolder": prefix,
                })

        elif entry.is_dir(follow_symlinks=False):
            subdir = Path(entry.path)
            subdir_name = entry.name
            new_prefix = prefix + "/" + subdir_name if prefix else subdir_name

            # If this subdir has direct media, collect them as samples
            if _has_media_in_dir_any(subdir):
                for sub in _scandir_files(subdir):
                    if len(result) >= max_samples:
                        return
                    if _entry_ext(sub) in ALL_MEDIA_EXTENSIONS:
                        result.append({
                            "filename": sub.name,
                            "name": _entry_stem(sub),
                            "subfolder": new_prefix,
                        })
            else:
                # Recurse into nested subdirs (empty intermediate dir)
                _collect_sample_images_recursive(subdir, new_prefix, max_samples, result)


@routes.post("/neo_gallery/dir_cover_images")
async def get_directory_cover_images(request):
    """Batch endpoint to collect cover images for all known directories.
    
    Returns lightweight cover image entries (filename + subfolder only, no txt parsing)
    for every custom directory and presets directory/subdirectory in a single request.
    
    Request body: { "samples": 2 } (optional, default 2 per directory)
    Response: { "covers": { "dir_name/key": [{...}], ... } }
    """
    try:
        data = await request.json() if request.content_type == "application/json" else {}
        sample_count = int(data.get("samples", 2))
        
        covers: dict[str, list[dict]] = {}

        def _collect_all():
            # Collect from presets (use real path name consistently)
            _collect_all_dir_covers(covers, PRESETS_DIR, "presets", sample_count)

            # Collect from the Lora example cache (subfolder anchored with "Lora/" so
            # the thumbnail endpoint can resolve it inside LORA_CACHE_DIR)
            if LORA_CACHE_DIR.exists():
                _collect_all_dir_covers(covers, LORA_CACHE_DIR, "Lora", sample_count, base_subfolder="Lora")

            # Collect from all custom directories (use real path names, no case conversion)
            for dir_path in _get_user_custom_dirs():
                dir_name = dir_path.name if dir_path.name else str(dir_path)
                _collect_all_dir_covers(covers, dir_path, dir_name, sample_count)

            # Collect from system directories (input/output), matching the home listing
            for info in _get_system_dirs():
                _collect_all_dir_covers(covers, info["path"], info["name"], sample_count)

        await asyncio.to_thread(_collect_all)

        return web.json_response({"covers": covers})
    except Exception as e:
        print(f"[Neo Gallery] Error collecting cover images: {e}")
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/neo_gallery/subdirs")
async def get_subdirs(request):
    """Get first-level subdirectory structure with image counts.

    Query params:
    - dir_name: name of the custom directory or 'presets' (required)
    - path: relative subdirectory path within that directory (optional, "/" separated)
    
    Returns only first-level subdirectories with their image counts.
    Fastest possible scan - one scandir pass per level, no recursion.
    
    Returns format:
        {
            "dir_name": str,
            "path": str,
            "subdirs": [{name: str, image_count: int, path: str}]
        }
    """
    if "dir_name" not in request.rel_url.query:
        return web.json_response({"error": "Missing dir_name"}, status=400)

    dir_name = request.rel_url.query["dir_name"]
    rel_path = request.rel_url.query.get("path", "")

    # Security check for path traversal
    if ".." in rel_path:
        return web.json_response({"error": "Invalid path"}, status=400)

    base: Path | None = None
    dir_name_lower = dir_name.lower()
    if dir_name_lower == "presets":
        base = PRESETS_DIR
    elif dir_name_lower.startswith("presets/"):
        base = PRESETS_DIR
        if not rel_path:
            rel_path = dir_name_lower[len("presets/"):]
    else:
        system = _resolve_system_dir(dir_name)
        if system:
            base = system[0]
            if not rel_path:
                rel_path = system[1]
        else:
            user_custom_dirs = _get_user_custom_dirs()
            for dir_path in user_custom_dirs:
                d_name = dir_path.name if dir_path.name else str(dir_path)
                if d_name.lower() == dir_name_lower:
                    base = dir_path
                    break

    if base is None or not base.exists():
        return web.json_response({"error": "Directory not found"}, status=404)

    if rel_path:
        parts = [p for p in rel_path.split("/") if p]
        target_dir = base
        for part in parts:
            target_dir = target_dir / part
    else:
        target_dir = base

    # Use lightweight structure-only scan (no txt parsing, no images)
    structure = await asyncio.to_thread(_scan_directory_structure_only, target_dir)

    return web.json_response({
        "dir_name": dir_name,
        "path": rel_path,
        "subdirs": structure.get("subdirs", []),
    })


# ---------------------------------------------------------------------------
# Thumbnail Routes
# ---------------------------------------------------------------------------


def _generate_thumbnail(source_path: Path, cache_path: Path, size: int = THUMBNAIL_SIZE) -> bool:
    """Generate a thumbnail image and save to cache_path.
    
    For video files, extracts first frame using ffmpeg.
    Returns True if successful, False otherwise.
    """
    try:
        # Check if source is a video file
        if source_path.suffix.lower() in VIDEO_EXTENSIONS:
            return _generate_video_thumbnail(source_path, cache_path, size)
        
        with Image.open(source_path) as img:
            # Convert to RGB if necessary (handle RGBA, P mode, etc.)
            if img.mode not in ("RGB", "L", "RGBA"):
                img = img.convert("RGB")
            
            # Create thumbnail (in-place resize)
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            
            # Ensure directory exists
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Save as JPEG
            if img.mode == "RGBA":
                # Create white background for RGBA images
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            
            img.save(cache_path, "JPEG", quality=85)
            return True
    except Exception as e:
        print(f"[Neo Gallery] Failed to generate thumbnail: {e}")
        return False


def _ffmpeg_exe() -> str | None:
    """Locate ffmpeg: PATH first, then the imageio-ffmpeg binary shipped with ComfyUI."""
    path = shutil.which("ffmpeg")
    if path:
        return path
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


def _generate_video_thumbnail(source_path: Path, cache_path: Path, size: int = THUMBNAIL_SIZE) -> bool:
    """Generate a thumbnail from a video file using ffmpeg.
    
    Extracts the first frame and saves as JPEG thumbnail.
    """
    try:
        # Check if ffmpeg is available
        ffmpeg_path = _ffmpeg_exe()
        if not ffmpeg_path:
            return False
        
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Extract first frame using ffmpeg
        # Note: -ss must be BEFORE -i for input seeking (works with most formats)
        cmd = [
            ffmpeg_path,
            "-ss", "00:00:00.500",
            "-i", str(source_path),
            "-vframes", "1",
            "-y",
            str(cache_path)
        ]
        
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode != 0:
            # Try without -ss for first frame (some formats don't support input seeking well)
            cmd = [
                ffmpeg_path,
                "-i", str(source_path),
                "-vframes", "1",
                "-y",
                str(cache_path)
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0:
                return False
        
        # Validate that the output is a valid image file
        try:
            with Image.open(cache_path) as img:
                img.verify()
            # Also check file size > 1KB to avoid empty/corrupt files
            if cache_path.stat().st_size < 1024:
                return False
        except Exception:
            # Invalid image, clean up and return failure
            try:
                cache_path.unlink(missing_ok=True)
            except Exception:
                pass
            return False
        
        return True
    except Exception as e:
        return False


def _find_source_media(filename: str, subfolder: str) -> Path | None:
    """Find the source media file (image, video, or audio) for a given filename and subfolder."""
    user_custom_dirs = _get_user_custom_dirs()
    source_path = None
    
    # Lora cache (items carry a subfolder prefixed with "Lora/", e.g. "Lora/detail/tweak")
    subfolder_lower = (subfolder or "").lower()
    if subfolder_lower.startswith("lora/"):
        sub_parts = [p for p in subfolder[len("lora/"):].split("/") if p]
        if sub_parts and ".." not in sub_parts and ".." not in filename:
            candidate = LORA_CACHE_DIR.joinpath(*sub_parts, filename)
            if candidate.exists():
                return candidate
    elif subfolder_lower == "lora":
        if ".." not in filename:
            candidate = LORA_CACHE_DIR / filename
            if candidate.exists():
                return candidate
    elif subfolder_lower.startswith("civitai_bookmarks/"):
        bm_parts = [p for p in subfolder[len("civitai_bookmarks/"):].split("/") if p]
        if bm_parts and ".." not in bm_parts and ".." not in filename:
            candidate = CIVITAI_BOOKMARK_DIR.joinpath(*bm_parts, filename)
            if candidate.exists():
                return candidate
    elif subfolder_lower.startswith("grid/") or subfolder_lower.startswith("character/"):
        # Main dirs (Grid / Character): generated results + OSS preset cache
        main_base = GRID_DIR if subfolder_lower.startswith("grid/") else CHARACTER_DIR
        sub_parts = [p for p in subfolder.split("/")[1:] if p]
        if sub_parts and ".." not in sub_parts and ".." not in filename:
            candidate = main_base.joinpath(*sub_parts, filename)
            if candidate.exists():
                return candidate

    # Search in custom dirs - try every dir directly first (most reliable)
    for dir_path in user_custom_dirs:
        candidate = dir_path / filename
        if candidate.exists():
            source_path = candidate
            break
    
    # Try subfolder under each custom dir (try all possible path combinations)
    if not source_path and subfolder:
        dir_parts = [p for p in subfolder.split("/") if p]
        
        # If there's only one part, it could be either:
        # 1. A direct subdir of a custom dir (e.g., "stars" -> dir_path / filename)
        # 2. A nested path under any custom dir (e.g., "stars/subdir")
        if len(dir_parts) == 1:
            # First try as root-level file under each custom dir
            for dir_path in user_custom_dirs:
                candidate = dir_path / filename
                if candidate.exists():
                    source_path = candidate
                    break
        
        # Try the full path under each custom dir (handles nested paths like "presets/subdir")
        if not source_path:
            for dir_path in user_custom_dirs:
                candidate = dir_path
                for part in dir_parts:
                    candidate = candidate / part
                candidate = candidate / filename
                if candidate.exists():
                    source_path = candidate
                    break
        
        # Special handling: when the subfolder starts with a directory name that matches
        # a custom dir's name, skip that first part (e.g., "stars/stars1104x1472" 
        # should resolve to dir_path / "stars1104x1472", not dir_path / "stars" / "stars1104x1472")
        if not source_path and len(dir_parts) >= 2:
            for dir_path in user_custom_dirs:
                # Check if first part matches this directory's name or parent path
                dir_name = dir_path.name
                dir_stem = dir_path.stem
                full_path_str = str(dir_path).lower()
                
                for i, part in enumerate(dir_parts):
                    # FIX: Use .lower() on both sides for case-insensitive comparison
                    if (part.lower() == dir_name.lower() or 
                        part.lower() == dir_stem.lower() or 
                        part.lower() + "\\" in full_path_str or 
                        part.lower() + "/" in full_path_str):
                        # This part matches the directory name, try rest of path
                        remaining_parts = dir_parts[i+1:]
                        if not remaining_parts:
                            # Just use the directory itself
                            candidate = dir_path / filename
                        else:
                            candidate = dir_path
                            for rp in remaining_parts:
                                candidate = candidate / rp
                            candidate = candidate / filename
                        
                        if candidate.exists():
                            source_path = candidate
                            break
                
                if source_path:
                    break
    
    # System dirs (input/output): items are scanned with only a relative subfolder,
    # so accept both the prefixed form ("input", "input/sub1") and bare relative
    # paths ("sub1") that deep navigation sends.
    if not source_path and ".." not in filename and ".." not in subfolder:
        sys_sub_lower = (subfolder or "").lower()
        for info in _get_system_dirs():
            sys_name_lower = info["name"].lower()
            if sys_sub_lower == sys_name_lower:
                rel_parts = []
            elif sys_sub_lower.startswith(sys_name_lower + "/"):
                rel_parts = [p for p in subfolder[len(info["name"]):].split("/") if p]
            elif subfolder:
                rel_parts = [p for p in subfolder.split("/") if p]
            else:
                rel_parts = []
            candidate = info["path"]
            for part in rel_parts:
                candidate = candidate / part
            candidate = candidate / filename
            if candidate.exists():
                source_path = candidate
                break

    # Main dirs (Grid / Character): generated results + OSS preset cache. Cards carry
    # the bare path below the main dir ("2026-09-24") or the prefixed form
    # ("Grid/2026-09-24"); only the matching main dir is searched for a prefix.
    if not source_path and ".." not in filename and ".." not in subfolder:
        main_parts = [p for p in (subfolder or "").split("/") if p]
        if main_parts and main_parts[0].lower() in ("storyboard", "charactersheet"):
            main_bases = (GRID_DIR if main_parts[0].lower() == "storyboard" else CHARACTER_DIR,)
            main_parts = main_parts[1:]
        else:
            main_bases = (GRID_DIR, CHARACTER_DIR)
        for main_base in main_bases:
            candidate = main_base
            for part in main_parts:
                candidate = candidate / part
            candidate = candidate / filename
            if candidate.exists():
                source_path = candidate
                break

    # Search in presets (including subfolders)
    if not source_path:
        subfolder_lower = (subfolder or "").lower()
        if subfolder_lower.startswith("presets/"):
            sub_path = subfolder_lower[len("presets/"):]
            candidate = PRESETS_DIR / sub_path / filename
            if candidate.exists():
                source_path = candidate
        elif subfolder_lower == "presets" or not subfolder:
            candidate = PRESETS_DIR / filename
            if candidate.exists():
                source_path = candidate
        else:
            # Fallback: treat subfolder as a direct subdirectory name under presets
            candidate = PRESETS_DIR / subfolder / filename
            if candidate.exists():
                source_path = candidate

    # Search in custom gallery dir
    if not source_path:
        candidate = CUSTOM_DIR / filename
        if candidate.exists():
            source_path = candidate
    
    # Fallback: try to find by extension (both image and video)
    if not source_path:
        for ext in [".jpeg", ".jpg", ".png", ".webp", ".gif", ".bmp", ".tiff",
                    ".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"]:
            candidate = PRESETS_DIR / (Path(filename).stem + ext)
            if candidate.exists():
                source_path = candidate
                break
    
    # Last resort: an unprefixed subfolder that no custom/system/presets dir
    # owns (e.g. "MMH3/model" from deep LoRA navigation) is treated as a path
    # relative to the lora cache, mirroring the prefixed "Lora/MMH3/model" form.
    # The lora cache is read-only, so this cannot shadow a writable location.
    if not source_path and subfolder and ".." not in filename and ".." not in subfolder:
        lora_sub_parts = [p for p in subfolder.split("/") if p]
        if lora_sub_parts and all(p not in ("..", ".") for p in lora_sub_parts):
            candidate = LORA_CACHE_DIR
            for part in lora_sub_parts:
                candidate = candidate / part
            candidate = candidate / filename
            if candidate.exists():
                source_path = candidate
    
    return source_path


def _find_source_image(filename: str, subfolder: str) -> Path | None:
    """Find the source image file for a given filename and subfolder."""
    return _find_source_media(filename, subfolder)


def _read_media_bytes(path: Path) -> tuple[bytes, str]:
    with open(path, "rb") as f:
        return f.read(), mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _media_file_response(path: Path) -> web.Response:
    """Serve a local media file. The URL carries the filename, so browsers can cache it."""
    with open(path, "rb") as f:
        body = f.read()
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return web.Response(
        body=body,
        content_type=content_type,
        headers={
            "Cache-Control": "public, max-age=86400",
            "Content-Disposition": f'inline; filename="{path.name}"',
        },
    )


def _thumbnail_hash(source_path: Path, source_stat) -> str:
    """Cache hash for a thumbnail: source path + size + mtime, so a regenerated file
    with the same name gets a new entry.

    normpath replaces resolve(): every source path the gallery builds is a resolved
    root joined with ".."-filtered segments, so it is already canonical, and
    resolve() is a network round trip per request on a SMB share.
    """
    cache_key = f"{os.path.normpath(str(source_path))}_{source_stat.st_size}_{source_stat.st_mtime}"
    return hashlib.md5(cache_key.encode()).hexdigest()[:12]


def _thumbnail_payload(size: int, source_path: Path) -> tuple[bytes, str] | None:
    """Bytes + content type for a local media thumbnail, generating the cache when stale.

    Blocking (Pillow / ffmpeg), so callers run it in a thread. A video that yields no
    frame returns None: serving the raw video as an <img> is pointless. Audio returns
    None too - the UI renders audio covers as their own tile and never asks for a
    thumbnail, so any caller left would get raw audio bytes back as an image response.

    The YYYY-MM bucket comes from the source mtime so one cache directory does not
    fill up.
    """
    suffix = source_path.suffix.lower()
    if suffix in AUDIO_EXTENSIONS:
        return None
    if size <= 0:
        return _read_media_bytes(source_path)

    try:
        source_stat = source_path.stat()
    except OSError:
        return None

    cache_path = THUMBNAIL_DIR / time.strftime("%Y-%m", time.localtime(source_stat.st_mtime)) / f"{_thumbnail_hash(source_path, source_stat)}_{size}.jpg"
    try:
        if cache_path.stat().st_mtime >= source_stat.st_mtime:
            return _read_media_bytes(cache_path)
    except OSError:
        pass

    if suffix in VIDEO_EXTENSIONS:
        if not _generate_video_thumbnail(source_path, cache_path, size):
            return None
    elif not _generate_thumbnail(source_path, cache_path, size):
        return _read_media_bytes(source_path)
    return _read_media_bytes(cache_path)


@routes.get("/neo_gallery/thumbnail")
async def get_thumbnail(request):
    """Serve cached thumbnail for gallery images."""
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "presets")
    size = int(request.rel_url.query.get("size", THUMBNAIL_SIZE))
    
    # URL decode filename to handle special characters
    from urllib.parse import unquote
    filename = unquote(filename)
    subfolder = unquote(subfolder)
    
    if not filename or ".." in filename or "/" in filename:
        return web.Response(status=400)
    
    # Find the source image
    source_path = await asyncio.to_thread(_find_source_image, filename, subfolder)

    # OSS fallback: try pre-generated thumbnail from remote index
    if not source_path and _is_oss_enabled():
        oss_subdir = _oss_dir_from_subfolder(subfolder)
        if oss_subdir:
            thumb_rel = await _find_thumbnail_in_oss_index(filename, oss_subdir)
            if thumb_rel:
                cached = await _download_oss_file(thumb_rel)
                if cached and cached.exists():
                    return await asyncio.to_thread(_media_file_response, cached)

    if not source_path:
        return web.Response(status=404)

    payload = await asyncio.to_thread(_thumbnail_payload, size, source_path)
    if payload is None:
        return web.Response(status=404, text="Thumbnail generation failed")

    body, content_type = payload
    return web.Response(body=body, content_type=content_type,
                        headers={"Cache-Control": "public, max-age=86400"})


@routes.get("/neo_gallery/video")
async def view_video(request):
    """Serve gallery videos by filename."""
    if "filename" not in request.rel_url.query:
        return web.Response(status=400)

    filename = request.rel_url.query["filename"]
    subfolder = request.rel_url.query.get("subfolder", "presets")

    if ".." in filename or ".." in subfolder:
        return web.Response(status=400)

    source_path = await asyncio.to_thread(_find_source_media, filename, subfolder)
    if not source_path:
        return web.Response(status=404)

    if source_path.suffix.lower() not in VIDEO_EXTENSIONS:
        return web.Response(status=400)

    return await asyncio.to_thread(_media_file_response, source_path)


@routes.get("/neo_gallery/audio")
async def view_audio(request):
    """Serve gallery audio by filename (waveform decode + playback + lightbox)."""
    if "filename" not in request.rel_url.query:
        return web.Response(status=400)

    filename = request.rel_url.query["filename"]
    subfolder = request.rel_url.query.get("subfolder", "presets")

    if ".." in filename or ".." in subfolder:
        return web.Response(status=400)

    source_path = await asyncio.to_thread(_find_source_media, filename, subfolder)
    if not source_path:
        return web.Response(status=404)

    if source_path.suffix.lower() not in AUDIO_EXTENSIONS:
        return web.Response(status=400)

    return await asyncio.to_thread(_media_file_response, source_path)


def _get_waveform_path(filename: str, subfolder: str) -> Path | None:
    """Return the disk cache path for decoded waveform peaks of an audio file.

    Mirrors the thumbnail cache key (source path + size + mtime) so the entry
    invalidates automatically when the source audio is replaced or edited.
    Returns None when the source audio cannot be located.
    """
    source_path = _find_source_media(filename, subfolder)
    if not (source_path and source_path.exists()):
        return None
    stat = source_path.stat()
    cache_key = f"{source_path.resolve().as_posix()}_{stat.st_size}_{int(stat.st_mtime)}"
    hash_hex = hashlib.md5(cache_key.encode()).hexdigest()[:16]
    WAVEFORM_DIR.mkdir(parents=True, exist_ok=True)
    return WAVEFORM_DIR / f"{hash_hex}.json"


@routes.get("/neo_gallery/waveform")
async def get_waveform(request):
    """Return cached decoded waveform peaks for a gallery audio file."""
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "")
    if not filename or ".." in filename or ".." in subfolder:
        return web.json_response({"has": False})

    def _load_waveform():
        cache_path = _get_waveform_path(filename, subfolder)
        if not cache_path or not cache_path.exists():
            return None
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)

    try:
        data = await asyncio.to_thread(_load_waveform)
        if data is None:
            return web.json_response({"has": False})
        peaks = data.get("peaks")
        if not isinstance(peaks, list) or not peaks:
            return web.json_response({"has": False})
        duration = data.get("duration", 0)
        try:
            duration = float(duration)
        except (TypeError, ValueError):
            duration = 0.0
        return web.json_response({"has": True, "peaks": peaks, "duration": duration})
    except Exception:
        return web.json_response({"has": False})


@routes.post("/neo_gallery/waveform")
async def save_waveform(request):
    """Persist decoded waveform peaks for a gallery audio file to the cache dir."""
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400)

    filename = str(body.get("filename", ""))
    subfolder = str(body.get("subfolder", ""))
    peaks = body.get("peaks")
    if not filename or ".." in filename or ".." in subfolder:
        return web.Response(status=400)
    if not isinstance(peaks, list) or not peaks or len(peaks) > 4096:
        return web.Response(status=400)

    # Only cache for real audio files that exist on disk.
    source_path = await asyncio.to_thread(_find_source_media, filename, subfolder)
    if not (source_path and source_path.suffix.lower() in AUDIO_EXTENSIONS):
        return web.Response(status=404)

    try:
        clean_peaks = [float(p) for p in peaks]
    except (TypeError, ValueError):
        return web.Response(status=400)

    duration = body.get("duration", 0)
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = 0.0

    def _write_waveform():
        cache_path = _get_waveform_path(filename, subfolder)
        if not cache_path:
            return False
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"peaks": clean_peaks, "duration": duration}, f)
        return True

    try:
        written = await asyncio.to_thread(_write_waveform)
    except Exception:
        return web.Response(status=500)
    if not written:
        return web.Response(status=404)
    return web.json_response({"ok": True})


@routes.get("/neo_gallery/media_meta")
async def media_meta(request):
    """Return embedded ComfyUI workflow/prompt metadata for a gallery media file."""
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "")
    if ".." in filename or ".." in subfolder:
        return web.json_response({"has": False})

    sub_lower = subfolder.lower()

    def _resolve_meta_path():
        if sub_lower == "lora" or sub_lower.startswith("lora/"):
            return _find_source_media(filename, subfolder)
        if sub_lower == "presets" or sub_lower == "custom":
            path = (PRESETS_DIR if sub_lower == "presets" else CUSTOM_DIR) / filename
            return path if path.is_file() else None
        # Custom dirs and system input/output dirs all resolve through the shared finder
        path = _find_source_media(filename, subfolder)
        return path if path and path.is_file() else None

    path = await asyncio.to_thread(_resolve_meta_path)
    if not path:
        return web.json_response({"has": False})

    raw = await asyncio.to_thread(_extract_media_metadata, path)
    if not raw:
        return web.json_response({"has": False})

    prompt = raw.get("prompt")
    workflow = raw.get("workflow")
    if isinstance(prompt, str):
        try:
            prompt = json.loads(prompt)
        except ValueError:
            prompt = None
    if isinstance(workflow, str):
        try:
            workflow = json.loads(workflow)
        except ValueError:
            workflow = None

    result = {
        "has": bool(prompt or workflow),
        "workflow": workflow if isinstance(workflow, dict) else None,
        "prompt": prompt if isinstance(prompt, dict) else None,
    }
    if isinstance(prompt, dict):
        result["texts"] = _collect_prompt_texts(prompt)
    return web.json_response(_json_safe(result))


@routes.get("/neo_gallery/txt")
async def view_txt(request):
    """Serve the full sidecar .txt for one gallery item.

    The list payload carries txt_content as a preview (the OSS index caps it at 500
    chars, the local scan at 8 lines), so the lightbox and the copy-prompt action
    need the sidecar file itself.
    """
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "")
    if not filename or ".." in filename or ".." in subfolder:
        return web.json_response({"success": False, "error": "filename required"}, status=400)

    txt_name = Path(filename).stem + ".txt"
    sub_lower = subfolder.lower()

    oss_subdir = _oss_dir_from_subfolder(subfolder)
    if oss_subdir and _is_oss_enabled():
        oss_rel = await _find_in_oss_index(filename, oss_subdir)
        if not oss_rel:
            from urllib.parse import unquote as _uq
            oss_rel = await _find_in_oss_index(_uq(filename), oss_subdir)
        if not oss_rel:
            return web.json_response({"success": False, "error": "not in oss index"}, status=404)
        # 索引里的相对路径是 posix 的，换后缀不能经过 Path：Windows 下 str(Path(...))
        # 会把 "/" 变成 "\"，拼进下载 URL 就是 404。
        cached = await _download_oss_file(Path(oss_rel).with_suffix(".txt").as_posix())
        if not cached:
            return web.json_response({"success": False, "error": "sidecar download failed"}, status=404)
        content = await asyncio.to_thread(_read_text_file, str(cached))
        return web.json_response(_json_safe({"success": True, "content": content}))

    def _resolve_txt_path() -> Path | None:
        if not subfolder or sub_lower == "presets":
            cand = PRESETS_DIR / txt_name
        elif sub_lower == "custom":
            cand = CUSTOM_DIR / txt_name
        elif sub_lower.startswith("presets/"):
            cand = PRESETS_DIR.joinpath(*[p for p in subfolder.split("/")[1:] if p], txt_name)
        else:
            cand = _find_source_media(txt_name, subfolder)
        return cand if cand and cand.is_file() else None

    path = await asyncio.to_thread(_resolve_txt_path)
    if not path:
        return web.json_response({"success": False, "error": "no sidecar file"}, status=404)
    content = await asyncio.to_thread(_read_text_file, str(path))
    return web.json_response(_json_safe({"success": True, "content": content}))


@routes.get("/neo_gallery/image")
async def view_image(request):
    """Serve gallery images by filename."""
    if "filename" not in request.rel_url.query:
        return web.Response(status=400)

    filename = request.rel_url.query["filename"]
    subfolder = request.rel_url.query.get("subfolder", "presets")
    category = request.rel_url.query.get("category", "")

    if ".." in filename or ".." in subfolder:
        return web.Response(status=400)

    if subfolder.startswith("__"):
        return web.Response(status=400)

    # Lora example cache: resolve through _find_source_media, which anchors the
    # "Lora/" prefix to LORA_CACHE_DIR (same resolution the thumbnail route uses).
    subfolder_lower = subfolder.lower()
    if subfolder_lower == "lora" or subfolder_lower.startswith("lora/"):
        source_path = await asyncio.to_thread(_find_source_media, filename, subfolder)
        if not source_path:
            return web.Response(status=404)
        return await asyncio.to_thread(_media_file_response, source_path)

    # Civitai bookmark example cache: "civitai_bookmarks/<model_id>" -> CIVITAI_BOOKMARK_DIR.
    if subfolder_lower.startswith("civitai_bookmarks/"):
        bm_parts = [p for p in subfolder[len("civitai_bookmarks/"):].split("/") if p]
        if not bm_parts or ".." in bm_parts or ".." in filename:
            return web.Response(status=404)
        source_path = CIVITAI_BOOKMARK_DIR.joinpath(*bm_parts, filename)
        if not source_path.exists():
            return web.Response(status=404)
        return await asyncio.to_thread(_media_file_response, source_path)

    user_custom_dirs = _get_user_custom_dirs()
    base: Path | None = None

    dir_parts = [p for p in subfolder.split("/") if p]
    subfolder_lower = subfolder.lower()

    def _match_dir_name(parts_list):
        target = parts_list[0].lower()
        for dir_path in user_custom_dirs:
            if dir_path.name.lower() == target:
                return dir_path
        return None

    if subfolder_lower == "presets" or subfolder_lower == "":
        base = PRESETS_DIR
    elif subfolder_lower == "custom":
        base = CUSTOM_DIR
    elif len(dir_parts) > 0 and dir_parts[0].lower() == "presets":
        base = PRESETS_DIR / "/".join(dir_parts[1:])
    elif len(dir_parts) > 0 and len(dir_parts) == 1:
        candidate = PRESETS_DIR / dir_parts[0]
        if candidate.exists():
            base = candidate
        else:
            matched_dir = _match_dir_name(dir_parts)
            if matched_dir:
                base = matched_dir
            else:
                # Try as subdirectory under any custom dir
                for dir_path in user_custom_dirs:
                    candidate = dir_path / dir_parts[0]
                    if candidate.exists():
                        base = candidate
                        break
    elif len(dir_parts) > 1:
        matched_dir = _match_dir_name(dir_parts)
        if matched_dir:
            base = matched_dir / "/".join(dir_parts[1:])
    else:
        for dir_path in user_custom_dirs:
            d_name = dir_path.name if dir_path.name else str(dir_path)
            if subfolder_lower == d_name.lower():
                base = dir_path
                break

    # Fallback: the subfolder may be a relative path rooted at a custom directory.
    # Deep nested navigation drops the base dir prefix from the image URL, so try
    # resolving the whole subfolder as a relative path under each custom dir root.
    if base is None:
        for dir_path in user_custom_dirs:
            candidate = dir_path
            for part in dir_parts:
                candidate = candidate / part
            if candidate.exists():
                base = candidate
                break

    # System dirs (input/output): same fallback as custom dirs, plus the
    # prefixed name form ("Input", "Input/sub1") that root items carry.
    if base is None and subfolder and ".." not in subfolder:
        system = _resolve_system_dir(subfolder)
        if system:
            candidate = system[0]
            for part in [p for p in system[1].split("/") if p]:
                candidate = candidate / part
            if candidate.exists():
                base = candidate
        else:
            for info in _get_system_dirs():
                candidate = info["path"]
                for part in dir_parts:
                    candidate = candidate / part
                if candidate.exists():
                    base = candidate
                    break

    # OSS fallback: serve from cache or download on demand.
    oss_subdir = _oss_dir_from_subfolder(subfolder)
    if oss_subdir and _is_oss_enabled():
        oss_rel = await _find_in_oss_index(filename, oss_subdir)
        if not oss_rel:
            from urllib.parse import unquote as _uq
            oss_rel = await _find_in_oss_index(_uq(filename), oss_subdir)
        if oss_rel:
            cached = await _download_oss_file(oss_rel)
            if cached and cached.exists():
                return await asyncio.to_thread(_media_file_response, cached)
        return web.Response(status=404)

    if base is None:
        # Final fallback: let the shared media resolver handle subfolders the
        # base-dir logic above doesn't cover (unprefixed lora cache paths,
        # deep system-dir paths, ...). Mirrors the thumbnail route.
        source_path = await asyncio.to_thread(_find_source_media, filename, subfolder)
        if source_path:
            return await asyncio.to_thread(_media_file_response, source_path)
        return web.Response(status=404)

    if not base.exists():
        return web.Response(status=404)

    def _resolve_image_fullpath() -> Path | None:
        file_stem = Path(filename).stem

        candidates_to_try = [filename]
        for ext in [".jpeg", ".jpg", ".png", ".webp", ".gif", ".bmp", ".tiff"]:
            candidates_to_try.append(file_stem + ext)

        use_category = category and not any(part in subfolder for part in category.split("/"))

        for candidate_filename in candidates_to_try:
            if use_category and category:
                candidate = base / category / candidate_filename
                if candidate.exists():
                    return candidate

            candidate = base / candidate_filename
            if candidate.exists():
                return candidate

        # Deep fallback: scan the tree once off the event loop.
        for p in base.rglob(f"{file_stem}*"):
            if p.is_file():
                ext_lower = p.suffix.lower()
                if ext_lower in IMG_EXTENSIONS:
                    return p

        # 同名子目录可能同时存在于多个根（如 "NeoAgent" 在 input 与 output 各一份），
        # base 只固定了其中一个；再走共享解析器兜底，避免另一个根里的文件 404。
        source_path = _find_source_media(filename, subfolder)
        if source_path and source_path.exists():
            return source_path
        return None

    fullpath = await asyncio.to_thread(_resolve_image_fullpath)

    if fullpath:
        return await asyncio.to_thread(_media_file_response, fullpath)
    return web.Response(status=404)


# ---------------------------------------------------------------------------
# Settings Routes (custom presets directory)
# ---------------------------------------------------------------------------



@routes.post("/neo_gallery/save_settings")
async def save_gallery_settings(request):
    """Save gallery settings (custom directories list)."""
    try:
        data = await request.json()
        current_settings = _load_settings()

        action = data.get("action")

        if action == "add":
            new_dir = data.get("path", "").strip()
            if not new_dir:
                return web.json_response({"success": False, "error": "No path provided"}, status=400)
            if not Path(new_dir).exists():
                return web.json_response(
                    {"success": False, "error": f"Directory not found: {new_dir}"},
                    status=400
                )
            dirs = current_settings.get("custom_directories", [])
            if new_dir not in dirs:
                dirs.append(new_dir)
            current_settings["custom_directories"] = dirs
            current_settings.pop("custom_directory", None)

        elif action == "remove":
            remove_path = data.get("path", "").strip()
            dirs = current_settings.get("custom_directories", [])
            if remove_path in dirs:
                dirs.remove(remove_path)
            current_settings["custom_directories"] = dirs
            hidden_dirs = current_settings.get("hidden_directories", [])
            if isinstance(hidden_dirs, list) and remove_path in hidden_dirs:
                hidden_dirs.remove(remove_path)
                current_settings["hidden_directories"] = hidden_dirs
            home = current_settings.get("home_order", [])
            if isinstance(home, list) and remove_path in home:
                home.remove(remove_path)
                current_settings["home_order"] = home
            chars = _character_token_list(current_settings.get("character_dirs"))
            off = _character_token_list(current_settings.get("character_dirs_off"))
            kept_chars = _purge_token_prefix(chars, remove_path.lower())
            kept_off = _purge_token_prefix(off, remove_path.lower())
            if kept_chars != chars:
                current_settings["character_dirs"] = kept_chars
            if kept_off != off:
                current_settings["character_dirs_off"] = kept_off

        elif action == "reorder":
            dirs = current_settings.get("custom_directories", [])
            paths = data.get("paths") if isinstance(data.get("paths"), list) else []
            ordered = [p for p in paths if p in dirs]
            ordered += [d for d in dirs if d not in ordered]
            current_settings["custom_directories"] = ordered
            # 统一顺序表：内置卡（Output/Input/收藏/Lora）、自定义目录与云端预设目录排在同一个列表里
            home = []
            for t in paths:
                if _is_home_entry_token(t, dirs) and t not in home:
                    home.append(t)
            home += [d for d in ordered if d not in home]
            home += [b for b in HOME_BUILTINS if b not in home]
            current_settings["home_order"] = home

        elif action == "set_hidden":
            hide_path = data.get("path", "").strip()
            hidden = bool(data.get("hidden"))
            dirs = current_settings.get("custom_directories", [])
            if _is_home_entry_token(hide_path, dirs):
                hidden_dirs = current_settings.get("hidden_directories", [])
                if not isinstance(hidden_dirs, list):
                    hidden_dirs = []
                if hidden and hide_path not in hidden_dirs:
                    hidden_dirs.append(hide_path)
                elif not hidden and hide_path in hidden_dirs:
                    hidden_dirs.remove(hide_path)
                current_settings["hidden_directories"] = hidden_dirs

        elif action == "set_character":
            # 角色图目录标记：从这个目录多选图片新建导演配方时默认全参考（三视图当关键帧会从设定图开镜）。
            # token 与隐藏开关同一套（内置卡 / 自定义目录 / 云端预设目录），只存显示路径、不落磁盘路径。
            token = data.get("path", "").strip()
            dirs = current_settings.get("custom_directories", [])
            if _is_home_entry_token(token, dirs):
                key = token.lower()
                marked = bool(data.get("character"))
                chars = _character_token_list(current_settings.get("character_dirs"))
                # 索引打了 character-sheet 标签的云端目录默认就是角色图，只从 character_dirs 里删掉会被
                # 默认值顶回来；用户显式取消要记进 character_dirs_off 才点得动。
                off = _character_token_list(current_settings.get("character_dirs_off"))
                if key in off:
                    off.remove(key)
                if marked:
                    if key not in chars:
                        chars.append(key)
                else:
                    if key in chars:
                        chars.remove(key)
                    if key not in off and key in _oss_character_dir_tokens():
                        off.append(key)
                current_settings["character_dirs"] = chars
                current_settings["character_dirs_off"] = off

        elif action == "list":
            pass

        elif action == "save_civitai":
            if "enabled" in data:
                current_settings["civitai_lora_enabled"] = bool(data.get("enabled"))
            if "bookmark_enabled" in data:
                current_settings["civitai_bookmark_enabled"] = bool(data.get("bookmark_enabled"))
            if "api_key" in data:
                current_settings["civitai_api_key"] = str(data.get("api_key") or "").strip()
            if "proxy" in data:
                current_settings["civitai_proxy"] = civitai.clean_proxy(data.get("proxy"))
            if isinstance(data.get("dirs"), list):
                current_settings["lora_sync_dirs"] = _normalize_lora_dir({"lora_sync_dirs": data["dirs"]})

        else:
            custom_dir = None
            if "presets_directory" in data:
                custom_dir = data["presets_directory"].strip()
            elif "custom_directory" in data:
                custom_dir = data["custom_directory"]

            if custom_dir is not None:
                if custom_dir and not Path(custom_dir).exists():
                    return web.json_response(
                        {"success": False, "error": f"Directory not found: {custom_dir}"},
                        status=400
                    )
                current_settings["custom_directories"] = [custom_dir]
                current_settings.pop("custom_directory", None)
                current_settings["hidden_directories"] = []

        _save_settings(current_settings)
        _invalidate_user_custom_dirs()
        if action == "save_civitai":
            await _ensure_auto_cache()
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.get("/neo_gallery/get_settings")
async def get_gallery_settings(request):
    """Get gallery settings (civitai api key is masked)."""
    settings = dict(_load_settings())
    key = str(settings.get("civitai_api_key") or "")
    settings["civitai_api_key"] = ""
    settings["civitai_api_key_set"] = bool(key)
    settings["civitai_api_key_hint"] = f"****{key[-4:]}" if len(key) >= 4 else ("****" if key else "")
    settings["civitai_proxy"] = civitai.clean_proxy(settings.get("civitai_proxy"))
    settings["home_order"] = _get_home_order()
    # 角色图有效列表：用户标记 ∪ 索引 character-sheet 标签目录 − character_dirs_off，前端逐字消费它。
    settings["character_dirs"] = _effective_character_dirs(settings)
    return web.json_response(settings)


@routes.post("/neo_gallery/upload_txt")
async def upload_txt(request):
    """Upload / update a .txt metadata file alongside a preset image."""
    try:
        post = await request.post()
        txt_content = post.get("content", "")
        filename = post.get("filename", "")

        if not filename:
            return web.json_response({"error": "No filename provided"}, status=400)

        if not filename.endswith(".txt"):
            filename += ".txt"

        dest = PRESETS_DIR / filename
        dest.write_text(txt_content, encoding="utf-8")
        return web.json_response({"name": filename, "success": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


def _delete_cached_thumbnails(filename: str, subfolder: str) -> int:
    """Remove thumbnail cache entries for one media file. Returns the deleted count."""
    if not THUMBNAIL_DIR.exists():
        return 0
    filename_stem = Path(filename).stem
    hash_hex = ""
    source_path = _find_source_media(filename, subfolder)
    if source_path and source_path.exists():
        hash_hex = _thumbnail_hash(source_path, source_path.stat())

    thumb_count = 0
    for date_dir in THUMBNAIL_DIR.iterdir():
        if not date_dir.is_dir():
            continue
        # Pattern 1: old format "{stem}_*.jpg"; Pattern 2: hash-based cache
        patterns = [f"{filename_stem}_*.jpg"] + ([f"{hash_hex}_*.jpg"] if hash_hex else [])
        for pattern in patterns:
            for thumb_file in date_dir.glob(pattern):
                try:
                    thumb_file.unlink()
                    thumb_count += 1
                except Exception:
                    pass
    return thumb_count


@routes.post("/neo_gallery/delete")
async def delete_gallery_item(request):
    """Delete a custom image + its .txt companion. Presets are read-only."""
    try:
        data = await request.json()
        filename = data.get("filename", "")
        subfolder = data.get("subfolder", "")

        # --- Input validation ---
        if not filename or ".." in filename:
            return web.json_response({"success": False, "error": "Invalid filename"}, status=400)

        # --- Read-only check for presets and lora cache ---
        # System input/output dirs are NOT blocked here: individual files inside
        # them can be deleted (the folder itself is protected by the listing UI).
        subfolder_lower = (subfolder or "").lower()
        if subfolder_lower == "presets" or subfolder_lower.startswith("presets/") \
                or subfolder_lower == "lora" or subfolder_lower.startswith("lora/") \
                or subfolder_lower == "civitai_bookmarks" or subfolder_lower.startswith("civitai_bookmarks/") \
                or subfolder_lower.startswith("storyboard/presets") or subfolder_lower.startswith("charactersheet/presets"):
            return web.json_response({"success": False, "error": "Cannot delete from read-only directory"}, status=403)

        # --- Resolve base directory and target path ---
        user_custom_dirs = _get_user_custom_dirs()
        
        print(f"[Neo Gallery] DELETE called: filename={filename!r}, subfolder={subfolder!r}")
        print(f"[Neo Gallery] Custom dirs count: {len(user_custom_dirs)}")
        for d in user_custom_dirs:
            print(f"  - {d}")

        base: Path | None = None
        found_path: Path | None = None
        
        # Single unified search: try every custom dir + subfolder + filename with every extension
        for dir_path in user_custom_dirs:
            if subfolder:
                candidate_base = dir_path / subfolder
            else:
                candidate_base = dir_path
            
            # Try exact filename first (without extension) — only if it exists as-is
            if (candidate_base / filename).is_file():
                base = dir_path
                found_path = candidate_base / filename
                print(f"[Neo Gallery] Found exact match: {found_path}")
                break
            
            # Try with every media extension
            for ext in ALL_MEDIA_EXTENSIONS:
                candidate = candidate_base / f"{filename}{ext}"
                if candidate.exists():
                    base = dir_path
                    found_path = candidate
                    print(f"[Neo Gallery] Found with extension {ext}: {candidate}")
                    break
            
            if base:
                break

        # Fallback: also check without subfolder prefix (root-level files)
        if not base:
            for dir_path in user_custom_dirs:
                for ext in ALL_MEDIA_EXTENSIONS:
                    candidate = dir_path / f"{filename}{ext}"
                    if candidate.exists():
                        base = dir_path
                        found_path = candidate
                        print(f"[Neo Gallery] Fallback found: {candidate}")
                        break
                if base:
                    break

        # System input/output dirs: allow deleting individual files inside them.
        # The folder itself stays protected (no folder-delete path); only files
        # are removed. Handles the prefixed ("Input/sub1") and bare relative
        # ("sub1") subfolder forms used by the listing and deep navigation.
        if not found_path and ".." not in filename and ".." not in subfolder:
            sys_sub_lower = (subfolder or "").lower()
            for info in _get_system_dirs():
                sys_name_lower = info["name"].lower()
                if sys_sub_lower == sys_name_lower:
                    rel_parts = []
                elif sys_sub_lower.startswith(sys_name_lower + "/"):
                    rel_parts = [p for p in subfolder[len(info["name"]):].split("/") if p]
                elif subfolder:
                    rel_parts = [p for p in subfolder.split("/") if p]
                else:
                    rel_parts = []
                if any(p in ("..", ".") for p in rel_parts):
                    continue
                sys_base = info["path"]
                for part in rel_parts:
                    sys_base = sys_base / part
                if (sys_base / filename).is_file():
                    base, found_path = sys_base, sys_base / filename
                    break
                for ext in ALL_MEDIA_EXTENSIONS:
                    candidate = sys_base / f"{filename}{ext}"
                    if candidate.exists():
                        base, found_path = sys_base, candidate
                        break
                if found_path:
                    break

        # Main dirs (Grid / Character): generated results are deletable; the OSS
        # preset cache is blocked above. Prefixed ("StoryBoard/2026-09-24") and bare
        # relative ("2026-09-24") subfolder forms, like system dirs. The prefix
        # is the display name ("StoryBoard"/"CharacterSheet"), not the on-disk dir name.
        if not found_path and ".." not in filename and ".." not in subfolder:
            main_parts = [p for p in (subfolder or "").split("/") if p]
            if main_parts and main_parts[0].lower() in ("storyboard", "charactersheet"):
                main_bases = (GRID_DIR if main_parts[0].lower() == "storyboard" else CHARACTER_DIR,)
                main_parts = main_parts[1:]
            else:
                main_bases = (GRID_DIR, CHARACTER_DIR)
            for main_base in main_bases:
                if any(p in ("..", ".") for p in main_parts):
                    continue
                main_target = main_base
                for part in main_parts:
                    main_target = main_target / part
                if (main_target / filename).is_file():
                    base, found_path = main_target, main_target / filename
                    break
                for ext in ALL_MEDIA_EXTENSIONS:
                    candidate = main_target / f"{filename}{ext}"
                    if candidate.exists():
                        base, found_path = main_target, candidate
                        break
                if found_path:
                    break

        if not base or not found_path:
            return web.json_response({"success": False, "error": f"Source file not found (filename={filename!r}, subfolder={subfolder!r})"}, status=404)

        # --- Resolve target directory ---
        target_dir = found_path.parent
        delete_filename = found_path.name  # Use the full filename with extension

        print(f"[Neo Gallery] Target dir: {target_dir}, file: {delete_filename}")

        if not target_dir.exists():
            return web.json_response({"success": False, "error": f"Target directory not found: {target_dir}"}, status=404)

        # --- Delete media files (use found_path's exact name) ---
        img_deleted = False
        if found_path and found_path.suffix.lower() in ALL_MEDIA_EXTENSIONS:
            try:
                found_path.unlink()
                img_deleted = True
                print(f"[Neo Gallery] Deleted media: {found_path}")
            except Exception as e:
                print(f"[Neo Gallery] Failed to delete {found_path}: {e}")

        # --- Delete .txt companion (use the same stem as found_path) ---
        txt_deleted = False
        txt_stem = found_path.stem  # Use the stem of the actual file, not the original filename
        txt = target_dir / f"{txt_stem}.txt"
        if txt.exists():
            try:
                txt.unlink()
                txt_deleted = True
                print(f"[Neo Gallery] Deleted txt: {txt}")
            except Exception as e:
                print(f"[Neo Gallery] Failed to delete {txt}: {e}")

        # Also check for .txt with the original filename stem (fallback)
        if not txt_deleted and filename:
            orig_txt = target_dir / f"{filename}.txt"
            if orig_txt.exists():
                try:
                    orig_txt.unlink()
                    txt_deleted = True
                except Exception as e:
                    print(f"[Neo Gallery] Failed to delete {orig_txt}: {e}")

        # Also check for .txt with the stem directly (no extension prefix)
        if not img_deleted and found_path.suffix.lower() != ".txt":
            stem_path = target_dir / found_path.name
            if stem_path.exists() and stem_path.suffix.lower() == ".txt":
                try:
                    stem_path.unlink()
                    txt_deleted = True
                except Exception as e:
                    print(f"[Neo Gallery] Failed to delete {stem_path}: {e}")

        # --- Delete cached thumbnails matching this file ---
        thumb_count = await asyncio.to_thread(_delete_cached_thumbnails, filename, subfolder)

        return web.json_response({
            "success": True,
            "deleted": img_deleted or txt_deleted,
            "image_deleted": img_deleted,
            "txt_deleted": txt_deleted,
            "thumbnails_cleared": thumb_count
        })
    except Exception as e:
        print(f"[Neo Gallery] delete_gallery_item error: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({"success": False, "error": str(e)}, status=500)





@routes.post("/neo_gallery/clear_thumbnails")
async def clear_thumbnails(request):
    """Clear all cached thumbnails for a given subfolder."""
    try:
        data = await request.json()
        subfolder = data.get("subfolder", "")
        
        if not subfolder:
            # Clear all thumbnails by removing date directories
            import shutil

            def _clear_all():
                for date_dir in THUMBNAIL_DIR.iterdir():
                    if date_dir.is_dir():
                        shutil.rmtree(date_dir)

            await asyncio.to_thread(_clear_all)
            return web.json_response({"success": True, "cleared": "all"})

        # For specific subfolder, clear all date directories (hash-based cache)
        def _clear_thumbs():
            count = 0
            for date_dir in THUMBNAIL_DIR.iterdir():
                if not date_dir.is_dir():
                    continue
                for thumb_file in date_dir.glob("*.jpg"):
                    thumb_file.unlink()
                    count += 1
            return count

        count = await asyncio.to_thread(_clear_thumbs)
        
        return web.json_response({"success": True, "cleared": count})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)



# Ensure gallery directories exist on module load
_ensure_dirs()
