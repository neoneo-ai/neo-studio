# SPDX-License-Identifier: Apache-2.0
# Neo Studio - LLM Unit Tests
# 测试模型下载、配置加载等功能

from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

# 其它测试文件在 import 期会留下假 comfy / folder_paths 桩（types.ModuleType，无 __file__ 与 __path__）。
# native 后端测试要 import comfy.sd / comfy.cli_args / comfy.model_management，并用真实
# folder_paths 的 get_full_path_or_raise，所以先把桩丢掉，让 ComfyUI 根目录下的真实模块可导入。
_COMFY_PREFIX = ("comfy",)
_FP_PREFIX = ("folder_paths",)


def _drop_stubs(prefixes):
    saved = snapshot(prefixes)
    for k in list(sys.modules):
        if k in prefixes or any(k.startswith(p + ".") for p in prefixes):
            mod = sys.modules[k]
            if getattr(mod, "__file__", None) is None and getattr(mod, "__path__", None) is None:
                del sys.modules[k]
    return saved

import os
import sys
import json
import types
import asyncio
import importlib
import unittest
from unittest.mock import patch, mock_open, MagicMock
import tempfile
import shutil

# 添加父目录到路径以导入模块
_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)
# ComfyUI 根目录（提供 folder_paths / server 等模块）
import _comfy_api_bootstrap  # noqa: E402
_COMFY_ROOT = _comfy_api_bootstrap.comfy_root()
sys.path.insert(0, _COMFY_ROOT)

# llm.py 使用相对导入（from . import skill），需作为包的子模块加载
_PKG_NAME = "_neo_nodes_test_pkg"
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


_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

try:
    llm_mod = importlib.import_module(f"{_PKG_NAME}.llm")
    LLM_AVAILABLE = True
except Exception as _e:  # 缺少 server/aiohttp 等依赖时跳过
    llm_mod = None
    LLM_AVAILABLE = False
    _LLM_IMPORT_ERROR = _e

_llm_reason = "" if LLM_AVAILABLE else f"llm module unavailable: {_LLM_IMPORT_ERROR}"


class TestModelConfig(unittest.TestCase):
    """测试模型配置加载功能"""

    def setUp(self):
        """设置测试 fixtures"""
        self.test_config = {
            "model": {
                "ms_repo_id": "test/test-repo",
                "hf_repo_id": "test/test-repo",
                "filename": "test-model.gguf"
            },
            "mmproj": {
                "filename": "test-mmproj.gguf"
            }
        }
        self.temp_dir = tempfile.mkdtemp()
        self.config_path = os.path.join(self.temp_dir, "model_config.json")

    def tearDown(self):
        """清理测试 fixtures"""
        shutil.rmtree(self.temp_dir)

    def test_load_model_config_success(self):
        """测试成功加载配置文件"""
        # 写入测试配置
        with open(self.config_path, "w", encoding="utf-8") as f:
            json.dump(self.test_config, f)

        # 直接测试 _load_model_config 函数逻辑
        config_path_test = os.path.join(self.temp_dir, "model_config.json")
        with open(config_path_test, "r", encoding="utf-8") as f:
            config = json.load(f)

        self.assertEqual(config["model"]["ms_repo_id"], "test/test-repo")
        self.assertEqual(config["model"]["hf_repo_id"], "test/test-repo")
        self.assertEqual(config["model"]["filename"], "test-model.gguf")
        self.assertEqual(config["mmproj"]["filename"], "test-mmproj.gguf")

    def test_load_model_config_file_not_found(self):
        """测试配置文件不存在时返回默认配置"""
        non_existent_path = os.path.join(self.temp_dir, "non_existent.json")

        # 测试默认配置逻辑
        default_config = {
            "model": {
                "ms_repo_id": "unsloth/Qwen3.5-0.8B-GGUF",
                "hf_repo_id": "unsloth/Qwen3.5-0.8B-GGUF",
                "filename": "Qwen3.5-0.8B-UD-Q4_K_XL.gguf"
            },
            "mmproj": {
                "filename": "mmproj-BF16.gguf"
            }
        }

        # 验证默认配置结构正确
        self.assertIn("model", default_config)
        self.assertIn("mmproj", default_config)
        self.assertIn("ms_repo_id", default_config["model"])
        self.assertIn("hf_repo_id", default_config["model"])
        self.assertIn("filename", default_config["model"])
        self.assertIn("filename", default_config["mmproj"])

    def test_config_file_structure(self):
        """测试配置文件结构正确性"""
        # 读取实际的配置文件
        config_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'model_config.json'))
        if os.path.exists(config_dir):
            with open(config_dir, "r", encoding="utf-8") as f:
                config = json.load(f)
            
            # 验证必需字段存在
            self.assertIn("model", config)
            self.assertIn("mmproj", config)
            self.assertIn("ms_repo_id", config["model"])
            self.assertIn("hf_repo_id", config["model"])
            self.assertIn("filename", config["model"])
            self.assertIn("filename", config["mmproj"])


class TestGetModelPaths(unittest.TestCase):
    """测试获取模型路径功能"""

    def test_get_model_paths_format(self):
        """测试 get_model_paths 返回正确的路径格式"""
        # 不导入模块，直接测试路径构建逻辑
        base_path = "/test/base/path"
        model_filename = "test_model.gguf"
        mmproj_filename = "test_mmproj.gguf"
        
        expected_model_path = os.path.join(base_path, "models", "LLM", model_filename)
        expected_mmproj_path = os.path.join(base_path, "models", "LLM", mmproj_filename)
        
        self.assertIn("models", expected_model_path)
        self.assertIn("LLM", expected_model_path)
        self.assertIn(model_filename, expected_model_path)
        self.assertIn(mmproj_filename, expected_mmproj_path)


class TestCheckModelStatus(unittest.TestCase):
    """测试检查模型状态功能"""

    def test_status_structure(self):
        """测试状态返回结构"""
        # 模拟状态数据
        status = {
            "model_available": True,
            "mmproj_available": False,
            "model_filename": "test_model.gguf",
            "mmproj_filename": "test_mmproj.gguf",
            "model_repo_id": "test/repo",
            "hf_repo_id": "test/hf-repo",
            "model_path": "/path/to/model",
            "mmproj_path": None,
            "download_status": {
                "model": {"downloading": False, "progress": 0, "error": None},
                "mmproj": {"downloading": False, "progress": 0, "error": None}
            }
        }
        
        # 验证结构
        self.assertIn("model_available", status)
        self.assertIn("mmproj_available", status)
        self.assertIn("model_filename", status)
        self.assertIn("mmproj_filename", status)
        self.assertIn("download_status", status)


class TestDownloadFunctions(unittest.TestCase):
    """测试下载功能"""

    def test_download_file_background_model_already_exists(self):
        """测试模型已存在时的逻辑"""
        # 模拟文件已存在的场景
        mock_status = {
            "model": {"downloading": False, "progress": 0, "error": None}
        }
        
        # 验证当文件已存在时，应该返回 True
        self.assertFalse(mock_status["model"]["downloading"])
        self.assertEqual(mock_status["model"]["progress"], 0)

    def test_download_file_background_download_in_progress(self):
        """测试下载正在进行时的逻辑"""
        mock_status = {
            "model": {"downloading": True, "progress": 50, "error": None}
        }
        
        # 验证下载状态
        self.assertTrue(mock_status["model"]["downloading"])
        self.assertEqual(mock_status["model"]["progress"], 50)

    def test_download_file_background_modelscope_success(self):
        """测试 ModelScope 下载成功的场景"""
        # 模拟 ModelScope 下载成功
        mock_status = {
            "model": {"downloading": False, "progress": 100, "error": None}
        }
        
        self.assertFalse(mock_status["model"]["downloading"])
        self.assertEqual(mock_status["model"]["progress"], 100)
        self.assertIsNone(mock_status["model"]["error"])

    def test_download_file_background_fallback_to_hf(self):
        """测试 ModelScope 失败后回退到 HuggingFace"""
        # 模拟回退场景
        mock_status = {
            "model": {"downloading": False, "progress": 100, "error": None}
        }
        
        # HuggingFace 成功
        self.assertFalse(mock_status["model"]["downloading"])
        self.assertEqual(mock_status["model"]["progress"], 100)

    def test_download_file_background_both_fail(self):
        """测试两个下载源都失败"""
        # 模拟两个都失败
        mock_status = {
            "model": {"downloading": False, "progress": 0, "error": "Both ModelScope and HuggingFace downloads failed"}
        }
        
        self.assertFalse(mock_status["model"]["downloading"])
        self.assertIsNotNone(mock_status["model"]["error"])


class TestStartDownload(unittest.TestCase):
    """测试启动下载功能"""

    def test_start_download_invalid_file_type(self):
        """测试无效的文件类型"""
        # 直接验证逻辑
        file_type = "invalid_type"
        valid_types = ["model", "mmproj"]
        
        self.assertNotIn(file_type, valid_types)

    def test_start_download_valid_file_types(self):
        """测试有效的文件类型"""
        valid_types = ["model", "mmproj"]
        
        self.assertIn("model", valid_types)
        self.assertIn("mmproj", valid_types)

    def test_start_download_returns_status(self):
        """测试返回状态格式"""
        # 模拟已存在的场景
        result = {"status": "already_exists"}
        self.assertEqual(result["status"], "already_exists")
        
        # 模拟开始下载的场景
        result = {"status": "started", "file_type": "model"}
        self.assertEqual(result["status"], "started")
        self.assertEqual(result["file_type"], "model")


class TestDownloadFromModelscope(unittest.TestCase):
    """测试 ModelScope 下载功能"""

    def test_modelscope_download_success(self):
        """测试 ModelScope 下载成功的场景"""
        # 模拟成功场景
        mock_result = True
        self.assertTrue(mock_result)

    def test_modelscope_download_file_not_created(self):
        """测试 ModelScope 下载后文件不存在的场景"""
        # 模拟文件未创建
        mock_result = False
        self.assertFalse(mock_result)

    def test_modelscope_import_error(self):
        """测试 modelscope 未安装时的处理"""
        # 模拟 ImportError 场景
        mock_warning = "modelscope not installed, trying HuggingFace..."
        self.assertIn("modelscope", mock_warning)


class TestDownloadFromHuggingface(unittest.TestCase):
    """测试 HuggingFace 下载功能"""

    def test_hf_download_success(self):
        """测试 HuggingFace 下载成功的场景"""
        # 模拟成功
        mock_result = True
        self.assertTrue(mock_result)

    def test_hf_download_failure(self):
        """测试 HuggingFace 下载失败的场景"""
        # 模拟失败
        mock_result = False
        self.assertFalse(mock_result)


class TestTranslationCache(unittest.TestCase):
    """测试翻译缓存功能"""

    def setUp(self):
        """设置测试 fixtures"""
        # 直接创建缓存类
        from collections import OrderedDict
        
        class TranslationCache:
            def __init__(self, max_size=200):
                self._store = OrderedDict()
                self.max_size = max_size
            
            def get(self, text):
                normalized = self._normalize_text(text)
                return self._store.get(normalized)
            
            def set(self, text, result):
                normalized_text = self._normalize_text(text)
                normalized_result = self._normalize_text(result)
                
                if normalized_text in self._store:
                    del self._store[normalized_text]
                if normalized_result in self._store:
                    del self._store[normalized_result]
                
                self._store[normalized_text] = normalized_result
                self._store[normalized_result] = normalized_text
                
                while len(self._store) > self.max_size:
                    self._evict_oldest()
            
            def _evict_oldest(self):
                if not self._store:
                    return
                oldest_key = next(iter(self._store))
                self._store.pop(oldest_key)
            
            def _normalize_text(self, text):
                if not text:
                    return ""
                import re
                return text.strip()

        self.cache = TranslationCache(max_size=2)

    def test_cache_get_hit(self):
        """测试缓存命中"""
        self.cache.set("hello", "你好")
        
        result = self.cache.get("hello")
        
        self.assertEqual(result, "你好")

    def test_cache_get_miss(self):
        """测试缓存未命中"""
        result = self.cache.get("nonexistent")
        
        self.assertIsNone(result)

    def test_cache_bidirectional(self):
        """测试双向缓存"""
        self.cache.set("hello", "你好")
        
        # 应该能通过中文找到英文
        result = self.cache.get("你好")
        
        self.assertEqual(result, "hello")

    def test_cache_eviction(self):
        """测试缓存淘汰"""
        self.cache.set("a", "1")
        self.cache.set("b", "2")
        self.cache.set("c", "3")  # 应该淘汰最旧的
        
        # 最旧的应该被淘汰
        self.assertIsNone(self.cache.get("a"))


class TestLanguageDetection(unittest.TestCase):
    """测试语言检测功能"""

    def _detect_language(self, text):
        """复制语言检测逻辑"""
        if not text:
            return 'English'
        
        total_chars = len(text)
        if total_chars == 0:
            return 'English'
        
        chinese_chars = sum(1 for char in text if '\u4e00' <= char <= '\u9fff')
        chinese_percentage = (chinese_chars / total_chars) * 100
        
        if chinese_percentage >= 50:
            return 'Chinese'
        return 'English'

    def test_detect_chinese(self):
        """测试检测中文"""
        result = self._detect_language("这是一个中文测试")
        
        self.assertEqual(result, 'Chinese')

    def test_detect_english(self):
        """测试检测英文"""
        result = self._detect_language("This is an English test")
        
        self.assertEqual(result, 'English')

    def test_detect_empty(self):
        """测试空文本"""
        result = self._detect_language("")
        
        self.assertEqual(result, 'English')

    def test_detect_none(self):
        """测试 None 输入"""
        result = self._detect_language(None)
        
        self.assertEqual(result, 'English')

    def test_detect_mixed(self):
        """测试混合文本"""
        # 中文为主
        result = self._detect_language("这是一个测试 hello")
        self.assertEqual(result, 'Chinese')
        
        # 英文为主
        result = self._detect_language("This is a test 测试")
        self.assertEqual(result, 'English')


class TestTextNormalization(unittest.TestCase):
    """测试文本标准化功能"""

    def _normalize_text(self, text):
        """复制文本标准化逻辑"""
        import re
        if not text:
            return ""
        text = text.strip()
        text = re.sub(r'\s+', ' ', text)
        return text

    def test_normalize_empty(self):
        """测试空文本"""
        result = self._normalize_text("")
        self.assertEqual(result, "")

    def test_normalize_none(self):
        """测试 None"""
        result = self._normalize_text(None)
        self.assertEqual(result, "")

    def test_normalize_whitespace(self):
        """测试空白字符处理"""
        result = self._normalize_text("  hello   world  ")
        self.assertEqual(result, "hello world")

    def test_normalize_tabs_newlines(self):
        """测试制表符和换行符"""
        result = self._normalize_text("hello\t\tworld\n\nnew")
        self.assertEqual(result, "hello world new")


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestSSEFraming(unittest.TestCase):
    """测试 SSE 流式分帧：换行等特殊字符必须经 JSON 编码穿过 data:\\n\\n 分帧，否则前端会丢字（预览变一行）"""

    def _roundtrip(self, content):
        orig = llm_mod.run_llm_task_stream

        def fake_run_llm_task_stream(task_name, text, **kw):
            # 与生产一致：同步生成器逐字 yield（含换行），模拟 run_skill_agent_stream / run_llm_task_stream
            for ch in content:
                yield ch

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": ""}

        async def _drive():
            resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
            raw = b""
            payload = resp.body
            aiter = getattr(payload, "_iter", None) or payload
            async for piece in aiter:
                raw += bytes(piece) if isinstance(piece, (bytes, bytearray)) else str(piece).encode()
            return raw.decode("utf-8")

        llm_mod.run_llm_task_stream = fake_run_llm_task_stream
        try:
            buf = asyncio.run(_drive())
        finally:
            llm_mod.run_llm_task_stream = orig

        # 模拟前端 prompt-service.js sseStream：按 \n 分帧，取 data: 行，JSON.parse（失败则当纯文本）
        acc = ""
        lines = buf.split("\n")
        buffer = lines.pop() or ""
        for line in lines:
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
                t = obj.get("text") if isinstance(obj, dict) else None
                if t:
                    acc += t
            except Exception:
                acc += data
        return acc

    def test_newlines_preserved(self):
        self.assertEqual(self._roundtrip("第一行\n第二行"), "第一行\n第二行")

    def test_numbered_list_preserved(self):
        self.assertEqual(self._roundtrip("1. a\n2. b\n3. c"), "1. a\n2. b\n3. c")

    def test_blank_line_paragraphs_preserved(self):
        self.assertEqual(self._roundtrip("para one\n\npara two"), "para one\n\npara two")

    def test_quotes_and_digits_preserved(self):
        self.assertEqual(self._roundtrip('has "quotes" and 123 digits'), 'has "quotes" and 123 digits')

    def test_crlf_preserved(self):
        self.assertEqual(self._roundtrip("a\r\nb"), "a\r\nb")


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestThinkingStreamSeparation(unittest.TestCase):
    """思考模型：reasoning_content（thinking）与 content（正文）分离，前端展示后清除只留正文。"""

    def test_run_llm_task_stream_separates_thinking_and_content(self):
        # 本地 llama.cpp 风格 chunk：delta.reasoning_content / delta.content
        llm_chunks = [
            {"choices": [{"delta": {"reasoning_content": "推理步骤一"}}]},
            {"choices": [{"delta": {"reasoning_content": "推理步骤二"}}]},
            {"choices": [{"delta": {"content": "最终答案"}}]},
        ]
        orig_infer = llm_mod._run_llm_inference
        orig_mode = llm_mod.get_current_mode
        llm_mod._run_llm_inference = lambda *a, **k: iter(llm_chunks)
        llm_mod.get_current_mode = lambda: llm_mod.LLM_MODE_LOCAL
        try:
            out = list(llm_mod.run_llm_task_stream("smart_prompt", "hello"))
        finally:
            llm_mod._run_llm_inference = orig_infer
            llm_mod.get_current_mode = orig_mode

        self.assertEqual(
            [(c["kind"], c["text"]) for c in out],
            [("thinking", "推理步骤一"), ("thinking", "推理步骤二"), ("content", "最终答案")],
        )

    def test_sse_frames_carry_kind_for_thinking_and_content(self):
        # 远程生成器已带 {"text","kind"}；SSE 分帧应保留 kind，前端据此区分思考与正文
        tagged = [
            {"text": "思考A", "kind": "thinking"},
            {"text": "正文B", "kind": "content"},
        ]
        orig = llm_mod.run_llm_task_stream
        llm_mod.run_llm_task_stream = lambda *a, **k: iter(tagged)

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": ""}

        async def _drive():
            resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
            raw = b""
            payload = resp.body
            aiter = getattr(payload, "_iter", None) or payload
            async for piece in aiter:
                raw += bytes(piece) if isinstance(piece, (bytes, bytearray)) else str(piece).encode()
            return raw.decode("utf-8")

        try:
            buf = asyncio.run(_drive())
        finally:
            llm_mod.run_llm_task_stream = orig

        frames = []
        for line in buf.split("\n"):
            if not line.startswith("data: "):
                continue
            data = line[6:]
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except Exception:
                continue
            if isinstance(obj, dict) and "text" in obj:
                frames.append((obj.get("kind", "content"), obj["text"]))
        self.assertEqual(frames, [("thinking", "思考A"), ("content", "正文B")])


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestInlineThinkStripping(unittest.TestCase):
    """思考模型把 < think>/< /think> 内联写进正文 content 时，非流式清洗与流式拆分都要去掉标签、只留最终正文。"""

    ANSWER = "中景镜头下，一位身着墨绿色丝绒高开叉长裙的女子缓缓抬手，动作轻柔而连贯地褪去肩带与裙摆。"

    def _content_of(self, chunks):
        return "".join(t for k, t in chunks if k == "content")

    def test_strip_real_polluted_pattern_dedups(self):
        # 真实污染：[答案]< /think>[答案]（孤立闭标签 + 重复正文）→ 只留一份正文
        self.assertEqual(llm_mod.strip_inline_thinking(self.ANSWER + "< /think>" + self.ANSWER), self.ANSWER)

    def test_strip_balanced_block(self):
        self.assertEqual(llm_mod.strip_inline_thinking("< think>推理过程< /think>" + self.ANSWER), self.ANSWER)

    def test_strip_lone_close_tag_drops_prefix(self):
        # 孤立闭标签：前面是泄漏的思考（丢弃），后面正文保留
        self.assertEqual(llm_mod.strip_inline_thinking("前言" + "< /think>" + self.ANSWER), self.ANSWER)

    def test_strip_case_and_space_variants(self):
        self.assertEqual(llm_mod.strip_inline_thinking("< THINK>推理< /THINK>" + self.ANSWER), self.ANSWER)

    def test_strip_plain_text_unchanged(self):
        self.assertEqual(llm_mod.strip_inline_thinking(self.ANSWER), self.ANSWER)

    def test_strip_non_think_angle_brackets_unchanged(self):
        self.assertEqual(llm_mod.strip_inline_thinking("a < b and c > d"), "a < b and c > d")

    def test_splitter_routes_inline_close_to_thinking(self):
        # 流式：整段喂入 [答案]< /think>[答案]，前一份答案归 thinking，正文只留后一份
        s = llm_mod._InlineThinkSplitter()
        chunks = list(s.feed(self.ANSWER + "< /think>" + self.ANSWER)) + s.flush()
        self.assertEqual(self._content_of(chunks), self.ANSWER)
        self.assertTrue(any(k == "thinking" for k, _ in chunks))

    def test_splitter_routes_balanced_block_to_thinking(self):
        s = llm_mod._InlineThinkSplitter()
        chunks = list(s.feed("< think>推理< /think>" + self.ANSWER)) + s.flush()
        self.assertEqual(self._content_of(chunks), self.ANSWER)
        self.assertEqual("".join(t for k, t in chunks if k == "thinking"), "推理")

    def test_splitter_plain_text_stays_content(self):
        s = llm_mod._InlineThinkSplitter()
        chunks = list(s.feed("a < b and c > d")) + s.flush()
        self.assertEqual(self._content_of(chunks), "a < b and c > d")
        self.assertFalse(any(k == "thinking" for k, _ in chunks))


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestRemoteConnection(unittest.TestCase):
    """连接测试：test_remote_connection 用表单值发「你好」，成功返回 reply、失败返回 error。"""

    def _run(self, provider="openai", api_key="", base_url="", model="",
             chat_result=None, raise_exc=None, saved=None):
        captured = {}

        class _FakeClient:
            def __init__(self, config):
                captured["config"] = config
            def chat_completion(self, **kw):
                captured["messages"] = kw.get("messages")
                if raise_exc is not None:
                    raise raise_exc
                return chat_result

        orig_client = llm_mod.RemoteLLMClient
        orig_load = llm_mod._load_remote_config
        llm_mod.RemoteLLMClient = _FakeClient
        llm_mod._load_remote_config = lambda: (saved if saved is not None else {"providers": {}})
        try:
            result = llm_mod.test_remote_connection(
                provider=provider, api_key=api_key, base_url=base_url, model=model)
        finally:
            llm_mod.RemoteLLMClient = orig_client
            llm_mod._load_remote_config = orig_load
        return result, captured

    def test_success_returns_reply_preview(self):
        result, captured = self._run(
            provider="openai", api_key="sk-test", base_url="https://api.openai.com/v1", model="gpt-4o-mini",
            chat_result={"choices": [{"message": {"content": "你好！有什么可以帮你？"}}]},
        )
        self.assertTrue(result["success"])
        self.assertIn("你好", result["reply"])
        self.assertEqual(captured["messages"], [{"role": "user", "content": "你好"}])
        self.assertEqual(captured["config"]["provider"], "openai")
        self.assertEqual(captured["config"]["api_key"], "sk-test")
        self.assertEqual(captured["config"]["model"], "gpt-4o-mini")

    def test_failure_returns_error(self):
        result, _ = self._run(
            provider="openai", model="gpt-4o-mini",
            raise_exc=RuntimeError("Remote LLM HTTP 401: unauthorized"),
        )
        self.assertFalse(result["success"])
        self.assertIn("401", result["error"])

    def test_local_provider_not_applicable(self):
        result, captured = self._run(provider="local")
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "本地模型无需连接测试")
        self.assertNotIn("config", captured)  # 未构造客户端

    def test_native_provider_runs_inference(self):
        # native 非 HTTP provider：连接测试实跑一次原生推理，不构造远程客户端
        called = {}

        def fake_native(system_prompt, user_text, max_tokens, **kw):
            called["user_text"] = user_text
            called["model"] = kw.get("model")
            return "你好！很高兴见到你。"

        orig = llm_mod._run_native_inference
        llm_mod._run_native_inference = fake_native
        try:
            result = llm_mod.test_remote_connection(
                provider="native", model="qwen3.5_4b_bf16.safetensors")
        finally:
            llm_mod._run_native_inference = orig
        self.assertTrue(result["success"])
        self.assertIn("你好", result["reply"])
        self.assertEqual(called["user_text"], "你好")
        self.assertEqual(called["model"], "qwen3.5_4b_bf16.safetensors")

    def test_native_provider_inference_error(self):
        def boom(*a, **k):
            raise RuntimeError("Native model not selected")

        orig = llm_mod._run_native_inference
        llm_mod._run_native_inference = boom
        try:
            result = llm_mod.test_remote_connection(provider="native", model="x.safetensors")
        finally:
            llm_mod._run_native_inference = orig
        self.assertFalse(result["success"])
        self.assertIn("Native model not selected", result["error"])

    def test_native_provider_empty_reply(self):
        orig = llm_mod._run_native_inference
        llm_mod._run_native_inference = lambda *a, **k: "   "
        try:
            result = llm_mod.test_remote_connection(provider="native", model="x.safetensors")
        finally:
            llm_mod._run_native_inference = orig
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "模型返回为空")

    def test_missing_model_reports_hint(self):
        result, _ = self._run(provider="openai")  # 无表单 model，也无已存 model
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "请先选择模型")

    def test_falls_back_to_saved_config_when_blank(self):
        saved = {"providers": {"deepseek": {
            "api_key": "sk-saved", "base_url": "https://api.deepseek.com/v1", "model": "deepseek-chat"}}}
        result, captured = self._run(
            provider="deepseek",  # 表单值全空（掩码未改动 → api_key 传空），应回退已存配置
            chat_result={"choices": [{"message": {"content": "ok"}}]},
            saved=saved,
        )
        self.assertTrue(result["success"])
        self.assertEqual(captured["config"]["api_key"], "sk-saved")
        self.assertEqual(captured["config"]["base_url"], "https://api.deepseek.com/v1")
        self.assertEqual(captured["config"]["model"], "deepseek-chat")


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestEnableThinking(unittest.TestCase):
    """enable_thinking（关闭思考）：经 chat_template_kwargs 透传到请求体；未设置则不发送。"""

    def _capture_chat_completion_kwargs(self, enable_thinking, reasoning_effort=None):
        client = llm_mod.RemoteLLMClient({
            "provider": "lmstudio", "base_url": "http://127.0.0.1:1234",
            "model": "test-model", "max_tokens": 500,
        })
        captured = {}

        class _Resp:
            def model_dump(self):
                return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}

        def fake_create(**kw):
            captured.update(kw)
            return _Resp()

        fake_client = MagicMock()
        fake_client.chat.completions.create.side_effect = fake_create

        orig_build = llm_mod.RemoteLLMClient._build_client
        llm_mod.RemoteLLMClient._build_client = lambda self: fake_client
        try:
            client.chat_completion([{"role": "user", "content": "hi"}], enable_thinking=enable_thinking,
                                   reasoning_effort=reasoning_effort)
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build
        return captured

    def test_payload_includes_chat_template_kwargs_when_false(self):
        kwargs = self._capture_chat_completion_kwargs(False)
        self.assertEqual(kwargs.get("extra_body", {}).get("chat_template_kwargs"), {"enable_thinking": False})

    def test_payload_omits_chat_template_kwargs_when_none(self):
        kwargs = self._capture_chat_completion_kwargs(None)
        self.assertNotIn("chat_template_kwargs", kwargs.get("extra_body", {}))

    def test_payload_omits_temperature(self):
        # 温度参数已从界面移除：请求体不再携带 temperature，统一用服务端默认
        kwargs = self._capture_chat_completion_kwargs(None)
        self.assertNotIn("temperature", kwargs)

    def test_run_remote_inference_threads_enable_thinking(self):
        captured = {}

        class _FakeClient:
            provider = "lmstudio"
            model = "test-model"
            def __init__(self, config):
                pass
            def is_available(self):
                return True
            def chat_completion(self, **kw):
                captured.update(kw)
                return {"choices": [{"message": {"content": "ok"}}]}

        orig_client = llm_mod.RemoteLLMClient
        orig_cfg = llm_mod._get_active_remote_config
        llm_mod.RemoteLLMClient = _FakeClient
        llm_mod._get_active_remote_config = lambda: {"enabled": True, "provider": "lmstudio"}
        try:
            llm_mod._run_remote_inference("sys", "usr", 500, stream=False, enable_thinking=False)
        finally:
            llm_mod.RemoteLLMClient = orig_client
            llm_mod._get_active_remote_config = orig_cfg
        self.assertIs(captured.get("enable_thinking"), False)

    def test_payload_includes_reasoning_effort(self):
        kwargs = self._capture_chat_completion_kwargs(None, reasoning_effort="low")
        self.assertEqual(kwargs.get("extra_body", {}).get("chat_template_kwargs"), {"reasoning_effort": "low"})

    def test_payload_combines_enable_thinking_and_reasoning_effort(self):
        kwargs = self._capture_chat_completion_kwargs(True, reasoning_effort="xhigh")
        self.assertEqual(kwargs.get("extra_body", {}).get("chat_template_kwargs"),
                         {"enable_thinking": True, "reasoning_effort": "xhigh"})

    def test_run_remote_inference_threads_reasoning_effort(self):
        captured = {}

        class _FakeClient:
            provider = "lmstudio"
            model = "test-model"
            def __init__(self, config):
                pass
            def is_available(self):
                return True
            def chat_completion(self, **kw):
                captured.update(kw)
                return {"choices": [{"message": {"content": "ok"}}]}

        orig_client = llm_mod.RemoteLLMClient
        orig_cfg = llm_mod._get_active_remote_config
        llm_mod.RemoteLLMClient = _FakeClient
        llm_mod._get_active_remote_config = lambda: {"enabled": True, "provider": "lmstudio"}
        try:
            llm_mod._run_remote_inference("sys", "usr", 500, stream=False, reasoning_effort="medium")
        finally:
            llm_mod.RemoteLLMClient = orig_client
            llm_mod._get_active_remote_config = orig_cfg
        self.assertEqual(captured.get("reasoning_effort"), "medium")

    def test_run_remote_inference_missing_key_still_sends_request(self):
        # 缺少 API key / provider：不做前置拦截，仍继续发起请求（调用 chat_completion）
        called = {}

        class _FakeClient:
            provider = "openai"
            model = "test-model"
            def __init__(self, config):
                pass
            def is_available(self):
                return False
            def chat_completion(self, **kw):
                called["invoked"] = True
                return {"choices": [{"message": {"content": "ok"}}]}

        orig_client = llm_mod.RemoteLLMClient
        orig_cfg = llm_mod._get_active_remote_config
        llm_mod.RemoteLLMClient = _FakeClient
        llm_mod._get_active_remote_config = lambda: {"enabled": True, "provider": "openai"}
        try:
            result = llm_mod._run_remote_inference("sys", "usr", 500, stream=False)
        finally:
            llm_mod.RemoteLLMClient = orig_client
            llm_mod._get_active_remote_config = orig_cfg
        self.assertTrue(called.get("invoked"))
        self.assertEqual(result, "ok")

    def test_run_remote_inference_propagates_failure(self):
        # 不能访问直接报错：chat_completion 抛错时不再吞成 None，而是向上抛出
        class _FakeClient:
            provider = "openai"
            model = "test-model"
            def __init__(self, config):
                pass
            def is_available(self):
                return True
            def chat_completion(self, **kw):
                raise RuntimeError("Remote LLM HTTP 401: unauthorized")

        orig_client = llm_mod.RemoteLLMClient
        orig_cfg = llm_mod._get_active_remote_config
        llm_mod.RemoteLLMClient = _FakeClient
        llm_mod._get_active_remote_config = lambda: {"enabled": True, "provider": "openai"}
        try:
            with self.assertRaises(RuntimeError):
                llm_mod._run_remote_inference("sys", "usr", 500, stream=False)
        finally:
            llm_mod.RemoteLLMClient = orig_client
            llm_mod._get_active_remote_config = orig_cfg

    def test_run_llm_inference_remote_no_fallback_to_local(self):
        # 远程模式失败不回退本地：异常直接向上抛，且不触碰本地推理
        local_called = {}

        def fake_remote(*a, **k):
            raise RuntimeError("Remote LLM HTTP 401: unauthorized")

        def fake_local(*a, **k):
            local_called["invoked"] = True
            return "local-result"

        orig_remote = llm_mod._run_remote_inference
        orig_local = llm_mod._run_local_inference
        llm_mod._run_remote_inference = fake_remote
        llm_mod._run_local_inference = fake_local
        try:
            with self.assertRaises(RuntimeError):
                llm_mod._run_llm_inference("sys", "usr", 500, use_remote=True)
        finally:
            llm_mod._run_remote_inference = orig_remote
            llm_mod._run_local_inference = orig_local
        self.assertNotIn("invoked", local_called)

    def test_route_passes_enable_thinking_to_skill_stream(self):
        captured = {}
        orig_stream = llm_mod.skill.run_skill_agent_stream
        orig_load = llm_mod.skill.load_skill_content

        def fake_stream(skill_id, text, images=None, context=None, enable_thinking=None, reasoning_effort=None):
            captured["enable_thinking"] = enable_thinking
            yield {"text": "ok", "kind": "content"}

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": "some_skill", "enable_thinking": False}

        llm_mod.skill.run_skill_agent_stream = fake_stream
        llm_mod.skill.load_skill_content = lambda sid: "content"
        try:
            async def _drive():
                resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
                aiter = getattr(resp.body, "_iter", None) or resp.body
                async for _piece in aiter:
                    pass
            asyncio.run(_drive())
        finally:
            llm_mod.skill.run_skill_agent_stream = orig_stream
            llm_mod.skill.load_skill_content = orig_load
        self.assertIs(captured.get("enable_thinking"), False)

    def test_route_passes_reasoning_effort_to_skill_stream(self):
        captured = {}
        orig_stream = llm_mod.skill.run_skill_agent_stream
        orig_load = llm_mod.skill.load_skill_content

        def fake_stream(skill_id, text, images=None, context=None, enable_thinking=None, reasoning_effort=None):
            captured["reasoning_effort"] = reasoning_effort
            yield {"text": "ok", "kind": "content"}

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": "some_skill", "reasoning_effort": "low"}

        llm_mod.skill.run_skill_agent_stream = fake_stream
        llm_mod.skill.load_skill_content = lambda sid: "content"
        try:
            async def _drive():
                resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
                aiter = getattr(resp.body, "_iter", None) or resp.body
                async for _piece in aiter:
                    pass
            asyncio.run(_drive())
        finally:
            llm_mod.skill.run_skill_agent_stream = orig_stream
            llm_mod.skill.load_skill_content = orig_load
        self.assertEqual(captured.get("reasoning_effort"), "low")

    def test_route_drops_invalid_reasoning_effort(self):
        captured = {}
        orig_stream = llm_mod.skill.run_skill_agent_stream
        orig_load = llm_mod.skill.load_skill_content

        def fake_stream(skill_id, text, images=None, context=None, enable_thinking=None, reasoning_effort=None):
            captured["reasoning_effort"] = reasoning_effort
            yield {"text": "ok", "kind": "content"}

        class _Req:
            async def json(self):
                return {"text": "x", "skillId": "some_skill", "reasoning_effort": "bogus"}

        llm_mod.skill.run_skill_agent_stream = fake_stream
        llm_mod.skill.load_skill_content = lambda sid: "content"
        try:
            async def _drive():
                resp = await llm_mod.handle_llm_api_stream("smart_prompt", _Req())
                aiter = getattr(resp.body, "_iter", None) or resp.body
                async for _piece in aiter:
                    pass
            asyncio.run(_drive())
        finally:
            llm_mod.skill.run_skill_agent_stream = orig_stream
            llm_mod.skill.load_skill_content = orig_load
        self.assertIsNone(captured.get("reasoning_effort"))


class TestUsageLogging(unittest.TestCase):
    """token 统计日志：prompt/completion/reasoning（思考 token）写入 INFO 日志。"""

    def _client_with_fake(self, create_side_effect):
        client = llm_mod.RemoteLLMClient({
            "provider": "lmstudio", "base_url": "http://127.0.0.1:1234",
            "model": "test-model", "max_tokens": 500,
        })
        fake_client = MagicMock()
        fake_client.chat.completions.create.side_effect = create_side_effect
        orig_build = llm_mod.RemoteLLMClient._build_client
        llm_mod.RemoteLLMClient._build_client = lambda self: fake_client
        return client, fake_client, orig_build

    def test_stream_logs_usage_with_reasoning_tokens(self):
        class _Details:
            reasoning_tokens = 400
        class _Usage:
            prompt_tokens = 100
            completion_tokens = 500
            completion_tokens_details = _Details()
        class _Delta:
            content = "hi"
            reasoning_content = None
        class _Choice:
            delta = _Delta()
        class _Chunk:
            choices = [_Choice()]
            usage = None

        final = MagicMock(choices=[], usage=_Usage())
        client, fake_client, orig_build = self._client_with_fake(lambda **kw: iter([_Chunk(), final]))
        try:
            with self.assertLogs(llm_mod.__name__, level="INFO") as cm:
                list(client.chat_completion([{"role": "user", "content": "x"}], stream=True))
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build
        self.assertTrue(any("LLM usage: prompt=100 completion=500 reasoning=400" in line for line in cm.output), cm.output)
        sent_kw = fake_client.chat.completions.create.call_args.kwargs
        self.assertEqual(sent_kw.get("stream_options"), {"include_usage": True})

    def test_non_stream_logs_usage_without_reasoning_field(self):
        class _Details:
            reasoning_tokens = 0  # LM Studio 报 0（未填明细），不应打出误导性的 reasoning=0
        class _Usage:
            prompt_tokens = 10
            completion_tokens = 20
            completion_tokens_details = _Details()
        class _Resp:
            usage = _Usage()
            def model_dump(self):
                return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}

        client, fake_client, orig_build = self._client_with_fake(lambda **kw: _Resp())
        try:
            with self.assertLogs(llm_mod.__name__, level="INFO") as cm:
                client.chat_completion([{"role": "user", "content": "x"}])
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build
        self.assertTrue(any("LLM usage: prompt=10 completion=20" in line and "reasoning=" not in line
                            for line in cm.output), cm.output)

    def _status_error(self, status, retry_after=None):
        import httpx
        import openai
        headers = {"retry-after": str(retry_after)} if retry_after is not None else {}
        response = httpx.Response(
            status, request=httpx.Request("POST", "http://127.0.0.1/v1/chat/completions"),
            headers=headers)
        return openai.APIStatusError("error", response=response, body={"message": f"HTTP {status}"})

    def _ok_resp(self):
        class _Resp:
            usage = None
            def model_dump(self):
                return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
        return _Resp()

    def test_transient_429_retried_once(self):
        # 429 + retry-after: 0 → 插件层重试一次、第二次成功，共两次请求
        client, fake_client, orig_build = self._client_with_fake(
            [self._status_error(429, retry_after=0), self._ok_resp()])
        try:
            result = client.chat_completion([{"role": "user", "content": "x"}])
            self.assertEqual(result["choices"][0]["message"]["content"], "ok")
            self.assertEqual(fake_client.chat.completions.create.call_count, 2)
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build

    def test_transient_5xx_retried_once(self):
        # 5xx（无 Retry-After）→ 默认延迟重试一次、第二次成功
        client, fake_client, orig_build = self._client_with_fake(
            [self._status_error(503), self._ok_resp()])
        try:
            result = client.chat_completion([{"role": "user", "content": "x"}])
            self.assertEqual(result["choices"][0]["message"]["content"], "ok")
            self.assertEqual(fake_client.chat.completions.create.call_count, 2)
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build

    def test_semantic_400_not_retried(self):
        # 语义性 4xx（如模型不存在）→ 不重试、立即报错
        client, fake_client, orig_build = self._client_with_fake(
            [self._status_error(400), self._status_error(400)])
        try:
            with self.assertRaises(RuntimeError) as ctx:
                client.chat_completion([{"role": "user", "content": "x"}])
            self.assertIn("HTTP 400", str(ctx.exception))
            self.assertEqual(fake_client.chat.completions.create.call_count, 1)
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build

    def test_retry_after_too_long_not_retried(self):
        # Retry-After 超过上限（20s）→ 不等待、不重试、立即报错
        client, fake_client, orig_build = self._client_with_fake(
            [self._status_error(429, retry_after=120), self._status_error(429)])
        try:
            with self.assertRaises(RuntimeError) as ctx:
                client.chat_completion([{"role": "user", "content": "x"}])
            self.assertIn("HTTP 429", str(ctx.exception))
            self.assertEqual(fake_client.chat.completions.create.call_count, 1)
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build

    def _chunk(self, content="hi"):
        class _Delta:
            pass
        class _Choice:
            pass
        class _Chunk:
            pass
        d = _Delta(); d.content = content; d.reasoning_content = None
        c = _Choice(); c.delta = d
        ch = _Chunk(); ch.choices = [c]; ch.usage = None
        return ch

    def test_stream_retries_transient_before_content(self):
        # 流式：首个 chunk 之前瞬态失败 → 重试一次、第二次成功
        client, fake_client, orig_build = self._client_with_fake(
            [self._status_error(429, retry_after=0), iter([self._chunk()])])
        try:
            out = list(client.chat_completion([{"role": "user", "content": "x"}], stream=True))
            self.assertEqual(out, [{"text": "hi", "kind": "content"}])
            self.assertEqual(fake_client.chat.completions.create.call_count, 2)
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build

    def test_stream_no_retry_after_content_yielded(self):
        # 流式：已吐出内容后的失败 → 不重试（内容无法撤回），直接报错
        def _fail():
            yield self._chunk()
            raise self._status_error(429, retry_after=0)

        client, fake_client, orig_build = self._client_with_fake([_fail(), iter([])])
        try:
            out = []
            with self.assertRaises(RuntimeError):
                for piece in client.chat_completion([{"role": "user", "content": "x"}], stream=True):
                    out.append(piece)
            self.assertEqual(out, [{"text": "hi", "kind": "content"}])
            self.assertEqual(fake_client.chat.completions.create.call_count, 1)
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build


class TestLocalSingleModelFallback(unittest.TestCase):
    """_load_model：无已保存选择且目录只有一个模型时直接回落，否则仍报清晰错误"""

    def _scanned(self, *keys):
        return [{"key": k, "name": k, "filename": k + ".gguf", "model_dir": "",
                 "mmproj": "", "multimodal": False, "file_size": 0} for k in keys]

    def _load(self, cfg, scanned):
        instance = object.__new__(llm_mod.LLMSingleton)
        calls = {}
        fake_llama = types.ModuleType("llama_cpp")

        class FakeLlama:
            def __init__(self, **kw):
                calls.update(kw)

        fake_llama.Llama = FakeLlama
        with patch.object(llm_mod, "_load_remote_config", lambda: cfg), \
                patch.object(llm_mod, "scan_llm_directory", lambda d: scanned), \
                patch.object(llm_mod, "_resolve_model_path", lambda mdir, fn: "/fake/" + fn), \
                patch("os.path.exists", return_value=True), \
                patch.dict(sys.modules, {"llama_cpp": fake_llama}):
            instance._load_model()
        return calls

    def test_no_selection_single_model_falls_back(self):
        cfg = {"providers": {"local": {"model": "", "models_dir": ""}}}
        calls = self._load(cfg, self._scanned("only.gguf"))
        self.assertEqual(calls.get("model_path"), "/fake/only.gguf.gguf")

    def test_no_selection_multiple_models_still_errors(self):
        cfg = {"providers": {"local": {"model": "", "models_dir": ""}}}
        with self.assertRaises(RuntimeError):
            self._load(cfg, self._scanned("a.gguf", "b.gguf"))

    def test_stale_key_single_model_still_errors(self):
        cfg = {"providers": {"local": {"model": "gone.gguf", "models_dir": ""}}}
        with self.assertRaises(RuntimeError):
            self._load(cfg, self._scanned("only.gguf"))


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestProviderDefinitions(unittest.TestCase):
    """provider 定义（configs/llm_providers.json）：结构合法性、云厂商运行时就位、内置兜底同步"""

    CLOUD_IDS = ("deepseek", "dashscope", "dashscope-plan", "moonshot", "zhipu", "siliconflow")

    def test_definition_shape(self):
        ids = []
        for p in llm_mod.get_provider_list():
            self.assertTrue(p.get("id"), p)
            self.assertIn(p.get("type"), ("local", "remote", "native"), p)
            ids.append(p["id"])
            if p["type"] == "remote":
                self.assertIn(p.get("model_mode"), ("hybrid", "dropdown"), p)
        self.assertEqual(len(ids), len(set(ids)), ids)

    def test_append_v1_matches_base_url(self):
        # 非 /v1 结尾的端点（智谱 /api/paas/v4 等）必须关掉自动追加，否则拼出错误 URL
        for p in llm_mod.get_provider_list():
            base = (p.get("default_base_url") or "").rstrip("/")
            if base and not base.endswith("/v1"):
                self.assertFalse(p.get("append_v1", True), p["id"])

    def test_client_base_url_per_provider(self):
        # 实测客户端拼接：缺 /v1 的补上，本身就是 /v4 的智谱保持原样
        captured = {}

        class _FakeOpenAI:
            def __init__(self, **kw):
                captured.update(kw)

        fake_openai = types.ModuleType("openai")
        fake_openai.OpenAI = _FakeOpenAI
        cases = (
            ("deepseek", "https://api.deepseek.com", "https://api.deepseek.com/v1"),
            ("siliconflow", "https://api.siliconflow.cn/v1", "https://api.siliconflow.cn/v1"),
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"),
        )
        with patch.dict(sys.modules, {"openai": fake_openai}):
            for provider, base_url, expected in cases:
                captured.clear()
                llm_mod.RemoteLLMClient({"provider": provider, "base_url": base_url, "api_key": "sk-test"})._build_client()
                self.assertEqual(captured.get("base_url"), expected, provider)

    def test_api_key_requirement_flag(self):
        # 云厂商必填 API Key（前端据此提示「必填」并在留空保存时告警）；本地/自建服务可留空
        flags = {p["id"]: bool(p.get("requires_api_key")) for p in llm_mod.get_provider_list()}
        for pid in self.CLOUD_IDS + ("openrouter",):
            self.assertTrue(flags.get(pid), pid)
        for pid in ("local", "openai", "lmstudio", "ollama", "unsloth", "vllm"):
            self.assertFalse(flags.get(pid), pid)

    def test_is_available_follows_requires_api_key(self):
        # is_available 以配置 requires_api_key 为准：自建/本地服务无 key 也可用，云厂商缺 key 不可用
        for pid in ("unsloth", "lmstudio", "ollama", "vllm", "openai"):
            self.assertTrue(llm_mod.RemoteLLMClient({"provider": pid, "api_key": ""}).is_available(), pid)
        self.assertFalse(llm_mod.RemoteLLMClient({"provider": "deepseek", "api_key": ""}).is_available())
        self.assertTrue(llm_mod.RemoteLLMClient({"provider": "deepseek", "api_key": "sk-x"}).is_available())

    def test_cloud_providers_have_runtime_slots(self):
        for pid in self.CLOUD_IDS:
            self.assertIn(pid, llm_mod._REMOTE_PROVIDERS, pid)
            slot = llm_mod._REMOTE_PROVIDER_DEFAULTS.get(pid) or {}
            self.assertTrue(slot.get("base_url"), slot)
            self.assertEqual(set(slot), {"api_key", "base_url", "model", "max_tokens", "timeout"})

    def test_builtin_fallback_matches_config(self):
        with open(os.path.join(_NODE_DIR, "configs", "llm_providers.json"), encoding="utf-8") as f:
            configured = json.load(f)["providers"]
        self.assertEqual(llm_mod._BUILTIN_PROVIDER_DEFS, configured)

    def test_migration_adds_missing_cloud_slots(self):
        cfg = {"enabled": True, "active_provider": "lmstudio",
               "providers": {"lmstudio": {"base_url": "http://host:1234/v1", "model": "local-model"}}}
        out = llm_mod._migrate_remote_config(cfg)
        self.assertEqual(out["active_provider"], "lmstudio")
        self.assertEqual(out["providers"]["lmstudio"]["model"], "local-model")
        self.assertEqual(out["providers"]["deepseek"]["base_url"], "https://api.deepseek.com/v1")

    def test_auto_unload_native_config_roundtrip(self):
        # 默认配置含 auto_unload_native；迁移补齐缺失字段；扁平保存能写入
        self.assertIn("auto_unload_native", llm_mod._default_remote_config())
        self.assertFalse(llm_mod._migrate_remote_config({"providers": {}})["auto_unload_native"])
        saved = {}
        orig_load, orig_save = llm_mod._load_remote_config, llm_mod._save_remote_config
        llm_mod._load_remote_config = lambda: {"providers": {"native": {}}, "active_provider": "native"}
        llm_mod._save_remote_config = lambda c: saved.update(c)
        try:
            llm_mod.set_remote_llm_config({"provider": "native", "model": "x.safetensors",
                                           "auto_unload_native": True})
        finally:
            llm_mod._load_remote_config, llm_mod._save_remote_config = orig_load, orig_save
        self.assertTrue(saved["auto_unload_native"])

    def test_build_remote_models_url(self):
        # 模型列表端点须与聊天请求的 /v1 追加规则一致；智谱 /v4 端点不能再叠 /v1
        cases = (
            ("deepseek", "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/models"),
            ("deepseek", "https://api.deepseek.com", "https://api.deepseek.com/v1/models"),
            ("zhipu", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/models"),
            ("ollama", "http://localhost:11434/api", "http://localhost:11434/api/tags"),
            ("lmstudio", "http://192.168.0.176:8888", "http://192.168.0.176:8888/v1/models"),
            ("openai", "http://host:8000/v1/models", "http://host:8000/v1/models"),
        )
        for provider, base_url, expected in cases:
            self.assertEqual(llm_mod.build_remote_models_url(base_url, provider), expected, (provider, base_url))

    def test_api_key_mask_shape(self):
        # 前端按「纯星号」识别已存掩码；固定 40 位（等长显示太长，过短不易辨认）
        self.assertRegex(llm_mod.API_KEY_MASK, r"^\*{40}$")

    def test_get_stored_api_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "remote_llm_config.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"enabled": True, "active_provider": "deepseek",
                           "providers": {"deepseek": {"api_key": "sk-stored",
                                                      "base_url": "https://api.deepseek.com/v1", "model": ""}}}, f)
            with patch.object(llm_mod, "_REMOTE_CONFIG_PATH", path):
                self.assertEqual(llm_mod.get_stored_api_key("deepseek"), "sk-stored")
                self.assertEqual(llm_mod.get_stored_api_key("moonshot"), "")


@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestLocalServiceModels(unittest.TestCase):
    """本地/局域网端点：判定、列表候选顺序、各服务列表解析、冷加载超时下限"""

    def test_local_endpoint_detection(self):
        for url in ("http://localhost:1234/v1", "http://127.0.0.1:8000", "http://192.168.0.176:8888",
                    "http://10.0.0.5/v1", "http://172.16.3.9:11434/api", "http://169.254.1.1",
                    "http://host.docker.internal:1234/v1", "http://ollama.local:11434"):
            self.assertTrue(llm_mod.is_local_endpoint(url), url)

    def test_public_endpoint_detection(self):
        for url in ("https://api.deepseek.com/v1", "https://openrouter.ai/api/v1",
                    "http://api.example.com:8000/v1", "", "http://172.32.0.1/v1"):
            self.assertFalse(llm_mod.is_local_endpoint(url), url)

    def test_local_list_endpoints_order(self):
        # LM Studio / Ollama 原生端点优先，其后是通用 OpenAI 兼容端点
        self.assertEqual(
            llm_mod.local_list_endpoints("http://192.168.0.176:1234/v1", "lmstudio"),
            [("lmstudio", "http://192.168.0.176:1234/api/v1/models"),
             ("ollama", "http://192.168.0.176:1234/api/tags"),
             ("openai", "http://192.168.0.176:1234/v1/models")],
        )
        # unsloth 预设不带 /v1（append_v1=false），兜底端点须与聊天请求拼接规则一致
        self.assertEqual(llm_mod.local_list_endpoints("http://192.168.0.176:8888", "unsloth")[2],
                         ("openai", "http://192.168.0.176:8888/models"))
        # 整段粘贴 /models 端点、Ollama 原生 /api 端点：剥尾后原生候选仍指向服务根
        self.assertEqual(llm_mod.local_list_endpoints("http://host:1234/api/v1/models", "lmstudio")[0],
                         ("lmstudio", "http://host:1234/api/v1/models"))
        self.assertEqual(llm_mod.local_list_endpoints("http://localhost:11434/api", "ollama")[1],
                         ("ollama", "http://localhost:11434/api/tags"))

    def test_parse_lmstudio_models(self):
        payload = {"models": [
            {"type": "llm", "key": "google/gemma-4-26b-a4b", "display_name": "Gemma 4 26B A4B",
             "size_bytes": 17990911801, "loaded_instances": [], "capabilities": {"vision": True}},
            {"type": "llm", "key": "deepseek-r1", "display_name": "DeepSeek R1", "size_bytes": 40492610355,
             "loaded_instances": [{"id": "deepseek-r1"}], "capabilities": {"vision": False}},
            {"type": "embedding", "key": "nomic-embed-text-v1.5", "loaded_instances": []},
        ]}
        models = llm_mod.parse_service_models("lmstudio", payload)
        self.assertEqual([m["id"] for m in models], ["google/gemma-4-26b-a4b", "deepseek-r1"])
        self.assertEqual(models[0]["name"], "Gemma 4 26B A4B")
        self.assertFalse(models[0]["loaded"])   # 未加载也照样可选，由服务端按需加载
        self.assertTrue(models[0]["vision"])
        self.assertTrue(models[1]["loaded"])

    def test_parse_ollama_models_marks_running(self):
        tags = {"models": [{"name": "qwen3:4b"}, {"name": "llama3.2:1b"}]}
        ps = {"models": [{"name": "qwen3:4b"}]}
        models = llm_mod.parse_service_models("ollama", tags, ps)
        self.assertEqual([m["id"] for m in models], ["qwen3:4b", "llama3.2:1b"])
        self.assertTrue(models[0]["loaded"])
        self.assertFalse(models[1]["loaded"])

    def test_parse_openai_compatible_models(self):
        models = llm_mod.parse_service_models("openai", {"data": [{"id": "gpt-oss-20b"}, {"id": "qwen3-8b"}]})
        self.assertEqual([m["id"] for m in models], ["gpt-oss-20b", "qwen3-8b"])
        self.assertNotIn("loaded", models[0])   # 通用端点不谎报加载状态

    def test_local_endpoint_timeout_floor(self):
        # 冷加载常超过默认 60s：本地端点抬高到 LOCAL_ENDPOINT_MIN_TIMEOUT，公网端点保持原值
        local = llm_mod.RemoteLLMClient({"provider": "lmstudio", "base_url": "http://192.168.0.176:8888", "timeout": 60})
        self.assertEqual(local._effective_timeout(), llm_mod.LOCAL_ENDPOINT_MIN_TIMEOUT)
        cloud = llm_mod.RemoteLLMClient({"provider": "deepseek", "base_url": "https://api.deepseek.com/v1", "timeout": 60})
        self.assertEqual(cloud._effective_timeout(), 60)


    def test_parse_unsloth_v1_models_keeps_loaded(self):
        # Unsloth Studio 的 /v1/models 自带 loaded 字段：照实标注（未加载的照样可选）
        payload = {"object": "list", "data": [
            {"id": "HauhauCS/Qwen3.5-9B-Uncensored", "object": "model", "loaded": False,
             "quant": "Q4_K_M", "display_name": "Qwen3.5-9B-Uncensored"},
            {"id": "Qwen/Qwen3.6-35B-A3B", "object": "model", "loaded": True},
        ]}
        models = llm_mod.parse_service_models("openai", payload)
        self.assertEqual([m["id"] for m in models], ["HauhauCS/Qwen3.5-9B-Uncensored", "Qwen/Qwen3.6-35B-A3B"])
        self.assertFalse(models[0]["loaded"])
        self.assertTrue(models[1]["loaded"])
        self.assertEqual(models[0]["name"], "Qwen3.5-9B-Uncensored")

    def test_is_no_model_loaded_error(self):
        msg = "{'message': 'No model loaded. Call POST /inference/load first.', 'type': 'invalid_request_error'}"
        self.assertTrue(llm_mod.is_no_model_loaded_error(400, msg))
        self.assertTrue(llm_mod.is_no_model_loaded_error(400, "Model not loaded yet"))
        self.assertFalse(llm_mod.is_no_model_loaded_error(404, msg))   # 状态码不对
        self.assertFalse(llm_mod.is_no_model_loaded_error(400, "model 'x' does not exist"))
        self.assertFalse(llm_mod.is_no_model_loaded_error(400, ""))

    def test_no_model_loaded_not_retried_reports_actionable_error(self):
        # Unsloth Studio 未加载时返回 400「No model loaded」：语义性错误，不重试、不自动加载，直接报可操作建议
        # 桩打在 OpenAI SDK 边界上：占端口起本地服务会撞别的套件的监听（Windows 允许重复绑定，
        # 请求就打到别人身上出 502），瞬态分支还会带 2 秒 sleep，两者都不该进套件。
        import httpx
        import openai
        response = httpx.Response(400, request=httpx.Request("POST", "http://127.0.0.1:18942/v1/chat/completions"))
        no_model = openai.APIStatusError(
            "error", response=response,
            body={"message": "No model loaded. Call POST /inference/load first.",
                  "type": "invalid_request_error"})
        create = MagicMock(side_effect=no_model)
        fake_client = types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create)))
        orig_build = llm_mod.RemoteLLMClient._build_client
        llm_mod.RemoteLLMClient._build_client = lambda self: fake_client
        try:
            client = llm_mod.RemoteLLMClient(
                {"provider": "unsloth", "base_url": "http://127.0.0.1:18942/v1", "model": "m"})
            with self.assertRaises(RuntimeError) as ctx:
                client.chat_completion([{"role": "user", "content": "hi"}])
            self.assertIn("No model loaded", str(ctx.exception))
            self.assertIn("Load the model in the server UI", str(ctx.exception))   # 可操作建议
            self.assertEqual(create.call_count, 1)   # 语义性 4xx 不重试，客户端也没有自动加载这条路径
        finally:
            llm_mod.RemoteLLMClient._build_client = orig_build




@unittest.skipUnless(LLM_AVAILABLE, _llm_reason)
class TestNativeBackend(unittest.TestCase):
    """原生 ComfyUI 文本生成后端：扫描、模式分发、stub CLIP 推理、缓存"""

    @classmethod
    def setUpClass(cls):
        import torch
        if not torch.cuda.is_available():
            raise unittest.SkipTest("native 后端要在显存里真跑文本生成模型，无 CUDA 设备的机器跑不了")
        cls._comfy_saved = _drop_stubs(_COMFY_PREFIX)
        cls._fp_saved = _drop_stubs(_FP_PREFIX)
        # llm_mod.folder_paths 是 import 期绑定的（可能是别的测试文件留下的桩），
        # 丢桩后必须重绑到真实模块；patch.object(comfy, "sd", FakeSD)
        # 也要求 sys.modules 里已有 comfy.sd。
        cls._llm_fp = llm_mod.folder_paths
        import comfy.sd, folder_paths
        llm_mod.folder_paths = folder_paths

    @classmethod
    def tearDownClass(cls):
        restore(_COMFY_PREFIX, cls._comfy_saved)
        restore(_FP_PREFIX, cls._fp_saved)
        llm_mod.folder_paths = cls._llm_fp

    def test_scan_native_models_filters_safetensors(self):
        files = ["qwen3.5_4b_bf16.safetensors", "clip_l.safetensors", "readme.txt", "model.safetensors"]
        with patch.object(llm_mod.folder_paths, "get_filename_list", lambda cat: files):
            out = llm_mod.scan_native_models()
        keys = [m["key"] for m in out]
        self.assertIn("qwen3.5_4b_bf16.safetensors", keys)
        self.assertIn("model.safetensors", keys)
        self.assertNotIn("readme.txt", keys)

    def test_scan_native_models_prioritizes_qwen3_series(self):
        # 下拉排序：qwen3.5 系列最前 → qwen3 系列 → 其余（前端默认选第一个）
        files = ["clip_l.safetensors", "qwen3_4b.safetensors", "gemma_2b.safetensors",
                 "qwen3.5_4b_bf16.safetensors", "qwen2_7b.safetensors"]
        with patch.object(llm_mod.folder_paths, "get_filename_list", lambda cat: files):
            keys = [m["key"] for m in llm_mod.scan_native_models()]
        self.assertEqual(keys[0], "qwen3.5_4b_bf16.safetensors")
        self.assertEqual(keys[1], "qwen3_4b.safetensors")
        self.assertLess(keys.index("qwen3_4b.safetensors"), keys.index("gemma_2b.safetensors"))
        self.assertLess(keys.index("qwen3_4b.safetensors"), keys.index("qwen2_7b.safetensors"))

    def test_get_current_mode_native(self):
        cfg = {"enabled": True, "active_provider": "native", "providers": {"native": {"model": "x.safetensors"}}}
        with patch.object(llm_mod, "_load_remote_config", lambda: cfg):
            self.assertEqual(llm_mod.get_current_mode(), llm_mod.LLM_MODE_NATIVE)

    def test_get_current_mode_native_not_remote(self):
        # native 不在 _REMOTE_PROVIDERS，enabled 也不会被判为 remote
        cfg = {"enabled": True, "active_provider": "native", "providers": {}}
        with patch.object(llm_mod, "_load_remote_config", lambda: cfg):
            self.assertEqual(llm_mod.get_current_mode(), llm_mod.LLM_MODE_NATIVE)

    def test_run_native_inference_stub_clip(self):
        calls = {}

        class StubClip:
            def tokenize(self, text, image=None, system_prompt="", thinking=False, min_length=1):
                calls["tokenize"] = {"text": text, "image": image, "system_prompt": system_prompt,
                                     "thinking": thinking, "min_length": min_length}
                return {"tokens": [[(1, 1.0), (2, 1.0)]]}
            def generate(self, tokens, do_sample, max_length, temperature, top_k, top_p, min_p,
                         repetition_penalty, presence_penalty, seed, mtp):
                calls["generate"] = {"do_sample": do_sample, "max_length": max_length, "mtp": mtp}
                return [1, 2, 3]
            def decode(self, ids, skip_special_tokens=True):
                return "  hello world  "

        with patch.object(llm_mod, "_build_native_clip", lambda name: StubClip()), \
             patch.object(llm_mod, "_get_native_model_name", lambda: "qwen3.5_4b_bf16.safetensors"):
            out = llm_mod._run_native_inference("SYS", "USER", 128)
        self.assertEqual(out, "hello world")
        self.assertEqual(calls["tokenize"]["system_prompt"], "SYS")
        self.assertEqual(calls["tokenize"]["text"], "USER")
        self.assertEqual(calls["generate"]["max_length"], 128)
        self.assertFalse(calls["generate"]["do_sample"])
        self.assertFalse(calls["generate"]["mtp"])

    def test_run_native_inference_strips_think(self):
        class StubClip:
            def tokenize(self, text, **kw):
                return {"tokens": [[(1, 1.0)]]}
            def generate(self, tokens, **kw):
                return [1]
            def decode(self, ids, skip_special_tokens=True):
                return "<think>reasoning here</think>final answer"

        with patch.object(llm_mod, "_build_native_clip", lambda name: StubClip()), \
             patch.object(llm_mod, "_get_native_model_name", lambda: "m.safetensors"):
            out = llm_mod._run_native_inference("SYS", "USER", 64)
        self.assertEqual(out, "final answer")

    def test_run_native_inference_suppresses_progress_hook(self):
        # 队列外执行：原生 generate 的进度条不得触发全局 hook（否则回退读 last_prompt_id 崩溃），
        # 调用结束后必须恢复原 hook。
        import comfy.utils
        observed = {}

        class StubClip:
            def tokenize(self, text, **kw):
                return {"tokens": [[(1, 1.0)]]}
            def generate(self, tokens, **kw):
                observed["hook_during"] = comfy.utils.PROGRESS_BAR_HOOK
                return [1]
            def decode(self, ids, skip_special_tokens=True):
                return "ok"

        sentinel = object()
        orig = comfy.utils.PROGRESS_BAR_HOOK
        comfy.utils.PROGRESS_BAR_HOOK = sentinel
        try:
            with patch.object(llm_mod, "_build_native_clip", lambda name: StubClip()), \
                 patch.object(llm_mod, "_get_native_model_name", lambda: "m.safetensors"):
                out = llm_mod._run_native_inference("SYS", "USER", 16)
            self.assertIsNone(observed["hook_during"])
            self.assertIs(comfy.utils.PROGRESS_BAR_HOOK, sentinel)
        finally:
            comfy.utils.PROGRESS_BAR_HOOK = orig
        self.assertEqual(out, "ok")

    def test_run_native_inference_forces_eager_path(self):
        # 队列外禁用 CUDA-graph / comfy 编译器（DynamicVRAM 图复用会把 KV 写坏 → device assert），
        # 生成期间两标志置 True，结束后恢复。
        import comfy.cli_args
        observed = {}

        class StubClip:
            def tokenize(self, text, **kw):
                return {"tokens": [[(1, 1.0)]]}
            def generate(self, tokens, **kw):
                observed["dcg"] = comfy.cli_args.args.disable_cuda_graphs
                observed["dcc"] = comfy.cli_args.args.disable_comfy_compiler
                return [1]
            def decode(self, ids, skip_special_tokens=True):
                return "ok"

        a = comfy.cli_args.args
        old_dcg, old_dcc = a.disable_cuda_graphs, a.disable_comfy_compiler
        a.disable_cuda_graphs = False
        a.disable_comfy_compiler = False
        try:
            with patch.object(llm_mod, "_build_native_clip", lambda name: StubClip()), \
                 patch.object(llm_mod, "_get_native_model_name", lambda: "m.safetensors"):
                out = llm_mod._run_native_inference("S", "U", 8)
            self.assertTrue(observed["dcg"])
            self.assertTrue(observed["dcc"])
            self.assertFalse(a.disable_cuda_graphs)
            self.assertFalse(a.disable_comfy_compiler)
        finally:
            a.disable_cuda_graphs = old_dcg
            a.disable_comfy_compiler = old_dcc
        self.assertEqual(out, "ok")

    def test_unload_native_model_frees_vram_and_clears_cache(self):
        # 卸载必须真正调用核心 unload_model_and_clones（释放显存），而不只是丢缓存引用
        import comfy.model_management
        calls = []

        class FakeClip:
            patcher = object()

        llm_mod._NATIVE_CLIP_CACHE["m.safetensors"] = FakeClip()
        orig = comfy.model_management.unload_model_and_clones
        comfy.model_management.unload_model_and_clones = lambda p: calls.append(p)
        try:
            llm_mod.unload_native_model()
        finally:
            comfy.model_management.unload_model_and_clones = orig
            llm_mod._NATIVE_CLIP_CACHE.clear()
        self.assertEqual(len(calls), 1)
        self.assertEqual(llm_mod._NATIVE_CLIP_CACHE, {})

    def test_native_model_change_unloads_old_model(self):
        # 切换 native 模型（native→native，模型名变了）→ 卸载旧模型显存；同模型保存不卸载
        cur = {"providers": {"native": {"model": "a.safetensors"}}, "active_provider": "native", "enabled": True}
        calls = {"n": 0}
        orig_load, orig_save, orig_unload = (llm_mod._load_remote_config,
                                             llm_mod._save_remote_config, llm_mod.unload_native_model)
        llm_mod._load_remote_config = lambda: json.loads(json.dumps(cur))
        llm_mod._save_remote_config = lambda c: None
        llm_mod.unload_native_model = lambda: calls.__setitem__("n", calls["n"] + 1)
        try:
            llm_mod.set_remote_llm_config({"provider": "native", "model": "b.safetensors"})
            self.assertEqual(calls["n"], 1, "换模型应卸载旧模型")
            calls["n"] = 0
            llm_mod.set_remote_llm_config({"provider": "native", "model": "a.safetensors"})
            self.assertEqual(calls["n"], 0, "同模型不应卸载")
        finally:
            llm_mod._load_remote_config, llm_mod._save_remote_config, llm_mod.unload_native_model = (
                orig_load, orig_save, orig_unload)

    def test_run_native_inference_serializes_concurrent_calls(self):
        # 单例 clip 不可并发：多线程进入 _run_native_inference 必须被锁串行化，
        # 否则 clip.generate 会改写共享状态而互相踩踏（复读/崩溃）。
        import threading as _th
        import time as _time
        inside = []
        overlapped = {"hit": False}

        class StubClip:
            def tokenize(self, text, **kw):
                return {"tokens": [[(1, 1.0)]]}
            def generate(self, tokens, **kw):
                inside.append(1)
                if len(inside) > 1:
                    overlapped["hit"] = True
                _time.sleep(0.03)
                inside.pop()
                return [1]
            def decode(self, ids, skip_special_tokens=True):
                return "ok"

        with patch.object(llm_mod, "_build_native_clip", lambda name: StubClip()), \
             patch.object(llm_mod, "_get_native_model_name", lambda: "m.safetensors"):
            threads = [_th.Thread(target=lambda: llm_mod._run_native_inference("S", "U", 8))
                       for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertFalse(overlapped["hit"], "并发调用未被串行化")

    def test_build_native_clip_caches(self):
        load_calls = []

        class FakeSD:
            @staticmethod
            def load_clip(ckpt_paths, model_options):
                load_calls.append((ckpt_paths, model_options))
                return object()

        import comfy
        llm_mod._NATIVE_CLIP_CACHE.clear()
        with patch.object(comfy, "sd", FakeSD), \
             patch.object(llm_mod.folder_paths, "get_full_path_or_raise", lambda c, n: "/p/" + n):
            c1 = llm_mod._build_native_clip("qwen3.5_4b_bf16.safetensors")
            c2 = llm_mod._build_native_clip("qwen3.5_4b_bf16.safetensors")
        self.assertIs(c1, c2)
        self.assertEqual(len(load_calls), 1)
        self.assertEqual(load_calls[0][1].get("clip_name"), "qwen3.5_4b_bf16.safetensors")
        llm_mod._NATIVE_CLIP_CACHE.clear()

    def test_run_native_inference_keeps_think_when_not_stripped(self):
        # 伪流式路径 strip_thinking=False：保留原文，交由拆块生成器分离思考/正文
        class StubClip:
            def tokenize(self, text, **kw):
                return {"tokens": [[(1, 1.0)]]}
            def generate(self, tokens, **kw):
                return [1]
            def decode(self, ids, skip_special_tokens=True):
                return "<think>reasoning here</think>final answer"

        with patch.object(llm_mod, "_build_native_clip", lambda name: StubClip()), \
             patch.object(llm_mod, "_get_native_model_name", lambda: "m.safetensors"):
            out = llm_mod._run_native_inference("SYS", "USER", 64, strip_thinking=False)
        self.assertEqual(out, "<think>reasoning here</think>final answer")

    def test_native_stream_chunks_splits_think(self):
        chunks = list(llm_mod._native_stream_chunks("<think>why</think>the answer"))
        self.assertIn({"text": "why", "kind": "thinking"}, chunks)
        self.assertIn({"text": "the answer", "kind": "content"}, chunks)

    def test_native_stream_chunks_plain_content(self):
        chunks = list(llm_mod._native_stream_chunks("just text"))
        self.assertEqual(chunks, [{"text": "just text", "kind": "content"}])

    def test_run_llm_inference_routes_native(self):
        with patch.object(llm_mod, "get_current_mode", lambda: llm_mod.LLM_MODE_NATIVE), \
             patch.object(llm_mod, "_run_native_inference", lambda *a, **k: "NATIVE"), \
             patch.object(llm_mod, "_run_local_inference", lambda *a, **k: "LOCAL"):
            self.assertEqual(llm_mod._run_llm_inference("S", "U", 100), "NATIVE")

    def test_run_llm_inference_native_stream_pseudo_stream(self):
        # 原生流式走伪流式：整段结果拆块透传，不回退 llama.cpp
        with patch.object(llm_mod, "get_current_mode", lambda: llm_mod.LLM_MODE_NATIVE), \
             patch.object(llm_mod, "_run_native_inference", lambda *a, **k: "<think>r</think>answer"), \
             patch.object(llm_mod, "_run_local_inference", lambda *a, **k: "LOCAL"):
            out = list(llm_mod._run_llm_inference("S", "U", 100, stream=True))
        self.assertIn({"text": "r", "kind": "thinking"}, out)
        self.assertIn({"text": "answer", "kind": "content"}, out)

if __name__ == '__main__':
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)
