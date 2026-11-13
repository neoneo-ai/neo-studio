# SPDX-License-Identifier: Apache-2.0
"""/neo_home/layout（studio/home_layout.py）离线单测：首页版式的读、存、恢复默认。

版式只存形状（板块顺序、卡顺序、隐藏项、自建卡、列数、标题区文案），落 <data root>/
configs/home_layout.json。这里覆盖空数据根回空版式、形状清洗（越界列数、非 http(s) 外链、
缺标题/缺跳转类型的自建卡、超上限的列表、换行压平）、坏文件退回默认值、保存原子落盘只留一份、
reset 删文件，以及三条路由的注册形状。落点逐用例顶到临时目录，永远不碰真实 data/。
"""

import asyncio
import importlib
import json
import tempfile
import types
import unittest
from pathlib import Path

from stub_env import restore, snapshot

home_layout = importlib.import_module("studio.home_layout")   # conftest.py 把 studio 顶成占位包，插件入口不执行

GOOD_CUSTOM = {"id": "custom_1", "section": "create", "title": "我的报表", "sub": "每周汇总",
               "icon": "file", "target": "page", "value": "gallery", "url": ""}


def _request(body=None, invalid_json=False) -> types.SimpleNamespace:
    """假请求：三条 handler 只读 JSON body 一样，坏 body 靠「读不出 JSON」模拟。"""
    async def read_json():
        if invalid_json:
            raise ValueError("no json")
        return body

    return types.SimpleNamespace(json=read_json)


def _payload(resp) -> dict:
    return json.loads(resp.body.decode("utf-8"))


def _layout_path(root: Path) -> Path:
    return root / "configs" / "home_layout.json"


class HomeLayoutTests(unittest.TestCase):
    """版式落点顶进临时目录：模块常量在 import 期按数据根算好，逐用例改写再归还。"""

    def setUp(self):
        self._saved = snapshot(("studio.home_layout",))
        self._tmp = tempfile.TemporaryDirectory(prefix="neo_home_layout_")
        self.root = Path(self._tmp.name)
        home_layout.CONFIGS_DIR = str(self.root / "configs")
        home_layout.LAYOUT_FILE = str(_layout_path(self.root))

    def tearDown(self):
        self._tmp.cleanup()
        restore(("studio.home_layout",), self._saved)

    def test_missing_file_answers_blank_layout(self):
        resp = asyncio.run(home_layout.layout_route(_request()))
        self.assertEqual(resp.status, 200)
        self.assertEqual(_payload(resp), home_layout.DEFAULT_LAYOUT)
        self.assertFalse(_layout_path(self.root).exists(), "没存过就不许凭空造一个版式文件")

    def test_save_round_trips_the_shape(self):
        patch = {
            "sections": ["material", "create", "edit"],
            "hidden_sections": ["material"],
            "order": {"create": ["director", "video", "paint", "custom_1"],
                      "edit": ["edit-pose", "edit-normal"]},
            "hidden": ["video", "settings"],
            "custom": [GOOD_CUSTOM],
            "cols": 4,
            "hero": {"title": "先想清楚", "accent": "再画", "suffix": "", "sub": "一句话就够",
                     "cta": "出图", "off": False, "cta_off": True},
        }
        layout = _payload(asyncio.run(home_layout.save_layout_route(_request(body=patch))))["layout"]
        self.assertEqual(layout["sections"], ["material", "create", "edit"], "板块顺序按提交的存")
        self.assertEqual(layout["hidden_sections"], ["material"], "整块收起要留得下来")
        self.assertEqual(layout["order"]["create"], ["director", "video", "paint", "custom_1"])
        self.assertEqual(layout["hidden"], ["video", "settings"], "逐卡隐藏要留得下来")
        self.assertEqual(layout["custom"][0]["title"], "我的报表")
        self.assertEqual(layout["cols"], 4)
        self.assertEqual(layout["hero"]["accent"], "再画")
        self.assertNotIn("suffix", layout["hero"], "空文案不占键，读回来才落得回默认文案")
        self.assertEqual(layout["hero"]["cta_off"], True)
        self.assertEqual(_payload(asyncio.run(home_layout.layout_route(_request()))), layout,
                         "GET 必须原样回读落盘那一份")
        self.assertEqual(json.loads(_layout_path(self.root).read_text(encoding="utf-8")), layout)

    def test_shape_is_cleaned_on_the_way_in(self):
        sections = [f"s{n}" for n in range(home_layout._MAX_SECTIONS + 6)]
        patch = {
            "sections": sections + ["s0", "create", 1, "s0"],
            "hidden_sections": ["nope"],
            "order": {"create": ["image", "image", "paint", "ghost"], "": ["video"],
                      "ghost_section": ["lib"]},
            "hidden": ["video", "video", "ghost", 7],
            "cols": 99,
            "hero": {"title": "  两行 \n 文案  ", "sub": "x" * 400, "cta": "", "off": "yes",
                     "junk": "丢掉"},
        }
        layout = home_layout.normalize_layout(patch)
        self.assertEqual(layout["sections"][:3], [f"s0", "s1", "s2"],
                         "板块 id 过形态、去重后按提交顺序留；哪一块真实存在由前端注册表判")
        self.assertEqual(len(layout["sections"]), home_layout._MAX_SECTIONS, "板块数按上限截断")
        self.assertEqual(layout["sections"].count("s0"), 1, "重复的板块只留第一次")
        self.assertEqual(layout["hidden_sections"], ["nope"], "隐藏板块同样只过 id 形态")
        self.assertEqual(layout["order"]["create"], ["image", "paint", "ghost"],
                         "卡 id 同样去重、过形态；卡是否真的存在由前端注册表判")
        self.assertNotIn("", layout["order"], "id 形态不合格的板块整键丢掉")
        self.assertEqual(layout["order"]["ghost_section"], ["lib"],
                         "后端只守形状，认不出的板块原样存着，前端渲染时丢弃")
        self.assertEqual(layout["hidden"], ["video", "ghost", "7"], "隐藏项同样去重与剔空")
        self.assertEqual(layout["cols"], 0, "列数不在档位里就是跟随窗口")
        self.assertEqual(layout["hero"]["title"], "两行 文案", "换行压成空格，首尾空白去掉")
        self.assertEqual(len(layout["hero"]["sub"]), home_layout._MAX_SUB)
        self.assertNotIn("cta", layout["hero"])
        self.assertEqual(layout["hero"]["off"], True, "开关只认布尔")
        self.assertNotIn("junk", layout["hero"])

    def test_custom_card_needs_id_title_and_target(self):
        broken = [
            {"id": "", "title": "有题无 id", "target": "page"},
            {"id": "bad id", "title": "id 形态不合格", "target": "page"},
            {"id": "custom_x", "title": "", "target": "page"},
            {"id": "custom_y", "title": "跳转类型不在清单里", "target": "walk"},
            "not-a-dict",
            None,
        ]
        layout = home_layout.normalize_layout({"custom": broken + [GOOD_CUSTOM]})
        self.assertEqual([c["id"] for c in layout["custom"]], ["custom_1"],
                         "三件不齐的自建卡不落盘，一份坏版式拖不垮首页")
        card = layout["custom"][0]
        self.assertEqual(card["section"], "create")
        self.assertEqual(card["value"], "gallery")
        self.assertEqual(card["icon"], "file")
        self.assertEqual(card["sub"], "每周汇总")

    def test_custom_card_shape_only_fields(self):
        layout = home_layout.normalize_layout({"custom": [{
            "id": "custom_2", "section": "不存在的板块", "title": "外链卡", "target": "url",
            "url": "javascript:alert(1)", "icon": "x" * 90, "value": "y" * 400, "sub": "z" * 300,
        }]})
        card = layout["custom"][0]
        self.assertEqual(card["section"], "", "板块名只认 id 形态，认不出就落回默认板块")
        self.assertEqual(card["url"], "", "非 http(s) 的 scheme 不进文件")
        self.assertEqual(len(card["icon"]), home_layout._MAX_ICON)
        self.assertEqual(len(card["value"]), home_layout._MAX_VALUE)
        self.assertEqual(len(card["sub"]), home_layout._MAX_SUB)

        layout = home_layout.normalize_layout({"custom": [{
            "id": "custom_3", "title": "https 卡", "target": "url", "url": "  HTTPS://a.test/x  "}]})
        self.assertEqual(layout["custom"][0]["url"], "HTTPS://a.test/x", "scheme 大小写都认")

    def test_custom_cards_capped(self):
        items = [{**GOOD_CUSTOM, "id": f"custom_{n}"} for n in range(home_layout._MAX_CUSTOM + 8)]
        self.assertEqual(len(home_layout.normalize_layout({"custom": items})["custom"]),
                         home_layout._MAX_CUSTOM)

    def test_broken_file_falls_back_to_blank(self):
        _layout_path(self.root).parent.mkdir(parents=True, exist_ok=True)
        _layout_path(self.root).write_text("{not json", encoding="utf-8")
        body = _payload(asyncio.run(home_layout.layout_route(_request())))
        self.assertEqual(body, home_layout.DEFAULT_LAYOUT,
                         "读坏的版式等于没有版式，首页不许空屏")

        _layout_path(self.root).write_text(json.dumps({"sections": "junk", "cols": "x",
                                                       "custom": "no", "hero": 5}), encoding="utf-8")
        self.assertEqual(home_layout.get_layout(), home_layout.DEFAULT_LAYOUT)

    def test_builtin_card_moves_out_of_home_and_back(self):
        """内置卡删掉再加回来：后端只动 hidden，order 里那一格一直留着，加回来就落回原位。"""
        full = ["paint", "video", "director", "pose", "agent", "voice"]
        layout = _payload(asyncio.run(home_layout.save_layout_route(
            _request(body={"order": {"create": full}, "hidden": ["video"]}))))["layout"]
        self.assertEqual(layout["hidden"], ["video"], "移出首页记进 hidden")
        self.assertEqual(layout["order"]["create"], full,
                         "order 里那一格留着：加回来落回原来的位置，不排到末尾")
        back = _payload(asyncio.run(home_layout.save_layout_route(_request(body={
            "order": {"create": full + ["custom_9"]}, "hidden": [],
            "custom": [{"id": "custom_9", "section": "create", "title": "外链卡",
                        "target": "url", "url": "https://ex.com/a"}]}))))["layout"]
        self.assertEqual(back["hidden"], [], "加回来就是摘掉 hidden 这一项")
        self.assertEqual(back["order"]["create"], full + ["custom_9"],
                         "表单建的自建卡排在板块末尾")
        self.assertEqual([c["id"] for c in back["custom"]], ["custom_9"])

    def test_reset_deletes_the_file(self):
        asyncio.run(home_layout.save_layout_route(
            _request(body={"cols": 5, "hero": {"title": "改过的标题"}})))
        self.assertTrue(_layout_path(self.root).exists())
        body = _payload(asyncio.run(home_layout.reset_layout_route(_request())))
        self.assertEqual(body["layout"], home_layout.DEFAULT_LAYOUT)
        self.assertFalse(_layout_path(self.root).exists(), "恢复默认就是删掉存盘那一份")
        self.assertEqual(home_layout.get_layout(), home_layout.DEFAULT_LAYOUT)

    def test_reset_without_a_file_is_not_an_error(self):
        body = _payload(asyncio.run(home_layout.reset_layout_route(_request())))
        self.assertTrue(body["success"])
        self.assertEqual(body["layout"], home_layout.DEFAULT_LAYOUT)

    def test_save_leaves_only_the_layout_file(self):
        for title in ("第一次", "第二次", "第三次"):
            asyncio.run(home_layout.save_layout_route(_request(body={"hero": {"title": title}})))
        configs = self.root / "configs"
        self.assertEqual([p.name for p in configs.iterdir()], ["home_layout.json"],
                         "原子替换不许留下 .tmp 之类的残骸")
        self.assertEqual(
            json.loads(_layout_path(self.root).read_text(encoding="utf-8"))["hero"]["title"],
            "第三次")

    def test_unreadable_and_non_object_body_rejected(self):
        resp = asyncio.run(home_layout.save_layout_route(_request(invalid_json=True)))
        self.assertEqual(resp.status, 400)
        self.assertFalse(_payload(resp)["success"])
        self.assertFalse(_layout_path(self.root).exists(), "拒收时不落盘")

        for body in ([], "版式", None, 7):
            resp = asyncio.run(home_layout.save_layout_route(_request(body=body)))
            self.assertEqual(resp.status, 400, f"{body!r} 不是一个版式对象")
            self.assertFalse(_layout_path(self.root).exists())

    def test_non_dict_patch_normalizes_to_blank(self):
        for patch in (None, [], "版式", 7):
            self.assertEqual(home_layout.normalize_layout(patch), home_layout.DEFAULT_LAYOUT)

    def test_blank_is_a_fresh_copy_each_time(self):
        blank = home_layout._blank()
        blank["sections"].append("create")
        blank["hero"]["title"] = "污染"
        blank["hidden"].append("paint")
        self.assertEqual(home_layout.DEFAULT_LAYOUT["sections"], [],
                         "空版式逐次新建，改一份不能串到下一份")

    def test_routes_are_the_three_home_layout_paths(self):
        self.assertEqual([(r.method, r.path) for r in home_layout.routes],
                         [("GET", "/neo_home/layout"), ("POST", "/neo_home/layout"),
                          ("POST", "/neo_home/layout/reset")])
        self.assertEqual(home_layout.CUSTOM_TARGETS, ("edit", "url", "recipe", "skill", "page"),
                         "自建卡的跳转类型清单与前端 HOME_TARGETS 同源；page 只在末尾，"
                         "为的是旧版式里存着的直连卡照读照跳，卡片弹窗已不给这一项")


if __name__ == "__main__":
    unittest.main()
