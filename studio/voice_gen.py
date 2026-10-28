# SPDX-License-Identifier: Apache-2.0
# Neo Studio — 语音生成（CosyVoice 零样本克隆）
# 独立于生图管线：自己的任务表与 rs.voice_gen.status 事件，复用 ComfyUI 队列提交与
# workflow.json 模板渲染（render_template / submit_graph）。参考音频来自画廊音频卡片，
# 经 copy_to_input 落到 input/ 后作为 {{REF_AUDIO_1}} 槽位；目标文本走 {{PROMPT}}。
# 输出由 SaveAudio 落盘，_collect_audio 收集，前端在弹窗内显示波形并播放。

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
import uuid
from urllib.parse import quote

from aiohttp import web
import folder_paths
from server import PromptServer

from . import image_gen as _ig
from . import skill as _skill
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

# 独立 client_id + 事件名：语音任务快照不混进生图的前端节点高亮
VOICE_CLIENT_ID = str(uuid.uuid4())
STATUS_EVENT = "rs.voice_gen.status"

MAX_TASKS = 32
TASK_TTL = 3600
POLL_INTERVAL = 0.5
TASK_TIMEOUT = 3600.0

DEFAULT_VOICE_PREFIX = "Voice"
VOICE_SKILL_ID = "cosyvoice_voice"

TASKS: dict = {}
WATCHERS: dict = {}


def _collect_audio(item: dict) -> list:
    """取 history 里 SaveAudio 落盘的音频，附带 /view 访问地址。"""
    output_root = os.path.realpath(folder_paths.get_output_directory())
    results = []
    for outputs in (item.get("outputs") or {}).values():
        for entry in (outputs or {}).get("audio", []):
            subfolder = str(entry.get("subfolder") or "")
            filename = str(entry.get("filename") or "")
            if not filename:
                continue
            real = os.path.realpath(os.path.join(output_root, *subfolder.split("/"), filename))
            if not _ig._within(real, output_root) or not os.path.isfile(real):
                continue
            results.append({"path": real, "subfolder": subfolder, "filename": filename,
                            "url": (f"/view?filename={quote(filename)}"
                                    f"&subfolder={quote(subfolder)}&type=output")})
    return results


def _snapshot(task: dict) -> dict:
    return {
        "task_id": task["task_id"],
        "prompt_id": task["prompt_id"],
        "status": task["status"],
        "created": task["created"],
        "updated": task["updated"],
        "prompt": task["params"]["prompt"],
        "seed": task["params"]["seed"],
        "audios": [{"filename": e["filename"], "subfolder": e["subfolder"], "url": e["url"]}
                   for e in task["audios"]],
        "progress": task.get("progress"),
        "error": task["error"],
        "warnings": task.get("warnings") or [],
    }


def _notify(task: dict) -> None:
    PromptServer.instance.send_sync(STATUS_EVENT, _snapshot(task))


def _finish(task: dict, status: str, audios: list, error: str) -> None:
    task["status"] = status
    task["audios"] = audios
    task["error"] = error
    task["progress"] = None
    task["updated"] = time.time()
    WATCHERS.pop(task["task_id"], None)
    if error:
        logger.warning(f"voice_gen task {task['task_id']} failed: {error}")
    _notify(task)


async def _watch(task_id: str) -> None:
    prompt_id = TASKS[task_id]["prompt_id"]
    deadline = time.monotonic() + TASK_TIMEOUT
    while True:
        await asyncio.sleep(POLL_INTERVAL)
        task = TASKS.get(task_id)
        if task is None or task["status"] not in ("queued", "running"):
            return
        state, item = _ig._lookup(prompt_id)
        if state == "done":
            error, cancelled = _ig._error_from_history(item)
            audios = _collect_audio(item)
            status = "cancelled" if cancelled else ("failed" if error else "succeeded")
            _finish(task, status, audios, error)
            return
        if state == "running":
            changed = task["status"] != "running"
            task["status"] = "running"
            prog = _ig._progress_for(prompt_id)
            if prog is not None and task.get("progress") != prog:
                task["progress"] = prog
                changed = True
            task["updated"] = time.time()
            if changed:
                _notify(task)
        elif time.monotonic() > deadline:
            _finish(task, "failed", [], "等待语音生成超时，任务已不在队列中")
            return


async def start_voice_generation(body: dict) -> dict:
    """按语音技能的 workflow.json 渲染并提交语音生成任务。"""
    body = dict(body or {})
    skill_id = str(body.get("skill_id") or VOICE_SKILL_ID).strip()
    template = _skill.load_skill_workflow(skill_id)
    if template is None:
        raise ValueError(f"技能 {skill_id} 没有工作流模板（workflow.json）")

    prompt_text = str(body.get("prompt") or "").strip()
    if not prompt_text:
        raise ValueError("要说的文字为空")

    refs = body.get("references")
    refs = refs if isinstance(refs, list) else ([refs] if refs else [])
    ref_name = _ig._reference_name(refs[0], "audio") if refs else None
    if not ref_name:
        raise ValueError("需要参考音频（请先在音频卡片上选择参考音源）")

    seed = body.get("seed")
    seed = random.randint(0, 2**63 - 1) if seed is None else max(0, int(seed))

    prefix = _ig.safe_prefix(str(body.get("output_prefix") or DEFAULT_VOICE_PREFIX))
    prefix = f"{prefix}/{time.strftime('%Y-%m-%d')}"
    slug = _ig.slug_from_text(prompt_text)
    if slug:
        prefix = f"{prefix}/{slug}"

    params = {
        "prompt": prompt_text,
        "seed": seed,
        "prefix": prefix,
        "ref_audios": [ref_name],
        "ref_images": [],
        "ref_videos": [],
        "loras": [],
    }

    graph, warns = _ig.render_template(template, params)
    prompt_id = await _ig.submit_graph(graph)
    _prune_tasks()
    now = time.time()
    task = {
        "task_id": str(uuid.uuid4()),
        "prompt_id": prompt_id,
        "status": "queued",
        "created": now,
        "updated": now,
        "params": params,
        "audios": [],
        "progress": None,
        "error": "",
        "warnings": list(warns),
    }
    TASKS[task["task_id"]] = task
    WATCHERS[task["task_id"]] = asyncio.create_task(_watch(task["task_id"]))
    return _snapshot(task)


def _prune_tasks() -> None:
    now = time.time()
    for task_id, task in list(TASKS.items()):
        if task["status"] in ("queued", "running"):
            continue
        if now - task["updated"] > TASK_TTL:
            TASKS.pop(task_id, None)
    while len(TASKS) > MAX_TASKS:
        oldest = min((t for t in TASKS.values() if t["status"] not in ("queued", "running")),
                     key=lambda t: t["updated"], default=None)
        if oldest is None:
            break
        TASKS.pop(oldest["task_id"], None)


def queue_rows() -> list:
    """顶栏队列面板的行：音频列表不进列表，只留目标文字与首个产物名。"""
    rows = []
    for task in list(TASKS.values()):
        first = task["audios"][0] if task["audios"] else None
        rows.append({
            "kind": "voice", "task_id": task["task_id"], "status": task["status"],
            "label": str(task["params"]["prompt"])[:40],
            "progress": task.get("progress"),
            "created": task["created"], "updated": task["updated"],
            "result": {"filename": first["filename"], "subfolder": first["subfolder"]} if first else None,
            "count": len(task["audios"]),
        })
    return rows


routes = PromptServer.instance.routes


@routes.post("/neo_voice/generate")
async def generate_route(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "请求体不是 JSON"}, status=400)
    try:
        return web.json_response(await start_voice_generation(body))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        logger.error(f"voice_gen generate failed: {e}")
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/neo_voice/status/{task_id}")
async def status_route(request):
    task = TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"error": "任务不存在"}, status=404)
    return web.json_response(_snapshot(task))


@routes.post("/neo_voice/cancel/{task_id}")
async def cancel_route(request):
    task = TASKS.get(request.match_info["task_id"])
    if task is None:
        return web.json_response({"error": "任务不存在"}, status=404)
    prompt_id = task["prompt_id"]
    queue = _ig._prompt_queue()
    queue.delete_queue_item(lambda entry: entry[1] == prompt_id)
    queue.interrupt_if_running(prompt_id)
    task["status"] = "cancelled"
    task["updated"] = time.time()
    watcher = WATCHERS.pop(task["task_id"], None)
    if watcher is not None:
        watcher.cancel()
    return web.json_response(_snapshot(task))
