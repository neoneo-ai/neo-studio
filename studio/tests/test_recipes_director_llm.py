# SPDX-License-Identifier: Apache-2.0
"""recipes 导演「文字故事板分段」后端逻辑的离线单测。

不依赖 ComfyUI 运行中的服务器与真实 LLM：server/folder_paths 用桩模块替换，
recipes 的 gallery/bookmark/gallery_lora/util 依赖用假模块；`run_llm_task` 通过
桩 `_PKG.llm.run_llm_task` 注入可控返回，验证端点组装、JSON 解析容错与多模态调用。"""

from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import asyncio
import json
import logging
import os
import sys
import tempfile
import types
import unittest

_TMP = tempfile.mkdtemp(prefix="neo_recipes_dirllm_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
_folder_paths.get_temp_directory = lambda: os.path.join(_TMP, "temp")
_folder_paths.get_annotated_filepath = lambda name, base_dir: os.path.join(base_dir, str(name).replace("/", os.sep))
sys.modules["folder_paths"] = _folder_paths

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_recipes_dirllm_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    import importlib.util
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


_gallery = types.ModuleType(f"{_PKG}.gallery")
_gallery.AUDIO_EXTENSIONS = {".mp3", ".wav"}
_gallery.IMG_EXTENSIONS = {".png", ".jpg", ".jpeg"}
_gallery.VIDEO_EXTENSIONS = {".mp4", ".webm"}
_gallery._copy_media_to_input = lambda src, fname: (fname, False)
sys.modules[f"{_PKG}.gallery"] = _gallery
setattr(_pkg, "gallery", _gallery)

_bookmark = types.ModuleType(f"{_PKG}.bookmark")
_bookmark._download_bytes = lambda *a, **k: b""
_bookmark._media_ext_from_url_or_bytes = lambda *a, **k: ".png"
sys.modules[f"{_PKG}.bookmark"] = _bookmark
setattr(_pkg, "bookmark", _bookmark)

_gallery_lora = types.ModuleType(f"{_PKG}.gallery_lora")
_gallery_lora.LORA_CACHE_DIR = os.path.join(_TMP, "lora_cache")
_gallery_lora._load_lora_index = lambda *a, **k: {}
sys.modules[f"{_PKG}.gallery_lora"] = _gallery_lora
setattr(_pkg, "gallery_lora", _gallery_lora)

_util = types.ModuleType(f"{_PKG}.util")
_util._extract_media_metadata = lambda *a, **k: {}
_util._json_safe = lambda v: v
class _PF(logging.Filter):
    def filter(self, record):
        return True
_util.PrefixFilter = _PF
sys.modules[f"{_PKG}.util"] = _util
setattr(_pkg, "util", _util)

# llm 桩：run_llm_task 由测试用例按需替换（记录调用参数，便于验证多模态调用）
_llm_calls = []


def _default_run_llm_task(task_name, text, images=None, **kw):
    _llm_calls.append({"task": task_name, "text": text, "images": images})
    if task_name == "director_story":
        return {"status": "success", "segments": json.dumps([{"prompt": "p1", "duration_sec": 5, "storyboard_prompt": "sb1"}, {"prompt": "p2", "duration_sec": 8}])}
    if task_name == "director_optimize":
        return {"status": "success", "prompt": "优化段"}
    return {"status": "success", "segments": json.dumps([{"prompt": "p1", "duration_sec": 5}, {"prompt": "p2", "duration_sec": 5}])}


def _default_run_llm_task_stream(task_name, text, images=None, **kw):
    """run_llm_task_stream 桩：yield {text, kind}；记录调用参数。director_optimize / director_panel_describe 出正文。"""
    _llm_calls.append({"task": task_name, "text": text, "images": images})
    if task_name == "director_optimize":
        yield {"text": "优化段", "kind": "content"}
    elif task_name == "director_panel_describe":
        yield {"text": "H3 i2v 提示词", "kind": "content"}
    else:
        yield {"text": "", "kind": "content"}


_llm = types.ModuleType(f"{_PKG}.llm")
_llm.run_llm_task = _default_run_llm_task
_llm.run_llm_task_stream = _default_run_llm_task_stream
sys.modules[f"{_PKG}.llm"] = _llm
setattr(_pkg, "llm", _llm)

recipes = _load("recipes", "recipes.py")


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _sse_text(resp):
    """消费 SSE 响应体，拼成完整文本。兼容：纯 bytes/text（早期错误返回）与异步生成器（流式正文）。"""
    async def _collect():
        body = resp.body
        if isinstance(body, (bytes, bytearray)):
            return bytes(body).decode("utf-8")
        if isinstance(body, str):
            return body
        # web.Response(body=<async gen>) 被 aiohttp 包成 AsyncIterablePayload，底层迭代器存于 _iter
        iterable = getattr(body, "_iter", None) or body
        out = b""
        async for chunk in iterable:
            out += chunk
        return out.decode("utf-8")
    return _run_async(_collect())


def _parse_sse(text):
    """解析 SSE 帧 → [(kind, payload)]；kind ∈ {'text','done','error'}。与前端 sseStream 一致：[ERROR] 前缀（裸文本或 JSON text）都算错误帧。"""
    frames = []
    for block in text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        assert block.startswith("data: "), block
        data = block[len("data: "):]
        if data == "[DONE]":
            frames.append(("done", None))
        elif data.startswith("[ERROR]"):
            frames.append(("error", data[len("[ERROR]"):].strip()))
        else:
            parsed = json.loads(data)
            t = parsed.get("text")
            if isinstance(t, str) and t.startswith("[ERROR]"):
                frames.append(("error", t[len("[ERROR]"):].strip()))
            else:
                frames.append(("text", parsed))
    return frames


def _sse_content(frames):
    """SSE 帧里所有正文块拼成的文本。"""
    return "".join(f[1]["text"] for f in frames if f[0] == "text")


class _FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class _FPBase(unittest.TestCase):
    # 全量跑时多个测试文件都在模块级覆盖 sys.modules["folder_paths"]，recipes 运行时
    # import folder_paths 会取到最后一个覆盖者的目录；每个用例前钉回本文件的桩、结束还原。
    def setUp(self):
        self._prev_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = _folder_paths

    def tearDown(self):
        if self._prev_fp is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self._prev_fp


# ===========================================================================
# 纯函数：_parse_segments / _read_input_image_bytes
# ===========================================================================
class ParseSegmentsTests(_FPBase):
    def test_plain_json_array(self):
        raw = '[{"prompt": "a", "duration_sec": 5}, {"prompt": "b", "duration_sec": 10}]'
        out = recipes._parse_segments(raw)
        self.assertEqual(out, [{"prompt": "a", "duration_sec": 5}, {"prompt": "b", "duration_sec": 10}])

    def test_markdown_wrapped(self):
        raw = '```json\n[{"prompt": "x", "duration_sec": 8}]\n```'
        out = recipes._parse_segments(raw)
        self.assertEqual(out, [{"prompt": "x", "duration_sec": 8}])

    def test_surrounding_prose(self):
        raw = '好的，以下是分镜：\n[{"prompt": "y", "duration_sec": 15}]\n希望有帮助。'
        out = recipes._parse_segments(raw)
        self.assertEqual(out, [{"prompt": "y", "duration_sec": 15}])

    def test_invalid_returns_empty(self):
        self.assertEqual(recipes._parse_segments("not json"), [])
        self.assertEqual(recipes._parse_segments('{"a": 1}'), [])
        self.assertEqual(recipes._parse_segments(""), [])

    def test_skips_missing_prompt_and_bad_duration(self):
        raw = '[{"prompt": "", "duration_sec": 5}, {"prompt": "ok", "duration_sec": "bad"}, {"no_prompt": 1}]'
        out = recipes._parse_segments(raw)
        self.assertEqual(out, [{"prompt": "ok", "duration_sec": 0}])


class RefHelpersTests(_FPBase):
    def test_read_input_image_bytes_missing_returns_none(self):
        self.assertIsNone(recipes._read_input_image_bytes(""))
        self.assertIsNone(recipes._read_input_image_bytes("../evil.png"))
        self.assertIsNone(recipes._read_input_image_bytes("no_such_file.png"))

    def test_read_input_image_bytes_reads_file(self):
        p = os.path.join(_INPUT_DIR, "img.png")
        with open(p, "wb") as f:
            f.write(b"\x89PNG-bytes")
        self.assertEqual(recipes._read_input_image_bytes("img.png"), b"\x89PNG-bytes")


# ===========================================================================
# 端点：文字故事板 → 分段（director_generate_segments）
# ===========================================================================
class GenerateSegmentsEndpointTests(_FPBase):
    def test_success_parses_segments(self):
        req = _FakeRequest({"idea": "一只机器猫找家", "segment_seconds": 10})
        resp = _run_async(recipes.rs_recipes_director_generate_segments(req))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(len(data["segments"]), 2)
        self.assertIn("storyboard_prompt", data["segments"][0])
        call = _llm_calls[-1]
        self.assertIn("一只机器猫找家", call["text"])
        self.assertIn("约 10 秒", call["text"])
        self.assertIsNone(call["images"], "不带角色参考时不发图片")

    def test_script_input(self):
        req = _FakeRequest({"script": "场景一…", "segment_seconds": 5})
        resp = _run_async(recipes.rs_recipes_director_generate_segments(req))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertIn("已确认的故事脚本", _llm_calls[-1]["text"])

    def test_default_segment_seconds_is_five(self):
        # 缺省 5 秒：出片默认一段短片，多段要调用方点名秒数
        req = _FakeRequest({"idea": "机器猫"})
        resp = _run_async(recipes.rs_recipes_director_generate_segments(req))
        self.assertTrue(json.loads(resp.body)["success"])
        self.assertIn("约 5 秒", _llm_calls[-1]["text"])

    def test_character_refs_attached(self):
        p = os.path.join(_INPUT_DIR, "cat.png")
        with open(p, "wb") as f:
            f.write(b"imgbytes")
        req = _FakeRequest({"idea": "机器猫", "characters": ["cat.png", "cat.png"]})
        resp = _run_async(recipes.rs_recipes_director_generate_segments(req))
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        call = _llm_calls[-1]
        self.assertIsNotNone(call["images"], "角色参考图以多模态附上")

    def test_empty_input_rejected(self):
        req = _FakeRequest({"idea": "   ", "script": ""})
        resp = _run_async(recipes.rs_recipes_director_generate_segments(req))
        self.assertEqual(resp.status, 400)

    def test_bad_json_rejected(self):
        req = _FakeRequest(ValueError("bad json"))
        resp = _run_async(recipes.rs_recipes_director_generate_segments(req))
        self.assertEqual(resp.status, 400)

    def test_unparseable_result_rejected(self):
        original = _llm.run_llm_task

        def _bad(task_name, text, images=None, **kw):
            return {"status": "success", "segments": "这不是 JSON"}

        _llm.run_llm_task = _bad
        try:
            req = _FakeRequest({"idea": "机器猫"})
            resp = _run_async(recipes.rs_recipes_director_generate_segments(req))
            self.assertEqual(resp.status, 422)
        finally:
            _llm.run_llm_task = original


class OptimizePromptsEndpointTests(_FPBase):
    def test_success_returns_single_prompt(self):
        req = _FakeRequest({"prompt": "段一", "duration_sec": 5, "mode": "r2v", "refs": {"images": ["a.png", "b.png"], "videos": ["v.mp4"]}})
        resp = _run_async(recipes.rs_recipes_director_optimize_prompts(req))
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.content_type, "text/event-stream")
        frames = _parse_sse(_sse_text(resp))
        self.assertEqual(_sse_content(frames), "优化段")
        self.assertTrue(any(f[0] == "done" for f in frames))
        text = _llm_calls[-1]["text"]
        self.assertIn("生成模式：r2v", text)
        self.assertIn("<Picture 1>…<Picture 2>", text)
        self.assertIn("<Video 1>", text)
        self.assertIn("约 5 秒", text)

    def test_missing_prompt_rejected(self):
        resp = _run_async(recipes.rs_recipes_director_optimize_prompts(_FakeRequest({"prompt": ""})))
        frames = _parse_sse(_sse_text(resp))
        self.assertTrue(any(f[0] == "error" for f in frames), frames)

    def test_empty_llm_result_rejected(self):
        """LLM 流无正文 → SSE 以 [ERROR] 帧上报（前端据此标记该段失败并继续下一段）。"""
        original = _llm.run_llm_task_stream
        _llm.run_llm_task_stream = lambda *a, **k: iter(())
        try:
            resp = _run_async(recipes.rs_recipes_director_optimize_prompts(_FakeRequest({"prompt": "a"})))
            frames = _parse_sse(_sse_text(resp))
            self.assertTrue(any(f[0] == "error" for f in frames), frames)
        finally:
            _llm.run_llm_task_stream = original

    def test_multimodal_sends_image_bytes(self):
        """参考图存在于 input/ 时，LLM 调用应带上图片字节（多模态）。"""
        original = _llm.run_llm_task_stream
        calls = []

        def _one(task_name, text, images=None, **kw):
            calls.append(images)
            yield {"text": "优化后的段一", "kind": "content"}

        _llm.run_llm_task_stream = _one
        try:
            p = os.path.join(_INPUT_DIR, "opt_ref.png")
            with open(p, "wb") as f:
                f.write(b"opt-bytes")
            req = _FakeRequest({"prompt": "段一", "duration_sec": 5, "refs": {"images": ["opt_ref.png"]}})
            resp = _run_async(recipes.rs_recipes_director_optimize_prompts(req))
            frames = _parse_sse(_sse_text(resp))
            self.assertEqual(_sse_content(frames), "优化后的段一")
            self.assertTrue(calls[0])   # 参考图存在 → LLM 调用带图片字节
        finally:
            _llm.run_llm_task_stream = original


# ===========================================================================
# 端点：宫格图拆分 / 逐格 LLM 描述
# ===========================================================================
class GridSplitEndpointTests(_FPBase):
    @staticmethod
    def _make_grid(path, rows=2, cols=3, cell=(160, 120), gap=8):
        from PIL import Image, ImageDraw
        cw, ch = cell
        img = Image.new("RGB", (cols * cw + (cols + 1) * gap, rows * ch + (rows + 1) * gap), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        for r in range(rows):
            for c in range(cols):
                color = ((r * cols + c) * 37 % 200 + 20, (r * 13 + 40) % 200, (c * 53 + 60) % 200)
                x0 = gap + c * (cw + gap)
                y0 = gap + r * (ch + gap)
                draw.rectangle([x0, y0, x0 + cw - 1, y0 + ch - 1], fill=color)
        img.save(path)

    def test_split_2x3_grid(self):
        """真实 PIL 6 格图 → 检出 2×3，各格落 input/（尺寸=内容区），返回行优先文件名。"""
        from PIL import Image
        src = os.path.join(_INPUT_DIR, "grid_src.png")
        self._make_grid(src)
        req = _FakeRequest({"filename": "grid_src.png"})
        resp = _run_async(recipes.rs_recipes_grid_split(req))
        data = json.loads(resp.body)
        self.assertTrue(data["success"], data)
        self.assertEqual((data["rows"], data["cols"]), (2, 3))
        self.assertEqual(len(data["panels"]), 6)
        for p in data["panels"]:
            saved = Image.open(os.path.join(_INPUT_DIR, p["filename"]))
            self.assertEqual(saved.size, (158, 118))   # 格子不带分隔条 / 图边，并各内缩 1px
            self.assertIn("/view?filename=", p["preview_url"])
        self.assertEqual(data["prompts"], [], "原图没有元信息 → 没有提示词")

    def test_split_returns_metadata_prompts(self):
        """原宫格图元信息里的正向提示词随拆分结果返回（前端作「全局故事参考（默认为原宫格提示词）」的默认值，可手动改写）。"""
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo
        src = os.path.join(_INPUT_DIR, "grid_meta.png")
        self._make_grid(src)
        info = PngInfo()
        info.add_text("prompt", json.dumps({
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "模糊、低质量"}},
            "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"prompt": "九宫格分镜：美女跳起中国舞"}},
            "5": {"class_type": "KSampler", "inputs": {"negative": ["3", 0], "steps": 20}},
        }))
        with Image.open(src) as im:
            loaded = im.copy()   # 先读进内存再带元信息覆写（Windows 下同文件读写句柄会冲突）
        loaded.save(src, pnginfo=info)

        resp = _run_async(recipes.rs_recipes_grid_split(_FakeRequest({"filename": "grid_meta.png"})))
        data = json.loads(resp.body)
        self.assertTrue(data["success"], data)
        self.assertEqual(data["prompts"], ["九宫格分镜：美女跳起中国舞"])

    def test_split_missing_file(self):
        resp = _run_async(recipes.rs_recipes_grid_split(_FakeRequest({"filename": "no_such.png"})))
        data = json.loads(resp.body)
        self.assertFalse(data["success"])

    def test_split_bad_filename_rejected(self):
        resp = _run_async(recipes.rs_recipes_grid_split(_FakeRequest({"filename": "../evil.png"})))
        data = json.loads(resp.body)
        self.assertFalse(data["success"])


class DescribePanelEndpointTests(_FPBase):
    def test_success_returns_single_prompt_with_panel_image(self):
        """单格多模态调用：一张分镜图字节喂给 LLM，流式返回该格的 H3 i2v 提示词。"""
        original = _llm.run_llm_task_stream
        calls = []

        def _one(task_name, text, images=None, **kw):
            calls.append((task_name, text, images))
            yield {"text": "H3 i2v 提示词", "kind": "content"}

        _llm.run_llm_task_stream = _one
        try:
            with open(os.path.join(_INPUT_DIR, "pa.png"), "wb") as f:
                f.write(b"panel-bytes-pa")
            req = _FakeRequest({"panel": "pa.png", "duration_sec": 4})
            resp = _run_async(recipes.rs_recipes_director_describe_panel(req))
            frames = _parse_sse(_sse_text(resp))
            self.assertEqual(_sse_content(frames), "H3 i2v 提示词")
            task, text, images = calls[0]
            self.assertEqual(task, "director_panel_describe")
            self.assertEqual(len(images), 1)   # 每次调用只带一张分镜图
            self.assertIn("约 4 秒", text)
        finally:
            _llm.run_llm_task_stream = original

    def test_empty_prompt_rejected(self):
        """LLM 流无正文 → SSE 以 [ERROR] 帧上报（前端据此标记该格失败并继续下一格）。"""
        original = _llm.run_llm_task_stream
        _llm.run_llm_task_stream = lambda *a, **k: iter(())
        try:
            resp = _run_async(recipes.rs_recipes_director_describe_panel(_FakeRequest({"panel": "a.png"})))
            frames = _parse_sse(_sse_text(resp))
            self.assertTrue(any(f[0] == "error" for f in frames), frames)
        finally:
            _llm.run_llm_task_stream = original

    def test_missing_panel_rejected(self):
        resp = _run_async(recipes.rs_recipes_director_describe_panel(_FakeRequest({"panel": ""})))
        frames = _parse_sse(_sse_text(resp))
        self.assertTrue(any(f[0] == "error" for f in frames), frames)

    def test_context_fields_appended_to_text(self):
        """宫格上下文：本格序号/行列、原宫格提示词、上一段结果都拼进 text，图仍只一张。"""
        original = _llm.run_llm_task_stream
        calls = []

        def _one(task_name, text, images=None, **kw):
            calls.append((task_name, text, images))
            yield {"text": "H3 i2v 提示词", "kind": "content"}

        _llm.run_llm_task_stream = _one
        try:
            with open(os.path.join(_INPUT_DIR, "pb.png"), "wb") as f:
                f.write(b"panel-bytes-pb")
            req = _FakeRequest({
                "panel": "pb.png", "duration_sec": 4,
                "panel_index": 4, "panel_total": 9, "rows": 3, "cols": 3,
                "grid_prompts": ["九宫格故事指令一", "   ", "第二句"],
                "prev_prompt": "上一段提示词XYZ",
            })
            resp = _run_async(recipes.rs_recipes_director_describe_panel(req))
            frames = _parse_sse(_sse_text(resp))
            self.assertEqual(_sse_content(frames), "H3 i2v 提示词")
            task, text, images = calls[0]
            self.assertEqual(len(images), 1)   # 上下文全走文本，图仍只一张分镜图
            self.assertIn("第 4 段（共 9 段）", text)
            self.assertIn("第 2 行第 1 列", text)   # idx=4 → 第 2 行第 1 列（行优先）
            self.assertIn("九宫格故事指令一", text)
            self.assertIn("第二句", text)
            self.assertNotIn("故事上下文：\n\n", text)   # 空白项被过滤，不留空行
            self.assertIn("上一段（第 3 段）已生成的提示词", text)
            self.assertIn("上一段提示词XYZ", text)
        finally:
            _llm.run_llm_task_stream = original

    def test_context_missing_or_invalid_degrades(self):
        """上下文字段缺失/非法时静默降级：仍 200，text 只含图+时长，不报错。"""
        original = _llm.run_llm_task_stream
        calls = []

        def _one(task_name, text, images=None, **kw):
            calls.append((task_name, text, images))
            yield {"text": "H3 i2v 提示词", "kind": "content"}

        _llm.run_llm_task_stream = _one
        try:
            with open(os.path.join(_INPUT_DIR, "pc.png"), "wb") as f:
                f.write(b"panel-bytes-pc")
            req = _FakeRequest({
                "panel": "pc.png", "duration_sec": 6,
                "panel_index": 10, "panel_total": 9,   # 越界 → 不加位置块
                "rows": "abc", "cols": None,           # 非数字 → 不算行列
                "grid_prompts": "不是数组",             # 非数组 → 不加故事上下文
                "prev_prompt": "   ",                   # 空串 → 不加承接
            })
            resp = _run_async(recipes.rs_recipes_director_describe_panel(req))
            frames = _parse_sse(_sse_text(resp))
            self.assertEqual(_sse_content(frames), "H3 i2v 提示词")
            text = calls[0][1]
            self.assertIn("约 6 秒", text)
            self.assertNotIn("第 10 段", text)
            self.assertNotIn("故事上下文", text)
            self.assertNotIn("上一段", text)
        finally:
            _llm.run_llm_task_stream = original


if __name__ == "__main__":
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)

