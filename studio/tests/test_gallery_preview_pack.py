# SPDX-License-Identifier: Apache-2.0
"""发布预处理里卡片预览那一发（离线单测，不跑 ffmpeg）。

--preview 给每条视频压一发短边封顶 480 的静音片落 previews/<目录>/，目录索引条目带 "preview" 键，
提示词库的卡片自动播就吃这一发。参数口径（静音 / 短边 480 / faststart / 码率上限）钉在这里，
ffmpeg 缺席时只跳过这一条，不压垮整次发布；update 模式的 prune 跟着索引留对应的预览。
"""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

_TOOLS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tools"))
_SPEC = importlib.util.spec_from_file_location(
    "gallery_preprocess_preview", os.path.join(_TOOLS, "gallery_preprocess.py"))
pack = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(pack)


def _write_video(stem: str, src: Path) -> Path:
    src.mkdir(parents=True, exist_ok=True)
    (src / f"{stem}.mp4").write_bytes(b"fake-video-bytes")
    (src / f"{stem}.txt").write_text(f"标题：{stem}\n提示词：正文首行", encoding="utf-8")
    return src


class PreviewCmdTests(unittest.TestCase):
    """ffmpeg 参数：静音、短边封顶 480、faststart、码率上限，落点永远是最后一个参数"""

    def test_cmd_is_silent_480p_faststart(self):
        cmd = pack.preview_cmd(Path("in/01.mp4"), Path("previews/d/01.mp4"))
        self.assertIn("-an", cmd)
        vf = cmd[cmd.index("-vf") + 1]
        # 横屏钉高（854×480）、竖屏钉宽（480×706）：与素材库插件现压那一条同一条 -vf
        self.assertIn(f"'if(gt(iw,ih),min(ih,{pack.PREVIEW_SHORT_EDGE}),-2)'", vf)
        self.assertIn(f"'if(gt(iw,ih),-2,min(iw,{pack.PREVIEW_SHORT_EDGE}))'", vf)
        self.assertEqual(cmd[cmd.index("-c:v") + 1], "libx264")
        self.assertEqual(cmd[cmd.index("-preset") + 1], "veryfast")
        self.assertEqual(cmd[cmd.index("-crf") + 1], "30")
        self.assertEqual(cmd[cmd.index("-pix_fmt") + 1], "yuv420p")
        self.assertIn("+faststart", cmd[cmd.index("-movflags") + 1])
        self.assertEqual(cmd[cmd.index("-maxrate") + 1], pack.PREVIEW_MAXRATE)
        self.assertEqual(cmd[cmd.index("-bufsize") + 1], pack.PREVIEW_MAXRATE)
        self.assertEqual(Path(cmd[-1]), Path("previews") / "d" / "01.mp4")


class PreviewScanTests(unittest.TestCase):
    """scan_directory 的预览位：只给视频条目写键，预览文件落 previews/<目录>/"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.src = _write_video("01_Remotion", self.root / "presets" / "明朝人物")
        (self.src / "02_海报.mp4").write_bytes(b"fake-video-bytes")
        self.out = self.root / "out"
        self._thumb = pack.generate_thumbnail
        self._preview = pack.generate_video_preview
        self.addCleanup(setattr, pack, "generate_thumbnail", self._thumb)
        self.addCleanup(setattr, pack, "generate_video_preview", self._preview)
        pack.generate_thumbnail = lambda src, dst, size: (dst.parent.mkdir(parents=True, exist_ok=True),
                                                          dst.write_bytes(b"jpg"), True)[-1]

    def _scan(self, preview: bool):
        pack.generate_video_preview = lambda src, dst: (dst.parent.mkdir(parents=True, exist_ok=True),
                                                        dst.write_bytes(b"mp4"), True)[-1]
        entries, _ = pack.scan_directory(self.src, self.out, 320, True, False, preview)
        return {Path(e["filename"]).stem: e for e in entries}

    def test_preview_flag_writes_preview_key_for_videos(self):
        by_stem = self._scan(preview=True)
        self.assertEqual(by_stem["01_Remotion"]["preview"], "previews/明朝人物/01_Remotion.mp4")
        self.assertTrue((self.out / "previews" / "明朝人物" / "01_Remotion.mp4").exists())

    def test_without_preview_flag_no_preview_key(self):
        by_stem = self._scan(preview=False)
        self.assertNotIn("preview", by_stem["01_Remotion"])
        self.assertFalse((self.out / "previews" / "明朝人物" / "01_Remotion.mp4").exists())

    def test_missing_ffmpeg_skips_preview_only_for_that_item(self):
        pack.generate_video_preview = self._preview   # 真函数：测 ffmpeg 缺席这一路
        self.addCleanup(setattr, pack, "ffmpeg_exe", pack.ffmpeg_exe)
        pack.ffmpeg_exe = lambda: None
        entries, _ = pack.scan_directory(self.src, self.out, 320, True, False, True)
        by_stem = {Path(e["filename"]).stem: e for e in entries}
        self.assertNotIn("preview", by_stem["01_Remotion"])
        self.assertTrue((self.out / "明朝人物" / "01_Remotion.mp4").exists())   # 原片照发


class PreviewPruneTests(unittest.TestCase):
    """update 模式：预览跟着索引留，源目录删掉的那条把预览一起带走"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.src = _write_video("01_Remotion", self.root / "presets" / "明朝人物")
        self.out = self.root / "out"
        self._thumb = pack.generate_thumbnail
        self._preview = pack.generate_video_preview
        self.addCleanup(setattr, pack, "generate_thumbnail", self._thumb)
        self.addCleanup(setattr, pack, "generate_video_preview", self._preview)
        pack.generate_thumbnail = lambda src, dst, size: (dst.parent.mkdir(parents=True, exist_ok=True),
                                                          dst.write_bytes(b"jpg"), True)[-1]

    def test_prune_drops_preview_of_removed_item(self):
        stale = self.out / "previews" / "明朝人物" / "09_已删条目.mp4"
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_bytes(b"stale")
        pack.generate_video_preview = lambda src, dst: (dst.parent.mkdir(parents=True, exist_ok=True),
                                                        dst.write_bytes(b"mp4"), True)[-1]
        kept = self.out / "previews" / "明朝人物" / "01_Remotion.mp4"
        pack.scan_directory(self.src, self.out, 320, True, True, True)
        self.assertTrue(kept.exists())
        self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()