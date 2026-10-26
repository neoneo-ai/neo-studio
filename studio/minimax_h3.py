# SPDX-License-Identifier: Apache-2.0
# Neo Studio - MiniMax H3 特定逻辑
"""MiniMax H3 视频生成特定逻辑，供 skill.py 的通用代理循环调用：
- 生成模式判定（_h3_mode）与各模式最终 grounding 约束；
- skill 正文条件段落裁剪（<!-- @if TOKENS -->...<!-- @end -->），token 为生成模式 + 已连参考媒体类型；
- 工作流上下文中 H3 节点块格式化（format_h3_context_lines）；
- audit: h3 技能生成后的确定性格式审计与窄修复（_h3_audit_and_repair / _h3_audit_events，规则实现在 h3_prompt_audit.py）。

llm / h3_prompt_audit 仅在函数运行时惰性导入，避免与 llm.py（顶层 from . import skill）形成循环导入。
"""

from __future__ import annotations

import logging
import math
import re

from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())


def _ratio(w, h):
    try:
        w, h = int(w), int(h)
        if w <= 0 or h <= 0:
            return ""
        g = math.gcd(w, h)
        rw, rh = w / g, h / g
        fmt = "{:.2f}".format(rw).rstrip("0").rstrip(".") + ":" + "{:.2f}".format(rh).rstrip("0").rstrip(".")
        return f" ({fmt})"
    except (TypeError, ValueError):
        return ""


def _dur(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return ""
    r = round(f)
    return f"{int(r)}s" if abs(f - r) < 0.05 else f"{f:.1f}s"


def _tag_list(label, files):
    # <Tag N> = 第 N 个该类型参考（1-based，与 tokenizer 计数一致）；files 为按序号排列的文件名（可含 None）
    if not isinstance(files, (list, tuple)) or not files:
        return ""
    parts = []
    for i, f in enumerate(files, 1):
        t = f"<{label} {i}>"
        if f:
            t += " " + str(f)
        parts.append(t)
    return ", ".join(parts)


def _keyframe_tags(kf):
    # ImageToVideo 的 first/last frame 本身就是 <Picture N>（tokenizer 按 [first, last] 顺序编号）
    entries = []
    if isinstance(kf, dict):
        if "first" in kf:
            entries.append((kf.get("first"), "first frame"))
        if "last" in kf:
            entries.append((kf.get("last"), "last frame"))
    parts = []
    for i, (f, role) in enumerate(entries, 1):
        t = f"<Picture {i}>"
        if f:
            t += " " + str(f)
        parts.append(t + f" ({role})")
    return ", ".join(parts)


# H3 各模式的最终 grounding 约束（仅 audit: h3 技能注入 workflow_context 末尾）
_H3_GROUNDING = {
    "T2VA": "Preserve any explicit continuous-camera or no-cut instruction instead of introducing an unsupported cut.",
    "I2VA": "Separate facts visible in the first frame from newly requested space or action revealed after it.",
    "FL2VA": "Prioritize exact endpoint geometry and a continuous state/camera path between the first and last frames.",
    "L2VA": "Invent only the minimum compatible preceding state needed to reach the final frame; do not infer a named location or period without evidence.",
    "Reference": ("Treat every explicitly assigned reference role as exclusive unless the user asks that reference to contribute additional traits. "
                  "Unspecified environment, lighting, composition, camera treatment, and atmosphere may be designed as new target content, "
                  "but never described as facts derived from a reference. "
                  "Do not add unsupported subject actions, dialogue, props, visible text, or an invented ending."),
}


def _h3_mode(node: dict) -> str:
    """按 H3 节点类型与 keyframe 槽位判定生成模式。"""
    kf = (node.get("refs") or {}).get("keyframes") or {}
    has_first, has_last = "first" in kf, "last" in kf
    t = str(node.get("type", ""))
    if t == "MiniMaxH3ReferenceToVideo":
        return "Reference"
    if t == "MiniMaxH3ImageToVideo":
        if has_first and has_last:
            return "FL2VA"
        if has_first:
            return "I2VA"
        if has_last:
            return "L2VA"
    return "T2VA"


def _h3_grounding_check(node: dict) -> str:
    """按 H3 节点类型与 keyframe 槽位判定模式，返回该模式的最终 grounding 检查句。"""
    mode = _h3_mode(node)
    return f"Final grounding check ({mode}): {_H3_GROUNDING[mode]} Return only the complete final H3 prompt."


_MODE_SECTION_RE = re.compile(r"<!--\s*@if\s+([A-Za-z0-9_,]+)\s*-->(.*?)<!--\s*@end\s*-->", re.DOTALL)
_H3_REF_KINDS = ("pictures", "videos", "audios")


def _h3_active_tokens(node: dict) -> set:
    """第一个 H3 节点的活跃 token：生成模式 + 已连接的参考媒体类型（refs 对应列表非空）。"""
    tokens = {_h3_mode(node)}
    refs = node.get("refs") or {}
    tokens.update(k.upper() for k in _H3_REF_KINDS if refs.get(k))
    return tokens


def _filter_mode_sections(body: str, context) -> str:
    """按当前 H3 上下文裁剪 skill 正文中的条件段落（<!-- @if TOKENS -->...<!-- @end -->）。

    token 为生成模式（T2VA/I2VA/FL2VA/L2VA/Reference）或参考媒体类型（PICTURES/VIDEOS/AUDIOS），
    段落任一 token 命中即保留。无 H3 上下文、正文无标记、或活跃 token 与所有 @if 列表均无交集时
    原样返回，保证行为安全回退。"""
    if not body or "<!--" not in body:
        return body
    h3 = (context or {}).get("h3") or [] if isinstance(context, dict) else []
    if not h3:
        return body
    blocks = list(_MODE_SECTION_RE.finditer(body))
    if not blocks:
        return body
    active = {t.upper() for t in _h3_active_tokens(h3[0])}
    if not any(active & {t.upper() for t in b.group(1).split(",")} for b in blocks):
        return body

    def _sub(m):
        inner = m.group(2).strip("\n")
        if active & {t.upper() for t in m.group(1).split(",")}:
            return "\n" + inner + "\n"
        return ""

    out = _MODE_SECTION_RE.sub(_sub, body)
    out = re.sub(r"\n{3,}", "\n\n", out)
    logger.info(f"Skill mode sections filtered for {', '.join(sorted(active))}")
    return out


def format_h3_context_lines(h3) -> list:
    """把工作流上下文中的 H3 节点块格式化为行列表（含参考标签提示）。"""
    lines = ["MiniMax H3 nodes in the current workflow:"]
    has_ref_tags = False
    for i, n in enumerate(h3[:8], 1):
        parts = [str(n.get("type", "H3"))]
        w, h = n.get("width"), n.get("height")
        aspect = n.get("aspect") or ""
        if not aspect and w and h:
            r = _ratio(w, h)
            aspect = r.strip(" ()") if r else ""
        if aspect:
            parts.append(f"Aspect Ratio: {aspect}")
        dur = n.get("duration_seconds")
        if dur is not None:
            d = _dur(dur)
            if d:
                parts.append(f"Duration: {d}")
        else:
            length = n.get("length")
            if length is not None:
                try:
                    sec, frames = _dur(int(length) / 24), int(length)
                except (TypeError, ValueError):
                    sec = ""
                if sec:
                    parts.append(f"Duration: {sec} ({frames} frames @24fps)")
        size = n.get("ref_image_size")
        if size:
            parts.append(f"ref_image_size={size}")
        nrefs = n.get("refs") or {}
        if isinstance(nrefs, dict):
            tag_parts = [t for t in (_keyframe_tags(nrefs.get("keyframes")),
                                     _tag_list("Picture", nrefs.get("pictures")),
                                     _tag_list("Video", nrefs.get("videos")),
                                     _tag_list("Audio", nrefs.get("audios"))) if t]
            if tag_parts:
                parts.append("References: " + ", ".join(tag_parts))
                has_ref_tags = True
        lines.append(f"  {i}. " + ", ".join(parts))
    if has_ref_tags:
        lines.append("In your prompt, refer to each node's reference media using the <Picture N>/<Video N>/<Audio N> tags listed above.")
    return lines


def _h3_narrow_repair(content: str, skill_id: str, text: str, context, max_tokens, failures) -> str | None:
    """发起一次窄修复调用；验收（复审通过 + 参考标签/对白不变）通过才返回修复文本，否则 None。"""
    from . import h3_prompt_audit
    try:
        from .llm import chat_turn
        msg = chat_turn(h3_prompt_audit.narrow_repair_messages(text, content, failures), max_tokens=max_tokens)
    except Exception as e:
        logger.warning(f"H3 narrow repair for skill '{skill_id}' failed: {e}")
        return None
    repaired = (msg.get("content") or "").strip()
    if not repaired:
        logger.info(f"H3 narrow repair for skill '{skill_id}' returned empty, keeping original output")
        return None
    if h3_prompt_audit.repair_acceptable(content, repaired, context):
        return repaired
    logger.info(f"H3 narrow repair for skill '{skill_id}' failed acceptance (re-audit/tags/dialogue), keeping original output")
    return None


def _h3_audit_and_repair(content: str, skill_id: str, text: str, context, max_tokens, on_step=None) -> str:
    """对生成的 H3 提示词跑确定性格式审计；失败时做一次窄修复（验收通过才采纳）。
    on_step 为可选的阶段上报回调（流式路径用），参数为状态文案；自检/修复的最终结果同样经 on_step 上报。"""
    from . import h3_prompt_audit
    audit = h3_prompt_audit.audit_h3_prompt(content, context)
    if not audit["repair_required"]:
        logger.info(f"H3 audit passed for skill '{skill_id}'")
        if on_step:
            on_step("格式自检通过")
        return content
    failures = audit["failures"]
    logger.info(f"H3 audit for skill '{skill_id}' failed: {'; '.join(failures)}")
    if on_step:
        on_step(f"自检发现 {len(failures)} 处格式问题：{'；'.join(failures)}")
        on_step("✏自动修复中…")
    repaired = _h3_narrow_repair(content, skill_id, text, context, max_tokens, failures)
    if repaired:
        logger.info(f"H3 narrow repair applied for skill '{skill_id}'")
        if on_step:
            on_step(f"✏已自动修复格式（{len(failures)} 处问题）")
        return repaired
    if on_step:
        on_step("修复未通过校验，保留原输出")
    return content


def _h3_audit_events(content: str, skill_id: str, text: str, context, max_tokens):
    """流式路径：正文已逐 token 透传完毕，对完整输出做审计并逐阶段上报 status/replace 事件。
    自检结果（含具体违规项）与修复结果都以 status 上报，前端常驻展示供用户查看。"""
    from . import h3_prompt_audit
    yield {"text": "格式自检中…", "kind": "status"}
    audit = h3_prompt_audit.audit_h3_prompt(content, context)
    if not audit["repair_required"]:
        logger.info(f"H3 audit passed for skill '{skill_id}'")
        yield {"text": "格式自检通过", "kind": "status"}
        return
    failures = audit["failures"]
    logger.info(f"H3 audit for skill '{skill_id}' failed: {'; '.join(failures)}")
    yield {"text": f"自检发现 {len(failures)} 处格式问题：{'；'.join(failures)}", "kind": "status"}
    yield {"text": "✏自动修复中…", "kind": "status"}
    repaired = _h3_narrow_repair(content, skill_id, text, context, max_tokens, failures)
    if repaired:
        logger.info(f"H3 narrow repair applied for skill '{skill_id}'")
        yield {"text": f"✏已自动修复格式（{len(failures)} 处问题）", "kind": "status"}
        yield {"text": repaired, "kind": "replace"}
    else:
        yield {"text": "修复未通过校验，保留原输出", "kind": "status"}

