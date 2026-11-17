# SPDX-License-Identifier: Apache-2.0
# Neo Studio — 生图设置 / 模型扫描 / 技能文件路由。
# 只碰 configs/image_gen.json、模型目录与技能目录，不依赖 PromptServer 与执行队列，
# 因此 ComfyUI 内注册与桌面端离线服务共用这一份实现。

from __future__ import annotations

import difflib
import asyncio
import json
import logging
import os
import re

import folder_paths
from aiohttp import web

from . import plugin_paths
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

CONFIGS_DIR = str(plugin_paths.CONFIGS_DIR)
SETTINGS_FILE = os.path.join(CONFIGS_DIR, "image_gen.json")

DEFAULT_SETTINGS = {
    "model": "",              # diffusion_models 相对名；空 = 自动挑选 Krea2 模型
    "text_encoder": "",       # text_encoders 相对名
    "vae": "",                # vae 相对名
    "loras": [],              # [{name, strength}]，LoraLoaderModelOnly
    "base_resolution": 1280,  # 按比例算尺寸时的长边
    "default_ratio": "1:1",
    "target_megapixels": 1.5,  # 模型工作分辨率（MP）：扩图补边画布归一化到此像素数；常规编辑目标超过它时等比封顶
    "count": 1,               # 单次生图张数（1-8，写入模板 {{COUNT}}）
    "output_prefix": "NeoAgent",
    "enhance_prompt": False,           # 是否启用 LLM 提示词增强（指令即技能 skill.md 正文）
}

# skill config.json 里可覆盖全局生图设置的键（steps 为采样步数默认值，非模型设置区管理）
_SKILL_SETTING_KEYS = tuple(DEFAULT_SETTINGS) + ("steps", "max_refs", "min_refs", "control_ref")

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}

# 自动挑选默认模型时的名称线索（按优先级）
_MODEL_HINTS = {
    "diffusion_models": ("krea2", "krea"),
    # Krea2 只吃 Qwen3-VL-4B（CLIPLoader type krea2 → TEModel.QWEN3VL_4B，12 层 tap×2560）；
    # 挑到 8B/32B 会在执行期报 conditioning 维度错误，因此只精确匹配 4b，不做宽泛兜底
    "text_encoders": ("qwen3vl_4b", "qwen3_vl_4b", "qwen_3_vl_4b", "qwen3-vl-4b"),
    # Krea2 沿用 Qwen-Image 的 VAE；社区 Krea2-* VAE 只在缺官方文件时兜底
    "vae": ("qwen_image", "krea2"),
}

# 跑不了生图模板的家族（视频 / 音频 / 3D）：自动挑选与「只看生图家族」的下拉都不列，挑到它们
# 等于一次必败的生成（conditioning 维度对不上）。词表按本机模型根与预设清单取证：MiniMaxH3 视频
# 与它的 TE、Wan 权重与 umt5 TE（NSFW_APIs\nsfw_wan_umt5-12b 这种散在根目录的）、LTX 文本投影、
# minimax_music3 与 acestep 音频、tripo 3D 网格。判定按路径分段：长词前缀命中（minimaxh3 / wan2 /
# music3），短词整段相等（h3）——整串子串匹配会把 Wanderlust 这类混种按 "wan" 误杀；
# ACE_of_a_new_dawn 是 Krea2 混种，所以不收 "ace"，acestep 音频由 "acestep" 自己命中。
# moss 不在表内：MOSS\moss_image_* 是生图线。
_NON_IMAGE_FAMILY_WORDS = ("minimax", "h3", "wan2", "umt5", "ltx", "music", "acestep", "tripo")


# ===========================================================================
# 设置
# ===========================================================================

def get_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                stored = json.load(f)
            if isinstance(stored, dict):
                settings.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
    except Exception as e:
        logger.warning(f"image_gen settings ignored ({e}); using defaults")
    return settings


def save_settings(patch: dict) -> dict:
    settings = get_settings()
    for key, value in (patch or {}).items():
        if key in DEFAULT_SETTINGS:
            settings[key] = value
    os.makedirs(CONFIGS_DIR, exist_ok=True)
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
    os.replace(tmp, SETTINGS_FILE)
    return settings


# ===========================================================================
# 模型扫描 / 解析
# ===========================================================================

def _folder_files(folder: str) -> list:
    try:
        return sorted(folder_paths.get_filename_list(folder) or [])
    except Exception as e:
        logger.warning(f"image_gen: scan {folder} failed: {e}")
        return []


def suggest_model(folder: str) -> str:
    """按名称线索挑一个默认模型（turbo 优先、短名优先）；无命中返回空串。"""
    files = _folder_files(folder)
    if not files:
        return ""
    for hint in _MODEL_HINTS.get(folder, ()):
        matches = [f for f in files if hint in f.lower() and not _is_non_image_family(f)]
        if matches:
            matches.sort(key=lambda f: (("turbo" not in f.lower()), len(f)))
            return matches[0]
    return ""


def _is_non_image_family(rel_path: str) -> bool:
    """模型相对路径属视频 / 音频 / 3D 家族：路径分段命中 _NON_IMAGE_FAMILY_WORDS 即算。

    目录段与文件名同一条判定：Krea2 混种常放在 MiniMaxH3\\ 下（目录命中），
    视频权重也常散在根目录里（minimax_h3_video_v1_5、nsfw_wan_umt5-12b，文件名命中）。
    """
    tokens = [t for t in re.split(r"[^a-z0-9]+", str(rel_path or "").replace("\\", "/").lower()) if t]
    for word in _NON_IMAGE_FAMILY_WORDS:
        for token in tokens:
            if len(word) > 3 and token.startswith(word):
                return True
            if len(word) <= 3 and token == word:
                return True
    return False


def resolve_model(folder: str, wanted: str, allow_fallback: bool = False) -> tuple:
    """把设置里的模型名解析成 folder_paths 可用的相对名。

    返回 (resolved, message)：wanted 为空时自动挑选；找不到时给出候选名。
    allow_fallback 是生图路径的口径：自定义模型名不在盘上、类别里挑得出默认模型时就用默认模型跑，
    第二格回的是「已回退」这句话（调用方当提示用，不拦生成）。生视频不给这个口径——
    那里的模型、编码器、VAE 是一整套配方，换基座等于换配方，报出来比回退诚实。
    """
    files = _folder_files(folder)
    if not files:
        return "", f"{folder} 目录里没有模型文件，请先放入模型"
    wanted = str(wanted or "").strip()
    if not wanted:
        suggested = suggest_model(folder)
        if suggested:
            return suggested, ""
        return "", f"{folder} 里没有找到可用的默认模型，请在设置中手动选择"
    variants = (wanted, wanted.replace("\\", "/"), wanted.replace("/", "\\"))
    for variant in variants:
        if variant in files:
            return variant, ""
    lowered = {f.lower(): f for f in files}
    for variant in variants:
        hit = lowered.get(variant.lower())
        if hit:
            return hit, ""
    candidates = difflib.get_close_matches(wanted, files, n=3, cutoff=0.4)
    hint = "；候选: " + ", ".join(candidates) if candidates else ""
    if allow_fallback:
        suggested = suggest_model(folder)
        if suggested:
            return suggested, f"配置里的 {wanted} 本机没有，已回退默认模型 {suggested}"
    return "", f"找不到模型 {wanted}（{folder}）{hint}"


def _display_sort(files: list) -> list:
    """下拉展示排序：krea2 相关靠前，其余按名称（不区分大小写）。"""
    return sorted(files, key=lambda f: ("krea2" not in f.lower(), f.lower()))


def folder_mtimes(folder: str) -> dict:
    """模型文件 → 修改时间（epoch 秒），供下拉显示更新时间。

    少一条就算少：get_full_path 取不到（网络盘断开、列完目录后文件被移走）
    或 stat 失败时跳过该文件，前端按「无日期」渲染，列表本身不受影响。
    """
    out = {}
    for name in _folder_files(folder):
        full = folder_paths.get_full_path(folder, name)
        if not full:
            continue
        try:
            out[name] = os.path.getmtime(full)
        except OSError:
            continue
    return out


def scan_models() -> dict:
    """列出可选模型、自动挑选结果与文件修改时间，供前端设置面板展示。

    image_* 是去掉视频 / 音频 / 3D 家族的那份，给没有技能家族上下文的下拉用（全局生图设置、
    提及选择器、Text Encoder / VAE 行）；原键始终是类别全表，技能清单校验与「显示全部模型」读它。
    LoRA 不给 image_ 键：跨家族混用 LoRA 是常态。
    """
    out = {}
    for folder in ("diffusion_models", "text_encoders", "vae", "loras"):
        files = _folder_files(folder)
        out[folder] = _display_sort(files)
        out["suggested_" + folder] = suggest_model(folder)
        out["mtimes_" + folder] = folder_mtimes(folder)
        if folder != "loras":
            out["image_" + folder] = _display_sort([f for f in files if not _is_non_image_family(f)])
    return out


# ===========================================================================
# 路由（桌面端离线服务与 ComfyUI 内注册共用）
# ===========================================================================

routes = web.RouteTableDef()


@routes.get("/neo_image_gen/settings")
async def get_settings_route(request):
    return web.json_response(get_settings())


@routes.post("/neo_image_gen/settings")
async def post_settings_route(request):
    try:
        patch = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    if not isinstance(patch, dict):
        return web.json_response({"error": "请求体不是对象"}, status=400)
    return web.json_response(save_settings(patch))


@routes.get("/neo_image_gen/models")
async def models_route(request):
    # 模型目录扫描（get_filename_list 走整棵 models 树）是同步文件遍历：
    # 桌面端所有请求共用一个事件循环，留在循环上会把并发的首页 list 挤到几秒后。
    return web.json_response(await asyncio.to_thread(scan_models))


@routes.get("/neo_image_gen/input_images")
async def input_images_route(request):
    """Input 目录图片列表（编辑弹窗「参考图」选择器用）；按修改时间倒序，上限 500。"""
    items = []
    input_dir = folder_paths.get_input_directory()
    for root, _dirs, files in os.walk(input_dir):
        for f in files:
            if os.path.splitext(f)[1].lower() in _IMAGE_SUFFIXES:
                full = os.path.join(root, f)
                try:
                    items.append((os.path.getmtime(full),
                                  os.path.relpath(full, input_dir).replace("\\", "/")))
                except OSError:
                    continue
    items.sort(reverse=True)
    out = []
    for _mtime, rel in items[:500]:
        name, _, sub = rel.rpartition("/")
        out.append({"filename": name, "subfolder": sub})
    return web.json_response({"items": out})



@routes.post("/neo_image_gen/plan_workflow_skill")
async def plan_workflow_skill_route(request):
    """「从画布创建技能」的导出预览：列出画布里可替换成占位符的 widget 候选，不落盘。"""
    from . import skill as _skill

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    body = body if isinstance(body, dict) else {}
    result = _skill.plan_workflow_skill(body.get("workflow"))
    if not result.get("success"):
        return web.json_response({"error": result.get("message")}, status=400)
    return web.json_response(result)


@routes.post("/neo_image_gen/save_workflow_skill")
async def save_workflow_skill_route(request):
    """把当前画布工作流（API prompt）导出为生图技能。"""
    from . import skill as _skill

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    body = body if isinstance(body, dict) else {}
    result = _skill.save_workflow_skill(
        body.get("name", ""), body.get("description", ""),
        body.get("tags", []), body.get("workflow"), body.get("bindings"))
    if not result.get("success"):
        return web.json_response({"error": result.get("message")}, status=400)
    return web.json_response(result)


@routes.post("/neo_image_gen/update_workflow_skill")
async def update_workflow_skill_route(request):
    """把画布工作流（API prompt）回写入 existing skill（预设只写模型值到本地覆盖）。"""
    from . import skill as _skill

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    body = body if isinstance(body, dict) else {}
    result = _skill.update_workflow_skill(str(body.get("skill_id") or ""), body.get("workflow"))
    if not result.get("success"):
        return web.json_response({"error": result.get("message")}, status=400)
    return web.json_response(result)


@routes.post("/neo_image_gen/update_workflow_skill_preview")
async def preview_workflow_skill_route(request):
    """回写前预览：返回画布相对技能的变更清单与 warnings，不落盘。"""
    from . import skill as _skill

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    body = body if isinstance(body, dict) else {}
    result = _skill.preview_workflow_skill(str(body.get("skill_id") or ""), body.get("workflow"))
    if not result.get("success"):
        return web.json_response({"error": result.get("message")}, status=400)
    return web.json_response(result)


@routes.get("/neo_image_gen/skill_workflow")
async def get_skill_workflow_route(request):
    """返回技能 workflow.json（API prompt 模板），供详情弹窗渲染节点流程图；缺失/非法 404。"""
    from . import skill as _skill

    skill_id = request.query.get("skill_id", "")
    if not skill_id:
        return web.json_response({"error": "缺少 skill_id"}, status=400)
    wf = _skill.load_skill_workflow(skill_id)
    if wf is None:
        return web.json_response({"error": "workflow.json 不存在或非法"}, status=404)
    return web.json_response({"skill_id": skill_id, "workflow": wf})


@routes.get("/neo_image_gen/skill_config")
async def get_skill_config_route(request):
    from . import skill as _skill

    skill_id = request.query.get("skill_id", "")
    if not skill_id:
        return web.json_response({"error": "缺少 skill_id"}, status=400)
    return web.json_response(_skill.get_skill_gen_config(skill_id))


@routes.post("/neo_image_gen/skill_config")
async def post_skill_config_route(request):
    from . import skill as _skill

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    body = body if isinstance(body, dict) else {}
    ok, message = _skill.save_skill_gen_config(
        str(body.get("skill_id") or ""), body.get("config") or {})
    if not ok:
        status = 403 if "preset" in message.lower() else 400
        return web.json_response({"error": message}, status=status)
    return web.json_response({"success": True})


@routes.post("/neo_image_gen/copy_skill_files")
async def copy_skill_files_route(request):
    """「复制为自定义」时把源技能的 workflow.json / config.json 一并带过去。"""
    from . import skill as _skill

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    body = body if isinstance(body, dict) else {}
    ok, message = _skill.copy_skill_files(
        str(body.get("from_id") or ""), str(body.get("to_id") or ""))
    if not ok:
        return web.json_response({"error": message}, status=400)
    return web.json_response({"success": True})


@routes.post("/neo_image_gen/save_combo_skill")
async def save_combo_skill_route(request):
    """「生成素材」弹窗把选中的"主模型 + LoRA"组合存为新技能（名称自动生成，其余设置沿用源技能）。"""
    from . import skill as _skill

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    body = body if isinstance(body, dict) else {}
    result = _skill.save_combo_as_skill(
        str(body.get("skill_id") or ""), body.get("model", ""), body.get("loras", []),
        body.get("ratio", ""), body.get("edge", ""))
    if not result.get("success"):
        return web.json_response({"error": result.get("message")}, status=400)
    return web.json_response(result)


# ==========================================
# 图片源解析（前端传图 / 节点 image 输入）
# 从 prompts.py 搬来：桌面端离线服务也要解析参考图，而 prompts.py 顶层带 server 与 torch，
# 桌面进程加载不动。folder_paths 与 PIL 只在函数内 import，模块 import 期保持干净。
# ==========================================

MAX_IMAGE_SIDE = 1024

# 节点 image 输入允许解析的图片扩展名
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


def _read_image_raw(src: dict) -> bytes | None:
    """解析图片源为原始字节。

    kind="data":  {"data": "data:image/png;base64,..."}  前端粘贴/选择/拖拽
    kind="input": {"value": "sub/dir/img.png[output]"}   节点 image 输入上游（如 LoadImage）
    """
    import base64
    import folder_paths

    kind = src.get("kind", "data")
    if kind == "data":
        data_uri = src.get("data", "")
        if "," not in data_uri:
            return None
        try:
            return base64.b64decode(data_uri.split(",", 1)[1])
        except Exception as e:
            logger.warning(f"resolve_image_bytes: failed to decode base64 image: {e}")
            return None

    if kind == "input":
        name = str(src.get("value", "")).strip()
        if not name:
            return None
        # 解析 [input]/[output] 标注（LoadImage 的 widget 值可能带），默认 input 目录
        stem, tag = name, ""
        if name.endswith("]") and "[" in name:
            stem, _, tag = name[:-1].rpartition("[")
        base_dir = folder_paths.get_output_directory() if tag == "output" \
            else folder_paths.get_input_directory()
        real = os.path.realpath(os.path.join(base_dir, stem))
        base_real = os.path.realpath(base_dir)
        if not os.path.normcase(real).startswith(os.path.normcase(base_real) + os.sep):
            logger.warning(f"resolve_image_bytes: path escapes directory: {name}")
            return None
        if not os.path.isfile(real):
            logger.warning(f"resolve_image_bytes: image not found: {name}")
            return None
        if os.path.splitext(real)[1].lower() not in _IMAGE_EXTENSIONS:
            logger.warning(f"resolve_image_bytes: unsupported image type: {name}")
            return None
        try:
            with open(real, "rb") as f:
                return f.read()
        except Exception as e:
            logger.warning(f"resolve_image_bytes: failed to read {name}: {e}")
            return None

    return None


def resolve_image_bytes(src: dict, max_side: int = MAX_IMAGE_SIDE) -> bytes | None:
    """将前端传入的图片源解析为字节数据（超过最长边时等比缩放为 PNG）。"""
    import io
    from PIL import Image

    if not isinstance(src, dict):
        return None
    raw = _read_image_raw(src)
    if raw is None:
        return None
    try:
        with Image.open(io.BytesIO(raw)) as img:
            w, h = img.size
            if max(w, h) > max_side:
                ratio = max_side / max(w, h)
                img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue()
    except Exception as e:
        logger.warning(f"resolve_image_bytes: failed to process image: {e}")
        return None

