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
import os
import tempfile
import unittest
from pathlib import Path
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


# resolve_video_params 生效值的形状（写副文件要逐项取自这份，不取面板原始态）
_FULL_PARAMS = {
    "prompt": "雪夜城市", "model": "diffusion_video/h3.safetensors",
    "text_encoder": "text_encoders/qae.safetensors", "vae": "vae/h3_vae.safetensors",
    "audio_vae": "vae/h3_audio.safetensors",
    "loras": [{"name": "loras/id.safetensors", "strength": 0.8}],
    "width": 1024, "height": 576, "length": 192, "steps": 21, "seed": 777,
    "ref_name": "neo/first.png", "ref_last": "neo/last.png",
    "ref_images": ["neo/first.png", "neo/a.png", "neo/b c.png"],
    "ref_videos": [], "ref_audios": [],
}

# _run_prompt 落进任务表的 reuse 载荷（副文件摘要行的直接输入）
_FULL_REUSE = {
    "seed": 777, "width": 1024, "height": 576, "frames": 192, "steps": 21,
    "model": "diffusion_video/h3.safetensors",
    "text_encoder": "text_encoders/qae.safetensors", "vae": "vae/h3_vae.safetensors",
    "audio_vae": "vae/h3_audio.safetensors",
    "loras": [{"name": "loras/id.safetensors", "strength": 0.8}],
    "src": "neo/first.png", "last": "neo/last.png", "refs": ["neo/a.png", "neo/b c.png"],
    "duration_sec": 8,
}


class SidecarTests(unittest.TestCase):
    """成片旁同名 .txt：出视频页「复用参数重跑」的读端（gallery._read_sidecar）吃这份。"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="neo_simple_sidecar_")

    def test_run_prompt_records_effective_params_for_sidecar(self):
        graph = {"5": {"class_type": "FakeVideo", "inputs": {}}}
        with _skill_chain(simple_video, graph, lambda b, c: dict(_FULL_PARAMS)):
            out = simple_video._run_prompt({"skill_id": "sk-a", "prompt": "x", "duration_sec": 8})
        reuse = out["reuse"]
        self.assertEqual((reuse["seed"], reuse["width"], reuse["height"], reuse["frames"]),
                         (777, 1024, 576, 192))
        self.assertEqual(reuse["steps"], 21)
        self.assertEqual(reuse["model"], "diffusion_video/h3.safetensors")
        self.assertEqual(reuse["text_encoder"], "text_encoders/qae.safetensors")
        self.assertEqual(reuse["audio_vae"], "vae/h3_audio.safetensors")
        self.assertEqual((reuse["src"], reuse["last"]), ("neo/first.png", "neo/last.png"))
        self.assertEqual(reuse["refs"], ["neo/a.png", "neo/b c.png"])
        self.assertEqual(reuse["duration_sec"], 8)

    def test_sidecar_written_beside_video_when_task_succeeds(self):
        # 副文件只在成片成功落盘后补写，且记的是生效值：路径按 output 根拼，值按 reuse 取
        item = {"outputs": {"9000": {"videos": [{"filename": "v.mp4", "subfolder": ""}]}},
                "status": {"status_str": "success", "completed": True}}
        task = {"task_id": "t-1", "prompt_id": "p-1", "status": "queued",
                "prompt": "雪夜城市", "skill_id": "sk-a", "seed": 777,
                "width": 1024, "height": 576, "length": 192,
                "reuse": dict(_FULL_REUSE),
                "filename": None, "subfolder": "", "progress": None, "error": "",
                "created": 0.0, "updated": 0.0}
        simple_video._TASKS["t-1"] = task
        self.addCleanup(simple_video._TASKS.pop, "t-1", None)
        with patch.object(simple_video.folder_paths, "get_output_directory", lambda: self.dir), \
             patch.object(simple_video, "_lookup", lambda pid: ("done", item)), \
             patch.object(simple_video, "POLL_INTERVAL", 0.01):
            asyncio.new_event_loop().run_until_complete(simple_video._watch("t-1"))
        text = Path(self.dir, "v.txt").read_text(encoding="utf-8")
        meta = text.splitlines()[1]
        self.assertEqual(text.splitlines()[0], "雪夜城市")
        for frag in ("seed=777", "1024x576", "model=diffusion_video/h3.safetensors",
                     "loras=loras/id.safetensors@0.8", "skill=sk-a",
                     "src=neo%2Ffirst.png", "last=neo%2Flast.png",
                     "refs=neo%2Fa.png,neo%2Fb%20c.png", "steps=21",
                     "text_encoder=text_encoders%2Fqae.safetensors",
                     "audio_vae=vae%2Fh3_audio.safetensors",
                     "vae=vae%2Fh3_vae.safetensors", "frames=192", "duration=8"):
            self.assertIn(frag, meta)

    def test_sidecar_not_overwritten_and_not_written_on_failure(self):
        # SaveVideo 已把工作流 JSON 抢注到同名 .txt（那条路归「导入工作流」）：副文件不覆盖
        Path(self.dir, "v.txt").write_text('{"3": {"class_type": "KSampler"}}', encoding="utf-8")
        simple_video.write_video_sidecar(os.path.join(self.dir, "v.mp4"), "p", {}, "sk-a")
        self.assertEqual(Path(self.dir, "v.txt").read_text(encoding="utf-8"),
                         '{"3": {"class_type": "KSampler"}}')
        item = {"outputs": {"9000": {"videos": [{"filename": "f.mp4", "subfolder": ""}]}},
                "status": {"status_str": "error", "completed": False,
                           "messages": [["execution_error",
                                         {"exception_message": "显存不足", "node_id": "9000", "node_type": "SaveVideo"}]]}}
        task = {"task_id": "t-2", "prompt_id": "p-2", "status": "queued",
                "prompt": "p", "skill_id": "sk-a", "seed": 1, "width": 1, "height": 1, "length": 1,
                "reuse": {}, "filename": None, "subfolder": "", "progress": None, "error": "",
                "created": 0.0, "updated": 0.0}
        simple_video._TASKS["t-2"] = task
        self.addCleanup(simple_video._TASKS.pop, "t-2", None)
        with patch.object(simple_video.folder_paths, "get_output_directory", lambda: self.dir), \
             patch.object(simple_video, "_lookup", lambda pid: ("done", item)), \
             patch.object(simple_video, "POLL_INTERVAL", 0.01):
            asyncio.new_event_loop().run_until_complete(simple_video._watch("t-2"))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "f.txt")))


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
