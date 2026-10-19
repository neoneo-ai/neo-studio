# SPDX-License-Identifier: Apache-2.0
"""StoryBoard / CharacterSheet 主目录与云端预设卡（离线单测）。

主目录是 output 下的子目录，只放可写的生成结果（<日期>/）。云端预设目录一律是
Cloud Presets 卡，预设文件只缓存在 Gallery 的 oss_cache；索引里残留的 categories
映射（旧版把预设挂进主目录的设计）读取时忽略，历史索引继续可用。
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

_TMP = tempfile.mkdtemp(prefix="neo_gallery_main_")
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

_PKG = "_neo_gallery_main_pkg"
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
_oss = _load("gallery_oss")      # 真实模块：分类解析与缓存路径就是要测的逻辑
_stub("gallery_lora",
      _lora_pending_subdirs=lambda *a, **k: {},
      _attach_lora_meta=lambda *a, **k: None,
      _attach_lora_subdir_paths=lambda *a, **k: None,
      _ensure_auto_cache=lambda *a, **k: None,
      _normalize_lora_dir=lambda *a, **k: "")
_stub("bookmark", CIVITAI_BOOKMARK_DIR=Path(_TMP) / "civitai_bookmarks",
      CIVITAI_DIR_KEY="civitai_bookmarks", _is_civitai_bookmark_enabled=lambda: False)

gallery = _load("gallery")
# 尺寸缓存等运行期写入落在临时 configs，不污染插件真实配置
gallery.CONFIGS_DIR = Path(_TMP) / "configs"

# 桩只在导入期占用全局名，避免影响其它测试文件。
if _prev_server is None:
    sys.modules.pop("server", None)
else:
    sys.modules["server"] = _prev_server
if _prev_folder_paths is None:
    sys.modules.pop("folder_paths", None)
else:
    sys.modules["folder_paths"] = _prev_folder_paths

GRID_DIR = Path(_OUTPUT) / "StoryBoard"
CHARACTER_DIR = Path(_OUTPUT) / "CharacterSheet"
gallery.GRID_DIR = GRID_DIR
gallery.CHARACTER_DIR = CHARACTER_DIR
gallery._MAIN_DIRS = {
    "StoryBoard": GRID_DIR,
    "CharacterSheet": CHARACTER_DIR,
}


class _Query:
    def __init__(self, params):
        self._params = params

    def get(self, key, default=""):
        return self._params.get(key, default)


class _GetRequest:
    def __init__(self, params):
        self.rel_url = types.SimpleNamespace(query=_Query(params))


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


def _payload(resp):
    return json.loads(resp.body.decode())


def _write(path, content=b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


_LEGACY_INDEX = {
    "base_url": "https://oss.example/presets/",
    "directories": {
        "styles": {"items": [{"filename": "a.png", "type": "image"}]},
        "已分类分镜": {"items": [{"filename": "g.png", "type": "image"}]},
        "已分类角色": {"items": [{"filename": "c.png", "type": "image"}]},
    },
}

_CATEGORY_INDEX = {
    "categories": {
        "StoryBoard": ["已分类分镜"],
        "CharacterSheet": ["已分类角色"],
        "presets": ["显式预设"],
    },
    "directories": {
        "显式预设": {"items": [{"filename": "p.png", "type": "image", "thumbnail": "thumbs/p.png"}]},
        "已分类分镜": {"items": [{"filename": "g.png", "type": "image", "thumbnail": "thumbs/g.png"}]},
        "已分类角色": {"items": [{"filename": "c.png", "type": "image", "thumbnail": "thumbs/c.png"}]},
        "未分类": {"items": [{"filename": "u.png", "type": "image", "thumbnail": "thumbs/u.png"}]},
    },
}


class OssIndexDirTests(unittest.TestCase):
    """索引里每个目录都是一张 Cloud Presets 卡；旧索引的 categories 映射不参与归属。"""

    def test_every_directory_is_a_preset_card(self):
        self.assertEqual(sorted(_oss._oss_index_dirs(_LEGACY_INDEX)),
                         ["styles", "已分类分镜", "已分类角色"])

    def test_legacy_categories_mapping_is_ignored(self):
        # 旧索引把目录挂进 StoryBoard/CharacterSheet：这些目录同样出现在 Cloud Presets
        self.assertEqual(sorted(_oss._oss_index_dirs(_CATEGORY_INDEX)),
                         ["已分类分镜", "已分类角色", "显式预设", "未分类"])

    def test_cache_dir_is_the_gallery_oss_cache(self):
        # 云端文件曾按分类写进 output/StoryBoard|CharacterSheet/presets：插件缓存落在用户 output 树里
        prev_cfg = _oss._get_oss_config
        _oss._get_oss_config = lambda: {}
        try:
            self.assertEqual(_oss._get_oss_cache_dir(), _oss.OSS_CACHE_DIR)
        finally:
            _oss._get_oss_config = prev_cfg

    def test_lookup_finds_files_of_legacy_categorized_dirs(self):
        prev = _oss._oss_index_cache
        _oss._oss_index_cache = _CATEGORY_INDEX
        try:
            async def _lookup(subdir):
                return await _oss._find_in_oss_index("g.png", subdir)

            self.assertEqual(asyncio.run(_lookup("已分类分镜")), "已分类分镜/g.png")
            self.assertIsNone(asyncio.run(_lookup("没有这个目录")))
        finally:
            _oss._oss_index_cache = prev

    def test_three_nav_prefixes_share_one_index_dir(self):
        # 三种导航前缀解析到同一个索引目录：前缀只决定卡片出现在哪
        self.assertEqual(gallery._oss_dir_from_subfolder("Cloud Presets/已分类分镜"), "已分类分镜")
        self.assertEqual(gallery._oss_dir_from_subfolder("StoryBoard/presets/已分类分镜"), "已分类分镜")
        self.assertEqual(gallery._oss_dir_from_subfolder("CharacterSheet/presets/已分类分镜"), "已分类分镜")
        # 前缀本身与本地目录、日期目录都不带出目录名
        self.assertEqual(gallery._oss_dir_from_subfolder("Cloud Presets"), "")
        self.assertEqual(gallery._oss_dir_from_subfolder("StoryBoard/presets"), "")
        self.assertEqual(gallery._oss_dir_from_subfolder("StoryBoard/2026-09-26"), "")
        self.assertEqual(gallery._oss_dir_from_subfolder(""), "")


_TAG_INDEX = {
    "version": 2,
    "base_url": "http://127.0.0.1:1/neo/presets",
    "categories": {"presets": ["明朝人物", "角色杂图"],
                   "CharacterSheet": ["现代人物"],
                   "StoryBoard": ["分镜标签"]},
    "directories": {
        # 标签大小写混杂与重复：读取要归一去重
        "明朝人物": {"count": 1, "index": "明朝人物/index.json", "rev": "r",
                  "covers": [], "tags": ["Character-Sheet", "character-sheet"]},
        # 老索引条目没有 tags 字段 = 无标签
        "角色杂图": {"count": 1, "index": "角色杂图/index.json", "rev": "r", "covers": []},
        "现代人物": {"count": 1, "index": "现代人物/index.json", "rev": "r",
                  "covers": [], "tags": ["character-sheet"]},
        "分镜标签": {"count": 1, "index": "分镜标签/index.json", "rev": "r",
                  "covers": [], "tags": ["character-sheet"]},
        "未归类标签": {"count": 1, "index": "未归类标签/index.json", "rev": "r",
                   "covers": [], "tags": ["voice"]},
        "_root": {"count": 1, "index": "_root/index.json", "rev": "r", "covers": [],
                  "tags": ["character-sheet"]},
        "旧版目录/index.json": {"count": 9, "items": [], "tags": ["character-sheet"]},
    },
}


class OssDirTagTests(unittest.TestCase):
    """目录标签是目录属性：标签不移动卡片，只按卡片位置出 token。"""

    def test_dir_tags_lowercase_dedupe(self):
        self.assertEqual(_oss._oss_dir_tags(_TAG_INDEX, "明朝人物"), ["character-sheet"])
        self.assertEqual(_oss._oss_dir_tags(_TAG_INDEX, "角色杂图"), [])
        self.assertEqual(_oss._oss_dir_tags(_TAG_INDEX, "没这个目录"), [])

    def test_tagged_dirs_skips_root_and_legacy_entries(self):
        self.assertEqual(_oss._oss_tagged_dirs(_TAG_INDEX, "character-sheet"),
                         ["明朝人物", "现代人物", "分镜标签"])
        self.assertEqual(_oss._oss_tagged_dirs(_TAG_INDEX, "Character-Sheet"),
                         ["明朝人物", "现代人物", "分镜标签"])
        self.assertEqual(_oss._oss_tagged_dirs(_TAG_INDEX, "voice"), ["未归类标签"])
        self.assertEqual(_oss._oss_tagged_dirs(_TAG_INDEX, "lora"), [])
        self.assertEqual(_oss._oss_tagged_dirs(_TAG_INDEX, ""), [])
        self.assertEqual(_oss._oss_tagged_dirs({}, "character-sheet"), [])

    def test_tag_tokens_use_the_cloud_presets_prefix(self):
        # 前端按 token 逐字匹配卡片位置，云端目录卡一律在 Cloud Presets 下
        self.assertEqual(_oss._oss_tagged_dir_tokens(_TAG_INDEX, _oss.OSS_TAG_CHARACTER_SHEET),
                         ["Cloud Presets/明朝人物", "Cloud Presets/现代人物",
                          "Cloud Presets/分镜标签"])

    def test_unlisted_tagged_dir_token_is_cloud_presets(self):
        self.assertEqual(_oss._oss_tagged_dir_tokens(_TAG_INDEX, "voice"),
                         ["Cloud Presets/未归类标签"])


_V2_INDEX = {
    "version": 2,
    "base_url": "http://127.0.0.1:1/neo/presets",
    "categories": {"StoryBoard": ["分镜目录"]},
    "directories": {
        "分镜目录": {
            "count": 2,
            "index": "分镜目录/index.json",
            "rev": "R1",
            "covers": [{"filename": "g.png", "thumbnail": "thumbnails/分镜目录/g.jpg"}],
        },
    },
}


class V2MasterIndexTests(unittest.TestCase):
    """v2 主索引只声明目录元数据：计数来自 count，封面来自 covers，items 进目录才拉。"""

    def setUp(self):
        self.cache_dir = _oss._get_oss_cache_dir()
        self.cache_file = self.cache_dir / "分镜目录" / "_index.json"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.cache_file.unlink(missing_ok=True)

    def _seed_cache(self, rev, items):
        self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        self.cache_file.write_text(json.dumps(
            {"version": 2, "name": "分镜目录", "generated_at": rev, "items": items},
            ensure_ascii=False), encoding="utf-8")

    def test_card_count_and_cover_come_from_master_entry(self):
        self.assertEqual(_oss._oss_dir_cards(_V2_INDEX), {"分镜目录": {"image_count": 2}})
        dirs = _oss._oss_directories_to_gallery_dirs(_V2_INDEX)
        self.assertEqual(dirs[0]["root_count"], 2)
        self.assertEqual(dirs[0]["items"], [])
        self.assertEqual(dirs[0]["path"], "Cloud Presets/分镜目录")
        covers = {}
        _oss._collect_oss_covers(covers, _V2_INDEX, "StoryBoard/presets")
        self.assertEqual(covers["StoryBoard/presets/分镜目录"][0]["filename"], "g.png")

    def test_dir_items_use_cached_dir_index_when_rev_matches(self):
        self._seed_cache("R1", [{"filename": "g.png", "type": "image", "mtime": 1, "txt_content": "全文"}])

        async def _go():
            return await _oss._oss_dir_items(_V2_INDEX, "分镜目录", "StoryBoard/presets")

        items = asyncio.run(_go())
        self.assertEqual(items[0]["txt_content"], "全文")
        self.assertEqual(items[0]["subfolder"], "StoryBoard/presets/分镜目录")

    def test_stale_dir_cache_is_not_served_as_current(self):
        # rev 变了就是目录重传过：旧缓存里的条目不能当现在的目录内容用
        self._seed_cache("OLD", [{"filename": "stale.png", "type": "image"}])

        async def _go():
            return await _oss._find_in_oss_index("g.png", "分镜目录")

        self.assertIsNone(asyncio.run(_go()))


class MainDirListingTests(unittest.TestCase):
    """固定首页卡（空目录也显示）+ 主目录里只读的 Cloud Presets 入口。"""

    @classmethod
    def setUpClass(cls):
        cls._prev_oss_enabled = gallery._is_oss_enabled
        cls._prev_load_index = gallery._load_oss_index_from_disk
        cls._prev_fetch_index = gallery._fetch_oss_index

        async def _index(*a, **k):
            return _CATEGORY_INDEX

        _write(GRID_DIR / "2026-09-24" / "shot.png")
        _write(CHARACTER_DIR / "2026-09-24" / "sheet.png")
        gallery._is_oss_enabled = lambda: True
        gallery._load_oss_index_from_disk = lambda: _CATEGORY_INDEX
        gallery._fetch_oss_index = _index

    @classmethod
    def tearDownClass(cls):
        gallery._is_oss_enabled = cls._prev_oss_enabled
        gallery._load_oss_index_from_disk = cls._prev_load_index
        gallery._fetch_oss_index = cls._prev_fetch_index

    def test_root_listing_injects_cloud_presets_card(self):
        out = _payload(_call(gallery.get_gallery_list(
            _GetRequest({"dir_name": "StoryBoard", "fields": "dirs"}))))
        resp_dir = out["directories"][0]
        self.assertEqual(resp_dir["name"], "StoryBoard")
        self.assertIn("2026-09-24", resp_dir["subdirs"])
        presets = resp_dir["subdirs"]["Cloud Presets"]
        self.assertEqual(presets["path"], "presets")
        self.assertTrue(presets["read_only"])
        self.assertEqual(presets["source"], "oss")
        # 本地 OSS 缓存目录本身不再作为普通子目录出现
        self.assertNotIn("presets", resp_dir["subdirs"])

    def test_presets_branch_lists_every_index_dir(self):
        out = _payload(_call(gallery.get_gallery_list(
            _GetRequest({"dir_name": "StoryBoard", "path": "presets"}))))
        resp_dir = out["directories"][0]
        self.assertTrue(resp_dir["read_only"])
        self.assertEqual(resp_dir["source"], "oss")
        self.assertEqual(resp_dir["name"], "StoryBoard/presets")
        # 主目录里的预设卡列索引里的全部目录：categories 不再挑目录
        self.assertEqual(sorted(resp_dir["subdirs"]),
                         sorted(["显式预设", "已分类分镜", "已分类角色", "未分类"]))

    def test_presets_branch_items_carry_navigable_subfolder(self):
        out = _payload(_call(gallery.get_gallery_list(
            _GetRequest({"dir_name": "CharacterSheet", "path": "presets/已分类角色"}))))
        items = out["directories"][0]["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["subfolder"], "CharacterSheet/presets/已分类角色")
        self.assertEqual(items[0]["source"], "oss")

    def test_deep_link_dir_name_with_sub_path(self):
        out = _payload(_call(gallery.get_gallery_list(
            _GetRequest({"dir_name": "StoryBoard/presets/已分类分镜"}))))
        items = out["directories"][0]["items"]
        self.assertEqual(items[0]["subfolder"], "StoryBoard/presets/已分类分镜")


class MainDirDeleteTests(unittest.TestCase):
    """主目录删除：生成结果可删，presets 预设缓存按只读拒绝。"""

    def _delete(self, **payload):
        return _call(gallery.delete_gallery_item(_PostRequest(payload)))

    def test_generated_result_is_deletable(self):
        target = _write(GRID_DIR / "2026-09-26" / "shot.png", b"png")
        _write(GRID_DIR / "2026-09-26" / "shot.txt", b"prompt")
        resp = self._delete(filename="shot.png", subfolder="2026-09-26")
        self.assertEqual(resp.status, 200)
        self.assertFalse(target.exists())
        self.assertFalse((GRID_DIR / "2026-09-26" / "shot.txt").exists())

    def test_prefixed_subfolder_also_resolves(self):
        target = _write(CHARACTER_DIR / "2026-09-27" / "sheet.png", b"png")
        resp = self._delete(filename="sheet.png", subfolder="CharacterSheet/2026-09-27")
        self.assertEqual(resp.status, 200)
        self.assertFalse(target.exists())

    def test_preset_cache_is_read_only(self):
        cached = _write(GRID_DIR / "presets" / "风格" / "a.png", b"png")
        resp = self._delete(filename="a.png", subfolder="StoryBoard/presets/风格")
        self.assertEqual(resp.status, 403)
        self.assertTrue(cached.exists())


class MainDirCoverTests(unittest.TestCase):
    """主目录每一层级都要给「当前目录 + 直接子目录」返回封面，子目录卡片才有缩略图。"""

    @classmethod
    def setUpClass(cls):
        cls._prev_oss_enabled = gallery._is_oss_enabled
        cls._prev_load_index = gallery._load_oss_index_from_disk
        cls._prev_fetch_index = gallery._fetch_oss_index

        async def _index(*a, **k):
            return _CATEGORY_INDEX

        # 封面现在按时间倒序取，显式给出 mtime 让断言稳定
        os.utime(_write(CHARACTER_DIR / "2026-09-24" / "sheet.png"), (2000, 2000))
        os.utime(_write(CHARACTER_DIR / "2026-09-25" / "pose.png"), (3000, 3000))
        os.utime(_write(CHARACTER_DIR / "2026-09-24" / "takes" / "take1.png"), (1000, 1000))
        # 本地 presets/ 目录存在过：它不能作为普通子目录出现，也不参与最近更新
        _write(GRID_DIR / "presets" / "已分类分镜" / "g.png")
        gallery._is_oss_enabled = lambda: True
        gallery._load_oss_index_from_disk = lambda: _CATEGORY_INDEX
        gallery._fetch_oss_index = _index

    @classmethod
    def tearDownClass(cls):
        gallery._is_oss_enabled = cls._prev_oss_enabled
        gallery._load_oss_index_from_disk = cls._prev_load_index
        gallery._fetch_oss_index = cls._prev_fetch_index

    def test_child_dir_cards_get_covers_keyed_by_nav_path(self):
        out = _payload(_call(gallery.get_gallery_list(
            _GetRequest({"dir_name": "CharacterSheet", "fields": "dirs,covers"}))))
        covers = out["covers"]
        # 卡片 key 与导航路径一致（前端 subdirKey = "CharacterSheet/<date>"）
        self.assertEqual([c["filename"] for c in covers["CharacterSheet/2026-09-24"]],
                         ["sheet.png", "take1.png"])  # 每个目录最多取 2 张，可下沉到子目录
        self.assertEqual(covers["CharacterSheet/2026-09-24"][0]["subfolder"], "CharacterSheet/2026-09-24")
        self.assertEqual(covers["CharacterSheet/2026-09-24"][1]["subfolder"], "CharacterSheet/2026-09-24/takes")
        self.assertEqual([c["filename"] for c in covers["CharacterSheet/2026-09-25"]], ["pose.png"])
        # 当前目录自身（首页卡）也有封面，供返回上级时复用
        self.assertIn("CharacterSheet", covers)

    def test_nested_level_covers_use_full_relative_path(self):
        out = _payload(_call(gallery.get_gallery_list(
            _GetRequest({"dir_name": "CharacterSheet", "path": "2026-09-24", "fields": "dirs,covers"}))))
        covers = out["covers"]
        self.assertEqual([c["filename"] for c in covers["CharacterSheet/2026-09-24/takes"]], ["take1.png"])
        self.assertEqual(covers["CharacterSheet/2026-09-24/takes"][0]["subfolder"],
                         "CharacterSheet/2026-09-24/takes")

    def test_aggregate_preset_card_borrows_a_cover(self):
        out = _payload(_call(gallery.get_gallery_list(
            _GetRequest({"dir_name": "StoryBoard", "fields": "dirs,covers"}))))
        covers = out["covers"]
        self.assertTrue(covers["StoryBoard/presets"])
        # 聚合预设卡借索引里第一个云端目录的封面（索引顺序就是卡片顺序）
        self.assertEqual(covers["StoryBoard/presets"], covers["StoryBoard/presets/显式预设"])


class RecentDirSortTests(unittest.TestCase):
    """插件自写目录（Output / Grid / Character）在目录内按最近更新排子目录；首页不再注入主目录卡。"""

    @classmethod
    def setUpClass(cls):
        cls._prev_oss_enabled = gallery._is_oss_enabled
        cls._prev_system_dirs = gallery._get_system_dirs
        cls._prev_custom_dirs = gallery._get_user_custom_dirs
        gallery._is_oss_enabled = lambda: False
        # 只认本用例自己的 output/input：同进程内其他测试文件会替换全局 folder_paths
        gallery._get_system_dirs = lambda: [
            {"path": Path(_OUTPUT), "name": "Output", "read_only": True},
            {"path": Path(_INPUT), "name": "Input", "read_only": True},
        ]
        gallery._get_user_custom_dirs = lambda: []

    @classmethod
    def tearDownClass(cls):
        gallery._is_oss_enabled = cls._prev_oss_enabled
        gallery._get_system_dirs = cls._prev_system_dirs
        gallery._get_user_custom_dirs = cls._prev_custom_dirs

    def setUp(self):
        # 每个用例从干净的三棵树开始；目录本身保留（插件启动时会确保它们存在）
        for base in (GRID_DIR, CHARACTER_DIR, Path(_OUTPUT)):
            base.mkdir(parents=True, exist_ok=True)
            for child in base.iterdir():
                shutil.rmtree(child) if child.is_dir() else child.unlink()

    @staticmethod
    def _touch(path, when):
        _write(path)
        os.utime(path, (when, when))
        return path

    def test_scan_recent_media_buckets_by_first_level_child(self):
        base = Path(_TMP) / "mt"
        if base.exists():
            shutil.rmtree(base)
        self._touch(base / "a" / "x.png", 1000)
        self._touch(base / "b" / "y.png", 2000)
        self._touch(base / "b" / "deep" / "z.png", 3000)
        self._touch(base / "top.png", 500)
        _write(base / "empty" / "note.txt")

        own, children = gallery._scan_recent_media(base, 2)

        self.assertEqual(own["mtime"], 500)
        self.assertEqual([c["rel"] for c in own["covers"]], [""])  # 根层文件
        self.assertEqual(children["a"]["mtime"], 1000)
        self.assertEqual(children["b"]["mtime"], 3000)  # 深层文件归到第一层子目录
        self.assertEqual([c["rel"] for c in children["b"]["covers"]], ["b/deep", "b"])
        self.assertEqual(children["empty"]["mtime"], 0.0)
        self.assertEqual(children["empty"]["covers"], [])

    def test_recent_covers_pick_the_newest_two(self):
        base = Path(_TMP) / "newest"
        if base.exists():
            shutil.rmtree(base)
        self._touch(base / "2026-09-20" / "old.png", 1000)
        self._touch(base / "2026-09-24" / "mid.png", 2000)
        self._touch(base / "2026-09-26" / "new.png", 3000)
        _write(base / "presets" / "风格" / "oss.png")  # 只读 OSS 缓存不算内容

        entries = gallery._recent_cover_entries(base, "Character", 2)
        self.assertEqual([e["filename"] for e in entries], ["new.png", "mid.png"])
        self.assertEqual([e["subfolder"] for e in entries],
                         ["Character/2026-09-26", "Character/2026-09-24"])
        self.assertEqual([e["name"] for e in entries], ["new", "mid"])
        # 无前缀时 subfolder 是该目录内的相对路径（系统目录的既有约定）
        self.assertEqual(gallery._recent_cover_entries(base, "", 1)[0]["subfolder"], "2026-09-26")

    def test_dir_covers_follow_recency_only_for_plugin_dirs(self):
        base = Path(_TMP) / "covers"
        if base.exists():
            shutil.rmtree(base)
        self._touch(base / "a" / "old.png", 1000)
        self._touch(base / "b" / "new.png", 3000)

        covers: dict = {}
        gallery._collect_all_dir_covers(covers, base, "Output", 2)
        self.assertEqual(sorted((c["filename"], c["subfolder"]) for c in covers["Output"]),
                         [("new.png", "b"), ("old.png", "a")])

        covers = {}
        gallery._collect_all_dir_covers(covers, base, "stars", 2)
        self.assertEqual(sorted(c["filename"] for c in covers["stars"]), ["new.png", "old.png"])

    def test_cover_kind_classification(self):
        self.assertEqual(gallery._cover_kind("a.png"), "image")
        self.assertEqual(gallery._cover_kind("B.JPG"), "image")
        self.assertEqual(gallery._cover_kind("c.mp4"), "video")
        self.assertEqual(gallery._cover_kind("d.mp3"), "audio")
        self.assertEqual(gallery._cover_kind("e.txt"), "other")

    def test_cover_kind_prefers_image_over_audio(self):
        base = Path(_TMP) / "cover_img_audio"
        if base.exists():
            shutil.rmtree(base)
        _write(base / "pic.png")
        _write(base / "song.mp3")

        covers: dict = {}
        gallery._collect_all_dir_covers(covers, base, "stars", 2)
        self.assertEqual([c["kind"] for c in covers["stars"]], ["image", "audio"])
        self.assertEqual(covers["stars"][0]["filename"], "pic.png")

    def test_cover_kind_prefers_video_over_audio(self):
        base = Path(_TMP) / "cover_vid_audio"
        if base.exists():
            shutil.rmtree(base)
        _write(base / "clip.mp4")
        _write(base / "song.mp3")

        covers: dict = {}
        gallery._collect_all_dir_covers(covers, base, "stars", 2)
        self.assertEqual([c["kind"] for c in covers["stars"]], ["video", "audio"])
        self.assertEqual(covers["stars"][0]["filename"], "clip.mp4")

    def test_audio_only_dir_yields_audio_kind_covers(self):
        base = Path(_TMP) / "cover_audio_only"
        if base.exists():
            shutil.rmtree(base)
        _write(base / "a.mp3")
        _write(base / "b.mp3")

        covers: dict = {}
        gallery._collect_all_dir_covers(covers, base, "stars", 2)
        self.assertTrue(covers["stars"])
        self.assertEqual([c["kind"] for c in covers["stars"]], ["audio", "audio"])

    def test_oss_covers_resolve_via_thumbnail_proxy(self):
        # 回归：OSS 索引的 thumbnail 是远端相对路径，不能当浏览器 URL 放进 url 字段，
        # 否则前端 <img> 直接 404 退化成文件夹图标；应走 /neo_gallery/thumbnail 代理。
        index = {
            "directories": {
                "26-06-25": {"items": [
                    {"filename": "a.jpg", "thumbnail": "thumbnails/26-06-25/a.jpg"},
                    {"filename": "b.mp4", "thumbnail": "thumbnails/26-06-25/b.jpg"},
                ]},
                "voice": {"items": [
                    {"filename": "song.mp3", "thumbnail": ""},
                ]},
            }
        }
        covers: dict = {}
        _oss._collect_oss_covers(covers, index)

        media = covers["Cloud Presets/26-06-25"]
        self.assertEqual(sorted((c["filename"], c["kind"]) for c in media),
                         [("a.jpg", "image"), ("b.mp4", "video")])
        for c in media:
            self.assertNotIn("url", c)
            self.assertEqual(c["subfolder"], "Cloud Presets/26-06-25")

        # 纯音频目录：kind=audio 封面，无需缩略图
        self.assertEqual([c["kind"] for c in covers["Cloud Presets/voice"]], ["audio"])

    def test_recent_cover_kind_beats_recency(self):
        base = Path(_TMP) / "cover_recent_mixed"
        if base.exists():
            shutil.rmtree(base)
        self._touch(base / "old" / "pic.png", 1000)
        self._touch(base / "new" / "song.mp3", 3000)

        entries = gallery._recent_cover_entries(base, "Character", 2)
        # image is preferred over the newer audio even though the audio is fresher
        self.assertEqual([e["kind"] for e in entries], ["image", "audio"])
        self.assertEqual(entries[0]["filename"], "pic.png")

    def test_recent_dir_whitelist(self):
        for name in ("Output", "output", "StoryBoard", "storyboard/2026-09-25", "CharacterSheet/2026-09-25"):
            self.assertTrue(gallery._is_recent_dir(name), name)
        for name in ("Input", "presets", "Lora", "stars", "civitai_bookmarks", ""):
            self.assertFalse(gallery._is_recent_dir(name), name)

    def test_level_listing_orders_recent_dir_by_update_time(self):
        base = Path(_TMP) / "level"
        if base.exists():
            shutil.rmtree(base)
        self._touch(base / "2026-09-20" / "old.png", 1000)
        self._touch(base / "2026-09-26" / "new.png", 3000)
        self._touch(base / "2026-09-24" / "mid.png", 2000)
        _write(base / "2026-09-22" / "note.txt")

        recent = gallery._process_single_directory(base, "Output", "", True, True, False, False)
        self.assertEqual(list(recent["subdirs"]), ["2026-09-26", "2026-09-24", "2026-09-20", "2026-09-22"])

        # 非白名单目录保持名称序（= 当前行为）
        other = gallery._process_single_directory(base, "stars", "", False, True, False, False)
        self.assertEqual(list(other["subdirs"]), ["2026-09-20", "2026-09-22", "2026-09-24", "2026-09-26"])

    def test_home_listing_has_no_main_dir_cards(self):
        self._touch(Path(_OUTPUT) / "character" / "sheet.png", 2000)
        self._touch(CHARACTER_DIR / "2026-09-25" / "newest.png", 3000)
        _write(GRID_DIR / "presets" / "风格" / "a.png")  # 只读缓存不算内容

        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"fields": "dirs"}))))
        names = [d["name"] for d in out["directories"]]

        # 首页不再注入 Grid / Character 卡；入口是生成对话框「直达」按钮、素材卡菜单与深链
        self.assertNotIn("Grid", names)
        self.assertNotIn("Character", names)
        self.assertEqual(names[:2], ["Output", "Input"])  # 系统目录：Output 在前


    def test_home_output_card_uses_the_newest_images_as_covers(self):
        self._touch(Path(_OUTPUT) / "character" / "old.png", 1000)
        self._touch(Path(_OUTPUT) / "grid" / "new.png", 3000)

        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"fields": "dirs,covers"}))))
        covers = out["covers"]

        # 系统目录（Output）卡封面取最新两张，subfolder 保持相对 output 的既有约定
        self.assertEqual(sorted((c["filename"], c["subfolder"]) for c in covers["Output"]),
                         [("new.png", "grid"), ("old.png", "character")])


class LoraSwitchListingTests(unittest.TestCase):
    """「启用 C 站 LORA」总开关关闭时，首页列表不出现任何 Lora 目录卡（已缓存的也不加载）。"""

    @classmethod
    def setUpClass(cls):
        cls._cache = Path(_TMP) / "lora_cache"
        _write(cls._cache / "krea2" / "example_00.png")
        cls._prev_cache_dir = gallery.LORA_CACHE_DIR
        cls._prev_oss_enabled = gallery._is_oss_enabled
        cls._prev_system_dirs = gallery._get_system_dirs
        cls._prev_custom_dirs = gallery._get_user_custom_dirs
        cls._prev_load_settings = gallery._load_settings
        gallery.LORA_CACHE_DIR = cls._cache
        gallery._is_oss_enabled = lambda: False
        gallery._get_system_dirs = lambda: [{"path": Path(_OUTPUT), "name": "Output", "read_only": True}]
        gallery._get_user_custom_dirs = lambda: []

    @classmethod
    def tearDownClass(cls):
        gallery.LORA_CACHE_DIR = cls._prev_cache_dir
        gallery._is_oss_enabled = cls._prev_oss_enabled
        gallery._get_system_dirs = cls._prev_system_dirs
        gallery._get_user_custom_dirs = cls._prev_custom_dirs
        gallery._load_settings = cls._prev_load_settings

    def _home_names(self, settings):
        gallery._load_settings = lambda: settings
        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"fields": "dirs"}))))
        return [d["name"] for d in out["directories"]]

    def test_switch_off_hides_cached_lora_dirs(self):
        names = self._home_names({"civitai_lora_enabled": False})
        self.assertEqual([n for n in names if n.startswith("Lora")], [])

    def test_switch_on_shows_lora_root_card(self):
        names = self._home_names({"civitai_lora_enabled": True})
        self.assertIn("Lora", names)

    def test_switch_off_deep_link_returns_nothing(self):
        gallery._load_settings = lambda: {"civitai_lora_enabled": False}
        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"dir_name": "Lora"}))))
        self.assertEqual(out["directories"], [])


class HomeOrderListingTests(unittest.TestCase):
    """首页顺序表：内置板块（Output/Input/Lora）与自定义目录按同一张表排序，隐藏项不列出。"""

    @classmethod
    def setUpClass(cls):
        cls._cache = Path(_TMP) / "order_lora_cache"
        _write(cls._cache / "krea2" / "example_00.png")
        cls._stars = Path(_TMP) / "stars"
        cls._beauty = Path(_TMP) / "beauty"
        for d in (cls._stars, cls._beauty):
            d.mkdir(parents=True, exist_ok=True)
        cls._prev_cache_dir = gallery.LORA_CACHE_DIR
        cls._prev_oss_enabled = gallery._is_oss_enabled
        cls._prev_system_dirs = gallery._get_system_dirs
        cls._prev_custom_dirs = gallery._get_user_custom_dirs
        cls._prev_load_settings = gallery._load_settings
        gallery.LORA_CACHE_DIR = cls._cache
        gallery._is_oss_enabled = lambda: False
        gallery._get_system_dirs = lambda: [
            {"path": Path(_OUTPUT), "name": "Output", "read_only": True},
            {"path": Path(_INPUT), "name": "Input", "read_only": True},
        ]
        gallery._get_user_custom_dirs = lambda: [cls._stars, cls._beauty]

    @classmethod
    def tearDownClass(cls):
        gallery.LORA_CACHE_DIR = cls._prev_cache_dir
        gallery._is_oss_enabled = cls._prev_oss_enabled
        gallery._get_system_dirs = cls._prev_system_dirs
        gallery._get_user_custom_dirs = cls._prev_custom_dirs
        gallery._load_settings = cls._prev_load_settings

    def _home_order(self, settings):
        gallery._load_settings = lambda: settings
        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"fields": "dirs"}))))
        keys = {"Output", "Input", "Lora", "stars", "beauty"}
        return [d["name"] for d in out["directories"] if d["name"] in keys]

    def test_default_order_puts_dirs_before_lora(self):
        settings = {"civitai_lora_enabled": True,
                    "custom_directories": [str(self._stars), str(self._beauty)]}
        self.assertEqual(self._home_order(settings),
                         ["Output", "Input", "stars", "beauty", "Lora"])

    def test_stored_order_moves_lora_first(self):
        settings = {"civitai_lora_enabled": True,
                    "custom_directories": [str(self._stars), str(self._beauty)],
                    "home_order": ["Lora", "Output", "Input", "local_bookmarks",
                                    "civitai_bookmarks", str(self._beauty), str(self._stars)]}
        self.assertEqual(self._home_order(settings),
                         ["Lora", "Output", "Input", "beauty", "stars"])

    def test_hidden_output_is_not_listed(self):
        settings = {"civitai_lora_enabled": True, "hidden_directories": ["Output"],
                    "custom_directories": [str(self._stars), str(self._beauty)]}
        self.assertEqual(self._home_order(settings),
                         ["Input", "stars", "beauty", "Lora"])

    def test_hidden_lora_is_not_listed(self):
        settings = {"civitai_lora_enabled": True, "hidden_directories": ["Lora"],
                    "custom_directories": [str(self._stars), str(self._beauty)]}
        self.assertEqual(self._home_order(settings),
                         ["Output", "Input", "stars", "beauty"])

    def test_hidden_output_deep_link_returns_nothing(self):
        gallery._load_settings = lambda: {"hidden_directories": ["Output"]}
        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"dir_name": "Output"}))))
        self.assertEqual(out["directories"], [])

    def _names(self, settings):
        gallery._load_settings = lambda: settings
        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"fields": "dirs"}))))
        return [d["name"] for d in out["directories"]]


class CloudPresetHideTests(unittest.TestCase):
    """云端预设目录逐卡隐藏：首页卡、板块子目录与深链都跟着首页隐藏开关走。"""

    @classmethod
    def setUpClass(cls):
        cls._prev_oss_enabled = gallery._is_oss_enabled
        cls._prev_load_index = gallery._load_oss_index_from_disk
        cls._prev_fetch_index = gallery._fetch_oss_index
        cls._prev_oss_fetch = _oss._fetch_oss_index
        cls._prev_save_settings = gallery._save_settings
        cls._prev_system_dirs = gallery._get_system_dirs
        cls._prev_custom_dirs = gallery._get_user_custom_dirs
        cls._prev_load_settings = gallery._load_settings
        gallery._is_oss_enabled = lambda: True
        gallery._load_oss_index_from_disk = lambda: _CATEGORY_INDEX

        # gallery_oss 里的深链处理走模块自己的取索引函数，桩掉它才不会真去拉云端索引。
        async def _index(force=False):
            return _CATEGORY_INDEX
        gallery._fetch_oss_index = _index
        _oss._fetch_oss_index = _index
        gallery._get_system_dirs = lambda: [
            {"path": Path(_OUTPUT), "name": "Output", "read_only": True},
            {"path": Path(_INPUT), "name": "Input", "read_only": True},
        ]
        gallery._get_user_custom_dirs = lambda: []

    @classmethod
    def tearDownClass(cls):
        gallery._is_oss_enabled = cls._prev_oss_enabled
        gallery._load_oss_index_from_disk = cls._prev_load_index
        gallery._fetch_oss_index = cls._prev_fetch_index
        _oss._fetch_oss_index = cls._prev_oss_fetch
        gallery._save_settings = cls._prev_save_settings
        gallery._get_system_dirs = cls._prev_system_dirs
        gallery._get_user_custom_dirs = cls._prev_custom_dirs
        gallery._load_settings = cls._prev_load_settings

    def _names(self, settings):
        gallery._load_settings = lambda: settings
        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"fields": "dirs"}))))
        return [d["name"] for d in out["directories"]]

    def test_cloud_preset_card_hides_with_the_home_entry_switch(self):
        base = {"civitai_lora_enabled": False}
        self.assertIn("显式预设", self._names(base))
        self.assertNotIn("显式预设", self._names({**base, "hidden_directories": ["Cloud Presets/显式预设"]}))

    def test_cloud_presets_section_skips_hidden_dirs(self):
        gallery._load_settings = lambda: {"hidden_directories": ["Cloud Presets/显式预设"]}
        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"dir_name": "Cloud Presets"}))))
        subdirs = out["directories"][0]["subdirs"]
        self.assertNotIn("显式预设", subdirs)
        self.assertIn("未分类", subdirs)

    def test_hidden_cloud_preset_deep_link_returns_nothing(self):
        gallery._load_settings = lambda: {"hidden_directories": ["Cloud Presets/显式预设"]}
        out = _payload(_call(gallery.get_gallery_list(_GetRequest({"dir_name": "Cloud Presets/显式预设"}))))
        self.assertEqual(out["directories"], [])

    def test_home_order_carries_cloud_preset_tokens(self):
        gallery._load_settings = lambda: {"home_order": ["Output"]}
        order = gallery._get_home_order()
        self.assertIn("Cloud Presets/显式预设", order)
        self.assertIn("Cloud Presets/未分类", order)

    def _save(self, payload):
        saved = {}
        gallery._load_settings = lambda: {"custom_directories": []}
        gallery._save_settings = lambda s: saved.update(s)
        _call(gallery.save_gallery_settings(_PostRequest(payload)))
        return saved

    def test_hidden_switch_persists_a_cloud_preset_token(self):
        saved = self._save({"action": "set_hidden", "path": "Cloud Presets/显式预设", "hidden": True})
        self.assertEqual(saved.get("hidden_directories"), ["Cloud Presets/显式预设"])

    def test_reorder_keeps_cloud_preset_tokens_in_order(self):
        saved = self._save({"action": "reorder",
                            "paths": ["Cloud Presets/未分类", "Output", "Cloud Presets/显式预设"]})
        self.assertEqual([t for t in saved.get("home_order", []) if t.startswith("Cloud Presets/")],
                         ["Cloud Presets/未分类", "Cloud Presets/显式预设"])
