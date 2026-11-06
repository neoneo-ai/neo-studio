# SPDX-License-Identifier: Apache-2.0
"""云端姿势上传脚本（tools/pose_deploy_oss.py）的清单构建离线单测。

上传侧产的那棵树就是读侧（studio/pose_cloud.py）认的形状：索引只留文件真在着的那批条目，
道具只留授权行给「可再分发」的那几条，且每条带着姿势仓库注册表里的原行（scale 与握点）。
这两条口径在脚本里，跑不到 OSS 上也能测 —— 上传本身要 --apply 与真凭据，用例不碰网络。
全程在临时目录里照姿势仓库的形状搭一份：pose-lib/ + dist/models/props/ + public/models/ATTRIBUTION.md。
"""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location("pose_deploy_oss", ROOT / "tools" / "pose_deploy_oss.py")
deploy = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(deploy)
_SPEC_PRUNE = importlib.util.spec_from_file_location("pose_prune_oss", ROOT / "tools" / "pose_prune_oss.py")
prune = importlib.util.module_from_spec(_SPEC_PRUNE)
_SPEC_PRUNE.loader.exec_module(prune)

SCENE = json.dumps({"format": "3dpose.scene/1", "characters": []}, ensure_ascii=False)
PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 24
GLB = b"glTF\x02\x00\x00\x00" + b"\x00" * 12


def write(path: Path, data) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data, encoding="utf-8")
    else:
        path.write_bytes(data)
    return path


class CloudIndexTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.lib = Path(self._tmp.name)
        write(self.lib / "poses" / "stand" / "a.scene.json", SCENE)
        write(self.lib / "poses" / "stand" / "b.scene.json", SCENE)
        write(self.lib / "preview" / "a.clay.png", PNG)
        write(self.lib / "index.json", json.dumps({
            "format": "pose-lib/1",
            "groups": [{"id": "stand", "label": "站立"}],
            "entries": [
                {"id": "a", "label": "A 站姿", "path": "poses/stand/a.scene.json",
                 "groups": ["stand"], "categories": ["站立"], "tags": ["preset"],
                 "charKey": "bodyMale", "gender": "male", "people": 1, "props": 0,
                 "preview": {"clay": "preview/a.clay.png", "skeleton": "preview/a.skeleton.png"},
                 "license": "CC0", "updatedAt": "2026-11-01"},
                {"id": "b", "label": "B 站姿", "path": "poses/stand/missing.scene.json",
                 "groups": ["stand"], "preview": {}},
            ],
        }, ensure_ascii=False))

    def tearDown(self):
        self._tmp.cleanup()

    def test_index_keeps_only_entries_whose_scene_is_on_disk(self):
        """库里有一条清单指向的文件没同步过来：整条不进云端清单，卡片点了才不会只会失败。"""
        index = deploy.build_index(self.lib, [])
        self.assertEqual(index["format"], "neo-pose-cloud/1")
        self.assertEqual(index["count"], 1)
        self.assertEqual([e["id"] for e in index["entries"]], ["a"])
        self.assertEqual(index["groups"], [{"id": "stand", "label": "站立"}])

    def test_index_keeps_preview_sizes_with_a_file_behind_them(self):
        """预览图按档位登记，档位文件不在的一档不进条目：卡片缩略图按档位挑，缺的档不能报地址。"""
        entry = deploy.build_index(self.lib, [])["entries"][0]
        self.assertEqual(entry["preview"], {"clay": "preview/a.clay.png"})
        self.assertEqual(entry["size"], (self.lib / "poses" / "stand" / "a.scene.json").stat().st_size)

    def test_index_carries_the_fields_the_cards_read(self):
        """卡片与筛选读的字段逐条同名：基座分派（charKey / gender）、人数道具数、标签与授权。"""
        entry = deploy.build_index(self.lib, [])["entries"][0]
        self.assertEqual(entry["label"], "A 站姿")
        self.assertEqual(entry["charKey"], "bodyMale")
        self.assertEqual(entry["gender"], "male")
        self.assertEqual(entry["people"], 1)
        self.assertEqual(entry["tags"], ["preset"])
        self.assertEqual(entry["license"], "CC0")
        self.assertEqual(entry["path"], "poses/stand/a.scene.json")


class CloudPropTests(unittest.TestCase):
    """云端道具的口径：授权行给「可再分发」才发，发的那件带着它的注册表行走。

    页面对 GLB 先归一成「1 单位高」、再乘注册表行的 scale（握点也照那一行还原成米），注册表里
    没这一行的云端道具就是一把 1 米长的手枪 —— 发哪件由「授权行」与「注册表行」两条一起定。
    临时树照姿势仓库的形状搭：pose-lib/（--source）、dist/models/props/（注册表 + GLB）、
    public/models/ATTRIBUTION.md（授权）。
    """

    ATTRIBUTION = """# 素体模型来源与授权

| 文件 | 上游文件 | 作者 / 授权 | 说明 |
|---|---|---|---|
| `katana.glb` | `katana.fbx`（https://polyhaven.com/a/katana — CC0 1.0 公有领域，可商用可再分发，署名可选） | 见来源页授权 | 导入 |
| `gone.glb` | `gone.fbx`（https://polyhaven.com/a/gone — CC0 1.0 公有领域，可商用可再分发） | 见来源页授权 | 导入 |
| `stick.glb` | 无上游（脚本生成） | 本项目自制 | `makePropGlb.mjs` 生成：随产物分发（可再分发） |
| `sword.glb` | 无上游（脚本生成） | 本项目自制 | `makePropGlb.mjs` 生成：随产物分发 |
| `prop_test_box.glb` | 无上游（脚本生成） | 本项目自制 | 最小 glTF 箱体 |
| `arrow.glb` | `ARROW.obj`（本地下载，来源与授权待确认） | 见来源页授权 | 不随仓库分发 |
| `sword_thin.glb` | `sword_thin.glb`（BlenderKit（Royalty Free（免版税，可商用，署名要求见来源页））） | 见来源页授权 | 导入 |
| `mixamo_spear.glb` | `spear.fbx`（mixamo.com，Mixamo 授权仅个人使用） | Mixamo | 本地导入 |

> `stick.glb` / `sword.glb` / `prop_test_box.glb` 是脚本生成的自制道具：授权口径相同，可随产物与插件包分发。
"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        self.lib = self.repo / "pose-lib"
        self.props = self.repo / "dist" / "models" / "props"
        write(self.lib / "poses" / "stand" / "a.scene.json", SCENE)
        write(self.lib / "preview" / "a.clay.png", PNG)
        write(self.repo / "public" / "models" / "ATTRIBUTION.md", self.ATTRIBUTION)
        write(self.props / "index.json", json.dumps({"props": [
            {"file": "prop_test_box.glb", "label": "测试箱体", "scale": 1},
            {"file": "stick.glb", "label": "棍", "scale": 1, "preview": "preview/stick.png"},
            {"file": "sword.glb", "label": "剑（自制）", "scale": 1, "hidden": True,
             "preview": "preview/sword.png"},
            {"file": "katana.glb", "label": "武士刀（古）", "scale": 1.003,
             "standing": True, "grab": 0.26, "license": "CC0 (Poly Haven)"},
            {"file": "gone.glb", "label": "没同步过来的道具", "scale": 1},
            {"file": "arrow.glb", "label": "箭", "scale": 1},
            {"file": "sword_thin.glb", "label": "细身剑", "scale": 0.76},
            {"file": "mixamo_spear.glb", "label": "长矛", "scale": 1},
            {"file": "legacy_no_row.glb", "label": "没登记授权的道具", "scale": 1},
        ]}, ensure_ascii=False))
        for leaf in ("stick.glb", "sword.glb", "katana.glb", "arrow.glb", "sword_thin.glb",
                     "mixamo_spear.glb", "legacy_no_row.glb", "prop_test_box.glb"):
            write(self.props / leaf, GLB)
        write(self.props / "preview" / "stick.png", PNG)     # 棍的预览图真在道具目录里

    def tearDown(self):
        self._tmp.cleanup()

    def built(self, wanted=()):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rows = deploy.build_props(self.props, self.props / "index.json",
                                      self.repo / "public" / "models" / "ATTRIBUTION.md", list(wanted))
        return rows, out.getvalue()

    def test_cc0_and_self_made_props_publish_with_their_registry_row(self):
        """发上云的每一件都带着注册表那一行：scale 与握点一字不改，页面照它把道具摆成对的尺寸。"""
        rows, out = self.built()
        self.assertEqual([r["file"] for r in rows],
                         ["stick.glb", "sword.glb", "katana.glb"], out)
        katana = rows[-1]
        self.assertEqual(katana["registry"]["scale"], 1.003)
        self.assertTrue(katana["registry"]["standing"] and katana["registry"]["grab"])
        self.assertEqual(rows[0]["registry"]["preview"], "preview/stick.png",
                         "预览路径随注册表那一行一起上云：面板的缩略图与 GLB 是同一批到货")
        self.assertEqual(katana["size"], (self.props / "katana.glb").stat().st_size)
        self.assertEqual(katana["license"], "CC0 (Poly Haven)")
        self.assertEqual(katana["source"], "https://polyhaven.com/a/katana")
        # 注册表自己没登记授权的那两条（自制）从授权行读：来源页只在上游行里有
        self.assertEqual(rows[0]["license"], "本项目自制（可再分发）")
        self.assertEqual(rows[0]["source"], "pose-repo")

    def test_royalty_free_pending_and_personal_use_rows_are_not_published(self):
        """Royalty Free 只写可商用、「授权待确认」与 Mixamo「仅个人使用」：三条都不给再分发。"""
        rows, out = self.built()
        self.assertEqual([r["file"] for r in rows], ["stick.glb", "sword.glb", "katana.glb"], out)
        for leaf in ("arrow.glb", "sword_thin.glb", "mixamo_spear.glb"):
            self.assertIn(leaf, out)

    def test_registry_row_without_an_attribution_line_is_not_published(self):
        """注册表列了、授权文件里没有这一行：没授权的 GLB 不上公开 bucket。"""
        rows, out = self.built()
        self.assertNotIn("legacy_no_row.glb", [r["file"] for r in rows])
        self.assertIn("ATTRIBUTION.md 里没有这一行", out)

    def test_repository_bench_boxes_are_not_published(self):
        """授权干净不等于该给用户看：标签「测试箱体」「单测箱体」的是仓库自己的基准件。"""
        rows, out = self.built()
        self.assertNotIn("prop_test_box.glb", [r["file"] for r in rows])
        self.assertIn("基准件", out)

    def test_license_clean_prop_without_a_glb_on_disk_is_dropped(self):
        """授权干净但 GLB 不在道具目录里：登记一条上不了云的行，读侧就是一条永远 404 的道具。"""
        rows, out = self.built()
        self.assertNotIn("gone.glb", [r["file"] for r in rows])
        self.assertIn("GLB 不在", out)

    def test_wanted_names_narrow_the_publishable_set(self):
        """--props 只在授权行给再分发的那批里再挑：点名 Royalty Free 的那件也不发。"""
        rows, _ = self.built(["stick.glb", "sword_thin.glb"])
        self.assertEqual([r["file"] for r in rows], ["stick.glb"])

    def test_missing_registry_publishes_no_props(self):
        """读不到注册表就整批不发：场景照发，道具一条不登记（页面对空注册表出的是空清单）。"""
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rows = deploy.build_props(self.props / "nope", self.props / "nope.json",
                                      self.repo / "public" / "models" / "ATTRIBUTION.md", [])
        self.assertEqual(rows, [])
        self.assertIn("读不到道具注册表", out.getvalue())

    def test_collect_files_uploads_scenes_previews_and_the_prop_under_props(self):
        """上传清单带场景与预览图；道具落 props/ 前缀，读侧落点是 models/props/。"""
        rows, _ = self.built(["stick.glb"])
        rels = [rel for _, rel in deploy.collect_files(self.lib, self.props, rows)]
        self.assertIn("poses/stand/a.scene.json", rels)
        self.assertIn("preview/a.clay.png", rels)
        self.assertIn("props/stick.glb", rels)

    def test_collect_files_uploads_the_prop_preview_with_the_prop(self):
        """注册表写了 preview 且图真在道具目录里：预览图与 GLB 同一批上云，键同前缀。"""
        rows, _ = self.built(["stick.glb"])
        rels = [rel for _, rel in deploy.collect_files(self.lib, self.props, rows)]
        self.assertIn("props/preview/stick.png", rels)

    def test_collect_files_says_so_when_the_preview_row_has_no_file(self):
        """注册表承诺了预览图、文件不在道具目录里：清单里不能出现那条键，要说出来 ——
        半个文件上云就是面板上一张永远转圈的缩略图。"""
        rows, _ = self.built(["sword.glb"])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rels = [rel for _, rel in deploy.collect_files(self.lib, self.props, rows)]
        self.assertIn("props/sword.glb", rels)
        self.assertNotIn("props/preview/sword.png", rels)
        self.assertIn("preview", out.getvalue())

    def test_collect_files_skips_a_prop_with_no_glb_on_disk(self):
        """索引里登记过的道具在上传时文件不在，上传清单里不能出现那条 —— 半个文件上云就是读侧的 502。"""
        rows = [{"id": "unit-cloud-prop", "label": "unit", "file": "unit-cloud-prop.glb"}]
        rels = [rel for _, rel in deploy.collect_files(self.lib, self.props, rows)]
        self.assertEqual(rels, ["poses/stand/a.scene.json", "preview/a.clay.png"])


class CredentialTests(unittest.TestCase):
    """凭据取自 <数据根>/configs/backyard_oss.json（AGENTS：deploy 脚本凭据从这份读）。
    键名口径是 studio/backyard.py 那一份：bucket，不是 bucket_name —— 读错键就是「凭据不全」，
    脚本列得出清单却永远传不上去。命令行 > 环境变量 > 配置文件的优先级在 OSS_* 上跑，
    用例把环境清成已知的样子，否则机器上一条残留的 OSS_ENDPOINT 就把断言带跑了。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._env = mock.patch.dict(os.environ, {}, clear=True)
        self._env.start()
        self.config = Path(self._tmp.name) / "backyard_oss.json"
        write(self.config, json.dumps({
            "endpoint": "https://cn-hangzhou.oss.aliyuncs.com",
            "bucket": "mediai",
            "access_key_id": "id-from-config",
            "access_key_secret": "secret-from-config",
        }))
        self.args = argparse.Namespace(endpoint="", bucket="", access_key_id="",
                                       access_key_secret="", config=str(self.config))

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def test_creds_come_from_the_bucket_key_backyard_writes(self):
        creds = deploy.load_credentials(self.args)
        self.assertEqual(creds["bucket"], "mediai")
        self.assertEqual(creds["endpoint"], "https://cn-hangzhou.oss.aliyuncs.com")
        self.assertEqual(creds["key_id"], "id-from-config")
        self.assertEqual(creds["key_secret"], "secret-from-config")

    def test_command_line_beats_the_environment_and_the_config(self):
        with mock.patch.dict(os.environ, {"OSS_BUCKET": "from-env", "OSS_ENDPOINT": "https://from-env.example"}):
            creds = deploy.load_credentials(self.args)
            self.assertEqual(creds["bucket"], "from-env")
            self.assertEqual(creds["endpoint"], "https://from-env.example")
            self.args.bucket = "from-cli"
            self.assertEqual(deploy.load_credentials(self.args)["bucket"], "from-cli")

    def test_a_config_without_a_bucket_leaves_the_creds_incomplete(self):
        """没有 bucket 时这项是空串：main() 据此报「凭据不全」退出，不拿空 bucket 去连 OSS。"""
        write(self.config, json.dumps({"endpoint": "https://cn-hangzhou.oss.aliyuncs.com"}))
        creds = deploy.load_credentials(self.args)
        self.assertEqual(creds["bucket"], "")
        self.assertFalse(all([creds["endpoint"], creds["bucket"], creds["key_id"], creds["key_secret"]]))

    def test_missing_config_file_degrades_to_empty_creds(self):
        self.args.config = str(Path(self._tmp.name) / "nope.json")
        creds = deploy.load_credentials(self.args)
        self.assertEqual(creds["bucket"], "")
        self.assertEqual(creds["endpoint"], "")


class SourceGuardTests(unittest.TestCase):
    """--source 的口径：只发姿势仓库的随包预设库 pose-lib/。合并库 <数据根>/pose/lib 是
    pose-lib + pose-lab 两根的合并结果，条目带 origin —— pose-lab 是作者自己的实验姿态，
    授权与审校都没走到它头上，整棵传上云就是把没发布的姿态推到公开 bucket 上。
    白名单只挡道具，挡不住场景树，所以这一层在 main() 入口直接拒。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.lib = Path(self._tmp.name)
        write(self.lib / "poses" / "stand" / "a.scene.json", SCENE)
        write(self.lib / "preview" / "a.clay.png", PNG)

    def tearDown(self):
        self._tmp.cleanup()

    def write_index(self, entries: list):
        write(self.lib / "index.json", json.dumps(
            {"format": "3dpose.index/1", "count": len(entries), "entries": entries}, ensure_ascii=False))

    def run_main(self):
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["pose_deploy_oss.py", "--source", str(self.lib), "--props"]):
            with contextlib.redirect_stdout(out):
                code = deploy.main()
        return code, out.getvalue()

    def test_merged_index_with_origin_markers_is_refused(self):
        """合并库的条目带 origin（lab / lib）：见到就退出 1，云端与数据根一个字都不写。"""
        self.write_index([{
            "id": "a", "label": "A 站姿", "path": "poses/stand/a.scene.json",
            "groups": ["stand"], "origin": "lab", "preview": {"clay": "preview/a.clay.png"},
        }])
        code, out = self.run_main()
        self.assertEqual(code, 1, out)
        self.assertIn("合并库", out)
        self.assertIn("pose-lab", out)
        self.assertFalse((self.lib / "_cloud_index.json").exists())

    def test_shipped_index_without_origin_uploads_the_files_it_lists(self):
        """随包 pose-lib 的条目不带 origin：干跑照常列清单，条数就是索引点名的那一条。"""
        self.write_index([{
            "id": "a", "label": "A 站姿", "path": "poses/stand/a.scene.json",
            "groups": ["stand"], "preview": {"clay": "preview/a.clay.png"},
        }])
        code, out = self.run_main()
        self.assertEqual(code, 0, out)
        self.assertIn("[DRY RUN]", out)
        self.assertIn("neo/pose/poses/stand/a.scene.json", out)


class PruneAllowSetTests(unittest.TestCase):
    """清理脚本的允许集与上传脚本同口径：两处一 drift，云端就多出「索引没有的文件」或删掉「要留的文件」。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        self.lib = self.repo / "pose-lib"
        self.props = self.repo / "dist" / "models" / "props"
        write(self.lib / "poses" / "stand" / "a.scene.json", SCENE)
        write(self.lib / "preview" / "a.clay.png", PNG)
        write(self.repo / "public" / "models" / "ATTRIBUTION.md",
              "| `stick.glb` | 无上游（脚本生成） | 本项目自制 | 随产物分发 |\n"
              "| `arrow.glb` | 本地下载（来源与授权待确认） | 见来源页授权 | 不随仓库分发 |\n")
        write(self.props / "index.json", json.dumps({"props": [
            {"file": "stick.glb", "label": "棍", "scale": 1},
            {"file": "arrow.glb", "label": "箭", "scale": 1},
        ]}, ensure_ascii=False))
        write(self.props / "stick.glb", GLB)
        write(self.props / "arrow.glb", GLB)

    def tearDown(self):
        self._tmp.cleanup()

    def test_allow_set_keeps_the_licensed_props_and_the_index(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            keys = prune.allow_keys(self.lib, self.props,
                                    self.repo / "public" / "models" / "ATTRIBUTION.md", "neo/pose/")
        self.assertIn("neo/pose/poses/stand/a.scene.json", keys)
        self.assertIn("neo/pose/preview/a.clay.png", keys)
        self.assertIn("neo/pose/props/stick.glb", keys)
        self.assertIn("neo/pose/index.json", keys)
        self.assertNotIn("neo/pose/props/arrow.glb", keys, "授权不干净的道具不在允许集里 = 清理时删掉它")

    def test_prefix_forms_land_on_one_key_tree(self):
        """前缀写成 neo/pose、/neo/pose/ 与 neo/pose/ 都指同一棵树：允许集对不上就是「整棵都该删」。"""
        for raw in ("neo/pose", "/neo/pose/", "neo/pose/"):
            prefix = prune.normalize_prefix(raw)
            self.assertEqual(prefix, "neo/pose/", raw)
            with contextlib.redirect_stdout(io.StringIO()):
                keys = prune.allow_keys(self.lib, self.props,
                                        self.repo / "public" / "models" / "ATTRIBUTION.md", prefix)
            self.assertIn("neo/pose/poses/stand/a.scene.json", keys, raw)
            self.assertIn("neo/pose/props/stick.glb", keys, raw)


if __name__ == "__main__":
    unittest.main()
