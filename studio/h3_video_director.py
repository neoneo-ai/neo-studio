"""Neo H3 Video Director：以 video_director 配方为参数逐段生成并拼接成单个含音频 VIDEO；也可接 NeoPromptAgent 的 BUNDLE 按单段生成。

设计（复用单段 H3 路径）：
- NeoH3VideoDirector 从配方读取 {shared, segments[]}；每段带自己的 skill_id、prompt、时长、首帧参考。
- 逐段复用单段解析/执行链 _run_segment_graph（resolve_video_params + render_template + execute_graph_inprocess）。
- BUNDLE 输入（forceInput）：提供时忽略 recipe，用 bundle 的 skill/提示词/参考图（data URI）跑单个片段。
- 跨段上下文窗口（默认）：上段尾部 window 帧作为本段开头的视频参考注入（NeoH3AddContext），本段重生成
  这 window 帧后丢掉头部 window 帧——接缝不再重复边界帧，且新段带着上段的真实像素开场；丢之前先把重合区与
  上段真实尾帧交叉淡化（_blend_seam，帧数不变），硬切摊成渐变。
- 分镜首帧优先：i2v/fl2v 段自带首帧图（分镜格）时，首帧锚点用它（不再被连续性顶替），上段尾部改走
  context_mode="reference"——目标之前的参考视频，不改时长、不丢帧、不做接缝淡化。
- 身份继承：首段（第一个带参考素材的段）的身份参考图领养到后续段，同走 NeoH3AddContext 的图片参考块。
- 多帧单次分块（shared.chunk_sec，默认 15 秒；0 = 关闭）：连续兼容段（t2v/i2v/fl2v、无自带参考素材、
  选中技能为多帧单次技能、总时长 ≤ chunk_sec）合并成一次 ref2va 运行（渲染该技能的 workflow.json + NeoH3AddGuides），
  各段分镜关键帧按累计起点钉在对应帧号；不兼容 / 超长的段自动退回逐段路径。块间上下文只走 reference 模式（目标之前的参考视频，不改时长、不丢帧）。
- Tier A 回退（context_frames=0）：没自带首帧图的 i2v/fl2v 段用上段尾帧当首帧；丢下段第一帧避免边界重复。
  以上各情况的丢帧数都同步裁音频保 A/V 对齐。
- seed 派生：base_seed + i（i 为段序号），保证可复现且各段不同。

单段生成/重生成（含从成片取前后真实帧当锚点、换种子重跑某一段）走**执行队列**，
单独放在 h3_segment.py（NeoH3SegmentRun 节点 + /neo_video_gen/run_segment* 路由）。
"""

import math
import random
import re

import torch
from fractions import Fraction

import comfy.utils
import nodes as comfy_nodes
from aiohttp import web
from comfy_api.latest import InputImpl, Types
from comfy_execution.utils import get_executing_context
from server import PromptServer

from .bundles import get_bundle
from .image_gen import render_template
from .image_gen_edit import _image_to_data_uri, _model_injection_node, execute_graph_inprocess
from .h3_video_gen import H3_FPS, _default_video_skill, _gen_video_skills, _resolve_skill_id, _require_vdn_plugin, _seconds_to_frames, _skill_label, ensure_reference_tags, is_multiframe_skill, resolve_video_params
from .h3_preview import load_h3_tiny_vae, preview_override
from .skill import get_skill_gen_config, load_skill_workflow
from .recipes import list_director_recipes, load_director_spec

# 当前 director 运行进度（进程内单例）。ComfyUI 串行执行 prompt，同一时刻只有一个活动 director。
# segment_index：正在生成的段序号（-1 = 尚未开始/已结束）；total_segments：总段数。
# step / total_steps：当前段已完成的采样步数 / 总步数（前端据此渲染段内进度条）。
# prompt_id：本次执行的队列 id（运行开始才可知），供「取消生成」中断/出队。
_DIRECTOR_PROGRESS = {"active": False, "segment_index": -1, "total_segments": 0, "step": 0, "total_steps": 0,
                      "prompt_id": None}


def get_director_progress() -> dict:
    return dict(_DIRECTOR_PROGRESS)


@PromptServer.instance.routes.get("/neo_video_gen/director_progress")
async def neo_video_gen_director_progress(request):
    """返回当前 director 运行进度，供节点内时间轴实时显示各段生成状态。"""
    return web.json_response(get_director_progress())


@PromptServer.instance.routes.post("/neo_video_gen/director/cancel")
async def neo_video_gen_director_cancel(request):
    """取消进行中的 director 任务：执行中则中断（与单段/生图任务同一套做法）。"""
    prompt_id = _DIRECTOR_PROGRESS.get("prompt_id")
    if not _DIRECTOR_PROGRESS["active"] or not prompt_id:
        return web.json_response({"success": False, "error": "没有进行中的导演任务"}, status=409)
    queue = PromptServer.instance.prompt_queue
    interrupted = queue.interrupt_if_running(prompt_id)
    dequeued = queue.delete_queue_item(lambda entry: entry[1] == prompt_id)
    if not interrupted and not dequeued:
        return web.json_response({"success": False, "error": "任务已结束，无法取消"}, status=409)
    return web.json_response({"success": True, "interrupted": interrupted, "dequeued": dequeued})


def _concat_segment_audio(audios, frame_rate: int, drops):
    """把各段 AudioInput 拼成一条；每个接缝按 drops[i]（0/1）决定是否裁掉对应采样。

    audios 为每段的 comp.audio（AudioInput {waveform:[B,C,T], sample_rate} 或 None），顺序对应各段。
    drops 与 segments 对齐：drops[i]=1 表示第 i 段被连续性链入、首帧已丢弃，需同步裁掉等量采样保 A/V 对齐。
    返回合并后的 AudioInput；全部无音频时返回 None。
    """
    present = [a for a in audios if a is not None]
    if not present:
        return None
    sample_rate = int(present[0].get("sample_rate") or 1)
    per_frame = max(0, int(round(sample_rate / frame_rate)))   # 每帧对应的采样数
    parts = []
    for i, a in enumerate(audios):
        if a is None:
            continue
        w = a["waveform"]
        d = drops[i] if i < len(drops) else 0
        if i > 0 and d > 0 and per_frame > 0:
            w = w[..., per_frame * d:]
        parts.append(w)
    if not parts:
        return None
    return {"waveform": torch.cat(parts, dim=-1), "sample_rate": sample_rate}


# H3 的一次模型调用会同时用到两类条件行：keyframe 锚点（PackedLayout 的 cond 行）与 minimax_refs
# （ref 行）。core 在两者并存时会用 refs 的 latent 覆盖 keyframe 的 cond_video_latents
# （comfy/model_base.py），锚点因此被丢掉；PackedLayout 又把 cond/ref 行的 t 一律从 text_len 起算，
# 而目标视频的 t 原点在所有 ref 之后。这两件事都在模型调用前一次性修掉，做法与 H3-Continuum 相同：
# 在 ModelPatcher 上挂一个带命名空间的 APPLY_MODEL wrapper（不改 core、不与其它插件的 extra_conds
# 补丁抢所有权，重复安装只保留一份）。
_CONTINUITY_WRAPPER_KEY = "neo_h3_continuity.apply_model.v1"
_CONTEXT_FRAMES_MARK = "neo_context_frames"       # 上下文窗口 ref 上标记占多少帧（对齐时间轴时据此定位）
_CONTEXT_ALIGNED_ATTR = "_neo_h3_context_aligned"  # 同一 layout 只对齐一次（拷贝本身也是幂等的）
SEAM_BLEND_FRAMES = 6   # 段间接缝的交叉淡化帧数（0 = 关闭）：把「丢掉重生成窗口帧」的硬切摊成渐变
CONTEXT_MODES = ("window", "reference")   # window = 目标开头重生成（调用方丢头帧）/ reference = 目标之前的参考视频


def _blend_seam(prev_frames, frames, drop, blend):
    """接缝交叉淡化：用本段重生成的重合帧与上一段已入片的真实尾帧按权重融合，替换回上一段尾部。

    重合区两份内容是同一时间位置的两版（上一段的真实帧 + 本段重生成的那 window 帧），所以是「替换 + 融合」：
    帧数与时长都不变，不需要额外采样，只是把硬切的瞬时跳变摊到 blend 帧上（权重 0→1）。
    各段分辨率不一致（-1 尺寸下各段 skill config 可能不同）或没有重合帧时原样返回。
    """
    n = min(int(blend or 0), int(drop or 0))
    if n <= 0 or prev_frames.shape[0] < n or frames.shape[0] < n:
        return prev_frames
    if tuple(prev_frames.shape[1:]) != tuple(frames.shape[1:]):
        return prev_frames
    t = torch.arange(1, n + 1, device=frames.device, dtype=torch.float32) / (n + 1)
    w = t.to(frames.dtype).view(n, *([1] * (frames.ndim - 1)))
    tail = prev_frames[-n:] * (1 - w) + frames[drop - n:drop] * w
    return torch.cat([prev_frames[:-n], tail], dim=0)


def _merge_cond_latents(payload):
    """把 keyframe 锚点与 refs 的 cond latent 合回一条列表（顺序与 PackedLayout 的 row 布局一致）。"""
    keyframes = payload.get("keyframes") or []
    refs = payload.get("refs") or []
    payload["cond_video_latents"] = (
        [kf["latent"] for kf in keyframes if kf.get("latent") is not None]
        + [r["latent"] for r in refs if r.get("latent") is not None])
    payload["cond_audio_latents"] = (
        [kf["audio_latent"] for kf in keyframes if kf.get("audio_latent") is not None]
        + [r["audio_latent"] for r in refs if r.get("audio_latent") is not None])


def _ref_row_ranges(layout, refs):
    """把 refs 逐个映射到布局里的 ref_img / ref_audio 行区间（消费顺序与 PackedLayout 构建顺序一致）。"""
    avail = [(int(a), int(b)) for a, b, kind in layout.segments if kind in ("ref_img", "ref_audio")]
    cursor = 0

    def take():
        nonlocal cursor
        if cursor >= len(avail):
            raise RuntimeError("[Neo Studio] H3 布局的参考行少于 minimax_refs，无法对齐跨段上下文窗口")
        row_range = avail[cursor]
        cursor += 1
        return row_range

    rows = []
    for ref in refs:
        kind = ref.get("kind")
        with_audio = int(ref.get("ref_audio_t") or 0) > 0
        if kind == "image":
            rows.append({"video": take(), "audio": None})
        elif kind == "audio":
            rows.append({"video": None, "audio": take() if with_audio else None})
        elif kind in ("video", "video_audio"):
            audio = take() if with_audio else None
            rows.append({"video": take(), "audio": audio})
        else:
            raise RuntimeError(f"[Neo Studio] 未知的 H3 参考类型：{kind!r}")
    return rows


def _align_payload_timeline(payload):
    """把上下文窗口行的时间坐标搬到目标视频开头（就地改 PackedLayout.position_ids）。

    锚点行不用动：core 的 PackedLayout 已让 refs 先占位、keyframe 锚点从目标时间轴原点起算。
    要搬的只有「窗口模式」的上下文行——本段会重生成上段尾部的那些帧，所以复用目标开头的行；
    reference 模式的窗口行不带标记，保持在目标之前的参考位。保持 position_ids 张量本体不变
    （Sol-Attn 的 span 注册认它），只改坐标。
    """
    layout = payload.get("layout")
    if layout is None or getattr(layout, _CONTEXT_ALIGNED_ATTR, False):
        return
    refs = payload.get("refs") or []
    targets = [(int(a), int(b)) for a, b, kind in layout.segments if kind == "video"]
    if not targets:
        return
    video_start, video_stop = targets[-1]
    target_t = int(layout.signature[1])
    frame_rows = max(1, (video_stop - video_start) // target_t)
    position_ids = layout.position_ids
    for ref, row in zip(refs, _ref_row_ranges(layout, refs)):
        if _CONTEXT_FRAMES_MARK not in ref:
            continue
        window_t = int(ref.get("latent_t") or 0)
        if window_t > target_t:
            raise RuntimeError(f"[Neo Studio] 跨段上下文窗口 T={window_t} 超过目标视频 T={target_t}")
        if row["video"] is None:
            raise RuntimeError("[Neo Studio] 跨段上下文窗口参考缺少视频行")
        start, stop = row["video"]
        if window_t <= 0 or stop - start != window_t * frame_rows:
            raise RuntimeError(f"[Neo Studio] 跨段上下文窗口行数 {stop - start} 与 latent T={window_t} 不符")
        position_ids[start:stop].copy_(position_ids[video_start:video_start + window_t * frame_rows])
    setattr(layout, _CONTEXT_ALIGNED_ATTR, True)


def _continuity_wrapper(executor, *args, **kwargs):
    """APPLY_MODEL wrapper：模型调用前修好本次调用的 payload（合并 cond 列表 + 对齐连续性行的时间轴）。"""
    payload = kwargs.get("minimax_payload")
    if not isinstance(payload, dict):
        return executor(*args, **kwargs)
    if payload.get("keyframes") and payload.get("refs") is not None:
        payload = dict(payload)
        _merge_cond_latents(payload)
        kwargs["minimax_payload"] = payload
    _align_payload_timeline(payload)
    return executor(*args, **kwargs)


def _install_continuity(model):
    """clone 一个 MODEL 并挂上连续性 wrapper（同一 key 先清再挂，可重复安装）。"""
    from comfy.patcher_extension import WrappersMP
    patched = model.clone()
    patched.remove_wrappers_with_key(WrappersMP.APPLY_MODEL, _CONTINUITY_WRAPPER_KEY)
    patched.add_wrapper_with_key(WrappersMP.APPLY_MODEL, _CONTINUITY_WRAPPER_KEY, _continuity_wrapper)
    return patched


class NeoH3AddKeyframe:
    """手动/画布用：把图像作为首帧 keyframe 锚点注入 H3 conditioning（与 minimax_refs 共存）。

    NeoH3VideoDirector 已改用 NeoH3AddContext（跨段上下文窗口）；本节点保留给手动搭图与旧画布工作流。
    接收已编码的参考 conditioning + VAE + 图像，将图像编码为 latent 后以 resolved_frame_index=0 写入
    minimax_keyframes；同时返回挂了连续性 wrapper 的 MODEL，使 refs 与 keyframes 同时生效、时间轴对齐。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "conditioning": ("CONDITIONING",),
                "vae": ("VAE",),
                "image": ("IMAGE", {"tooltip": "首帧锚点图：只取批次第 1 张，编码成 latent 钉在时间轴第 0 帧。"}),
                "frame_count": ("INT", {"default": 124, "min": 5, "max": 3600,
                                        "tooltip": "本段总帧数（24fps，124 帧 ≈ 5 秒），需与采样段长度一致。"}),
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING")
    RETURN_NAMES = ("model", "conditioning")
    FUNCTION = "add_keyframe"
    CATEGORY = "Neo Studio"
    DESCRIPTION = "首帧锚点：把图像编码成 latent 写入 H3 conditioning 的第 0 帧 keyframe（手动搭图与旧画布工作流用）。"
    SEARCH_ALIASES = [
        "h3 keyframe", "add keyframe", "first frame", "keyframe anchor", "frame 0",
        "首帧", "首帧锚点", "关键帧", "锚点", "h3 首帧", "画布首帧",
    ]
    OUTPUT_TOOLTIPS = (
        "挂了连续性 wrapper 的 MODEL：keyframes 与 refs 并存时时间轴对齐。",
        "写入首帧 keyframe 后的 conditioning，接采样器 positive。",
    )

    def add_keyframe(self, model, conditioning, vae, image, frame_count):
        import node_helpers
        img = image[:1]  # [1, H, W, C]
        latent = vae.encode(img)
        keyframes = [{"resolved_frame_index": 0, "latent": latent}]
        cond = node_helpers.conditioning_set_values(conditioning, {
            "minimax_keyframes": keyframes,
            "minimax_frame_count": int(frame_count),
        })
        return (_install_continuity(model), cond)


_MAX_GUIDES = 32   # 多帧单次一块允许的关键帧锚点上限（15 秒块内段数 × fl2v 首尾双锚点的余量）


def _resize_guide(image, width, height):
    """关键帧图 [B,H,W,C] → 精确缩放到画布 [B,height,width,3]（同官方 H3 guide 节点，中心裁剪保比例）。"""
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", "center")
    return samples.movedim(1, -1)


class NeoH3AddGuides:
    """多帧单次（director 分块运行，内部节点用）：把多个带时间戳的 keyframe 锚点批量注入 H3 conditioning。

    每对 guide_N_image / guide_N_frame 编码后以该帧号写入 minimax_keyframes，与 minimax_refs 共存；
    director 的分块单次模式用它把各段分镜关键帧钉在各自累计起点（等价于多个 MiniMaxH3AddGuide）。
    新旧模式开关 = latent 是否连接：接上目标 AV latent → 关键帧先缩放到该画布再编码（新，与主视频
    latent 空间维度一致，首帧图/分镜图分辨率≠配方画布时不 patchify 报错）；不接 → 按原图分辨率编码
    （旧，兼容老工作流）。director 分块运行时自动接线，恒走新模式。
    返回挂了连续性 wrapper 的 MODEL，锚点与参考同时生效、时间轴对齐（机制同 NeoH3AddKeyframe）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        optional = {}
        for i in range(8):   # 画布用槽位；director 运行时经 kwargs 可传满 _MAX_GUIDES 对
            optional[f"guide_{i}_image"] = ("IMAGE",)
            optional[f"guide_{i}_frame"] = ("INT", {"default": 0, "min": -3600, "max": 3600})
        optional["latent"] = ("LATENT", {"tooltip": "接上目标 AV latent = 关键帧先缩放到该画布再编码（分镜图分辨率≠配方画布时不 patchify 报错）；不接 = 按原图分辨率编码。"})   # 可选：接上=关键帧对齐目标画布（新）；不接=按原图分辨率编码（旧，兼容老工作流）
        return {
            "required": {
                "model": ("MODEL",),
                "conditioning": ("CONDITIONING",),
                "vae": ("VAE",),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING")
    RETURN_NAMES = ("model", "conditioning")
    FUNCTION = "add_guides"
    CATEGORY = "Neo Studio"
    DESCRIPTION = "多帧关键帧锚点：把多组「图像 + 帧号」批量写入 H3 conditioning 的 minimax_keyframes（等价多个 MiniMaxH3AddGuide）。"
    SEARCH_ALIASES = [
        "h3 guides", "add guides", "keyframes batch", "multi keyframe", "timeline anchor",
        "多帧锚点", "关键帧批量", "时间轴锚点", "分镜关键帧", "h3 关键帧",
    ]
    OUTPUT_TOOLTIPS = (
        "挂了连续性 wrapper 的 MODEL：锚点与参考同时生效、时间轴对齐。",
        "写入全部关键帧锚点后的 conditioning，接采样器 positive。",
    )

    def add_guides(self, model, conditioning, vae, latent=None, **kwargs):
        import node_helpers
        width = height = None
        if latent is not None:   # 新模式：按目标 AV latent 的画布尺寸对齐关键帧（同官方 MiniMaxH3AddGuide）
            video = latent["samples"].tensors[0]   # [B, 24, T, H/16, W/16]
            width, height = int(video.shape[4] * 16), int(video.shape[3] * 16)   # 像素画布（latent × 16）
        keyframes = []
        for i in range(_MAX_GUIDES):
            img = kwargs.get(f"guide_{i}_image")
            if img is None:
                continue
            idx = int(kwargs.get(f"guide_{i}_frame", 0) or 0)
            frames = _resize_guide(img[:1], width, height) if width else img[:1]   # 未接 latent → 旧模式原分辨率
            keyframes.append({"resolved_frame_index": max(0, idx), "latent": vae.encode(frames)})
        if not keyframes:
            return (model, conditioning)
        cond = node_helpers.conditioning_set_values(conditioning, {"minimax_keyframes": keyframes}, append=True)
        return (_install_continuity(model), cond)


_H3_COND_NODES = ("MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo")
_H3_SAMPLER_NODES = ("KSampler", "KSamplerAdvanced")
_CANVAS_MULTIPLE = 32   # 参考块的像素对齐（官方 H3 节点同款；latent 侧即 16 分频后的偶数）


def _canvas_size(value):
    """模板里的 width/height 输入：整数才当画布用（链接 / 占位符 / 缺省都返回 0 = 不缩放）。"""
    return int(value) if isinstance(value, int) else 0


def _free_node_id(graph):
    """模板图里没被占用的节点 id（注入节点用它，避免与模板 id 撞号）。"""
    nid = 9000
    while str(nid) in graph:
        nid += 1
    return str(nid)


def _inject_continuity_nodes(graph, context_tail, context_frames, identity_names=(), context_mode=CONTEXT_MODES[0]):
    """在渲染后的模板图里注入 NeoH3AddContext（先身份参考、后上下文窗口），返回 (graph, overrides)。

    定位消费 H3 conditioning 的采样器，把采样器的 model / positive / negative 改指到注入节点——模型输出
    带连续性 wrapper，refs 与 keyframe 锚点才会同时生效、时间轴才对齐。context_tail 通过 override 注入虚拟
    LoadImage（不写临时文件）；身份参考图直接用 input 目录里的真实 LoadImage（与 r2v 模板同一条加载路径）。
    context_mode 原样传给注入节点：window = 目标开头重生成（调用方丢头帧）/ reference = 目标之前的参考视频。
    """
    if context_tail is None and not identity_names:
        return graph, None
    sampler_id = cond_id = None
    for nid, node in graph.items():
        if node.get("class_type") not in _H3_SAMPLER_NODES:
            continue
        for key in ("positive", "negative"):
            src = (node.get("inputs") or {}).get(key)
            if not (isinstance(src, (list, tuple)) and len(src) == 2):
                continue
            cond_node = graph.get(src[0])
            if cond_node is not None and cond_node.get("class_type") in _H3_COND_NODES:
                sampler_id, cond_id = nid, src[0]
                break
        if sampler_id is not None:
            break
    if sampler_id is None:
        raise RuntimeError("[Neo Studio] 未找到消费 H3 conditioning 的 KSampler，无法注入跨段连续性")
    sampler_inputs = graph[sampler_id]["inputs"]
    cond_inputs = graph[cond_id]["inputs"]
    model_src = sampler_inputs.get("model")
    vae_src = cond_inputs.get("vae")
    if not (isinstance(model_src, (list, tuple)) and len(model_src) == 2):
        raise RuntimeError("[Neo Studio] H3 采样器没有 model 来源，无法把连续性 wrapper 交给采样")
    if not (isinstance(vae_src, (list, tuple)) and len(vae_src) == 2):
        raise RuntimeError("[Neo Studio] H3 conditioning 节点没有 vae 来源，无法编码上下文窗口")

    width = _canvas_size(cond_inputs.get("width"))
    height = _canvas_size(cond_inputs.get("height"))
    overrides = {}
    model_ref, cond_ref = [model_src[0], model_src[1]], [cond_id, 0]

    def add_node(image_key, image_id, **extra):
        """插一个 NeoH3AddContext：接在上一棒后面，下一棒的 model / conditioning 指到它。"""
        nonlocal model_ref, cond_ref
        node_id = _free_node_id(graph)
        graph[node_id] = {"class_type": "NeoH3AddContext", "inputs": {
            "model": model_ref, "conditioning": cond_ref, "vae": [vae_src[0], vae_src[1]],
            "width": width, "height": height, image_key: [image_id, 0], **extra}}
        model_ref, cond_ref = [node_id, 0], [node_id, 1]

    for name in identity_names:
        image_id = _free_node_id(graph)
        graph[image_id] = {"class_type": "LoadImage", "inputs": {"image": name}}
        add_node("identity_image", image_id)
    if context_tail is not None:
        image_id = _free_node_id(graph)
        graph[image_id] = {"class_type": "LoadImage", "inputs": {"image": "__neo_context_tail__"}}
        add_node("context_image", image_id, context_frames=int(context_frames), context_mode=context_mode)
        overrides[image_id] = [context_tail]

    sampler_inputs["model"] = model_ref
    for key in ("positive", "negative"):
        src = sampler_inputs.get(key)
        if isinstance(src, (list, tuple)) and len(src) == 2 and src[0] == cond_id:
            sampler_inputs[key] = cond_ref
    return graph, overrides


def _inject_multiframe_guides(graph, guides):
    """在渲染后的模板图里注入 NeoH3AddGuides（每个关键帧一个 LoadImage），返回 (graph, overrides)。

    供多帧单次分块运行用：定位 latent_image 指向 H3 conditioning 的采样器，把它的 model / positive / negative
    改指到注入节点——接在 _inject_continuity_nodes 之后调用时即串在连续性链尾（身份/上下文 → 关键帧锚点）。
    guides 为空时不动图。
    """
    if not guides:
        return graph, None
    sampler_id = cond_id = None
    for nid, node in graph.items():
        if node.get("class_type") not in _H3_SAMPLER_NODES:
            continue
        latent_src = (node.get("inputs") or {}).get("latent_image")
        if not (isinstance(latent_src, (list, tuple)) and len(latent_src) == 2):
            continue
        cond_node = graph.get(latent_src[0])
        if cond_node is not None and cond_node.get("class_type") in _H3_COND_NODES:
            sampler_id, cond_id = nid, latent_src[0]
            break
    if sampler_id is None:
        raise RuntimeError("[Neo Studio] 未找到消费 H3 conditioning 的 KSampler，无法注入多帧关键帧锚点")
    vae_src = (graph[cond_id].get("inputs") or {}).get("vae")
    if not (isinstance(vae_src, (list, tuple)) and len(vae_src) == 2):
        raise RuntimeError("[Neo Studio] H3 conditioning 节点没有 vae 来源，无法编码多帧关键帧")
    sampler_inputs = graph[sampler_id]["inputs"]
    model_ref = sampler_inputs.get("model")
    cond_ref = None
    for key in ("positive", "negative"):
        src = sampler_inputs.get(key)
        if isinstance(src, (list, tuple)) and len(src) == 2:
            cond_ref = list(src)
            break
    if not (isinstance(model_ref, (list, tuple)) and len(model_ref) == 2) or cond_ref is None:
        raise RuntimeError("[Neo Studio] H3 采样器没有 model / conditioning 来源，无法注入多帧关键帧锚点")
    node_id = _free_node_id(graph)
    inputs = {"model": list(model_ref), "conditioning": cond_ref, "vae": list(vae_src), "latent": [cond_id, 1]}
    graph[node_id] = {"class_type": "NeoH3AddGuides", "inputs": inputs}   # 先入图占号，image id 才不会撞上它
    for i, g in enumerate(guides[:_MAX_GUIDES]):
        image_id = _free_node_id(graph)
        graph[image_id] = {"class_type": "LoadImage", "inputs": {"image": g["name"]}}
        inputs[f"guide_{i}_image"] = [image_id, 0]
        inputs[f"guide_{i}_frame"] = int(g["frame_idx"])
    sampler_inputs["model"] = [node_id, 0]
    for key in ("positive", "negative"):
        src = sampler_inputs.get(key)
        if isinstance(src, (list, tuple)) and len(src) == 2 and src[0] == cond_ref[0] and src[1] == cond_ref[1]:
            sampler_inputs[key] = [node_id, 1]
    return graph, None


class NeoH3AddContext:
    """跨段连续性：把上段尾部若干帧当作 H3 视频参考注入 conditioning，并可附带身份参考图。

    context_image 取尾部 context_frames 帧编成一条参考视频块（帧数就近对齐到模型要求的 17k+5 网格），
    identity_image 的每张图各编成一条参考图片块（按画布面积等比缩放，与官方 r2v 的参考图同规格）。
    context_mode：window = 本段开头重生成这些帧（上下文行搬到目标开头，调用方丢头帧）；
    reference = 目标之前的参考视频（不搬时间轴、不丢帧，用于自带分镜首帧的段）。
    返回的 MODEL 挂了连续性 wrapper：keyframes 与 refs 并存时合回一条 cond 列表（wrapper 按命名空间安装，
    链式多段调用也只会保留一份）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "conditioning": ("CONDITIONING",),
                "vae": ("VAE",),
                "width": ("INT", {"default": 1344, "min": 0, "max": comfy_nodes.MAX_RESOLUTION}),
                "height": ("INT", {"default": 768, "min": 0, "max": comfy_nodes.MAX_RESOLUTION}),
            },
            "optional": {
                "context_image": ("IMAGE", {"tooltip": "上段尾部窗口帧（接 NeoH3VideoDirector / NeoH3SegmentRun 的成片输出）；空 = 不注入上下文。"}),
                "identity_image": ("IMAGE", {"tooltip": "身份参考图，可批量逐张成块：保角色/物体外观跨段一致。"}),
                "context_frames": ("INT", {"default": 22, "min": 0, "max": 362,
                                           "tooltip": "取上段尾部多少帧做上下文（自动就近对齐 17k+5 网格）；0 = 不注入。"}),   # 0 = 不注入上下文窗口
                "context_mode": (list(CONTEXT_MODES), {"default": CONTEXT_MODES[0],
                                                       "tooltip": "window = 本段开头重生成这些帧（调用方丢头帧）；reference = 作为目标之前的参考视频，不搬时间轴不丢帧。"}),
            },
        }

    RETURN_TYPES = ("MODEL", "CONDITIONING")
    RETURN_NAMES = ("model", "conditioning")
    FUNCTION = "add_context"
    CATEGORY = "Neo Studio"
    DESCRIPTION = "跨段连续性：上段尾部若干帧作为 H3 视频参考（window=开头重生成 / reference=目标之前的参考）注入 conditioning。"
    SEARCH_ALIASES = [
        "h3 context", "continuity", "cross segment", "video reference", "identity reference",
        "window", "reference mode", "尾帧", "跨段连续性", "上下文窗口", "身份参考",
        "段间衔接", "连续性",
    ]
    OUTPUT_TOOLTIPS = (
        "挂了连续性 wrapper 的 MODEL（链式多段调用只保留一份 wrapper）。",
        "注入上下文/身份参考后的 conditioning，接采样器 positive。",
    )

    def add_context(self, model, conditioning, vae, width, height, context_image=None, identity_image=None,
                    context_frames=22, context_mode=CONTEXT_MODES[0]):
        import node_helpers
        canvas = _ref_canvas(width, height)
        images = identity_image if identity_image is not None else []
        refs = [_identity_ref(vae, image.unsqueeze(0), canvas) for image in images]
        window = _align_context_frames(context_frames) if int(context_frames or 0) > 0 else 0
        if context_image is not None and window > 0:
            refs.append(_context_ref(vae, context_image, window, canvas, reference=(context_mode == "reference")))
        if not refs:
            return (model, conditioning)
        cond = node_helpers.conditioning_set_values(conditioning, {"minimax_refs": refs}, append=True)
        return (_install_continuity(model), cond)


def _ref_canvas(width, height):
    """参考块要用的画布像素尺寸（按 32 对齐）；非法尺寸返回 None（= 用图像自身尺寸）。"""
    if int(width) <= 0 or int(height) <= 0:
        return None
    return (max(_CANVAS_MULTIPLE, round(int(width) / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE),
            max(_CANVAS_MULTIPLE, round(int(height) / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE))


def _ref_pixels(width, height, canvas):
    """参考图/视频要编码的像素尺寸：给了画布就按画布面积等比缩到不超过画布（官方 r2v 的 match 同法）。

    两种来源都按 32 对齐——patchify 要求 latent 侧每轴为偶数，非画布来源的尺寸先对齐再送 VAE。
    """
    if canvas is not None:
        scale = min(1.0, math.sqrt((canvas[0] * canvas[1]) / float(width * height)))
        width, height = width * scale, height * scale
    return (max(_CANVAS_MULTIPLE, round(width / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE),
            max(_CANVAS_MULTIPLE, round(height / _CANVAS_MULTIPLE) * _CANVAS_MULTIPLE))


def _resize_frames(frames, width, height):
    """[B,H,W,C] 拉到目标像素尺寸（官方参考图/参考视频用的同一套 lanczos 拉抻，裁剪关闭）。"""
    if frames.shape[1] == height and frames.shape[2] == width:
        return frames
    samples = frames[..., :3].movedim(-1, 1)
    return comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)


def _identity_ref(vae, image, canvas):
    """一张身份参考图 → 布局的图片参考块（与官方 r2v 的 ref_image 同规格）。"""
    width, height = _ref_pixels(image.shape[2], image.shape[1], canvas)
    latent = vae.encode(_resize_frames(image[:1], width, height))
    return {"kind": "image", "latent_h": height // 16, "latent_w": width // 16, "latent": latent}


def _context_ref(vae, frames, window, canvas, reference=False):
    """尾部 window 帧 → 布局的视频参考块（无音轨，ref_audio_t=0）。

    reference=True（本段自带分镜首帧的段）时不打上下文标记：时间轴保持 core 给的「目标之前」参考位，
    既不搬到目标开头、也不会被调用方当成待重生成的窗口丢掉。
    """
    width, height = _ref_pixels(frames.shape[2], frames.shape[1], canvas)
    latent = vae.encode(_resize_frames(frames[-window:], width, height))
    latent_t = int(latent.shape[2])
    expect = _context_latent_t(window)
    if latent_t != expect:
        raise ValueError(
            f"上下文窗口 {window} 帧编码后得到 latent T={latent_t}，与 H3 的 17k+5 网格（T={expect}）不符："
            "请确认 vae 是 MiniMax H3 视频 VAE")
    ref = {"kind": "video", "latent_t": latent_t, "latent_h": height // 16, "latent_w": width // 16,
           "ref_audio_t": 0, "latent": latent, "audio_latent": None}
    if not reference:
        ref[_CONTEXT_FRAMES_MARK] = int(window)
    return ref


def _align_context_frames(n):
    """上下文窗口帧数就近对齐到 H3 的 17k+5 网格（不低于 5）：落在网格上，末尾的 latent 步才正好覆盖这些帧。"""
    n = int(n)
    if n <= 5:
        return 5
    return 5 + 17 * int(round((n - 5) / 17.0))


def _context_latent_t(window):
    """window 帧上下文在 latent 时间轴上占的步数（每 17 帧 5 步、首步只含 1 帧）。"""
    return 2 + 5 * ((int(window) - 5) // 17)


def _inherited_identity_names(segments):
    """身份继承的参考图：第一个带参考素材的段的参考图（上限 4 张）。"""
    for seg in segments:
        names = (seg.get("refs") or {}).get("images") or []
        if names:
            return list(names)[:4]
    return []


def _identity_names(spec, segments):
    """本次生成要注入各段的身份参考图：配方「角色参考图」在前，段自带参考补齐；去重截 4。

    配方角色参考图（load_director_spec 的 identity_images）是身份的第一来源——分镜关键帧
    不含面部（背影 / 局部特写）时，它是唯一能锚住角色身份的东西；段自带参考（首个带参考
    素材的段）按既有语义补齐。
    """
    names = []
    for name in list(spec.get("identity_images") or []) + _inherited_identity_names(segments):
        if name not in names:
            names.append(name)
    return names[:4]


def _align_frame_count(n):
    """向上对齐到 H3 的 17k+5 帧网格。"""
    n = max(5, int(n))
    while n % 17 != 5:
        n += 1
    return n


def _align_frame_count_nearest(n, minimum=5):
    """就近对齐到 17k+5 帧网格（不低于 minimum）：总时长含上下文窗口时用它，避免向上对齐多出半个窗口。"""
    n = max(int(n), int(minimum))
    up = _align_frame_count(n)
    down = up - 17
    if down >= max(5, int(minimum)) and n - down < up - n:
        return down
    return up


def _panel_first(seg: dict) -> bool:
    """该段是否「分镜首帧」：i2v/fl2v 段自带首帧图（分镜格）→ 首帧锚点用它，连续性不再顶替它。"""
    return (seg.get("mode") or "t2v") in ("i2v", "fl2v") and bool(seg.get("ref_input"))


def _seg_duration(seg: dict) -> float:
    """段时长（秒）：配方给了正值用它，否则按 5 秒计（与执行时 length 缺省回退一致）。"""
    try:
        d = float(seg.get("duration_sec"))
    except (TypeError, ValueError):
        return 5.0
    return d if d > 0 else 5.0


def _chunk_compatible(seg: dict) -> bool:
    """该段能否进多帧单次分块：选中技能为多帧单次技能，且（文生/图生/尾帧/首尾帧、无自带参考素材）或 r2v
    （须带参考集，块内再校验各段参考一致）。"""
    if not is_multiframe_skill(seg.get("skill_id")):
        return False
    mode = seg.get("mode") or "t2v"
    if mode == "r2v":
        return bool(seg.get("refs") or {})
    return mode in ("t2v", "i2v", "l2v", "fl2v") and not (seg.get("refs") or {})


def _ref_signature(seg):
    """段的参考集签名（图/视频/音频各自按顺序）。多帧块内各段参考必须完全一致（含顺序）才能合并，
    这样 <Picture N> 编号在整块内保持一致；无参考的段恒为 ([], [], [])。"""
    refs = seg.get("refs") or {}
    return (tuple(refs.get("images") or []), tuple(refs.get("videos") or []), tuple(refs.get("audios") or []))


def _segment_references(seg):
    """seg.refs（{images,videos,audios}）→ body.references 列表（与逐段路径同格式），供多帧块共享参考集。"""
    refs = seg.get("refs") or {}
    out = []
    for name in (refs.get("images") or []):
        out.append({"kind": "input", "value": name})
    for name in (refs.get("videos") or []):
        out.append({"kind": "input", "value": name, "media": "video"})
    for name in (refs.get("audios") or []):
        out.append({"kind": "input", "value": name, "media": "audio"})
    return out


def _chunk_budget(shared: dict) -> float:
    """多帧单次分块的时长预算：取 shared.chunk_sec（缺省 15 秒）；0 = 关闭合并（纯逐段生成）。"""
    cs = shared.get("chunk_sec")
    return float(cs) if cs is not None else 15.0


def _chunk_anchor(seg) -> bool:
    """该段自带首帧锚点（自带首帧 / 分镜关键帧）吗？

    多帧技能模板没有图片入口（图片只经 minimax_keyframes 注入），自带首帧的段即使单独成块也得走多帧
    路径，否则模板会静默忽略这张图——段首就不是用户给的图。带自带参考素材的段按技能说明退回逐段执行
    （那类段不进多帧路径）；只带尾帧的段不在内——逐段路径下它走窗口连续性，帧数与成片对得上，
    尾帧锚点只在块内注入（见 _plan_multiframe_guides）。
    """
    if seg.get("refs"):
        return False
    return bool(seg.get("keyframe") or seg.get("ref_input"))


def _plan_chunks(segments, chunk_sec):
    """把段规划成执行单元：连续兼容段（总时长 ≤ chunk_sec）合并成一个多帧单次块，其余各成 legacy 单元。

    返回 [{"kind": "multi"/"legacy", "segs": [...]}]，顺序与输入一致、不丢段。chunk_sec <= 0 时不合并
    （仍逐段各跑一次）；单段的兼容块一般归 legacy（无锚点可加，多帧模板没有收益），但**自带首帧锚点的单段
    仍走多帧路径**（见 _chunk_anchor）——多帧技能模板没有图片入口，首帧只能靠关键帧锚点钉在段首。
    """
    budget = float(chunk_sec or 0)
    if budget <= 0:
        return [{"kind": "multi" if (_chunk_compatible(s) and _chunk_anchor(s)) else "legacy", "segs": [s]}
                for s in segments]
    units, cur, cur_dur = [], [], 0.0

    def flush():
        if not cur:
            return
        units.append({"kind": "multi" if (len(cur) > 1 or _chunk_anchor(cur[0])) else "legacy", "segs": list(cur)})
        cur.clear()

    for seg in segments:
        d = _seg_duration(seg)
        if not _chunk_compatible(seg) or d > budget:
            flush()
            units.append({"kind": "legacy", "segs": [seg]})
            continue
        if cur and (cur_dur + d > budget or _ref_signature(cur[0]) != _ref_signature(seg)):
            flush()
        cur.append(seg)
        cur_dur += d
    flush()
    return units


def _plan_multiframe_guides(segs, total_frames):
    """块内各段的累计起点 → 关键帧锚点帧号（24fps）。

    返回 ([{name, frame_idx}], skipped)：name 取段的关键帧（spec.keyframe，first_frame 优先于分镜图），
    fl2v 段另在段末钉一个尾帧锚点；落位超出 total_frames 的锚点跳过并计数。
    """
    guides, skipped = [], 0
    start = 0.0
    for seg in segs:
        d = _seg_duration(seg)
        name = seg.get("keyframe") or seg.get("ref_input")
        if name:
            idx = int(round(start * H3_FPS))
            if idx < total_frames:
                guides.append({"name": name, "frame_idx": idx})
            else:
                skipped += 1
        if (seg.get("mode") or "t2v") in ("fl2v", "l2v") and seg.get("last_input"):
            idx = min(int(round((start + d) * H3_FPS)) - 1, total_frames - 1)
            if idx >= 0:
                guides.append({"name": seg["last_input"], "frame_idx": idx})
        start += d
    return guides, skipped


def _fmt_ts(sec):
    """秒 → MM:SS.mmm（H3 提示词时间戳格式）。"""
    m = int(sec // 60)
    return f"{m:02d}:{sec - m * 60:06.3f}"


def _merge_chunk_prompt(segs):
    """把块内多段合并成一条多镜头提示词（多帧单次运行用）。

    单段直接用原文；多段按顺序机械拼接（[Shot N] + 切点时间戳），确定性、无 LLM 依赖。
    """
    if len(segs) == 1:
        return segs[0].get("prompt") or ""
    lines = []
    start = 0.0
    for i, seg in enumerate(segs, 1):
        d = _seg_duration(seg)
        lines.append(f"[Shot {i}] At {_fmt_ts(start)} cut... {str(seg.get('prompt') or '').strip()}")
        start += d
    return "\n".join(lines)


def _run_segment_graph(body, skill_id, model, steps, label="", vae=None, preview=True, node_id=None,
                       context_tail=None, context_frames=0, identity_names=(), context_mode=CONTEXT_MODES[0],
                       on_step=None, on_total=None):
    """单段执行链：解析参数 → 渲染模板 → 模型注入/VDN 校验 → 连续性注入 → 进程内执行，返回 VIDEO。

    recipe 逐段与 BUNDLE 单段共用；label 仅用于错误消息前缀（如「第 3 段：」）。
    vae/preview/node_id 控制采样期间节点内的实时预览（见 h3_preview）。
    on_step：每采样步回调（step_number），供 director 更新进度。
    on_total：总步数确定后回调（节点入参或各段 skill config），供 director 修正 total_steps。
    context_tail：跨段上下文（上段尾部 context_frames 帧，[F,H,W,C]）。context_mode="window" 时它是本段
    开头的重生成窗口——目标时长加 window 帧并就近对齐到 17k+5 网格，那段帧由调用方在拼接时丢掉；
    "reference" 时它只是目标之前的参考视频，不改时长、不丢帧。
    identity_names：继承到本段的身份参考图文件名（用 input 目录里的真实 LoadImage 加载）。
    """
    real_id = _resolve_skill_id(skill_id or "")
    template = load_skill_workflow(real_id)
    if template is None:
        raise RuntimeError(f"{label}skill '{skill_id}' 缺少 workflow.json，无法生成")
    cfg = get_skill_gen_config(real_id)
    params = resolve_video_params(body, cfg, skip_model=(model is not None))
    if steps is not None and int(steps) > 0:
        params["steps"] = int(steps)
    if on_total is not None:
        on_total(int(params.get("steps") or 0))  # 真实总步数（节点入参或该段 skill config），供前端进度条按比例推进
    window = int(context_frames or 0) if context_tail is not None else 0
    if window > 0 and context_mode == CONTEXT_MODES[0]:
        params["length"] = _align_frame_count_nearest(int(params.get("length") or 124) + window,
                                                     minimum=window + 5)
    ensure_reference_tags(template, params)
    graph, _warns = render_template(template, params)
    overrides = None
    if model is not None:
        x_id, pruned = _model_injection_node(graph)
        if x_id is None:
            raise RuntimeError(f"{label}无法定位模型注入点（缺少 KSampler/SigmaShift 的 model 输入）")
        for pid in pruned:
            del graph[pid]
        overrides = {x_id: [model]}
    else:
        _require_vdn_plugin(graph)
    graph, c_overrides = _inject_continuity_nodes(graph, context_tail, window, identity_names, context_mode)
    if c_overrides:
        overrides = {**(overrides or {}), **c_overrides}
    with preview_override(preview, vae, node_id, on_step=on_step):
        return execute_graph_inprocess(graph, output_type="VIDEO", overrides=overrides)


def _run_multiframe_unit(body, skill_id, model, steps, label="", vae=None, preview=True, node_id=None,
                         guides=(), context_tail=None, context_frames=0, identity_names=(),
                         on_step=None, on_total=None):
    """多帧单次分块执行链：渲染块内首段多帧技能的 workflow.json → 模型注入 / 连续性（身份 + 跨块上下文）→ 关键帧锚点 → 进程内执行，返回 VIDEO。

    skill_id 取块内首段的技能（决定 config.json 的模型 / LoRA 缺省与 ref2va 工作流模板）；guides 为 _plan_multiframe_guides 的
    [{name, frame_idx}]。跨块上下文固定 reference 模式——块边界由关键帧锚点钉住，上块尾部只作「目标之前」
    的参考视频（不改时长、不丢帧、不做接缝淡化）。
    """
    real_id = _resolve_skill_id(skill_id or "")
    cfg = get_skill_gen_config(real_id)
    template = load_skill_workflow(real_id)
    params = resolve_video_params(body, cfg, skip_model=(model is not None))
    if steps is not None and int(steps) > 0:
        params["steps"] = int(steps)
    if on_total is not None:
        on_total(int(params.get("steps") or 0))   # 真实总步数，供前端进度条按比例推进
    ensure_reference_tags(template, params)
    graph, _warns = render_template(template, params)
    overrides = None
    if model is not None:
        x_id, pruned = _model_injection_node(graph)
        if x_id is None:
            raise RuntimeError(f"{label}无法定位模型注入点（缺少 KSampler/SigmaShift 的 model 输入）")
        for pid in pruned:
            del graph[pid]
        overrides = {x_id: [model]}
    else:
        _require_vdn_plugin(graph)
    window = int(context_frames or 0) if context_tail is not None else 0
    graph, c_overrides = _inject_continuity_nodes(graph, context_tail, window, identity_names, "reference")
    if c_overrides:
        overrides = {**(overrides or {}), **c_overrides}
    graph, g_overrides = _inject_multiframe_guides(graph, guides)
    if g_overrides:
        overrides = {**(overrides or {}), **g_overrides}
    with preview_override(preview, vae, node_id, on_step=on_step):
        return execute_graph_inprocess(graph, output_type="VIDEO", overrides=overrides)


def parse_segment_selection(text, total: int):
    """解析「仅运行勾选的段」（节点时间轴勾选 / Studio 时间轴勾选写入的段号文本）。

    1 基段号，逗号 / 空格 / 顿号分隔（如 "1,3,5"）；空 = 全部段（返回 None）。
    返回 0 基段序号升序列表；段号非法或越界抛 ValueError（消息可直接回前端）。
    """
    raw = str(text or "").strip()
    if not raw:
        return None
    picked = []
    for token in re.split(r"[,，、\s]+", raw):
        if not token.isdigit():
            raise ValueError(f"「仅运行勾选的段」只接受段号（1 基，如 1,3,5），收到：{raw}")
        n = int(token)
        if n < 1 or n > total:
            raise ValueError(f"段号越界：第 {n} 段（配方共 {total} 段）")
        if n not in picked:
            picked.append(n)
    if not picked:
        return None
    return sorted(n - 1 for n in picked)


class NeoH3VideoDirector:
    """以 video_director 配方为参数逐段生成并拼接成单个含音频 VIDEO；连 NeoPromptAgent 的 BUNDLE 时按单片段生成（忽略配方）。"""

    @classmethod
    def INPUT_TYPES(cls):
        names = list_director_recipes()
        vskills = _gen_video_skills()
        default_skill = _default_video_skill(vskills)   # 可用技能里步数最少者；都不可用时在全列表里取步数最少者
        return {
            "required": {
                "recipe": (names, {"default": names[0] if names else "",
                                   "tooltip": "video_director 配方名：多段整片模式的分镜来源；接了 BUNDLE 时忽略配方。"}),
            },
            "optional": {
                "skill": ([_skill_label(s) for s in vskills], {"default": _skill_label(default_skill) if default_skill else "",
                                                               "tooltip": "仅 BUNDLE 单段模式用的视频 skill；配方多段模式忽略（各段自带 skill）。"}),  # BUNDLE 单段用的视频 skill（不可用带「（不可用）」后缀）；recipe 多段模式忽略（各段自带）
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**63 - 1,
                                 "tooltip": "-1 = 用配方 shared.seed（配方里存 -1 = 每次运行随机种子）；≥0 = 本次整片覆盖该种子。"}),   # -1 = 用配方 shared.seed
                "width": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION,
                                  "tooltip": "-1 = 优先配方 shared 分辨率，缺省回退各段 skill config（选配方时前端自动填）。"}),  # -1 = 优先配方 shared 分辨率，缺省回退各段 skill config（选中配方时前端自动填）
                "height": ("INT", {"default": -1, "min": -1, "max": comfy_nodes.MAX_RESOLUTION,
                                   "tooltip": "-1 = 优先配方 shared 分辨率，缺省回退各段 skill config（选配方时前端自动填）。"}),  # -1 = 优先配方 shared 分辨率，缺省回退各段 skill config（选中配方时前端自动填）
                "continuity": ("BOOLEAN", {"default": True,
                                           "tooltip": "跨段连续性总开关：开 = 上下文窗口 + 身份继承。"}),   # 跨段连续性总开关：开 = 上下文窗口 + 身份继承
                "context_frames": ("INT", {"default": 22, "min": 0, "max": 362,
                                           "tooltip": "上下文窗口帧数；0 = 退回尾帧链入（只带上一段尾帧）。"}),  # 上下文窗口帧数；0 = 退回 Tier A 尾帧链入
                "model": ("MODEL", {"tooltip": "外部加速模型；提供时覆盖每段内部主模型链（UNETLoader/LoRA/VDN）。"}),  # 外部加速模型；提供时覆盖每段内部主模型链（UNETLoader/LoRA/VDN）
                "steps": ("INT", {"default": -1, "min": -1, "max": 100,
                                  "tooltip": "-1 = 优先配方 shared.steps，缺省用各段 preset/config 的 steps。"}),  # -1 = 优先配方值，再退 preset/config
                "preview": ("BOOLEAN", {"default": True,
                                        "tooltip": "节点内实时预览：开 = taeh3 真彩动作预览，关 = 完全不出（省显存）。"}),   # 节点内实时预览：开 = taeh3 真彩动作预览，关 = 完全不出
                # 仅 BUNDLE 单段模式用（配方多段时各段自带 duration_sec）：秒 → 帧（24fps，向上对齐 17k+5 网格）
                # 默认 5 秒 = 内置 H3 skill config 的 length（124 帧）；前端选中 skill 后按该 skill 的 length 自动填秒数
                "duration_sec": ("INT", {"default": 5, "min": 1, "max": 150,
                                         "tooltip": "BUNDLE 单段时长（秒）：按 24fps 换算成 H3 帧数并对齐 17k+5 网格（5 秒 → 124 帧）；切换视频 skill 时按该 skill config 的 length 自动填"}),
                "bundle": ("STRING", {"forceInput": True}),   # NeoPromptAgent BUNDLE；提供时忽略 recipe，按单段生成
                # 仅运行勾选的段：节点/Studio 时间轴上勾选后写入（1 基段号，空 = 全部）。勾选是运行期临时状态，
                # 不写进配方；工作流加载时前端会重置为空，避免旧选择在下次运行里生效。
                "only_segments": ("STRING", {"default": "",
                                             "tooltip": "只运行勾选的段：填段号（1 基，逗号分隔，如 1,3,5）；空 = 全部段（由时间轴上的勾选自动写入）"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",   # 预览事件按节点 id 路由回节点内的动画面板
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "generate"
    CATEGORY = "Neo Studio"
    DESCRIPTION = "分镜视频导演：以 video_director 配方为参数，逐段生成并拼接成单个含音频 VIDEO（跨段上下文窗口保连续性）。"
    SEARCH_ALIASES = [
        "h3 director", "video director", "storyboard", "recipe", "segments", "multi segment",
        "h3 video", "bundle segment", "full film", "分镜", "分镜导演", "导演配方",
        "整片生成", "配方生成", "视频配方", "分段生成", "含音频视频", "单段生成",
    ]
    OUTPUT_TOOLTIPS = (
        "整片拼接后的 VIDEO（含音频，24fps），接 SaveVideo / 预览；接 NeoH3SegmentRun 的 film 可做单段重生成锚点。",
    )

    def _run_bundle_segment(self, payload, skill, seed, width, height, model, steps, vae=None, preview=True, node_id=None,
                           duration_sec=5):
        """BUNDLE 单段生成：提示词/参考来自 NeoPromptAgent 的 BUNDLE（data URI），视频 skill / 时长（秒）用节点入参，忽略 recipe。"""
        sid = _resolve_skill_id(skill)
        if not any(s["id"] == sid for s in _gen_video_skills()):
            raise ValueError(f"未选择有效的视频 skill：'{skill}'（需为含 workflow.json 的视频技能）")
        prompts = payload.get("prompts") or []
        prompt = str(prompts[0]).strip() if prompts else ""
        if not prompt:
            raise ValueError("BUNDLE 缺少提示词，无法生成视频")
        body = {"prompt": prompt}
        if int(seed) >= 0:
            body["seed"] = int(seed)
        in_w = int(width) if int(width) > 0 else 0
        in_h = int(height) if int(height) > 0 else 0
        if in_w > 0:
            body["width"] = in_w
        if in_h > 0:
            body["height"] = in_h
        body["length"] = _seconds_to_frames(int(duration_sec))
        refs = payload.get("references") or []
        if refs:
            body["references"] = list(refs)
        video = _run_segment_graph(body, sid, model, steps, vae=vae, preview=preview, node_id=node_id)
        comp = video.get_components()
        return (InputImpl.VideoFromComponents(
            Types.VideoComponents(images=comp.images, audio=comp.audio, frame_rate=Fraction(H3_FPS))
        ),)

    def generate(self, recipe, skill="", seed=-1, width=-1, height=-1, continuity=True, context_frames=22, model=None, steps=-1, duration_sec=5, bundle="", preview=True, unique_id=None, only_segments=""):
        payload = get_bundle(bundle) if bundle else None
        if payload:
            vae = load_h3_tiny_vae() if preview else None   # 预览解码器：一次生成内复用；关闭时不加载
            return self._run_bundle_segment(payload, skill, seed, width, height, model, steps, vae, preview, unique_id,
                                            duration_sec=duration_sec)
        spec = load_director_spec(recipe)
        segments = spec.get("segments") or []
        if not segments:
            raise ValueError(f"配方 '{recipe}' 没有可执行的段")
        # 只跑勾选的段（空 = 全部）；段号非法/越界在这里报错，消息可直接回前端
        keep = parse_segment_selection(only_segments, len(segments))
        return self._run_spec(spec, seed, width, height, continuity, context_frames, model, steps, preview, unique_id,
                              keep=keep)

    def _run_spec(self, spec, seed, width, height, continuity, context_frames, model, steps, preview, unique_id,
                  progress_index=0, progress_total=None, keep=None):
        """按 spec 逐段生成并拼接成单个含音频 VIDEO；配方多段运行与「单段重生成」共用同一条执行链。

        progress_index / progress_total：单段重生成时把进度映射回配方里的真实段序号与总段数
        （默认从 0 开始，即整条配方从头跑）。
        keep：只跑这些段（0 基原始段序号；None = 全部段）。跳过段不生成也不进成片，但 seed / 进度 /
        报错文案仍按原始段序号，同一段在整片运行与部分运行里结果一致。
        首帧锚点：i2v/fl2v 段自带首帧图（分镜格）时用它，上段尾部只作为「目标之前」的参考视频；
        没自带首帧图时才由连续性接手（窗口第 0 帧 / Tier A 上段尾帧）。
        """
        vae = load_h3_tiny_vae() if preview else None   # 预览解码器：一次生成内复用；关闭时不加载
        shared = spec.get("shared") or {}
        all_segments = spec.get("segments") or []
        runs = [(i, seg) for i, seg in enumerate(all_segments) if keep is None or i in keep]
        if not runs:
            raise ValueError("没有勾选任何段：请在时间轴上勾选要运行的段")
        segments = [seg for _, seg in runs]   # 实际执行的子序列（分块/循环都基于它）
        orig = [i for i, _ in runs]           # 子序列各段的原始段序号

        base_seed = int(seed) if int(seed) >= 0 else (int(shared.get("seed", 0)) if shared.get("seed") is not None else 0)
        # 配方 shared.seed = -1 → 本次运行随机取种子；各段仍按 base_seed + 原始段序号派生，重跑同一段结果一致
        if base_seed < 0:
            base_seed = random.randrange(2 ** 63)
        # width/height：节点入参 > 0 时覆盖全部段；-1 时优先配方 shared 分辨率，缺省再回退各段 skill config 默认。
        in_w = int(width) if int(width) > 0 else int(shared.get("width") or 0)
        in_h = int(height) if int(height) > 0 else int(shared.get("height") or 0)

        # 跨段上下文窗口：上段尾部 window 帧作为下段开头的重生成窗口（0 = 退回 Tier A 的尾帧链入）
        window = _align_context_frames(context_frames) if continuity and int(context_frames or 0) > 0 else 0
        identity_names = _identity_names(spec, segments) if continuity else []

        ctx = get_executing_context()
        _DIRECTOR_PROGRESS.update(active=True, segment_index=progress_index - 1,
                                  total_segments=max(1, int(progress_total or len(all_segments))), step=0,
                                  total_steps=max(1, int(steps)) if int(steps) > 0 else 0,
                                  prompt_id=getattr(ctx, "prompt_id", None))
        all_frames = []
        all_audio = []
        drops = []       # 与执行单元（每次 all_audio.append）对齐：该单元丢掉的头部帧数（窗口帧数 / Tier A 的 1 帧 / 0）
        prev_tail = None
        # 多帧单次分块：连续兼容段合并成一次 ref2va 运行、关键帧锚点钉在各段累计起点；
        # 不兼容（自带参考素材 / 超长）或超预算的段退回逐段路径。整配方「多帧合并」开关关闭时不再合并，
        # 但自带锚点帧的段仍走多帧路径（多帧技能模板没有图片入口，首/尾帧只能在多帧路径里钉住，见 _chunk_anchor）。
        units = _plan_chunks(segments, _chunk_budget(shared))
        multi_at, consumed = {}, set()   # 多帧块首段在子序列里的下标 → 块内段；块内其余段由 consumed 跳过
        offset = 0
        for unit in units:
            if unit["kind"] == "multi":
                multi_at[offset] = unit["segs"]
                consumed.update(range(offset + 1, offset + len(unit["segs"])))
            offset += len(unit["segs"])
        try:
            # pos = 子序列下标（跨段衔接只看它：首个执行单元没有上文）；i = 原始段序号（seed / 进度 / 文案用）
            for pos, (i, seg) in enumerate(runs):
                _DIRECTOR_PROGRESS["segment_index"] = progress_index + i
                _DIRECTOR_PROGRESS["step"] = 0
                m_segs = multi_at.get(pos)
                if m_segs is not None:
                    # 多帧单次：整块一次 ref2va；跨块上下文只走 reference（不改时长、不丢帧、不做接缝淡化）
                    total_sec = sum(_seg_duration(s) for s in m_segs)
                    total_frames = _align_frame_count(int(round(total_sec * H3_FPS)))
                    guides, n_skipped = _plan_multiframe_guides(m_segs, total_frames)
                    label = f"第 {orig[pos] + 1}–{orig[pos + len(m_segs) - 1] + 1} 段"
                    if n_skipped:
                        print(f"[Neo Studio] 多帧单次块（{label}）：{n_skipped} 个关键帧锚点超出帧预算，已跳过")
                    prompt = _merge_chunk_prompt(m_segs)
                    body = {"prompt": prompt, "seed": (base_seed + orig[pos]) % (2**63), "length": total_frames}
                    if in_w > 0:
                        body["width"] = in_w
                    if in_h > 0:
                        body["height"] = in_h
                    references = _segment_references(m_segs[0])
                    if references:
                        body["references"] = references
                    context_tail = None
                    if window > 0 and prev_tail is not None and prev_tail.shape[0] >= window:
                        context_tail = prev_tail
                    video = _run_multiframe_unit(body, m_segs[0].get("skill_id") or "", model, steps,
                                                 f"多帧块（{label}）：", vae, preview, unique_id,
                                                 guides=guides, context_tail=context_tail, context_frames=window,
                                                 identity_names=identity_names,
                                                 on_step=lambda s: _DIRECTOR_PROGRESS.__setitem__("step", s),
                                                 on_total=lambda n: _DIRECTOR_PROGRESS.__setitem__("total_steps", max(1, int(n) or 1)))
                    comp = video.get_components()
                    all_frames.append(comp.images)
                    drops.append(0)
                    all_audio.append(comp.audio)
                    prev_tail = comp.images[-window:] if window > 0 else comp.images[-1:]
                    continue
                if pos in consumed:
                    continue   # 已并入上面的多帧块
                prompt = seg.get("prompt", "")
                body = {
                    "prompt": prompt,
                    "seed": (base_seed + i) % (2**63),
                }
                if in_w > 0:
                    body["width"] = in_w
                if in_h > 0:
                    body["height"] = in_h
                dur = seg.get("duration_sec")
                if dur is not None and float(dur) > 0:
                    body["length"] = _seconds_to_frames(float(dur))

                mode = seg.get("mode") or "t2v"
                # 分镜首帧段（i2v/fl2v 自带首帧图）：首帧锚点用它，不再被连续性顶替；上段尾部随之改为
                # 「目标之前」的参考视频（不重生成、不丢帧）——段首就是本段分镜图。
                panel_anchor = _panel_first(seg)
                segment_context = "reference" if panel_anchor else CONTEXT_MODES[0]

                # 跨段上下文：上段尾部 window 帧（上段得够长）
                context_tail = None
                if window > 0 and prev_tail is not None and prev_tail.shape[0] >= window:
                    context_tail = prev_tail

                # 按段模式组装参考（T2V 段不带任何参考）：
                #   i2v/fl2v 首帧：本段分镜首帧图优先；否则窗口第 0 帧 / Tier A 链入上段尾帧
                #   l2v 只带尾帧锁收尾（不注首帧，节点侧保持 L2VA）
                #   r2v 全参考：参考素材（图/视频/音频），第一个参考视频即源视频
                #   fl2v 另带尾帧锁收尾
                refs = []
                chained = False
                
                if mode in ("i2v", "fl2v"):
                    primary_input = None
                    if panel_anchor:
                        primary_input = seg["ref_input"]
                        refs.append({"kind": "input", "value": primary_input})
                    elif context_tail is not None:
                        # 窗口的第 0 帧就是目标第 0 帧：拿它当首帧（与窗口行同内容）
                        refs.append({"kind": "data", "data": _image_to_data_uri(context_tail[:1])})
                        chained = True
                    elif continuity and pos > 0 and prev_tail is not None:
                        refs.append({"kind": "data", "data": _image_to_data_uri(prev_tail[-1:])})
                        chained = True
                elif mode == "r2v":
                    primary_input = None
                    chained = context_tail is not None
                if mode in ("i2v", "fl2v", "l2v", "r2v"):
                    seg_refs = seg.get("refs") or {}
                    for name in (seg_refs.get("images") or []):
                        if name != primary_input:
                            refs.append({"kind": "input", "value": name})
                    for name in (seg_refs.get("videos") or []):
                        refs.append({"kind": "input", "value": name, "media": "video"})
                    for name in (seg_refs.get("audios") or []):
                        refs.append({"kind": "input", "value": name, "media": "audio"})
                # 身份参考：配方角色参考图 + 段自带参考，注入每个还没有这些图的段
                # （首段也在内——分镜关键帧没脸时它是唯一的身份锚点；段自带的参考不重复注入）
                sent = {r["value"] for r in refs if r.get("kind") == "input"}
                inherited = [n for n in identity_names if n not in sent]
                if refs:
                    body["references"] = refs
                if mode in ("fl2v", "l2v"):
                    if not seg.get("last_input"):
                        raise ValueError(f"第 {i + 1} 段为{'首尾帧' if mode == 'fl2v' else '尾帧'}生视频但缺少尾帧：请为该段设置尾帧图")
                    body["last_frame"] = {"kind": "input", "value": seg["last_input"]}
                if mode in ("i2v", "fl2v") and not refs and context_tail is None:
                    raise ValueError(
                        f"第 {i + 1} 段为{'首尾帧' if mode == 'fl2v' else '图生视频'}但没有可用首帧：" +
                        ("请为该段设置首帧，或开启「连续性」以上段尾帧 / 上下文窗口链入"
                         if pos > 0 else "首段需自带首帧"))

                video = _run_segment_graph(body, seg.get("skill_id") or "", model, steps, f"第 {i + 1} 段：",
                                           vae, preview, unique_id, context_tail=context_tail,
                                           context_frames=window, identity_names=inherited,
                                           context_mode=segment_context,
                                           on_step=lambda s: _DIRECTOR_PROGRESS.__setitem__("step", s),
                                           on_total=lambda n: _DIRECTOR_PROGRESS.__setitem__("total_steps", max(1, int(n) or 1)))
                comp = video.get_components()
                frames = comp.images

                # 丢掉头部：窗口模式丢本段重生成的那 window 帧；Tier A 丢与上段重复的一帧；
                # 分镜首帧段两者都不丢（段首就是本段分镜图）。窗口模式丢帧前先把重合区与上一段真实尾帧
                # 交叉淡化（帧数不变），接缝不再硬切。
                drop = window if (context_tail is not None and segment_context == CONTEXT_MODES[0]) \
                    else (1 if (pos > 0 and chained) else 0)
                if context_tail is not None and segment_context == CONTEXT_MODES[0] and all_frames:
                    all_frames[-1] = _blend_seam(all_frames[-1], frames, drop, SEAM_BLEND_FRAMES)
                all_frames.append(frames[drop:] if drop and frames.shape[0] > drop else frames)
                drops.append(drop)
                all_audio.append(comp.audio)
                prev_tail = frames[-window:] if window > 0 else frames[-1:]

            final_frames = torch.cat(all_frames, dim=0)
            final_audio = _concat_segment_audio(all_audio, H3_FPS, drops)
            return (InputImpl.VideoFromComponents(
                Types.VideoComponents(images=final_frames, audio=final_audio, frame_rate=Fraction(H3_FPS))
            ),)
        finally:
            _DIRECTOR_PROGRESS.update(active=False, segment_index=-1, total_segments=0, step=0, total_steps=0,
                                      prompt_id=None)


# ===========================================================================
# 图片分镜（storyboard）逻辑已迁至 storyboard.py（独立于节点运行时）。
# ===========================================================================


NODE_CLASS_MAPPINGS = {"NeoH3VideoDirector": NeoH3VideoDirector, "NeoH3AddKeyframe": NeoH3AddKeyframe,
                       "NeoH3AddContext": NeoH3AddContext, "NeoH3AddGuides": NeoH3AddGuides}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoH3VideoDirector": "Neo H3 Video Director",
                              "NeoH3AddKeyframe": "Neo H3 Add Keyframe (Hybrid)",
                              "NeoH3AddContext": "Neo H3 Add Context (Cross-segment)",
                              "NeoH3AddGuides": "Neo H3 Add Guides (Multiframe)"}
