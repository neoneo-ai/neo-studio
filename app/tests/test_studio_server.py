# SPDX-License-Identifier: Apache-2.0
"""桌面端服务（app/studio_server.py）离线单测：ComfyUI 不在跑时 Studio 的可用面与能力边界。

服务复用内核插件模块挂在各自 RouteTableDef 上的 handler，进程里没有 PromptServer，
所以这里直接起真服务打真接口：Studio 页面、静态文件、浏览、设置与配方写入都要出得来；
生成 / 队列 / 显存类接口必须回 409 offline，不能让前端以为生成成功了。
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

APP_DIR = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLUGIN_DIR = APP_DIR.parent / "studio"
COMFY_ROOT = APP_DIR.parent.parent / "ComfyUI"
sys.path.insert(0, str(APP_DIR))
sys.path.insert(0, str(PLUGIN_DIR / "tests"))

import studio_caps as caps
import studio_server as ns
import mcp_client
import mcp_routes

TEST_PORT = 8291
STUDIO_URL = "/neo-studio"
SAMPLE = ("CharacterSheet", "2026-09-27_00001_.png")   # 整合包里的真实产物，只读
CONFIGS = PLUGIN_DIR / "configs"
# 写入用例落数据根的这些配置文件：用例前后快照还原，不留测试数据
WRITE_FILES = ("image_gen.json", "bookmarks.json", "remote_llm_config.json")


def _data_root() -> Path:
    """桌面端加载的插件模块实际用的用户数据根：写入用例的落点与断言都以它为准。"""
    return sys.modules[f"{ns.DESKTOP_PKG}.plugin_paths"].DATA_ROOT
# 必须 ComfyUI 在跑才有的接口：桌面端一律 409 offline，前端据此门控
COMFY_ONLY_ROUTES = (
    "/neo_image_gen/generate",
    "/neo_image_gen/tasks",
    "/neo_image_gen/enhance",
    "/neo_image_gen/skill_dims?skill_id=x",
    "/neo_video_gen/run_segment",
    "/neo_video_gen/assemble_segments",
    "/neo_video_gen/simple",
    "/neo_voice/generate",
    "/neo_studio/director/generate",
    "/neo_studio/queue",
    "/neo_studio/mem_stats",
    "/neo_studio/clear_memory",
    "/neo_nodes/repair",
    "/rs_prompts/enhance_prompt",
)



def _request(port, path, data=None, method=None, headers=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                 headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _snapshot(paths):
    return {p: (p.read_bytes() if p.exists() else None) for p in paths}


def _restore(saved):
    for path, data in saved.items():
        if data is None:
            if path.exists():
                path.unlink()
        else:
            path.write_bytes(data)


from stub_env import NODE_STUB_PREFIXES, restore, snapshot

class _RealFolderPaths(unittest.TestCase):
    """gallery 模块在 import 期读 folder_paths.output_directory；同进程里节点类用例把
    server/comfy/folder_paths 换成了桩，这里进用例先摘掉桩、出来还原，不污染后续测试。"""

    @classmethod
    def _pin_real(cls):
        cls._saved = snapshot(NODE_STUB_PREFIXES)
        restore(NODE_STUB_PREFIXES, {})

    @classmethod
    def _restore_stubs(cls):
        restore(NODE_STUB_PREFIXES, cls._saved)



class _ServerCase(_RealFolderPaths):
    """共享一个服务实例：起进程贵，用例只读接口不互相干扰。"""

    @classmethod
    def setUpClass(cls):
        cls._pin_real()
        cls.app = ns.build_app(COMFY_ROOT, PLUGIN_DIR, {"starting": False})
        cls.tmpdir = Path(tempfile.mkdtemp(prefix="neo_studio_desktop_"))
        cls.app["userdata"] = cls.tmpdir / "neo_gallery_data.json"
        cls.app["comfy_log"] = cls.tmpdir / "comfy_run.log"
        cls.app["comfy_log"].write_text("desktop log line 1\ndesktop log line 2\n", encoding="utf-8")
        # MCP 注册表落在用例自己的临时目录：注册表写入用例不能碰真实数据根
        cls.mcp_config = cls.tmpdir / "mcp_servers.json"
        cls.app["mcp"] = mcp_client.McpManager(cls.mcp_config)
        cls.server = ns.DesktopServer(lambda: cls.app, TEST_PORT)
        cls.port = cls.server.start()

    @classmethod
    def tearDownClass(cls):
        cls.app["mcp"].close_all()   # 用例连过的外部 MCP 进程不能留到下一个测试进程外
        cls.server.stop()
        cls._restore_stubs()

    def get(self, path, data=None):
        return _request(self.port, path, data)

    def post_json(self, path, payload):
        return self.get(path, data=json.dumps(payload).encode())




class OfflineServiceTests(_ServerCase):
    def test_service_binds_and_serves_studio_page(self):
        status, body = self.get(STUDIO_URL)
        self.assertEqual(status, 200)
        self.assertIn(b"Neo Studio", body)

    def test_version_reports_offline_snapshot_and_caps(self):
        status, body = self.get("/neo_studio/version")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        self.assertTrue(data["offline"])
        self.assertNotEqual(data["comfyui_version"], "unknown")
        # 生成 / 显存类功能离线不可用；纯文件功能（宫格切分）可用
        self.assertFalse(data["caps"]["image_gen"])
        self.assertFalse(data["caps"]["director"])
        self.assertFalse(data["caps"]["simple_video"])
        self.assertFalse(data["caps"]["memory"])
        self.assertTrue(data["caps"]["grid_split"])

    def test_version_reports_desktop_starting_flag(self):
        # 冷启动那几秒 js_api 还没注入，页面靠这份快照知道「桌面端已拉起、端口未就绪」
        self.app["flags"]["starting"] = True
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertTrue(data["starting"], "桌面端拉起 ComfyUI 期间快照要报启动中")
        self.app["flags"]["starting"] = False
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertFalse(data["starting"], "没在拉起时不报启动中")

    def test_version_carries_the_route_ownership_table(self):
        # 页面钉在桌面端口后由前端判定归属：表由桌面端下发，前端不另立第二份清单
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertIn("GET /neo_gallery/list", data["routes"], "桌面端能服务的要列出来")
        self.assertNotIn("POST /neo_studio/director/generate", data["routes"],
                         "要执行队列的归 ComfyUI，页面直连过去")
        self.assertNotIn("POST /neo_video_gen/simple", data["routes"],
                         "简单视频生成要执行队列，页面直连 ComfyUI")

    def test_version_carries_the_direct_target_only_when_desktop_reports_it(self):
        # 空 = 这路 ComfyUI 不认桌面端 origin（未就绪 / 附着 / 远程），页面留在离线形态
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertEqual(data["comfy_base"], "")
        self.app["flags"]["comfy_base"] = "http://127.0.0.1:8188"
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertEqual(data["comfy_base"], "http://127.0.0.1:8188", "页面靠它把生成类请求原地切过去")
        self.app["flags"]["comfy_base"] = ""

    def test_version_carries_the_paths_for_the_about_page(self):
        # 「设置 → 关于」的路径行：数据根与 ComfyUI 根由 build_app 存进 app，远程地址读启动设置快照
        data_root = Path("F:/neo-data")
        self.app["data_root"] = data_root
        self.app["launcher"]["remote"] = "http://192.168.0.20:8188"
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertEqual(data["data_root"], str(data_root), "路径按本机分隔符交给页面")
        self.assertEqual(data["comfy_local"], str(COMFY_ROOT), "ComfyUI 根就是拉起它的那份根目录")
        self.assertEqual(data["remote"], "http://192.168.0.20:8188")
        self.app["data_root"] = None
        self.app["launcher"]["remote"] = ""
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertEqual(data["data_root"], "", "数据根没解析出来时出空串，页面收起该行")
        self.assertEqual(data["remote"], "", "连的本机时远程行不出")

    def test_comfy_state_needs_the_desktop_kernel_provider(self):
        # 引导页那一路桌面端还没装配出内核：没有 provider 就明说没有，不给前端一份假状态
        status, body = self.get("/neo_studio/comfy_state")
        self.assertEqual(status, 409)
        self.assertFalse(json.loads(body)["success"])

    def test_comfy_state_answers_the_kernel_snapshot(self):
        # 整页刷新后 pywebview 的桥晚于页面脚本注入，顶栏状态位靠这条路由从 HTTP 侧补上
        self.app["kernel_state"] = lambda: {"port": 8188, "pid": 4321, "mine": True,
                                            "running": True, "ready": True, "starting": False}
        try:
            status, body = self.get("/neo_studio/comfy_state")
        finally:
            self.app["kernel_state"] = None
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        self.assertEqual((data["port"], data["pid"], data["mine"], data["running"], data["ready"]),
                         (8188, 4321, True, True, True), "顶栏状态位要的字段一个都不能少")

    def test_extension_static_files_served(self):
        for path in ("/extensions/comfyui-neo-studio/studio/studio-app.js",
                     "/extensions/comfyui-neo-studio/studio/style.css",
                     "/extensions/comfyui-neo-studio/gallery.js"):
            self.assertEqual(self.get(path)[0], 200, path)

    def test_extension_static_files_not_cacheable(self):
        """桌面端窗口开着时改了插件 JS：缓存里的旧模块和新模块拼进同一张模块图，
        一个 ES 模块链接错误就把整页打回只出顶栏（视图不挂、胶囊永远 hidden）。"""
        path = "/extensions/comfyui-neo-studio/gallery-utils.js"
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=30) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Cache-Control"), "no-store", path)

    def test_gallery_browsing_routes_served(self):
        status, body = self.get("/neo_gallery/list?fields=dirs,items,covers&dir_name=output&path=")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["directories"])
        self.assertEqual(self.get("/neo_gallery/get_settings")[0], 200)
        self.assertEqual(self.get("/neo_gallery/css")[0], 200)
        self.assertEqual(self.get("/neo_gallery/placeholder.png")[0], 200)

    def test_gallery_sidecar_txt_route_served_offline(self):
        """云端预设的提示词全文要在桌面端可读：索引里的 txt_content 只有 500 字预览。"""
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertIn("GET /neo_gallery/txt", data["routes"])
        self.assertEqual(self.get("/neo_gallery/txt?filename=&subfolder=")[0], 400)

    def test_prompt_names_served_offline(self):
        """@ 点名弹层的图像/视频提示词候选要离线出得来：只读 prompts/ 目录的名字与标签，
        生成侧那条 list_prompts 带 mtime 与正文解析，不在桌面端的能力表里。"""
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertIn("POST /rs_prompts/list_prompt_names", data["routes"])
        status, body = self.post_json("/rs_prompts/list_prompt_names", {})
        self.assertEqual(status, 200)
        rows = json.loads(body)
        self.assertTrue([r for r in rows if r["source"] == "presets"], "内置 presets 要出得来")
        sources = [r["source"] for r in rows]
        self.assertEqual(sources, ["custom"] * sources.count("custom") + ["presets"] * sources.count("presets"),
                         "custom 在前、presets 在后，与 list_prompts 同序")
        for row in rows:
            self.assertFalse(row["name"].endswith(".txt"), "名字去掉 .txt 后缀")
            self.assertIsInstance(row["tags"], list)

    def test_agent_session_history_served_offline(self):
        """历史会话是数据根 agent_sessions/ 里的文件：列 / 读 / 删在桌面端就能做完，
        右栏空态的最近列表不该等 ComfyUI 起来才铺得出来。"""
        data = json.loads(self.get("/neo_studio/version")[1])
        for route in ("GET /neo_agent/sessions", "GET /neo_agent/session",
                      "POST /neo_agent/session/delete", "POST /neo_agent/session/delete_all"):
            self.assertIn(route, data["routes"])
        agent = sys.modules[f"{ns.DESKTOP_PKG}.agent"]
        run_id = "a" * 32
        session = agent.AGENT_SESSIONS_DIR / f"20260101-000000-{run_id}.json"
        session.parent.mkdir(parents=True, exist_ok=True)
        session.write_text(json.dumps({
            "version": 1, "run_id": run_id, "created": 1767225600, "mode": "act",
            "status": "succeeded", "input": {"text": "上一轮的首句", "images": [], "context": {}},
            "frames": [{"kind": "content", "text": "好了"}], "messages": [],
        }, ensure_ascii=False), encoding="utf-8")
        try:
            status, body = self.get("/neo_agent/sessions")
            self.assertEqual(status, 200)
            rows = json.loads(body)["sessions"]
            # 列表里本来就可能有这台机器上跑过的会话：认自己写的那一条在不在、摘要对不对，
            # 别假设数据根是空的——用户跑过一轮智能体之后这条就该炸
            mine = [r for r in rows if r["run_id"] == run_id]
            self.assertEqual(len(mine), 1, "自己写的那一条要在最近列表里")
            self.assertEqual(mine[0]["text"], "上一轮的首句")
            self.assertEqual(self.get(f"/neo_agent/session?run_id={run_id}")[0], 200)
        finally:
            session.unlink(missing_ok=True)

    def test_backyard_upload_plan_served_offline(self):
        """上传页打开就列待上传目录，这份清单在桌面端窗口里也要出得来。"""
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertIn("GET /neo_backyard/upload_plan", data["routes"])
        self.assertEqual(self.get("/neo_backyard/upload_plan")[0], 400)
        dist = Path(tempfile.mkdtemp(prefix="neo_backyard_plan_", dir=str(self.tmpdir)))
        (dist / "仙侠玄幻人物").mkdir()
        (dist / "仙侠玄幻人物" / "001.png").write_bytes(b"png")
        (dist / "index.json").write_text(json.dumps({"version": 2, "directories": {
            "仙侠玄幻人物": {"count": 1, "index": "仙侠玄幻人物/index.json", "rev": "R1", "covers": []},
        }}, ensure_ascii=False), encoding="utf-8")
        status, body = self.get(f"/neo_backyard/upload_plan?source_dir={urllib.parse.quote(str(dist))}")
        self.assertEqual(status, 200)
        plan = json.loads(body)
        self.assertTrue(plan["success"])
        self.assertEqual(plan["directories"][0]["name"], "仙侠玄幻人物")

    def test_model_lists_see_extra_model_paths(self):
        """模型目录要在桌面端进程里可见：extra_model_paths.yaml 只有 ComfyUI 的 main.py 会加载，
        桌面端不自己加载的话 get_filename_list 只扫 <root>/models/，模型落在 extra 路径的机器上
        离线页的模型下拉就是空表，技能里已存的模型路径全标「(缺失)」。"""
        if not (COMFY_ROOT / "extra_model_paths.yaml").is_file():
            self.skipTest("这台机器的 ComfyUI 根没有 extra_model_paths.yaml")
        import folder_paths
        extra = [p for p in folder_paths.get_folder_paths("diffusion_models")
                 if not Path(p).is_relative_to(COMFY_ROOT)]
        self.assertTrue(extra, "extra_model_paths.yaml 里的模型目录要在桌面端进程可见")
        data = json.loads(self.get("/neo_image_gen/models")[1])
        self.assertTrue(data["diffusion_models"], "模型下拉不能是空表")
        missing = [f for f in data["diffusion_models"] if f not in data["mtimes_diffusion_models"]]
        self.assertEqual(missing, [], "下拉要给出每个模型的修改时间（mtimes_diffusion_models）")

    def test_thumbnail_generated_without_comfyui(self):
        query = urllib.parse.urlencode({"filename": SAMPLE[1], "subfolder": SAMPLE[0]})
        status, body = self.get(f"/neo_gallery/thumbnail?{query}")
        self.assertEqual(status, 200)
        self.assertIn(body[:3], (b"\xff\xd8\xff", b"\x89PNG"))

    def test_userdata_round_trip(self):
        payload = json.dumps({"sectionStates": {"gallery_categories": {"collapsed": True}}}).encode()
        status, body = self.get(ns.USERDATA_PATH, data=payload)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["success"])
        status, body = self.get(ns.USERDATA_PATH)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["sectionStates"]["gallery_categories"]["collapsed"], True)

    def test_offline_log_reads_comfy_run_log(self):
        status, body = self.get("/neo_studio/log")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        self.assertIn("desktop log line 2", "".join(e["m"] for e in data["entries"]))

    def test_launcher_snapshot_and_apply(self):
        # 设置页读的是桌面端的启动快照；保存由桌面端校验并重启 ComfyUI
        self.app["launcher"].update(root="D:/ComfyUI", python="D:/python/python.exe", port=8188,
                                    plugin_dir="D:/ComfyUI/custom_nodes/comfyui-neo-studio",
                                    state_dir="D:/studio/data", portable=True, state="ok", error="",
                                    listen="127.0.0.1,192.168.0.7", lan_ips=["192.168.0.7"],
                                    remote="http://192.168.0.20:8188")
        applied = []
        self.app["launcher_api"]["apply"] = (
            lambda root, python, port, listen, remote: applied.append((root, python, port, listen, remote))
            or {"ok": True, "state": "ok"})
        status, body = self.get("/neo_studio/launcher")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["plugin_dir"], "D:/ComfyUI/custom_nodes/comfyui-neo-studio")
        self.assertEqual(data["state"], "ok")
        self.assertEqual(data["listen"], "127.0.0.1,192.168.0.7")
        self.assertEqual(data["lan_ips"], ["192.168.0.7"])
        self.assertEqual(data["remote"], "http://192.168.0.20:8188")
        status, body = self.post_json("/neo_studio/launcher",
                                      {"root": "E:/ComfyUI", "python": "E:/py/python.exe", "port": 8190,
                                       "listen": "0.0.0.0", "remote": "http://10.0.0.5:8188"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        self.assertEqual(applied, [("E:/ComfyUI", "E:/py/python.exe", 8190, "0.0.0.0", "http://10.0.0.5:8188")])
        # 旧载荷没有 listen / remote：传 None = 这次不动这两项
        self.post_json("/neo_studio/launcher", {"root": "E:/ComfyUI", "python": "E:/py/python.exe", "port": 8190})
        self.assertEqual(applied[-1], ("E:/ComfyUI", "E:/py/python.exe", 8190, None, None))

    def test_launcher_retry_actions(self):
        calls = []
        self.app["launcher_api"]["install_plugin"] = lambda: calls.append("plugin") or {"ok": True}
        self.app["launcher_api"]["install_deps"] = lambda: calls.append("deps") or {"ok": True}
        for action in ("install_plugin", "install_deps"):
            status, body = self.post_json("/neo_studio/launcher", {"action": action})
            self.assertEqual(status, 200, action)
            self.assertTrue(json.loads(body)["ok"], action)
        self.assertEqual(calls, ["plugin", "deps"])

    def test_launcher_toggle_actions_carry_their_flag(self):
        got = []
        self.app["launcher_api"]["set_frameless"] = lambda on: got.append(("frameless", on)) or {"ok": True}
        self.app["launcher_api"]["set_dev_mode"] = lambda on: got.append(("dev_mode", on)) or {"ok": True}
        for action, key in (("set_frameless", "frameless"), ("set_dev_mode", "dev_mode")):
            status, body = self.post_json("/neo_studio/launcher", {"action": action, key: True})
            self.assertEqual(status, 200, action)
            self.assertTrue(json.loads(body)["ok"], action)
            status, body = self.post_json("/neo_studio/launcher", {"action": action, key: False})
            self.assertEqual(status, 200, action)
        self.assertEqual(got, [("frameless", True), ("frameless", False),
                               ("dev_mode", True), ("dev_mode", False)])

    def test_launcher_post_rejects_unknown_action(self):
        status, body = self.post_json("/neo_studio/launcher", {"action": "rm_root"})
        self.assertEqual(status, 400)
        self.assertFalse(json.loads(body)["ok"])

    def test_comfy_only_routes_report_offline(self):
        for path in COMFY_ONLY_ROUTES:
            status, body = self.get(path, data=b"{}")
            self.assertEqual(status, 409, path)
            data = json.loads(body)
            self.assertFalse(data["success"])
            self.assertTrue(data["offline"])


    def test_mem_stats_reports_offline(self):
        status, _ = self.get("/neo_studio/mem_stats")
        self.assertEqual(status, 409)

    def test_llm_config_and_title_routes_served_offline(self):
        """LLM 配置只读配置文件、标题提取只打 8080：与 ComfyUI 运行时无关，桌面端必须服务"""
        status, body = self.get("/rs_prompts/llm_mode")
        self.assertEqual(status, 200)
        self.assertIn("mode", json.loads(body))
        status, body = self.get("/rs_prompts/remote_llm_config")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["provider_list"])
        self.assertEqual(self.get("/rs_prompts/get_models")[0], 200)
        self.assertEqual(self.get("/rs_prompts/native_models")[0], 200)
        status, body = self.post_json("/rs_prompts/extract_title",
                                      {"text": "一位年轻女性端坐于户外木质椅子上，身着碎花裙，背景是花园"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["title"])


class DesktopWriteTests(_ServerCase):
    """离线可编辑面：设置 / 收藏 / 配方 / 技能都是真实落盘写入。"""

    def setUp(self):
        self.configs = _data_root() / "configs"
        self._saved = _snapshot(tuple(self.configs / n for n in WRITE_FILES))
        self._extra_dirs = []

    def tearDown(self):
        _restore(self._saved)
        for d in self._extra_dirs:
            shutil.rmtree(d, ignore_errors=True)

    def test_image_gen_settings_round_trip(self):
        status, body = self.post_json("/neo_image_gen/settings", {"output_prefix": "ShellWrite"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["output_prefix"], "ShellWrite")
        status, body = self.get("/neo_image_gen/settings")
        self.assertEqual(json.loads(body)["output_prefix"], "ShellWrite")

    def test_bookmark_local_add_and_list(self):
        status, body = self.post_json("/neo_bookmark/local/add",
                                      {"name": "ShellBookmark", "source": "local",
                                       "dir": "output", "subfolder": ""})
        self.assertEqual(status, 200, body)
        status, body = self.get("/neo_bookmark/local")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(any(i.get("name") == "ShellBookmark" for i in data["items"]))

    def test_recipe_save_and_list(self):
        name = "desktop-test-recipe"
        status, body = self.post_json("/rs_recipes/save", {"name": name, "prompt": "desktop offline"})
        self.assertEqual(status, 200, body)
        recipe_dir = _data_root() / "recipes" / "custom" / name
        self._extra_dirs.append(recipe_dir)
        self.assertTrue((recipe_dir / "recipe.json").is_file())
        status, body = self.post_json("/rs_recipes/list", {"source": "custom"})
        self.assertEqual(status, 200)
        self.assertTrue(any(r.get("name") == name for r in json.loads(body)))

    def test_skill_save_and_delete(self):
        skill_id = "desktop_test_skill"
        status, body = self.post_json("/rs_prompts/save_skill",
                                      {"id": skill_id, "name": "Desktop Test Skill",
                                       "content": "# desktop\n离线写入", "source": "custom"})
        self.assertEqual(status, 200, body)
        skill_dir = _data_root() / "skills" / "custom" / skill_id
        self._extra_dirs.append(skill_dir)
        self.assertTrue((skill_dir / "skill.md").is_file())
        status, body = self.post_json("/rs_prompts/delete_skill",
                                      {"id": skill_id, "source": "custom"})
        self.assertEqual(status, 200, body)
        self.assertFalse(skill_dir.exists())

    def test_llm_config_round_trip_masks_key(self):
        """离线写 LLM 配置：密钥真实落盘，接口回读只给掩码"""
        desktop_llm = sys.modules[f"{ns.DESKTOP_PKG}.llm"]
        status, body = self.post_json("/rs_prompts/remote_llm_config",
                                      {"provider": "openai", "api_key": "sk-desktop-secret",
                                       "base_url": "https://api.openai.com/v1",
                                       "model": "gpt-4o-mini"})
        self.assertEqual(status, 200, body)
        self.assertTrue(json.loads(body)["success"])
        status, body = self.get("/rs_prompts/remote_llm_config")
        slot = json.loads(body)["providers"]["openai"]
        self.assertEqual(status, 200)
        self.assertEqual(slot["api_key"], desktop_llm.API_KEY_MASK)
        self.assertEqual(slot["model"], "gpt-4o-mini")
        saved = json.loads((self.configs / "remote_llm_config.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["providers"]["openai"]["api_key"], "sk-desktop-secret")



class DesktopModuleTests(_RealFolderPaths):
    """桌面端模块族必须自带路由表、不碰 ComfyUI 运行时，且与能力清单一致。"""

    @classmethod
    def setUpClass(cls):
        cls._pin_real()

    @classmethod
    def tearDownClass(cls):
        cls._restore_stubs()

    def test_desktop_modules_carry_own_route_tables(self):
        from aiohttp import web
        tables = ns.load_desktop_modules(PLUGIN_DIR)
        self.assertEqual(len(tables), len(ns.DESKTOP_ROUTE_MODULES))
        for table in tables:
            self.assertIsInstance(table, web.RouteTableDef)
            self.assertTrue(len(table) > 0)

    def test_desktop_modules_do_not_import_comfyui_runtime(self):
        """import 期不碰 ComfyUI 运行时：函数内的惰性导入有兜底，不算。"""
        forbidden = ("from server", "import server", "import nodes", "from nodes",
                     "from comfy", "import comfy", "import torch", "from torch",
                     "from comfy_api", "import pynvml")
        for name in ns.DESKTOP_MODULES:
            for line in (PLUGIN_DIR / f"{name}.py").read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if line[:1].isspace() or stripped.startswith("#"):
                    continue
                for word in forbidden:
                    self.assertNotIn(word, stripped, f"{name}.py: {stripped}")

    def test_capability_manifest_matches_module_routes(self):
        registered = {(r.method, r.path)
                      for table in ns.load_desktop_modules(PLUGIN_DIR) for r in table}
        # MCP 是桌面端自己的一层（浏览器 spawn 不了 stdio 子进程），路由表在 app 层不在插件层
        registered |= {(r.method, r.path) for r in mcp_routes.routes}
        self.assertFalse(caps.DESKTOP_ROUTES - registered,
                         f"能力清单里的桌面端路由在模块里不存在: {sorted(caps.DESKTOP_ROUTES - registered)}")

    def test_route_list_is_the_manifest_in_wire_form(self):
        # 下发给页面的归属表就是这张表，不在前端另立第二份
        self.assertEqual(set(caps.route_list()),
                         {f"{method} {path}" for method, path in caps.DESKTOP_ROUTES})

    def test_desktop_app_mounts_exactly_the_manifest(self):
        app = ns.build_app(COMFY_ROOT, PLUGIN_DIR)
        desktop_pages = {("GET", "/neo-studio"), ("GET", "/neo_studio/version"),
                       ("GET", "/neo_studio/comfy_state"),
                       ("GET", "/neo_studio/log"), ("GET", "/neo_studio/launcher"),
                       ("POST", "/neo_studio/launcher")}
        mounted = {(r.method, r.resource.canonical) for r in app.router.routes()
                   if r.method != "HEAD" and r.resource.canonical.startswith(("/neo", "/rs_"))}
        self.assertEqual(mounted - desktop_pages, caps.DESKTOP_ROUTES)


# 路由用例用的最小 MCP 服务：UTF-8 的 NDJSON over stdio，规范三步齐全
FAKE_MCP = '''
import json, sys

TOOLS = {"tools": [{"name": "ping", "description": "ping", "inputSchema":
        {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]}


def send(msg):
    sys.stdout.buffer.write((json.dumps(msg, ensure_ascii=False) + "\\n").encode("utf-8"))
    sys.stdout.buffer.flush()


for raw in sys.stdin.buffer:
    msg = json.loads(raw.decode("utf-8"))
    if "id" not in msg:
        continue
    if msg["method"] == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result":
              {"protocolVersion": "2025-06-18", "capabilities": {},
               "serverInfo": {"name": "route-mcp", "version": "1"}}})
    elif msg["method"] == "tools/list":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": TOOLS})
    else:
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"content": [{"type": "text",
              "text": msg["params"]["arguments"].get("text", "")}]}})
'''


class McpRouteTests(_ServerCase):
    """外部 MCP 服务只在桌面端进程里连：页面拿到注册表、工具表与调用结果，密钥不回显。"""

    def setUp(self):
        # 服务实例是整族用例共用的，注册表与在连会话要逐条用例复位，不能靠执行顺序
        self.app["mcp"].close_all()
        if self.mcp_config.exists():
            self.mcp_config.unlink()

    def test_registry_starts_empty(self):
        data = json.loads(self.get("/neo_mcp/servers")[1])
        self.assertEqual(data["servers"], [])
        self.assertEqual(data["connected"], [])

    def test_registry_round_trip_masks_the_secret(self):
        status, body = self.post_json("/neo_mcp/servers", {"servers": [
            {"name": "demo", "transport": "stdio", "command": "node", "args": ["server.js"],
             "env": {"API_KEY": "super-secret"}}]})
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["servers"][0]["env"], {"API_KEY": "***"})
        self.assertNotIn("super-secret", body.decode("utf-8"), "响应里不能把密钥带回浏览器")
        self.assertIn("super-secret", self.mcp_config.read_text(encoding="utf-8"), "密钥只留本机")
        self.assertEqual(json.loads(self.get("/neo_mcp/servers")[1])["servers"][0]["name"], "demo")

    def test_registry_validation_error_is_reported_to_the_page(self):
        data = json.loads(self.post_json("/neo_mcp/servers", {"servers": [
            {"name": "demo", "transport": "http", "url": "ftp://a/mcp"}]})[1])
        self.assertFalse(data["success"])
        self.assertIn("HTTP 地址无效", data["error"])

    def test_registry_post_without_servers_is_a_bad_request(self):
        self.assertEqual(self.post_json("/neo_mcp/servers", {})[0], 400)

    def test_tools_list_is_empty_without_a_connection(self):
        data = json.loads(self.get("/neo_mcp/tools")[1])
        self.assertEqual(data["tools"], [])
        self.assertEqual(data["connected"], [])

    def test_connect_to_an_unregistered_server_reports_it(self):
        data = json.loads(self.post_json("/neo_mcp/connect", {"name": "ghost"})[1])
        self.assertFalse(data["success"])
        self.assertIn("未注册", data["error"])

    def test_call_without_a_connection_reports_it(self):
        data = json.loads(self.post_json("/neo_mcp/tools/call",
                                         {"name": "ghost", "tool": "x", "arguments": {}})[1])
        self.assertFalse(data["success"])
        self.assertIn("未连接", data["error"])

    def test_disconnect_is_idempotent(self):
        self.assertTrue(json.loads(self.post_json("/neo_mcp/disconnect", {"name": "ghost"})[1])["success"])

    def test_connect_through_the_route_lists_the_tools(self):
        script = self.tmpdir / "route_mcp_server.py"
        script.write_text(FAKE_MCP, encoding="utf-8")
        self.post_json("/neo_mcp/servers", {"servers": [
            {"name": "demo", "transport": "stdio", "command": sys.executable, "args": [str(script)]}]})
        data = json.loads(self.post_json("/neo_mcp/connect", {"name": "demo"})[1])
        self.assertTrue(data["success"], data)
        self.assertEqual([t["name"] for t in data["tools"]], ["ping"])
        self.assertEqual(json.loads(self.get("/neo_mcp/tools")[1])["connected"], ["demo"])
        data = json.loads(self.post_json("/neo_mcp/tools/call",
                                         {"name": "demo", "tool": "ping", "arguments": {"text": "hi"}})[1])
        self.assertEqual(data["result"]["content"][0]["text"], "hi")
        self.assertTrue(json.loads(self.post_json("/neo_mcp/disconnect", {"name": "demo"})[1])["success"])
        self.assertEqual(json.loads(self.get("/neo_mcp/tools")[1])["connected"], [])

    def test_mcp_routes_are_listed_in_the_ownership_table(self):
        data = json.loads(self.get("/neo_studio/version")[1])
        self.assertIn("GET /neo_mcp/servers", data["routes"])
        self.assertIn("POST /neo_mcp/tools/call", data["routes"])
        self.assertTrue(data["caps"]["mcp"], "MCP 只有桌面端能服务，页面据此门控")

    # 局域网监听 / 附着那路的页面在 ComfyUI 端口上：MCP 族跨源打回桌面端口，浏览器要这份响应头
    def full(self, path, method=None, headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method,
                                     headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status, {k.lower(): v for k, v in resp.headers.items()}
        except urllib.error.HTTPError as exc:
            return exc.code, {k.lower(): v for k, v in exc.headers.items()}

    def test_mcp_answers_cross_origin_from_a_loopback_page(self):
        status, headers = self.full("/neo_mcp/servers", headers={"Origin": "http://127.0.0.1:8188"})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("access-control-allow-origin"), "http://127.0.0.1:8188")

    def test_mcp_preflight_allows_the_json_post(self):
        status, headers = self.full("/neo_mcp/tools/call", method="OPTIONS", headers={
            "Origin": "http://127.0.0.1:8188", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type"})
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("access-control-allow-origin"), "http://127.0.0.1:8188")
        self.assertEqual(headers.get("access-control-allow-headers"), "Content-Type")

    def test_mcp_refuses_a_page_from_outside_the_machine(self):
        # 外部站点把域名解析到回环（DNS 重绑）也拿不到 MCP 子进程：不回过源头，预检直接 403
        status, headers = self.full("/neo_mcp/servers", headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 200, "响应照发，浏览器按缺响应头自己拦")
        self.assertNotIn("access-control-allow-origin", headers)
        status, headers = self.full("/neo_mcp/connect", method="OPTIONS",
                                    headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("access-control-allow-origin", headers)

    def test_mcp_keeps_working_without_an_origin(self):
        # 本机脚本 / 单测不带 Origin：与以前一样拿注册表，响应里不掺 CORS 头
        status, headers = self.full("/neo_mcp/servers")
        self.assertEqual(status, 200)
        self.assertNotIn("access-control-allow-origin", headers)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """短路径的 302 要看得见面包缺没缺：跟着跑就只能看见入口页正文。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PoseBridgeTests(_ServerCase):
    """3D 摆姿页在桌面端离线服务里的形态：页面、子资源前缀、场景往返与能力门控。

    摆姿包（3d-pose-art 的 vite 产物）装在数据根 <data_root>/pose/dist/，装没装逐请求判断。
    产物文件与场景都写在这个目录下，用例只删自己创建的文件。"""

    def setUp(self):
        self.pose_dir = _data_root() / "pose"
        self.pose_module = sys.modules[f"{ns.DESKTOP_PKG}.pose"]
        self.created = []
        # 随包副本（studio/pose_dist）挪开：这一组用例单独看数据根那一级，兜底行为由下面那条用例单独测
        self._real_pkg_dist = self.pose_module.PACKAGE_DIST
        self.pose_module.PACKAGE_DIST = _data_root() / "unit_pkg_dist_missing"

    def tearDown(self):
        self.pose_module.PACKAGE_DIST = self._real_pkg_dist
        for path in self.created:
            try:
                path.unlink(missing_ok=True)
            except PermissionError:
                # Windows 上 FileResponse 的文件句柄要等 executor 线程收尾才释放，机器忙时这一下
                # 落在 tearDown 之后。用例写的是 conftest 钉下的临时数据根，退出时整棵摘掉。
                pass

    def write(self, path: Path, content: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        self.created.append(path)
        return path

    def get_full(self, path):
        """要读响应头：子资源的 MIME 与缓存策略就是这条前缀的全部行为。"""
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(f"http://127.0.0.1:{self.port}{path}", timeout=20) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def test_status_carries_caps_and_install_state(self):
        status, body = self.get("/neo_pose/status")
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        # 摆姿、时间轴、导出全在浏览器里跑，离线服务只给文件；估点/网格/pano 要 pose-art 那套
        # Python sidecar，桌面端进程起不动，页面按这几位置灰控件。自备素体导入是桌面端自己那条路。
        self.assertTrue(data["caps"]["pose"])
        self.assertTrue(data["caps"]["export"])
        self.assertTrue(data["caps"]["body_import"])
        for sidecar_only in ("photo3d", "mesh", "pano", "lib_write"):
            self.assertFalse(data["caps"][sidecar_only], f"{sidecar_only} 在桌面端不可用")
        self.assertEqual(data["installed"], (self.pose_dir / "dist" / "index.html").is_file())
        self.assertEqual(data["bridge"], list(self.pose_module.BRIDGE_MESSAGES),
                         "桥消息名单由后端下发，宿主与摆姿页都按它校验")
        # 两级落点与随包清单都在 status 里：装机的人一眼看到页面跑在哪一级、装到了什么
        for key in ("dist_source", "package_installed", "models_present", "manifest_version",
                    "lib_dir", "lib_installed", "lib_entries"):
            self.assertIn(key, data, f"status 要报出 {key}")

    def test_package_copy_serves_the_page_when_data_root_is_empty(self):
        """随包副本是兜底那一级：数据根没装摆姿包时，页面与 CC0 素体都从插件目录里出来。"""
        pkg = self.pose_module.PACKAGE_DIST
        self.pose_module.PACKAGE_DIST = self.pose_dir / "unit_pkg_copy"
        try:
            self.write(self.pose_module.PACKAGE_DIST / "index.html",
                       '<!doctype html><html><body>pose-unit-pkg</body></html>')
            self.write(self.pose_module.PACKAGE_DIST / "models" / "ybot.glb", "glb-bytes")
            status, data = self.get("/neo_pose/status")
            payload = json.loads(data)
            self.assertTrue(payload["installed"])
            self.assertEqual(payload["dist_source"], "package")
            self.assertTrue(payload["package_installed"])
            self.assertEqual(payload["models_present"], ["ybot.glb"])
            status, body = self.get("/neo-pose")
            self.assertEqual(status, 200, "兜底那一级要接住短路径的跳转")
            self.assertIn(b"pose-unit-pkg", body)
            status, _, _ = self.get_full("/pose-dist/models/ybot.glb")
            self.assertEqual(status, 200)
        finally:
            self.pose_module.PACKAGE_DIST = pkg

    def test_page_route_serves_pose_page_once_dist_is_there(self):
        """iframe 的 src 就是这条短路径：短路径跳到前缀下的入口页，产物才有相对深度可解析。"""
        self.write(self.pose_dir / "dist" / "index.html",
                   '<!doctype html><html><body>pose-unit-page</body></html>')
        status, body = self.get("/neo-pose")
        self.assertEqual(status, 200, "302 要跟着走到前缀下的入口页")
        self.assertIn(b"pose-unit-page", body)

    def test_page_route_says_the_package_is_missing(self):
        (self.pose_dir / "dist" / "index.html").unlink(missing_ok=True)
        status, body = self.get("/neo-pose")
        self.assertEqual(status, 404)
        self.assertIn("未安装".encode(), body, "缺包要说清楚，不能让 iframe 自己黑屏")

    def test_dist_prefix_serves_wasm_and_hashes_only_assets(self):
        self.write(self.pose_dir / "dist" / "assets" / "pose_unit-abc.wasm", "wasm-bytes")
        self.write(self.pose_dir / "dist" / "pose_unit.svg", "<svg/>")
        status, headers, body = self.get_full("/pose-dist/assets/pose_unit-abc.wasm")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "application/wasm",
                         "WebView 按 MIME 编译，text/plain 的话 wasm 解码直接失败")
        self.assertIn("immutable", headers.get("Cache-Control", ""))

        status, headers, _ = self.get_full("/pose-dist/pose_unit.svg")
        self.assertEqual(status, 200)
        self.assertNotIn("immutable", headers.get("Cache-Control", ""),
                         "无哈希的产物改动即失效，不能让它缓存一年")

    def test_dist_prefix_stays_inside_the_package(self):
        status, _, _ = self.get_full("/pose-dist/../../configs/data_root.json")
        self.assertIn(status, (400, 404), "前缀不能把数据根里的配置发出去")

    def test_pose_lib_prefix_serves_the_synced_library(self):
        """姿势库弹窗跑在离线窗口里：库文件按 `/pose-lib/` 这条前缀伺服，弹窗读的就是这些地址。"""
        index = {"format": "3dpose.index/1",
                 "entries": [{"id": "a", "label": "A-Pose", "path": "poses/stand/a.pose.json",
                             "groups": ["stand"], "preview": {"clay": "preview/a.clay.png"}}]}
        self.write(self.pose_dir / "lib" / "index.json", json.dumps(index, ensure_ascii=False))
        self.write(self.pose_dir / "lib" / "poses" / "stand" / "a.pose.json",
                   '{"format":"pose-file/v1","rig":{}}')
        status, headers, body = self.get_full("/pose-lib/index.json")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["entries"][0]["id"], "a")
        status, headers, _ = self.get_full("/pose-lib/poses/stand/a.pose.json")
        self.assertEqual(status, 200, "弹窗按 entry.path 取姿态文件交回 pose/apply")
        self.assertNotIn("immutable", headers.get("Cache-Control", ""),
                         "库会被同步脚本重新生成，不许长缓存")
        status, _, _ = self.get_full("/pose-lib/../../scenes/unit_pose_scene.json")
        self.assertIn(status, (400, 404), "这条前缀不能把库外的文件发出去")
        status, _, _ = self.get_full("/pose-lib/no_such.pose.json")
        self.assertEqual(status, 404)

    def test_models_prefix_serves_the_registries_the_page_asks_for(self):
        """道具与素体注册表在产物里写的是 origin 根上的绝对路径 /models/...：页面挂在
        /pose-dist/ 下时这些请求落回 origin 根，只有前缀伺服的话注册表就是空的 ——
        道具面板一条都不出、加具逐条失败，页面不会说「缺包」，只会一直说加具失败。"""
        pkg = self.pose_module.PACKAGE_DIST
        self.pose_module.PACKAGE_DIST = self.pose_dir / "unit_models_pkg"
        try:
            pkg_dist = self.pose_module.PACKAGE_DIST
            self.write(pkg_dist / "index.html", '<!doctype html><html><body>pose-unit-pkg</body></html>')
            self.write(pkg_dist / "models" / "props" / "index.json",
                       json.dumps({"props": [{"file": "box.glb", "label": "箱体"}]}, ensure_ascii=False))
            self.write(pkg_dist / "models" / "props" / "box.glb", "glTF\x02unit-prop")

            status, headers, body = self.get_full("/models/props/index.json")
            self.assertEqual(status, 200, "道具注册表要按页面写死的那条路径答出来")
            self.assertEqual(json.loads(body)["props"][0]["file"], "box.glb")

            status, headers, _ = self.get_full("/models/props/box.glb")
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("Content-Type"), "model/gltf-binary",
                             "注册表里的 file 就按这条路径取，MIME 不对页面解不出几何")

            # 自备素体落进数据根后，页面同样按 /models/<key>.glb 取它
            import base64
            saved = json.loads(self.post_json("/neo_pose/import_model", {
                "key": "unit_models_body",
                "data": base64.b64encode(b"glTF\x02" + b"unit-models-body").decode()})[1])
            self.created.append(self.pose_dir / "dist" / "models" / "unit_models_body.glb")
            status, _, _ = self.get_full("/models/unit_models_body.glb")
            self.assertEqual(status, 200, f"导入回来的 {saved['key']} 要在这条前缀上取得到")

            # 数据根那份压住随包的同名文件：道具注册表按数据根那条答
            self.write(self.pose_dir / "dist" / "models" / "props" / "index.json",
                       json.dumps({"props": [{"file": "wide.glb", "label": "全量"}]}, ensure_ascii=False))
            status, _, body = self.get_full("/models/props/index.json")
            self.assertEqual(json.loads(body)["props"][0]["file"], "wide.glb")

            status, _, _ = self.get_full("/models/../../launcher_config.json")
            self.assertIn(status, (400, 404), "这条前缀不能把摆姿包 models 之外的文件发出去")
        finally:
            self.pose_module.PACKAGE_DIST = pkg

    def test_scene_round_trip_offline(self):
        saved = json.loads(self.post_json("/neo_pose/scene",
                                          {"name": "pose_unit_scene", "scene": {"camYaw": 42}})[1])
        self.assertTrue(saved["success"])
        try:
            rows = json.loads(self.get("/neo_pose/scenes")[1])["scenes"]
            self.assertIn("pose_unit_scene", [row["name"] for row in rows])
            scene = json.loads(self.get("/neo_pose/scene?name=pose_unit_scene")[1])["scene"]
            self.assertEqual(scene["camYaw"], 42)
        finally:
            (self.pose_dir / "scenes" / "pose_unit_scene.json").unlink(missing_ok=True)

    def test_pose_routes_are_desktop_owned(self):
        """页面与桥接口归桌面端；子资源前缀是静态伺服，不进能力表。

        逐条核对摆姿模块注册的那张表：能力归属表漏一条，桌面端就会把那个接口报成「要 ComfyUI 在跑」。"""
        registered = {(route.method.upper(), route.path) for route in self.pose_module.routes}
        missing = sorted(item for item in registered
                         if item[1].startswith("/neo") and item not in caps.DESKTOP_ROUTES)
        self.assertEqual(missing, [], "这些桥接口没登记进桌面端能力表")
        self.assertEqual(caps.owner("GET", "/neo-pose"), "desktop")
        self.assertEqual(caps.owner("GET", "/neo_pose/status"), "desktop")
        self.assertEqual(caps.owner("POST", "/neo_pose/export_image"), "desktop")
        self.assertEqual(caps.owner("POST", "/neo_pose/scene"), "desktop")
        self.assertEqual(caps.owner("POST", "/neo_pose/import_model"), "desktop",
                         "自备素体导入是桌面端自己那条路，不依赖 ComfyUI 运行时")
        self.assertNotIn(("GET", "/pose-dist/{path}"), caps.DESKTOP_ROUTES,
                         "整条前缀逐条打表只会让能力表里的条目数随构建产物变动")
        self.assertNotIn(("GET", "/models/{path}"), caps.DESKTOP_ROUTES,
                         "道具注册表与素体 GLB 的根前缀也是静态伺服，与子资源同一条路")
        self.assertNotIn(("GET", "/pose-lib/{path:.*}"), caps.DESKTOP_ROUTES,
                         "姿势库的整条前缀同静态伺服，不进能力表")

    def test_import_model_offline_lands_in_data_root(self):
        """离线服务里导入一份自备 GLB：落点在数据根的 pose/dist/models，页面那条前缀取得到。"""
        import base64
        payload = base64.b64encode(b"glTF\x02\x00\x00\x00" + bytes(32)).decode()
        status, body = self.post_json("/neo_pose/import_model", {"key": "unit_body", "data": payload})
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data["success"])
        self.assertEqual(data["url"], "/pose-dist/models/unit_body.glb")
        dest = self.pose_dir / "dist" / "models" / "unit_body.glb"
        self.created.append(dest)
        self.assertTrue(dest.is_file())
        status, _, raw = self.get_full("/pose-dist/models/unit_body.glb")
        self.assertEqual(status, 200)
        self.assertEqual(raw[:4], b"glTF")
        status, body = self.post_json("/neo_pose/import_model", {"key": "../escape", "data": payload})
        self.assertEqual(status, 400, "key 里不许有路径")

    def test_import_model_accepts_real_glb_size(self):
        """真实素体体积的那一份要进得来：aiohttp 默认只收 1MB 请求体，桌面端不抬高就会 413。

        插件端那条走 ComfyUI 自己的 app（--max-upload-size 默认 100MB），桌面端这条是自建 app，
        两边体积口径必须一致，否则「自备素体」在插件端能跑、在独立窗口里就是死路。
        """
        import base64
        big = b"glTF\x02\x00\x00\x00" + bytes(2 * 1024 * 1024)   # 2MB，远超 transport 默认上限
        status, body = self.post_json("/neo_pose/import_model",
                                      {"key": "unit_big", "data": base64.b64encode(big).decode()})
        self.assertEqual(status, 200, f"2MB 素体导入被挡：{status} {body[:200]}")
        dest = self.pose_dir / "dist" / "models" / "unit_big.glb"
        self.created.append(dest)
        self.assertEqual(dest.stat().st_size, len(big))

    def test_import_model_caps_are_reported_by_the_interface(self):
        """体积上限由接口说清楚，而不是 transport 抢答：超 GLB 上限与超请求体上限都回 400。"""
        import base64
        over_glb = base64.b64encode(b"glTF\x02\x00\x00\x00"
                                    + bytes(self.pose_module.MAX_GLB_BYTES + 1)).decode()
        status, body = self.post_json("/neo_pose/import_model",
                                      {"key": "unit_over", "data": over_glb})
        self.assertEqual(status, 400)
        self.assertIn("GLB 超过", json.loads(body)["error"], "要说的是素体上限，不是请求体上限")
        (self.pose_dir / "dist" / "models" / "unit_over.glb").unlink(missing_ok=True)
        over_body = json.dumps({"key": "unit_over2", "data": "A" * (self.pose_module.MAX_BODY_BYTES + 1)})
        status, body = self.get("/neo_pose/import_model", data=over_body.encode())
        self.assertEqual(status, 400)
        self.assertIn("请求体超过", json.loads(body)["error"], "请求体上限也要由接口回 400")


if __name__ == "__main__":
    unittest.main()
