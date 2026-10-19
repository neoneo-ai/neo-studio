# SPDX-License-Identifier: Apache-2.0
"""/neo_gallery/image 的 base 目录解析顺序（离线单测）。

列表项只带「相对子路径」（浏览 input/NeoAgent 时 subfolder="NeoAgent"），但同名
子目录可能同时存在于 input 与 output（实测 input/NeoAgent 存导演锚点帧、output/NeoAgent
存生成图）。命中其中一个 base 后就只在它下面找文件、找不到直接 404，会让另一个根里的
图点不开：卡片缩略图走共享解析器正常，灯箱/大图走 /neo_gallery/image 却 404。

灯箱「提示词」全文走 /neo_gallery/txt：列表项的 txt_content 只是预览（云端索引 500 字、
本地扫描 8 行），副文件原文要单独读，否则「复制提示词」复制的是截断文本。
"""

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="neo_gallery_image_")
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

_PKG = "_neo_gallery_image_pkg"
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

# 桩只在导入期占用全局名，避免影响其它测试文件（它们各自安装同名桩）。
if _prev_server is None:
    sys.modules.pop("server", None)
else:
    sys.modules["server"] = _prev_server
if _prev_folder_paths is None:
    sys.modules.pop("folder_paths", None)
else:
    sys.modules["folder_paths"] = _prev_folder_paths

# 无自定义目录：只考验 input/output 两个系统根
gallery._get_user_custom_dirs = lambda: []


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


def _write(rel_to_root, content, root):
    path = os.path.join(root, rel_to_root.replace("/", os.sep))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content)
    return path


def _image(filename, subfolder):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(
            gallery.view_image(_Request({"filename": filename, "subfolder": subfolder})))
    finally:
        loop.close()


def _txt(filename, subfolder):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(
            gallery.view_txt(_Request({"filename": filename, "subfolder": subfolder})))
    finally:
        loop.close()


class ImageRouteRootFallbackTests(unittest.TestCase):
    """base 目录里找不到文件时必须再走共享解析器，而不是直接 404。"""

    def setUp(self):
        # input 与 output 各有一个 NeoAgent 子目录（真实数据里的同名子目录）
        _write("NeoAgent/ref_abc.png", b"input-ref", root=_INPUT)
        _write("NeoAgent/shot.png", b"output-shot", root=_OUTPUT)

    def test_file_in_input_resolves_with_bare_subfolder(self):
        resp = _image("ref_abc.png", "NeoAgent")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, b"input-ref")

    def test_file_in_output_still_resolves(self):
        resp = _image("shot.png", "NeoAgent")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, b"output-shot")

    def test_prefixed_subfolder_resolves(self):
        resp = _image("ref_abc.png", "Input/NeoAgent")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.body, b"input-ref")

    def test_missing_file_still_404(self):
        self.assertEqual(_image("nope.png", "NeoAgent").status, 404)


class TxtRouteSidecarTests(unittest.TestCase):
    """/neo_gallery/txt 返回副文件全文，共享解析器解析不到时 404。"""

    def setUp(self):
        _write("NeoAgent/shot.png", b"output-shot", root=_OUTPUT)
        _write("NeoAgent/shot.txt", "宗门演武台、剑冢、云海崖".encode("utf-8"), root=_OUTPUT)

    def test_sidecar_text_returns_full_content(self):
        resp = _txt("shot.png", "NeoAgent")
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.body.decode())["content"], "宗门演武台、剑冢、云海崖")

    def test_missing_sidecar_is_404(self):
        self.assertEqual(_txt("ref_abc.png", "NeoAgent").status, 404)

    def test_empty_filename_is_400(self):
        self.assertEqual(_txt("", "NeoAgent").status, 400)


class TxtRouteOssSidecarTests(unittest.TestCase):
    """/neo_gallery/txt 的云端分支：下载路径必须保持索引里的 posix 分隔符。

    索引里的 rel 是 "仙侠玄幻人物/181_下凡仙娥.png"；换后缀时走 str(Path(...))
    在 Windows 上会得到 "仙侠玄幻人物\\181_下凡仙娥.txt"，拼进下载 URL 就是 404，
    灯箱全文永远回落到 500 字预览。
    """

    def setUp(self):
        self._orig = (gallery._is_oss_enabled, gallery._find_in_oss_index, gallery._download_oss_file)
        self.calls = []
        sidecar = _write("oss_dl/仙侠玄幻人物/181_下凡仙娥.txt",
                         "正向提示词：仙山云海、宗门演武台".encode("utf-8"), root=_TMP)
        gallery._is_oss_enabled = lambda: True

        async def _find(fn, sub):
            return "仙侠玄幻人物/181_下凡仙娥.png"

        gallery._find_in_oss_index = _find

        async def _dl(rel):
            self.calls.append(rel)
            return Path(sidecar)

        gallery._download_oss_file = _dl

    def tearDown(self):
        gallery._is_oss_enabled, gallery._find_in_oss_index, gallery._download_oss_file = self._orig

    def test_cloud_sidecar_returns_full_text(self):
        resp = _txt("181_下凡仙娥.png", "Cloud Presets/仙侠玄幻人物")
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.body.decode())["content"], "正向提示词：仙山云海、宗门演武台")

    def test_download_rel_stays_posix(self):
        _txt("181_下凡仙娥.png", "Cloud Presets/仙侠玄幻人物")
        rel = self.calls[0]
        self.assertEqual(rel, "仙侠玄幻人物/181_下凡仙娥.txt")
        self.assertNotIn("\\", rel)
