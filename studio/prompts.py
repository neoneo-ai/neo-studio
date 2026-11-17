# SPDX-License-Identifier: Apache-2.0
# Neo Studio - Prompts

from __future__ import annotations

import os
import json
import asyncio
import server
import torch
from aiohttp import web
import threading
import logging
import time
import base64
from typing import Optional
from server import PromptServer

from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

from . import skill
from .image_gen_files import resolve_image_bytes
from .llm import strip_inline_thinking
from .bundles import create_bundle

from .prompt_names import (PRESETS_DIR, CUSTOM_DIR,
                           tags_file_path, load_tags_index, sample_runtime_prompts)

PENDING_PROMPTS = {}

_tags_lock = threading.Lock()

# 从 llm 模块导入 LLM 相关功能
from .llm import (
    handle_llm_api_request,
    handle_llm_api_stream,
    unload_local_model,
    unload_native_model,
    get_remote_llm_config,
    set_remote_llm_config,
    get_current_mode,
    LLM_MODE_LOCAL,
    LLM_MODE_NATIVE,
    LLM_MODE_REMOTE,
    run_llm_task,
    LLM_TASKS,
    resolve_multi_result,
)


def _auto_unload_after_generate():
    """节点执行结束：当前模式对应开关开启时，卸载驻留的本地 / 原生模型。"""
    mode = get_current_mode()
    cfg = get_remote_llm_config()
    try:
        if mode == LLM_MODE_LOCAL and cfg.get("auto_unload_local", False):
            result = unload_local_model()
            logger.info(f"Auto-unloaded local model after auto-generate: {result}")
            print(f"[Neo Studio] Auto-unloaded local model: {result}")
        elif mode == LLM_MODE_NATIVE and cfg.get("auto_unload_native", False):
            unload_native_model()
            logger.info("Auto-unloaded native model after auto-generate")
            print("[Neo Studio] Auto-unloaded native model")
    except Exception as e:
        msg = f"Failed to auto-unload model: {e}"
        logger.warning(msg)
        print(f"[Neo Studio] {msg}")


def image_tensor_to_png(image: torch.Tensor) -> bytes | None:
    """将 ComfyUI IMAGE tensor ((1,H,W,3) float 0~1) 转为 PNG bytes（第一帧）。"""
    import io
    import numpy as np
    from PIL import Image

    try:
        arr = image[0].detach().cpu().numpy()
        arr = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"image_tensor_to_png: failed: {e}")
        return None


MAX_BUNDLE_REFERENCES = 9  # bundle 参考图上限，对齐官方 MiniMaxH3ReferenceToVideo.ref_images


def _bundle_references(image) -> list:
    """把连接的 image 张量按 batch 维逐帧编码成 H3/Krea2/Ref2V 可消费的 reference（data URI）列表；无图/失败返回空列表。

    单图 [1,H,W,C] → 1 个 reference；批量 [N,H,W,C] → N 个（超过上限只取前 MAX_BUNDLE_REFERENCES 张）。
    """
    if image is None or not isinstance(image, torch.Tensor) or image.dim() != 4:
        return []
    references = []
    for i in range(min(int(image.shape[0]), MAX_BUNDLE_REFERENCES)):
        png = image_tensor_to_png(image[i:i + 1])
        if not png:
            continue
        data_uri = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        references.append({"kind": "data", "data": data_uri})
    return references


# 前端采集的 @引用/本地上传参考图按节点 id 暂存（原始 src：data URI / input 引用），
# 供 get_prompt 出队创建 bundle 时合并进 references。只存轻量引用，TTL + 取出即删防泄漏。
_PENDING_BUNDLE_REFS = {}
_PENDING_BUNDLE_REFS_LOCK = threading.Lock()
_BUNDLE_REFS_TTL_SECONDS = 3600


def store_bundle_refs(node_id, refs) -> None:
    """暂存前端采集的参考图（@引用/本地上传），供 get_prompt 出队时合并进 bundle.references。

    node_id 与节点 hidden UNIQUE_ID 一致；refs 为 [{kind:"data",data:...}|{kind:"input",value:...}]。
    replace 语义：以当前 refs 整体覆盖该节点旧值（前端每次图片增删/清空都推送完整列表）；
    refs 为空列表表示清空该节点暂存。take_bundle_refs 取出一条后即删除（与最近一次生成绑定）。
    """
    key = str(node_id or "")
    if not key:
        return
    now = time.time()
    with _PENDING_BUNDLE_REFS_LOCK:
        for k in [k for k, (t, _) in _PENDING_BUNDLE_REFS.items() if now - t > _BUNDLE_REFS_TTL_SECONDS]:
            del _PENDING_BUNDLE_REFS[k]
        if refs:
            _PENDING_BUNDLE_REFS[key] = (now, list(refs))
        else:
            _PENDING_BUNDLE_REFS.pop(key, None)


def take_bundle_refs(node_id) -> list:
    """取出并清除暂存的参考图，转成 reference data URI 列表（与 _bundle_references 输出格式一致）。"""
    key = str(node_id or "")
    if not key:
        return []
    with _PENDING_BUNDLE_REFS_LOCK:
        entry = _PENDING_BUNDLE_REFS.pop(key, None)
    if not entry:
        return []
    refs = []
    for src in entry[1]:
        png = resolve_image_bytes(src)
        if png:
            refs.append({"kind": "data", "data": "data:image/png;base64," + base64.b64encode(png).decode("ascii")})
    return refs


@server.PromptServer.instance.routes.post("/rs_prompts/bundle_refs")
async def neo_store_bundle_refs(request):
    """前端图片增删时推送 @引用/本地上传参考图暂存（与点击生成解耦），出队合并进 bundle.references。"""
    data = await request.json()
    node_id = str(data.get("uid") or "")
    refs = data.get("refs") or []
    if node_id:
        store_bundle_refs(node_id, refs)
    return web.json_response({"success": True})


def _save_tags_index(index: dict, tags_file: str) -> None:
    """Save tags index to the dedicated tags file."""
    try:
        with open(tags_file, 'w', encoding='utf-8') as f:
            json.dump(index, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Error saving tags index to {tags_file}: {e}")


def _update_tags_index(prompt_name: str, tags: list[str] | None = None, source: str = "custom") -> None:
    """更新指定来源的标签索引"""
    tags_file = tags_file_path(source)
    with _tags_lock:
        index = load_tags_index(tags_file)
        if tags is None:
            index.pop(prompt_name, None)
        else:
            index[prompt_name] = tags
        _save_tags_index(index, tags_file)


# ==========================================
# Prompt Node Class
# ==========================================

class NeoPrompts:
    _encode_cache = {}
    _CACHE_MAX_SIZE = 50
    MIN_SIZE = (400, 300)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "用于把提示词编码成 conditioning 的 CLIP。"}),
                "text": ("STRING", {"multiline": True, "default": "", "hidden": True}),
                "disable_text_input": ("BOOLEAN", {"default": False, "hidden": True}),
                "auto_generate": ("BOOLEAN", {"default": False, "hidden": True}),
                "quick_input": ("STRING", {"default": "", "hidden": True}),
                "skill_id": ("STRING", {"default": "", "hidden": True}),
                "quick_input_used": ("BOOLEAN", {"default": False, "hidden": True}),
                "random_enabled": ("BOOLEAN", {"default": False, "hidden": True}),
                "random_count": ("INT", {"default": 1, "min": 1, "max": 16, "step": 1, "hidden": True}),
            },
            "optional": {
                "text_input": ("STRING", {"forceInput": True,
                                          "tooltip": "外部提示词接入：接上后忽略节点内文本框、自动增强与随机抽取。"}),
                "image": ("IMAGE", {"tooltip": "接图像时走图生文（反推提示词）流程，需同时开启自动生成。"}),
                "instance_uid": ("STRING", {"default": "", "hidden": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("CONDITIONING",  "STRING")
    RETURN_NAMES = ("POSITIVE",  "PROMPT")
    FUNCTION = "encode_prompts"
    CATEGORY = "Neo Studio"
    DESCRIPTION = "AI-powered text encoder supports save/select prompt, LLM-based prompt enhancement, translation, classification, title extraction, intelligent caching, and auto-generate."
    SEARCH_ALIASES = [
        "prompt encoder", "text encode", "clip text encode", "positive", "conditioning",
        "llm", "auto generate", "reverse prompt", "image to prompt", "random prompt",
        "提示词", "提示词编码", "文本编码", "提示词增强", "反推提示词", "图生文",
        "翻译", "分类", "标题", "随机提示词", "自动增强", "neo",
    ]
    OUTPUT_TOOLTIPS = (
        "编码后的正样本 conditioning，接采样器的 positive。",
        "本次实际使用的提示词文本（增强 / 随机 / 反推后的最终结果）。",
    )

    def encode_prompts(self, clip, disable_text_input=False, auto_generate=False, quick_input="",
                       text="", text_input=None, unique_id=None, instance_uid="", skill_id="", image=None,
                       quick_input_used=False, random_enabled=False, random_count=1):
        """Encode prompts with optional auto-generate support.
        
        Logic:
        1. If auto_generate is enabled and (quick_input or image) has content, call LLM synchronously (ignore existing text)
        2. If image is provided, use the reverse_prompt skill (image-to-prompt)
        3. Otherwise, combine text and quick_input (same as frontend logic)
        """
        logger.info(f"encode_prompts called: auto_generate={auto_generate}, text='{text[:50]}...', quick_input='{quick_input[:50]}...', text_input={text_input is not None}, image={image is not None}")
        
        # 运行时随机：每次执行从混合池抽 1 条替换当前文本（编码器单输出，数量固定 1）。
        # 清空 quick_input 使后续自动增强/指令拼装不会覆盖随机结果。
        if random_enabled and text_input is None:
            picked = sample_runtime_prompts(1)
            if picked:
                text = picked[0]
                quick_input = ""
                logger.info(f"Runtime random selected: {text[:60]}...")
                if instance_uid:
                    PromptServer.instance.send_sync("rs.prompt.update", {
                        "instance_uid": instance_uid,
                        "prompt": text,
                        "random_count": 1,
                    })
            else:
                logger.warning("Runtime random enabled but prompt pool is empty, keeping current text")
        
        # Generate synchronously only when auto_generate is enabled;
        # an image input then selects the image (reverse_prompt/template) flow.
        if auto_generate and (quick_input.strip() or image is not None) and text_input is None:
            logger.info(f"Auto-generate condition met, checking LLM mode...")
            current_mode = get_current_mode()
            logger.info(f"Current LLM mode: {current_mode}")
            try:
                image_bytes = image_tensor_to_png(image) if image is not None else None
                image_mode = image_bytes is not None
                if image_mode or current_mode == LLM_MODE_REMOTE:
                    # Use selected template as system prompt when available
                    task_name = "reverse_prompt" if image_mode else "smart_prompt"
                    system_prompt = None
                    template_max = None
                    skill_agent = False
                    if skill_id.strip():
                        if skill.load_skill_content(skill_id):
                            skill_agent = True
                            logger.info(f"Auto-generate using skill '{skill_id}' (agent)")
                        else:
                            logger.warning(f"Skill '{skill_id}' not found, falling back to {task_name}")
                    logger.info(f"Calling LLM with {task_name} task, quick_input: {quick_input[:100]}..., image: {image_mode}")
                    # Use stream generation for real-time update
                    from .llm import run_llm_task_stream
                    accumulated = ""
                    if skill_agent:
                        gen = skill.run_skill_agent_stream(skill_id, quick_input, images=[image_bytes] if image_mode else None)
                    else:
                        stream_kwargs = {"system_prompt": system_prompt, "max_tokens_override": template_max}
                        if image_mode:
                            stream_kwargs["images"] = [image_bytes]
                        gen = run_llm_task_stream(task_name, quick_input, **stream_kwargs)
                    for chunk in gen:
                        # run_llm_task_stream / run_skill_agent_stream：dict 带 kind，只累计正文（跳过思考）
                        if isinstance(chunk, dict):
                            if chunk.get("kind") == "thinking":
                                continue
                            text_chunk = chunk.get("text", "")
                        else:
                            text_chunk = chunk or ""
                        accumulated += text_chunk
                        # Send real-time update to frontend
                        if instance_uid:
                            PromptServer.instance.send_sync("rs.prompt.auto_generate_update", {
                                "instance_uid": instance_uid,
                                "prompt": accumulated,
                                "is_complete": False
                            })

                    if accumulated:
                        text = accumulated
                        logger.info(f"Auto-generated prompt: {accumulated[:100]}...")
                        # Send final update
                        if instance_uid:
                            PromptServer.instance.send_sync("rs.prompt.auto_generate_update", {
                                "instance_uid": instance_uid,
                                "prompt": accumulated,
                                "is_complete": True
                            })
                else:
                    logger.warning(f"Auto-generate only works in remote LLM mode, current mode: {current_mode}")
            except Exception as e:
                logger.error(f"Auto-generate failed: {e}")
                logger.exception(e)
        else:
            logger.info(f"Auto-generate condition not met: auto_generate={auto_generate}, quick_input_has_content={quick_input.strip()}, text_input_none={text_input is None}")
            # Combine text and quick_input (same logic as frontend)
            # quick_input 已作为生成指令被消费时不再拼入提示词
            if quick_input.strip() and not quick_input_used:
                if text.strip():
                    text = f"{text}\n\n---\n\n{quick_input}"
                else:
                    text = quick_input

        current_text = text
        if disable_text_input:
            effective_text_input = None
        else:
            effective_text_input = text_input

        if effective_text_input is not None:
            # EXTERNAL: use the connected text_input as the content to encode/output
            current_text = effective_text_input
        
        if effective_text_input is not None and instance_uid:
            PromptServer.instance.send_sync("rs.prompt.update", {
                "instance_uid": instance_uid,
                "prompt": current_text
            })
        
        cache_key = (current_text, id(clip))
        
        if cache_key in NeoPrompts._encode_cache:
            pos_cond, neg_cond = NeoPrompts._encode_cache[cache_key]
        else:
            tokens_pos = clip.tokenize(current_text)
            pos_cond = clip.encode_from_tokens_scheduled(tokens_pos)
            
            neg_cond = []
            for t in pos_cond:
                d = t[1].copy() if len(t) > 1 else {}
                if "pooled_output" in d and d["pooled_output"] is not None:
                    d["pooled_output"] = torch.zeros_like(d["pooled_output"])
                neg_cond.append((torch.zeros_like(t[0]), d))
            
            if len(NeoPrompts._encode_cache) >= NeoPrompts._CACHE_MAX_SIZE:
                NeoPrompts._encode_cache.clear()
            NeoPrompts._encode_cache[cache_key] = (pos_cond, neg_cond)

        # 节点执行结束：勾选自动卸载时释放本地/原生模型（手动 生成不走节点执行，不受影响）
        _auto_unload_after_generate()
        return {
            "ui": {"text": [current_text]},
            "result": (pos_cond, neg_cond, current_text)
        }

    @classmethod
    def IS_CHANGED(cls, auto_generate=False, quick_input="", image=None, random_enabled=False, **kwargs):
        # If auto_generate is enabled and (quick_input or image) has content, always re-execute
        if image is not None or (auto_generate and quick_input.strip()) or random_enabled:
            import time
            return time.time()  # Return unique value to force re-execution
        # Otherwise, never change (use cached result)
        return float("nan")


# ==========================================
# API Routes for Prompt Management
# ==========================================

@server.PromptServer.instance.routes.post("/rs_prompts/save_prompt")
async def rs_prompts_save_prompt(request):
    try:
        data = await request.json()
        name = str(data.get("name", "") or "")
        if not name.strip():
            return web.Response(status=400, text="Name required")
        resolved = _prompt_rel_name(name)
        if resolved is None:
            return web.Response(status=400, text="Invalid name")
        base_dir, rel = resolved

        # 构建文件路径：首段 video 落进 custom/video/（视频池），首段 presets 落进预设来源
        folder = os.path.join(base_dir, *rel.split("/")[:-1])
        stem = rel.split("/")[-1]
        filepath = os.path.join(folder, f"{stem}.txt")
        counter = 1
        while os.path.exists(filepath):
            filepath = os.path.join(folder, f"{stem}-{counter}.txt")
            counter += 1

        # 确保目录存在
        os.makedirs(folder, exist_ok=True)
        
        # 保存前清洗：去掉思考模型可能内联泄漏的 < think>/< /think> 标签及重复正文，
        # 避免把推理过程写进自定义提示词文件。
        text = strip_inline_thinking(data.get("text", ""))
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(text)
        
        # 确定来源：标签索引的键就是相对扫描名（视频条是 video/名字），与读侧 iter_prompt_names 同一命名
        source = "presets" if base_dir == PRESETS_DIR else "custom"
        _update_tags_index(rel, data.get("tags", []), source=source)
        
        return web.Response(status=200, text="OK")
    except Exception as e:
        logger.error(f"Error saving prompt: {e}")
        return web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/rs_prompts/delete_prompt")
async def rs_prompts_delete_prompt(request):
    try:
        data = await request.json()
        name = str(data.get("name") or "")
        if not name.strip():
            return web.Response(status=400, text="Name required")
        
        # 确定来源和基础目录：与保存同一套名字解析，首段 video 认视频池
        resolved = _prompt_rel_name(name)
        if resolved is None:
            return web.Response(status=400, text="Invalid name")
        base_dir, rel = resolved
        source = "presets" if base_dir == PRESETS_DIR else "custom"
        
        # 构建文件路径
        filepath = os.path.join(base_dir, *rel.split("/")) + ".txt"
        if os.path.exists(filepath):
            os.remove(filepath)
            _update_tags_index(rel, tags=None, source=source)
            return web.Response(status=200, text="OK")
        
        # 尝试在两个目录中查找
        for search_dir in [CUSTOM_DIR, PRESETS_DIR]:
            filepath = os.path.join(search_dir, *rel.split("/")) + ".txt"
            if os.path.exists(filepath):
                os.remove(filepath)
                s = "custom" if search_dir == CUSTOM_DIR else "presets"
                _update_tags_index(rel, tags=None, source=s)
                return web.Response(status=200, text="OK")
        
        return web.Response(status=404, text="Prompt not found")
    except Exception as e:
        logger.error(f"Error deleting prompt: {e}")
        return web.Response(status=500, text=str(e))


def _prompt_rel_name(name: str):
    """把请求里的名字收成 (来源目录, 相对扫描名)，清洗不出可用段时给 None

    斜杠只当目录分隔，每段只留字母数字与空格 / 下划线 / 连字符，清洗后为空的段（含 `..`）丢掉，
    名字因此永远落在来源目录内。相对扫描名与读侧 iter_prompt_names 的显示名同一命名：
    首段 video 那条就是视频池（is_video_prompt 同一判法），首段 presets 认预设来源。
    """
    segments = []
    for raw in (name or "").replace("\\", "/").split("/"):
        seg = "".join(c for c in raw.strip() if c.isalnum() or c in " _-").strip()
        if seg:
            segments.append(seg)
    if segments and segments[0] == "presets":
        segments = segments[1:]
        base_dir = PRESETS_DIR
    else:
        base_dir = CUSTOM_DIR
    if not segments:
        return None
    return base_dir, "/".join(segments)


# ==========================================
# API Routes Registration (LLM API)
# ==========================================

@server.PromptServer.instance.routes.post("/rs_prompts/extract_classify")
async def rs_prompts_extract_classify(request):
    """提示词分类：优先 LAYA（33ms），不可用时规则匹配，最后 fallback LLM。"""
    from aiohttp import web
    try:
        data = await request.json()
        text = (data.get("text") or "").strip()
        if not text:
            return web.json_response({"error": "text content is empty"}, status=400)

        # 1. 尝试 LAYA 快速分类
        from . import laya_router
        if laya_router.is_available():
            questions = {
                "classify": {
                    "type": "choice",
                    "instructions": "Which style category does this prompt belong to?",
                    "criteria": {
                        "唯美": "aesthetic, ethereal, dreamy, beautiful scenery, 唯美",
                        "特色": "unique, distinctive, special style, 特色",
                        "写实": "realistic, photorealistic, natural, 写实",
                        "古风": "ancient Chinese, classical, 古风, traditional Chinese",
                        "动漫": "anime, manga, cartoon, illustration, 动漫",
                        "油画": "oil painting, classical art, impressionist, 油画",
                        "室内": "indoor, interior, room, house, 室内",
                        "户外": "outdoor, landscape, nature, street, 户外",
                    },
                }
            }
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(None, lambda: laya_router.classify(text, questions))
            if result and "classify" in result:
                val = result["classify"].get("value", "")
                conf = result["classify"].get("confidence", 0)
                if val:
                    logger.info(f"extract_classify → LAYA: {val} (conf={conf:.2f})")
                    return web.json_response({"status": "success", "classify": val})
            logger.info("extract_classify → LAYA returned no result, fallback to rule")

        # 2. LAYA 不可用/无结果：关键词规则匹配
        rule_val = _rule_classify(text)
        if rule_val:
            logger.info(f"extract_classify → Rule: {rule_val}")
            return web.json_response({"status": "success", "classify": rule_val})

        # 3. 规则也没匹配到：fallback LLM
        logger.info("extract_classify → LLM fallback")
        return await handle_llm_api_request("extract_classify", request)
    except Exception as e:
        logger.error(f"Error in extract_classify: {e}")
        return web.json_response({"error": str(e)}, status=500)


# 分类关键词表（按优先级排列，先匹配先返回）
_CLASSIFY_RULES = [
    ("古风", ["古风", "水墨", "古典中国", "ancient chinese", "classical chinese", "traditional chinese", "唐宋", "汉服", "仙侠"]),
    ("动漫", ["动漫", "二次元", "anime", "manga", "cartoon", "illustration", "日系", "赛璐珞"]),
    ("油画", ["油画", "oil painting", "impressionist", "印象派", "古典油画", "renoir", "monet"]),
    ("唯美", ["唯美", "梦幻", "ethereal", "dreamy", "aesthetic", "仙气", "飘逸"]),
    ("写实", ["写实", "photorealistic", "realistic", "电影质感", "胶片", "35mm", "纪录片", "写实质感"]),
    ("室内", ["室内", "interior", "indoor", "房间", "客厅", "卧室", "书房"]),
    ("户外", ["户外", "outdoor", "landscape", "风景", "街拍", "自然光", "山间"]),
    ("特色", ["赛博朋克", "蒸汽波", "cyberpunk", "vaporwave", "超现实主义", "surreal", "特色"]),
]


def _rule_classify(text: str) -> Optional[str]:
    """关键词规则分类：返回第一个匹配的类别，无匹配返回 None。"""
    lower = text.lower()
    for category, keywords in _CLASSIFY_RULES:
        for kw in keywords:
            if kw.lower() in lower:
                return category
    return None

@server.PromptServer.instance.routes.post("/rs_prompts/translate_prompt")
async def rs_prompts_translate_prompt(request):
    return await handle_llm_api_request("translate_prompt", request)

@server.PromptServer.instance.routes.post("/rs_prompts/smart_prompt")
async def rs_prompts_smart_prompt(request):
    """智能提示词 - LLM 直接判断用户意图并生成/改写"""
    from aiohttp import web
    try:
        data = await request.json()
        text = data.get("text", "")  # 已拼接的提示词（前端拼接）
        skill_id = data.get("skillId", "")  # skill ID
        template = data.get("template", "")  # 可选的系统提示词内容（直接传递内容）

        logger.info(f"Smart prompt request: text='{text[:100]}...', skill_id='{skill_id}', template='{template[:100] if template else 'None'}...'")

        if not text or not text.strip():
            return web.json_response({"error": "text is required"}, status=400)

        from .llm import run_llm_task, get_current_mode, LLM_MODE_REMOTE

        # 确定系统提示词：优先使用 template 内容，其次按 skill_id 走代理循环
        system_prompt = None
        skill_agent = False
        if template and template.strip():
            # 直接提供了系统提示词内容
            system_prompt = template
            logger.info(f"Using direct template content (length: {len(system_prompt)})")
        elif skill_id:
            # 使用 skill id 走代理循环（按需读取引用 + 中英主文件互斥）
            if skill.load_skill_content(skill_id):
                skill_agent = True
                logger.info(f"Routing skill '{skill_id}' through agent runner")
            else:
                logger.warning(f"Skill '{skill_id}' not found or has no content")

        # run_in_executor：LLM 调用是同步阻塞的，直接跑会卡死事件循环
        loop = asyncio.get_running_loop()
        if skill_agent:
            try:
                answer = await loop.run_in_executor(
                    None, lambda: skill.run_skill_agent(skill_id, text))
                result_data = {"status": "success", "prompt": answer}
            except Exception as e:
                logger.error(f"Skill agent error for '{skill_id}': {e}")
                result_data = {"error": str(e)}
        elif system_prompt and system_prompt.strip():
            result_data = await loop.run_in_executor(
                None, lambda: run_llm_task("template_prompt", text, system_prompt=system_prompt))
        else:
            result_data = await loop.run_in_executor(
                None, lambda: run_llm_task("smart_prompt", text))
        
        if "error" in result_data:
            error_msg = result_data["error"]
            logger.warning(f"Smart prompt error: {error_msg}")
            
            # 如果是本地模式且模型未加载，提供有用的提示
            if get_current_mode() == LLM_MODE_LOCAL and ("LLM model not found" in error_msg or "Model not loaded" in error_msg):
                return web.json_response({
                    "error": f"Local model is not available. Please download the model first, or switch to remote API mode."
                }, status=422)
            
            # 如果是远程模式且配置不正确，提供有用的提示
            if get_current_mode() == LLM_MODE_REMOTE:
                return web.json_response({
                    "error": f"Remote API error: {error_msg}. Please check your remote_llm_config.json configuration."
                }, status=422)
            
            return web.json_response({"error": error_msg}, status=422)
        
        logger.info(f"Smart prompt response: result='{result_data.get('prompt', '')[:100]}...'")
        return web.json_response(result_data)
        
    except Exception as e:
        logger.error(f"Error handling smart prompt: {e}")
        logger.exception(e)
        return web.json_response({"error": str(e)}, status=500)


# ==========================================
# LAYA 轻量分类 API（智能 skill 选择）
# ==========================================

@server.PromptServer.instance.routes.post("/rs_prompts/classify_skill")
async def rs_prompts_classify_skill(request):
    """根据用户文本推荐最匹配的增强 skill（LAYA 33ms 分类）。

    请求: {"text": "用户描述"}
    响应: {"skill": "chinese_ancient_fantasy", "confidence": 0.91}
    LAYA 不可用时: {"skill": null}
    """
    try:
        data = await request.json()
        text = (data.get("text") or "").strip()
        if not text:
            return web.json_response({"skill": None})

        from . import laya_router
        if not laya_router.is_available():
            return web.json_response({"skill": None})

        # 从 scan_skills() 筛选 image_enhance 类候选
        all_skills = skill.scan_skills()
        candidates = [s for s in all_skills if s.get("category") == "image_enhance"]
        if not candidates:
            return web.json_response({"skill": None})

        # 构造 LAYA choice questions：每个 skill 的 criteria 用 cn_name + tags + description
        criteria = {}
        for s in candidates:
            parts = [s.get("cn_name") or s["id"]]
            if s.get("tags"):
                parts.append(", ".join(s["tags"][:4]))
            if s.get("description"):
                parts.append(s["description"][:60])
            criteria[s["id"]] = " - ".join(parts)

        questions = {
            "skill": {
                "type": "choice",
                "instructions": "Which prompt enhancement style best matches this image description?",
                "criteria": criteria,
            }
        }

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, lambda: laya_router.classify(text, questions))

        if result and "skill" in result:
            val = result["skill"]
            skill_id = val.get("value", "")
            conf = val.get("confidence", 0.0)
            # 验证返回的 skill_id 确实在候选列表中
            if skill_id in criteria:
                logger.info(f"classify_skill → LAYA: {skill_id} (conf={conf:.2f})")
                return web.json_response({"skill": skill_id, "confidence": conf})

        logger.info("classify_skill → no match")
        return web.json_response({"skill": None})
    except Exception as e:
        logger.error(f"Error in classify_skill: {e}")
        return web.json_response({"skill": None})


# 中文反推系统提示词：明确中文质量词示例，避免 skill.md 默认英文版里的英文质量词把输出带成英文
_REVERSE_PROMPT_ZH_SYSTEM = (
    "你是一个专业的图像反推提示词助手。请仔细观察给定的图像，反推出用于生成该图像的文生图提示词。要求：\n"
    "1. 分析图像中的主体、场景、风格、光影、构图、材质、氛围等所有视觉元素\n"
    "2. 使用中文生成详细的提示词，包含中文质量词（如：杰作、最佳画质、高分辨率、细节丰富、8k 等）\n"
    "3. 提示词应适合文生图模型使用\n"
    "4. 仅返回提示词内容，不要包含任何解释、说明、前言或后缀文字\n"
    "5. 不要说'好的'、'这是反推的提示词'等任何多余内容，直接输出提示词本身"
)


def _reverse_system_prompt(language):
    """按语言返回反推系统提示词：中文用明确中文版（含中文质量词），英文沿用 skill.md 默认。"""
    if language == "en":
        return LLM_TASKS["reverse_prompt"]["system"]
    return _REVERSE_PROMPT_ZH_SYSTEM


def _reverse_sse_frame(obj):
    return ("data: " + json.dumps(obj) + "\n\n").encode()


def _reverse_sse_error(msg):
    return web.Response(text=f"data: [ERROR] {msg}\n\n" + "data: [DONE]\n\n",
                        content_type="text/event-stream")


async def _reverse_llm_stream(gen, txt_path, lang_path, language, lang_marker):
    """LLM 生成器 → SSE 正文帧 → 落盘同名旁车；模型跑空与链路异常都写成 [ERROR] 帧，不给空结果框。"""
    accumulated = ""
    try:
        loop = asyncio.get_running_loop()

        def next_chunk():
            try:
                return next(gen)
            except StopIteration:
                return None

        while True:
            chunk = await loop.run_in_executor(None, next_chunk)
            if chunk is None:
                break
            text = chunk.get("text", "") if isinstance(chunk, dict) else str(chunk)
            kind = chunk.get("kind", "content") if isinstance(chunk, dict) else "content"
            if kind == "thinking":
                continue
            accumulated += text
            yield _reverse_sse_frame({"text": text, "kind": "content"})

        prompt_text = accumulated.strip()
        if not prompt_text:
            yield b"data: [ERROR] Failed to generate prompt\n\n"
            yield b"data: [DONE]\n\n"
            return
        # 旁车与语言标记一起落：标记对不上（换语言 / 视频换了帧数）就跳过缓存重新反推
        txt_path.write_text(prompt_text, encoding="utf-8")
        lang_path.write_text(lang_marker, encoding="utf-8")
        logger.info(f"Reverse prompt saved to: {txt_path} (lang={lang_marker})")
        yield _reverse_sse_frame({"meta": {"status": "success", "txt_file": txt_path.name, "language": language}})
        yield b"data: [DONE]\n\n"
    except Exception as e:
        logger.error(f"Reverse prompt stream error: {e}")
        yield (f"data: [ERROR] {str(e)}\n\n").encode()
        yield b"data: [DONE]\n\n"


def _reverse_cache_hit(txt_path, lang_path, language, signature=None):
    """同名 .txt 存在且记录标记与请求一致时返回缓存文本，否则返回 None（需重新反推）。

    signature 是图片以外那一发特有的输入（视频用它 = 帧数）：标进 .rp-lang 后换输入就失效。
    不传（图片那条）标记就是语言本身，旧缓存文件的读法一字不变。
    """
    if not txt_path.exists():
        return None
    cached = txt_path.read_text(encoding="utf-8").strip()
    if not cached:
        return None
    expected = language if signature is None else f"{language}|{signature}"
    cached_lang = lang_path.read_text(encoding="utf-8").strip() if lang_path.exists() else None
    return cached if cached_lang == expected else None


@server.PromptServer.instance.routes.post("/rs_prompts/reverse_prompt")
async def rs_prompts_reverse_prompt(request):
    """从图像反推提示词并流式返回，结果保存为同名 .txt 文件"""
    from aiohttp import web
    from pathlib import Path

    try:
        data = await request.json()
        filename = data.get("filename", "")
        subfolder = data.get("subfolder", "presets")
        language = str(data.get("language", "zh")).strip().lower()
        if language not in ("zh", "en"):
            language = "zh"

        if not filename:
            return _reverse_sse_error("filename is required")

        # 用共享的媒体查找器定位图像（覆盖 presets/custom/输入输出/宫格/角色等全部来源）
        from .gallery import _find_source_media
        image_path = _find_source_media(filename, subfolder)
        if image_path is None or not image_path.exists():
            return _reverse_sse_error("Image not found")

        txt_path = image_path.with_suffix(".txt")
        lang_path = image_path.with_suffix(".rp-lang")

        # 同名 .txt 已存在且语言匹配时直接返回缓存，避免重复调用 LLM；
        # 切换语言（或旧缓存无语言标记）则跳过缓存强制重新反推。
        cached_prompt = _reverse_cache_hit(txt_path, lang_path, language)
        if cached_prompt is not None:
            logger.info(f"Reverse prompt cache hit: {txt_path} (lang={language})")

            async def cached_stream():
                yield _reverse_sse_frame({"text": cached_prompt, "kind": "content"})
                yield _reverse_sse_frame({"meta": {"status": "success", "txt_file": txt_path.name, "language": language}})
                yield b"data: [DONE]\n\n"

            return web.Response(body=cached_stream(), content_type="text/event-stream",
                                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

        # 读取图像，如果过大则缩放到最长边 1024px
        MAX_REVERSE_SIDE = 1024
        image_bytes: bytes = b""
        try:
            from PIL import Image
            import io
            with Image.open(image_path) as img:
                w, h = img.size
                if max(w, h) > MAX_REVERSE_SIDE:
                    ratio = MAX_REVERSE_SIDE / max(w, h)
                    new_w = int(w * ratio)
                    new_h = int(h * ratio)
                    img_resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                    buf = io.BytesIO()
                    img_resized.save(buf, format=img.format or "PNG")
                    image_bytes = buf.getvalue()
                else:
                    with open(image_path, "rb") as f:
                        image_bytes = f.read()
        except Exception as resize_err:
            logger.warning(f"Failed to resize image, using original: {resize_err}")
            with open(image_path, "rb") as f:
                image_bytes = f.read()

        # 按语言选择系统提示词：中文用明确中文版，英文沿用 skill.md 默认
        system_prompt = _reverse_system_prompt(language)
        from .llm import run_llm_task_stream
        gen = run_llm_task_stream("reverse_prompt", "", images=[image_bytes], system_prompt=system_prompt)

        return web.Response(body=_reverse_llm_stream(gen, txt_path, lang_path, language, language),
                            content_type="text/event-stream",
                            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    except Exception as e:
        logger.error(f"Error handling reverse prompt: {e}")
        logger.exception(e)
        return _reverse_sse_error(str(e))


# ==========================================
# Video Reverse Prompt (视频反推提示词 / 多帧)
# ==========================================

# 一发最多喂几帧：canvas 出的是 PNG，12 帧 @768px 编码后约 3MB，稳在桌面端自服务的
# 请求体上限内（app/studio_server.py 按 frames.MAX_BODY_BYTES 装配请求体）
REVERSE_VIDEO_MAX_FRAMES = 12

# 中文视频反推系统提示词：明确中文质量词，理由与图像那条同——skill.md 的默认英文版会把中文输出带成英文
_REVERSE_VIDEO_ZH_SYSTEM = (
    "你是专业的视频反推提示词助手。用户给出来自同一条视频、按时间顺序排列的若干帧，"
    "每一帧都带它在片中的时间戳。把这些帧还原成一段能生成这条视频的提示词。要求："
    "1. 把帧当成一段在动的镜头来读：主体、场景、风格、光线、色调、氛围写成一段连贯的话，不要逐帧罗列；"
    "2. 从帧与帧的变化判断运镜：推、拉、摇、移、跟、升降、手持、航拍、固定机位，以及镜头之间的切换节奏；"
    "3. 用时间戳说清动作发生在片中的哪一段：前段发生什么、后段发生什么；"
    "4. 使用中文生成提示词，附带中文视频质量词（如：电影感、运镜流畅、细节丰富、高画质、稳定画面等），"
    "适用于文生视频与文生图模型；"
    "5. 只返回提示词本身，不要解释，不要前后缀，不要分帧描述。"
)


@server.PromptServer.instance.routes.post("/rs_prompts/reverse_video_prompt")
async def rs_prompts_reverse_video_prompt(request):
    """从一条视频的抽帧序列反推提示词并流式返回，结果写进视频同名的 .rp.txt"""
    from aiohttp import web

    try:
        data = await request.json()
        filename = data.get("filename", "")
        subfolder = data.get("subfolder", "")
        language = str(data.get("language", "zh")).strip().lower()
        if language not in ("zh", "en"):
            language = "zh"

        if not filename:
            return _reverse_sse_error("filename is required")

        from .gallery import _find_source_media
        video_path = _find_source_media(filename, subfolder)
        if video_path is None or not video_path.exists():
            return _reverse_sse_error("Video not found")
        from .util import VIDEO_EXTENSIONS
        if video_path.suffix.lower() not in VIDEO_EXTENSIONS:
            return _reverse_sse_error(f"视频反推只吃视频：{video_path.suffix}")

        frames = _decode_reverse_frames(data.get("frames"))
        if not frames:
            return _reverse_sse_error("没有收到帧：先到抽帧页抽一批，或在本页抽帧")
        if len(frames) > REVERSE_VIDEO_MAX_FRAMES:
            return _reverse_sse_error(f"一次最多 {REVERSE_VIDEO_MAX_FRAMES} 帧")
        # 原生引擎的视觉编码器一次只吃第一张图（docs/llm.md），多帧发过去只有首帧被看见
        if get_current_mode() == LLM_MODE_NATIVE and len(frames) > 1:
            return _reverse_sse_error("原生引擎只吃第一帧：把帧数调到 1，或改用远程视觉模型")

        # 视频同名 .txt 是「视频再来一发」读进去的生效参数旁车（studio/gallery.py 的 _read_sidecar），
        # 反推结果只能落 .rp.txt —— 落 .txt 等于一发把用户的生成参数覆盖掉
        txt_path = video_path.with_suffix(".rp.txt")
        lang_path = video_path.with_suffix(".rp-lang")
        marker = f"{language}|{len(frames)}"

        # 缓存按「语言 + 帧数」失效：帧数换了就是换了一次采样，旧结果不再对得上这一发
        cached_prompt = _reverse_cache_hit(txt_path, lang_path, language, signature=len(frames))
        if cached_prompt is not None:
            logger.info(f"Reverse video prompt cache hit: {txt_path} (lang={marker})")

            async def cached_stream():
                yield _reverse_sse_frame({"text": cached_prompt, "kind": "content"})
                yield _reverse_sse_frame({"meta": {"status": "success", "txt_file": txt_path.name, "language": language}})
                yield b"data: [DONE]\n\n"

            return web.Response(body=cached_stream(), content_type="text/event-stream",
                                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

        duration = data.get("range", {}).get("duration") if isinstance(data.get("range"), dict) else None
        user_text = _reverse_video_user_text(frames, language, duration)
        from .llm import run_llm_task_stream
        gen = run_llm_task_stream("video_reverse_prompt", user_text,
                                  images=[blob for _, blob in frames],
                                  system_prompt=_reverse_video_system_prompt(language))

        return web.Response(body=_reverse_llm_stream(gen, txt_path, lang_path, language, marker),
                            content_type="text/event-stream",
                            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    except Exception as e:
        logger.error(f"Error handling video reverse prompt: {e}")
        logger.exception(e)
        return _reverse_sse_error(str(e))


def _reverse_video_system_prompt(language: str) -> str:
    """按语言返回视频反推系统提示词：中文用明确中文版（带运镜与时间戳读法），英文沿用 skill.md 默认。"""
    if language == "en":
        return LLM_TASKS["video_reverse_prompt"]["system"]
    return _REVERSE_VIDEO_ZH_SYSTEM


def _reverse_video_frame_stamp(sec) -> str:
    """秒 → mm:ss.mmm：与抽帧页 frameStamp 同一套标签，模型看到的与用户在页面上看到的是同一个时间。"""
    ms = int(round(float(sec) * 1000))
    return f"{ms // 60000:02d}:{(ms // 1000) % 60:02d}.{ms % 1000:03d}"


def _decode_reverse_frames(raw):
    """前端抽好的帧 [{t, data}] → [(秒, PNG 字节)]。data 收裸 base64，也收 canvas 的 data URI 前缀。"""
    frames = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        data = str(item.get("data", ""))
        if data.startswith("data:"):
            data = data.partition(",")[2]
        try:
            blob = base64.b64decode(data)
        except (ValueError, TypeError):
            continue
        if blob:
            frames.append((float(item.get("t") or 0), blob))
    return frames


def _reverse_video_user_text(frames, language, duration=None):
    """帧标签进正文：不带时间戳的多张图在模型眼里就是互不相关的画面，写不出运镜、节奏与先后。"""
    if language == "en":
        labels = ", ".join(f"frame {i + 1} at {_reverse_video_frame_stamp(t)}"
                           for i, (t, _) in enumerate(frames))
        text = f"These frames come from one video, in time order: {labels}."
        if duration:
            text += f" The full video is {_reverse_video_frame_stamp(duration)} long."
        return text
    labels = "、".join(f"帧{i + 1}@{_reverse_video_frame_stamp(t)}"
                       for i, (t, _) in enumerate(frames))
    text = f"以下 {len(frames)} 帧取自同一条视频，按时间顺序：{labels}。"
    if duration:
        text += f"整片时长 {_reverse_video_frame_stamp(duration)}。"
    return text


# ==========================================
# Stream LLM API Routes (SSE)
# ==========================================

@server.PromptServer.instance.routes.post("/rs_prompts/stream_{task_name}")
async def rs_prompts_stream_llm_api_request(request):
    """流式 LLM API 请求（SSE）"""
    task_name = request.match_info["task_name"]
    return await handle_llm_api_stream(task_name, request)


# ==========================================
# NeoPromptAgent Node Class
# A simple prompt generator node with settings button only
# ==========================================

class NeoPromptAgent:
    """
    A simple prompt generator node that outputs text only.
    - No clip input required
    - Supports external/internal input toggle
    - Output: STRING (the prompt text)
    - Has a settings button to select LLM model
    - Supports auto-generate option
    """

    _CACHE_MAX_SIZE = 50
    MIN_SIZE = (400, 300)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": "", "hidden": True}),
                "disable_text_input": ("BOOLEAN", {"default": False, "hidden": True}),
                "auto_generate": ("BOOLEAN", {"default": False, "hidden": True}),
                "quick_input": ("STRING", {"default": "", "hidden": True}),
                "skill_id": ("STRING", {"default": "", "hidden": True}),
                "quick_input_used": ("BOOLEAN", {"default": False, "hidden": True}),
                "random_enabled": ("BOOLEAN", {"default": False, "hidden": True}),
                "random_count": ("INT", {"default": 1, "min": 1, "max": 16, "step": 1, "hidden": True}),
            },
            "optional": {
                "text_input": ("STRING", {"forceInput": True,
                                          "tooltip": "外部提示词接入：接上后忽略节点内文本框、自动增强与随机抽取。"}),
                "image": ("IMAGE", {"tooltip": "接图像时走图生文（反推提示词）流程，需同时开启自动生成。"}),
                "instance_uid": ("STRING", {"default": "", "hidden": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("PROMPT", "BUNDLE")
    # 多结果 skill：PROMPT 按条目循环消费（OUTPUT_IS_LIST），单结果等价于原行为；BUNDLE 为本次生成的运行时包 id
    OUTPUT_IS_LIST = (True, False)
    FUNCTION = "get_prompt"
    CATEGORY = "Neo Studio"
    OUTPUT_NODE = True
    DESCRIPTION = "Simple prompt generator node with settings button. Supports external/internal input toggle and auto-generate. No clip encoder binding."
    SEARCH_ALIASES = [
        "prompt agent", "prompt generator", "prompt list", "bundle", "llm",
        "auto generate", "reverse prompt", "image to prompt", "random prompt", "skill",
        "提示词", "提示词生成", "提示词代理", "提示词增强", "反推提示词", "图生文",
        "随机提示词", "多段提示词", "参考包", "运行时包", "neo",
    ]
    OUTPUT_TOOLTIPS = (
        "本次生成的提示词；多结果 skill 时按条目成列表输出（OUTPUT_IS_LIST）。",
        "本次生成的运行时包 id（提示词 + 参考图），接 NeoImageGenEdit / NeoH3VideoDirector / NeoBundleExpand 的 bundle。",
    )

    def get_prompt(self, prompt="", disable_text_input=False, auto_generate=False, quick_input="", text_input=None, instance_uid="", unique_id=None, skill_id="", image=None, quick_input_used=False, random_enabled=False, random_count=1):
        """Returns the prompt text as output.

        Logic:
        1. If auto_generate is enabled and (quick_input or image) has content, call LLM synchronously (ignore existing prompt)
        2. Otherwise, combine prompt and quick_input (same as frontend logic)
        """
        logger.info(f"get_prompt called: auto_generate={auto_generate}, prompt='{prompt[:50]}...', quick_input='{quick_input[:50]}...', text_input={text_input is not None}, image={image is not None}")
        gen_meta = {"task": None, "skill_id": ""}

        # 运行时随机：从混合池不重复抽取 count 条，结果列表直接作为输出。
        # 清空 quick_input 使后续自动增强/指令拼装不会覆盖随机结果。
        random_picked = []
        if random_enabled and text_input is None:
            count = max(1, min(int(random_count or 1), 16))
            random_picked = sample_runtime_prompts(count)
            if random_picked:
                prompt = random_picked[0]
                quick_input = ""
                logger.info(f"Runtime random selected {len(random_picked)} prompts, first: {prompt[:60]}...")
                if instance_uid:
                    # 编辑框按多结果约定（\n---\n 分隔）展示全部抽中条目，输出仍为逐条列表
                    PromptServer.instance.send_sync("rs.prompt.update", {
                        "instance_uid": instance_uid,
                        "prompt": "\n---\n".join(random_picked),
                        "random_count": len(random_picked),
                    })
            else:
                logger.warning("Runtime random enabled but prompt pool is empty, keeping current prompt")

        # Generate synchronously only when auto_generate is enabled;
        # an image input then selects the image (reverse_prompt/template) flow.
        if auto_generate and (quick_input.strip() or image is not None) and text_input is None:
            logger.info(f"Auto-generate condition met, checking LLM mode...")
            current_mode = get_current_mode()
            logger.info(f"Current LLM mode: {current_mode}")
            try:
                image_bytes = image_tensor_to_png(image) if image is not None else None
                image_mode = image_bytes is not None
                if image_mode or current_mode == LLM_MODE_REMOTE:
                    # Use selected template as system prompt when available
                    task_name = "reverse_prompt" if image_mode else "smart_prompt"
                    system_prompt = None
                    template_max = None
                    skill_agent = False
                    if skill_id.strip():
                        if skill.load_skill_content(skill_id):
                            skill_agent = True
                            logger.info(f"Auto-generate using skill '{skill_id}' (agent)")
                        else:
                            logger.warning(f"Skill '{skill_id}' not found, falling back to {task_name}")
                    gen_meta.update(task=task_name, skill_id=skill_id)
                    logger.info(f"Calling LLM with {task_name} task, quick_input: {quick_input[:100]}..., image: {image_mode}")
                    # Use stream generation for real-time update
                    from .llm import run_llm_task_stream
                    accumulated = ""
                    if skill_agent:
                        gen = skill.run_skill_agent_stream(skill_id, quick_input, images=[image_bytes] if image_mode else None)
                    else:
                        stream_kwargs = {"system_prompt": system_prompt, "max_tokens_override": template_max}
                        if image_mode:
                            stream_kwargs["images"] = [image_bytes]
                        gen = run_llm_task_stream(task_name, quick_input, **stream_kwargs)
                    for chunk in gen:
                        # run_llm_task_stream / run_skill_agent_stream：dict 带 kind，只累计正文（跳过思考）
                        if isinstance(chunk, dict):
                            if chunk.get("kind") == "thinking":
                                continue
                            text_chunk = chunk.get("text", "")
                        else:
                            text_chunk = chunk or ""
                        accumulated += text_chunk
                        # Send real-time update to frontend
                        if instance_uid:
                            PromptServer.instance.send_sync("rs.prompt.auto_generate_update", {
                                "instance_uid": instance_uid,
                                "prompt": accumulated,
                                "is_complete": False
                            })

                    if accumulated:
                        prompt = accumulated
                        logger.info(f"Auto-generated prompt: {accumulated[:100]}...")
                        # Send final update
                        if instance_uid:
                            PromptServer.instance.send_sync("rs.prompt.auto_generate_update", {
                                "instance_uid": instance_uid,
                                "prompt": accumulated,
                                "is_complete": True
                            })
                else:
                    logger.warning(f"Auto-generate only works in remote LLM mode, current mode: {current_mode}")
            except Exception as e:
                logger.error(f"Auto-generate failed: {e}")
                logger.exception(e)
        else:
            logger.info(f"Auto-generate condition not met: auto_generate={auto_generate}, quick_input_has_content={quick_input.strip()}, text_input_none={text_input is None}")
            # Combine prompt and quick_input (same logic as frontend)
            # quick_input 已作为生成指令被消费时不再拼入提示词
            if quick_input.strip() and not quick_input_used:
                if prompt.strip():
                    prompt = f"{prompt}\n\n---\n\n{quick_input}"
                else:
                    prompt = quick_input

        current_text = prompt
        if disable_text_input:
            effective_text_input = None
        else:
            effective_text_input = text_input

        if effective_text_input is not None:
            # EXTERNAL: use the connected text_input as the content to encode/output
            current_text = effective_text_input

        if effective_text_input is not None and instance_uid:
            PromptServer.instance.send_sync("rs.prompt.update", {
                "instance_uid": instance_uid,
                "prompt": current_text
            })

        # 多结果 skill：按 multi_result 契约拆分；未声明或仅一段时为 [current_text]
        multi_rule = None
        if gen_meta["task"] == "template_prompt":
            multi_rule = skill.load_skill_multi_result(gen_meta["skill_id"])
        elif gen_meta["task"]:
            multi_rule = LLM_TASKS.get(gen_meta["task"], {}).get("multi_result")
        elif skill_id:
            # 节点未参与生成（如前端生成后直接出队）：按所选模板/任务契约拆分
            multi_rule = skill.load_skill_multi_result(skill_id)
            if multi_rule is None and skill_id in LLM_TASKS:
                multi_rule = LLM_TASKS[skill_id].get("multi_result")
        prompts_list = resolve_multi_result(current_text, multi_rule) or [current_text]
        if random_picked:
            # 运行时随机批量：直接输出抽到的条目列表（OUTPUT_IS_LIST 按条循环消费）
            prompts_list = list(random_picked)
            current_text = prompts_list[0]

        # 节点执行结束：勾选自动卸载时释放本地/原生模型（手动 生成不走节点执行，不受影响）
        _auto_unload_after_generate()
        # 运行时 bundle：把本次 prompt/连接图/skill 打包成临时 id，供下游 H3/Krea2 按 id 消费
        # references = 连线张量 + 前端采集的 @引用/本地上传图（按节点 id 暂存，取出即删）
        references = (_bundle_references(image) + take_bundle_refs(unique_id))[:MAX_BUNDLE_REFERENCES]
        bundle_id = create_bundle({
            "prompts": list(prompts_list),
            "references": references,
            "gen_type": "",   # 运行时无法确定目标模态（图/视频），留空；消费端按自身类型处理
        })
        return {
            "ui": {"text": [current_text]},
            "result": (prompts_list, bundle_id)
        }

    @classmethod
    def IS_CHANGED(cls, auto_generate=False, quick_input="", image=None, random_enabled=False, **kwargs):
        # If auto_generate is enabled and (quick_input or image) has content, always re-execute
        if image is not None or (auto_generate and quick_input.strip()) or random_enabled:
            import time
            return time.time()  # Return unique value to force re-execution
        # Otherwise, never change (use cached result)
        return float("nan")


# ==========================================
# Node Class Mappings
# ==========================================
NODE_CLASS_MAPPINGS = {
    "NeoPromptEncoder": NeoPrompts,
    "NeoPromptAgent": NeoPromptAgent,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "NeoPromptEncoder": "Neo Prompt Encoder",
    "NeoPromptAgent": "Neo Prompt Agent",
}
