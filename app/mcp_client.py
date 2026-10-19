# SPDX-License-Identifier: Apache-2.0
"""桌面端的标准 MCP 客户端：浏览器 spawn 不了子进程，stdio 只能活在这个进程里。

JSON-RPC 2.0 的 initialize / tools/list / tools/call，两条传输：stdio（换行分隔 JSON 的
子进程）与 streamable HTTP（Mcp-Session-Id + SSE 帧）。前端只通过 app/mcp_routes.py 的
HTTP 接口访问这里，JS 侧不写第二个客户端。

会话只在用户点「连接」时建立，关窗时全部回收：没有自动连接，也没有后台轮询。
"""
from __future__ import annotations

import json
import locale
import os
import queue
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Callable, Optional

PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "Neo Studio", "version": "desktop"}
TRANSPORTS = ("stdio", "http")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)   # pythonw 没有控制台：不挂这个旗子子进程会自己开一个控制台窗口
STDERR_KEEP_LINES = 200
REQUEST_TIMEOUT = 30.0
INIT_TIMEOUT = 25.0
CALL_TIMEOUT = 120.0   # 外部工具的 tools/call 没有「快」的保证：抓网页、跑构建都可能几分钟
MAX_TEXT_CHARS = 200_000   # 工具返回的正文上限：一次抓取回整页 HTML 时不能把它原样搬进浏览器
STDERR_ENCODING = locale.getpreferredencoding(False) or "utf-8"


def decode_stderr(raw: bytes) -> str:
    """子进程 stderr 的编码由它那边定：本机代码页（中文 Windows 是 cp936）是常态，子进程继承到
    PYTHONIOENCODING / PYTHONUTF8 时就是 UTF-8。只按本机代码页解 UTF-8 的话，「缺依赖」会变成
    「缂轰緷璧栵」，用户看不到要装什么；UTF-8 能解干净就先按 UTF-8 解，解不动再回落代码页。"""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode(STDERR_ENCODING, "replace")


class McpError(Exception):
    """一次 MCP 往返失败：消息里带上用户能看懂的原因，前端原样显示。"""


def _tail(lines) -> str:
    return " | ".join(list(lines)[-3:]) if lines else ""


def _resolve_command(command: str, args: list) -> list:
    """Windows 上 npx / pip 装出来的 CLI 都是 .cmd 包装：CreateProcess 认不了批处理，
    直接 Popen(["npx", "foo"]) 抛 WinError 193，用户只看到「连不上」。解析出真实路径后
    交回 cmd /c。"""
    exe = shutil.which(command) or command
    argv = list(args or [])
    if exe.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", exe] + argv
    return [exe] + argv


def _normalize_url(raw: str) -> str:
    """streamable HTTP 端点允许路径（/mcp 是惯例），不允许凭据与片段：
    userinfo 会被 urllib 打进日志与重定向里，片段在服务端没有意义。"""
    url = str(raw or "").strip()
    if "://" not in url:
        url = "http://" + url
    scheme, rest = url.split("://", 1)
    if scheme.lower() not in ("http", "https"):
        return ""
    host, _, tail = rest.partition("/")
    if "@" in host or "#" in url:
        return ""
    if not host:
        return ""
    return f"{scheme.lower()}://{host}" + ("/" + tail if tail else "")


class StdioTransport:
    """stdio 传输：换行分隔的 JSON 走子进程的 stdin / stdout。

    stderr 必须一直有人读：MCP server 把 stderr 管道缓冲区（Windows 约 64KB）写满之后
    会卡在 write 上，请求就永远不回来。这里把它抽进只留尾部的环形队列，超时与进程退出时
    取尾部三行拼进错误原因。
    """

    def __init__(self, server: dict, timeout: float = REQUEST_TIMEOUT):
        argv = _resolve_command(str(server.get("command", "")), server.get("args") or [])
        env = server.get("env")
        popen_env = None
        if isinstance(env, dict) and env:
            popen_env = dict(os.environ)
            popen_env.update({k: str(v) for k, v in env.items()})
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0, env=popen_env,
                                     creationflags=NO_WINDOW)
        self.timeout = timeout
        self.stderr_lines: deque = deque(maxlen=STDERR_KEEP_LINES)
        self._out: queue.Queue = queue.Queue()
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                self._out.put(json.loads(line))
            except json.JSONDecodeError:
                self._out.put(line)   # server 往 stdout 打了非 JSON 日志：交给 request 循环丢掉
        self._out.put(None)   # stdout 关闭 = 进程退出，唤醒所有在等的 request

    def _pump_stderr(self) -> None:
        for raw in self.proc.stderr:
            # 子进程写 stderr 用的是本机代码页（中文 Windows 是 cp936）：按 UTF-8 解就是乱码，
            # 用户看不到「缺依赖」这类原因。stdout 反过来必须按 UTF-8 —— JSON-RPC over stdio 规范定的。
            self.stderr_lines.append(decode_stderr(raw).rstrip())

    def _write(self, payload: dict) -> None:
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()
        except (OSError, ValueError) as e:
            raise McpError(f"写入子进程失败：{e}（{_tail(self.stderr_lines)}）")

    def request(self, payload: dict, timeout: float = None) -> Optional[dict]:
        timeout = timeout or self.timeout
        if self.proc.poll() is not None:
            raise McpError(f"进程已退出（code={self.proc.returncode}）：{_tail(self.stderr_lines)}")
        self._write(payload)
        if "id" not in payload:
            return None   # 通知不需要响应
        rid = payload["id"]
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise McpError(f"等待响应超时（{timeout:.0f}s）：{_tail(self.stderr_lines)}")
            try:
                item = self._out.get(timeout=min(remaining, 1.0))
            except queue.Empty:
                continue
            if item is None:
                raise McpError(f"子进程关闭了输出：{_tail(self.stderr_lines)}")
            if not isinstance(item, dict):
                continue
            if item.get("id") == rid and ("result" in item or "error" in item):
                return item
            if "method" in item and "id" in item:
                # 服务端反向发起的请求（sampling / roots / elicitation）：必须回一个错，
                # 否则它挂在一个永不来的应答上，后续所有 tools/call 都排在这条请求后面
                self._write({"jsonrpc": "2.0", "id": item["id"],
                             "error": {"code": -32601, "message": "Method not found"}})

    def close(self) -> None:
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # cmd /c 包一层时 terminate 只打到 cmd，孙进程（node）还在读 stdin：强杀
            self.proc.kill()
        except OSError:
            pass


class HttpTransport:
    """streamable HTTP 传输：一次 POST 一条 JSON-RPC 消息。

    响应可能是裸 JSON，也可能是 text/event-stream 的 SSE 帧（服务端在长任务里边推进度
    边回结果），按 id 挑出属于本请求的那一帧。会话 id 由 initialize 响应的
    Mcp-Session-Id 响应头给出，之后每个请求都要带上它 —— 不带的话服务端把每条请求当
    新会话，tools/call 直接 404。
    """

    def __init__(self, server: dict, timeout: float = REQUEST_TIMEOUT):
        url = _normalize_url(server.get("url", ""))
        if not url:
            raise McpError(f"HTTP 地址无效：{server.get('url', '')}")
        self.url = url
        self.timeout = timeout
        self.session_id = ""
        headers = server.get("headers")
        self.headers = {str(k): str(v) for k, v in headers.items()} if isinstance(headers, dict) else {}

    def request(self, payload: dict, timeout: float = None) -> Optional[dict]:
        timeout = timeout or self.timeout
        req = urllib.request.Request(self.url, method="POST",
                                     data=json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json, text/event-stream")
        for key, value in self.headers.items():
            req.add_header(key, value)
        if self.session_id:
            req.add_header("Mcp-Session-Id", self.session_id)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                sid = resp.headers.get("Mcp-Session-Id")
                if sid:
                    self.session_id = sid
        except urllib.error.HTTPError as e:
            raise McpError(f"HTTP {e.code}：{e.read().decode('utf-8', 'replace')[:200]}")
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise McpError(f"连接失败：{e}")
        if "id" not in payload:
            return None   # 通知按规范回 202 / 204，没有响应体
        text = body.decode("utf-8", "replace")
        if not text.strip():
            raise McpError("服务端返回空响应")
        if "text/event-stream" in ctype:
            return self._sse_pick(text, payload["id"])
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            raise McpError(f"响应不是 JSON：{text[:200]}")

    @staticmethod
    def _sse_pick(text: str, rid) -> dict:
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if not chunk:
                continue
            try:
                item = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict) and item.get("id") == rid and ("result" in item or "error" in item):
                return item
        raise McpError("SSE 流里没有本请求的响应")

    def close(self) -> None:
        self.session_id = ""   # 无持久连接可断：清掉会话 id，重连时重新 initialize



class McpSession:
    """一个 MCP 会话：一条管道上串行跑 JSON-RPC。

    锁是必需的：两条请求交错写同一条 stdin，服务端会收到两行粘成一半的报文；
    读侧也会把 A 的响应发给 B。
    """

    def __init__(self, name: str, transport, timeout: float = None):
        self.name = name
        self.transport = transport
        self.server_info: dict = {}
        self.tools: list = []
        self.timeout = timeout   # 覆盖默认超时：连接探测要短超时，不能把一次 tools/list 等满 30s
        self._lock = threading.Lock()
        self._next_id = 1

    def _rpc(self, method: str, params: dict = None, timeout: float = None) -> dict:
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            payload = {"jsonrpc": "2.0", "id": rid, "method": method}
            if params is not None:
                payload["params"] = params
            resp = self.transport.request(payload, timeout or self.timeout)
            if resp is None:
                raise McpError(f"{method} 没有响应")
            if "error" in resp:
                raise McpError(f"{method} 失败：{resp['error'].get('message', resp['error'])}")
            return resp.get("result") or {}

    def _notify(self, method: str, params: dict = None) -> None:
        with self._lock:
            payload = {"jsonrpc": "2.0", "method": method}
            if params is not None:
                payload["params"] = params
            self.transport.request(payload)

    def start(self) -> list:
        """initialize → notifications/initialized → tools/list：一次连上就拿到工具表。"""
        res = self._rpc("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                       "clientInfo": CLIENT_INFO}, INIT_TIMEOUT)
        self.server_info = res.get("serverInfo") or {}
        self._notify("notifications/initialized")
        return self.list_tools()

    def list_tools(self) -> list:
        self.tools = self._rpc("tools/list").get("tools") or []
        return self.tools

    def call_tool(self, name: str, arguments: dict) -> dict:
        return self._rpc("tools/call", {"name": name, "arguments": arguments or {}}, CALL_TIMEOUT)

    def close(self) -> None:
        try:
            self.transport.close()
        except OSError:
            pass


def _public(server: dict) -> dict:
    """给前端的注册表条目：env 与 headers 只留键名，值一律 ***。密钥不回显、不进日志；
    前端把整份表存回来时按 *** 认回本机原值。"""
    out = {"name": str(server.get("name", "")), "transport": server.get("transport", "stdio"),
           "enabled": bool(server.get("enabled", True)),
           "args": list(server.get("args") or []), "tools": list(server.get("tools") or [])}
    if server.get("transport") == "http":
        out["url"] = str(server.get("url", ""))
        out["headers"] = {str(k): "***" for k in (server.get("headers") or {})}
    else:
        out["command"] = str(server.get("command", ""))
        out["env"] = {str(k): "***" for k in (server.get("env") or {})}
    return out


def _validate(server: dict, seen: set) -> str:
    """注册表条目的校验：返回空串表示通过，否则是给前端的原因。"""
    if not isinstance(server, dict):
        return "服务条目必须是对象"
    name = str(server.get("name", "")).strip()
    if not name:
        return "服务名不能为空"
    if name in seen:
        return f"服务名重复：{name}"
    transport = server.get("transport", "stdio")
    if transport not in TRANSPORTS:
        return f"不支持的传输：{transport}"
    if transport == "stdio" and not str(server.get("command", "")).strip():
        return "stdio 服务必须填命令"
    if transport == "http" and not _normalize_url(server.get("url", "")):
        return f"HTTP 地址无效：{server.get('url', '')}"
    for key in ("args", "tools"):
        if key in server and not isinstance(server[key], list):
            return f"{key} 必须是数组"
    for key in ("env", "headers"):
        if key in server and not isinstance(server[key], dict):
            return f"{key} 必须是对象"
    return ""


def builtin_server(python_exe, server_py, comfy_url: str) -> dict:
    """插件自带 mcp_server.py 的注册表条目。解释器与插件副本路径只有桌面端知道，
    浏览器侧拼不出来；解释器还没配（引导页没填完）或副本没落地时回 None，注册表就还是空表。"""
    exe, server = str(python_exe or ""), str(server_py or "")
    if not exe or not Path(server).is_file():
        return None
    return {"name": "neo-studio", "transport": "stdio", "command": exe,
            "args": [server, "--comfy-url", comfy_url], "enabled": True}


def _tool_view(server_name: str, tool: dict, allowed: set) -> dict:
    """工具卡片要的是能画出来的那几项：参数名与必填项，不是整份 JSON Schema。"""
    schema = tool.get("inputSchema") or {}
    props = schema.get("properties") if isinstance(schema, dict) else None
    meta = tool.get("_meta")
    example = meta.get("example") if isinstance(meta, dict) else None
    return {"server": server_name, "name": str(tool.get("name", "")),
            "description": str(tool.get("description", "")),
            "required": list(schema.get("required") or []) if isinstance(schema, dict) else [],
            "params": sorted(props) if isinstance(props, dict) else [],
            "example": example if isinstance(example, dict) else {},
            "enabled": not allowed or tool.get("name") in allowed}


def _trim(result: dict) -> dict:
    """tools/call 的正文上限：一次网页抓取回整页 HTML 时不能原样搬进浏览器。"""
    content = result.get("content")
    if not isinstance(content, list):
        return result
    for block in content:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            block["text"] = block["text"][:MAX_TEXT_CHARS]
    return result


class McpManager:
    """MCP 会话登记表与注册表文件：只在用户点「连接」时 spawn 子进程，关窗时全部回收。"""

    def __init__(self, config_path: Path, log: Callable[[str], None] = None,
                 defaults: list = None):
        self.config_path = Path(config_path)
        self.log = log
        self.defaults = [d for d in (defaults or []) if d]
        self._lock = threading.Lock()
        self._sessions: dict = {}

    def _note(self, text: str) -> None:
        if self.log is not None:
            self.log(f"mcp {text}")   # 只记服务名与原因：env / headers 的值不进日志

    def _load(self) -> list:
        """读注册表；文件缺失时用桌面端给的内置条目（插件自带 mcp_server.py）—— 与插件的
        DEFAULT_SETTINGS 同一套，默认在代码里，不发默认副本。文件在而读不出（用户写坏）回空表：
        用户改过的文件不能被内置条目盖掉。"""
        if not self.config_path.is_file():
            return list(self.defaults)
        try:
            data = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        servers = data.get("servers") if isinstance(data, dict) else data
        return [s for s in servers if isinstance(s, dict)] if isinstance(servers, list) else []

    def servers(self) -> list:
        return [_public(s) for s in self._load()]

    def connected(self) -> list:
        with self._lock:
            return sorted(self._sessions)

    def save_servers(self, servers: list) -> dict:
        if not isinstance(servers, list):
            return {"success": False, "error": "servers 必须是数组"}
        seen, clean = set(), []
        for item in servers:
            reason = _validate(item, seen)
            if reason:
                return {"success": False, "error": reason}
            seen.add(str(item.get("name", "")).strip())
            clean.append(item)
        stored = {s.get("name"): s for s in self._load()}
        for item in clean:
            # 前端把 _public 的 *** 原样存回来时保住本机真值：密钥不回显，就不能被自己的掩码覆盖掉
            for key in ("env", "headers"):
                kept = stored.get(item.get("name"), {}).get(key) or {}
                merged = {k: (kept.get(k) if v == "***" and kept.get(k) else v)
                          for k, v in (item.get(key) or {}).items()}
                if merged:
                    item[key] = merged
        for name in list(self._sessions):
            entry = next((s for s in clean if s.get("name") == name), None)
            if entry is None or not entry.get("enabled", True):
                self._disconnect(name)   # 删掉或停用服务不能留一个还在跑的进程
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.config_path.with_name(self.config_path.name + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"servers": clean}, f, indent=2, ensure_ascii=False)
            os.replace(tmp, self.config_path)
        except OSError as e:
            return {"success": False, "error": f"写入 {self.config_path.name} 失败：{e}"}
        return {"success": True, "servers": [_public(s) for s in clean]}

    def _open(self, server: dict):
        return HttpTransport(server) if server.get("transport") == "http" else StdioTransport(server)

    def connect(self, name: str) -> dict:
        name = str(name or "").strip()
        server = next((s for s in self._load() if s.get("name") == name), None)
        if server is None:
            return {"success": False, "error": f"未注册的服务：{name}"}
        if not server.get("enabled", True):
            return {"success": False, "error": "服务已停用"}
        if name in self._sessions:
            self._disconnect(name)   # 重连先收旧会话：两条管道抢同一个 stdio 时响应会串包
        try:
            session = McpSession(name, self._open(server))
            tools = session.start()
        except McpError as e:
            self._note(f"connect {name} failed: {e}")
            return {"success": False, "error": str(e)}
        except OSError as e:
            self._note(f"connect {name} failed: {e}")
            return {"success": False, "error": f"启动失败：{e}"}
        with self._lock:
            self._sessions[name] = session
        self._note(f"connect {name} ok tools={len(tools)}")
        allowed = set(server.get("tools") or [])
        return {"success": True, "serverInfo": session.server_info,
                "tools": [_tool_view(name, t, allowed) for t in tools]}

    def _disconnect(self, name: str) -> None:
        with self._lock:
            session = self._sessions.pop(name, None)
        if session is not None:
            session.close()
            self._note(f"disconnect {name}")

    def disconnect(self, name: str) -> dict:
        name = str(name or "").strip()
        with self._lock:
            existed = name in self._sessions
        if existed:
            self._disconnect(name)
        return {"success": True}

    def tools(self) -> dict:
        with self._lock:
            items = list(self._sessions.items())
        allowed = {s.get("name"): set(s.get("tools") or []) for s in self._load()}
        out = []
        for name, session in items:
            for tool in session.tools:
                out.append(_tool_view(name, tool, allowed.get(name, set())))
        return {"success": True, "tools": out, "connected": sorted(n for n, _ in items)}

    def call(self, name: str, tool: str, arguments: dict) -> dict:
        with self._lock:
            session = self._sessions.get(str(name or "").strip())
        if session is None:
            return {"success": False, "error": f"未连接：{name}"}
        if not isinstance(arguments, dict):
            return {"success": False, "error": "arguments 必须是对象"}
        try:
            result = session.call_tool(str(tool), arguments)
        except McpError as e:
            self._note(f"call {name}/{tool} failed: {e}")
            return {"success": False, "error": str(e)}
        return {"success": True, "result": _trim(result)}

    def close_all(self) -> None:
        """关窗收尾：桌面端拉起的 MCP 子进程不能留成孤儿。"""
        with self._lock:
            sessions = list(self._sessions.items())
            self._sessions.clear()
        for name, session in sessions:
            try:
                session.close()
            except OSError:
                pass
        if sessions:
            self._note(f"closed {len(sessions)} session(s)")


