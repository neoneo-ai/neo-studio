# SPDX-License-Identifier: Apache-2.0
"""/neo_frames/*（studio/frames.py）离线单测：抽帧页的两条文件层接口。

抽帧本身在浏览器里跑，后端只剩两件事 —— 把素材库里那条视频按分段回给播放器，把抽出来的一帧
PNG 写进 output/Frames。这里覆盖分段响应、素材不存在、非视频（图片与音频混在素材库里），以及帧的
落点与重名。落点与素材解析都来自 studio.gallery，用例把它顶成临时目录里的两份常量。
"""

import asyncio
import base64
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from aiohttp import web

from stub_env import restore, snapshot

frames = importlib.import_module("studio.frames")   # conftest.py 把 studio 顶成占位包，插件入口不执行

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
VIDEO = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
GALLERY_STUB = "studio.gallery"


def _request(query=None, body=None, content_length=None) -> types.SimpleNamespace:
    """假请求：这两条 handler 只读 query、content_length 与 JSON body 三样。"""
    async def read_json():
        if body is None:
            raise ValueError("no body")
        return body

    return types.SimpleNamespace(
        match_info={},
        rel_url=types.SimpleNamespace(query=query or {}),
        content_length=content_length if content_length is not None
        else (len(json.dumps(body)) if body is not None else 0),
        json=read_json)


def _run(handler, request):
    return asyncio.run(handler(request))


def _png() -> str:
    return base64.b64encode(PNG).decode()


class _GalleryStubCase(unittest.TestCase):
    """素材通道与帧的落点都来自 Gallery：只顶掉 studio.gallery 这一个模块，收尾归还，
    不把 gallery 的真实 import 副作用留给同进程的后续用例。"""

    def setUp(self):
        self._saved = snapshot((GALLERY_STUB,))
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.frames_dir = self.root / "stub_output" / "Frames"
        self.source = None
        self.created = []
        mod = types.ModuleType(GALLERY_STUB)
        mod.FRAMES_DIR = self.frames_dir
        mod.FRAMES_DIR_NAME = "Frames"
        mod._find_source_media = lambda filename, subfolder: self.source
        sys.modules[GALLERY_STUB] = mod

    def tearDown(self):
        for path in self.created:
            if path.is_file():
                path.unlink()
        restore((GALLERY_STUB,), self._saved)
        self._tmp.cleanup()

    def write(self, path: Path, data: bytes) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.created.append(path)
        return path

    def saved(self, name: str) -> Path:
        dest = self.frames_dir / name
        self.created.append(dest)
        return dest


class VideoSourceTests(_GalleryStubCase):
    def test_video_serves_a_range_capable_response(self):
        """分段响应是抽帧页唯一的后端依赖：整份读进内存的 Response 分段不了，seek 会落回片头。

        FileResponse 自己解析 Range（aiohttp 3.14），抽一批帧时反复打的 seek
        才不会把整条视频重传。
        """
        self.source = self.write(self.root / "src" / "clip.mp4", VIDEO)
        resp = _run(frames.frames_video, _request(query={"filename": "clip.mp4", "subfolder": "Output"}))
        self.assertEqual(resp.status, 200)
        self.assertIsInstance(resp, web.FileResponse)
        self.assertEqual(resp.headers["Content-Type"], "video/mp4")
        self.assertIn("max-age", resp.headers["Cache-Control"])

    def test_video_rejects_bad_names_and_missing_asset(self):
        self.assertEqual(_run(frames.frames_video, _request(query={})).status, 400)
        self.assertEqual(_run(frames.frames_video, _request(query={"filename": ".."})).status, 400)
        self.source = None
        self.assertEqual(_run(frames.frames_video,
                              _request(query={"filename": "gone.mp4", "subfolder": ""})).status, 404)

    def test_video_rejects_non_video_asset(self):
        """素材库里混着的图片与音频点进播放器只会是个空播放器：接口要说清不收的是哪种"""
        self.source = self.write(self.root / "src" / "shot.png", PNG)
        resp = _run(frames.frames_video, _request(query={"filename": "shot.png", "subfolder": ""}))
        self.assertEqual(resp.status, 400)
        self.assertIn("抽帧只支持视频", json.loads(resp.body)["error"])


class FrameSaveTests(_GalleryStubCase):
    def test_frame_lands_in_the_frames_output_dir(self):
        """帧的落点是 output 下的 Frames 子目录：素材库浏览 output 就看到，接口回相对 subfolder"""
        data = json.loads(_run(frames.frames_save,
                               _request(body={"data": _png(), "name": "frame-00:07.125"})).body)
        self.assertTrue(data["success"])
        # Windows 的文件名不吃冒号：时间戳落进文件名时换成下划线
        self.assertEqual(data["filename"], "frame-00_07_125.png")
        self.assertEqual(data["subfolder"], "Frames")
        self.assertEqual(self.saved("frame-00_07_125.png").read_bytes(), PNG)

    def test_data_url_prefix_is_stripped_before_decode(self):
        """页面交的是 canvas 的 data URL：前缀得先摘掉，base64 段才解得开"""
        data = json.loads(_run(frames.frames_save,
                               _request(body={"data": "data:image/png;base64," + _png()})).body)
        self.assertTrue(data["success"])
        self.assertEqual(data["filename"], "frame.png")
        self.assertEqual(self.saved("frame.png").read_bytes(), PNG)

    def test_second_frame_with_same_time_keeps_both(self):
        """同名要留下两份：同一秒内抽两帧（间隔小于 1 秒）不该互相覆盖"""
        first = json.loads(_run(frames.frames_save, _request(body={"data": _png(), "name": "frame-00:00"})).body)
        second = json.loads(_run(frames.frames_save, _request(body={"data": _png(), "name": "frame-00:00"})).body)
        self.assertEqual(first["filename"], "frame-00_00.png")
        self.assertEqual(second["filename"], "frame-00_00_1.png")
        self.assertEqual(self.saved("frame-00_00.png").read_bytes(), PNG)
        self.assertEqual(self.saved("frame-00_00_1.png").read_bytes(), PNG)

    def test_save_rejects_bad_payload(self):
        self.assertEqual(_run(frames.frames_save, _request(body={"data": "%%%"})).status, 400)
        self.assertEqual(_run(frames.frames_save, _request(body={"data": ""})).status, 400)
        self.assertEqual(_run(frames.frames_save, _request(body={})).status, 400)

    def test_save_rejects_oversized_body(self):
        """一帧整张 PNG 走 body：体积上限先挡住，不能等写盘时才截断"""
        resp = _run(frames.frames_save, _request(body={"data": _png()},
                                                 content_length=frames.MAX_BODY_BYTES + 1))
        self.assertEqual(resp.status, 400)
        self.assertIn("MB", json.loads(resp.body)["error"])


class RouteContractTests(unittest.TestCase):
    def test_page_only_needs_two_routes(self):
        """页面只认这两条路径：抽帧在浏览器里做，后端不能多出第三条通路"""
        self.assertEqual({(r.method, r.path) for r in frames.routes},
                         {("GET", "/neo_frames/video"), ("POST", "/neo_frames/save")})


if __name__ == "__main__":
    unittest.main()

