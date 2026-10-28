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



def _request(port, path, data=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data)
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


if __name__ == "__main__":
    unittest.main()
