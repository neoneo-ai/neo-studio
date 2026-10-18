# SPDX-License-Identifier: Apache-2.0
# Neo Studio MCP Server 单测：协议握手、工具表、任务探测、段号换算、SSE、回环校验。
# 全程走假 HTTP 层，不连真实 ComfyUI（mcp_server 是叶子模块，只用标准库）。

import io
import os
import sys
import json
import base64
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest import mock

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _NODE_DIR)

import mcp_server as mcp  # noqa: E402


class Resp:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self.payload

    def __iter__(self):
        return iter(self.payload.splitlines())


class FakeHttp:
    """按 (method, path) 路由的假 urlopen；未登记的路径一律 404（任务表探测靠它）。"""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.calls = []

    def route(self, method, path, payload):
        self.routes[(method, path)] = payload

    def __call__(self, req, timeout=None):
        path = urllib.parse.urlsplit(req.full_url).path
        body = json.loads(req.data) if req.data else None
        self.calls.append((req.method, path, body))
        hit = self.routes.get((req.method, path))
        if hit is None:
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {},
                                         io.BytesIO(b'{"error": "not found"}'))
        if callable(hit):
            return hit(req)
        raw = hit if isinstance(hit, bytes) else json.dumps(hit, ensure_ascii=False).encode("utf-8")
        return Resp(raw)

    def body(self, method, path):
        for m, p, d in self.calls:
            if (m, p) == (method, path):
                return d
        return None

    def paths(self):
        return [(m, p) for m, p, _ in self.calls]


def http_error(code, detail):
    def raiser(req):
        payload = json.dumps({"error": detail}).encode("utf-8")
        raise urllib.error.HTTPError(req.full_url, code, "Bad", {}, io.BytesIO(payload))
    return raiser


def sse(*frames) -> bytes:
    lines = [f"data: {json.dumps(f, ensure_ascii=False)}" for f in frames]
    lines.append("data: [DONE]")
    return ("\n".join(lines) + "\n").encode("utf-8")


def rpc(fake, lines, tools=None, b64=False):
    stdin = io.StringIO("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in lines))
    stdout = io.StringIO()
    with mock.patch.object(mcp.urllib.request, "urlopen", fake):
        mcp.serve(mcp.Ctx(mcp.Comfy("http://127.0.0.1:8188", 5), b64), tools or mcp.TOOLS, stdin, stdout)
    return [json.loads(x) for x in stdout.getvalue().splitlines()]


def call_tool(name, args, routes=None, b64=False):
    """跑一轮 tools/call，返回 (响应, 假 HTTP 记录)。"""
    fake = FakeHttp(routes)
    out = rpc(fake, [{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                      "params": {"name": name, "arguments": args}}], b64=b64)
    return out[0], fake


def text_of(resp) -> str:
    return resp["result"]["content"][0]["text"]


def init_lines():
    return [{"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": mcp.PROTOCOL_VERSION, "capabilities": {},
                        "clientInfo": {"name": "test", "version": "0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"}]


# ===========================================================================
# 协议层
# ===========================================================================

class ProtocolTests(unittest.TestCase):
    def test_initialize_handshake(self):
        out = rpc(FakeHttp(), init_lines())
        self.assertEqual(len(out), 1)   # 通知不回复
        res = out[0]["result"]
        self.assertEqual(res["protocolVersion"], mcp.PROTOCOL_VERSION)
        self.assertEqual(res["serverInfo"]["name"], "neo-studio")
        self.assertEqual(res["serverInfo"]["version"], mcp.plugin_version())
        self.assertIn("task_id", res["instructions"])
        self.assertIn("has_workflow", res["instructions"], "instructions 要写明生图技能必须带工作流模板")
        self.assertIn("tools", res["capabilities"])

    def test_protocol_negotiation_falls_back(self):
        lines = init_lines()[:1]
        lines[0]["params"]["protocolVersion"] = "2099-01-01"
        self.assertEqual(rpc(FakeHttp(), lines)[0]["result"]["protocolVersion"], mcp.PROTOCOL_VERSION)
        lines[0]["params"]["protocolVersion"] = "2025-06-18"
        self.assertEqual(rpc(FakeHttp(), lines)[0]["result"]["protocolVersion"], "2025-06-18")

    def test_tools_list_shape(self):
        tools = rpc(FakeHttp(), init_lines() + [{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}])[1]["result"]["tools"]
        self.assertEqual({t["name"] for t in tools}, set(mcp.HANDLERS))
        for t in tools:
            self.assertTrue(t["description"])
            schema = t["inputSchema"]
            self.assertEqual(schema["type"], "object")
            self.assertTrue(set(schema["required"]) <= set(schema["properties"]))
            for prop in schema["properties"].values():
                self.assertTrue(prop["description"])
            example = (t.get("_meta") or {}).get("example") or {}
            self.assertTrue(set(example) <= set(schema["properties"]))
            if schema["required"]:
                self.assertTrue(example, f"{t['name']} 有必填参数就得带示例参数")

    def test_empty_capability_lists(self):
        out = rpc(FakeHttp(), [{"jsonrpc": "2.0", "id": 1, "method": "resources/list"},
                               {"jsonrpc": "2.0", "id": 2, "method": "prompts/list"},
                               {"jsonrpc": "2.0", "id": 3, "method": "ping"}])
        self.assertEqual([o["result"] for o in out], [{"resources": []}, {"prompts": []}, {}])

    def test_bad_json_unknown_method_silent_notification(self):
        stdin = io.StringIO("not json\n" + json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/shutdown"})
                            + "\n" + json.dumps({"jsonrpc": "2.0", "method": "notifications/cancelled"}) + "\n")
        stdout = io.StringIO()
        with mock.patch.object(mcp.urllib.request, "urlopen", FakeHttp()):
            mcp.serve(mcp.Ctx(mcp.Comfy("http://127.0.0.1:8188", 5), False), mcp.TOOLS, stdin, stdout)
        out = [json.loads(x) for x in stdout.getvalue().splitlines()]
        self.assertEqual([o["error"]["code"] for o in out], [-32700, -32601])

    def test_unknown_tool_is_jsonrpc_error(self):
        resp = rpc(FakeHttp(), [{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                 "params": {"name": "drop_everything", "arguments": {}}}])[0]
        self.assertEqual(resp["error"]["code"], -32602)

    def test_tool_whitelist_filters_tools_list(self):
        tools = [t for t in mcp.TOOLS if t["name"] in ("neo_status", "get_media")]
        res = rpc(FakeHttp(), [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}], tools=tools)
        self.assertEqual({t["name"] for t in res[0]["result"]["tools"]}, {"neo_status", "get_media"})
        resp = rpc(FakeHttp(), [{"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                 "params": {"name": "assemble_run", "arguments": {}}}], tools=tools)[0]
        self.assertEqual(resp["error"]["code"], -32602)


# ===========================================================================
# 基础工具
# ===========================================================================

class BaseToolTests(unittest.TestCase):
    def test_neo_status(self):
        routes = {("GET", "/neo_studio/version"): {"plugin_version": "1.2.0", "comfyui_version": "0.3.40",
                                                   "recipes": ["a", "b"]},
                  ("GET", "/queue"): {"queue_running": [1], "queue_pending": [2, 3]}}
        data = json.loads(text_of(call_tool("neo_status", {}, routes)[0]))
        self.assertEqual(data["neo_studio"], "1.2.0")
        self.assertEqual(data["director_recipes"], 2)
        self.assertEqual(data["queue_pending"], 2)
        self.assertEqual(data["comfy_url"], "http://127.0.0.1:8188")

    def test_list_skills_and_models(self):
        skills = [{"id": "qwen_image_21", "name": "Qwen", "cn_name": "写实", "has_workflow": True,
                   "gen_image": True, "gen_video": False, "mode": "t2i_edit", "requires_ref": False},
                  {"id": "qwen_image_21_face_swap", "name": "Swap", "cn_name": "换脸", "has_workflow": True,
                   "gen_image": True, "gen_video": False, "mode": "edit", "requires_ref": True},
                  {"id": "translate", "name": "Translate", "cn_name": "翻译", "has_workflow": False,
                   "gen_image": False, "gen_video": False}]
        data = json.loads(text_of(call_tool("list_skills", {},
                                           {("GET", "/rs_prompts/skills"): skills})[0]))
        self.assertEqual(data["count"], 2)          # 默认只列生图 / 生视频技能
        self.assertTrue(data["skills"][0]["has_workflow"])
        # 技能收不收参考图要靠这两项告诉调用方：行里没有 mode / requires_ref 时，带参考图那一发
        # 只能挑到纯文生图技能上，参考图被模板丢掉，智能体那边看不出任何痕迹
        self.assertEqual(data["skills"][0]["mode"], "t2i_edit")
        self.assertFalse(data["skills"][0]["requires_ref"])

        data = json.loads(text_of(call_tool("list_skills", {"all": True},
                                           {("GET", "/rs_prompts/skills"): skills})[0]))
        self.assertEqual([s["id"] for s in data["skills"]],
                         ["qwen_image_21", "qwen_image_21_face_swap", "translate"])
        data = json.loads(text_of(call_tool("list_skills", {"q": "翻译", "all": True},
                                           {("GET", "/rs_prompts/skills"): skills})[0]))
        self.assertEqual([s["id"] for s in data["skills"]], ["translate"])
        self.assertNotIn("description", data["skills"][0])

        data = json.loads(text_of(call_tool("list_models", {}, {("GET", "/neo_image_gen/models"):
                                                                 {"diffusion_models": ["m1", "m2"],
                                                                  "suggested_model": "m1"}})[0]))
        self.assertEqual(data["diffusion_models"]["count"], 2)
        self.assertEqual(data["suggested_model"], "m1")

    def test_generate_image_payload_and_task_id(self):
        routes = {("POST", "/neo_image_gen/generate"): {"task_id": "T1", "status": "queued"}}
        resp, fake = call_tool("generate_image",
                               {"skill_id": "sd", "prompt": "猫", "width": 1024,
                                "references": ["a.png", "b.png"]}, routes)
        body = fake.body("POST", "/neo_image_gen/generate")
        self.assertEqual(body["prompt"], "猫")
        self.assertEqual(body["width"], 1024)
        self.assertNotIn("height", body)
        self.assertEqual(body["references"], [{"kind": "input", "value": "a.png"},
                                              {"kind": "input", "value": "b.png"}])
        self.assertEqual(json.loads(text_of(resp))["task_id"], "T1")

    def test_generate_image_without_skill_id_points_at_list_skills(self):
        # 后端的空技能报错写的是「技能下拉」，MCP 侧要在打到后端之前换成照着做得下去的一句
        resp, fake = call_tool("generate_image", {"prompt": "猫"})
        self.assertTrue(resp["result"]["isError"])
        self.assertIn("list_skills", text_of(resp))
        self.assertIn("has_workflow", text_of(resp))
        self.assertEqual(fake.calls, [], "技能 id 缺失时不该把请求发到后端")

    def test_reference_on_a_text_to_image_skill_is_refused(self):
        """参考图进了纯文生图模板就是静默丢图：这一发跑出来就是「出的图不跟我给的图走」。
        绘画页的技能列表把这种技能从编辑面板里过滤掉了，工具这一侧要在发出请求之前点名要换的技能。"""
        routes = {("GET", "/rs_prompts/skills"): [{"id": "image_gen", "mode": "t2i", "has_workflow": True}],
                  ("POST", "/neo_image_gen/generate"): {"task_id": "T1", "status": "queued"}}
        resp, fake = call_tool("generate_image", {"skill_id": "image_gen", "prompt": "猫",
                                                 "references": ["a.png"]}, routes)
        self.assertTrue(resp["result"]["isError"])
        self.assertIn("mode=t2i", text_of(resp))
        self.assertIn("mode=edit / t2i_edit", text_of(resp))
        self.assertNotIn(("POST", "/neo_image_gen/generate"), fake.paths())

    def test_reference_on_a_skill_that_accepts_it_runs(self):
        """mode 声明优先，画布导入的用户技能没有 mode 时看 requires_ref——与绘画页技能列表同一份判法。"""
        skills = [{"id": "qwen_image_21_face_swap", "mode": "edit", "requires_ref": True},
                  {"id": "qwen_image_21", "mode": "t2i_edit"},
                  {"id": "my_canvas_skill", "requires_ref": True},
                  {"id": "my_plain_skill"}]
        routes = {("GET", "/rs_prompts/skills"): skills,
                  ("POST", "/neo_image_gen/generate"): {"task_id": "T1", "status": "queued"}}
        for skill in ("qwen_image_21_face_swap", "qwen_image_21", "my_canvas_skill"):
            resp, fake = call_tool("generate_image", {"skill_id": skill, "prompt": "猫",
                                                     "references": ["a.png"]}, routes)
            self.assertFalse(resp["result"]["isError"], text_of(resp))
            self.assertEqual(fake.body("POST", "/neo_image_gen/generate")["skill_id"], skill)
        resp, fake = call_tool("generate_image", {"skill_id": "my_plain_skill", "prompt": "猫",
                                                 "references": ["a.png"]}, routes)
        self.assertIn("my_plain_skill", text_of(resp))
        self.assertNotIn(("POST", "/neo_image_gen/generate"), fake.paths())

    def test_a_skill_the_table_does_not_list_is_left_to_the_backend(self):
        routes = {("GET", "/rs_prompts/skills"): [{"id": "image_gen", "mode": "t2i"}],
                  ("POST", "/neo_image_gen/generate"): {"task_id": "T1", "status": "queued"}}
        resp = call_tool("generate_image", {"skill_id": "gone", "prompt": "猫",
                                           "references": ["a.png"]}, routes)[0]
        self.assertEqual(json.loads(text_of(resp))["task_id"], "T1")

    def test_plain_text_to_image_never_probes_the_skill_table(self):
        routes = {("GET", "/rs_prompts/skills"): [{"id": "image_gen", "mode": "t2i"}],
                  ("POST", "/neo_image_gen/generate"): {"task_id": "T1", "status": "queued"}}
        resp, fake = call_tool("generate_image", {"skill_id": "image_gen", "prompt": "猫"}, routes)
        self.assertEqual(json.loads(text_of(resp))["task_id"], "T1")
        self.assertNotIn(("GET", "/rs_prompts/skills"), fake.paths())

    def test_task_status_probes_tables_and_merges_director_progress(self):
        routes = {("GET", "/neo_studio/director/T1"): {"status": "running", "recipe": "r",
                                                       "latest_preview": "x" * 5000},
                  ("GET", "/neo_video_gen/director_progress"): {"active": True, "segment_index": 2,
                                                                "total_segments": 5, "step": 10,
                                                                "total_steps": 30}}
        resp, fake = call_tool("task_status", {"task_id": "T1"}, routes)
        data = json.loads(text_of(resp))
        self.assertEqual(data["kind"], "director")
        self.assertEqual(data["segment"]["index"], 3)      # 对外 1 起
        self.assertNotIn("latest_preview", text_of(resp))
        self.assertEqual([p for _, p in fake.paths()][:3],
                         ["/neo_image_gen/tasks", "/neo_studio/director/T1",
                          "/neo_video_gen/director_progress"])

    def test_task_status_image_kind_with_view_urls(self):
        routes = {("GET", "/neo_image_gen/tasks"): [{"task_id": "T9", "status": "succeeded",
                                                     "images": [{"filename": "neo_0001.png",
                                                                 "subfolder": ""}]}]}
        data = json.loads(text_of(call_tool("task_status", {"task_id": "T9"}, routes)[0]))
        self.assertEqual(data["kind"], "image")
        self.assertEqual(data["images"][0]["url"],
                         "http://127.0.0.1:8188/view?filename=neo_0001.png&subfolder=&type=output")

    def test_task_status_video_kind_carries_view_url(self):
        # 链接必须由后端拼：智能体按配方 filename_prefix 自己拼 /view 时目录是 NeoDirector/xxx，
        # 产物真实落盘目录是 neo_director_regen
        routes = {("GET", "/neo_video_gen/run_segment/T7"): {"status": "succeeded", "recipe": "r",
                                                             "filename": "Temp_古风少女换装_s1_20261018-184750.mp4",
                                                             "subfolder": "neo_director_regen"}}
        data = json.loads(text_of(call_tool("task_status", {"task_id": "T7"}, routes)[0]))
        self.assertEqual(data["kind"], "segment")
        self.assertEqual(data["url"],
                         "http://127.0.0.1:8188/view?filename=Temp_%E5%8F%A4%E9%A3%8E%E5%B0%91%E5%A5%B3"
                         "%E6%8D%A2%E8%A3%85_s1_20261018-184750.mp4&subfolder=neo_director_regen&type=output")

    def test_task_status_running_video_has_no_url(self):
        routes = {("GET", "/neo_studio/director/T8"): {"status": "running", "recipe": "r"}}
        data = json.loads(text_of(call_tool("task_status", {"task_id": "T8"}, routes)[0]))
        self.assertNotIn("url", data)

    def test_task_status_and_cancel_not_found(self):
        resp = call_tool("task_status", {"task_id": "T0"})[0]
        self.assertTrue(resp["result"]["isError"])
        self.assertIn("任务不存在", text_of(resp))
        self.assertIn("任务不存在", text_of(call_tool("cancel_task", {"task_id": "T0"})[0]))

    def test_cancel_task_probes_routes(self):
        routes = {("POST", "/neo_video_gen/run_segment/T5/cancel"): {"ok": True, "cancelled": True}}
        resp, fake = call_tool("cancel_task", {"task_id": "T5"}, routes)
        self.assertEqual(json.loads(text_of(resp))["kind"], "segment")
        self.assertEqual(len(fake.calls), 3)   # 生图 / 整片 404 之后才命中单段

    def test_get_media_video_is_url_only(self):
        data = json.loads(text_of(call_tool("get_media", {"filename": "v.mp4", "subfolder": "NeoDirector/x",
                                                          "base64": True})[0]))
        self.assertNotIn("base64", data)
        self.assertEqual(data["kind"], "video")
        self.assertIn("/view?filename=v.mp4", data["url"])
        self.assertIn("url", data["note"])

    def test_get_media_image_base64_opt_in(self):
        data = json.loads(text_of(call_tool("get_media", {"filename": "a.png"})[0]))
        self.assertNotIn("base64", data)
        self.assertEqual(data["kind"], "image")

        data = json.loads(text_of(call_tool("get_media", {"filename": "a.png", "base64": True},
                                            {("GET", "/view"): b"PNGDATA"})[0]))
        self.assertEqual(base64.b64decode(data["base64"]), b"PNGDATA")
        self.assertEqual(data["bytes"], 7)

    def test_global_base64_flag(self):
        data = json.loads(text_of(call_tool("get_media", {"filename": "a.png"},
                                           {("GET", "/view"): b"X"}, b64=True)[0]))
        self.assertEqual(data["bytes"], 1)

    def test_oversize_image_returns_url_only(self):
        routes = {("GET", "/view"): b"X" * (mcp.MAX_B64_BYTES + 10)}
        data = json.loads(text_of(call_tool("get_media", {"filename": "big.png", "base64": True}, routes)[0]))
        self.assertNotIn("base64", data)
        self.assertEqual(data["bytes"], mcp.MAX_B64_BYTES + 10)
        self.assertIn("url", data["note"])

    def test_gallery_and_recipes(self):
        data = json.loads(text_of(call_tool("list_gallery", {"dir_name": "NeoGallery"},
                                           {("GET", "/neo_gallery/list"): {"dirs": ["a", "b"]}})[0]))
        self.assertEqual(data, ["a", "b"])
        data = json.loads(text_of(call_tool("list_recipes", {}, {("POST", "/rs_recipes/list"):
                                                                 [{"name": "r", "type": "video_director",
                                                                   "segments": [{}, {}]}]})[0]))
        self.assertEqual(data["recipes"][0]["segments"], 2)

    def test_missing_param_and_http_error_text(self):
        self.assertIn("缺少参数：name", text_of(call_tool("load_recipe", {})[0]))
        resp = call_tool("load_recipe", {"name": "r"},
                         {("POST", "/rs_recipes/load"): http_error(500, "配方损坏")})[0]
        self.assertTrue(resp["result"]["isError"])
        self.assertIn("HTTP 500：配方损坏", text_of(resp))

    def test_unreachable_message_is_actionable(self):
        def down(req, timeout=None):
            raise urllib.error.URLError("connection refused")
        resp = rpc(down, [{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": "neo_status", "arguments": {}}}])[0]
        self.assertIn("ComfyUI 不可达", text_of(resp))
        self.assertIn("Neo Studio 已启动", text_of(resp))

    def test_output_truncated(self):
        resp = call_tool("load_recipe", {"name": "r"},
                         {("POST", "/rs_recipes/load"):
                          {"recipe": {"blob": "y" * (mcp.MAX_TEXT + 500)}}})[0]
        self.assertIn("已截断", text_of(resp))


# ===========================================================================
# 导演工具（段序号 1 起 ↔ 端点 0 基）
# ===========================================================================

class DirectorTests(unittest.TestCase):
    def test_director_recipes_and_spec(self):
        data = json.loads(text_of(call_tool("director_recipes", {},
                                           {("GET", "/neo_studio/version"): {"recipes": ["r1"]}})[0]))
        self.assertEqual(data["recipes"], ["r1"])

        routes = {("GET", "/rs_recipes/director_spec"): {"name": "r1", "shared": {"width": 768},
                                                        "segments": [{"skill_id": "h3", "duration_sec": 10,
                                                                      "prompt": "p1"},
                                                                     {"duration_sec": 5, "prompt": "p2"}]}}
        data = json.loads(text_of(call_tool("director_spec", {"name": "r1"}, routes)[0]))
        self.assertEqual(data["segment_count"], 2)
        self.assertEqual([s["index"] for s in data["segments"]], [1, 2])
        self.assertEqual(data["shared"]["width"], 768)

    def test_director_plan_modes(self):
        routes = {("POST", "/rs_recipes/director_generate_segments"):
                  {"segments": [{"prompt": "p", "duration_sec": 10}]}}
        resp, fake = call_tool("director_plan", {"idea": "雨夜便利店", "segment_seconds": 8}, routes)
        self.assertEqual(fake.body("POST", "/rs_recipes/director_generate_segments"),
                         {"idea": "雨夜便利店", "segment_seconds": 8})
        self.assertEqual(json.loads(text_of(resp))["segments"][0]["duration_sec"], 10)

        _, fake = call_tool("director_plan", {"script": "第一幕"}, routes)
        self.assertEqual(fake.body("POST", "/rs_recipes/director_generate_segments"), {"script": "第一幕"})

        self.assertIn("缺少参数：idea", text_of(call_tool("director_plan", {}, routes)[0]))
        self.assertIn("plan / optimize / modify", text_of(call_tool("director_plan", {"mode": "zzz"})[0]))

    def test_director_plan_optimize_and_modify_are_sse(self):
        routes = {("POST", "/rs_recipes/director_optimize_prompts"): sse({"text": "【画面】…"}),
                  ("POST", "/rs_recipes/director_modify_segment"): sse({"text": "改后的提示词"})}
        self.assertEqual(text_of(call_tool("director_plan", {"mode": "optimize", "prompt": "p"}, routes)[0]),
                         "【画面】…")
        resp, fake = call_tool("director_plan",
                               {"mode": "modify", "prompt": "p", "instruction": "改成黄昏",
                                "duration_sec": 6, "video_mode": "i2v", "refs": {"images": ["a.png"]}},
                               routes)
        self.assertEqual(text_of(resp), "改后的提示词")
        self.assertEqual(fake.body("POST", "/rs_recipes/director_modify_segment"),
                         {"prompt": "p", "duration_sec": 6, "mode": "i2v",
                          "refs": {"images": ["a.png"]}, "instruction": "改成黄昏"})

    def test_generate_prompt_skips_thinking_frames(self):
        routes = {("POST", "/rs_prompts/stream_generate_prompt"):
                  sse({"kind": "thinking", "text": "思考过程"}, {"text": "一只"}, {"text": "橘猫"})}
        resp, fake = call_tool("generate_prompt", {"text": "橘猫", "skill_id": "sd"}, routes)
        self.assertEqual(text_of(resp), "一只橘猫")
        self.assertEqual(fake.body("POST", "/rs_prompts/stream_generate_prompt"),
                         {"text": "橘猫", "skillId": "sd"})

    def test_sse_error_points_at_llm_config(self):
        def llm_down(req, timeout=None):
            return Resp("data: [ERROR] 未配置 LLM 模型\n".encode("utf-8"))
        routes = {("POST", "/rs_prompts/stream_generate_prompt"): llm_down}
        resp = call_tool("generate_prompt", {"text": "x"}, routes)[0]
        self.assertTrue(resp["result"]["isError"])
        self.assertIn("未配置 LLM 模型", text_of(resp))
        self.assertIn("设置里选模型", text_of(resp))

    def test_director_save_copy_passthrough(self):
        routes = {("POST", "/rs_recipes/save"): {"ok": True, "name": "我的片子"},
                  ("POST", "/rs_recipes/copy"): {"ok": True, "name": "我的片子_副本"}}
        resp, fake = call_tool("director_save",
                               {"name": "我的片子", "shared": {"width": 768, "height": 432, "seed": -1},
                                "segments": [{"prompt": "p1", "duration_sec": 10}],
                                "assets": [{"filename": "a.png", "kind": "identity"}]}, routes)
        self.assertEqual(fake.body("POST", "/rs_recipes/save"),
                         {"name": "我的片子", "type": "video_director",
                          "shared": {"width": 768, "height": 432, "seed": -1},
                          "segments": [{"prompt": "p1", "duration_sec": 10}],
                          "assets": [{"filename": "a.png", "kind": "identity"}]})
        self.assertTrue(json.loads(text_of(resp))["ok"])
        self.assertIn("我的片子_副本", text_of(call_tool("director_copy", {"name": "预设"}, routes)[0]))

    def test_director_save_rejects_empty_segments_and_keeps_preset_error(self):
        self.assertIn("segments 为空", text_of(call_tool("director_save", {"name": "x"})[0]))
        resp = call_tool("director_save", {"name": "预设", "segments": [{"prompt": "p", "duration_sec": 5}]},
                         {("POST", "/rs_recipes/save"): http_error(400, "内置预设配方只读")})[0]
        self.assertIn("内置预设配方只读", text_of(resp))

    def test_director_keyframes_returns_save_ready_segments(self):
        routes = {
            ("POST", "/rs_recipes/load"): {"recipe": {
                "type": "video_director", "shared": {"width": 1344},
                "story": {"idea": "雨夜便利店", "segment_seconds": 5},
                "segments": [{"skill_id": "minimax_h3_vdn_i2v", "prompt": "雨夜街道，霓虹",
                              "duration_sec": 5, "storyboard_prompt": "雨夜便利店门口，霓虹倒影"},
                             {"skill_id": "minimax-h3-vdn-r2v", "prompt": "推门进店",
                              "duration_sec": 5, "mode": "r2v", "refs": {"images": ["keep.png"]}}]}},
            ("POST", "/neo_video_gen/storyboard_generate"): {"success": True, "task_id": "SB1", "total": 2},
            ("GET", "/neo_video_gen/storyboard_status/SB1"): {
                "success": True, "status": "done", "total": 2, "processed": 2,
                "details": [{"index": 0, "status": "done", "filename": "storyboard_雨夜_01.png",
                             "preview_url": "/rs_recipes/asset?recipe=雨夜&file=storyboard_雨夜_01.png"},
                            {"index": 1, "status": "done", "filename": "storyboard_雨夜_02.png",
                             "preview_url": "/rs_recipes/asset?recipe=雨夜&file=storyboard_雨夜_02.png"}]},
        }
        resp, fake = call_tool("director_keyframes", {"recipe": "雨夜", "skill_id": "qwen_image_21"}, routes)
        body = fake.body("POST", "/neo_video_gen/storyboard_generate")
        self.assertEqual(body["name"], "雨夜")
        self.assertEqual(body["skill_id"], "qwen_image_21")
        self.assertEqual(body["index"], 0)
        self.assertFalse(body["force"])
        self.assertNotIn("mode", body, "没点名模式就交给后端按角色参考图自动")
        self.assertEqual(body["segments"][0]["storyboard_prompt"], "雨夜便利店门口，霓虹倒影")
        self.assertEqual(body["segments"][1]["storyboard_prompt"], "", "没有分镜提示词就空着，让后端回退视频提示词")
        data = json.loads(text_of(resp))
        self.assertEqual(data["status"], "done")
        self.assertEqual([d["index"] for d in data["details"]], [1, 2], "段号对外一律 1 起")
        first, second = data["segments"]
        self.assertEqual(first["storyboard"], "storyboard_雨夜_01.png")
        self.assertEqual(first["first_frame"], "storyboard_雨夜_01.png", "非全参考段要把关键帧设成首帧，i2v 才吃这张图")
        self.assertEqual(second["storyboard"], "storyboard_雨夜_02.png")
        self.assertNotIn("first_frame", second, "全参考段不设首帧")
        self.assertEqual(second["refs"]["images"], ["storyboard_雨夜_02.png", "keep.png"], "全参考段把关键帧进参考图池")
        self.assertEqual(data["shared"], {"width": 1344}, "shared 要回带：save 是整份覆盖")
        self.assertEqual(data["story"]["idea"], "雨夜便利店", "story 要回带，否则 📖 页的主题与角色参考会被清掉")
        self.assertNotIn("preview_url", text_of(resp))

    def test_director_keyframes_rejects_bad_segments_and_mode(self):
        routes = {("POST", "/rs_recipes/load"): {"recipe": {"type": "video_director",
                                                            "segments": [{"prompt": "p1"}, {"prompt": "p2"}]}}}
        self.assertIn("段序号超出范围",
                      text_of(call_tool("director_keyframes", {"recipe": "r", "segments": [3]}, routes)[0]))
        self.assertIn("mode 只能是",
                      text_of(call_tool("director_keyframes", {"recipe": "r", "mode": "zzz"}, routes)[0]))
        resp = call_tool("director_keyframes", {"recipe": "r"},
                         {("POST", "/rs_recipes/load"): {"recipe": {"type": "video_director", "segments": []}}})[0]
        self.assertIn("还没有分段", text_of(resp))
        resp = call_tool("director_keyframes", {"recipe": "r"},
                         {("POST", "/rs_recipes/load"): {"recipe": {"type": "image",
                                                                    "segments": [{"prompt": "p"}]}}})[0]
        self.assertIn("不是 video_director 配方", text_of(resp))

    def test_director_keyframes_splits_non_contiguous_picks(self):
        routes = {("POST", "/rs_recipes/load"): {"recipe": {
                      "type": "video_director",
                      "segments": [{"prompt": "p1"}, {"prompt": "p2"}, {"prompt": "p3"}]}},
                  ("POST", "/neo_video_gen/storyboard_generate"): {"success": True, "task_id": "SB1"},
                  ("GET", "/neo_video_gen/storyboard_status/SB1"): {
                      "success": True, "status": "done",
                      "details": [{"index": 0, "status": "done", "filename": "k1.png"}]}}
        _, fake = call_tool("director_keyframes", {"recipe": "r", "segments": [1, 3]}, routes)
        indexes = [d["index"] for m, p, d in fake.calls if p == "/neo_video_gen/storyboard_generate"]
        self.assertEqual(indexes, [0, 2], "跳着选段要按段各发一发，图名才不会和段号错位")

    def test_director_save_passes_story_through(self):
        routes = {("POST", "/rs_recipes/save"): {"ok": True, "name": "r"}}
        _, fake = call_tool("director_save",
                            {"name": "r", "segments": [{"prompt": "p", "duration_sec": 5}],
                             "story": {"idea": "雨夜便利店", "segment_seconds": 5,
                                       "characters": [{"filename": "girl.png"}]}}, routes)
        body = fake.body("POST", "/rs_recipes/save")
        self.assertEqual(body["story"]["idea"], "雨夜便利店")
        self.assertEqual(body["story"]["characters"], [{"filename": "girl.png"}])

    def test_task_status_and_cancel_cover_storyboard(self):
        routes = {
            ("GET", "/neo_video_gen/storyboard_status/SB1"): {
                "success": True, "status": "done", "total": 2, "processed": 2,
                "details": [{"index": 0, "status": "done", "filename": "k1.png",
                             "preview_url": "/rs_recipes/asset?recipe=r&file=k1.png"}]},
            ("POST", "/neo_video_gen/storyboard_cancel/SB1"): {"success": True, "status": "cancelled"},
        }
        resp = call_tool("task_status", {"task_id": "SB1"}, routes)[0]
        self.assertEqual(json.loads(text_of(resp))["kind"], "storyboard")
        self.assertNotIn("preview_url", text_of(resp), "预览是相对地址，取图统一走 get_media")
        _, fake = call_tool("cancel_task", {"task_id": "SB1"}, routes)
        self.assertEqual(json.loads(text_of(call_tool("cancel_task", {"task_id": "SB1"}, routes)[0]))["kind"],
                         "storyboard")
        self.assertEqual(len(fake.calls), 5, "生图 / 整片 / 单段 / 拼接都 404 之后才命中分镜")

    def test_director_spec_projects_storyboard_fields(self):
        routes = {("GET", "/rs_recipes/director_spec"): {
            "name": "r", "shared": {}, "segments": [
                {"skill_id": "h3", "prompt": "p1", "duration_sec": 5,
                 "storyboard": "storyboard_r_01.png", "storyboard_prompt": "门口全景",
                 "first_frame": "storyboard_r_01.png"}]}}
        seg = json.loads(text_of(call_tool("director_spec", {"name": "r"}, routes)[0]))["segments"][0]
        self.assertEqual(seg["storyboard"], "storyboard_r_01.png")
        self.assertEqual(seg["storyboard_prompt"], "门口全景")
        self.assertEqual(seg["first_frame"], "storyboard_r_01.png")

    def test_director_run_payload(self):
        routes = {("POST", "/neo_studio/director/generate"): {"task_id": "D1", "status": "queued", "recipe": "r"}}
        resp, fake = call_tool("director_run", {"recipe": "r", "only_segments": [1, 3], "seed": 7}, routes)
        body = fake.body("POST", "/neo_studio/director/generate")
        self.assertEqual(body["only_segments"], "1,3")   # 后端按 1 基解析勾选段
        self.assertEqual(body["seed"], 7)
        self.assertNotIn("width", body)
        self.assertEqual(json.loads(text_of(resp))["task_id"], "D1")

    def test_segment_run_converts_one_based_to_zero_based(self):
        routes = {("POST", "/neo_video_gen/run_segment"): {"task_id": "S1", "status": "queued", "segment": 1}}
        resp, fake = call_tool("segment_run", {"recipe": "r", "segment": 2, "anchors": "first"}, routes)
        self.assertEqual(fake.body("POST", "/neo_video_gen/run_segment")["segment"], 1)
        self.assertEqual(json.loads(text_of(resp))["segment"], 2)   # 回给智能体仍是 1 起

    def test_segment_run_rejects_bad_segment_index(self):
        for bad in (None, 0, -1, "abc"):
            self.assertIn("段序号", text_of(call_tool("segment_run", {"recipe": "r", "segment": bad})[0]))

    def test_assemble_run_converts_use_list(self):
        routes = {("POST", "/neo_video_gen/assemble_segments"): {"task_id": "A1", "status": "queued"}}
        resp, fake = call_tool("assemble_run", {"recipe": "r", "segments": [1, 3]}, routes)
        self.assertEqual(fake.body("POST", "/neo_video_gen/assemble_segments")["use"], [0, 2])
        self.assertEqual(json.loads(text_of(resp))["use"], [1, 3])

        _, fake = call_tool("assemble_run", {"recipe": "r", "segments": "2, 4"}, routes)
        self.assertEqual(fake.body("POST", "/neo_video_gen/assemble_segments")["use"], [1, 3])
        self.assertIn("段序号列表为空", text_of(call_tool("assemble_run", {"recipe": "r"})[0]))


# ===========================================================================
# 启动参数与安全边界
# ===========================================================================

class CliTests(unittest.TestCase):
    def test_comfy_base_is_loopback_only(self):
        self.assertEqual(mcp.comfy_base(None), "http://127.0.0.1:8188")
        self.assertEqual(mcp.comfy_base("http://127.0.0.1/"), "http://127.0.0.1:8188")
        self.assertEqual(mcp.comfy_base("http://localhost:8191"), "http://localhost:8191")
        for bad in ("http://10.0.0.5:8188", "http://192.168.1.9:8188", "https://127.0.0.1:8188",
                    "http://example.com:8188", "127.0.0.1:8188"):
            with self.assertRaises(SystemExit):
                mcp.comfy_base(bad)

    def test_selftest_lists_enabled_tools(self):
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err):
            self.assertEqual(mcp.main(["--selftest", "--tools", "neo_status,generate_image"]), 0)
        self.assertIn("2 工具", err.getvalue())
        self.assertIn("generate_image", err.getvalue())

    def test_selftest_and_env_whitelist(self):
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err):
            mcp.main(["--selftest"])
        self.assertIn(f"{len(mcp.HANDLERS)} 工具", err.getvalue())

        err = io.StringIO()
        with mock.patch.dict(os.environ, {"NEO_MCP_TOOLS": "neo_status"}), \
                mock.patch.object(sys, "stderr", err):
            mcp.main(["--selftest"])
        self.assertIn("1 工具", err.getvalue())

    def test_unknown_whitelist_entry_is_rejected(self):
        with self.assertRaises(SystemExit):
            mcp.main(["--selftest", "--tools", "neo_status,drop_tables"])

    def test_server_is_a_leaf_module(self):
        src = open(os.path.join(_NODE_DIR, "mcp_server.py"), encoding="utf-8").read()
        for banned in ("from .", "import folder_paths", "from comfy", "torch", "import server"):
            self.assertNotIn(banned, src)


if __name__ == "__main__":
    unittest.main()






