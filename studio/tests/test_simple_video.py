#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""simple_video（一句话 + 首帧出一段视频）离线单测。

复用 test_h3_video_director 的桩环境，在其中加载 simple_video。覆盖：_video_terminal 在渲染图里
找未被消费的 VIDEO 末端（跳过落盘节点、无 VIDEO 抛错）、_run_prompt 把末端接一个 SaveVideo 落进
NeoSimple/ 子目录并归一 seed、generate/cancel 路由与任务表流转。
"""

import asyncio
import contextlib
import json
import unittest
from unittest.mock import patch

from test_h3_video_director import _load, _server   # noqa: E402  —— 复用同一套桩

simple_video = _load("simple_video", "simple_video.py")
simple_video.PromptServer = _server.PromptServer


class _FakeVideoNode:
    RETURN_TYPES = ("VIDEO", "IMAGE")


class _FakeImageNode:
    RETURN_TYPES = ("IMAGE",)


class _Req:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


class _ReqPath:
    def __init__(self, task_id):
        self.match_info = {"task_id": task_id}


@contextlib.contextmanager
def _skill_chain(simple, graph, params_fn):
    """把 _run_prompt 依赖的技能链换成桩，喂进一份含 VIDEO 末端的渲染图。"""
    with contextlib.ExitStack() as st:
        st.enter_context(patch.dict(simple.comfy_nodes.NODE_CLASS_MAPPINGS, {"FakeVideo": _FakeVideoNode}))
        st.enter_context(patch.object(simple, "_resolve_skill_id", lambda v: "sk-a"))
        st.enter_context(patch.object(simple, "load_skill_workflow", lambda s: {}))
        st.enter_context(patch.object(simple, "get_skill_gen_config", lambda s: {}))
        st.enter_context(patch.object(simple, "resolve_video_params", params_fn))
        st.enter_context(patch.object(simple, "render_template", lambda t, p: (dict(graph), [])))
        yield


class VideoTerminalTests(unittest.TestCase):
    def setUp(self):
        self._mapping = dict(simple_video.comfy_nodes.NODE_CLASS_MAPPINGS)
        simple_video.comfy_nodes.NODE_CLASS_MAPPINGS = {
            "FakeVideo": _FakeVideoNode, "FakeImage": _FakeImageNode,
            "SaveVideo": type("SaveVideo", (), {"RETURN_TYPES": ()}),
        }

    def tearDown(self):
        simple_video.comfy_nodes.NODE_CLASS_MAPPINGS = self._mapping

    def test_finds_unconsumed_video(self):
        graph = {"5": {"class_type": "FakeVideo", "inputs": {}}}
        self.assertEqual(simple_video._video_terminal(graph), ("5", 0))

    def test_savevideo_reference_does_not_consume(self):
        graph = {"5": {"class_type": "FakeVideo", "inputs": {}},
                 "9000": {"class_type": "SaveVideo", "inputs": {"video": ["5", 0]}}}
        self.assertEqual(simple_video._video_terminal(graph), ("5", 0))

    def test_consumed_video_is_not_terminal(self):
        graph = {"5": {"class_type": "FakeVideo", "inputs": {}},
                 "6": {"class_type": "FakeImage", "inputs": {"src": ["5", 0]}}}
        with self.assertRaises(ValueError):
            simple_video._video_terminal(graph)


class RunPromptTests(unittest.TestCase):
    def _params(self, seed):
        return {"prompt": "一段测试视频", "width": 1344, "height": 768, "length": 120, "seed": seed}

    def test_attaches_savevideo_to_video_output(self):
        graph = {"5": {"class_type": "FakeVideo", "inputs": {}}}
        with _skill_chain(simple_video, graph, lambda b, c: self._params(999)):
            out = simple_video._run_prompt({"skill_id": "sk-a", "prompt": "x"})
        node = out["graph"]["9000"]
        self.assertEqual(node["class_type"], "SaveVideo")
        self.assertEqual(node["inputs"]["video"], ["5", 0])
        self.assertTrue(node["inputs"]["filename_prefix"].startswith("NeoSimple/"))
        self.assertEqual(out["seed"], 999)

    def test_duration_sec_becomes_length_frames(self):
        graph = {"5": {"class_type": "FakeVideo", "inputs": {}}}
        seen = {}

        def fake_resolve(body, cfg):
            seen["length"] = body.get("length")
            return self._params(1)

        with _skill_chain(simple_video, graph, fake_resolve):
            simple_video._run_prompt({"skill_id": "sk-a", "prompt": "x", "duration_sec": 5})
        self.assertEqual(seen["length"], simple_video._seconds_to_frames(5))

    def test_negative_seed_uses_resolved_seed(self):
        graph = {"5": {"class_type": "FakeVideo", "inputs": {}}}
        with _skill_chain(simple_video, graph, lambda b, c: self._params(777)):
            out = simple_video._run_prompt({"skill_id": "sk-a", "prompt": "x", "seed": -1})
        self.assertEqual(out["seed"], 777, "seed<0 走随机解析值")


class RouteTests(unittest.TestCase):
    def setUp(self):
        simple_video._TASKS.clear()
        simple_video._WATCHERS.clear()
        self.payload = {"graph": {"5": {"class_type": "FakeVideo", "inputs": {}}},
                        "seed": 5, "skill_id": "sk", "prompt": "p",
                        "width": 1344, "height": 768, "length": 120}

    def _drive(self, payload):
        async def _submit(graph):
            RouteTests.captured = graph
            return "prompt-1"

        loop = asyncio.new_event_loop()
        try:
            with patch.object(simple_video, "_run_prompt", lambda d: dict(self.payload)), \
                 patch.object(simple_video, "submit_graph", _submit), \
                 patch.object(simple_video, "_lookup", lambda pid: ("queued", None)), \
                 patch.object(simple_video, "POLL_INTERVAL", 0.01):
                resp = loop.run_until_complete(simple_video.simple_generate_route(_Req(payload)))
                # 生成会拉起轮询 watcher；关掉 loop 前取消它，留下 pending 任务会让「loop is closed」炸在 GC
                for w in list(simple_video._WATCHERS.values()):
                    w.cancel()
                loop.run_until_complete(asyncio.sleep(0))
            return json.loads(resp.body), resp.status
        finally:
            loop.close()

    def _cancel(self, task_id):
        queue = _server.PromptServer.instance.prompt_queue
        queue.delete_queue_item = lambda f: True
        queue.interrupt_if_running = lambda pid: False
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(simple_video.simple_cancel_route(_ReqPath(task_id)))
        finally:
            loop.close()

    def test_generate_returns_snapshot_and_watches(self):
        data, status = self._drive({"prompt": "p", "skill_id": "sk"})
        self.assertEqual(status, 200)
        self.assertTrue(data["success"])
        self.assertEqual(data["status"], "queued")
        self.assertIn(data["task_id"], simple_video._TASKS)
        self._cancel(data["task_id"])   # 收尾取消，避免遗留 watcher 挂住事件循环

    def test_cancel_marks_task_cancelled(self):
        data, _ = self._drive({"prompt": "p", "skill_id": "sk"})
        task_id = data["task_id"]
        self._cancel(task_id)
        self.assertEqual(simple_video._TASKS[task_id]["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
