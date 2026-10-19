# SPDX-License-Identifier: Apache-2.0
"""媒体路由的 Content-Type 与缓存头（离线单测）。

/neo_gallery/video、/audio、/image、/fullpath 共用 _media_file_response。未知
二进制（LoRA 权重、优化器等）必须回落 application/octet-stream，不能伪装成
image/jpeg——浏览器按响应类型渲染会直接乱码。
"""

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from urllib.parse import quote
from PIL import Image

_TMP = tempfile.mkdtemp(prefix="neo_gallery_media_")
_INPUT = os.path.join(_TMP, "input")
_OUTPUT = os.path.join(_TMP, "output")

_prev_server = sys.modules.get("server")
_prev_folder_paths = sys.modules.get("folder_paths")

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(
    instance=types.SimpleNamespace(
        routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f))))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.input_directory = _INPUT
_folder_paths.output_directory = _OUTPUT
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_gallery_media_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _stub(name, **attrs):
    mod = types.ModuleType(f"{_PKG}.{name}")
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    return mod


_stub("util",
      IMG_EXTENSIONS={".png", ".jpg", ".jpeg"}, VIDEO_EXTENSIONS={".mp4"},
      AUDIO_EXTENSIONS={".mp3"}, ALL_MEDIA_EXTENSIONS={".png", ".jpg", ".jpeg", ".mp4", ".mp3"},
      _has_media_recursive=lambda *a, **k: False,
      _has_media_in_dir_any=lambda *a, **k: False,
      _extract_media_metadata=lambda *a, **k: {},
      _collect_prompt_texts=lambda *a, **k: [],
      _load_settings=lambda *a, **k: {},
      _save_settings=lambda *a, **k: None,
      _json_safe=lambda v: v)
async def _oss_none(*a, **k):
    return None


async def _oss_no_items(*a, **k):
    return []


_stub("gallery_oss",
      OSS_NAV_PREFIX="Cloud Presets",
      _is_oss_enabled=lambda: False,
      _load_oss_index_from_disk=lambda *a, **k: {},
      _fetch_oss_index=lambda *a, **k: None,
      _oss_index_dirs=lambda *a, **k: [],
      _oss_directories_to_gallery_dirs=lambda *a, **k: [],
      OSS_TAG_CHARACTER_SHEET="character-sheet",
      _oss_tagged_dir_tokens=lambda *a, **k: [],
      _collect_oss_covers=lambda *a, **k: {},
      _handle_oss_gallery_list=lambda *a, **k: None,
      _find_in_oss_index=_oss_none,
      _find_thumbnail_in_oss_index=_oss_none,
      _download_oss_file=lambda *a, **k: None,
      _oss_dir_cards=lambda *a, **k: {},
      _oss_dir_items=_oss_no_items)
_stub("gallery_lora",
      _lora_pending_subdirs=lambda *a, **k: [],
      _attach_lora_meta=lambda *a, **k: None,
      _attach_lora_subdir_paths=lambda *a, **k: None,
      _ensure_auto_cache=lambda *a, **k: None,
      _normalize_lora_dir=lambda *a, **k: "")
_stub("bookmark", CIVITAI_BOOKMARK_DIR=Path(_TMP) / "civitai_bookmarks",
      CIVITAI_DIR_KEY="civitai_bookmarks", _is_civitai_bookmark_enabled=lambda: False)

import importlib.util as _importlib_util

_spec = _importlib_util.spec_from_file_location(f"{_PKG}.gallery", os.path.join(PLUGIN_DIR, "gallery.py"))
gallery = _importlib_util.module_from_spec(_spec)
sys.modules[f"{_PKG}.gallery"] = gallery
setattr(_pkg, "gallery", gallery)
_spec.loader.exec_module(gallery)

if _prev_server is None:
    sys.modules.pop("server", None)
else:
    sys.modules["server"] = _prev_server
if _prev_folder_paths is None:
    sys.modules.pop("folder_paths", None)
else:
    sys.modules["folder_paths"] = _prev_folder_paths

gallery._get_user_custom_dirs = lambda: []
gallery.CONFIGS_DIR = Path(_TMP) / "configs"


class _Query:
    def __init__(self, params):
        self._params = params

    def get(self, key, default=""):
        return self._params.get(key, default)

    def __contains__(self, key):
        return key in self._params

    def __getitem__(self, key):
        return self._params[key]


class _Request:
    def __init__(self, params):
        self.rel_url = types.SimpleNamespace(query=_Query(params))


def _write(rel, content):
    path = os.path.join(_INPUT, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content)
    return Path(path)


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class MediaContentTypeTests(unittest.TestCase):
    MEDIA = Path(_INPUT) / "NeoAgent/media"

    @classmethod
    def setUpClass(cls):
        _write("NeoAgent/media/a.png", b"\x89PNG\r\n\x1a\nfake")
        _write("NeoAgent/media/a.mp4", b"\x00\x00\x00\x18ftypmp42fake")
        _write("NeoAgent/media/a.mp3", b"ID3fake")
        _write("NeoAgent/media/a.safetensors", b'{"__metadata__":{}}fake')
        _write("NeoAgent/media/a.json", b'{"a": 1}')

    def test_known_types_and_cache_headers(self):
        for name, expected in {"a.png": "image/png", "a.mp4": "video/mp4",
                               "a.mp3": "audio/mpeg", "a.json": "application/json"}.items():
            resp = gallery._media_file_response(self.MEDIA / name)
            self.assertEqual(resp.status, 200, name)
            self.assertEqual(resp.content_type, expected, name)
            self.assertEqual(resp.headers.get("Cache-Control"), "public, max-age=86400", name)
            self.assertIn("inline;", resp.headers.get("Content-Disposition", ""), name)

    def test_unknown_binary_is_octet_stream(self):
        resp = gallery._media_file_response(self.MEDIA / "a.safetensors")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.content_type, "application/octet-stream")

    def test_video_route_serves_mp4_and_rejects_image(self):
        resp = _run(gallery.view_video(_Request({"filename": "a.mp4", "subfolder": "NeoAgent/media"})))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.content_type, "video/mp4")
        resp = _run(gallery.view_video(_Request({"filename": "a.png", "subfolder": "NeoAgent/media"})))
        self.assertEqual(resp.status, 400)

    def test_audio_route_serves_mp3(self):
        resp = _run(gallery.view_audio(_Request({"filename": "a.mp3", "subfolder": "NeoAgent/media"})))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.content_type, "audio/mpeg")

    def test_missing_file_is_404(self):
        resp = _run(gallery.view_video(_Request({"filename": "nope.mp4", "subfolder": "NeoAgent/media"})))
        self.assertEqual(resp.status, 404)

    def test_image_route_serves_png(self):
        resp = _run(gallery.view_image(_Request({"filename": "a.png", "subfolder": "NeoAgent/media"})))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.content_type, "image/png")

    def test_image_route_serves_model_file_via_shared_resolver(self):
        # 无自定义目录时 base 为空，落到共享解析器：权重文件按 octet-stream 返回。
        resp = _run(gallery.view_image(_Request({"filename": "a.safetensors", "subfolder": "NeoAgent/media"})))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.content_type, "application/octet-stream")
        self.assertIn(quote("a.safetensors"), resp.headers.get("Content-Disposition", ""))

    def test_traversal_is_rejected(self):
        resp = _run(gallery.view_image(_Request({"filename": "../a.png", "subfolder": "NeoAgent/media"})))
        self.assertEqual(resp.status, 400)
        resp = _run(gallery.view_video(_Request({"filename": "a.mp4", "subfolder": "../.."})))
        self.assertEqual(resp.status, 400)


    def test_full_list_route_returns_directories(self):
        resp = _run(gallery.get_gallery_list(_Request({})))
        self.assertEqual(resp.status, 200)
        self.assertIn("directories", json.loads(resp.text))

    def test_thumbnail_route_serves_cached_jpeg(self):
        from PIL import Image
        gallery.THUMBNAIL_DIR = Path(_TMP) / "thumbs"
        Image.new("RGB", (64, 32), (200, 30, 30)).save(self.MEDIA / "thumb_src.png")
        req = _Request({"filename": "thumb_src.png", "subfolder": "NeoAgent/media"})
        resp = _run(gallery.get_thumbnail(req))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.content_type, "image/jpeg")
        self.assertEqual(resp.headers.get("Cache-Control"), "public, max-age=86400")
        # 第二次命中磁盘缓存，仍然正常返回
        self.assertEqual(_run(gallery.get_thumbnail(req)).status, 200)

    def test_thumbnail_route_missing_is_404(self):
        gallery.THUMBNAIL_DIR = Path(_TMP) / "thumbs"
        resp = _run(gallery.get_thumbnail(_Request({"filename": "ghost.png", "subfolder": "nope"})))
        self.assertEqual(resp.status, 404)


class DimCacheTests(unittest.TestCase):
    """尺寸缓存持久化：重启后重开同一目录不再读图片头（NAS 上每张卡一次往返）。"""

    BASE = Path(_TMP) / "dimcache"
    SIZES = {"a.png": (40, 30), "b.png": (20, 10)}

    def setUp(self):
        self.BASE.mkdir(parents=True, exist_ok=True)
        for name, size in self.SIZES.items():
            Image.new("RGB", size).save(self.BASE / name)
        gallery._DIM_CACHE.clear()
        gallery._DIM_CACHE_LOADED = False

    def tearDown(self):
        gallery._DIM_CACHE.clear()
        gallery._DIM_CACHE_LOADED = False

    def _sizes(self, entries):
        return {e["filename"]: (e.get("w"), e.get("h")) for e in entries}

    def test_sizes_survive_cache_reload(self):
        self.assertEqual(self._sizes(gallery._scan_gallery_entries(self.BASE, "")), self.SIZES)
        self.assertTrue((gallery.CONFIGS_DIR / "gallery_dim_cache.json").exists())

        gallery._DIM_CACHE.clear()
        gallery._DIM_CACHE_LOADED = False
        real = gallery._media_dimensions
        gallery._media_dimensions = lambda path: self.fail("header re-read after reload")
        try:
            entries = gallery._scan_gallery_entries(self.BASE, "")
        finally:
            gallery._media_dimensions = real
        self.assertEqual(self._sizes(entries), self.SIZES)

    def test_changed_file_is_reread(self):
        entries = gallery._scan_gallery_entries(self.BASE, "")
        self.assertEqual(self._sizes(entries), self.SIZES)

        Image.new("RGB", (11, 7)).save(self.BASE / "a.png")
        gallery._DIM_CACHE.clear()
        gallery._DIM_CACHE_LOADED = False
        entries = gallery._scan_gallery_entries(self.BASE, "")
        self.assertEqual(self._sizes(entries), {"a.png": (11, 7), "b.png": (20, 10)})


if __name__ == "__main__":
    unittest.main()

