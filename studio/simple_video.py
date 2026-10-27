"""Neo Studio 简单版视频生成：一句话 + 首帧（可选尾帧/参考）直接出一段视频。

与导演整片生成（studio.py）同走执行队列，区别是这条不建配方、不读配方：请求自带的
提示词 / 首帧 / 尾帧 / 参考 / 尺寸 / 时长直接解析成技能模板参数（resolve_video_params +
render_template，与导演逐段同一条链），渲染出的图接一个 SaveVideo 落进输出目录
output/NeoSimple/，产物只播放，不进任何配方「结果」区。任务表与取消沿用同一套做法。

为什么走队列：显存装载/卸载、采样步数进度、取消（interrupt）都交给 ComfyUI 执行器，
导演/单段/生图都是这条路；这里没有画布，把「技能模板 + SaveVideo」整图提交进队列。
"""

import asyncio
import logging
import re
import time
import uuid

from aiohttp import web
import nodes as comfy_nodes
from server import PromptServer

from .h3_video_gen import _resolve_skill_id, _seconds_to_frames, resolve_video_params
from .image_gen import _error_from_history, _lookup, _progress_for, render_template, submit_graph
from .skill import get_skill_gen_config, load_skill_workflow
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

TASK_TTL = 3600.0     # 任务记录保留时长（秒）
POLL_INTERVAL = 1.0   # 轮询队列状态的间隔（秒）
OUT_SUBDIR = "NeoSimple"   # 简单视频落盘子目录（SaveVideo 的 filename_prefix 前缀）
_VIDEO_EXT = (".mp4", ".webm", ".mov", ".mkv", ".gif")
# 找末端 VIDEO 输出时跳过的落盘节点：它们对 VIDEO 的引用不算「消费」，且自身不作为产物端点
_SKIP_OUTPUT_NODES = {"SaveImage", "PreviewImage", "SaveVideo"}

_TASKS: dict = {}
_WATCHERS: dict = {}


def _safe_name(text) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(text).strip()).strip("_") or "video"


def _video_terminal(graph: dict) -> tuple:
    """技能模板渲染出的图里产出 VIDEO、且未被其它执行节点引用的末端 (node_id, 槽号)。

    与 image_gen_edit._terminal_output 同一判据，去掉对逐节点结果的依赖（队列模式没有 results）。
    模板末端没有 VIDEO 时抛 ValueError（消息直接回前端）。"""
    produced = []
    for nid, node in graph.items():
        ct = node.get("class_type")
        if ct in _SKIP_OUTPUT_NODES:
            continue
        class_def = comfy_nodes.NODE_CLASS_MAPPINGS.get(ct)
        if class_def is None:
            continue
        for idx, out_type in enumerate(getattr(class_def, "RETURN_TYPES", ())):
            if out_type == "VIDEO":
                produced.append((nid, idx))
    consumed = set()
    for node in graph.values():
        if node.get("class_type") in _SKIP_OUTPUT_NODES:
            continue
        for value in (node.get("inputs") or {}).values():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str):
                consumed.add((value[0], value[1]))
    terminal = [p for p in produced if p not in consumed]
    if not terminal:
        raise ValueError("该技能模板没有 VIDEO 输出，无法作为整段视频保存")
    return terminal[-1]


def _video_from_history(item: dict) -> tuple:
    """从 history 的 outputs 里找 SaveVideo 落盘的视频条目，返回 (filename, subfolder)。"""
    for outs in (item.get("outputs") or {}).values():
        if not isinstance(outs, dict):
            continue
        for entries in outs.values():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if isinstance(entry, dict) and str(entry.get("filename", "")).lower().endswith(_VIDEO_EXT):
                    return entry["filename"], str(entry.get("subfolder") or "")
    return None, ""


def _snapshot(task: dict) -> dict:
    return {key: task[key] for key in (
        "task_id", "prompt_id", "status", "seed", "skill_id", "prompt",
        "width", "height", "length", "filename", "subfolder", "progress",
        "error", "created", "updated")}


def _prune_tasks() -> None:
    """清掉过期或超额的历史任务记录（运行中的不动）。"""
    now = time.time()
    for task in [t for t in _TASKS.values() if t["status"] not in ("queued", "running")]:
        if now - task["updated"] > TASK_TTL:
            _TASKS.pop(task["task_id"], None)
    while len(_TASKS) > 32:
        oldest = min((t for t in _TASKS.values() if t["status"] not in ("queued", "running")),
                     key=lambda t: t["updated"], default=None)
        if oldest is None:
            return
        _TASKS.pop(oldest["task_id"], None)


async def _watch(task_id: str) -> None:
    """轮询队列状态直到结束：更新进度，收产物名与错误。"""
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        task = _TASKS.get(task_id)
        if task is None or task["status"] not in ("queued", "running"):
            return
        state, item = _lookup(task["prompt_id"])
        if state == "done":
            error, cancelled = _error_from_history(item)
            filename, subfolder = (None, "")
            if not error and not cancelled:
                filename, subfolder = _video_from_history(item)
            task["status"] = "cancelled" if cancelled else ("failed" if error else "succeeded")
            task["filename"] = filename
            task["subfolder"] = subfolder
            task["error"] = error
            task["progress"] = None
            task["updated"] = time.time()
            _WATCHERS.pop(task_id, None)
            if error and not cancelled:
                logger.warning(f"simple video task {task_id} failed: {error}")
            return
        if state == "running":
            task["status"] = "running"
            progress = _progress_for(task["prompt_id"])
            if progress is not None:
                task["progress"] = progress
            task["updated"] = time.time()


def _run_prompt(data: dict) -> dict:
    """校验请求 → 解析技能模板参数 → 渲染图 → 接 SaveVideo → 返回 {graph, seed, ...}。"""
    body = dict(data or {})
    skill_id = _resolve_skill_id(str(body.get("skill_id") or ""))
    if not skill_id:
        raise ValueError("请先选择一个视频技能（带工作流模板）")
    template = load_skill_workflow(skill_id)
    if template is None:
        raise ValueError(f"技能 {skill_id} 没有工作流模板（workflow.json），无法生成视频")
    cfg = get_skill_gen_config(skill_id)

    # 时长以秒进来（composer 的时长滑杆），按 H3 帧网格换算成模板的 length 帧
    duration_sec = body.get("duration_sec")
    if duration_sec is not None and float(duration_sec) > 0:
        body["length"] = _seconds_to_frames(float(duration_sec))

    seed_in = body.get("seed")
    params = resolve_video_params(body, cfg)   # seed 缺省时内部已随机
    graph, _warns = render_template(template, params)

    nid, idx = _video_terminal(graph)
    graph["9000"] = {"class_type": "SaveVideo", "inputs": {
        "video": [nid, idx],
        "filename_prefix": f"{OUT_SUBDIR}/{_safe_name(params['prompt'][:24])}",
        "format": "auto",   # 新版核心 SaveVideo 必填（无默认值）
    }}
    explicit_seed = seed_in is not None and int(seed_in) >= 0
    return {
        "graph": graph,
        "seed": int(seed_in) if explicit_seed else int(params["seed"]),
        "skill_id": skill_id,
        "prompt": params["prompt"],
        "width": int(params["width"]), "height": int(params["height"]), "length": int(params["length"]),
    }


@PromptServer.instance.routes.post("/neo_video_gen/simple")
async def simple_generate_route(request):
    """把一段简单视频（技能模板 + SaveVideo）提交到执行队列，返回任务快照。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是 JSON"}, status=400)
    task_id = str(uuid.uuid4())
    try:
        payload = _run_prompt(data)
        prompt_id = await submit_graph(payload["graph"])
    except (ValueError, RuntimeError) as e:
        return web.json_response({"success": False, "error": str(e)}, status=400)
    except Exception as e:
        logger.error(f"simple video submit failed: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

    now = time.time()
    _TASKS[task_id] = {
        "task_id": task_id, "prompt_id": prompt_id, "status": "queued",
        "seed": payload["seed"], "skill_id": payload["skill_id"], "prompt": payload["prompt"],
        "width": payload["width"], "height": payload["height"], "length": payload["length"],
        "filename": None, "subfolder": OUT_SUBDIR, "progress": None, "error": "",
        "created": now, "updated": now,
    }
    _WATCHERS[task_id] = asyncio.create_task(_watch(task_id))
    _prune_tasks()
    return web.json_response({"success": True, **_snapshot(_TASKS[task_id])})


@PromptServer.instance.routes.get("/neo_video_gen/simple/{task_id}")
async def simple_status_route(request):
    """简单视频任务快照：status（queued/running/succeeded/failed/cancelled）+ progress + filename + error。"""
    task = _TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    return web.json_response({"success": True, **_snapshot(task)})


@PromptServer.instance.routes.post("/neo_video_gen/simple/{task_id}/cancel")
async def simple_cancel_route(request):
    """取消简单视频任务：未执行则出队，执行中则中断（与整片/单段/生图任务同一套做法）。"""
    task = _TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"success": False, "error": "任务不存在"}, status=404)
    queue = PromptServer.instance.prompt_queue
    dequeued = queue.delete_queue_item(lambda entry: entry[1] == task["prompt_id"])
    interrupted = queue.interrupt_if_running(task["prompt_id"])
    if not dequeued and not interrupted:
        return web.json_response({"success": False, "error": "任务已结束，无法取消"}, status=409)
    task["status"] = "cancelled"
    task["updated"] = time.time()
    watcher = _WATCHERS.pop(task["task_id"], None)
    if watcher is not None:
        watcher.cancel()
    return web.json_response({"success": True, "dequeued": dequeued, "interrupted": interrupted})