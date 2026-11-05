import json
import os
import pathlib
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

_APP_DIR = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_APP_DIR))
import studio_pose as sp

WINDOWS_ONLY = unittest.skipUnless(os.name == "nt", "robocopy 镜像只在 Windows 跑")
HAS_NODE = shutil.which("node") is not None
NODE_ONLY = unittest.skipUnless(HAS_NODE, "索引重建要 node")

IDX_JS = """// fixture 的合并索引构建：形状照真 poseLib.mjs 的 merged（3dpose.index/1 + charKey 进条目）
import fs from "node:fs";
import path from "node:path";
const repo = import.meta.dirname.replaceAll("\\\\", "/").slice(0, -8);
const out = process.argv.indexOf("--out");
const file = out > -1 ? process.argv[out + 1] : null;
if (!file) { console.error("need --out"); process.exit(2); }
const dir = path.join(repo, "pose-lab", "poses");
const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -11)) : [];
const entries = ids.map((id) => ({ id, label: id, groups: ["stand"], charKey: process.env.FIXTURE_CHAR || "bodyMale",
  path: "poses/" + id + ".scene.json", preview: { clay: "preview/" + id + ".clay.png" } }));
fs.writeFileSync(file, JSON.stringify({ format: "3dpose.index/1", count: entries.length, entries }));
"""


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _make_repo(root: pathlib.Path) -> pathlib.Path:
    """一个最小摆姿仓库：pose-lib（预设集）+ pose-lab（本地集）+ dist（构建产物）+ 索引脚本。"""
    _write(root / "package.json", "{}")
    _write(root / "scripts" / "poseLib.mjs", IDX_JS)
    _write(root / "pose-lib" / "poses" / "p1.scene.json", "{}")
    _write(root / "pose-lib" / "preview" / "p1.clay.png", "clay")
    _write(root / "pose-lib" / "preview" / "p1.depth.png", "depth")
    _write(root / "pose-lib" / "ATTRIBUTION.md", "attribution")
    _write(root / "pose-lab" / "poses" / "p1.scene.json", "lab")
    _write(root / "pose-lab" / "poses" / "p2.scene.json", "{}")
    _write(root / "pose-lab" / "preview" / "p1.clay.png", "clay-lab")
    _write(root / "pose-lib" / "preview" / "p2.clay.png", "clay")
    _write(root / "pose-lib" / "categories.json", "{}")
    _write(root / "dist" / "index.html", "<html></html>")
    _write(root / "dist" / "models" / "bodyMale.glb", "glb-m")
    _write(root / "dist" / "models" / "bodyFemale.glb", "glb-f")
    _write(root / "dist" / "assets" / "app.js", "js")
    _write(root / "dist" / "app.js.map", "map")
    _write(root / "LICENSE", "mit")
    return root



class RepoDiscoveryTests(unittest.TestCase):
    def test_config_path_then_env_then_sibling(self):
        with tempfile.TemporaryDirectory() as tmp:
            t = pathlib.Path(tmp)
            repo = _make_repo(t / "repo")
            comfy = t / "ComfyUI"
            comfy.mkdir()
            (comfy / "main.py").write_text("", encoding="utf-8")
            sibling = _make_repo(t / "3d-pose-art")
            self.assertEqual(sp.find_pose_repo({"pose_repo": str(repo)}, comfy), repo)
            with patch.dict(os.environ, {sp.POSE_ENV_KEY: str(repo)}):
                self.assertEqual(sp.find_pose_repo({}, comfy), repo)
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(sp.find_pose_repo({}, comfy), sibling,
                                 "装机习惯：仓库与 ComfyUI 并排放时自己找得到")
            self.assertIsNone(sp.find_pose_repo({}, None))
            self.assertIsNone(sp.pose_repo_dir(str(t)), "没有 pose-lib 容器就不是仓库根")
            self.assertIsNone(sp.pose_repo_dir("repo/relative"), "相对路径不认")

    def test_auto_sync_without_a_repo_is_a_no_op(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = sp.auto_sync(pathlib.Path(tmp), None, lambda line: None)
            self.assertEqual(out["repo"], "")
            self.assertEqual((out["dist"], out["lib"]), (0, 0))
            self.assertIn("未配置", out["skipped"])


@WINDOWS_ONLY
class DistSyncTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._tmp.name)
        self.repo = _make_repo(self.tmp / "repo")
        self.data = self.tmp / "data"
        self.data.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_first_run_populates_dist(self):
        out = sp.sync_dist(self.repo, self.data)
        dist = self.data / "pose" / "dist"
        self.assertTrue((dist / "index.html").is_file())
        self.assertTrue((dist / "models" / "bodyMale.glb").is_file())
        self.assertTrue((dist / "models" / "bodyFemale.glb").is_file())
        self.assertTrue((dist / "assets" / "app.js").is_file())
        self.assertTrue((dist / "app.js.map").is_file(), "sourceMap 原样进数据根，tools 脚本的口径")
        self.assertTrue((dist / "LICENSE").is_file(), "MIT 许可证跟着产物落进去")
        self.assertGreater(out["files"], 0)

    def test_second_run_copies_nothing(self):
        sp.sync_dist(self.repo, self.data)
        out = sp.sync_dist(self.repo, self.data)
        self.assertEqual(out["files"], 0, "源没变化时重复启动跑不出文件复制")

    def test_deleted_files_come_back_and_imported_bodies_survive(self):
        dist = self.data / "pose" / "dist"
        sp.sync_dist(self.repo, self.data)
        (dist / "models" / "bodyMale.glb").unlink()
        _write(dist / "models" / "my_body.glb", "mine")
        out = sp.sync_dist(self.repo, self.data)
        self.assertTrue((dist / "models" / "bodyMale.glb").is_file(),
                        "手动删过的产物下一轮启动原样补回")
        self.assertTrue((dist / "models" / "my_body.glb").is_file(),
                        "用户导入的自备素体不在镜像结果里：先存后还")
        self.assertGreater(out["files"], 0)


@WINDOWS_ONLY
@NODE_ONLY
class LibSyncTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._tmp.name)
        self.repo = _make_repo(self.tmp / "repo")
        self.data = self.tmp / "data"
        self.data.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _index(self):
        return json.loads((self.data / "pose" / "lib" / "index.json").read_text(encoding="utf-8"))

    def test_first_run_merges_lib_and_rebuilds_index(self):
        out = sp.sync_lib(self.repo, self.data)
        lib = self.data / "pose" / "lib"
        self.assertEqual((lib / "poses" / "p1.scene.json").read_text(encoding="utf-8"), "lab",
                        "同 id 以本地那份为准，与 sync_pose_lib.ps1 同一条优先口径")
        self.assertTrue((lib / "poses" / "p2.scene.json").is_file(), "只属于预设集的那份要进来")
        self.assertEqual((lib / "preview" / "p1.clay.png").read_text(encoding="utf-8"), "clay-lab")
        self.assertTrue((lib / "preview" / "p2.clay.png").is_file(), "预览也要逐条补齐")
        self.assertFalse((lib / "preview" / "p1.depth.png").exists(), "默认档不带 depth 预览")
        self.assertTrue((lib / "ATTRIBUTION.md").is_file())
        self.assertTrue((lib / "categories.json").is_file())
        self.assertTrue((lib / "LICENSE").is_file())
        self.assertEqual(sorted(e["id"] for e in self._index()["entries"]), ["p1", "p2"])
        self.assertTrue(all(e.get("charKey") for e in self._index()["entries"]),
                        "charKey 进条目：场景库的基座筛选靠它才有落点")
        self.assertTrue(out["index"])
        self.assertEqual(sp.sync_lib(self.repo, self.data)["files"], 0,
                         "源没变化时重复启动跑不出文件复制")

    def test_new_pose_triggers_sync_and_new_index(self):
        sp.sync_lib(self.repo, self.data)
        _write(self.repo / "pose-lab" / "poses" / "p3.scene.json", "{}")
        _write(self.repo / "pose-lab" / "preview" / "p3.clay.png", "clay")
        out = sp.sync_lib(self.repo, self.data)
        self.assertGreater(out["files"], 0, "pose 数据更新后必须动手")
        self.assertTrue((self.data / "pose" / "lib" / "poses" / "p3.scene.json").is_file())
        self.assertEqual(sorted(e["id"] for e in self._index()["entries"]), ["p1", "p2", "p3"])

    def test_stale_depth_preview_gets_cleaned(self):
        lib = self.data / "pose" / "lib"
        sp.sync_lib(self.repo, self.data)
        _write(lib / "preview" / "old.depth.png", "depth")
        _write(self.repo / "pose-lab" / "poses" / "p3.scene.json", "{}")
        sp.sync_lib(self.repo, self.data)
        self.assertFalse((lib / "preview" / "old.depth.png").exists(),
                        "上一版留下的 depth 预览在同步时清掉，页面不会端着 404 的缩略图")

    def test_old_index_without_charkey_gets_rebuilt(self):
        lib = self.data / "pose" / "lib"
        _write(lib / "poses" / "p1.scene.json", "{}")
        _write(lib / "preview" / "p1.clay.png", "clay")
        _write(lib / "index.json", json.dumps(
            {"format": "3dpose.index/1", "count": 1,
             "entries": [{"id": "p1", "label": "p1", "groups": ["stand"],
                          "path": "poses/p1.scene.json",
                          "preview": {"clay": "preview/p1.clay.png"}}]}))
        out = sp.sync_lib(self.repo, self.data)
        self.assertTrue(out["index"], "旧版清单没有基座字段：基座筛选没有落点，重建一次补上")
        self.assertTrue(all(e.get("charKey") for e in self._index()["entries"]))
        self.assertTrue((lib / "poses" / "p2.scene.json").is_file())

    def test_ship_only_repo_mirrors_from_pose_lib(self):
        shutil.rmtree(self.repo / "pose-lab")
        out = sp.sync_lib(self.repo, self.data)
        self.assertIsNotNone(out)
        lib = self.data / "pose" / "lib"
        self.assertEqual((lib / "poses" / "p1.scene.json").read_text(encoding="utf-8"), "{}",
                        "没有本地集时镜像预设集那一份")
        self.assertTrue((lib / "preview" / "p1.clay.png").is_file())
        self.assertFalse((lib / "preview" / "p1.depth.png").exists())

    def test_missing_source_levels_skip_their_side(self):
        shutil.rmtree(self.repo / "dist")
        shutil.rmtree(self.repo / "pose-lib" / "poses")
        shutil.rmtree(self.repo / "pose-lab")
        out = sp.auto_sync(self.data, self.repo, lambda line: None)
        self.assertEqual((out["dist"], out["lib"], out["index"]), (0, 0, False),
                         "源缺哪级跳哪级：没构建过、没有库都不许洗数据根")
        self.assertIn("dist", out["skipped"])
        self.assertFalse((self.data / "pose" / "dist").exists())

    def test_auto_sync_reports_the_run(self):
        out = sp.auto_sync(self.data, self.repo, lambda line: None)
        self.assertGreater(out["dist"], 0)
        self.assertGreater(out["lib"], 0)
        self.assertTrue(out["index"])
        self.assertEqual(out["repo"], str(self.repo))
        self.assertTrue({p.name for p in (self.data / "pose" / "dist" / "models").glob("*.glb")}
                        >= {"bodyMale.glb", "bodyFemale.glb"},
                        "数据根补齐标准基座素体，页面开局的 bodyMale 才有文件挂着")

        self.assertFalse((self.data / "pose" / "_sync_stash").exists())
