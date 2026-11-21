# SPDX-License-Identifier: Apache-2.0
"""拖进画布的素材落 input/（studio/canvas.py 的 POST /neo_canvas/upload）：纯文件写入。

画布上的图片 / 视频 / 音频节点认的是 ComfyUI input/ 里的文件，浏览器拖进来的那一份必须先落到那里。
这一发不跑队列、不吃显存，桌面端离线服务自己答（app/studio_caps.py 的 _CANVAS 已登记），所以这里
不需要 ComfyUI 运行时：落点就是 folder_paths.input_directory，用例把它顶成临时目录。
"""

import asyncio
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

from stub_env import restore, snapshot

canvas = importlib.import_module("studio.canvas")   # conftest.py 把 studio 顶成占位包，插件入口不执行
FOLDER_PATHS_STUB = "folder_paths"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24


def _request(name, body=b"", content_length=None) -> types.SimpleNamespace:
    """假请求：这条 handler 只读 query 里的 name、content_length 与体字节三样。"""
    async def read():
        return body

    return types.SimpleNamespace(
        rel_url=types.SimpleNamespace(query={"name": name}),
        content_length=content_length if content_length is not None else len(body),
        read=read)


def _run(name, body=PNG, content_length=None):
    return asyncio.run(canvas.canvas_upload(_request(name, body, content_length)))


class CanvasUploadTests(unittest.TestCase):
    def setUp(self):
        self._saved = snapshot((FOLDER_PATHS_STUB,))
        self._tmp = tempfile.TemporaryDirectory()
        self.input_dir = Path(self._tmp.name) / "input"
        self.input_dir.mkdir()
        mod = types.ModuleType(FOLDER_PATHS_STUB)
        mod.input_directory = str(self.input_dir)
        sys.modules[FOLDER_PATHS_STUB] = mod

    def tearDown(self):
        restore((FOLDER_PATHS_STUB,), self._saved)
        self._tmp.cleanup()

    def landed(self):
        return sorted(path.name for path in self.input_dir.iterdir())

    def test_dropped_file_lands_in_input_root(self):
        data = json.loads(_run("cat.png").body)
        self.assertTrue(data["success"])
        self.assertEqual((data["filename"], data["subfolder"]), ("cat.png", ""))
        self.assertEqual((self.input_dir / "cat.png").read_bytes(), PNG)

    def test_same_name_appends_counter(self):
        names = [json.loads(_run("cat.png").body)["filename"],
                 json.loads(_run("cat.png").body)["filename"]]
        self.assertEqual(names, ["cat.png", "cat_1.png"],
                         "input/ 是 ComfyUI 自己的目录，覆盖别人传上去的那一张是数据事故")
        self.assertEqual(self.landed(), ["cat.png", "cat_1.png"])

    def test_dropped_path_is_a_filename_only(self):
        """桌面窗口交出的名带整条路径与冒号：只认最后一个路径段，落点不许带出目录段。"""
        filename = json.loads(_run("C:\\Users\\tony\\Desktop\\猫猫 图 1.png").body)["filename"]
        self.assertEqual(filename, "猫猫_图_1.png")
        self.assertEqual(self.landed(), [filename])
        self.assertEqual(json.loads(_run("../../evil.png").body)["filename"], "evil.png",
                         "穿越段拼进文件名也不许跑出 input/ 根目录")
        self.assertEqual(self.landed(), ["evil.png", filename])

    def test_extension_the_canvas_does_not_take_is_refused(self):
        resp = _run("pack.zip", b"PK\x03\x04")
        self.assertEqual(resp.status, 400)
        self.assertEqual(self.landed(), [], "不收的文件不落 input/")

    def test_oversize_is_refused_with_a_status_code(self):
        """413 是「这张太大」：前端那句「上传失败（413）」靠的就是这个状态码。"""
        self.assertEqual(_run("big.mp4", b"", canvas.MAX_UPLOAD_BYTES + 1).status, 413)
        self.assertEqual(self.landed(), [])

    def test_empty_body_is_refused(self):
        self.assertEqual(_run("cat.png", b"").status, 400)
        self.assertEqual(self.landed(), [])


if __name__ == "__main__":
    unittest.main()
