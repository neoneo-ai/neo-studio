# SPDX-License-Identifier: Apache-2.0
"""Manage Directories：自定义目录的隐藏与排序（离线单测）。

隐藏的目录保留在配置里，但 _get_user_custom_dirs 不再返回它；
reorder 按提交的完整顺序回写（未知路径剔除、未列出的目录追加末尾）；set_hidden 对不存在的目录无效；
删除目录时同步清掉它的隐藏标记。set_character 写角色图目录标记（character_dirs），同样只认已知
token；云端目录由索引的 character 标签自带默认值，用户显式取消的记在 character_dirs_off 里。
"""

import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
import importlib.util as _importlib_util
from pathlib import Path
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="neo_gallery_dir_manage_")
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
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_gallery_dir_manage_pkg"
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


# 内存版 settings：save_gallery_settings 走 _load/_save，_get_user_custom_dirs 走真实 JSON 文件
_SETTINGS = {}

_stub("util",
      IMG_EXTENSIONS={".png"}, VIDEO_EXTENSIONS={".mp4"},
      AUDIO_EXTENSIONS={".mp3"}, ALL_MEDIA_EXTENSIONS={".png", ".mp4", ".mp3"},
      _has_media_recursive=lambda *a, **k: False,
      _has_media_in_dir_any=lambda *a, **k: False,
      _extract_media_metadata=lambda *a, **k: {},
      _collect_prompt_texts=lambda *a, **k: [],
      _load_settings=lambda *a, **k: dict(_SETTINGS),
      _save_settings=lambda s, *a, **k: _SETTINGS.update(s),
      _json_safe=lambda v: v)


async def _oss_none(*a, **k):
    return None


async def _oss_no_items(*a, **k):
    return []


_stub("gallery_oss",
      OSS_NAV_PREFIX="Cloud Presets",
      OSS_TAG_CHARACTER_SHEET="character-sheet",
      _is_oss_enabled=lambda *a, **k: False,
      _load_oss_index_from_disk=lambda *a, **k: None,
      _fetch_oss_index=lambda *a, **k: None,
      _oss_index_dirs=lambda *a, **k: [],
      _oss_directories_to_gallery_dirs=lambda *a, **k: [],
      _oss_tagged_dir_tokens=lambda *a, **k: [],
      _collect_oss_covers=lambda *a, **k: None,
      _handle_oss_gallery_list=lambda *a, **k: None,
      _find_in_oss_index=_oss_none,
      _find_thumbnail_in_oss_index=_oss_none,
      _download_oss_file=lambda *a, **k: None,
      _oss_dir_cards=lambda *a, **k: [],
      _oss_dir_items=_oss_no_items)
_stub("gallery_lora",
      _lora_pending_subdirs=lambda *a, **k: {},
      _attach_lora_meta=lambda *a, **k: None,
      _attach_lora_subdir_paths=lambda *a, **k: None,
      _ensure_auto_cache=lambda *a, **k: None,
      _normalize_lora_dir=lambda *a, **k: "")
_stub("bookmark", CIVITAI_BOOKMARK_DIR=Path(_TMP) / "civitai_bookmarks",
      CIVITAI_DIR_KEY="civitai_bookmarks", _is_civitai_bookmark_enabled=lambda: False)

gallery = _load("gallery")

# 桩只在导入期占用全局名，避免影响其它测试文件。
if _prev_server is None:
    sys.modules.pop("server", None)
else:
    sys.modules["server"] = _prev_server
if _prev_folder_paths is None:
    sys.modules.pop("folder_paths", None)
else:
    sys.modules["folder_paths"] = _prev_folder_paths


class _PostRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


def _call(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _post(payload):
    resp = _call(gallery.save_gallery_settings(_PostRequest(payload)))
    return json.loads(resp.body.decode())


def _get_settings():
    resp = _call(gallery.get_gallery_settings(None))
    return json.loads(resp.body.decode())


class DirManageBase(unittest.TestCase):
    """三个真实素材目录 + 可写 settings JSON（_get_user_custom_dirs 直接读文件）。"""

    @classmethod
    def setUpClass(cls):
        cls._prev_configs_dir = gallery.CONFIGS_DIR
        cls.configs = Path(_TMP) / "configs_test"
        cls.configs.mkdir(parents=True, exist_ok=True)
        gallery.CONFIGS_DIR = cls.configs
        cls.dir_a = Path(_TMP) / "stars"
        cls.dir_b = Path(_TMP) / "beauty"
        cls.dir_c = Path(_TMP) / "wuxia"
        for d in (cls.dir_a, cls.dir_b, cls.dir_c):
            d.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        gallery.CONFIGS_DIR = cls._prev_configs_dir

    def setUp(self):
        _SETTINGS.clear()

    def _write_file_settings(self, custom, hidden=None):
        payload = {"custom_directories": custom}
        if hidden is not None:
            payload["hidden_directories"] = hidden
        (self.configs / "gallery_settings.json").write_text(
            json.dumps(payload), encoding="utf-8")

    def _post_and_sync_file(self, payload):
        """save_gallery_settings 写的是内存 settings；同步一份到文件供 _get_user_custom_dirs 读。"""
        result = _post(payload)
        self._write_file_settings(_SETTINGS.get("custom_directories", []),
                                   _SETTINGS.get("hidden_directories"))
        return result


class HiddenDirTests(DirManageBase):

    def test_hidden_dir_excluded_from_listing(self):
        self._write_file_settings(
            [str(self.dir_a), str(self.dir_b), str(self.dir_c)],
            hidden=[str(self.dir_b)])
        self.assertEqual(gallery._get_user_custom_dirs(), [self.dir_a, self.dir_c])

    def test_hidden_match_is_case_insensitive_resolved(self):
        # 配置里大小写不同的路径也要能对上（Windows 路径不区分大小写）
        hidden_entry = str(self.dir_b).upper()
        self._write_file_settings([str(self.dir_a), str(self.dir_b)], hidden=[hidden_entry])
        self.assertEqual(gallery._get_user_custom_dirs(), [self.dir_a])

    def test_no_hidden_key_lists_everything(self):
        self._write_file_settings([str(self.dir_a), str(self.dir_b)])
        self.assertEqual(gallery._get_user_custom_dirs(), [self.dir_a, self.dir_b])



class ReorderTests(DirManageBase):

    def _three_dirs(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b), str(self.dir_c)]

    def test_reorder_applies_submitted_order(self):
        self._three_dirs()
        result = _post({"action": "reorder",
                        "paths": [str(self.dir_c), str(self.dir_a), str(self.dir_b)]})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["custom_directories"],
                         [str(self.dir_c), str(self.dir_a), str(self.dir_b)])

    def test_reorder_drops_unknown_paths(self):
        self._three_dirs()
        result = _post({"action": "reorder",
                        "paths": [str(self.dir_c), "F:\\nope", str(self.dir_a)]})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["custom_directories"],
                         [str(self.dir_c), str(self.dir_a), str(self.dir_b)])

    def test_reorder_appends_missing_dirs(self):
        self._three_dirs()
        result = _post({"action": "reorder", "paths": [str(self.dir_b)]})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["custom_directories"],
                         [str(self.dir_b), str(self.dir_a), str(self.dir_c)])

    def test_reorder_non_list_is_noop(self):
        self._three_dirs()
        result = _post({"action": "reorder", "paths": None})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["custom_directories"],
                         [str(self.dir_a), str(self.dir_b), str(self.dir_c)])


class SetHiddenTests(DirManageBase):

    def test_set_hidden_adds_and_removes(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b)]
        result = _post({"action": "set_hidden", "path": str(self.dir_a), "hidden": True})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["hidden_directories"], [str(self.dir_a)])
        result = _post({"action": "set_hidden", "path": str(self.dir_a), "hidden": False})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["hidden_directories"], [])

    def test_set_hidden_builtin_key(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a)]
        result = _post({"action": "set_hidden", "path": "Lora", "hidden": True})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["hidden_directories"], ["Lora"])
        result = _post({"action": "set_hidden", "path": "Lora", "hidden": False})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["hidden_directories"], [])

    def test_set_hidden_unknown_path_ignored(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a)]
        result = _post({"action": "set_hidden", "path": "F:\\nope", "hidden": True})
        self.assertTrue(result["success"])
        self.assertNotIn("hidden_directories", _SETTINGS)

    def test_remove_cleans_hidden_flag(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b)]
        _SETTINGS["hidden_directories"] = [str(self.dir_b)]
        result = _post({"action": "remove", "path": str(self.dir_b)})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["custom_directories"], [str(self.dir_a)])
        self.assertEqual(_SETTINGS["hidden_directories"], [])

    def test_hidden_dir_disappears_from_listing_after_set_hidden(self):
        self._write_file_settings([str(self.dir_a), str(self.dir_b)])
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b)]
        result = self._post_and_sync_file({"action": "set_hidden", "path": str(self.dir_b), "hidden": True})
        self.assertTrue(result["success"])
        self.assertEqual(gallery._get_user_custom_dirs(), [self.dir_a])


class SetCharacterTests(DirManageBase):
    """角色图目录标记：character_dirs 存小写 token；未知 token 不落盘；删除目录连带清标记。"""

    def test_set_character_adds_and_removes(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a)]
        result = _post({"action": "set_character", "path": str(self.dir_a), "character": True})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["character_dirs"], [str(self.dir_a).lower()])
        _post({"action": "set_character", "path": str(self.dir_a), "character": True})   # 重复标记不堆叠
        self.assertEqual(_SETTINGS["character_dirs"], [str(self.dir_a).lower()])
        result = _post({"action": "set_character", "path": str(self.dir_a), "character": False})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["character_dirs"], [])

    def test_set_character_builtin_key(self):
        _SETTINGS["custom_directories"] = []
        result = _post({"action": "set_character", "path": "Lora", "character": True})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["character_dirs"], ["lora"])

    def test_set_character_unknown_path_ignored(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a)]
        result = _post({"action": "set_character", "path": "F:\\nope", "character": True})
        self.assertTrue(result["success"])
        self.assertNotIn("character_dirs", _SETTINGS)

    def test_set_character_cloud_preset_dir(self):
        # 云端预设目录的 token 由 OSS 索引提供；这里直接替换索引来源，不联网
        _SETTINGS["custom_directories"] = []
        with mock.patch.object(gallery, "_oss_home_dir_tokens", lambda: ["Cloud Presets/角色杂图"]):
            result = _post({"action": "set_character", "path": "Cloud Presets/角色杂图", "character": True})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["character_dirs"], ["cloud presets/角色杂图"])

    def test_remove_cleans_character_flag(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b)]
        _SETTINGS["character_dirs"] = [str(self.dir_b).lower()]
        result = _post({"action": "remove", "path": str(self.dir_b)})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["character_dirs"], [])

    def test_settings_route_exposes_character_dirs(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a)]
        _post({"action": "set_character", "path": str(self.dir_a), "character": True})
        self.assertEqual(_get_settings()["character_dirs"], [str(self.dir_a).lower()])


    def test_settings_route_adds_tagged_cloud_dirs(self):
        # 索引里打了 character 标签的云端目录自带角色图默认值，用户不用逐个点 
        _SETTINGS["custom_directories"] = [str(self.dir_a)]
        _post({"action": "set_character", "path": str(self.dir_a), "character": True})
        with mock.patch.object(gallery, "_oss_character_dir_tokens",
                               lambda: ["cloud presets/明朝人物", "cloud presets/角色杂图"]):
            chars = _get_settings()["character_dirs"]
        self.assertIn(str(self.dir_a).lower(), chars)
        self.assertIn("cloud presets/明朝人物", chars)
        self.assertIn("cloud presets/角色杂图", chars)

    def test_tagged_cloud_dir_off_survives_reload(self):
        # 点 取消云端目录要记进 character_dirs_off，读取时不会被默认值顶回来
        _SETTINGS["custom_directories"] = []
        with mock.patch.multiple(gallery,
                                 _oss_home_dir_tokens=lambda: ["Cloud Presets/明朝人物"],
                                 _oss_character_dir_tokens=lambda: ["cloud presets/明朝人物"]):
            result = _post({"action": "set_character", "path": "Cloud Presets/明朝人物", "character": False})
            self.assertTrue(result["success"])
            self.assertEqual(_SETTINGS["character_dirs_off"], ["cloud presets/明朝人物"])
            self.assertNotIn("cloud presets/明朝人物", _SETTINGS["character_dirs"])
            self.assertNotIn("cloud presets/明朝人物", _get_settings()["character_dirs"])

    def test_set_character_on_cloud_dir_clears_off(self):
        _SETTINGS["custom_directories"] = []
        _SETTINGS["character_dirs_off"] = ["cloud presets/明朝人物"]
        with mock.patch.multiple(gallery,
                                 _oss_home_dir_tokens=lambda: ["Cloud Presets/明朝人物"],
                                 _oss_character_dir_tokens=lambda: ["cloud presets/明朝人物"]):
            result = _post({"action": "set_character", "path": "Cloud Presets/明朝人物", "character": True})
            self.assertTrue(result["success"])
            self.assertEqual(_SETTINGS["character_dirs"], ["cloud presets/明朝人物"])
            self.assertEqual(_SETTINGS["character_dirs_off"], [])

    def test_local_dir_unmark_writes_no_off_entry(self):
        # 本地目录没有云端默认值，取消只清 character_dirs，不产生 character_dirs_off
        _SETTINGS["custom_directories"] = [str(self.dir_a)]
        _post({"action": "set_character", "path": str(self.dir_a), "character": True})
        _post({"action": "set_character", "path": str(self.dir_a), "character": False})
        self.assertEqual(_SETTINGS["character_dirs"], [])
        self.assertEqual(_SETTINGS.get("character_dirs_off", []), [])

    def test_remove_cleans_character_dirs_off(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b)]
        _SETTINGS["character_dirs_off"] = [str(self.dir_b).lower()]
        result = _post({"action": "remove", "path": str(self.dir_b)})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS.get("character_dirs_off", []), [])


class HomeOrderTests(DirManageBase):
    """统一顺序表：内置板块与自定义目录同表排序，删除目录时同步清掉表里的条目。"""

    def test_default_order_is_builtins_dirs_lora(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b)]
        self.assertEqual(gallery._get_home_order(),
                         ["Output", "Input", "local_bookmarks", "civitai_bookmarks",
                          str(self.dir_a), str(self.dir_b), "Lora"])

    def test_reorder_writes_unified_order(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b), str(self.dir_c)]
        paths = ["Lora", str(self.dir_c), "Output", "Input", "local_bookmarks",
                 "civitai_bookmarks", str(self.dir_a)]
        result = _post({"action": "reorder", "paths": paths})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["custom_directories"],
                         [str(self.dir_c), str(self.dir_a), str(self.dir_b)])
        self.assertEqual(_SETTINGS["home_order"],
                         ["Lora", str(self.dir_c), "Output", "Input", "local_bookmarks",
                          "civitai_bookmarks", str(self.dir_a), str(self.dir_b)])

    def test_get_settings_returns_home_order(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a)]
        self.assertEqual(_get_settings()["home_order"],
                         ["Output", "Input", "local_bookmarks", "civitai_bookmarks",
                          str(self.dir_a), "Lora"])

    def test_remove_cleans_home_order_entry(self):
        _SETTINGS["custom_directories"] = [str(self.dir_a), str(self.dir_b)]
        _SETTINGS["home_order"] = ["Output", str(self.dir_b), "Lora"]
        result = _post({"action": "remove", "path": str(self.dir_b)})
        self.assertTrue(result["success"])
        self.assertEqual(_SETTINGS["home_order"], ["Output", "Lora"])


if __name__ == "__main__":
    unittest.main()

