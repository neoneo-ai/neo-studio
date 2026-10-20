# SPDX-License-Identifier: Apache-2.0
"""桌面端 MCP 客户端（app/mcp_client.py）单测：不联网、不装任何 MCP SDK。

stdio 传输打一个自写的假 MCP 服务脚本（NDJSON over stdin/stdout），HTTP 传输打一个 stdlib
http.server。断言的是规范行为与本机边界：initialize 之后要发 notifications/initialized、
tools/call 的正文要截断、密钥不回显也不进日志、服务端反向请求要回错、子进程要收干净。
"""
import atexit
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from uuid import uuid4

APP_DIR = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, str(APP_DIR))

import mcp_client as mc
import studio_caps as caps

# 假 MCP 服务：NDJSON over stdin/stdout，按第一个参数切行为
FAKE_SERVER = r'''
import json, sys

mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
out_file = sys.argv[2] if len(sys.argv) > 2 else ""

TOOLS = {"tools": [
    {"name": "echo", "description": "回显输入", "_meta": {"example": {"text": "示例"}}, "inputSchema":
        {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "boom", "description": "必定失败", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "big", "description": "超长正文", "inputSchema": {"type": "object", "properties": {}}},
]}


def send(msg):
    sys.stdout.buffer.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


if mode == "exit":
    sys.stderr.write("缺依赖，启动即退出\n")
    sys.stderr.flush()
    sys.exit(3)

if mode == "utf8_exit":
    # 子进程继承到 PYTHONIOENCODING / PYTHONUTF8 时写的是 UTF-8，跟父进程的本机代码页无关
    sys.stderr.buffer.write("缺依赖，启动即退出\n".encode("utf-8"))
    sys.stderr.buffer.flush()
    sys.exit(3)

if mode == "stderr":
    for i in range(4000):
        sys.stderr.write("x" * 200 + "\n")
    sys.stderr.flush()

pending_tools = None

for raw in sys.stdin.buffer:
    line = raw.decode("utf-8").strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("id") == 900 and "error" in msg:
        if out_file:
            open(out_file, "a", encoding="utf-8").write("reject\n")
        send({"jsonrpc": "2.0", "method": "ui/notify", "params": {"text": "ignored"}})
        if pending_tools is not None:
            # 硬屏障：拒绝应答落盘之后才发 tools/list 的响应。客户端在等 tools/list 的读循环里
            # 才会应答反向请求，反向请求挂在 tools/list 上发；响应早发一步，connect() 就在
            # 那行写入之前返回，断言读到的永远是空文件。
            send({"jsonrpc": "2.0", "id": pending_tools, "result": TOOLS})
            pending_tools = None
        continue
    if "id" not in msg:
        continue
    method = msg["method"]
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result":
              {"protocolVersion": "2025-06-18", "capabilities": {},
               "serverInfo": {"name": "fake-mcp", "version": "1.0"}}})
    elif mode == "hang":
        continue
    elif method == "tools/list":
        if out_file:
            send({"jsonrpc": "2.0", "id": 900, "method": "sampling/createMessage", "params": {}})
            pending_tools = msg["id"]
        else:
            send({"jsonrpc": "2.0", "id": msg["id"], "result": TOOLS})
    elif method == "tools/call":
        name = msg["params"]["name"]
        if name == "boom":
            send({"jsonrpc": "2.0", "id": msg["id"],
                  "error": {"code": -32603, "message": "工具炸了"}})
        elif name == "big":
            send({"jsonrpc": "2.0", "id": msg["id"], "result":
                  {"content": [{"type": "text", "text": "x" * 300000}]}})
        else:
            send({"jsonrpc": "2.0", "id": msg["id"], "result":
                  {"content": [{"type": "text",
                                "text": msg["params"]["arguments"].get("text", "")}]}})
'''


def tmp_dir(prefix: str) -> Path:
    path = Path(tempfile.mkdtemp(prefix=prefix))
    return path


def fake_server(mode: str = "ok", out_file: str = "") -> dict:
    """按行为起一个假 MCP 服务条目：mode 决定它是正常、即退、灌 stderr 还是不回响应。"""
    return {"name": "fake", "transport": "stdio", "command": sys.executable,
            "args": [str(FAKE_SCRIPT), mode] + ([out_file] if out_file else [])}


TMP = tmp_dir("neo_mcp_test_")
FAKE_SCRIPT = TMP / "fake_mcp_server.py"
FAKE_SCRIPT.write_text(FAKE_SERVER, encoding="utf-8")


def manager_for(servers: list, notes: list = None) -> mc.McpManager:
    """按给定注册表建一个管理器：注册表落在临时数据根里，日志收进 notes 供断言。"""
    path = TMP / f"mcp_servers_{uuid4().hex}.json"
    mgr = mc.McpManager(path, log=notes.append if notes is not None else None)
    saved = mgr.save_servers(servers)
    assert saved["success"], saved
    return mgr


class StdioSessionTests(unittest.TestCase):
    """stdio 会话：连上、列工具、调工具、收进程。"""

    def setUp(self):
        self.notes = []
        self.mgr = manager_for([fake_server()], self.notes)

    def tearDown(self):
        self.mgr.close_all()

    def test_connect_lists_tools_and_reports_server_info(self):
        res = self.mgr.connect("fake")
        self.assertTrue(res["success"], res)
        self.assertEqual(res["serverInfo"]["name"], "fake-mcp")
        self.assertEqual([t["name"] for t in res["tools"]], ["echo", "boom", "big"])
        self.assertEqual(self.mgr.connected(), ["fake"])

    def test_call_tool_returns_content(self):
        self.mgr.connect("fake")
        res = self.mgr.call("fake", "echo", {"text": "你好 MCP"})
        self.assertTrue(res["success"], res)
        self.assertEqual(res["result"]["content"][0]["text"], "你好 MCP")

    def test_tool_error_surfaces_as_message(self):
        self.mgr.connect("fake")
        res = self.mgr.call("fake", "boom", {})
        self.assertFalse(res["success"])
        self.assertIn("工具炸了", res["error"])

    def test_long_text_is_trimmed_to_the_wire_limit(self):
        self.mgr.connect("fake")
        text = self.mgr.call("fake", "big", {})["result"]["content"][0]["text"]
        self.assertEqual(len(text), mc.MAX_TEXT_CHARS, "超长正文要截断后再交给浏览器")

    def test_reverse_request_is_rejected_and_notifications_ignored(self):
        out = TMP / "reject.txt"
        out.write_text("", encoding="utf-8")
        self.mgr = manager_for([fake_server("ok", str(out))], self.notes)
        res = self.mgr.connect("fake")
        self.assertTrue(res["success"], res)
        self.assertIn("reject", out.read_text(encoding="utf-8"),
                      "服务端反向发起的请求必须回错，不能让它挂在永不来的应答上")
        self.assertEqual([t["name"] for t in res["tools"]], ["echo", "boom", "big"],
                         "服务端发的通知要丢进读循环丢弃，不能顶掉 tools/list 的响应")

    def test_stderr_flood_does_not_stall_the_round_trip(self):
        """stderr 写满管道缓冲区后 server 会卡在 write：抽干线程没跑起来的话这条用例超时。"""
        self.mgr = manager_for([fake_server("stderr")], self.notes)
        self.assertTrue(self.mgr.connect("fake")["success"])
        self.assertTrue(self.mgr.call("fake", "echo", {"text": "ok"})["success"])

    def test_dead_process_reports_stderr_tail(self):
        """即退进程的原因要带上 stderr 尾部，用户才知道要装什么；报「已退出」还是「关闭了输出」
        取决于写入与进程退出谁先到，两种都算把原因送到了。"""
        res = manager_for([fake_server("exit")], []).connect("fake")
        self.assertFalse(res["success"])
        self.assertIn("缺依赖", res["error"])
        self.assertTrue("code=3" in res["error"] or "关闭了输出" in res["error"], res["error"])

    def test_utf8_stderr_tail_survives_the_machine_codepage(self):
        """子进程写的是 UTF-8 时，按本机代码页（中文 Windows 的 cp936）解就是「缂轰緷璧栵」这种乱码，
        等于没把要装什么送到用户眼前。"""
        res = manager_for([fake_server("utf8_exit")], []).connect("fake")
        self.assertFalse(res["success"])
        self.assertIn("缺依赖", res["error"])

    def test_timeout_reports_the_reason(self):
        transport = mc.StdioTransport(fake_server("hang"), timeout=1.0)
        session = mc.McpSession("fake", transport, timeout=1.0)
        with self.assertRaises(mc.McpError) as got:
            session.list_tools()
        self.assertIn("超时", str(got.exception))
        session.close()

    def test_close_all_terminates_the_child(self):
        self.mgr.connect("fake")
        session = list(self.mgr._sessions.values())[0]
        self.mgr.close_all()
        self.assertEqual(self.mgr.connected(), [])
        self.assertIsNotNone(session.transport.proc.poll(), "子进程要随会话一起收掉，不能留成孤儿")

    def test_connect_log_never_carries_the_secret_value(self):
        entry = fake_server("exit")
        entry["env"] = {"API_KEY": "super-secret-value"}
        notes = []
        res = manager_for([entry], notes).connect("fake")
        self.assertFalse(res["success"])
        self.assertNotIn("super-secret-value", " ".join(notes))
        self.assertNotIn("super-secret-value", " ".join(v for v in res.values() if isinstance(v, str)))

    def test_reconnect_replaces_the_live_session(self):
        self.mgr.connect("fake")
        first = list(self.mgr._sessions.values())[0]
        self.assertTrue(self.mgr.connect("fake")["success"])
        self.assertIsNotNone(first.transport.proc.poll(), "重连要先收掉旧会话，两条管道会抢同一个 stdio")
        self.assertEqual(len(self.mgr._sessions), 1)



class RegistryTests(unittest.TestCase):
    """注册表：密钥只留键名、掩码存回不覆盖真值、校验挡住坏条目、停用即断会话。"""

    def setUp(self):
        self.notes = []
        self.registry = TMP / f"registry_{uuid4().hex}.json"
        self.mgr = mc.McpManager(self.registry, log=self.notes.append)

    def test_secret_values_are_masked_in_the_response_and_kept_on_disk(self):
        saved = self.mgr.save_servers([{"name": "civ", "transport": "http",
                                        "url": "https://api.example.com/mcp",
                                        "headers": {"Authorization": "Bearer super-secret"}}])
        self.assertTrue(saved["success"], saved)
        self.assertEqual(saved["servers"][0]["headers"], {"Authorization": "***"})
        self.assertNotIn("super-secret", json.dumps(saved), "响应里不能把密钥带回浏览器")
        self.assertIn("Bearer super-secret", self.registry.read_text(encoding="utf-8"),
                      "密钥只留本机")

    def test_masked_value_saved_back_keeps_the_stored_secret(self):
        self.mgr.save_servers([{"name": "civ", "transport": "http", "url": "https://a/mcp",
                                "headers": {"Authorization": "Bearer super-secret"}}])
        again = self.mgr.save_servers([{"name": "civ", "transport": "http", "url": "https://a/mcp",
                                        "headers": {"Authorization": "***"}}])
        self.assertTrue(again["success"], again)
        self.assertIn("Bearer super-secret", self.registry.read_text(encoding="utf-8"),
                      "前端把掩码原样存回来时不能被 *** 覆盖掉真值")

    def test_validation_rejects_broken_entries(self):
        bad = ([{"name": "", "transport": "stdio", "command": "node"}],
               [{"name": "a", "transport": "stdio", "command": "node"},
                {"name": "a", "transport": "stdio", "command": "node"}],
               [{"name": "a", "transport": "sse", "url": "http://a/mcp"}],
               [{"name": "a", "transport": "stdio", "command": ""}],
               [{"name": "a", "transport": "http", "url": "ftp://a/mcp"}],
               [{"name": "a", "transport": "stdio", "command": "node", "args": "x"}])
        for servers in bad:
            res = self.mgr.save_servers(servers)
            self.assertFalse(res["success"], servers)
            self.assertTrue(res["error"])
        self.assertFalse(self.registry.exists(), "校验没过时不能落盘")

    def test_missing_registry_reads_empty(self):
        self.assertEqual(mc.McpManager(TMP / "nope.json").servers(), [])

    def test_missing_registry_falls_back_to_the_builtin_entry(self):
        path = TMP / f"builtin_{uuid4().hex}.json"
        mgr = mc.McpManager(path, defaults=[{"name": "neo-studio", "transport": "stdio",
                                             "command": "python", "args": ["mcp_server.py"]}])
        self.assertEqual([s["name"] for s in mgr.servers()], ["neo-studio"],
                         "注册表还没有文件时，面板要直接看到插件自带的服务")
        self.assertFalse(path.exists(), "默认在代码里，读注册表不能顺手写用户的文件")
        self.assertEqual(mgr.save_servers([])["servers"], [],
                         "用户删掉自带条目并保存后，删除就要留得住")

    def test_broken_registry_does_not_get_the_builtin_entry(self):
        path = TMP / f"broken_{uuid4().hex}.json"
        path.write_text("{ not json", encoding="utf-8")
        mgr = mc.McpManager(path, defaults=[{"name": "neo-studio", "command": "python"}])
        self.assertEqual(mgr.servers(), [], "用户写坏的文件不能被内置条目盖掉")

    def test_registry_write_leaves_no_temp_file(self):
        self.mgr.save_servers([fake_server()])
        self.assertTrue(self.registry.exists())
        self.assertFalse(self.registry.with_name(self.registry.name + ".tmp").exists())

    def test_disabled_server_refuses_connect(self):
        entry = fake_server()
        entry["enabled"] = False
        self.assertTrue(self.mgr.save_servers([entry])["success"])
        res = self.mgr.connect("fake")
        self.assertFalse(res["success"])
        self.assertIn("停用", res["error"])

    def test_disabling_a_live_server_disconnects_it(self):
        self.assertTrue(self.mgr.save_servers([fake_server()])["success"])
        self.mgr.connect("fake")
        session = list(self.mgr._sessions.values())[0]
        entry = fake_server()
        entry["enabled"] = False
        self.mgr.save_servers([entry])
        self.assertEqual(self.mgr.connected(), [], "停用服务不能留一个还在跑的进程")
        self.assertIsNotNone(session.transport.proc.poll())

    def test_tool_allowlist_marks_the_rest_disabled(self):
        entry = fake_server()
        entry["tools"] = ["echo"]
        self.assertTrue(self.mgr.save_servers([entry])["success"])
        self.mgr.connect("fake")
        flags = {t["name"]: t["enabled"] for t in self.mgr.tools()["tools"]}
        self.assertEqual(flags, {"echo": True, "boom": False, "big": False})
        view = {t["name"]: t for t in self.mgr.tools()["tools"]}
        self.assertEqual(view["echo"]["example"], {"text": "示例"}, "示例参数要透传给工具卡预填")
        self.assertEqual(view["boom"]["example"], {}, "没有示例的工具回空字典")

    def test_calling_an_unconnected_server_reports_it(self):
        self.assertTrue(self.mgr.save_servers([fake_server()])["success"])
        res = self.mgr.call("fake", "echo", {"text": "x"})
        self.assertFalse(res["success"])
        self.assertIn("未连接", res["error"])




class _Handler(BaseHTTPRequestHandler):
    """streamable HTTP 服务端桩：initialize 发 Mcp-Session-Id，tools/list 走 SSE 帧。"""

    seen = []

    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).seen.append((msg.get("method"), self.headers.get("Mcp-Session-Id")))
        if msg["method"] == "initialize":
            body = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result":
                               {"protocolVersion": "2025-06-18", "capabilities": {},
                                "serverInfo": {"name": "http-mcp", "version": "1"}}}).encode()
            self._send(200, body, extra={"Mcp-Session-Id": "sess-42"})
        elif msg["method"] == "notifications/initialized":
            self._send(202)
        elif msg["method"] == "tools/list":
            frame = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [
                {"name": "http_echo", "description": "SSE 回显", "inputSchema":
                 {"type": "object", "properties": {"text": {"type": "string"}},
                  "required": ["text"]}}]}})
            self._send(200, ("event: message\ndata: " + frame + "\n\n").encode(),
                       ctype="text/event-stream")
        elif msg["method"] == "tools/call":
            if self.headers.get("Mcp-Session-Id") != "sess-42":
                self._send(404, b'{"error":"no session"}')
                return
            body = json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [
                {"type": "text", "text": msg["params"]["arguments"].get("text", "")}]}}).encode()
            self._send(200, body)
        else:
            self._send(400)


class HttpTransportTests(unittest.TestCase):
    """streamable HTTP 传输：会话头、SSE 帧、通知无响应、失败原因。"""

    @classmethod
    def setUpClass(cls):
        cls.httpd = HTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        _Handler.seen = []
        self.mgr = manager_for([{"name": "web", "transport": "http",
                                 "url": f"http://127.0.0.1:{self.port}/mcp"}])

    def test_initialize_captures_the_session_id_header(self):
        res = self.mgr.connect("web")
        self.assertTrue(res["success"], res)
        self.assertEqual(res["serverInfo"]["name"], "http-mcp")

    def test_initialized_notification_is_posted_without_a_response(self):
        self.mgr.connect("web")
        self.assertIn("notifications/initialized", [m for m, _ in _Handler.seen],
                      "规范要求在 initialize 之后发这条通知，缺了它服务端不认会话")

    def test_tools_list_answers_from_an_sse_stream(self):
        res = self.mgr.connect("web")
        self.assertEqual([t["name"] for t in res["tools"]], ["http_echo"])

    def test_every_request_after_initialize_carries_the_session_id(self):
        self.mgr.connect("web")
        self.assertTrue(self.mgr.call("web", "http_echo", {"text": "hi"})["success"])
        sids = [sid for m, sid in _Handler.seen if m in ("tools/list", "tools/call")]
        self.assertEqual(sids, ["sess-42"] * len(sids),
                         "不带 Mcp-Session-Id 时服务端把请求当新会话，tools/call 直接 404")

    def test_bad_url_is_rejected_by_the_registry(self):
        res = self.mgr.save_servers([{"name": "web", "transport": "http", "url": "ftp://a/mcp"}])
        self.assertFalse(res["success"])
        self.assertIn("HTTP 地址无效", res["error"])

    def test_connection_refused_reports_the_reason(self):
        mgr = manager_for([{"name": "gone", "transport": "http", "url": "http://127.0.0.1:1/mcp"}])
        res = mgr.connect("gone")
        self.assertFalse(res["success"])
        self.assertIn("连接失败", res["error"])



class CommandAndCapabilityTests(unittest.TestCase):
    def test_cmd_wrapper_goes_through_cmd_slash_c(self):
        """npx / pip 装出来的 CLI 是 .cmd 包装：CreateProcess 认不了批处理。"""
        script = TMP / "fake_tool.cmd"
        script.write_text("@echo off\r\n", encoding="utf-8")
        self.assertEqual(mc._resolve_command(str(script), ["--flag"]),
                         ["cmd", "/c", str(script), "--flag"])
        # 解析得到的路径交回原样，参数顺序不动
        plain = mc._resolve_command("neo_no_such_tool_xyz", ["-c", "x"])
        self.assertEqual(plain, ["neo_no_such_tool_xyz", "-c", "x"])

    def test_builtin_server_needs_the_interpreter_and_the_server_file(self):
        """自带条目只有桌面端拼得出来：解释器与插件副本路径浏览器都不知道。"""
        server_py = TMP / "mcp_server_probe.py"
        self.assertIsNone(mc.builtin_server("", server_py, "http://127.0.0.1:8188"),
                          "引导页还没填完解释器时不编默认条目")
        self.assertIsNone(mc.builtin_server("python", server_py, "http://127.0.0.1:8188"),
                          "插件副本没落地时不编默认条目")
        server_py.write_text("", encoding="utf-8")
        entry = mc.builtin_server("python", server_py, "http://127.0.0.1:8188")
        self.assertEqual(entry["args"], [str(server_py), "--comfy-url", "http://127.0.0.1:8188"])
        self.assertEqual(mc._validate(entry, set()), "", "默认条目必须过注册表自己的校验")

    def test_mcp_routes_belong_to_the_desktop_service(self):
        for method, path in caps._MCP:
            self.assertEqual(caps.owner(method, path), "desktop", f"{method} {path}")

    def test_mcp_feature_flag_is_on_for_the_desktop_process(self):
        self.assertTrue(caps.features()["mcp"])

    def test_registry_lands_in_the_data_root_configs(self):
        import studio_server as ns
        got = ns.mcp_config_path(Path("D:/ComfyUI/custom_nodes/comfyui-neo-studio"),
                                 Path("D:/Neo-Studio/data"))
        self.assertEqual(str(got).replace("\\", "/"), "D:/Neo-Studio/data/configs/mcp_servers.json")

    def test_mcp_layers_do_not_import_comfyui_runtime(self):
        """桌面端进程里没有 ComfyUI 运行时：这两层连 folder_paths 都不需要。"""
        forbidden = ("from server", "import server", "import nodes", "from nodes",
                     "from comfy", "import comfy", "import torch", "from torch",
                     "from comfy_api", "import folder_paths")
        for name in ("mcp_client.py", "mcp_routes.py"):
            for line in (APP_DIR / name).read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if line[:1].isspace() or stripped.startswith("#"):
                    continue
                for word in forbidden:
                    self.assertNotIn(word, stripped, f"{name}: {stripped}")


atexit.register(shutil.rmtree, TMP, ignore_errors=True)
