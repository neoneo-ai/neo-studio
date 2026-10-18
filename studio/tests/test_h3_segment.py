#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""h3_segment（单段生成 / 重生成）离线单测。

复用 test_h3_video_director 的桩环境（server / comfy / folder_paths / comfy_api + 真实 recipes 模块），
在其中加载 h3_segment。覆盖：成片帧区间复算、锚点取帧与降级、单段 spec 组装、run_single_segment 的
执行/落盘/记账，以及 /neo_video_gen/run_segment* 三个路由与任务 watcher。
"""

import asyncio
import contextlib
import json
import pathlib
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

import av
import torch

from test_h3_video_director import (   # noqa: E402  —— 复用同一套桩与工具
    _FakeComp,
    _load,
    _run_async,
    h3_video_director,
    recipes,
)

# 节点的预览路由要读「当前执行上下文」；离线环境里用桩替身，用例内再按需 patch。
_comfy_exec_utils = types.ModuleType("comfy_execution.utils")
_comfy_exec_utils.get_executing_context = lambda: None
sys.modules["comfy_execution.utils"] = _comfy_exec_utils

h3_segment = _load("h3_segment", "h3_segment.py")


def _write_test_mp4(path, frames=12, size=32):
    """写一段真实小 mp4（h264/24fps，逐帧灰度递增）：成片帧数与取帧走真实 PyAV 路径。"""
    import numpy as np

    with av.open(path, mode="w") as container:
        stream = container.add_stream("libx264", rate=24)
        stream.width = stream.height = size
        stream.pix_fmt = "yuv420p"
        for i in range(frames):
            gray = np.full((size, size, 3), i * 255 // max(1, frames - 1), dtype=np.uint8)
            frame = av.VideoFrame.from_ndarray(gray, format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return path


@contextlib.contextmanager
def _pin_folder_paths():
    """把 input/output 目录指到临时目录。

    其它测试模块会替换 sys.modules["folder_paths"]，而 h3_segment 在导入时已捕获当时的模块对象，
    recipes 又在函数里 `import folder_paths`。这里同时改这个对象的函数并把 sys.modules 指向它，
    保证「锚点 PNG 写入目录」与「配方 results 解析目录」看到的是同一套临时目录。
    """
    with tempfile.TemporaryDirectory() as work:
        out = pathlib.Path(work)
        (out / "output").mkdir()
        (out / "input").mkdir()
        fp = getattr(h3_segment, "folder_paths", None) or sys.modules["folder_paths"]
        saved_fp = sys.modules.get("folder_paths")
        saved_in, saved_out = fp.get_input_directory, fp.get_output_directory
        fp.get_input_directory = lambda: str(out / "input")
        fp.get_output_directory = lambda: str(out / "output")
        sys.modules["folder_paths"] = fp
        try:
            yield out
        finally:
            fp.get_input_directory, fp.get_output_directory = saved_in, saved_out
            if saved_fp is None:
                sys.modules.pop("folder_paths", None)
            else:
                sys.modules["folder_paths"] = saved_fp


def _png_mean(rel_name: str) -> float:
    """读回写入的锚点 png 的灰度均值，用于确认取到的是哪一帧。"""
    import numpy as np
    from PIL import Image

    path = pathlib.Path(h3_segment.folder_paths.get_input_directory()) / rel_name
    return float(np.asarray(Image.open(path).convert("L")).mean())


class _FakeSavedVideo:
    """假 VIDEO：get_components() 给段数，save_to() 真的落一个文件（验证产物路径与目录）。"""

    def __init__(self, frames=12):
        self._comp = _FakeComp(torch.zeros(frames, 8, 8, 3), None)
        self.saved = []

    def get_components(self):
        return self._comp

    def save_to(self, path, format=None, codec=None):
        pathlib.Path(path).write_bytes(b"mp4")
        self.saved.append((path, format, codec))


class _FakeRequest:
    """aiohttp 请求替身：json() 返回给定 body，match_info 用于路径参数，rel_url.query 用于查询串。"""

    def __init__(self, body=None, match=None, query=None):
        self._body = body or {}
        self.match_info = match or {}
        self.rel_url = types.SimpleNamespace(query=query or {})

    async def json(self):
        return self._body


def _body(resp) -> dict:
    return json.loads(resp.body.decode("utf-8"))


class _RecipeCase(unittest.TestCase):
    """把 recipes 的自定义/预设目录指到临时目录，并写一份最小 video_director 配方。"""

    SEGMENTS = ({"skill_id": "sk-a", "prompt": "第一段", "duration_sec": 5},
                {"skill_id": "sk-a", "prompt": "第二段", "duration_sec": 5},
                {"skill_id": "sk-a", "prompt": "第三段", "duration_sec": 5})

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self._tmp.name)
        self._dirs = (recipes.CUSTOM_DIR, recipes.PRESETS_DIR)
        recipes.CUSTOM_DIR = root / "custom"
        recipes.PRESETS_DIR = root / "presets"
        recipes.CUSTOM_DIR.mkdir(parents=True, exist_ok=True)
        recipes.PRESETS_DIR.mkdir(parents=True, exist_ok=True)
        h3_segment._SEGMENT_TASKS.clear()
        h3_segment._SEGMENT_WATCHERS.clear()
        h3_segment._RUNS.clear()

    def tearDown(self):
        recipes.CUSTOM_DIR, recipes.PRESETS_DIR = self._dirs
        self._tmp.cleanup()

    def spec(self, segments=None) -> dict:
        return {"shared": {"mode": "t2v", "seed": 7}, "segments": list(segments or self.SEGMENTS)}

    def write_recipe(self, name="T", segments=None, preset=False, **extra) -> pathlib.Path:
        base = recipes.PRESETS_DIR if preset else recipes.CUSTOM_DIR
        recipe_dir = base / name
        recipe_dir.mkdir(parents=True, exist_ok=True)
        meta = {"type": "video_director", "shared": {"mode": "t2v", "seed": 7},
                "segments": list(segments if segments is not None else self.SEGMENTS), **extra}
        (recipe_dir / "recipe.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return recipe_dir


def _length(seg) -> int:
    return h3_segment._segment_length(seg)


class SegmentLengthTests(unittest.TestCase):
    def test_duration_sec_wins(self):
        self.assertEqual(h3_segment._segment_length({"duration_sec": 5}), 124)

    def test_falls_back_to_skill_config_length(self):
        with patch.object(h3_segment, "get_skill_gen_config", lambda sid: {"length": 96}):
            self.assertEqual(h3_segment._segment_length({"skill_id": "sk-a"}), 96)

    def test_default_when_no_config(self):
        with patch.object(h3_segment, "get_skill_gen_config", lambda sid: None):
            self.assertEqual(h3_segment._segment_length({"skill_id": "sk-a"}), 124)


class SegmentFrameRangeTests(unittest.TestCase):
    def test_window_segments_drop_their_context_head(self):
        spec = {"segments": [{"duration_sec": 5}] * 3}
        window = h3_segment._align_context_frames(22)
        length = _length(spec["segments"][0])
        ranges = h3_segment._segment_frame_ranges(spec, True, 22)
        self.assertEqual(ranges[0], (0, length, length))                 # 首段没有上文，不丢帧
        for i in (1, 2):
            start, kept, generated = ranges[i]
            self.assertEqual(generated, h3_segment._align_frame_count_nearest(length + window, minimum=window + 5))
            self.assertEqual(kept, generated - window)
            self.assertEqual(start, sum(r[1] for r in ranges[:i]))       # 段起点 = 前面所有段保留帧之和

    def test_tier_a_chained_i2v_drops_one_frame(self):
        spec = {"segments": [{"duration_sec": 5}, {"duration_sec": 5, "mode": "i2v"}]}
        length = _length(spec["segments"][0])
        self.assertEqual(h3_segment._segment_frame_ranges(spec, True, 0),
                         [(0, length, length), (length, length - 1, length)])

    def test_no_continuity_keeps_every_frame(self):
        spec = {"segments": [{"duration_sec": 5}, {"duration_sec": 5, "mode": "i2v"}]}
        length = _length(spec["segments"][0])
        self.assertEqual(h3_segment._segment_frame_ranges(spec, False, 22),
                         [(0, length, length), (length, length, length)])


class RegenSpecTests(unittest.TestCase):
    SPEC = {"shared": {"mode": "mixed", "width": 1344},
            "segments": [{"skill_id": "seg-skill", "prompt": "p", "mode": "r2v", "duration_sec": 5,
                          "refs": {"images": ["a.png"], "videos": ["v.mp4"]}}]}

    def test_both_anchors_rewrite_to_fl2v_without_touching_segment_refs(self):
        out = h3_segment._regen_spec(self.SPEC, 0, "fl2v", "first.png", "last.png", "anchor-skill")
        self.assertEqual(out["shared"], self.SPEC["shared"])
        seg = out["segments"][0]
        self.assertEqual(seg["mode"], "fl2v")
        self.assertEqual((seg["ref_input"], seg["last_input"]), ("first.png", "last.png"))
        self.assertEqual(seg["skill_id"], "anchor-skill")
        # 身份参考走运行时注入通路（i2v/fl2v 模板只有单路首帧槽位），不再混进段参考
        self.assertEqual(seg["refs"]["images"], ["a.png"])
        self.assertEqual(seg["refs"]["videos"], ["v.mp4"])
        self.assertEqual(seg["prompt"], "p")
        self.assertNotIn("identity_images", out)     # 配方没有角色参考图

    def test_recipe_identity_images_ride_into_single_segment_spec(self):
        # 配方「角色参考图」原样带进单段 spec：单段重生成也靠它锚住角色身份
        out = h3_segment._regen_spec(dict(self.SPEC, identity_images=["char.png"]), 0, None, None, None, "")
        self.assertEqual(out["identity_images"], ["char.png"])

    def test_no_anchors_keeps_original_mode_and_skill(self):
        out = h3_segment._regen_spec(self.SPEC, 0, None, None, None, "")
        seg = out["segments"][0]
        self.assertEqual(seg["mode"], "r2v")
        self.assertEqual(seg["skill_id"], "seg-skill")
        self.assertIsNone(seg.get("ref_input"))
        self.assertEqual(seg["refs"]["images"], ["a.png"])



class AnchorSkillTests(unittest.TestCase):
    TEMPLATES = {
        "plain": {"6": {"inputs": {"image": "{{REF_IMAGE}}"}}},
        "fl": {"6": {"inputs": {"image": "{{REF_IMAGE}}", "last": "{{REF_IMAGE_LAST}}"}}},
        "none": {"6": {"inputs": {"prompt": "hi"}}},
    }

    def _load(self, sid):
        return self.TEMPLATES.get(sid, self.TEMPLATES["none"])

    def test_template_has_anchor_checks_tokens(self):
        self.assertTrue(h3_segment._template_has_anchor(self.TEMPLATES["fl"], need_last=True))
        self.assertFalse(h3_segment._template_has_anchor(self.TEMPLATES["plain"], need_last=True))
        self.assertTrue(h3_segment._template_has_anchor(self.TEMPLATES["plain"], need_last=False))
        self.assertFalse(h3_segment._template_has_anchor(self.TEMPLATES["none"], need_last=False))

    def test_keeps_segment_skill_when_it_supports_anchors(self):
        with patch.object(h3_segment, "load_skill_workflow", self._load), \
                patch.object(h3_segment, "_resolve_skill_id", lambda s: s):
            self.assertEqual(h3_segment._pick_anchor_skill("fl", need_last=True), "fl")

    def test_falls_back_to_first_supporting_skill(self):
        with patch.object(h3_segment, "load_skill_workflow", self._load), \
                patch.object(h3_segment, "_resolve_skill_id", lambda s: s), \
                patch.object(h3_segment, "_gen_video_skills", lambda: [{"id": "none"}, {"id": "plain"}]):
            self.assertEqual(h3_segment._pick_anchor_skill("none", need_last=False), "plain")

    def test_raises_when_no_skill_supports_anchors(self):
        with patch.object(h3_segment, "load_skill_workflow", self._load), \
                patch.object(h3_segment, "_resolve_skill_id", lambda s: s), \
                patch.object(h3_segment, "_gen_video_skills", lambda: [{"id": "none"}]):
            with self.assertRaises(ValueError) as ctx:
                h3_segment._pick_anchor_skill("none", need_last=True)
        self.assertIn("没有支持首/尾帧锚点", str(ctx.exception))


class FilmPickTests(_RecipeCase):
    def _films(self, work, names):
        for name in names:
            _write_test_mp4(work / "output" / name, frames=6, size=16)

    def test_newest_non_segment_video_is_the_default(self):
        with _pin_folder_paths() as work:
            self._films(work, ["old.mp4", "newer.mp4", "clip.mp4"])
            self.write_recipe(results=[
                {"filename": "old.mp4", "kind": "video", "type": "output", "at": "2026-01-01 10:00:00"},
                {"filename": "newer.mp4", "kind": "video", "type": "output", "at": "2026-01-02 10:00:00"},
                {"filename": "clip.mp4", "kind": "video", "type": "output", "at": "2026-01-03 10:00:00", "segment": 1},
            ])
            self.assertEqual([c["filename"] for c in h3_segment._film_candidates("T")], ["newer.mp4", "old.mp4"])
            self.assertEqual(h3_segment._film_entry("T")["filename"], "newer.mp4")
            self.assertEqual(h3_segment._film_entry("T", "old.mp4")["filename"], "old.mp4")

    def test_pinned_film_must_be_one_of_the_recipe_results(self):
        with _pin_folder_paths() as work:
            self._films(work, ["newest.mp4"])
            self.write_recipe(results=[{"filename": "newest.mp4", "kind": "video", "type": "output"}])
            with self.assertRaises(ValueError) as ctx:
                h3_segment._film_entry("T", "other.mp4")
            self.assertIn("不在该配方的结果里", str(ctx.exception))
            self.assertIn("newest.mp4", str(ctx.exception))       # 报错里列出可选成片

    def test_no_film_returns_none(self):
        with _pin_folder_paths():
            self.write_recipe()
            self.assertIsNone(h3_segment._film_entry("T"))


class FilmLayoutTests(_RecipeCase):
    SEGMENTS3 = ({"skill_id": "sk-a", "prompt": "p", "duration_sec": 5},) * 3

    def test_recorded_layout_wins_over_recomputed(self):
        with _pin_folder_paths() as work:
            spec = self.spec(self.SEGMENTS3)
            _write_test_mp4(work / "output" / "merged.mp4", frames=300, size=16)
            self.write_recipe(segments=self.SEGMENTS3, results=[
                {"filename": "merged.mp4", "kind": "video", "type": "output", "layout": [158, 120, 22]}])
            film = h3_segment._film_entry("T")
            self.assertEqual(h3_segment.film_layout(film, spec, True, 22), [(0, 158), (158, 120), (278, 22)])

    def test_layout_ignored_when_sum_mismatches(self):
        with _pin_folder_paths() as work:
            spec = self.spec(self.SEGMENTS3)
            total = sum(r[1] for r in h3_segment._segment_frame_ranges(spec, False, 0))
            _write_test_mp4(work / "output" / "film.mp4", frames=total, size=16)
            self.write_recipe(segments=self.SEGMENTS3, results=[
                {"filename": "film.mp4", "kind": "video", "type": "output", "layout": [1, 2, 3]}])
            film = h3_segment._film_entry("T")
            # layout 与实际帧数对不上 → 回退到配方复算（continuity 关时各段保留 = 段长）
            self.assertEqual(h3_segment.film_layout(film, spec, False, 0)[0], (0, 124))

    def test_recomputed_layout_rejects_frame_count_mismatch(self):
        with _pin_folder_paths() as work:
            spec = self.spec(self.SEGMENTS3)
            _write_test_mp4(work / "output" / "film.mp4", frames=7, size=16)
            self.write_recipe(segments=self.SEGMENTS3, results=[
                {"filename": "film.mp4", "kind": "video", "type": "output"}])
            film = h3_segment._film_entry("T")
            with self.assertRaises(ValueError) as ctx:
                h3_segment.film_layout(film, spec, True, 22)
            self.assertIn("成片 film.mp4 的帧数 7", str(ctx.exception))


class AnchorResolveTests(_RecipeCase):
    SEGMENTS3 = ({"skill_id": "sk-a", "prompt": "p", "duration_sec": 5},) * 3

    def _film(self, work, frames, name="film.mp4"):
        _write_test_mp4(work / "output" / name, frames=frames, size=32)
        return [{"filename": name, "kind": "video", "type": "output"}]

    def _resolve(self, spec, index, anchors, warnings, continuity=False, context_frames=0, film=None):
        """按生产路径来：先定成片条目（`_film_entry`），再按段边界取锚点。"""
        return h3_segment.resolve_anchors(spec, index, anchors, continuity, context_frames, warnings,
                                          h3_segment._film_entry("T", film))

    def test_reads_neighbour_frames_from_film(self):
        with _pin_folder_paths() as work:
            spec = self.spec(self.SEGMENTS3)
            ranges = h3_segment._segment_frame_ranges(spec, False, 0)
            total = ranges[-1][0] + ranges[-1][1]
            self.write_recipe(segments=self.SEGMENTS3, results=self._film(work, total))

            warnings = []
            mode, first, last = self._resolve(spec, 1, "both", warnings)
            self.assertEqual((mode, warnings), ("both", []))
            head, tail = ranges[0][1] - 1, ranges[0][1] + ranges[1][1]
            self.assertAlmostEqual(_png_mean(first), head * 255.0 / (total - 1), delta=8)
            self.assertAlmostEqual(_png_mean(last), tail * 255.0 / (total - 1), delta=8)
            self.assertTrue(pathlib.Path(first).name.startswith("film_"))   # 锚点名带成片名，可追溯来源

    def test_pinned_film_decides_where_anchors_come_from(self):
        with _pin_folder_paths() as work:
            spec = self.spec(self.SEGMENTS3)
            total = sum(r[1] for r in h3_segment._segment_frame_ranges(spec, False, 0))
            _write_test_mp4(work / "output" / "old.mp4", frames=total, size=32)
            _write_test_mp4(work / "output" / "new.mp4", frames=6, size=32)
            self.write_recipe(segments=self.SEGMENTS3, results=[
                {"filename": "old.mp4", "kind": "video", "type": "output"},
                {"filename": "new.mp4", "kind": "video", "type": "output"},
            ])
            # 默认取最新的 new.mp4 → 帧数对不上，报错并点名是哪个成片
            with self.assertRaises(ValueError) as ctx:
                self._resolve(spec, 0, "both", [])
            self.assertIn("new.mp4", str(ctx.exception))
            # 指定 old.mp4 → 帧数一致，正常取锚点
            mode, first, _last = self._resolve(spec, 0, "both", [], film="old.mp4")
            self.assertEqual(mode, "both")
            self.assertTrue(pathlib.Path(first).name.startswith("old_"))


    def test_first_segment_uses_its_own_first_frame(self):
        with _pin_folder_paths() as work:
            spec = self.spec(self.SEGMENTS3)
            total = sum(r[1] for r in h3_segment._segment_frame_ranges(spec, False, 0))
            self.write_recipe(segments=self.SEGMENTS3, results=self._film(work, total))
            mode, first, _last = self._resolve(spec, 0, "both", [])
            self.assertEqual(mode, "both")
            self.assertAlmostEqual(_png_mean(first), 0.0, delta=8)

    def test_last_segment_falls_back_to_first_anchor_with_warning(self):
        with _pin_folder_paths() as work:
            spec = self.spec(self.SEGMENTS3)
            total = sum(r[1] for r in h3_segment._segment_frame_ranges(spec, False, 0))
            self.write_recipe(segments=self.SEGMENTS3, results=self._film(work, total))
            warnings = []
            mode, first, last = self._resolve(spec, 2, "both", warnings)
            self.assertEqual((mode, last), ("first", None))
            self.assertIsNotNone(first)
            self.assertIn("尾帧锚点", " ".join(warnings))

    def test_missing_film_downgrades_to_no_anchors(self):
        with _pin_folder_paths():
            self.write_recipe()
            warnings = []
            self.assertEqual(self._resolve(self.spec(), 0, "both", warnings, continuity=True, context_frames=22),
                             ("none", None, None))
            self.assertIn("还没有可用的成片", " ".join(warnings))

    def test_frame_count_mismatch_raises_with_film_name(self):
        with _pin_folder_paths() as work:
            spec = self.spec()
            total = sum(r[1] for r in h3_segment._segment_frame_ranges(spec, False, 0))
            self.write_recipe(results=self._film(work, total - 17))
            with self.assertRaises(ValueError) as ctx:
                self._resolve(spec, 0, "both", [])
        self.assertIn("成片 film.mp4 的帧数", str(ctx.exception))

    def test_segment_clip_results_are_not_used_as_film(self):
        with _pin_folder_paths() as work:
            spec = self.spec()
            _write_test_mp4(work / "output" / "regen.mp4", frames=7, size=32)
            self.write_recipe(results=[{"filename": "regen.mp4", "kind": "video", "type": "output", "segment": 0}])
            warnings = []
            self.assertEqual(self._resolve(spec, 0, "both", warnings), ("none", None, None))
            self.assertIn("还没有可用的成片", " ".join(warnings))




class _RunSpecRecorder:
    """_run_spec 替身：记录调用参数并返回一段假视频（不碰真实模型 / 队列）。"""

    def __init__(self, frames=12):
        self.calls = []
        self.video = _FakeSavedVideo(frames)

    def __call__(self, spec, seed, width, height, continuity, context_frames, model, steps, preview, unique_id,
                 progress_index=0, progress_total=None):
        self.calls.append({"spec": spec, "seed": seed, "width": width, "height": height, "continuity": continuity,
                           "context_frames": context_frames, "model": model, "steps": steps, "preview": preview,
                           "unique_id": unique_id, "progress_index": progress_index,
                           "progress_total": progress_total})
        return (self.video,)


class RunSingleSegmentTests(_RecipeCase):
    def test_no_anchors_records_segment_and_new_seed(self):
        with _pin_folder_paths() as work:
            self.write_recipe()
            rec = _RunSpecRecorder(frames=124)
            with patch.object(h3_video_director.NeoH3VideoDirector, "_run_spec", rec):
                out = h3_segment.run_single_segment("T", 1, "none", -1, steps=8, preview_node_id="42")
            self.assertEqual(len(rec.calls), 1)
            call = rec.calls[0]
            self.assertEqual(call["seed"], out["seed"])
            self.assertGreaterEqual(call["seed"], 0)
            self.assertEqual((call["steps"], call["preview"], call["unique_id"]), (8, True, "42"))
            # 连续性开关按入参透传（身份参考随它生效）；单段不链入上下文窗口：context_frames 恒为 0
            self.assertEqual((call["continuity"], call["context_frames"]), (True, 0))
            self.assertEqual(call["model"], None)           # 队列执行：模型由模板里的加载器提供
            self.assertEqual(call["spec"]["segments"][0]["skill_id"], "sk-a")
            self.assertEqual((out["frames"], out["anchors"], out["film"]), (124, "none", None))
            self.assertTrue((work / "output" / "neo_director_regen" / out["filename"]).is_file())
            results = recipes.list_recipe_results("T")
            self.assertEqual(len(results), 1)
            self.assertEqual((results[0]["segment"], results[0]["seed"]), (1, out["seed"]))

    def test_pinned_film_is_reported_and_used(self):
        with _pin_folder_paths() as work:
            spec = self.spec()
            total = sum(r[1] for r in h3_segment._segment_frame_ranges(spec, False, 0))
            _write_test_mp4(work / "output" / "old.mp4", frames=total, size=32)
            _write_test_mp4(work / "output" / "new.mp4", frames=6, size=32)
            self.write_recipe(results=[
                {"filename": "old.mp4", "kind": "video", "type": "output"},
                {"filename": "new.mp4", "kind": "video", "type": "output"},
            ])
            rec = _RunSpecRecorder()
            with patch.object(h3_video_director.NeoH3VideoDirector, "_run_spec", rec), \
                    patch.object(h3_segment, "_pick_anchor_skill", lambda seg_skill, need_last: "anchor-skill"):
                out = h3_segment.run_single_segment("T", 0, "both", 7, record=False, film="old.mp4",
                                                    continuity=False, context_frames=0)
            self.assertEqual(out["film"], "old.mp4")            # 上报实际用作锚点来源的成片
            self.assertEqual(rec.calls[0]["spec"]["segments"][0]["ref_input"] is not None, True)
            with self.assertRaises(ValueError) as ctx:
                h3_segment.run_single_segment("T", 0, "both", 7, record=False, film="missing.mp4")
            self.assertIn("不在该配方的结果里", str(ctx.exception))

    def test_anchors_rewrite_spec_and_keep_given_seed(self):
        with _pin_folder_paths():
            self.write_recipe()
            rec = _RunSpecRecorder()
            with patch.object(h3_video_director.NeoH3VideoDirector, "_run_spec", rec), \
                    patch.object(h3_segment, "resolve_anchors", lambda *a, **k: ("both", "a.png", "b.png")), \
                    patch.object(h3_segment, "_film_entry",
                                 lambda recipe, film=None: {"path": "F:/film.mp4", "filename": "film.mp4"}), \
                    patch.object(h3_segment, "_video_size", lambda path: (0, 0)), \
                    patch.object(h3_segment, "_pick_anchor_skill", lambda seg_skill, need_last: "anchor-skill"):
                out = h3_segment.run_single_segment("T", 1, "both", 1234, record=False)
            seg = rec.calls[0]["spec"]["segments"][0]
            self.assertEqual((seg["mode"], seg["ref_input"], seg["last_input"], seg["skill_id"]),
                             ("fl2v", "a.png", "b.png", "anchor-skill"))
            self.assertEqual(rec.calls[0]["seed"], 1234)
            self.assertEqual(out["film"], "film.mp4")
            self.assertIsNone(out["filename"])
            self.assertEqual(recipes.list_recipe_results("T"), [])

    def test_pre_resolved_anchors_are_reused(self):
        with _pin_folder_paths():
            self.write_recipe()
            rec = _RunSpecRecorder()
            with patch.object(h3_video_director.NeoH3VideoDirector, "_run_spec", rec), \
                    patch.object(h3_segment, "resolve_anchors", side_effect=AssertionError("不应重复解析锚点")), \
                    patch.object(h3_segment, "_pick_anchor_skill", lambda seg_skill, need_last: "anchor-skill"):
                h3_segment.run_single_segment("T", 0, "both", 1, record=False,
                                              anchors_ready=("first", "only-first.png", None))
            seg = rec.calls[0]["spec"]["segments"][0]
            self.assertEqual((seg["mode"], seg["ref_input"], seg.get("last_input")),
                             ("i2v", "only-first.png", None))

    def test_rejects_preset_recipe_and_bad_index(self):
        self.write_recipe()
        self.write_recipe(name="P", preset=True)
        with self.assertRaises(ValueError) as ctx:
            h3_segment.run_single_segment("P", 0, "none", -1)
        self.assertIn("只读", str(ctx.exception))
        with self.assertRaises(ValueError) as ctx:
            h3_segment.run_single_segment("T", 9, "none", -1)
        self.assertIn("段序号越界", str(ctx.exception))


class _FakeQueue:
    def __init__(self, dequeue=True, interrupt=True):
        self._dequeue, self._interrupt, self.calls = dequeue, interrupt, []

    def delete_queue_item(self, predicate):
        self.calls.append("dequeue")
        return self._dequeue

    def interrupt_if_running(self, prompt_id):
        self.calls.append("interrupt")
        return self._interrupt


def _task_snapshot(task_id="t1", prompt_id="p1") -> dict:
    return {"task_id": task_id, "prompt_id": prompt_id, "status": "running", "recipe": "T", "segment": 0,
            "seed": -1, "filename": None, "subfolder": h3_segment.SEG_OUT_SUBDIR, "film": None,
            "progress": None, "warnings": [], "error": "", "created": 0.0, "updated": 0.0}


class FilmSizeNoticeTests(_RecipeCase):
    def test_generates_at_the_film_size(self):
        with _pin_folder_paths() as work:
            spec = self.spec()
            total = sum(r[1] for r in h3_segment._segment_frame_ranges(spec, False, 0))
            _write_test_mp4(work / "output" / "film.mp4", frames=total, size=24)     # 成片 24×24
            self.write_recipe(results=[{"filename": "film.mp4", "kind": "video", "type": "output"}],
                              shared={"mode": "t2v", "seed": 7, "width": 32, "height": 32})
            rec = _RunSpecRecorder()
            with patch.object(h3_video_director.NeoH3VideoDirector, "_run_spec", rec), \
                    patch.object(h3_segment, "_pick_anchor_skill", lambda seg_skill, need_last: "anchor-skill"):
                out = h3_segment.run_single_segment("T", 0, "both", 1, record=False,
                                                    continuity=False, context_frames=0)
            # 按成片尺寸生成（而不是配方的 32×32），并提示两者不同
            self.assertEqual((rec.calls[0]["width"], rec.calls[0]["height"]), (24, 24))
            self.assertIn("按成片尺寸 24×24 生成", " ".join(out["warnings"]))

    def test_no_notice_and_film_size_when_sizes_match(self):
        with _pin_folder_paths() as work:
            spec = self.spec()
            total = sum(r[1] for r in h3_segment._segment_frame_ranges(spec, False, 0))
            _write_test_mp4(work / "output" / "film.mp4", frames=total, size=32)
            self.write_recipe(results=[{"filename": "film.mp4", "kind": "video", "type": "output"}],
                              shared={"mode": "t2v", "seed": 7, "width": 32, "height": 32})
            rec = _RunSpecRecorder()
            with patch.object(h3_video_director.NeoH3VideoDirector, "_run_spec", rec), \
                    patch.object(h3_segment, "_pick_anchor_skill", lambda seg_skill, need_last: "anchor-skill"):
                out = h3_segment.run_single_segment("T", 0, "both", 1, record=False,
                                                    continuity=False, context_frames=0)
            self.assertEqual(out["warnings"], [])
            self.assertEqual((rec.calls[0]["width"], rec.calls[0]["height"]), (32, 32))


class RunSegmentRouteTests(_RecipeCase):
    def test_run_prompt_builds_single_node_graph(self):
        with _pin_folder_paths() as work:
            segments = [{"skill_id": "sk-a", "prompt": "p", "duration_sec": 5}]
            _write_test_mp4(work / "output" / "clip.mp4", frames=h3_segment._segment_length(segments[0]), size=16)
            self.write_recipe(segments=segments, results=[{"filename": "clip.mp4", "kind": "video", "type": "output"}])
            payload = h3_segment._run_prompt({"recipe": "T", "segment": 0, "anchors": "first", "seed": 5,
                                              "film": "clip.mp4"})
        node = payload["graph"]["1"]
        self.assertEqual(node["class_type"], "NeoH3SegmentRun")
        self.assertEqual(node["inputs"]["segment"], 1)              # 节点对外 1 起
        self.assertEqual(node["inputs"]["anchors"], "只钉首帧")
        self.assertTrue(node["inputs"]["record"])                   # 路由流一定落盘并记账
        self.assertEqual((payload["index"], payload["seed"]), (0, 5))
        self.assertEqual(node["inputs"]["film"], "clip.mp4")        # 指定锚点来源成片

    def test_run_prompt_rejects_bad_requests(self):
        self.write_recipe()
        for body, expect in (({"recipe": ""}, "缺少配方名"),
                             ({"recipe": "T", "segment": 99}, "段序号越界"),
                             ({"recipe": "T", "segment": 0, "anchors": "wat"}, "未知锚点模式"),
                             ({"recipe": "Nope", "segment": 0}, "配方不存在")):
            with self.assertRaises(ValueError) as ctx:
                h3_segment._run_prompt(body)
            self.assertIn(expect, str(ctx.exception))
        self.write_recipe(name="P", preset=True)
        with self.assertRaises(ValueError) as ctx:
            h3_segment._run_prompt({"recipe": "P", "segment": 0})
        self.assertIn("只读", str(ctx.exception))
        # 指定的成片不在配方结果里 → 明确报错（不悄悄回落到别的成片）
        with self.assertRaises(ValueError) as ctx:
            h3_segment._run_prompt({"recipe": "T", "segment": 0, "anchors": "both", "film": "nope.mp4"})
        self.assertIn("不在该配方的结果里", str(ctx.exception))

    def test_run_prompt_checks_film_frame_count_only_when_anchoring(self):
        self.write_recipe()
        with patch.object(h3_segment, "_film_entry", lambda recipe, film=None: {"filename": "film.mp4",
                                                                               "path": "film.mp4"}), \
                patch.object(h3_segment, "_video_frame_count", lambda path: 999):
            with self.assertRaises(ValueError) as ctx:
                h3_segment._run_prompt({"recipe": "T", "segment": 0, "anchors": "both"})
            self.assertIn("成片 film.mp4 的帧数 999", str(ctx.exception))
            self.assertTrue(h3_segment._run_prompt({"recipe": "T", "segment": 0, "anchors": "none"}))

    def test_submit_route_creates_task_and_watcher_tracks_progress(self):
        self.write_recipe()
        submitted = []

        async def _fake_submit(graph):
            submitted.append(graph)
            return "prompt-1"

        def _fake_lookup(prompt_id):
            return ("running", None)

        async def _flow():
            resp = await h3_segment.run_segment_route(_FakeRequest(
                {"recipe": "T", "segment": 0, "anchors": "none", "node_id": 7, "preview": False}))
            data = _body(resp)
            await asyncio.sleep(0.05)      # 让 watcher 跑一轮
            return resp, data

        with patch.object(h3_segment, "submit_graph", _fake_submit), \
                patch.object(h3_segment, "_lookup", _fake_lookup), \
                patch.object(h3_segment, "_progress_for", lambda pid: {"value": 3, "max": 10}), \
                patch.object(h3_segment, "POLL_INTERVAL", 0.01):
            resp, data = _run_async(_flow())

        self.assertEqual(resp.status, 200)
        self.assertTrue(data["success"])
        self.assertEqual(len(submitted), 1)
        self.assertEqual(submitted[0]["1"]["class_type"], "NeoH3SegmentRun")
        self.assertFalse(submitted[0]["1"]["inputs"]["preview"])
        self.assertEqual(h3_segment._RUNS["prompt-1"], {"preview_node_id": 7})   # 预览路由回编辑器所属节点
        task = h3_segment._SEGMENT_TASKS[data["task_id"]]
        self.assertEqual((task["status"], task["progress"]), ("running", {"value": 3, "max": 10}))
        self.assertEqual((task["recipe"], task["segment"]), ("T", 0))

    def test_submit_route_maps_validation_and_submit_errors(self):
        self.write_recipe()
        resp = _run_async(h3_segment.run_segment_route(_FakeRequest({"recipe": "T", "segment": 99})))
        self.assertEqual(resp.status, 400)
        self.assertIn("段序号越界", _body(resp)["error"])

        async def _reject(graph):
            raise ValueError("Prompt has no outputs")

        async def _boom(graph):
            raise RuntimeError("queue down")

        for handler, status in ((_reject, 400), (_boom, 500)):
            with patch.object(h3_segment, "submit_graph", handler):
                resp = _run_async(h3_segment.run_segment_route(
                    _FakeRequest({"recipe": "T", "segment": 0, "anchors": "none"})))
            self.assertEqual(resp.status, status)
            self.assertTrue(_body(resp)["error"])

    def test_status_route_roundtrip(self):
        h3_segment._SEGMENT_TASKS["t1"] = {**_task_snapshot("t1", "p1"), "segment": 2, "seed": 7,
                                           "progress": {"value": 1, "max": 4}}
        resp = _run_async(h3_segment.run_segment_status_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertEqual((resp.status, _body(resp)["segment"], _body(resp)["seed"]), (200, 2, 7))
        self.assertEqual(set(_body(resp)), {"success", "task_id", "prompt_id", "status", "recipe", "segment", "seed",
                                            "filename", "subfolder", "film", "progress", "warnings", "error",
                                            "created", "updated"})
        self.assertEqual(_body(resp)["subfolder"], "neo_director_regen")
        resp = _run_async(h3_segment.run_segment_status_route(_FakeRequest(match={"task_id": "nope"})))
        self.assertEqual((resp.status, _body(resp)["error"]), (404, "任务不存在"))

    def test_cancel_route_dequeues_or_interrupts(self):
        h3_segment._SEGMENT_TASKS["t1"] = _task_snapshot()
        queue = _FakeQueue()
        fake_server = types.SimpleNamespace(instance=types.SimpleNamespace(prompt_queue=queue))
        with patch.object(h3_segment, "PromptServer", fake_server):
            resp = _run_async(h3_segment.run_segment_cancel_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertTrue(_body(resp)["success"])
        self.assertEqual(queue.calls, ["dequeue", "interrupt"])

        idle = _FakeQueue(dequeue=False, interrupt=False)
        with patch.object(h3_segment, "PromptServer",
                          types.SimpleNamespace(instance=types.SimpleNamespace(prompt_queue=idle))):
            resp = _run_async(h3_segment.run_segment_cancel_route(_FakeRequest(match={"task_id": "t1"})))
        self.assertEqual((resp.status, _body(resp)["error"]), (409, "任务已结束，无法取消"))

        resp = _run_async(h3_segment.run_segment_cancel_route(_FakeRequest(match={"task_id": "nope"})))
        self.assertEqual(resp.status, 404)

    def test_watch_records_result_and_failure_states(self):
        h3_segment._SEGMENT_TASKS["t1"] = _task_snapshot()
        h3_segment._RUNS["p1"] = {"preview_node_id": 7, "filename": "s.mp4", "seed": 9,
                                  "film": "film.mp4", "warnings": ["w"]}

        def _ok(prompt_id):
            return ("done", {"status": {"completed": True}})

        with patch.object(h3_segment, "_lookup", _ok), patch.object(h3_segment, "POLL_INTERVAL", 0.01):
            _run_async(h3_segment._watch("t1"))
        task = h3_segment._SEGMENT_TASKS["t1"]
        self.assertEqual((task["status"], task["filename"], task["film"], task["seed"], task["warnings"]),
                         ("succeeded", "s.mp4", "film.mp4", 9, ["w"]))
        self.assertEqual(task["subfolder"], "neo_director_regen")
        self.assertNotIn("p1", h3_segment._RUNS)

        h3_segment._SEGMENT_TASKS["t2"] = _task_snapshot("t2", "p2")

        def _failed(prompt_id):
            return ("done", {"status": {"messages": [["execution_error", {
                "exception_message": "CUDA out of memory", "node_id": 1, "node_type": "NeoH3SegmentRun"}]]}})

        with patch.object(h3_segment, "_lookup", _failed), patch.object(h3_segment, "POLL_INTERVAL", 0.01):
            _run_async(h3_segment._watch("t2"))
        self.assertEqual(h3_segment._SEGMENT_TASKS["t2"]["status"], "failed")
        self.assertIn("CUDA out of memory", h3_segment._SEGMENT_TASKS["t2"]["error"])
        self.assertIsNone(h3_segment._SEGMENT_TASKS["t2"]["subfolder"])

        h3_segment._SEGMENT_TASKS["t3"] = _task_snapshot("t3", "p3")

        def _cancelled(prompt_id):
            return ("done", {"status": {"messages": [["execution_interrupted", {}]]}})

        with patch.object(h3_segment, "_lookup", _cancelled), patch.object(h3_segment, "POLL_INTERVAL", 0.01):
            _run_async(h3_segment._watch("t3"))
        self.assertEqual(h3_segment._SEGMENT_TASKS["t3"]["status"], "cancelled")

    def test_watch_stops_for_finished_or_missing_task(self):
        def _never(prompt_id):       # 已结束的任务不再查询队列
            raise AssertionError("不应查询已结束的任务")

        h3_segment._SEGMENT_TASKS["t1"] = {**_task_snapshot(), "status": "succeeded"}
        with patch.object(h3_segment, "_lookup", _never), patch.object(h3_segment, "POLL_INTERVAL", 0.01):
            _run_async(h3_segment._watch("t1"))
            _run_async(h3_segment._watch("gone"))
        self.assertEqual(h3_segment._SEGMENT_TASKS["t1"]["status"], "succeeded")

    def test_prune_tasks_keeps_running_and_drops_stale(self):
        h3_segment._SEGMENT_TASKS["old"] = {**_task_snapshot("old"), "status": "succeeded",
                                            "updated": time.time() - h3_segment.TASK_TTL - 1}
        h3_segment._SEGMENT_TASKS["live"] = {**_task_snapshot("live"), "status": "running"}
        h3_segment._prune_tasks()
        self.assertNotIn("old", h3_segment._SEGMENT_TASKS)
        self.assertIn("live", h3_segment._SEGMENT_TASKS)


class SegmentRunNodeTests(_RecipeCase):
    def test_input_types_expose_recipe_and_segment(self):
        self.write_recipe()
        self.write_recipe(name="P", preset=True)
        spec = h3_segment.NeoH3SegmentRun.INPUT_TYPES()
        self.assertEqual(sorted(spec["required"]), ["anchors", "recipe", "record", "seed", "segment"])
        self.assertIn("P", spec["required"]["recipe"][0])          # 预设与自定义配方都能选
        self.assertEqual(spec["required"]["anchors"][0], list(h3_segment.ANCHOR_LABELS))
        self.assertEqual(spec["required"]["seed"][1]["default"], -1)
        self.assertEqual(sorted(spec["optional"]),
                         ["context_frames", "continuity", "film", "preview", "steps"])
        self.assertEqual(spec["optional"]["film"][1]["default"], "")   # 留空 = 用最新成片
        self.assertEqual(spec["hidden"], {"unique_id": "UNIQUE_ID"})

    def test_node_is_an_output_node(self):
        # 路由提交的是「只有一个本节点」的 prompt；ComfyUI 的 validate_prompt 要求存在输出节点，
        # 否则直接以 "Prompt has no outputs" 拒绝（画布上不接 SaveVideo 也不执行）。
        self.assertTrue(h3_segment.NeoH3SegmentRun.OUTPUT_NODE)
        self.assertEqual(h3_segment.NeoH3SegmentRun.RETURN_TYPES, ("VIDEO",))

    def test_node_forwards_metadata_and_writes_result_back(self):
        self.write_recipe()
        calls = []

        def _fake_run(recipe, index, anchors, seed, **kwargs):
            calls.append({"recipe": recipe, "index": index, "anchors": anchors, "seed": seed, **kwargs})
            return {"video": "VIDEO", "filename": "s.mp4", "subfolder": "neo_director_regen", "seed": seed,
                    "frames": 124, "anchors": anchors, "film": "film.mp4", "warnings": ["w"]}

        node = h3_segment.NeoH3SegmentRun()
        h3_segment._RUNS["prompt-9"] = {"preview_node_id": 7}
        with patch.object(h3_segment, "run_single_segment", _fake_run), \
                patch.object(h3_segment, "get_executing_context",
                             lambda: types.SimpleNamespace(prompt_id="prompt-9", node_id="1")):
            out = node.run_segment(recipe="T", segment=2, anchors="只钉首帧", seed=5, record=False, steps=8,
                                   preview=True, continuity=False, context_frames=0, film="old.mp4", unique_id="1")
        self.assertEqual(out, ("VIDEO",))
        call = calls[0]
        self.assertEqual((call["recipe"], call["index"], call["anchors"], call["seed"]), ("T", 1, "first", 5))
        self.assertEqual((call["steps"], call["preview"], call["continuity"], call["context_frames"]),
                         (8, True, False, 0))
        self.assertEqual(call["preview_node_id"], 7)     # 提交路由指定：实时预览推回编辑器节点面板
        self.assertEqual(call["film"], "old.mp4")        # 指定的成片透传（空 = 最新）
        self.assertFalse(call["record"])
        self.assertEqual(h3_segment._RUNS["prompt-9"],
                         {"preview_node_id": 7, "filename": "s.mp4", "seed": 5, "frames": 124, "film": "film.mp4",
                          "anchors": "first", "warnings": ["w"]})

    def test_node_keeps_own_id_when_not_submitted_by_route(self):
        self.write_recipe()
        calls = []

        def _fake_run(recipe, index, anchors, seed, **kwargs):
            calls.append(kwargs)
            return {"video": "VIDEO", "filename": None, "subfolder": "neo_director_regen", "seed": seed,
                    "frames": 12, "anchors": anchors, "film": None, "warnings": []}

        node = h3_segment.NeoH3SegmentRun()
        with patch.object(h3_segment, "run_single_segment", _fake_run), \
                patch.object(h3_segment, "get_executing_context", lambda: None):
            node.run_segment(recipe="T", segment=1, anchors="两端锚点", seed=-1, unique_id="88")
        self.assertEqual(calls[0]["preview_node_id"], "88")
        self.assertEqual(calls[0]["film"], "")
        self.assertEqual(h3_segment._RUNS, {})     # 画布上直接跑：不保留运行元数据


if __name__ == "__main__":
    unittest.main()
