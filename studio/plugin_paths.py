# SPDX-License-Identifier: Apache-2.0
# Neo Studio 数据根：用户数据住桌面端的状态目录，代码与内置预设住插件目录。
#
# 插件被装进 ComfyUI/custom_nodes 后，gallery / recipes / prompts / skills / configs 这些
# 用户数据不再随插件目录走：桌面端（源码运行是 Neo-Studio/data，exe 是 exe 旁的 data/）在拉起
# ComfyUI 时注入 NEO_STUDIO_DATA，并往插件目录留一份指针，用户自己启动 ComfyUI 时也认得。
# 三处都落空才回退插件目录 —— 插件被 ComfyUI-Manager 单独装、测试里临时造目录都走这条。
#
# 叶子模块：只依赖标准库，任何模块都能安全 import，不会绕出循环。

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
from pathlib import Path

PLUGIN_DIR = Path(__file__).parent.resolve()
DATA_ROOT_ENV = "NEO_STUDIO_DATA"
POINTER_FILE = PLUGIN_DIR / "configs" / "data_root.json"

# 随代码走的内置预设：数据根缺文件时从插件目录补进去
SEED_DIRS = ("configs", "prompts/presets", "skills/presets", "skills/tasks", "recipes/presets")
# 出厂文件落进数据根时的字节指纹，数据根 configs/ 下的缓存：删了重建，删后最坏是存量副本不再自动前进
SEED_STAMP_REL = "configs/preset_seed.json"
# 一次性搬运：这两条全参考预设在 2026-11-14 才带特效表与特效本体清单，播种指纹又是这轮才引入的，
# 老数据根没有指纹可判，只能把缺的那几个键补进去——已有键与键值一字不动，用户钉过的 steps 照留。
SEED_ADD_KEYS = frozenset((
    "skills/presets/minimax-h3-r2v/config.json",
    "skills/presets/minimax-h3-r2v/models.json",
    "skills/presets/minimax-h3-vdn-r2v/config.json",
    "skills/presets/minimax-h3-vdn-r2v/models.json",
))


def _resolve_data_root() -> Path:
    env = os.environ.get(DATA_ROOT_ENV, "").strip()
    if env:
        return Path(env)
    try:
        # utf-8-sig: a pointer written by a shell redirect lands as UTF-8 with a BOM,
        # and a strict utf-8 read turns that into a JSONDecodeError - which falls
        # through to the plugin directory as the data root, silently.
        cfg = json.loads(POINTER_FILE.read_text(encoding="utf-8-sig"))
        root = str(cfg.get("data_root", "")).strip() if isinstance(cfg, dict) else ""
        if root:
            return Path(root)
    except (OSError, json.JSONDecodeError):
        pass
    return PLUGIN_DIR


def write_pointer(data_root: Path, plugin_dir: Path) -> None:
    """桌面端把数据根写进插件目录：用户不经桌面端自己起 ComfyUI 时，插件靠它找到同一份数据。"""
    cfg = {"version": 1, "data_root": str(Path(data_root).resolve())}
    target = Path(plugin_dir) / "configs" / "data_root.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    os.replace(tmp, target)


DATA_ROOT = _resolve_data_root()
CONFIGS_DIR = DATA_ROOT / "configs"
GALLERY_DIR = DATA_ROOT / "gallery"
PROMPTS_DIR = DATA_ROOT / "prompts"
RECIPES_DIR = DATA_ROOT / "recipes"
SKILLS_DIR = DATA_ROOT / "skills"
AGENT_SESSIONS_DIR = DATA_ROOT / "agent_sessions"   # 智能体一次运行的会话落盘，只存本机
TASKS_DB = CONFIGS_DIR / "studio_tasks.sqlite"      # 顶栏任务中心：跨重启留下的生成状态历史


def seed_presets(plugin_dir: Path | None = None, data_root: Path | None = None) -> None:
    """内置预设走进数据根：缺的补进去，没人动过的出厂版随代码换新，用户改过的永不覆盖。"""
    src_dir = Path(plugin_dir) if plugin_dir else PLUGIN_DIR
    root = Path(data_root) if data_root else DATA_ROOT
    if root == src_dir:
        return
    try:
        stamp_file = root / SEED_STAMP_REL
        stamps = _seed_stamps(stamp_file)
        touched = False
        for rel, shipped in _shipped_seed_files(src_dir):
            target = root / rel
            if not target.exists():
                _place_seed(shipped, target)
                stamps[rel] = _sha256(shipped)
                touched = True
            elif stamps.get(rel) == _sha256(target):
                _place_seed(shipped, target)
                stamps[rel] = _sha256(shipped)
                touched = True
            elif rel in SEED_ADD_KEYS and _fill_missing_keys(shipped, target):
                # 补过键的副本不记指纹：往后每次seed都只走补键这条路，出厂再变也不会吃掉用户的键值
                touched = True
        if touched:
            _write_seed_stamps(stamp_file, stamps)
    except OSError as exc:
        logging.getLogger(__name__).warning(f"[Neo Studio] 预设补进 {root} 失败：{exc}")


def _shipped_seed_files(src_dir: Path):
    """出厂预设的 (相对路径, 插件目录里的文件)，路径固定用正斜杠，指纹跨平台一个样。"""
    for rel in SEED_DIRS:
        src = src_dir / rel
        if not src.is_dir():
            continue
        for f in src.rglob("*"):
            if f.is_file():
                yield f.relative_to(src_dir).as_posix(), f


def _place_seed(shipped: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(shipped, target)


def _sha256(path: Path) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _fill_missing_keys(shipped: Path, target: Path) -> bool:
    """出厂文件新增的键补进数据根副本，已有键与键值一字不动；两边都是 JSON 对象才动手。"""
    try:
        new = json.loads(shipped.read_text(encoding="utf-8-sig"))
        current = json.loads(target.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(new, dict) or not isinstance(current, dict):
        return False
    missing = {k: v for k, v in new.items() if k not in current}
    if not missing:
        return False
    current.update(missing)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, target)
    return True


def _seed_stamps(stamp_file: Path) -> dict:
    # 指纹是缓存：被删、写坏、被旧版本写过都只退化成"存量副本不再自动前进"，读侧一律不抛
    try:
        cfg = json.loads(stamp_file.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    files = cfg.get("files") if isinstance(cfg, dict) else None
    return dict(files) if isinstance(files, dict) else {}


def _write_seed_stamps(stamp_file: Path, stamps: dict) -> None:
    stamp_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = stamp_file.with_name(stamp_file.name + ".tmp")
    tmp.write_text(json.dumps({"version": 1, "files": stamps}, indent=2), encoding="utf-8")
    os.replace(tmp, stamp_file)


seed_presets()
