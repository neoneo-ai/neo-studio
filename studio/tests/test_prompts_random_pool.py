# SPDX-License-Identifier: Apache-2.0
"""运行时随机池的作用域（离线单测）。

随机池 = presets + custom 两棵树的普通 .txt（整篇一条）+ collections 条目（按行一条），配方不入池。
kind 选池子：绘画页 / 视频页的「随机」各自只要自己那一池，Prompt Agent 节点走空值那条要混池。
归属口径看扫描名首段 —— `video/` 目录（含子目录）里的文件归视频，其余归图像，
与前端 js/core/preset-picker.js 的 isVideoPromptName 同一份。
"""

import importlib
import os
import shutil
import sys
import types
import unittest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _NODE_DIR)
# ComfyUI 根有两种落点：仓库的上级目录，与整合包里的同级 ComfyUI（.vscode/settings.json 的 extraPaths）
for _cand in (os.path.join(_NODE_DIR, "..", ".."), os.path.join(_NODE_DIR, "..", "..", "ComfyUI")):
    if os.path.isfile(os.path.join(_cand, "folder_paths.py")):
        sys.path.insert(0, os.path.abspath(_cand))
        break

_PKG_NAME = "_neo_prompts_random_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg


class _FakeRoutes:
    def _deco(self, *a, **k):
        def wrapper(fn):
            return fn
        return wrapper

    def get(self, *a, **k):
        return self._deco()

    def post(self, *a, **k):
        return self._deco()


class _FakePromptServer:
    class instance:
        routes = _FakeRoutes()


_prev_server = sys.modules.get("server")
_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

_import_error = ""
try:
    names_mod = importlib.import_module(f"{_PKG_NAME}.prompt_names")
    PROMPTS_AVAILABLE = True
except Exception as _e:
    names_mod = None
    PROMPTS_AVAILABLE = False
    _import_error = str(_e)
finally:
    if _prev_server is None:
        sys.modules.pop("server", None)
    else:
        sys.modules["server"] = _prev_server


@unittest.skipUnless(PROMPTS_AVAILABLE, f"prompt pool module unavailable: {_import_error}")
class RandomPoolScopeTests(unittest.TestCase):
    """kind 筛池：image 排除 video 目录，video 只取 video 目录，空值不筛（旧调用方照旧）"""

    FILES = {
        "红杯": "一只红色陶瓷杯",
        "精美图像提示词/古风女孩": "古风女孩写真",
        "video/镜头推进": "镜头缓缓推进，画面亮起",
        "video/子目录/雨夜窗边": "雨夜窗边，玻璃上的水珠",
    }

    def setUp(self):
        self._bases = []
        for source, base in (("presets", names_mod.PRESETS_DIR), ("custom", names_mod.CUSTOM_DIR)):
            self._bases.append(base)
            os.makedirs(base, exist_ok=True)
            files = self.FILES if source == "presets" else {"我的红杯": "一只红杯"}
            for name, text in files.items():
                path = os.path.join(base, *name.split("/")) + ".txt"
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)

    def tearDown(self):
        # 用例写进的是 conftest 钉住的临时数据根，逐条清掉，下一条扫不到上一份的提示词
        for base in self._bases:
            shutil.rmtree(base, ignore_errors=True)

    def pool(self, kind):
        return names_mod.iter_random_candidates(kind)

    def test_empty_kind_keeps_the_mixed_pool(self):
        """不传 kind = 混池：图像与视频条目都在（Prompt Agent 节点与旧调用方要的就是这一份）"""
        pool = self.pool("")
        self.assertIn("一只红色陶瓷杯", pool)
        self.assertIn("镜头缓缓推进，画面亮起", pool)
        self.assertIn("雨夜窗边，玻璃上的水珠", pool)

    def test_image_excludes_the_video_directory(self):
        pool = self.pool("image")
        self.assertIn("一只红色陶瓷杯", pool)
        self.assertIn("一只红杯", pool)
        self.assertIn("古风女孩写真", pool)
        self.assertNotIn("镜头缓缓推进，画面亮起", pool)
        self.assertNotIn("雨夜窗边，玻璃上的水珠", pool)

    def test_video_takes_only_the_video_directory(self):
        """临时根里还铺着出厂预设，断言只钉用例自己种的那几条：视频池收得到它们，收不到图像那几条"""
        pool = self.pool("video")
        self.assertIn("镜头缓缓推进，画面亮起", pool)
        self.assertIn("雨夜窗边，玻璃上的水珠", pool)
        for image_text in ("一只红色陶瓷杯", "一只红杯", "古风女孩写真"):
            self.assertNotIn(image_text, pool)

    def test_sample_respects_the_scope_and_dedupes(self):
        """抽 count 条不重复；要得比这一档池子还多就全量返回，且不越出池子"""
        image_pool = self.pool("image")
        picked = names_mod.sample_runtime_prompts(len(image_pool) + 5, "image")
        self.assertEqual(len(set(picked)), len(picked), "整池抽完也不出重复")
        self.assertEqual(set(picked), set(image_pool), "要得比池子多就是全量")
        for video_text in ("镜头缓缓推进，画面亮起", "雨夜窗边，玻璃上的水珠"):
            self.assertNotIn(video_text, picked)
        one = names_mod.sample_runtime_prompts(1, "video")
        self.assertEqual(len(one), 1)
        self.assertIn(one[0], self.pool("video"))

    def test_video_flag_is_the_first_path_segment(self):
        """归属看扫描名首段：video 目录算视频，collections 前缀落图像一侧"""
        self.assertTrue(names_mod.is_video_prompt("video/镜头推进"))
        self.assertTrue(names_mod.is_video_prompt("video/子目录/雨夜窗边"))
        self.assertFalse(names_mod.is_video_prompt("红杯"))
        self.assertFalse(names_mod.is_video_prompt("collections/一批镜头"))


if __name__ == "__main__":
    unittest.main()
