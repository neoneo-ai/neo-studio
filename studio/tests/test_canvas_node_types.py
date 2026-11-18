# SPDX-License-Identifier: Apache-2.0
"""画布节点类型的存取（离线单测）。

_clean_node 在写与读两条路上都要过：类型表只认 image / text 时，生成 / 视频 / 配方节点
在保存那一轮就被改写成提示词节点，画布一重开只剩正文面，metadata 留下了面却没了。
这一层的职责是原样留类型 —— 旧页面认不出的面自己回落到正文，不会被后端改名。
"""
from __future__ import annotations

import unittest

from studio import canvas


def _node(**over) -> dict:
    raw = {"id": "n1", "type": "gen", "title": "生成", "position": {"x": 10, "y": 20},
           "width": 340, "height": 240, "metadata": {"skill_id": "s"}}
    raw.update(over)
    return raw


class CanvasNodeTypeTests(unittest.TestCase):
    def test_page_types_survive_the_clean(self):
        for kind in ("image", "text", "gen", "video", "recipe"):
            self.assertEqual(canvas._clean_node(_node(type=kind))["type"], kind)

    def test_a_type_this_build_does_not_know_lands_unchanged(self):
        """前端新加的面，旧后端也不给改名：页面自己认不出就落正文面，画布不能替它改"""
        self.assertEqual(canvas._clean_node(_node(type="audio"))["type"], "audio")

    def test_missing_type_falls_back_to_text(self):
        for blank in (None, "", "   "):
            self.assertEqual(canvas._clean_node(_node(type=blank))["type"], "text")

    def test_project_rounds_types_with_its_connections(self):
        project = canvas._clean_project({"nodes": [_node(type="gen", id="g1"), _node(type="recipe", id="c1")],
                                         "connections": [{"fromNodeId": "g1", "toNodeId": "c1"}]})
        self.assertEqual([n["type"] for n in project["nodes"]], ["gen", "recipe"])
        self.assertEqual([c["toNodeId"] for c in project["connections"]], ["c1"])


if __name__ == "__main__":
    unittest.main()
