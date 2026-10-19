# SPDX-License-Identifier: Apache-2.0
# Neo Studio — 内置生图（技能工作流模板渲染）
# 生图完全由所选技能的 workflow.json 模板驱动：占位符替换 + LoRA 槽位填充/动态注入，
# 渲染后的 API prompt 通过内部 HTTP API 压进执行队列，复用 ComfyUI 的排队、显存生命周期与
# 取消行为；任务状态由 _watch 协程按变化经 rs.image_gen.status 事件推给前端。
# 输出落在 output 目录的 <前缀>/<日期>/<slug> 下并写同名 .txt（提示词），
# Gallery 可直接浏览、搜索并把图发送回工作流节点。

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import io
import json
import logging
import os
import random
import re
import shutil
import time
import uuid
from typing import Generator
from urllib.parse import quote, unquote

import aiohttp
from aiohttp import web
import folder_paths
from comfy.cli_args import args as cli_args, LatentPreviewMethod
from comfy_execution.progress import ProgressHandler, add_progress_handler, get_progress_state
from server import PromptServer

from .util import PrefixFilter, ASPECT_LABELS, ratio_pair
from .image_gen_files import (CONFIGS_DIR, SETTINGS_FILE, DEFAULT_SETTINGS, _IMAGE_SUFFIXES,
                              _MODEL_HINTS, _SKILL_SETTING_KEYS, _display_sort, _folder_files,
                              get_settings, save_settings, scan_models, resolve_model, suggest_model)

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

MAX_IMAGES = 8        # 单次请求最多张数（批量共用一个 base seed）
TASK_TTL = 3600       # 任务记录保留时长（秒）
MAX_TASKS = 32        # 任务记录上限

# 独立 client_id：生图任务的进度事件不混进前端 UI 的节点高亮
CLIENT_ID = str(uuid.uuid4())
# 任务快照推送事件：_watch 按变化 send_sync 给所有客户端，前端 watchTask 按 task_id 过滤
STATUS_EVENT = "rs.image_gen.status"

# 采样参数（cfg/sampler/denoise 等）不走设置，直接写死在各技能的 workflow.json 模板里；
# steps 例外：skill config.json 可配默认值，节点/请求可覆盖。
# 单次请求允许覆盖的设置键（其余设置一律以全局为准）
_OVERRIDE_KEYS = ("model", "text_encoder", "vae", "loras",
                  "base_resolution", "default_ratio", "output_prefix", "steps")

# 扩图默认触发词（与 Qwen2.1 扩图 LoRA 的训练触发词一致）；扩图模式提示词为空时填入
OUTPAINT_DEFAULT_PROMPT = ("Outpaint the image: replace the solid gray areas with a seamless continuation "
                           "of the scene, keeping the existing picture unchanged.")
# 扩图链两次缩放的目标像素数（对齐参考工作流 ▶▷Qwen-image21-功能流 的「图像扩展」分支）：
# 原图先归一化到 1MP，补灰边后整幅画布再归一化到 target_megapixels（默认 1.5，见 DEFAULT_SETTINGS），
# 两次都按 32 对齐（编码器只吃 32 的倍数）
OUTPAINT_REF_MP = 1.0
# 扩图链的四边留白占位符（模板 ImagePadForOutpaint 用，值来自请求里的 outpaint 参数）
_PAD_TOKENS = {"{{PAD_LEFT}}": "left", "{{PAD_TOP}}": "top",
               "{{PAD_RIGHT}}": "right", "{{PAD_BOTTOM}}": "bottom"}

# 局部编辑追加的区域约束（模型看到的是涂抹区标红的裁剪图）
LOCAL_EDIT_PROMPT_SUFFIX = ("Only modify the red highlighted area; keep all other parts of the image exactly unchanged.")
# 点选删除默认提示词（SAM3 遮罩标红后，模型移除红色区域物体并自然填充背景）
REMOVE_DEFAULT_PROMPT = ("Remove the object in the red highlighted area and fill it with the surrounding background. "
                         "The filled area seamlessly continues the scene's lighting, perspective, and surface textures. "
                         "All other parts of the image remain exactly unchanged.")

_VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
_AUDIO_SUFFIXES = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac"}

# 参考媒体类型 → 允许的后缀（参考图/参考视频/参考音频，对应 H3 的 ref_images/ref_videos/ref_audios）
_REF_MEDIA_SUFFIXES = {
    "image": _IMAGE_SUFFIXES,
    "video": _VIDEO_SUFFIXES,
    "audio": _AUDIO_SUFFIXES,
}

# data URI 的 mime → 落盘后缀（参考媒体以 kind=data 传来时用；未知 mime 回落 .bin 由 Comfy 报错）
_MIME_SUFFIXES = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/bmp": ".bmp",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3",
    "audio/flac": ".flac", "audio/ogg": ".ogg", "audio/mp4": ".m4a",
}


# ===========================================================================
# 尺寸工具
# ===========================================================================

_RATIO_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$", re.I)


def parse_ratio(ratio) -> float | None:
    """解析 "16:9" / "16x9" / "1.78" 之类的比例，非法返回 None。"""
    if ratio is None:
        return None
    text = str(ratio).strip()
    if not text:
        return None
    m = _RATIO_RE.match(text)
    if m:
        w, h = float(m.group(1)), float(m.group(2))
        return (w / h) if w > 0 and h > 0 else None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value > 0 else None


def _round_multiple(value: float, multiple: int = 16) -> int:
    return max(multiple, int(value / multiple + 0.5) * multiple)


def size_from_ratio(ratio_value: float, base_resolution: int) -> tuple:
    """按比例算出长边为 base_resolution 的宽高（对齐到 16）。"""
    long_side = max(256, int(base_resolution))
    if ratio_value >= 1.0:
        return _round_multiple(long_side), _round_multiple(long_side / ratio_value)
    return _round_multiple(long_side * ratio_value), _round_multiple(long_side)


def resolve_dimensions(settings: dict, *, ratio=None, width=0, height=0) -> tuple:
    """宽高优先级：显式宽高 > 显式比例 > 设置默认比例。"""
    try:
        w, h = int(width or 0), int(height or 0)
    except (TypeError, ValueError):
        w = h = 0
    if w > 0 and h > 0:
        return _round_multiple(w), _round_multiple(h)
    base = settings.get("base_resolution") or DEFAULT_SETTINGS["base_resolution"]
    value = parse_ratio(ratio)
    if value:
        return size_from_ratio(value, base)
    value = parse_ratio(settings.get("default_ratio")) or 1.0
    return size_from_ratio(value, base)


# ===========================================================================
# 输出路径 / 参考图
# ===========================================================================

def safe_prefix(prefix: str) -> str:
    """清洗输出前缀（可含子目录）：拒绝上跳，逐段消毒非法字符。"""
    text = str(prefix or "").strip().replace("\\", "/")
    parts = []
    for raw in text.split("/"):
        if raw.strip() == "..":
            raise ValueError(f"非法输出路径: {prefix}")
        part = re.sub(r'[<>:"|?*\x00-\x1f]', "", raw).strip(" .")
        if not part or part == ".":
            continue
        parts.append(part)
    return "/".join(parts)


def slug_from_text(text: str, limit: int = 40) -> str:
    """从提示词取 ASCII slug（用作输出子目录名）；无可用字符返回空串。"""
    words = re.findall(r"[A-Za-z0-9]+", str(text or ""))
    slug = "_".join(words[:6]).lower()
    return slug[:limit].strip("_")


def _within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def _split_tagged(value: str) -> tuple:
    """拆掉 LoadImage widget 值末尾的 [input]/[output] 标注。"""
    stem, tag = str(value or "").strip(), ""
    if stem.endswith("]") and "[" in stem:
        stem, _, tag = stem[:-1].rpartition("[")
    return stem.replace("\\", "/"), tag


def _reference_size(ref_name: str) -> tuple | None:
    """读参考图像素尺寸（等比适配计算用）；失败返回 None。"""
    try:
        from PIL import Image
        path = os.path.join(folder_paths.get_input_directory(), *ref_name.split("/"))
        with Image.open(path) as img:
            return img.size  # (w, h)
    except Exception as e:
        logger.warning(f"image_gen: read reference size failed ({ref_name}): {e}")
        return None


def _edit_canvas_size(ref_size: tuple | None, width: int, height: int) -> tuple | None:
    """常规编辑送进编码器的参考画布尺寸（模板里 ImageScale 的目标 = {{CANVAS_WIDTH}}/{{CANVAS_HEIGHT}}）。

    与参考工作流一致：参考图缩放到与空 latent 相同的尺寸（编码器 resolution=0 不再二次缩放），
    画面位置才不偏。比例与原图差超过半格时按「换画幅重画」只对齐到 32，让编码器按模板自带的
    resolution 语义处理，避免把参考图硬拉变形。无参考图（文生图）返回 None → 模板里该节点被裁。"""
    if not ref_size or min(ref_size) <= 0:
        return None
    w, h = _round_multiple(width, 32), _round_multiple(height, 32)
    k = min(w / ref_size[0], h / ref_size[1])   # 原图等比放进目标框
    if abs(ref_size[0] * k - w) > 16 or abs(ref_size[1] * k - h) > 16:
        return _round_multiple(ref_size[0], 32), _round_multiple(ref_size[1], 32)
    return w, h


def _reference_name(src: dict, media: str = "image") -> str | None:
    """把参考媒体落到 input 目录，返回对应加载节点（LoadImage/LoadVideo/LoadAudio）可用的相对名。

    media 为 image / video / audio（缺省 image，保持既有调用不变）：决定允许的后缀。
    无法解析（类型不符/文件不存在/内容非法）返回 None。
    """
    if not isinstance(src, dict):
        return None
    suffixes = _REF_MEDIA_SUFFIXES.get(media, _IMAGE_SUFFIXES)
    input_dir = os.path.realpath(folder_paths.get_input_directory())
    kind = src.get("kind", "input")

    if kind == "input":
        stem, tag = _split_tagged(src.get("value", ""))
        if not stem or ".." in stem.split("/"):
            return None
        if os.path.splitext(stem)[1].lower() not in suffixes:
            return None
        base = input_dir if tag != "output" else os.path.realpath(folder_paths.get_output_directory())
        real = os.path.realpath(os.path.join(base, *stem.split("/")))
        if not _within(real, base) or not os.path.isfile(real):
            logger.warning(f"image_gen: reference {media} not found: {src.get('value')}")
            return None
        if tag != "output":
            return stem
        # output 里的文件对应加载节点看不到，复制进 input 目录再用
        dest_dir = os.path.join(input_dir, "NeoAgent")
        os.makedirs(dest_dir, exist_ok=True)
        root, ext = os.path.splitext(os.path.basename(real))
        name = f"{root}_{time.strftime('%Y%m%d-%H%M%S')}{ext}"
        shutil.copy2(real, os.path.join(dest_dir, name))
        return f"NeoAgent/{name}"

    if kind == "data":
        data_uri = str(src.get("data", ""))
        if "," not in data_uri:
            return None
        head, payload = data_uri.split(",", 1)
        mime = head[5:].split(";", 1)[0].strip().lower() if head.startswith("data:") else ""
        if mime and mime.split("/", 1)[0] != media:
            return None   # mime 与声明的参考类型不符（如把视频当参考图传进来）
        ext = _MIME_SUFFIXES.get(mime, ".png")
        try:
            raw = base64.b64decode(payload)
        except Exception as e:
            logger.warning(f"image_gen: bad base64 reference: {e}")
            return None
        dest_dir = os.path.join(input_dir, "NeoAgent")
        os.makedirs(dest_dir, exist_ok=True)
        digest = hashlib.sha1(raw).hexdigest()[:12]
        name = f"ref_{digest}{ext}"
        with open(os.path.join(dest_dir, name), "wb") as f:
            f.write(raw)
        return f"NeoAgent/{name}"

    return None


# ===========================================================================
# 请求参数解析（设置 + 单次覆盖 + 模型解析 + 参考图落盘）
# ===========================================================================

def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _resolve_loras(settings: dict) -> tuple:
    """解析设置里的 LoRA 列表，返回 ([{name, strength}], warnings)。"""
    entries = settings.get("loras") or []
    if not isinstance(entries, list):
        return [], ["loras 配置不是列表，已忽略"]
    resolved = []
    warnings = []
    for entry in entries:
        if isinstance(entry, str):
            name, strength = entry, 1.0
        elif isinstance(entry, dict):
            name = str(entry.get("name", "")).strip()
            strength = _float(entry.get("strength"), 1.0)
        else:
            continue
        if not name:
            continue
        hit, err = resolve_model("loras", name)
        if err:
            warnings.append(err)
            continue
        resolved.append({"name": hit, "strength": min(10.0, max(-10.0, strength))})
    return resolved, warnings


_REF_IMAGE_SLOT_RE = re.compile(r"\{\{REF_IMAGE_(\d+)\}\}")


def template_max_refs(template: dict, settings: dict | None = None) -> int:
    """技能可保留的参考图张数上限：config.json 的 max_refs 优先，
    缺省回退模板 {{REF_IMAGE_n}} 多路槽位的最大序号（无多路槽位时为 1）。"""
    try:
        cfg_max = int((settings or {}).get("max_refs") or 0)
    except (TypeError, ValueError):
        cfg_max = 0
    if cfg_max > 0:
        return cfg_max
    found = 0
    for node in (template or {}).values():
        if not isinstance(node, dict):
            continue
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, str):
                for m in _REF_IMAGE_SLOT_RE.finditer(value):
                    found = max(found, int(m.group(1)))
    return found or 1


def template_is_qwen21(template: dict) -> bool:
    """是否 Qwen Image 2.1 模板：含 Qwen Image 2.1 编码器 + 采样器。

    扩图 / 局部编辑 / 目标尺寸 32 对齐都按它判定（Qwen2.1 的 latent 一格 = 32px）。"""
    types = {n.get("class_type") for n in (template or {}).values() if isinstance(n, dict)}
    return "TextEncodeQwenImage21" in types and "KSampler" in types


def template_supports_outpaint(template: dict) -> bool:
    """模板是否自带扩图链（ImagePadForOutpaint）——扩图请求只能发给扩图技能。"""
    types = {n.get("class_type") for n in (template or {}).values() if isinstance(n, dict)}
    return "ImagePadForOutpaint" in types


def _parse_outpaint(value) -> dict | None:
    """解析扩图参数 {left, top, right, bottom, total_pixels}；未提供时返回 None。

    四边留白以「原图按 1MP 归一化后」的像素计（非负整数，单边上限 8192）；total_pixels 是补边画布
    归一化的目标总像素（MP），0/缺失 = 用默认 1.5MP；四边全 0 视为未开扩图。"""
    if not isinstance(value, dict):
        return None
    pads = {}
    for key in ("left", "top", "right", "bottom"):
        raw = value.get(key)
        if raw is None:
            pads[key] = 0
            continue
        try:
            pads[key] = max(0, min(8192, int(raw)))
        except (TypeError, ValueError):
            raise ValueError(f"outpaint.{key} 需为非负整数")
    if not any(pads.values()):
        return None
    total_pixels = _float(value.get("total_pixels"), 0.0)
    return {"left": pads["left"], "top": pads["top"], "right": pads["right"],
            "bottom": pads["bottom"],
            "total_pixels": max(0.0, min(16.0, total_pixels))}


def _parse_remove_points(value) -> list | None:
    """解析点选删除的点击坐标 [{x, y}]（原图像素）；未提供时返回 None。

    最多 5 个点；坐标为非负整数，单边上限 8192。"""
    if not isinstance(value, (list, tuple)) or not value:
        return None
    pts = []
    for p in list(value)[:5]:
        if not isinstance(p, dict):
            raise ValueError("remove_points 每项需为 {x, y} 对象")
        try:
            x = max(0, min(8192, int(p["x"])))
            y = max(0, min(8192, int(p["y"])))
        except (KeyError, TypeError, ValueError):
            raise ValueError("remove_points 每项需含数值 x/y")
        pts.append({"x": x, "y": y})
    return pts or None


def _prepare_local_edit(ref_name: str, mask_src: dict) -> dict:
    """高分局部编辑预处理：解码涂抹遮罩，自动定位编辑区（非零像素包围盒 + 25% 边距），
    生成红色高亮裁剪图（模型据此识别编辑目标）与羽化遮罩（合并回原图用），返回裁剪框与临时文件名。"""
    from PIL import Image, ImageFilter
    mask_name = _reference_name(mask_src)
    if not mask_name:
        raise ValueError("涂抹区域（遮罩）无法读取，请重新涂抹后再生成")
    input_dir = folder_paths.get_input_directory()
    try:
        with Image.open(os.path.join(input_dir, *ref_name.split("/"))) as orig:
            orig = orig.convert("RGB")
        with Image.open(os.path.join(input_dir, *mask_name.split("/"))) as mask:
            mask = mask.convert("L")
    except Exception as e:
        raise ValueError(f"读取原图/遮罩失败：{e}")
    if mask.size != orig.size:
        mask = mask.resize(orig.size)
    bbox = mask.getbbox()
    if not bbox:
        raise ValueError("请先涂抹要编辑的区域")
    W, H = orig.size
    bx0, by0, bx1, by1 = bbox
    pad_x = max(32, int((bx1 - bx0) * 0.25))
    pad_y = max(32, int((by1 - by0) * 0.25))
    x0 = (max(0, bx0 - pad_x) // 8) * 8
    y0 = (max(0, by0 - pad_y) // 8) * 8
    x1 = min(W, ((bx1 + pad_x) + 7) // 8 * 8)
    y1 = min(H, ((by1 + pad_y) + 7) // 8 * 8)
    w, h = x1 - x0, y1 - y0
    crop = orig.crop((x0, y0, x1, y1))
    mask_crop = mask.crop((x0, y0, x1, y1))
    red = Image.new("RGB", crop.size, (255, 0, 0))
    hl = Image.composite(red, crop, mask_crop)
    # 羽化：高斯模糊 + 电平拉伸（内部保持实色，边缘平滑过渡）
    radius = max(4, min(w, h) // 32)
    feathered = mask_crop.filter(ImageFilter.GaussianBlur(radius)).point(
        lambda v: max(0, min(255, int((v - 38) / 176 * 255))))
    tag = time.strftime("%Y%m%d-%H%M%S") + "_" + uuid.uuid4().hex[:6]
    hl_name = f"NeoAgent/_neo_local_hl_{tag}.png"
    mask_out_name = f"NeoAgent/_neo_local_mask_{tag}.png"
    os.makedirs(os.path.join(input_dir, "NeoAgent"), exist_ok=True)
    hl.save(os.path.join(input_dir, *hl_name.split("/")))
    feathered.save(os.path.join(input_dir, *mask_out_name.split("/")))
    # 编辑区放大到约 1MP 高分重绘（对齐参考工作流的 ImageScaleToTotalPixels）；32 对齐：
    # Qwen 编码器按 32 取整参考图尺寸并据此建空 latent，尺寸不整时高分裁剪图会被缩放、内容错位
    scale = (1e6 / (w * h)) ** 0.5
    w2 = max(64, int(w * scale + 0.5) // 32 * 32)
    h2 = max(64, int(h * scale + 0.5) // 32 * 32)
    return {"x": x0, "y": y0, "w": w, "h": h, "w2": w2, "h2": h2,
            "hl_name": hl_name, "mask_name": mask_out_name}


async def _sam3_segment(ref_name: str, points: list) -> str:
    """SAM3 点选分割（阻塞推理放线程池），返回 Input/NeoAgent 下的遮罩文件名。"""
    from . import sam3_seg
    return await asyncio.get_running_loop().run_in_executor(
        None, sam3_seg.segment_points, ref_name, points)


def resolve_request(body: dict, settings: dict | None = None, max_refs: int = 1) -> dict:
    """把一次生图请求解析成模板参数（占位符取值）；非法时抛 ValueError（消息可直接回前端）。

    max_refs：保留的参考图张数上限（默认 1）；多参考技能（如 Qwen Image 2.1
    分镜）传更大值，超出部分截断并提示。"""
    body = body if isinstance(body, dict) else {}
    settings = settings or get_settings()
    merged = dict(settings)
    for key in _OVERRIDE_KEYS:
        if body.get(key) is not None:
            merged[key] = body[key]

    prompt_text = str(body.get("prompt") or "").strip()
    if not prompt_text:
        raise ValueError("提示词为空")

    model, err = resolve_model("diffusion_models", merged.get("model"))
    if err:
        raise ValueError(err)
    encoder, err = resolve_model("text_encoders", merged.get("text_encoder"))
    if err:
        raise ValueError(err)
    vae, err = resolve_model("vae", merged.get("vae"))
    if err:
        raise ValueError(err)

    warnings = []
    loras, lora_warns = _resolve_loras(merged)
    warnings.extend(lora_warns)

    refs = body.get("references")
    refs = refs if isinstance(refs, list) else ([refs] if refs else [])
    # 局部编辑：第二张参考是涂抹遮罩（kind=data），不作为模型参考图
    local_edit_on = bool(body.get("local_edit"))
    mask_src = None
    if local_edit_on and len(refs) >= 2:
        mask_src, refs = refs[1], refs[:1]
    names = []
    for src in refs:
        name = _reference_name(src)
        if name and name not in names:
            names.append(name)
    if refs and not names:
        raise ValueError("参考图无法读取，请确认图片仍然存在")
    if len(names) > max_refs:
        warnings.append("只使用第一张参考图" if max_refs == 1 else f"只使用前 {max_refs} 张参考图")
        names = names[:max_refs]
    # 少图技能（如 ControlNet：第 1 张内容、第 2 张姿势）：张数不足时模板会渲染出缺输入的图，这里先拦住
    min_refs = _int(merged.get("min_refs"), 0)
    if min_refs and len(names) < min_refs:
        raise ValueError(f"该技能需要至少 {min_refs} 张参考图")
    # 控制图（config.json 的 control_ref 指定第几张）只进模型补丁：Fun ControlNet 由补丁自己
    # VAE 编码它。它不能同时占编码器参考槽，否则编码器把姿势照片当内容参考直接复刻。
    control_ref = _int(merged.get("control_ref"), 0)
    control_image = None
    if control_ref and len(names) >= control_ref:
        control_image = names[control_ref - 1]
        names = names[:control_ref - 1] + names[control_ref:]
    ref_name = names[0] if names else None

    # 扩图：四边留白像素 + 目标总像素（MP）；None = 未开扩图模式
    outpaint = _parse_outpaint(body.get("outpaint"))
    if outpaint and not ref_name:
        raise ValueError("扩图需要参考图，请添加参考图后再生成")

    # 高分局部编辑：解码遮罩、自动定位编辑区并落盘高亮裁剪图/羽化遮罩
    local_edit = None
    if local_edit_on:
        if not ref_name:
            raise ValueError("局部编辑需要参考图")
        if not mask_src:
            raise ValueError("局部编辑需要涂抹区域（遮罩）")
        local_edit = _prepare_local_edit(ref_name, mask_src)

    count = max(1, min(MAX_IMAGES, _int(body.get("count"), _int(merged.get("count"), 1))))
    width, height = resolve_dimensions(merged, ratio=body.get("ratio"),
                                       width=body.get("width"), height=body.get("height"))
    # 采样步数：本次请求（节点入参/接口）> skill config.json > 默认 20
    steps = max(1, _int(merged.get("steps"), 20))
    # 分辨率选择器（{{ASPECT_RATIO}} / {{MEGAPIXELS}}）的取值：比例取本次请求或技能默认比例，
    # 百万像素由输出尺寸反算（夹在节点 0.1~16 的合法区间里）
    ratio_wh = ratio_pair(body.get("ratio")) or ratio_pair(merged.get("default_ratio"))

    ref_scale = None
    src_size = None
    if ref_name:
        # 参考图长边限到 1024px（VAE encode + Qwen3-VL 接地的输入尺度），两侧取 8 的倍数
        src_size = _reference_size(ref_name)
        if src_size and min(src_size) > 0:
            scale = 1024 / max(src_size)
            ref_scale = (max(8, int(src_size[0] * scale + 0.5)) // 8 * 8,
                         max(8, int(src_size[1] * scale + 0.5)) // 8 * 8)
        else:
            ref_scale = (1024, 1024)
    # 画布尺寸（模板里参考图缩放节点的目标）：无参考图时为 None → 该节点被裁
    canvas = _edit_canvas_size(src_size, width, height)

    seed = body.get("seed")
    seed = random.randint(0, 2**63 - 1) if seed is None else max(0, _int(seed, 0))

    prefix = safe_prefix(merged.get("output_prefix") or DEFAULT_SETTINGS["output_prefix"])
    if not prefix:
        prefix = DEFAULT_SETTINGS["output_prefix"]
    slug = slug_from_text(prompt_text)
    prefix = f"{prefix}/{time.strftime('%Y-%m-%d')}"
    if slug:
        prefix = f"{prefix}/{slug}"

    return {
        "prompt": prompt_text,
        "negative": str(body.get("negative") or "").strip(),
        "model": model,
        "text_encoder": encoder,
        "vae": vae,
        "loras": loras,
        "seed": seed,
        "count": count,
        "width": width,
        "height": height,
        "steps": steps,
        "ref_name": ref_name,
        "ref_images": names,
        "control_image": control_image,
        "ref_scale": ref_scale if ref_name else None,
        "canvas": canvas,
        "outpaint": outpaint,
        "local_edit": local_edit,
        "target_mp": _float(merged.get("target_megapixels"), DEFAULT_SETTINGS["target_megapixels"]),
        "aspect_ratio": f"{ratio_wh[0]:g}:{ratio_wh[1]:g}" if ratio_wh else "",
        "megapixels": min(16.0, max(0.1, round(width * height / (1024 * 1024), 2))),
        "prefix": prefix,
        "warnings": warnings,
    }


# ===========================================================================
# 模板渲染（workflow.json 占位符替换 + LoRA 槽位 / 动态注入）
# ===========================================================================

_PLACEHOLDER_TOKENS = ("{{PROMPT}}", "{{NEGATIVE}}", "{{SEED}}", "{{STEPS}}", "{{WIDTH}}", "{{HEIGHT}}",
                       "{{LENGTH}}", "{{COUNT}}", "{{PREFIX}}", "{{MODEL}}", "{{TEXT_ENCODER}}", "{{VAE}}",
                       "{{AUDIO_VAE}}", "{{REF_IMAGE}}", "{{REF_IMAGE_LAST}}", "{{CONTROL_IMAGE}}", "{{REF_WIDTH}}", "{{REF_HEIGHT}}",
                       "{{CANVAS_WIDTH}}", "{{CANVAS_HEIGHT}}", "{{OUTPAINT_REF_MP}}", "{{TARGET_MP}}",
                       "{{MEGAPIXELS}}", "{{ASPECT_RATIO}}",
                       "{{PAD_LEFT}}", "{{PAD_TOP}}", "{{PAD_RIGHT}}", "{{PAD_BOTTOM}}")

# 单帧占位符（首帧 {{REF_IMAGE}} / 尾帧 {{REF_IMAGE_LAST}}）：未挂该帧时整值判未填，
# 所在 LoadImage 节点会被裁掉 —— 首尾帧技能因此可只给一边（仅首帧=I2VA、仅尾帧=L2VA）。
_FRAME_TOKENS = {"{{REF_IMAGE}}": "ref_name", "{{REF_IMAGE_LAST}}": "ref_last"}
# 需要参考图的判定只看单帧占位符：多路槽位（{{REF_IMAGE_n}}）未挂时裁掉即可，
# 0 张参考对「文生图 + 可选参考」模板（如 Qwen Image 2.1）是合法路径。
_SINGLE_REF_TOKEN_RE = re.compile(r"\{\{REF_IMAGE(_LAST)?\}\}")

# 多路参考槽位占位符：{{REF_IMAGE_1..n}} / {{REF_VIDEO_1..n}} / {{REF_AUDIO_1..n}}。
# 序号按媒体类型各自 1 基编号，列表由调用方按目标节点上限裁好（H3 为 9 图 / 3 视频 / 3 音频）。
# 未提供对应序号时该值判为「未填」，render_template 会把所在节点连同连线一起裁掉。
_REF_SLOT_RE = re.compile(r"^\{\{REF_(IMAGE|VIDEO|AUDIO)_(\d+)\}\}$")
_REF_SLOT_KEYS = {"IMAGE": "ref_images", "VIDEO": "ref_videos", "AUDIO": "ref_audios"}
_UNFILLED = object()


def _typed_value(token: str, params: dict):
    """占位符对应的类型化取值（尺寸/种子/张数是 int，其余是 str）。"""
    if token == "{{PROMPT}}":
        return params["prompt"]
    if token == "{{NEGATIVE}}":
        return params["negative"]
    if token == "{{SEED}}":
        return params["seed"]
    if token == "{{STEPS}}":
        return params["steps"]
    if token == "{{WIDTH}}":
        return params["width"]
    if token == "{{HEIGHT}}":
        return params["height"]
    if token == "{{LENGTH}}":
        return params["length"]
    if token == "{{COUNT}}":
        return params["count"]
    # 分辨率选择器（ResolutionSelector）的两个 widget：百万像素按本次输出尺寸算，
    # 比例必须落进 combo 认得的那几个 label，落不进去就是技能比例不合法（不是渲染 bug）
    if token == "{{MEGAPIXELS}}":
        megapixels = params.get("megapixels")
        if not megapixels:
            raise ValueError("技能模板的 {{MEGAPIXELS}} 需要输出尺寸才能填值")
        return megapixels
    if token == "{{ASPECT_RATIO}}":
        label = ASPECT_LABELS.get(str(params.get("aspect_ratio") or "").strip())
        if not label:
            raise ValueError("技能模板的 {{ASPECT_RATIO}} 只支持 %s 这些比例，当前比例 %s 不在其中"
                             % (" / ".join(sorted(ASPECT_LABELS)), params.get("aspect_ratio") or "未设置"))
        return label
    if token == "{{PREFIX}}":
        return params["prefix"]
    if token == "{{MODEL}}":
        return params["model"]
    if token == "{{TEXT_ENCODER}}":
        return params["text_encoder"]
    if token == "{{VAE}}":
        return params["vae"]
    if token == "{{AUDIO_VAE}}":
        return params["audio_vae"]
    if token == "{{REF_IMAGE}}":
        return params["ref_name"]
    if token == "{{REF_IMAGE_LAST}}":
        return params.get("ref_last")
    if token == "{{CONTROL_IMAGE}}":
        return params.get("control_image") or _UNFILLED
    scale = params.get("ref_scale") or (0, 0)
    if token == "{{REF_WIDTH}}":
        return scale[0]
    if token == "{{REF_HEIGHT}}":
        return scale[1]
    # 画布尺寸（模板里参考图缩放节点的目标）：无参考图时为未填 → 该节点被剪掉
    canvas = params.get("canvas")
    if token == "{{CANVAS_WIDTH}}":
        return canvas[0] if canvas else _UNFILLED
    if token == "{{CANVAS_HEIGHT}}":
        return canvas[1] if canvas else _UNFILLED
    # 扩图链（模板里 1MP 归一化 → 补灰边 → 目标像素归一化）：没开扩图 / 没参考图时不填 → 整链被裁
    if token in _PAD_TOKENS or token in ("{{OUTPAINT_REF_MP}}", "{{TARGET_MP}}"):
        outpaint = params.get("outpaint") if params.get("ref_name") else None
        if not outpaint:
            return _UNFILLED
        if token == "{{OUTPAINT_REF_MP}}":
            return OUTPAINT_REF_MP
        if token == "{{TARGET_MP}}":
            return outpaint.get("total_pixels") or params["target_mp"]
        return outpaint[_PAD_TOKENS[token]]
    raise ValueError(f"未知占位符 {token}")


def _substitute_value(value: str, params: dict):
    """替换字符串值里的占位符；整值恰好是单个占位符时直接取类型化值（保持 int 等原类型）。

    整值是 {{REF_<MEDIA>_<n>}} 参考槽位且没有第 n 个参考时返回 _UNFILLED（该节点待裁）；
    整值是单帧占位符（{{REF_IMAGE}} / {{REF_IMAGE_LAST}}）且该帧未挂时同样返回 _UNFILLED。"""
    token = value.strip()
    if token in _FRAME_TOKENS:
        return params.get(_FRAME_TOKENS[token]) or _UNFILLED
    slot = _REF_SLOT_RE.match(token)
    if slot:
        names = params.get(_REF_SLOT_KEYS[slot.group(1)]) or []
        idx = int(slot.group(2)) - 1
        return names[idx] if 0 <= idx < len(names) else _UNFILLED
    tokens = [t for t in _PLACEHOLDER_TOKENS if t in value]
    if not tokens:
        return value
    token = value.strip()
    if token in tokens:
        return _typed_value(token, params)
    out = value
    for t in tokens:
        out = out.replace(t, str(_typed_value(t, params)))
    return out


_UNKNOWN_TOKEN_RE = re.compile(r"\{\{[A-Za-z0-9_]+\}\}")
# LoRA 槽位（{{LORA_i_NAME}} / {{LORA_i_STRENGTH}}）由 _apply_loras 负责填，不算未知占位符
_LORA_SLOT_TOKEN_RE = re.compile(r"^\{\{LORA_\d+_(?:NAME|STRENGTH)\}\}$")


def _reject_unknown_tokens(graph: dict) -> None:
    """模板里残留的 {{XXX}}：占位符名写错，或插件代码没重启（旧代码不认识新占位符）。

    静默提交的话，ComfyUI 只会报「could not convert string to float: '{{...}}'」，所以这里
    提前给出明确错误。只认 ASCII 名字的 token，模板里的中文正文不受影响。"""
    for m in _UNKNOWN_TOKEN_RE.finditer(json.dumps(graph, ensure_ascii=False)):
        if _LORA_SLOT_TOKEN_RE.match(m.group(0)):
            continue
        raise ValueError(f"技能模板里有未知占位符 {m.group(0)}：检查占位符名，"
                         f"或重启 ComfyUI（更新插件后旧代码不认识新占位符）")


def _node_sort_key(nid):
    try:
        return (0, int(str(nid)), "")
    except (TypeError, ValueError):
        return (1, 0, str(nid))


def _model_consumer(graph: dict, src_id: str):
    """model 输入连到 src 输出的 LoraLoaderModelOnly 节点 id；无则 None。"""
    best = None
    for nid, node in graph.items():
        if not isinstance(node, dict) or node.get("class_type") != "LoraLoaderModelOnly":
            continue
        v = (node.get("inputs") or {}).get("model")
        if isinstance(v, list) and len(v) == 2 and v[0] == str(src_id):
            if best is None or _node_sort_key(nid) < _node_sort_key(best):
                best = nid
    return best


def _any_model_consumer(graph: dict, src_id: str):
    """model 输入连到 src 输出的任意节点 id（取排序最前）；无则 None。"""
    best = None
    for nid, node in graph.items():
        if nid == src_id or not isinstance(node, dict):
            continue
        v = (node.get("inputs") or {}).get("model")
        if isinstance(v, list) and len(v) == 2 and v[0] == str(src_id):
            if best is None or _node_sort_key(nid) < _node_sort_key(best):
                best = nid
    return best


def _apply_loras(graph: dict, loras: list, warnings: list):
    """填模板 {{LORA_i_*}} 槽位；超出槽位的 LoRA 在主链末端动态插入 LoraLoaderModelOnly。"""
    slot_re = re.compile(r"^\{\{LORA_(\d+)_NAME\}\}$")
    slots = {}
    for nid, node in graph.items():
        if not isinstance(node, dict) or node.get("class_type") != "LoraLoaderModelOnly":
            continue
        m = slot_re.match(str((node.get("inputs") or {}).get("lora_name", "")))
        if m:
            slots[int(m.group(1))] = nid
    ordered = [slots[i] for i in sorted(slots)]

    for entry, nid in zip(loras, ordered):
        node = graph[nid]
        node["inputs"]["lora_name"] = entry["name"]
        node["inputs"]["strength_model"] = entry["strength"]

    # 空槽（LoRA 比槽位少）：保留槽位可加载 —— strength 0 + loras 目录兜底文件
    for nid in ordered[len(loras):]:
        fallbacks = _folder_files("loras")
        if not fallbacks:
            raise ValueError(f"模板有 {len(ordered)} 个 LoRA 槽位但只配置了 {len(loras)} 个，且 loras 目录里没有可兜底的文件")
        node = graph[nid]
        node["inputs"]["lora_name"] = fallbacks[0]
        node["inputs"]["strength_model"] = 0.0

    # 多余 LoRA（比槽位多）：主链末端之后动态串联插入
    if len(loras) <= len(ordered):
        return
    if ordered:
        anchor = ordered[-1]
    else:
        unets = [nid for nid, n in graph.items()
                 if isinstance(n, dict) and n.get("class_type") == "UNETLoader"]
        if not unets:
            warnings.append(f"找不到 LoRA 注入点（模板没有 UNETLoader），跳过 {len(loras)} 个 LoRA")
            return
        anchor = sorted(unets, key=_node_sort_key)[0]
        while True:  # 模板手写过非槽位 LoRA 链时，锚点推到链尾
            nxt = _model_consumer(graph, anchor)
            if not nxt:
                break
            anchor = nxt
    consumer = _any_model_consumer(graph, anchor)
    if consumer is None:
        warnings.append(f"找不到 LoRA 注入点的下游节点（节点 {anchor}），跳过多余 LoRA")
        return
    try:
        max_id = max(int(nid) for nid in graph if str(nid).isdigit())
    except ValueError:
        max_id = 0
    prev = anchor
    for i, entry in enumerate(loras[len(ordered):], start=1):
        nid = str(max_id + i)
        graph[nid] = {"class_type": "LoraLoaderModelOnly",
                      "inputs": {"model": [str(prev), 0], "lora_name": entry["name"],
                                 "strength_model": entry["strength"]}}
        prev = nid
    graph[consumer]["inputs"]["model"] = [prev, 0]


def _prune_unfilled(graph: dict, unfilled: set) -> None:
    """裁掉未填参考槽位的节点链：先删该节点，再删指向它们的连线；
    只剩连线、被裁空的中间节点（如参考视频的 GetVideoComponents）随之递归裁掉。"""
    dead = set(unfilled)
    while dead:
        for nid in dead:
            graph.pop(nid, None)
        dead = set()
        for nid, node in list(graph.items()):
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs")
            if not inputs:
                continue
            for key, value in list(inputs.items()):
                if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and value[0] not in graph:
                    del inputs[key]   # 上游已被裁掉：这条连线一并去掉
            if not inputs:
                dead.add(nid)         # 纯连线节点被裁空 → 该中转节点也失效


_AUTOGROW_SLOT_KEY_RE = re.compile(r"^([a-z_]+)\.([a-z_]+)_(\d+)$")
_REF_SLOT_LIMIT = 17   # Autogrow 名字数上限（TextEncodeQwenImage21 的 images.image_1..17）

# Autogrow 槽位词干 → 参考列表键；参考加载节点 → 写素材名的 widget
_SLOT_STEMS = {"image": "ref_images", "ref_image": "ref_images",
               "video": "ref_videos", "ref_video": "ref_videos",
               "audio": "ref_audios", "ref_audio": "ref_audios"}
_LOADER_WIDGETS = {"LoadImage": "image", "LoadVideo": "file", "LoadAudio": "audio"}


def _slot_groups(graph: dict, nid: str) -> dict:
    """节点自身的 Autogrow 参考输入：槽位词干 -> {槽序号: 输入键名}。"""
    groups = {}
    for key in (graph[nid].get("inputs") or {}):
        m = _AUTOGROW_SLOT_KEY_RE.match(key)
        if m and m.group(2) in _SLOT_STEMS:
            groups.setdefault(m.group(2), {})[int(m.group(3))] = key
    return groups


def _ref_slot_chain(graph: dict, start_id: str):
    """槽位上游的独占参考链：加载节点（LoadImage/LoadVideo/LoadAudio）→ 只喂它一家的中间节点，止于槽位直连源。

    上游不是加载节点（链头多入口 / 非参考源）时返回 None，该槽不作为克隆原型。"""
    head = start_id
    while graph.get(head, {}).get("class_type") not in _LOADER_WIDGETS:
        links = [v[0] for v in (graph.get(head, {}).get("inputs") or {}).values()
                 if isinstance(v, list) and len(v) == 2]
        if len(links) != 1:
            return None
        head = links[0]
    chain = [head]
    cur = head
    while cur != start_id:
        consumers = [nid for nid, node in graph.items()
                     if isinstance(node, dict)
                     for v in (node.get("inputs") or {}).values()
                     if isinstance(v, list) and len(v) == 2 and v[0] == cur]
        if len(consumers) != 1:
            return None
        cur = consumers[0]
        chain.append(cur)
    return chain


def _expand_ref_slots(graph: dict, params: dict) -> None:
    """参考数超过模板已有槽位时，克隆最高已有槽的链补到 Autogrow 的 prefix.stem_k。

    模板只写演示用的前几槽，容量由 config.json 的 max_refs 声明（resolve_request 已按它截断）。
    槽基址取模板已有最小序号：Qwen 1 基（image_1），minimax 0 基（ref_image_0）。"""
    next_id = max((int(nid) for nid in graph if str(nid).isdigit()), default=0) + 1
    for nid in list(graph):
        if not isinstance(graph[nid], dict):
            continue
        for stem, keys in _slot_groups(graph, nid).items():
            names = params.get(_SLOT_STEMS[stem]) or []
            if len(names) <= len(keys):
                continue
            top_key = keys[max(keys)]
            src = (graph[nid].get("inputs") or {}).get(top_key)
            if not (isinstance(src, list) and len(src) == 2 and src[0] in graph):
                continue
            chain = _ref_slot_chain(graph, src[0])
            if not chain:
                continue
            base = min(keys)
            prefix = top_key.rsplit(".", 1)[0]
            for i in range(base + len(keys), base + min(len(names), _REF_SLOT_LIMIT)):
                new_ids = [str(next_id + j) for j in range(len(chain))]
                next_id += len(chain)
                mapping = dict(zip(chain, new_ids))
                for old, new in mapping.items():
                    node = copy.deepcopy(graph[old])
                    for key, value in list(node["inputs"].items()):
                        if isinstance(value, list) and len(value) == 2 and value[0] in mapping:
                            node["inputs"][key] = [mapping[value[0]], value[1]]
                    graph[new] = node
                head = graph[new_ids[0]]
                head["inputs"][_LOADER_WIDGETS[head["class_type"]]] = names[i - base]
                graph[nid]["inputs"][f"{prefix}.{stem}_{i}"] = [mapping[src[0]], 0]


def _next_graph_id(graph: dict) -> str:
    try:
        return str(max(int(nid) for nid in graph if str(nid).isdigit()) + 1)
    except ValueError:
        return "9999"


def _drop_unused_empty_latent(graph: dict) -> None:
    """移除不再被任何节点引用的 EmptyLatentImage（尺寸改由编码器空 latent 决定）。"""
    for nid, node in list(graph.items()):
        if isinstance(node, dict) and node.get("class_type") == "EmptyLatentImage" and not any(
                isinstance(v, list) and len(v) == 2 and v[0] == str(nid)
                for m in graph.values() if isinstance(m, dict)
                for v in (m.get("inputs") or {}).values()):
            graph.pop(nid)


def _apply_local_edit(graph: dict, local: dict) -> None:
    """高分局部编辑图变换（Qwen Image 2.1）：首张参考图换成红色高亮裁剪图并放大到高分；
    解码后缩回裁剪尺寸，按羽化遮罩原位合并回原图。"""
    te_id = next((nid for nid, n in sorted(graph.items(), key=lambda kv: _node_sort_key(kv[0]))
                 if isinstance(n, dict) and n.get("class_type") == "TextEncodeQwenImage21"), None)
    if te_id is None:
        raise ValueError("该技能不支持局部编辑（模板没有 Qwen Image 2.1 编码器）")
    te = graph[te_id]
    src = (te.get("inputs") or {}).get("images.image_1")
    if not (isinstance(src, list) and len(src) == 2 and src[0] in graph):
        raise ValueError("局部编辑需要参考图，请添加参考图后再生成")
    decode_id = next((nid for nid, n in sorted(graph.items(), key=lambda kv: _node_sort_key(kv[0]))
                      if isinstance(n, dict) and n.get("class_type") == "VAEDecode"), None)
    save_id = next((nid for nid, n in sorted(graph.items(), key=lambda kv: _node_sort_key(kv[0]))
                    if isinstance(n, dict) and n.get("class_type") == "SaveImage"), None)
    if decode_id is None or save_id is None:
        raise ValueError("该技能不支持局部编辑（模板没有解码/保存节点）")
    hl_id = _next_graph_id(graph)
    graph[hl_id] = {"class_type": "LoadImage", "inputs": {"image": local["hl_name"]}}
    up_id = _next_graph_id(graph)
    graph[up_id] = {"class_type": "ImageScale",
                    "inputs": {"image": [hl_id, 0], "upscale_method": "lanczos",
                               "width": local["w2"], "height": local["h2"], "crop": "disabled"}}
    te["inputs"]["images.image_1"] = [up_id, 0]
    te["inputs"]["resolution"] = 0   # 保持裁剪高分尺寸（画布=编辑区）
    sampler_id = next((nid for nid, n in sorted(graph.items(), key=lambda kv: _node_sort_key(kv[0]))
                       if isinstance(n, dict) and n.get("class_type") == "KSampler"), None)
    if sampler_id is not None:
        graph[sampler_id]["inputs"]["latent_image"] = [te_id, 2]
    mask_id = _next_graph_id(graph)
    graph[mask_id] = {"class_type": "LoadImageMask", "inputs": {"image": local["mask_name"], "channel": "red"}}
    down_id = _next_graph_id(graph)
    graph[down_id] = {"class_type": "ImageScale",
                      "inputs": {"image": [decode_id, 0], "upscale_method": "lanczos",
                                 "width": local["w"], "height": local["h"], "crop": "disabled"}}
    comp_id = _next_graph_id(graph)
    graph[comp_id] = {"class_type": "ImageCompositeMasked",
                      "inputs": {"destination": [str(src[0]), int(src[1])], "source": [down_id, 0],
                                 "x": local["x"], "y": local["y"], "resize_source": False,
                                 "mask": [mask_id, 0]}}
    graph[save_id]["inputs"]["images"] = [comp_id, 0]
    _drop_unused_empty_latent(graph)


def render_template(template: dict, params: dict) -> tuple[dict, list]:
    """把 workflow.json 模板渲染成可提交队列的 API prompt。返回 (graph, warnings)。

    模板用 {{REF_IMAGE}}（单路首帧）或 {{REF_IMAGE_n}} / {{REF_VIDEO_n}} / {{REF_AUDIO_n}}
    声明参考槽位；未提供对应序号的槽位整条裁掉，参考图张数超过模板槽位时按
    config.json 的 max_refs 克隆槽链补齐 Autogrow 输入。"""
    text = json.dumps(template, ensure_ascii=False)
    if _SINGLE_REF_TOKEN_RE.search(text) and not (
            params.get("ref_images") or params.get("ref_name") or params.get("ref_last")):
        raise ValueError("该技能需要参考图，请添加参考图后再生成")
    graph = copy.deepcopy(template)
    unfilled = set()
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        for key, value in list(inputs.items()):
            if isinstance(value, str) and "{{" in value:
                resolved = _substitute_value(value, params)
                if resolved is _UNFILLED:
                    unfilled.add(nid)
                    break
                inputs[key] = resolved
    if unfilled:
        _prune_unfilled(graph, unfilled)
    _expand_ref_slots(graph, params)
    warnings = []
    _apply_loras(graph, params.get("loras") or [], warnings)
    if params.get("local_edit"):
        _apply_local_edit(graph, params["local_edit"])
    _reject_unknown_tokens(graph)
    return graph, warnings


# ===========================================================================
# 队列提交 / 状态查询（复用 ComfyUI 排队、显存与取消行为）
# ===========================================================================

POLL_INTERVAL = 0.5   # 轮询间隔（秒）
TASK_TIMEOUT = 3600.0  # 单个任务最长等待（秒）


def _is_tls() -> bool:
    return bool(getattr(cli_args, "tls_keyfile", None) and getattr(cli_args, "tls_certfile", None))


def _api_url(path: str) -> str:
    hosts = [h for h in str(cli_args.listen or "").split(",") if h and h not in ("0.0.0.0", "::")]
    host = hosts[0] if hosts else "127.0.0.1"
    return f"{'https' if _is_tls() else 'http'}://{host}:{cli_args.port}{path}"


def _prompt_queue():
    return PromptServer.instance.prompt_queue


async def submit_graph(graph: dict) -> str:
    """把图压进执行队列，返回 prompt_id；校验失败时抛 ValueError。"""
    url = _api_url("/prompt")
    # TLS 模式下服务端多为自签证书，跳过校验（只是本机内部回环调用）
    connector = aiohttp.TCPConnector(ssl=False) if _is_tls() else None
    body = {"prompt": graph, "client_id": CLIENT_ID}
    # 按 prompt 指定预览方法：CLI 默认 none（不生成任何预览图），本插件实时预览依赖它；
    # 用户未显式配置 --preview-method 时用 latent2rgb（内置 latent→RGB 映射，无需额外 vae_approx 模型）
    if cli_args.preview_method is LatentPreviewMethod.NoPreviews:
        body["extra_data"] = {"preview_method": "latent2rgb"}
    try:
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.post(url, json=body, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                payload = await resp.json()
                if resp.status == 200:
                    return payload["prompt_id"]
    except (aiohttp.ClientError, KeyError, json.JSONDecodeError) as e:
        raise ValueError(f"生图队列不可用: {e}") from e
    error = payload.get("error") or {}
    if isinstance(error, dict):
        message = " ".join(str(x) for x in (error.get("message"), error.get("details")) if x)
    else:
        message = str(error)
    raise ValueError(message or "工作流校验失败")


def _lookup(prompt_id: str) -> tuple:
    """返回 (state, info)：state 为 queued/running/done，info 为 history 条目或 None。"""
    queue = _prompt_queue()
    history = queue.get_history(prompt_id=prompt_id) or {}
    item = history.get(prompt_id)
    if item is not None:
        return "done", item
    running, pending = queue.get_current_queue_volatile()
    for entry in running:
        if entry[1] == prompt_id:
            return "running", None
    for entry in pending:
        if entry[1] == prompt_id:
            return "queued", None
    return "unknown", None


def _progress_for(prompt_id: str):
    """采样节点步数进度 {value, max}；registry 不属于本 prompt 或无步数信息时返回 None。"""
    registry = get_progress_state()
    if getattr(registry, "prompt_id", "") != prompt_id:
        return None
    best_max = 0.0
    best_value = 0.0
    for entry in registry.nodes.values():
        mx = float(entry.get("max") or 0)
        if mx <= 1:
            continue
        if mx > best_max:
            best_max, best_value = mx, float(entry.get("value") or 0)
    if best_max <= 1:
        return None
    return {"value": int(best_value), "max": int(best_max)}


def _error_from_history(item: dict) -> tuple:
    """返回 (错误文本, 是否被取消)。"""
    status = item.get("status") or {}
    if status.get("completed"):
        return "", False
    for message in status.get("messages") or []:
        if not (isinstance(message, (list, tuple)) and len(message) == 2):
            continue
        event = message[0]
        data = message[1] if isinstance(message[1], dict) else {}
        if event == "execution_interrupted":
            return "任务已取消", True
        if event == "execution_error":
            text = str(data.get("exception_message") or "").strip()
            node = data.get("node_id")
            if text:
                return (f"{text}（节点 {node}/{data.get('node_type')}）" if node else text), False
    return "执行失败", False


def _collect_images(item: dict) -> list:
    """取 history 里 SaveImage 落盘的图片，附带 /view 访问地址。"""
    output_root = os.path.realpath(folder_paths.get_output_directory())
    results = []
    for outputs in (item.get("outputs") or {}).values():
        for entry in (outputs or {}).get("images", []):
            subfolder = str(entry.get("subfolder") or "")
            filename = str(entry.get("filename") or "")
            if not filename:
                continue
            real = os.path.realpath(os.path.join(output_root, *subfolder.split("/"), filename))
            if not _within(real, output_root) or not os.path.isfile(real):
                continue
            results.append({"path": real, "subfolder": subfolder, "filename": filename,
                            "url": (f"/view?filename={quote(filename)}"
                                    f"&subfolder={quote(subfolder)}&type=output")})
    return results


def _sidecar_path(image_path: str) -> str:
    return os.path.splitext(image_path)[0] + ".txt"


def write_sidecar(image_path: str, params: dict) -> None:
    """图片旁写同名 .txt：首行提示词、次行参数摘要（Gallery 直接读前两行）。"""
    path = _sidecar_path(image_path)
    if os.path.exists(path):
        return
    loras = ",".join(f"{l['name']}@{l['strength']}" for l in params.get("loras") or [])
    meta = (f"seed={params['seed']} {params['width']}x{params['height']} "
            f"model={params['model']}" + (f" loras={loras}" if loras else ""))
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"{params['prompt']}\n{meta}\n")
    except OSError as e:
        logger.warning(f"image_gen: sidecar write failed: {e}")


# ===========================================================================
# 任务表（进程内，TTL 清理；只存小记录不存图）
# ===========================================================================

TASKS: dict = {}
_WATCHERS: dict = {}

# 每个 prompt 的最新采样预览图（data URL）：由进度 handler 捕获，随任务快照推送；终态清空
_PREVIEWS: dict = {}


def _preview_data_url(image) -> str | None:
    """ComfyUI 推来的预览图元组 ("JPEG"/"PNG", PIL.Image, max_res) 编码为 data URL。"""
    try:
        fmt, pil_image, _max_res = image
        buf = io.BytesIO()
        pil_image.save(buf, format=fmt, quality=95, compress_level=1)
        mime = "image/png" if fmt == "PNG" else "image/jpeg"
        return f"data:{mime};base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


class _PreviewCapture(ProgressHandler):
    """捕获每步预览图（与节点实时预览同源）；只留活跃任务的最新一张。"""

    def __init__(self):
        super().__init__("neo_image_gen_preview")

    def update_handler(self, node_id, value, max_value, state, prompt_id, image=None):
        if image is None:
            return
        url = _preview_data_url(image)
        if url is None:
            return
        # 本回调跑在执行线程上，提交与清理任务在事件循环线程上原地增删 TASKS；
        # 直接遍历 TASKS.values() 会撞出 "dictionary changed size during iteration"，先取快照。
        for task in list(TASKS.values()):
            if task["prompt_id"] == prompt_id and task["status"] in ("queued", "running"):
                _PREVIEWS[prompt_id] = url
                return


_PREVIEW_CAPTURE = _PreviewCapture()
add_progress_handler(_PREVIEW_CAPTURE)


def _ensure_preview_handler() -> None:
    """核心 reset_progress_state 每次 prompt 执行都新建空 registry，import 时注册的 handler 会被丢弃；轮询 tick 上补注册。

    轮询 tick 在事件循环线程上，执行线程在 start_progress / update_progress 里遍历
    registry.handlers.values()；add_progress_handler 原地插入就撞出
    "dictionary changed size during iteration"，节点执行直接失败。
    所以整块换新 dict：遍历方手里的旧 dict 全程不变，核心 register_handler 的插入
    落在当时的当前 dict 上，webui handler 不会被挤掉。
    """
    registry = get_progress_state()
    if _PREVIEW_CAPTURE.name in registry.handlers:
        return
    handlers = registry.handlers.copy()  # dict.copy 是 GIL 内的单次 C 调用，不会撞上执行线程的原地插入
    handlers[_PREVIEW_CAPTURE.name] = _PREVIEW_CAPTURE
    registry.handlers = handlers


def _public_image(entry: dict) -> dict:
    return {"filename": entry["filename"], "subfolder": entry["subfolder"], "url": entry["url"]}


def _snapshot(task: dict) -> dict:
    return {
        "task_id": task["task_id"],
        "prompt_id": task["prompt_id"],
        "status": task["status"],
        "created": task["created"],
        "updated": task["updated"],
        "prompt": task["params"]["prompt"],
        "mode": "redraw" if task["params"]["ref_name"] else "t2i",
        "width": task["params"]["width"],
        "height": task["params"]["height"],
        # 送进编码器的参考画布尺寸（模板里的 ImageScale 目标）；无参考图时为 None
        "canvas": task["params"].get("canvas"),
        "model": task["params"]["model"],
        "seed": task["params"]["seed"],
        "images": [_public_image(e) for e in task["images"]],
        "progress": task.get("progress"),
        "preview": task.get("preview"),
        "error": task["error"],
        "warnings": task.get("warnings") or [],
    }


def _prune_tasks() -> None:
    now = time.time()
    for task_id, task in list(TASKS.items()):
        if task["status"] in ("queued", "running"):
            continue
        if now - task["updated"] > TASK_TTL:
            TASKS.pop(task_id, None)
            _PREVIEWS.pop(task["prompt_id"], None)
    while len(TASKS) > MAX_TASKS:
        oldest = min((t for t in TASKS.values() if t["status"] not in ("queued", "running")),
                     key=lambda t: t["updated"], default=None)
        if oldest is None:
            break
        TASKS.pop(oldest["task_id"], None)
        _PREVIEWS.pop(oldest["prompt_id"], None)


def _notify(task: dict) -> None:
    """任务快照有变化时经 WebSocket 推给所有客户端（前端按 task_id 过滤）。"""
    PromptServer.instance.send_sync(STATUS_EVENT, _snapshot(task))


def _finish(task: dict, status: str, images: list, error: str) -> None:
    task["status"] = status
    task["images"] = images
    task["error"] = error
    task["progress"] = None
    task["preview"] = None
    _PREVIEWS.pop(task["prompt_id"], None)
    task["updated"] = time.time()
    _WATCHERS.pop(task["task_id"], None)
    if error:
        logger.warning(f"image_gen task {task['task_id']} failed: {error}")
    _notify(task)


async def _watch(task_id: str) -> None:
    prompt_id = TASKS[task_id]["prompt_id"]
    deadline = time.monotonic() + TASK_TIMEOUT
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        task = TASKS.get(task_id)
        if task is None or task["status"] not in ("queued", "running"):
            return
        _ensure_preview_handler()
        state, item = _lookup(prompt_id)
        if state == "done":
            error, cancelled = _error_from_history(item)
            images = _collect_images(item)
            for entry in images:
                write_sidecar(entry["path"], task["params"])
            status = "cancelled" if cancelled else ("failed" if error else "succeeded")
            _finish(task, status, images, error)
            return
        if state == "running":
            changed = task["status"] != "running"
            task["status"] = "running"
            prog = _progress_for(prompt_id)
            if prog is not None and task.get("progress") != prog:
                task["progress"] = prog
                changed = True
            url = _PREVIEWS.get(prompt_id)
            if url is not None and task.get("preview") != url:
                task["preview"] = url
                changed = True
            task["updated"] = time.time()
            if changed:
                _notify(task)
        elif time.monotonic() > deadline:
            _finish(task, "failed", [], "等待生图超时，任务已不在队列中")
            return


_ENHANCE_DEFAULT_SYSTEM_PROMPT = (
    "You are a professional image generation prompt enhancer. "
    "Given a user's brief description and target resolution, expand it into a rich, detailed visual description "
    "suitable for a high-quality text-to-image model. Preserve all elements the user stated; add details about "
    "lighting, composition, style, texture, color palette, and atmosphere. "
    "Output ONLY the enhanced description in the same language as the input, no explanations or prefixes."
)


def _enhance_system_prompt(skill_id: str, prompt_text: str) -> str:
    """带 workflow.json 的技能由工作流驱动，正文只作帮助文档 → 增强用内置默认；其余技能用正文作扩写指令。"""
    if skill_id:
        from . import skill as _skill
        try:
            if _skill.load_skill_workflow(skill_id) is None:
                language = _skill._resolve_skill_language(prompt_text)
                body = (_skill.load_skill_content(skill_id, language=language) or "").strip()
                if body:
                    return body
        except Exception:
            pass
    return _ENHANCE_DEFAULT_SYSTEM_PROMPT


async def _enhance_prompt(prompt_text: str, width: int, height: int, skill_id: str = "") -> str:
    """调用 LLM 增强生图提示词；用技能 skill.md 正文作为系统提示词，缺失时用内置默认；失败时返回原文。"""
    from . import llm as _llm

    sys_prompt = _enhance_system_prompt(skill_id, prompt_text)

    user_msg = f"Target resolution: {width}x{height}\nUser prompt: {prompt_text}"
    try:
        result = await asyncio.get_running_loop().run_in_executor(
            None, lambda: _llm.chat_turn([
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_msg},
            ], max_tokens=1024)
        )
        enhanced = str(result.get("content") or "").strip()
        if not enhanced:
            return prompt_text
        return enhanced
    except Exception as e:
        logger.warning(f"prompt enhancement failed, using original: {e}")
        return prompt_text


def _enhance_prompt_stream(prompt_text: str, width: int, height: int, skill_id: str = "") -> Generator[str, None, None]:
    """流式增强生图提示词，逐 chunk yield 文本；失败时 yield '[ERROR] ...'。"""
    from . import llm as _llm

    sys_prompt = _enhance_system_prompt(skill_id, prompt_text)

    user_msg = f"Target resolution: {width}x{height}\nUser prompt: {prompt_text}"
    try:
        result = _llm._run_llm_inference(
            sys_prompt, user_msg, 1024,
            use_remote=(_llm.get_current_mode() == _llm.LLM_MODE_REMOTE), stream=True)
        if hasattr(result, '__iter__') and not isinstance(result, str):
            for chunk in result:
                if isinstance(chunk, dict):
                    if "text" in chunk:
                        # 远程生成器：{"text","kind"}；只取正文，跳过思考（thinking）
                        if chunk.get("kind") != "thinking":
                            yield chunk["text"]
                        continue
                    choices = chunk.get("choices", [])
                    if choices:
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                elif isinstance(chunk, str) and chunk:
                    yield chunk
        else:
            # 本地路径未返回生成器（不支持流式）：回退为整段输出
            yield result or prompt_text
    except Exception as e:
        logger.warning(f"prompt enhancement stream failed: {e}")
        yield f"[ERROR] {str(e)}"


async def start_generation(body: dict) -> dict:
    """按所选技能的 workflow.json 模板渲染并提交生图任务。"""
    from . import skill as _skill

    body = dict(body or {})
    skill_id = str(body.get("skill_id") or "").strip()
    if not skill_id:
        raise ValueError("请先在技能下拉里选择一个生图技能（带工作流模板）")
    template = _skill.load_skill_workflow(skill_id)
    if template is None:
        raise ValueError(f"技能 {skill_id} 没有工作流模板（workflow.json），"
                         f"可在技能下拉的「保存当前工作流」里从画布导出一个")
    # 扩图仅支持 Qwen Image 2.1 模板；扩图模式提示词为空时填默认触发词
    if isinstance(body.get("outpaint"), dict):
        if not template_supports_outpaint(template):
            raise ValueError("该技能不支持扩图，请切换到 Qwen Image 2.1 扩图后重试")
        if not str(body.get("prompt") or "").strip():
            body["prompt"] = OUTPAINT_DEFAULT_PROMPT

    # 局部编辑仅支持 Qwen Image 2.1 模板；提示词追加红色区域约束
    if body.get("local_edit"):
        if not template_is_qwen21(template):
            raise ValueError("该技能不支持局部编辑，请切换到 Qwen Image 2.1 高分局部编辑后重试")
        p = str(body.get("prompt") or "").strip()
        if "red" not in p.lower():
            body["prompt"] = (p + " " + LOCAL_EDIT_PROMPT_SUFFIX).strip()

    settings = get_settings()
    cfg = _skill.get_skill_gen_config(skill_id)
    for key, value in cfg.items():
        if key in _SKILL_SETTING_KEYS and value not in (None, "", []):
            settings[key] = value

    # Qwen Image 2.1 的 latent 一格 = 32px（VAE 16x 下采样 + 2x2 patchify）：目标尺寸必须 32 对齐，
    # 否则模型要自己补/裁一格 → 出图尺寸和内容一起偏（参考工作流的 ResolutionSelector 用 multiple=32）。
    # 显式宽高先对齐（避免 resolve_dimensions 先对到 16：1000→1008→再对 32 变成 1024，多偏一格），
    # 比例/设置默认值那条路再兜一次。
    if template_is_qwen21(template):
        w, h = _int(body.get("width"), 0), _int(body.get("height"), 0)
        if w > 0 and h > 0:
            body["width"], body["height"] = _round_multiple(w, 32), _round_multiple(h, 32)

    # 点选删除：SAM3 点选分割 → 遮罩，走局部编辑管线（标红裁剪 + 羽化合并）；
    # 空提示词填默认删除指令，非空用户提示词原样使用（VLM 描述仅用于可选预填建议）
    remove_points = _parse_remove_points(body.get("remove_points"))
    if remove_points:
        refs = body.get("references")
        refs = refs if isinstance(refs, list) else ([refs] if refs else [])
        ref_name = _reference_name(refs[0]) if refs else None
        if not ref_name:
            raise ValueError("点选删除需要原图（参考图）")
        mask_name = await _sam3_segment(ref_name, remove_points)
        body["local_edit"] = True
        body["references"] = refs + [{"kind": "input", "value": mask_name}]
        if not str(body.get("prompt") or "").strip():
            body["prompt"] = REMOVE_DEFAULT_PROMPT

    params = resolve_request(body or {}, settings, max_refs=template_max_refs(template, settings))
    if template_is_qwen21(template):
        params["width"] = _round_multiple(params["width"], 32)
        params["height"] = _round_multiple(params["height"], 32)
    if settings.get("enhance_prompt") and not (body or {}).get("skip_enhance") and not remove_points:
        params["prompt"] = await _enhance_prompt(
            params["prompt"], params["width"], params["height"], skill_id)
    graph, template_warns = render_template(template, params)
    params["warnings"].extend(template_warns)
    prompt_id = await submit_graph(graph)
    _prune_tasks()
    now = time.time()
    task = {
        "task_id": str(uuid.uuid4()),
        "prompt_id": prompt_id,
        "status": "queued",
        "created": now,
        "updated": now,
        "params": params,
        "images": [],
        "progress": None,
        "preview": None,
        "error": "",
        "warnings": list(params.get("warnings") or []),
    }
    TASKS[task["task_id"]] = task
    _WATCHERS[task["task_id"]] = asyncio.create_task(_watch(task["task_id"]))
    return _snapshot(task)


# ===========================================================================
# 路由
# ===========================================================================

routes = PromptServer.instance.routes


@routes.post("/neo_image_gen/generate")
async def generate_route(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    try:
        return web.json_response(await start_generation(body))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        logger.error(f"image_gen generate failed: {e}")
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/neo_image_gen/segment_points")
async def segment_points_route(request):
    """点选删除预览：原图 + 点击坐标走 SAM3 点提示分割，返回遮罩文件名（前端叠加到原图上做所见即所得预览）。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    ref_name = str((body or {}).get("image") or "").strip().replace("\\", "/")
    try:
        points = _parse_remove_points((body or {}).get("points"))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    if not ref_name or not points:
        return web.json_response({"error": "需要原图与标记点"}, status=400)
    input_dir = os.path.abspath(folder_paths.get_input_directory())
    full = os.path.abspath(os.path.join(input_dir, *ref_name.split("/")))
    if not full.startswith(input_dir + os.sep) or not os.path.isfile(full):
        return web.json_response({"error": "原图无法读取"}, status=400)
    try:
        mask_name = await _sam3_segment(ref_name, points)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"mask": mask_name})


@routes.post("/neo_image_gen/enhance")
async def enhance_route(request):
    """SSE 流式增强提示词：前端先调此端点拿到增强后的 prompt，再提交 generate。"""
    try:
        body = await request.json()
    except Exception:
        return web.Response(text="data: [ERROR] bad json\n\ndata: [DONE]\n\n", content_type="text/event-stream")

    skill_id = str((body or {}).get("skill_id") or "").strip()
    prompt_text = str((body or {}).get("prompt") or "").strip()
    if not prompt_text:
        return web.Response(text="data: [DONE]\n\n", content_type="text/event-stream")

    settings = get_settings()
    if skill_id:
        from . import skill as _skill
        cfg = _skill.get_skill_gen_config(skill_id)
        for key, value in cfg.items():
            if key in DEFAULT_SETTINGS and value not in (None, "", []):
                settings[key] = value

    # 用 resolve_request 拿到 width/height（与 generate 路径一致）
    try:
        params = resolve_request(body or {}, settings)
        width, height = params["width"], params["height"]
    except Exception:
        width = int(settings.get("image_width", 1024))
        height = int(settings.get("image_height", 1024))

    async def event_stream():
        loop = asyncio.get_running_loop()
        gen = _enhance_prompt_stream(prompt_text, width, height, skill_id)

        def next_chunk():
            try:
                return next(gen)
            except StopIteration:
                return None

        while True:
            chunk = await loop.run_in_executor(None, next_chunk)
            if chunk is None:
                break
            yield ("data: " + json.dumps({"text": chunk}) + "\n\n").encode()
        yield b"data: [DONE]\n\n"

    return web.Response(
        body=event_stream(),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@routes.get("/neo_image_gen/status/{task_id}")
async def status_route(request):
    task = TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"error": "任务不存在"}, status=404)
    return web.json_response(_snapshot(task))


@routes.get("/neo_image_gen/tasks")
async def tasks_route(request):
    _prune_tasks()
    tasks = sorted(TASKS.values(), key=lambda t: t["created"], reverse=True)[:MAX_TASKS]
    return web.json_response([_snapshot(t) for t in tasks])


@routes.post("/neo_image_gen/cancel/{task_id}")
async def cancel_route(request):
    task = TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"error": "任务不存在"}, status=404)
    prompt_id = task["prompt_id"]
    queue = _prompt_queue()
    dequeued = queue.delete_queue_item(lambda entry: entry[1] == prompt_id)
    interrupted = queue.interrupt_if_running(prompt_id)
    task["status"] = "cancelled"
    task["updated"] = time.time()
    watcher = _WATCHERS.pop(task["task_id"], None)
    if watcher is not None:
        watcher.cancel()
    _notify(task)
    return web.json_response({"dequeued": dequeued, "interrupted": interrupted})

