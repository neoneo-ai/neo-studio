# SPDX-License-Identifier: Apache-2.0
"""recipes 缩略图端点（/rs_recipes/thumbnail）的离线单测。

验证路径校验（400）、配方/资产缺失（404）、缓存未命中现生成、缓存命中不再调用
gallery._generate_thumbnail、视频封面的旧整帧大缓存按请求尺寸就地重生成，以及 size 参数钳制到
[32, 1024]。server/folder_paths/gallery/bookmark/gallery_lora/util 用桩模块替换，
RECIPES_DIR/CUSTOM_DIR/PRESETS_DIR/THUMB_DIR 指向临时目录。"""

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

_TMP = tempfile.mkdtemp(prefix="neo_recipes_thumb_")
_INPUT_DIR = os.path.join(_TMP, "input")
os.makedirs(_INPUT_DIR, exist_ok=True)

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: os.path.join(_TMP, "output")
_folder_paths.get_temp_directory = lambda: os.path.join(_TMP, "temp")


class StubFolderPathsMixin:
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

_PKG = "_neo_recipes_thumb_pkg"
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


# gallery 桩：_generate_thumbnail 记录调用次数并写一个假 JPEG，避免依赖 PIL/ffmpeg
_thumb_calls = {"n": 0}
_FAKE_JPEG_HEAD = b"\xff\xd8\xff\xe0FAKEJPEG"


def _fake_generate_thumbnail(source_path, thumb_path, size):
    _thumb_calls["n"] += 1
    with open(thumb_path, "wb") as f:
        # 末尾记下生成时的尺寸：旧版整帧大缓存就靠它摆出来
        f.write(_FAKE_JPEG_HEAD + str(size).encode())
    return True


def _fake_cached_video_thumb_fits(suffix, thumb_path, size):
    """尺寸检查的桩：非视频封面由 PIL 缩过，一律合格；视频读回缓存记下的尺寸与请求比。"""
    if suffix.lower() not in _gallery.VIDEO_EXTENSIONS:
        return True
    with open(thumb_path, "rb") as f:
        body = f.read()
    return int(body[len(_FAKE_JPEG_HEAD):]) <= size


_gallery = types.ModuleType(f"{_PKG}.gallery")
_gallery.AUDIO_EXTENSIONS = {".mp3", ".wav"}
_gallery.IMG_EXTENSIONS = {".png", ".jpg", ".jpeg"}
_gallery.VIDEO_EXTENSIONS = {".mp4", ".webm"}
_gallery._copy_media_to_input = lambda src, fname: (fname, False)
_gallery._generate_thumbnail = _fake_generate_thumbnail
_gallery._cached_video_thumb_fits = _fake_cached_video_thumb_fits
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


class _QueryRequest:
    def __init__(self, query):
        self.rel_url = types.SimpleNamespace(query=query)


def _thumb(query):
    return _run_async(recipes.rs_recipes_thumbnail(_QueryRequest(query)))


class ThumbnailRoutesTests(StubFolderPathsMixin, unittest.TestCase):
    def setUp(self):
        self.install_folder_paths()
        self._tmp = tempfile.mkdtemp(prefix="neo_recipes_thumb_routes_")
        self.recipes_dir = os.path.join(self._tmp, "recipes")
        self.custom = os.path.join(self.recipes_dir, "custom")
        self.presets = os.path.join(self.recipes_dir, "presets")
        self.thumb_dir = os.path.join(self.recipes_dir, ".thumbs")
        for d in (self.custom, self.presets, self.thumb_dir):
            os.makedirs(d)
        self._orig = (recipes.RECIPES_DIR, recipes.CUSTOM_DIR, recipes.PRESETS_DIR, recipes.THUMB_DIR)
        recipes.RECIPES_DIR = pathlib.Path(self.recipes_dir)
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)
        recipes.PRESETS_DIR = pathlib.Path(self.presets)
        recipes.THUMB_DIR = pathlib.Path(self.thumb_dir)
        _thumb_calls["n"] = 0
        self._make_recipe("r1")

    def tearDown(self):
        self.restore_folder_paths()
        (recipes.RECIPES_DIR, recipes.CUSTOM_DIR, recipes.PRESETS_DIR, recipes.THUMB_DIR) = self._orig

    def _make_recipe(self, name, asset="a.png"):
        d = os.path.join(self.custom, name)
        assets = os.path.join(d, "assets")
        os.makedirs(assets, exist_ok=True)
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump({"name": name, "prompt": "", "assets": [], "type": "video_director",
                       "segments": []}, f, ensure_ascii=False)
        if asset:
            with open(os.path.join(assets, asset), "wb") as f:
                f.write(b"image-bytes")

    def test_invalid_path_400(self):
        self.assertEqual(_thumb({"recipe": "../evil", "file": "a.png"}).status, 400)
        self.assertEqual(_thumb({"recipe": "r1", "file": "sub/a.png"}).status, 400)
        self.assertEqual(_thumb({"recipe": "", "file": "a.png"}).status, 400)

    def test_missing_recipe_404(self):
        self.assertEqual(_thumb({"recipe": "nope", "file": "a.png"}).status, 404)

    def test_missing_asset_404(self):
        self.assertEqual(_thumb({"recipe": "r1", "file": "ghost.png"}).status, 404)

    def test_cache_miss_generates_jpeg(self):
        resp = _thumb({"recipe": "r1", "file": "a.png", "size": "256"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.content_type, "image/jpeg")
        self.assertIn("immutable", resp.headers.get("Cache-Control", ""))
        self.assertEqual(_thumb_calls["n"], 1, "未命中时生成一次")
        thumbs = os.listdir(self.thumb_dir)
        self.assertEqual(len(thumbs), 1)
        self.assertTrue(thumbs[0].endswith("_256.jpg"), f"缓存文件名带尺寸：{thumbs[0]}")

    def test_cache_hit_skips_generation(self):
        _thumb({"recipe": "r1", "file": "a.png", "size": "256"})
        resp = _thumb({"recipe": "r1", "file": "a.png", "size": "256"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(_thumb_calls["n"], 1, "命中缓存不得再次生成")

    def test_oversized_video_cover_cache_is_regenerated(self):
        """旧版 ffmpeg 不缩放，视频封面缓存里躺着的是整帧大图，文件名却写着 _256。"""
        self._make_recipe("r2", asset="clip.mp4")
        asset = pathlib.Path(self.custom, "r2", "assets", "clip.mp4")
        thumb = recipes._recipe_thumb_path(asset, 256)
        thumb.write_bytes(_FAKE_JPEG_HEAD + b"1024")

        resp = _thumb({"recipe": "r2", "file": "clip.mp4", "size": "256"})

        self.assertEqual(resp.status, 200)
        self.assertEqual(_thumb_calls["n"], 1, "整帧大图判为不合格，重生成一次")
        self.assertEqual(thumb.read_bytes(), _FAKE_JPEG_HEAD + b"256", "同一份缓存就地换成小图")

    def test_fitting_video_cover_cache_is_served(self):
        self._make_recipe("r3", asset="clip.mp4")
        asset = pathlib.Path(self.custom, "r3", "assets", "clip.mp4")
        thumb = recipes._recipe_thumb_path(asset, 256)
        thumb.write_bytes(_FAKE_JPEG_HEAD + b"256")

        resp = _thumb({"recipe": "r3", "file": "clip.mp4", "size": "256"})

        self.assertEqual(resp.status, 200)
        self.assertEqual(_thumb_calls["n"], 0, "尺寸合格且没过期就只读缓存")

    def test_size_clamped_to_bounds(self):
        _thumb({"recipe": "r1", "file": "a.png", "size": "1"})
        names = os.listdir(self.thumb_dir)
        self.assertTrue(any(n.endswith("_32.jpg") for n in names), f"过小尺寸钳到 32：{names}")

        _thumb({"recipe": "r1", "file": "a.png", "size": "99999"})
        names = os.listdir(self.thumb_dir)
        self.assertTrue(any(n.endswith("_1024.jpg") for n in names), f"过大尺寸钳到 1024：{names}")

    def test_bad_size_falls_back_to_default(self):
        resp = _thumb({"recipe": "r1", "file": "a.png", "size": "abc"})
        self.assertEqual(resp.status, 200)
        names = os.listdir(self.thumb_dir)
        self.assertTrue(any(n.endswith("_256.jpg") for n in names), f"非法 size 回退默认：{names}")


if __name__ == "__main__":
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)