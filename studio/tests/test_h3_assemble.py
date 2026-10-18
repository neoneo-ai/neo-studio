#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""h3_assemble（把重生成的段拼回成片）离线单测。

复用 test_h3_segment / test_h3_video_director 的桩环境；core 的 `InputImpl`（读片 / 写成片）在离线环境
用替身（只替换 h3_assemble.InputImpl），拼帧、接缝融合、layout 记账、任务与路由都是真路径。
"""

import json
import pathlib
import unittest
from unittest.mock import patch

import torch

from test_h3_segment import (   # noqa: E402  —— 复用桩环境与工具
    _body,
    _FakeRequest,
    _pin_folder_paths,
    _RecipeCase,
    _run_async,
    _write_test_mp4,
)
from test_h3_video_director import _load, recipes

h3_assemble = _load("h3_assemble", "h3_assemble.py")

H3_FPS = 24


class _FakeComponents:
    def __init__(self, images, audio):
        self.images = images
        self.audio = audio


class _FakeInputImpl:
    """core InputImpl 替身：VideoFromFile 按注册表给帧（支持 start_time/duration 取区间）。"""

    sources = {}
    saved = []

    @classmethod
    def reset(cls):
        cls.sources = {}
        cls.saved = []

    @classmethod
    def register(cls, path, frames, audio=None):
        cls.sources[str(path)] = (frames, audio)

    @classmethod
    def VideoFromFile(cls, path, start_time=0, duration=0):
        frames, audio = cls.sources[str(path)]

        class _File:
            def get_components(self):
                if duration:
                    first = int(round(start_time * H3_FPS))
                    count = int(round(duration * H3_FPS))
                    return _FakeComponents(frames[first:first + count], audio)
                return _FakeComponents(frames, audio)

        return _File()

    @classmethod
    def VideoFromComponents(cls, components):
        class _Out:
            def save_to(self, path, format=None, codec=None, crf=None):
                # 写一个真 mp4（帧数一致）并登记成可读源：拼接产物本身也会被后续调用当输入读回
                _write_test_mp4(path, frames=int(components.images.shape[0]), size=8)
                cls.sources[str(path)] = (components.images, components.audio)
                cls.saved.append((str(path), components, crf))

        return _Out()


def _audio(sample_rate=32000, samples=48000):
    return {"waveform": torch.zeros(1, 2, samples), "sample_rate": sample_rate}


def _frames(count, value, size=8):
    return torch.full((count, size, size, 3), float(value))


class AssembleTests(_RecipeCase):
    """只把勾选的段换成新片段，其余段沿用原成片（3 段 × 5s = 124 帧/段；窗口模式保留 [124,119,119]）。"""

    FILM_TOTAL = 362     # 124 + 119 + 119

    def setUp(self):
        super().setUp()
        _FakeInputImpl.reset()
        h3_assemble._TASKS.clear()

    def _setup(self, work, film=True, clips=(1,), clip_frames=141, clip_value=0.2, clip_size=8):
        results = []
        if film:
            _write_test_mp4(work / "output" / "film.mp4", frames=self.FILM_TOTAL, size=16)
            _FakeInputImpl.register(work / "output" / "film.mp4", _frames(self.FILM_TOTAL, 0.1), _audio())
            results.append({"filename": "film.mp4", "kind": "video", "type": "output"})
        for index in clips:
            name = f"clip{index}.mp4"
            _write_test_mp4(work / "output" / name, frames=clip_frames, size=16)
            _FakeInputImpl.register(work / "output" / name,
                                    _frames(clip_frames, clip_value, clip_size), _audio())
            results.append({"filename": name, "kind": "video", "type": "output", "segment": index, "seed": 1})
        self.write_recipe(results=results)

    def test_replaces_only_the_selected_segment(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                result = h3_assemble.assemble_film("T", [1], blend=2)
            # 第 1 段沿用原成片（124 帧）+ 第 2 段新片段（141 帧）+ 第 3 段沿用原成片（119 帧）
            self.assertEqual(result["frames"], 124 + 141 + 119)
            self.assertEqual(result["layout"], [124, 141, 119])
            self.assertEqual((result["film"], result["replaced"]), ("film.mp4", [1]))
            self.assertTrue((work / "output" / "neo_director_merge" / result["filename"]).is_file())
            self.assertEqual(_FakeInputImpl.saved[-1][2], h3_assemble.MERGE_CRF,
                             "拼接用高码率重编码（压低沿用段的代际损失）")
            saved = recipes.list_recipe_results("T")[0]        # 新成片：无 segment，带 layout
            self.assertEqual(saved["filename"], result["filename"])
            self.assertIsNone(saved.get("segment"))
            self.assertEqual(saved["layout"], [124, 141, 119])
            images = _FakeInputImpl.saved[-1][1].images
            self.assertAlmostEqual(float(images[0].mean()), 0.1, places=5)      # 原成片第 1 段
            self.assertAlmostEqual(float(images[200].mean()), 0.2, places=5)    # 新片段
            self.assertAlmostEqual(float(images[380].mean()), 0.1, places=5)    # 原成片第 3 段
            # 两处接缝各 2 帧融合：前段尾帧 × 后段头帧，权重 1/3、2/3
            self.assertAlmostEqual(float(images[122].mean()), 0.1 * 2 / 3 + 0.2 / 3, places=5)
            self.assertAlmostEqual(float(images[123].mean()), 0.1 / 3 + 0.2 * 2 / 3, places=5)
            self.assertAlmostEqual(float(images[263].mean()), 0.2 * 2 / 3 + 0.1 / 3, places=5)
            self.assertAlmostEqual(float(images[264].mean()), 0.2 / 3 + 0.1 * 2 / 3, places=5)

    def test_two_clips_keep_the_middle_from_the_film(self):
        with _pin_folder_paths() as work:
            self._setup(work, clips=(0, 2), clip_frames=141, clip_value=0.3)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                result = h3_assemble.assemble_film("T", [0, 2])
            self.assertEqual(result["layout"], [141, 119, 141])
            self.assertEqual(result["replaced"], [0, 2])
            images = _FakeInputImpl.saved[-1][1].images
            self.assertAlmostEqual(float(images[0].mean()), 0.3, places=5)
            self.assertAlmostEqual(float(images[200].mean()), 0.1, places=5)    # 中间段沿用原成片
            self.assertAlmostEqual(float(images[350].mean()), 0.3, places=5)

    def test_all_segments_from_clips_needs_no_film(self):
        with _pin_folder_paths() as work:
            self._setup(work, film=False, clips=(0, 1, 2))
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                result = h3_assemble.assemble_film("T", [0, 1, 2])
            self.assertEqual((result["frames"], result["layout"], result["film"]), (423, [141, 141, 141], None))

    def test_missing_clips_and_bad_use_are_reported(self):
        with _pin_folder_paths() as work:
            self._setup(work, clips=(1,))
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                with self.assertRaises(ValueError) as ctx:
                    h3_assemble.assemble_film("T", [0])          # 第 1 段没有片段
                self.assertIn("第 1 段", str(ctx.exception))
                with self.assertRaises(ValueError) as ctx:
                    h3_assemble.assemble_film("T", [7])
                self.assertIn("段序号越界", str(ctx.exception))
                with self.assertRaises(ValueError) as ctx:
                    h3_assemble.assemble_film("T", [])
                self.assertIn("还没有选择要替换的段", str(ctx.exception))

    def test_missing_film_blocks_unselected_segments(self):
        with _pin_folder_paths() as work:
            self._setup(work, film=False, clips=(1,))
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                with self.assertRaises(ValueError) as ctx:
                    h3_assemble.assemble_film("T", [1])          # 其余段无处沿用
            self.assertIn("还没有可用的成片", str(ctx.exception))

    def test_size_mismatch_is_resized_with_notice(self):
        with _pin_folder_paths() as work:
            self._setup(work, clips=(1,), clip_size=12)

            def _resize(frames, width, height):
                return torch.nn.functional.interpolate(
                    frames.movedim(-1, 1), size=(height, width), mode="bilinear", align_corners=False).movedim(1, -1)

            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl), \
                    patch.object(h3_assemble, "_resize_frames", _resize):
                result = h3_assemble.assemble_film("T", [1])
            self.assertIn("已缩放到成片尺寸", " ".join(result["warnings"]))
            self.assertEqual(tuple(_FakeInputImpl.saved[-1][1].images.shape[1:3]), (8, 8))

    def test_missing_audio_warns_and_outputs_silent_film(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            _FakeInputImpl.sources[str(work / "output" / "clip1.mp4")] = (_frames(141, 0.2), None)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                result = h3_assemble.assemble_film("T", [1])
            self.assertIn("没有音频轨", " ".join(result["warnings"]))
            self.assertIsNone(_FakeInputImpl.saved[-1][1].audio)

    def test_progress_stages_and_cancel(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            stages = []
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                h3_assemble.assemble_film("T", [1], progress=lambda stage, value, total: stages.append((stage, value, total)))
                with self.assertRaises(h3_assemble._Cancelled):
                    h3_assemble.assemble_film("T", [1], should_cancel=lambda: True)
        self.assertTrue(stages[0][0].startswith("沿用原成片第 1..1 段"))
        self.assertEqual(stages[-1][0], "编码成片")
        self.assertEqual(stages[-1][1], stages[-1][2])


class AssembleTaskTests(_RecipeCase):
    class _InlineThread:
        """让路由起的后台线程在测试里同步跑完。"""

        def __init__(self, target=None, args=(), name=None, daemon=None):
            self._target, self._args = target, args

        def start(self):
            self._target(*self._args)

    def setUp(self):
        super().setUp()
        _FakeInputImpl.reset()
        h3_assemble._TASKS.clear()

    def _setup(self, work):
        _write_test_mp4(work / "output" / "film.mp4", frames=362, size=16)
        _FakeInputImpl.register(work / "output" / "film.mp4", _frames(362, 0.1), _audio())
        _write_test_mp4(work / "output" / "clip1.mp4", frames=141, size=16)
        _FakeInputImpl.register(work / "output" / "clip1.mp4", _frames(141, 0.2), _audio())
        self.write_recipe(results=[
            {"filename": "film.mp4", "kind": "video", "type": "output"},
            {"filename": "clip1.mp4", "kind": "video", "type": "output", "segment": 1},
        ])

    def _task(self, task_id="t1", **overrides):
        task = {"task_id": task_id, "status": "queued", "recipe": "T", "use": [1], "film": "", "blend": 0,
                "continuity": True, "context_frames": 22, "filename": None, "subfolder": None, "frames": 0,
                "progress": None,
                "stage": "", "clips": [], "warnings": [], "error": "", "cancel": False,
                "created": 0.0, "updated": 0.0}
        task.update(overrides)
        h3_assemble._TASKS[task_id] = task
        return task

    def test_run_task_records_success_failure_and_cancel(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            self._task()
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                h3_assemble._run_task("t1")
            task = h3_assemble._TASKS["t1"]
            self.assertEqual((task["status"], task["frames"]), ("succeeded", 124 + 141 + 119))
            self.assertTrue(task["filename"].endswith(".mp4"))
            self.assertEqual(task["subfolder"], "neo_director_merge")   # 快照带产物目录，取图才拼得对
            self.assertEqual([c["segment"] for c in task["clips"]], [1])

            self._task("t2", use=[9])
            h3_assemble._run_task("t2")
            self.assertEqual(h3_assemble._TASKS["t2"]["status"], "failed")
            self.assertIn("段序号越界", h3_assemble._TASKS["t2"]["error"])

            self._task("t3", cancel=True)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl):
                h3_assemble._run_task("t3")
            self.assertEqual(h3_assemble._TASKS["t3"]["status"], "cancelled")

    def test_assemble_route_starts_task_and_validates(self):
        with _pin_folder_paths() as work:
            self._setup(work)
            with patch.object(h3_assemble, "InputImpl", _FakeInputImpl), \
                    patch.object(h3_assemble.threading, "Thread", self._InlineThread):
                resp = _run_async(h3_assemble.assemble_segments_route(
                    _FakeRequest({"recipe": "T", "use": [1], "blend": 0})))
                data = _body(resp)
            self.assertEqual(resp.status, 200)
            self.assertTrue(data["success"])
            self.assertEqual((data["status"], data["frames"], data["use"]), ("succeeded", 384, [1]))
            self.assertEqual(data["subfolder"], "neo_director_merge")
            self.assertEqual(set(data), {"success", "task_id", "status", "recipe", "use", "film", "blend",
                                         "filename", "subfolder", "frames", "progress", "stage", "clips",
                                         "warnings", "error", "created", "updated"})
            for body, expect in (({"recipe": "T", "use": [5]}, "段序号越界"),
                                 ({"recipe": "Nope", "use": [0]}, "配方不存在"),
                                 ({"recipe": "T", "use": []}, "还没有选择要替换的段"),
                                 ({"recipe": "T", "use": [0]}, "第 1 段")):
                resp = _run_async(h3_assemble.assemble_segments_route(_FakeRequest(body)))
                self.assertEqual(resp.status, 400)
                self.assertIn(expect, _body(resp)["error"])
        self.write_recipe(name="P", preset=True)
        resp = _run_async(h3_assemble.assemble_segments_route(_FakeRequest({"recipe": "P", "use": [0]})))
        self.assertEqual(resp.status, 400)
        self.assertIn("只读", _body(resp)["error"])

    def test_status_and_cancel_routes(self):
        self._task("t1", status="running")
        resp = _run_async(h3_assemble.assemble_status_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertEqual((resp.status, _body(resp)["use"]), (200, [1]))
        resp = _run_async(h3_assemble.assemble_status_route(_FakeRequest(match={"task_id": "nope"})))
        self.assertEqual(resp.status, 404)
        resp = _run_async(h3_assemble.assemble_cancel_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertTrue(_body(resp)["success"])
        self.assertTrue(h3_assemble._TASKS["t1"]["cancel"])
        h3_assemble._TASKS["t1"]["status"] = "succeeded"
        resp = _run_async(h3_assemble.assemble_cancel_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertEqual((resp.status, _body(resp)["error"]), (409, "任务已结束，无法取消"))


if __name__ == "__main__":
    unittest.main()


