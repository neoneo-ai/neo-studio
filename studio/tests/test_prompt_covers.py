# SPDX-License-Identifier: Apache-2.0
"""提示词封面的两条链（离线单测，全程不依赖 ComfyUI）。

封面是正文旁边的 sidecar `prompts/custom/<扫描名>.jpg`：写侧只认自定义池（预设池是代码目录、
出厂只读，403 挡在那里），源文件必须是 ComfyUI output/ 里的图或视频；读侧的 scan_prompts
带一份封面 mtime 供卡片换缓存，删正文连带删它旁边那张封面。
"""

import asyncio
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

from aiohttp import web

import stub_env

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _NODE_DIR)
# ComfyUI 根有两种落点：仓库的上级目录，与整合包里的同级 ComfyUI（.vscode/settings.json 的 extraPaths）
for _cand in (os.path.join(_NODE_DIR, "..", ".."), os.path.join(_NODE_DIR, "..", "..", "ComfyUI")):
    if os.path.isfile(os.path.join(_cand, "folder_paths.py")):
        sys.path.insert(0, os.path.abspath(_cand))
        break

_PKG_NAME = "_neo_prompt_covers_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg


class _FakeRoutes:
    """装饰器只把函数留下：测试直接调路由函数本体，不起 aiohttp 服务"""

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


_prev_env = stub_env.snapshot(stub_env.GALLERY_STUB_PREFIXES)
_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server
# 封面的缩略图生成在 gallery 那一层，prompts 是惰性 import：测试先把桩的 folder_paths 顶进去，
# 让 gallery 在桩环境里起得来（它 import 期只要 output_directory / input_directory 两个属性）
_fake_folder_paths = types.ModuleType("folder_paths")
_fake_folder_paths.output_directory = os.path.join(tempfile.gettempdir(), "neo_prompt_covers_output")
_fake_folder_paths.input_directory = os.path.join(tempfile.gettempdir(), "neo_prompt_covers_input")
os.makedirs(_fake_folder_paths.output_directory, exist_ok=True)
os.makedirs(_fake_folder_paths.input_directory, exist_ok=True)
sys.modules["folder_paths"] = _fake_folder_paths

_import_error = ""
try:
    names_mod = importlib.import_module(f"{_PKG_NAME}.prompt_names")
    prompts_mod = importlib.import_module(f"{_PKG_NAME}.prompts")
    importlib.import_module(f"{_PKG_NAME}.gallery")
    COVERS_AVAILABLE = True
except Exception as _e:
    names_mod = prompts_mod = None
    COVERS_AVAILABLE = False
    _import_error = str(_e)
finally:
    stub_env.restore(stub_env.GALLERY_STUB_PREFIXES, _prev_env)


class _Request:
    """最小请求替身：POST 带 JSON 体，GET 带查询串"""

    def __init__(self, payload=None, query=None):
        self._payload = payload or {}
        self.rel_url = types.SimpleNamespace(query=query or {})

    async def json(self):
        return self._payload


@unittest.skipUnless(COVERS_AVAILABLE, f"prompt modules unavailable: {_import_error}")
class PromptCoverTests(unittest.TestCase):
    """sidecar 写 / 读 / 删：名字口径、只读预设、源文件缺失的可见结果"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="neo_prompt_covers_")
        self.output = os.path.join(self.root, "output")
        os.makedirs(self.output, exist_ok=True)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        # 源图解析在 ComfyUI 的 output/ 里做，测试把它指到临时目录，不碰真实输出目录
        self._real_folder_paths = prompts_mod.folder_paths
        prompts_mod.folder_paths = types.SimpleNamespace(
            get_full_path=lambda kind, rel: os.path.join(self.output, *rel.replace("\\", "/").split("/")))
        self.addCleanup(setattr, prompts_mod, "folder_paths", self._real_folder_paths)

    def tearDown(self):
        # 用例写进的是 conftest 钉住的临时数据根，逐条清掉，下一条扫不到上一份的提示词
        shutil.rmtree(names_mod.CUSTOM_DIR, ignore_errors=True)

    def write_prompt(self, name, text="一只红色陶瓷杯的白底产品图。"):
        path = os.path.join(names_mod.CUSTOM_DIR, *name.split("/")) + ".txt"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def write_output_image(self, filename="shot.png", size=(900, 600)):
        from PIL import Image
        path = os.path.join(self.output, filename)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Image.new("RGB", size, (200, 40, 40)).save(path)
        return path

    def cover_path(self, name):
        return os.path.join(names_mod.CUSTOM_DIR, *name.split("/")) + ".jpg"

    def set_cover(self, name, filename=None, subfolder=""):
        payload = {"name": name, "subfolder": subfolder}
        if filename is not None:
            payload["filename"] = filename
        return _run(prompts_mod.rs_prompts_set_prompt_cover(_Request(payload)))

    def test_cover_sidecar_lands_next_to_prompt(self):
        self.write_prompt("红杯")
        self.write_output_image()
        resp = self.set_cover("红杯", "shot.png")
        self.assertEqual(resp.status, 200)
        self.assertTrue(os.path.isfile(self.cover_path("红杯")))
        self.assertEqual(_json(resp)["cover"], int(os.path.getmtime(self.cover_path("红杯"))))

    def test_sidecar_is_scaled_jpeg(self):
        """写下去就是 512px 长边的 JPEG：读侧直接回文件，不再逐尺寸现生成"""
        self.write_prompt("红杯")
        self.write_output_image(size=(1600, 900))
        self.set_cover("红杯", "shot.png")
        from PIL import Image
        with Image.open(self.cover_path("红杯")) as img:
            self.assertEqual(img.format, "JPEG")
            self.assertLessEqual(max(img.size), names_mod.COVER_MAX_SIDE)

    def test_scan_marks_cover_mtime(self):
        self.write_prompt("红杯")
        self.write_prompt("无封面")
        self.write_output_image()
        self.set_cover("红杯", "shot.png")
        rows = {r["name"]: r for r in names_mod.scan_prompts("custom")}
        self.assertGreater(rows["红杯"]["cover"], 0)
        self.assertNotIn("cover", rows["无封面"])

    def test_cover_source_pointer_lands_next_to_cover(self):
        """封面的来路记在它旁边那条指针里：视频池的卡片自动播认的就是这一发指的产物"""
        self.write_prompt("红杯")
        self.write_output_image("NeoStudio/shot.png")
        self.assertEqual(self.set_cover("红杯", "shot.png", subfolder="NeoStudio").status, 200)
        pointer = self.cover_path("红杯")[:-4] + names_mod.COVER_SOURCE_SUFFIX
        with open(pointer, encoding="utf-8") as f:
            row = json.load(f)
        self.assertEqual({key: row[key] for key in ("filename", "subfolder", "kind")},
                         {"filename": "shot.png", "subfolder": "NeoStudio", "kind": "image"})
        from PIL import Image
        with Image.open(self.cover_path("红杯")) as img:
            self.assertEqual((row["w"], row["h"]), img.size,
                             "指针记的就是封面自己那一张的像素尺寸：卡片落位即按它定高")

    def test_pointer_written_before_size_still_reads(self):
        """记尺寸这写法之前写的指针：只有来路三个字段，读侧照出，条目不带 w/h（卡片退回探测那张封面）"""
        self.write_prompt("红杯")
        self.write_output_image()
        self.set_cover("红杯", "shot.png")
        pointer = self.cover_path("红杯")[:-4] + names_mod.COVER_SOURCE_SUFFIX
        with open(pointer, "w", encoding="utf-8") as f:
            json.dump({"filename": "shot.png", "subfolder": "", "kind": "image"}, f)
        rows = {r["name"]: r for r in names_mod.scan_prompts("custom")}
        self.assertEqual(rows["红杯"]["cover_media"],
                         {"filename": "shot.png", "subfolder": "", "kind": "image"})

    def test_scan_exposes_cover_media_for_card_preview(self):
        """列表带出指针：前端只有这一发认得出「这张封面是这条产物播出来的」，卡片并按记下的尺寸定高"""
        self.write_prompt("video/镜头")
        self.write_prompt("无封面")
        self.write_output_image("out/frame.png")
        self.set_cover("video/镜头", "frame.png", subfolder="out")
        rows = {r["name"]: r for r in names_mod.scan_prompts("custom")}
        media = rows["video/镜头"]["cover_media"]
        self.assertEqual({key: media[key] for key in ("filename", "subfolder", "kind")},
                         {"filename": "frame.png", "subfolder": "out", "kind": "image"})
        self.assertEqual((media["w"], media["h"]), (512, 341), "900×600 缩到 512 长边就是这一档")
        self.assertNotIn("cover_media", rows["无封面"], "没有封面的条连这一位都不带")

    def test_pointer_records_video_kind_of_the_source(self):
        """指针认得源是视频（后缀表在 gallery 那一层，惰性取）：卡片的视频位只播 kind 是 video 的那一发"""
        self.write_prompt("video/镜头")
        cover = self.cover_path("video/镜头")
        os.makedirs(os.path.dirname(cover), exist_ok=True)
        with open(cover, "wb") as f:
            f.write(b"\xff\xd8placeholderjpeg")
        prompts_mod._record_cover_source(cover, "镜头推进.mp4", "out")
        rows = {r["name"]: r for r in names_mod.scan_prompts("custom")}
        self.assertEqual(rows["video/镜头"]["cover_media"]["kind"], "video")

    def test_broken_pointer_leaves_the_card_a_still_cover(self):
        """指针被外部编辑器写坏：封面照出，预览位空着，不给卡片一条必败的视频地址"""
        self.write_prompt("红杯")
        self.write_output_image()
        self.set_cover("红杯", "shot.png")
        with open(self.cover_path("红杯")[:-4] + names_mod.COVER_SOURCE_SUFFIX, "w", encoding="utf-8") as f:
            f.write("{不是 JSON")
        rows = {r["name"]: r for r in names_mod.scan_prompts("custom")}
        self.assertGreater(rows["红杯"]["cover"], 0)
        self.assertNotIn("cover_media", rows["红杯"])

    def test_cover_in_video_subdir_pool(self):
        """视频池的提示词一样有封面：sidecar 跟着正文落在 video/ 里"""
        self.write_prompt("video/镜头")
        self.write_output_image("frame.png")
        self.assertEqual(self.set_cover("video/镜头", "frame.png").status, 200)
        self.assertTrue(os.path.isfile(self.cover_path("video/镜头")))

    def test_factory_preset_cover_refused(self):
        """预设池是代码目录：403，不往代码目录里写用户封面"""
        preset = os.path.join(names_mod.PRESETS_DIR, "_封面用例.txt")
        with open(preset, "w", encoding="utf-8") as f:
            f.write("出厂预设正文")
        self.addCleanup(os.remove, preset)
        self.write_output_image()
        self.assertEqual(self.set_cover("presets/_封面用例", "shot.png").status, 403)
        self.assertFalse(os.path.isfile(os.path.join(names_mod.PRESETS_DIR, "_封面用例.jpg")))

    def test_missing_prompt_is_404(self):
        self.write_output_image()
        self.assertEqual(self.set_cover("不存在", "shot.png").status, 404)

    def test_missing_source_is_404(self):
        self.write_prompt("红杯")
        self.assertEqual(self.set_cover("红杯", "nope.png").status, 404)
        self.assertFalse(os.path.isfile(self.cover_path("红杯")))

    def test_non_media_source_refused(self):
        """源限定图与视频：拿 .txt 当封面是一次必败的缩略图生成"""
        self.write_prompt("红杯")
        with open(os.path.join(self.output, "note.txt"), "w", encoding="utf-8") as f:
            f.write("不是图")
        self.assertEqual(self.set_cover("红杯", "note.txt").status, 404)

    def test_traversal_name_never_writes_sidecar(self):
        self.write_prompt("红杯")
        self.write_output_image()
        self.assertEqual(self.set_cover("../evil", "shot.png").status, 404)
        self.assertIsNone(names_mod.prompt_cover_target("../evil"))

    def test_delete_removes_prompt_and_cover(self):
        self.write_prompt("红杯")
        self.write_output_image()
        self.set_cover("红杯", "shot.png")
        self.assertEqual(_run(prompts_mod.rs_prompts_delete_prompt(_Request({"name": "红杯"}))).status, 200)
        self.assertFalse(os.path.isfile(os.path.join(names_mod.CUSTOM_DIR, "红杯.txt")))
        self.assertFalse(os.path.isfile(self.cover_path("红杯")))
        self.assertFalse(os.path.isfile(self.cover_path("红杯")[:-4] + names_mod.COVER_SOURCE_SUFFIX),
                         "那条指针跟着封面一起清，不留一条指向空封面的记录")

    def test_cover_route_serves_jpeg_with_revalidating_cache(self):
        self.write_prompt("红杯")
        self.write_output_image()
        self.set_cover("红杯", "shot.png")
        resp = _run(names_mod.prompt_cover_route(_Request(query={"name": "红杯"})))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Cache-Control"), "public, max-age=0, must-revalidate")
        self.assertNotIn("immutable", resp.headers.get("Cache-Control", ""))
        self.assertIsInstance(resp, web.FileResponse)  # 条件请求由 FileResponse 判，没变回 304
        with open(self.cover_path("红杯"), "rb") as f:
            self.assertTrue(f.read(2).startswith(b"\xff\xd8"))  # JPEG 起始标记

    def test_cover_route_404_without_cover(self):
        self.write_prompt("无封面")
        route = names_mod.prompt_cover_route
        self.assertEqual(_run(route(_Request(query={"name": "无封面"}))).status, 404)

    def test_cover_route_404_for_unknown_name(self):
        self.assertEqual(_run(names_mod.prompt_cover_route(_Request(query={"name": "不存在"}))).status, 404)


def _run(coro):
    return asyncio.run(coro)


def _json(resp):
    """json_response 的载荷：aiohttp 只把序列化后的 body 留下，读回来判"""
    return json.loads(resp.body.decode())


if __name__ == "__main__":
    unittest.main()

