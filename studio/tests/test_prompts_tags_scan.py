# SPDX-License-Identifier: Apache-2.0
"""提示词列表的两条扫描口径（离线单测）。

list_prompts 扫整棵 presets + custom 树：标签索引按来源读一次交进扫描，不再每个 .txt 各读一遍
同一份 _tags_index.json。@ 点名弹层那份在 prompt_names.py 的 list_prompt_names：只从目录列表
取名字、不逐个 stat，正文是选中那一发才读，桌面端离线服务与 ComfyUI 内注册共用它。
名字与子目录前缀口径两条保持一致。
"""

import builtins
import importlib
import json
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

_PKG_NAME = "_neo_prompts_scan_pkg"
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
    prompts_mod = importlib.import_module(f"{_PKG_NAME}.prompts")
    prompt_names_mod = importlib.import_module(f"{_PKG_NAME}.prompt_names")
    PROMPTS_AVAILABLE = True
except Exception as _e:
    prompts_mod = None
    prompt_names_mod = None
    PROMPTS_AVAILABLE = False
    _import_error = str(_e)
finally:
    if _prev_server is None:
        sys.modules.pop("server", None)
    else:
        sys.modules["server"] = _prev_server


def _seed(source: str, files: dict, tags: list) -> None:
    """按来源写提示词文件与标签索引：files 的键是相对来源根的名字，值只用作内容"""
    base = prompts_mod.PRESETS_DIR if source == "presets" else prompts_mod.CUSTOM_DIR
    tags_dir = os.path.dirname(prompt_names_mod.tags_file_path(source))
    index = {}
    for name, text in files.items():
        path = os.path.join(base, *name.split("/")) + ".txt"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        index[name] = tags
    os.makedirs(tags_dir, exist_ok=True)
    with open(prompt_names_mod.tags_file_path(source), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)


@unittest.skipUnless(PROMPTS_AVAILABLE, f"prompts module unavailable: {_import_error}")
class TagsScanTests(unittest.TestCase):
    """标签索引按来源读一次；子目录前缀与 tags 口径不变"""

    def setUp(self):
        self.touched = []

    def tearDown(self):
        # 用例写进的是 conftest 钉住的临时数据根，逐条清掉，下一条扫不到上一份的提示词
        for source in self.touched:
            base = prompts_mod.PRESETS_DIR if source == "presets" else prompts_mod.CUSTOM_DIR
            shutil.rmtree(base, ignore_errors=True)

    def seed(self, source, files, tags):
        self.touched.append(source)
        _seed(source, files, tags)

    def _count_index_reads(self, source):
        """包住索引读取数它被调用了几次，返回 (调用路径列表, 扫描结果)"""
        real = prompts_mod.load_tags_index
        calls = []

        def spy(path):
            calls.append(path)
            return real(path)

        prompts_mod.load_tags_index = spy
        try:
            rows = prompts_mod._scan_prompts(source)
        finally:
            prompts_mod.load_tags_index = real
        return calls, rows

    def test_tags_index_read_once_for_whole_source(self):
        self.seed("presets", {
            "红杯": "一只红色陶瓷杯",
            "蓝杯": "一只蓝色陶瓷杯",
            "精美图像提示词/古风女孩": "古风女孩写真",
            "精美图像提示词/古风礼服": "古风礼服写真",
        }, ["红"])
        calls, rows = self._count_index_reads("presets")
        self.assertEqual(calls, [prompt_names_mod.tags_file_path("presets")])
        self.assertEqual(len(rows), 4)

    def test_custom_source_uses_its_own_index(self):
        self.seed("custom", {"我的红杯": "一只红杯"}, ["自定义"])
        calls, rows = self._count_index_reads("custom")
        self.assertEqual(calls, [prompt_names_mod.tags_file_path("custom")])
        self.assertEqual([(r["name"], r["tags"], r["source"]) for r in rows],
                         [("我的红杯", ["自定义"], "custom")])

    def test_subdirectory_names_keep_the_prefix(self):
        self.seed("presets", {"精美图像提示词/古风女孩": "古风女孩写真"}, ["古"])
        _, rows = self._count_index_reads("presets")
        self.assertEqual([r["name"] for r in rows], ["精美图像提示词/古风女孩"])
        self.assertEqual(rows[0]["tags"], ["古"])

    def test_names_scan_skips_per_file_opens(self):
        """@ 点名用的那份列表：整棵树只开一份索引，一个 .txt 都不打开"""
        self.seed("presets", {
            "红杯": "一只红色陶瓷杯",
            "精美图像提示词/古风女孩": "古风女孩写真",
            "_草稿": "不该出现在列表里",
        }, ["红"])
        opened = []
        real_open = builtins.open

        def spy_open(*a, **k):
            opened.append(str(a[0]))
            return real_open(*a, **k)

        real_index = prompt_names_mod.load_tags_index
        index_calls = []

        def spy_index(path):
            index_calls.append(path)
            return real_index(path)

        builtins.open = spy_open
        prompt_names_mod.load_tags_index = spy_index
        try:
            rows = prompt_names_mod.iter_prompt_names("presets")
        finally:
            builtins.open = real_open
            prompt_names_mod.load_tags_index = real_index
        names = [(r["name"], r["source"]) for r in rows]
        self.assertIn(("红杯", "presets"), names)
        self.assertIn(("精美图像提示词/古风女孩", "presets"), names)
        self.assertNotIn("_草稿", [n for n, _ in names])
        self.assertEqual([r["tags"] for r in rows if r["name"] == "红杯"], [["红"]])
        self.assertEqual(index_calls, [prompt_names_mod.tags_file_path("presets")])
        self.assertEqual([p for p in opened if p.endswith(".txt")], [])


if __name__ == "__main__":
    unittest.main()
