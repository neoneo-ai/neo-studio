# SPDX-License-Identifier: Apache-2.0
"""视频反推（POST /rs_prompts/reverse_video_prompt）离线单测：多帧入参、时间戳正文、落点与缓存。

三条产品规则都在这一页：
- 结果只写视频同名的 .rp.txt / .rp-lang —— 视频同名 .txt 是「再来一发」读进去的生效参数旁车；
- 帧数进缓存标记（.rp-lang 落 zh|8）：换一次采样就重新反推，图片那条标记仍是纯语言；
- 原生引擎一次只吃第一张图，多帧必须在进 LLM 之前被挡下。
"""

import asyncio
import base64
import json
import os
import sys
import types
import tempfile
import unittest
from pathlib import Path

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _NODE_DIR)
_COMFY_ROOT = os.path.abspath(os.path.join(_NODE_DIR, "..", ".."))
sys.path.insert(0, _COMFY_ROOT)

_PKG_NAME = "_neo_prompts_video_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg


class _FakeRoutes:
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


_prev_server = sys.modules.get("server")
_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

_prompts_import_error = ""
try:
    import importlib
    prompts_mod = importlib.import_module(f"{_PKG_NAME}.prompts")
    PROMPTS_AVAILABLE = True
except Exception as _e:
    prompts_mod = None
    PROMPTS_AVAILABLE = False
    _prompts_import_error = str(_e)
finally:
    if _prev_server is None:
        sys.modules.pop("server", None)
    else:
        sys.modules["server"] = _prev_server

# 两帧的假 PNG：canvas 的 data URI 与裸 base64 两种写法都收
_FRAME_A = "data:image/png;base64," + base64.b64encode(b"\x89PNG frame-a").decode()
_FRAME_B = base64.b64encode(b"\x89PNG frame-b").decode()


@unittest.skipUnless(PROMPTS_AVAILABLE, f"prompts module unavailable: {_prompts_import_error}")
class VideoFrameHelpersTests(unittest.TestCase):
    """帧序列的解码与正文拼装：时间戳标签是视频反推与图片反推唯一的分别。"""

    def test_decode_accepts_data_uri_and_bare_base64(self):
        frames = prompts_mod._decode_reverse_frames(
            [{"t": 6.9, "data": _FRAME_A}, {"t": 13.8, "data": _FRAME_B}])
        self.assertEqual([t for t, _ in frames], [6.9, 13.8])
        self.assertEqual([blob for _, blob in frames],
                         [b"\x89PNG frame-a", b"\x89PNG frame-b"])

    def test_decode_skips_items_without_a_picture(self):
        frames = prompts_mod._decode_reverse_frames(
            [{"t": 1, "data": "not-base64!!"}, {"t": 2}, {"data": _FRAME_B}, "junk", None])
        # 只留有画面那一条：帧号缺时间就记 0，坏数据与形状不对的一律不进请求
        self.assertEqual([(t, blob) for t, blob in frames], [(0.0, b"\x89PNG frame-b")])

    def test_frame_stamp_is_minutes_seconds_millis(self):
        self.assertEqual(prompts_mod._reverse_video_frame_stamp(0), "00:00.000")
        self.assertEqual(prompts_mod._reverse_video_frame_stamp(6.9), "00:06.900")
        # 59.9995 秒取整到 60000ms 不能写成 00:59.1000：毫秒进位要进到 01:00.000
        self.assertEqual(prompts_mod._reverse_video_frame_stamp(59.9995), "01:00.000")
        self.assertEqual(prompts_mod._reverse_video_frame_stamp(75.5), "01:15.500")

    def test_user_text_labels_every_frame_with_its_timestamp(self):
        frames = prompts_mod._decode_reverse_frames(
            [{"t": 6.9, "data": _FRAME_A}, {"t": 13.8, "data": _FRAME_B}])
        text = prompts_mod._reverse_video_user_text(frames, "zh", 30.0)
        self.assertIn("帧1@00:06.900", text)
        self.assertIn("帧2@00:13.800", text)
        self.assertIn("整片时长 00:30.000", text)

    def test_user_text_english_variant_carries_the_same_labels(self):
        text = prompts_mod._reverse_video_user_text([(6.9, b"x")], "en")
        self.assertIn("frame 1 at 00:06.900", text)
        self.assertNotIn("整片", text)

    def test_zh_system_prompt_is_chinese(self):
        sp = prompts_mod._reverse_video_system_prompt("zh")
        self.assertIn("时间戳", sp)
        self.assertNotIn("masterpiece", sp)

    def test_en_system_prompt_uses_the_video_skill_default(self):
        self.assertEqual(prompts_mod._reverse_video_system_prompt("en"),
                         prompts_mod.LLM_TASKS["video_reverse_prompt"]["system"])
        self.assertIn("timestamp", prompts_mod.LLM_TASKS["video_reverse_prompt"]["system"])


@unittest.skipUnless(PROMPTS_AVAILABLE, f"prompts module unavailable: {_prompts_import_error}")
class VideoReverseRouteTests(unittest.TestCase):
    """端点本体：入参校验、.rp.txt 落点、按帧数失效的缓存与原生引擎的多帧闸门。"""

    def setUp(self):
        d = tempfile.mkdtemp(prefix="neo_rp_video_")
        self.video = Path(d) / "shot.mp4"
        self.video.write_bytes(b"ftypmp4")
        # 视频同名 .txt 是「视频再来一发」读进去的生效参数：反推一发都不能碰它
        self.sidecar = Path(d) / "shot.txt"
        self.sidecar.write_text("seed 42, steps 20", encoding="utf-8")

        # 注入假 gallery，供端点内 from .gallery import _find_source_media
        self._gallery_name = f"{_PKG_NAME}.gallery"
        self._prev_gallery = sys.modules.get(self._gallery_name)
        fake_gallery = types.ModuleType(self._gallery_name)
        fake_gallery._find_source_media = lambda fn, sf: self.video
        sys.modules[self._gallery_name] = fake_gallery

        # LLM 链换桩：记录进链的 task / 正文 / 帧，产出一段固定正文
        self.calls = {}
        self._llm_mod = sys.modules[f"{_PKG_NAME}.llm"]
        self._prev_stream = self._llm_mod.run_llm_task_stream
        self._prev_mode = prompts_mod.get_current_mode
        prompts_mod.get_current_mode = lambda: prompts_mod.LLM_MODE_REMOTE
        self._llm_mod.run_llm_task_stream = self._fake_stream

        # 直接调 handler 时 aiohttp 不会把 body 装成 payload：截 Response 的入参读流与文本
        self._sent = []
        self._prev_response = prompts_mod.web.Response

        def _spy(*a, **k):
            self._sent.append(k)
            return self._prev_response(*a, **k)

        prompts_mod.web.Response = _spy

    def tearDown(self):
        self._llm_mod.run_llm_task_stream = self._prev_stream
        prompts_mod.get_current_mode = self._prev_mode
        prompts_mod.web.Response = self._prev_response
        if self._prev_gallery is None:
            sys.modules.pop(self._gallery_name, None)
        else:
            sys.modules[self._gallery_name] = self._prev_gallery

    def _fake_stream(self, task, text, images=None, system_prompt="", **kw):
        self.calls.update(task=task, text=text, images=images, system_prompt=system_prompt)
        return iter([{"text": "a slow push-in ", "kind": "content"},
                     {"text": "on a neon alley", "kind": "content"}])

    def _payload(self, frames=None, **extra):
        body = {"filename": "shot.mp4", "subfolder": "Video", "language": "zh",
                "frames": [{"t": 6.9, "data": _FRAME_A}, {"t": 13.8, "data": _FRAME_B}]
                if frames is None else frames,
                "range": {"start": 6.9, "end": 13.8, "duration": 30.0}}
        body.update(extra)
        return body

    class _Req:
        def __init__(self, payload):
            self._payload = payload

        async def json(self):
            return self._payload

    def _post(self, payload):
        """跑一次端点，拿它发出去的那一发响应的入参（流式是生成器，失败是文本）。"""
        self._sent.clear()
        asyncio.run(prompts_mod.rs_prompts_reverse_video_prompt(self._Req(payload)))
        return self._sent[-1]

    def _stream_frames(self, payload):
        return asyncio.run(self._frames(self._post(payload)["body"]))

    @staticmethod
    async def _frames(body):
        out = []
        async for raw in body:
            text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
            for line in text.split("\n"):
                if line.startswith("data: "):
                    out.append(line[6:])
        return out

    def test_two_frames_go_to_the_video_skill_with_their_timestamps(self):
        self._stream_frames(self._payload())
        self.assertEqual(self.calls["task"], "video_reverse_prompt")
        self.assertIn("帧1@00:06.900", self.calls["text"])
        self.assertIn("整片时长 00:30.000", self.calls["text"])
        self.assertEqual(len(self.calls["images"]), 2)

    def test_result_lands_in_rp_txt_and_never_the_generation_sidecar(self):
        frames = self._stream_frames(self._payload())
        meta = [json.loads(f) for f in frames if f != "[DONE]"][-1]["meta"]
        self.assertEqual(meta["txt_file"], "shot.rp.txt")
        self.assertEqual(self.video.with_suffix(".rp.txt").read_text(encoding="utf-8"),
                         "a slow push-in on a neon alley")
        self.assertEqual(self.video.with_suffix(".rp-lang").read_text(encoding="utf-8"), "zh|2")
        self.assertEqual(self.sidecar.read_text(encoding="utf-8"), "seed 42, steps 20",
                         "反推一发不能碰「视频再来一发」读进去的生效参数旁车")

    def test_same_frame_count_same_language_hits_the_cache(self):
        self.video.with_suffix(".rp.txt").write_text("cached push-in", encoding="utf-8")
        self.video.with_suffix(".rp-lang").write_text("zh|2", encoding="utf-8")
        frames = self._stream_frames(self._payload())
        self.assertEqual(json.loads(frames[0])["text"], "cached push-in")
        self.assertEqual(self.calls, {}, "命中缓存不该进 LLM 链")

    def test_frame_count_change_forces_a_reversal(self):
        # 旧缓存是 4 帧那一次采样：这次抽 2 帧，标记对不上就重跑并覆盖落点
        self.video.with_suffix(".rp.txt").write_text("cached four-frame run", encoding="utf-8")
        self.video.with_suffix(".rp-lang").write_text("zh|4", encoding="utf-8")
        self._stream_frames(self._payload())
        self.assertEqual(self.calls.get("task"), "video_reverse_prompt")
        self.assertEqual(self.video.with_suffix(".rp-lang").read_text(encoding="utf-8"), "zh|2")

    def test_a_bare_language_marker_is_not_a_video_cache_hit(self):
        # 图片那条留下的纯语言标记不能被视频当成命中
        self.video.with_suffix(".rp.txt").write_text("cached image run", encoding="utf-8")
        self.video.with_suffix(".rp-lang").write_text("zh", encoding="utf-8")
        self._stream_frames(self._payload())
        self.assertEqual(self.calls.get("task"), "video_reverse_prompt")

    def test_image_cache_marker_stays_the_language_itself(self):
        # 图片链的标记一字不变：旧缓存文件照旧命中
        img = self.video.with_suffix(".png")
        txt, lang = img.with_suffix(".txt"), img.with_suffix(".rp-lang")
        txt.write_text("a red-haired girl", encoding="utf-8")
        lang.write_text("zh", encoding="utf-8")
        self.assertEqual(prompts_mod._reverse_cache_hit(txt, lang, "zh"), "a red-haired girl")


    def _refused(self, payload):
        """校验挡在进 LLM 之前：失败帧是直接文本，一条 LLM 链都不该起。"""
        text = self._post(payload)["text"]
        self.assertIn("[ERROR]", text)
        self.assertIn("[DONE]", text)
        self.assertEqual(self.calls, {}, f"不该进 LLM 链: {text}")
        return text

    def test_non_video_file_is_refused(self):
        img = self.video.with_suffix(".png")
        img.write_bytes(b"\x89PNG")
        sys.modules[self._gallery_name]._find_source_media = lambda fn, sf: img
        self.assertIn("视频", self._refused(self._payload(filename="shot.png")))

    def test_frame_list_over_the_cap_is_refused(self):
        many = [{"t": i * 1.0, "data": _FRAME_B}
                for i in range(prompts_mod.REVERSE_VIDEO_MAX_FRAMES + 1)]
        self.assertIn(str(prompts_mod.REVERSE_VIDEO_MAX_FRAMES),
                      self._refused(self._payload(frames=many)))

    def test_empty_frame_list_is_refused(self):
        self.assertIn("帧", self._refused(self._payload(frames=[])))

    def test_missing_video_is_refused(self):
        sys.modules[self._gallery_name]._find_source_media = lambda fn, sf: None
        self._refused(self._payload())

    def test_native_engine_refuses_more_than_one_frame(self):
        prompts_mod.get_current_mode = lambda: prompts_mod.LLM_MODE_NATIVE
        self.assertIn("原生", self._refused(self._payload()))

    def test_native_engine_takes_a_single_frame(self):
        prompts_mod.get_current_mode = lambda: prompts_mod.LLM_MODE_NATIVE
        frames = self._stream_frames(self._payload(frames=[{"t": 6.9, "data": _FRAME_A}]))
        self.assertEqual(frames[-1], "[DONE]")
        self.assertEqual(self.calls["task"], "video_reverse_prompt")

    def test_video_reverse_lives_on_the_kernel_side_of_the_caps_table(self):
        """桌面端自服不了这条链：能力表把它归内核，前端据此在离线窗口门控。"""
        import studio_caps as caps
        route = ("POST", "/rs_prompts/reverse_video_prompt")
        self.assertEqual(caps.owner(*route), "comfy", "离线窗口只能 409，桌面端不自服这条")
        self.assertTrue(caps.forwardable(*route), "内核在跑时桌面端口要把这一发转给内核")
        self.assertEqual(caps.FEATURE_ROUTES["prompt_reverse_video"], route)
        self.assertIn("prompt_reverse_video", caps.KERNEL_FEATURES, "能力表据此翻面")


if __name__ == "__main__":
    unittest.main()


