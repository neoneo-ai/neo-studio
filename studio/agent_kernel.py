# SPDX-License-Identifier: Apache-2.0
"""可选的 dsh 内核桥：把一次右栏运行交给外部 dsh 进程跑，帧照右栏那一套发。

默认后端仍是 agent.py 里的循环。这里只在三件事齐了才接手——`agent_backend=dsh`、指了 dsh 入口
（偏好 `dsh_bin` 或环境变量 `NEO_DSH_BIN`）、本机能起 node；缺一样就由 agent.py 回退循环，
本模块只回答「能不能用、为什么不能」（`unavailable()`），不替调用方做决定。

闸与收场不在这里：MCP 子进程带着 `NEO_AGENT_RUN` 起来，`ask_user` / `finish_task` 打进
`/neo_agent/ask` 等路由，落回循环那一份实现。桥只做三件事——拼 argv、把 dsh 的事件翻成右栏的帧、
把产物名记进运行对象（`finish_task` 只认这份表）。

能力边界写在这里，是因为它们决定回退，不是实现细节：
- 只接执行模式：计划模式的工具过滤与清单在循环里，dsh 侧没有对应物；
- 不接附件图与续聊原文：这棵树的 prompt 只传文本，接了图会静默丢掉；
- 暂停不生效：桥在两次事件之间才看得见 `run.stop`，暂停面留空。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from collections import deque
from pathlib import Path

from .plugin_paths import DSH_HOME_DIR, PLUGIN_DIR

PATCH_TEMPLATE = PLUGIN_DIR / "dsh_profile.patch.yml"
PROMPT_MARKER = "__NEO_SYSTEM_PROMPT__"
PROFILE = "sdk-minimal"
PROVIDER = "deepseek-official"
MODEL_ENV = "DSH_MODEL"
BIN_ENV = "NEO_DSH_BIN"
KEY_ENV = "DEEPSEEK_API_KEY"
INIT_TIMEOUT = 60.0
WAIT_SEC = 3600.0        # 一发内核的上限：整片串行是段乘数分钟，比循环的 2400 秒再放一档
POLL_SEC = 1.0           # 两次事件之间看一眼取消位：取消的延迟就压在这一档


def unavailable(prefs: dict) -> str:
    """不能用的原因，空串表示能用。回退决策、状态路由与日志都照这一句。"""
    if not shutil.which("node"):
        return "本机没有 node：dsh 要 Node 22.18 以上"
    path = _bin_of(prefs)
    if not path:
        return f"没有指定 dsh 入口（偏好 dsh_bin 或环境变量 {BIN_ENV}）"
    if not Path(path).is_file():
        return f"dsh 入口不存在：{path}"
    if not os.environ.get(KEY_ENV, "").strip():
        return f"没有 {KEY_ENV}：sdk-minimal 这棵树只有 DeepSeek 的 API-key adapter"
    if not PATCH_TEMPLATE.is_file():
        return f"缺 profile 叠加层模板：{PATCH_TEMPLATE}"
    return ""


def _bin_of(prefs: dict) -> str:
    return str((prefs or {}).get("dsh_bin") or os.environ.get(BIN_ENV, "")).strip()


def _workspace() -> Path:
    """dsh 的工作目录：装在数据根里，既不进插件目录也不落用户家目录。"""
    path = DSH_HOME_DIR / "workspace"
    path.mkdir(parents=True, exist_ok=True)
    return path


def render_patch(persona: str, dest: Path) -> None:
    """把模板的占位行换成这一次的系统提示词。

    `!!js` 是 new Function，dsh 是 ESM 包，函数体里没有 require（实测落兜底句），所以正文只能
    在起进程前内联进 patch；行首统一加 6 空格，正文自身的缩进保持相对不变。"""
    out: list[str] = []
    for line in PATCH_TEMPLATE.read_text(encoding="utf-8").splitlines():
        if line.strip() != PROMPT_MARKER:
            out.append(line)
            continue
        for item in persona.splitlines():
            out.append("      " + item.rstrip() if item.strip() else "")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text("\n".join(out) + "\n", encoding="utf-8")


def _argv(prefs: dict, patch: Path) -> list[str]:
    return [str(shutil.which("node")), _bin_of(prefs), "--profile", PROFILE, "--patch", str(patch)]



async def _send(proc, payload: dict) -> None:
    proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
    await proc.stdin.drain()


async def _next_msg(proc):
    """读一条消息：字典是消息、None 是这一秒没新行（好让调用方看一眼取消位）、False 是进程走了。"""
    try:
        raw = await asyncio.wait_for(proc.stdout.readline(), timeout=POLL_SEC)
    except asyncio.TimeoutError:
        return None
    if not raw:
        return False
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        return None
    try:
        msg = json.loads(text)
    except ValueError:
        return None
    return msg if isinstance(msg, dict) else None


async def _wait_response(proc, want: str, timeout: float) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError(f"dsh 在 {int(timeout)} 秒内没有回应（profile 行与服务行是否齐）")
        msg = await _next_msg(proc)
        if msg is False:
            raise RuntimeError("dsh 进程提前退出：入口、profile 或 DSH_HOME 不可用")
        if msg is None:
            continue
        if str(msg.get("id")) == want:
            if msg.get("error"):
                raise RuntimeError(str((msg["error"] or {}).get("message") or "dsh 报错"))
            return


def _text_of(data: dict) -> str:
    message = data.get("message") if isinstance(data.get("message"), dict) else {}
    blocks = message.get("content") if isinstance(message.get("content"), list) else []
    return "".join(str(b.get("text") or "") for b in blocks if isinstance(b, dict))


def _args_of(block: dict) -> dict:
    raw = block.get("arguments")
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(str(raw or ""))
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


async def _usage(run, data: dict, emit) -> None:
    """逐轮 token 照 provider 报的累进：右栏那一栏读的是这几个键。"""
    block = next((data[k] for k in ("usage", "tokenUsage", "tokens")
                  if isinstance(data.get(k), dict)), {})
    prompt = int(block.get("inputTokens") or block.get("prompt_tokens") or 0)
    done = int(block.get("outputTokens") or block.get("completion_tokens") or 0)
    if not (prompt or done):
        return
    run.usage["prompt_tokens"] += prompt
    run.usage["completion_tokens"] += done
    run.usage["total_tokens"] += int(block.get("totalTokens") or block.get("total_tokens")
                                     or prompt + done)
    run.usage["turns"] += 1
    await emit({"kind": "usage", **run.usage})


async def _event(run, emit, event, calls: dict, loop) -> None:
    """一条 dsh 事件翻成右栏的帧。工具名在 assistant/message 的 tool-call 块里，
    tool/result 只带 callId，所以名字要从 calls 这张表回查。"""
    event = event if isinstance(event, dict) else {}
    etype = str(event.get("type") or "")
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    if etype == "assistant/message":
        message = data.get("message") if isinstance(data.get("message"), dict) else {}
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            kind = str(block.get("type") or "")
            if kind == "tool-call":
                name = str(block.get("name") or "")
                calls[str(block.get("id") or "")] = (name, _args_of(block))
                await emit({"kind": "tool_call", "tool": name,
                            "text": str(block.get("arguments") or "")})
            elif kind == "text" and block.get("text"):
                await emit({"kind": "content", "text": str(block["text"])})
        await _usage(run, data, emit)
    elif etype == "tool/call":
        # 名字与参数的权威来源：tool/result 只带 callId，assistant/message 的块 id 与它不一定同号
        calls[str(data.get("callId") or "")] = (str(data.get("name") or ""), _args_of(data))
    elif etype == "tool/result":
        message = data.get("message") if isinstance(data.get("message"), dict) else {}
        # callId 在 message 里（顶层没有）：实测 tool/result 的顶层是 {turn, step, message}
        call_id = str(message.get("toolCallId") or data.get("toolCallId") or "")
        name, args = calls.get(call_id, ("", {}))
        result = _text_of(data)
        media = loop._media_of(result)
        for item in media:
            title = str(item.get("title") or "")
            if title:
                # finish_task 只认这份表里的名字：桥不记账，收场那一发就会把自己的产物拒掉
                run.media_urls[title] = item
        if name:
            loop._focus_update(run, name, args, result)
        await emit({"kind": "tool_result", "tool": name,
                    "text": loop._clip(result, loop.RESULT_CLIP), "media": media})


async def _pump(run, emit, proc, loop) -> None:
    deadline = asyncio.get_running_loop().time() + WAIT_SEC
    calls: dict = {}
    while True:
        if run.stop.is_set():
            run.reason = "cancelled"
            await emit({"kind": "content", "text": loop.CANCELLED_TEXT})
            return
        if asyncio.get_running_loop().time() >= deadline:
            run.reason = "kernel_timeout"
            await emit({"kind": "content", "text": "内核跑了一小时还没有收场：把需求拆小再试。"})
            return
        msg = await _next_msg(proc)
        if msg is False:
            run.reason = "kernel_exit"
            return
        if msg is None:
            continue
        method = str(msg.get("method") or "")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        if str(params.get("sessionId") or run.run_id) != run.run_id:
            continue
        if method == "session.status" and params.get("status") == "idle":
            if not run.reason:
                # finish_task 那条路由成功收场时自己写了 finish；走到这里说明模型直接给了回答
                run.reason = "answer"
            return
        if method == "session.event":
            await _event(run, emit, params.get("event"), calls, loop)


def _env(run) -> dict:
    """子进程环境：密钥只在这里传，不落任何文件；run_id 就是闸与收场的绑定。"""
    env = dict(os.environ)
    env.update({
        "DSH_HOME": str(DSH_HOME_DIR),
        "NEO_AGENT_RUN": run.run_id,
        "NEO_PYTHON": sys.executable,
        "NEO_MCP_SERVER": str(PLUGIN_DIR / "mcp_server.py"),
        "NEO_DSH_WORKSPACE": str(_workspace()),
    })
    base = getattr(getattr(getattr(run.client, "ctx", None), "comfy", None), "base", "")
    if base:
        env["NEO_MCP_COMFY_URL"] = str(base)
    return env


async def _stop(proc) -> None:
    """收进程：先关 stdin 让它自己收场，3 秒不走就 terminate，再不走 kill。"""
    try:
        proc.stdin.close()
    except (OSError, RuntimeError):
        pass
    for nudge in (None, proc.terminate, proc.kill):
        if nudge is not None:
            nudge()
        try:
            await asyncio.wait_for(proc.wait(), timeout=3.0)
            return
        except asyncio.TimeoutError:
            continue


async def run(run, text: str, emit, mode: str = "act") -> None:
    """跑一发：起 dsh、交提示词、翻事件，直到 idle、取消或超时。

    系统提示词按循环那一份现算（mode / 上下文 / 焦点链 / 偏好 / 点名技能都在里面），
    内联进这一次的 patch —— dsh 侧的 personaPrefix 就是它，不另写第二份提示词。"""
    from . import agent as loop

    persona = loop.system_prompt(mode, run.context, run.focus, run.plan_steps, run.prefs,
                                 run.user_skill, run.user_skill_info, len(run.image_refs))
    patch = DSH_HOME_DIR / f"patch-{run.run_id}.yml"
    render_patch(persona, patch)
    proc = await asyncio.create_subprocess_exec(
        *_argv(run.prefs, patch), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=str(_workspace()), env=_env(run))
    errors: deque = deque(maxlen=20)

    async def drain():
        async for raw in proc.stderr:
            errors.append(raw.decode("utf-8", "replace").rstrip())

    asyncio.ensure_future(drain())
    try:
        await _send(proc, {"jsonrpc": "2.0", "id": "1", "method": "initialize",
                           "params": {"cwd": str(_workspace()), "provider": PROVIDER,
                                      "model": os.environ.get(MODEL_ENV, "deepseek-chat")}})
        await _wait_response(proc, "1", INIT_TIMEOUT)
        await _send(proc, {"jsonrpc": "2.0", "id": "2", "method": "session/prompt",
                           "params": {"sessionId": run.run_id,
                                      "contentBlocks": [{"type": "text", "text": text}]}})
        await _pump(run, emit, proc, loop)
    except (TimeoutError, RuntimeError, OSError) as exc:
        run.reason = "kernel_error"
        detail = "；".join(list(errors)[-3:])
        await emit({"kind": "content", "text": f"内核失败：{exc}" + (f"（{detail}）" if detail else "")})
    finally:
        await _stop(proc)
