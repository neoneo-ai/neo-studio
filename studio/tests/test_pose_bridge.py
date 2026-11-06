# SPDX-License-Identifier: Apache-2.0
"""「3D 姿势」桥接口（studio/pose.py）离线单测。

姿势页在 iframe 里跑，桥的契约是消息名而不是代码：宿主页面、姿势页、这份用例三处同名，
所以先把消息名与能力位钉死。其余用例覆盖 dist 子资源的路径包含、场景落盘与场景库伺服、ControlNet
图组导出到素材库，以及「姿势包没装」这条用户一定会撞上的路。全程只在根 conftest.py
钉住的临时数据根里读写。
"""

import asyncio
import base64
import contextlib
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from aiohttp import web

from stub_env import restore, snapshot

pose = importlib.import_module("studio.pose")   # conftest.py 把 studio 顶成占位包，插件入口不执行

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

GALLERY_STUB = "studio.gallery"


def _request(match_info=None, query=None, body=None):
    """假请求：这些 handler 只读 match_info、query、content_length 与 JSON body 四样。"""
    async def read_json():
        if body is None:
            raise ValueError("no body")
        return body

    return types.SimpleNamespace(
        match_info=match_info or {},
        rel_url=types.SimpleNamespace(query=query or {}),
        content_length=len(json.dumps(body)) if body is not None else 0,
        json=read_json)


def _run(handler, request):
    return asyncio.run(handler(request))


@contextlib.contextmanager
def no_package_copy():
    """把随包副本（studio/pose_dist）临时挪开：这几条用例要单独看数据根那一级。

    随包副本是仓库里的构建产物，装机后它一直在；「缺包」用例不挪开它就只能看到 installed=True。"""
    saved = pose.PACKAGE_DIST
    pose.PACKAGE_DIST = saved.parent / "pose_dist_missing_for_this_case"
    try:
        yield
    finally:
        pose.PACKAGE_DIST = saved


class _PoseCase(unittest.TestCase):
    """用例只在自己的临时姿势目录里建文件，收尾摘掉自己创建的那几份。"""

    def setUp(self):
        self.created = []
        pose.SCENES_DIR.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        for path in self.created:
            if path.is_file():
                path.unlink()

    def write(self, path: Path, text="") -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        self.created.append(path)
        return path

    def write_png(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(PNG)
        self.created.append(path)
        return path


class BridgeContractTests(unittest.TestCase):
    def test_bridge_message_names_are_the_contract(self):
        self.assertEqual(pose.BRIDGE_MESSAGES,
                         ("pose:ready", "pose:theme", "pose:export-image",
                          "pose:save-scene", "pose:open-scene",
                          "pose:call", "pose:state"))

    def test_caps_gate_the_sidecar_only_features(self):
        """姿势与导出在浏览器里跑，估点/网格/pano 要 pose-art 的 Python sidecar：
        桌面端进程起不动它，能力位必须是 False，页面据此置灰按钮。"""
        self.assertTrue(pose.BRIDGE_CAPS["pose"])
        self.assertTrue(pose.BRIDGE_CAPS["export"])
        for gated in ("photo3d", "mesh", "pano", "lib_write"):
            self.assertFalse(pose.BRIDGE_CAPS[gated], f"{gated} 要本机 sidecar，不能报可用")

    def test_caps_open_body_import(self):
        """自备素体导入是宿主自己那条路（写 GLB 进数据根 + 页面本地登记），不依赖 sidecar。"""
        self.assertTrue(pose.BRIDGE_CAPS["body_import"])

    def test_glb_cap_is_reachable_inside_the_body_cap(self):
        """素体上限要落在请求体上限之内：GLB 走 base64 进 JSON，编码后膨胀 4/3 再加 JSON 外壳。

        两条上限取同一句话的话，面板真发一份顶格的 GLB 会先撞请求体上限，接口里那条
        「GLB 超过 …」永远轮不到回答 —— 上限写了等于没写。
        """
        inflated = pose.MAX_GLB_BYTES * 4 // 3 + 4096   # 4096 给 key / filename 那层壳
        self.assertLess(inflated, pose.MAX_BODY_BYTES,
                        "按 MAX_GLB_BYTES 发一份 GLB，base64 后必须先撞请求体上限")
        self.assertGreater(pose.MAX_GLB_BYTES, 8 * 1024 * 1024,
                           "Mixamo 十几 MB 级的高模要落在限内，上限不许收成参考图那档")

    def test_caps_announce_host_ui_panel(self):
        """宿主自带控件面板：能力位为真，姿势页据此收起 demo 控件，动作走 pose:call。"""
        self.assertTrue(pose.BRIDGE_CAPS["hostUi"])

    def test_status_reports_missing_package(self):
        with no_package_copy():
            if pose.INDEX_HTML.is_file():
                pose.INDEX_HTML.unlink()
            payload = pose.status_payload()
            self.assertFalse(payload["installed"])
            self.assertIn("sync_pose_dist", payload["hint"])
            self.assertEqual(payload["caps"], pose.BRIDGE_CAPS)

    def test_status_reports_the_bundled_copy_as_installed(self):
        """数据根那份被删掉时，随包副本兜底：装机后不跑同步脚本也能开页面。"""
        if pose.INDEX_HTML.is_file():
            pose.INDEX_HTML.unlink()
        payload = pose.status_payload()
        self.assertTrue(payload["installed"], "studio/pose_dist 随插件分发，缺数据根那份不算没装")
        self.assertEqual(payload["dist_source"], "package")
        self.assertEqual(payload["hint"], "")


class StatusAndPageTests(_PoseCase):
    def test_status_reports_installed_package_with_scenes(self):
        self.write(pose.SCENES_DIR / "unit_scene.json", '{"characters": []}')
        self.write(pose.INDEX_HTML, "<!doctype html><html><body>pose unit dist</body></html>")
        payload = pose.status_payload()
        self.assertTrue(payload["installed"])
        self.assertEqual(payload["hint"], "")
        self.assertEqual([row["name"] for row in payload["scenes"]], ["unit_scene"])

    def test_page_route_reports_missing_package(self):
        with no_package_copy():
            if pose.INDEX_HTML.is_file():
                pose.INDEX_HTML.unlink()
            resp = _run(pose.pose_page, _request())
            self.assertEqual(resp.status, 404)

    def test_page_route_redirects_into_the_static_prefix(self):
        """相对资源要有目录深度：页面落在前缀下的 index.html，./assets/x.js 才解析得对。"""
        self.write(pose.INDEX_HTML, '<!doctype html><html><body class="pose-unit"></body></html>')
        with self.assertRaises(web.HTTPFound) as got:
            _run(pose.pose_page, _request())
        self.assertEqual(got.exception.location, pose.PAGE_URL)


class DistAssetTests(_PoseCase):
    def test_dist_path_stays_inside_dist(self):
        self.assertEqual(pose.inside_dir(pose.DIST_DIR, "assets/index-abc.js"),
                         (pose.DIST_DIR / "assets/index-abc.js").resolve())
        for escape in ("../pose.py", "a/../../b.js", "", "C:/Windows/system32/x.js"):
            self.assertIsNone(pose.inside_dir(pose.DIST_DIR, escape), f"{escape} 不能给出 dist 外的文件")

    def test_wasm_asset_serves_as_wasm_with_hashed_cache(self):
        """Windows 的 mimetypes 读注册表，.wasm 报 octet-stream 时 Draco 的
        instantiateStreaming 直接拒收，姿势页连 GLB 都解不出来。"""
        self.write(pose.DIST_DIR / "assets" / "draco_wasm_wrapper-abc.wasm", "x")
        resp = _run(pose.pose_static, _request(match_info={"path": "assets/draco_wasm_wrapper-abc.wasm"}))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Content-Type"], "application/wasm")
        self.assertIn("immutable", resp.headers["Cache-Control"])

    def test_unhashed_asset_is_revalidated(self):
        self.write(pose.DIST_DIR / "logo.svg", "<svg/>")
        resp = _run(pose.pose_static, _request(match_info={"path": "logo.svg"}))
        self.assertEqual(resp.headers["Cache-Control"], "no-cache")

    def test_prefix_root_serves_the_entry_page(self):
        """地址栏直接敲前缀（/pose-dist/）也要进页面：空路径落到入口页。"""
        self.write(pose.INDEX_HTML, "<!doctype html><html><body>pose unit dist</body></html>")
        resp = _run(pose.pose_static, _request(match_info={"path": ""}))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Content-Type"], "text/html")

    def test_missing_asset_is_404(self):
        resp = _run(pose.pose_static, _request(match_info={"path": "assets/nope.js"}))
        self.assertEqual(resp.status, 404)


class LibAssetTests(_PoseCase):
    """场景库（pose-lib 的库数据）：`/pose-lib/` 一条前缀伺服数据根那一级，全程只读。"""

    def index(self) -> Path:
        return self.write(pose.LIB_DIR / "index.json", json.dumps(
            {"format": "3dpose.index/1", "count": 2,
             "groups": [{"key": "stand", "label": "站立", "count": 2}],
             "entries": [{"id": "a", "label": "A-Pose", "path": "poses/stand/a.scene.json",
                          "groups": ["stand"], "preview": {"clay": "preview/a.clay.png"}},
                         {"id": "b", "label": "Rest", "path": "poses/stand/b.scene.json",
                          "groups": ["stand"], "preview": {}}]}))

    def test_lib_index_serves_json_and_its_scene_file(self):
        self.index()
        self.write(pose.LIB_DIR / "poses" / "stand" / "a.scene.json",
                   '{"format":"3dpose.scene/1","subjects":[]}')
        resp = _run(pose.pose_lib, _request(match_info={"path": "index.json"}))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Content-Type"], "application/json")
        got = _run(pose.pose_lib, _request(match_info={"path": "poses/stand/a.scene.json"}))
        self.assertEqual(got.status, 200)
        self.assertEqual(got.headers["Content-Type"], "application/json")
        # 库文件会被同步脚本重新生成：不许长缓存，改库后刷新页面要拿到新的场景
        self.assertEqual(got.headers["Cache-Control"], "no-cache")

    def test_lib_dir_read_serves_index(self):
        """弹窗按库目录取一次清单：目录请求落到 index.json，与姿势包前缀根同一条口径。"""
        self.index()
        resp = _run(pose.pose_lib, _request(match_info={"path": ""}))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Content-Type"], "application/json")

    def test_lib_path_stays_in_lib(self):
        self.index()
        for escape in ("../dist/index.html", "lib/../../pose.py", "C:/Windows/x.js"):
            self.assertEqual(_run(pose.pose_lib, _request(match_info={"path": escape})).status, 400,
                            f"{escape} 不能给出库外的文件")

    def test_lib_missing_is_404(self):
        """库没同步时整条前缀 404：弹窗先看 status 的 lib_installed 出同步指引。"""
        self.assertEqual(_run(pose.pose_lib, _request(match_info={"path": "index.json"})).status, 404)

    def test_status_reports_the_synced_library(self):
        self.index()
        self.write(pose.LIB_DIR / "preview" / "a.clay.png", "x")
        payload = pose.status_payload()
        self.assertTrue(payload["lib_installed"])
        self.assertEqual(payload["lib_entries"], 2)
        self.assertEqual(payload["lib_dir"], str(pose.LIB_DIR))

    def test_status_reports_library_missing_or_broken(self):
        """读不出索引（没同步 / 坏 JSON）一律报 0 条：弹窗出同步指引，不是空浏览器。"""
        payload = pose.status_payload()
        self.assertFalse(payload["lib_installed"])
        self.assertEqual(payload["lib_entries"], 0)
        self.write(pose.LIB_DIR / "index.json", "{ not json")
        self.assertEqual(pose.status_payload()["lib_entries"], 0)


class SceneTests(_PoseCase):
    def test_scene_round_trip_leaves_no_temp_file(self):
        """场景落盘先写 .tmp 再替换：窗口中途关掉不能留下半份 JSON。"""
        resp = _run(pose.pose_save_scene,
                    _request(body={"name": "unit_a", "scene": {"characters": [{"id": "c1"}]}}))
        self.assertEqual(resp.status, 200)
        path = pose.SCENES_DIR / "unit_a.json"
        self.created.append(path)
        self.assertTrue(path.is_file())
        self.assertFalse((pose.SCENES_DIR / "unit_a.json.tmp").exists())
        got = json.loads(_run(pose.pose_get_scene, _request(query={"name": "unit_a"})).body)
        self.assertEqual(got["scene"]["characters"][0]["id"], "c1")

    def test_older_scene_json_reads_with_missing_fields(self):
        """旧场景缺本轮新加的字段照常返回：字段语义不因新改动而改变。"""
        self.write(pose.SCENES_DIR / "unit_old.json", json.dumps({"characters": []}))
        got = json.loads(_run(pose.pose_get_scene, _request(query={"name": "unit_old"})).body)
        self.assertTrue(got["success"])
        self.assertEqual(got["scene"], {"characters": []})

    def test_scene_name_rejects_path_escape(self):
        for name in ("a/b", "..", "a\\b", "x" * 65, ""):
            resp = _run(pose.pose_save_scene, _request(body={"name": name, "scene": {}}))
            self.assertEqual(resp.status, 400, f"场景名 {name!r} 要挡住")
            resp = _run(pose.pose_get_scene, _request(query={"name": name}))
            self.assertEqual(resp.status, 400)

    def test_scene_body_must_be_an_object(self):
        resp = _run(pose.pose_save_scene, _request(body={"name": "unit_a", "scene": "[]"}))
        self.assertEqual(resp.status, 400)


class _GalleryStubCase(_PoseCase):
    """素材通道要 Gallery 的解析与落点：只顶掉 studio.gallery 这一个模块，收尾归还，
    不把 gallery 的真实 import 副作用留给同进程的后续用例。"""

    def setUp(self):
        super().setUp()
        self._saved = snapshot((GALLERY_STUB,))
        self.stub_pose_dir = pose.DIST_DIR.parent / "stub_output" / "Pose"
        self.source = None
        mod = types.ModuleType(GALLERY_STUB)
        mod.POSE_DIR = self.stub_pose_dir
        mod.POSE_DIR_NAME = "Pose"
        mod._find_source_media = lambda filename, subfolder: self.source
        sys.modules[GALLERY_STUB] = mod

    def tearDown(self):
        restore((GALLERY_STUB,), self._saved)
        super().tearDown()


class ExportImageTests(_GalleryStubCase):
    def test_export_lands_in_the_pose_output_dir(self):
        """导出落点是 output 下的 Pose 子目录：素材库浏览 output 就能看到，接口回相对 subfolder。"""
        resp = _run(pose.pose_export_image,
                    _request(body={"data": base64.b64encode(PNG).decode(), "name": "pose shot"}))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        dest = self.stub_pose_dir / data["filename"]
        self.created.append(dest)
        self.assertEqual(dest.read_bytes(), PNG)
        self.assertEqual(data["subfolder"], "Pose")

    def test_export_rejects_bad_payload(self):
        self.assertEqual(_run(pose.pose_export_image, _request(body={"data": "%%%"})).status, 400)
        self.assertEqual(_run(pose.pose_export_image,
                              _request(body={"data": base64.b64encode(PNG).decode(), "ext": ".svg"})).status,
                         400)


class ExportSetTests(_GalleryStubCase):
    """ControlNet 图组 → 素材库的 Pose 目录：一次一组落进 output/Pose，
    页面拼的名字只留文件名安全段，重名由 _unique_path 追加序号。"""

    def _png(self):
        return base64.b64encode(PNG).decode()

    def test_set_lands_in_the_pose_output_dir(self):
        resp = _run(pose.pose_export_set, _request(body={"files": [
            {"name": "pose_a_front_skeleton", "data": self._png()},
            {"name": "data:pose a front depth", "data": "data:image/png;base64," + self._png()}]}))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["count"], 2)
        self.assertEqual(data["subfolder"], "Pose")
        for name in data["saved"]:
            self.assertTrue(name.endswith(".png"), f"落盘要带扩展名：{name}")
            self.assertNotIn(" ", name, f"名字里的空格要换成下划线：{name}")
            dest = self.stub_pose_dir / name
            self.created.append(dest)
            self.assertEqual(dest.read_bytes(), PNG)

    def test_set_caps_group_and_rejects_bad_payload(self):
        """超出 MAX_SET_FILES 在写盘之前挡掉：不能留下半组图。"""
        over = [{"name": f"unit_set_{n}", "data": self._png()} for n in range(pose.MAX_SET_FILES + 1)]
        self.assertEqual(_run(pose.pose_export_set, _request(body={"files": over})).status, 400)
        self.assertEqual(list(self.stub_pose_dir.glob("unit_set_*")), [])
        self.assertEqual(_run(pose.pose_export_set, _request(body={"files": []})).status, 400)
        self.assertEqual(_run(pose.pose_export_set, _request(body={"files": [{"name": "u", "data": "%%%"}]})).status, 400)
        self.assertEqual(_run(pose.pose_export_set,
                              _request(body={"files": [{"name": "u", "data": self._png(), "ext": ".svg"}]})).status,
                         400)

    def test_set_rejects_a_group_with_one_bad_file_leaves_nothing(self):
        """一组里最后一张不合法：整批不落盘，素材库里不许留下一组缺一张的图。"""
        resp = _run(pose.pose_export_set, _request(body={"files": [
            {"name": "unit_pair_skeleton", "data": self._png()},
            {"name": "unit_pair_depth", "data": "%%%", "ext": ".png"}]}))
        self.assertEqual(resp.status, 400)
        self.assertEqual(list(self.stub_pose_dir.glob("unit_pair_*")), [])


GLB_STUB = b"glTF\x02\x00\x00\x00" + bytes(64)

PATCHED = ("DIST_DIR", "PACKAGE_DIST", "MODELS_DIR", "INDEX_HTML", "SCENES_DIR", "MAX_GLB_BYTES")


class PackageDistTests(_GalleryStubCase):
    """两级落点与自备素体导入：随包那份最小副本装完就能开页面，用户同步的全量产物与自备 GLB 压它。

    落点与数据根全指到临时目录 —— 随包副本是构建产物，用例不许依赖它在不在仓库里。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._tmp.cleanup)
        super().setUp()
        root = Path(self._tmp.name)
        self.data_dist = root / "data_dist"
        self.pkg_dist = root / "pose_dist"
        self._paths = {name: getattr(pose, name) for name in PATCHED}
        self._data_root = pose.plugin_paths.DATA_ROOT
        pose.DIST_DIR = self.data_dist
        pose.PACKAGE_DIST = self.pkg_dist
        pose.MODELS_DIR = self.data_dist / "models"
        pose.INDEX_HTML = self.data_dist / "index.html"
        pose.SCENES_DIR = root / "scenes"
        pose.plugin_paths.DATA_ROOT = root

    def tearDown(self):
        for name, value in self._paths.items():
            setattr(pose, name, value)
        pose.plugin_paths.DATA_ROOT = self._data_root
        super().tearDown()

    def page_of(self, dist_dir: Path) -> Path:
        """那一级的入口页：装没装就看这个文件在不在。"""
        return self.write(dist_dir / "index.html", '<!doctype html><html><body class="pose-unit"></body></html>')

    def glb(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(GLB_STUB)
        self.created.append(path)
        return path

    def static(self, rel: str):
        return _run(pose.pose_static, _request(match_info={"path": rel}))

    def test_package_only_install_serves_page_models_and_status(self):
        """只有随包副本时页面与 GLB 都从那一层级取：最小包里只带默认基座那一具标准素体也够用。"""
        self.page_of(self.pkg_dist)
        self.glb(self.pkg_dist / "models" / "bodyMale.glb")
        payload = pose.status_payload()
        self.assertTrue(payload["installed"])
        self.assertEqual(payload["dist_source"], "package")
        self.assertTrue(payload["package_installed"])
        self.assertEqual(payload["models_present"], ["bodyMale.glb"])
        self.assertEqual(payload["hint"], "")
        self.assertEqual(self.static("").status, 200)
        glb = self.static("models/bodyMale.glb")
        self.assertEqual(glb.status, 200)
        self.assertEqual(glb.headers["Content-Type"], "model/gltf-binary")
        with self.assertRaises(web.HTTPFound) as got:
            _run(pose.pose_page, _request())
        self.assertEqual(got.exception.location, pose.PAGE_URL)

    def models(self, rel: str):
        return _run(pose.pose_models, _request(match_info={"path": rel}))

    def test_prop_registry_prefix_resolves_in_both_dist_levels(self):
        """道具注册表与素体 GLB 在产物里写的是 /models/... 这条根路径：两级落点都要答得出，
        注册表读空的页面不报缺包，只会一条一条说加具失败。"""
        self.page_of(self.pkg_dist)
        self.write(self.pkg_dist / "models" / "props" / "index.json", '{"props": []}')
        self.glb(self.pkg_dist / "models" / "bodyMale.glb")
        registry = self.models("props/index.json")
        self.assertEqual(registry.status, 200, "随包那一级要接住页面写死的那条注册表路径")
        self.assertEqual(registry.headers["Content-Type"], "application/json")
        self.assertEqual(self.models("bodyMale.glb").status, 200)
        # 数据根那一级起来后同名文件优先，数据根没有的那份仍从随包那一级取
        self.page_of(self.data_dist)
        self.glb(self.data_dist / "models" / "wide.glb")
        self.assertEqual(self.models("wide.glb").status, 200)
        self.assertEqual(self.models("props/index.json").status, 200)
        self.assertEqual(self.models("props/none.glb").status, 404, "两级都没有就是没有，不给一份空注册表")
        self.assertEqual(self.models("../scenes/a.json").status, 400, "注册表路径不能走出 dist")

    def test_data_root_dist_wins_over_the_package_copy(self):
        """两级都有同名文件时取数据根那份：新构建与自备素体压随包副本，页面跑用户装的那版。"""
        self.page_of(self.pkg_dist)
        self.page_of(self.data_dist)
        self.write(self.pkg_dist / "assets" / "index-abc.js", "console.log('package')")
        self.write(self.data_dist / "assets" / "index-abc.js", "console.log('data-root')")
        self.write(self.pkg_dist / "models" / "bodyMale.glb", "package")
        self.write(self.data_dist / "models" / "bodyMale.glb", "data-root")
        self.assertEqual(self.static("assets/index-abc.js").status, 200)
        self.assertEqual(pose.status_payload()["dist_source"], "data_root")
        self.assertEqual(pose.status_payload()["dist_dir"], str(self.data_dist))
        self.assertEqual(pose.dist_dirs()[0], self.data_dist)

    def test_missing_both_levels_reports_not_installed_and_says_how(self):
        payload = pose.status_payload()
        self.assertFalse(payload["installed"])
        self.assertEqual(payload["dist_source"], "")
        self.assertFalse(payload["package_installed"])
        self.assertIn("sync_pose_dist", payload["hint"])
        self.assertIn("build_pose_package", payload["hint"])
        self.assertEqual(self.static("index.html").status, 404)
        self.assertEqual(_run(pose.pose_page, _request()).status, 404)


    def test_manifest_is_reported_when_the_package_ships_one(self):
        """发货清单只在随包那一级：status 报出版本、文件数与体积，装机的人能核对装到了什么。"""
        self.page_of(self.pkg_dist)
        self.write(self.pkg_dist / pose.MANIFEST_NAME, json.dumps({
            "format": "neo-studio-pose-package/1",
            "built_utc": "2026-10-28T00:00:00Z",
            "total_bytes": 4096,
            "files": [{"path": "index.html", "bytes": 60, "sha256": "x"}],
        }))
        payload = pose.status_payload()
        self.assertEqual(payload["manifest_version"], "neo-studio-pose-package/1")
        self.assertEqual(payload["manifest_built"], "2026-10-28T00:00:00Z")
        self.assertEqual(payload["manifest_files"], 1)
        self.assertEqual(payload["manifest_bytes"], 4096)

    def test_missing_manifest_leaves_status_fields_empty(self):
        self.page_of(self.pkg_dist)
        payload = pose.status_payload()
        self.assertTrue(payload["installed"])
        self.assertEqual(payload["manifest_version"], "")
        self.assertEqual(payload["manifest_files"], 0)
        self.assertEqual(payload["manifest_bytes"], 0)

    def test_import_model_writes_into_data_root_models(self):
        """自备 GLB 落进数据根那一级，页面按 <key>.glb 取它；同名导入是替换，不出第二个 key。"""
        body = base64.b64encode(GLB_STUB).decode()
        data = json.loads(_run(pose.pose_import_model,
                               _request(body={"key": "mixamo_a", "data": body})).body)
        self.assertTrue(data["success"])
        self.assertEqual(data["url"], "/pose-dist/models/mixamo_a.glb")
        dest = pose.MODELS_DIR / "mixamo_a.glb"
        self.created.append(dest)
        self.assertEqual(dest.read_bytes(), GLB_STUB)
        self.assertFalse((pose.MODELS_DIR / "mixamo_a.glb.tmp").exists())
        self.assertEqual(self.static("models/mixamo_a.glb").status, 200)
        _run(pose.pose_import_model, _request(body={"key": "mixamo_a", "data": body}))
        self.assertEqual(sorted(p.name for p in pose.MODELS_DIR.glob("*.glb")), ["mixamo_a.glb"])
        self.assertIn("mixamo_a.glb", pose.status_payload()["models_present"])

    def test_import_model_resolves_gallery_files(self):
        """素材库那条来源复用 Gallery 的解析器：GLB 从素材库取一份也落进同一个落点。"""
        self.source = self.glb(Path(self._tmp.name) / "src" / "src.glb")
        data = json.loads(_run(pose.pose_import_model,
                               _request(body={"key": "from_lib", "filename": "src.glb"})).body)
        self.assertTrue(data["success"])
        dest = pose.MODELS_DIR / "from_lib.glb"
        self.created.append(dest)
        self.assertEqual(dest.read_bytes(), GLB_STUB)

    def test_import_model_rejects_bad_payload_without_writing(self):
        """key、来源、字节数、文件头四道校验全在写盘之前：挡下的请求不许留下半个模型的痕迹。"""
        good = base64.b64encode(GLB_STUB).decode()
        for body in (
            {"key": "", "data": good},
            {"key": "a/b", "data": good},
            {"key": "../escape", "data": good},
            {"key": "unit"},
            {"key": "unit", "data": "%%%", "filename": ""},
            {"key": "unit", "data": base64.b64encode(b"").decode()},
            {"key": "unit", "data": base64.b64encode(b"not-a-glb").decode()},
            {"key": "unit", "data": good, "filename": "also.glb"},
            {"key": "unit", "filename": "../x.glb"},
        ):
            self.assertEqual(_run(pose.pose_import_model, _request(body=body)).status, 400, str(body))
        self.assertEqual(list(pose.MODELS_DIR.glob("*.glb")), [])
        pose.MAX_GLB_BYTES = 8
        self.assertEqual(_run(pose.pose_import_model,
                              _request(body={"key": "unit_big", "data": good})).status, 400)
        self.assertEqual(list(pose.MODELS_DIR.glob("*.glb")), [])

    def test_import_model_rejects_non_glb_gallery_file_and_missing_asset(self):
        self.source = self.write_png(Path(self._tmp.name) / "src" / "src.png")
        self.assertEqual(_run(pose.pose_import_model,
                              _request(body={"key": "unit", "filename": "src.png"})).status, 400)
        self.source = None
        resp = _run(pose.pose_import_model, _request(body={"key": "unit", "filename": "nope.glb"}))
        self.assertEqual(resp.status, 404)
        self.assertEqual(list(pose.MODELS_DIR.glob("*.glb")), [])


class _CloudFixture(_PoseCase):
    """云端那棵的夹具：缓存整棵挪进临时树、网络层换桩、配置与缓存索引就地写。

    全程不联网：_http_get 换成桩，用例钉的是「拿到字节以后怎么办」那一段。
    """

    GLB = b"glTF\x02\x00\x00\x00" + b"\x00" * 40

    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory(prefix="neo_pose_cloud_")
        self.addCleanup(self._tmp.cleanup)
        self.cloud = importlib.import_module("studio.pose_cloud")
        self._http_get = self.cloud._http_get
        self._cache_dir = self.cloud.CACHE_DIR
        self.cloud.CACHE_DIR = Path(self._tmp.name) / "pose" / "oss_cache"
        self.cloud.INDEX_CACHE_FILE = self.cloud.CACHE_DIR / "_index.json"
        self.cloud.CLOUD_PROPS_DIR = self.cloud.CACHE_DIR / "models" / "props"
        self.calls = []

    def tearDown(self):
        self.cloud._http_get = self._http_get
        self.cloud.CACHE_DIR = self._cache_dir
        self.cloud.INDEX_CACHE_FILE = self._cache_dir / "_index.json"
        self.cloud.CLOUD_PROPS_DIR = self._cache_dir / "models" / "props"
        super().tearDown()

    def stub_http(self, routes: dict):
        """桩网络层：routes 是 url → (body, status)；没列出的报 404，调用序列留在 self.calls。"""
        async def fake(url):
            self.calls.append(url)
            return routes.get(url, (None, 404))

        self.cloud._http_get = fake

    def write_config(self, cfg: dict):
        self.cloud.OSS_PRESETS_FILE.parent.mkdir(parents=True, exist_ok=True)
        self.write(self.cloud.OSS_PRESETS_FILE, json.dumps(cfg, ensure_ascii=False))

    def write_cloud_index(self, index: dict):
        self.cloud.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.write(self.cloud.INDEX_CACHE_FILE, json.dumps(index, ensure_ascii=False))

    def cloud_index(self):
        return {
            "format": "neo-pose-cloud/1",
            "generatedAt": "2026-11-06T00:00:00Z",
            "count": 1,
            "groups": [{"key": "stand", "label": "站立", "count": 1}],
            "entries": [{"id": "c1", "label": "云端站姿", "path": "poses/stand/c1.scene.json",
                         "groups": ["stand"], "tags": ["cloud"], "charKey": "bodyMale",
                         "preview": {"clay": "preview/c1.clay.png"}}],
            "props": [{"id": "stick", "label": "木棍", "file": "stick-cloud.glb", "size": 48}],
        }

class CloudTests(_CloudFixture):
    """云端场景库与云端道具：索引 TTL、路径守卫、下载校验、不可用形态。

    道具那三级顺序也在这一类里钉 —— 云端缓存是第三级，数据根与随包副本永远压它。
    """

    def test_urls_derive_pose_prefix_from_the_presets_index(self):
        """预设索引边上加 pose/ 就是默认落点；pose_index_url 写了就以它为准。"""
        self.assertEqual(self.cloud.cloud_urls({
            "enabled": True, "index_url": "https://host/neo/presets/index.json",
        })["index_url"], "https://host/neo/pose/index.json")
        self.assertEqual(self.cloud.cloud_urls({
            "enabled": True, "index_url": "https://host/neo/presets/index.json",
            "pose_index_url": "https://other/pose/index.json",
        })["index_url"], "https://other/pose/index.json")
        empty = self.cloud.cloud_urls({})
        self.assertFalse(empty["enabled"])
        self.assertEqual(empty["index_url"], "")

    def test_status_without_config_says_unavailable_without_network(self):
        body = json.loads(_run(self.cloud.pose_cloud_status, _request()).text)
        self.assertFalse(body["enabled"])
        self.assertFalse(body["available"])
        self.assertIn("pose_index_url", body["hint"])
        self.assertEqual(self.calls, [])   # 状态接口不许碰网络

    def test_status_reports_the_cached_index_counts(self):
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        self.write_cloud_index(self.cloud_index())
        body = json.loads(_run(self.cloud.pose_cloud_status, _request()).text)
        self.assertTrue(body["enabled"])
        self.assertTrue(body["available"])
        self.assertEqual((body["scenes"], body["props"]), (1, 1))
        self.assertEqual(body["base_url"], "https://host/neo/pose/")


    def test_index_cache_within_ttl_is_not_refetched(self):
        self.write_config({"enabled": True, "index_url": "https://host/neo/presets/index.json",
                           "sync_interval_hours": 24})
        self.write_cloud_index(self.cloud_index())
        self.stub_http({})
        body = json.loads(_run(self.cloud.pose_cloud_index, _request()).text)
        self.assertEqual(body["source"], "cache")
        self.assertEqual(body["entries"][0]["path"], "poses/stand/c1.scene.json")
        self.assertEqual(body["entries"][0]["origin"], "cloud")
        self.assertEqual(body["props"][0]["path"], "models/props/stick-cloud.glb")
        self.assertEqual(self.calls, [])   # TTL 没到就不碰网络
        asyncio.run(self.cloud.load_index(force=True))   # 强制刷新（「刷新云端清单」那一条）必须重取
        self.assertEqual(len(self.calls), 1)


    def test_index_fetch_failure_falls_back_to_the_cached_copy(self):
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        self.write_cloud_index(self.cloud_index())
        self.cloud.INDEX_CACHE_FILE.write_text("{{{", encoding="utf-8")   # 坏缓存 + 断网
        self.stub_http({})
        resp = _run(self.cloud.pose_cloud_index, _request())
        self.assertEqual(resp.status, 502)
        self.assertIn("pose_index_url", json.loads(resp.text)["error"])

    def test_cloud_file_rejects_traversal_and_paths_the_index_does_not_list(self):
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        self.write_cloud_index(self.cloud_index())
        self.stub_http({})
        for path in ("../x.json", "/etc/passwd", "C:/Windows/x.json", "poses/stand/other.json",
                     "models/props/not-in-index.glb"):
            self.assertEqual(_run(self.cloud.pose_cloud_file, _request(query={"path": path})).status,
                             400, path)

    def test_cloud_file_checks_the_path_before_it_asks_whether_cloud_is_on(self):
        """云端没配置时的越界请求也是 400：路径守卫在配置检查之前，越界不会被说成「没配置」。

        「没配置」与「路径越界」都是 400，混在一起用户读不出自己撞的是哪一条；这条钉的是顺序，
        越界的请求不该走到配置那一步，更不该碰网络。
        """
        self.stub_http({})
        for path in ("../x.json", "/etc/passwd", "C:/Windows/x.json"):
            resp = _run(self.cloud.pose_cloud_file, _request(query={"path": path}))
            self.assertEqual(resp.status, 400, path)
            self.assertIn("相对路径", json.loads(resp.text)["error"], path)
        self.assertEqual(self.calls, [])

    def test_cloud_file_serves_the_cached_copy_and_downloads_once(self):
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        self.write_cloud_index(self.cloud_index())
        scene = json.dumps({"format": "3dpose.scene/1", "rigs": []}, ensure_ascii=False)
        base = "https://host/neo/pose/"
        self.stub_http({base + "poses/stand/c1.scene.json": (scene.encode("utf-8"), 200),
                        base + "props/stick-cloud.glb": (self.GLB, 200),
                        base + "preview/c1.clay.png": (PNG, 200)})
        self.assertEqual(_run(self.cloud.pose_cloud_file,
                              _request(query={"path": "poses/stand/c1.scene.json"})).status, 200)
        cached = self.cloud.CACHE_DIR / "poses" / "stand" / "c1.scene.json"
        self.assertEqual(json.loads(cached.read_text(encoding="utf-8")), json.loads(scene))
        # 云端道具的落点就是页面写死的那一级：/models/props/<file>.glb
        self.assertEqual(_run(self.cloud.pose_cloud_file,
                              _request(query={"path": "models/props/stick-cloud.glb"})).status, 200)
        self.assertEqual((self.cloud.CLOUD_PROPS_DIR / "stick-cloud.glb").read_bytes(), self.GLB)
        self.assertEqual(_run(self.cloud.pose_cloud_file,
                              _request(query={"path": "preview/c1.clay.png"})).status, 200)
        self.assertEqual(list(self.cloud.CACHE_DIR.rglob("*.tmp")), [])
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(_run(self.cloud.pose_cloud_file,
                              _request(query={"path": "poses/stand/c1.scene.json"})).status, 200)
        self.assertEqual(len(self.calls), 3)   # 命中缓存不再发请求

    def test_cloud_file_rejects_a_glb_without_magic_and_caches_nothing(self):
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        self.write_cloud_index(self.cloud_index())
        self.stub_http({"https://host/neo/pose/props/stick-cloud.glb": (b"not-a-glb!!", 200)})
        resp = _run(self.cloud.pose_cloud_file, _request(query={"path": "models/props/stick-cloud.glb"}))
        self.assertEqual(resp.status, 502)
        self.assertIn("glTF", json.loads(resp.text)["error"])
        self.assertEqual(list(self.cloud.CLOUD_PROPS_DIR.glob("*.glb")), [])

    def test_cloud_file_reports_missing_upstream_as_404(self):
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        self.write_cloud_index(self.cloud_index())
        self.stub_http({})
        resp = _run(self.cloud.pose_cloud_file, _request(query={"path": "poses/stand/c1.scene.json"}))
        self.assertEqual(resp.status, 404)
        self.assertEqual(list(self.cloud.CACHE_DIR.rglob("c1.scene.json")), [])

    def test_props_fallback_serves_the_cloud_cache_as_the_third_level(self):
        """道具的三级顺序：数据根 → 随包副本 → 云端缓存；前两级压得住的，轮不到云端。"""
        cloud_glb = self.cloud.CLOUD_PROPS_DIR / "unit-cloud-prop.glb"
        cloud_glb.parent.mkdir(parents=True, exist_ok=True)
        cloud_glb.write_bytes(self.GLB)
        self.created.append(cloud_glb)
        self.assertEqual(pose._dist_response("models/props/unit-cloud-prop.glb").status, 200)
        cached_root = self.cloud.CACHE_DIR
        self.cloud.CACHE_DIR = cached_root / "not-anymore"   # 缓存整棵没了 = 这条回到 404
        self.assertEqual(pose._dist_response("models/props/unit-cloud-prop.glb").status, 404)
        self.cloud.CACHE_DIR = cached_root



class CloudPropRegistryTests(_CloudFixture):
    """伺服道具注册表时补云端行（pose._props_registry_response）。

    页面对 GLB 先归一成「1 单位高」、再乘注册表行的 scale：注册表里没这一行的云端道具就是一把
    1 米长的手枪。钉三件事 —— 云端行带着 scale 与握点进注册表且标 hidden（姿势页自己的面板没有
    「先取文件再加具」那一步，不许列没缓存的道具）；本机登记过的文件一条不补；这一条是姿势页的
    开局路径，桩网络里没有一条路由，发出请求就是失败。
    """

    def setUp(self):
        super().setUp()
        self.registry = {
            "_readme": ["GLB 道具注册表：file 是裸文件名，scale 是注册表级缩放。"],
            "props": [{"file": "stick.glb", "label": "棍", "scale": 1}],
        }
        self.write(pose.DIST_DIR / "models" / "props" / "index.json",
                   json.dumps(self.registry, ensure_ascii=False))

    def cloud_index(self):
        base = super().cloud_index()
        base["props"] = [
            {"id": "katana", "label": "武士刀（古）", "file": "katana.glb", "size": 257,
             "license": "CC0（公有领域，可商用可再分发）",
             "source": "https://polyhaven.com/a/katana",
             "registry": {"file": "katana.glb", "label": "武士刀（古）", "scale": 1.003,
                          "standing": True, "grab": 0.26, "hidden": False}},
            {"id": "stick", "label": "棍", "file": "stick.glb", "size": 88,
             "registry": {"file": "stick.glb", "label": "棍", "scale": 1}},
        ]
        return base

    def served_registry(self) -> list:
        self.stub_http({})
        resp = pose._dist_response("models/props/index.json")
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.calls, [], "伺服注册表不许发网络请求")
        self.assertNotIsInstance(resp, web.FileResponse, "补了行就不是纯文件伺服")
        return json.loads(resp.text)["props"]

    def test_cloud_rows_join_the_registry_with_scale_and_hidden(self):
        """云端行整条照索引给（scale 1.003、握点 standing/grab），并改写成 hidden。"""
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        self.write_cloud_index(self.cloud_index())
        rows = self.served_registry()
        self.assertEqual([r["file"] for r in rows], ["stick.glb", "katana.glb"])
        katana = rows[1]
        self.assertEqual(katana["scale"], 1.003)
        self.assertTrue(katana["standing"] and katana["grab"])
        self.assertIs(katana["hidden"], True, "姿势页自己的面板不许列没缓存的道具")

    def test_local_registry_rows_are_never_replaced(self):
        """本机登记过的道具一条不补：数据根同步过姿势仓库时，注册表与 GLB 两级都在着。"""
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        self.write_cloud_index(self.cloud_index())
        rows = self.served_registry()
        self.assertEqual(len(rows), 2, "云端那根 stick 不许压本机那根，也不许重复登记")
        self.assertEqual(rows[0], self.registry["props"][0])

    def test_registry_without_a_cloud_cache_is_served_as_the_file_it_is(self):
        """没有云端缓存：这条回到纯文件伺服，发出去的就是本机那份字节（页面开局读它不许等 OSS）。"""
        self.stub_http({})
        resp = pose._dist_response("models/props/index.json")
        self.assertIsInstance(resp, web.FileResponse)
        self.assertEqual(self.calls, [])
        served = (pose.DIST_DIR / "models" / "props" / "index.json").read_text(encoding="utf-8")
        self.assertEqual(json.loads(served), self.registry)

    def test_an_index_from_an_older_deploy_still_lands_as_a_row(self):
        """旧版上传脚本的条目没有 registry 那一行：补出来是一条只有名字的行，页面按默认 scale 摆。"""
        self.write_config({"enabled": True, "pose_index_url": "https://host/neo/pose/index.json"})
        index = super().cloud_index()
        self.write_cloud_index(index)
        self.assertEqual(self.served_registry()[-1],
                         {"file": "stick-cloud.glb", "label": "木棍", "hidden": True})


if __name__ == "__main__":
    unittest.main()


