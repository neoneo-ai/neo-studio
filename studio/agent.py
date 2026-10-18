# SPDX-License-Identifier: Apache-2.0
"""右栏 Neo Agent 的后端代理循环（SSE）。

前端一次 POST /neo_agent/run 之后只收 {kind,text} 帧的时间线：plan / tool_call /
tool_result / status / content。显式选了生图技能就按技能直出图，不叫 LLM；没选技能才让
LLM 规划并调工具。

两条路径的工具调用一律经进程内 MCP 客户端逐行走 mcp_server.serve 的 JSON-RPC，与外部
智能体连 MCP 是同一套口径：右栏看到的工具表就是 MCP 的全集，出片链路（director_run /
segment_run / assemble_run）也开给这个面板，能不能调由协议自己判，这里不再砍第二层。
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import uuid
from urllib.parse import quote

from aiohttp import web

from . import mcp_server as mcp
from .plugin_paths import PLUGIN_DIR
from .util import _json_safe

logger = logging.getLogger("NeoStudio")

routes = web.RouteTableDef()

# 入队即返回 task_id 的异步工具：循环里要轮询到终态，不能把一次 tools/call 当同步结果用
TASK_TOOLS = ("generate_image", "director_run", "segment_run", "assemble_run")

MAX_TURNS = 12
MAX_TOKENS = 900
TASK_POLL_SEC = 2.0
TASK_WAIT_SEC = 600.0
FILM_WAIT_SEC = 2400.0      # 整片是多段 × 每段数分钟，按单图的 600 秒必超时
COMFY_TIMEOUT = 30
ARGS_CLIP = 300
RESULT_CLIP = 1500
TASK_FINAL = ("succeeded", "failed", "cancelled")
# cancel 的 task_id 从请求体来，会被拼进 /view 与 cancel 路由的路径段，只收 UUID 形态
TASK_ID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")
# 停整条循环的 run_id 是后端发的 uuid4().hex，从请求体回来只认这个形态
RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
# 出片三类的产物是 mp4，快照只给 filename：单段与拼接的产物子目录写死在生成模块里，取图要自己补
FILM_DIR = {"director": "", "segment": "neo_director_regen", "assemble": "neo_director_merge"}
CANCELLED_TEXT = "已取消：智能体循环与在跑的任务已停止"
SYSTEM_PROMPT_FILE = PLUGIN_DIR / "prompts" / "agent" / "system_prompt.md"



# ---------------------------------------------------------------------------
# 进程内 MCP 客户端
# ---------------------------------------------------------------------------

class McpClient:
    """把请求逐行喂给 mcp_server.serve，读它的 JSON-RPC 应答。
    工具表就是 mcp.TOOLS 本身，右栏与外部 MCP 客户端拿到同一张表与同一套报错文案。"""

    def __init__(self, base: str, timeout: int = COMFY_TIMEOUT):
        self.ctx = mcp.Ctx(mcp.Comfy(base, timeout))
        self.tools = list(mcp.TOOLS)
        self._id = 0

    def _rpc(self, method, params=None) -> dict:
        self._id += 1
        msg = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            msg["params"] = params
        out = io.StringIO()
        mcp.serve(self.ctx, self.tools, io.StringIO(json.dumps(msg, ensure_ascii=False) + "\n"), out)
        lines = [x for x in out.getvalue().splitlines() if x.strip()]
        reply = json.loads(lines[-1]) if lines else {}
        if reply.get("error"):
            raise mcp.ToolError(str(reply["error"].get("message") or "MCP 调用失败"))
        return reply.get("result") or {}

    def tool_list(self) -> list:
        return list(self._rpc("tools/list").get("tools") or [])

    def call(self, name: str, args: dict) -> str:
        """tools/call 的文本载荷；isError 时抛 ToolError，让循环把错误原文回填给 LLM。"""
        res = self._rpc("tools/call", {"name": name, "arguments": args})
        text = "\n".join(str(b.get("text") or "") for b in (res.get("content") or [])
                         if b.get("type") == "text")
        if res.get("isError"):
            raise mcp.ToolError(text or f"工具执行失败：{name}")
        return text


def comfy_base(request) -> str:
    """工具回指的 ComfyUI 就是本次请求自己的来源：地址不从请求体取，不给任意目标留口子。"""
    host = str(request.url.host or "127.0.0.1")
    port = request.url.port or (443 if request.url.scheme == "https" else 8188)
    return f"{request.url.scheme}://{host}:{port}"


# ---------------------------------------------------------------------------
# 运行取消面
# ---------------------------------------------------------------------------

_RUNS: dict[str, "_Run"] = {}


class _Run:
    """一次 /neo_agent/run 的取消面。

    停止要从另一个 HTTP 请求打进来，运行中的循环就得按 run_id 挂住；条目只在整条 SSE
    活着期间存在，_events 收尾时摘掉，不跨请求留状态。task_id 记在运行对象上是因为 LLM
    正卡在一次请求里时，取消端点要能立刻掐掉在跑的 ComfyUI 任务，不能等循环回到轮询边界。"""

    def __init__(self, client):
        self.client = client
        self.run_id = uuid.uuid4().hex
        self.stop = asyncio.Event()
        self.task_id = ""

    async def cancel_comfy_task(self):
        """掐掉在跑的 ComfyUI 任务。没有任务、任务已终态、取消失败都不影响循环收场。"""
        if not self.task_id:
            return
        try:
            await asyncio.to_thread(self.client.call, "cancel_task", {"task_id": self.task_id})
        except (mcp.ToolError, OSError, ValueError) as e:
            logger.info(f"[Neo Studio] agent cancel task {self.task_id} failed: {e}")


# ---------------------------------------------------------------------------
# 载荷解析与 LLM 接缝
# ---------------------------------------------------------------------------

def _clip(text, limit: int) -> str:
    text = str(text)
    return text if len(text) <= limit else text[:limit] + "…"


def _json_of(text: str) -> dict:
    """工具载荷是 mcp_server.dump 出来的 JSON 文本；解不开就当空，交给上层按无产物处理。"""
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _media_of(text: str) -> list:
    """工具载荷里的产物媒体：生图的 images 逐条成项，出片三类的成片按 filename 补成 /view 地址。
    右栏的缩略图与产物链接只认这一份列表——最终回答里的 URL 会被 Markdown 画成 <a>，
    点一下整扇窗口翻到图片页，回来时启动状态与整条时间线一起没了。"""
    data = _json_of(text)
    items = [{"kind": "image", "url": str(im["url"]), "title": str(im.get("filename") or "")}
             for im in (data.get("images") or [])
             if isinstance(im, dict) and im.get("url")]
    if items:
        return items
    if str(data.get("status")) != "succeeded":
        return []
    film = str(data.get("filename") or "")
    kind = str(data.get("kind") or "")
    if not film or kind not in FILM_DIR:
        return []
    # 整片快照带 subfolder，单段与拼接只给文件名：产物子目录写死在生成模块里，取图得自己补
    subfolder = str(data.get("subfolder") or FILM_DIR[kind])
    return [{"kind": "video", "title": film,
             "url": f"/view?filename={quote(film, safe='')}&subfolder={quote(subfolder, safe='')}&type=output"}]


def _status_of(text: str) -> str:
    """task_status 的状态与采样步数压成一行进度，喂给前端的状态行。"""
    data = _json_of(text)
    status = str(data.get("status") or "")
    prog = data.get("progress")
    if isinstance(prog, dict) and prog.get("max"):
        status = f"{status} {int(prog.get('value') or 0)}/{int(prog['max'])}"
    seg = data.get("segment")     # 整片是多段任务：段号与段内步数也要上状态行
    if isinstance(seg, dict) and seg.get("total"):
        steps = int(seg.get("total_steps") or 0)
        step = f" {int(seg.get('step') or 0)}/{steps}" if steps else ""
        status = f"{status} 段 {int(seg.get('index') or 0)}/{int(seg['total'])}{step}"
    return status


def _caption(text: str) -> str:
    data = _json_of(text)
    images = [m for m in _media_of(text) if m["kind"] == "image"]
    if str(data.get("status")) != "succeeded":
        return str(data.get("error") or "") or "任务结束，没有产物"
    if images:
        w, h = data.get("width"), data.get("height")
        size = f" · {w}×{h}" if w and h else ""
        return f"完成：{len(images)} 张{size}"
    film = str(data.get("filename") or "")     # 出片任务的产物是成片文件名
    if film:
        return f"完成：成片 {film}"
    return "任务结束，没有产物"


def _openai_tools(tools: list) -> list:
    """MCP 的 tools/list 载荷原样发给远程 provider 会整请求 500：llama-server 逐条找 type 键
    （Failed to parse tools: Missing tool type），inputSchema 在 OpenAI 侧叫 parameters。
    _meta 里的示例参数是 Studio 工具卡预填用的，不进模型请求。"""
    return [{"type": "function",
             "function": {"name": str(t.get("name") or ""),
                          "description": str(t.get("description") or ""),
                          "parameters": t.get("inputSchema") or {"type": "object", "properties": {}}}}
            for t in tools]


def _chat(messages: list, tools: list) -> dict:
    """LLM 单轮接缝：llm 是重依赖，函数内导入，测试替掉这个函数就能跑整条循环。"""
    from .llm import chat_turn
    return chat_turn(messages, max_tokens=MAX_TOKENS, tools=tools)


def system_prompt(skill_id: str) -> str:
    try:
        text = SYSTEM_PROMPT_FILE.read_text(encoding="utf-8")
    except OSError as e:
        raise mcp.ToolError(f"缺少智能体系统提示词：{SYSTEM_PROMPT_FILE}（{e}）")
    if skill_id:
        text += f"\n\n用户已选定技能 {skill_id}：出图时直接用它作为 generate_image 的 skill_id。"
    return text


# ---------------------------------------------------------------------------
# 事件泵：循环里的进度帧要能在轮询中间发出去，不能等整轮跑完
# ---------------------------------------------------------------------------

async def _pump(make_coro):
    queue: asyncio.Queue = asyncio.Queue()

    async def worker():
        try:
            await make_coro(queue.put)
        except Exception as e:
            await queue.put({"__error__": str(e)})
        await queue.put(None)

    task = asyncio.create_task(worker())
    try:
        while True:
            frame = await queue.get()
            if frame is None:
                break
            if "__error__" in frame:
                await task
                raise mcp.ToolError(str(frame["__error__"]))
            yield frame
        await task
    finally:
        # 客户端断开时 aiohttp 关掉这个生成器，GeneratorExit 路径里 await 不动 worker；
        # 不 cancel 的话 LLM 循环与任务轮询会在后台跑满 MAX_TURNS 轮与 600 / 2400 秒上限
        if not task.done():
            task.cancel()


# ---------------------------------------------------------------------------
# 两条运行路径
# ---------------------------------------------------------------------------

async def _task_and_wait(client, tool: str, args: dict, emit, run) -> str:
    """异步任务工具只回 task_id：轮询 task_status 到终态，采样步数与段号经 status 帧发出去。
    停止位在轮询边界生效：掐掉任务并按 cancelled 终态交回，调用方的循环据此立刻收场。"""
    snap = await asyncio.to_thread(client.call, tool, args)
    task_id = str(_json_of(snap).get("task_id") or "")
    if not task_id:
        return snap                      # 同步出图的后端快照里已带 images
    run.task_id = task_id
    cap = TASK_WAIT_SEC if tool == "generate_image" else FILM_WAIT_SEC
    waited = 0.0
    while True:
        snap = await asyncio.to_thread(client.call, "task_status", {"task_id": task_id})
        status = _status_of(snap)
        await emit({"kind": "status", "tool": "task_status", "task_id": task_id,
                    "text": status or "排队中…"})
        if status.split(" ")[0] in TASK_FINAL:
            run.task_id = ""
            return snap
        if run.stop.is_set():
            await run.cancel_comfy_task()
            run.task_id = ""
            return json.dumps({"task_id": task_id, "status": "cancelled"}, ensure_ascii=False)
        if waited >= cap:
            raise mcp.ToolError(f"任务超时（{int(cap)} 秒）：{task_id}")
        await asyncio.sleep(TASK_POLL_SEC)
        waited += TASK_POLL_SEC


async def _tool_result(client, name: str, args: dict, emit, run) -> str:
    """一次 tools/call 的文本结果；异步任务工具在循环里轮询到终态，其余一次返回。"""
    try:
        if name in TASK_TOOLS:
            return await _task_and_wait(client, name, args, emit, run)
        return await asyncio.to_thread(client.call, name, args)
    except mcp.ToolError as e:
        return f"[error] {e}"


async def _run_skill(client, text: str, skill_id: str, emit, run) -> None:
    """显式选了生图技能：不叫 LLM，按 generate_image → task_status 直出图，模型与尺寸走技能自带设置。"""
    args = {"skill_id": skill_id, "prompt": text}
    await emit({"kind": "plan", "text": f"按技能 {skill_id} 直接出图"})
    await emit({"kind": "tool_call", "tool": "generate_image",
                "text": _clip(json.dumps(args, ensure_ascii=False), ARGS_CLIP)})
    result = await _task_and_wait(client, "generate_image", args, emit, run)
    await emit({"kind": "tool_result", "tool": "generate_image",
                "text": _clip(result, RESULT_CLIP), "media": _media_of(result)})
    if run.stop.is_set():
        await emit({"kind": "content", "text": CANCELLED_TEXT})
        return
    await emit({"kind": "content", "text": _caption(result)})


async def _run_agent(client, text: str, skill_id: str, emit, run) -> None:
    """LLM 规划 → tools/call → 结果回填 → 直到给出最终回答或用满轮次。
    停止位只在轮次与工具边界生效：LLM 的单轮请求在飞时掐不掉，回来后的第一个边界收场。"""
    messages = [{"role": "system", "content": system_prompt(skill_id)},
                {"role": "user", "content": text}]
    tools = _openai_tools(client.tool_list())
    answered = False
    for _ in range(MAX_TURNS):
        if run.stop.is_set():
            await emit({"kind": "content", "text": CANCELLED_TEXT})
            return
        msg = await asyncio.to_thread(_chat, messages, tools)
        content = str(msg.get("content") or "")
        calls = msg.get("tool_calls") or []
        assistant = {"role": "assistant", "content": content}
        if calls:
            assistant["tool_calls"] = calls
        messages.append(assistant)
        if content:
            await emit({"kind": "plan" if calls else "content", "text": content})
            if not calls:
                answered = True
                break       # 最终回答到了就收场，不能把剩下的轮次继续喂给 LLM
        for tc in calls:
            fn = tc.get("function") or {}
            name = str(fn.get("name") or "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            await emit({"kind": "tool_call", "tool": name,
                        "text": _clip(json.dumps(args, ensure_ascii=False), ARGS_CLIP)})
            result = await _tool_result(client, name, args, emit, run)
            await emit({"kind": "tool_result", "tool": name,
                        "text": _clip(result, RESULT_CLIP), "media": _media_of(result)})
            messages.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": result})
            if run.stop.is_set():
                await emit({"kind": "content", "text": CANCELLED_TEXT})
                return
    if not answered:
        await emit({"kind": "content",
                    "text": f"跑了 {MAX_TURNS} 轮还没有结论：把需求说具体些（要什么画面、用哪个技能）再试。"})


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

def _sse(frame) -> bytes:
    return ("data: " + json.dumps(_json_safe(frame), ensure_ascii=False) + "\n\n").encode("utf-8")


async def _events(run, text: str, skill_id: str):
    runner = _run_skill if skill_id else _run_agent
    _RUNS[run.run_id] = run
    try:
        # 首帧报 run_id：前端的「⏹ 取消」只有拿到它才能停这条循环
        yield _sse({"kind": "run", "run_id": run.run_id})
        try:
            async for frame in _pump(lambda emit: runner(run.client, text, skill_id, emit, run)):
                yield _sse(frame)
        except mcp.ToolError as e:
            yield f"data: [ERROR] {e}\n\n".encode("utf-8")
        except Exception as e:
            logger.info(f"[Neo Studio] agent run failed: {e}")
            yield f"data: [ERROR] {e}\n\n".encode("utf-8")
        yield b"data: [DONE]\n\n"
    finally:
        _RUNS.pop(run.run_id, None)
        # 前端 abort 时来不及发 cancel：断开路径上兜底掐掉在跑的 ComfyUI 任务
        if run.task_id:
            asyncio.create_task(run.cancel_comfy_task())


def _error_response(message: str) -> web.Response:
    return web.Response(
        body=f"data: [ERROR] {message}\n\ndata: [DONE]\n\n".encode("utf-8"),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@routes.post("/neo_agent/run")
async def agent_run(request):
    """右栏智能体：一次请求，一路 SSE 时间线。body {text, skill_id}。"""
    try:
        body = await request.json()
    except Exception:
        return _error_response("请求不是合法 JSON")
    text = str((body or {}).get("text") or "").strip()
    skill_id = str((body or {}).get("skill_id") or "").strip()
    if not text:
        return _error_response("没有输入内容")
    return web.Response(
        body=_events(_Run(McpClient(comfy_base(request))), text, skill_id),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"},
    )


@routes.post("/neo_agent/cancel")
async def agent_cancel(request):
    """时间线上的「取消」：run_id 停整条智能体循环并掐掉在跑的任务，task_id 只掐那一个任务
    （循环照旧换路）。两种 id 都从请求体来，会被拼进 cancel 路由的路径段，先按形态校验。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是合法 JSON"}, status=400)
    run_id = str((body or {}).get("run_id") or "").strip()
    task_id = str((body or {}).get("task_id") or "").strip()
    if run_id:
        if not RUN_ID_RE.match(run_id):
            return web.json_response({"success": False, "error": "run_id 不合法"}, status=400)
        run = _RUNS.get(run_id)
        if run is None:
            return web.json_response({"success": False, "error": "这次运行已经收场"}, status=404)
        run.stop.set()
        await run.cancel_comfy_task()
        return web.json_response({"success": True, "run_id": run_id, "task_id": run.task_id})
    if not TASK_ID_RE.match(task_id):
        return web.json_response({"success": False, "error": "task_id 不合法"}, status=400)
    try:
        data = json.loads(await asyncio.to_thread(
            McpClient(comfy_base(request)).call, "cancel_task", {"task_id": task_id}))
    except (mcp.ToolError, ValueError) as e:
        return web.json_response({"success": False, "error": str(e)}, status=404)
    return web.json_response({"success": True, **_json_safe(data)})

