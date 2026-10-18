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

import json
import logging
import os
import shutil
from pathlib import Path

PLUGIN_DIR = Path(__file__).parent.resolve()
DATA_ROOT_ENV = "NEO_STUDIO_DATA"
POINTER_FILE = PLUGIN_DIR / "configs" / "data_root.json"

# 随代码走的内置预设：数据根为空时从插件目录补进去，只补缺失文件，用户改过的不覆盖
SEED_DIRS = ("configs", "prompts/presets", "skills/presets", "skills/tasks", "recipes/presets")


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


def seed_presets() -> None:
    """数据根第一次用时，把插件目录里的内置预设补进去。"""
    if DATA_ROOT == PLUGIN_DIR:
        return
    try:
        for rel in SEED_DIRS:
            src = PLUGIN_DIR / rel
            if not src.is_dir():
                continue
            for f in src.rglob("*"):
                if not f.is_file():
                    continue
                dst = DATA_ROOT / f.relative_to(PLUGIN_DIR)
                if dst.exists():
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dst)
    except OSError as exc:
        logging.getLogger(__name__).warning(f"[Neo Studio] 预设补进 {DATA_ROOT} 失败：{exc}")


seed_presets()
