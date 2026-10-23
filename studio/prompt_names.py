# SPDX-License-Identifier: Apache-2.0
# Neo Studio — 提示词目录扫描（名字与标签）。
# 只碰数据根的 prompts/ 目录与每来源一份 _tags_index.json，不依赖 PromptServer / 节点 / LLM，
# 因此 ComfyUI 内注册与桌面端离线服务共用这一份实现。

from __future__ import annotations

import asyncio
import json
import logging
import os

from aiohttp import web

from . import plugin_paths
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

PROMPTS_DIR = str(plugin_paths.PROMPTS_DIR)
PRESETS_DIR = os.path.join(PROMPTS_DIR, "presets")
CUSTOM_DIR = os.path.join(PROMPTS_DIR, "custom")
PRESETS_TAGS_FILE = os.path.join(PRESETS_DIR, "_tags_index.json")
CUSTOM_TAGS_FILE = os.path.join(CUSTOM_DIR, "_tags_index.json")

for _dir in (PROMPTS_DIR, PRESETS_DIR, CUSTOM_DIR):
    os.makedirs(_dir, exist_ok=True)


def tags_file_path(source: str) -> str:
    """来源对应的标签索引文件：presets 与 custom 各一份"""
    return PRESETS_TAGS_FILE if source == "presets" else CUSTOM_TAGS_FILE


def load_tags_index(tags_file: str) -> dict:
    """读一份标签索引：文件缺失或被外部编辑器写坏时当空表，不阻断列表"""
    if not os.path.exists(tags_file):
        return {}
    try:
        with open(tags_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Error loading tags index from {tags_file}: {e}")
        return {}


def iter_prompt_names(source: str) -> list:
    """一个来源的全部提示词名字：只从目录列表取名字，一个来源只开一份标签索引。

    @ 点名弹层要的是名字与标签，正文是选中那一发才读；这里不逐个 stat 文件，
    一次弹层就是两次目录列表加两次索引打开，SMB 上不再逐文件往返。
    """
    base_dir = PRESETS_DIR if source == "presets" else CUSTOM_DIR
    index = load_tags_index(tags_file_path(source))
    prompts: list = []

    def walk(dir_path: str, prefix: str) -> None:
        try:
            entries = sorted(os.scandir(dir_path), key=lambda e: e.name)
        except OSError as e:
            logger.warning(f"Cannot scan prompts dir {dir_path}: {e}")
            return
        for entry in entries:
            if entry.is_dir():
                walk(entry.path, f"{prefix}{entry.name}/")
            elif entry.name.endswith(".txt") and not entry.name.startswith("_"):
                display = f"{prefix}{entry.name[:-4]}" if prefix else entry.name[:-4]
                prompts.append({"name": display, "source": source, "tags": index.get(display, [])})

    if os.path.isdir(base_dir):
        walk(base_dir, "")
    return prompts


# ===========================================================================
# 路由（桌面端离线服务与 ComfyUI 内注册共用）
# ===========================================================================

routes = web.RouteTableDef()


@routes.post("/rs_prompts/list_prompt_names")
async def list_prompt_names_route(request):
    """@ 点名弹层的候选：两个来源的名字与标签，custom 在前、presets 在后（与 list_prompts 同序）"""
    rows = await asyncio.to_thread(lambda: iter_prompt_names("custom") + iter_prompt_names("presets"))
    return web.json_response(rows)
