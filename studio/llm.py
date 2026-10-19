# SPDX-License-Identifier: Apache-2.0
# Neo Studio - LLM (Large Language Model)
# LLM 公共代码模块，支持本地模型和远程 API

from __future__ import annotations

import os
import re
import json
import copy
import logging
import asyncio
import base64
import io
import hashlib
import socket
import threading
import time
from typing import Any, Dict, List, Optional, Generator
from pathlib import Path
from PIL import Image
import folder_paths
from collections import OrderedDict
from urllib.parse import urlparse
import aiohttp
from aiohttp import web

from . import laya_router, plugin_paths, prompt_lines, skill
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

# ==========================================
# LLM Configuration & Management
# ==========================================

_CONFIGS_DIR: str = str(plugin_paths.CONFIGS_DIR)
_PROVIDERS_CONFIG_PATH = os.path.join(_CONFIGS_DIR, "llm_providers.json")

# 内置兜底（llm_providers.json 缺失时使用），内容与 configs/llm_providers.json 保持一致
_BUILTIN_PROVIDER_DEFS = [
    {"id": "native", "name": "Native (ComfyUI safetensors)", "type": "native", "model_mode": "dropdown"},
    {"id": "local", "name": "Local GGUF (llama.cpp)", "type": "local"},
    {"id": "deepseek", "name": "DeepSeek 深度求索", "type": "remote",
     "default_base_url": "https://api.deepseek.com/v1", "append_v1": True, "show_api_key": True, "requires_api_key": True, "model_mode": "hybrid"},
    {"id": "dashscope", "name": "阿里云百炼 (通义千问)", "type": "remote",
     "default_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "append_v1": True, "show_api_key": True, "requires_api_key": True, "model_mode": "hybrid"},
    {"id": "dashscope-plan", "name": "阿里云百炼 Token Plan", "type": "remote",
     "default_base_url": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "append_v1": True, "show_api_key": True, "requires_api_key": True, "model_mode": "hybrid"},
    {"id": "moonshot", "name": "月之暗面 Kimi", "type": "remote",
     "default_base_url": "https://api.moonshot.cn/v1", "append_v1": True, "show_api_key": True, "requires_api_key": True, "model_mode": "hybrid"},
    {"id": "zhipu", "name": "智谱 GLM", "type": "remote",
     "default_base_url": "https://open.bigmodel.cn/api/paas/v4", "append_v1": False, "show_api_key": True, "requires_api_key": True, "model_mode": "hybrid"},
    {"id": "siliconflow", "name": "硅基流动 SiliconFlow", "type": "remote",
     "default_base_url": "https://api.siliconflow.cn/v1", "append_v1": True, "show_api_key": True, "requires_api_key": True, "model_mode": "hybrid"},
    {"id": "openai", "name": "OpenAI Compatible", "type": "remote",
     "default_base_url": "", "append_v1": True, "show_api_key": True, "model_mode": "hybrid"},
    {"id": "lmstudio", "name": "LM Studio", "type": "remote",
     "default_base_url": "http://localhost:1234/v1", "append_v1": True, "show_api_key": False, "model_mode": "dropdown"},
    {"id": "ollama", "name": "Ollama", "type": "remote",
     "default_base_url": "http://localhost:11430/v1", "append_v1": True, "show_api_key": False, "model_mode": "dropdown"},
    {"id": "openrouter", "name": "OpenRouter", "type": "remote",
     "default_base_url": "https://openrouter.ai/api/v1", "append_v1": True, "show_api_key": True, "requires_api_key": True, "model_mode": "dropdown"},
    {"id": "unsloth", "name": "Unsloth", "type": "remote",
     "default_base_url": "http://192.168.0.176:8888/v1", "append_v1": False, "show_api_key": True, "model_mode": "dropdown"},
    {"id": "vllm", "name": "vLLM Server", "type": "remote",
     "default_base_url": "http://localhost:8000/v1", "append_v1": True, "show_api_key": False, "model_mode": "dropdown"},
]


def _load_provider_defs() -> List[Dict[str, Any]]:
    """从 configs/llm_providers.json 加载 provider 定义；文件缺失或损坏时回退内置列表。"""
    try:
        with open(_PROVIDERS_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        providers = data.get("providers")
        if isinstance(providers, list) and providers:
            return providers
    except Exception as e:
        logger.warning(f"Failed to load llm_providers.json, using builtin defaults: {e}")
    return list(_BUILTIN_PROVIDER_DEFS)


def get_provider_list() -> List[Dict[str, Any]]:
    """返回 provider 定义列表（供前端动态构建下拉）。"""
    return _load_provider_defs()


# 已存 API Key 对前端的脱敏串：固定 40 个星号（前端按纯星号识别为「未改动、沿用已存密钥」）
API_KEY_MASK = "*" * 40


def get_stored_api_key(provider: str) -> str:
    """读取已保存的 provider API Key（模型列表拉取等只读场景复用已存密钥，不回传明文给前端）。"""
    slot = _load_remote_config().get("providers", {}).get(provider)
    if isinstance(slot, dict):
        return str(slot.get("api_key", "") or "")
    return ""


def build_remote_models_url(base_url: str, provider: str = "") -> str:
    """按 base_url 兼容写法构造模型列表端点；/v1 追加规则与 _build_client 保持一致。"""
    base = (base_url or "").strip().rstrip("/")
    append_v1 = True
    for p in _load_provider_defs():
        if p.get("id") == provider:
            append_v1 = p.get("append_v1", True)
            break
    if base.endswith("/models"):
        return base
    if base.endswith("/api"):
        return f"{base}/tags"      # Ollama 原生接口
    if append_v1 and not base.endswith("/v1"):
        return f"{base}/v1/models"
    return f"{base}/models"         # /v1 结尾或 append_v1=false（如智谱 /api/paas/v4）


# 本地 / 局域网端点：LM Studio / Ollama / vLLM 等在收到请求时按需加载模型，客户端只需放宽超时；
# Unsloth Studio 的 /v1 未加载时返回 400「No model loaded」，客户端不自动加载，直接报可操作的错误（见 _no_model_loaded_hint）。
_LOCAL_HOST_NAMES = {"localhost", "0.0.0.0", "::1", "host.docker.internal"}
_PRIVATE_IPV4_RE = re.compile(r"^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|127\.)")
# 冷加载大模型可能持续数分钟（Cline 对 Ollama 用 5 分钟口径），低于该值一律抬高
LOCAL_ENDPOINT_MIN_TIMEOUT = 300
# OpenAI SDK 自身重试已禁用（max_retries=0）；插件层只对瞬态失败（408/409/429/5xx/网络中断）
# 重试一次，语义性 4xx（400/401/403/404/413/422 等）立即报错；Retry-After 超过上限不等待、直接报错。
_TRANSIENT_RETRY_STATUSES = frozenset({408, 409, 429})
_TRANSIENT_RETRY_DELAY = 2.0
_RETRY_AFTER_MAX_WAIT = 20.0


def is_local_endpoint(base_url: str) -> bool:
    """端点是否指向本机 / 局域网服务（按 host 判断，与 provider 名无关）"""
    host = (urlparse(base_url or "").hostname or "").strip().lower()
    if not host:
        return False
    if host in _LOCAL_HOST_NAMES or host.endswith(".local"):
        return True
    return bool(_PRIVATE_IPV4_RE.match(host))


def _service_root(base_url: str) -> str:
    """剥掉 /models、/v1、/api 尾巴得到服务根（兼容 http://host/api/v1/models 这类整段粘贴的端点）"""
    root = (base_url or "").strip().rstrip("/")
    while True:
        for suffix in ("/models", "/v1", "/api"):
            if root.endswith(suffix):
                root = root[: -len(suffix)]
                break
        else:
            break
    return root


def local_list_endpoints(base_url: str, provider: str = "") -> List[tuple]:
    """本地端点的模型列表候选，按顺序尝试、首个有结果者胜：
    LM Studio 的 /api/v1/models 列出全部已下载模型（含 loaded_instances），
    Ollama 的 /api/tags 列出已 pull 的模型；其余服务（Unsloth Studio 等）走 OpenAI 兼容端点。

    只看 /v1/models 时未加载的模型在部分服务上会缺失，前端会看不到可选模型。"""
    root = _service_root(base_url)
    return [
        ("lmstudio", f"{root}/api/v1/models"),
        ("ollama", f"{root}/api/tags"),
        ("openai", build_remote_models_url(base_url, provider)),
    ]


def is_no_model_loaded_error(status_code: int, detail: str) -> bool:
    """Unsloth Studio 的未加载错误：400 + 'No model loaded. Call POST /inference/load first.'"""
    if status_code != 400 or not detail:
        return False
    text = detail.lower()
    return "no model loaded" in text or "model not loaded" in text


def parse_service_models(kind: str, payload: Dict[str, Any],
                         running_payload: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """把各服务的模型列表响应归一化为 [{id, name, size?, vision?, loaded?}]；loaded 未知时不带该键。"""
    models: List[Dict[str, Any]] = []

    def _entry(model_id: str, name: str = "", size: int = 0,
               vision: bool = False, loaded: Optional[bool] = None) -> Dict[str, Any]:
        item: Dict[str, Any] = {"id": model_id, "name": name or model_id}
        if size:
            item["size"] = size
        if vision:
            item["vision"] = True
        if loaded is not None:
            item["loaded"] = loaded
        return item

    if kind == "ollama":
        running = set()
        for m in (running_payload or {}).get("models") or []:
            name = (m.get("name") or m.get("model") or "") if isinstance(m, dict) else str(m)
            if name:
                running.add(name)
        for m in payload.get("models") or []:
            name = (m.get("name") or m.get("model") or "") if isinstance(m, dict) else str(m)
            if name:
                # 运行中的模型会出现在 /api/ps；未加载的照样可选，首次请求由 Ollama 自行加载
                models.append(_entry(name, name, loaded=name in running))
        return models

    if kind == "lmstudio":
        for m in payload.get("models") or []:
            if not isinstance(m, dict) or m.get("type") == "embedding":
                continue
            model_id = m.get("key") or m.get("id") or ""
            if not model_id:
                continue
            caps = m.get("capabilities") or {}
            models.append(_entry(model_id, m.get("display_name") or "",
                                 int(m.get("size_bytes") or 0), bool(caps.get("vision")),
                                 bool(m.get("loaded_instances"))))
        return models

    # OpenAI 兼容 /v1/models：列表项即服务端可服务的模型；带 loaded 字段的服务（Unsloth Studio）照实标注
    for m in payload.get("data") or []:
        if not isinstance(m, dict):
            if m:
                models.append(_entry(str(m)))
            continue
        model_id = m.get("id") or m.get("name") or ""
        if not model_id:
            continue
        loaded = m.get("loaded")
        models.append(_entry(model_id, m.get("display_name") or "",
                             loaded=loaded if isinstance(loaded, bool) else None))
    return models


# ==========================================
# Text Normalization Utility
# ==========================================

def _normalize_text(text):
    """标准化文本，用于缓存键的生成"""
    if not text:
        return ""
    text = text.strip()
    text = re.sub(r'\s+', ' ', text)
    return text


# ==========================================
# Inline Thinking Block Splitter
# ==========================================
# 思考模型（Qwen3 等）在部分端点上会把推理过程内联写进正文 content 字段，形如
# < think>...
# </think>。这类标签没走独立的 reasoning_content 字段，若不处理会直接泄漏进输出区并被保存。
# 这里按流式逐块拆分：思考段标成 thinking（进临时面板），正文保持 content；
# 跨 chunk 的标签边界通过保留尾部缓冲处理。

_THINK_TAG_RE = re.compile(r"<\s*/?\s*think\s*>", re.IGNORECASE)
# 覆盖 "< /think>" 等最长变体，用于判断缓冲尾部是否可能是未闭合标签的前缀
_THINK_MAX_TAG_LEN = 16


class _InlineThinkSplitter:
    """把内联在正文里的 < think>...
</think> 块拆出并标成 thinking。

    feed() 接收一段文本、产出 [(kind, text), ...]（kind ∈ {"content","thinking"}）；
    flush() 在流结束时冲刷剩余缓冲。
    """

    def __init__(self):
        self._buf = ""
        self._in_think = False

    def feed(self, text: str):
        if not text:
            return []
        self._buf += text
        out = []
        while True:
            m = _THINK_TAG_RE.search(self._buf)
            if not m:
                safe_end = self._safe_tail_end()
                emit = self._buf[:safe_end]
                if emit:
                    out.append(("thinking" if self._in_think else "content", emit))
                    self._buf = self._buf[safe_end:]
                break
            prefix = self._buf[:m.start()]
            is_close = "/" in m.group(0)
            # 前缀归属：已在思考中，或遇到孤立闭标签（未开先闭，前面是泄漏的思考）→ thinking；否则正文。
            out_kind = "thinking" if (self._in_think or is_close) else "content"
            if prefix:
                out.append((out_kind, prefix))
            # 开标签进入思考，闭标签回到正文
            self._in_think = not is_close
            self._buf = self._buf[m.end():]
        return out

    def flush(self):
        if not self._buf:
            return []
        kind = "thinking" if self._in_think else "content"
        text, self._buf = self._buf, ""
        return [(kind, text)]

    def _safe_tail_end(self):
        # 从最后一个 '<' 起的尾部若短于最长标签，可能是未闭合标签的前缀，保留等下一块确认
        n = len(self._buf)
        idx = self._buf.rfind("<")
        if idx != -1 and (n - idx) < _THINK_MAX_TAG_LEN:
            return idx
        return n


def strip_inline_thinking(text: str) -> str:
    """移除正文里内联的 < think>...
</think> 块，只保留最终回答（非流式路径用）。"""
    if not text or "<" not in text:
        return text
    splitter = _InlineThinkSplitter()
    parts = []
    had_think = False
    for kind, chunk in list(splitter.feed(text)) + splitter.flush():
        if kind == "content":
            parts.append(chunk)
        else:
            had_think = True
    if not had_think:
        return text
    return "".join(parts).strip()


# ==========================================
# Translation Cache Configuration
# ==========================================

class TranslationCache:
    """翻译缓存，支持双向缓存和自动淘汰"""
    
    _KEY_TEXT = "T:"
    _KEY_RESULT = "R:"
    
    def __init__(self, max_size=200):
        self._store = OrderedDict()
        self.max_size = max_size
    
    def get(self, text):
        normalized = _normalize_text(text)
        result = self._store.get(f"{self._KEY_TEXT}{normalized}")
        if result:
            return result
        return self._store.get(f"{self._KEY_RESULT}{normalized}")
    
    def set(self, text, result):
        normalized_text = _normalize_text(text)
        normalized_result = _normalize_text(result)
        
        text_key = f"{self._KEY_TEXT}{normalized_text}"
        result_key = f"{self._KEY_RESULT}{normalized_result}"
        
        if text_key in self._store:
            del self._store[text_key]
        if result_key in self._store:
            del self._store[result_key]
        
        self._store[text_key] = normalized_result
        self._store[result_key] = normalized_text
        
        while len(self._store) > self.max_size:
            self._evict_oldest()
    
    def _evict_oldest(self):
        if not self._store:
            return
        oldest_key = next(iter(self._store))
        self._store.pop(oldest_key)
        logger.info(f"Cache full, evicted oldest entry: '{oldest_key[:20]}...'")
    
    def size(self):
        return len(self._store)
    
    def clear(self):
        self._store.clear()


# 全局翻译缓存实例
TRANSLATION_CACHE = TranslationCache(max_size=200)


# ==========================================
# Remote LLM Configuration
# ==========================================

_REMOTE_CONFIG_PATH = os.path.join(_CONFIGS_DIR, "remote_llm_config.json")


def _build_provider_defaults() -> Dict[str, Dict[str, Any]]:
    """根据 llm_providers.json 生成各 provider 的默认配置槽位。"""
    defaults: Dict[str, Dict[str, Any]] = {}
    for p in _load_provider_defs():
        pid = p.get("id", "")
        if not pid:
            continue
        if p.get("type") == "local":
            defaults[pid] = {"model": "", "models_dir": ""}
        else:
            defaults[pid] = {
                "api_key": "",
                "base_url": p.get("default_base_url", ""),
                "model": "",
                "max_tokens": 500,
                "timeout": 60,
            }
    return defaults


_REMOTE_PROVIDER_DEFAULTS = _build_provider_defaults()

# 走 OpenAI 兼容 HTTP 的 provider；local 为进程内 llama.cpp，不属于远程
_REMOTE_PROVIDERS = {p["id"] for p in _load_provider_defs() if p.get("type") == "remote"}


def _default_remote_config() -> Dict[str, Any]:
    """默认远程配置：按 provider 分槽存储，互不覆盖"""
    return {
        "enabled": False,
        "active_provider": "openai",
        "auto_unload_local": False,
        "auto_unload_native": False,
        "providers": {key: dict(defaults) for key, defaults in _REMOTE_PROVIDER_DEFAULTS.items()},
    }


def _migrate_remote_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """兼容旧版扁平配置格式，迁移为按 provider 分槽存储"""
    providers = config.get("providers")
    if isinstance(providers, dict):
        # 已是最新格式，补齐缺失的 provider 槽位
        for key, defaults in _REMOTE_PROVIDER_DEFAULTS.items():
            providers.setdefault(key, dict(defaults))
        config.setdefault("enabled", False)
        config.setdefault("auto_unload_local", False)
        config.setdefault("auto_unload_native", False)
        active = config.get("active_provider") or "openai"
        if active not in _REMOTE_PROVIDER_DEFAULTS:
            active = "openai"
        config["active_provider"] = active
        return config

    # 旧格式：单 provider 扁平结构
    new = _default_remote_config()
    new["auto_unload_local"] = bool(config.get("auto_unload_local", False))
    new["auto_unload_native"] = bool(config.get("auto_unload_native", False))
    new["enabled"] = bool(config.get("enabled", False))
    provider = config.get("provider", "openai")
    if provider not in _REMOTE_PROVIDER_DEFAULTS:
        # 旧配置可能把远程连接信息放在 "local" 下，按 base_url 推断归属
        base_url = str(config.get("base_url", "") or "")
        if "1234" in base_url:
            provider = "lmstudio"
        elif "11430" in base_url or "11434" in base_url:
            provider = "ollama"
        else:
            provider = "openai"
        new["enabled"] = False
    new["active_provider"] = provider
    # LM Studio / Ollama 的 model 只能来自服务端模型列表，不能迁移旧的 OpenAI 默认值
    for key in ("api_key", "base_url", "max_tokens", "timeout"):
        if key in config:
            new["providers"][provider][key] = config[key]
    if provider == "openai" and "model" in config:
        new["providers"][provider]["model"] = config["model"]
    return new


def _get_active_remote_config() -> Dict[str, Any]:
    """返回当前激活 provider 的扁平配置（含 provider/enabled 字段），供远程推理使用"""
    config = _load_remote_config()
    provider = config.get("active_provider", "openai")
    slot = config.get("providers", {}).get(provider)
    merged = dict(_REMOTE_PROVIDER_DEFAULTS.get(provider, {}))
    if isinstance(slot, dict):
        merged.update(slot)
    merged["provider"] = provider
    merged["enabled"] = bool(config.get("enabled", False))
    return merged



def test_remote_connection(provider: str, api_key: str = "", base_url: str = "", model: str = "") -> Dict[str, Any]:
    """连接测试：用给定 provider/密钥/端点/模型发送「你好」，成功返回 {success, reply}，失败返回 {success, error}。

    空值回退到该 provider 已存配置（前端掩码未改动时 api_key 传空，此处沿用已存明文密钥）。
    """
    if provider == "native":
        # 原生后端本地生成、非 HTTP provider：实跑一次推理即为连接测试
        return test_native_connection((model or "").strip())
    if not provider or provider == "local":
        return {"success": False, "error": "本地模型无需连接测试"}
    saved = _load_remote_config().get("providers", {}).get(provider) or {}
    config = {
        "provider": provider,
        "api_key": (api_key or "").strip() or saved.get("api_key", ""),
        "base_url": (base_url or "").strip() or saved.get("base_url", ""),
        "model": (model or "").strip() or saved.get("model", ""),
        "timeout": 30,
    }
    if not config["model"]:
        return {"success": False, "error": "请先选择模型"}
    client = RemoteLLMClient(config)
    try:
        response = client.chat_completion(
            messages=[{"role": "user", "content": "你好"}],
            max_tokens=100,
        )
        content = (response.get("choices") or [{}])[0].get("message", {}).get("content", "")
        reply = (content or "").strip()
        if not reply:
            return {"success": False, "error": "模型返回为空"}
        preview = reply[:80] + ("…" if len(reply) > 80 else "")
        return {"success": True, "reply": preview}
    except Exception as e:
        logger.warning(f"LLM connection test failed ({provider}): {e}")
        return {"success": False, "error": str(e)}


def _load_remote_config() -> Dict[str, Any]:
    """加载远程 LLM 配置"""
    try:
        if os.path.exists(_REMOTE_CONFIG_PATH):
            with open(_REMOTE_CONFIG_PATH, "r", encoding="utf-8") as f:
                config = _migrate_remote_config(json.load(f))
            # 一次性：把旧 model_config.json 的 current_model 接手到 local provider
            local_slot = config.get("providers", {}).get("local")
            if local_slot is not None and not local_slot.get("model"):
                legacy = os.path.join(_CONFIGS_DIR, "model_config.json")
                if os.path.exists(legacy):
                    try:
                        with open(legacy, "r", encoding="utf-8") as f:
                            cur = json.load(f).get("current_model", "")
                        if cur and cur.strip():
                            local_slot["model"] = cur
                            _save_remote_config(config)
                    except Exception:
                        pass
            return config
    except Exception as e:
        logger.error(f"Failed to load remote LLM config: {e}")
    return _default_remote_config()

def _save_remote_config(config: Dict[str, Any]):
    """保存远程 LLM 配置"""
    try:
        with open(_REMOTE_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        logger.info("Remote LLM config saved")
    except Exception as e:
        logger.error(f"Failed to save remote LLM config: {e}")

def get_remote_llm_config() -> Dict[str, Any]:
    """获取远程 LLM 配置"""
    return _load_remote_config()

def set_remote_llm_config(config: Dict[str, Any]):
    """设置远程 LLM 配置"""
    if isinstance(config.get("providers"), dict):
        # 完整结构：合并保存
        merged = _load_remote_config()
        prev_native_model = merged.get("providers", {}).get("native", {}).get("model", "")
        merged.update(config)
        saved = _migrate_remote_config(merged)
        _save_remote_config(saved)
        if saved.get("active_provider") != "local":
            _unload_local_if_inactive()
        if saved.get("active_provider") != "native":
            _unload_native_if_inactive()
        elif saved.get("providers", {}).get("native", {}).get("model", "") != prev_native_model:
            # native 槽位换了模型：旧模型不会再被使用，释放其显存
            unload_native_model()
        return

    # 扁平结构：只更新对应 provider 的槽位，不影响其它 provider
    current = _load_remote_config()
    provider = config.get("provider")
    if provider in current.get("providers", {}):
        slot = current["providers"][provider]
        prev_model = slot.get("model", "")
        for key in ("base_url", "model", "models_dir", "max_tokens", "timeout"):
            if key in config:
                slot[key] = config[key]
        if config.get("api_key"):
            slot["api_key"] = config["api_key"]
        if config.get("enabled"):
            current["enabled"] = True
        else:
            current["enabled"] = False
        current["active_provider"] = provider
        if "auto_unload_local" in config:
            current["auto_unload_local"] = bool(config["auto_unload_local"])
        if "auto_unload_native" in config:
            current["auto_unload_native"] = bool(config["auto_unload_native"])
        _save_remote_config(current)
        logger.info(f"Remote LLM provider '{provider}' config updated")
        if provider != "local":
            _unload_local_if_inactive()
        if provider != "native":
            _unload_native_if_inactive()
        elif slot.get("model", "") != prev_model:
            # native 槽位换了模型：旧模型不会再被使用，释放其显存
            unload_native_model()
        return

    # 未知 provider：只更新启用状态
    current["enabled"] = bool(config.get("enabled", current.get("enabled", False)))
    _save_remote_config(current)

# 远程 LLM 模式常量
LLM_MODE_LOCAL = "local"
LLM_MODE_REMOTE = "remote"
LLM_MODE_NATIVE = "native"

# 流式的最小 max_tokens（远程/本地通用）：思考模型（如 qwen3.6-35b-a3b）会先把预算花在 reasoning_content，
# 任务模板默认值（~500）常被推理耗尽导致正文为空。给一个下限保证思考后仍有空间输出最终答案；
# 需要更长可在此调大，或在配置里为对应 provider 设置更大的 max_tokens。
STREAM_MIN_MAX_TOKENS = 4096

def get_current_mode() -> str:
    """获取当前 LLM 模式：local / remote / native（基于 provider 值判断）"""
    config = _load_remote_config()
    active = config.get("active_provider")
    if config.get("enabled") and active in _REMOTE_PROVIDERS:
        return LLM_MODE_REMOTE
    if active == "native":
        return LLM_MODE_NATIVE
    return LLM_MODE_LOCAL


# ==========================================
# Model-Specific System Prompts (for remote mode)
# ==========================================

_TASK_MODEL_CONFIGS = {
    "extract_title": {"max_tokens": 20, "model_override": None},
    "extract_classify": {"max_tokens": 50, "model_override": None},
    "enhance_prompt": {"max_tokens": 500, "model_override": None},
    "translate_prompt": {"max_tokens": 500, "model_override": None},
}

def get_task_config(task_name: str) -> Dict[str, Any]:
    """获取任务配置"""
    return _TASK_MODEL_CONFIGS.get(task_name, {"max_tokens": 500, "model_override": None})


# ==========================================
# Local Model Helpers (realtime scan)
# ==========================================

def _resolve_llm_dir(models_dir: str = "") -> str:
    """解析本地模型目录：自定义路径优先，空值回退默认 <ComfyUI>/models/LLM"""
    custom = str(models_dir or "").strip()
    if custom:
        return os.path.abspath(custom)
    return os.path.join(folder_paths.base_path, "models", "LLM")


def _is_mmproj_file(fname: str) -> bool:
    """判断是否为多模态投影文件：兼容 mmproj-f16.gguf 与 <模型名>.mmproj-f16.gguf 两种命名"""
    name = fname.lower()
    return name.endswith(".gguf") and "mmproj" in name


def scan_llm_directory(models_dir: str = "") -> List[Dict[str, str]]:
    """递归扫描本地模型目录下的 .gguf 文件（平铺 / 单层子目录 / LM Studio 多层嵌套均支持）。
    同目录恰好只有一个 mmproj 投影文件时绑定给该目录下的所有模型（用于图片反推）；投影文件本身不列为可选模型。"""
    llm_dir = _resolve_llm_dir(models_dir)
    discovered: List[Dict[str, str]] = []
    seen: set = set()

    if not os.path.isdir(llm_dir):
        return discovered

    def _register(key: str, model_dir: str, fname: str, mmproj: str = "", full: str = "", proj_size: int = 0) -> None:
        if key in seen:
            return
        seen.add(key)
        stem = fname[:-5] if fname.lower().endswith(".gguf") else fname
        file_size = 0
        try:
            if full and os.path.isfile(full):
                file_size = os.path.getsize(full)
        except OSError:
            file_size = 0
        # 多模态模型：所属目录的单张 mmproj 投影文件计入总体积
        if proj_size:
            file_size += proj_size
        discovered.append({
            "key": key,
            "name": stem,
            "filename": fname,
            "model_dir": model_dir,
            "mmproj": mmproj,
            "multimodal": bool(mmproj),
            "file_size": file_size,
        })

    for root, _dirs, files in os.walk(llm_dir):
        # 同目录恰好只有一个名字含 mmproj 的 gguf 时才绑定（多个候选时不猜测）
        ggufs = sorted(f for f in files if f.lower().endswith(".gguf"))
        projectors = [f for f in ggufs if _is_mmproj_file(f)]
        bind = projectors[0] if len(projectors) == 1 else ""
        # 单张 mmproj 投影文件服务该目录下所有模型，其体积计入每个模型的总体积
        proj_size = 0
        if bind:
            proj_full = os.path.join(root, bind)
            try:
                if os.path.isfile(proj_full):
                    proj_size = os.path.getsize(proj_full)
            except OSError:
                proj_size = 0
        for fname in ggufs:
            if _is_mmproj_file(fname):
                continue
            full = os.path.join(root, fname)
            # key 取相对路径去扩展名：根目录为 "stem"，深层为 "pub/model/stem"
            rel = os.path.relpath(full, llm_dir).replace("\\", "/")
            _register(rel[:-5], root, fname, bind, full=full, proj_size=proj_size)

        discovered.sort(key=lambda item: item["key"])
    return discovered


def unload_local_model():
    """卸载本地 LLM 模型（释放显存）"""
    global LLMSingleton
    if LLMSingleton._instance is not None:
        try:
            if hasattr(LLMSingleton._instance, 'model') and LLMSingleton._instance.model is not None:
                del LLMSingleton._instance.model
            LLMSingleton._instance = None
            msg = "Local LLM model unloaded successfully"
            logger.info(msg)
            print(f"[Neo Studio] {msg}")
            return {"success": True, "message": "Model unloaded"}
        except Exception as e:
            msg = f"Failed to unload local model: {e}"
            logger.error(msg)
            print(f"[Neo Studio] {msg}")
            return {"success": False, "error": str(e)}
    msg = "No local model loaded, nothing to unload"
    logger.info(msg)
    print(f"[Neo Studio] {msg}")
    return {"success": True, "message": "No model was loaded"}


def _unload_local_if_inactive():
    """激活 provider 已不是 local 时，驻留的本地模型不会再被使用，直接释放显存"""
    if LLMSingleton._instance is not None:
        unload_local_model()


def _unload_native_if_inactive():
    """激活 provider 已不是 native 时，驻留的原生文本生成模型不会再被使用，释放显存"""
    if _NATIVE_CLIP_CACHE:
        unload_native_model()


def __reload_llm_singleton():
    """销毁并重建 LLM 单例，以加载新模型"""
    global LLMSingleton
    LLMSingleton._instance = None


def _bind_sibling_mmproj(model_key: str) -> str:
    """主模型选定后，若其所在目录恰好只有一个名字含 mmproj 的 gguf，
    自动绑定为该模型的投影文件（下载命名不规范时的兜底自愈）。返回 mmproj 文件名。"""
    scanned = scan_llm_directory(_get_local_models_dir())
    for entry in scanned:
        if entry["key"] != model_key:
            continue
        target = _resolve_model_path(entry["model_dir"], entry["filename"])
        model_dir = os.path.dirname(target)
        base = os.path.basename(target).lower()
        try:
            siblings = [f for f in os.listdir(model_dir)
                        if f.lower().endswith(".gguf") and f.lower() != base and _is_mmproj_file(f)]
        except OSError:
            return ""
        if len(siblings) == 1:
            logger.info(f"Auto-bound mmproj '{siblings[0]}' to {model_key}")
            return siblings[0]
        return entry.get("mmproj", "")
    return ""


def set_current_model(model_key: str) -> bool:
    """设置当前本地模型；key 必须是扫描结果中的 key。"""
    scanned = scan_llm_directory(_get_local_models_dir())
    keys = {item["key"] for item in scanned}
    if model_key not in keys:
        logger.warning(f"Unknown model key: {model_key}")
        return False
    _set_local_model(model_key)
    __reload_llm_singleton()
    return True


def _get_local_models_dir() -> str:
    """当前 local provider 配置的模型目录。"""
    cfg = _load_remote_config()
    return cfg.get("providers", {}).get("local", {}).get("models_dir", "")


def _set_local_model(model_key: str) -> None:
    """持久化当前选中的本地模型到 remote_llm_config.json。"""
    cfg = _load_remote_config()
    cfg.setdefault("providers", {}).setdefault("local", {})["model"] = model_key
    _save_remote_config(cfg)


def _resolve_model_path(model_dir: str, filename: str) -> str:
    """定位 gguf 文件绝对路径；model_dir 兼容相对子目录与扫描写入的绝对目录"""
    if model_dir and os.path.isabs(model_dir):
        return os.path.join(model_dir, filename)
    return os.path.join(folder_paths.base_path, "models", "LLM", model_dir, filename)


def get_available_models() -> Dict[str, Any]:
    """获取当前配置目录下的所有可用本地模型（实时扫描磁盘，不落盘）。"""
    scanned = scan_llm_directory(_get_local_models_dir())
    model_list: List[Dict[str, Any]] = []
    for item in scanned:
        model_list.append({
            "key": item["key"],
            "name": item["name"],
            "filename": item["filename"],
            "model_dir": item["model_dir"],
            "multimodal": item.get("multimodal", False),
            "file_size": item.get("file_size", 0),
        })
    cfg = _load_remote_config()
    cur = cfg.get("providers", {}).get("local", {}).get("model", "")
    return {
        "current_model": cur,
        "models": model_list,
    }


# ==========================================
# Remote API LLM Client (OpenAI SDK)
# ==========================================

def _usage_counts(usage) -> Dict[str, int]:
    """provider 的 token 统计压成 plain dict：SDK 回的是对象，dict 才进得了 JSON 响应与会话文件。

    两家后端都认（远程是 response.usage 对象或 model_dump 出来的 dict，本地 llama.cpp 是 dict）。
    一个数都没报时回空 dict——右栏把「这一轮没有 usage」与「这一轮烧了 0 token」分得开。"""
    if usage is None:
        return {}
    pick = usage.get if isinstance(usage, dict) else (lambda key: getattr(usage, key, None))
    prompt, completion, total = pick("prompt_tokens"), pick("completion_tokens"), pick("total_tokens")
    if prompt is None and completion is None:
        return {}
    prompt, completion = int(prompt or 0), int(completion or 0)
    return {"prompt_tokens": prompt, "completion_tokens": completion,
            "total_tokens": int(total or (prompt + completion))}


def _log_llm_usage(usage) -> None:
    """记录单次 LLM 调用的 token 统计：prompt/completion，及思考 token reasoning_tokens（Qwen3 系思考模型返回）。"""
    if usage is None:
        return
    prompt_tokens = getattr(usage, "prompt_tokens", None)
    completion_tokens = getattr(usage, "completion_tokens", None)
    details = getattr(usage, "completion_tokens_details", None)
    reasoning_tokens = getattr(details, "reasoning_tokens", None) if details is not None else None
    line = f"[Neo Studio] LLM usage: prompt={prompt_tokens} completion={completion_tokens}"
    # 0/缺失多为服务端未报明细（如 LM Studio），打出反而误导，仅正数时记录
    if reasoning_tokens:
        line += f" reasoning={reasoning_tokens}"
    logger.info(line)


def _api_status_detail(e) -> str:
    """提取 openai.APIStatusError 的服务端错误体文本（4xx 响应会说明具体原因，如模型不存在）"""
    body = getattr(e, "body", None)
    if body is None:
        return ""
    try:
        return str(body)[:500]
    except Exception:
        return ""


def _transient_retry_delay(e) -> Optional[float]:
    """瞬态失败的插件层重试间隔（秒）；不可重试（语义性 4xx 等）返回 None。

    可重试：网络中断 / 连接失败 / 超时（httpx.TransportError、openai.APIConnectionError，
    含 APITimeoutError），以及 408/409/429/5xx 状态码。带 Retry-After 且不超过上限时按其等待，
    否则固定 _TRANSIENT_RETRY_DELAY；Retry-After 过长（> _RETRY_AFTER_MAX_WAIT）不等待、直接报错。
    """
    import httpx
    import openai
    transient = isinstance(e, (httpx.TransportError, openai.APIConnectionError))
    if not transient and isinstance(e, openai.APIStatusError):
        status = e.status_code
        transient = status in _TRANSIENT_RETRY_STATUSES or status >= 500
    if not transient:
        return None
    delay = _TRANSIENT_RETRY_DELAY
    response = getattr(e, "response", None)
    header = (getattr(response, "headers", None) or {}).get("retry-after")
    if header is not None:
        try:
            delay = float(header)
        except (TypeError, ValueError):
            pass
    return delay if 0 <= delay <= _RETRY_AFTER_MAX_WAIT else None


class RemoteLLMClient:
    """基于 OpenAI SDK 的远程 LLM 客户端，调用 OpenAI 兼容 API"""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.provider = config.get("provider", "openai")
        self.api_key = config.get("api_key", "")
        self.base_url = config.get("base_url", "")
        self.model = config.get("model", "gpt-4o-mini")
        self.max_tokens = config.get("max_tokens", 500)
        self.timeout = config.get("timeout", 60)

    def _add_images_to_messages(self, messages: List[Dict[str, Any]],
                                 image_bytes_list: List[bytes]) -> List[Dict[str, Any]]:
        """将图片添加到 user message 中"""
        result = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if image_bytes_list and isinstance(content, str) and role == "user":
                content_parts = []
                for img_bytes in image_bytes_list:
                    b64 = base64.b64encode(img_bytes).decode('utf-8')
                    content_parts.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"}
                    })
                content_parts.append({"type": "text", "text": content})
                content = content_parts

            result.append({"role": role, "content": content})
        return result

    def _effective_timeout(self) -> float:
        """本地端点的冷加载远超默认 60s（首次把模型读进显存）：抬高到 LOCAL_ENDPOINT_MIN_TIMEOUT"""
        if is_local_endpoint(self.base_url):
            return max(self.timeout, LOCAL_ENDPOINT_MIN_TIMEOUT)
        return self.timeout

    def _no_model_loaded_hint(self, status_code: int, detail: str) -> str:
        """本地端点没加载模型时，给出能直接照做的处置建议"""
        if not (self.base_url and is_local_endpoint(self.base_url)
                and is_no_model_loaded_error(status_code, detail)):
            return ""
        return (" | Load the model in the server UI first (or POST /api/inference/load with the "
                "server's API key), then retry.")

    def _build_client(self):
        """构造 OpenAI 兼容客户端（指向 base_url；本地/自建服务端 api_key 可为任意非空占位值）。"""
        import openai
        timeout = self._effective_timeout()
        if self.base_url:
            base = self.base_url.rstrip('/')
            # 根据 provider 定义决定是否自动追加 /v1（Unsloth 等服务端不使用 /v1 前缀）
            append_v1 = True
            for p in _load_provider_defs():
                if p.get("id") == self.provider:
                    append_v1 = p.get("append_v1", True)
                    break
            if append_v1 and not base.endswith('/v1'):
                base = f"{base}/v1"
            # max_retries=0：SDK 层不隐藏重试，瞬态失败由插件层统一按 _transient_retry_delay 重试一次
            return openai.OpenAI(base_url=base, api_key=self.api_key or "lm-studio", timeout=timeout, max_retries=0)
        return openai.OpenAI(api_key=self.api_key or "lm-studio", timeout=timeout, max_retries=0)

    def chat_completion(self, messages: List[Dict[str, Any]],
                        max_tokens: Optional[int] = None,
                        image_bytes_list: Optional[List[bytes]] = None,
                        stream: bool = False,
                        tools: Optional[List[Dict[str, Any]]] = None,
                        enable_thinking: Optional[bool] = None,
                        reasoning_effort: Optional[str] = None) -> Any:
        """
        发送聊天补全请求

        Args:
            messages: 消息列表
            max_tokens: 最大 token 数
            image_bytes_list: 图片字节列表
            stream: 是否流式输出
            enable_thinking: 是否启用思考（None=不发送，交由服务端/模型默认）
            reasoning_effort: 思考深度档位 low/medium/xhigh（Qwen3.8 chat_template 参数；仅远程思考模板生效）

        Returns:
            非流式：返回响应字典；流式：返回生成器
        """
        import openai

        effective_max_tokens = max_tokens or self.max_tokens

        # 处理图片
        if image_bytes_list:
            messages = self._add_images_to_messages(messages, image_bytes_list)

        client = self._build_client()

        kwargs = {
            "model": self.model,
            "messages": messages,
            "max_tokens": effective_max_tokens,
        }
        if stream:
            # 让服务端在流末尾 chunk 附带 token 统计（vLLM/SGLang/LM Studio 均支持）
            kwargs["stream_options"] = {"include_usage": True}
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        # Qwen3.8 等思考模板：经 chat_template_kwargs 控制推理过程与思考深度。
        # enable_thinking None=不发送（服务端/模型默认）；False=跳过思考直接出正文（更快更稳）。
        # reasoning_effort 档位由模板注入对应"思考契约"文本（low/medium/xhigh，xhigh 为模板默认）。
        # OpenAI SDK 会把 extra_body 拍平到请求体顶层，等价于顶层 chat_template_kwargs。
        if enable_thinking is not None or reasoning_effort:
            ctk = {}
            if enable_thinking is not None:
                ctk["enable_thinking"] = bool(enable_thinking)
            if reasoning_effort:
                ctk["reasoning_effort"] = str(reasoning_effort)
            kwargs["extra_body"] = {"chat_template_kwargs": ctk}

        if not self.model:
            raise RuntimeError(
                f"No model selected for provider '{self.provider}'. "
                "Open Settings and pick a model first."
            )

        logger.info(f"Sending request to remote LLM: model={self.model}, stream={stream}, chat_template_kwargs={(kwargs.get('extra_body') or {}).get('chat_template_kwargs')}")

        for attempt in (1, 2):
            try:
                if stream:
                    kwargs["stream"] = True
                    return self._stream_response_generator(client, **kwargs)
                response = client.chat.completions.create(**kwargs)
                _log_llm_usage(getattr(response, "usage", None))
                return self._parse_response(response.model_dump())
            except openai.APITimeoutError as e:
                delay = _transient_retry_delay(e)
                if attempt == 1 and delay is not None:
                    logger.warning(f"Remote LLM timeout, retrying in {delay}s: {e}")
                    time.sleep(delay)
                    continue
                logger.warning(f"Remote LLM timeout: {e}")
                raise RuntimeError(f"Remote LLM timeout: {e}")
            except openai.APIConnectionError as e:
                delay = _transient_retry_delay(e)
                if attempt == 1 and delay is not None:
                    logger.warning(f"Remote LLM connection error, retrying in {delay}s: {e}")
                    time.sleep(delay)
                    continue
                logger.warning(f"Remote LLM connection error: {e}")
                raise RuntimeError(f"Remote LLM network error: {e}")
            except openai.APIStatusError as e:
                detail = _api_status_detail(e)
                # 瞬态状态码（408/409/429/5xx）重试一次；其余 4xx 是语义性错误，立即上报
                delay = _transient_retry_delay(e)
                if attempt == 1 and delay is not None:
                    logger.warning(f"Remote LLM HTTP {e.status_code}, retrying in {delay}s: {detail}")
                    time.sleep(delay)
                    continue
                logger.error(f"Remote LLM HTTP error: {e.status_code} | body={detail}")
                raise RuntimeError(f"Remote LLM HTTP {e.status_code}: {detail or e.message}"
                                   f"{self._no_model_loaded_hint(e.status_code, detail)}")
            except Exception as e:
                logger.error(f"Remote LLM completion failed: {e}")
                raise

    def _parse_response(self, response_data: Dict[str, Any]) -> Dict[str, Any]:
        """解析响应为统一格式"""
        choices = response_data.get("choices", [])
        if not choices:
            return {"choices": []}
        
        message = choices[0].get("message", {})
        content = message.get("content", "")
        out_message = {"role": message.get("role", "assistant"), "content": strip_inline_thinking(content)}
        tool_calls = message.get("tool_calls")
        if tool_calls:
            out_message["tool_calls"] = tool_calls
        out = {"choices": [{"message": out_message}]}
        usage = _usage_counts(response_data.get("usage"))
        if usage:
            out["usage"] = usage      # 智能体面板按它报每轮 token；不带就是这一轮没报
        return out

    def _stream_response_generator(self, client, **kwargs):
        """流式响应生成器：逐块 yield {"text":..., "kind":"content"|"thinking"}。

        思考模型（如 qwen3.6-35b-a3b）把推理过程放在 delta.reasoning_content、最终答案放在
        delta.content；两者分开打标，前端可实时展示思考并在正文出现时自动清除，只保留最终结果。
        """
        import openai

        for attempt in (1, 2):
            yielded = False
            try:
                stream = client.chat.completions.create(**kwargs)
                usage = None
                for chunk in stream:
                    if getattr(chunk, "usage", None) is not None:
                        usage = chunk.usage
                    choices = getattr(chunk, "choices", None) or []
                    if not choices:
                        continue
                    delta = choices[0].delta
                    content = getattr(delta, "content", None) or ""
                    reasoning = getattr(delta, "reasoning_content", None) or (getattr(delta, "model_extra", None) or {}).get("reasoning_content") or ""
                    if content:
                        yielded = True
                        yield {"text": content, "kind": "content"}
                    if reasoning:
                        yielded = True
                        yield {"text": reasoning, "kind": "thinking"}
                _log_llm_usage(usage)
                return
            except openai.APITimeoutError as e:
                # 瞬态失败：仅当尚未产出任何内容时重试一次（已吐出的内容无法撤回）
                delay = _transient_retry_delay(e)
                if attempt == 1 and not yielded and delay is not None:
                    logger.warning(f"Remote LLM stream timeout, retrying in {delay}s: {e}")
                    time.sleep(delay)
                    continue
                logger.warning(f"Remote LLM stream timeout: {e}")
                raise RuntimeError(f"Remote LLM timeout: {e}")
            except openai.APIConnectionError as e:
                delay = _transient_retry_delay(e)
                if attempt == 1 and not yielded and delay is not None:
                    logger.warning(f"Remote LLM stream connection error, retrying in {delay}s: {e}")
                    time.sleep(delay)
                    continue
                logger.warning(f"Remote LLM stream connection error: {e}")
                raise RuntimeError(f"Remote LLM network error: {e}")
            except openai.APIStatusError as e:
                detail = _api_status_detail(e)
                # 瞬态状态码（408/409/429/5xx）且尚未产出内容时重试一次；其余 4xx 是语义性错误，立即上报
                delay = _transient_retry_delay(e)
                if attempt == 1 and not yielded and delay is not None:
                    logger.warning(f"Remote LLM stream HTTP {e.status_code}, retrying in {delay}s: {detail}")
                    time.sleep(delay)
                    continue
                logger.error(f"Remote LLM stream HTTP {e.status_code}: {detail}")
                raise RuntimeError(f"Remote LLM HTTP {e.status_code}: {detail or e.message}"
                                   f"{self._no_model_loaded_hint(e.status_code, detail)}")
            except Exception as e:
                logger.error(f"Remote LLM stream failed: {e}")
                raise

    def is_available(self) -> bool:
        """检查客户端是否可用"""
        if not self.provider:
            return False
        # 是否需要 API key 以 provider 定义（configs/llm_providers.json）的 requires_api_key 为准；
        # 自建/本地服务（unsloth / lmstudio / ollama / vllm / OpenAI Compatible）不要求 key
        requires_key = False
        for p in _load_provider_defs():
            if p.get("id") == self.provider:
                requires_key = bool(p.get("requires_api_key", False))
                break
        if requires_key and not self.api_key:
            return False
        return True


# ==========================================
# LLM Singleton (Local Mode)
# ==========================================

class LLMSingleton:
    """LLM 单例模式，确保模型只加载一次（本地模式）"""
    _instance = None
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.model = None
        self.has_mmproj = False
        self._load_model()

    def _load_model(self):
        """加载 LLM 模型，如果不存在则报错"""
        remote_cfg = _load_remote_config()
        local_slot = remote_cfg.get("providers", {}).get("local", {})
        current_model_key: str = local_slot.get("model", "")
        models_dir = local_slot.get("models_dir", "")

        scanned = scan_llm_directory(models_dir)
        model_cfg: Dict[str, Any] = {}
        for item in scanned:
            if item["key"] == current_model_key:
                model_cfg = item
                break

        if not model_cfg and not current_model_key and len(scanned) == 1:
            # 从未保存过选择且目录里恰好只有一个模型：直接回落，无需手动选择
            model_cfg = scanned[0]
            current_model_key = model_cfg["key"]

        if not model_cfg:
            filename = current_model_key or "no model"
            raise RuntimeError(
                f"LLM model not found: {filename}\n"
                f"Please select a model in the node settings (Settings → Neo LLM → Local).\n"
                f"Or switch to remote API mode."
            )

        target_path = _resolve_model_path(model_cfg["model_dir"], model_cfg["filename"])
        model_dir = os.path.dirname(target_path)
        mmproj_name = str(model_cfg.get("mmproj", "") or "")
        if not mmproj_name:
            mmproj_name = _bind_sibling_mmproj(current_model_key)
        mmproj_path = os.path.join(model_dir, mmproj_name) if mmproj_name else None

        logger.info(f"Loading LLM model: {target_path}")
        logger.info(f"mmproj path: {mmproj_path}")

        if not os.path.exists(target_path):
            filename = os.path.basename(target_path) or "unknown.gguf"
            raise RuntimeError(
                f"LLM model not found: {filename}\n"
                f"Expected path: {target_path}\n"
                f"Please place the model file in: {model_dir}/\n"
                f"Or switch to remote API mode in the node settings."
            )

        if not mmproj_path or not os.path.exists(mmproj_path):
            logger.warning(
                f"mmproj file not found: {mmproj_path}. "
                f"Image understanding will not work."
            )
            mmproj_path = None

        try:
            from llama_cpp import Llama
        except ImportError as e:
            # 延迟导入：未安装时插件与远程模式照常工作，仅本地推理给出明确指引
            raise RuntimeError(
                "本地推理需要 llama-cpp-python 但未安装。"
                "请按 README「本地 LLM 推理安装（可选）」章节安装预编译 wheel，"
                "或在 Settings 中切换到远程 API（OpenAI Compatible / OpenRouter / LM Studio / Ollama）。"
            ) from e

        logger.info(f"Initializing Llama with n_ctx=2048, n_threads=4, n_gpu_layers=-1")
        llama_kwargs = {
            "model_path": target_path,
            "n_ctx": 2048,
            "n_threads": 4,
            "n_gpu_layers": -1,
            "verbose": False,
        }

        if mmproj_path:
            logger.info(f"Loading mmproj file: {mmproj_path}")
            llama_kwargs["mmproj"] = mmproj_path
            self.mmproj_path = mmproj_path
        else:
            logger.warning("No mmproj file found, loading text-only model.")

        self.model = Llama(**llama_kwargs)
        self.has_mmproj = mmproj_path is not None
        logger.info(f"LLM model loaded successfully, has_mmproj={self.has_mmproj}")
        print(f"[Neo Studio] LLM model loaded: {os.path.basename(target_path)} | has_mmproj={self.has_mmproj}")

    def create_chat_completion(self, messages, max_tokens, image_bytes_list=None, stream=False,
                               tools=None, tool_choice=None):
        """创建聊天补全请求，支持图像输入、工具调用和流式输出"""
        if self.model is None:
            raise RuntimeError("LLM Model not loaded")

        if image_bytes_list and len(image_bytes_list) > 0:
            new_messages = []
            for msg in messages:
                if msg.get("role") == "user":
                    content_list = []
                    for img_bytes in image_bytes_list:
                        if isinstance(img_bytes, (bytes, bytearray)):
                            b64 = base64.b64encode(img_bytes).decode('utf-8')
                            data_uri = f"data:image/png;base64,{b64}"
                        elif isinstance(img_bytes, str):
                            data_uri = img_bytes
                        else:
                            continue
                        content_list.append({"type": "image_url", "image_url": {"url": data_uri}})
                    content_list.append({"type": "text", "text": msg.get("content", "")})
                    new_messages.append({"role": "user", "content": content_list})
                else:
                    new_messages.append(msg)
            messages = new_messages

        return self.model.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            stream=stream,
            tools=tools,
            tool_choice=tool_choice,
        )


def get_llm_instance():
    """获取 LLM 单例实例（本地模式）"""
    return LLMSingleton.get_instance()


# ==========================================
# Native Backend (ComfyUI safetensors text generation)
# ==========================================
# 复用 ComfyUI 原生文本生成路径（clip.tokenize -> clip.generate -> clip.decode），
# 直接吃 models/text_encoders 下的 safetensors（如 Qwen3.5-4B BF16），无需 llama.cpp wheel。
# 原生引擎整段生成：非流式直接返回整段；流式走伪流式（整段拆块透传，无逐字动画）。
# 多轮/工具对话（chat_turn+tools）无法解析 tool_calls，回退 llama.cpp。

_NATIVE_CLIP_CACHE: Dict[str, Any] = {}
# 原生 clip 单例不可并发：clip.generate 内部会改写 cond_stage_model 的 clip options 与
# KV/position 缓冲，多线程同时进入会互相踩踏 → 复读乱码，甚至 index_copy_ 越界触发
# CUDA device-side assert 崩溃。引擎内是串行执行，队列外调用（run_in_executor 线程池）需自己加锁。
_NATIVE_LOCK = threading.Lock()


def scan_native_models() -> List[Dict[str, Any]]:
    """扫描 text_encoders 目录下的 safetensors 文本生成模型，供前端下拉选择。

    qwen3.5 / qwen3 系列排到最前（前端无已存选择时默认取第一个，故首选即常用模型）。
    """
    def rank(name: str) -> int:
        key = re.sub(r"[^a-z0-9]", "", name.lower())
        if "qwen35" in key:
            return 0
        if "qwen3" in key:
            return 1
        return 2

    models: List[Dict[str, Any]] = []
    try:
        for name in folder_paths.get_filename_list("text_encoders"):
            if name.lower().endswith(".safetensors"):
                models.append({"key": name, "name": name})
        models.sort(key=lambda m: (rank(m["key"]), m["key"].lower()))
    except Exception as e:
        logger.warning(f"Failed to scan native text_encoders models: {e}")
    return models


def _get_native_model_name() -> str:
    """读取 native provider 槽位保存的模型文件名。"""
    slot = _load_remote_config().get("providers", {}).get("native", {})
    return str(slot.get("model", "") or "")


def _build_native_clip(name: str):
    """按文件名从 text_encoders 加载并缓存 ComfyUI CLIP 单例（Qwen3.5 等 safetensors 文本生成模型）。"""
    if not name:
        raise RuntimeError(
            "Native model not selected. Open Settings → Neo LLM → Native and pick a model.\n"
            "Place a Qwen3.5 safetensors file in models/text_encoders/ first."
        )
    cached = _NATIVE_CLIP_CACHE.get(name)
    if cached is not None:
        return cached
    import comfy.sd
    path = folder_paths.get_full_path_or_raise("text_encoders", name)
    logger.info(f"Loading native text-gen model: {path}")
    # Qwen3.5 由 detect_te_model 按权重形状自动识别，无需指定 clip_type
    clip = comfy.sd.load_clip(
        ckpt_paths=[path],
        model_options={"clip_name": name},
    )
    _NATIVE_CLIP_CACHE[name] = clip
    logger.info(f"Native text-gen model loaded: {name}")
    print(f"[Neo Studio] Native text-gen model loaded: {name}")
    return clip


def unload_native_model():
    """卸载原生文本生成模型：从显存释放并清缓存（只卸这些模型，保留其它已加载模型）。"""
    if not _NATIVE_CLIP_CACHE:
        return
    import comfy.model_management
    for clip in list(_NATIVE_CLIP_CACHE.values()):
        patcher = getattr(clip, "patcher", None)
        if patcher is None:
            continue
        try:
            comfy.model_management.unload_model_and_clones(patcher)
        except Exception as e:
            logger.warning(f"Failed to unload native model from VRAM: {e}")
    _NATIVE_CLIP_CACHE.clear()
    logger.info("Native text-gen model unloaded, VRAM freed")


def _pil_to_comfy_image(img) -> Any:
    """PIL Image / 字节 → ComfyUI IMAGE 张量 [1,H,W,3] float 0-1。"""
    import numpy as np
    import torch
    if not isinstance(img, Image.Image):
        img = Image.open(io.BytesIO(img))
    arr = np.array(img.convert("RGB"), dtype="float32") / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _run_native_inference(system_prompt: str, user_text: str, max_tokens: int,
                          images: Optional[Any] = None, do_sample: bool = False,
                          temperature: float = 1.0, top_k: int = 50, top_p: float = 0.95,
                          min_p: float = 0.0, repetition_penalty: float = 1.0,
                          presence_penalty: float = 0.0, seed: Optional[int] = None,
                          thinking: bool = False, strip_thinking: bool = True,
                          model: Optional[str] = None) -> str:
    """原生 ComfyUI 文本生成后端：tokenize -> generate -> decode，整段生成。

    默认贪心（do_sample=False）保证确定性与可复现；传入采样参数时按参数采样。
    strip_thinking=True 剥离思考块只留正文（非流式）；伪流式传 False 保留原文，
    交由 _native_stream_chunks 按思考/正文拆块透传前端。
    model 覆盖本次调用的模型（连接测试用当前表单值，缺省读已保存槽位）。
    """
    import comfy.utils
    import comfy.cli_args
    # 单例 clip 串行化：并发进入会让 clip.generate 改写共享的 clip options / KV 缓冲而互相踩踏。
    with _NATIVE_LOCK:
        # 队列外执行：原生解码在有 comfy-aimdo(DynamicVRAM) 的服务器里走 graph_dynamic_vbar_blocks +
        # CUDA-graph 复用（prefetch_queue_pop 的 enable_graph）。队列外第二次复用会把 KV 写坏 →
        # index_copy_ 越界 → device-side assert 崩溃（首次全新加载正常）。强制 eager 路径即稳定，
        # 与首次加载行为一致。生成结束恢复全局标志。
        args = comfy.cli_args.args
        old_dcg, old_dcc = args.disable_cuda_graphs, args.disable_comfy_compiler
        args.disable_cuda_graphs = True
        args.disable_comfy_compiler = True
        # 队列外执行：原生 generate 内部用 comfy.utils.ProgressBar 逐 token 上报，进度钩子取不到
        # prompt_id/node_id 时会回退读 server_instance.last_prompt_id（首次入队前该属性不存在）→
        # AttributeError。这里临时禁用全局 hook 后恢复（同 sam3_seg 队列外调用范式）。
        old_hook = comfy.utils.PROGRESS_BAR_HOOK
        comfy.utils.PROGRESS_BAR_HOOK = None
        try:
            clip = _build_native_clip((model or "").strip() or _get_native_model_name())
            image_tensor = None
            if images is not None and len(images) > 0:
                image_tensor = _pil_to_comfy_image(images[0])
            tokens = clip.tokenize(user_text, image=image_tensor, system_prompt=system_prompt,
                                   thinking=thinking, min_length=1)
            gen = clip.generate(tokens, do_sample=do_sample, max_length=max_tokens,
                                temperature=temperature, top_k=top_k, top_p=top_p, min_p=min_p,
                                repetition_penalty=repetition_penalty, presence_penalty=presence_penalty,
                                seed=seed, mtp=False)
            text = clip.decode(gen)
        finally:
            comfy.utils.PROGRESS_BAR_HOOK = old_hook
            args.disable_cuda_graphs = old_dcg
            args.disable_comfy_compiler = old_dcc
    # 剥离思考块，仅保留正文（与 TextGenerate 节点一致）
    if strip_thinking:
        reasoning, sep, body = text.partition("</think>")
        if sep and (reasoning.lstrip().startswith("<think>") or user_text.rstrip().endswith("<think>")):
            text = body
    return text.strip()


def _native_stream_chunks(text: str) -> Generator[Dict[str, Any], None, None]:
    """原生整段文本 → 伪流式块：按 <think> 拆成 thinking/content，逐块 yield {"text","kind"}。

    原生引擎整段生成、无法逐 token，这里把整段结果拆块喂给流式接口，
    前端思考面板与正文照常工作（无逐字打字动画）。
    """
    splitter = _InlineThinkSplitter()
    for kind, part in list(splitter.feed(text)) + splitter.flush():
        if part:
            yield {"text": part, "kind": kind}


def test_native_connection(model: str = "") -> Dict[str, Any]:
    """原生后端连接测试：真正加载模型并跑一次短推理，返回 {success, reply}｜{success, error}。

    远程 provider 的连接测试打 HTTP；原生后端本地生成，故此处实跑一次推理，
    用当前表单模型（缺省读已保存槽位）验证模型可加载、可出字。
    """
    try:
        text = _run_native_inference("You are a helpful assistant. Reply briefly.",
                                     "你好", 32, model=(model or "").strip() or None)
    except Exception as e:
        logger.warning(f"Native LLM connection test failed: {e}")
        return {"success": False, "error": str(e)}
    reply = (text or "").strip()
    if not reply:
        return {"success": False, "error": "模型返回为空"}
    preview = reply[:80] + ("…" if len(reply) > 80 else "")
    return {"success": True, "reply": preview}


# ==========================================
# Unified LLM Inference Engine
# ==========================================

def _run_llm_inference(system_prompt: str, user_text: str, max_tokens: int,
                       images: Optional[Any] = None, use_remote: bool = False,
                       stream: bool = False, enable_thinking: Optional[bool] = None,
                       reasoning_effort: Optional[str] = None) -> Any:  # type: ignore[return-type]
    """
    执行 LLM 推理，支持本地和远程模式

    Args:
        system_prompt: 系统提示词
        user_text: 用户文本
        max_tokens: 最大 token 数
        images: PIL Image 对象列表或字节数据列表（仅本地模式支持）
        use_remote: 是否使用远程 API
        stream: 是否流式输出

    Returns:
        非流式：LLM 响应文本；流式：返回生成器
    """
    # 思考模型会先把 token 预算花在 reasoning_content，任务模板默认值常被推理耗尽导致正文为空。
    # 远程/本地流式都给一个下限，保证思考结束后仍有空间输出最终答案（见 STREAM_MIN_MAX_TOKENS）。
    if stream and max_tokens < STREAM_MIN_MAX_TOKENS:
        max_tokens = STREAM_MIN_MAX_TOKENS

    if use_remote:
        # 远程模式不再回退本地：请求成功返回结果，不能访问则直接抛错由上层上报
        return _run_remote_inference(system_prompt, user_text, max_tokens, images, stream=stream,
                                     enable_thinking=enable_thinking, reasoning_effort=reasoning_effort)
    if get_current_mode() == LLM_MODE_NATIVE:
        # 原生引擎整段生成、无法逐 token。流式请求走伪流式：跑完整段后按思考/正文拆块透传，
        # 前端流式接口照常工作（无逐字打字动画）。工具循环（chat_turn+tools）仍回退 llama.cpp。
        text = _run_native_inference(system_prompt, user_text, max_tokens, images=images,
                                     thinking=bool(enable_thinking), strip_thinking=not stream)
        if stream:
            return _native_stream_chunks(text)
        return text
    return _run_local_inference(system_prompt, user_text, max_tokens, images, stream=stream)


def _run_local_inference(system_prompt: str, user_text: str, max_tokens: int,
                         images: Optional[Any] = None, stream: bool = False) -> Any:  # type: ignore[return-type]
    """执行本地 LLM 推理"""
    llm = get_llm_instance()
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text}
    ]

    try:
        image_bytes_list = None
        if images is not None and len(images) > 0:
            image_bytes_list = []
            for img in images:
                if hasattr(img, 'tobytes'):
                    buffer = io.BytesIO()
                    img.save(buffer, format='PNG')
                    image_bytes_list.append(buffer.getvalue())
                elif isinstance(img, (bytes, bytearray)):
                    image_bytes_list.append(img)
                elif hasattr(img, 'read'):
                    image_bytes_list.append(img.read())

        output = llm.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            image_bytes_list=image_bytes_list,
            stream=stream,
        )

        if stream:
            return output  # 返回生成器

        if not isinstance(output, dict):
            logger.warning(f"LLM returned non-dict output: {type(output)}")
            return None

        choices = output.get('choices')
        if not isinstance(choices, list) or len(choices) == 0:
            logger.warning("LLM response 'choices' is empty or invalid.")
            return None

        message = choices[0].get('message', {})
        content = message.get('content', '')

        if not content:
            logger.warning("LLM 'content' is None.")
            return ""

        return content.strip()
    except Exception as e:
        logger.exception(f"Error during local LLM inference: {e}")
        return None


def _run_remote_inference(system_prompt: str, user_text: str, max_tokens: int,
                          images: Optional[Any] = None, stream: bool = False,
                          enable_thinking: Optional[bool] = None,
                          reasoning_effort: Optional[str] = None) -> Any:  # type: ignore[return-type]
    """执行远程 LLM 推理"""
    config = _get_active_remote_config()

    if not config.get("enabled", False):
        raise RuntimeError("Remote LLM is not enabled. Please configure remote_llm_config.json")

    client = RemoteLLMClient(config)

    # 不做 is_available() 前置拦截（缺 API key / provider 也继续发请求），不能访问时直接抛出错误
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_text}
    ]

    try:
        image_bytes_list = None
        if images is not None and len(images) > 0:
            image_bytes_list = []
            for img in images:
                if hasattr(img, 'tobytes'):
                    buffer = io.BytesIO()
                    img.save(buffer, format='PNG')
                    image_bytes_list.append(buffer.getvalue())
                elif isinstance(img, (bytes, bytearray)):
                    image_bytes_list.append(img)
                elif hasattr(img, 'read'):
                    image_bytes_list.append(img.read())

        logger.info(f"Sending request to remote LLM: provider={client.provider}, model={client.model}")
        response = client.chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            image_bytes_list=image_bytes_list,
            stream=stream,
            enable_thinking=enable_thinking,
            reasoning_effort=reasoning_effort,
        )

        if stream:
            return response  # 返回生成器

        logger.info(f"Remote LLM response received")
        choices = response.get("choices", [])
        if not choices:
            logger.warning("Remote LLM response 'choices' is empty.")
            return ""

        message = choices[0].get("message", {})
        content = message.get("content", "")

        return content.strip() if content else ""
    except (RuntimeError, OSError, socket.gaierror) as e:
        # 不能访问直接报错：保留真实原因向上抛（run_llm_task / 流式路由统一上报），不再静默返回 None
        logger.warning(f"Remote LLM inference failed (network): {e}")
        raise
    except Exception as e:
        logger.exception(f"Error during remote LLM inference: {e}")
        raise


# ==========================================
# Language Detection Utility
# ==========================================

def _detect_language(text):
    """检测文本语言"""
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


# ==========================================
# LLM Task Definitions - Load from task skills (skills/tasks/<task>/skill.md)
# ==========================================


def _build_llm_tasks() -> Dict[str, Any]:
    """Build LLM_TASKS from task skills."""
    tasks = {}
    task_names = [
        "extract_title",
        "extract_classify",
        "translate_prompt",
        "smart_prompt",
        "template_prompt",
        "reverse_prompt",
        "lora_tag",
        "director_story",
        "director_optimize",
        "director_modify_segment",
        "director_panel_describe",
        "storyboard_story",
    ]

    for task_name in task_names:
        template = skill.load_task_template(task_name)
        if template is not None:
            tasks[task_name] = {
                "system": template.get("content", ""),
                "max_tokens": template.get("max_tokens", 500),
                "result_key": template.get("result_key", "prompt"),
                "description": template.get("description", ""),
                "multi_result": template.get("multi_result"),
            }
        else:
            logger.warning(f"Failed to load task skill: {task_name}")

    return tasks


# LLM_TASKS is now dynamically loaded from task skills
LLM_TASKS = _build_llm_tasks()

DEFAULT_MULTI_SEPARATOR = "\n---\n"


def resolve_multi_result(text: str, rule: Optional[Dict[str, Any]] = None) -> List[str]:
    """按 skill 的 multi_result 输出契约把 LLM 文本拆分为提示词列表。

    rule 为 None 表示该 skill 未声明多结果，返回空列表（调用方回退为整段文本）。

    rule 格式（来自任务/模板 skill.md frontmatter 的 multi_result 字段）：
      {"format": "separator", "separator": "\n---\n"}   按分隔符拆分（默认分隔符）
      {"format": "json_array"}                            按 JSON 数组解析，失败回退分隔符
    """
    if not text or not text.strip():
        return []
    if not rule:
        return []

    fmt = str(rule.get("format", "separator"))
    candidates: List[str] = []

    if fmt == "json_array":
        try:
            data = json.loads(text)
        except Exception:
            data = None
        if isinstance(data, list):
            candidates = [str(x) for x in data]
        elif isinstance(data, dict):
            for value in data.values():
                if isinstance(value, list):
                    candidates = [str(x) for x in value]
                    break

    if not candidates:
        sep = str(rule.get("separator") or DEFAULT_MULTI_SEPARATOR)
        candidates = re.split(re.escape(sep), text)

    return [c.strip() for c in candidates if c and c.strip()]


# ==========================================
# Public LLM Task Runner
# ==========================================

def chat_turn(messages: List[Dict[str, Any]], max_tokens: Optional[int] = None,
              tools: Optional[List[Dict[str, Any]]] = None,
              enable_thinking: Optional[bool] = None,
              reasoning_effort: Optional[str] = None) -> Dict[str, Any]:
    """对当前激活的 provider（本地 llama.cpp 或远程 API）执行一次（非流式）对话，返回 assistant message dict。

    供 skill 代理循环与右栏智能体按需调用：传入带 tools 的 messages，返回含 content / tool_calls 的消息。
    provider 报了 token 统计时消息里多一项 usage（plain dict）——调用方要按它报每轮用量；
    没报时没有这一项，调用方按「没有」处理，不当 0。
    按 get_current_mode() 分发到本地或远程；对应后端不可用时抛出 RuntimeError。
    """
    if get_current_mode() == LLM_MODE_REMOTE:
        config = _get_active_remote_config()
        if not config.get("enabled", False):
            raise RuntimeError("Remote LLM is disabled")
        client = RemoteLLMClient(config)
        if not client.is_available():
            raise RuntimeError(f"Remote provider '{client.provider}' is not available")
        response = client.chat_completion(messages=messages, max_tokens=max_tokens, tools=tools,
                                          enable_thinking=enable_thinking, reasoning_effort=reasoning_effort)
    else:
        if get_current_mode() == LLM_MODE_NATIVE:
            logger.info("Native backend does not support multi-turn/tool chat; falling back to llama.cpp local backend.")
        llm = get_llm_instance()
        response = llm.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens or 500,
            tools=tools,
            tool_choice="auto" if tools else None,
        )
    choices = response.get("choices", [])
    if not choices:
        return {}
    message = choices[0].get("message", {}) or {}
    usage = _usage_counts(response.get("usage"))
    if usage:
        message = {**message, "usage": usage}
    return message


def run_llm_task(task_name: str, text: str, extra_system_prompt: Optional[str] = None,
                 images: Optional[Any] = None, system_prompt: Optional[str] = None,
                 max_tokens_override: Optional[int] = None) -> Dict[str, Any]:
    """
    执行 LLM 任务

    Args:
        task_name: 任务名称，必须在 LLM_TASKS 中定义
        text: 输入文本
        extra_system_prompt: 额外的系统提示词（可选）
        images: 图像数据列表（可选，用于多模态任务）
        system_prompt: 完全自定义的系统提示词（可选，会覆盖默认系统提示词）

    Returns:
        dict: 包含 status 和结果的数据，或错误信息
    """
    if task_name not in LLM_TASKS:
        return {"error": f"Invalid task: {task_name}"}

    task_config = LLM_TASKS[task_name]

    # Debug logging
    logger.info(f"run_llm_task: task_name={task_name}, system_prompt provided={system_prompt is not None}, system_prompt_length={len(system_prompt) if system_prompt else 0}")

    # 如果提供了自定义 system_prompt（非空），使用它
    if system_prompt is not None and system_prompt.strip():
        # Use the provided system_prompt as-is
        logger.info(f"Using custom system_prompt (length: {len(system_prompt)})")
        pass
    # 如果没有提供 system_prompt，使用任务默认的
    elif system_prompt is None:
        system_prompt = task_config["system"]
        logger.info(f"Using default system_prompt (length: {len(system_prompt)})")
    # 如果是 template_prompt 且提供了空字符串，使用 extra_system_prompt
    elif task_name == "template_prompt" and extra_system_prompt:
        system_prompt = extra_system_prompt
        logger.info(f"Using extra_system_prompt for template_prompt (length: {len(system_prompt)})")
    # 否则使用任务默认的
    else:
        system_prompt = task_config["system"]
        logger.info(f"Using default system_prompt (fallback, length: {len(system_prompt)})")

    max_tokens = task_config["max_tokens"]
    if max_tokens_override:
        max_tokens = int(max_tokens_override)
    result_key = task_config["result_key"]

    use_remote = get_current_mode() == LLM_MODE_REMOTE

    if task_name == "translate_prompt":
        source_lang = _detect_language(text)

        if source_lang == 'Chinese':
            target_lang = 'English'
        else:
            target_lang = 'Chinese'

        system_prompt += f"\nTranslation Direction: {source_lang} to {target_lang}"
        logger.info(f"Auto-detected translation direction: {source_lang} -> {target_lang}")

        result = TRANSLATION_CACHE.get(text)
        if result:
            logger.info(f"Translation cache HIT for: '{text[:20]}...'")
            return {"status": "success", result_key: result}

    if extra_system_prompt and system_prompt is not None:
        system_prompt = system_prompt + extra_system_prompt

    try:
        result = _run_llm_inference(system_prompt, text, max_tokens, images=images, use_remote=use_remote)
    except Exception as e:
        logger.error(f"Failed to execute task {task_name}: {e}")
        return {"error": f"LLM inference failed: {str(e)}"}

    if not result:
        mode_str = "Remote API" if use_remote else "Local model"
        logger.warning(f"Failed to get response from {mode_str} for task: {task_name}")
        return {"error": f"failed to {task_name.replace('_', ' ')}"}

    if task_name == "translate_prompt":
        TRANSLATION_CACHE.set(text, result)
        logger.info(f"Saved result to cache: '{text[:20]}...' -> '{result[:20]}...'")

    logger.info(f"LLM task {task_name} completed: input='{text[:100]}...', output='{result[:100]}...'")
    return {"status": "success", result_key: result}


def run_llm_task_stream(task_name: str, text: str, extra_system_prompt: Optional[str] = None,
                        images: Optional[Any] = None, system_prompt: Optional[str] = None,
                        max_tokens_override: Optional[int] = None, context: Optional[Dict[str, Any]] = None,
                        enable_thinking: Optional[bool] = None,
                        reasoning_effort: Optional[str] = None) -> Generator[Dict[str, Any], None, None]:
    """
    流式执行 LLM 任务，返回生成器

    Args:
        task_name: 任务名称，必须在 LLM_TASKS 中定义
        text: 输入文本
        extra_system_prompt: 额外的系统提示词（可选，已废弃，请使用 system_prompt）
        images: 图像数据列表（可选，用于多模态任务）
        system_prompt: 完全自定义的系统提示词（可选，会覆盖默认系统提示词）
        context: 前端采集的工作流上下文（可选，MiniMax H3 参数 + 参考媒体清单，注入系统提示词）

    Yields:
        dict: {"text": 文本块, "kind": "content"|"thinking"}；正文为 content，思考过程为 thinking
    """
    if task_name not in LLM_TASKS:
        yield {"text": f"[ERROR] Invalid task: {task_name}", "kind": "content"}
        return

    task_config = LLM_TASKS[task_name]

    # 如果提供了自定义 system_prompt（非空），使用它
    if system_prompt is not None and system_prompt.strip():
        # Use the provided system_prompt as-is
        logger.info(f"run_llm_task_stream: Using custom system_prompt (length: {len(system_prompt)})")
        pass
    # 如果没有提供 system_prompt，使用任务默认的
    elif system_prompt is None:
        system_prompt = task_config["system"]
        logger.info(f"run_llm_task_stream: Using default system_prompt (length: {len(system_prompt)})")
    # 如果是 template_prompt 且提供了空字符串，使用 extra_system_prompt
    elif task_name == "template_prompt" and extra_system_prompt:
        system_prompt = extra_system_prompt
        logger.info(f"run_llm_task_stream: Using extra_system_prompt for template_prompt (length: {len(system_prompt)})")
    # 否则使用任务默认的
    else:
        system_prompt = task_config["system"]
        logger.info(f"run_llm_task_stream: Using default system_prompt (fallback, length: {len(system_prompt)})")

    max_tokens = task_config["max_tokens"]
    if max_tokens_override:
        max_tokens = int(max_tokens_override)

    use_remote = get_current_mode() == LLM_MODE_REMOTE

    if task_name == "translate_prompt":
        source_lang = _detect_language(text)
        if source_lang == 'Chinese':
            target_lang = 'English'
        else:
            target_lang = 'Chinese'
        system_prompt += f"\nTranslation Direction: {source_lang} to {target_lang}"

    # 兼容旧版：如果没有提供 system_prompt，但有 extra_system_prompt，追加到默认提示词
    # 注意：如果已经提供了 system_prompt，这个逻辑不会执行
    if extra_system_prompt and (system_prompt == task_config["system"]):
        system_prompt = system_prompt + extra_system_prompt

    # 工作流上下文（MiniMax H3 参数 + 参考媒体清单）：仅元数据注入，参考图像素由 skill 工具按需取回
    ctx_block = skill._format_workflow_context(context)
    if ctx_block:
        system_prompt += "\n\n" + ctx_block

    try:
        result_gen = _run_llm_inference(system_prompt, text, max_tokens, images=images,
                                        use_remote=use_remote, stream=True, enable_thinking=enable_thinking,
                                        reasoning_effort=reasoning_effort)
        if hasattr(result_gen, '__iter__') and not isinstance(result_gen, str):
            # 内联 < think> 拆分器：把写进正文的推理块重标为 thinking，避免泄漏进输出区
            splitter = _InlineThinkSplitter()
            for chunk in result_gen:
                # 远程生成器已带 {"text","kind"}；本地 llama.cpp 为 {choices:[{delta:{...}}]}。
                # 统一抽出正文(content)与独立推理(reasoning_content)，正文再过内联思考拆分器。
                content = ""
                reasoning = ""
                if isinstance(chunk, dict):
                    if "text" in chunk:
                        if chunk.get("kind", "content") == "thinking":
                            reasoning = chunk["text"]
                        else:
                            content = chunk["text"]
                    else:
                        choices = chunk.get("choices", [])
                        if choices:
                            delta = choices[0].get("delta", {})
                            content = delta.get("content") or ""
                            reasoning = delta.get("reasoning_content") or ""
                elif isinstance(chunk, str):
                    content = chunk
                for kind, part in splitter.feed(content):
                    yield {"text": part, "kind": kind}
                if reasoning:
                    yield {"text": reasoning, "kind": "thinking"}
            for kind, part in splitter.flush():
                yield {"text": part, "kind": kind}
        else:
            yield {"text": strip_inline_thinking(result_gen or ""), "kind": "content"}
    except Exception as e:
        logger.error(f"Failed to execute stream task {task_name}: {e}")
        yield {"text": f"[ERROR] {str(e)}", "kind": "content"}


# ==========================================
# API Handler Functions
# ==========================================

# 把同步阻塞调用（OpenAI SDK / llama.cpp 推理）丢进线程池执行。
# 直接在 async 路由里跑会卡死 aiohttp 事件循环：LLM 未返回期间 presets 列表等
# 所有其他请求都无法响应。
async def _run_blocking(fn):
    return await asyncio.get_running_loop().run_in_executor(None, fn)


async def handle_llm_api_request(task_name, request):
    """
    处理 LLM API 请求

    Args:
        task_name: 任务名称
        request: 请求对象

    Returns:
        web.json_response: 响应对象
    """
    if task_name not in LLM_TASKS:
        return web.json_response({"error": "Invalid task"}, status=400)

    try:
        data = await request.json()
        text = data.get("text", "")

        logger.info(f"LLM API request: task={task_name}, text='{text[:100]}...'")

        if not text or not text.strip():
            return web.json_response({"error": "text content is empty"}, status=400)

        result_data = await _run_blocking(lambda: run_llm_task(task_name, text))

        if "error" in result_data:
            error_msg = result_data["error"]
            logger.warning(f"LLM API error: task={task_name}, error={error_msg}")

            if get_current_mode() == LLM_MODE_LOCAL and ("LLM model not found" in error_msg or "Model not loaded" in error_msg):
                return web.json_response({
                    "error": f"Local model is not available. Please download the model first, or switch to remote API mode."
                }, status=422)

            if get_current_mode() == LLM_MODE_REMOTE:
                return web.json_response({
                    "error": f"Remote API error: {error_msg}. Please check your remote_llm_config.json configuration."
                }, status=422)

            return web.json_response({"error": error_msg}, status=422)

        logger.info(f"LLM API response: task={task_name}, result='{result_data.get('prompt', result_data.get('enhanced', result_data.get('translated', '')))[:100]}...'")
        return web.json_response(result_data)

    except Exception as e:
        logger.error(f"Error handling LLM task {task_name}: {e}")
        logger.exception(e)
        return web.json_response({"error": str(e)}, status=500)


async def handle_llm_api_stream(task_name, request):
    """
    处理流式 LLM API 请求（SSE）

    Args:
        task_name: 任务名称
        request: 请求对象

    Returns:
        web.Response: SSE 流式响应
    """
    if task_name not in LLM_TASKS:
        return web.Response(text="data: [ERROR] Invalid task\n\n", content_type="text/event-stream")

    try:
        data = await request.json()
        text = data.get("text", "")
        skill_id = data.get("skillId", data.get("skill_id", ""))
        raw_images = data.get("images") or []
        # 前端采集的 @引用/本地上传参考图（不含连线图）+ 节点 id，供出队时合并进 bundle.references
        bundle_refs = data.get("bundleRefs") or []
        node_id = str(data.get("uid") or "")
        if node_id and bundle_refs:
            from .prompts import store_bundle_refs
            store_bundle_refs(node_id, bundle_refs)
        # 前端采集的工作流上下文（MiniMax H3 参数 + 参考媒体清单），仅元数据，无图像素
        context = data.get("context")
        # "思考深度"下拉：off→enable_thinking=False；low/medium/xhigh→reasoning_effort（Qwen3.8 模板档位）
        enable_thinking = data.get("enable_thinking")
        reasoning_effort = data.get("reasoning_effort")
        if reasoning_effort not in ("low", "medium", "xhigh"):
            reasoning_effort = None

        logger.info(f"LLM API stream request: endpoint={task_name}, text='{text[:100]}...', skillId='{skill_id}', images={len(raw_images)}, context={'yes' if context else 'no'}, enable_thinking={enable_thinking}, reasoning_effort={reasoning_effort}")

        # 允许空文本：有图片输入（如反推）时合法
        images = []
        if raw_images:
            from .prompts import resolve_image_bytes
            images = [b for b in (resolve_image_bytes(src) for src in raw_images) if b]
            if not images:
                return web.Response(text="data: [ERROR] invalid image data\n\n", content_type="text/event-stream")

        if not text.strip() and not images:
            return web.Response(text="data: [ERROR] text content is empty\n\n", content_type="text/event-stream")

        # skill 路由：skillId 优先于 endpoint 的 task_name
        # （任务类 skill 如 reverse_prompt 直接用其默认系统提示词）
        if skill_id and skill_id in LLM_TASKS:
            task_name = skill_id
            logger.info(f"Skill route: task_name='{skill_id}'")

        system_prompt = None
        template_max_tokens = None
        skill_agent = False
        if task_name == "reverse_prompt":
            logger.info("reverse_prompt skill: using default task system prompt")
        elif skill_id:
            # 非任务类 skill：走代理循环（按需读取引用 + 中英主文件互斥）
            logger.info(f"Attempting to load skill: {skill_id}")
            if skill.load_skill_content(skill_id):
                skill_agent = True
                logger.info(f"Routing skill '{skill_id}' through agent runner")
            else:
                logger.warning(f"Skill '{skill_id}' not found or has no content")
        elif images:
            # 有图但未指定 skill：默认走反推
            task_name = "reverse_prompt"
            logger.info("Image input without explicit skill, using reverse_prompt")
        else:
            logger.info("No skillId provided, using default task")

        async def event_stream():
            try:
                # 将模板内容作为 system_prompt 传递；图片 byte 列表传给流式任务。
                # 同步生成器在事件循环上直接迭代会阻塞整个 aiohttp loop（LLM 未出首包
                # 时其他请求全部卡住），因此每次 next() 都丢进线程池执行。
                if skill_agent:
                    gen = skill.run_skill_agent_stream(skill_id, text, images=images if images else None, context=context,
                                                       enable_thinking=enable_thinking, reasoning_effort=reasoning_effort)
                else:
                    gen = run_llm_task_stream(task_name, text, system_prompt=system_prompt,
                                              images=images if images else None,
                                              max_tokens_override=template_max_tokens,
                                              context=context,
                                              enable_thinking=enable_thinking,
                                              reasoning_effort=reasoning_effort)
                loop = asyncio.get_running_loop()

                def next_chunk():
                    try:
                        return next(gen)
                    except StopIteration:
                        return None

                while True:
                    chunk = await loop.run_in_executor(None, next_chunk)
                    if chunk is None:
                        break
                    # JSON 编码每个 chunk：换行/引号等特殊字符转义后才能安全穿过 SSE 的 data:\n\n 分帧，
                    # 否则单个 "\n" 会拆成空 data: 行被前端丢弃（导致预览变成一行）。
                    # kind 区分思考（thinking）与正文（content），前端据此展示/清除思考区。
                    if isinstance(chunk, dict):
                        frame = {"text": chunk.get("text", ""), "kind": chunk.get("kind", "content")}
                    else:
                        frame = {"text": chunk}
                    yield ("data: " + json.dumps(frame) + "\n\n").encode()

                yield b"data: [DONE]\n\n"
            except Exception as e:
                logger.error(f"Stream error for task {task_name}: {e}")
                yield (f"data: [ERROR] {str(e)}\n\n").encode()
                yield b"data: [DONE]\n\n"

        return web.Response(
            body=event_stream(),
            content_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        )
    except Exception as e:
        logger.error(f"Error handling stream LLM task {task_name}: {e}")
        logger.exception(e)
        return web.Response(
            text=f"data: [ERROR] {str(e)}\n\ndata: [DONE]\n\n",
            content_type="text/event-stream"
        )


# ==========================================
# LLM 配置路由：只读配置文件 / 扫模型目录 / 打 8080 与远程服务，不碰 ComfyUI 运行时。
# ComfyUI 与桌面端共用这一批 handler（桌面端按 app/studio_caps.py 挂载同一份代码）。
# ==========================================

routes = web.RouteTableDef()


def _mask_remote_config(config: dict) -> dict:
    """复制配置并隐藏所有 provider 的 api_key（固定星号串，前端原样显示）"""
    safe = copy.deepcopy(config)
    for slot in safe.get("providers", {}).values():
        if isinstance(slot, dict) and slot.get("api_key"):
            slot["api_key"] = API_KEY_MASK
    return safe


@routes.get("/rs_prompts/get_models")
async def rs_prompts_get_models(request):
    try:
        return web.json_response(get_available_models())
    except Exception as e:
        logger.error(f"Error getting models: {e}")
        return web.Response(status=500, text=str(e))


@routes.get("/rs_prompts/native_models")
async def rs_prompts_get_native_models(request):
    """原生文本生成模型列表（扫描 text_encoders 下的 safetensors）。"""
    try:
        return web.json_response({"models": scan_native_models()})
    except Exception as e:
        logger.error(f"Error getting native models: {e}")
        return web.json_response({"models": []})


@routes.post("/rs_prompts/set_model")
async def rs_prompts_set_model(request):
    try:
        data = await request.json()
        model_key = data.get("model_key")
        if not model_key:
            return web.Response(status=400, text="model_key required")
        if set_current_model(model_key):
            return web.json_response({"success": True, "current_model": model_key})
        return web.Response(status=400, text="Invalid model key")
    except Exception as e:
        logger.error(f"Error setting model: {e}")
        return web.Response(status=500, text=str(e))


@routes.get("/rs_prompts/remote_llm_config")
async def rs_prompts_get_remote_llm_config(request):
    """获取远程 LLM 配置（按 provider 分槽，返回时隐藏 api_key）"""
    try:
        masked = _mask_remote_config(get_remote_llm_config())
        masked["provider_list"] = get_provider_list()
        return web.json_response(masked)
    except Exception as e:
        logger.error(f"Error getting remote LLM config: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/remote_llm_config")
async def rs_prompts_set_remote_llm_config(request):
    """设置远程 LLM 配置（只更新对应 provider，不覆盖其它 provider）"""
    try:
        data = await request.json()
        set_remote_llm_config(data)
        return web.json_response({"success": True, "config": _mask_remote_config(get_remote_llm_config())})
    except Exception as e:
        logger.error(f"Error setting remote LLM config: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/llm_connection_test")
async def rs_prompts_llm_connection_test(request):
    """连接测试：用当前表单的 provider/密钥/端点/模型发送「你好」，成功返回回复摘要"""
    try:
        data = await request.json() or {}
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: test_remote_connection(
                provider=data.get("provider", ""),
                api_key=data.get("api_key", ""),
                base_url=data.get("base_url", ""),
                model=data.get("model", ""),
            ),
        )
        return web.json_response(result)
    except Exception as e:
        logger.error(f"Error testing LLM connection: {e}")
        return web.Response(status=500, text=str(e))


@routes.get("/rs_prompts/llm_mode")
async def rs_prompts_get_llm_mode(request):
    """获取当前 LLM 模式"""
    try:
        return web.json_response({"mode": get_current_mode()})
    except Exception as e:
        logger.error(f"Error getting LLM mode: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/extract_title")
async def rs_prompts_extract_title(request):
    """提取标题：优先 LAYA 选段（33ms），不可用时回退规则 → LLM。"""
    try:
        data = await request.json()
        text = (data.get("text") or "").strip()
        if not text:
            return web.json_response({"error": "text content is empty"}, status=400)

        # 1. 尝试 LAYA：拆段 → choice 选最佳标题段
        if laya_router.is_available():
            segments = prompt_lines.split_title_candidates(text)
            if len(segments) >= 2:
                questions = {
                    "title": {
                        "type": "choice",
                        "instructions": "Which segment best represents the main subject and scene, suitable as a short title for this prompt?",
                        "criteria": {s[:40]: s[:60] for s in segments},
                    }
                }
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(None, lambda: laya_router.classify(text, questions))
                if result and "title" in result:
                    val = result["title"].get("value", "")
                    if val:
                        # LAYA 返回的是 criteria key（截断到 40 字），还原为完整段
                        best_seg = next((s for s in segments if s[:40] == val), val)
                        title = best_seg.strip()[:50]
                        if title:
                            logger.info(f"extract_title → LAYA: {title}")
                            return web.json_response({"status": "success", "title": title})

        # 2. LAYA 不可用/无结果：规则提取
        rule_title = prompt_lines._extract_title(text)
        if rule_title and rule_title != "(未命名)" and len(rule_title) >= 4:
            logger.info(f"extract_title → Rule: {rule_title}")
            return web.json_response({"status": "success", "title": rule_title})

        # 3. 规则也不够好：fallback LLM
        logger.info("extract_title → LLM fallback")
        return await handle_llm_api_request("extract_title", request)
    except Exception as e:
        logger.error(f"Error in extract_title: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def _fetch_json(session, url: str, headers: dict):
    """GET 一个 JSON 端点：返回 (payload, 错误串)；出错即让调用方换下一个候选"""
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None, f"HTTP {resp.status}"
            return await resp.json(), ""
    except asyncio.TimeoutError:
        return None, "Timeout"
    except Exception as e:
        return None, str(e)


@routes.post("/rs_prompts/fetch_remote_models")
async def rs_prompts_fetch_remote_models(request):
    """Proxy request to fetch model list from LM Studio / Ollama / OpenAI-compatible APIs.

    本地 / 局域网端点依次尝试原生列表端点（LM Studio /api/v1/models 列全部已下载模型、
    Ollama /api/tags+ps 列已 pull 模型）与 OpenAI 兼容 /v1/models（Unsloth Studio 带 loaded 字段）；云端端点行为不变。
    """
    try:
        data = await request.json()
        base_url = (data.get("base_url", "") or "").strip().rstrip("/")
        api_key = (data.get("api_key", "") or "").strip()
        provider = (data.get("provider", "") or "").strip()

        if not base_url:
            return web.Response(status=400, text="base_url required")

        # 输入框留空沿用已存密钥：前端只回传掩码，明文仅存于服务端配置
        if not api_key and provider:
            api_key = get_stored_api_key(provider)

        # 部分 OpenAI 兼容云端点（如官方 API）拉取列表也需要鉴权
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        is_local = is_local_endpoint(base_url)
        endpoints = (local_list_endpoints(base_url, provider) if is_local
                     else [("openai", build_remote_models_url(base_url, provider))])

        models = []
        source = ""
        last_error = ""
        saw_http = False
        async with aiohttp.ClientSession() as session:
            for kind, url in endpoints:
                payload, err = await _fetch_json(session, url, headers)
                if payload is None:
                    last_error = err
                    # 本地服务的候选端点 404 属正常（不是每种服务都有全部端点）：服务有响应即视为可达
                    if is_local and err.startswith("HTTP "):
                        saw_http = True
                    continue
                running = None
                if kind == "ollama":
                    # /api/ps 给出正在运行的模型，用于标注「已加载 / 未加载」（不影响可选性）
                    running, _ = await _fetch_json(session, f"{url.rsplit('/api/', 1)[0]}/api/ps", headers)
                parsed = parse_service_models(kind, payload, running)
                if parsed:
                    models, source = parsed, kind
                    break

        if models:
            return web.json_response({"success": True, "models": models, "source": source})
        if last_error == "Timeout":
            return web.json_response({"success": False, "error": "Timeout"}, status=504)
        if last_error and not saw_http:
            return web.json_response({"success": False, "error": last_error}, status=502)
        # 服务可达但所有候选都没列出模型：返回空列表（前端显示「无可用模型」而非连接失败）
        return web.json_response({"success": True, "models": [], "source": ""})
    except Exception as e:
        logger.error(f"Error fetching remote models: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=502)


# ==========================================
# Module Exports
# ==========================================

__all__ = [
    "handle_llm_api_request",
    "handle_llm_api_stream",
    "run_llm_task",
    "run_llm_task_stream",
    "get_remote_llm_config",
    "set_remote_llm_config",
    "get_current_mode",
    "LLM_MODE_LOCAL",
    "LLM_MODE_REMOTE",
    "RemoteLLMClient",
    "get_available_models",
    "set_current_model",
    "scan_llm_directory",
]
