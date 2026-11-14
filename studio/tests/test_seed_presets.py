# SPDX-License-Identifier: Apache-2.0
"""内置预设播种（studio/plugin_paths.py）离线单测。

出厂预设改了，已装机的数据根必须自己跟上，否则改动对用户就是零效果；跟上又不能吃掉用户的
自定义。这里钉的就是这两条：没人动过的出厂副本随代码换新，动过的一个字都不改，老数据根靠
一次性补键搬进新增的键。全程在临时目录里造插件目录与数据根，碰不到真实 Neo-Studio/data。
"""

import importlib
import json
import tempfile
import unittest
from pathlib import Path

plugin_paths = importlib.import_module("studio.plugin_paths")   # conftest.py 把 studio 顶成占位包

R2V_CONFIG = "skills/presets/minimax-h3-r2v/config.json"
R2V_MODELS = "skills/presets/minimax-h3-r2v/models.json"
SHIP_SKILL = "skills/presets/effect_h3/config.json"


def _write(root: Path, rel: str, payload) -> Path:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    text = payload if isinstance(payload, str) else json.dumps(payload, indent=2, ensure_ascii=False)
    target.write_text(text, encoding="utf-8")
    return target


class SeedSyncTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="neo_seed_")
        self.addCleanup(self._tmp.cleanup)
        self.plugin = Path(self._tmp.name) / "plugin"
        self.root = Path(self._tmp.name) / "data"
        _write(self.plugin, "configs/llm_providers.json", {"providers": [{"id": "x"}]})
        _write(self.plugin, SHIP_SKILL, {"effect": "bullet_time", "effects": [{"id": "bullet_time"}]})
        _write(self.plugin, R2V_CONFIG, {"width": 960, "steps": 20, "effect": "none", "effects": [{"id": "none"}]})
        _write(self.plugin, R2V_MODELS, {"family": "minimax_h3", "files": [{"filename": "a.safetensors"}]})
        self.root.mkdir(parents=True)

    def seed(self):
        plugin_paths.seed_presets(plugin_dir=self.plugin, data_root=self.root)

    def _stamp(self) -> dict:
        cfg = json.loads((self.root / plugin_paths.SEED_STAMP_REL).read_text(encoding="utf-8"))
        return cfg["files"]

    def test_seed_fills_a_fresh_data_root(self):
        self.seed()
        self.assertEqual(json.loads((self.root / R2V_CONFIG).read_text(encoding="utf-8"))["effect"], "none")
        self.assertIn(R2V_CONFIG, self._stamp())
        self.assertEqual(len(self._stamp()), 4)

    def test_unmodified_shipped_copy_moves_forward(self):
        self.seed()
        _write(self.plugin, R2V_CONFIG, {"width": 960, "steps": 30, "effect": "none", "effects": []})
        self.seed()
        cfg = json.loads((self.root / R2V_CONFIG).read_text(encoding="utf-8"))
        self.assertEqual(cfg["steps"], 30, "没人动过的出厂副本要随代码换新")

    def test_user_edited_copy_survives(self):
        self.seed()
        _write(self.root, R2V_CONFIG, {"width": 960, "steps": 8, "effect": "bullet_time"})
        self.seed()
        cfg = json.loads((self.root / R2V_CONFIG).read_text(encoding="utf-8"))
        self.assertEqual((cfg["steps"], cfg["effect"]), (8, "bullet_time"), "用户改过的不覆盖")

    def test_legacy_copy_gets_only_the_missing_keys(self):
        """老数据根没有指纹可判：缺的键补进去，用户钉过的 steps 一字不动。"""
        _write(self.root, R2V_CONFIG, {"width": 960, "height": 544, "steps": 8, "max_refs": 9})
        self.seed()
        cfg = json.loads((self.root / R2V_CONFIG).read_text(encoding="utf-8"))
        self.assertEqual((cfg["steps"], cfg["effect"], len(cfg["effects"])), (8, "none", 1))

    def test_filled_copy_keeps_its_own_values_after_a_shipped_change(self):
        _write(self.root, R2V_CONFIG, {"steps": 8})
        self.seed()
        _write(self.plugin, R2V_CONFIG, {"width": 960, "steps": 20, "effect": "none",
                                         "effects": [{"id": "none"}], "max_refs": 9})
        self.seed()
        cfg = json.loads((self.root / R2V_CONFIG).read_text(encoding="utf-8"))
        self.assertEqual((cfg["steps"], cfg["max_refs"]), (8, 9), "补过键的副本只补缺失键，值照留")

    def test_seed_is_idempotent(self):
        self.seed()
        first = (self.root / R2V_CONFIG).read_text(encoding="utf-8")
        stamp = self._stamp()
        self.seed()
        self.assertEqual((self.root / R2V_CONFIG).read_text(encoding="utf-8"), first)
        self.assertEqual(self._stamp(), stamp)

    def test_stamp_cache_is_deletable(self):
        self.seed()
        (self.root / plugin_paths.SEED_STAMP_REL).unlink()
        _write(self.root, SHIP_SKILL, {"effect": "bullet_time", "effects": [{"id": "frozen_moment"}]})
        self.seed()   # 指纹没了就只补缺，绝不覆盖存量副本
        self.assertEqual(len(json.loads((self.root / SHIP_SKILL).read_text(encoding="utf-8"))["effects"]), 1)

    def test_corrupt_stamp_does_not_break_the_seed(self):
        self.root.joinpath("configs").mkdir(parents=True, exist_ok=True)
        _write(self.root, plugin_paths.SEED_STAMP_REL, "{not json")
        self.seed()
        self.assertTrue((self.root / R2V_MODELS).is_file())

    def test_data_root_inside_plugin_dir_seeds_nothing(self):
        plugin_paths.seed_presets(plugin_dir=self.plugin, data_root=self.plugin)
        self.assertFalse((self.plugin / plugin_paths.SEED_STAMP_REL).exists())

    def test_shipped_reference_presets_carry_the_effect_table(self):
        """出厂数据自检：两条全参考预设带无特效默认的特效表，且声明同一批特效本体。"""
        with tempfile.TemporaryDirectory(prefix="neo_seed_ship_") as tmp:
            fresh = Path(tmp)
            plugin_paths.seed_presets(plugin_dir=plugin_paths.PLUGIN_DIR, data_root=fresh)
            for slug in ("minimax-h3-r2v", "minimax-h3-vdn-r2v"):
                cfg = json.loads((fresh / "skills/presets" / slug / "config.json").read_text(encoding="utf-8"))
                self.assertEqual(cfg["effect"], "none")
                self.assertEqual([e["id"] for e in cfg["effects"]][0], "none")
                self.assertNotIn("frozen_moment", [e["id"] for e in cfg["effects"]])
                self.assertEqual(len(cfg["effects"]), 11)
                man = json.loads((fresh / "skills/presets" / slug / "models.json").read_text(encoding="utf-8"))
                self.assertEqual(len(man["files"]), 10)


if __name__ == "__main__":
    unittest.main()
