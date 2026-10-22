#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""dsh 内核探针：标准库 JSON-RPC 客户端驱动 dsh --profile sdk-minimal 跑我们这套 MCP 工具。

dev-only：不进 Registry 包，不进任何依赖清单。要量的就四件事——事件词表长什么样、逐轮 token
怎么走、出片闸在协议里落在哪一条反向请求上、MCP 桥的超时与体积上限撞在哪一发任务。

方法词汇照 deepseek-harness-sdk 0.2.1rc2 的 client.py：initialize / session/prompt /
session/resume / session/working_directory/get|set / shutdown。推送侧两条：session.event 带一条
会话事件，session.status 的 status=idle 就是这一发跑完。
不装 deepseek-harness-sdk：它的运行时 wheel 首次使用要从 GitHub Releases 与 npm 拉资源，
探针只要 npm 装出来的 dsh 与 Node。

Usage:
  python dsh_host.py --dsh-bin <dsh.cmd> --task "..." [--session-id spike-1] [--out a.json] -v
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from collections import Counter, deque
from pathlib import Path
from queue import Empty, Queue

REPO = Path(__file__).resolve().parents[2]
PATCH_FILE = REPO / "tools" / "dsh_probe" / "neo-studio.patch.yml"
MCP_SERVER = REPO / "studio" / "mcp_server.py"
SYSTEM_PROMPT = REPO / "studio" / "prompts" / "agent" / "system_prompt.md"
DSH_JS = REPO / "tools" / "dsh_probe" / "npm" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
PROMPT_MARKER = "__NEO_SYSTEM_PROMPT__"
USAGE_KEYS = ("promptTokens", "completionTokens", "totalTokens", "prompt_tokens",
              "completion_tokens", "total_tokens", "inputTokens", "outputTokens")

# Windows 控制台默认 GBK，dsh 日志里的非 GBK 字符会把打印打崩（实测 UnicodeEncodeError）
for _stream in (sys.stdout, sys.stderr):
    _stream.reconfigure(encoding="utf-8", errors="replace")



def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def shrink(obj, cap: int = 1200) -> str:
    text = json.dumps(obj, ensure_ascii=False)
    return text if len(text) <= cap else text[:cap] + "..."


class Host:
    """dsh 的 stdio 客户端：一条读线程把响应、推送、反向请求分开收。"""

    def __init__(self, argv: list, home: Path, workspace: Path, profile_env: dict):
        env = os.environ.copy()
        env.update(profile_env)
        # DSH_HOME 必须显式：SDK 侧从不隐式用 ~/.dsh，探针跟同一条口径，不落到用户家目录
        env["DSH_HOME"] = str(home)
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                     errors="replace", cwd=str(workspace), env=env, bufsize=1)
        # errors=replace 是必须的：strict 解码会让读线程在一条非 UTF-8 行上死掉，
        # dsh 的日志就此全丢（实测 UnicodeDecodeError 杀线程，initialize 跟着超时）

        self.stderr_tail: list[str] = []
        self.responses: dict[str, Queue] = {}
        self.notifications: Queue = Queue()
        self.inbound: Queue = Queue()
        self._ids = 0
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                # stdout 混进非协议行会打断 JSON-RPC 成帧（上游 README 专门点过这条）：
                # 当数据记下来，别让一条 banner 把探针卡死
                self.notifications.put({"method": "__raw_stdout__", "params": {"line": line[:400]}})
                continue
            if not isinstance(msg, dict):
                continue
            mid = msg.get("id")
            if mid is not None and "method" in msg:
                self.inbound.put(msg)
            elif mid is not None:
                self.responses.setdefault(str(mid), Queue()).put(msg)
            else:
                self.notifications.put(msg)

    def _read_stderr(self) -> None:
        for line in self.proc.stderr:
            self.stderr_tail.append(line.rstrip())
            if len(self.stderr_tail) > 200:
                self.stderr_tail.pop(0)

    def send(self, payload: dict) -> None:
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params, timeout: float = 60.0) -> dict:
        self._ids += 1
        mid = str(self._ids)
        box = self.responses.setdefault(mid, Queue())
        frame = {"jsonrpc": "2.0", "id": mid, "method": method}
        if params is not None:
            frame["params"] = params
        self.send(frame)
        try:
            msg = box.get(timeout=timeout)
        except Empty:
            raise TimeoutError(method + " 在 " + str(timeout) + "s 内没有回应：profile 里有没有 JSON-RPC "
                               "服务行、dsh 版本、DSH_HOME 是否可写")
        self.responses.pop(mid, None)
        if "error" in msg:
            err = msg["error"] if isinstance(msg["error"], dict) else {}
            raise RuntimeError(method + " 报错：" + str(err.get("message")) + " " + shrink(err.get("data"), 300))
        return msg.get("result") if isinstance(msg.get("result"), dict) else {}

    def drain_inbound(self) -> list:
        """反向请求逐条记下来并回空结果：出片闸与 ask_user 在协议里落在哪条方法上，就是这条量出来的。"""
        seen = []
        while True:
            try:
                msg = self.inbound.get_nowait()
            except Empty:
                return seen
            seen.append({"method": str(msg.get("method") or ""),
                         "params": shrink(msg.get("params") or {}, 900)})
            self.send({"jsonrpc": "2.0", "id": msg.get("id"), "result": {}})

    def close(self) -> None:
        """关线程不留孤儿：先给它一次 shutdown 落盘的机会，再 terminate，最后 kill。"""
        try:
            self.request("shutdown", None, timeout=3.0)
        except (TimeoutError, RuntimeError, OSError, ValueError) as exc:
            self.stderr_tail.append("shutdown 请求没走通：" + str(exc))
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        for _ in range(20):
            if self.proc.poll() is not None:
                return
            time.sleep(0.15)
        self.proc.terminate()
        for _ in range(20):
            if self.proc.poll() is not None:
                return
            time.sleep(0.15)
        self.proc.kill()
        self.proc.wait()


def summarize(events: list) -> dict:
    """事件词表、逐轮 token、工具面与收场原因：这四样是桥接层的翻译表要照写的东西。

    载荷形状实测：tool/call 的名字在顶层；tool/result 的正文在 message.content[]；
    成功收场是 turn/end 的 reason.kind=completed，失败收场在 assistant/attempt 的
    stream[].chunk{type:finish,reason}；assistant/message 的正文在 message.content[] 的
    type=text 块里，reasoning 与 tool-call 块另算。
    """
    types: Counter = Counter()
    tools: Counter = Counter()
    usage: list = []
    texts: list = []
    finish: list = []
    results: list = []
    for ev in events:
        etype = str(ev.get("type") or "")
        types[etype] += 1
        data = ev.get("data") if isinstance(ev.get("data"), dict) else {}
        if etype == "tool/call":
            tools[str(data.get("name") or "")] += 1
        if etype == "tool/result":
            msg = data.get("message") if isinstance(data.get("message"), dict) else {}
            blocks = msg.get("content") if isinstance(msg.get("content"), list) else []
            chars = sum(len(str(b.get("text") or "")) for b in blocks if isinstance(b, dict))
            # isError 在 message 里、内核级失败（UNKNOWN_TOOL 这类）在顶层 error 上，
            # 只看顶层 isError 会把每一次失败的工具调用记成成功
            failed = bool(data.get("isError") or data.get("error") or msg.get("isError"))
            results.append({"chars": chars, "is_error": failed})
        for key in ("usage", "tokenUsage", "tokens"):
            block = data.get(key)
            if isinstance(block, dict):
                row = {k: v for k, v in block.items() if isinstance(v, (int, float))}
                if any(k in row for k in USAGE_KEYS):
                    usage.append(dict({"source": etype}, **row))
        if etype == "turn/end":
            finish.append({"at": "turn/end", "reason": shrink(data.get("reason") or {}, 300)})
        if etype == "assistant/attempt":
            for entry in data.get("stream") or []:
                if not isinstance(entry, dict):
                    continue
                inner = entry.get("chunk") if isinstance(entry.get("chunk"), dict) else entry
                if inner.get("type") == "finish":
                    finish.append({"at": "assistant/attempt",
                                   "reason": shrink(inner.get("reason") or {}, 500)})
        if etype == "assistant/message":
            msg = data.get("message") if isinstance(data.get("message"), dict) else {}
            for block in msg.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                    texts.append({"type": etype, "chars": len(str(block["text"])),
                                  "head": str(block["text"])[:220]})
    chars = [int(r["chars"]) for r in results]
    return {"event_count": len(events), "event_types": dict(types), "tool_calls": dict(tools),
            "tool_results": {"n": len(results), "max_chars": max(chars) if chars else 0,
                             "total_chars": sum(chars), "errors": sum(1 for r in results if r["is_error"])},
            "usage": usage, "finish": finish, "tail_messages": texts[-6:]}



def turn(host: Host, session_id: str, text: str, timeout: float, verbose: bool) -> dict:
    """一发任务：prompt 交进去，收推送收到 session.status=idle，反向请求全程记录。"""
    start = time.time()
    res = host.request("session/prompt",
                       {"sessionId": session_id, "contentBlocks": [{"type": "text", "text": text}]},
                       timeout=60.0)
    events: list = []
    frames: deque = deque(maxlen=500)
    head: list = []
    frames_total = 0
    inbound: list = []
    tool_names: list = []
    idle = False

    def keep(record: dict) -> None:
        """报告不是流水账：只留开头 20 条加最近 480 条。轮询风暴那一发是 3943 帧、1.9MB，
        全留就没法用编辑器打开。"""
        nonlocal frames_total
        frames.append(record)
        frames_total += 1
        if len(head) < 20:
            head.append(record)
    while time.time() - start < timeout:
        inbound += host.drain_inbound()
        try:
            frame = host.notifications.get(timeout=1.0)
        except Empty:
            continue
        method = str(frame.get("method") or "")
        params = frame.get("params") if isinstance(frame.get("params"), dict) else {}
        if str(params.get("sessionId") or "") not in ("", session_id):
            continue
        event = params.get("event") if isinstance(params.get("event"), dict) else None
        etype = str((event or {}).get("type") or "")
        data = (event or {}).get("data") or params
        if etype == "request/header" and isinstance(data, dict):
            # 工具表在 request/header 里给出：MCP 桥有没有把我们的 21 个工具挂进模型可见
            # 的工具集，只有这一条量得出来（名字形如 mcp__neo__generate_image）
            header = data.get("header") if isinstance(data.get("header"), dict) else {}
            tool_names = [str(t.get("name") or "") for t in header.get("tools") or [] if isinstance(t, dict)]
        if event is not None:
            events.append(event)
        record = {"method": method, "type": etype,
                  "data": shrink(data, 6000 if etype == "request/header" else 700),
                  "sec": round(time.time() - start, 2)}
        if verbose:
            log("  +" + str(record["sec"]) + "s " + method + " " + etype + " "
                + str(record["data"])[:150])
        if method == "session.status" and params.get("status") == "idle":
            idle = True
            keep(record)
            break
        keep(record)
    inbound += host.drain_inbound()
    kept = head + [f for f in frames if all(f is not h for h in head)]
    return dict({"session_id": session_id, "message_id": str(res.get("messageId") or ""),
                 "idle": idle, "cut_by_timeout": not idle, "seconds": round(time.time() - start, 2),
                 "frames_total": frames_total, "frames": kept, "inbound_requests": inbound,
                 "tool_surface": tool_names,
                 "mcp_tool_names": [n for n in tool_names if n.startswith("mcp__")]},
                **summarize(events))



def render_patch(dest: Path) -> bool:
    """把模板的 __NEO_SYSTEM_PROMPT__ 行换成那份正文：!!js 是 new Function，函数体里没有
    require，19KB 正文只能内联进 patch。行首统一加 6 空格，正文自身的缩进保持相对不变。"""
    body = SYSTEM_PROMPT.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    for line in PATCH_FILE.read_text(encoding="utf-8").splitlines():
        if line.strip() != PROMPT_MARKER:
            out.append(line)
            continue
        for item in body:
            out.append("      " + item.rstrip() if item.strip() else "")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text("\n".join(out) + "\n", encoding="utf-8")
    return PROMPT_MARKER not in out


def main() -> int:
    ap = argparse.ArgumentParser(prog="dsh_host", description="dsh 内核探针（标准库 stdio 客户端）")
    ap.add_argument("--node", default="node")
    ap.add_argument("--dsh-js", default=str(DSH_JS))
    ap.add_argument("--task", required=True)
    ap.add_argument("--session-id", default="")
    ap.add_argument("--home", default=str(REPO / "data" / "dsh_probe" / "home"))
    ap.add_argument("--workspace", default=str(REPO / "data" / "dsh_probe" / "workspace"))
    ap.add_argument("--profile", default="sdk-minimal")
    ap.add_argument("--provider", default="deepseek-official")
    ap.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-chat"))
    ap.add_argument("--timeout", type=float, default=900.0)
    ap.add_argument("--out", default="")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    node = shutil.which(args.node)
    if not node:
        log("找不到 node：" + args.node + "；dsh 要 Node 22.18 以上")
        return 2
    # 直接 spawn node 跑 lib/bin.js，不走 npm 的 dsh.cmd：cmd.exe 会按控制台代码页转一遍
    # argv，中文任务文本进去就是乱码（实测 只回复 变成 ֻ�ظ�）
    dsh_js = Path(args.dsh_js)
    if not dsh_js.is_file():
        log("找不到 dsh 入口：" + str(dsh_js) + "；先跑 tools\\dsh_probe\\run_spike.ps1 装 pinned 包")
        return 2
    if not PATCH_FILE.is_file() or not SYSTEM_PROMPT.is_file():
        log("缺少 profile 叠加层或系统提示词：" + str(PATCH_FILE))
        return 2
    if not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        log("缺少 DEEPSEEK_API_KEY：sdk-minimal 那棵树里只有 DeepSeek 的 API-key adapter，"
            "其余 provider 要另加 adapter 行")
        return 2
    home = Path(args.home)
    workspace = Path(args.workspace)
    home.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    session_id = args.session_id or "spike-" + time.strftime("%Y%m%d-%H%M%S", time.localtime())
    patch = home / ("patch-" + session_id + ".yml")
    if not render_patch(patch):
        log("系统提示词正文没写进 patch：" + str(patch))
        return 2

    # profile 里的 !!js 表达式靠这两个变量取路径：不写死盘符，从脚本位置现算；
    # MCP 子进程用同一个解释器起，探针跑在哪个 Python 上就用哪个。PYTHONUTF8 是给它的
    # stderr 用的：我们的 MCP server 在中文 Windows 上按 cp936 写日志，经 dsh 的管道并进
    # dsh 的 stderr 就是乱码（实测 v1.4.0 那行只剩 ��）
    profile_env = {"NEO_PYTHON": sys.executable,
                   "NEO_MCP_SERVER": str(MCP_SERVER),
                   "NEO_PROBE_WORKSPACE": str(workspace),
                   "PYTHONUTF8": "1"}
    argv = [node, str(dsh_js), "--profile", args.profile, "--patch", str(patch)]
    host = Host(argv, home, workspace, profile_env)
    report = {"session_id": session_id, "profile": args.profile, "provider": args.provider,
              "model": args.model, "task": args.task, "patch": str(patch), "argv": argv}
    code = 0
    try:
        info = host.request("initialize",
                            {"cwd": str(workspace), "provider": args.provider, "model": args.model},
                            timeout=45.0)
        report["server_info"] = info.get("serverInfo")
        report["turn"] = turn(host, session_id, args.task, args.timeout, args.verbose)
        if not report["turn"]["idle"]:
            log("这一发没跑到 session.status=idle：超时、闸卡住、或工具调用被 MCP 桥掐掉")
            code = 1
    except (TimeoutError, RuntimeError, OSError, ValueError) as exc:
        report["error"] = str(exc)
        log("探针失败：" + str(exc))
        code = 1
    finally:
        report["stderr_tail"] = host.stderr_tail[-40:]
        host.close()
    data = json.dumps(report, ensure_ascii=False, indent=1)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(data, encoding="utf-8")
        log("report: " + str(out))
    print(data[:4000])
    return code



if __name__ == "__main__":
    sys.exit(main())


