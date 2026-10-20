# SPDX-License-Identifier: Apache-2.0
"""右栏 Neo Agent 的后端代理循环（SSE）。

前端一次 POST /neo_agent/run 之后只收 {kind,text} 帧的时间线：plan / tool_call /
tool_result / status / content / ask / paused / resumed / context / usage / plan_steps /
focus / finish。运行一律由 LLM 规划并调工具；
界面当前状态（当前页、当前导演配方、绘画页模式、素材库目录）随请求体进系统提示词，
右栏不再让用户选技能，用哪个技能由 LLM 自己查 list_skills 定。

工具调用一律经进程内 MCP 客户端逐行走 mcp_server.serve 的 JSON-RPC，与外部
智能体连 MCP 是同一套口径：右栏看到的工具表就是 MCP 的全集，出片链路（director_run /
segment_run / assemble_run）也开给这个面板，能不能调由协议自己判，这里不再砍第二层。

六件右栏独有的事：mode=plan 的计划模式只查不跑（写操作工具不进 LLM 的工具表，调用到也拒）；
ask_user / finish_task / write_plan 是右栏自己的伪工具，不发 MCP——ask 帧挂起等 POST /neo_agent/answer
把用户选项交回来，write_plan 在计划模式收场前把执行清单交下来（右栏铺成逐条打勾的清单，
切到执行模式后照它跑并逐条划掉），finish_task 在执行模式交收场文本、产物名与下一步方向
（产物名只认本次运行真出现过的工具结果，编出来的名字拒回）；
images 是输入框附件图，按 prompts 的图片源口径解析成字节进首个 user 消息；
暂停 / 继续按 run_id 在轮次与轮询边界生效，暂停掐掉在飞的 ComfyUI 任务且不自动重发；
每一轮请求前按 CONTEXT_BUDGET_TOKENS 压一次上下文，超了从最旧的工具结果压成一行标记
（只换 content，不删消息——assistant.tool_calls 与 tool.tool_call_id 是成对的）；
出片级工具（整片 / 单段 / 拼接 / 关键帧）在入队之前先发一张量级确认卡，用户在偏好里关掉
confirm_films 才不拦。

一次运行的时间线逐帧与 LLM 原文落在用户数据根的 agent_sessions/（一次运行一个 JSON，原子写，
只存本机、不进 Registry 包）：GET /neo_agent/sessions 列历史，GET /neo_agent/session 读回整条
时间线，POST /neo_agent/run 带 resume 时这一轮接在那条旧会话后面跑。
一次运行里最近一次生成的技能 / 主模型 / 尺寸 / 种子 / 产物名记成焦点链，逐轮重注入系统提示词
并随会话落盘：「再来一张」接的就是上一张那一发的配置，续聊不会连自己刚用过的技能一起忘掉。
provider 每轮报的 token 统计逐轮累进 run.usage 并随会话落盘，历史列表里看得见这条会话烧掉多少；
「从这条消息重新开始」带 from 时从那条会话的第 N 条用户消息截断，本轮从那个点重新长出去。
用户级偏好在 configs/agent_prefs.json（一台机器一份，右栏「设为偏好」写它），逐轮进系统提示词，
排在焦点链之后——本会话刚出过那一发的真值优先。
输入框 @ 点名的技能是本轮指令，排在偏好与焦点链之后：用户明说了这一发用哪个技能，就出哪一发。
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
from .plugin_paths import AGENT_SESSIONS_DIR, CONFIGS_DIR, PLUGIN_DIR
from .util import _json_safe

logger = logging.getLogger("NeoStudio")

routes = web.RouteTableDef()

# 入队即返回 task_id 的异步工具：循环里要轮询到终态，不能把一次 tools/call 当同步结果用
TASK_TOOLS = ("generate_image", "director_run", "segment_run", "assemble_run")
# 本轮附件图要注入参考的工具：出图直接进 references，出片的参考集归配方拥有（segment_run /
# director_run 没有参考入参），所以出片侧只写本轮新建配方的 characters 与段 refs
REF_TOOLS = ("generate_image", "director_plan", "director_save")
# 焦点链：只收这些工具的成功终态——读类工具的返回值是候选集，不是本轮出过的东西
FOCUS_TOOLS = ("generate_image", "director_run", "segment_run", "assemble_run", "director_save")
FOCUS_MEDIA_MAX = 4       # 产物文件名只留最近几张：焦点每轮都要进系统提示词，逐轮灌长列表就是白烧 token
FOCUS_CLIP = 200          # 提示词与产物名来自 LLM 入参与工具载荷，逐字段裁长度再进系统提示词
FOCUS_LABELS = (("skill_id", "技能"), ("model", "主模型"), ("loras", "LoRA"),
                ("width", "宽"), ("height", "高"), ("seed", "种子"),
                ("recipe", "导演配方"), ("prompt", "提示词"),
                ("images", "产物图"), ("film", "成片"), ("task_id", "最近任务"))

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
# 用户级偏好：一台机器一份，落在数据根的 configs/agent_prefs.json——这个文件用户会自己在编辑器里
# 打开改，写盘走 .tmp 再 replace；代码里的 DEFAULT_PREFS 就是缺文件时的读入口，不往数据根落默认副本
AGENT_PREFS_FILE = CONFIGS_DIR / "agent_prefs.json"
# confirm_films 默认关：出片确认卡只在用户自己打开它时才拦——默认拦住整片会把「✨ 生成 → 出片」
# 这条今天就在跑的链路变成每次多点一下，而这一发的取舍本来就是用户开口要出片时给过的
DEFAULT_PREFS = {"preferred_skill": "", "preferred_size": "", "preferred_family": "",
                 "style_notes": "", "avoid": "", "confirm_films": False}
PREFS_TEXT_MAX = 400
PREFS_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")     # 技能 id 与模型家族名的形态
PREFS_SIZE_RE = re.compile(r"^\d{3,4}x\d{3,4}$|^\d{1,2}:\d{1,2}$")    # 1024x1024 或 16:9
# 计划模式不许执行的工具：生成入队、配方写、取消在跑的任务，全是改状态的动作
PLAN_BLOCKED_TOOLS = frozenset(("generate_image", "director_run", "segment_run", "assemble_run",
                                "director_save", "director_copy", "director_keyframes", "cancel_task"))
# 出片三类的产物是 mp4，快照 succeeded 后带 filename + 产物子目录，取图按它拼 /view
FILM_KINDS = ("director", "segment", "assemble")
CANCELLED_TEXT = "已取消：智能体循环与在跑的任务已停止"
PAUSE_TIMEOUT_TEXT = "已暂停后超时收场：在跑的任务已取消，这次运行结束"
SYSTEM_PROMPT_FILE = PLUGIN_DIR / "prompts" / "agent" / "system_prompt.md"
# 上下文预算：一次运行的全部 messages 逐轮整份进请求，provider 的窗口比这窄就是整请求 400。
# 估算口径是字符数 / 2：中文约一字一 token，英文约两字一 token，取一半是宁可估高
CONTEXT_BUDGET_TOKENS = 24000
CONTEXT_REPORT_FLOOR = CONTEXT_BUDGET_TOKENS // 4   # 到这一档起才发 context 帧：一轮纯问答的量级不值得逐轮报
COMPRESS_KEEP = 8         # 最近这么多条消息不压：本轮的工具结果与刚说过的话模型要接着用
COMPRESS_MARK = "[这段工具结果早于上下文预算，已从请求里压掉]"
IMAGE_TOKENS = 1000       # 附件图按定值计：base64 的字符数会把一条消息算成十万 token，压完整轮上下文就是被一张图带跑
MSG_OVERHEAD = 4          # OpenAI 一条消息的固定壳开销
# 出片级工具的量级确认卡：一次整片是三段 × 每段数分钟起步，跑下去再喊停就晚了一半
FILM_GATE_TOOLS = ("director_run", "segment_run", "assemble_run", "director_keyframes")
GATE_OPTIONS = ("✅ 跑这一发", "⏹ 先不跑")

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
FINISH_TOOL = {"type": "function", "function": {
    "name": "finish_task",
    "description": ("收场时调用，把交付物一次性交回来：做了什么与产物是什么（result）、"
                    "产物文件名（media，只能填本次运行真出现过的工具结果里的文件名）、"
                    "用户可以照着点的下一步方向（next_options）。不调这个工具直接写一段话也能收场，"
                    "但 media 与下一步只能靠这一份结构传下来。"),
    "parameters": {"type": "object", "properties": {
        "result": {"type": "string", "description": "两三句中文，说清做了什么、产物是什么"},
        "media": {"type": "array", "items": {"type": "string"},
                  "description": "产物文件名，逐字照抄工具结果里的 filename；没有产物就留空"},
        "next_options": {"type": "array", "items": {"type": "string"},
                         "description": "2-5 个用户可以照着点的下一步，写成能直接发出去的一句话"}},
        "required": ["result"]}}}
PLAN_TOOL = {"type": "function", "function": {
    "name": "write_plan",
    "description": ("计划模式收场前调用，把这份计划交成结构化清单：每步是 {tool, key_args, note}，"
                    "tool 必须是工具表里的真名，key_args 写关键参数（技能 id、段数、时长、尺寸、配方名），"
                    "note 一句话说明这一步要产出什么。用户切到执行模式后照着这份清单逐条跑。"),
    "parameters": {"type": "object", "properties": {
        "steps": {"type": "array", "items": {"type": "object", "properties": {
            "tool": {"type": "string", "description": "要调的工具名，照工具表里的真名写"},
            "key_args": {"type": "string", "description": "这一步的关键参数，一行写完"},
            "note": {"type": "string", "description": "这一步要产出什么"}}}},
        "required": ["steps"]}}}}

PLAN_MODE_NOTE = """

本轮是计划模式（Plan）：只查不跑。
- generate_image / director_run / segment_run / assemble_run / director_save / director_copy /
  director_keyframes / cancel_task 这一类改状态的工具本轮调不到，调用会被后端拒回错误。
- 要看现状就用查询类工具查清：neo_status、list_skills、list_models、list_recipes、
  director_recipes、director_spec、list_gallery。
- 方向上有分叉就用 ask_user 把问题与选项发给用户，等回答再定计划。
- 收场前调 write_plan 把计划交成结构化清单：分步骤写明每步要调的工具与关键参数（技能 id、段数、
  时长、尺寸、配方名），最后一步写明产物是什么。右栏会把它铺成一张执行清单，用户切到执行模式
  就照着这一份逐条跑，工具名写错了这一发会被拒回。
- 计划模式里不许说「已完成」，不许编造产物文件名，finish_task 也会被拒回——把要做的事写进计划，让用户切到执行模式再跑。"""



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

    落盘面（created / mode / frames / messages / focus / 终态）挂在同一个对象上，_events 收尾时整份
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
        # 素材库当前目录是否标了 👤 角色图：注入参考时决定新建配方走不走全参考（见 _apply_references）
        self.character_dir = False
        # 采样预览要的档（像素最长边，0 = 这一轮关掉采样预览）：没给请求体的调用方按右栏卡片那一档，见 _preview_of
        self.preview_side = AGENT_PREVIEW_SIDE
        self.resume_of = ""
        self.resume_from = 0      # 「从这条消息重新开始」的序号（历史里第几条用户消息，1 起），0 = 整条接上
        self.status = "running"
        self.frames: list[dict] = []
        self.messages: list[dict] = []
        # 焦点链：本轮会话最近一次生成的既定事实（技能 / 主模型 / 尺寸 / 种子 / 产物名）。
        # _focus_update 逐次覆盖，逐轮重注入系统提示词，随会话落盘供续聊恢复——不跨运行留全局状态
        self.focus: dict = {}
        # token 统计按 provider 每轮报的 usage 累加，随会话落盘进历史摘要：
        # 一轮 12 轮 × 长上下文跑到什么量级，用户要在右栏看见，不能只留在后端日志里
        self.usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "turns": 0}
        # 执行清单：计划模式 write_plan 写下的那一份，切到执行模式续聊时接回来逐条划掉
        self.plan_steps: list = []
        # 用户级偏好的快照（configs/agent_prefs.json 在请求开始时读一次）：一轮跑一半用户改了
        # 偏好不该影响正在跑的这一条循环
        self.prefs: dict = dict(DEFAULT_PREFS)
        # 输入框 @ 点名的技能：本轮指令，比偏好与焦点链都近。只认形态，认得到与否由循环里那次 list_skills 定
        self.user_skill = ""
        # 本次运行真出现过的产物：名字 → 产物项。finish_task 只认这份表里的名字
        self.media_urls: dict[str, dict] = {}

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


def _first_user_text(messages) -> str:
    for msg in messages or []:
        if isinstance(msg, dict) and msg.get("role") == "user":
            return str(msg.get("content") or "").strip()
    return ""


def _session_title(run) -> str:
    """会话标题 = 整条对话的第一句话，落盘就定下来：列表、读回、中间舞台的页眉认的是
    同一个字符串，续聊那条不会把「续一下」这种短句子顶成标题。接上的旧会话里存了 title
    就用它（链条一路往上带），老会话没这个字段就翻它落盘的第一条 user 消息。
    标题只用来认会话，不作为事实源，也不进续聊回填。"""
    if run.resume_of:
        parent = _load_session(run.resume_of)
        if parent:
            title = str(parent.get("title") or "").strip()
            if title:
                return _clip(title, 120)
            first = _first_user_text(parent.get("messages"))
            if first:
                return _clip(first, 120)
    return _clip(_first_user_text([{"role": "user", "content": run.text}]) or "（只给了附件图）", 120)


def _save_session(run) -> None:
    """一次运行的时间线与续聊原文落盘，原子写（.tmp 再 replace）。会话正文含用户提示词、
    本机路径与产物名，只落在数据根里：不进 Registry 包、不出本机。"""
    payload = {"version": 1, "run_id": run.run_id, "created": run.created,
               "updated": time.time(), "mode": run.mode, "status": run.status,
               "title": _session_title(run),
               "resume_of": run.resume_of, "resume_from": run.resume_from, "focus": run.focus,
               "usage": run.usage, "plan_steps": run.plan_steps,
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
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        out.append({"run_id": str(data.get("run_id") or ""), "created": data.get("created"),
                    "mode": data.get("mode"), "status": data.get("status"),
                    "resume_of": data.get("resume_of"),
                    # 焦点链里的技能：历史列表里认得出「这条会话最后是用哪个技能出的图」
                    "focus_skill": str((data.get("focus") or {}).get("skill_id") or ""),
                    "text": _clip(str(inp.get("text") or ""), 120),
                    # 会话标题：整条对话的第一句话，列表与读回认的是同一个字符串。
                    # 早于这个字段的老会话文件没有它，退回那次自己的首句
                    "title": _clip(str(data.get("title") or inp.get("text") or ""), 120),
                    "images": len(inp.get("images") or []),
                    # 这条会话烧掉多少 token：长上下文的会话在列表里就该看得出来
                    "tokens": int(usage.get("total_tokens") or 0),
                    "resume_from": int(data.get("resume_from") or 0),
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
# 用户级偏好：configs/agent_prefs.json，一台机器一份
# ---------------------------------------------------------------------------

def _clean_prefs(raw) -> dict:
    """偏好文件的读入口：缺字段回默认值，形态不对的字段丢回默认值。

    这个文件在用户自己的编辑器里打开着，一个 {"preferred_size": ["1024x1024"]} 不能把整轮
    系统提示词带炸；combo 与路径类值在这里按形态收口，照抄进来的越界字符串也在这一步裁掉。"""
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for key in ("preferred_skill", "preferred_family"):
        value = str(raw.get(key) or "").strip()
        out[key] = value if PREFS_NAME_RE.match(value) else ""
    size = str(raw.get("preferred_size") or "").strip()
    out["preferred_size"] = size if PREFS_SIZE_RE.match(size) else ""
    for key in ("style_notes", "avoid"):
        out[key] = _clip(str(raw.get(key) or "").strip(), PREFS_TEXT_MAX)
    out["confirm_films"] = bool(raw.get("confirm_films", DEFAULT_PREFS["confirm_films"]))
    return out


def _load_prefs() -> dict:
    """缺文件、半截文件都回代码里的默认值：不往数据根落一份默认副本，用户的偏好只在他改的时候才写盘。"""
    try:
        raw = json.loads(AGENT_PREFS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(DEFAULT_PREFS)
    return _clean_prefs(raw)


def _save_prefs(prefs) -> dict:
    """原子写（.tmp 再 replace）：用户开着编辑器时不会读到半截 JSON。返回落盘的那一份。"""
    clean = _clean_prefs(prefs)
    AGENT_PREFS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = AGENT_PREFS_FILE.with_name(AGENT_PREFS_FILE.name + ".tmp")
    tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, AGENT_PREFS_FILE)
    return clean


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


AGENT_PREVIEW_SIDE = 384      # 右栏卡片那一档，与 h3_preview.AGENT_PREVIEW_SIDE 同值：这里只比数值，不 import 那个模块


def _preview_side(value) -> int:
    """请求里界面要的采样预览最长边（像素）：中间舞台宽就要大档，右栏卡片按紧凑档，0 = 这一轮关掉采样预览。
    没给这个字段按右栏那一档（卡片就这么宽），负数按关掉处理。上限由 h3_preview 的档位定。"""
    try:
        side = int(value)
    except (TypeError, ValueError):
        return AGENT_PREVIEW_SIDE
    return max(0, side)


def _preview_of(tool: str, task_id: str, snap: str, side: int = AGENT_PREVIEW_SIDE):
    """右栏卡片用的预览载荷：进程内直读拥有那张表的模块，不走 HTTP。
    出片取本步的帧，按 side 选紧凑档（384）还是全尺寸档（1024）——中间舞台那一轮要的是大图；
    生图取进度 handler 捕获的最新一张。
    side 是 0（界面关掉采样预览）时连表都不读：2 秒一轮的 base64 帧灌进 SSE，没人看就是白烧带宽。
    这份载荷只进 SSE 给界面，绝不进 LLM 的文本——base64 进上下文就是整轮 token 爆炸。
    读不到就返回 None 继续轮询：h3_preview 模块级 import server / comfy.taesd.taesd / torch，
    离线服务与测试进程里没有这些模块，让它们把一次出片轮询打断是拿 UI 增强换交付。"""
    if side <= 0:
        return None
    try:
        if tool == "generate_image":
            pid = str(_json_of(snap).get("prompt_id") or "")
            if not pid:
                return None
            from .image_gen import _PREVIEWS
            url = _PREVIEWS.get(pid)
            return {"frames": [url]} if url else None
        from .h3_preview import get_latest_preview, preview_wants_small
        return get_latest_preview(task_id, small=preview_wants_small(side))
    except ImportError:
        return None


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
    素材库当前目录标了 👤 角色图时，新建配方照画廊 ⋯ 菜单同一条口径补上全参考模式。
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
        # 角色图目录的参考图不当首帧：画廊 ⋯ 菜单在这类目录建配方就是整批一段全参考，
        # 智能体新建的配方照同一口径补 shared.mode。图片参考只有显式 r2v 才进模板
        # （load_director_spec 缺显式模式时按首/尾帧推 i2v/fl2v，连图参考一起退成 t2v 丢掉），
        # 模型自己写了 mode（含 mixed）就照它的，不改他的值。
        if run.character_dir:
            shared = args.get("shared")
            shared = args["shared"] = shared if isinstance(shared, dict) else {}
            if not str(shared.get("mode") or "").strip():
                shared["mode"] = "r2v"


def _chat(messages: list, tools: list) -> dict:
    """LLM 单轮接缝：llm 是重依赖，函数内导入，测试替掉这个函数就能跑整条循环。"""
    from .llm import chat_turn
    return chat_turn(messages, max_tokens=MAX_TOKENS, tools=tools)


# ---------------------------------------------------------------------------
# 上下文预算：超了就从最旧的工具结果开始压
# ---------------------------------------------------------------------------

def _msg_tokens(msg: dict) -> int:
    """一条消息的粗略 token。字符数 / 2 对中文与英文都落在同一量级，宁可估高。

    附件图按 IMAGE_TOKENS 定值计：一条带图的 user 消息里是 base64，按字符数算会把一条消息
    记成十万 token，压缩就会从该留的地方下手。tool_calls 的参数同样在计费。"""
    content = msg.get("content")
    if isinstance(content, list):
        total = sum(IMAGE_TOKENS if (isinstance(part, dict) and part.get("type") == "image_url")
                    else len(str(part)) // 2 for part in content)
    else:
        total = len(str(content or "")) // 2
    for call in (msg.get("tool_calls") or []):
        total += len(json.dumps(call, ensure_ascii=False)) // 2
    return total + MSG_OVERHEAD


def _compress_messages(messages: list, budget: int = CONTEXT_BUDGET_TOKENS) -> int:
    """整份 messages 的 token 估计；超预算时从最旧的工具结果开始压成一行标记。

    只换 role="tool" 消息的 content，一条都不删：assistant 的 tool_calls 与 tool 消息的
    tool_call_id 是成对的，删一条 tool 就是整请求 400，比超预算更难查。
    系统提示词（焦点链、用户偏好、执行清单都在 messages[0] 里）与 user 消息不参与压缩。
    第一遍只动最近 COMPRESS_KEEP 条之外的那一段；压完还超才动第二遍（见下）。
    已压过的不再压第二次；压到预算内就停，压不动的剩余量由调用方在 context 帧里报出来。
    返回压完的估计值。"""
    total = sum(_msg_tokens(m) for m in messages)
    if total <= budget:
        return total
    keep_from = max(1, len(messages) - COMPRESS_KEEP)

    def compress(msg) -> int:
        """把一条工具结果压成标记，返回省下的估计值。"""
        nonlocal total
        if msg.get("role") != "tool":
            return 0
        content = str(msg.get("content") or "")
        if not content or content == COMPRESS_MARK:
            return 0
        saved = max(0, (len(content) - len(COMPRESS_MARK)) // 2)
        msg["content"] = COMPRESS_MARK
        total -= saved
        return saved

    for msg in messages[:keep_from]:
        if compress(msg) and total <= budget:
            return total
    # 最近那一段自己就能顶爆预算（一次 list_gallery 的全表）：压它，只留住最新的一条
    # ——那是模型下一步要照着调的参数来源
    newest_tool = max((i for i, m in enumerate(messages) if m.get("role") == "tool"), default=-1)
    for i in range(keep_from, len(messages)):
        if i != newest_tool and compress(messages[i]) and total <= budget:
            return total
    return total


# ---------------------------------------------------------------------------
# 执行清单与收场契约：右栏伪工具 write_plan / finish_task 的验收
# ---------------------------------------------------------------------------

def _plan_of(run, args: dict, mode: str) -> tuple[str, list]:
    """write_plan 的验收，返回 (拒回原文, 清单)。

    每步的 tool 必须是这次工具表里的真名：名字写错的一步在计划里就是一条跑不动的，
    用户切到执行模式照着跑会当场报错，那比少写一步更难查。"""
    if mode != "plan":
        return ("[error] write_plan 只在计划模式用：执行模式直接把事做完，收场用 finish_task", [])
    steps = args.get("steps")
    if not isinstance(steps, list) or not (1 <= len(steps) <= 12):
        return ("[error] write_plan 要 1-12 步的 steps：每步 {tool, key_args, note}，"
                "tool 用工具表里的真名", [])
    names = {str(t.get("name") or "") for t in run.client.tool_list()}
    out: list = []
    for st in steps:
        st = st if isinstance(st, dict) else {}
        tool = str(st.get("tool") or "").strip()
        if tool not in names:
            return (f"[error] write_plan 第 {len(out) + 1} 步的工具名不在工具表里：{tool or '（空）'}。"
                    "照工具表里的真名重写这份计划", [])
        out.append({"tool": tool,
                    "key_args": _clip(str(st.get("key_args") or "").strip(), 200),
                    "note": _clip(str(st.get("note") or "").strip(), 200),
                    "done": False})
    return "", out


def _plan_mark(run, name: str, result: str) -> bool:
    """执行模式里把清单上第一项同名工具划成已完成：右栏的 3/8 就是这么走起来的。

    只认成功交付——[error] 与任务终态非 succeeded 的那一发没产出东西，划上去就是报假进度。"""
    if not run.plan_steps or result.startswith("[error]"):
        return False
    if name in TASK_TOOLS and str(_json_of(result).get("status") or "").split(" ")[0] != "succeeded":
        return False
    for step in run.plan_steps:
        if step["tool"] == name and not step["done"]:
            step["done"] = True
            return True
    return False


def _plan_block(steps: list) -> str:
    """执行清单进系统提示词：计划模式写下的那一份计划在切到执行模式后还在，逐条照跑、跑完一条划掉一条。"""
    if not steps:
        return ""
    lines = []
    for i, step in enumerate(steps[:12]):
        line = f"- {i + 1}. {step.get('tool')}"
        if step.get("key_args"):
            line += f"（{_clip(step['key_args'], 200)}）"
        if step.get("note"):
            line += f"：{_clip(step['note'], 200)}"
        lines.append(line + ("　✅ 已完成" if step.get("done") else ""))
    return ("\n\n本轮照这份执行清单跑（用户刚从计划模式切过来，这是他自己认下的计划）：\n"
            + "\n".join(lines)
            + "\n按顺序逐条做，做完一条才做下一条；要改顺序或跳过某条就把理由讲给用户。"
              "清单跑完用 finish_task 收场，media 只报本次运行真出现过的产物名。")


def _finish_of(run, args: dict, mode: str) -> tuple[str, dict]:
    """finish_task 的验收，返回 (拒回原文, 收场载荷)。

    media 里的名字必须在本次运行的工具结果里真出现过：模型编一个文件名出来，右栏的播放与
    下载链接就是 404，用户点下去只拿到一句「文件不存在」——这一发比不交产物更坏。"""
    if mode == "plan":
        return ("[error] 计划模式不收场：把要做的事写进 write_plan 的计划，"
                "让用户切到执行模式再跑", {})
    result = str(args.get("result") or "").strip()
    if not result:
        return ("[error] finish_task 缺 result：把做了什么与产物是什么写清楚再收场", {})
    names = [str(n).strip() for n in (args.get("media") or []) if str(n).strip()][:8]
    fake = [n for n in names if n not in run.media_urls]
    if fake:
        seen = "、".join(sorted(list(run.media_urls)[:8])) or "（本次运行还没有产物）"
        return (f"[error] finish_task 的产物名在本次运行的工具结果里没有：{'、'.join(fake)}。"
                f"本次出现过的产物是 {seen}；只报这些名字，没有产物就把 media 留空", {})
    return "", {"result": _clip(result, RESULT_CLIP),
                "media": [run.media_urls[n] for n in names],
                "options": [_clip(str(o).strip(), 200) for o in (args.get("next_options") or [])
                            if str(o).strip()][:6]}


def _gate_cost(name: str, args: dict) -> str:
    """出片确认卡上的量级：段数 / 段号 / 时长 / 尺寸 / 配方名。

    字段全从 LLM 这一发的入参来，缺什么就不写什么——卡上报一个编出来的数，用户是照它决定
    跑不跑的，那比不给数更坏。"""
    bits = []
    segs = args.get("segments")
    if isinstance(segs, (list, tuple)) and segs:
        bits.append(f"{len(segs)} 段")
    if isinstance(args.get("segment"), int):
        bits.append(f"第 {int(args['segment'])} 段")
    for key, label in (("duration_sec", "秒/段"), ("seconds", "秒"),
                       ("frames", "帧"), ("fps", "fps")):
        value = args.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            bits.append(f"{label} {value}")
    width, height = args.get("width"), args.get("height")
    if isinstance(width, int) and isinstance(height, int):
        bits.append(f"{width}x{height}")
    recipe = str(args.get("recipe") or "").strip()
    if recipe:
        bits.append(_clip(recipe, 80))
    return " · ".join(bits) or "参数在配方里"


def _gate_refused(text: str) -> bool:
    """确认卡上的回答认挡不挡：选项是后端给的两句，认得出「先不跑」就挡下这一发。

    自由输入走同一集关键词。[timeout] 那句按「跑」走——用户 30 分钟没有回应时取舍已经交回循环：
    代价是用户离开电脑时这一发会照跑，换来的是循环不挂在确认卡上永不收场。"""
    line = str(text or "").strip()
    if not line or line.startswith("[timeout]"):
        return False
    return any(key in line for key in ("先不跑", "不出片", "别跑", "不跑", "取消"))


# ---------------------------------------------------------------------------
# 焦点链：本会话最近一次生成的既定事实
# ---------------------------------------------------------------------------

def _focus_update(run, name: str, args: dict, result: str) -> None:
    """一次生成工具的成功终态把技能 / 主模型 / 尺寸 / 种子 / 产物名写进焦点链：下一轮的系统
    提示词靠它把「上一张是怎么出的」立成本会话的事实。
    只收 FOCUS_TOOLS 的成功终态——failed / cancelled 的入参是试过的路，不是出过东西的配置，
    记进焦点就是拿一次失败污染整条会话；读类工具的返回是候选集，同样不算事实。
    工具载荷优先（它是后端真值），LLM 的入参只在载荷没给时兜底（generate_image 同步返回的
    快照没有宽高，主模型留空时后端自己挑的那一份只有载荷知道）。"""
    if name not in FOCUS_TOOLS:
        return
    data = _json_of(result)
    if name in TASK_TOOLS:
        if str(data.get("status") or "").split(" ")[0] != "succeeded":
            return
    elif data.get("success") is not True:      # director_save 是同步写：回执 success 才算事实
        return
    facts: dict = {}
    for key in ("skill_id", "model"):
        value = str(data.get(key) or args.get(key) or "").strip()
        if value:
            facts[key] = _clip(value, FOCUS_CLIP)
    for key in ("width", "height", "seed"):
        value = data.get(key)
        if value is None:
            value = args.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            facts[key] = int(value)
    if name == "director_save":
        recipe = str(data.get("name") or args.get("name") or "").strip()
    else:
        recipe = str(data.get("recipe") or args.get("recipe") or "").strip()
    if recipe:
        facts["recipe"] = _clip(recipe, FOCUS_CLIP)
    prompt = str(args.get("prompt") or "").strip()
    if prompt:
        facts["prompt"] = _clip(prompt, FOCUS_CLIP)
    loras = args.get("loras")
    if isinstance(loras, list):
        names = [_clip(str(l.get("name") if isinstance(l, dict) else l).strip(), FOCUS_CLIP)
                 for l in loras]
        names = [n for n in names if n]
        if names:
            facts["loras"] = names[:FOCUS_MEDIA_MAX]
    files = [_clip(str(im.get("filename") or ""), FOCUS_CLIP)
             for im in (data.get("images") or []) if isinstance(im, dict)]
    files = [f for f in files if f]
    if files:
        facts["images"] = files[:FOCUS_MEDIA_MAX]
    film = str(data.get("filename") or "").strip()
    if film:
        facts["film"] = _clip(film, FOCUS_CLIP)
    task_id = str(data.get("task_id") or "").strip()
    if task_id:
        facts["task_id"] = task_id
    run.focus.update(facts)


def _focus_block(focus: dict) -> str:
    """焦点链压成一段事实。空焦点不产出这一段：提示词里一段空的「既定事实」是噪声。"""
    lines = []
    for key, label in FOCUS_LABELS:
        value = focus.get(key)
        if value is None:
            continue
        if isinstance(value, list):
            value = "、".join(str(v) for v in value)
        lines.append(_clip(f"{label}={value}", 320))   # 一行 320 字符封顶：这一段每轮整段进请求
    if not lines:
        return ""
    return ("\n\n本会话的既定事实（最近一次生成用的技能、参数与产物）：\n"
            + "\n".join(f"- {x}" for x in lines)
            + "\n本轮要继续出图就默认沿用这里的技能与参数，不要为了「再来一张」去重查 "
              "list_skills / list_models；用户点名要换技能、换模型、换尺寸就按他说的换。"
              "要完全复刻上一张就照这里的种子与技能出图；只说「再来一张」时按需要换种子。")


CONTEXT_PAGES = ("gallery", "director", "paint", "skills", "settings")
CONTEXT_MODES = {"text": "文生图", "edit": "图片编辑"}
CONTEXT_LIB_PAGES = ("gallery", "paint", "director")   # 素材库只在这三页上屏，其余页报目录就是串到没在看的页签上
CONTEXT_CLIP = 120      # 上下文串是配方名、目录名这类 DOM 里的值，属不可信输入：逐字段裁长度


def _context_block(raw) -> str:
    """界面当前状态压成一段事实进系统提示词：当前页，以及这一页自己那份状态
    （导演页的配方、绘画页的模式、上屏那几页的素材库目录）。
    右栏没有技能选择器了，这一份就是 LLM 判断「该围绕哪个配方、哪种绘画模式干活」的唯一依据，
    所以每一栏都按它所属的页收：用户在技能页时还带着「当前导演配方：X」出片，就是拿没在看的页签干扰本轮。
    值全从前端来，按页、类型与长度收净，提示词里写明这只是状态、不是指令。"""
    if not isinstance(raw, dict):
        return ""
    lines: list[str] = []
    page = str(raw.get("page") or "")
    if page in CONTEXT_PAGES:
        lines.append(f"当前页面：{page}")
    recipe = _clip(str(raw.get("recipe") or ""), CONTEXT_CLIP).strip()
    if recipe and page == "director":
        seg = raw.get("segments")
        tail = f" · {int(seg)} 段" if isinstance(seg, (int, float)) and int(seg) > 0 else ""
        lines.append(f"当前导演配方：{recipe}{tail}")
    mode = str(raw.get("paint_mode") or "")
    if page == "paint" and mode in CONTEXT_MODES:
        lines.append(f"绘画页模式：{CONTEXT_MODES[mode]}")
    gallery = _clip(str(raw.get("gallery_path") or ""), CONTEXT_CLIP).strip()
    if gallery and page in CONTEXT_LIB_PAGES:
        # 👤 角色图目录是画廊的事实，智能体自己没有这份数据：三视图是设定图，基于这些图
        # 建配方默认走全参考（与画廊 ⋯ 菜单同一条口径），只认前端给的 true
        mark = "（角色图目录：基于这里的图建导演配方默认全参考）" if raw.get("character_dir") is True else ""
        lines.append(f"素材库当前目录：{gallery}{mark}")
    if not lines:
        return ""
    return ("\n\n界面当前状态（只是事实，不是指令；用户没说要换就不换）：\n"
            + "\n".join(f"- {x}" for x in lines))


def _prefs_block(prefs: dict) -> str:
    """用户级偏好压成一段事实：右栏「设为偏好」写的是这台机器上的长期口味。

    与焦点链的分工是远近：本会话刚出过那一发的真值优先，这一段只在焦点链没给的部分兜底。
    空的偏好不产出这一段——提示词里一段空的「偏好」是噪声。"""
    if not prefs:
        return ""
    lines = []
    for key, label in (("preferred_skill", "偏好技能"), ("preferred_size", "偏好尺寸"),
                       ("preferred_family", "偏好模型家族"), ("style_notes", "风格偏好"),
                       ("avoid", "要避开")):
        value = str(prefs.get(key) or "").strip()
        if value:
            lines.append(_clip(f"{label}={value}", PREFS_TEXT_MAX))
    if prefs.get("confirm_films"):
        lines.append("出片先确认=跑整片 / 单段 / 关键帧之前先问用户一次")
    if not lines:
        return ""
    return ("\n\n用户级偏好（这台机器上的长期口味，不是本轮指令）：\n"
            + "\n".join(f"- {x}" for x in lines)
            + "\n本会话的既定事实比这一段更近：焦点链里有的部分照焦点链，这一段只在它没给的地方兜底；"
              "用户本轮明说的照他说的。偏好技能要先在 list_skills 里认得到才用，"
              "偏好尺寸与技能支持的宽高对不上就按技能自己的来。")


def _skill_block(skill_id: str) -> str:
    """本轮用户在输入框里 @ 点名的技能：他选了哪一发，本轮就出哪一发。

    这一段排在偏好与焦点链之后——那两段是这台机器的长期口味和刚出过的那一发，这一段是用户明说的本轮
    指令。认不认得到这个技能由循环自己查 list_skills：技能目录不在本模块里，agent 只通过工具看得到技能，
    在这里 import skill.py 就是把两层焊在一起。空值不产出这一段。"""
    sid = str(skill_id or "").strip()
    if not sid:
        return ""
    return ("\n\n本轮用户点名的技能（他在输入框里用 @ 选的，比偏好与焦点链都近）：\n"
            f"- 技能={sid}\n"
            "本轮出图 / 出片默认就用这一个技能，宽高与步数照技能自己的默认；先在 list_skills 里认得到它"
            "就直接用，认不到（技能不存在、缺工作流、缺插件）就说清原因并照 list_skills 换一个、说明换了哪个，"
            "不要静默换。用户在正文里另点了别的技能时照他说的换。")


def system_prompt(mode: str = "act", context: str = "", focus: dict | None = None,
                  plan_steps: list | None = None, prefs: dict | None = None,
                  skill: str = "") -> str:
    """系统提示词 = 静态提示词 + 界面状态 + 焦点链 + 用户级偏好 + 本轮点名技能（+ 计划模式说明 + 执行清单）。
    焦点链与执行清单要在每次 LLM 请求前重算：本轮生成工具刚立的事实、清单上刚划掉的那一条
    都得在下一轮请求里可见（见 _run_agent）。执行清单只在执行模式进提示词——
    计划模式这一轮正在写它，还没有清单可照跑。"""
    try:
        text = SYSTEM_PROMPT_FILE.read_text(encoding="utf-8")
    except OSError as e:
        raise mcp.ToolError(f"缺少智能体系统提示词：{SYSTEM_PROMPT_FILE}（{e}）")
    text += context
    text += _focus_block(focus or {})
    text += _prefs_block(prefs or {})
    text += _skill_block(skill)
    if mode == "plan":
        text += PLAN_MODE_NOTE
    else:
        text += _plan_block(plan_steps or [])
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
    last_preview = None
    while True:
        snap = await asyncio.to_thread(client.call, "task_status", {"task_id": task_id})
        status = _status_of(snap)
        frame = {"kind": "status", "tool": "task_status", "task_id": task_id,
                 "text": status or "排队中…"}
        # 预览载荷只在推进时挂一次：2 秒一次的轮询原样重发同一批帧，SSE 就只是白灌 base64
        prev = _preview_of(tool, task_id, snap, run.preview_side)
        sig = None
        if prev and prev.get("frames"):
            sig = prev.get("step") if prev.get("step") is not None else prev["frames"][0]
            if sig == last_preview:
                sig = None
        if sig is not None:
            last_preview = sig
            frame["preview"] = prev
        await emit(frame)
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
    ask_user / finish_task / write_plan 是右栏的伪工具，不发 MCP：ask 帧挂起等用户点选，
    write_plan 在计划模式收场前把执行清单交下来，finish_task 在执行模式交收场载荷与产物名。
    history 是续聊带回来的旧会话原文（不含 system）：带它时这一轮接在那条会话后面跑，
    轮次预算是新一轮自己的 12 轮。
    每轮请求前压一次上下文（_compress_messages）；出片级工具在跑之前过一道量级确认卡
    （用户偏好里的 confirm_films）；provider 每轮报的 token 统计逐轮累进 run.usage。"""
    messages = [{"role": "system", "content": system_prompt(mode, context, run.focus,
                                                            run.plan_steps, run.prefs,
                                                            run.user_skill)}]
    messages += list(history or [])
    messages.append(_user_message(text, images or []))
    run.messages = messages       # 同一个 list 对象：循环里的 append 逐轮可见，半途收场也留得下
    tools = _openai_tools(client.tool_list(), plan=(mode == "plan")) + [ASK_TOOL]
    tools += [PLAN_TOOL] if mode == "plan" else [FINISH_TOOL]
    answered = False
    sent_tokens = -1
    for _ in range(MAX_TURNS):
        if run.stop.is_set():
            await emit({"kind": "content", "text": CANCELLED_TEXT})
            return
        if not await run.await_resume(emit):
            return
        # 焦点链、用户偏好与执行清单逐轮重注入：本轮刚立的事实与清单上刚划掉的一条要在这一轮
        # 的请求里可见，而 messages[0] 是循环开头按当时的状态写的
        messages[0]["content"] = system_prompt(mode, context, run.focus, run.plan_steps, run.prefs,
                                               run.user_skill)
        # 上下文在每一轮的边界上压：一次长会话里的技能全表与长工具返回是逐轮攒起来的，
        # 不压就是整请求 400，报错点在 provider 那一侧，比少一轮难查得多
        tokens = _compress_messages(messages)
        # 上下文帧只在量级开始有意义时报：一轮纯问答的上下文本来就在预算的四分之一以下，
        # 逐轮发一条「用了 8%」是噪声
        if tokens >= CONTEXT_REPORT_FLOOR and tokens != sent_tokens:
            sent_tokens = tokens
            await emit({"kind": "context", "approx_tokens": tokens,
                        "ratio": round(tokens / CONTEXT_BUDGET_TOKENS, 2)})
        msg = await asyncio.to_thread(_chat, messages, tools)
        # provider 每轮报的 token 统计累进运行对象：整条会话烧掉多少 token 要能在右栏看见，
        # 不能只留在后端日志里
        usage = msg.pop("usage", None)
        if isinstance(usage, dict):
            for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
                run.usage[key] += int(usage.get(key) or 0)
            run.usage["turns"] += 1
            await emit({"kind": "usage", **run.usage})
        content = str(msg.get("content") or "")
        calls = msg.get("tool_calls") or []
        finish = None       # 本轮的 finish_task 收场载荷：收下了就在这条 calls 之后退出双层循环
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
            elif name == "finish_task":
                result, finish = _finish_of(run, args, mode)
            elif name == "write_plan":
                result, steps = _plan_of(run, args, mode)
                if not result:
                    run.plan_steps = steps
                    result = json.dumps({"success": True, "steps": steps}, ensure_ascii=False)
            elif mode == "plan" and name in PLAN_BLOCKED_TOOLS:
                # 计划模式里模型仍可能硬调写操作：拒回原文它才会改口去写计划
                result = (f"[error] 计划模式不执行 {name}：把要做的事写进计划，"
                          f"让用户切到执行模式再跑")
            elif mode == "act" and name in FILM_GATE_TOOLS and run.prefs.get("confirm_films", False):
                # 一次整片是三段 × 每段数分钟起步：跑下去再喊停就晚了一半，先在卡上把量级报出来。
                # 确认要在入队之前——挡下之后才发任务就等于没挡
                answer = await run.await_answer(
                    emit, f"要跑 {name}（{_gate_cost(name, args)}），这一发是数分钟起步的量级，跑吗？",
                    list(GATE_OPTIONS))
                if _gate_refused(answer):
                    result = (f"[skipped] 用户选择这一发不跑（{name}）：把「用户挡下了这一发」写进结论，"
                              f"换一个更小的方向或把计划交回来，不要自己重发同一发")
                else:
                    result = await _tool_result(client, name, args, emit, run)
            else:
                result = await _tool_result(client, name, args, emit, run)
            media = _media_of(result)
            await emit({"kind": "tool_result", "tool": name,
                        "text": _clip(result, RESULT_CLIP), "media": media})
            for item in media:
                # 产物名与它的地址记在运行对象上：finish_task 只认这份表里真出现过的名字
                title = str(item.get("title") or "")
                if title:
                    run.media_urls[title] = item
            messages.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": result})
            before = json.dumps(run.focus, ensure_ascii=False, sort_keys=True)
            _focus_update(run, name, args, result)
            if json.dumps(run.focus, ensure_ascii=False, sort_keys=True) != before:
                # 焦点链交回界面：右栏的「设为偏好」照这一份填，用户不用自己抄技能名与尺寸
                await emit({"kind": "focus", "focus": run.focus})
            if name == "write_plan" and run.plan_steps:
                await emit({"kind": "plan_steps", "steps": run.plan_steps})
            elif _plan_mark(run, name, result):
                await emit({"kind": "plan_steps", "steps": run.plan_steps})
            if finish:
                await emit({"kind": "finish", "text": finish["result"],
                            "media": finish["media"], "options": finish["options"]})
                answered = True
                break
            if run.stop.is_set():
                await emit({"kind": "content", "text": CANCELLED_TEXT})
                return
        if finish:
            break
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
            # 预览载荷只给界面：base64 帧写进会话文件，一步就能把 SESSION_FILE_MAX 顶满
            run.frames.append({k: v for k, v in frame.items() if k != "preview"})
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
    """右栏智能体：一次请求，一路 SSE 时间线。body {text, mode, images, context, preview_side, resume, from, skill_id}。
    mode 只认 plan / act，其余按 act；images 是输入框附件图，按 prompts 的图片源口径给，
    act 模式下它们默认作为本轮生成的参考图（见 _apply_references）；
    context 是界面当前状态（当前页 / 当前导演配方 / 绘画页模式 / 素材库目录与它的角色图标记），值从前端 DOM 来；
    preview_side 是界面这一轮要的采样预览最长边（像素）：中间舞台那块宽，挂着时前端要 1024 那一档，
    栏子那档是 384，前端关掉采样预览时给 0（后端不读预览表、不挂载荷），不给字段按 384；
    resume 是「继续这次会话」要接的那条旧会话的 run_id，带它时旧对话原文与那条会话的焦点链
    （上一次生成的技能 / 参数 / 产物）一起接在系统提示词之后，那条会话在计划模式交出的执行清单
    也在执行模式下接回来照跑；
    from 是「从这条消息重新开始」：连着 resume 给，取那条会话里第 N 条用户消息（1 起），
    那一条与它之后的原文整段丢掉，本轮的输入从那个点重新长出去；
    skill_id 是输入框 @ 点名的技能：本轮出图 / 出片默认用它，排在偏好与焦点链之后（见 _skill_block）。"""
    try:
        body = await request.json()
    except Exception:
        return _error_response("请求不是合法 JSON")
    body = body or {}
    text = str(body.get("text") or "").strip()
    mode = str(body.get("mode") or "act").strip()
    if mode not in ("plan", "act"):
        mode = "act"
    raw_ctx = body.get("context")
    context = _context_block(raw_ctx)
    images = await asyncio.to_thread(_resolve_images, body.get("images") or [])
    if not text:
        # 只给图不给字是合法输入（看图说话），补一句要什么，别让 LLM 对着图无话可说
        text = "（没有文字说明）看这张附件图，说清你能拿它做什么，并给出建议的下一步" if images else ""
    if not text:
        return _error_response("没有输入内容")
    resume = str(body.get("resume") or "").strip()
    raw_from = body.get("from")
    resume_from = 0
    history: list = []
    record: dict | None = None
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
        if raw_from is not None:
            # 序号数的是那条会话里的第几条用户消息（界面上就照这个序号铺按钮），内部换成消息位置
            try:
                resume_from = int(raw_from)
            except (TypeError, ValueError):
                return _error_response("from 要是一个序号（整数）")
            marks = [i for i, m in enumerate(history) if str(m.get("role") or "") == "user"]
            if not (1 <= resume_from <= len(marks)):
                return _error_response(f"from 的序号超出这条会话的用户消息数（1-{len(marks)}）")
            history = history[:marks[resume_from - 1]]
    elif raw_from is not None:
        return _error_response("from 要连着 resume 一起给")
    run = _Run(McpClient(comfy_base(request)))
    run.mode, run.text, run.context = mode, text, context
    run.character_dir = isinstance(raw_ctx, dict) and raw_ctx.get("character_dir") is True
    run.preview_side = _preview_side(body.get("preview_side"))
    run.resume_of, run.resume_from = resume, resume_from
    # 偏好是请求开始时读的一次快照：一轮跑一半用户改了偏好，不该影响正在跑的这条循环
    run.prefs = await asyncio.to_thread(_load_prefs)
    # skill_id 是输入框 @ 点名的技能（右栏只给形态合法的技能名）：与偏好里的 preferred_skill 同一档校验，
    # 认不认得到这个技能不在这里判——技能目录在 skill.py 那一层，循环里那次 list_skills 才是认得到的地方
    raw_skill = str(body.get("skill_id") or "").strip()
    run.user_skill = raw_skill if PREFS_NAME_RE.match(raw_skill) else ""
    if record is not None:
        saved_focus = record.get("focus")
        if isinstance(saved_focus, dict) and not resume_from:
            # 从中间某条消息重开时不接焦点链：那条会话后半段刚出过的那一发在截断点之后，
            # 把它当本轮的既定事实就是报一个本轮没做过的事
            run.focus = dict(saved_focus)
        saved_plan = record.get("plan_steps")
        if mode == "act" and isinstance(saved_plan, list):
            # 计划模式交出的那份清单在切到执行模式后接着照跑，跑完一条划掉一条
            run.plan_steps = [dict(step) for step in saved_plan
                              if isinstance(step, dict) and step.get("tool")][:12]
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
    """「🗂 历史」的列表：新的在前，只回摘要（时间 / 模式 / 终态 / 标题 / 工具数），
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


@routes.get("/neo_agent/prefs")
async def agent_prefs_get(request):
    """右栏「偏好」表单的当前值：纯文件读，桌面端服务没 ComfyUI 也在。缺文件回代码里的默认值。"""
    return web.json_response(_json_safe({"ok": True, "prefs": await asyncio.to_thread(_load_prefs)}))


@routes.post("/neo_agent/prefs")
async def agent_prefs_save(request):
    """存用户级偏好：逐字段按形态收净再原子写（见 _clean_prefs）。
    越界的 combo 值与长文本在这一步挡掉，落盘的只有收净的那一份。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求不是合法 JSON"}, status=400)
    prefs = await asyncio.to_thread(_save_prefs, body if isinstance(body, dict) else {})
    return web.json_response(_json_safe({"ok": True, "prefs": prefs}))
