# SPDX-License-Identifier: Apache-2.0
# Neo Studio — C 站（Civitai）客户端。
#
# API KEY 与代理只有一份配置，落在 configs/gallery_settings.json（画廊 C 站同步 /
# C 站收藏 / 技能修复 LoRA 下载 / 模型库 C 站源共用）。请求口径、下载地址校验与
# 响应归一化集中在这里，各调用方只负责自己的响应形状。

from __future__ import annotations

import json
import re
import sys
import time
import socket
from urllib.parse import urlsplit

import aiohttp

if sys.platform == "win32":
    import winreg
else:
    winreg = None

from .util import _load_settings

API_HOST = "https://civitai.com"
API_BASE = f"{API_HOST}/api/v1"
USER_AGENT = "comfyui-neo-studio"

# 权重只走 C 站自己的签名端点；签名地址短时效，续传必须每次重新请求该端点
_DOWNLOAD_PATH_RE = re.compile(r"^/api/download/models/\d+$")
_ALLOWED_HOSTS = {"civitai.com", "www.civitai.com"}
_PROXY_SCHEMES = ("http", "https", "socks5")

# 列表过滤口径，与 C 站 types / baseModels / sort 取值一致（取值非法 C 站直接 400）
LORA_TYPES = ("LORA", "LoCon", "DoRA")
BASE_MODELS = ("SD 1.5", "SDXL 1.0", "Pony", "NoobAI", "Illustrious", "Flux.1 D", "Flux.1 S",
               "Flux.1 Krea", "SD 3.5 Large", "SD 3.5 Medium", "Krea 2", "Qwen", "SD 2.1",
               "PixArt a", "Hunyuan 1", "Wan Video 14B t2v")
SORTS = ("Most Downloaded", "Highest Rated", "Most Liked", "Most Discussed", "Most Collected",
         "Most Images", "Newest", "Oldest", "Recently Added")

# 底模枚举会随 C 站上新变化，实时取 /enums（24 小时缓存），失败沿用上一份
ENUMS_TTL = 86400.0
_enums = {"ts": 0.0, "base_models": list(BASE_MODELS)}


# ---------------------------------------------------------------------------
# 配置（唯一来源：gallery_settings.json）
# ---------------------------------------------------------------------------

def api_key() -> str:
    """画廊设置里的 Civitai API KEY；受限 / NSFW / 高热度内容下载需要。"""
    return str(_load_settings().get("civitai_api_key") or "").strip()


def clean_proxy(raw) -> str:
    """用户填写的代理地址：补默认 scheme，scheme 归小写，非法值按未配置处理。"""
    raw = str(raw or "").strip()
    if not raw:
        return ""
    scheme, sep, rest = raw.partition("://")
    if not sep:
        scheme, rest = "http", raw
    rest = rest.strip().rstrip("/")
    if scheme.lower() not in _PROXY_SCHEMES or not rest:
        return ""
    return f"{scheme.lower()}://{rest}"


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


# 系统代理读一次缓存一会儿：代理客户端可能比 ComfyUI 后开，探测结果别锁死
_sys_proxy = {"at": 0.0, "url": ""}
_SYS_PROXY_TTL = 60.0


def system_proxy() -> str:
    """Windows 系统代理（浏览器用的那一个）。

    aiohttp 只认 HTTP_PROXY 环境变量，不读注册表；代理客户端开「系统代理」模式时
    浏览器能上 C 站、直连被墙，插件必须自己把注册表里的代理取出来。
    代理端口没在监听就返回空，退回直连，避免代理客户端关掉后请求全挂。
    """
    now = time.monotonic()
    if now - _sys_proxy["at"] < _SYS_PROXY_TTL:
        return _sys_proxy["url"]
    _sys_proxy["at"] = now
    url = ""
    if winreg is not None:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") as key:
                enable = winreg.QueryValueEx(key, "ProxyEnable")[0]
                server = str(winreg.QueryValueEx(key, "ProxyServer")[0]).strip()
        except OSError:
            enable, server = 0, ""
        # 只认 host:port；PAC（AutoConfigURL）与分协议写法（proxy=..;https=..）不猜
        if enable and server and ";" not in server and "=" not in server:
            host, _, port = server.partition(":")
            if host and port.isdigit() and _port_open(host, int(port)):
                url = clean_proxy(f"http://{host}:{port}")
    _sys_proxy["url"] = url
    return url


def proxy() -> str:
    """C 站请求用的代理：设置里填了就用设置的，没填就用系统代理。"""
    return clean_proxy(_load_settings().get("civitai_proxy")) or system_proxy()


def proxy_kwargs() -> dict:
    """aiohttp 请求的 proxy= 参数；未配置代理时为空。"""
    value = proxy()
    return {"proxy": value} if value else {}


def system_proxy_kwargs() -> dict:
    """系统代理的 aiohttp 参数：模型库的 ModelScope / HF 请求走这一个，设置里的 C 站代理不掺进来。"""
    value = system_proxy()
    return {"proxy": value} if value else {}


def headers(key: str = None) -> dict:
    h = {"User-Agent": USER_AGENT}
    key = api_key() if key is None else str(key or "").strip()
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


# ---------------------------------------------------------------------------
# 请求参数与下载地址
# ---------------------------------------------------------------------------

def base_model_options() -> list:
    """底模下拉的取值：静态清单 + 已取到的 C 站实时枚举。"""
    return list(dict.fromkeys(list(_enums["base_models"]) + list(BASE_MODELS)))


async def fetch_enums(session) -> list:
    """GET /enums 刷新底模枚举；24 小时内只取一次，失败沿用上一份。"""
    if time.time() - _enums["ts"] < ENUMS_TTL:
        return base_model_options()
    status, body = await api_get(session, "/enums")
    active = [str(b) for b in ((body or {}).get("ActiveBaseModel") or [])] if status == 200 else []
    _enums["ts"] = time.time()
    if active:
        _enums["base_models"] = active
    return base_model_options()


def search_params(query="", types=None, base_models=None, nsfw=False,
                  sort="Most Downloaded", limit=24, cursor="") -> dict:
    """列表接口参数：types / baseModels 必须重复传（逗号串 C 站直接 400）。

    翻页只认 cursor（下一页取响应的 metadata.nextCursor）：page 参数 C 站已不认，
    带 query 时与 cursor 共存还直接 400。页码是前端/后端自己的记账，不进请求。
    """
    try:
        limit = min(100, max(1, int(limit)))
    except (TypeError, ValueError):
        limit = 24
    params = {"limit": str(limit), "nsfw": "True" if nsfw else "False"}
    text = str(query or "").strip()
    if text:
        params["query"] = text
    if cursor:
        params["cursor"] = str(cursor)
    params["sort"] = sort if sort in SORTS else SORTS[0]
    params["types"] = [t for t in (types or []) if t in LORA_TYPES] or ["LORA"]
    bases = [b for b in (base_models or []) if b in base_model_options()]
    if bases:
        params["baseModels"] = bases
    return params


def download_path(url) -> str:
    """C 站 downloadUrl → 校验过的 path+query；下载时只拼 C 站自己的主机。"""
    parts = urlsplit(str(url or ""))
    if parts.netloc.lower() not in _ALLOWED_HOSTS:
        return ""
    if not _DOWNLOAD_PATH_RE.match(parts.path):
        return ""
    return f"{parts.path}?{parts.query}" if parts.query else parts.path


# ---------------------------------------------------------------------------
# 归一化
# ---------------------------------------------------------------------------

def normalize_file(f: dict) -> dict:
    hashes = f.get("hashes") or {}
    return {
        "id": f.get("id"),
        "name": str(f.get("name") or ""),
        "format": str(f.get("format") or ""),
        "size": int(f.get("sizeKB") or 0) * 1024,
        "primary": bool(f.get("primary")),
        "download_path": download_path(f.get("downloadUrl")),
        "sha256": str(hashes.get("SHA256") or hashes.get("sha256") or ""),
    }


def model_files(version: dict) -> list:
    """版本内可下载权重：只认 type == Model，其余是 config / 预览。"""
    return [normalize_file(f) for f in (version.get("files") or [])
            if str(f.get("type") or "").lower() == "model"]


def pick_file(files: list) -> dict:
    """主文件优先，其次 .safetensors，再次首个可用权重。"""
    for f in files:
        if f.get("primary"):
            return f
    for f in files:
        if str(f.get("name") or "").lower().endswith(".safetensors"):
            return f
    return files[0] if files else {}


def normalize_version(v: dict) -> dict:
    return {
        "id": v.get("id"),
        "name": str(v.get("name") or ""),
        "base_model": str(v.get("baseModel") or ""),
        "trained_words": [str(w) for w in (v.get("trainedWords") or [])],
        "published_at": str(v.get("publishedAt") or ""),
        "downloads": int((v.get("stats") or {}).get("downloadCount") or 0),
        "files": [f for f in model_files(v) if f["download_path"]],
    }


def _preview_url(model: dict) -> str:
    for v in model.get("modelVersions") or []:
        for img in v.get("images") or []:
            url = str((img or {}).get("url") or "")
            if url:
                return url
    return str(((model.get("props") or {}).get("previewUrl")) or "")


def normalize_model(m: dict) -> dict:
    stats = m.get("stats") or {}
    return {
        "id": m.get("id"),
        "name": str(m.get("name") or ""),
        "type": str(m.get("type") or ""),
        "base_models": [str(b) for b in (m.get("baseModels") or [])],
        "nsfw": bool(m.get("nsfw")),
        "creator": str(((m.get("creator") or {}).get("username")) or m.get("userName") or ""),
        # 列表接口的 tags 是纯字符串数组，详情接口是 {name} 对象，两种都要吃
        "tags": [str((t.get("name") if isinstance(t, dict) else t) or "")
                 for t in (m.get("tags") or [])],
        "downloads": int(stats.get("downloadCount") or 0),
        "thumbs_up": int(stats.get("thumbsUpCount") or 0),
        "preview_url": _preview_url(m),
        "versions": [normalize_version(v) for v in (m.get("modelVersions") or [])],
    }


# ---------------------------------------------------------------------------
# 请求
# ---------------------------------------------------------------------------

async def api_get(session, path: str, params: dict = None, key: str = None,
                  timeout: int = 25) -> tuple:
    """GET C 站 API 路径，返回 (http_status, json|None)；0 表示连不上。

    非 200 也尽量回传响应体：C 站的参数校验说明要给用户看。
    """
    try:
        async with session.get(f"{API_BASE}{path}", params=params, headers=headers(key),
                               timeout=aiohttp.ClientTimeout(total=timeout),
                               **proxy_kwargs()) as resp:
            try:
                body = await resp.json(content_type=None)
            except Exception:
                body = None
            return resp.status, body
    except Exception:
        return 0, None


def error_detail(body) -> str:
    """C 站 4xx 响应体里的参数校验说明，压成一行可读的文本。"""
    if not isinstance(body, dict):
        return ""
    err = body.get("error")
    if isinstance(err, str):
        return err[:200]
    if not isinstance(err, dict):
        return ""
    try:
        items = json.loads(err.get("message") or "[]")
    except (TypeError, ValueError):
        return str(err.get("message") or "")[:200]
    parts = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        path = ".".join(str(p) for p in (it.get("path") or []))
        msg = str(it.get("message") or "")
        parts.append(f"{path} {msg}".strip())
    return "; ".join(p for p in parts if p)[:200]


def error_message(status: int, detail: str = "") -> str:
    """把 C 站常见状态码翻成可操作的中文提示，带上 C 站自己的说明。"""
    if status == 400:
        msg = "C 站拒绝了请求参数（400）"
    elif status == 401:
        msg = "C 站拒绝访问（401）：API KEY 无效，请在画廊设置的 C 站区更新"
    elif status == 403:
        msg = "C 站拒绝访问（403）：内容受限，需要有效 API KEY"
    elif status == 429:
        msg = "C 站请求过于频繁（429），请稍后重试"
    elif status == 0:
        msg = "无法连接 civitai.com：请在画廊设置的 C 站区配置代理（如 http://127.0.0.1:7890）"
    else:
        msg = f"Civitai HTTP {status}"
    return f"{msg}：{detail}" if detail else msg

