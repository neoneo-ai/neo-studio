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
        "prompts.chat": {"count": 20, "tags": ["prompts-chat"]},
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
        return _Ctx(_Resp(self._owner.payload, self._owner.status))


class FakeAiohttp:
    """Stands in for the OSS index endpoint: aiohttp.ClientSession().get(index_url) -> response."""

    def __init__(self, payload: str, status: int = 200):
        self.payload = payload
        self.status = status
        self.requested = []

    def ClientSession(self):
        return _Session(self)

    def ClientTimeout(self, **kwargs):
        return None



class OssIndexCacheAge(unittest.TestCase):
    """A cache older than the sync interval must be refetched, not re-stamped at load."""

    def setUp(self):
        self._tmp_dir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp_dir.name)
        (self.tmp / "configs").mkdir()
        (self.tmp / "gallery" / "oss_cache").mkdir(parents=True)
        with open(self.tmp / "configs" / "oss_presets.json", "w", encoding="utf-8") as f:
            json.dump(OSS_CONFIG, f, ensure_ascii=False)
        self._saved = (gallery_oss.CONFIGS_DIR, gallery_oss.OSS_CACHE_DIR,
                       gallery_oss.OSS_INDEX_CACHE_FILE, gallery_oss._oss_index_cache,
                       gallery_oss._oss_index_fetch_time, gallery_oss.aiohttp)
        gallery_oss.CONFIGS_DIR = self.tmp / "configs"
        gallery_oss.OSS_CACHE_DIR = self.tmp / "gallery" / "oss_cache"
        gallery_oss.OSS_INDEX_CACHE_FILE = gallery_oss.OSS_CACHE_DIR / "_index.json"
        gallery_oss._oss_index_cache = None
        gallery_oss._oss_index_fetch_time = 0.0
        self.cache_file = gallery_oss.OSS_INDEX_CACHE_FILE

    def tearDown(self):
        (gallery_oss.CONFIGS_DIR, gallery_oss.OSS_CACHE_DIR, gallery_oss.OSS_INDEX_CACHE_FILE,
         gallery_oss._oss_index_cache, gallery_oss._oss_index_fetch_time,
         gallery_oss.aiohttp) = self._saved
        self._tmp_dir.cleanup()

    def _write_cache(self, index: dict, age_seconds: float) -> float:
        with open(self.cache_file, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False)
        stamp = os.stat(self.cache_file).st_mtime - age_seconds
        os.utime(self.cache_file, (stamp, stamp))
        return os.stat(self.cache_file).st_mtime

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


if __name__ == "__main__":
    unittest.main()
