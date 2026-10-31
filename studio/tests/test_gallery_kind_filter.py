# SPDX-License-Identifier: Apache-2.0
"""虚拟归类快捷筛选（/neo_gallery/kind_items）：全站聚合的判定、上限与隐藏条目（离线单测）。

标签是虚拟归类：文件不搬进新目录，标签按扩展名与目录锚定把全库素材归到一起。
扫的是首页可见的那些目录；排序表里隐藏的条目一并跳过，云端预设（每个云端目录都要一次索引
下载）不进聚合，只扫本地。
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
import importlib.util as _importlib_util
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="neo_gallery_kind_")
_INPUT = os.path.join(_TMP, "input")
_OUTPUT = os.path.join(_TMP, "output")
os.makedirs(_INPUT, exist_ok=True)
os.makedirs(_OUTPUT, exist_ok=True)

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
_folder_paths.get_output_directory = lambda: _OUTPUT
_folder_paths.get_input_directory = lambda: _INPUT
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_gallery_kind_pkg"
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


def _load(name):
    spec = _importlib_util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, f"{name}.py"))
    mod = _importlib_util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
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
_oss = _load("gallery_oss")      # 真实模块：临时数据根里没有索引，云端预设一律不算进聚合
_stub("gallery_lora",
      _lora_pending_subdirs=lambda *a, **k: {},
      _attach_lora_meta=lambda *a, **k: None,
      _attach_lora_subdir_paths=lambda *a, **k: None,
      _ensure_auto_cache=lambda *a, **k: None,
      _normalize_lora_dir=lambda *a, **k: "")
_stub("bookmark", CIVITAI_BOOKMARK_DIR=Path(_TMP) / "civitai_bookmarks",
      CIVITAI_DIR_KEY="civitai_bookmarks", _is_civitai_bookmark_enabled=lambda: False)

gallery = _load("gallery")
# 设置与缓存都落在临时 configs，不污染插件真实配置
gallery.CONFIGS_DIR = Path(_TMP) / "configs"
gallery.GRID_DIR = Path(_OUTPUT) / "StoryBoard"
gallery.CHARACTER_DIR = Path(_OUTPUT) / "CharacterSheet"

# 桩只在导入期占用全局名，避免影响其它测试文件。
if _prev_server is None:
    sys.modules.pop("server", None)
else:
    sys.modules["server"] = _prev_server
if _prev_folder_paths is None:
    sys.modules.pop("folder_paths", None)
else:
    sys.modules["folder_paths"] = _prev_folder_paths


class _Query:
    def __init__(self, params):
        self._params = params

    def get(self, key, default=""):
        return self._params.get(key, default)


class _GetRequest:
    def __init__(self, params):
        self.rel_url = types.SimpleNamespace(query=_Query(params))


def _call(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _payload(resp):
    return json.loads(resp.body.decode())


def _write(path, content=b"x", mtime=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def _names(items):
    return [item["filename"] for item in items]


def _settings(**overrides):
    base = {"custom_directories": [], "hidden_directories": [], "character_dirs": []}
    base.update(overrides)
    return base


def _apply_settings(settings: dict) -> None:
    """本用例的设置：标记与云端标签读内存里这一份，自定义目录与隐藏条目读临时 configs 里那一份。

    自定义目录是 _scan_user_custom_dirs 从盘上读的，只改 _load_settings 的话首页看不到它。
    """
    gallery.CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    (gallery.CONFIGS_DIR / "gallery_settings.json").write_text(json.dumps(settings), encoding="utf-8")
    gallery._load_settings = lambda: settings
    gallery._invalidate_user_custom_dirs()


class KindCountTests(unittest.TestCase):
    """计数按扩展名分开：图片 / 视频 / 音频；一张文件可以同时进多个标签。"""

    def setUp(self):
        self.settings = _settings()
        _apply_settings(self.settings)
        self.written = []

    def tearDown(self):
        for path in self.written:
            if path.exists():
                path.unlink()

    def test_kind_param_empty_returns_only_counts(self):
        self.written.append(_write(Path(_OUTPUT) / "a.png"))
        self.written.append(_write(Path(_OUTPUT) / "b.mp4"))
        self.written.append(_write(Path(_OUTPUT) / "c.mp3"))

        out = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": ""}))))
        self.assertEqual(out["counts"]["image"], 1)
        self.assertEqual(out["counts"]["video"], 1)
        self.assertEqual(out["counts"]["audio"], 1)
        self.assertNotIn("items", out)

    def test_kind_filter_returns_items_of_that_kind_only(self):
        self.written.append(_write(Path(_OUTPUT) / "a.png"))
        self.written.append(_write(Path(_OUTPUT) / "c.mp3"))

        out = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": "audio"}))))
        self.assertEqual(out["kind"], "audio")
        self.assertEqual(_names(out["items"]), ["c.mp3"])
        # 条目带的是首页一致的目录名前缀，缩略图与取用照现有寻址走
        self.assertEqual(out["items"][0]["subfolder"], "Output")
        self.assertEqual(out["items"][0]["type"], "audio")


class KindAnchorTests(unittest.TestCase):
    """用途标签按目录锚定：Pose / Frames / StoryBoard / CharacterSheet 的落点全在 output 下。"""

    def setUp(self):
        self.settings = _settings()
        _apply_settings(self.settings)
        self.written = []

    def tearDown(self):
        for path in self.written:
            if path.exists():
                path.unlink()

    def test_pose_frames_storyboard_charactersheet_anchors(self):
        self.written.append(_write(Path(_OUTPUT) / "Pose" / "pose_front_side.png"))
        self.written.append(_write(Path(_OUTPUT) / "Frames" / "frame-00_07_125.png"))
        self.written.append(_write(Path(_OUTPUT) / "StoryBoard" / "26-09-24" / "grid.png"))
        self.written.append(_write(Path(_OUTPUT) / "CharacterSheet" / "26-09-24" / "sheet.png"))

        counts = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": ""}))))["counts"]
        self.assertEqual(counts["pose"], 1)
        self.assertEqual(counts["frames"], 1)
        self.assertEqual(counts["storyboard"], 1)
        self.assertEqual(counts["character"], 1)
        # 一张文件同时进类型标签与用途标签
        self.assertEqual(counts["image"], 4)

        pose = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": "pose"}))))
        self.assertEqual(_names(pose["items"]), ["pose_front_side.png"])
        self.assertEqual(pose["items"][0]["subfolder"], "Output/Pose")

        sheet = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": "storyboard"}))))
        self.assertEqual(sheet["items"][0]["subfolder"], "Output/StoryBoard/26-09-24")

    def test_filename_prefix_covers_before_the_pose_dir_existed(self):
        """摆姿与抽帧的旧批次直接落在 output 根，只有文件名前缀能认出来。"""
        self.written.append(_write(Path(_OUTPUT) / "pose_shot.png"))
        self.written.append(_write(Path(_OUTPUT) / "frame-00_07_125.png"))
        self.written.append(_write(Path(_OUTPUT) / "shot.png"))

        counts = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": ""}))))["counts"]
        self.assertEqual(counts["pose"], 1)
        self.assertEqual(counts["frames"], 1)


class KindCustomDirTests(unittest.TestCase):
    """自定义目录进聚合：条目带的是目录名前缀，标记的角色图逐段继承（子目录不用重标）。"""

    def setUp(self):
        self.settings = _settings()
        _apply_settings(self.settings)
        self.custom = Path(_TMP) / "library" / "stars"

    def tearDown(self):
        shutil.rmtree(self.custom, ignore_errors=True)
        gallery._invalidate_user_custom_dirs()

    def test_items_carry_the_custom_dir_name_prefix(self):
        _write(self.custom / "孟子义" / "front.png")
        self.settings = _settings(custom_directories=[str(self.custom)])
        _apply_settings(self.settings)

        out = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": "image"}))))
        self.assertEqual(_names(out["items"]), ["front.png"])
        self.assertEqual(out["items"][0]["subfolder"], "stars/孟子义")

    def test_marked_character_dir_inherits_by_segments(self):
        _write(self.custom / "孟子义" / "front.png")
        self.settings = _settings(custom_directories=[str(self.custom)],
                                  character_dirs=[str(self.custom)])
        _apply_settings(self.settings)

        # 标记落在 stars 上：它下面的每一层子目录都继承，子目录里没重标也认角色图
        counts = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": ""}))))["counts"]
        self.assertEqual(counts["character"], 1)
        self.assertEqual(counts["image"], 1)
        self.assertEqual(_names(_payload(_call(gallery.get_kind_items(
            _GetRequest({"kind": "character"}))))["items"]), ["front.png"])

    def test_sibling_of_marked_dir_is_not_character(self):
        _write(self.custom / "孟子义" / "front.png")
        _write(self.custom / "other" / "wide.png")
        self.settings = _settings(custom_directories=[str(self.custom)],
                                  character_dirs=[str(self.custom / "孟子义")])
        _apply_settings(self.settings)

        # 只标了孟子义那一层：同级的 other 不跟着沾光
        self.assertEqual(_payload(_call(gallery.get_kind_items(
            _GetRequest({"kind": ""}))))["counts"]["character"], 1)

    def test_unmarked_character_dir_leaves_the_kind(self):
        _write(self.custom / "front.png")
        self.settings = _settings(custom_directories=[str(self.custom)],
                                  character_dirs=[str(self.custom)],
                                  character_dirs_off=[str(self.custom)])
        _apply_settings(self.settings)

        self.assertEqual(_payload(_call(gallery.get_kind_items(
            _GetRequest({"kind": ""}))))["counts"]["character"], 0)


class KindRootBoundaryTests(unittest.TestCase):
    """聚合的边界：首页隐藏的条目不进标签，没启用的 Lora 缓存不进标签，条数上限带 truncated。"""

    def setUp(self):
        self.settings = _settings()
        _apply_settings(self.settings)
        self.custom = Path(_TMP) / "library" / "hidden_dir"

    def tearDown(self):
        shutil.rmtree(self.custom, ignore_errors=True)
        shutil.rmtree(gallery.LORA_CACHE_DIR, ignore_errors=True)
        gallery._invalidate_user_custom_dirs()

    def test_hidden_custom_dir_is_skipped(self):
        _write(self.custom / "gone.png")
        self.settings = _settings(custom_directories=[str(self.custom)],
                                  hidden_directories=[str(self.custom)])
        _apply_settings(self.settings)

        out = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": "image"}))))
        self.assertEqual(out["counts"]["image"], 0)
        self.assertEqual(_names(out["items"]), [])

    def test_hidden_system_dir_is_skipped(self):
        written = _write(Path(_OUTPUT) / "hidden_output.png")
        self.settings = _settings(hidden_directories=["Output"])
        _apply_settings(self.settings)
        self.assertEqual(_payload(_call(gallery.get_kind_items(
            _GetRequest({"kind": "image"}))))["counts"]["image"], 0)
        written.unlink()

    def test_disabled_lora_cache_is_not_aggregated(self):
        _write(gallery.LORA_CACHE_DIR / "detail" / "example.png")
        self.assertEqual(_payload(_call(gallery.get_kind_items(
            _GetRequest({"kind": "image"}))))["counts"]["image"], 0)

        self.settings = _settings(civitai_lora_enabled=True)
        _apply_settings(self.settings)
        out = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": "image"}))))
        self.assertEqual(out["counts"]["image"], 1)
        self.assertEqual(out["items"][0]["subfolder"], "Lora/detail")

    def test_items_are_capped_and_marked_truncated(self):
        stamp = 1700000000
        names = [f"shot{index}.png" for index in range(6)]
        for index, name in enumerate(names):
            _write(Path(_OUTPUT) / name, mtime=stamp + index)
        gallery.KIND_MAX_ITEMS = 4
        try:
            out = _payload(_call(gallery.get_kind_items(_GetRequest({"kind": "image"}))))
        finally:
            gallery.KIND_MAX_ITEMS = 400
            for name in names:
                (Path(_OUTPUT) / name).unlink()

        # 计数数的是全库，条目只交回前 4 条，剩下的靠 truncated 说清
        self.assertEqual(out["counts"]["image"], 6)
        self.assertEqual(len(out["items"]), 4)
        self.assertTrue(out["truncated"])
        # 按 mtime 倒序：最近生成的排在前面，与目录视图同一份排序
        self.assertEqual(_names(out["items"])[:2], ["shot5.png", "shot4.png"])
