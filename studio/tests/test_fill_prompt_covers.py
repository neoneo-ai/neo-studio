# SPDX-License-Identifier: Apache-2.0
# tools/fill_prompt_covers.py 的匹配与写入：旁车整行、内嵌元数据整行、--loose 包含、按池取产物。

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

_TOOLS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tools"))
_SPEC = importlib.util.spec_from_file_location(
    "fill_prompt_covers", os.path.join(_TOOLS, "fill_prompt_covers.py"))
cover_init = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(cover_init)

HEAD = "红衣女孩站在雨夜的霓虹街角回头"
OTHER_HEAD = "白衣男孩在天台上看城市日出"
MP4 = {".mp4"}


def prompt_graph(text: str) -> dict:
    """一条产物的内嵌元数据：ComfyUI 的 prompt 图里正提示词那个字段"""
    return {"prompt": json.dumps({"1": {"class_type": "CLIPTextEncode",
                                        "inputs": {"text": text}}})}


class FakeUtil:
    """插件 util 的最小替身：只替掉读文件字节那一段格式解码，后缀与文本收集都用插件那一份"""

    def __init__(self, real):
        self.real = real
        self.meta_map: dict[Path, dict] = {}

    def _extract_media_metadata(self, path) -> dict:
        return self.meta_map.get(Path(path), {})

    def __getattr__(self, item):
        return getattr(self.real, item)


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.util = FakeUtil(cover_init.load_studio()[2])

    def media(self, name: str, head: str = HEAD, sidecar: bool = True, meta: bool = True,
              mtime: int = 1000) -> Path:
        path = self.root / name
        path.write_bytes(b"fake media")
        os.utime(path, (mtime, mtime))
        if sidecar:
            path.with_name(name + ".txt").write_text(f"{head}\n1024x1024 steps=20", encoding="utf-8")
        if meta:
            self.util.meta_map[path] = prompt_graph(head)
        return path

    def plan(self, name: str, media: list[Path], loose: bool = False, head: str = HEAD) -> dict:
        prompts = [{"name": name, "txt": self.root / "p.txt", "head": head,
                    "mtime": 1, "has_cover": False}]
        return cover_init.plan_covers(prompts, cover_init.media_entries(media, self.util), loose)[0]

    def test_sidecar_line_is_tier_one(self):
        target = self.media("a.png", meta=False)
        self.assertEqual(self.plan("p", [target])["tier"], 1)

    def test_embedded_meta_is_tier_two(self):
        target = self.media("a.png", sidecar=False)
        self.assertEqual(self.plan("p", [target])["tier"], 2)

    def test_sidecar_beats_a_newer_meta_match(self):
        sidecar_hit = self.media("sidecar.png", meta=False, mtime=1000)
        meta_hit = self.media("meta.png", sidecar=False, mtime=2000)
        plan = self.plan("p", [sidecar_hit, meta_hit])
        self.assertEqual((plan["tier"], plan["file"]), (1, sidecar_hit))

    def test_newest_wins_within_a_tier(self):
        old = self.media("old.png", sidecar=False, mtime=1000)
        new = self.media("new.png", sidecar=False, mtime=2000)
        self.assertEqual(self.plan("p", [old, new])["file"], new)

    def test_image_prompt_never_picks_a_video(self):
        self.assertEqual(self.plan("p", [self.media("clip.mp4")])["file"], None)

    def test_video_prompt_picks_the_video_pool(self):
        video = self.media("clip.mp4")
        image = self.media("frame.png", mtime=2000)
        plan = self.plan("video/p", [video, image])
        self.assertEqual((plan["pool"], plan["file"]), ("video", video))

    def test_pool_follows_the_video_directory_and_the_v_prefix(self):
        self.assertTrue(cover_init.is_video_pool("video/片段"))
        self.assertTrue(cover_init.is_video_pool("video/系列/片段"))
        self.assertTrue(cover_init.is_video_pool("_V_01_片段"))
        self.assertFalse(cover_init.is_video_pool("成图一条"))


    def test_containment_needs_the_loose_flag(self):
        # 视频与多段片的元数据里是整篇正文（首行加后续分镜），整行相等对不上，--loose 才吃
        target = self.media("clip.mp4", sidecar=False)
        self.util.meta_map[target] = prompt_graph(HEAD + "，第二镜她走进店里坐下")
        self.assertEqual(self.plan("video/p", [target])["file"], None)
        self.assertEqual(self.plan("video/p", [target], loose=True)["tier"], 3)

    def test_short_head_has_no_discriminating_power(self):
        target = self.root / "a.png"
        target.write_bytes(b"x")
        target.with_name("a.png.txt").write_text("你好", encoding="utf-8")
        self.assertEqual(self.plan("p", [target], loose=True, head="你好")["file"], None)

    def test_workflow_json_sidecar_is_not_a_prompt(self):
        target = self.root / "a.png"
        target.write_bytes(b"x")
        target.with_name("a.png.txt").write_text(json.dumps({"nodes": []}), encoding="utf-8")
        self.assertEqual(self.plan("p", [target])["file"], None)

    def test_exported_workflow_text_counts_as_a_meta_match(self):
        # 前端导出的 workflow JSON 也在元数据里：节点里的那句提示词同样是这条产物的来路
        target = self.root / "a.png"
        target.write_bytes(b"x")
        self.util.meta_map[target] = {"workflow": json.dumps(
            {"nodes": [{"widgets_values": ["16:9 (Widescreen)", HEAD]}]})}
        self.assertEqual(self.plan("p", [target])["tier"], 2)

    def test_media_without_sidecar_or_meta_leaves_the_prompt_unmatched(self):
        target = self.root / "a.png"
        target.write_bytes(b"x")
        self.assertEqual(self.plan("p", [target], loose=True)["file"], None)


class WriteCoverTests(unittest.TestCase):
    def test_image_cover_is_a_jpeg_at_the_sidecar_size(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "out.png"
            Image.new("RGB", (900, 400), (10, 20, 30)).save(source)
            target = Path(tmp) / "cover.jpg"
            self.assertTrue(cover_init.write_cover(source, target, 512, None, MP4))
            with Image.open(target) as cover:
                self.assertEqual((cover.format, max(cover.size)), ("JPEG", 512))

    def test_transparent_source_gets_a_white_base(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "out.png"
            Image.new("RGBA", (300, 200), (0, 0, 0, 0)).save(source)
            target = Path(tmp) / "cover.jpg"
            self.assertTrue(cover_init.write_cover(source, target, 512, None, MP4))
            with Image.open(target) as cover:
                self.assertEqual(cover.convert("RGB").getpixel((10, 10)), (255, 255, 255))

    def test_video_without_a_decoder_is_a_reported_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "clip.mp4"
            source.write_bytes(b"fake video")
            target = Path(tmp) / "cover.jpg"
            self.assertFalse(cover_init.write_cover(source, target, 512, None, MP4))
            self.assertFalse(target.exists())


class FrameSignatureTests(unittest.TestCase):
    """首帧签名那一档：只给「已有封面、来路整行对不上、旁边没有指针」的条补那条指针，那张 JPEG 不动"""

    def test_a_decisive_first_place_is_accepted(self):
        self.assertTrue(cover_init.frame_match_accepted(0.003, 0.4))

    def test_a_second_place_right_behind_is_a_guess(self):
        # 前两名挨在一起说的是「这批片长得像」，不是「这张封面切自它」
        self.assertFalse(cover_init.frame_match_accepted(0.019, 0.021))

    def test_a_weak_first_place_is_rejected(self):
        self.assertFalse(cover_init.frame_match_accepted(0.19, 0.9))

    def test_a_frame_of_another_shape_never_enters_the_ranking(self):
        flat = [1.0] * cover_init.FRAME_SIG_GRID ** 2
        wide = [1.0] * cover_init.FRAME_SIG_GRID ** 2
        sigs = {Path("wide.mp4"): (wide, 1.78), Path("scope.mp4"): (flat, 2.39)}
        cover_sig = [1.6] * cover_init.FRAME_SIG_GRID ** 2
        hit = cover_init.best_frame_match((cover_sig, 2.39), sigs)
        self.assertEqual(hit[0], Path("scope.mp4"))

    def test_the_pointer_fill_leaves_the_cover_jpeg_untouched(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cover = root / "p.jpg"
            Image.new("RGB", (512, 220), (30, 40, 50)).save(cover)
            before = cover.read_bytes()
            video = root / "clip.mp4"
            video.write_bytes(b"fake video")
            _plugin_paths, prompt_names, _util = cover_init.load_studio()
            cover_init.write_cover_pointer(prompt_names, cover, video, [root], MP4)
            pointer = cover.with_name(cover.stem + prompt_names.COVER_SOURCE_SUFFIX)
            self.assertEqual(json.loads(pointer.read_text(encoding="utf-8")),
                             {"filename": "clip.mp4", "subfolder": "", "kind": "video",
                              "w": 512, "h": 220})
            self.assertEqual(cover.read_bytes(), before)


class LoaderTests(unittest.TestCase):
    def test_cover_rules_come_from_the_plugin_not_from_a_second_copy(self):
        """脚本读的是插件那一份 prompt_names / util：sidecar 后缀、封面尺寸、视频后缀不能各写一套"""
        _plugin_paths, prompt_names, util = cover_init.load_studio()
        self.assertEqual((prompt_names.COVER_SUFFIX, prompt_names.COVER_MAX_SIDE), (".jpg", 512))
        self.assertIn(".mp4", util.VIDEO_EXTENSIONS)
        self.assertTrue(callable(util._extract_media_metadata))


if __name__ == "__main__":
    unittest.main()
