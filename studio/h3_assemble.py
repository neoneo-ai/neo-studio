"""Neo H3 把重生成的段拼回成片：单段生成（h3_segment）的后续步骤，不是独立的入口。

流程：**先单段出**（h3_segment 的单段流程，片段记进配方 results 且带 `segment`），确认满意后
**只把这一（几）段换回成片**——没换的段直接沿用原成片对应帧与音频（解码 → 拼接 → 再编码，内容不变）：
- 每个接缝用 `h3_video_director._blend_seam` 把「前段尾帧 × 本段头帧」按 0→1 交叉淡化（默认 6 帧）；
- 音频按各段帧数裁齐后 `_concat_segment_audio` 拼接，A/V 对齐；
- 新成片写 `output/neo_director_merge/`，记进配方 results 并带 `layout`（逐段真实帧数），
  所以它能被继续重做（后续单段重生成按这个成片的真实段边界取锚点帧）。

拼接不用模型（纯解码/编码），所以不走执行队列也不需要显存管理：路由 + 后台线程 + 任务快照（进度/取消）。
"""

import datetime
import logging
import pathlib
import threading
import time
import uuid
from fractions import Fraction

import folder_paths
import torch
from aiohttp import web
from comfy_api.latest import InputImpl, Types
from server import PromptServer

from .h3_segment import _film_entry, _safe_name, _video_frame_count, film_layout
from .h3_video_director import SEAM_BLEND_FRAMES, _blend_seam, _concat_segment_audio, _resize_frames
from .h3_video_gen import H3_FPS
from .recipes import add_recipe_results, is_preset_recipe, list_recipe_results, load_director_spec
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

MERGE_DIR = "neo_director_merge"     # 拼接成片的输出目录（片段在 neo_director_regen）
MERGE_CRF = 16                       # 拼接要重编码沿用段：用高码率压低代际损失（默认码率连续拼接会越拼越糊）
MAX_TASKS = 16
TASK_TTL = 3600.0


class _Cancelled(Exception):
    """用户取消了拼接（协作式：在片段/阶段边界生效）。"""


def _clip_entries(recipe: str) -> dict:
    """每段最新的单段产物：{segment_index: entry}（list_recipe_results 新 → 旧，首次命中即最新）。"""
    clips = {}
    for entry in list_recipe_results(recipe):
        index = entry.get("segment")
        if entry.get("kind") == "video" and index is not None and int(index) not in clips:
            clips[int(index)] = entry
    return clips


def _validate(recipe: str, use) -> tuple:
    """校验配方、要替换的段与片段齐备，返回 (spec, clips)。不满足抛 ValueError（HTTP 语义由调用方决定）。"""
    if is_preset_recipe(recipe):
        raise ValueError("内置预设配方只读：请先「复制配方」再拼接")
    spec = load_director_spec(recipe)
    segments = spec.get("segments") or []
    if not segments:
        raise ValueError(f"配方没有分段：{recipe}")
    indices = sorted({int(i) for i in (use or [])})
    if not indices:
        raise ValueError("还没有选择要替换的段：请先在左边把要重做的段生成出来")
    for i in indices:
        if not 0 <= i < len(segments):
            raise ValueError(f"段序号越界：第 {i + 1} 段（配方共 {len(segments)} 段）")
    clips = _clip_entries(recipe)
    missing = [i + 1 for i in indices if i not in clips]
    if missing:
        raise ValueError("这些段还没有单段产物，请先在左边生成：" + "、".join(f"第 {i} 段" for i in missing))
    return spec, clips


def _sources(spec: dict, clips: dict, use: set, layout: list) -> list:
    """逐段定来源：勾选的段用新片段，其余（连续的）合并成一次「沿用原成片」读取。"""
    segments = spec.get("segments") or []
    parts = []
    i = 0
    while i < len(segments):
        if i in use:
            parts.append({"kind": "clip", "index": i, "clip": clips[i]})
            i += 1
            continue
        start, last = layout[i][0], i
        count = layout[i][1]
        while last + 1 < len(segments) and (last + 1) not in use:
            last += 1
            count += layout[last][1]
        parts.append({"kind": "film", "from": i, "to": last, "start": start, "frames": count})
        i = last + 1
    return parts


def assemble_film(recipe: str, use, film: str = "", blend: int = SEAM_BLEND_FRAMES,
                  continuity: bool = True, context_frames: int = 22, progress=None, should_cancel=None) -> dict:
    """把「勾选的段」换成对应的单段产物、其余段沿用原成片，产出新的完整成片。

    use：要替换的段序号（0 基，非空）；没勾的段必须有可用成片（全是新片段时不需要成片）。
    progress(stage, value, total)：stage 为中文阶段描述，value/total 为已拼/总帧数；should_cancel() 返回真则中止。
    """
    notify = progress or (lambda stage, value, total: None)
    blend = max(0, int(blend or 0))
    spec, clips = _validate(recipe, use)
    segments = spec.get("segments") or []
    use = {int(i) for i in use}

    film_entry = None
    layout = []
    if len(use) < len(segments):     # 还有段要沿用原成片
        film_entry = _film_entry(recipe, film)
        if film_entry is None:
            raise ValueError("还有段要沿用原成片，但该配方还没有可用的成片："
                             "请把这些段也用新片段，或先跑一次整条配方生成成片")
        layout = film_layout(film_entry, spec, continuity, context_frames)

    parts = _sources(spec, clips, use, layout)
    for part in parts:
        part["expected"] = (_video_frame_count(part["clip"]["path"]) if part["kind"] == "clip"
                            else part["frames"])
    total = sum(part["expected"] for part in parts)

    images = None
    audios = []
    merged_layout = []
    warnings = []
    offset = 0
    for part in parts:
        if should_cancel and should_cancel():
            raise _Cancelled()
        if part["kind"] == "clip":
            entry = part["clip"]
            notify(f"读取第 {part['index'] + 1} 段新片段（{part['expected']} 帧）", offset, total)
            comp = InputImpl.VideoFromFile(entry["path"]).get_components()
            label = f"第 {part['index'] + 1} 段片段 {entry['filename']}"
            merged_layout.append(part["expected"])
        else:
            notify(f"沿用原成片第 {part['from'] + 1}..{part['to'] + 1} 段（{part['frames']} 帧）", offset, total)
            comp = InputImpl.VideoFromFile(film_entry["path"], start_time=part["start"] / H3_FPS,
                                           duration=part["frames"] / H3_FPS).get_components()
            label = f"原成片 {film_entry['filename']} 第 {part['from'] + 1}..{part['to'] + 1} 段"
            merged_layout += [layout[i][1] for i in range(part["from"], part["to"] + 1)]
        frames = comp.images
        if int(frames.shape[0]) != part["expected"]:
            raise ValueError(f"{label} 取到 {int(frames.shape[0])} 帧，与段边界 {part['expected']} 帧不一致："
                             f"请重新生成该段，或换一个成片")
        if images is None:
            images = torch.empty((total, *frames.shape[1:]), dtype=frames.dtype)
        elif tuple(frames.shape[1:]) != tuple(images.shape[1:]):
            # 尺寸不同（配方尺寸改过 / 旧成片）：按成片尺寸拉抻，保证能拼起来；结果里明确提示
            height, width = int(images.shape[1]), int(images.shape[2])
            frames = _resize_frames(frames, width, height).to(images.dtype)
            warnings.append(f"{label} 尺寸 {int(comp.images.shape[2])}×{int(comp.images.shape[1])} 与成片 "
                            f"{width}×{height} 不同：已缩放到成片尺寸")
        n = part["expected"]
        if blend > 0 and offset > 0:
            keep = min(blend, offset, n)
            images[offset - keep:offset] = _blend_seam(images[offset - keep:offset], frames, keep, keep)
        images[offset:offset + n] = frames
        audios.append(comp.audio)
        offset += n
        del comp, frames

    if images is None:
        raise ValueError("没有可拼接的内容：请先生成要替换的段")
    if should_cancel and should_cancel():
        raise _Cancelled()

    audio = _concat_segment_audio(audios, H3_FPS, [0] * len(audios))
    if any(a is None for a in audios):
        warnings.append("有片段没有音频轨：已输出无声成片")
        audio = None

    notify("编码成片", total, total)
    out_dir = pathlib.Path(folder_paths.get_output_directory()) / MERGE_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{_safe_name(recipe)}_merged_{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.mp4"
    video = InputImpl.VideoFromComponents(Types.VideoComponents(
        images=images, audio=audio, frame_rate=Fraction(H3_FPS)))
    video.save_to(str(out_dir / filename), format=Types.VideoContainer.MP4,
                  codec=Types.VideoCodec.H264, crf=MERGE_CRF)

    add_recipe_results(recipe, [{
        "filename": filename, "subfolder": MERGE_DIR, "type": "output", "kind": "video",
        "layout": merged_layout,
    }])
    replaced = []
    for part in parts:
        if part["kind"] == "clip":
            replaced.append({"segment": part["index"], "filename": part["clip"]["filename"],
                             "frames": part["expected"]})
    return {"filename": filename, "subfolder": MERGE_DIR, "frames": int(images.shape[0]),
            "layout": merged_layout, "film": film_entry["filename"] if film_entry is not None else None,
            "replaced": sorted(use), "warnings": warnings, "clips": replaced}


# ===========================================================================
# 拼接任务：后台线程 + 快照（进度 / 阶段 / 取消）
# ===========================================================================

_TASKS: dict = {}


def _snapshot(task: dict) -> dict:
    return {key: task[key] for key in (
        "task_id", "status", "recipe", "use", "film", "blend", "filename", "subfolder", "frames",
        "progress", "stage", "clips", "warnings", "error", "created", "updated")}


def _prune_tasks() -> None:
    now = time.time()
    for task in [t for t in _TASKS.values() if t["status"] not in ("queued", "running")]:
        if now - task["updated"] > TASK_TTL:
            _TASKS.pop(task["task_id"], None)
    while len(_TASKS) > MAX_TASKS:
        oldest = min((t for t in _TASKS.values() if t["status"] not in ("queued", "running")),
                     key=lambda t: t["updated"], default=None)
        if oldest is None:
            return
        _TASKS.pop(oldest["task_id"], None)


def _run_task(task_id: str) -> None:
    """后台线程：跑拼接并持续写任务快照；取消是协作式的（在片段/阶段边界生效）。"""
    task = _TASKS.get(task_id)
    if task is None:
        return
    task["status"] = "running"
    task["updated"] = time.time()

    def on_progress(stage, value, total):
        task["stage"] = stage
        if total:
            task["progress"] = {"value": int(value), "max": int(total)}
        task["updated"] = time.time()

    try:
        result = assemble_film(task["recipe"], task["use"], film=task["film"], blend=task["blend"],
                               continuity=task["continuity"], context_frames=task["context_frames"],
                               progress=on_progress, should_cancel=lambda: bool(task.get("cancel")))
        task.update({"status": "succeeded", "filename": result["filename"], "subfolder": result["subfolder"],
                     "frames": result["frames"],
                     "clips": result["clips"], "warnings": result["warnings"],
                     "film": result["film"] or "", "progress": None, "stage": ""})
    except _Cancelled:
        task.update({"status": "cancelled", "error": "已取消", "progress": None, "stage": ""})
    except ValueError as e:
        task.update({"status": "failed", "error": str(e), "progress": None, "stage": ""})
    except Exception as e:
        logger.error(f"assemble task {task_id} failed: {e}")
        task.update({"status": "failed", "error": str(e), "progress": None, "stage": ""})
    task["updated"] = time.time()


@PromptServer.instance.routes.post("/neo_video_gen/assemble_segments")
async def assemble_segments_route(request):
    """拼回成片（`{recipe, use:[段序号], film?, blend?, continuity?, context_frames?}`）：起后台线程拼新成片。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是 JSON"}, status=400)
    recipe = str(data.get("recipe") or "").strip()
    if not recipe:
        return web.json_response({"success": False, "error": "缺少配方名"}, status=400)
    use = [int(i) for i in (data.get("use") or [])]
    try:
        _validate(recipe, use)
    except ValueError as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)

    task_id = str(uuid.uuid4())
    now = time.time()
    _TASKS[task_id] = {
        "task_id": task_id, "status": "queued", "recipe": recipe, "use": sorted(set(use)),
        "film": str(data.get("film") or "").strip(), "blend": int(data.get("blend", SEAM_BLEND_FRAMES)),
        "continuity": bool(data.get("continuity", True)), "context_frames": int(data.get("context_frames", 22)),
        "filename": None, "subfolder": None, "frames": 0, "progress": None, "stage": "", "clips": [],
        "warnings": [], "error": "", "cancel": False, "created": now, "updated": now,
    }
    threading.Thread(target=_run_task, args=(task_id,), name=f"neo-assemble-{task_id[:8]}", daemon=True).start()
    _prune_tasks()
    return web.json_response({"success": True, **_snapshot(_TASKS[task_id])})


@PromptServer.instance.routes.get("/neo_video_gen/assemble_segments/{task_id}")
async def assemble_status_route(request):
    """拼接任务快照：status（queued/running/succeeded/failed/cancelled）+ progress + stage + filename。"""
    task = _TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    return web.json_response({"success": True, **_snapshot(task)})


@PromptServer.instance.routes.post("/neo_video_gen/assemble_segments/{task_id}/cancel")
async def assemble_cancel_route(request):
    """取消拼接（协作式：当前片段处理完后生效）。"""
    task = _TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    if task["status"] not in ("queued", "running"):
        return web.json_response({"success": False, "error": "任务已结束，无法取消"}, status=409)
    task["cancel"] = True
    return web.json_response({"success": True})


