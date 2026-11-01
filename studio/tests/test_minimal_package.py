# SPDX-License-Identifier: Apache-2.0
# 最小整合包插件清单与内置预设的一致性：预设要的节点，整合包发的插件必须给得出。

import json
import os
import re
import unittest

_TOOLS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tools"))
_PRESETS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "skills", "presets"))
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_MODULE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


def _manifest():
    with open(os.path.join(_TOOLS, "minimal_plugins.json"), encoding="utf-8") as f:
        return json.load(f)


def _preset_class_types():
    """预设 workflow.json 里的 class_type -> 用到它的预设名；这张图就是整合包必须跑得起来的图。"""
    used = {}
    for name in sorted(os.listdir(_PRESETS)):
        path = os.path.join(_PRESETS, name, "workflow.json")
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            graph = json.load(f)
        for node in graph.values():
            if isinstance(node, dict) and node.get("class_type"):
                used.setdefault(node["class_type"], []).append(name)
    return used


class TestMinimalManifest(unittest.TestCase):
    def test_required_plugins_pinned(self):
        for plugin in _manifest()["required"]:
            self.assertTrue(_COMMIT.match(plugin["commit"]), plugin["name"])
            self.assertTrue(plugin["repo"].startswith("https://"), plugin["name"])
            self.assertTrue(plugin["nodes"], plugin["name"])
            self.assertTrue(plugin["used_by"], plugin["name"])

    def test_used_by_presets_exist(self):
        for plugin in _manifest()["required"]:
            for preset in plugin["used_by"]:
                self.assertTrue(os.path.isdir(os.path.join(_PRESETS, preset)),
                                f"{plugin['name']} 的 used_by 指向不存在的预设 {preset}")

    def test_excluded_plugin_nodes_not_in_presets(self):
        used = _preset_class_types()
        for plugin in _manifest()["excluded"]:
            for node in plugin["nodes"]:
                self.assertNotIn(node, used,
                                 f"预设 {used.get(node)} 还要 {node}，这个节点属于被排除的 {plugin['name']}")

    def test_krea2_preset_stays_removed(self):
        self.assertFalse(os.path.isdir(os.path.join(_PRESETS, "image_gen_image")))
        for plugin in _manifest()["required"]:
            self.assertNotIn("image_gen_image", plugin["used_by"])

    def test_preset_class_types_cover_required_nodes(self):
        # 清单说插件提供 X，预设里就得真的用得到 X，否则清单与预设已经对不上
        used = set(_preset_class_types())
        for plugin in _manifest()["required"]:
            self.assertTrue(set(plugin["nodes"]) & used,
                            f"{plugin['name']} 声明的节点没有任何预设在用")

    def test_import_smoke_modules_are_importable_names(self):
        # 整包自检拿 import_smoke 在包内 python 里真 import 一遍；名字写错就是自检跑不到东西
        for plugin in _manifest()["required"]:
            smoke = plugin["import_smoke"]
            notes = plugin.get("import_notes", {})
            for mod in smoke:
                self.assertTrue(_MODULE.match(mod), f"{plugin['name']} 的 import_smoke 里 {mod} 不是模块名")
            self.assertFalse(set(notes) - set(smoke),
                             f"{plugin['name']} 的 import_notes 点了 import_smoke 里没有的模块")
            for mod, note in notes.items():
                self.assertTrue(note.strip(), f"{plugin['name']} 的 {mod} 没有说明为什么导入不了")
