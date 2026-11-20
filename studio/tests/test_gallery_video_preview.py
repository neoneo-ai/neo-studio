# SPDX-License-Identifier: Apache-2.0
"""素材库卡片自动播的那一发：短边封顶 480、静音、只留开头 10 秒、分段回（离线单测）。

卡片是循环播的：一条 5 分钟的 NAS 片不能变成一次三分钟的首屏请求 —— -t 在输出侧封顶，
ffmpeg 只解到那一秒就收工；也不能带音轨（-an，有声本体走灯箱那条 /neo_gallery/video）。
+faststart 决定首帧要不要等整篇下完：没有它，卡片在整片落地之前只是一张封面图。
压片比缩略图贵一个数量级，所以同一时刻只允许一发 ffmpeg 在压：排队的请求排在锁上有界等待
（一屏十几条视频是一次交回的一串请求，全部顶回 404 等于把这一屏全判成「只能停在封面上」），
等满了才 404，卡片停在首帧封面上，不铺一格解不开的播放器（ffmpeg 缺席的机器同理 —— 404 是
这台机器没这个能力）。
缓存新鲜性按「路径 + mtime + size + e480_10」判，短边上限与封顶秒数写在文件名里：以后改常数，
旧文件的键自动不匹配，不会留下「文件名写着 15、里面是整片」的脏缓存。
失败路径钉三条：ffmpeg 中途失败不留中间份（半份 mp4 头部有 moov 却没有完整帧），
中间份的后缀留 .mp4（封装器是 ffmpeg 按输出扩展名选的，认不出来就是整条链全灭），
非视频与越界路径在入口就 400/404。ffmpeg 本体由桩替掉，桩照 ffmpeg 那样按扩展名选封装器，
用例不依赖 ffmpeg，也不联网。
"""

import os
import sys
import subprocess
import tempfile
import types
import unittest
import importlib.util as _importlib_util
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="neo_gallery_video_preview_")
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
_folder_paths.get_input_directory = lambda: _INPUT
_folder_paths.get_output_directory = lambda: _OUTPUT
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_gallery_video_preview_pkg"
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
      OSS_NAV_PREFIX="Cloud Presets", OSS_ARTIFACT_DIRS=("previews", "thumbnails"),
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
      _find_preview_in_oss_index=_oss_none,
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
_PREVIEW_BASE = Path(_TMP) / "preview_cache"
gallery.VIDEO_PREVIEW_DIR = _PREVIEW_BASE
_REAL_SUBPROCESS = gallery.subprocess

# 每次 ffmpeg 调用记下 argv 与 kwargs；returncode 按 _RESULTS 逐次取，取完算成功。
_CALLS: list[tuple[list[str], dict]] = []
_RESULTS: list[int] = []


def _fake_run(cmd, **kwargs):
    """替掉 ffmpeg：成功时把输出文件写出来（压片写的是中间份那一个）。

    封装器是 ffmpeg 按输出文件名的扩展名选的，认不出来就是一句 returncode 1 ——
    本机那条 "Unable to choose an output format" 的失败要在桩上一样倒得出来。
    """
    _CALLS.append((list(cmd), kwargs))
    code = _RESULTS.pop(0) if _RESULTS else 0
    if code == 0:
        out = Path(cmd[-1])
        if out.suffix != ".mp4":
            return types.SimpleNamespace(returncode=1, stdout=b"", stderr=b"invalid argument")
        out.write_bytes(b"fake-preview")
    return types.SimpleNamespace(returncode=code, stdout=b"", stderr=b"")


def _pair(cmd: list[str], flag: str) -> str:
    """取 "-t 10" 这种「标志 值」对里的值。"""
    return cmd[cmd.index(flag) + 1]


def _use_fake_ffmpeg(exe="ffmpeg"):
    gallery.subprocess = types.SimpleNamespace(
        run=_fake_run, SubprocessError=_REAL_SUBPROCESS.SubprocessError)
    gallery._ffmpeg_exe = lambda: exe


class PreviewGeneration(unittest.TestCase):
    """_video_preview_file：缓存新鲜就直回；压片参数封顶时长与音轨；失败不留脏文件。"""

    def setUp(self):
        _CALLS.clear()
        _RESULTS.clear()
        _use_fake_ffmpeg()
        # 每个用例一份独立的缓存根：上一用例留下的缓存不能被本用例当成「新鲜的」直回
        gallery.VIDEO_PREVIEW_DIR = _PREVIEW_BASE / self.id()
        self.src_dir = gallery.CUSTOM_DIR / "vidprev"
        self.src_dir.mkdir(parents=True, exist_ok=True)
        self.mp4 = self.src_dir / "clip.mp4"
        self.mp4.write_bytes(b"source-video")

    def tearDown(self):
        gallery.subprocess = _REAL_SUBPROCESS
        gallery.VIDEO_PREVIEW_DIR = _PREVIEW_BASE

    def test_preview_cmd_caps_duration_audio_and_faststart(self):
        """短边 480、静音、-t 10、+faststart、封装器写死、no-window 创建标志，一条不缺。"""
        preview = gallery._video_preview_file(self.mp4)
        self.assertIsNotNone(preview)
        cmd, kwargs = _CALLS[0]
        self.assertEqual(cmd[cmd.index("-i") + 1], str(self.mp4))
        self.assertIn("-an", cmd)
        self.assertEqual(_pair(cmd, "-t"), str(gallery.VIDEO_PREVIEW_MAX_SECONDS))
        self.assertEqual(_pair(cmd, "-movflags"), "+faststart")
        self.assertEqual(_pair(cmd, "-f"), "mp4")
        edge = gallery.VIDEO_PREVIEW_SHORT_EDGE
        vf = cmd[cmd.index("-vf") + 1]
        # 封顶按短边：横屏钉高度、竖屏钉宽度，两边都只剩缩小。只钉宽度时横屏只剩 480×270，
        # 铺不满横屏那一格（那一格的高只有列宽的 3/4），铺满就是放大播
        self.assertIn(f"'if(gt(iw,ih),-2,min(iw,{edge}))'", vf)
        self.assertIn(f"'if(gt(iw,ih),min(ih,{edge}),-2)'", vf)
        self.assertEqual(kwargs.get("creationflags"), gallery.NO_WINDOW)
        # 只写中间份再 replace：落进缓存的永远是一份完整的 mp4，中间份的后缀留 .mp4
        self.assertTrue(cmd[-1].endswith(".part.mp4"))
        self.assertEqual(preview.read_bytes(), b"fake-preview")

    def test_queued_request_reuses_the_warmed_cache(self):
        """排到队时这一发多半已被前一条请求压好了：判一次新鲜就端缓存，不再重压一发。"""
        cache = gallery._video_preview_cache_path(self.mp4, self.mp4.stat())
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(b"fake-preview")
        stamp = self.mp4.stat().st_mtime + 5
        os.utime(cache, (stamp, stamp))
        self.assertTrue(gallery._generate_video_preview(self.mp4, cache))
        self.assertEqual(_CALLS, [])
        self.assertEqual(cache.read_bytes(), b"fake-preview")

    def test_cache_name_carries_short_edge_and_cap(self):
        """文件名带 e480 与 10 这个键：常数变了、或封顶口径从按宽换成按短边，旧键自动不匹配。"""
        preview = gallery._video_preview_file(self.mp4)
        self.assertIn(f"_e{gallery.VIDEO_PREVIEW_SHORT_EDGE}_{gallery.VIDEO_PREVIEW_MAX_SECONDS}.mp4",
                      preview.name)

    def test_fresh_cache_never_spawns_ffmpeg(self):
        """首屏是反复打的：缓存新鲜时一次 ffmpeg 都不起（与缩略图同一套 mtime 口径）。"""
        stat = self.mp4.stat()
        cache = gallery._video_preview_cache_path(self.mp4, stat)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(b"cached-preview")
        future = stat.st_mtime + 10
        os.utime(cache, (future, future))
        self.assertEqual(gallery._video_preview_file(self.mp4), cache)
        self.assertEqual(_CALLS, [])

    def test_stale_source_rebuilds_under_a_new_key(self):
        """重生成同名素材：mtime 进缓存键，旧文件不会被当成新鲜的端回来。"""
        first = gallery._video_preview_file(self.mp4)
        self.assertIsNotNone(first)
        stamp = self.mp4.stat().st_mtime + 20
        os.utime(self.mp4, (stamp, stamp))
        self.assertNotEqual(gallery._video_preview_file(self.mp4), first)
        self.assertEqual(len(_CALLS), 2)

    def test_failed_encode_leaves_no_cache_and_no_part(self):
        """ffmpeg 中途失败：缓存里既没有 mp4 也没有 .part —— 半份文件头部有 moov 却没完整帧。"""
        _RESULTS.append(1)
        self.assertIsNone(gallery._video_preview_file(self.mp4))
        self.assertEqual([p for p in gallery.VIDEO_PREVIEW_DIR.rglob("*") if p.is_file()], [])

    def test_no_ffmpeg_degrades_to_cover(self):
        """这台机器没有 ffmpeg：直回 None，卡片停在首帧封面上，不铺一格解不开的播放器。"""
        gallery._ffmpeg_exe = lambda: None
        self.assertIsNone(gallery._video_preview_file(self.mp4))
        self.assertEqual(_CALLS, [])


class PreviewRoute(unittest.IsolatedAsyncioTestCase):
    """GET /neo_gallery/preview：本地现压、分段回；非视频与无能力时的入口口径。"""

    def setUp(self):
        _CALLS.clear()
        _RESULTS.clear()
        _use_fake_ffmpeg()
        gallery.VIDEO_PREVIEW_DIR = _PREVIEW_BASE / self.id()
        # 路由那侧要过 _find_source_media 的寻址：素材落在桩的 ComfyUI output 下，
        # subfolder 就是它的相对目录（与素材页交回给前端的 subfolder 同一口径）
        self.src_dir = Path(_OUTPUT) / "prev_route"
        self.src_dir.mkdir(parents=True, exist_ok=True)
        self.mp4 = self.src_dir / "clip.mp4"
        self.mp4.write_bytes(b"source-video")
        self.png = self.src_dir / "still.png"
        self.png.write_bytes(b"source-image")

    def tearDown(self):
        gallery.subprocess = _REAL_SUBPROCESS
        gallery.VIDEO_PREVIEW_DIR = _PREVIEW_BASE

    def _request(self, query):
        return types.SimpleNamespace(rel_url=types.SimpleNamespace(query=query))

    async def test_missing_filename_is_400(self):
        self.assertEqual((await gallery.view_video_preview(self._request({}))).status, 400)

    async def test_traversal_is_400(self):
        query = {"filename": "clip.mp4", "subfolder": "../../secret"}
        self.assertEqual((await gallery.view_video_preview(self._request(query))).status, 400)

    async def test_non_video_is_400(self):
        query = {"filename": "still.png", "subfolder": "prev_route"}
        self.assertEqual((await gallery.view_video_preview(self._request(query))).status, 400)

    async def test_no_ffmpeg_is_404(self):
        gallery._ffmpeg_exe = lambda: None
        query = {"filename": "clip.mp4", "subfolder": "prev_route"}
        self.assertEqual((await gallery.view_video_preview(self._request(query))).status, 404)

    async def test_preview_is_served_as_a_ranged_file(self):
        """卡片循环播：分段响应让循环回去时只重读需要的字节（FileResponse 自带 Range）。"""
        query = {"filename": "clip.mp4", "subfolder": "prev_route"}
        resp = await gallery.view_video_preview(self._request(query))
        self.assertEqual(resp.status, 200)
        self.assertIsInstance(resp, gallery.web.FileResponse)
        self.assertEqual(resp.headers.get("Content-Type"), "video/mp4")
        self.assertIn("max-age", resp.headers.get("Cache-Control", ""))

    async def test_cloud_preset_without_oss_is_404(self):
        """云端预设且 OSS 未配置：404（卡片停在首帧封面），不现压、不联网。"""
        query = {"filename": "missing.mp4", "subfolder": "presets/neo-codex/999999999"}
        self.assertEqual((await gallery.view_video_preview(self._request(query))).status, 404)
