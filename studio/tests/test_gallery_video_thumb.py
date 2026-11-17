# SPDX-License-Identifier: Apache-2.0
"""素材页视频缩略图的 ffmpeg 调用带 no-window 创建标志，并按请求尺寸出图（离线单测）。

桌面端用 CREATE_NO_WINDOW 拉起 ComfyUI：父进程没有控制台，Windows 就给派生出来的控制台程序
新建一个窗口。顶部归类标签一次聚合全库，懒加载网格逐条要缩略图，每个未命中缓存的视频都会
派生一次 ffmpeg —— 屏幕上一闪一片黑框，一条视频一个框。钉的就是每次 ffmpeg 调用都带上创建
标志，输入 seek 失败后的回退调用也不例外（漏一次就漏一次闪窗）。ffmpeg 还要自己把帧缩到请求
尺寸：整帧 JPEG 在 1080p 是 75KB、4K 是几 MB，卡片只要 320px，旧缓存里躺着的就是这种整帧大图，
所以命中前先比一次尺寸，不合格就地重生成。ffmpeg 本体由桩替掉，用例不依赖 ffmpeg，也不联网。
"""

import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
import importlib.util as _importlib_util
from pathlib import Path

from PIL import Image

_TMP = tempfile.mkdtemp(prefix="neo_gallery_video_thumb_")
_INPUT = os.path.join(_TMP, "input")
_OUTPUT = os.path.join(_TMP, "output")
os.makedirs(_INPUT, exist_ok=True)
os.makedirs(_OUTPUT, exist_ok=True)

_prev_server = sys.modules.get("server")
_prev_folder_paths = sys.modules.get("folder_paths")

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(
    instance=types.SimpleNamespace(
        routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f))))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.input_directory = _INPUT
_folder_paths.output_directory = _OUTPUT
_folder_paths.get_output_directory = lambda: _OUTPUT
_folder_paths.get_input_directory = lambda: _INPUT
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_gallery_video_thumb_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _stub(name, **attrs):
    mod = types.ModuleType(f"{_PKG}.{name}")
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    return mod

_stub("util",
      IMG_EXTENSIONS={".png", ".jpg", ".jpeg"}, VIDEO_EXTENSIONS={".mp4"},
      AUDIO_EXTENSIONS={".mp3"}, ALL_MEDIA_EXTENSIONS={".png", ".jpg", ".jpeg", ".mp4", ".mp3"},
      _has_media_recursive=lambda *a, **k: False,
      _has_media_in_dir_any=lambda *a, **k: False,
      _extract_media_metadata=lambda *a, **k: {},
      _collect_prompt_texts=lambda *a, **k: [],
      _load_settings=lambda *a, **k: {},
      _save_settings=lambda *a, **k: None,
      _json_safe=lambda v: v)


async def _oss_none(*a, **k):
    return None


async def _oss_no_items(*a, **k):
    return []


_stub("gallery_oss",
      OSS_NAV_PREFIX="Cloud Presets",
      OSS_CACHE_DIR=Path(_TMP) / "oss_cache",
      _is_oss_enabled=lambda: False,
      _load_oss_index_from_disk=lambda *a, **k: {},
      _fetch_oss_index=lambda *a, **k: None,
      _oss_index_dirs=lambda *a, **k: [],
      _oss_directories_to_gallery_dirs=lambda *a, **k: [],
      OSS_TAG_CHARACTER_SHEET="character-sheet",
      _oss_tagged_dir_tokens=lambda *a, **k: [],
      _collect_oss_covers=lambda *a, **k: {},
      _handle_oss_gallery_list=lambda *a, **k: None,
      _find_in_oss_index=_oss_none,
      _find_thumbnail_in_oss_index=_oss_none,
      _download_oss_file=lambda *a, **k: None,
      _oss_dir_cards=lambda *a, **k: {},
      _oss_dir_items=_oss_no_items)
_stub("gallery_lora",
      _lora_pending_subdirs=lambda *a, **k: {},
      _attach_lora_meta=lambda *a, **k: None,
      _attach_lora_subdir_paths=lambda *a, **k: None,
      _ensure_auto_cache=lambda *a, **k: None,
      _normalize_lora_dir=lambda *a, **k: "")
_stub("bookmark", CIVITAI_BOOKMARK_DIR=Path(_TMP) / "civitai_bookmarks",
      CIVITAI_DIR_KEY="civitai_bookmarks", _is_civitai_bookmark_enabled=lambda: False)

_spec = _importlib_util.spec_from_file_location(f"{_PKG}.gallery", os.path.join(PLUGIN_DIR, "gallery.py"))
gallery = _importlib_util.module_from_spec(_spec)
sys.modules[f"{_PKG}.gallery"] = gallery
setattr(_pkg, "gallery", gallery)
_spec.loader.exec_module(gallery)

# 桩只在导入期占用全局名，避免影响其它测试文件（它们各自安装同名桩）。
if _prev_server is None:
    sys.modules.pop("server", None)
else:
    sys.modules["server"] = _prev_server
if _prev_folder_paths is None:
    sys.modules.pop("folder_paths", None)
else:
    sys.modules["folder_paths"] = _prev_folder_paths

gallery.THUMBNAIL_DIR = Path(_TMP) / "thumbnails"
_REAL_SUBPROCESS = gallery.subprocess

# 每次 ffmpeg 调用记下 argv 与 kwargs；returncode 按 _RESULTS 逐次取，取完算成功。
_CALLS: list[tuple[list[str], dict]] = []
_RESULTS: list[int] = []


def _requested_dims(cmd: list[str]) -> tuple[int, int]:
    """读 -vf scale=W:H 里要求的尺寸；命令不带缩放时按整帧算（旧版行为）。"""
    match = re.search(r"scale=(\d+):(\d+)", " ".join(cmd))
    if match:
        return int(match.group(1)), int(match.group(2))
    return 640, 480


def _write_jpeg(path: Path, width: int = 640, height: int = 480) -> None:
    """桩交回的产物要过函数末尾那两道关：PIL 验得出，且不小于 1KB。

    纯色 JPEG 压出来只有几百字节，会被「产物太小」那道判定挡掉，用例就跑不到成功路径，
    所以喂随机字节当像素。
    """
    Image.frombytes("RGB", (width, height), os.urandom(width * height * 3)).save(path, "JPEG", quality=95)


def _fake_run(cmd, **kwargs):
    cmd = [str(c) for c in cmd]
    _CALLS.append((cmd, kwargs))
    returncode = _RESULTS.pop(0) if _RESULTS else 0
    if returncode == 0:
        _write_jpeg(Path(cmd[-1]), *_requested_dims(cmd))
    return types.SimpleNamespace(returncode=returncode, stdout=b"", stderr=b"")


def _cache_path_for(source: Path, size: int) -> Path:
    """照 _thumbnail_payload 的算法算出某张素材在某尺寸下的缓存文件路径。"""
    stat = source.stat()
    bucket = time.strftime("%Y-%m", time.localtime(stat.st_mtime))
    return gallery.THUMBNAIL_DIR / bucket / f"{gallery._thumbnail_hash(source, stat)}_{size}.jpg"


def _payload_size(body: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(body)) as img:
        return img.size


class VideoThumbnailSpawnTests(unittest.TestCase):
    """ffmpeg 调用带 CREATE_NO_WINDOW 并按请求尺寸缩放：桌面端没有控制台，漏一次就闪一次黑框。"""

    def setUp(self):
        gallery.subprocess = types.SimpleNamespace(run=_fake_run)
        gallery._ffmpeg_exe = lambda: "ffmpeg"
        _CALLS.clear()
        _RESULTS.clear()
        shutil.rmtree(gallery.THUMBNAIL_DIR, ignore_errors=True)
        self.src = Path(_OUTPUT) / "clip.mp4"
        self.src.write_bytes(b"fake-mp4")
        self.cache = Path(_TMP) / "thumbs" / "clip.jpg"

    def tearDown(self):
        gallery.subprocess = _REAL_SUBPROCESS

    def _flag(self, index: int):
        return _CALLS[index][1].get("creationflags")

    def test_first_frame_call_carries_no_window_flag(self):
        self.assertTrue(gallery._generate_video_thumbnail(self.src, self.cache, 320))
        self.assertEqual(len(_CALLS), 1)
        self.assertEqual(_CALLS[0][0][:2], ["ffmpeg", "-ss"])
        self.assertEqual(self._flag(0), gallery.NO_WINDOW)
        if sys.platform == "win32":
            # 0 在 Windows 上的含义就是「照常开一个控制台窗口」，标志必须是 CREATE_NO_WINDOW 本体
            self.assertEqual(gallery.NO_WINDOW, subprocess.CREATE_NO_WINDOW)

    def test_fallback_call_carries_the_flag_too(self):
        """输入 seek 失败后的第二条命令（去掉 -ss）同样不能开窗口。"""
        _RESULTS.extend([1, 0])
        self.assertTrue(gallery._generate_video_thumbnail(self.src, self.cache, 320))
        self.assertEqual(len(_CALLS), 2)
        self.assertIn("-ss", _CALLS[0][0])
        self.assertNotIn("-ss", _CALLS[1][0])
        self.assertEqual(self._flag(0), gallery.NO_WINDOW)
        self.assertEqual(self._flag(1), gallery.NO_WINDOW)

    def test_ffmpeg_scales_the_frame_to_the_requested_size(self):
        """整帧 JPEG 是 75KB 起，卡片只有 320px：缩放与单线程都要由 ffmpeg 做。"""
        self.assertTrue(gallery._generate_video_thumbnail(self.src, self.cache, 320))
        argv = _CALLS[0][0]
        self.assertIn("scale=320:320:force_original_aspect_ratio=decrease", argv)
        self.assertIn("-threads", argv)
        self.assertEqual(argv[argv.index("-threads") + 1], "1")
        self.assertEqual(_payload_size(self.cache.read_bytes()), (320, 320))

    def test_ffmpeg_missing_skips_spawn(self):
        gallery._ffmpeg_exe = lambda: None
        self.assertFalse(gallery._generate_video_thumbnail(self.src, self.cache, 320))
        self.assertEqual(_CALLS, [])

    def test_route_payload_carries_flag_and_size(self):
        """懒加载网格逐条调的取图函数（顶部归类标签一次就是几十条）。"""
        body, content_type = gallery._thumbnail_payload(320, self.src)
        self.assertEqual(content_type, "image/jpeg")
        self.assertEqual(len(_CALLS), 1)
        self.assertEqual(self._flag(0), gallery.NO_WINDOW)
        self.assertEqual(_payload_size(body), (320, 320))


class VideoThumbCacheFitTests(unittest.TestCase):
    """缓存命中要先看尺寸合不合格：旧缓存里躺着的是整帧大图，文件名却写着 _320。"""

    def setUp(self):
        gallery.subprocess = types.SimpleNamespace(run=_fake_run)
        gallery._ffmpeg_exe = lambda: "ffmpeg"
        _CALLS.clear()
        _RESULTS.clear()
        shutil.rmtree(gallery.THUMBNAIL_DIR, ignore_errors=True)
        self.src = Path(_OUTPUT) / "clip.mp4"
        self.src.write_bytes(b"fake-mp4")
        self.cache = _cache_path_for(self.src, 320)

    def tearDown(self):
        gallery.subprocess = _REAL_SUBPROCESS

    def _cache_newer_than_source(self, cache: Path, body: bytes) -> None:
        """把一张现成的产物摆成「已缓存」：内容随意给，mtime 比素材新。"""
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(body)
        stamp = self.src.stat().st_mtime + 10
        os.utime(cache, (stamp, stamp))

    def test_oversized_cache_entry_is_regenerated(self):
        buffer = io.BytesIO()
        Image.frombytes("RGB", (640, 480), os.urandom(640 * 480 * 3)).save(buffer, "JPEG", quality=95)
        self._cache_newer_than_source(self.cache, buffer.getvalue())

        body, _ = gallery._thumbnail_payload(320, self.src)

        self.assertEqual(len(_CALLS), 1, "整帧大图要判为不合格，重生成一次")
        self.assertEqual(_payload_size(body), (320, 320))
        self.assertEqual(_payload_size(self.cache.read_bytes()), (320, 320), "同一份缓存就地换成小图")

    def test_half_written_cache_entry_is_regenerated(self):
        self._cache_newer_than_source(self.cache, b"not-an-image")
        body, _ = gallery._thumbnail_payload(320, self.src)
        self.assertEqual(len(_CALLS), 1, "读不出图的缓存不算命中")
        self.assertEqual(_payload_size(body), (320, 320))

    def test_fitting_cache_entry_is_served_without_spawn(self):
        buffer = io.BytesIO()
        Image.frombytes("RGB", (320, 180), os.urandom(320 * 180 * 3)).save(buffer, "JPEG", quality=95)
        self._cache_newer_than_source(self.cache, buffer.getvalue())

        body, _ = gallery._thumbnail_payload(320, self.src)

        self.assertEqual(_CALLS, [], "尺寸合格且没过期就只读缓存，不再启 ffmpeg")
        self.assertEqual(_payload_size(body), (320, 180))


if __name__ == "__main__":
    unittest.main()
