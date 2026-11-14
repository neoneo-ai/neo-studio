# SPDX-License-Identifier: Apache-2.0
# Neo Studio — 生视频（MiniMax H3）全局设置：独立于生图 image_gen.json，
# 落盘 configs/video_gen.json；/neo_video_gen/* 路由在此注册。

from __future__ import annotations

import json
import logging
import os
import re

import folder_paths
from aiohttp import web

from . import plugin_paths
from .image_gen_files import folder_mtimes
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

CONFIGS_DIR = str(plugin_paths.CONFIGS_DIR)
VIDEO_SETTINGS_FILE = os.path.join(CONFIGS_DIR, "video_gen.json")

# 空 = 未配置，节点回落到此再报错
DEFAULT_VIDEO_SETTINGS = {
    "video_model": "",                 # diffusion_models 相对名
    "video_text_encoder": "",          # text_encoders 相对名
    "video_vae": "",                   # vae 相对名（视频）
    "video_audio_vae": "",             # vae 相对名（H3 音频，独立 VAE）
}

routes = web.RouteTableDef()


def get_video_settings() -> dict:
    settings = dict(DEFAULT_VIDEO_SETTINGS)
    try:
        if os.path.exists(VIDEO_SETTINGS_FILE):
            with open(VIDEO_SETTINGS_FILE, "r", encoding="utf-8") as f:
                stored = json.load(f)
            if isinstance(stored, dict):
                settings.update({k: v for k, v in stored.items() if k in DEFAULT_VIDEO_SETTINGS})
    except Exception as e:
        logger.warning(f"video_gen settings ignored ({e}); using defaults")
    return settings


def save_video_settings(patch: dict) -> dict:
    settings = get_video_settings()
    for key, value in (patch or {}).items():
        if key in DEFAULT_VIDEO_SETTINGS:
            settings[key] = value
    os.makedirs(CONFIGS_DIR, exist_ok=True)
    tmp = VIDEO_SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    os.replace(tmp, VIDEO_SETTINGS_FILE)
    return settings


# 生视频（MiniMax H3）自动挑选默认模型时的名称线索（按优先级），与 image_gen._MODEL_HINTS 同构。
# "h3" 精确命中 H3 系列，避开同名 minimax 的 Music3 音频模型；VAE 用 h3_video 避开 audio VAE。
_VIDEO_MODEL_HINTS = {
    "diffusion_models": ("minimax_h3",),
    "text_encoders": ("qwen3vl_32b_minimax_h3",),
    "vae": ("minimax_h3_video",),
}


def suggest_video_model(folder: str) -> str:
    """按 H3 名称线索挑默认视频模型（turbo 优先、短名优先）；无命中返回空串。与 image_gen.suggest_model 同构。"""
    files = _video_folder_files(folder)
    if not files:
        return ""
    for hint in _VIDEO_MODEL_HINTS.get(folder, ()):
        matches = [f for f in files if hint in f.lower()]
        if matches:
            matches.sort(key=lambda f: (("turbo" not in f.lower()), len(f)))
            return matches[0]
    return ""


def suggest_audio_vae() -> str:
    """按名称线索挑 H3 音频 VAE（文件名同时含 h3 与 audio），无命中返回空串。"""
    for f in _video_folder_files("vae"):
        low = f.lower()
        if "h3" in low and "audio" in low:
            return f
    return ""


def _video_folder_files(folder: str) -> list:
    """类别里的模型相对名（排序）；目录扫不到（模型根断开）回空表，调用方按「没有候选」处理。"""
    try:
        return sorted(folder_paths.get_filename_list(folder) or [])
    except Exception as e:
        logger.warning(f"video_gen: scan {folder} failed: {e}")
        return []


def _video_display_sort(files: list) -> list:
    """下拉展示排序：H3 相关（文件名含 h3）靠前，其余按名称（不区分大小写）。与 image_gen._display_sort 同构。"""
    return sorted(files, key=lambda f: ("h3" not in f.lower(), f.lower()))


# 预设清单的 field → 模型类别：技能钉的就是清单里这些落点，社区命名（MiniMaxH3\h3.safetensors）
# 名称线索抓不到，靠清单进下拉。vae 类别按 field 分视频 / 音频两行
_VIDEO_MANIFEST_FIELDS = {"diffusion_models": ("model",), "text_encoders": ("text_encoder",),
                          "vae": ("vae",), "loras": ("loras",)}


def _family_tokens(rel_path: str) -> list:
    return [t for t in re.split(r"[^a-z0-9]+", str(rel_path or "").replace("\\", "/").lower()) if t]


def _is_h3_family(rel_path: str) -> bool:
    """MiniMax H3 家族：目录段或文件名命中 minimax / h3。清单没枚举的同家族权重
    （MiniMaxH3\\Fast\\fasth3_omniref_8step_pruned_int8）就靠目录段命中收进来。"""
    return any(t.startswith("minimax") or t == "h3" for t in _family_tokens(rel_path))


def _is_music_family(rel_path: str) -> bool:
    """minimax Music3 / acestep 音频家族（Music 权重树）：出视频三行不收，音频 VAE 行收。

    整串子串匹配，不按分段：minimax_music3 被下划线拆成 minimax 与 music3 两段，
    分段判定认不出它是音频家族，会被 minimax 前缀当成 H3 收进主模型行。
    """
    low = str(rel_path or "").replace("\\", "/").lower()
    return "minimax_music" in low or "acestep" in low


def _video_family_match(rel_path: str, audio: bool) -> bool:
    """一行 H3 下拉的家族判定：audio=False 收 H3 主模型 / 文本编码器 / 视频 VAE，
    audio=True 收 H3 音频 VAE 与 Music 家族。带 audio 段的 H3 文件（minimax_h3_audio_vae、
    diffusion_models 里的 minimax_h3_audio_v1_5）不进非音频行，反之亦然。"""
    if _is_music_family(rel_path):
        return audio
    if not _is_h3_family(rel_path):
        return False
    return ("audio" in _family_tokens(rel_path)) == audio


def _manifest_paths(folder: str, audio: bool = False) -> list:
    """视频族预设清单在该类别的落点名（filename 与 alt 都算，盘上没落也算——前端按「缺失」列出，
    钉住的值与模型库下载入口都靠它）。清单读不到（技能模块不可用、无 models.json）回空表。"""
    try:
        from . import skill_models
        from .skill import scan_skills
    except Exception as e:
        logger.warning(f"video_gen: skill manifest unavailable: {e}")
        return []
    fields = ("audio_vae",) if (folder == "vae" and audio) else _VIDEO_MANIFEST_FIELDS.get(folder, ())
    out = []
    for item in scan_skills():
        if item.get("source") != "presets":
            continue
        resolved = skill_models.resolve_skill_models(item.get("id", ""))
        if resolved.get("kind") != "video":
            continue
        for entry in resolved.get("files", []):
            if not isinstance(entry, dict) or entry.get("field") not in fields:
                continue
            for name in (entry.get("filename"), entry.get("alt")):
                name = str(name or "").strip().replace("\\", "/")
                if name and name not in out:
                    out.append(name)
    return out


def _video_scoped(files: list, folder: str, audio: bool = False) -> list:
    """H3 家族的下拉列表：预设清单钉的落点 ∪ 家族命中，统一走 _video_display_sort 的 H3 优先排序。
    清单里盘上没有的名字保留（前端标「缺失」），这样「自动」钉值不会因过滤被当成不存在。"""
    merged = []
    for name in _manifest_paths(folder, audio) + [f for f in files if _video_family_match(f, audio)]:
        if name not in merged:
            merged.append(name)
    return _video_display_sort(merged)


def scan_video_models() -> dict:
    """列出 H3 生视频可选模型（H3 相关靠前）与 LoRA，供前端设置面板展示。

    video_* 是 H3 家族 + 预设清单那一份，给「生视频模型 / Text Encoder / VAE（视频）/ VAE（音频）」
    四行用；原键始终是类别全表，「显示全部模型」与 LoRA 行读它（LoRA 跨家族混用是常态，不给 video_ 键）。
    """
    out = {}
    for folder in ("diffusion_models", "text_encoders", "vae", "loras"):
        files = _video_folder_files(folder)
        out[folder] = _video_display_sort(files)
        out["mtimes_" + folder] = folder_mtimes(folder)
        if folder == "loras":
            continue
        out["video_" + folder] = _video_scoped(files, folder)
    out["video_audio_vae"] = _video_scoped(_video_folder_files("vae"), "vae", audio=True)
    return out


@routes.get("/neo_video_gen/models")
async def video_models_route(request):
    return web.json_response(scan_video_models())


@routes.get("/neo_video_gen/settings")
async def get_video_settings_route(request):
    return web.json_response(get_video_settings())


@routes.post("/neo_video_gen/settings")
async def post_video_settings_route(request):
    try:
        patch = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    if not isinstance(patch, dict):
        return web.json_response({"error": "请求体不是对象"}, status=400)
    return web.json_response(save_video_settings(patch))