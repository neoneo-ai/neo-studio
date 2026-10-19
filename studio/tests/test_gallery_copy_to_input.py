# SPDX-License-Identifier: Apache-2.0
"""/neo_gallery/copy_to_input 的 subfolder 解析顺序（离线单测）。

画廊卡片只带「相对子路径」（自定义目录下的 "刘亦菲"、input 下的 "pasted"），
解析时必须优先按 subfolder 精确定位，之后才按文件名做宽松兜底：否则 input/output
根目录里同名的另一张图会盖过用户选中的那张，复制出来的参考图与同一个 subfolder 的
/neo_gallery/thumbnail 预览不一致（实测数据里 stars/刘亦菲/003.png 与 input|output
根的 003.png 同名但内容不同，角色图因此参考了错的图）。
"""

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="neo_gallery_copy_")
_INPUT = os.path.join(_TMP, "input")
_OUTPUT = os.path.join(_TMP, "output")
_CUSTOM = os.path.join(_TMP, "stars")   # 自定义目录（扫描结果里的卡片名 = 目录名）

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

_PKG = "_neo_gallery_copy_pkg"
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

# 自定义目录固定为临时 stars 目录（gallery.py 只在导入期绑定 folder_paths）
gallery._get_user_custom_dirs = lambda: [Path(_CUSTOM)]


class _Query:
    def __init__(self, params):
        self._params = params

    def get(self, key, default=""):
        return self._params.get(key, default)


class _Request:
    def __init__(self, params):
        self.rel_url = types.SimpleNamespace(query=_Query(params))


def _write(rel_to_root, content, root=_CUSTOM):
    path = os.path.join(root, rel_to_root.replace("/", os.sep))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content)
    return path


def _copy(filename, subfolder):
    loop = asyncio.new_event_loop()
    try:
        resp = loop.run_until_complete(
            gallery.copy_to_input(_Request({"filename": filename, "subfolder": subfolder})))
    finally:
        loop.close()
    return json.loads(resp.body.decode())


class CopyToInputSubfolderTests(unittest.TestCase):
    """选中素材的定位必须与缩略图预览一致：先按 subfolder 精确解析，再按文件名兜底。"""

    @classmethod
    def setUpClass(cls):
        # _copy_media_to_input 在调用期懒导入 folder_paths：测试期间挂上桩，结束还原
        cls._prev_folder_paths = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = _folder_paths
        # 自定义目录里人名子目录下的同名图（真实配置里的 stars/<人名>/003.png）
        _write("刘亦菲/003.png", b"liu")
        _write("关晓彤/003.png", b"guan")
        # input / output 根各有一张同名的无关图（来自更早的运行）
        _write("003.png", b"unrelated-input", root=_INPUT)
        _write("003.png", b"unrelated-output", root=_OUTPUT)

    @classmethod
    def tearDownClass(cls):
        if cls._prev_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = cls._prev_folder_paths

    def _copied(self, out):
        self.assertTrue(out.get("success"), out)
        return Path(_INPUT, out["filename"]).read_bytes()

    def test_custom_subfolder_beats_same_named_root_file(self):
        # stars/刘亦菲/003.png：不能被 input|output 根的 003.png 顶掉
        self.assertEqual(self._copied(_copy("003.png", "刘亦菲")), b"liu")

    def test_input_relative_subfolder_beats_input_root(self):
        _write("pasted/shot.png", b"pasted", root=_INPUT)
        _write("shot.png", b"input-root", root=_INPUT)
        self.assertEqual(self._copied(_copy("shot.png", "pasted")), b"pasted")

    def test_output_relative_subfolder_beats_output_root(self):
        _write("2026-09-24/frame.png", b"dated", root=_OUTPUT)
        _write("frame.png", b"output-root", root=_OUTPUT)
        self.assertEqual(self._copied(_copy("frame.png", "2026-09-24")), b"dated")

    def test_prefixed_subfolder_still_resolves(self):
        # 带目录名前缀的完整形式（收藏/导航路径）解析不变
        self.assertEqual(self._copied(_copy("003.png", "stars/刘亦菲")), b"liu")

    def test_root_file_without_subfolder_still_resolves(self):
        # 无 subfolder（素材就在目录根）：按文件名的宽松兜底仍然可用
        _write("rootonly.png", b"root-only", root=_OUTPUT)
        self.assertEqual(self._copied(_copy("rootonly.png", "")), b"root-only")

    def test_missing_file_reports_not_found(self):
        out = _copy("nope.png", "刘亦菲")
        self.assertFalse(out["success"])
        self.assertEqual(out["error"], "Image not found")
