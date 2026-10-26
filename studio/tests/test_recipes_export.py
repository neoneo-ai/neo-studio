# SPDX-License-Identifier: Apache-2.0
"""recipes 配方导出/导入（zip 包）后端逻辑的离线单测。

server/folder_paths 用桩模块替换，recipes 的 gallery/bookmark/gallery_lora/util/llm
依赖用假模块，RECIPES_DIR/CUSTOM_DIR/PRESETS_DIR 指向临时目录；验证导出 zip 结构
（顶层目录 + Readme.txt）、Readme 内容（包内容/来源/快速应用）、导入往返、
重名自动改名、无 recipe.json / 路径穿越拒绝。"""

from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import asyncio
import io
import json
import logging
import os
import pathlib
import sys
import tempfile
import types
import unittest
import zipfile

import shutil as _shutil

_TMP = tempfile.mkdtemp(prefix="neo_recipes_export_")
# 清空本模块私有临时目录（旧运行残留会让重名用例不幂等）
for _e in os.listdir(_TMP):
    _p = os.path.join(_TMP, _e)
    if os.path.isdir(_p):
        _shutil.rmtree(_p, ignore_errors=True)
    else:
        os.remove(_p)
_RECIPES_DIR = os.path.join(_TMP, "recipes")
_CUSTOM_DIR = os.path.join(_RECIPES_DIR, "custom")
_PRESETS_DIR = os.path.join(_RECIPES_DIR, "presets")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
for d in (_CUSTOM_DIR, _PRESETS_DIR, _INPUT_DIR, _OUTPUT_DIR):
    os.makedirs(d, exist_ok=True)

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
_folder_paths.get_temp_directory = lambda: os.path.join(_TMP, "temp")
_folder_paths.get_annotated_filepath = lambda name, base_dir: os.path.join(base_dir, str(name).replace("/", os.sep))
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_recipes_export_pkg"
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
_llm.run_llm_task = lambda *a, **k: {"status": "success"}
_llm._readme_config = {}
_llm._load_remote_config = lambda: _llm._readme_config
def _detect_language(text):
    if not text:
        return "English"
    zh = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    return "Chinese" if zh / len(text) >= 0.5 else "English"
_llm._detect_language = _detect_language
sys.modules[f"{_PKG}.llm"] = _llm
setattr(_pkg, "llm", _llm)

recipes = _load("recipes", "recipes.py")
recipes.RECIPES_DIR = pathlib.Path(_RECIPES_DIR)
recipes.CUSTOM_DIR = pathlib.Path(_CUSTOM_DIR)
recipes.PRESETS_DIR = pathlib.Path(_PRESETS_DIR)


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeRequest:
    def __init__(self, query=None):
        self.rel_url = types.SimpleNamespace(query=query or {})


class _MultipartPart:
    def __init__(self, name, filename, data):
        self.name = name
        self.filename = filename
        self._data = data

    async def read(self):
        return self._data


class _MultipartReader:
    def __init__(self, parts):
        self._iter = iter(parts)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class _FakeMultipartRequest:
    def __init__(self, parts):
        self._parts = parts

    async def multipart(self):
        return _MultipartReader(self._parts)


def _write_recipe(name, meta, assets=None):
    d = pathlib.Path(_CUSTOM_DIR) / name
    (d / "assets").mkdir(parents=True, exist_ok=True)
    for fname, blob in (assets or {}).items():
        (d / "assets" / fname).write_bytes(blob)
    with open(d / "recipe.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    return d


def _zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, data in entries.items():
            zf.writestr(arcname, data)
    return buf.getvalue()


DIRECTOR_META = {
    "name": "导演导出测试",
    "type": "video_director",
    "created_at": "2026-09-27T10:00:00",
    "shared": {"width": 960, "height": 544, "mode": "mixed"},
    "segments": [
        {"skill_id": "s1", "prompt": "a", "duration_sec": 5},
        {"skill_id": "s2", "prompt": "b", "duration_sec": 7},
    ],
}


class ExportTests(unittest.TestCase):
    def test_export_zip_structure_and_readme(self):
        _write_recipe("导演导出测试", DIRECTOR_META, {"a.png": b"img", "b.mp4": b"vid"})
        resp = _run_async(recipes.rs_recipes_export(_FakeRequest({"name": "导演导出测试"})))
        self.assertEqual(resp.status, 200)
        self.assertIn("application/zip", resp.content_type)
        self.assertIn("导演导出测试.zip", resp.headers.get("Content-Disposition", ""))

        zf = zipfile.ZipFile(io.BytesIO(resp.body))
        names = set(zf.namelist())
        self.assertEqual(names, {
            "导演导出测试/recipe.json",
            "导演导出测试/Readme.txt",
            "导演导出测试/assets/a.png",
            "导演导出测试/assets/b.mp4",
        })

        readme = zf.read("导演导出测试/Readme.txt").decode("utf-8")
        for token in ("导演导出测试", "分镜视频导演配方", "2 段", "960×544", "总时长 12s",
                      "Neo Studio", "https://github.com/neoneo-ai/neo-studio",
                      "导入", "NeoH3VideoDirector"):
            self.assertIn(token, readme)
        self.assertNotIn("【来源】", readme)
        # Readme 只进包内，不落盘到配方目录
        self.assertFalse((pathlib.Path(_CUSTOM_DIR) / "导演导出测试" / "Readme.txt").exists())

    def test_export_normal_recipe_readme(self):
        _write_recipe("普通导出测试", {"name": "普通导出测试", "prompt": "p", "created_at": "2026-09-27T11:00:00"}, {"c.png": b"img"})
        resp = _run_async(recipes.rs_recipes_export(_FakeRequest({"name": "普通导出测试"})))
        self.assertEqual(resp.status, 200)
        zf = zipfile.ZipFile(io.BytesIO(resp.body))
        readme = zf.read("普通导出测试/Readme.txt").decode("utf-8")
        self.assertIn("普通配方", readme)
        self.assertIn("发送到工作流", readme)

    def test_export_readme_english(self):
        _llm._readme_config["readme_language"] = "en"
        try:
            _write_recipe("English Recipe", {"name": "English Recipe", "prompt": "a cat", "created_at": "2026-09-27T12:00:00"}, {"d.png": b"img"})
            resp = _run_async(recipes.rs_recipes_export(_FakeRequest({"name": "English Recipe"})))
            self.assertEqual(resp.status, 200)
            zf = zipfile.ZipFile(io.BytesIO(resp.body))
            readme = zf.read("English Recipe/Readme.txt").decode("utf-8")
            for token in ("[Contents]", "[Quick start]", "standard recipe",
                          "Import", "Send to workflow", "Neo Studio"):
                self.assertIn(token, readme)
            self.assertNotIn("[Source]", readme)
            self.assertNotIn("配方包", readme)
        finally:
            _llm._readme_config.pop("readme_language", None)

    def test_export_readme_samples_line(self):
        d = _write_recipe("示例结果测试", {"name": "示例结果测试", "prompt": "p"}, {"a.png": b"img"})
        (d / "samples").mkdir(exist_ok=True)
        (d / "samples" / "r1.mp4").write_bytes(b"vid")
        resp = _run_async(recipes.rs_recipes_export(_FakeRequest({"name": "示例结果测试"})))
        self.assertEqual(resp.status, 200)
        zf = zipfile.ZipFile(io.BytesIO(resp.body))
        readme = zf.read("示例结果测试/Readme.txt").decode("utf-8")
        self.assertIn("示例结果：1 个", readme)
        # 无示例结果的配方（普通导出测试）不出现该行
        resp2 = _run_async(recipes.rs_recipes_export(_FakeRequest({"name": "普通导出测试"})))
        zf2 = zipfile.ZipFile(io.BytesIO(resp2.body))
        self.assertNotIn("示例结果", zf2.read("普通导出测试/Readme.txt").decode("utf-8"))

    def test_export_not_found(self):
        resp = _run_async(recipes.rs_recipes_export(_FakeRequest({"name": "不存在"})))
        self.assertEqual(resp.status, 404)


class ImportTests(unittest.TestCase):
    def test_import_roundtrip(self):
        blob = _zip_bytes({
            "导入往返/recipe.json": json.dumps({"name": "导入往返", "prompt": "p"}, ensure_ascii=False).encode("utf-8"),
            "导入往返/assets/a.png": b"img",
            "导入往返/Readme.txt": "说明文件，随包保留".encode("utf-8"),
        })
        resp = _run_async(recipes.rs_recipes_import(_FakeMultipartRequest([
            _MultipartPart("file", "x.zip", blob)])))
        self.assertEqual(resp.status, 200)
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["name"], "导入往返")
        d = pathlib.Path(_CUSTOM_DIR) / "导入往返"
        self.assertTrue((d / "recipe.json").is_file())
        self.assertEqual((d / "assets" / "a.png").read_bytes(), b"img")
        self.assertEqual((d / "Readme.txt").read_text(encoding="utf-8"), "说明文件，随包保留")

    def test_import_name_conflict_auto_rename(self):
        _write_recipe("冲突名", {"name": "冲突名", "prompt": "p"})
        blob = _zip_bytes({"冲突名/recipe.json": json.dumps({"name": "冲突名"}, ensure_ascii=False).encode("utf-8")})
        resp = _run_async(recipes.rs_recipes_import(_FakeMultipartRequest([
            _MultipartPart("file", "x.zip", blob)])))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["name"], "冲突名-copy")
        self.assertTrue((pathlib.Path(_CUSTOM_DIR) / "冲突名-copy" / "recipe.json").is_file())

    def test_import_no_recipe_json(self):
        blob = _zip_bytes({"foo/readme.txt": b"hi"})
        resp = _run_async(recipes.rs_recipes_import(_FakeMultipartRequest([
            _MultipartPart("file", "x.zip", blob)])))
        self.assertEqual(resp.status, 400)

    def test_import_unsafe_path(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            info = zipfile.ZipInfo("../evil.txt")
            zf.writestr(info, b"bad")
        resp = _run_async(recipes.rs_recipes_import(_FakeMultipartRequest([
            _MultipartPart("file", "x.zip", buf.getvalue())])))
        self.assertEqual(resp.status, 400)

    def test_import_no_file(self):
        resp = _run_async(recipes.rs_recipes_import(_FakeMultipartRequest([])))
        self.assertEqual(resp.status, 400)

    def test_export_preset_allowed(self):
        d = pathlib.Path(_PRESETS_DIR) / "预设导出"
        (d / "assets").mkdir(parents=True, exist_ok=True)
        with open(d / "recipe.json", "w", encoding="utf-8") as f:
            json.dump({"name": "预设导出", "prompt": "p"}, f, ensure_ascii=False)
        resp = _run_async(recipes.rs_recipes_export(_FakeRequest({"name": "预设导出"})))
        self.assertEqual(resp.status, 200)


if __name__ == "__main__":
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)
