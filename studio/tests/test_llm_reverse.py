# SPDX-License-Identifier: Apache-2.0
"""图片反推（POST /rs_prompts/reverse_prompt）离线单测：缓存命中、SSE 帧、能力表归属。

切换语言即强制重新反推：同名 .txt 存在且记录语言与请求一致才命中缓存，
否则（切语言 / 旧缓存无语言标记）跳过缓存重新生成。
反推链注册在 studio/llm.py 的 routes 上（app/studio_caps.py 把这条链表进桌面端自服），用例随链同侧。
"""

import asyncio
import importlib
import json
import os
import sys
import types
import tempfile
import unittest
from pathlib import Path

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _NODE_DIR)
import _comfy_api_bootstrap  # noqa: E402
sys.path.insert(0, _comfy_api_bootstrap.comfy_root())

_PKG_NAME = "_neo_llm_reverse_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg

# llm.py 的路由是 aiohttp 的 RouteTableDef，不碰 server；模块层只要真实 folder_paths 可导入
_llm_import_error = ""
try:
    llm_mod = importlib.import_module(f"{_PKG_NAME}.llm")
    LLM_AVAILABLE = True
except Exception as _e:
    llm_mod = None
    LLM_AVAILABLE = False
    _llm_import_error = str(_e)


@unittest.skipUnless(LLM_AVAILABLE, f"llm module unavailable: {_llm_import_error}")
class ReverseCacheHitTests(unittest.TestCase):
    """_reverse_cache_hit：同名 .txt 存在且语言匹配才命中，切语言/无标记则需重新反推。"""

    def _mk(self, name, text=None, lang=None):
        d = tempfile.mkdtemp(prefix="neo_rp_cache_")
        img = Path(d) / f"{name}.png"
        img.write_bytes(b"\x89PNG fake")
        txt_path = img.with_suffix(".txt")
        lang_path = img.with_suffix(".rp-lang")
        if text is not None:
            txt_path.write_text(text, encoding="utf-8")
        if lang is not None:
            lang_path.write_text(lang, encoding="utf-8")
        return txt_path, lang_path

    def test_no_txt_needs_regenerate(self):
        txt_path, lang_path = self._mk("shot")
        self.assertIsNone(llm_mod._reverse_cache_hit(txt_path, lang_path, "zh"))

    def test_same_language_hits_cache(self):
        txt_path, lang_path = self._mk("shot", text="一个红发女孩", lang="zh")
        self.assertEqual(llm_mod._reverse_cache_hit(txt_path, lang_path, "zh"), "一个红发女孩")

    def test_switched_language_needs_regenerate(self):
        txt_path, lang_path = self._mk("shot", text="一个红发女孩", lang="zh")
        self.assertIsNone(llm_mod._reverse_cache_hit(txt_path, lang_path, "en"))

    def test_legacy_cache_without_lang_marker_needs_regenerate(self):
        # 旧缓存只有 .txt、无 .rp-lang 标记：视为语言未知，强制重新反推
        txt_path, lang_path = self._mk("shot", text="a red-haired girl")
        self.assertIsNone(llm_mod._reverse_cache_hit(txt_path, lang_path, "zh"))

    def test_zh_system_prompt_is_chinese(self):
        # 中文系统提示词必须明确中文输出，且不含英文质量词示例（否则 LLM 会被带成英文）
        sp = llm_mod._reverse_system_prompt("zh")
        self.assertIn("使用中文生成", sp)
        self.assertNotIn("masterpiece", sp)



@unittest.skipUnless(LLM_AVAILABLE, f"llm module unavailable: {_llm_import_error}")
class ReversePromptSSETests(unittest.TestCase):
    """rs_prompts_reverse_prompt：SSE 流式帧（缓存命中立即发正文 + meta + DONE）与能力表归属。"""

    def _req(self, payload):
        class _Req:
            async def json(self):
                return payload
        return _Req()

    @staticmethod
    async def _frames(gen):
        out = []
        async for raw in gen:
            text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
            for line in text.split("\n"):
                if line.startswith("data: "):
                    out.append(line[6:])
        return out

    def test_cache_hit_streams_text_then_meta(self):
        import aiohttp.web as web_mod
        d = tempfile.mkdtemp(prefix="neo_rp_sse_")
        img = Path(d) / "shot.png"
        img.write_bytes(b"\x89PNG fake")
        img.with_suffix(".txt").write_text("一个红发女孩", encoding="utf-8")
        img.with_suffix(".rp-lang").write_text("zh", encoding="utf-8")

        # 注入假 gallery 模块（避免真实 import .gallery 的重依赖），供端点内 from .gallery import _find_source_media 使用
        gallery_name = f"{_PKG_NAME}.gallery"
        prev_gallery = sys.modules.get(gallery_name)
        fake_gallery = types.ModuleType(gallery_name)
        fake_gallery._find_source_media = lambda fn, sf: img
        sys.modules[gallery_name] = fake_gallery

        # 捕获 web.Response 的 body（async generator），直接消费以验证 SSE 帧
        captured = {}
        orig_response = web_mod.Response
        def spy_response(*a, **k):
            if k.get("body") is not None:
                captured["body"] = k["body"]
            return orig_response(*a, **k)
        web_mod.Response = spy_response
        try:
            asyncio.run(llm_mod.rs_prompts_reverse_prompt(
                self._req({"filename": "shot.png", "subfolder": "Output", "language": "zh"})))
        finally:
            web_mod.Response = orig_response
            if prev_gallery is None:
                sys.modules.pop(gallery_name, None)
            else:
                sys.modules[gallery_name] = prev_gallery

        frames = asyncio.run(self._frames(captured["body"]))
        self.assertEqual(frames[-1], "[DONE]")
        texts = [json.loads(f) for f in frames if f != "[DONE]"]
        self.assertEqual(texts[0].get("text"), "一个红发女孩")
        self.assertEqual(texts[-1].get("meta", {}).get("txt_file"), "shot.txt")

    def test_reverse_routes_are_desktop_self_served(self):
        """反推链归桌面端自服：注册在 llm.py 的 routes 上，离线窗口直接服务这一发，不转给内核。"""
        import studio_caps as caps
        pairs = (("prompt_reverse", ("POST", "/rs_prompts/reverse_prompt")),
                 ("prompt_reverse_video", ("POST", "/rs_prompts/reverse_video_prompt")))
        for name, route in pairs:
            self.assertEqual(caps.owner(*route), "desktop", f"{name} 该由桌面端自服")
            self.assertFalse(caps.forwardable(*route), "自服的请求不该转给内核")
            self.assertIn(route, caps.DESKTOP_ROUTES)
            self.assertEqual(caps.FEATURE_ROUTES[name], route)
            self.assertNotIn(name, caps.KERNEL_FEATURES, "能力表据此在离线窗口翻面")


if __name__ == "__main__":
    unittest.main()

