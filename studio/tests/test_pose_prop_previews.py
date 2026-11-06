# SPDX-License-Identifier: Apache-2.0
"""云端道具预览图脚本（tools/pose_prop_previews.py）的离线单测。

这条脚本只做一件事：把云端索引里没写 preview 的道具行补上预览路径，图取来源页对同一件模型的官方渲染。
来源解析、行筛选与索引写入全在本地算得完，上传要 --apply 与真凭据 —— 用例不碰网络，也不动云端。
"""

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location("pose_prop_previews", ROOT / "tools" / "pose_prop_previews.py")
previews = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(previews)

PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 24


def write(path: Path, data) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data, encoding="utf-8")
    else:
        path.write_bytes(data)
    return path


def cloud_index(props: list) -> dict:
    return {"format": "neo-pose-cloud/1", "count": 1,
            "entries": [{"id": "a", "label": "A 站姿", "path": "poses/stand/a.scene.json"}],
            "props": props}

class RowSelectionTests(unittest.TestCase):
    """哪些行要补图：面板看得见的、行里还没写 preview 的那批。"""

    ROWS = [
        {"id": "katana", "label": "武士刀（古）", "file": "katana.glb",
         "source": "https://polyhaven.com/a/antique_katana_01",
         "registry": {"file": "katana.glb", "label": "武士刀（古）", "scale": 1.003}},
        {"id": "stick", "label": "棍", "file": "stick.glb", "source": "pose-repo",
         "registry": {"file": "stick.glb", "label": "棍", "scale": 1}},
        {"id": "sword", "label": "剑（自制）", "file": "sword.glb", "source": "pose-repo",
         "registry": {"file": "sword.glb", "label": "剑（自制）", "scale": 1, "hidden": True}},
        {"id": "staff", "label": "齐眉棍", "file": "staff.glb", "source": "blenderkit",
         "registry": {"file": "staff.glb", "label": "齐眉棍", "scale": 1.997,
                      "preview": "preview/staff.png"}},
    ]

    def test_hidden_cards_and_rows_with_a_preview_are_left_alone(self):
        """hidden 行不进面板卡片，已写 preview 的行不动：补图只补面板上看得见又还没图的那批。"""
        rows = previews.visible_rows(cloud_index(self.ROWS), [])
        self.assertEqual([r["id"] for r in rows], ["katana", "stick"])

    def test_wanted_ids_take_the_bare_glb_name_too(self):
        """--props katana 与 --props katana.glb 是同一件：道具注册表的键就是裸文件名。"""
        rows = previews.visible_rows(cloud_index(self.ROWS), ["katana.glb"])
        self.assertEqual([r["id"] for r in rows], ["katana"])

    def test_preview_rel_is_the_registry_relative_form(self):
        """preview 写的是道具目录里的相对路径：读侧 _prop_row 与面板拼的 OSS 键都吃这一形。"""
        row = {"file": "dagger_medieval.glb", "registry": {}}
        self.assertEqual(previews.preview_rel(row), "preview/dagger_medieval.png")
        self.assertEqual(previews.row_id(row), "dagger_medieval")


class SourceResolutionTests(unittest.TestCase):
    """一件的图从哪来：注册表行自己登记的来源页，不在这里猜第二个来源。"""

    def test_polyhaven_thumbnail_moves_to_the_card_size(self):
        """来源页默认给 256 档：摆到卡片上是糊的，档位改到卡片那一档，版本号留着。"""
        url = previews.card_size_thumb(
            "https://cdn.polyhaven.com/asset_img/thumbs/machete.png?width=256&height=256&format=webp&v=638aca1b")
        self.assertIn(f"width={previews.PREVIEW_SIDE}", url)
        self.assertIn(f"height={previews.PREVIEW_SIDE}", url)
        self.assertIn("format=png", url)
        self.assertIn("v=638aca1b", url)
        self.assertTrue(url.startswith("https://cdn.polyhaven.com/asset_img/thumbs/machete.png?"))

    def test_blendkit_takes_the_largest_thumbnail_and_strips_the_padding(self):
        """BlenderKit 的 URL 字段两头带空格：不去掉就是 urllib 报 unknown url type。"""
        payload = {"files": [
            {"fileType": "MODEL", "thumbnailLargeUrlNonsquared": None},
            {"fileType": "THUMBNAIL", "thumbnailSmallUrl": " https://cdn.example/small.jpg ",
             "thumbnailLargeUrlNonsquared": " https://cdn.example/large.jpg "},
        ]}
        with mock.patch.object(previews, "json_get", lambda url: payload):
            self.assertEqual(previews.blendkit_thumb("https://www.blendkit.com/api/v1/assets/x/"),
                             "https://cdn.example/large.jpg")

    def test_self_made_prop_copies_the_shipped_render(self):
        """自制道具没有上游：随包那张就是姿势仓库渲的，原样搬过来，不渲第二遍。"""
        row = {"id": "stick", "file": "stick.glb", "source": "pose-repo", "registry": {}}
        with tempfile.TemporaryDirectory() as tmp:
            shipped = Path(tmp)
            write(shipped / "preview" / "stick.png", PNG)
            dest = Path(tmp) / "out" / "preview" / "stick.png"
            with mock.patch.object(previews, "SHIPPED_PREVIEWS", shipped):
                self.assertEqual(previews.copy_shipped_preview(row, dest), "")
            self.assertEqual(dest.read_bytes(), PNG)

    def test_self_made_prop_without_a_render_names_the_render_to_run(self):
        """随包没那张图就说得清去哪张：跑姿势仓库的 npm run prop:preview，不在这里编一张。"""
        row = {"id": "stick", "file": "stick.glb", "source": "pose-repo", "registry": {}}
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "preview" / "stick.png"
            with mock.patch.object(previews, "SHIPPED_PREVIEWS", Path(tmp) / "props"):
                note = previews.copy_shipped_preview(row, dest)
        self.assertIn("npm run prop:preview", note)
        self.assertFalse(dest.exists())

    def test_a_row_without_a_source_home_says_so(self):
        """注册表行既没有 assetUrl 也没有可取图的 source：这一件就是没图，卡片出「无预览」。"""
        row = {"id": "mystery", "file": "mystery.glb", "registry": {}}
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "preview" / "mystery.png"
            note = previews.render_preview(row, dest)
        self.assertIn("source", note)
        self.assertFalse(dest.exists())


class IndexWriteTests(unittest.TestCase):
    """写出去的那两份索引：改后的只多 registry.preview，改前那份原样留着。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.index_file = self.root / "index.json"
        write(self.index_file, json.dumps(cloud_index([
            {"id": "katana", "label": "武士刀（古）", "file": "katana.glb",
             "source": "https://polyhaven.com/a/antique_katana_01",
             "registry": {"file": "katana.glb", "label": "武士刀（古）", "scale": 1.003}},
            {"id": "sword", "label": "剑（自制）", "file": "sword.glb", "source": "pose-repo",
             "registry": {"file": "sword.glb", "label": "剑（自制）", "scale": 1, "hidden": True}},
        ]), ensure_ascii=False))
        self.out = self.root / "out"

    def tearDown(self):
        self._tmp.cleanup()

    def run_main(self) -> tuple:
        out = io.StringIO()
        argv = ["pose_prop_previews.py", "--index", str(self.index_file), "--out", str(self.out)]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(out):
            code = previews.main()
        return code, out.getvalue()

    @staticmethod
    def paint(row, dest):
        write(dest, PNG)
        return ""

    def test_dry_run_writes_no_cloud_and_lists_the_keys_it_would_put(self):
        """默认 dry-run：只出本地图与清单，云端一个字都不写。"""
        with mock.patch.object(previews, "render_preview", self.paint):
            code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("[DRY RUN]", out)
        self.assertIn("neo/pose/props/preview/katana.png", out)
        self.assertNotIn("sword", out)   # hidden 行不发图

    def test_patched_index_adds_only_the_preview_key(self):
        """索引只往注册表行加 preview 一个键：条数与场景条目一字不改，原样那份留在 index.before.json。"""
        before = json.loads(self.index_file.read_text(encoding="utf-8"))
        with mock.patch.object(previews, "render_preview", self.paint):
            code, out = self.run_main()
        self.assertEqual(code, 0, out)
        after = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(after["count"], before["count"])
        self.assertEqual(after["entries"], before["entries"])
        katana, sword = after["props"]
        self.assertEqual(katana["registry"]["preview"], "preview/katana.png")
        self.assertEqual(set(katana["registry"]) - set(before["props"][0]["registry"]), {"preview"})
        self.assertNotIn("preview", sword["registry"])
        self.assertEqual(json.loads((self.out / "index.before.json").read_text(encoding="utf-8")), before)

