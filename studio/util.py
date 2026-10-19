# SPDX-License-Identifier: Apache-2.0
# Neo Studio — low-level media helpers shared by gallery / lora / recipes.
# Leaf module: depends only on the standard library, so it can be imported
# anywhere without risking an import cycle with the gallery route modules.

from __future__ import annotations

import copy
import json
import logging
import math
import os
import re
import difflib
from pathlib import Path

from . import plugin_paths

CURRENT_DIR = Path(__file__).parent.resolve()
CONFIGS_DIR = plugin_paths.CONFIGS_DIR
SETTINGS_FILE = CONFIGS_DIR / "gallery_settings.json"


class PrefixFilter(logging.Filter):
    """Auto-prepend '[Neo Studio] ' to log records that lack the prefix."""
    def filter(self, record):
        if not record.getMessage().startswith("[Neo Studio]"):
            record.msg = "[Neo Studio] " + record.msg
            record.args = ()
        return True


def plugin_version() -> str:
    """pyproject.toml 里的版本号：Studio 版本页与插件加载 banner 共用同一来源。"""
    pyproject = CURRENT_DIR / "pyproject.toml"
    try:
        m = re.search(r'^version\s*=\s*"([^"]+)"', pyproject.read_text(encoding="utf-8"), re.M)
        if m:
            return m.group(1)
    except OSError:
        pass
    return "unknown"


# ResolutionSelector（ComfyUI nodes_resolution.AspectRatio）的 aspect_ratio 是 combo，取值只能是这八项；
# 技能模板的 {{ASPECT_RATIO}} 按请求比例落进其中一项，落不进去就是比例不合法（不是渲染 bug）。
ASPECT_LABELS = {"1:1": "1:1 (Square)", "2:3": "2:3 (Portrait Photo)", "3:2": "3:2 (Photo)",
                 "3:4": "3:4 (Portrait Standard)", "4:3": "4:3 (Standard)",
                 "9:16": "9:16 (Portrait Widescreen)", "16:9": "16:9 (Widescreen)",
                 "21:9": "21:9 (Ultrawide)"}


def ratio_pair(text) -> tuple | None:
    """比例标签 → (w, h)：接受 "16:9" 与 combo 写法 "16:9 (Widescreen)" 的比例前缀，非法返回 None。"""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$",
                 str(text or "").strip().split(" ")[0], re.I)
    if not m:
        return None
    w, h = float(m.group(1)), float(m.group(2))
    if w <= 0 or h <= 0:
        return None
    return (w, h)


def _load_settings() -> dict:
    try:
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"[Neo Gallery] Failed to load settings ({e}); treating as empty. "
              f"Fix or delete {SETTINGS_FILE}")
    return {}


def _save_settings(settings: dict) -> None:
    """Atomically persist settings. Raises so callers can report a real failure."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_name(SETTINGS_FILE.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
    tmp.replace(SETTINGS_FILE)


def _json_safe(value):
    """Return a copy with non-finite floats (NaN/Infinity) replaced by None so the
    response is always valid strict JSON that browsers can parse."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# Media extensions
# ---------------------------------------------------------------------------
IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
ALL_MEDIA_EXTENSIONS = IMG_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS


def _has_media_recursive(directory: Path) -> bool:
    """Return True if any media file exists anywhere under directory.

    Stops as soon as the first media file is found, so deeply nested trees
    are not scanned in full just to derive a count that callers only use
    as a has-content flag. os.walk hands over the names of one enumeration
    per level; Path.is_file() re-queries every entry, which is a network
    round trip each on SMB shares.
    """
    for _root, _dirs, names in os.walk(directory):
        for name in names:
            if Path(name).suffix.lower() in ALL_MEDIA_EXTENSIONS:
                return True
    return False


def _has_media_in_dir_any(dir_path: Path) -> bool:
    """Check if a directory contains any media files (images OR videos) directly."""
    try:
        with os.scandir(dir_path) as it:
            for entry in it:
                if entry.is_file(follow_symlinks=False) and Path(entry.name).suffix.lower() in ALL_MEDIA_EXTENSIONS:
                    return True
    except OSError:
        return False
    return False


def _extract_media_metadata(path: Path) -> dict:
    """Read ComfyUI metadata embedded by Civitai example media: PNG tEXt chunks
    and MP4 udta/ilst ©cmt (written by VHS_VideoCombine save_metadata)."""
    try:
        data = path.read_bytes()
    except OSError:
        return {}
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        texts = {}
        off = 8
        while off + 12 <= len(data):
            size = int.from_bytes(data[off:off + 4], "big")
            if size <= 0 or off + 12 + size > len(data):
                break
            ctype = data[off + 4:off + 8]
            if ctype == b"tEXt":
                key, _, val = data[off + 8:off + 8 + size].partition(b"\x00")
                texts[key.decode("latin1", "replace")] = val.decode("utf-8", "replace")
            elif ctype == b"IDAT":
                break
            off += 12 + size
        return texts
    if data[4:8] == b"ftyp":
        i = data.find(b"ilst")
        if i > 0:
            seg = data[i + 4:i + 4_000_000]
            pos = 0
            result = {}
            while pos < len(seg) - 8:
                size = int.from_bytes(seg[pos:pos + 4], "big")
                if size < 8 or pos + size > len(seg):
                    break
                body = seg[pos + 8:pos + size]
                d = body.find(b"data")
                if d >= 0:
                    brace = body.find(b"{", d + 8)
                    if brace >= 0:
                        raw = body[brace:]
                        try:
                            parsed = json.loads(raw.decode("utf-8", "replace"))
                        except ValueError:
                            end = raw.rfind(b"}")
                            try:
                                parsed = json.loads(raw[:end + 1].decode("utf-8", "replace"))
                            except ValueError:
                                parsed = None
                        if isinstance(parsed, dict):
                            if "prompt" in parsed or "workflow" in parsed:
                                return parsed
                            if "nodes" in parsed and "links" in parsed:
                                result.setdefault("workflow", parsed)
                            elif parsed and all(
                                isinstance(v, dict) and "class_type" in v for v in parsed.values()
                            ):
                                result.setdefault("prompt", parsed)
                pos += size
            return result
    return {}


def _collect_prompt_texts(prompt: dict) -> dict:
    positive, negative, params = [], [], {}
    for node in (prompt or {}).values():
        if not isinstance(node, dict):
            continue
        for k, v in node.get("inputs", {}).items():
            if isinstance(v, str) and k in (
                "text", "positive_prompt", "negative_prompt", "text_g", "text_l", "caption",
            ):
                (negative if "negative" in k else positive).append(v)
            elif k in ("steps", "cfg", "seed", "width", "height", "length", "num_frames", "frame_rate") \
                    and isinstance(v, (int, float)) and k not in params:
                params[k] = v
    return {"positive": positive, "negative": negative, "params": params}


