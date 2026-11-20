# SPDX-License-Identifier: Apache-2.0
"""Tests for the cloud prompt mirror in studio/gallery_oss.py (sync_prompt_mirror).

The prompt library's cards are .txt files under prompts/presets/. Refreshing only the index caches
leaves that file set untouched: a row published in the cloud never shows up and a row the cloud
dropped keeps its card - "refreshed, count unchanged, the stale card is still there". The mirror
closes that gap for the directories tagged prompts, and only for them.
"""

import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

import plugin_paths

REPO_ROOT = Path(__file__).resolve().parents[2]
STUDIO_DIR = REPO_ROOT / "studio"
sys.path.insert(0, str(STUDIO_DIR))

PKG = "_neo_oss_mirror_pkg"
_pkg = types.ModuleType(PKG)
_pkg.__path__ = [str(STUDIO_DIR)]
sys.modules[PKG] = _pkg
_util = types.ModuleType(PKG + ".util")
_util.IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
_util.VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
_util.AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}
sys.modules[PKG + ".util"] = _util
_paths = types.ModuleType(PKG + ".plugin_paths")
_paths.__dict__.update({n: getattr(plugin_paths, n) for n in dir(plugin_paths)})
sys.modules[PKG + ".plugin_paths"] = _paths

_spec = importlib.util.spec_from_file_location(PKG + ".gallery_oss", STUDIO_DIR / "gallery_oss.py")
gallery_oss = importlib.util.module_from_spec(_spec)
sys.modules[gallery_oss.__name__] = gallery_oss
_spec.loader.exec_module(gallery_oss)

CLOUD_DIR = "prompts.chat"
SHEET_DIR = "明朝人物"
REV = "2026-11-20T00:00:00Z"
STALE_REV = "2026-10-17T00:00:00Z"
BASE_URL = "https://oss.example/neo/presets"
OSS_CONFIG = {
    "enabled": True,
    "index_url": f"{BASE_URL}/index.json",
    "base_url": BASE_URL,
    "sync_interval_hours": 24,
    "cache_dir": "",
}
MASTER_INDEX = {
    "version": 2,
    "generated_at": REV,
    "directories": {
        CLOUD_DIR: {"count": 3, "tags": ["prompts"],
                    "index": f"{CLOUD_DIR}/index.json", "rev": REV},
        SHEET_DIR: {"count": 1, "tags": ["character-sheet"],
                    "index": f"{SHEET_DIR}/index.json", "rev": REV},
    },
}
# 云端当前那一份目录索引：两条新条 + 一条镜像里已按标题前截落好的条
CLOUD_ITEMS = [
    {"filename": "01_Foo.jpg", "type": "image",
     "txt_content": "标题：Foo Portrait\n提示词：foo body first line",
     "thumbnail": f"thumbnails/{CLOUD_DIR}/01_Foo.jpg"},
    {"filename": "02_Bar.mp4", "type": "video",
     "txt_content": "标题：Bar Scene\n提示词：bar body first line",
     "preview": f"previews/{CLOUD_DIR}/02_Bar.mp4",
     "thumbnail": f"thumbnails/{CLOUD_DIR}/02_Bar.jpg"},
    {"filename": "03_Ancient.mp4", "type": "video",
     "txt_content": "标题：Ancient Egyptians Casually Use Modern Tech: Six-Vignette Comedy "
                    "Montage (20s Video)\n提示词：20 seconds, horizontal 16:9.",
     "thumbnail": f"thumbnails/{CLOUD_DIR}/03_Ancient.jpg"},
]
# 发布时出的那张缩略图：卡片图位与视频预览都要一张封面 sidecar 才起得来
THUMB_BYTES = "FAKE-JPEG"
THUMBS = {f"{BASE_URL}/{item['thumbnail']}": THUMB_BYTES
          for item in CLOUD_ITEMS if item.get("thumbnail")}
SIDECARS = {
    f"{BASE_URL}/{CLOUD_DIR}/01_Foo.txt": (
        "标题：Foo Portrait\n提示词：foo body first line\nsecond body line\n\n"
        "说明：一句说明\n标签：cinematic, portrait\n来源：https://prompts.chat/p/1（提示词正文 CC0 1.0）\n"),
    f"{BASE_URL}/{CLOUD_DIR}/02_Bar.txt": (
        "标题：Bar Scene\n提示词：bar body first line\n\n"
        "标签：video\n来源：https://prompts.chat/p/2（提示词正文 CC0 1.0）\n"),
    f"{BASE_URL}/{CLOUD_DIR}/03_Ancient.txt": "标题：Ancient\n提示词：body\n",
}
# 镜像里已落好的两个名字：一个是标题前截（同一条），一个是云端删掉的那条 JSON 卡
LEGACY_KEPT = "Ancient Egyptians Casually Use Modern Tech Six-V"
LEGACY_STALE = "image to video 360 product rotaion"
OTHER_PRESET_DIR = "精美图像提示词"
# 同一条在两边各有一个名字：池里的名字取旁车标题，索引预览掐在正文里没有 `标题：` 行；
# 发布器换过截法留下的老名字是池里 "Cat" 对云端标题 "Dog fun"。正文两边同源，长度要过比正文的下限。
DRIFT_TITLE = "印象派油画风格"
DRIFT_BODY = "印象派油画风格，笔触堆叠的厚涂肌理，灰蓝色调的天光与暖色反光互相透进对方，" * 6
DOG_BODY = "柴犬戴着毛线帽坐在咖啡馆窗边，木质桌面的反光与奶白的晨光，" * 6
# 整名相等那一路的样本：标题 "Cat" 短过比前缀的下限，正文 78 个字符短过比正文的下限
SHORT_TITLE_ROW = {"filename": "11_Cat.mp4", "txt": "11_Cat.txt", "type": "image",
                   "thumbnail": "26-06-26/11_Cat.jpg",
                   "txt_content": "标题：Cat\n提示词：" + DRIFT_BODY[:78]}
DRIFT_ROWS = [
    {"filename": "27_Cat.jpg", "txt": "27_Cat.txt", "type": "image",
     "thumbnail": "26-06-26/27_Cat.jpg", "txt_content": "提示词：" + DRIFT_BODY[:220]},
    {"filename": "04_Dogfun.mp4", "txt": "04_Dogfun.txt", "type": "image",
     "thumbnail": "26-06-26/04_Dogfun.jpg", "txt_content": f"标题：Dog fun\n提示词：{DOG_BODY[:220]}"},
]


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _Resp:
    def __init__(self, payload: str, status: int = 200):
        self._payload = payload.encode("utf-8")
        self.status = status

    async def read(self) -> bytes:
        return self._payload


class _Ctx:
    def __init__(self, value):
        self._value = value

    async def __aenter__(self):
        return self._value

    async def __aexit__(self, *exc):
        return False


class _Session:
    def __init__(self, owner):
        self._owner = owner

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def get(self, url, timeout=None):
        self._owner.requested.append(url)
        payload, status = self._owner.by_url.get(url, (self._owner.payload, self._owner.status))
        return _Ctx(_Resp(payload, status))


class FakeAiohttp:
    """Assumed OSS endpoint: every URL answers from by_url, so a sidecar can fail on its own."""

    def __init__(self, payload: str, status: int = 200, by_url: dict | None = None):
        self.payload = payload
        self.status = status
        self.by_url = by_url or {}
        self.requested = []

    def ClientSession(self):
        return _Session(self)

    def ClientTimeout(self, **kwargs):
        return None


class MirrorSandbox:
    """临时数据根 + 假 OSS：预设池落在临时目录里，云端索引与旁车都从 by_url 答。"""

    def setUp(self):
        self._tmp_dir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp_dir.name)
        (self.tmp / "configs").mkdir()
        (self.tmp / "gallery" / "oss_cache").mkdir(parents=True)
        with open(self.tmp / "configs" / "oss_presets.json", "w", encoding="utf-8") as f:
            json.dump(OSS_CONFIG, f, ensure_ascii=False)
        self._saved = (gallery_oss.CONFIGS_DIR, gallery_oss.OSS_CACHE_DIR,
                       gallery_oss.OSS_INDEX_CACHE_FILE, gallery_oss.PRESETS_DIR,
                       gallery_oss.PRESETS_TAGS_FILE, gallery_oss._oss_index_cache,
                       gallery_oss._oss_index_fetch_time, gallery_oss.aiohttp)
        gallery_oss.CONFIGS_DIR = self.tmp / "configs"
        gallery_oss.OSS_CACHE_DIR = self.tmp / "gallery" / "oss_cache"
        gallery_oss.OSS_INDEX_CACHE_FILE = gallery_oss.OSS_CACHE_DIR / "_index.json"
        gallery_oss.PRESETS_DIR = self.tmp / "prompts" / "presets"
        gallery_oss.PRESETS_TAGS_FILE = gallery_oss.PRESETS_DIR / "_tags_index.json"
        gallery_oss._oss_index_cache = None
        gallery_oss._oss_index_fetch_time = 0.0
        gallery_oss.PRESETS_DIR.mkdir(parents=True)

    def tearDown(self):
        (gallery_oss.CONFIGS_DIR, gallery_oss.OSS_CACHE_DIR, gallery_oss.OSS_INDEX_CACHE_FILE,
         gallery_oss.PRESETS_DIR, gallery_oss.PRESETS_TAGS_FILE, gallery_oss._oss_index_cache,
         gallery_oss._oss_index_fetch_time, gallery_oss.aiohttp) = self._saved
        self._tmp_dir.cleanup()

    def _server(self, index: dict, items: dict | None = None, dir_status: int = 200):
        """主索引 URL 答 index，目录索引与旁车 URL 答 by_url；dir_status 让目录索引那一发单独失败。"""
        by_url = {}
        for dir_name, payload in (items or {}).items():
            by_url[f"{BASE_URL}/{dir_name}/index.json"] = (json.dumps(payload, ensure_ascii=False), dir_status)
        for url, text in SIDECARS.items():
            by_url[url] = (text, 200)
        for url, blob in THUMBS.items():
            by_url[url] = (blob, 200)
        gallery_oss.aiohttp = FakeAiohttp(json.dumps(index, ensure_ascii=False), by_url=by_url)
        return gallery_oss.aiohttp

    def _dir_cache(self, dir_name: str, generated_at: str, items: list[dict]) -> Path:
        target_dir = gallery_oss.OSS_CACHE_DIR / dir_name
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / "_index.json"
        path.write_text(json.dumps({"version": 2, "name": dir_name,
                                   "generated_at": generated_at, "items": items}, ensure_ascii=False),
                        encoding="utf-8")
        return path

    def _mirror_file(self, pool: str, name: str, body: str = "旧正文\n") -> Path:
        """pool: "image" 进 presets/<目录>/，"video" 进 presets/video/<目录>/"""
        folder = gallery_oss.PRESETS_DIR / ("video" if pool == "video" else "") / CLOUD_DIR
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{name}.txt"
        path.write_text(body, encoding="utf-8")
        return path

    def _tags(self, index: dict) -> None:
        gallery_oss.PRESETS_TAGS_FILE.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")

    def _read_tags(self) -> dict:
        return json.loads(gallery_oss.PRESETS_TAGS_FILE.read_text(encoding="utf-8"))

    def _pool_files(self, pool: str) -> list[str]:
        folder = gallery_oss.PRESETS_DIR / ("video" if pool == "video" else "") / CLOUD_DIR
        return sorted(p.name[:-4] for p in folder.glob("*.txt")) if folder.is_dir() else []

    def _pool_covers(self, pool: str) -> list[str]:
        folder = gallery_oss.PRESETS_DIR / ("video" if pool == "video" else "") / CLOUD_DIR
        return sorted(p.name for p in folder.glob("*.jpg")) if folder.is_dir() else []

    @staticmethod
    def _payload(response) -> dict:
        return json.loads(response.body.decode("utf-8"))

    def _cloud_server(self, dir_status: int = 200):
        """云端当前那一发：目录索引答 CLOUD_ITEMS，三条旁车答 SIDECARS（dir_status 让目录索引单独失败）"""
        self._server(MASTER_INDEX, {CLOUD_DIR: {"version": 2, "name": CLOUD_DIR,
                                                "generated_at": REV, "items": CLOUD_ITEMS}},
                     dir_status=dir_status)

    def _sync(self):
        return _run(gallery_oss.sync_prompt_mirror(MASTER_INDEX))


class MirrorImportsAndPrunes(MirrorSandbox, unittest.TestCase):
    """云端提示词目录 → 提示词池：缺的补进来，云端删掉的那条一并收掉。"""

    def test_missing_rows_land_in_both_pools_as_their_own_bodies(self):
        self._cloud_server()
        result = self._sync()
        self.assertEqual((result["imported"], result["pruned"]), (3, 0))
        self.assertEqual(self._pool_files("image"), ["Foo Portrait"])
        self.assertEqual(self._pool_files("video"), ["Ancient", "Bar Scene"])
        body = (gallery_oss.PRESETS_DIR / CLOUD_DIR / "Foo Portrait.txt").read_text(encoding="utf-8")
        self.assertIn("second body line", body)
        # 说明 / 标签 / 来源 那几行是发布器记的来路：进正文的话「填入绘画页」会把它一起贴进提示词框
        self.assertNotIn("来源：", body)
        self.assertNotIn("标签：", body)

    def test_imported_rows_carry_the_cloud_tags_into_the_tags_index(self):
        self._cloud_server()
        self._tags({f"video/{CLOUD_DIR}/{LEGACY_STALE}": ["JSON"]})
        self._sync()
        tags = self._read_tags()
        self.assertEqual(tags[f"{CLOUD_DIR}/Foo Portrait"], ["cinematic", "portrait"])
        self.assertEqual(tags[f"video/{CLOUD_DIR}/Bar Scene"], ["video"])

    def test_cloud_dropped_row_is_pruned_with_its_tag_key(self):
        self._cloud_server()
        stale = self._mirror_file("video", LEGACY_STALE)
        self._tags({f"video/{CLOUD_DIR}/{LEGACY_STALE}": ["JSON"], f"{OTHER_PRESET_DIR}/keep": ["keep"]})
        other = gallery_oss.PRESETS_DIR / OTHER_PRESET_DIR
        other.mkdir()
        kept = other / "keep.txt"
        kept.write_text("出厂预设正文\n", encoding="utf-8")
        result = self._sync()
        self.assertEqual(result["pruned"], 1)
        self.assertFalse(stale.exists(), "云端删掉的条要在这一发从池子里收掉")
        tags = self._read_tags()
        # 删掉的条连键一起收：留着键，筛子的标签计数就数到一张不存在的卡上
        self.assertNotIn(f"video/{CLOUD_DIR}/{LEGACY_STALE}", tags)
        self.assertEqual(tags[f"{OTHER_PRESET_DIR}/keep"], ["keep"], "镜像只动它自己那批键")
        self.assertEqual(tags[f"{CLOUD_DIR}/Foo Portrait"], ["cinematic", "portrait"])
        self.assertTrue(kept.exists(), "出厂预设池不碰")

    def test_legacy_truncated_name_is_the_same_prompt(self):
        """镜像里那批名字是标题前截落的（发布器换过截法），认不得它们就重下一遍、池里两张卡"""
        self._cloud_server()
        legacy = self._mirror_file("video", LEGACY_KEPT)
        result = self._sync()
        self.assertEqual((result["imported"], result["pruned"]), (2, 0))
        self.assertTrue(legacy.exists())
        self.assertEqual(len(self._pool_files("video")), 2)
        self.assertNotIn("Ancient Egyptians Casually Use Modern Tech Six-V (2)", self._pool_files("video"))

    def test_short_names_are_not_a_match_basis(self):
        self.assertFalse(gallery_oss._mirror_is_same("Mine", "Mini Game"))
        self.assertTrue(gallery_oss._mirror_is_same("Underwater Veo 3 video", "Underwater Veo 3 video"))

    def test_sidecar_that_does_not_arrive_leaves_the_pool_alone(self):
        self._cloud_server()
        for url in list(gallery_oss.aiohttp.by_url):
            if url.endswith(".txt"):
                gallery_oss.aiohttp.by_url[url] = (gallery_oss.aiohttp.by_url[url][0], 404)
        result = self._sync()
        self.assertEqual((result["imported"], result["pruned"]), (0, 0))
        self.assertEqual(self._pool_files("image"), [])



class MirrorPairsTheSameRowAcrossNames(MirrorSandbox, unittest.TestCase):
    """云端还在发的条被剪掉、下一发又当缺的补回来：每一刷都在换名字，提示词库条数来回跳。"""

    def _drift_server(self):
        server = self._server(MASTER_INDEX, {CLOUD_DIR: {"version": 2, "name": CLOUD_DIR,
                                                        "generated_at": REV, "items": DRIFT_ROWS}})
        server.by_url[f"{BASE_URL}/26-06-26/27_Cat.jpg"] = (THUMB_BYTES, 200)
        server.by_url[f"{BASE_URL}/26-06-26/04_Dogfun.jpg"] = (THUMB_BYTES, 200)
        return server

    def _plant(self) -> list[Path]:
        """两条卡都是按旁车标题与发布器老截法落的：名字与索引预览给出的标题都对不上"""
        return [self._mirror_file("image", DRIFT_TITLE, body=DRIFT_BODY + "\n"),
                self._mirror_file("image", "Cat", body=DOG_BODY + "\n")]

    def test_a_short_body_under_the_pairing_floor_pairs_by_its_exact_name(self):
        """标题 "Cat" 短过比前缀的下限、正文 78 字短过比正文的下限：整名相等没有歧义"""
        self._server(MASTER_INDEX, {CLOUD_DIR: {"version": 2, "name": CLOUD_DIR,
                                                "generated_at": REV, "items": [SHORT_TITLE_ROW]}})
        card = self._mirror_file("image", "Cat", body=DRIFT_BODY[:78] + "\n")
        result = self._sync()
        self.assertEqual((result["imported"], result["pruned"]), (0, 0))
        self.assertTrue(card.exists(), "短名不拿前缀认条，也不拿它删条")

    def test_two_names_for_the_same_rows_stay_put(self):
        """预览掐掉了 `标题：` 那一行就只能报文件名 stem，池里名字取旁车标题——比标题就判成云端删掉了"""
        self._drift_server()
        cards = self._plant()
        result = self._sync()
        self.assertEqual((result["imported"], result["pruned"]), (0, 0))
        for card in cards:
            self.assertTrue(card.exists(), "剪掉一发、补回一发，同一句提示词的卡在刷新之间不见一次")

    def test_a_card_the_cloud_stopped_publishing_is_still_pruned(self):
        self._drift_server()
        self._plant()
        gone = self._mirror_file("image", "云端已下架的那条", body="云端再也没有的正文" * 20 + "\n")
        result = self._sync()
        self.assertEqual(result["pruned"], 1)
        self.assertFalse(gone.exists(), "正文比不拢才是云端删掉的条：加了正文这一路，剪枝那一刀不能钝掉")

    def test_cards_without_a_cover_get_their_row_by_the_body(self):
        """图位补齐走同一份配对：名字比不拢的条补不到封面，卡片就只剩文字位"""
        self._drift_server()
        cards = self._plant()
        result = self._sync()
        self.assertEqual((result["imported"], result["covers"]), (0, 2))
        for card in cards:
            self.assertTrue(card.with_name(card.name[:-4] + ".jpg").exists())


class MirrorPruneWaitsForCurrentRev(MirrorSandbox, unittest.TestCase):
    """目录索引没刷到主索引当前 rev 时不删：拿旧那一叠当依据删条目，一次断网清掉整池。"""

    def _stale_cache(self):
        self._dir_cache(CLOUD_DIR, STALE_REV,
                        [{"filename": "01_Foo.jpg", "type": "image",
                          "txt_content": "标题：Foo Portrait\n提示词：foo body first line"}])
        self._cloud_server(dir_status=502)

    def test_prune_waits_when_the_dir_index_fetch_fails(self):
        self._stale_cache()
        kept = self._mirror_file("video", LEGACY_STALE)
        result = self._sync()
        self.assertEqual(result["pruned"], 0)
        self.assertTrue(kept.exists(), "拉失败退回旧缓存，旧那一叠不能当删条目的依据")

    def test_import_still_lands_from_the_cached_rows(self):
        """界面显示的也是旧那一叠：补条按旧缓存走，卡不会空着"""
        self._stale_cache()
        result = self._sync()
        self.assertEqual(result["imported"], 1)
        self.assertEqual(self._pool_files("image"), ["Foo Portrait"])


class MirrorCovers(MirrorSandbox, unittest.TestCase):
    """卡片那格图位：正文旁边没有封面 sidecar 的条在界面上只剩文字，视频那条连预览都不播。"""

    def test_a_new_row_lands_with_the_cover_that_fills_its_media_tile(self):
        self._cloud_server()
        result = self._sync()
        self.assertEqual(result["covers"], 3)
        self.assertEqual(self._pool_covers("image"), ["Foo Portrait.jpg"])
        self.assertEqual(self._pool_covers("video"), ["Ancient.jpg", "Bar Scene.jpg"])
        cover = gallery_oss.PRESETS_DIR / "video" / CLOUD_DIR / "Bar Scene.jpg"
        self.assertEqual(cover.read_bytes(), THUMB_BYTES.encode("utf-8"))

    def test_a_card_without_a_cover_gets_one_without_reimporting_the_body(self):
        self._cloud_server()
        kept = self._mirror_file("video", LEGACY_KEPT, body="我自己改过的正文\n")
        result = self._sync()
        # 云端三条里两条池子没有（一起补进来），池里那条只补图
        self.assertEqual((result["imported"], result["covers"]), (2, 3))
        self.assertEqual(kept.read_text(encoding="utf-8"), "我自己改过的正文\n", "补图不覆正文")
        self.assertTrue((kept.parent / (LEGACY_KEPT + ".jpg")).exists())
        self.assertEqual(self._pool_files("video"), [LEGACY_KEPT, "Bar Scene"])

    def test_prune_takes_the_cover_with_the_card(self):
        self._cloud_server()
        stale = self._mirror_file("video", LEGACY_STALE)
        cover = stale.with_name(stale.name[:-4] + ".jpg")
        cover.write_bytes(b"x")
        result = self._sync()
        self.assertEqual(result["pruned"], 1)
        self.assertFalse(stale.exists())
        self.assertFalse(cover.exists(), "正文收了，图位留着就是池子里的一张孤图")

    def test_a_row_published_without_a_thumbnail_still_imports_as_a_text_card(self):
        bare = [{"filename": item["filename"], "type": item["type"],
                 "txt_content": item["txt_content"]} for item in CLOUD_ITEMS]
        self._server(MASTER_INDEX, {CLOUD_DIR: {"version": 2, "name": CLOUD_DIR,
                                                "generated_at": REV, "items": bare}})
        result = self._sync()
        self.assertEqual((result["imported"], result["covers"]), (3, 0))
        self.assertEqual(self._pool_covers("video"), [])


class MirrorOnlyTaggedDirs(MirrorSandbox, unittest.TestCase):
    """只有带 prompts 标签的目录是镜像源：角色卡目录是素材，不是提示词。"""

    def test_character_sheet_directory_is_not_mirrored(self):
        self._server(MASTER_INDEX, {
            CLOUD_DIR: {"version": 2, "name": CLOUD_DIR, "generated_at": REV, "items": CLOUD_ITEMS},
            SHEET_DIR: {"version": 2, "name": SHEET_DIR, "generated_at": REV,
                        "items": [{"filename": "001_逆命剑胚.png", "type": "image",
                                   "txt_content": "标题：逆命剑胚\n提示词：body"}]},
        })
        result = _run(gallery_oss.sync_prompt_mirror(MASTER_INDEX))
        self.assertEqual(result["directories"], 1)
        self.assertFalse((gallery_oss.PRESETS_DIR / SHEET_DIR).exists())

    def test_sync_route_reports_the_mirror_step(self):
        self._server(MASTER_INDEX, {CLOUD_DIR: {"version": 2, "name": CLOUD_DIR,
                                                "generated_at": REV, "items": CLOUD_ITEMS}})
        self._mirror_file("video", LEGACY_STALE)
        payload = self._payload(_run(gallery_oss.sync_oss_index(None)))
        self.assertTrue(payload["success"])
        self.assertEqual(payload["mirror"]["imported"], 3)
        self.assertEqual(payload["mirror"]["pruned"], 1)


if __name__ == "__main__":
    unittest.main()

