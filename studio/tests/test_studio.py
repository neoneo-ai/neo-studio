#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""studio（Neo Studio 整片生成）离线单测。

复用 test_h3_video_director 的桩环境（server / comfy / folder_paths + 真实 recipes 模块），
在其中加载 studio。覆盖：_run_prompt 两节点图组装与校验、generate/status/cancel 三个路由、
任务 watcher 的进度/完成/配方记账，以及 version 路由。
"""

import asyncio
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from test_h3_video_director import (   # noqa: E402  —— 复用同一套桩与工具
    _OUTPUT_DIR,
    _comfy_mm,
    _folder_paths,
    _load,
    _server,
    recipes,
)

studio = _load("studio", "studio.py")
# 全套件运行时，其它测试模块会替换 sys.modules["server"] 为各自的桩；
# 把 studio 固定到本套件的 server 桩（带 send_sync / prompt_queue）。
studio.PromptServer = _server.PromptServer


class _RecipeCase(unittest.TestCase):
    """把 recipes 的自定义/预设目录指到临时目录，并写一份最小 video_director 配方。"""

    SEGMENTS = ({"skill_id": "sk-a", "prompt": "第一段", "duration_sec": 5},
                {"skill_id": "sk-a", "prompt": "第二段", "duration_sec": 5})

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self._tmp.name)
        self._dirs = (recipes.CUSTOM_DIR, recipes.PRESETS_DIR)
        recipes.CUSTOM_DIR = root / "custom"
        recipes.PRESETS_DIR = root / "presets"
        recipes.CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
        recipes.PRESETS_DIR.mkdir(parents=True, exist_ok=True)
        studio._TASKS.clear()
        studio._WATCHERS.clear()

    def tearDown(self):
        recipes.CUSTOM_DIR, recipes.PRESETS_DIR = self._dirs
        self._tmp.cleanup()

    def write_recipe(self, name="T", preset=False):
        base = recipes.PRESETS_DIR if preset else recipes.CUSTOM_DIR
        recipe_dir = base / name
        recipe_dir.mkdir(parents=True, exist_ok=True)
        meta = {"type": "video_director", "shared": {"mode": "t2v", "seed": 7},
                "segments": list(self.SEGMENTS)}
        (recipe_dir / "recipe.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return recipe_dir

    def _req(self, payload):
        class _Req:
            async def json(self):
                return payload
        return _Req()

    def _drive(self, payload, lookup=None, progress=None, rounds=300):
        """同一事件循环里提交生成请求并轮询到任务结束（桩执行无真实 I/O）。"""
        async def _fake_submit(graph):
            return "prompt-1"

        loop = asyncio.new_event_loop()
        try:
            with patch.object(studio, "submit_graph", _fake_submit), \
                 patch.object(studio, "_lookup", lookup or (lambda pid: ("queued", None))), \
                 patch.object(studio, "_progress_for", progress or (lambda pid: None)), \
                 patch.object(studio, "POLL_INTERVAL", 0.01):
                resp = loop.run_until_complete(studio.director_generate_route(self._req(payload)))
                self.assertEqual(resp.status, 200, f"生成请求失败：{resp.body}")
                data = json.loads(resp.body)
                task_id = data["task_id"]
                for _ in range(rounds):
                    loop.run_until_complete(asyncio.sleep(0.01))
                    if studio._TASKS[task_id]["status"] not in ("queued", "running"):
                        break
            return data, studio._TASKS[task_id]
        finally:
            loop.close()


class RunPromptTests(_RecipeCase):
    def test_graph_two_nodes(self):
        self.write_recipe("R")
        payload = studio._run_prompt({"recipe": "R", "seed": 3, "width": 640, "height": 384}, "task-1")
        g = payload["graph"]
        # 节点 key = task_id：执行器注入 UNIQUE_ID 时自然等于 task_id，预览路由一致
        self.assertEqual(set(g), {"task-1", "2"})
        self.assertEqual(g["task-1"]["class_type"], "NeoH3VideoDirector")
        self.assertEqual(g["task-1"]["inputs"]["recipe"], "R")
        self.assertEqual(g["task-1"]["inputs"]["seed"], 3)
        self.assertEqual(g["task-1"]["inputs"]["width"], 640)
        self.assertTrue(g["task-1"]["inputs"]["preview"])   # taeh3 实时预览：载荷按 unique_id 路由到 Studio 播放器
        self.assertNotIn("unique_id", g["task-1"]["inputs"])  # 隐藏输入由执行器注入，不显式写
        self.assertEqual(g["2"]["class_type"], "SaveVideo")
        self.assertEqual(g["2"]["inputs"]["video"], ["task-1", 0])
        self.assertTrue(g["2"]["inputs"]["filename_prefix"].startswith("NeoDirector/"))
        self.assertEqual(g["2"]["inputs"]["format"], "auto")   # 新版核心 SaveVideo 必填

    def test_missing_recipe(self):
        with self.assertRaises(ValueError):
            studio._run_prompt({}, "t")

    def _shared(self, name, **kw):
        """把运行参数写进配方 shared（模拟导演编辑器保存后的配方）。"""
        d = self.write_recipe(name)
        meta = json.loads((d / "recipe.json").read_text(encoding="utf-8"))
        meta["shared"].update(kw)
        (d / "recipe.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    def test_run_params_prefer_recipe_shared(self):
        # Studio 生成面板只发 recipe/only_segments：continuity / context_frames / steps 读配方 shared
        self._shared("R", steps=12, continuity=False, context_frames=30)
        inputs = studio._run_prompt({"recipe": "R"}, "task-1")["graph"]["task-1"]["inputs"]
        self.assertEqual(inputs["steps"], 12)
        self.assertIs(inputs["continuity"], False)
        self.assertEqual(inputs["context_frames"], 30)

    def test_request_run_params_beat_recipe(self):
        # MCP / 画布节点显式传值 → 覆盖配方值
        self._shared("R", steps=12, continuity=False, context_frames=30)
        payload = {"recipe": "R", "steps": 8, "continuity": True, "context_frames": 5}
        inputs = studio._run_prompt(payload, "task-1")["graph"]["task-1"]["inputs"]
        self.assertEqual(inputs["steps"], 8)
        self.assertIs(inputs["continuity"], True)
        self.assertEqual(inputs["context_frames"], 5)

    def test_recipe_without_run_params_keeps_defaults(self):
        # 旧配方没有这些键 → 缺省 continuity=True、context_frames=22、steps=-1（各段技能 config）
        self.write_recipe("R")
        inputs = studio._run_prompt({"recipe": "R"}, "task-1")["graph"]["task-1"]["inputs"]
        self.assertIs(inputs["continuity"], True)
        self.assertEqual(inputs["context_frames"], 22)
        self.assertEqual(inputs["steps"], -1)

    def test_preset_rejected(self):
        self.write_recipe("P", preset=True)
        with self.assertRaises(ValueError):
            studio._run_prompt({"recipe": "P"}, "t")

    def test_no_segments_rejected(self):
        d = self.write_recipe("E")
        (d / "recipe.json").write_text(
            json.dumps({"type": "video_director", "segments": []}), encoding="utf-8")
        with self.assertRaises(ValueError):
            studio._run_prompt({"recipe": "E"}, "t")


class GenerateRouteTests(_RecipeCase):
    def test_generate_submits_and_tracks(self):
        self.write_recipe("R")
        data, task = self._drive({"recipe": "R", "seed": 3})
        self.assertTrue(data["success"])
        self.assertEqual(task["status"], "queued")
        self.assertEqual(task["prompt_id"], "prompt-1")
        self.assertEqual(task["recipe"], "R")

    def test_validation_error_400(self):
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_generate_route(self._req({})))
        finally:
            loop.close()
        self.assertEqual(r.status, 400)
        self.assertFalse(json.loads(r.body)["success"])

    def test_status_route(self):
        self.write_recipe("R")
        data, _ = self._drive({"recipe": "R"})
        req = types.SimpleNamespace(match_info={"task_id": data["task_id"]})
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_status_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 200)
        self.assertEqual(json.loads(r.body)["status"], "queued")

    def test_status_route_unknown_task_404(self):
        req = types.SimpleNamespace(match_info={"task_id": "nope"})
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_status_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 404)

    def test_cancel_route(self):
        self.write_recipe("R")
        data, _ = self._drive({"recipe": "R"})
        queue = types.SimpleNamespace(
            delete_queue_item=lambda pred: True, interrupt_if_running=lambda pid: False)
        req = types.SimpleNamespace(match_info={"task_id": data["task_id"]})
        loop = asyncio.new_event_loop()
        try:
            with patch.object(studio.PromptServer.instance, "prompt_queue", queue):
                r = loop.run_until_complete(studio.director_cancel_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 200)
        body = json.loads(r.body)
        self.assertTrue(body["success"])
        self.assertTrue(body["dequeued"])

    def test_cancel_route_unknown_task_404(self):
        req = types.SimpleNamespace(match_info={"task_id": "nope"})
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_cancel_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 404)


class WatcherTests(_RecipeCase):
    def test_success_records_result(self):
        self.write_recipe("R")
        # 结果记账要求文件真实存在于 output 目录（桩环境里放一个空文件）
        film_dir = os.path.join(_OUTPUT_DIR, "NeoDirector")
        os.makedirs(film_dir, exist_ok=True)
        film_path = os.path.join(film_dir, "R_1.mp4")
        with open(film_path, "wb"):
            pass
        try:
            # 全套件运行时 sys.modules["folder_paths"] 会被其它测试模块替换；
            # _result_path 在函数内 import，这里固定回本套件的桩（output 目录 = _OUTPUT_DIR）
            saved_fp = sys.modules.get("folder_paths")
            sys.modules["folder_paths"] = _folder_paths
            try:
                item = {"status": {"completed": True, "messages": []},
                        "outputs": {"2": {"images": [{"filename": "R_1.mp4", "subfolder": "NeoDirector", "type": "output"}],
                                          "animated": [True]}}}
                data, task = self._drive({"recipe": "R"}, lookup=lambda pid: ("done", item))
                self.assertEqual(task["status"], "succeeded")
                self.assertEqual(task["filename"], "R_1.mp4")
                self.assertEqual(task["subfolder"], "NeoDirector")
                meta = json.loads((recipes.CUSTOM_DIR / "R" / "recipe.json").read_text(encoding="utf-8"))
                self.assertTrue(any(r.get("filename") == "R_1.mp4" and r.get("subfolder") == "NeoDirector"
                                     for r in meta.get("results", [])))
            finally:
                if saved_fp is None:
                    sys.modules.pop("folder_paths", None)
                else:
                    sys.modules["folder_paths"] = saved_fp
        finally:
            os.remove(film_path)

    def test_failed_task_keeps_error(self):
        self.write_recipe("R")
        item = {"status": {"completed": False,
                           "messages": [["execution_error", {"exception_message": "boom"}]]},
                "outputs": {}}
        data, task = self._drive({"recipe": "R"}, lookup=lambda pid: ("done", item))
        self.assertEqual(task["status"], "failed")
        self.assertIn("boom", task["error"])

    def test_progress_captured_while_running(self):
        self.write_recipe("R")
        calls = {"n": 0}

        def _lookup(pid):
            calls["n"] += 1
            return ("running", None) if calls["n"] < 3 else (
                "done", {"status": {"completed": True, "messages": []},
                         "outputs": {"2": {"images": [{"filename": "x.mp4", "subfolder": "", "type": "output"}],
                                           "animated": [True]}}})

        seen = {}
        orig = studio._notify

        def _spy(task):
            if task.get("progress") is not None:
                seen["progress"] = task["progress"]
            return orig(task)

        with patch.object(studio, "_notify", _spy):
            data, task = self._drive({"recipe": "R"}, lookup=_lookup, progress=lambda pid: {"value": 3, "max": 10})
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(seen.get("progress"), {"value": 3, "max": 10})

    def test_snapshot_payload_carries_queue_fields(self):
        # 顶栏队列吃 rs.director.status 实时推进：快照少了 created/updated/progress 行就定不了位置
        self.write_recipe("R")
        item = {"status": {"completed": True, "messages": []},
                "outputs": {"2": {"images": [{"filename": "R_1.mp4", "subfolder": "NeoDirector", "type": "output"}],
                                  "animated": [True]}}}
        data, task = self._drive({"recipe": "R"}, lookup=lambda pid: ("done", item))
        snap = studio._snapshot(task)
        for key in ("task_id", "status", "progress", "created", "updated", "recipe",
                    "filename", "subfolder"):
            self.assertIn(key, snap)
        self.assertEqual(snap["task_id"], data["task_id"])
        self.assertEqual(snap["status"], "succeeded")
        self.assertEqual((snap["filename"], snap["subfolder"]), ("R_1.mp4", "NeoDirector"))


class QueueRowsTests(_RecipeCase):
    """顶栏队列聚合（GET /neo_studio/queue）：六张表的行都带页面落点，按提交时间倒序，条数封顶。"""

    def setUp(self):
        super().setUp()
        # 六张任务表在模块级，全套件共享：进用例先清空，行集才是本用例放的这几行
        studio.image_gen.TASKS.clear()
        studio.image_gen._WATCHERS.clear()
        studio.voice_gen.TASKS.clear()
        studio.voice_gen.WATCHERS.clear()
        studio.simple_video._TASKS.clear()
        studio.simple_video._WATCHERS.clear()
        studio.h3_segment._SEGMENT_TASKS.clear()
        studio.h3_segment._SEGMENT_WATCHERS.clear()
        studio.h3_assemble._TASKS.clear()

    def _rows(self):
        loop = asyncio.new_event_loop()
        try:
            resp = loop.run_until_complete(studio.queue_route(None))
        finally:
            loop.close()
        self.assertEqual(resp.status, 200)
        body = json.loads(resp.body)
        self.assertTrue(body["success"])
        return body["rows"]

    def test_queue_route_pages_rows_from_all_six_tables(self):
        studio._TASKS["f1"] = {"task_id": "f1", "prompt_id": "p", "status": "queued",
                               "recipe": "R", "seed": 1, "filename": None, "subfolder": "",
                               "progress": None, "error": "", "created": 6, "updated": 6}
        studio.image_gen.TASKS["i1"] = {"task_id": "i1", "prompt_id": "p", "status": "running",
                                        "params": {"prompt": "一只猫"}, "images": [],
                                        "progress": {"value": 3, "max": 20}, "created": 5, "updated": 5}
        studio.voice_gen.TASKS["v1"] = {"task_id": "v1", "prompt_id": "p", "status": "succeeded",
                                        "params": {"prompt": "你好"}, "audios": [],
                                        "progress": None, "error": "", "created": 4, "updated": 4}
        studio.voice_gen.TASKS["v1"]["audios"] = [{"filename": "a.mp3", "subfolder": "NeoVoice", "url": ""}]
        studio.simple_video._TASKS["s1"] = {"task_id": "s1", "status": "queued", "prompt": "开场镜头",
                                            "filename": None, "subfolder": "", "progress": None,
                                            "created": 3, "updated": 3}
        studio.h3_segment._SEGMENT_TASKS["g1"] = {"task_id": "g1", "status": "succeeded",
                                                  "recipe": "R", "segment": 1, "filename": "seg.mp4",
                                                  "subfolder": "NeoDirector", "progress": None,
                                                  "created": 2, "updated": 2}
        studio.h3_assemble._TASKS["a1"] = {"task_id": "a1", "status": "running", "recipe": "R",
                                           "use": [0, 2], "filename": None, "subfolder": "",
                                           "progress": None, "created": 1, "updated": 1}
        by = {row["kind"]: row for row in self._rows()}
        self.assertEqual(set(by), {"image", "voice", "simple", "segment", "assemble", "film"})
        self.assertEqual(by["image"]["label"], "一只猫")
        self.assertEqual(by["image"]["page"], "paint")
        self.assertIsNone(by["image"]["result"])
        self.assertEqual(by["voice"]["label"], "你好")
        self.assertEqual(by["voice"]["page"], "gallery")
        self.assertEqual(by["voice"]["result"], {"filename": "a.mp3", "subfolder": "NeoVoice"})
        self.assertEqual(by["simple"]["label"], "开场镜头")
        self.assertEqual(by["simple"]["page"], "video")
        self.assertEqual(by["film"]["label"], "R")
        self.assertEqual(by["film"]["page"], "director")
        self.assertIsNone(by["film"]["result"])
        self.assertEqual(by["segment"]["label"], "R 第 2 段")
        self.assertEqual(by["segment"]["result"], {"filename": "seg.mp4", "subfolder": "NeoDirector"})
        self.assertEqual(by["assemble"]["label"], "R 拼接 2 段")
        self.assertEqual([row["created"] for row in self._rows()],
                         sorted((row["created"] for row in self._rows()), reverse=True))

    def test_queue_rows_carry_count_and_time_pair_for_panel_meta(self):
        # 面板行第二行的三件（提交时刻 / 时长 / 张数）全读行上的 created / updated / count：
        # 少一件，多图行就只说「看图」、终态行报不出耗时
        studio.image_gen.TASKS["i1"] = {"task_id": "i1", "prompt_id": "p", "status": "succeeded",
                                        "params": {"prompt": "一只猫"},
                                        "images": [{"filename": "n_1.png", "subfolder": "Neo/Paint", "url": ""},
                                                   {"filename": "n_2.png", "subfolder": "Neo/Paint", "url": ""}],
                                        "progress": None, "error": "", "created": 10.0, "updated": 22.3}
        studio.voice_gen.TASKS["v1"] = {"task_id": "v1", "prompt_id": "p", "status": "succeeded",
                                        "params": {"prompt": "你好"},
                                        "audios": [{"filename": "a.mp3", "subfolder": "NeoVoice", "url": ""},
                                                   {"filename": "b.mp3", "subfolder": "NeoVoice", "url": ""}],
                                        "progress": None, "error": "", "created": 8.0, "updated": 11.0}
        studio.simple_video._TASKS["s1"] = {"task_id": "s1", "status": "succeeded", "prompt": "开场镜头",
                                            "filename": "s.mp4", "subfolder": "NeoVideo", "progress": None,
                                            "error": "", "created": 5.0, "updated": 41.5}
        by = {row["kind"]: row for row in self._rows()}
        self.assertEqual(by["image"]["count"], 2)
        self.assertEqual(by["voice"]["count"], 2)
        self.assertEqual(by["simple"]["count"], 1)
        self.assertEqual((by["image"]["created"], by["image"]["updated"]), (10.0, 22.3))
        self.assertEqual((by["voice"]["created"], by["voice"]["updated"]), (8.0, 11.0))
        self.assertEqual((by["simple"]["created"], by["simple"]["updated"]), (5.0, 41.5))
        # 缩略图取首个产物的名字与目录，行上的 result 就是缩略路由的入参
        self.assertEqual(by["image"]["result"], {"filename": "n_1.png", "subfolder": "Neo/Paint"})
        self.assertEqual(by["voice"]["result"], {"filename": "a.mp3", "subfolder": "NeoVoice"})

    def test_queue_route_caps_rows_at_limit(self):
        for i in range(studio.QUEUE_LIMIT + 12):
            studio.simple_video._TASKS[f"s{i}"] = {"task_id": f"s{i}", "status": "succeeded",
                                                   "prompt": f"镜头 {i}", "filename": f"{i}.mp4",
                                                   "subfolder": "NeoVideo", "progress": None,
                                                   "created": i, "updated": i}
        rows = self._rows()
        self.assertEqual(len(rows), studio.QUEUE_LIMIT)
        self.assertTrue(all(row["kind"] == "simple" for row in rows))
        # 封顶丢的是最旧（updated 最小）的空闲行，最新的必须留下
        self.assertEqual(rows[0]["created"], studio.QUEUE_LIMIT + 11)


class VideoFromHistoryTests(unittest.TestCase):
    def test_finds_video_entry(self):
        item = {"outputs": {"2": {"images": [{"filename": "a/b.mp4", "subfolder": "a", "type": "output"}],
                                  "animated": [True]}}}
        self.assertEqual(studio._video_from_history(item), ("a/b.mp4", "a"))

    def test_no_video(self):
        item = {"outputs": {"2": {"images": [{"filename": "x.png", "subfolder": "", "type": "output"}],
                                  "animated": [True]}}}
        self.assertEqual(studio._video_from_history(item), (None, ""))


class VersionRouteTests(unittest.TestCase):
    def test_version(self):
        req = types.SimpleNamespace()
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.studio_version_route(req))
        finally:
            loop.close()
        self.assertEqual(r.status, 200)
        data = json.loads(r.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["plugin"], "Neo Studio")
        self.assertIn("plugin_version", data)
        self.assertIn("comfyui_version", data)

    def test_version_carries_paths_for_the_about_page(self):
        # 「设置 → 关于」的路径行：数据根与 ComfyUI 根由内核报，远程地址只有桌面端知道
        req = types.SimpleNamespace()
        loop = asyncio.new_event_loop()
        try:
            data = json.loads(loop.run_until_complete(studio.studio_version_route(req)).body)
        finally:
            loop.close()
        self.assertTrue(data["data_root"], "数据根要报出落点，设置页才有可复制的路径")
        self.assertIn("comfy_local", data)
        self.assertEqual(data["remote"], "", "内核不知道启动设置里的远程地址，留空让页面收起该行")


class LogRouteTests(unittest.TestCase):
    def test_log_entries(self):
        entries = [{"t": "2026-10-10T10:00:00", "m": "Starting ComfyUI\n"}]
        logger_mod = types.SimpleNamespace(get_logs=lambda: entries)
        with patch.dict(sys.modules, {"app": types.SimpleNamespace(logger=logger_mod),
                                      "app.logger": logger_mod}):
            loop = asyncio.new_event_loop()
            try:
                r = loop.run_until_complete(studio.studio_log_route(types.SimpleNamespace()))
            finally:
                loop.close()
        data = json.loads(r.body)
        self.assertEqual(r.status, 200)
        self.assertTrue(data["success"])
        self.assertEqual(data["entries"], entries)


class LatestPreviewTests(_RecipeCase):
    """status 路由的 latest_preview 兜底字段 + 终态清除 + 缓存限量。"""

    @property
    def h3p(self):
        # studio 导入的同一份 h3_preview 模块实例（相对导入落在 _neo_h3director_pkg 包下）
        return sys.modules[studio.__name__.rsplit(".", 1)[0] + ".h3_preview"]

    def setUp(self):
        super().setUp()
        self.h3p._LATEST.clear()
        self.h3p._LATEST_SMALL.clear()

    def tearDown(self):
        self.h3p._LATEST.clear()
        self.h3p._LATEST_SMALL.clear()
        super().tearDown()

    def test_status_route_includes_latest_preview(self):
        self.write_recipe("R")
        data, _ = self._drive({"recipe": "R"})   # 默认 lookup 保持 queued
        payload = {"frames": ["data:image/jpeg;base64,x"], "fps": 4, "w": 512, "h": 288, "step": 3}
        self.h3p._store_latest(data["task_id"], payload)
        req = types.SimpleNamespace(match_info={"task_id": data["task_id"]})
        loop = asyncio.new_event_loop()
        try:
            r = loop.run_until_complete(studio.director_status_route(req))
        finally:
            loop.close()
        self.assertEqual(json.loads(r.body)["latest_preview"], payload)

    def test_terminal_clears_latest_preview(self):
        self.write_recipe("R")
        item = {"status": {"completed": True, "messages": []}, "outputs": {}}

        def _lookup(pid):
            # 模拟采样期间推帧：任务终态前缓存里必须有最新帧
            task_id = next(iter(studio._TASKS))
            self.h3p._store_latest(task_id, {"frames": ["f"], "fps": 4, "w": 1, "h": 1, "step": 2})
            return ("done", item)

        data, task = self._drive({"recipe": "R"}, lookup=_lookup)
        self.assertEqual(task["status"], "succeeded")
        self.assertIsNone(self.h3p.get_latest_preview(data["task_id"]), "终态应清掉最新帧缓存")

    def test_store_latest_cap_evicts_oldest(self):
        for i in range(10):
            self.h3p._store_latest(f"n{i}", {"step": i})
        self.assertEqual(len(self.h3p._LATEST), 8)
        self.assertNotIn("n0", self.h3p._LATEST)
        self.assertIn("n9", self.h3p._LATEST)

    def test_compact_preview_is_a_separate_channel(self):
        """紧凑档只走进程内那一份：路由载荷是全尺寸那一份，终态两张表一起清。"""
        small = {"frames": ["small"], "step": 3}
        self.h3p._store_latest("t-1", {"frames": ["full"], "step": 3}, small)
        self.assertEqual(self.h3p.get_latest_preview("t-1"), {"frames": ["full"], "step": 3})
        self.assertEqual(self.h3p.get_latest_preview("t-1", small=True), small)
        self.h3p.clear_latest_preview("t-1")
        self.assertIsNone(self.h3p.get_latest_preview("t-1", small=True))

    def test_store_latest_cap_evicts_both_channels(self):
        for i in range(10):
            self.h3p._store_latest(f"n{i}", {"step": i}, {"step": i})
        self.assertEqual(len(self.h3p._LATEST), len(self.h3p._LATEST_SMALL))
        self.assertNotIn("n0", self.h3p._LATEST_SMALL)
        self.assertIn("n9", self.h3p._LATEST_SMALL)


class MemStatsTests(unittest.TestCase):
    """mem_stats / clear_memory 走驱动级显存（含全部进程），不依赖 torch 真实设备。"""

    GB = 1024 ** 3

    def _run(self, fn, vram):
        loop = asyncio.new_event_loop()
        try:
            with patch.object(studio, "_driver_vram", lambda device: vram):
                return loop.run_until_complete(fn(None))
        finally:
            loop.close()

    def test_mem_stats(self):
        r = self._run(studio.mem_stats_route, (4 * self.GB, 16 * self.GB))
        self.assertEqual(json.loads(r.body), {"success": True, "vram_total": 16 * self.GB, "vram_used": 12 * self.GB})

    def test_mem_stats_unavailable(self):
        r = self._run(studio.mem_stats_route, vram=None)
        self.assertEqual(json.loads(r.body), {"success": False})

    def test_clear_memory_reports_driver_freed(self):
        seq = iter([(4 * self.GB, 16 * self.GB), (10 * self.GB, 16 * self.GB)])
        loop = asyncio.new_event_loop()
        try:
            with patch.object(studio, "_driver_vram", lambda device: next(seq)), \
                 patch.object(_comfy_mm, "unload_all_models") as unload, \
                 patch.object(_comfy_mm, "soft_empty_cache") as empty:
                r = loop.run_until_complete(studio.clear_memory_route(None))
        finally:
            loop.close()
        data = json.loads(r.body)
        self.assertEqual(data["freed_bytes"], 6 * self.GB)
        unload.assert_called_once_with()
        empty.assert_called_once_with(force=True)

    def test_clear_memory_no_driver_stats(self):
        r = self._run(studio.clear_memory_route, vram=None)
        self.assertEqual(json.loads(r.body), {"success": True, "freed_bytes": 0})


class DriverVramTests(unittest.TestCase):
    """_driver_vram：优先 NVML（与 nvidia-smi 同源），不可用时回退 torch。"""

    GB = 1024 ** 3

    def test_prefers_nvml(self):
        fake = types.ModuleType("pynvml")
        fake.nvmlInit = lambda: None
        fake.nvmlDeviceGetHandleByIndex = lambda i: ("handle", i)
        fake.nvmlDeviceGetMemoryInfo = lambda h: types.SimpleNamespace(used=4 * self.GB, total=16 * self.GB)
        with patch.dict(sys.modules, {"pynvml": fake}), \
             patch.object(studio, "_NVML_READY", False):
            self.assertEqual(studio._driver_vram("cuda:0"), (12 * self.GB, 16 * self.GB))

    def test_falls_back_to_torch(self):
        with patch.dict(sys.modules, {"pynvml": None}), \
             patch("torch.cuda.mem_get_info", return_value=(8 * self.GB, 16 * self.GB)):
            self.assertEqual(studio._driver_vram("cuda:0"), (8 * self.GB, 16 * self.GB))

    def test_unavailable_returns_none(self):
        with patch.dict(sys.modules, {"pynvml": None}), \
             patch("torch.cuda.mem_get_info", side_effect=RuntimeError("no cuda")):
            self.assertIsNone(studio._driver_vram("cuda:0"))


if __name__ == "__main__":
    unittest.main()

