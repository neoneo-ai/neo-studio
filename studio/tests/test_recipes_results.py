# SPDX-License-Identifier: Apache-2.0
"""recipes 配方结果（results）后端逻辑的离线单测。

结果 = 执行产物在 output 目录里的路径：只记路径不复制文件（区别于 samples 的内容副本），
面板点击查看、删除时连同磁盘上的真实文件一起删。server 用桩模块替换，
gallery/bookmark/gallery_lora/util 用假模块，CUSTOM_DIR/PRESETS_DIR/RECIPES_DIR
指向临时目录，验证 _norm_result / _result_path 的校验、add_results / delete_result
端点、列表回读过滤、以及重存配方不丢结果。"""

from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import asyncio
import json
import logging
import os
import pathlib
import sys
import tempfile
import types
import unittest

_TMP = tempfile.mkdtemp(prefix="neo_recipes_results_")
_OUTPUT_DIR = os.path.join(_TMP, "output")
_INPUT_DIR = os.path.join(_TMP, "input")
os.makedirs(_OUTPUT_DIR, exist_ok=True)
os.makedirs(_INPUT_DIR, exist_ok=True)

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server


def _annotated_filepath(name, base_dir):
    """与核心一致：拼路径并拒绝越出 base_dir 的名字。"""
    base = os.path.abspath(base_dir)
    path = os.path.abspath(os.path.join(base, str(name).replace("/", os.sep)))
    if os.path.commonpath([base, path]) != base:
        raise ValueError("escapes base")
    return path


_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
_folder_paths.get_temp_directory = lambda: os.path.join(_TMP, "temp")
_folder_paths.get_annotated_filepath = _annotated_filepath


class StubFolderPathsMixin:
    """folder_paths 桩只在用例期间挂到 sys.modules：其它测试文件也用同名桩并各自按自己的
    临时目录解析路径，长期占用会互相覆盖（导入期挂上会让对端的路径断言全错）。"""

    def install_folder_paths(self):
        self._prev_folder_paths = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = _folder_paths

    def restore_folder_paths(self):
        if self._prev_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self._prev_folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_recipes_results_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    import importlib.util
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


_gallery = types.ModuleType(f"{_PKG}.gallery")
_gallery.AUDIO_EXTENSIONS = {".mp3", ".wav"}
_gallery.IMG_EXTENSIONS = {".png", ".jpg", ".jpeg"}
_gallery.VIDEO_EXTENSIONS = {".mp4", ".webm"}
_gallery._copy_media_to_input = lambda src, fname: (fname, False)
sys.modules[f"{_PKG}.gallery"] = _gallery
setattr(_pkg, "gallery", _gallery)

_bookmark = types.ModuleType(f"{_PKG}.bookmark")
_bookmark._download_bytes = lambda *a, **k: b""
_bookmark._media_ext_from_url_or_bytes = lambda *a, **k: ".png"
sys.modules[f"{_PKG}.bookmark"] = _bookmark
setattr(_pkg, "bookmark", _bookmark)

_gallery_lora = types.ModuleType(f"{_PKG}.gallery_lora")
_gallery_lora.LORA_CACHE_DIR = os.path.join(_TMP, "lora_cache")
_gallery_lora._load_lora_index = lambda *a, **k: {}
sys.modules[f"{_PKG}.gallery_lora"] = _gallery_lora
setattr(_pkg, "gallery_lora", _gallery_lora)

_util = types.ModuleType(f"{_PKG}.util")
_util._extract_media_metadata = lambda *a, **k: {}
_util._json_safe = lambda v: v
class _PF(logging.Filter):
    def filter(self, record):
        return True
_util.PrefixFilter = _PF
sys.modules[f"{_PKG}.util"] = _util
setattr(_pkg, "util", _util)

_llm = types.ModuleType(f"{_PKG}.llm")
sys.modules[f"{_PKG}.llm"] = _llm
setattr(_pkg, "llm", _llm)

recipes = _load("recipes", "recipes.py")


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


def _body(resp):
    return json.loads(resp.body)


def _write_output(rel, content=b"data"):
    path = os.path.join(_OUTPUT_DIR, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content)
    return path


# ===========================================================================
# 纯函数：_norm_result / _result_path
# ===========================================================================
class NormResultTests(unittest.TestCase):
    def test_normalizes_output_ref(self):
        out = recipes._norm_result({"filename": "a.mp4", "subfolder": "", "type": "output", "kind": "video"})
        self.assertEqual(out, {"filename": "a.mp4", "subfolder": "", "kind": "video"})

    def test_infers_kind_by_suffix(self):
        self.assertEqual(recipes._norm_result({"filename": "a.png"})["kind"], "image")
        self.assertEqual(recipes._norm_result({"filename": "a.mp3"})["kind"], "audio")
        self.assertEqual(recipes._norm_result({"filename": "a.webm"})["kind"], "video")

    def test_keeps_known_kind_and_trims_subfolder(self):
        out = recipes._norm_result({"filename": "a.mp4", "subfolder": "/sub/", "kind": "audio"})
        self.assertEqual(out["subfolder"], "sub")
        self.assertEqual(out["kind"], "audio")

    def test_stored_entry_without_type_is_output(self):
        # 落盘条目不带 type 字段，回读时必须仍按 output 规范化
        self.assertEqual(recipes._norm_result({"filename": "a.mp4", "subfolder": "s"})["filename"], "a.mp4")

    def test_rejects_bad_refs(self):
        for bad in (None, "a.mp4", {}, {"filename": ""}, {"filename": "../evil.mp4"},
                    {"filename": "sub/evil.mp4"}, {"filename": "a.mp4", "subfolder": "a/../b"},
                    {"filename": "a.mp4", "subfolder": "a\\b"}, {"filename": "a.mp4", "type": "input"},
                    {"filename": "a.mp4", "type": "temp"}):
            self.assertIsNone(recipes._norm_result(bad), f"应拒绝：{bad!r}")


class ResultPathTests(StubFolderPathsMixin, unittest.TestCase):
    def setUp(self):
        self.install_folder_paths()

    def tearDown(self):
        self.restore_folder_paths()

    def test_existing_file_resolves(self):
        p = _write_output("r1_00001.mp4", b"v")
        self.assertEqual(str(recipes._result_path({"filename": "r1_00001.mp4", "subfolder": ""})), p)

    def test_subfolder_resolves(self):
        p = _write_output("sub/r2_00001.mp4", b"v")
        self.assertEqual(str(recipes._result_path({"filename": "r2_00001.mp4", "subfolder": "sub"})), p)

    def test_missing_file_returns_none(self):
        self.assertIsNone(recipes._result_path({"filename": "nope.mp4", "subfolder": ""}))

    def test_traversal_returns_none(self):
        self.assertIsNone(recipes._result_path({"filename": "../secret.mp4", "subfolder": ""}))


# ===========================================================================
# 端点：add_results / delete_result / list / save 保留
# ===========================================================================
class ResultRoutesTests(StubFolderPathsMixin, unittest.TestCase):
    def setUp(self):
        self.install_folder_paths()
        self._tmp = tempfile.mkdtemp(prefix="neo_recipes_results_routes_")
        self.recipes_dir = os.path.join(self._tmp, "recipes")
        self.custom = os.path.join(self.recipes_dir, "custom")
        self.presets = os.path.join(self.recipes_dir, "presets")
        os.makedirs(self.custom)
        os.makedirs(self.presets)
        self._orig = (recipes.RECIPES_DIR, recipes.CUSTOM_DIR, recipes.PRESETS_DIR)
        recipes.RECIPES_DIR = pathlib.Path(self.recipes_dir)
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)
        recipes.PRESETS_DIR = pathlib.Path(self.presets)
        self._make_recipe(self.custom, "res-a")

    def tearDown(self):
        self.restore_folder_paths()
        recipes.RECIPES_DIR, recipes.CUSTOM_DIR, recipes.PRESETS_DIR = self._orig

    def _make_recipe(self, base, name, meta=None):
        d = os.path.join(base, name)
        os.makedirs(os.path.join(d, "assets"), exist_ok=True)
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump(meta or {"name": name, "prompt": "", "assets": [], "type": "video_director",
                               "segments": [{"prompt": "a", "duration_sec": 5}]}, f, ensure_ascii=False)

    def _meta(self, base, name):
        with open(os.path.join(base, name, "recipe.json"), "r", encoding="utf-8") as f:
            return json.load(f)

    def _add(self, name, results):
        return _run_async(recipes.rs_recipes_add_results(_FakeRequest({"name": name, "results": results})))

    def _delete(self, name, filename):
        return _run_async(recipes.rs_recipes_delete_result(_FakeRequest({"name": name, "filename": filename})))

    def test_add_results_records_paths_and_dedupes(self):
        _write_output("shot_00001.mp4", b"v")
        _write_output("shot_00002.mp4", b"v2")
        resp = self._add("res-a", [
            {"filename": "shot_00001.mp4", "subfolder": "", "type": "output", "kind": "video"},
            {"filename": "shot_00002.mp4", "subfolder": "", "type": "output", "kind": "video"},
        ])
        self.assertEqual(resp.status, 200)
        self.assertEqual(_body(resp), {"success": True, "added": 2, "skipped": 0})
        stored = self._meta(self.custom, "res-a")["results"]
        self.assertEqual([r["filename"] for r in stored], ["shot_00001.mp4", "shot_00002.mp4"])
        self.assertTrue(all(r["kind"] == "video" and r["at"] for r in stored))
        self.assertEqual([r.get("hero") for r in stored], [True, None], "首张成功的产物自动记主图")

        again = self._add("res-a", [{"filename": "shot_00001.mp4", "type": "output"}])
        self.assertEqual(_body(again), {"success": True, "added": 0, "skipped": 1})
        self.assertEqual(len(self._meta(self.custom, "res-a")["results"]), 2, "重复路径不得重复记录")

    def test_add_results_keeps_existing_hero(self):
        _write_output("h_00001.png", b"a")
        _write_output("h_00002.png", b"b")
        self._add("res-a", [{"filename": "h_00001.png", "type": "output", "kind": "image"}])
        self._add("res-a", [{"filename": "h_00002.png", "type": "output", "kind": "image"}])
        stored = self._meta(self.custom, "res-a")["results"]
        self.assertEqual([r.get("hero") for r in stored], [True, None],
                         "追加产物不得把配方封面顶到最新那张")

    def test_add_results_skips_missing_file(self):
        resp = self._add("res-a", [{"filename": "ghost.mp4", "type": "output"}])
        self.assertEqual(_body(resp)["added"], 0)
        self.assertNotIn("results", self._meta(self.custom, "res-a"), "没有有效结果时不写字段")

    def test_add_results_preset_forbidden(self):
        self._make_recipe(self.presets, "preset-a")
        resp = self._add("preset-a", [{"filename": "x.mp4", "type": "output"}])
        self.assertEqual(resp.status, 403)

    def test_add_results_unknown_recipe_404(self):
        self.assertEqual(self._add("nope", []).status, 404)

    def _set_hero(self, name, filename, subfolder=""):
        return _run_async(recipes.rs_recipes_set_hero(
            _FakeRequest({"name": name, "filename": filename, "subfolder": subfolder})))

    def test_set_hero_moves_the_flag_and_survives_reload(self):
        _write_output("hero_00001.png", b"a")
        _write_output("hero_00002.png", b"b")
        self._add("res-a", [
            {"filename": "hero_00001.png", "type": "output", "kind": "image"},
            {"filename": "hero_00002.png", "type": "output", "kind": "image"},
        ])
        resp = self._set_hero("res-a", "hero_00002.png")
        self.assertEqual(resp.status, 200)
        self.assertEqual(_body(resp), {"success": True,
                                       "hero": {"filename": "hero_00002.png", "subfolder": "", "kind": "image"}})
        stored = self._meta(self.custom, "res-a")["results"]
        self.assertEqual([r.get("hero") for r in stored], [None, True], "整份只留一个主图")

        listed = next(r for r in _body(_run_async(recipes.rs_recipes_list(_FakeRequest({}))))
                      if r["name"] == "res-a")
        self.assertEqual([r.get("hero") for r in listed["results"]], [None, True], "列表回读带出主图标记")

    def test_set_hero_unknown_recipe_404(self):
        self.assertEqual(self._set_hero("nope", "a.png").status, 404)

    def test_set_hero_missing_result_404(self):
        _write_output("hero_00003.png", b"a")
        self._add("res-a", [{"filename": "hero_00003.png", "type": "output", "kind": "image"}])
        resp = self._set_hero("res-a", "not_recorded.png")
        self.assertEqual(resp.status, 404)
        self.assertEqual([r.get("hero") for r in self._meta(self.custom, "res-a")["results"]], [True],
                         "点名不存在的结果不得把原主图清掉")

    def test_set_hero_preset_forbidden(self):
        self._make_recipe(self.presets, "preset-hero")
        resp = self._set_hero("preset-hero", "a.png")
        self.assertEqual(resp.status, 403)

    def test_delete_result_removes_entry_and_file(self):
        path = _write_output("shot_00003.mp4", b"v3")
        with open(os.path.join(_OUTPUT_DIR, "shot_00003.txt"), "w", encoding="utf-8") as f:
            f.write("prompt meta")
        self._add("res-a", [{"filename": "shot_00003.mp4", "type": "output", "kind": "video"}])

        resp = self._delete("res-a", "shot_00003.mp4")
        self.assertEqual(resp.status, 200)
        self.assertEqual(_body(resp), {"success": True, "deleted": True})
        self.assertFalse(os.path.exists(path), "应删除 output 目录里的真实文件")
        self.assertFalse(os.path.exists(os.path.join(_OUTPUT_DIR, "shot_00003.txt")), "同删 .txt 旁车")
        self.assertEqual(self._meta(self.custom, "res-a")["results"], [])

    def test_delete_result_missing_file_still_drops_entry(self):
        _write_output("shot_00004.mp4", b"v4")
        self._add("res-a", [{"filename": "shot_00004.mp4", "type": "output"}])
        os.remove(os.path.join(_OUTPUT_DIR, "shot_00004.mp4"))
        resp = self._delete("res-a", "shot_00004.mp4")
        self.assertEqual(_body(resp), {"success": True, "deleted": False}, "文件已不在也要能摘掉记录")
        self.assertEqual(self._meta(self.custom, "res-a")["results"], [])

    def test_delete_result_invalid_filename_400(self):
        self.assertEqual(self._delete("res-a", "../evil.mp4").status, 400)

    def test_delete_result_preset_forbidden(self):
        self._make_recipe(self.presets, "preset-b")
        resp = _run_async(recipes.rs_recipes_delete_result(_FakeRequest({"name": "preset-b", "filename": "a.mp4"})))
        self.assertEqual(resp.status, 403)

    def test_list_filters_missing_file_and_counts(self):
        _write_output("keep_00001.mp4", b"v")
        _write_output("gone_00002.mp4", b"v")
        self._add("res-a", [
            {"filename": "keep_00001.mp4", "type": "output"},
            {"filename": "gone_00002.mp4", "type": "output"},
        ])
        os.remove(os.path.join(_OUTPUT_DIR, "gone_00002.mp4"))

        resp = _run_async(recipes.rs_recipes_list(_FakeRequest({})))
        rec = next(r for r in _body(resp) if r["name"] == "res-a")
        self.assertEqual([r["filename"] for r in rec["results"]], ["keep_00001.mp4"], "文件不在就不再列出")
        self.assertEqual(rec["result_count"], 1)

    def test_save_keeps_existing_results(self):
        _write_output("keep_00002.mp4", b"v")
        self._add("res-a", [{"filename": "keep_00002.mp4", "type": "output", "kind": "video"}])

        resp = _run_async(recipes.rs_recipes_save(_FakeRequest({
            "name": "res-a", "prompt": "改过的提示词", "assets": [], "type": "video_director",
            "shared": {"width": 960, "height": 544},
            "segments": [{"prompt": "b", "duration_sec": 5, "skill_id": "vid-skill"}],
        })))
        self.assertEqual(resp.status, 200)
        meta = self._meta(self.custom, "res-a")
        self.assertEqual(meta["prompt"], "改过的提示词")
        self.assertEqual([r["filename"] for r in meta["results"]], ["keep_00002.mp4"], "重存配方不得清空结果记录")


# ===========================================================================
# 端点：/rs_recipes/set_segment_duration（画布车厢顶行那一枚时长框写的那一发）
# ===========================================================================
class SegmentDurationRouteTests(StubFolderPathsMixin, unittest.TestCase):
    """只写 segments[index].duration_sec 这一个字段：预设只读、越界钳到导演页那一份边界，
    资产 / 示例 / 结果 / 故事板原样留着（区别于整份覆盖的 /rs_recipes/save）。"""

    def setUp(self):
        self.install_folder_paths()
        self._tmp = tempfile.mkdtemp(prefix="neo_recipes_dur_routes_")
        self.recipes_dir = os.path.join(self._tmp, "recipes")
        self.custom = os.path.join(self.recipes_dir, "custom")
        self.presets = os.path.join(self.recipes_dir, "presets")
        os.makedirs(self.custom)
        os.makedirs(self.presets)
        self._orig = (recipes.RECIPES_DIR, recipes.CUSTOM_DIR, recipes.PRESETS_DIR)
        recipes.RECIPES_DIR = pathlib.Path(self.recipes_dir)
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)
        recipes.PRESETS_DIR = pathlib.Path(self.presets)

    def tearDown(self):
        self.restore_folder_paths()
        recipes.RECIPES_DIR, recipes.CUSTOM_DIR, recipes.PRESETS_DIR = self._orig

    def _write(self, base, name, meta=None):
        d = os.path.join(base, name)
        os.makedirs(os.path.join(d, "assets"), exist_ok=True)
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump(meta or {"name": name, "type": "video_director",
                               "segments": [{"prompt": "a", "duration_sec": 5}]}, f, ensure_ascii=False)

    def _meta(self, base, name):
        with open(os.path.join(base, name, "recipe.json"), "r", encoding="utf-8") as f:
            return json.load(f)

    def _director(self, base=None, name="dur-a"):
        meta = {"name": name, "type": "video_director", "title": "短片",
                "assets": [{"filename": "角色.png", "kind": "image"}],
                "samples": ["开场首帧.png"],
                "results": [{"filename": "r_00001.mp4", "subfolder": "", "kind": "video"}],
                "story": {"logline": "一句话故事"},
                "setup": {"characters": [{"name": "橘猫"}]},
                "shared": {"mode": "i2v", "width": 1344, "height": 768},
                "segments": [{"prompt": "第一段", "duration_sec": 5, "skill_id": "h3_t2v"},
                             {"prompt": "第二段", "duration_sec": 12, "skill_id": "h3_t2v"}]}
        self._write(base if base is not None else self.custom, name, meta)
        return meta

    def _set(self, name, segment, duration_sec):
        return _run_async(recipes.rs_recipes_set_segment_duration(_FakeRequest(
            {"name": name, "segment": segment, "duration_sec": duration_sec})))

    def test_writes_only_the_touched_segment(self):
        self._director()
        resp = self._set("dur-a", 0, 8)
        self.assertEqual(resp.status, 200)
        self.assertEqual(_body(resp), {"success": True, "name": "dur-a", "segment": 0,
                                       "duration_sec": 8})
        meta = self._meta(self.custom, "dur-a")
        self.assertEqual([s["duration_sec"] for s in meta["segments"]], [8, 12],
                         "只动写到的那一段，别段时长不动")
        self.assertEqual(meta["segments"][0]["prompt"], "第一段", "段上的其它字段原样")
        self.assertEqual(meta["assets"], [{"filename": "角色.png", "kind": "image"}],
                         "改时长不得清空资产")
        self.assertEqual(meta["samples"], ["开场首帧.png"])
        self.assertEqual(meta["results"], [{"filename": "r_00001.mp4", "subfolder": "", "kind": "video"}])
        self.assertEqual(meta["story"], {"logline": "一句话故事"})
        self.assertEqual(meta["shared"], {"mode": "i2v", "width": 1344, "height": 768})

    def test_clamps_to_the_director_page_bounds(self):
        self._director()
        self.assertEqual(_body(self._set("dur-a", 1, 9000))["duration_sec"], 3600,
                         "越界钳到上限再落盘（与导演页时长框同一份边界）")
        self.assertEqual(self._meta(self.custom, "dur-a")["segments"][1]["duration_sec"], 3600)
        self.assertEqual(_body(self._set("dur-a", 1, 0))["duration_sec"], 1)
        self.assertEqual(self._meta(self.custom, "dur-a")["segments"][1]["duration_sec"], 1)

    def test_preset_recipe_stays_readonly(self):
        self._director(base=self.presets, name="preset-dur")
        resp = self._set("preset-dur", 0, 9)
        self.assertEqual(resp.status, 403)
        self.assertIn("只读", _body(resp)["error"], "要说清楚去哪儿能改")
        self.assertEqual([s["duration_sec"] for s in self._meta(self.presets, "preset-dur")["segments"]],
                         [5, 12], "拒了就不动预设文件")

    def test_rejects_missing_recipe_segment_and_type(self):
        self._director()
        self.assertEqual(self._set("nope", 0, 8).status, 404, "配方不存在")
        self.assertEqual(self._set("dur-a", 9, 8).status, 400, "段序号越界")
        self.assertEqual(self._set("dur-a", -1, 8).status, 400)
        self.assertEqual(self._set("dur-a", "x", 8).status, 400, "段序号不是个数就是 400")
        self.assertEqual(self._set("dur-a", 0, None).status, 400, "没有秒数不写盘")
        self._write(self.custom, "plain", {"name": "plain", "type": "image_lora", "prompt": "一句"})
        self.assertEqual(self._set("plain", 0, 8).status, 400, "没有分段的配方没有时长可写")
        self.assertEqual([s["duration_sec"] for s in self._meta(self.custom, "dur-a")["segments"]],
                         [5, 12], "拒掉的每一发都不落盘")


if __name__ == "__main__":
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)



