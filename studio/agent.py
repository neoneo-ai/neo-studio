# SPDX-License-Identifier: Apache-2.0
"""右栏 Neo Agent 的后端代理循环（SSE）。

前端一次 POST /neo_agent/run 之后只收 {kind,text} 帧的时间线：plan / tool_call /
tool_result / status / content / ask / paused / resumed。运行一律由 LLM 规划并调工具；
界面当前状态（当前页、当前导演配方、绘画页模式、素材库目录）随请求体进系统提示词，
右栏不再让用户选技能，用哪个技能由 LLM 自己查 list_skills 定。

工具调用一律经进程内 MCP 客户端逐行走 mcp_server.serve 的 JSON-RPC，与外部
智能体连 MCP 是同一套口径：右栏看到的工具表就是 MCP 的全集，出片链路（director_run /
segment_run / assemble_run）也开给这个面板，能不能调由协议自己判，这里不再砍第二层。

四件右栏独有的事：mode=plan 的计划模式只查不跑（写操作工具不进 LLM 的工具表，调用到也拒）；
ask_user 是右栏自己的伪工具，循环发 ask 帧挂起等 POST /neo_agent/answer 把用户选项交回来；
images 是输入框附件图，按 prompts 的图片源口径解析成字节进首个 user 消息；
暂停 / 继续按 run_id 在轮次与轮询边界生效，暂停掐掉在飞的 ComfyUI 任务且不自动重发。

一次运行的时间线逐帧与 LLM 原文落在用户数据根的 agent_sessions/（一次运行一个 JSON，原子写，
只存本机、不进 Registry 包）：GET /neo_agent/sessions 列历史，GET /neo_agent/session 读回整条
时间线，POST /neo_agent/run 带 resume 时这一轮接在那条旧会话后面跑。
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import time
import uuid
from urllib.parse import quote

from aiohttp import web

from . import mcp_server as mcp
from .plugin_paths import AGENT_SESSIONS_DIR, PLUGIN_DIR
from .util import _json_safe

logger = logging.getLogger("NeoStudio")

routes = web.RouteTableDef()

# 入队即返回 task_id 的异步工具：循环里要轮询到终态，不能把一次 tools/call 当同步结果用
TASK_TOOLS = ("generate_image", "director_run", "segment_run", "assemble_run")
# 本轮附件图要注入参考的工具：出图直接进 references，出片的参考集归配方拥有（segment_run /
# director_run 没有参考入参），所以出片侧只写本轮新建配方的 characters 与段 refs
REF_TOOLS = ("generate_image", "director_plan", "director_save")

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
# ask 帧的 ask_id 同样是 uuid4().hex，回答请求带回来只认这个形态
ASK_ID_RE = re.compile(r"^[0-9a-f]{32}$")
# 一次运行能带的附件图张数：再多就是往 LLM 请求里灌 base64
MAX_IMAGES = 6
# 等用户点选项的上限：前端整页导航走、SSE 还挂着时不能把循环吊死在 await 上
ASK_WAIT_SEC = 1800.0
# 暂停后等「继续」的上限，与 ask 同档：暂停后整页导航走、SSE 还挂着时按超时收场
PAUSE_WAIT_SEC = 1800.0
ANSWER_CLIP = 2000
# 会话落盘：一次运行一个文件在数据根的 agent_sessions/。续聊要回填给 LLM 的原文比
# 时间线上的展示裁剪宽——RESULT_CLIP 那一档是给右栏铺卡片用的，接上下文要更全
RESUME_MSG_CLIP = 4000
RESUME_MSG_MAX = 40
SESSION_FILE_MAX = 400_000
MAX_SESSIONS = 100
SESSION_TTL_SEC = 7 * 24 * 3600
# 会话文件名是 <创建时间>-<run_id>.json，按名字倒序就是新的在前；
# 名字形态不对的文件一律无视，这一页只认自己写出来的东西
SESSION_FILE_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{32}\.json$")
# 计划模式不许执行的工具：生成入队、配方写、取消在跑的任务，全是改状态的动作
PLAN_BLOCKED_TOOLS = frozenset(("generate_image", "director_run", "segment_run", "assemble_run",
                                "director_save", "director_copy", "director_keyframes", "cancel_task"))
# 出片三类的产物是 mp4，快照 succeeded 后带 filename + 产物子目录，取图按它拼 /view
FILM_KINDS = ("director", "segment", "assemble")
CANCELLED_TEXT = "已取消：智能体循环与在跑的任务已停止"
PAUSE_TIMEOUT_TEXT = "已暂停后超时收场：在跑的任务已取消，这次运行结束"
SYSTEM_PROMPT_FILE = PLUGIN_DIR / "prompts" / "agent" / "system_prompt.md"

# 右栏伪工具：只进本次运行的 LLM 工具表，不进 MCP 注册表，外部 MCP 客户端看不到
ASK_TOOL = {"type": "function", "function": {
    "name": "ask_user",
    "description": ("要用户在几个方向里定一个时调用：把问题与 2-5 个互斥选项发给用户，等到回答再继续。"
                    "一次运行最多问一次；能用查询工具确定的事不要问用户。"),
    "parameters": {"type": "object", "properties": {
        "question": {"type": "string", "description": "要用户决定什么，一句话说清"},
        "options": {"type": "array", "items": {"type": "string"},
                    "description": "2-5 个用户可以直接照选的方向"}},
        "required": ["question", "options"]}}}

PLAN_MODE_NOTE = """

本轮是计划模式（Plan）：只查不跑。
- generate_image / director_run / segment_run / assemble_run / director_save / director_copy /
  director_keyframes / cancel_task 这一类改状态的工具本轮调不到，调用会被后端拒回错误。
- 要看现状就用查询类工具查清：neo_status、list_skills、list_models、list_recipes、
  director_recipes、director_spec、list_gallery。
- 方向上有分叉就用 ask_user 把问题与选项发给用户，等回答再定计划。
- 收场时交出一份能照着跑的计划：分步骤写明每步要调的工具与关键参数（技能 id、段数、
  时长、尺寸、配方名），最后一步写明产物是什么。
- 计划模式里不许说「已完成」，也不许编造产物文件名。"""



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
    正卡在一次请求里时，取消端点要能立刻掐掉在跑的 ComfyUI 任务，不能等循环回到轮询边界。
    asks 是 ask_user 的挂起点：循环发完 ask 帧就 await 在这个 Event 上，回答请求按
    ask_id 找到它写入答案并 set；取消整条运行时也要把挂着的问句一并交收，
    否则取消点下去循环还卡在 await 上。pause / resume 是暂停面的一对 Event：
    「暂停」置 pause，循环在下一个轮次 / 轮询边界停在 await_resume 上；「继续」置 resume
    把它放开。没在暂停时置 resume 是空操作——pause 一侧先清掉它，旧的一次「继续」
    不会把下一次暂停直接放过去。

    落盘面（created / mode / frames / messages / 终态）挂在同一个对象上，_events 收尾时整份
    写进数据根的 agent_sessions/：前端「🗂 历史」读回的就是这一份。"""

    def __init__(self, client):
        self.client = client
        self.run_id = uuid.uuid4().hex
        self.stop = asyncio.Event()
        self.pause = asyncio.Event()
        self.resume = asyncio.Event()
        self.task_id = ""
        self.asks: dict[str, dict] = {}
        # 会话落盘面，挂在同一个对象上：收尾时整份写进数据根的 agent_sessions/，
        # 前端「🗂 历史」读回时间线，「继续这次会话」接的是 messages
        self.created = time.time()
        self.mode = "act"
        self.text = ""
        self.context = ""
        self.image_refs: list[str] = []
        # 附件原样挂在运行对象上：注入参考要的是图片源本身，image_refs 只是会话摘要。
        # image_names 是落盘后的 input/ 名字缓存，两者都不进会话落盘（落盘不带图字节）
        self.image_sources: list[dict] = []
        self.image_names: list[str] = []
        self.resume_of = ""
        self.status = "running"
        self.frames: list[dict] = []
        self.messages: list[dict] = []

    async def await_answer(self, emit, question: str, options: list) -> str:
        """发一问，等到用户点选或超时。超时是真实失败模式：整页导航走、SSE 还挂着，
        循环不能永远停在 await 上。"""
        ask_id = uuid.uuid4().hex
        ask = {"event": asyncio.Event(), "text": ""}
        self.asks[ask_id] = ask
        try:
            await emit({"kind": "ask", "ask_id": ask_id, "text": question, "options": options})
            await asyncio.wait_for(ask["event"].wait(), ASK_WAIT_SEC)
            return ask["text"]
        except asyncio.TimeoutError:
            return "[timeout] 用户没有回应这个问题：按你自己的判断继续，并在回答里说明这一点"
        finally:
            self.asks.pop(ask_id, None)

    def wake_asks(self, text: str):
        """取消整条运行时交收挂着的问句：写一句定论把 await 放开。"""
        for ask in self.asks.values():
            ask["text"] = text
            ask["event"].set()

    async def await_resume(self, emit) -> bool:
        """暂停检查点：没在暂停直接过；暂停了就发 paused 帧等在「继续」上。
        超时是真实失败模式：暂停后整页导航走、SSE 还挂着，循环不能永远等在这里——
        按超时收场并把停止位置置上，返回 False 让调用方立刻收场。"""
        if not self.pause.is_set():
            return True
        await emit({"kind": "paused", "text": "已暂停：在跑的任务已取消，点「继续」接着跑"})
        try:
            await asyncio.wait_for(self.resume.wait(), PAUSE_WAIT_SEC)
        except asyncio.TimeoutError:
            self.stop.set()
            await emit({"kind": "content", "text": PAUSE_TIMEOUT_TEXT})
            return False
        self.pause.clear()
        await emit({"kind": "resumed", "text": "已继续"})
        return True

    async def cancel_comfy_task(self):
        """掐掉在跑的 ComfyUI 任务。没有任务、任务已终态、取消失败都不影响循环收场。"""
        if not self.task_id:
            return
        try:
            await asyncio.to_thread(self.client.call, "cancel_task", {"task_id": self.task_id})
        except (mcp.ToolError, OSError, ValueError) as e:
            logger.info(f"[Neo Studio] agent cancel task {self.task_id} failed: {e}")


# ---------------------------------------------------------------------------
# 会话落盘：一次运行一个文件，供「🗂 历史」读回时间线、供「继续这次会话」接上下文
# ---------------------------------------------------------------------------

def _session_files() -> list:
    """目录里的会话文件，新的在前。同秒落盘的两条只能靠落盘时间分先后——
    列表顺序与超条数收档都要这个顺序，文件名前缀做同时间下的次级键。
    名字形态不对的一律无视：这一页只认自己写出来的文件，用户丢进这目录的别的文件不碰。"""
    if not AGENT_SESSIONS_DIR.is_dir():
        return []
    files = [p for p in AGENT_SESSIONS_DIR.glob("*.json") if SESSION_FILE_RE.match(p.name)]
    return sorted(files, key=lambda p: (p.stat().st_mtime, p.name), reverse=True)


def _session_of(run_id: str):
    hits = [p for p in AGENT_SESSIONS_DIR.glob(f"*-{run_id}.json") if SESSION_FILE_RE.match(p.name)]
    return hits[0] if hits else None


def _prune_sessions() -> None:
    """过期与超条数的会话收掉：只 unlink 这个目录里按名字认出来的自己的文件。"""
    files = _session_files()
    stale = files[MAX_SESSIONS:]
    now = time.time()
    stale += [p for p in files[:MAX_SESSIONS] if now - p.stat().st_mtime > SESSION_TTL_SEC]
    for p in stale:
        p.unlink(missing_ok=True)


def _stored_messages(messages: list) -> list:
    """续聊要回填给 LLM 的原文。system 不落盘：续聊按当时的 mode 与界面状态重生成，
    换了模式不会带着旧模式的提示词跑。附件图的 base64 不落盘：一轮里灌进请求的图字节
    能把会话文件撑到读不动，续聊要带图就靠 input 目录里的文件名重新解析。"""
    out = []
    for msg in messages:
        if msg.get("role") == "system":
            continue
        content = msg.get("content")
        if isinstance(content, list):
            parts = [str(p.get("text") or "") for p in content if p.get("type") == "text"]
            imgs = sum(1 for p in content if p.get("type") == "image_url")
            if imgs:
                # 附件说明落在句首：逐条裁长度时句子尾部会被裁掉，说明落在尾部就等于没落盘
                parts.insert(0, f"[附件图 {imgs} 张，落盘不存图；这一轮要带图就从输入框重新附加]")
            content = "\n".join(parts)
        item = {"role": str(msg.get("role") or ""), "content": _clip(content or "", RESUME_MSG_CLIP)}
        if msg.get("tool_calls"):
            item["tool_calls"] = msg["tool_calls"]
        if msg.get("tool_call_id"):
            item["tool_call_id"] = str(msg["tool_call_id"])
        out.append(item)
    return out[-RESUME_MSG_MAX:]


def _image_refs(raw) -> list:
    """附件图只落引用不落字节：素材库拖入与本地选图都已落进 input 目录，按文件名记；
    粘贴来的 data URI 没有文件名，记一句，续聊要带图就从输入框重新附加。"""
    refs = []
    for src in (raw or [])[:MAX_IMAGES]:
        if not isinstance(src, dict):
            continue
        refs.append(str(src.get("value") or "") if src.get("kind") == "input" else "[粘贴图]")
    return [r for r in refs if r]


def _save_session(run) -> None:
    """一次运行的时间线与续聊原文落盘，原子写（.tmp 再 replace）。会话正文含用户提示词、
    本机路径与产物名，只落在数据根里：不进 Registry 包、不出本机。"""
    payload = {"version": 1, "run_id": run.run_id, "created": run.created,
               "updated": time.time(), "mode": run.mode, "status": run.status,
               "resume_of": run.resume_of,
               "input": {"text": run.text, "images": run.image_refs, "context": run.context},
               "frames": run.frames, "messages": _stored_messages(run.messages)}
    data = json.dumps(_json_safe(payload), ensure_ascii=False)
    # 一次大结果（技能全表、长工具返回）能把文件撑到几兆：从最旧消息丢起，
    # 接得上上下文的最后几轮比完整历史更值钱
    while len(data) > SESSION_FILE_MAX and len(payload["messages"]) > 1:
        payload["messages"].pop(0)
        data = json.dumps(_json_safe(payload), ensure_ascii=False)
    if len(data) > SESSION_FILE_MAX:
        # 时间线是展示层，续聊不读它：文件还是太大就只留最终回答
        payload["frames"] = [f for f in payload["frames"] if f.get("kind") == "content"][-1:]
        data = json.dumps(_json_safe(payload), ensure_ascii=False)
    AGENT_SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(run.created))
    target = AGENT_SESSIONS_DIR / f"{stamp}-{run.run_id}.json"
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    os.replace(tmp, target)
    _prune_sessions()


def _read_session(path):
    """整份读回一条会话。半截文件是真实失败模式（写盘中途断电、磁盘写满）：
    它不进列表也不参与续聊，收掉，别让下一次列表整页跟着炸。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        path.unlink(missing_ok=True)
        return None
    return data if isinstance(data, dict) else None


def _load_session(run_id: str):
    path = _session_of(run_id)
    return _read_session(path) if path else None


def _list_sessions() -> list:
    """历史列表，新的在前，只回摘要。摘要要读整份文件才取得到首句与工具数：
    条数上限与单文件上限一起把这一页的读量压在几兆内，不为此留第二份索引文件。"""
    _prune_sessions()
    out = []
    for path in _session_files():
        data = _read_session(path)
        if data is None:
            continue
        inp = data.get("input") or {}
        out.append({"run_id": str(data.get("run_id") or ""), "created": data.get("created"),
                    "mode": data.get("mode"), "status": data.get("status"),
                    "resume_of": data.get("resume_of"),
                    "text": _clip(str(inp.get("text") or ""), 120),
                    "images": len(inp.get("images") or []),
                    "tools": sum(1 for f in (data.get("frames") or []) if f.get("kind") == "tool_call")})
    return out


def _delete_sessions(run_id: str = "") -> int:
    """删一条会话，或清空整目录里的会话文件。只按名字认自己的文件，目录本身与别的文件不碰。"""
    if run_id:
        path = _session_of(run_id)
        if path is None:
            return 0
        path.unlink(missing_ok=True)
        return 1
    n = 0
    for path in _session_files():
        path.unlink(missing_ok=True)
        n += 1
    return n


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
    if not film or kind not in FILM_KINDS:
        return []
    # 产物子目录由后端快照给出（整片 NeoDirector/<配方>、单段 neo_director_regen、拼接 neo_director_merge）
    subfolder = str(data.get("subfolder") or "")
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


def _openai_tools(tools: list, plan: bool = False) -> list:
    """MCP 的 tools/list 载荷原样发给远程 provider 会整请求 500：llama-server 逐条找 type 键
    （Failed to parse tools: Missing tool type），inputSchema 在 OpenAI 侧叫 parameters。
    _meta 里的示例参数是 Studio 工具卡预填用的，不进模型请求。
    plan=True 时把改状态的工具整条摘掉：模型看不见工具就不会去调，比只在调用点上拦更可靠。"""
    out = [{"type": "function",
            "function": {"name": str(t.get("name") or ""),
                         "description": str(t.get("description") or ""),
                         "parameters": t.get("inputSchema") or {"type": "object", "properties": {}}}}
           for t in tools]
    return [t for t in out if t["function"]["name"] not in PLAN_BLOCKED_TOOLS] if plan else out


def _user_message(text: str, images: list) -> dict:
    """首个 user 消息：带附件图时按多模态口径组装（与 skill.py 的技能代理循环同一形状）。
    图只进这一条消息，后续轮次靠历史文本走，不逐轮重灌 base64。"""
    if not images:
        return {"role": "user", "content": text}
    parts = [{"type": "image_url",
              "image_url": {"url": "data:image/png;base64," + base64.b64encode(b).decode("ascii")}}
             for b in images]
    parts.append({"type": "text", "text": text})
    return {"role": "user", "content": parts}


def _resolve_images(raw: list) -> list:
    """输入框附件图按 prompts 的图片源口径解析（data URI / input 目录文件名），
    超长的图由 resolve_image_bytes 等比缩到 MAX_IMAGE_SIDE。没带图就不碰 prompts（它带 PIL 与
    folder_paths 依赖，不该为一次纯文字对话被拖进来）。"""
    if not raw:
        return []
    from .prompts import resolve_image_bytes
    return [b for b in (resolve_image_bytes(src) for src in raw[:MAX_IMAGES]
                        if isinstance(src, dict)) if b]


def _attachment_names(sources: list) -> list:
    """本轮附件落成参考图名（出图与出片共用）。粘贴 / 拖入的图由 image_gen._reference_name
    写进 input/NeoAgent/ 按内容哈希去重——同一张图重发不重复落盘，也是 🎨 绘画页出图今天就在写的文件；
    素材库拖入的图本来就是 input/ 名，原样返回。名字要在生成工具真正被调到时才要，纯问答的一轮不写文件。"""
    if not sources:
        return []
    from .image_gen import _reference_name
    return [n for n in (_reference_name(src) for src in sources[:MAX_IMAGES]) if n]


async def _run_references(run) -> list:
    """参考图名按运行对象缓存：一条会话里连续出图只落盘一次。"""
    if not run.image_sources:
        return []
    if not run.image_names:
        run.image_names = await asyncio.to_thread(_attachment_names, run.image_sources)
    return run.image_names


async def _recipe_taken(client, name: str) -> bool:
    """director_save 要写的名字是否已被占用——注入只碰本轮新建的配方，改用户已有配方是他的明确要求。"""
    data = _json_of(await asyncio.to_thread(client.call, "director_recipes", {}))
    return any(str(r.get("name") or "") == name for r in data.get("recipes") or [])


async def _apply_references(client, name: str, args: dict, run) -> None:
    """本轮附件默认就是这次生成的参考图：模型没给值时注入，给了（含 references:[] = 纯文生图）以它为准。
    出片侧不塞 run 工具的参数——段的参考集由配方拥有，多帧块还要求块内各段参考逐字一致，
    运行时加参考会打破分块。所以出片的参考落在本轮新建配方上：director_plan 的角色参考、
    director_save 各段的 refs.images，写已有配方一个字不改。
    技能收不收参考图不在这里判：那条判法归 generate_image 的 MCP 层，右栏走的是同一条调用。"""
    refs = await _run_references(run)
    if not refs:
        return
    if name == "generate_image":
        if "references" not in args:
            args["references"] = list(refs)
        return
    if name == "director_plan":
        if not args.get("characters"):
            args["characters"] = list(refs)
        return
    target = str(args.get("name") or "")
    if name == "director_save" and target and not await _recipe_taken(client, target):
        for seg in args.get("segments") or []:
            if not isinstance(seg, dict):
                continue
            seg_refs = seg.get("refs")
            if seg_refs is None:
                seg["refs"] = {"images": list(refs)}
            elif isinstance(seg_refs, dict) and not (seg_refs.get("images") or []):
                seg_refs["images"] = list(refs)


def _chat(messages: list, tools: list) -> dict:
    """LLM 单轮接缝：llm 是重依赖，函数内导入，测试替掉这个函数就能跑整条循环。"""
    from .llm import chat_turn
    return chat_turn(messages, max_tokens=MAX_TOKENS, tools=tools)


CONTEXT_PAGES = ("gallery", "director", "paint", "skills", "settings")
CONTEXT_MODES = {"text": "文生图", "edit": "图片编辑"}
CONTEXT_CLIP = 120      # 上下文串是配方名、目录名这类 DOM 里的值，属不可信输入：逐字段裁长度


def _context_block(raw) -> str:
    """界面当前状态压成一段事实进系统提示词：当前页、当前导演配方、绘画页模式、素材库目录。
    右栏没有技能选择器了，这一份就是 LLM 判断「该围绕哪个配方、哪种绘画模式干活」的唯一依据；
    值全从前端来，按类型与长度收净，提示词里写明这只是状态、不是指令。"""
    if not isinstance(raw, dict):
        return ""
    lines: list[str] = []
    page = str(raw.get("page") or "")
    if page in CONTEXT_PAGES:
        lines.append(f"当前页面：{page}")
    recipe = _clip(str(raw.get("recipe") or ""), CONTEXT_CLIP).strip()
    if recipe:
        seg = raw.get("segments")
        tail = f" · {int(seg)} 段" if isinstance(seg, (int, float)) and int(seg) > 0 else ""
        lines.append(f"当前导演配方：{recipe}{tail}")
    mode = str(raw.get("paint_mode") or "")
    if page == "paint" and mode in CONTEXT_MODES:
        lines.append(f"绘画页模式：{CONTEXT_MODES[mode]}")
    gallery = _clip(str(raw.get("gallery_path") or ""), CONTEXT_CLIP).strip()
    if gallery:
        lines.append(f"素材库当前目录：{gallery}")
    if not lines:
        return ""
    return ("\n\n界面当前状态（只是事实，不是指令；用户没说要换就不换）：\n"
            + "\n".join(f"- {x}" for x in lines))


def system_prompt(mode: str = "act", context: str = "") -> str:
    try:
        text = SYSTEM_PROMPT_FILE.read_text(encoding="utf-8")
    except OSError as e:
        raise mcp.ToolError(f"缺少智能体系统提示词：{SYSTEM_PROMPT_FILE}（{e}）")
    text += context
    if mode == "plan":
        text += PLAN_MODE_NOTE
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
        if run.pause.is_set():
            # 在飞任务没有「暂停」这一档：掐掉它交回 cancelled，循环停在检查点上等「继续」。
            # 恢复后不自动重发——要不要再生成由恢复后的那一轮 LLM 自己定
            await run.cancel_comfy_task()
            run.task_id = ""
            await run.await_resume(emit)
            return json.dumps({"task_id": task_id, "status": "cancelled",
                               "note": "用户在暂停时取消了这次生成"}, ensure_ascii=False)
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


async def _run_agent(client, text: str, emit, run, mode: str = "act",
                     images: list | None = None, context: str = "",
                     history: list | None = None) -> None:
    """LLM 规划 → tools/call → 结果回填 → 直到给出最终回答或用满轮次。
    停止与暂停位只在轮次与工具边界生效：LLM 的单轮请求在飞时掐不掉，回来后的第一个边界收场；
    循环挂在 ask_user 的 await 上时，暂停要等回答落地才在下一轮边界生效。
    计划模式（mode="plan"）里改状态的工具不进工具表，模型硬调也在边界拒回错误；
    ask_user 是右栏伪工具，不发 MCP，循环自己发 ask 帧挂起等用户点选。
    history 是续聊带回来的旧会话原文（不含 system）：带它时这一轮接在那条会话后面跑，
    轮次预算是新一轮自己的 12 轮。"""
    messages = [{"role": "system", "content": system_prompt(mode, context)}]
    messages += list(history or [])
    messages.append(_user_message(text, images or []))
    run.messages = messages       # 同一个 list 对象：循环里的 append 逐轮可见，半途收场也留得下
    tools = _openai_tools(client.tool_list(), plan=(mode == "plan")) + [ASK_TOOL]
    answered = False
    for _ in range(MAX_TURNS):
        if run.stop.is_set():
            await emit({"kind": "content", "text": CANCELLED_TEXT})
            return
        if not await run.await_resume(emit):
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
            if mode == "act" and name in REF_TOOLS:
                # 注入要在发 tool_call 帧之前：时间线的工具卡上得看得见这次真用了哪些参考图
                await _apply_references(client, name, args, run)
            await emit({"kind": "tool_call", "tool": name,
                        "text": _clip(json.dumps(args, ensure_ascii=False), ARGS_CLIP)})
            if name == "ask_user":
                result = await run.await_answer(
                    emit, str(args.get("question") or "").strip(),
                    [str(o).strip() for o in (args.get("options") or []) if str(o).strip()][:5])
            elif mode == "plan" and name in PLAN_BLOCKED_TOOLS:
                # 计划模式里模型仍可能硬调写操作：拒回原文它才会改口去写计划
                result = (f"[error] 计划模式不执行 {name}：把要做的事写进计划，"
                          f"让用户切到执行模式再跑")
            else:
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


async def _events(run, text: str, mode: str = "act", images: list | None = None,
                  context: str = "", history: list | None = None):
    async def runner(emit):
        # 逐帧记在运行对象上：历史里打开旧会话要的就是这一串帧，前端不留第二份
        async def record(frame):
            run.frames.append(frame)
            await emit(frame)

        await _run_agent(run.client, text, record, run, mode, images, context, history)

    _RUNS[run.run_id] = run
    try:
        # 首帧报 run_id：前端的「⏹ 取消」与「选项回答」都要靠它认这次运行
        yield _sse({"kind": "run", "run_id": run.run_id})
        try:
            async for frame in _pump(runner):
                yield _sse(frame)
            run.status = "cancelled" if run.stop.is_set() else "succeeded"
        except mcp.ToolError as e:
            run.status = "failed"
            yield f"data: [ERROR] {e}\n\n".encode("utf-8")
        except Exception as e:
            run.status = "error"
            logger.info(f"[Neo Studio] agent run failed: {e}")
            yield f"data: [ERROR] {e}\n\n".encode("utf-8")
        yield b"data: [DONE]\n\n"
    finally:
        _RUNS.pop(run.run_id, None)
        # 前端 abort 时来不及发 cancel：断开路径上兜底掐掉在跑的 ComfyUI 任务
        if run.task_id:
            asyncio.create_task(run.cancel_comfy_task())
        if run.status == "running":
            # 断流收尾时循环没机会写终态：落了 interrupted，历史里看得见这一条没跑完
            run.status = "interrupted"
        # 落盘挂成后台任务：收尾路径上 await 不动它（前端 abort 时这个生成器正被关掉），
        # 半途收场的运行也要在历史里留下这一条
        asyncio.create_task(asyncio.to_thread(_save_session, run))


def _error_response(message: str) -> web.Response:
    return web.Response(
        body=f"data: [ERROR] {message}\n\ndata: [DONE]\n\n".encode("utf-8"),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@routes.post("/neo_agent/run")
async def agent_run(request):
    """右栏智能体：一次请求，一路 SSE 时间线。body {text, mode, images, context, resume}。
    mode 只认 plan / act，其余按 act；images 是输入框附件图，按 prompts 的图片源口径给，
    act 模式下它们默认作为本轮生成的参考图（见 _apply_references）；
    context 是界面当前状态（当前页 / 当前导演配方 / 绘画页模式 / 素材库目录），值从前端 DOM 来；
    resume 是「继续这次会话」要接的那条旧会话的 run_id，带它时旧对话原文接在系统提示词之后。"""
    try:
        body = await request.json()
    except Exception:
        return _error_response("请求不是合法 JSON")
    body = body or {}
    text = str(body.get("text") or "").strip()
    mode = str(body.get("mode") or "act").strip()
    if mode not in ("plan", "act"):
        mode = "act"
    context = _context_block(body.get("context"))
    images = await asyncio.to_thread(_resolve_images, body.get("images") or [])
    if not text:
        # 只给图不给字是合法输入（看图说话），补一句要什么，别让 LLM 对着图无话可说
        text = "（没有文字说明）看这张附件图，说清你能拿它做什么，并给出建议的下一步" if images else ""
    if not text:
        return _error_response("没有输入内容")
    resume = str(body.get("resume") or "").strip()
    history: list = []
    if resume:
        # 续聊带的 run_id 会拼进会话文件名的匹配段，按后端发出去的形态校验；
        # 还在跑的循环不能同时被两条请求接上
        if not RUN_ID_RE.match(resume):
            return _error_response("resume 的 run_id 不合法")
        if resume in _RUNS:
            return _error_response("这次运行还在跑，不能同时续")
        record = await asyncio.to_thread(_load_session, resume)
        if record is None:
            return _error_response(f"会话不存在：{resume}")
        history = list(record.get("messages") or [])
    run = _Run(McpClient(comfy_base(request)))
    run.mode, run.text, run.context = mode, text, context
    run.resume_of = resume
    run.image_refs = _image_refs(body.get("images"))
    run.image_sources = [src for src in (body.get("images") or [])
                         if isinstance(src, dict)][:MAX_IMAGES]
    return web.Response(
        body=_events(run, text, mode, images, context, history),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"},
    )


@routes.post("/neo_agent/answer")
async def agent_answer(request):
    """时间线上「选项确认卡」的回答：把用户选的方向交回正等在 ask 帧上的循环。
    run_id / ask_id 都从请求体来，按后端发出去的形态校验，认不到就 404，不给任意目标留口子。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是合法 JSON"}, status=400)
    run_id = str((body or {}).get("run_id") or "").strip()
    ask_id = str((body or {}).get("ask_id") or "").strip()
    text = str((body or {}).get("text") or "").strip()
    if not RUN_ID_RE.match(run_id):
        return web.json_response({"success": False, "error": "run_id 不合法"}, status=400)
    if not ASK_ID_RE.match(ask_id):
        return web.json_response({"success": False, "error": "ask_id 不合法"}, status=400)
    if not text:
        return web.json_response({"success": False, "error": "没有回答内容"}, status=400)
    run = _RUNS.get(run_id)
    if run is None:
        return web.json_response({"success": False, "error": "这次运行已经收场"}, status=404)
    ask = run.asks.get(ask_id)
    if ask is None:
        return web.json_response({"success": False, "error": "这个问题已经收场"}, status=404)
    ask["text"] = _clip(text, ANSWER_CLIP)
    ask["event"].set()
    return web.json_response({"success": True, "run_id": run_id, "ask_id": ask_id})


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
        run.resume.set()      # 循环正停在暂停检查点上：不放开 resume 它就退不出 await
        run.wake_asks("用户已取消这次运行")
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



@routes.post("/neo_agent/pause")
async def agent_pause(request):
    """时间线上的「暂停」：让循环停在下一个轮次 / 轮询边界，SSE 开着不收尾。
    在飞的 ComfyUI 任务没有暂停态，边界上会掐掉它，恢复后不自动重发。
    run_id 从请求体来，按后端发出去的形态校验，认不到就 404，不给任意目标留口子。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是合法 JSON"}, status=400)
    run_id = str((body or {}).get("run_id") or "").strip()
    if not RUN_ID_RE.match(run_id):
        return web.json_response({"success": False, "error": "run_id 不合法"}, status=400)
    run = _RUNS.get(run_id)
    if run is None:
        return web.json_response({"success": False, "error": "这次运行已经收场"}, status=404)
    run.resume.clear()    # 上一次「继续」留下的 set 不能把这一次暂停直接放过去
    run.pause.set()
    return web.json_response({"success": True, "run_id": run_id, "task_id": run.task_id})


@routes.post("/neo_agent/resume")
async def agent_resume(request):
    """时间线上的「继续」：放开正等在暂停检查点上的循环。没在暂停时这一发是空操作，
    循环照旧跑到下一个边界，前端重复点「继续」不会把运行推过检查点。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是合法 JSON"}, status=400)
    run_id = str((body or {}).get("run_id") or "").strip()
    if not RUN_ID_RE.match(run_id):
        return web.json_response({"success": False, "error": "run_id 不合法"}, status=400)
    run = _RUNS.get(run_id)
    if run is None:
        return web.json_response({"success": False, "error": "这次运行已经收场"}, status=404)
    run.resume.set()
    return web.json_response({"success": True, "run_id": run_id})


@routes.get("/neo_agent/sessions")
async def agent_sessions(request):
    """「🗂 历史」的列表：新的在前，只回摘要（时间 / 模式 / 终态 / 首句 / 工具数），
    整条时间线由 /neo_agent/session 按 run_id 读回。"""
    return web.json_response(_json_safe({"ok": True, "sessions": await asyncio.to_thread(_list_sessions)}))


@routes.get("/neo_agent/session")
async def agent_session(request):
    """打开一条旧会话：时间线逐帧与续聊要用的 messages 一起读回去。
    run_id 从查询串来，按后端发出去的形态校验，认不到 404，不给路径穿越留口子。"""
    run_id = str(request.query.get("run_id") or "").strip()
    if not RUN_ID_RE.match(run_id):
        return web.json_response({"ok": False, "error": "run_id 不合法"}, status=400)
    data = await asyncio.to_thread(_load_session, run_id)
    if data is None:
        return web.json_response({"ok": False, "error": f"会话不存在：{run_id}"}, status=404)
    return web.json_response(_json_safe({"ok": True, "session": data}))


@routes.post("/neo_agent/session/delete")
async def agent_session_delete(request):
    """删一条会话：run_id 按后端发出去的形态校验，只删那一个文件。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求不是合法 JSON"}, status=400)
    run_id = str((body or {}).get("run_id") or "").strip()
    if not RUN_ID_RE.match(run_id):
        return web.json_response({"success": False, "error": "run_id 不合法"}, status=400)
    n = await asyncio.to_thread(_delete_sessions, run_id)
    if not n:
        return web.json_response({"success": False, "deleted": 0, "error": "会话不存在"}, status=404)
    return web.json_response({"success": True, "deleted": n})


@routes.post("/neo_agent/session/delete_all")
async def agent_session_delete_all(request):
    """「清空对话」连着清历史：只删会话目录里按名字认出来的文件，目录本身与别的文件不碰。"""
    return web.json_response({"success": True, "deleted": await asyncio.to_thread(_delete_sessions)})
