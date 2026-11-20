# SPDX-License-Identifier: Apache-2.0
"""Tests for the cloud preset index cache age in studio/gallery_oss.py.

The age of the master index on disk decides whether the card list refetches it. Measured from
the load moment, a cache published days ago counts as just fetched at every startup, so a card
published in the cloud stays hidden for the whole sync interval no matter how often the app restarts.
"""

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

import plugin_paths

REPO_ROOT = Path(__file__).resolve().parents[2]
STUDIO_DIR = REPO_ROOT / "studio"
sys.path.insert(0, str(STUDIO_DIR))

PKG = "_neo_oss_index_pkg"
_pkg = types.ModuleType(PKG)
_pkg.__path__ = [str(STUDIO_DIR)]
sys.modules[PKG] = _pkg
_util = types.ModuleType(PKG + ".util")
_util.IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
_util.VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
_util.AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}
sys.modules[PKG + ".util"] = _util
_oss_paths = types.ModuleType(PKG + ".plugin_paths")
_oss_paths.__dict__.update({n: getattr(plugin_paths, n) for n in dir(plugin_paths)})
sys.modules[PKG + ".plugin_paths"] = _oss_paths

_spec = importlib.util.spec_from_file_location(PKG + ".gallery_oss", STUDIO_DIR / "gallery_oss.py")
gallery_oss = importlib.util.module_from_spec(_spec)
sys.modules[gallery_oss.__name__] = gallery_oss
_spec.loader.exec_module(gallery_oss)

DAY_SECONDS = 86400
# 云端今天发布的索引：比本地缓存多一张 prompts.chat 卡。
FRESH_INDEX = {
    "version": 1,
    "generated_at": "2026-11-19T00:00:00Z",
    "directories": {
        "明朝人物": {"count": 200, "tags": ["character-sheet"]},
        "prompts.chat": {"count": 20, "tags": ["prompts"]},
    },
}
# 本地缓存里那份旧索引：发布 prompts.chat 之前生成的。
STALE_INDEX = {
    "version": 1,
    "generated_at": "2026-10-17T00:00:00Z",
    "directories": {"明朝人物": {"count": 200}},
}
OSS_CONFIG = {
    "enabled": True,
    "index_url": "https://oss.example/neo/presets/index.json",
    "base_url": "https://oss.example/neo/presets",
    "sync_interval_hours": 24,
    "cache_dir": "",
}
CLOUD_DIR = "prompts.chat"
DIR_INDEX_URL = OSS_CONFIG["base_url"] + "/" + CLOUD_DIR + "/index.json"
# 主索引条目：发布器现在的形状（目录索引 URL + 当前 rev）
INDEX_WITH_REV = {
    "version": 1,
    "generated_at": "2026-11-19T00:00:00Z",
    "directories": {
        CLOUD_DIR: {"count": 2, "tags": ["prompts"],
                    "index": CLOUD_DIR + "/index.json", "rev": "2026-11-19T00:00:00Z"},
    },
}
# 云端当前那份目录索引：两条带媒体的条目（一条带预览）
FRESH_DIR_INDEX = {
    "version": 1,
    "generated_at": "2026-11-19T00:00:00Z",
    "items": [
        {"filename": "01.jpg", "subfolder": CLOUD_DIR, "type": "image", "media_url": "01.jpg"},
        {"filename": "02.mp4", "subfolder": CLOUD_DIR, "type": "video", "media_url": "02.mp4",
         "preview": {"filename": "02.preview.mp4", "subfolder": CLOUD_DIR, "type": "preview"}},
    ],
}
# 本地 oss_cache 里那份旧目录索引：停在上一版 rev，只有一条
STALE_DIR_INDEX = {
    "version": 1,
    "generated_at": "2026-10-17T00:00:00Z",
    "items": [{"filename": "old.jpg", "subfolder": CLOUD_DIR, "type": "image"}],
}


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
        return _Ctx(_Resp(self._owner.by_url.get(url, self._owner.payload), self._owner.status))


class FakeAiohttp:
    """Stands in for the OSS index endpoint: aiohttp.ClientSession().get(index_url) -> response."""

    def __init__(self, payload: str, status: int = 200, by_url: dict | None = None):
        self.payload = payload
        self.status = status
        self.by_url = by_url or {}
        self.requested = []

    def ClientSession(self):
        return _Session(self)

    def ClientTimeout(self, **kwargs):
        return None



class OssCacheSandbox:
    """临时数据根 + 假 OSS 端点：主索引缓存与逐目录索引缓存都落在临时目录，网络那一发由 FakeAiohttp 接走。"""

    def setUp(self):
        self._tmp_dir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp_dir.name)
        (self.tmp / "configs").mkdir()
        (self.tmp / "gallery" / "oss_cache").mkdir(parents=True)
        with open(self.tmp / "configs" / "oss_presets.json", "w", encoding="utf-8") as f:
            json.dump(OSS_CONFIG, f, ensure_ascii=False)
        self._saved = (gallery_oss.CONFIGS_DIR, gallery_oss.OSS_CACHE_DIR,
                       gallery_oss.OSS_INDEX_CACHE_FILE, gallery_oss._oss_index_cache,
                       gallery_oss._oss_index_fetch_time, gallery_oss.aiohttp,
                       gallery_oss.PRESETS_DIR, gallery_oss.PRESETS_TAGS_FILE)
        gallery_oss.CONFIGS_DIR = self.tmp / "configs"
        gallery_oss.OSS_CACHE_DIR = self.tmp / "gallery" / "oss_cache"
        gallery_oss.OSS_INDEX_CACHE_FILE = gallery_oss.OSS_CACHE_DIR / "_index.json"
        gallery_oss._oss_index_cache = None
        gallery_oss._oss_index_fetch_time = 0.0
        # 刷新那一发带着云端提示词镜像（sync_prompt_mirror）：预设池落点也进沙箱，用例不往共享临时根里写条
        gallery_oss.PRESETS_DIR = self.tmp / "prompts" / "presets"
        gallery_oss.PRESETS_TAGS_FILE = gallery_oss.PRESETS_DIR / "_tags_index.json"
        self.cache_file = gallery_oss.OSS_INDEX_CACHE_FILE

    def tearDown(self):
        (gallery_oss.CONFIGS_DIR, gallery_oss.OSS_CACHE_DIR, gallery_oss.OSS_INDEX_CACHE_FILE,
         gallery_oss._oss_index_cache, gallery_oss._oss_index_fetch_time,
         gallery_oss.aiohttp, gallery_oss.PRESETS_DIR, gallery_oss.PRESETS_TAGS_FILE) = self._saved
        self._tmp_dir.cleanup()

    def _write_cache(self, index: dict, age_seconds: float) -> float:
        with open(self.cache_file, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False)
        stamp = os.stat(self.cache_file).st_mtime - age_seconds
        os.utime(self.cache_file, (stamp, stamp))
        return os.stat(self.cache_file).st_mtime

    def _write_dir_cache(self, dir_name: str, payload: dict) -> Path:
        """逐目录索引的磁盘缓存 oss_cache/<dir>/_index.json —— 提示词库的云端配对读的就是这一份。"""
        target_dir = gallery_oss.OSS_CACHE_DIR / dir_name
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / "_index.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        return path

    def _mock_server(self, index: dict, dir_index: dict | None = None):
        """假 OSS 端点：主索引 URL 答 `index`，目录索引 URL 答 `dir_index`。"""
        by_url = {}
        if dir_index is not None:
            by_url[DIR_INDEX_URL] = json.dumps(dir_index, ensure_ascii=False)
        gallery_oss.aiohttp = FakeAiohttp(json.dumps(index, ensure_ascii=False), by_url=by_url)
        return gallery_oss.aiohttp

    @staticmethod
    def _payload(response) -> dict:
        return json.loads(response.body.decode("utf-8"))


class OssIndexCacheAge(OssCacheSandbox, unittest.TestCase):
    """A cache older than the sync interval must be refetched, not re-stamped at load."""

    def test_disk_cache_age_comes_from_the_file_not_the_load_moment(self):
        written = self._write_cache(STALE_INDEX, age_seconds=2 * DAY_SECONDS)
        index = gallery_oss._load_oss_index_from_disk()
        self.assertIsNotNone(index)
        self.assertAlmostEqual(gallery_oss._oss_index_fetch_time, written, delta=2)

    def test_stale_cache_is_refetched_on_the_next_request(self):
        self._write_cache(STALE_INDEX, age_seconds=2 * DAY_SECONDS)
        gallery_oss.aiohttp = FakeAiohttp(json.dumps(FRESH_INDEX, ensure_ascii=False))
        index = _run(gallery_oss._fetch_oss_index())
        self.assertEqual(gallery_oss.aiohttp.requested, [OSS_CONFIG["index_url"]])
        self.assertIn("prompts.chat", index.get("directories", {}))
        with open(self.cache_file, "r", encoding="utf-8") as f:
            self.assertIn("prompts.chat", json.load(f)["directories"])

    def test_fresh_cache_is_served_without_a_network_call(self):
        self._write_cache(STALE_INDEX, age_seconds=60)
        gallery_oss._load_oss_index_from_disk()
        gallery_oss.aiohttp = FakeAiohttp(json.dumps(FRESH_INDEX, ensure_ascii=False))
        index = _run(gallery_oss._fetch_oss_index())
        self.assertEqual(gallery_oss.aiohttp.requested, [])
        self.assertNotIn("prompts.chat", index.get("directories", {}))


class SyncRefetchesDirIndexes(OssCacheSandbox, unittest.TestCase):
    """手动刷新云端索引那一发：主索引之外，逐目录索引一起重拉到当前 rev。

    只换主索引不够——提示词库的云端配对与素材页封面只读 oss_cache/<dir>/_index.json 那份磁盘缓存，
    缓存停在旧 rev 上，云端刚发布的卡与预览在界面上就一发都不动。"""

    def test_dir_index_cache_is_served_until_the_master_rev_moves(self):
        self._write_dir_cache(CLOUD_DIR, FRESH_DIR_INDEX)
        self._mock_server(INDEX_WITH_REV, FRESH_DIR_INDEX)
        items = _run(gallery_oss._fetch_oss_dir_index(INDEX_WITH_REV, CLOUD_DIR))
        self.assertEqual(gallery_oss.aiohttp.requested, [])
        self.assertEqual(len(items), 2)

    def test_force_refetches_a_dir_index_that_sits_on_the_current_rev(self):
        self._write_dir_cache(CLOUD_DIR, FRESH_DIR_INDEX)
        self._mock_server(INDEX_WITH_REV, FRESH_DIR_INDEX)
        items = _run(gallery_oss._fetch_oss_dir_index(INDEX_WITH_REV, CLOUD_DIR, force=True))
        self.assertEqual(gallery_oss.aiohttp.requested, [DIR_INDEX_URL])
        self.assertEqual(len(items), 2)

    def test_sync_route_moves_the_dir_cache_to_the_current_rev(self):
        self._write_cache(STALE_INDEX, age_seconds=2 * DAY_SECONDS)
        dir_cache = self._write_dir_cache(CLOUD_DIR, STALE_DIR_INDEX)
        server = self._mock_server(INDEX_WITH_REV, FRESH_DIR_INDEX)
        payload = self._payload(_run(gallery_oss.sync_oss_index(None)))
        self.assertTrue(payload["success"])
        self.assertEqual(payload["items"], 2)
        self.assertEqual(payload["refreshed"], 1)
        self.assertIn(DIR_INDEX_URL, server.requested)
        with open(dir_cache, "r", encoding="utf-8") as f:
            self.assertEqual(len(json.load(f)["items"]), 2)

    def test_sync_route_names_the_reason_when_cloud_presets_are_absent(self):
        with open(self.tmp / "configs" / "oss_presets.json", "w", encoding="utf-8") as f:
            json.dump({**OSS_CONFIG, "enabled": False}, f, ensure_ascii=False)
        response = _run(gallery_oss.sync_oss_index(None))
        payload = self._payload(response)
        self.assertEqual(response.status, 400)
        self.assertFalse(payload["success"])
        # 前端认这一发要说「这一页没有云端预设可刷」，不该去比后端那句英文
        self.assertEqual(payload["reason"], "not_configured")


if __name__ == "__main__":
    unittest.main()
