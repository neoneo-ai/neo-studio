"""Neo H3 单段生成/重生成：把「配方里的某一段」当成一次正常的队列执行来跑。

为什么走队列（而不是像导演那样进程内执行）：
- 显存由 ComfyUI 的执行器负责（模型装载/卸载、OOM 前的腾挪），队列外自加载容易和画布上驻留的权重叠加；
- 执行上下文（`torch.inference_mode()`）是线程本地的，只有队列执行器里才有；
- 进度条与取消（`interrupt`）直接用 ComfyUI 自己的，不用另造一套；
- 采样期间的实时预览走插件自己的 taeh3 通道（`rs.h3.preview`，见 h3_preview）：`_run_spec` 在
  `NeoH3SegmentRun` 自己的执行里安装预览钩子，因此可以路由回编辑器所属的那个节点面板。

两种用途：
- **重生成**（配方已有成片）：从成片里按段帧区间取前后真实帧当首/尾锚点，换种子只重跑这一段；
- **单段直出/调试**（配方还没跑出过硬结果）：不用锚点，按该段自身的模式与参考直接生成。

执行链复用 `NeoH3VideoDirector._run_spec`（单段 spec → 逐段执行 → 拼接），所以模板渲染、技能解析、
身份参考补齐、帧数对齐等规则与整条配方运行时完全一致。
"""

import asyncio
import datetime
import logging
import random
import re
import time
import uuid
from pathlib import Path

import av
import folder_paths
import torch
from aiohttp import web
from comfy_api.latest import Types
from comfy_execution.utils import get_executing_context
from PIL import Image
from server import PromptServer

from .h3_preview import clear_latest_preview
from .h3_video_director import (
    NeoH3VideoDirector,
    _align_context_frames,
    _align_frame_count_nearest,
    _panel_first,
)
from .h3_video_gen import _gen_video_skills, _resolve_skill_id, _seconds_to_frames
from .image_gen import _error_from_history, _lookup, _progress_for, submit_graph
from .recipes import (add_recipe_results, is_preset_recipe, list_director_recipes, list_recipe_results,
                      load_director_spec)
from .skill import get_skill_gen_config, load_skill_workflow
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

# 锚点模式（节点下拉用中文标签，接口/内部用键）
ANCHOR_LABELS = ("两端锚点", "只钉首帧", "不用锚点")
_ANCHOR_KEYS = {label: key for label, key in zip(ANCHOR_LABELS, ("both", "first", "none"))}

# 单段任务的运行元数据：prompt_id -> {...}。只放"这次执行从哪来、预览推给谁、产物落在哪"这类小字段，
# 由本模块的提交路由写入、由 NeoH3SegmentRun 在队列里读回，任务结束即删。
_RUNS: dict = {}

TASK_TTL = 3600.0     # 任务记录保留时长（秒）
POLL_INTERVAL = 0.5   # 轮询队列状态的间隔（秒）
SEG_OUT_SUBDIR = "neo_director_regen"   # 单段重生成落盘的输出目录（拼接成片在 h3_assemble 里落 neo_director_merge）


def _safe_name(text) -> str:
    """文件名安全化（配方名可能带空格/中文/其它字符）。"""
    return re.sub(r"[^\w\-.]+", "_", str(text or "")).strip("_") or "recipe"


def _segment_length(seg: dict) -> int:
    """该段的目标帧数：配方段时长优先，缺省用该段 skill config 的 length（与 resolve_video_params 的回退一致）。"""
    dur = seg.get("duration_sec")
    if dur is not None and float(dur) > 0:
        return _seconds_to_frames(float(dur))
    cfg = get_skill_gen_config(_resolve_skill_id(seg.get("skill_id") or "")) or {}
    return max(5, int(cfg.get("length") or 124))


def _segment_frame_ranges(spec: dict, continuity: bool, context_frames: int) -> list:
    """复算每段在成片里的帧区间 [(start, kept, generated)]，用于把成片帧映射回段边界。

    派生规则与 _run_spec 完全一致：分镜首帧段（i2v/fl2v 自带首帧图）不加窗口、不丢帧；
    其余段窗口模式各段多生成 window 帧、丢掉头部 window 帧；Tier A（window=0）下 i2v/fl2v 段
    链入上段尾帧、丢 1 帧。
    """
    window = _align_context_frames(context_frames) if continuity and int(context_frames or 0) > 0 else 0
    ranges = []
    start = 0
    prev_generated = 0
    for i, seg in enumerate(spec.get("segments") or []):
        length = _segment_length(seg)
        panel = _panel_first(seg)
        has_context = not panel and window > 0 and i > 0 and prev_generated >= window
        generated = _align_frame_count_nearest(length + window, minimum=window + 5) if has_context else length
        chained = not panel and (has_context or (continuity and i > 0 and (seg.get("mode") or "t2v") in ("i2v", "fl2v")))
        drop = min(window if has_context else (1 if chained else 0), generated)
        ranges.append((start, generated - drop, generated))
        start += generated - drop
        prev_generated = generated
    return ranges


def _video_size(path: str) -> tuple:
    """成片分辨率 (W, H)：容器元数据，不解码。"""
    with av.open(path, mode="r") as container:
        stream = container.streams.video[0]
        return int(stream.width or 0), int(stream.height or 0)


def _video_frame_count(path: str) -> int:
    """成片帧数：优先用容器元数据，缺失时按时长×帧率估算（不解码）。"""
    with av.open(path, mode="r") as container:
        stream = container.streams.video[0]
        if stream.frames:
            return int(stream.frames)
        duration = float(stream.duration * stream.time_base) if stream.duration else 0.0
        return int(round(duration * float(stream.average_rate or 0)))


def _read_video_frames(path: str, indices) -> dict:
    """取成片里指定下标的帧 {index: [H,W,C] float 0-1}：顺序解码到最后一个目标即停，不进整片内存。"""
    want = sorted({int(i) for i in indices if int(i) >= 0})
    if not want:
        return {}
    last = want[-1]
    found = {}
    with av.open(path, mode="r") as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        for index, frame in enumerate(container.decode(stream)):
            if index in want:
                found[index] = torch.from_numpy(frame.to_ndarray(format="rgb24")).float().div_(255.0)
            if index >= last:
                break
    return found


def _save_anchor_png(frame, name: str) -> str:
    """把锚点帧写成 input/NeoAgent/<name>.png，返回相对名（模板的 LoadImage 占位符直接用）。"""
    dest_dir = Path(folder_paths.get_input_directory()) / "NeoAgent"
    dest_dir.mkdir(parents=True, exist_ok=True)
    arr = (frame.clamp(0.0, 1.0) * 255.0).round().to(torch.uint8).numpy()
    Image.fromarray(arr).save(dest_dir / f"{name}.png")
    return f"NeoAgent/{name}.png"


def _template_has_anchor(template: dict, need_last: bool) -> bool:
    """模板是否带锚点占位符：尾帧锚点要 {{REF_IMAGE_LAST}}，只钉首帧要 {{REF_IMAGE}} / {{REF_IMAGE_1}}。"""
    tokens = ("{{REF_IMAGE_LAST}}",) if need_last else ("{{REF_IMAGE}}", "{{REF_IMAGE_1}}")
    for node in (template or {}).values():
        for value in ((node or {}).get("inputs") or {}).values():
            if isinstance(value, str) and any(tok in value for tok in tokens):
                return True
    return False


def _pick_anchor_skill(seg_skill: str, need_last: bool) -> str:
    """挑一个支持锚点的视频技能：优先沿用本段技能（占位符够用），否则取第一个支持的。"""
    if seg_skill and _template_has_anchor(load_skill_workflow(_resolve_skill_id(seg_skill)), need_last):
        return seg_skill
    for skill in _gen_video_skills():
        if _template_has_anchor(load_skill_workflow(skill["id"]), need_last):
            return skill["id"]
    raise ValueError("没有支持首/尾帧锚点的视频技能：请先建一个带首尾帧的 H3 技能（模板含 {{REF_IMAGE}} / {{REF_IMAGE_LAST}}）")


def _film_candidates(recipe: str) -> list:
    """成片候选（配方 results 里非单段产物的视频，最新在前）：供「基于哪个成片取锚点」的选择与提示。"""
    return [entry for entry in list_recipe_results(recipe)
            if entry.get("kind") == "video" and entry.get("segment") is None]


def _film_entry(recipe: str, film: str | None = None) -> dict | None:
    """选成片结果条目：默认最新的一条「非单段产物」视频（带 segment 的是片段，跳过）。

    指定 film 时按文件名取（也接受 `subfolder/文件名`），不在配方结果里则报错而不是回落到别的成片。
    """
    candidates = _film_candidates(recipe)
    if film:
        name = str(film).strip()
        for entry in candidates:
            full = f"{entry.get('subfolder', '')}/{entry['filename']}".lstrip("/")
            if name in (entry["filename"], full):
                return entry
        names = "、".join(entry["filename"] for entry in candidates) or "无"
        raise ValueError(f"指定的成片不在该配方的结果里：{name}（可选：{names}）")
    return candidates[0] if candidates else None


def film_layout(film: dict, spec: dict, continuity: bool, context_frames: int) -> list:
    """成片里各段的帧区间 [(start, kept)]，用于按段边界取锚点帧。

    优先用结果条目里记的 `layout`（逐段保留帧数，由「拼接成片」写入：那是该成片真实的段边界）；
    没有 layout 的成片（整条配方直出、或旧记录）按当前配方复算，并要求总帧数严格吻合。
    """
    segments = spec.get("segments") or []
    total = _video_frame_count(film["path"])
    layout = [int(n) for n in (film.get("layout") or []) if int(n) > 0]
    if layout and len(layout) == len(segments) and sum(layout) == total:
        out = []
        start = 0
        for kept in layout:
            out.append((start, kept))
            start += kept
        return out
    ranges = _segment_frame_ranges(spec, continuity, context_frames)
    expected = ranges[-1][0] + ranges[-1][1]
    if total != expected:
        raise ValueError(_frame_count_error(total, expected, continuity, context_frames, film["filename"]))
    return [(start, kept) for start, kept, _generated in ranges]


def _regen_spec(spec: dict, index: int, mode, first_name, last_name, skill_id: str) -> dict:
    """把配方第 index 段改成「锚点单段」的 spec：mode/skill 按可用锚点定，其余字段原样保留。

    配方级身份参考图（identity_images）一并带下去：单段重生成走同一条身份注入通路，
    不塞 refs.images —— i2v/fl2v 模板只有单路首帧槽位，塞进去也不会生效。
    """
    seg = dict((spec.get("segments") or [])[index])
    if mode:
        seg["mode"] = mode
        seg["ref_input"] = first_name
        seg["last_input"] = last_name
    if skill_id:
        seg["skill_id"] = skill_id
    single = {"shared": dict(spec.get("shared") or {}), "segments": [seg]}
    if spec.get("identity_images"):
        single["identity_images"] = list(spec["identity_images"])
    return single


def resolve_anchors(spec: dict, index: int, anchors: str, continuity: bool, context_frames: int,
                    warnings: list, film: dict | None = None) -> tuple:
    """按成片段边界取首/尾锚点帧并落盘，返回 (可用锚点模式, 首帧名, 尾帧名)；取不到就降级并在 warnings 里说明。

    film 为成片结果条目（`_film_entry`，含 path/filename/layout?）；None 表示该配方没有成片可用。
    """
    if film is None:
        warnings.append("该配方还没有可用的成片，已改为不用锚点直接生成这一段")
        return "none", None, None

    layout = film_layout(film, spec, continuity, context_frames)   # 帧数对不上时在这里报错并点名成片
    total = layout[-1][0] + layout[-1][1]
    start, kept = layout[index]
    head_index = start - 1 if start > 0 else start          # 首段没有上一段尾帧，用本段自己的首帧
    tail_index = start + kept if start + kept < total else None
    frames = _read_video_frames(film["path"], [i for i in (head_index, tail_index) if i is not None])

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = _safe_name(Path(film["filename"]).stem or "film")   # 锚点名带成片名：一眼看出帧取自哪个结果
    first_name = last_name = None
    if head_index in frames:
        first_name = _save_anchor_png(frames[head_index], f"{base}_s{index + 1}_first_{stamp}")
    need_last = anchors == "both" and tail_index is not None
    if need_last and tail_index in frames:
        last_name = _save_anchor_png(frames[tail_index], f"{base}_s{index + 1}_last_{stamp}")
    if anchors == "both" and last_name is None and first_name:
        warnings.append("该段没有可用的尾帧锚点（末段）：只用首帧锚点")
    if first_name and last_name:
        return "both", first_name, last_name
    if first_name:
        return "first", first_name, None
    warnings.append("成片里取不到锚点帧，已改为不用锚点直接生成这一段")
    return "none", None, None


# ===========================================================================
# 单段执行（节点内调用，因此跑在 ComfyUI 执行器里）
# ===========================================================================

def run_single_segment(recipe: str, index: int, anchors: str, seed: int, *, steps: int = -1,
                       continuity: bool = True, context_frames: int = 22, preview: bool = True,
                       preview_node_id=None, record: bool = True, anchors_ready=None, film: str = "") -> dict:
    """跑配方里的第 index 段（0 起）：解析成片/锚点 → 单段 spec → 执行 →（可选）落盘并记进配方结果。

    film 指定用哪个成片结果取锚点（文件名或 `subfolder/文件名`；空 = 最新的成片结果）。
    anchors_ready：(mode, first_name, last_name) 已解析好时直接复用，不再解一次成片。
    返回 {video, filename, subfolder, seed, frames, anchors, film, warnings}。
    """
    if not recipe:
        raise ValueError("缺少配方名")
    if is_preset_recipe(recipe):
        raise ValueError("内置预设配方只读：请先「复制配方」再做单段生成")
    spec = load_director_spec(recipe)
    segments = spec.get("segments") or []
    if index < 0 or index >= len(segments):
        raise ValueError(f"段序号越界：第 {index + 1} 段（配方共 {len(segments)} 段）")
    if anchors not in ("both", "first", "none"):
        raise ValueError(f"未知锚点模式：{anchors}")

    film_entry = _film_entry(recipe, film) if anchors != "none" else None
    warnings = []
    # 锚点帧来自成片 → 就按成片的像素尺寸生成：同尺寸才能和成片无缝拼回（否则拼接只能缩放，必然掉画质）
    width = height = -1
    if film_entry is not None:
        size = _video_size(film_entry["path"])
        if all(size):
            width, height = size
            shared = spec.get("shared") or {}
            want = (int(shared.get("width") or 0), int(shared.get("height") or 0))
            if all(want) and want != size:
                warnings.append(f"按成片尺寸 {size[0]}×{size[1]} 生成（配方共享分辨率是 {want[0]}×{want[1]}）："
                                f"锚点帧取自该成片，同尺寸才能无缝拼回")
    first_name = last_name = None
    if anchors != "none":
        if anchors_ready:
            anchors, first_name, last_name = anchors_ready
        else:
            anchors, first_name, last_name = resolve_anchors(spec, index, anchors, continuity, context_frames,
                                                             warnings, film_entry)
    mode = {"both": "fl2v", "first": "i2v"}.get(anchors)
    skill_id = _pick_anchor_skill(segments[index].get("skill_id") or "", need_last=(mode == "fl2v")) if mode else ""
    single = _regen_spec(spec, index, mode, first_name, last_name, skill_id)

    if seed is None or int(seed) < 0:
        seed = random.randint(0, 2 ** 63 - 1)   # 默认换种子：同参数同种子会得到几乎一样的结果
    seed = int(seed)
    # 传真实 continuity：身份参考随连续性生效（与整条配方一致）；context_frames=0 保证单段不链入上下文窗口
    (video,) = NeoH3VideoDirector()._run_spec(single, seed, width, height, continuity=continuity, context_frames=0,
                                              model=None, steps=int(steps), preview=bool(preview),
                                              unique_id=preview_node_id)
    frames = int(video.get_components().images.shape[0])

    filename = None
    if record:
        out_dir = Path(folder_paths.get_output_directory()) / SEG_OUT_SUBDIR
        out_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{_safe_name(recipe)}_s{index + 1}_{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.mp4"
        video.save_to(str(out_dir / filename), format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
        add_recipe_results(recipe, [{
            "filename": filename, "subfolder": SEG_OUT_SUBDIR, "type": "output",
            "kind": "video", "segment": index, "seed": seed,
        }])
    return {"video": video, "filename": filename, "subfolder": SEG_OUT_SUBDIR, "seed": seed,
            "frames": frames, "anchors": anchors,
            "film": film_entry["filename"] if film_entry else None, "warnings": warnings}


class NeoH3SegmentRun:
    """单段生成/重生成：跑 video_director 配方里的某一段（可选把成片里的前后真实帧当首/尾锚点）。

    跑在 ComfyUI 执行器里，所以显存、进度条、取消都由它负责；采样期间的实时预览走插件自己的
    tae3h 通道。产物默认同时写进配方「结果」区（`record` 关掉则只出 VIDEO，接 SaveVideo 自己存）。
    配方还没有成片时（还没跑过整条配方）锚点自动降级为「不用锚点」，可直接用本节点单段调试。
    """

    @classmethod
    def INPUT_TYPES(cls):
        recipes = list_director_recipes()
        return {
            "required": {
                "recipe": (recipes or [""], {"default": recipes[0] if recipes else ""}),
                "segment": ("INT", {"default": 1, "min": 1, "max": 999, "step": 1,
                                    "tooltip": "配方里的段号（1 基）。"}),
                "anchors": (list(ANCHOR_LABELS), {"default": ANCHOR_LABELS[0],
                                                  "tooltip": "用成片里的哪些真实帧当锚点；配方还没有成片时自动降级为不用锚点。"}),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2 ** 63 - 1,
                                 "tooltip": "-1 = 用配方该段的 seed；换种子重生成时填 ≥0。"}),
                "record": ("BOOLEAN", {"default": True,
                                       "tooltip": "开 = 产物同时写进配方「结果」区；关 = 只出 VIDEO，自己接 SaveVideo。"}),
            },
            "optional": {
                "steps": ("INT", {"default": -1, "min": -1, "max": 200}),
                "preview": ("BOOLEAN", {"default": True}),
                "continuity": ("BOOLEAN", {"default": True}),
                "context_frames": ("INT", {"default": 22, "min": 0, "max": 362}),
                "film": ("STRING", {"default": "",
                                    "tooltip": "成片文件名（配方「结果」区里的名字）：取其中的前后真实帧当锚点；空 = 用当前记录的最新成片。"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "run_segment"
    CATEGORY = "Neo Studio"
    # 本节点是「生成这一段」的动作节点：执行本身就是目的（产物默认记进配方结果），
    # 因此按 ComfyUI 约定声明为输出节点——否则单节点 prompt 会被队列以 "Prompt has no outputs" 拒绝，
    # 画布上不接 SaveVideo 也不会执行。
    OUTPUT_NODE = True
    DESCRIPTION = "单段生成/重生成：跑配方里的某一段，可选用成片结果里的前后真实帧当锚点（换种子重生成）。"
    SEARCH_ALIASES = [
        "h3 segment", "segment run", "single segment", "regenerate", "reroll segment",
        "segment anchor", "film anchor", "h3 debug", "单段", "单段生成", "单段重生成",
        "分段生成", "重生成", "换种子", "锚点", "段调试",
    ]
    OUTPUT_TOOLTIPS = (
        "本段生成的 VIDEO（含音频）。record 开着时同时写进配方「结果」区，可接 SaveVideo 单独存。",
    )

    def run_segment(self, recipe, segment, anchors, seed, record=True, steps=-1, preview=True,
                    continuity=True, context_frames=22, film="", unique_id=None):
        ctx = get_executing_context()
        prompt_id = getattr(ctx, "prompt_id", None)
        meta = _RUNS.get(prompt_id) or {}
        index = max(0, int(segment) - 1)
        result = run_single_segment(recipe, index, _ANCHOR_KEYS.get(anchors, "both"), int(seed),
                                    steps=int(steps), continuity=bool(continuity),
                                    context_frames=int(context_frames), preview=bool(preview),
                                    preview_node_id=meta.get("preview_node_id") or unique_id,
                                    record=bool(record), anchors_ready=meta.get("anchors"),
                                    film=str(film or "").strip())
        if prompt_id and prompt_id in _RUNS:
            meta.update({"filename": result["filename"], "seed": result["seed"], "frames": result["frames"],
                         "anchors": result["anchors"], "film": result["film"],
                         "warnings": result["warnings"]})
            _RUNS[prompt_id] = meta
        return (result["video"],)


# ===========================================================================
# 单段任务：提交到 ComfyUI 执行队列 + 进度/结果/取消
# ===========================================================================

_SEGMENT_TASKS: dict = {}     # task_id -> 快照字段（状态/进度/产物名）
_SEGMENT_WATCHERS: dict = {}  # task_id -> asyncio.Task


def _snapshot(task: dict) -> dict:
    return {key: task[key] for key in (
        "task_id", "prompt_id", "status", "recipe", "segment", "seed",
        "filename", "subfolder", "film", "progress", "warnings", "error", "created", "updated")}


def _prune_tasks() -> None:
    """清掉过期或超额的历史任务记录（运行中的不动）。"""
    now = time.time()
    for task in [t for t in _SEGMENT_TASKS.values() if t["status"] not in ("queued", "running")]:
        if now - task["updated"] > TASK_TTL:
            _SEGMENT_TASKS.pop(task["task_id"], None)
    while len(_SEGMENT_TASKS) > 32:
        oldest = min((t for t in _SEGMENT_TASKS.values() if t["status"] not in ("queued", "running")),
                     key=lambda t: t["updated"], default=None)
        if oldest is None:
            return
        _SEGMENT_TASKS.pop(oldest["task_id"], None)


async def _watch(task_id: str) -> None:
    """轮询队列状态直到结束：更新进度、收产物名与错误（产物由节点自己落盘并写回 _RUNS）。"""
    task = _SEGMENT_TASKS.get(task_id)
    if task is None:
        return
    prompt_id = task["prompt_id"]
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        task = _SEGMENT_TASKS.get(task_id)
        if task is None or task["status"] not in ("queued", "running"):
            return
        state, item = _lookup(prompt_id)
        if state == "done":
            error, cancelled = _error_from_history(item)
            meta = _RUNS.pop(prompt_id, {}) or {}
            clear_latest_preview(meta.get("preview_node_id"))   # 终态后紧凑档没人再取，随这次运行收掉
            task["status"] = "cancelled" if cancelled else ("failed" if error else "succeeded")
            task["filename"] = meta.get("filename")
            # 产物目录由节点写死（SEG_OUT_SUBDIR），快照带上它：取图与播放链接只按 filename + subfolder 拼
            task["subfolder"] = SEG_OUT_SUBDIR if task["filename"] else None
            task["film"] = meta.get("film")
            task["seed"] = meta.get("seed", task["seed"])
            task["warnings"] = list(meta.get("warnings") or [])
            task["error"] = error
            task["progress"] = None
            task["updated"] = time.time()
            _SEGMENT_WATCHERS.pop(task_id, None)
            if error and not cancelled:
                logger.warning(f"segment task {task_id} failed: {error}")
            return
        if state == "running":
            task["status"] = "running"
        progress = _progress_for(prompt_id)
        if progress is not None:
            task["progress"] = progress
        task["updated"] = time.time()


def _frame_count_error(actual: int, total: int, continuity: bool, context_frames: int, film: str = "") -> str:
    source = f"成片 {film} 的帧数" if film else "成片帧数"
    return (f"{source} {actual} 与按当前配方复算的 {total} 不一致：请确认成片是用同一份配方"
            f"（段时长/宽高/步数未改）、连续性={'开' if continuity else '关'}、"
            f"上下文窗口={context_frames} 生成的")


def _run_prompt(data: dict) -> dict:
    """校验请求并组装单节点 prompt（真正执行交给队列）。返回 {recipe, index, seed, graph}。"""
    recipe = str(data.get("recipe") or "").strip()
    if not recipe:
        raise ValueError("缺少配方名")
    if is_preset_recipe(recipe):
        raise ValueError("内置预设配方只读：请先「复制配方」再做单段生成")
    spec = load_director_spec(recipe)
    segments = spec.get("segments") or []
    index = int(data.get("segment", 0))
    if index < 0 or index >= len(segments):
        raise ValueError(f"段序号越界：第 {index + 1} 段（配方共 {len(segments)} 段）")
    anchors = str(data.get("anchors") or "both")
    if anchors not in ("both", "first", "none"):
        raise ValueError(f"未知锚点模式：{anchors}")
    continuity = bool(data.get("continuity", True))
    context_frames = int(data.get("context_frames", 22))
    film = str(data.get("film") or "").strip()
    # 有锚点时先定成片（指定的必须在配方结果里，空则最新），并校验它与复算/记录的段边界一致
    if anchors != "none":
        film_entry = _film_entry(recipe, film)
        if film_entry is not None:
            film_layout(film_entry, spec, continuity, context_frames)
    return {
        "recipe": recipe,
        "index": index,
        "seed": int(data.get("seed", -1)),
        "graph": {"1": {"class_type": "NeoH3SegmentRun", "inputs": {
            "recipe": recipe,
            "segment": index + 1,
            "anchors": next(label for label, key in _ANCHOR_KEYS.items() if key == anchors),
            "seed": int(data.get("seed", -1)),
            "record": True,                                    # 路由流一定落盘并记进配方结果
            "steps": int(data.get("steps", -1)),
            "preview": bool(data.get("preview", True)),
            "continuity": continuity,
            "context_frames": context_frames,
            "film": film,
        }}},
    }


@PromptServer.instance.routes.post("/neo_video_gen/run_segment")
async def run_segment_route(request):
    """把「配方某一段」提交到 ComfyUI 执行队列（显存/进度/取消都由执行器负责），返回任务快照。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是 JSON"}, status=400)
    task_id = str(uuid.uuid4())   # 先建：没有节点归属的路由任务按它寻址预览帧（右栏智能体出片没有节点面板）
    try:
        payload = _run_prompt(data)
        prompt_id = await submit_graph(payload["graph"])
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        logger.error(f"run_segment submit failed: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

    now = time.time()
    _RUNS[prompt_id] = {"preview_node_id": data.get("node_id") or task_id}
    _SEGMENT_TASKS[task_id] = {
        "task_id": task_id, "prompt_id": prompt_id, "status": "queued",
        "recipe": payload["recipe"], "segment": payload["index"], "seed": payload["seed"],
        "filename": None, "subfolder": SEG_OUT_SUBDIR, "film": None, "progress": None,
        "warnings": [], "error": "", "created": now, "updated": now,
    }
    _SEGMENT_WATCHERS[task_id] = asyncio.create_task(_watch(task_id))
    _prune_tasks()
    return web.json_response({"success": True, **_snapshot(_SEGMENT_TASKS[task_id])})


@PromptServer.instance.routes.get("/neo_video_gen/run_segment/{task_id}")
async def run_segment_status_route(request):
    """单段任务快照：status（queued/running/succeeded/failed/cancelled）+ progress + filename + error。"""
    task = _SEGMENT_TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    return web.json_response({"success": True, **_snapshot(task)})


@PromptServer.instance.routes.post("/neo_video_gen/run_segment/{task_id}/cancel")
async def run_segment_cancel_route(request):
    """取消单段任务：未执行则出队，执行中则中断（与生图任务同一套做法）。"""
    task = _SEGMENT_TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    queue = PromptServer.instance.prompt_queue
    dequeued = queue.delete_queue_item(lambda entry: entry[1] == task["prompt_id"])
    interrupted = queue.interrupt_if_running(task["prompt_id"])
    if not dequeued and not interrupted:
        return web.json_response({"success": False, "error": "任务已结束，无法取消"}, status=409)
    return web.json_response({"success": True, "dequeued": dequeued, "interrupted": interrupted})


NODE_CLASS_MAPPINGS = {"NeoH3SegmentRun": NeoH3SegmentRun}
NODE_DISPLAY_NAME_MAPPINGS = {"NeoH3SegmentRun": "Neo H3 Segment Run (单段生成/重生成)"}




