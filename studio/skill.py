# SPDX-License-Identifier: Apache-2.0
# Neo Studio - Skills (目录式多文件 Markdown 技能)
"""
Skill = 一个目录，内含主文件 skill.md（大小写不敏感：SKILL.md / Skill.md 亦可；YAML frontmatter + 系统提示词正文）+ 可选的其它 *.md 与子目录中的 *.txt 引用文件。

存储布局：
    skills/
      presets/<skill_id>/   预设（随插件发布，只读、不可删）
      tasks/<skill_id>/     任务（内置 LLM 操作，供 llm.LLM_TASKS 使用）
      custom/<skill_id>/    用户自定义

约定：
- skill id = 目录名。
- 元数据只从 skill.md 的 YAML frontmatter 读取（name/tags/inputs/description/
  max_tokens/result_key/multi_result/multi_turn/category/markers/
  gen_image/created_at）。
- 系统提示词 = 顶层所有 .md 按文件名升序拼接（子目录与 *.txt 引用文件不并入，
  由代理按需读取）；带 YAML frontmatter 的 .md（含主文件 skill.md，忽略大小写）
  去掉 frontmatter，其余正文原样保留。

本模块承载 skill 的目录管理与"按需读取引用文件"的代理循环；仅在函数运行时惰性导入 llm 原语，
避免与 llm.py（顶层 from . import skill）形成循环导入。prompts.py / llm.py 作为消费者从这里导入。
"""

from __future__ import annotations

import os
import re
import io
import copy
import asyncio
import json
import base64
import shutil
import logging
import tempfile
import datetime
import threading
import zipfile
from collections.abc import Generator
from typing import Any, Dict

import yaml
from aiohttp import web

routes = web.RouteTableDef()

try:
    from pypinyin import lazy_pinyin, Style as _PinyinStyle
except ImportError:  # pypinyin 缺失时中文拼音匹配静默不可用，其余功能正常
    lazy_pinyin = None
from .minimax_h3 import _ratio, _filter_mode_sections, _h3_audit_and_repair, _h3_audit_events, _h3_grounding_check, _h3_mode, format_h3_context_lines
from . import plugin_paths
from .util import PrefixFilter, ASPECT_LABELS, ratio_pair

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))   # 同级 custom_nodes 探测
SKILLS_DIR = str(plugin_paths.SKILLS_DIR)
SKILL_PRESETS_DIR = os.path.join(SKILLS_DIR, "presets")
SKILL_CUSTOM_DIR = os.path.join(SKILLS_DIR, "custom")
TASKS_DIR = os.path.join(SKILLS_DIR, "tasks")
# 预设技能本地配置覆盖（用户本机模型路径等；运行期并入有效 config，不进 git）
SKILL_OVERRIDES_DIR = str(plugin_paths.CONFIGS_DIR / "skill_overrides")

for _d in (SKILLS_DIR, SKILL_PRESETS_DIR, SKILL_CUSTOM_DIR, TASKS_DIR, SKILL_OVERRIDES_DIR):
    if not os.path.exists(_d):
        os.makedirs(_d)

_skills_lock = threading.Lock()

# 仅内部使用的任务（实现细节），不对外展示为可选 skill
_SKILL_INTERNAL = {
    "template_prompt",
    "extract_title",
    "extract_classify",
}

# 内置使命级别的默认输入契约（skill.md 未声明 inputs 时使用）
_SKILL_DEFAULT_INPUTS = {
    "reverse_prompt": ["image", "text"],
    "smart_prompt": ["text"],
    "template_prompt": ["text"],
    "translate_prompt": ["text"],
    "extract_title": ["text"],
    "extract_classify": ["text"],
}

# frontmatter 序列化时的字段顺序（未列出的额外字段追加在末尾）
_META_KEY_ORDER = (
    "name", "cn_name", "tags", "inputs", "description", "max_tokens",
    "result_key", "multi_result", "multi_turn", "category",
    "gen_image", "gen_video", "mode", "requires_ref", "audit", "created_at",
)

# 技能文件管理器支持的文件扩展名（.md 主/子文档 + .txt 引用文本）。
# 注意：系统提示词拼接仍只取顶层 .md（见 load_skill_content），此集合仅用于文件管理。
_SKILL_FILE_EXTS = (".md", ".txt")


def _skill_category(skill_id: str, data: dict) -> str:
    """推断 skill 分类：vision（含图像输入）/ task（任务）/ style（模板）。"""
    if data.get("category"):
        return data["category"]
    if "image" in (data.get("inputs") or []):
        return "vision"
    return "task"


# ==========================================
# Frontmatter 解析 / 序列化
# ==========================================

def split_frontmatter(text: str) -> tuple[dict, str]:
    """把 skill.md 拆成 (metadata dict, body str)。frontmatter 是文件开头的 --- YAML 块。

    闭合分隔符通过 PyYAML 事件流（第一个 DocumentEndEvent）定位，而不是扫描
    字面量 ``---`` 行，这样多行 YAML 值里即使含有 ``---`` 也能正确解析。
    body 按原始 Markdown 返回，从不按 YAML 解析。
    """
    if text.startswith("\ufeff"):
        text = text[1:]
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    end_line = None
    for event in yaml.parse(text, Loader=yaml.SafeLoader):
        if isinstance(event, yaml.DocumentEndEvent):
            end_line = event.end_mark.line
            break
    if end_line is None or end_line < 1:
        return {}, text
    fm_text = "\n".join(lines[1:end_line])
    try:
        meta = yaml.safe_load(fm_text)
    except Exception:
        logger.warning(f"Invalid YAML frontmatter:\n{fm_text[:200]}")
        return {}, text
    if not isinstance(meta, dict):
        meta = {}
    body = "\n".join(lines[end_line + 1:]).lstrip("\n")
    return meta, body


def serialize_frontmatter(meta: dict, body: str) -> str:
    """把 metadata + 正文拼回 skill.md 文本。"""
    ordered = {}
    for key in _META_KEY_ORDER:
        if meta.get(key) is not None:
            ordered[key] = meta[key]
    for k, v in meta.items():
        if k not in ordered and v is not None:
            ordered[k] = v
    fm = yaml.safe_dump(ordered, allow_unicode=True, default_flow_style=False, sort_keys=False)
    return f"---\n{fm}---\n\n{body}"


# ==========================================
# 目录 / 内容读取
# ==========================================

def _skill_dir(skill_id: str) -> str | None:
    """返回 skill id 对应的目录（custom > presets > tasks），不存在则 None。"""
    if not skill_id:
        return None
    for base in (SKILL_CUSTOM_DIR, SKILL_PRESETS_DIR, TASKS_DIR):
        d = os.path.join(base, skill_id)
        if os.path.isdir(d):
            return d
    return None


def _skill_source(skill_dir: str) -> str:
    """skill 目录所在分组名（presets/custom/tasks）。"""
    return os.path.basename(os.path.dirname(skill_dir))


def _main_md_name(skill_dir: str) -> str | None:
    """主文件（skill.md，忽略大小写）在目录内的实际文件名；无则 None。

    兼容 SKILL.md / Skill.md 等写法（Agent Skills 常用大写），并在大小写敏感
    的文件系统上也能正确定位到真实文件名。
    """
    try:
        names = [fn for fn in os.listdir(skill_dir)
                 if fn.lower() == "skill.md" and os.path.isfile(os.path.join(skill_dir, fn))]
    except OSError:
        return None
    return sorted(names)[0] if names else None


def _read_skill_md(skill_dir: str) -> tuple[dict, str]:
    main = _main_md_name(skill_dir)
    if not main:
        return {}, ""
    path = os.path.join(skill_dir, main)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
    except Exception as e:
        logger.warning(f"Error reading {main} in {skill_dir}: {e}")
        return {}, ""
    return split_frontmatter(text)


def _list_all_skill_files(skill_dir: str) -> list[str]:
    """递归列出 skill 目录内所有受支持文件（.md/.txt）的相对路径（/ 分隔）。

    顶层文件在前、其余按路径升序，供前端技能文件管理器展示与编辑。"""
    found = []
    for dirpath, _dirnames, filenames in os.walk(skill_dir):
        for fn in filenames:
            if not fn.lower().endswith(_SKILL_FILE_EXTS):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), skill_dir).replace(os.sep, "/")
            found.append(rel)
    found.sort(key=lambda r: (0 if "/" not in r else 1, r.lower()))
    return found


def _main_md_files_for_language(skill_dir: str, language: str) -> list:
    """返回指定语言下应并入系统提示词的顶层 .md 文件（升序）。

    同一 skill 的中英主文件互斥：language='cn' 优先 skill.cn.md，缺省时回退 skill.md；
    language='en'（默认）优先 skill.md，缺省时回退 skill.cn.md。其余顶层 .md 一律保留。
    """
    try:
        names = sorted(fn for fn in os.listdir(skill_dir)
                       if fn.lower().endswith(".md") and os.path.isfile(os.path.join(skill_dir, fn)))
    except OSError:
        return []
    has_cn = any(n.lower() == "skill.cn.md" for n in names)
    has_en = any(n.lower() == "skill.md" for n in names)

    def keep(fn):
        lfn = fn.lower()
        if lfn == "skill.cn.md":
            # EN 语言下，若存在英文主文件则丢弃中文孪生文件
            return not (language != "cn" and has_en)
        if lfn == "skill.md":
            # CN 语言下，若存在中文主文件则丢弃英文孪生文件
            return not (language == "cn" and has_cn)
        return True

    return [fn for fn in names if keep(fn)]


def load_skill_content(skill_id: str, language: str = "en") -> str | None:
    """拼接 skill 目录顶层主 .md（按语言选择，中英互斥）为系统提示词；带 YAML frontmatter 的
    .md（含主文件 skill.md / skill.cn.md，忽略大小写）去掉 frontmatter，其余正文原样保留。
    （子目录与 .txt 引用文件不并入提示词，由代理按需读取。）"""
    d = _skill_dir(skill_id)
    if not d:
        return None
    parts = []
    for fn in _main_md_files_for_language(d, language):
        fp = os.path.join(d, fn)
        try:
            with open(fp, 'r', encoding='utf-8') as f:
                text = f.read()
        except Exception as e:
            logger.warning(f"Error reading {fp}: {e}")
            continue
        meta, stripped = split_frontmatter(text)
        body = stripped if isinstance(meta, dict) and meta else text
        if body.strip():
            parts.append(body.rstrip("\n"))
    content = "\n\n".join(parts)
    return content or None


def _skill_meta(skill_id: str) -> dict:
    d = _skill_dir(skill_id)
    if not d:
        return {}
    meta, _ = _read_skill_md(d)
    return meta


def load_skill_max_tokens(skill_id: str):
    """加载 skill 声明的 max_tokens 覆盖（未声明则 None）。"""
    val = _skill_meta(skill_id).get("max_tokens")
    try:
        return int(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def load_skill_multi_result(skill_id: str):
    """加载 skill 的 multi_result 输出契约（未声明则 None）。"""
    meta = _skill_meta(skill_id)
    return meta.get("multi_result") if meta else None


def load_skill_audit(skill_id: str):
    """加载 skill 声明的输出审计类型（如 `audit: h3`；未声明则 None，不做生成后审计）。"""
    val = _skill_meta(skill_id).get("audit")
    return str(val) if val else None


# ==========================================
# On-demand reference loading (tool-calling agent)
# ==========================================

def list_skill_references(skill_id: str) -> list:
    """返回 skill 内可被代理按需读取的引用文件（相对路径，升序、去重）。

    即除顶层主 .md（skill.md / skill.cn.md）外的所有受支持文件（.md/.txt，含 references/ 子目录）。
    """
    d = _skill_dir(skill_id)
    if not d:
        return []
    refs = []
    for rel in _list_all_skill_files(d):
        base = rel.split("/")[-1].lower()
        is_top = "/" not in rel
        if is_top and (base == "skill.md" or base == "skill.cn.md"):
            continue
        refs.append(rel)
    return refs


def build_reference_index(skill_id: str, language: str = "en") -> str:
    """生成注入系统提示词的引用文件索引；无引用时返回空串。"""
    refs = list_skill_references(skill_id)
    if not refs:
        return ""
    lines = [
        "",
        "## Available reference files",
        "",
        "The skill instructions above refer to on-demand reference files. When you reach a step that says to read one, call the `read_skill_file` tool with its exact relative path from the list below. Load it before using it; do not guess its contents.",
        "",
    ]
    lines.extend(f"- {rel}" for rel in refs)
    return "\n".join(lines)


def read_skill_file(skill_id: str, rel_path: str):
    """代理工具：按相对路径读取 skill 引用文件；越界/不存在/不可读返回 None。"""
    d = _skill_dir(skill_id)
    if not d or not rel_path:
        return None
    target = _safe_skill_file_path(d, rel_path)
    if not target or not os.path.isfile(target):
        return None
    try:
        with open(target, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        logger.warning(f"Error reading skill reference {rel_path}: {e}")
        return None


_SKILL_FILE_TOOL = {
    "type": "function",
    "function": {
        "name": "read_skill_file",
        "description": ("Read one reference file of the current skill by its exact relative path "
                        "(e.g. 'references/model-selection.md'). Call it only for files listed in the "
                        "'Available reference files' section, when the skill instructions tell you to read them."),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path of the reference file within the skill directory."},
            },
            "required": ["path"],
        },
    },
}

_REFERENCE_IMAGE_TOOL = {
    "type": "function",
    "function": {
        "name": "get_reference_image",
        "description": ("Fetch the actual pixels of one workflow reference image by its 1-based index in the "
                        "'Reference media' list of <workflow_context>. Call it only when you need to inspect a "
                        "specific reference image's content; do not fetch images you will not use."),
        "parameters": {
            "type": "object",
            "properties": {
                "index": {"type": "integer", "description": "1-based index of the reference image in <workflow_context>."},
            },
            "required": ["index"],
        },
    },
}

_MAX_SKILL_AGENT_TURNS = 8


def _format_workflow_context(context, grounding: bool = False) -> str:
    """把前端采集的工作流上下文（MiniMax H3 参数 + 叶子媒体清单）格式化为系统提示词文本块。

    参考图只列元数据不内联；带尺寸的图片可通过 get_reference_image 工具按需取回像素。
    H3 节点块由 minimax_h3.format_h3_context_lines 格式化；grounding=True 时末尾追加模式约束句。
    """
    if not isinstance(context, dict):
        return ""
    h3 = context.get("h3") or []
    refs = context.get("references") or []
    nodes = context.get("nodes") or []
    if not (h3 or refs):
        return ""

    lines = ["<workflow_context>"]
    if h3:
        lines.extend(format_h3_context_lines(h3))
    if refs:
        lines.append("Reference media (leaf inputs of the workflow):")
        for i, r in enumerate(refs[:32], 1):
            kind = r.get("kind", "?")
            src = r.get("source") or {}
            name = src.get("value", "") if isinstance(src, dict) else str(src)
            w, h = r.get("width"), r.get("height")
            if w and h:
                lines.append(f"  [{i}] image {name}{_ratio(w, h)} ({w}x{h}) - fetchable via get_reference_image({i})")
            else:
                lines.append(f"  [{i}] {kind} {name}")
        if any(r.get("kind") == "image" for r in refs[:32]):
            lines.append("Fetch a reference image's actual pixels with the get_reference_image tool only when you need to inspect it; do not assume unseen details.")
    others = [t for t in nodes if "MiniMax" not in str(t)][:40]
    if others:
        lines.append("Other node types: " + ", ".join(str(t) for t in others))
    if grounding and h3:
        lines.append(_h3_grounding_check(h3[0]))
        logger.info(f"H3 grounding injected: {_h3_mode(h3[0])} mode")
    lines.append("</workflow_context>")
    return "\n".join(lines)


def _fetch_reference_image(context, index) -> tuple[bytes | None, str]:
    """按 1-based 序号取回参考图字节（复用 prompts._read_image_raw 的目录校验）。"""
    refs = (context or {}).get("references") or []
    try:
        i = int(index)
    except (TypeError, ValueError):
        return None, f"[error] invalid reference index: {index}"
    if not (1 <= i <= len(refs)):
        return None, f"[error] reference index out of range: {i} (1-{len(refs)})"
    ref = refs[i - 1]
    src = ref.get("source") or {}
    name = src.get("value", "") if isinstance(src, dict) else str(src)
    if ref.get("kind") != "image":
        return None, f"[error] reference {i} ({name}) is a video; only images can be fetched"
    from .prompts import _read_image_raw
    data = _read_image_raw(src) if isinstance(src, dict) else None
    if data is None:
        return None, f"[error] failed to read reference image {i} ({name})"
    return data, f"Reference image {i}: {name}"


def _resolve_skill_language(text: str) -> str:
    """确定加载哪一版主文件：全局偏好 en/cn 优先，否则按输入语言自动判断。"""
    from .llm import _load_remote_config, _detect_language
    try:
        pref = str(_load_remote_config().get("skill_language", "auto")).lower()
    except Exception:
        pref = "auto"
    if pref in ("en", "cn"):
        return pref
    return "cn" if _detect_language(text or "") == "Chinese" else "en"


def _initial_user_message(text: str, images) -> Dict[str, Any]:
    """构造首个 user 消息；有图时组装多模态内容，否则纯文本。"""
    if not images:
        return {"role": "user", "content": text}
    parts = []
    for img_bytes in images:
        b64 = base64.b64encode(img_bytes).decode("utf-8")
        parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})
    parts.append({"type": "text", "text": text})
    return {"role": "user", "content": parts}


def _skill_agent_core(skill_id: str, text: str, images=None, context=None, enable_thinking=None, reasoning_effort=None, on_step=None) -> str:
    """执行 skill 生成：工作流上下文始终注入系统提示词；仅当存在引用文件或参考图像时启用工具调用
    代理循环（本地/远程一致），否则单轮推理。read_skill_file 按需读取引用文件，get_reference_image
    按需取回参考图像素。context 为前端采集的工作流上下文（MiniMax H3 参数 + 参考媒体清单）。
    on_step 为可选的阶段上报回调（audit: h3 技能的审计/修复阶段）。
    返回最终答案字符串；失败抛出异常。"""
    from .llm import chat_turn, get_current_mode, LLM_MODE_REMOTE, _run_llm_inference

    skill_id = (skill_id or "").strip()
    if not skill_id:
        raise ValueError("No skill specified")

    language = _resolve_skill_language(text)
    system_prompt = load_skill_content(skill_id, language=language)
    if not system_prompt:
        raise ValueError(f"Skill '{skill_id}' not found or has no content")

    audit_kind = load_skill_audit(skill_id)
    ctx_block = _format_workflow_context(context, grounding=(audit_kind == "h3"))
    refs = list_skill_references(skill_id)
    ref_images = [r for r in (context or {}).get("references", []) if r.get("kind") == "image"] if isinstance(context, dict) else []
    max_tokens = load_skill_max_tokens(skill_id) or 500
    remote_mode = (get_current_mode() == LLM_MODE_REMOTE)

    # 系统提示词：主文件（按 H3 模式裁剪条件段落）+ 引用索引（若有）+ 工作流上下文（若有），单轮与工具循环两条路径共用
    system = _filter_mode_sections(system_prompt, context)
    if refs:
        system += "\n" + build_reference_index(skill_id, language)
    if ctx_block:
        system += ("\n\n" if refs else "\n") + ctx_block

    # 无引用文件且无可取回参考图像：单轮生成（系统提示词已含工作流上下文）
    if not (refs or ref_images):
        result = _run_llm_inference(system, text, max_tokens, images=images or None, use_remote=remote_mode, enable_thinking=enable_thinking)
        if audit_kind == "h3" and result:
            if on_step:
                on_step("🔍 格式自检中…")
            return _h3_audit_and_repair(result, skill_id, text, context, max_tokens, on_step=on_step)
        return result or ""

    # 有引用文件/参考图像：工具调用代理循环（按需取回）
    tools = [_SKILL_FILE_TOOL] if refs else []
    if ref_images:
        tools.append(_REFERENCE_IMAGE_TOOL)
    messages = [
        {"role": "system", "content": system},
        _initial_user_message(text, images),
    ]
    content = ""
    for _ in range(_MAX_SKILL_AGENT_TURNS):
        msg = chat_turn(messages, max_tokens=max_tokens, tools=tools or None,
                        enable_thinking=enable_thinking, reasoning_effort=reasoning_effort)
        content = msg.get("content") or ""
        tool_calls = msg.get("tool_calls") or []
        assistant_msg = {"role": "assistant", "content": content}
        if tool_calls:
            assistant_msg["tool_calls"] = tool_calls
        messages.append(assistant_msg)
        if not tool_calls:
            break
        fetched_images = []
        for tc in tool_calls:
            fn = tc.get("function") or {}
            name = fn.get("name")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except (ValueError, TypeError):
                args = {}
            if name == "read_skill_file":
                file_content = read_skill_file(skill_id, str(args.get("path", "")))
                tool_result = file_content if file_content is not None else f"[error] reference file not found: {args.get('path')}"
            elif name == "get_reference_image":
                img_bytes, caption = _fetch_reference_image(context, args.get("index"))
                tool_result = caption
                if img_bytes is not None:
                    fetched_images.append((caption, img_bytes))
            else:
                tool_result = f"[error] unknown tool: {name}"
            messages.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": tool_result})
        # 取回的参考图作为独立 user 消息回灌（部分 provider 的 tool 消息不支持图片；
        # 且须在本轮全部 tool 结果之后，保持 assistant->tool*->user 的消息顺序）
        for caption, img_bytes in fetched_images:
            b64 = base64.b64encode(img_bytes).decode("utf-8")
            messages.append({"role": "user", "content": [
                {"type": "text", "text": f"Fetched {caption}."},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ]})

    if not content.strip():
        raise RuntimeError(f"Skill '{skill_id}' produced no output")
    if audit_kind == "h3":
        if on_step:
            on_step("🔍 格式自检中…")
        content = _h3_audit_and_repair(content, skill_id, text, context, max_tokens, on_step=on_step)
    return content


def run_skill_agent(skill_id: str, text: str, images=None, context=None) -> str:
    """非流式执行 skill，返回最终答案字符串；失败抛出异常。"""
    return _skill_agent_core(skill_id, text, images, context)


def _skill_agent_core_stream(skill_id: str, text: str, images=None, context=None, enable_thinking=None, reasoning_effort=None) -> Generator[dict, None, None]:
    """流式执行 skill 生成：工作流上下文始终注入系统提示词；单轮路径逐 token 透传 LLM 输出（与
    llm.run_llm_task_stream 一致），仅当存在引用文件或参考图像时走工具循环（复用非流式核心再逐字
    输出）。失败抛出异常，由调用方捕获。"""
    from .llm import get_current_mode, LLM_MODE_REMOTE, _run_llm_inference

    skill_id = (skill_id or "").strip()
    if not skill_id:
        raise ValueError("No skill specified")

    language = _resolve_skill_language(text)
    system_prompt = load_skill_content(skill_id, language=language)
    if not system_prompt:
        raise ValueError(f"Skill '{skill_id}' not found or has no content")

    audit_kind = load_skill_audit(skill_id)
    ctx_block = _format_workflow_context(context, grounding=(audit_kind == "h3"))
    refs = list_skill_references(skill_id)
    ref_images = [r for r in (context or {}).get("references", []) if r.get("kind") == "image"] if isinstance(context, dict) else []
    max_tokens = load_skill_max_tokens(skill_id) or 500
    remote_mode = (get_current_mode() == LLM_MODE_REMOTE)

    system = _filter_mode_sections(system_prompt, context)
    if refs:
        system += "\n" + build_reference_index(skill_id, language)
    if ctx_block:
        system += ("\n\n" if refs else "\n") + ctx_block

    # 无引用文件/参考图像：单轮生成，逐 token 透传 LLM 输出（系统提示词已含工作流上下文）。
    # 归一成 {"text","kind"}（与 llm.run_llm_task_stream 一致）：思考（thinking）与正文（content）分开打标，
    # 前端据此展示/清除临时思考面板，消费方只累计正文。
    if not (refs or ref_images):
        result = _run_llm_inference(system, text, max_tokens, images=images or None,
                                    use_remote=remote_mode, stream=True, enable_thinking=enable_thinking,
                                    reasoning_effort=reasoning_effort)
        buf = []
        if hasattr(result, '__iter__') and not isinstance(result, str):
            for chunk in result:
                # 远程生成器已带 {"text","kind"}；本地 llama.cpp 为 {choices:[{delta:{...}}]}。统一归一打标。
                if isinstance(chunk, dict):
                    if "text" in chunk:
                        kind = chunk.get("kind", "content")
                        yield {"text": chunk["text"], "kind": kind}
                        if kind == "content":
                            buf.append(chunk["text"])
                        continue
                    choices = chunk.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0].get("delta", {})
                    content = delta.get("content") or ""
                    reasoning = delta.get("reasoning_content") or ""
                    if content:
                        yield {"text": content, "kind": "content"}
                        buf.append(content)
                    if reasoning:
                        yield {"text": reasoning, "kind": "thinking"}
                elif isinstance(chunk, str):
                    yield {"text": chunk, "kind": "content"}
                    buf.append(chunk)
        else:
            # 本地路径未返回生成器（不支持流式）：回退为整段输出
            result = result or ""
            if result:
                yield {"text": result, "kind": "content"}
            buf.append(result)
        # audit: h3：正文已实时透传，拿到完整输出后做格式审计（必要时窄修复），进度以 status 事件上报
        if audit_kind == "h3":
            full = "".join(buf).strip()
            if not full:
                raise RuntimeError(f"Skill '{skill_id}' produced no output")
            yield from _h3_audit_events(full, skill_id, text, context, max_tokens)
        return

    # 有引用文件/参考图像：工具调用循环需完整消息解析 tool_calls，复用非流式核心后逐字输出（仅正文）。
    # audit: h3：生成阶段先上报状态（如实说明按需读取的来源），审计/修复阶段经 on_step 收集、随最终内容前发出。
    if audit_kind == "h3":
        what = []
        if refs:
            what.append("读取技能引用文件")
        if ref_images:
            what.append(f"查看 {len(ref_images)} 张已连参考图")
        yield {"text": f"⏳ 生成中（按需{'、'.join(what)}）…", "kind": "status"}
    steps = []
    content = _skill_agent_core(skill_id, text, images, context, enable_thinking=enable_thinking,
                                reasoning_effort=reasoning_effort, on_step=steps.append)
    for s in steps:
        yield {"text": s, "kind": "status"}
    for ch in content:
        yield {"text": ch, "kind": "content"}


def run_skill_agent_stream(skill_id: str, text: str, images=None, context=None, enable_thinking=None, reasoning_effort=None) -> Generator[dict, None, None]:
    """流式契约：逐 token yield {"text","kind"}（思考 thinking / 正文 content，与 llm.run_llm_task_stream 一致）；失败 yield [ERROR]。"""
    try:
        saw_content = False
        for chunk in _skill_agent_core_stream(skill_id, text, images, context, enable_thinking=enable_thinking, reasoning_effort=reasoning_effort):
            if chunk.get("kind") == "content" and (chunk.get("text") or "").strip():
                saw_content = True
            yield chunk
        # 思考模型可能把 max_tokens 预算全花在 reasoning 上，导致正文为空。
        # 此时给一条可见提示，避免前端在思考结束后静默无响应（最终只保留正文）。
        if not saw_content:
            yield {"text": "[未生成最终提示词：模型思考占用了全部 token 预算。请在 ✨ 菜单将「思考深度」设为「不思考」，或调大该技能的 max_tokens 后重试。]", "kind": "content"}
    except Exception as e:
        logger.error(f"Skill agent error for '{skill_id}': {e}")
        yield {"text": f"[ERROR] {str(e)}", "kind": "content"}


def load_task_template(task_name: str) -> dict:
    """读取任务 skill（tasks/<task_name>/skill.md）为 llm.LLM_TASKS 条目。"""
    d = os.path.join(TASKS_DIR, task_name)
    if not os.path.isdir(d):
        return {}
    meta, body = _read_skill_md(d)
    return {
        "content": body,
        "max_tokens": meta.get("max_tokens", 500),
        "result_key": meta.get("result_key", "prompt"),
        "description": meta.get("description", ""),
        "multi_result": meta.get("multi_result"),
    }


def _skill_name_pinyin_tags(name) -> list:
    """为中文技能名生成拼音匹配标签（全拼 + 首字母缩写），供前端 / 菜单按拼音检索。

    仅当名称含 CJK 且安装了 pypinyin 时返回非空；英文/数字字符原样并入拼音串。"""
    if not name or lazy_pinyin is None:
        return []
    s = str(name)
    if not any("\u4e00" <= ch <= "\u9fff" for ch in s):
        return []

    def compact(style):
        return re.sub(r"[^a-z0-9]", "", "".join(lazy_pinyin(s, style=style)).lower())

    tags = []
    full = compact(_PinyinStyle.NORMAL)
    initials = compact(_PinyinStyle.FIRST_LETTER)
    if full:
        tags.append(full)
    if initials and initials != full:
        tags.append(initials)
    return tags


def _gen_config_summary(cfg: dict) -> dict | None:
    """从技能有效 config（预设含本地覆盖）提取列表预览摘要；只保留非空项，全空返回 None。"""
    if not isinstance(cfg, dict):
        return None
    out = {}
    model = str(cfg.get("model") or "").strip()
    if model:
        out["model"] = model[:256]
    loras = []
    for entry in cfg.get("loras") or []:
        name = str((entry or {}).get("name") or "").strip() if isinstance(entry, dict) else str(entry or "").strip()
        if name and name not in loras:
            loras.append(name[:256])
    if loras:
        out["loras"] = loras
    try:
        base = int(cfg.get("base_resolution"))
        if base > 0:
            out["base_resolution"] = base
    except (TypeError, ValueError):
        pass
    ratio = str(cfg.get("default_ratio") or "").strip()
    if ratio:
        out["default_ratio"] = ratio[:32]
    try:
        steps = int(cfg.get("steps"))
        if steps > 0:
            out["steps"] = steps
    except (TypeError, ValueError):
        pass
    default_prompt = str(cfg.get("default_prompt") or "").strip()
    if default_prompt:
        out["default_prompt"] = default_prompt
    return out or None


def _attach_gen_config(skill: dict, skill_id: str) -> None:
    """生图/生视频技能附带紧凑生成配置摘要（主模型 / LoRA 名 / 长边尺寸 / 默认比例 / 采样步数），供前端选择窗行内预览卡片。"""
    if not (skill.get("gen_image") or skill.get("gen_video")):
        return
    summary = _gen_config_summary(get_skill_gen_config(skill_id))
    if summary:
        skill["gen_config"] = summary


def _vdn_plugin_installed() -> bool:
    """VDN 加速插件 ComfyUI-VDN-H3 是否已装：看同级 custom_nodes 目录里有没有它（桌面端没有节点注册表）。"""
    parent = os.path.dirname(CURRENT_DIR)
    try:
        names = os.listdir(parent)
    except OSError:
        return False
    return any(name.lower().startswith("comfyui-vdn") and os.path.isdir(os.path.join(parent, name))
               for name in names)


def _video_skill_available(d: str) -> bool:
    """视频技能当前可用性：workflow 引用 VDN 加速节点时依赖可选插件 ComfyUI-VDN-H3，未装则不可用。"""
    wf = os.path.join(d, "workflow.json")
    if not os.path.isfile(wf):
        return True
    with open(wf, encoding="utf-8") as f:
        needs_vdn = "ApplyVDNH3" in f.read()
    return (not needs_vdn) or _vdn_plugin_installed()


def scan_skills() -> list:
    """合并 tasks + presets/custom 为统一 skill 元数据列表。

    每个 skill 返回: {id, name, category, source, inputs, needs_image, multi_turn, has_workflow, tags, description}；
    生图/生视频技能另带 gen_config 摘要（主模型 / LoRA 名 / 长边尺寸 / 默认比例 / 采样步数，取自有效 config.json）。
    """
    skills = []

    # 1) 任务 (tasks/<id>/) -> category=task/vision
    if os.path.isdir(TASKS_DIR):
        for entry in sorted(os.listdir(TASKS_DIR)):
            d = os.path.join(TASKS_DIR, entry)
            if not os.path.isdir(d):
                continue
            skill_id = entry
            if skill_id in _SKILL_INTERNAL:
                continue
            meta, _ = _read_skill_md(d)
            inputs = meta.get("inputs") or _SKILL_DEFAULT_INPUTS.get(skill_id, ["text"])
            skill = {
                "id": skill_id,
                "name": meta.get("name", skill_id),
                "cn_name": meta.get("cn_name") or meta.get("name") or skill_id,
                "category": _skill_category(skill_id, {**meta, "inputs": inputs}),
                "source": "tasks",
                "tags": list(meta.get("tags", [])) + _skill_name_pinyin_tags(meta.get("cn_name") or meta.get("name", skill_id)),
                "inputs": inputs,
                "needs_image": "image" in inputs,
                "multi_turn": bool(meta.get("multi_turn", False)),
                "gen_image": bool(meta.get("gen_image", False)),
                "gen_video": bool(meta.get("gen_video", False)),
                "requires_ref": bool(meta.get("requires_ref", False)),
                "multi_frame": bool(meta.get("multi_frame", False)),
                "mode": str(meta.get("mode") or "").strip(),
                "description": meta.get("description", ""),
            }
            _attach_gen_config(skill, skill_id)
            if skill["gen_video"]:
                skill["available"] = _video_skill_available(d)
            skills.append(skill)

    # 2) 预设 + 自定义 (presets/<id>/, custom/<id>/) -> category=frontmatter（缺省 image_enhance）
    with _skills_lock:
        for base, source in ((SKILL_PRESETS_DIR, "presets"), (SKILL_CUSTOM_DIR, "custom")):
            if not os.path.isdir(base):
                continue
            for entry in sorted(os.listdir(base)):
                d = os.path.join(base, entry)
                if not os.path.isdir(d):
                    continue
                skill_id = entry
                meta, _ = _read_skill_md(d)
                inputs = meta.get("inputs") or ["text"]
                skill = {
                    "id": skill_id,
                    "name": meta.get("name", skill_id),
                    "cn_name": meta.get("cn_name") or meta.get("name") or skill_id,
                    "category": meta.get("category", "image_enhance"),
                    "source": source,
                    "tags": list(meta.get("tags", [])) + _skill_name_pinyin_tags(meta.get("cn_name") or meta.get("name", skill_id)),
                    "inputs": inputs,
                    "needs_image": "image" in inputs,
                    "multi_turn": bool(meta.get("multi_turn", False)),
                    "gen_image": bool(meta.get("gen_image", False)),
                    "gen_video": bool(meta.get("gen_video", False)),
                    "requires_ref": bool(meta.get("requires_ref", False)),
                    "multi_frame": bool(meta.get("multi_frame", False)),
                    "mode": str(meta.get("mode") or "").strip(),
                    "has_workflow": os.path.isfile(os.path.join(d, "workflow.json")),
                    "description": meta.get("description", ""),
                }
                _attach_gen_config(skill, skill_id)
                if skill["gen_video"]:
                    skill["available"] = _video_skill_available(d)
                skills.append(skill)

    return skills


# ==========================================
# 文件管理 / 保存（含路径安全校验）
# ==========================================

def _normalize_skill_id(raw: str) -> str:
    """规范化 skill id：目录名，仅保留 [A-Za-z0-9_-]。"""
    raw = (raw or "").strip()
    raw = raw.replace("\\", "/").split("/")[-1]
    return re.sub(r'[^A-Za-z0-9_-]', '', raw)


def _safe_skill_file_path(skill_dir: str, filename: str) -> str | None:
    """校验并返回 skill 目录内受支持文件（.md/.txt，可含子目录）的绝对路径；
    非法/越界/非受支持类型返回 None。"""
    fn = (filename or "").replace("\\", "/").strip()
    if not fn or fn.startswith("/"):
        return None
    parts = [p for p in fn.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    if not parts[-1].lower().endswith(_SKILL_FILE_EXTS):
        return None
    target = os.path.realpath(os.path.join(skill_dir, *parts))
    base = os.path.realpath(skill_dir)
    if os.path.commonpath([target, base]) != base:
        return None
    return target


def _find_name_conflict(name: str, exclude_id: str):
    """返回与 cn_name（中文名）同名但 id 不同的 skill 的 id；无冲突返回 None。"""
    target = (name or "").strip()
    if not target:
        return None
    for s in scan_skills():
        if s["id"] != exclude_id and (s.get("cn_name") or "").strip() == target:
            return s["id"]
    return None


def save_skill_main(skill_id: str, name: str, content: str, tags=None, source: str = "custom", multi_turn=None,
                    category=None, gen_image=None, gen_video=None, mode=None, requires_ref=None,
                    cn_name=None) -> bool:
    """保存 skill 的主文件 skill.md（frontmatter + 正文），保留未编辑的既有字段。

    multi_turn/category/gen_image/gen_video/mode/requires_ref 为 None 时沿用 frontmatter 既有值；显式传入则写入（假值时移除该字段）。
    """
    sid = _normalize_skill_id(skill_id)
    if not sid:
        return False
    base = SKILL_PRESETS_DIR if source == "presets" else SKILL_CUSTOM_DIR
    d = os.path.join(base, sid)
    with _skills_lock:
        os.makedirs(d, exist_ok=True)
        meta, _body = _read_skill_md(d)
        mt = meta.get("multi_turn") if multi_turn is None else bool(multi_turn)
        cat = meta.get("category") if category is None else (category or "").strip()
        gi = meta.get("gen_image") if gen_image is None else bool(gen_image)
        gv = meta.get("gen_video") if gen_video is None else bool(gen_video)
        md = meta.get("mode") if mode is None else (mode or "").strip()
        rr = meta.get("requires_ref") if requires_ref is None else bool(requires_ref)
        dn = meta.get("cn_name") if cn_name is None else (cn_name or "").strip()
        new_meta = {
            "name": (name or "").strip() or sid,
            "cn_name": dn or None,
            "tags": list(tags or []),
            "description": meta.get("description", ""),
            "inputs": meta.get("inputs"),
            "max_tokens": meta.get("max_tokens"),
            "result_key": meta.get("result_key"),
            "multi_result": meta.get("multi_result"),
            "multi_turn": mt or None,
            "category": cat or None,
            "gen_image": gi or None,
            "gen_video": gv or None,
            "mode": md or None,
            "requires_ref": rr or None,
            "ratio": meta.get("ratio"),
            "created_at": meta.get("created_at") or datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        new_meta = {k: v for k, v in new_meta.items() if v is not None}
        text = serialize_frontmatter(new_meta, content or "")
        main = _main_md_name(d) or "skill.md"
        with open(os.path.join(d, main), 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
    return True


def save_skill_file(skill_id: str, filename: str, content: str) -> bool:
    """保存 skill 目录内的某个 .md 文件。"""
    d = _skill_dir(skill_id)
    if not d:
        return False
    target = _safe_skill_file_path(d, filename)
    if not target:
        return False
    with _skills_lock:
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'w', encoding='utf-8', newline='\n') as f:
                f.write(content or "")
        except Exception as e:
            logger.error(f"Error saving skill file {target}: {e}")
            return False
    return True


def delete_skill_file(skill_id: str, filename: str) -> bool:
    """删除 skill 目录内某个 .md 文件（不允许删 skill.md）。"""
    d = _skill_dir(skill_id)
    if not d:
        return False
    fn = (filename or "").replace("\\", "/")
    if fn.lower() == "skill.md":
        return False
    target = _safe_skill_file_path(d, fn)
    if not target or not os.path.isfile(target):
        return False
    with _skills_lock:
        os.remove(target)
    return True


def delete_skill(skill_id: str) -> tuple[bool, str]:
    """删除整个 skill 目录。预设不可删。返回 (success, message)。"""
    sid = _normalize_skill_id(skill_id)
    if not sid:
        return False, "Invalid skill id"
    with _skills_lock:
        for base in (SKILL_CUSTOM_DIR, SKILL_PRESETS_DIR):
            d = os.path.join(base, sid)
            if os.path.isdir(d):
                if os.path.basename(base) == "presets":
                    return False, "Cannot delete preset skill"
                shutil.rmtree(d)
                return True, "deleted"
    return False, "Skill not found"


# ==========================================
# 生图技能：工作流模板导出 / 每技能 config.json
# ==========================================

def load_skill_workflow(skill_id: str):
    """读 skill 的 workflow.json（API prompt 模板）；缺失或非法返回 None。"""
    d = _skill_dir(str(skill_id or ""))
    if not d:
        return None
    try:
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            wf = json.load(f)
    except Exception:
        return None
    return wf if isinstance(wf, dict) and wf else None


def _read_config_file(skill_dir: str) -> dict:
    """读技能目录下的 config.json；缺失或损坏返回 {}。"""
    try:
        with open(os.path.join(skill_dir, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return {}
    return cfg if isinstance(cfg, dict) else {}


def _override_path(sid: str) -> str:
    """预设技能本地配置覆盖文件路径（configs/skill_overrides/<id>.json）。"""
    return os.path.join(SKILL_OVERRIDES_DIR, f"{sid}.json")


def _read_override(sid: str) -> dict:
    """读预设技能的本地配置覆盖；缺失或损坏返回 {}。"""
    try:
        with open(_override_path(sid), encoding="utf-8") as f:
            ov = json.load(f)
    except Exception:
        return {}
    return ov if isinstance(ov, dict) else {}


def get_skill_gen_config(skill_id: str) -> dict:
    """读 skill 的生图/生视频设置：预设 = 自身 config.json ⊕ 本地覆盖文件；缺失或损坏返回 {}。"""
    d = _skill_dir(str(skill_id or ""))
    if not d:
        return {}
    cfg = _read_config_file(d)
    if _skill_source(d) == "presets":
        ov = _read_override(_normalize_skill_id(str(skill_id or "")))
        if ov:
            cfg = {**cfg, **ov}
    return cfg


def _effective_gen_config(skill_id: str, is_video: bool) -> dict:
    """技能的有效生图/生视频设置 = 全局默认 ⊕ 技能 config（含预设本地覆盖）⊕ 空模型名的自动挑选。

    「导入到画布」灌 widget 用的就是这套值（web/skill.js 的 workflowParamValues + listGenModels 的
    suggested_*），所以它同时是画布打开时的基线：回写比对以它为基准，编码器 / VAE / 输出前缀 /
    张数 / 视频尺寸这些不落 config.json 的默认值才不会被报成「空 → 值」的假变更。
    image_gen 惰性导入：单测单独加载 skill.py 时不拉起 comfy 依赖。"""
    from .image_gen import get_settings, resolve_model
    eff = get_settings()
    eff.update(get_skill_gen_config(skill_id))
    for key, folder in (("model", "diffusion_models"), ("text_encoder", "text_encoders"), ("vae", "vae")):
        resolved, err = resolve_model(folder, eff.get(key))
        if not err and resolved:
            eff[key] = resolved
    if is_video:
        # 视频尺寸/时长默认值与前端导入回落值一致：config.json 没有这三键时画布灌的就是它们
        for key, default in (("width", 1344), ("height", 768), ("length", 124)):
            if not isinstance(eff.get(key), int) or eff[key] < 1:
                eff[key] = default
    return eff


def has_skill_config_override(skill_id: str) -> bool:
    """预设技能是否存在本地配置覆盖（UI 的「已修改」标记 / 恢复默认按钮）。"""
    sid = _normalize_skill_id(str(skill_id or ""))
    d = _skill_dir(sid) if sid else None
    return bool(d and _skill_source(d) == "presets" and os.path.isfile(_override_path(sid)))


def reset_skill_gen_config(skill_id: str) -> tuple[bool, str]:
    """预设技能生图/生视频设置恢复默认：删除本地覆盖文件（幂等）。返回 (success, message)。"""
    sid = _normalize_skill_id(str(skill_id or ""))
    d = _skill_dir(sid) if sid else None
    if not d:
        return False, "Skill not found"
    with _skills_lock:
        p = _override_path(sid)
        if os.path.isfile(p):
            os.remove(p)
    return True, ""


def _clean_lora_entries(loras) -> list:
    """LoRA 条目规范化为 [{name, strength}]：空名跳过，强度夹到 [-10, 10]。"""
    out = []
    for entry in loras or []:
        name = str((entry or {}).get("name") or "").strip() if isinstance(entry, dict) else str(entry or "").strip()
        if not name:
            continue
        try:
            strength = float((entry or {}).get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        out.append({"name": name[:256], "strength": max(-10.0, min(10.0, strength))})
    return out


def save_skill_gen_config(skill_id: str, cfg: dict) -> tuple[bool, str]:
    """写 skill 的生图/生视频设置：自定义写自身 config.json，预设写本地覆盖文件（不改预设文件）。返回 (success, message)。"""
    sid = _normalize_skill_id(str(skill_id or ""))
    d = _skill_dir(sid) if sid else None
    if not d:
        return False, "Skill not found"
    is_preset = _skill_source(d) == "presets"
    cfg = cfg if isinstance(cfg, dict) else {}
    clean = {}
    for key in ("model", "text_encoder", "vae", "audio_vae"):
        value = str(cfg.get(key) or "").strip()
        if value:
            clean[key] = value[:256]
    loras = _clean_lora_entries(cfg.get("loras"))
    if loras:
        clean["loras"] = loras
    for key in ("base_resolution", "count"):
        try:
            clean[key] = max(1, int(cfg.get(key)))
        except (TypeError, ValueError):
            continue
    ratio = str(cfg.get("default_ratio") or "").strip()
    if ratio:
        clean["default_ratio"] = ratio[:32]
    prefix = str(cfg.get("output_prefix") or "").strip()
    if prefix:
        clean["output_prefix"] = prefix[:128]
    if cfg.get("enhance_prompt"):
        clean["enhance_prompt"] = True
    with _skills_lock:
        # width/height/length/steps 是视频 skill 的尺寸/时长/采样步数默认值，非模型设置区管理；保存时保留既有有效值（预设取合并后的有效 config）
        existing = get_skill_gen_config(sid) if is_preset else _read_config_file(d)
        for key in ("width", "height", "length", "steps"):
            val = cfg.get(key, existing.get(key))
            try:
                clean[key] = max(1, int(val))
            except (TypeError, ValueError):
                continue
        target = _override_path(sid) if is_preset else os.path.join(d, "config.json")
        if is_preset:
            os.makedirs(SKILL_OVERRIDES_DIR, exist_ok=True)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(clean, f, indent=2, ensure_ascii=False)
        os.replace(tmp, target)
    return True, ""


def _node_sort_key(nid):
    try:
        return (0, int(str(nid)), "")
    except (TypeError, ValueError):
        return (1, 0, str(nid))


def _model_consumer(workflow: dict, src_id: str):
    """model 输入连到 src 输出的 LoraLoaderModelOnly 节点 id；无则 None。"""
    best = None
    for nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "LoraLoaderModelOnly":
            continue
        v = (node.get("inputs") or {}).get("model")
        if isinstance(v, list) and len(v) == 2 and v[0] == str(src_id):
            if best is None or _node_sort_key(nid) < _node_sort_key(best):
                best = nid
    return best


def _main_lora_chain(workflow: dict) -> list:
    """主链 LoRA 节点 id（UNETLoader → LoraLoaderModelOnly* 串联），按链序。"""
    chain = []
    for unet_id in sorted((nid for nid, n in workflow.items()
                           if isinstance(n, dict) and n.get("class_type") == "UNETLoader"),
                          key=_node_sort_key):
        cur = unet_id
        while True:
            nxt = _model_consumer(workflow, cur)
            if not nxt:
                break
            chain.append(nxt)
            cur = nxt
    return chain


def _lora_slot_count(template) -> int:
    """技能已存模板自带的 LoRA 槽位数：画布导入时先灌这些槽位，多出来的 config.loras 才是注入的。"""
    if not isinstance(template, dict):
        return 0
    return len(_main_lora_chain(template))


def _strip_runtime_loras(workflow: dict, cfg_loras, slots: int = 0) -> tuple[dict, list]:
    """剥离画布里运行时注入的主链 LoRA 节点，返回 (剥离后的 workflow, 注入节点的 lora 条目)。

    前端「导入到画布」按 config.loras 灌 LoRA：先填模板自带的 {{LORA_i_NAME}} 槽位，超出槽位的
    部分在主链末端注入（web injectRuntimeLoras / image_gen._apply_loras 同一套）。所以链上槽位
    之后的 len(config.loras) - slots 个节点就是程序注入的 —— 判据是数量，widget 里被改过的具体
    名一样算（按名字匹配会让「只改 LoRA 值」报成新增节点，也会把模板自带槽位整条删掉）。
    剥离是注入的逆操作：下游 model 输入接回它的 model 来源；剥下来的 name/strength 交回
    config.loras，改 LoRA 值只报 loras 变更，不报「节点 0→1」「连线数」假变更。"""
    n_cfg = sum(1 for l in (cfg_loras or []) if isinstance(l, dict) and l.get("name"))
    chain = _main_lora_chain(workflow)
    n_strip = min(max(n_cfg - slots, 0), max(len(chain) - slots, 0))
    targets = [nid for nid in chain[len(chain) - n_strip:]
               if "{{" not in str((workflow[nid].get("inputs") or {}).get("lora_name") or "")]
    if not targets:
        return workflow, []
    wf = copy.deepcopy(workflow)
    entries = []
    for nid in reversed(targets):
        inputs = wf[nid].get("inputs") or {}
        src = inputs.get("model")
        if isinstance(src, list) and len(src) == 2:
            for n in wf.values():
                if not isinstance(n, dict):
                    continue
                for k, v in (n.get("inputs") or {}).items():
                    if isinstance(v, list) and len(v) == 2 and v[0] == nid:
                        n["inputs"][k] = [src[0], v[1]]
        try:
            strength = float(inputs.get("strength_model", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        entries.append({"name": str(inputs.get("lora_name") or ""), "strength": strength})
        del wf[nid]
    entries.reverse()
    return wf, [e for e in entries if e["name"]]


def _reaches_load_image(workflow: dict, node_id: str) -> bool:
    """节点输入链路（沿所有连线回溯）是否到达 LoadImage；用于识别参考图缩放节点。"""
    stack, seen = [str(node_id)], set()
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        node = workflow.get(nid)
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == "LoadImage":
            return True
        for v in (node.get("inputs") or {}).values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                stack.append(v[0])
    return False


_AUTOGROW_SLOT_KEY_RE = re.compile(r"^([a-z_]+)\.([a-z_]+)_(\d+)$")


def _ref_slot_tokens(workflow: dict) -> dict:
    """LoadImage 节点 → 参考占位符：按 Autogrow 消费者的槽位序号编号，
    画布 ⇄ 技能往返保住槽位序号（槽基址随模板：Qwen 1 基 images.image_1，minimax 0 基 ref_images.ref_image_0）；
    单张参考（含无槽位消费者的混合情况）沿用 {{REF_IMAGE}}。"""
    refs = [nid for nid, n in workflow.items()
            if isinstance(n, dict) and n.get("class_type") == "LoadImage"
            and isinstance((n.get("inputs") or {}).get("image"), str)]
    slot_of = {}
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        for key, value in (node.get("inputs") or {}).items():
            m = _AUTOGROW_SLOT_KEY_RE.match(key)
            if m and isinstance(value, list) and len(value) == 2:
                slot_of.setdefault(str(value[0]), int(m.group(3)))
    if len(refs) < 2 or any(nid not in slot_of for nid in refs):
        return {nid: "{{REF_IMAGE}}" for nid in refs}
    order = sorted(refs, key=lambda nid: (slot_of[nid], _node_sort_key(nid)))
    return {nid: f"{{{{REF_IMAGE_{i + 1}}}}}" for i, nid in enumerate(order)}


_COMMON_RATIOS = (("1:1", 1.0), ("16:9", 16 / 9), ("9:16", 9 / 16),
                  ("4:3", 4 / 3), ("3:4", 3 / 4), ("3:2", 3 / 2), ("2:3", 2 / 3))


def _ratio_label(w: int, h: int) -> str:
    if w <= 0 or h <= 0:
        return ""
    value = w / h
    for label, target in _COMMON_RATIOS:
        if abs(value - target) < 0.01:
            return label
    return f"{w}:{h}"


# 画布导出成技能时的可选占位符（预设 image_gen_text_subject 的写法）：写死文本的提示词节点，
# 和给 latent 供宽高的 ResolutionSelector（百万像素 + 比例）。候选由「从画布创建技能」对话框逐项
# 勾选，勾中的才写进模板；回写按已存模板同一节点同一字段的占位符复原勾选。这份选择不进
# config.json —— 设置区保存是整文件白名单重写，写进去会被擦掉。
_PROMPT_TEXT_FIELDS = {"PrimitiveString": "value", "PrimitiveStringMultiline": "value", "StringLiteral": "value"}
_LATENT_SIZE_CLASSES = ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyFlux2LatentImage",
                        "EmptyHunyuanLatentImage", "EmptyLTXVLatentImage", "EmptyMochiLatentVideo")
_BIND_TOKENS = ("PROMPT", "NEGATIVE", "WIDTH", "HEIGHT", "MEGAPIXELS", "ASPECT_RATIO")
_PROMPT_HOPS = 4  # 文本节点到 CLIPTextEncode 之间允许穿过的透传层数（PreviewAny / ComfySwitchNode / ComfyGateway）


def _clip_bind_sides(workflow: dict) -> dict:
    """CLIPTextEncode → 该填的占位符名：按采样器 positive / negative 的连线判定；
    没连到采样器的沿用「第一个正向、其余负向」的既有约定。"""
    sides = {}
    for node in workflow.values():
        if not isinstance(node, dict) or node.get("class_type") not in ("KSampler", "KSamplerAdvanced"):
            continue
        for key, token in (("positive", "PROMPT"), ("negative", "NEGATIVE")):
            link = (node.get("inputs") or {}).get(key)
            if isinstance(link, list) and len(link) == 2:
                sides.setdefault(str(link[0]), token)
    order = 0
    for nid, node in workflow.items():
        if isinstance(node, dict) and node.get("class_type") == "CLIPTextEncode":
            sides.setdefault(nid, "PROMPT" if order == 0 else "NEGATIVE")
            order += 1
    return sides


def _string_source_node(workflow: dict, start_id: str) -> str | None:
    """沿连线反向找写死文本的节点：预览 / 开关 / 网关这类透传节点不改文本，最多回溯 _PROMPT_HOPS 层。"""
    queue, seen = [(start_id, 0)], {start_id}
    while queue:
        nid, depth = queue.pop(0)
        node = workflow.get(nid)
        if not isinstance(node, dict):
            continue
        field = _PROMPT_TEXT_FIELDS.get(node.get("class_type"))
        if field and isinstance((node.get("inputs") or {}).get(field), str):
            return nid
        if depth >= _PROMPT_HOPS:
            continue
        for link in (node.get("inputs") or {}).values():
            if isinstance(link, list) and len(link) == 2 and isinstance(link[0], str) and link[0] not in seen:
                seen.add(link[0])
                queue.append((link[0], depth + 1))
    return None


def _selector_ratio_label(value) -> str:
    """ResolutionSelector 的 combo 值 "16:9 (Widescreen)" → 技能设置用的 "16:9"；非比例写法返回 ""。"""
    pair = ratio_pair(value)
    return f"{pair[0]:g}:{pair[1]:g}" if pair else ""


def _base_resolution_from_mp(label: str, megapixels: float) -> int:
    """combo 的比例 + 百万像素 → 技能设置的 base_resolution（size_from_ratio 的长边，对齐 16）：
    16:9 @ 1.05MP 要开在 sqrt(mp * 长宽比) 上，直接取 sqrt(mp) 出来的图会小一档。"""
    pair = ratio_pair(label)
    if not pair or megapixels <= 0:
        return 0
    value = pair[0] / pair[1]
    long_side = (megapixels * 1024 * 1024 * max(value, 1 / value)) ** 0.5
    return max(256, int(long_side / 16 + 0.5) * 16)


def _bind_candidates(workflow: dict) -> list:
    """画布里可替换成占位符的 widget 候选：提示词原文节点 + 输出尺寸的 ResolutionSelector。
    候选在导入对话框里显示成「节点 #id · 字段 = 当前值 → {{TOKEN}}」，由用户勾选。"""
    out = []
    sides = _clip_bind_sides(workflow)
    for nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "CLIPTextEncode":
            continue
        link = (node.get("inputs") or {}).get("text")
        if not (isinstance(link, list) and len(link) == 2 and isinstance(link[0], str)):
            continue  # 文本就写在 CLIPTextEncode 自己身上，固定规则已经替换
        src = _string_source_node(workflow, link[0])
        if not src:
            continue
        field = _PROMPT_TEXT_FIELDS[workflow[src]["class_type"]]
        value = workflow[src]["inputs"][field]
        if not value.strip():
            continue
        out.append({"node": src, "field": field, "token": sides.get(nid, "PROMPT"),
                    "class_type": str(workflow[src].get("class_type")), "value": value})
    for nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "ResolutionSelector":
            continue
        feeds_latent = any(isinstance(link, list) and len(link) == 2 and link[0] == nid
                           and str(n.get("class_type")) in _LATENT_SIZE_CLASSES
                           for n in workflow.values() if isinstance(n, dict)
                           for link in (n.get("inputs") or {}).values())
        if not feeds_latent:
            continue
        inputs = node.get("inputs") or {}
        megapixels = inputs.get("megapixels")
        has_mp = isinstance(megapixels, (int, float)) and not isinstance(megapixels, bool)
        ratio = inputs.get("aspect_ratio")
        label = _selector_ratio_label(ratio)
        # 技能里真正要存的两项是 base_resolution / default_ratio（同一份算式在 _template_from_workflow
        # 写进 config.json）。候选不带这两项，对话框上的 megapixels 就会被读成「技能里的那一项设置」，
        # 而技能设置面板与 config.json 里都没有 megapixels 这个键。
        base = _base_resolution_from_mp(label, float(megapixels)) if has_mp and label else 0
        if has_mp:
            out.append({"node": nid, "field": "megapixels", "token": "MEGAPIXELS",
                        "class_type": "ResolutionSelector", "value": megapixels,
                        "setting": {"key": "base_resolution", "value": base} if base else {}})
        if isinstance(ratio, str) and label in ASPECT_LABELS:
            out.append({"node": nid, "field": "aspect_ratio", "token": "ASPECT_RATIO",
                        "class_type": "ResolutionSelector", "value": ratio,
                        "setting": {"key": "default_ratio", "value": label}})
    return out


def _apply_bindings(template: dict, bindings) -> None:
    """按勾选写入占位符：只认 _BIND_TOKENS 里的名字，节点与字段必须是模板里已有的标量。"""
    for item in bindings or []:
        if not isinstance(item, dict):
            continue
        token = str(item.get("token") or "")
        node = template.get(str(item.get("node") or ""))
        if token not in _BIND_TOKENS or not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        field = str(item.get("field") or "")
        value = inputs.get(field)
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            continue
        inputs[field] = "{{%s}}" % token


def _bound_bindings(old_wf: dict, workflow: dict) -> list:
    """回写时复原创建时的勾选：候选里只保留已存模板同一节点同一字段已经是占位符的那些。"""
    wanted = {(str(c["node"]), str(c["field"]), str(c["token"])): c for c in _bind_candidates(workflow)}
    out = []
    for nid, node in (old_wf or {}).items():
        if not isinstance(node, dict):
            continue
        for key, value in (node.get("inputs") or {}).items():
            text = str(value)
            if not (text.startswith("{{") and text.endswith("}}")):
                continue
            entry = wanted.get((str(nid), str(key), text[2:-2]))
            if entry:
                out.append(entry)
    return out


def _template_from_workflow(workflow: dict, bindings=None) -> tuple[dict, list, dict]:
    """把 API prompt 转成模板：已知值替换为占位符、主链 LoRA 编为 {{LORA_i_*}} 槽位。

    bindings 是「从画布创建技能」对话框勾选的可选占位符（_bind_candidates 的候选项），
    在固定规则之后写入。
    返回 (template, warnings, seed_cfg)；seed_cfg 是从加载器/LoRA/latent 尺寸/SaveImage
    前缀提取的 config.json 初值（只含非空项）。"""
    template = copy.deepcopy(workflow)
    warnings = []
    seed_cfg = {}
    ref_tokens = _ref_slot_tokens(workflow)

    clip_nodes = [nid for nid, n in workflow.items()
                  if isinstance(n, dict) and n.get("class_type") == "CLIPTextEncode"]
    if not clip_nodes:
        warnings.append("工作流没有 CLIPTextEncode 节点，运行时无法注入提示词")
    for i, nid in enumerate(clip_nodes):
        inputs = template[nid]["inputs"]
        if isinstance(inputs.get("text"), str):
            inputs["text"] = "{{PROMPT}}" if i == 0 else "{{NEGATIVE}}"

    for nid, node in workflow.items():
        ct = node.get("class_type")
        inputs = template[nid]["inputs"]
        if ct == "UNETLoader" and isinstance(inputs.get("unet_name"), str):
            seed_cfg.setdefault("model", inputs["unet_name"])
            inputs["unet_name"] = "{{MODEL}}"
        elif ct == "CLIPLoader" and isinstance(inputs.get("clip_name"), str):
            seed_cfg.setdefault("text_encoder", inputs["clip_name"])
            inputs["clip_name"] = "{{TEXT_ENCODER}}"
        elif ct == "VAELoader" and isinstance(inputs.get("vae_name"), str):
            seed_cfg.setdefault("vae", inputs["vae_name"])
            inputs["vae_name"] = "{{VAE}}"
        elif ct in ("KSampler", "KSamplerAdvanced") and "seed" in inputs:
            inputs["seed"] = "{{SEED}}"
        elif ct in _LATENT_SIZE_CLASSES:
            if isinstance(inputs.get("width"), int) and isinstance(inputs.get("height"), int):
                seed_cfg.setdefault("default_ratio", _ratio_label(inputs["width"], inputs["height"]))
            if isinstance(inputs.get("batch_size"), int):
                seed_cfg.setdefault("count", inputs["batch_size"])
            for key, token in (("width", "{{WIDTH}}"), ("height", "{{HEIGHT}}"), ("batch_size", "{{COUNT}}")):
                if isinstance(inputs.get(key), int):
                    inputs[key] = token
        elif ct == "ResolutionSelector":
            # 尺寸由 combo（比例 + 百万像素）算出来时，config 里记的是这条链的真实输出
            label = _selector_ratio_label(inputs.get("aspect_ratio"))
            megapixels = inputs.get("megapixels")
            if label and isinstance(megapixels, (int, float)) and not isinstance(megapixels, bool):
                seed_cfg.setdefault("default_ratio", label)
                seed_cfg.setdefault("base_resolution", _base_resolution_from_mp(label, float(megapixels)))
        elif ct == "SaveImage" and isinstance(inputs.get("filename_prefix"), str):
            seed_cfg.setdefault("output_prefix", inputs["filename_prefix"])
            inputs["filename_prefix"] = "{{PREFIX}}"
        elif ct == "LoadImage" and isinstance(inputs.get("image"), str):
            inputs["image"] = ref_tokens[nid]

    if not any(isinstance(n, dict) and n.get("class_type") == "SaveImage" for n in workflow.values()):
        warnings.append("工作流没有 SaveImage 节点，将无法收集输出图片")

    # 主链 LoRA：UNETLoader → LoraLoaderModelOnly* 链按序编号为槽位
    loras = []
    slot = 0
    unet_ids = sorted((nid for nid, n in workflow.items()
                       if isinstance(n, dict) and n.get("class_type") == "UNETLoader"),
                      key=_node_sort_key)
    for unet_id in unet_ids:
        cur = unet_id
        while True:
            nxt = _model_consumer(workflow, cur)
            if not nxt:
                break
            slot += 1
            orig = workflow[nxt]["inputs"]
            try:
                strength = float(orig.get("strength_model", 1.0))
            except (TypeError, ValueError):
                strength = 1.0
            loras.append({"name": str(orig.get("lora_name") or ""), "strength": strength})
            template[nxt]["inputs"]["lora_name"] = "{{LORA_%d_NAME}}" % slot
            template[nxt]["inputs"]["strength_model"] = "{{LORA_%d_STRENGTH}}" % slot
            cur = nxt
    if loras:
        seed_cfg["loras"] = [l for l in loras if l["name"]]

    _apply_bindings(template, bindings)
    return template, warnings, seed_cfg


def _is_h3_video_workflow(workflow: dict) -> bool:
    """画布工作流是否为 MiniMax H3 视频（T2V/I2V/R2V）：有 H3 *ToVideo 入口，或 CreateVideo+VAEDecodeAudio。"""
    types = set()
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type") or "")
        if not ct:
            continue
        types.add(ct)
        if ct.startswith("MiniMaxH3") and (ct.endswith("ImageToVideo") or ct.endswith("ReferenceToVideo")):
            return True
    return "CreateVideo" in types and "VAEDecodeAudio" in types


def _template_video_from_workflow(workflow: dict) -> tuple[dict, list, dict]:
    """H3 视频工作流 → 模板：UNETLoader→{{MODEL}}、CLIPLoader→{{TEXT_ENCODER}}、
    VAELoader（喂 VAEDecodeAudio 的→{{AUDIO_VAE}}，其余→{{VAE}}）、MiniMaxH3* 入口 prompt/width/height/length
    →占位符、KSampler seed→{{SEED}}、LoadImage→{{REF_IMAGE}} / {{REF_IMAGE_n}} 槽位、主链 LoRA→{{LORA_i_*}} 槽位。

    返回 (template, warnings, seed_cfg)；约定与 _template_from_workflow 一致（seed_cfg 只含非空项）。"""
    template = copy.deepcopy(workflow)
    warnings = []
    seed_cfg = {}
    ref_tokens = _ref_slot_tokens(workflow)

    # H3 音频是独立 VAE：喂给 VAEDecodeAudio.vae 的 VAELoader 才是音频 VAE，不能复用视频 VAE
    audio_vae_ids = set()
    for nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "VAEDecodeAudio":
            continue
        vae = (node.get("inputs") or {}).get("vae")
        if isinstance(vae, list) and len(vae) == 2:
            audio_vae_ids.add(str(vae[0]))

    for nid, node in workflow.items():
        ct = node.get("class_type")
        inputs = template[nid]["inputs"]
        if ct == "UNETLoader" and isinstance(inputs.get("unet_name"), str):
            seed_cfg.setdefault("model", inputs["unet_name"])
            inputs["unet_name"] = "{{MODEL}}"
        elif ct == "CLIPLoader" and isinstance(inputs.get("clip_name"), str):
            seed_cfg.setdefault("text_encoder", inputs["clip_name"])
            inputs["clip_name"] = "{{TEXT_ENCODER}}"
        elif ct == "VAELoader" and isinstance(inputs.get("vae_name"), str):
            if nid in audio_vae_ids:
                seed_cfg.setdefault("audio_vae", inputs["vae_name"])
                inputs["vae_name"] = "{{AUDIO_VAE}}"
            else:
                seed_cfg.setdefault("vae", inputs["vae_name"])
                inputs["vae_name"] = "{{VAE}}"
        elif ct.startswith("MiniMaxH3"):
            # prompt 无论字符串还是连线都替换为运行时 {{PROMPT}}（断开原提示词来源节点，由 NeoH3VideoDirector 注入）
            if "prompt" in inputs:
                inputs["prompt"] = "{{PROMPT}}"
            for key, token in (("width", "{{WIDTH}}"), ("height", "{{HEIGHT}}"), ("length", "{{LENGTH}}")):
                v = inputs.get(key)
                if isinstance(v, int):
                    seed_cfg.setdefault(key, v)
                    inputs[key] = token
                elif isinstance(v, str) and v.isdigit():
                    seed_cfg.setdefault(key, int(v))
                    inputs[key] = token
        elif ct in ("KSampler", "KSamplerAdvanced") and "seed" in inputs:
            inputs["seed"] = "{{SEED}}"
        elif ct == "LoadImage" and isinstance(inputs.get("image"), str):
            inputs["image"] = ref_tokens[nid]
        elif ct in ("LoadVideo", "LoadAudio"):
            # 参考视频/音频槽位：占位文件通常不在 input 目录里，灌画布会整节点红框 → 导出即默认跳过（bypass）
            template[nid]["mode"] = 4

    if not seed_cfg.get("model"):
        warnings.append("工作流没有 UNETLoader，运行时无法注入视频模型")
    if not seed_cfg.get("text_encoder"):
        warnings.append("工作流没有 CLIPLoader，运行时无法注入文本编码器")
    if not seed_cfg.get("vae"):
        warnings.append("工作流没有视频 VAELoader，运行时无法注入 VAE")

    # 主链 LoRA：与生图一致，UNETLoader → LoraLoaderModelOnly* 按序编为 {{LORA_i_*}} 槽位
    loras = []
    slot = 0
    unet_ids = sorted((nid for nid, n in workflow.items()
                       if isinstance(n, dict) and n.get("class_type") == "UNETLoader"),
                      key=_node_sort_key)
    for unet_id in unet_ids:
        cur = unet_id
        while True:
            nxt = _model_consumer(workflow, cur)
            if not nxt:
                break
            slot += 1
            orig = workflow[nxt]["inputs"]
            try:
                strength = float(orig.get("strength_model", 1.0))
            except (TypeError, ValueError):
                strength = 1.0
            loras.append({"name": str(orig.get("lora_name") or ""), "strength": strength})
            template[nxt]["inputs"]["lora_name"] = "{{LORA_%d_NAME}}" % slot
            template[nxt]["inputs"]["strength_model"] = "{{LORA_%d_STRENGTH}}" % slot
            cur = nxt
    if loras:
        seed_cfg["loras"] = [l for l in loras if l["name"]]

    return template, warnings, seed_cfg


def save_workflow_skill(name: str, description: str, tags, workflow: dict, bindings=None) -> dict:
    """把当前画布工作流（API prompt）导出为生图技能：skill.md + workflow.json + config.json。

    bindings 是导入对话框勾选的可选占位符，见 _bind_candidates。"""
    if not isinstance(workflow, dict) or not workflow:
        return {"success": False, "message": "workflow 不是合法的 API prompt"}
    for nid, node in workflow.items():
        if not isinstance(node, dict) or not node.get("class_type") or not isinstance(node.get("inputs"), dict):
            return {"success": False, "message": f"节点 {nid} 缺少 class_type/inputs"}
    is_video = _is_h3_video_workflow(workflow)
    if is_video:
        template, warnings, seed_cfg = _template_video_from_workflow(workflow)
    else:
        template, warnings, seed_cfg = _template_from_workflow(workflow, bindings)
    has_ref = any(isinstance(v, str) and "{{REF_IMAGE" in v
                  for n in template.values() if isinstance(n, dict)
                  for v in (n.get("inputs") or {}).values())

    base_id = _normalize_skill_id(str(name or "")) or "workflow-skill"
    sid, i = base_id, 2
    while os.path.isdir(os.path.join(SKILL_CUSTOM_DIR, sid)):
        sid = f"{base_id}-{i}"
        i += 1
    title = str(name or "").strip()
    meta = {
        "name": sid,
        "cn_name": title or None,
        "tags": [str(t) for t in (tags if isinstance(tags, list) else [])],
        "description": str(description or ""),
        # 视频 I2V 需要首帧参考图（对齐内置 minimax_h3_i2v preset）；生图四视图沿用既有 inputs=["text"]+requires_ref 行为
        "inputs": (["image", "text"] if has_ref else ["text"]) if is_video else ["text"],
        "category": "video_gen" if is_video else "image_gen",
    }
    meta["gen_video" if is_video else "gen_image"] = True
    if has_ref:
        meta["requires_ref"] = True
    with _skills_lock:
        d = os.path.join(SKILL_CUSTOM_DIR, sid)
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, "skill.md.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(serialize_frontmatter(meta, str(description or "")))
        os.replace(tmp, os.path.join(d, "skill.md"))
        tmp = os.path.join(d, "workflow.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(template, f, indent=2, ensure_ascii=False)
        os.replace(tmp, os.path.join(d, "workflow.json"))
        if seed_cfg:
            tmp = os.path.join(d, "config.json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(seed_cfg, f, indent=2, ensure_ascii=False)
            os.replace(tmp, os.path.join(d, "config.json"))
    return {"success": True, "id": sid, "warnings": warnings, "gen_video": is_video}


def plan_workflow_skill(workflow: dict) -> dict:
    """「从画布创建技能」的导出预览：视频判定 + 可替换成占位符的 widget 候选，不落盘。

    候选就是给用户勾选的那份清单（提示词原文节点、输出尺寸的 ResolutionSelector），
    视频模板按视频固定规则替换，没有可选项。"""
    if not isinstance(workflow, dict) or not workflow:
        return {"success": False, "message": "workflow 不是合法的 API prompt"}
    for nid, node in workflow.items():
        if not isinstance(node, dict) or not node.get("class_type") or not isinstance(node.get("inputs"), dict):
            return {"success": False, "message": f"节点 {nid} 缺少 class_type/inputs"}
    is_video = _is_h3_video_workflow(workflow)
    warnings = []
    if not is_video and not any(isinstance(n, dict) and n.get("class_type") == "CLIPTextEncode"
                                for n in workflow.values()):
        warnings.append("工作流没有 CLIPTextEncode 节点，运行时无法注入提示词")
    return {"success": True, "gen_video": is_video, "warnings": warnings,
            "candidates": [] if is_video else _bind_candidates(workflow)}


def _workflow_update_guard(skill_id: str, workflow: dict) -> tuple[str, str, str]:
    """回写/预览共用守卫：返回 (skill_id, 技能目录, 拒绝消息)；消息非空即不可回写。

    预设技能可回写模型值（写 configs/skill_overrides/），结构由调用方按 structural 决定去向。
    """
    sid = _normalize_skill_id(str(skill_id or ""))
    d = _skill_dir(sid) if sid else None
    if not d:
        return "", "", "Skill not found"
    if not isinstance(workflow, dict) or not workflow:
        return "", "", "workflow 不是合法的 API prompt"
    for nid, node in workflow.items():
        if not isinstance(node, dict) or not node.get("class_type") or not isinstance(node.get("inputs"), dict):
            return "", "", f"节点 {nid} 缺少 class_type/inputs"
    return sid, d, ""


def _lora_label(loras) -> str:
    if not isinstance(loras, list) or not loras:
        return "（无）"
    return "、".join(f"{l.get('name')}×{l.get('strength', 1)}"
                     for l in loras if isinstance(l, dict))


def _same_ratio(old, new) -> bool:
    """比例按数值判等（容差 1%，与 _ratio_label 一致）：画布 1296:736 与技能里的 16:9 是同一比例。"""
    from .image_gen import parse_ratio
    a, b = parse_ratio(old), parse_ratio(new)
    if a is None or b is None:
        return str(old or "").strip() == str(new or "").strip()
    return abs(a - b) <= 0.01 * max(a, b)


def _config_changes(base_cfg: dict, new_cfg: dict) -> list:
    """画布提取值相对基线（_effective_gen_config）的键变更清单：只列画布提供的键，值没变不记。"""
    changes = []
    for key, new in new_cfg.items():
        old = base_cfg.get(key)
        if key == "loras":
            old_label, new_label = _lora_label(old), _lora_label(new)
            if old_label != new_label:
                changes.append({"field": "loras", "from": old_label, "to": new_label})
        elif key == "default_ratio":
            if not _same_ratio(old, new):
                changes.append({"field": key, "from": "" if old is None else old, "to": new})
        elif old != new:
            changes.append({"field": key, "from": "" if old is None else old, "to": new})
    return changes


def _node_changes(old_wf: dict, new_wf: dict) -> list:
    """旧模板 ⇄ 新模板的结构差异：按 class_type 计数 + 连线数（widget 值差异由 config 变更覆盖）。"""
    def counts(wf):
        c = {}
        for n in wf.values():
            if not isinstance(n, dict):
                continue
            ct = str(n.get("class_type") or "")
            if ct:
                c[ct] = c.get(ct, 0) + 1
        return c

    def links(wf):
        return sum(1 for n in wf.values() if isinstance(n, dict)
                   for v in (n.get("inputs") or {}).values()
                   if isinstance(v, list) and len(v) == 2)

    old_c, new_c = counts(old_wf), counts(new_wf)
    changes = [{"field": f"节点 {ct}", "from": f"{old_c.get(ct, 0)} 个", "to": f"{new_c.get(ct, 0)} 个"}
               for ct in sorted(set(old_c) | set(new_c))
               if old_c.get(ct, 0) != new_c.get(ct, 0)]
    old_l, new_l = links(old_wf), links(new_wf)
    if old_l != new_l:
        changes.append({"field": "连线数", "from": old_l, "to": new_l})
    return changes


def _plan_workflow_update(sid: str, d: str, workflow: dict) -> dict:
    """画布 API prompt → 落盘计划：模板、warnings、合并后的 config、变更清单、skill.md 元数据。"""
    is_video = _is_h3_video_workflow(workflow)
    is_preset = _skill_source(d) == "presets"
    old_wf = load_skill_workflow(sid)
    # 画布主链里模板槽位之后的 config.loras 个节点是导入时程序注入的，剥离后不计入模板结构；
    # 剥下来的 name/strength 并回 seed_cfg["loras"]，改 LoRA 值只落 config.json、只报 loras 变更
    workflow, injected_loras = _strip_runtime_loras(
        workflow, (_effective_gen_config(sid, is_video) or {}).get("loras"), _lora_slot_count(old_wf))
    if is_video:
        template, warnings, seed_cfg = _template_video_from_workflow(workflow)
    else:
        # 画布灌 widget 后勾选过的占位符已经是具体值，按已存模板复原勾选再替换
        template, warnings, seed_cfg = _template_from_workflow(workflow, _bound_bindings(old_wf, workflow))
    if injected_loras:
        seed_cfg["loras"] = list(seed_cfg.get("loras") or []) + injected_loras
    has_ref = any(isinstance(v, str) and "{{REF_IMAGE" in v
                  for n in template.values() if isinstance(n, dict)
                  for v in (n.get("inputs") or {}).values())

    meta, body = _read_skill_md(d)
    want_cat = "video_gen" if is_video else "image_gen"
    if meta.get("category") and meta["category"] != want_cat:
        warnings.append("技能分类与画布工作流类型不一致")

    changes = []
    merged_cfg = None
    if seed_cfg:
        old_cfg = _read_config_file(d)
        merged_cfg = {**old_cfg, **seed_cfg}
        # 基线 = 画布打开时的有效配置，不是 config.json 原文：默认值/自动建议模型不算变更
        changes = _config_changes(_effective_gen_config(sid, is_video), seed_cfg)
    node_changes = _node_changes(old_wf, template) if old_wf else []
    changes += node_changes

    rewrite_md = (not is_preset) and bool(meta) and bool(meta.get("requires_ref")) != has_ref
    if rewrite_md:
        changes.append({"field": "requires_ref",
                        "from": "真" if meta.get("requires_ref") else "假",
                        "to": "真" if has_ref else "假"})
        if has_ref:
            meta["requires_ref"] = True
        else:
            meta.pop("requires_ref", None)

    return {"template": template, "warnings": warnings, "meta": meta, "body": body,
            "merged_cfg": merged_cfg, "rewrite_md": rewrite_md,
            "is_video": is_video, "changes": changes, "structural": bool(node_changes)}


def preview_workflow_skill(skill_id: str, workflow: dict) -> dict:
    """回写前预览：与 update_workflow_skill 同一套守卫与变更计算，只算不写。"""
    sid, d, err = _workflow_update_guard(skill_id, workflow)
    if err:
        return {"success": False, "message": err}
    plan = _plan_workflow_update(sid, d, workflow)
    return {"success": True, "id": sid, "warnings": plan["warnings"],
            "gen_video": plan["is_video"], "changes": plan["changes"],
            "preset": _skill_source(d) == "presets", "structural": plan["structural"]}


def update_workflow_skill(skill_id: str, workflow: dict) -> dict:
    """把画布工作流回写入 existing skill：custom 落 workflow.json（skill.md 正文保留）；
    预设只把画布上的模型值写 configs/skill_overrides/，结构变更由前端复制为自定义副本后写入。"""
    sid, d, err = _workflow_update_guard(skill_id, workflow)
    if err:
        return {"success": False, "message": err}
    is_preset = _skill_source(d) == "presets"
    plan = _plan_workflow_update(sid, d, workflow)
    if not is_preset:
        with _skills_lock:
            tmp = os.path.join(d, "workflow.json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(plan["template"], f, indent=2, ensure_ascii=False)
            os.replace(tmp, os.path.join(d, "workflow.json"))
            if plan["rewrite_md"]:
                main = _main_md_name(d)
                tmp = os.path.join(d, main + ".tmp")
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(serialize_frontmatter(plan["meta"], plan["body"]))
                os.replace(tmp, os.path.join(d, main))
    if plan["merged_cfg"]:
        # 与生图/生视频设置区共用写路径（整文件重写）：先垫既有 config.json 再覆盖画布提取值，
        # 保住设置区的 base_resolution / enhance_prompt 等画布不提供的键；预设写本地覆盖文件
        save_skill_gen_config(sid, plan["merged_cfg"])
    return {"success": True, "id": sid, "warnings": plan["warnings"],
            "gen_video": plan["is_video"], "changes": plan["changes"],
            "preset": is_preset, "structural": plan["structural"]}


def copy_skill_files(from_id: str, to_id: str) -> tuple[bool, str]:
    """把 from 技能的 workflow.json / config.json 复制到 to（供「复制为自定义」补全生图模板）；预设源写合并后的有效 config（含本地覆盖）。"""
    src = _skill_dir(str(from_id or ""))
    dst = _skill_dir(str(to_id or ""))
    if not src or not dst:
        return False, "Skill not found"
    copied = 0
    with _skills_lock:
        ws = os.path.join(src, "workflow.json")
        if os.path.isfile(ws):
            shutil.copy2(ws, os.path.join(dst, "workflow.json"))
            copied += 1
        cs = os.path.join(src, "config.json")
        ov_sid = _normalize_skill_id(str(from_id or ""))
        if _skill_source(src) == "presets":
            if os.path.isfile(cs) or os.path.isfile(_override_path(ov_sid)):
                with open(os.path.join(dst, "config.json"), "w", encoding="utf-8") as f:
                    json.dump(get_skill_gen_config(ov_sid), f, indent=2, ensure_ascii=False)
                copied += 1
        elif os.path.isfile(cs):
            shutil.copy2(cs, os.path.join(dst, "config.json"))
            copied += 1
    return True, f"copied {copied} file(s)"


def _model_base_name(name: str) -> str:
    """模型/LoRA 文件名 → 技能命名用名：取路径末段并去扩展名。"""
    n = str(name or "").strip().replace("\\", "/").split("/")[-1]
    return n.rsplit(".", 1)[0] if "." in n else n


def save_combo_as_skill(source_id: str, model: str, loras, ratio: str = "", base_resolution=None) -> dict:
    """把「生成素材」弹窗选中的"主模型 + LoRA"组合存为新自定义技能：
    工作流模板按源技能原样复制；其余生图设置沿用源技能有效 config（预设含本地覆盖），仅覆盖 model/loras，
    弹窗里选定了比例 / 最长边时一并覆盖（未选定沿用源技能）。
    技能名自动生成 = 主模型名 + LoRA 名以 "-" 连接（未选 LoRA 时只有主模型名）。返回 {"success", "id", "name"}。
    """
    src = _skill_dir(str(source_id or ""))
    if not src:
        return {"success": False, "message": "源技能不存在"}
    ws = os.path.join(src, "workflow.json")
    if not os.path.isfile(ws):
        return {"success": False, "message": "源技能没有工作流模板，无法保存为新技能"}

    model = str(model or "").strip()
    clean_loras = _clean_lora_entries(loras)
    if not model and not clean_loras:
        return {"success": False, "message": "请先选择主模型或 LoRA"}

    title = "-".join(p for p in ([_model_base_name(model)] if model else [])
                     + [_model_base_name(l["name"]) for l in clean_loras] if p)
    base_id = _normalize_skill_id(title) or "combo-skill"
    src_meta, _ = _read_skill_md(src)
    desc = f"由「{src_meta.get('cn_name') or str(source_id)}」保存的模型组合：{title}"
    with _skills_lock:
        sid, i = base_id, 2
        while os.path.isdir(os.path.join(SKILL_CUSTOM_DIR, sid)):
            sid = f"{base_id}-{i}"
            i += 1
        d = os.path.join(SKILL_CUSTOM_DIR, sid)
        os.makedirs(d, exist_ok=True)
        meta = {
            "name": sid,
            "cn_name": title or None,
            "tags": [str(t) for t in (src_meta.get("tags") or [])],
            "description": desc,
            "inputs": ["text"],
            "category": "image_gen",
            "gen_image": True,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
        tmp = os.path.join(d, "skill.md.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(serialize_frontmatter(meta, desc))
        os.replace(tmp, os.path.join(d, "skill.md"))
        shutil.copy2(ws, os.path.join(d, "workflow.json"))
        cfg = get_skill_gen_config(_normalize_skill_id(str(source_id)))
        if model:
            cfg["model"] = model
        cfg["loras"] = clean_loras
        # 弹窗里选定了比例 / 最长边时一并覆盖（未选定沿用源技能有效 config）
        ratio = str(ratio or "").strip()
        if ratio:
            cfg["default_ratio"] = ratio[:32]
        try:
            base = int(base_resolution)
            if base > 0:
                cfg["base_resolution"] = base
        except (TypeError, ValueError):
            pass
        tmp = os.path.join(d, "config.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        os.replace(tmp, os.path.join(d, "config.json"))
    return {"success": True, "id": sid, "name": title}


# ==========================================
# 上传（zip / 目录清单）
# ==========================================

def _write_skill_files(target_dir: str, rel_paths: list[str], blobs: list[bytes]) -> bool:
    """把 (相对路径, 内容) 写入 target_dir，仅保留受支持文件（.md/.txt）并校验安全；缺 skill.md 时自动创建。"""
    os.makedirs(target_dir, exist_ok=True)
    base = os.path.realpath(target_dir)
    wrote_skill_md = False
    for rel, blob in zip(rel_paths, blobs):
        parts = [p for p in (rel or "").replace("\\", "/").split("/") if p not in ("", ".")]
        if not parts or any(p == ".." for p in parts):
            logger.warning(f"Reject unsafe skill file path: {rel}")
            continue
        if not parts[-1].lower().endswith(_SKILL_FILE_EXTS):
            continue
        target = os.path.realpath(os.path.join(base, *parts))
        if os.path.commonpath([target, base]) != base:
            logger.warning(f"Reject out-of-bounds skill file path: {rel}")
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(blob or b"")
        if parts[-1].lower() == "skill.md":
            wrote_skill_md = True
    if not wrote_skill_md:
        # 自动创建 skill.md（带最小 frontmatter），保证目录是合法 skill
        with open(os.path.join(base, "skill.md"), 'w', encoding='utf-8', newline='\n') as f:
            f.write(serialize_frontmatter({"name": os.path.basename(base)}, ""))
    return True


def _collect_skill_files(root: str) -> tuple[list[str], list[bytes]]:
    """收集 root 下所有受支持文件（.md/.txt）的 (相对路径, 字节)。"""
    rel_paths = []
    blobs = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in sorted(filenames):
            if not fn.lower().endswith(_SKILL_FILE_EXTS):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            with open(full, "rb") as f:
                blobs.append(f.read())
            rel_paths.append(rel)
    return rel_paths, blobs


def _upload_from_zip(zip_bytes: bytes, skill_id_field: str) -> dict:
    tmpdir = tempfile.mkdtemp(prefix="skill_zip_")
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                parts = [p for p in name.split("/") if p not in ("", ".")]
                if os.path.isabs(name) or any(p == ".." for p in parts):
                    return {"success": False, "status": 400, "message": f"Unsafe path in zip: {name}"}
            zf.extractall(tmpdir)

        entries = [e for e in os.listdir(tmpdir) if not e.startswith("__MACOSX") and not e.startswith(".")]
        root = tmpdir
        wrapper_id = ""
        if len(entries) == 1 and os.path.isdir(os.path.join(tmpdir, entries[0])):
            root = os.path.join(tmpdir, entries[0])
            wrapper_id = entries[0]

        sid = _normalize_skill_id(skill_id_field or wrapper_id)
        if not sid:
            return {"success": False, "status": 400, "message": "skill_id required (no wrapper folder in zip)"}

        rel_paths, blobs = _collect_skill_files(root)
        _write_skill_files(os.path.join(SKILL_CUSTOM_DIR, sid), rel_paths, blobs)
        return {"success": True, "id": sid}
    except Exception as e:
        logger.error(f"Error extracting skill zip: {e}")
        return {"success": False, "status": 500, "message": str(e)}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _upload_from_manifest(rel_paths: list[str], file_parts: list[tuple[str, bytes]], skill_id_field: str) -> dict:
    if not rel_paths:
        return {"success": False, "status": 400, "message": "Empty manifest"}
    norm = [p.replace("\\", "/") for p in rel_paths]
    # 若所有路径共享同一顶层目录，视为选中的 skill 根文件夹（webkitRelativePath 首段）
    tops = {n.split("/", 1)[0] for n in norm if "/" in n}
    strip_top = len(tops) == 1 and all("/" in n for n in norm)
    inner = [n.split("/", 1)[1] if strip_top else n for n in norm]
    sid = _normalize_skill_id(skill_id_field or (list(tops)[0] if strip_top else ""))
    if not sid:
        return {"success": False, "status": 400, "message": "skill_id required"}

    paths = []
    blobs = []
    for rel, (_fname, blob) in zip(inner, file_parts):
        if rel.lower().endswith(_SKILL_FILE_EXTS):
            paths.append(rel)
            blobs.append(blob)
    _write_skill_files(os.path.join(SKILL_CUSTOM_DIR, sid), paths, blobs)
    return {"success": True, "id": sid}


# ==========================================
# API Routes (skill 管理)
# ==========================================

@routes.get("/rs_prompts/skills")
async def rs_prompts_list_skills(request):
    """列出所有 skill（任务 + 预设/自定义统一元数据）。"""
    try:
        # 技能目录扫描（tasks + presets/custom 逐个读 config.json）是同步文件遍历，
        # 与模型扫描同一理由交回线程，不占桌面端那一个事件循环。
        return web.json_response(await asyncio.to_thread(scan_skills))
    except Exception as e:
        logger.error(f"Error listing skills: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/load_skill")
async def rs_prompts_load_skill(request):
    """加载单个 skill 完整数据（元数据 + 拼接内容 + 文件列表）。"""
    try:
        data = await request.json()
        skill_id = _normalize_skill_id(data.get("id", ""))
        d = _skill_dir(skill_id) if skill_id else None
        if not d:
            return web.Response(status=404, text="Skill not found")
        meta, _ = _read_skill_md(d)
        files = []
        for fn in _list_all_skill_files(d):
            fp = os.path.join(d, fn)
            files.append({"name": fn, "size": os.path.getsize(fp)})
        resp = {
            "id": skill_id,
            "name": meta.get("name", skill_id),
            "cn_name": meta.get("cn_name") or meta.get("name") or skill_id,
            "source": _skill_source(d),
            "tags": meta.get("tags", []),
            "description": meta.get("description", ""),
            "inputs": meta.get("inputs") or ["text"],
            "category": meta.get("category", "image_enhance"),
            "content": load_skill_content(skill_id) or "",
            "files": files,
            "max_tokens": meta.get("max_tokens"),
            "multi_result": meta.get("multi_result"),
            "multi_turn": bool(meta.get("multi_turn", False)),
            "result_key": meta.get("result_key"),
            "gen_image": bool(meta.get("gen_image", False)),
            "gen_video": bool(meta.get("gen_video", False)),
            "mode": str(meta.get("mode") or "").strip(),
            "requires_ref": bool(meta.get("requires_ref", False)),
            "config_overridden": has_skill_config_override(skill_id),
        }
        if resp["gen_video"]:
            resp["available"] = _video_skill_available(d)   # 详情弹窗顶部「不可用」说明用
        return web.json_response(resp)
    except Exception as e:
        logger.error(f"Error loading skill: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/save_skill")
async def rs_prompts_save_skill(request):
    """保存/更新 skill 主文件（skill.md）。预设只读。"""
    try:
        data = await request.json()
        skill_id = _normalize_skill_id(data.get("id", ""))
        if not skill_id:
            return web.Response(status=400, text="Skill id required")
        source = data.get("source", "custom")
        existing_dir = _skill_dir(skill_id)
        if existing_dir and _skill_source(existing_dir) == "presets" and source != "presets":
            return web.Response(status=403, text="Cannot modify preset skill")
        final_name = (data.get("name") or "").strip() or skill_id
        cn_name = (data.get("cn_name") or "").strip()
        conflict = _find_name_conflict(cn_name, skill_id) if cn_name else None
        if conflict:
            return web.Response(status=409, text=f"中文名称「{cn_name}」已被 {conflict} 使用，请改用其他名称")
        ok = save_skill_main(
            skill_id,
            data.get("name", ""),
            data.get("content", ""),
            data.get("tags", []),
            source,
            data.get("multi_turn"),
            category=data.get("category"),
            gen_image=data.get("gen_image"),
            gen_video=data.get("gen_video"),
            mode=data.get("mode"),
            requires_ref=data.get("requires_ref"),
            cn_name=cn_name or None,
        )
        if not ok:
            return web.Response(status=500, text="Failed to save skill")
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error saving skill: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/delete_skill")
async def rs_prompts_delete_skill(request):
    """删除整个 skill 目录（预设不可删）。"""
    try:
        data = await request.json()
        ok, msg = delete_skill(_normalize_skill_id(data.get("id", "")))
        if not ok and "preset" in msg.lower():
            return web.Response(status=403, text=msg)
        if not ok:
            return web.Response(status=404, text=msg)
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error deleting skill: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/reset_skill_config")
async def rs_prompts_reset_skill_config(request):
    """预设技能生图/生视频设置恢复默认（删除本地覆盖文件，幂等）。"""
    try:
        data = await request.json()
        ok, msg = reset_skill_gen_config(_normalize_skill_id(data.get("id", "")))
        if not ok:
            return web.Response(status=404, text=msg)
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error resetting skill config: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/upload_skill")
async def rs_prompts_upload_skill(request):
    """上传 skill：.zip（file 字段）或目录清单（manifest + 有序 files 字段）。"""
    try:
        reader = await request.multipart()
        skill_id_field = ""
        manifest_raw = None
        zip_bytes = None
        file_parts = []
        async for part in reader:
            if part.name == "skill_id":
                skill_id_field = (await part.read()).decode("utf-8").strip()
            elif part.name == "manifest":
                manifest_raw = (await part.read()).decode("utf-8")
            elif part.name == "file" and part.filename:
                zip_bytes = await part.read()
            elif part.name == "files":
                file_parts.append((part.filename, await part.read()))

        with _skills_lock:
            if zip_bytes is not None:
                result = _upload_from_zip(zip_bytes, skill_id_field)
            elif manifest_raw is not None:
                try:
                    rel_paths = json.loads(manifest_raw)
                except Exception:
                    return web.Response(status=400, text="Invalid manifest JSON")
                result = _upload_from_manifest(rel_paths, file_parts, skill_id_field)
            else:
                return web.Response(status=400, text="No upload payload")

        if not result.get("success"):
            status = result.get("status", 500)
            return web.Response(status=status, text=result.get("message", "Upload failed"))
        return web.json_response(result)
    except Exception as e:
        logger.error(f"Error uploading skill: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/load_skill_file")
async def rs_prompts_load_skill_file(request):
    """加载 skill 目录内某个 .md 文件内容。"""
    try:
        data = await request.json()
        skill_id = _normalize_skill_id(data.get("id", ""))
        filename = data.get("file", "")
        d = _skill_dir(skill_id) if skill_id else None
        if not d:
            return web.Response(status=404, text="Skill not found")
        target = _safe_skill_file_path(d, filename)
        if not target or not os.path.isfile(target):
            return web.Response(status=404, text="File not found")
        with open(target, 'r', encoding='utf-8') as f:
            content = f.read()
        return web.json_response({"name": filename, "content": content})
    except Exception as e:
        logger.error(f"Error loading skill file: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/save_skill_file")
async def rs_prompts_save_skill_file(request):
    """保存 skill 目录内某个 .md 文件。"""
    try:
        data = await request.json()
        ok = save_skill_file(
            _normalize_skill_id(data.get("id", "")),
            data.get("file", ""),
            data.get("content", ""),
        )
        if not ok:
            return web.Response(status=400, text="Failed to save skill file")
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error saving skill file: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/delete_skill_file")
async def rs_prompts_delete_skill_file(request):
    """删除 skill 目录内某个 .md 文件（skill.md 不可删）。"""
    try:
        data = await request.json()
        ok = delete_skill_file(
            _normalize_skill_id(data.get("id", "")),
            data.get("file", ""),
        )
        if not ok:
            return web.Response(status=400, text="Failed to delete skill file")
        return web.json_response({"success": True})
    except Exception as e:
        logger.error(f"Error deleting skill file: {e}")
        return web.Response(status=500, text=str(e))