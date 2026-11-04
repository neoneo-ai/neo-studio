# SPDX-License-Identifier: Apache-2.0
"""civitai.py — C 站共享客户端单元测试。

覆盖：代理地址清洗、API KEY / 代理读取（唯一来源 gallery_settings.json）、请求头、
列表参数（types / baseModels 重复传 + 取值白名单）、下载地址 SSRF 校验、
模型 / 版本 / 文件归一化、api_get 的 proxy 透传与错误码。
"""
from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import asyncio
import importlib
import json
import os
import sys
import types
import unittest

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_civitai_test_pkg"
if _PKG not in sys.modules:
    _pkg = types.ModuleType(_PKG)
    _pkg.__path__ = [PLUGIN_DIR]
    sys.modules[_PKG] = _pkg

civitai = importlib.import_module(f"{_PKG}.civitai")

_SETTINGS = {}
civitai._load_settings = lambda: dict(_SETTINGS)
# 系统代理探测读真实注册表，测试里锁成空：代理行为只由设置里的 civitai_proxy 驱动
_real_system_proxy = civitai.system_proxy
civitai.system_proxy = lambda: ""


def set_settings(**kwargs):
    _SETTINGS.clear()
    _SETTINGS.update(kwargs)


class ProxyTests(unittest.TestCase):
    def test_clean_proxy_defaults_scheme(self):
        self.assertEqual(civitai.clean_proxy("127.0.0.1:7890"), "http://127.0.0.1:7890")
        self.assertEqual(civitai.clean_proxy("http://127.0.0.1:7890/"), "http://127.0.0.1:7890")
        self.assertEqual(civitai.clean_proxy("SOCKS5://a:1080"), "socks5://a:1080")

    def test_clean_proxy_rejects_junk(self):
        for raw in ("", None, "   ", "ftp://a:21", "http://", "://x", "socks5://"):
            self.assertEqual(civitai.clean_proxy(raw), "", repr(raw))
        self.assertEqual(civitai.clean_proxy("civitai.com"), "http://civitai.com")

    def test_proxy_and_proxy_kwargs_read_settings(self):
        set_settings(civitai_proxy="127.0.0.1:7890")
        self.assertEqual(civitai.proxy(), "http://127.0.0.1:7890")
        self.assertEqual(civitai.proxy_kwargs(), {"proxy": "http://127.0.0.1:7890"})
        set_settings(civitai_proxy="")
        self.assertEqual(civitai.proxy_kwargs(), {})


class HeaderTests(unittest.TestCase):
    def test_api_key_and_headers(self):
        set_settings(civitai_api_key="  abc123  ")
        self.assertEqual(civitai.api_key(), "abc123")
        self.assertEqual(civitai.headers()["Authorization"], "Bearer abc123")
        self.assertEqual(civitai.headers("explicit")["Authorization"], "Bearer explicit")
        # 显式传空串 = 调用方要求匿名，不回落设置里的 KEY
        self.assertNotIn("Authorization", civitai.headers(""))
        set_settings(civitai_api_key="")
        self.assertNotIn("Authorization", civitai.headers())


class SearchParamTests(unittest.TestCase):
    def test_types_are_lists_and_filtered(self):
        params = civitai.search_params("my lora", types=["LORA", "LoCon", "bogus"],
                                       base_models=["SDXL 1.0", "Nope"], sort="Newest")
        self.assertEqual(params["types"], ["LORA", "LoCon"])
        self.assertEqual(params["baseModels"], ["SDXL 1.0"])
        self.assertEqual(params["query"], "my lora")
        self.assertEqual(params["sort"], "Newest")

    def test_defaults(self):
        params = civitai.search_params()
        self.assertEqual(params["types"], ["LORA"])
        self.assertNotIn("baseModels", params)
        self.assertNotIn("query", params)
        self.assertNotIn("negatives", params)
        self.assertEqual(params["nsfw"], "False")
        self.assertEqual(params["sort"], "Most Downloaded")

    def test_pagination_is_cursor_only(self):
        # C 站翻页只认 cursor（响应的 metadata.nextCursor）：page 参数不进请求
        params = civitai.search_params("anime")
        self.assertNotIn("page", params)
        self.assertNotIn("cursor", params)
        self.assertEqual(civitai.search_params("anime", cursor="24")["cursor"], "24")
        # 浏览（无 query）同样只能 cursor 翻页
        params = civitai.search_params(cursor="261069|5828|42903")
        self.assertEqual(params["cursor"], "261069|5828|42903")
        self.assertNotIn("page", params)
        self.assertNotIn("query", params)

    def test_limit_clamped(self):
        self.assertEqual(civitai.search_params(limit="9999")["limit"], "100")
        self.assertEqual(civitai.search_params(limit="x")["limit"], "24")


class _FakeKey:
    def __init__(self, values):
        self.values = values

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeWinreg:
    """替 winreg：注册表里的 ProxyEnable / ProxyServer。"""

    HKEY_CURRENT_USER = 1

    def __init__(self, values, fail=False):
        self.values = values
        self.fail = fail
        self.opens = 0

    def OpenKey(self, root, path):
        self.opens += 1
        if self.fail:
            raise OSError("no such key")
        return _FakeKey(self.values)

    def QueryValueEx(self, key, name):
        return (key.values[name], 1)


class SystemProxyTests(unittest.TestCase):
    """浏览器能上 C 站靠的是系统代理；aiohttp 不读注册表，插件必须自己取。"""

    def setUp(self):
        self._winreg = civitai.winreg
        self._port_open = civitai._port_open
        self._cache = dict(civitai._sys_proxy)

    def tearDown(self):
        civitai.winreg = self._winreg
        civitai._port_open = self._port_open
        civitai._sys_proxy.clear()
        civitai._sys_proxy.update(self._cache)

    def _run(self, values, listening=True, fail=False):
        civitai._sys_proxy.clear()
        civitai._sys_proxy.update({"at": 0.0, "url": ""})
        fake = FakeWinreg(values, fail)
        civitai.winreg = fake
        civitai._port_open = lambda host, port: listening
        return _real_system_proxy(), fake

    def test_enabled_and_listening(self):
        url, fake = self._run({"ProxyEnable": 1, "ProxyServer": "127.0.0.1:7890"})
        self.assertEqual(url, "http://127.0.0.1:7890")

    def test_disabled(self):
        url, _ = self._run({"ProxyEnable": 0, "ProxyServer": "127.0.0.1:7890"})
        self.assertEqual(url, "")

    def test_proxy_app_closed_falls_back_to_direct(self):
        url, _ = self._run({"ProxyEnable": 1, "ProxyServer": "127.0.0.1:7890"}, listening=False)
        self.assertEqual(url, "")

    def test_pac_and_per_protocol_strings_ignored(self):
        for server in ("proxy=127.0.0.1:7890;https=127.0.0.1:7891", "127.0.0.1;7890", ""):
            url, _ = self._run({"ProxyEnable": 1, "ProxyServer": server})
            self.assertEqual(url, "", server)

    def test_no_registry(self):
        url, _ = self._run({}, fail=True)
        self.assertEqual(url, "")

    def test_result_cached(self):
        url, fake = self._run({"ProxyEnable": 1, "ProxyServer": "127.0.0.1:7890"})
        again = _real_system_proxy()
        self.assertEqual((url, again), ("http://127.0.0.1:7890", "http://127.0.0.1:7890"))
        self.assertEqual(fake.opens, 1)

    def test_settings_proxy_wins_over_system(self):
        fake = FakeWinreg({"ProxyEnable": 1, "ProxyServer": "127.0.0.1:7890"})
        civitai.winreg = fake
        civitai._port_open = lambda host, port: True
        civitai._sys_proxy.clear()
        civitai._sys_proxy.update({"at": 0.0, "url": ""})
        civitai.system_proxy = _real_system_proxy
        try:
            set_settings(civitai_proxy="socks5://127.0.0.1:1080")
            self.assertEqual(civitai.proxy(), "socks5://127.0.0.1:1080")
            # 模型库的请求只跟系统代理，设置里那条 C 站代理不掺进来
            self.assertEqual(civitai.system_proxy_kwargs(), {"proxy": "http://127.0.0.1:7890"})
            set_settings(civitai_proxy="")
            self.assertEqual(civitai.proxy(), "http://127.0.0.1:7890")
            self.assertEqual(civitai.proxy_kwargs(), {"proxy": "http://127.0.0.1:7890"})
        finally:
            civitai.system_proxy = lambda: ""


class DownloadPathTests(unittest.TestCase):
    def test_signed_download_endpoint_accepted(self):
        path = civitai.download_path("https://civitai.com/api/download/models/123456"
                                     "?token=abc&expires=99")
        self.assertEqual(path, "/api/download/models/123456?token=abc&expires=99")
        self.assertEqual(civitai.download_path("https://www.civitai.com/api/download/models/7"),
                         "/api/download/models/7")

    def test_other_hosts_and_paths_rejected(self):
        for url in ("", "https://evil.com/api/download/models/1",
                    "https://civitai.com/api/v1/models/1",
                    "https://civitai.com/api/download/models/abc",
                    "https://civitai.com/api/download/models/1/../../x",
                    "/api/download/models/1",
                    "https://civitai.com.evil.com/api/download/models/1"):
            self.assertEqual(civitai.download_path(url), "", url)


class NormalizeTests(unittest.TestCase):
    VERSION = {
        "id": 11, "name": "v2.0", "baseModel": "SDXL", "trainedWords": ["kw1", "kw2"],
        "publishedAt": "2025-01-01", "stats": {"downloadCount": 42},
        "files": [
            {"id": 1, "name": "model.safetensors", "format": "SafeTensor", "sizeKB": 1000,
             "type": "Model", "primary": True,
             "downloadUrl": "https://civitai.com/api/download/models/1?token=t",
             "hashes": {"SHA256": "deadbeef"}},
            {"id": 2, "name": "preview.png", "type": "Image",
             "downloadUrl": "https://civitai.com/api/download/models/2"},
        ],
    }

    def test_model_files_only_weights(self):
        files = civitai.model_files(self.VERSION)
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["name"], "model.safetensors")
        self.assertEqual(files[0]["size"], 1000 * 1024)
        self.assertEqual(files[0]["sha256"], "deadbeef")
        self.assertEqual(files[0]["download_path"], "/api/download/models/1?token=t")

    def test_normalize_version(self):
        v = civitai.normalize_version(self.VERSION)
        self.assertEqual(v["id"], 11)
        self.assertEqual(v["base_model"], "SDXL")
        self.assertEqual(v["trained_words"], ["kw1", "kw2"])
        self.assertEqual(v["downloads"], 42)
        self.assertEqual(len(v["files"]), 1)

    def test_pick_file_prefers_primary_then_safetensors(self):
        self.assertEqual(civitai.pick_file(civitai.model_files(self.VERSION))["id"], 1)
        files = [{"name": "a.ckpt", "primary": False}, {"name": "b.safetensors", "primary": False}]
        self.assertEqual(civitai.pick_file(files)["name"], "b.safetensors")
        self.assertEqual(civitai.pick_file([{"name": "c.ckpt"}])["name"], "c.ckpt")
        self.assertEqual(civitai.pick_file([]), {})

    def test_normalize_model(self):
        m = civitai.normalize_model({
            "id": 5, "name": "My LoRA", "type": "LORA", "baseModels": ["SDXL"], "nsfw": True,
            "creator": {"username": "bob"}, "tags": [{"name": "style"}],
            "stats": {"downloadCount": 10, "thumbsUpCount": 3},
            "modelVersions": [self.VERSION],
        })
        self.assertEqual(m["name"], "My LoRA")
        self.assertEqual(m["creator"], "bob")
        self.assertEqual(m["tags"], ["style"])
        self.assertEqual(m["downloads"], 10)
        self.assertTrue(m["nsfw"])
        self.assertEqual(len(m["versions"]), 1)

    def test_normalize_model_string_tags(self):
        # C 站列表接口回的是纯字符串 tags，详情接口才是 {name} 对象
        m = civitai.normalize_model({"id": 6, "name": "X", "tags": ["western art", "nsfw"]})
        self.assertEqual(m["tags"], ["western art", "nsfw"])

    def test_preview_url(self):
        self.assertEqual(civitai._preview_url({"modelVersions": [{"images": [{"url": "u"}]}]}), "u")
        self.assertEqual(civitai._preview_url({"props": {"previewUrl": "p"}}), "p")
        self.assertEqual(civitai._preview_url({}), "")


class ApiGetTests(unittest.TestCase):
    def test_api_get_sends_key_proxy_and_params(self):
        calls = []

        class Resp:
            status = 200

            async def json(self, content_type=None):
                return {"items": []}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        class Session:
            def get(self, url, params=None, headers=None, timeout=None, **kwargs):
                calls.append({"url": url, "params": params, "headers": headers, "kwargs": kwargs})
                return Resp()

        set_settings(civitai_api_key="k1", civitai_proxy="127.0.0.1:7890")
        status, body = asyncio.run(civitai.api_get(Session(), "/models", {"limit": "1"}))
        self.assertEqual(status, 200)
        self.assertEqual(body, {"items": []})
        call = calls[0]
        self.assertEqual(call["url"], f"{civitai.API_BASE}/models")
        self.assertEqual(call["headers"]["Authorization"], "Bearer k1")
        self.assertEqual(call["kwargs"], {"proxy": "http://127.0.0.1:7890"})

    def test_api_get_no_proxy_when_unset(self):
        calls = []

        class Resp:
            status = 401

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

        class Session:
            def get(self, url, params=None, headers=None, timeout=None, **kwargs):
                calls.append(kwargs)
                return Resp()

        set_settings(civitai_api_key="", civitai_proxy="")
        status, body = asyncio.run(civitai.api_get(Session(), "/models"))
        self.assertEqual(status, 401)
        self.assertIsNone(body)
        self.assertEqual(calls[0], {})
        self.assertNotIn("Authorization", calls[0])

    def test_api_get_connection_error_returns_zero(self):
        class Session:
            def get(self, *a, **k):
                raise OSError("no route")

        status, body = asyncio.run(civitai.api_get(Session(), "/models"))
        self.assertEqual(status, 0)
        self.assertIsNone(body)


class ErrorMessageTests(unittest.TestCase):
    def test_error_message(self):
        self.assertIn("401", civitai.error_message(401))
        self.assertIn("403", civitai.error_message(403))
        self.assertIn("429", civitai.error_message(429))
        self.assertIn("代理", civitai.error_message(0))
        self.assertEqual(civitai.error_message(404), "Civitai HTTP 404")
        self.assertIn("page param", civitai.error_message(400, "Cannot use page param"))

    def test_error_detail_plain(self):
        self.assertIn("cursor", civitai.error_detail(
            {"error": "Cannot use page param with query search. Use cursor-based pagination."}))
        self.assertEqual(civitai.error_detail(None), "")
        self.assertEqual(civitai.error_detail({"error": 5}), "")

    def test_error_detail_zod(self):
        body = {"error": {"name": "ZodError", "message": json.dumps([
            {"code": "invalid_value", "path": ["sort"], "message": "Invalid option"},
            {"code": "too_big", "path": ["limit"], "message": "Too big"},
        ])}}
        detail = civitai.error_detail(body)
        self.assertIn("sort", detail)
        self.assertIn("Invalid option", detail)
        self.assertIn("limit", detail)
        self.assertEqual(civitai.error_detail({"error": {"message": "not json ["}}), "not json [")


class EnumTests(unittest.TestCase):
    class Resp:
        def __init__(self, status, payload):
            self.status = status
            self.payload = payload

        async def json(self, content_type=None):
            return self.payload

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    def _session(self, status, payload, calls):
        resp = self.Resp(status, payload)

        class Session:
            def get(self, url, params=None, headers=None, timeout=None, **kwargs):
                calls.append(url)
                return resp

        return Session()

    def setUp(self):
        civitai._enums.update(ts=0.0, base_models=list(civitai.BASE_MODELS))

    def test_enums_refresh_and_cache(self):
        calls = []
        bases = asyncio.run(civitai.fetch_enums(self._session(200, {"ActiveBaseModel": ["Pony", "Krea 2"]}, calls)))
        self.assertIn("Krea 2", bases)
        self.assertIn("SDXL 1.0", bases)
        self.assertEqual(len(calls), 1)
        bases = asyncio.run(civitai.fetch_enums(self._session(200, {"ActiveBaseModel": ["Pony"]}, calls)))
        self.assertEqual(len(calls), 1)
        self.assertIn("Krea 2", bases)

    def test_enums_failure_keeps_previous_list(self):
        calls = []
        bases = asyncio.run(civitai.fetch_enums(self._session(500, None, calls)))
        self.assertEqual(bases, civitai.base_model_options())
        self.assertIn("SDXL 1.0", bases)
        asyncio.run(civitai.fetch_enums(self._session(500, None, calls)))
        self.assertEqual(len(calls), 1)


restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)

if __name__ == "__main__":
    unittest.main(verbosity=2)
