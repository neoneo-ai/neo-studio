# SPDX-License-Identifier: Apache-2.0
# Neo Studio — 模型库：Comfy-Org 专区（Hugging Face / ModelScope 双源）。
# 搜索 → 文件清单（按 split_files 前缀推断 ComfyUI 类别）→ aiohttp 流式下载，
# .part + HTTP Range 断点续传，单任务，进度轮询，取消保留断点。

from __future__ import annotations

import asyncio
import glob
import json
import re
import time
from pathlib import Path

import aiohttp
from aiohttp import web

routes = web.RouteTableDef()

from . import civitai
from .util import CONFIGS_DIR

ORG = "Comfy-Org"
MS_BASE = "https://modelscope.cn"
DEFAULT_HF_ENDPOINT = "https://huggingface.co"
# 国内网络默认解析不到 huggingface.co：报错要给出「换镜像端点」这条出路，光一行 gaierror 没人看得懂
HF_UNREACHABLE_HINT = "（HF 端点连不上：在模型库 ⚙ 把「HF 端点」改成镜像站根地址，如 https://hf-mirror.com）"
# ModelScope 是国内站点，连不通基本都是本机网络 / 代理的事，提示给的是「重试或换源」这条路
MS_UNREACHABLE_HINT = "（ModelScope 连不通：检查本机网络与代理后点 ⟳ 重试，或改用其他源）"
HUB_FILE = CONFIGS_DIR / "model_hub.json"
REGISTRY_FILE = CONFIGS_DIR / "model_registry.json"

SOURCES = ("modelscope", "huggingface", "civitai")
REPO_CACHE_TTL = 900.0
FILE_CACHE_TTL = 600.0
MS_PROBE_CONCURRENCY = 8
CHUNK_SIZE = 4 * 1024 * 1024
USER_AGENT = "comfyui-neo-studio"

DEFAULT_SETTINGS = {
    "source": "modelscope",
    "hf_endpoint": DEFAULT_HF_ENDPOINT,
    "hf_token": "",
    "ms_token": "",
    "llm_subdir": "LLM",
    "timeout_total": 3600,
    "sock_read": 180,
}

# split_files/<category>/... 是 Comfy-Org repackaged 仓库的落盘约定，直接映射 ComfyUI 类别
SPLIT_CATEGORY = {
    "checkpoints": "checkpoints",
    "diffusion_models": "diffusion_models",
    "transformer": "diffusion_models",
    "unet": "diffusion_models",
    "vae": "vae",
    "vae_encode": "vae",
    "vae_decode": "vae",
    "audio_vae": "audio_vae",
    "text_encoders": "text_encoders",
    "text_encoder": "text_encoders",
    "clip": "text_encoders",
    "clip_vision": "clip_vision",
    "loras": "loras",
    "lora": "loras",
    "controlnet": "controlnet",
    "model_patches": "model_patches",
    "upscale_models": "upscale_models",
    "latent_upscale_models": "upscale_models",
    "audio_encoders": "audio_encoders",
    "diffusion_model_patches": "model_patches",
}

# 仓库根目录散放文件（如 Real-ESRGAN_repackaged）按文件名关键词兜底，顺序即优先级
FILENAME_CATEGORY = (
    ("clip_vision", "clip_vision"),
    ("audio_vae", "audio_vae"),
    ("vae", "vae"),
    ("lora", "loras"),
    ("esrgan", "upscale_models"),
    ("upscale", "upscale_models"),
    ("upscaler", "upscale_models"),
    ("controlnet", "controlnet"),
    ("clip", "text_encoders"),
    ("text_encoder", "text_encoders"),
    ("t5", "text_encoders"),
    ("qwen", "text_encoders"),
    ("gemma", "text_encoders"),
    ("llama", "text_encoders"),
)

MODEL_EXTENSIONS = {".safetensors", ".bin", ".pth", ".pt", ".ckpt", ".gguf", ".onnx", ".npz"}
# LLM 专用类别：落 models/<llm_subdir>/<repo>/，供插件内置 llama-cpp 与外部 Studio 共用
LLM_CATEGORY = "llm"

_BAD_FILE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED = {"con", "prn", "aux", "nul"}


# ---------------------------------------------------------------------------
# 配置与注册表
# ---------------------------------------------------------------------------

def clean_endpoint(value) -> str:
    """镜像端点必须是 http(s) 绝对地址；非法值回落到官方端点。"""
    ep = str(value or "").strip().rstrip("/")
    if ep.startswith("https://") or ep.startswith("http://"):
        return ep
    return DEFAULT_HF_ENDPOINT


def load_hub_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    try:
        if HUB_FILE.exists():
            data = json.loads(HUB_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                settings.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})
    except Exception as e:
        print(f"[Neo Model Hub] 配置读取失败（{e}），使用默认值: {HUB_FILE}")
    settings["source"] = settings["source"] if settings["source"] in SOURCES else "modelscope"
    settings["hf_endpoint"] = clean_endpoint(settings["hf_endpoint"])
    settings["llm_subdir"] = sanitize_subfolder(settings["llm_subdir"]) or "LLM"
    for key in ("timeout_total", "sock_read"):
        try:
            settings[key] = max(10, int(settings[key]))
        except (TypeError, ValueError):
            settings[key] = DEFAULT_SETTINGS[key]
    return settings


def save_hub_settings(partial: dict) -> dict:
    settings = load_hub_settings()
    for key in DEFAULT_SETTINGS:
        if key in partial:
            settings[key] = partial[key]
    settings["source"] = settings["source"] if settings["source"] in SOURCES else "modelscope"
    settings["hf_endpoint"] = clean_endpoint(settings["hf_endpoint"])
    settings["llm_subdir"] = sanitize_subfolder(settings["llm_subdir"]) or "LLM"
    for key in ("timeout_total", "sock_read"):
        try:
            settings[key] = max(10, int(settings[key]))
        except (TypeError, ValueError):
            settings[key] = DEFAULT_SETTINGS[key]
    HUB_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = HUB_FILE.with_name(HUB_FILE.name + ".tmp")
    tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(HUB_FILE)
    return settings


def load_registry() -> dict:
    """策展注册表：分组 + 推荐组合，只存仓库名与说明，不存全量元数据。"""
    try:
        if REGISTRY_FILE.exists():
            reg = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
            if isinstance(reg, dict):
                return reg
    except Exception as e:
        print(f"[Neo Model Hub] 注册表读取失败（{e}）: {REGISTRY_FILE}")
    return {}


# ---------------------------------------------------------------------------
# 文件名 / 路径安全
# ---------------------------------------------------------------------------

def sanitize_filename(name) -> str:
    """仓库内文件名 → 安全 basename：去目录、去非法字符、拒绝 .. 与 Windows 保留名。"""
    raw = str(name or "").replace("\\", "/").split("/")[-1].strip()
    raw = _BAD_FILE_CHARS.sub("_", raw).strip(" .")
    if not raw or raw == ".." or raw.split(".")[0].lower() in _WINDOWS_RESERVED:
        return ""
    return raw[:180]


def sanitize_subfolder(sub) -> str:
    """用户填写的子目录：只允许相对路径片段，丢弃 .. 与非法字符。"""
    raw = str(sub or "").replace("\\", "/").strip("/")
    parts = [p for p in raw.split("/") if p and p not in (".", "..") and not _BAD_FILE_CHARS.search(p)]
    return "/".join(parts)[:180]


def split_files_category(path: str) -> str:
    parts = str(path or "").replace("\\", "/").split("/")
    if len(parts) >= 2 and parts[0] == "split_files":
        return SPLIT_CATEGORY.get(parts[1].lower(), "")
    return ""


def infer_category(path: str) -> str:
    """落盘类别：split_files 前缀优先，其次文件名关键词，.gguf 归 LLM，兜底 diffusion_models。"""
    norm = str(path or "").replace("\\", "/")
    mapped = split_files_category(norm)
    if mapped:
        return mapped
    name = norm.split("/")[-1].lower()
    if name.endswith(".gguf"):
        return LLM_CATEGORY
    for keyword, category in FILENAME_CATEGORY:
        if keyword in name:
            return category
    return "diffusion_models"


def is_model_file(path: str) -> bool:
    return Path(str(path or "").replace("\\", "/")).suffix.lower() in MODEL_EXTENSIONS


# ---------------------------------------------------------------------------
# 源 URL 构造
# ---------------------------------------------------------------------------

def hf_list_url(endpoint: str) -> str:
    return f"{clean_endpoint(endpoint)}/api/models"


def hf_model_url(endpoint: str, repo: str) -> str:
    return f"{clean_endpoint(endpoint)}/api/models/{repo}"


def hf_resolve_url(endpoint: str, repo: str, path: str) -> str:
    return f"{clean_endpoint(endpoint)}/models/{repo}/resolve/main/{path}"


def ms_model_url(repo: str) -> str:
    return f"{MS_BASE}/api/v1/models/{repo}"


def ms_files_url(repo: str, root: str = "") -> str:
    url = f"{MS_BASE}/api/v1/models/{repo}/repo/files?Revision=master"
    return f"{url}&Root={root}" if root else url


def ms_resolve_url(repo: str, path: str) -> str:
    return f"{MS_BASE}/models/{repo}/resolve/master/{path}"


def resolve_url(source: str, repo: str, path: str, settings: dict) -> str:
    if source == "modelscope":
        return ms_resolve_url(repo, path)
    if source == "civitai":
        return f"{civitai.API_HOST}{path}"
    return hf_resolve_url(settings["hf_endpoint"], repo, path)


def source_headers(source: str, settings: dict) -> dict:
    if source == "civitai":
        return civitai.headers()
    headers = {"User-Agent": USER_AGENT}
    token = str((settings.get("ms_token") if source == "modelscope" else settings.get("hf_token")) or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def other_source(source: str) -> str:
    return "huggingface" if source == "modelscope" else "modelscope"


def download_timeout(settings: dict) -> aiohttp.ClientTimeout:
    return aiohttp.ClientTimeout(total=settings["timeout_total"], sock_read=settings["sock_read"])


# ---------------------------------------------------------------------------
# 落盘目录
# ---------------------------------------------------------------------------

def registered_dirs(folder_paths, category: str) -> list:
    """类别的注册目录。folder_paths.get_folder_paths 对未知键抛 KeyError，
    这里容忍未注册键与大小写差异（llm / LLM）。"""
    known = getattr(folder_paths, "folder_names_and_paths", {})
    for key in (category, category.upper(), category.lower()):
        if key in known:
            return [Path(d) for d in folder_paths.get_folder_paths(key)]
    return []


def category_dirs(category: str, settings: dict) -> list:
    """类别的全部落盘目录：folder_paths 注册目录，含 extra_model_paths.yaml 指向的外部目录。"""
    import folder_paths
    dirs = registered_dirs(folder_paths, category)
    if category == LLM_CATEGORY:
        subdir = sanitize_subfolder(settings.get("llm_subdir")) or "LLM"
        out = [d.parent / subdir for d in dirs]
        fallback = Path(getattr(folder_paths, "base_path", "") or "") / "models" / subdir
        if fallback not in out:
            out.append(fallback)
        return [d for d in out if d.is_dir()] or out[:1]
    return dirs


def category_root(category: str, settings: dict) -> Path:
    """类别 → 落盘根目录：注册目录里类别同名者优先（unet / diffusion_models 同组时选对），
    其次第一个已存在的目录。"""
    dirs = category_dirs(category, settings)
    if not dirs:
        raise ValueError(f"未配置的模型类别目录: {category}")
    candidates = [d for d in dirs if d.name.lower() == category.lower()] or dirs
    for d in candidates:
        if d.is_dir():
            return d
    return candidates[0]


def resolve_target(category, subfolder, filename, settings, repo="") -> Path:
    """拼落盘路径并做包含性检查；llm 类别强制按仓库名建子目录。"""
    root = category_root(category, settings)
    sub = sanitize_subfolder(subfolder)
    if category == LLM_CATEGORY:
        repo_part = sanitize_filename(str(repo).split("/")[-1]) if repo else ""
        sub = "/".join(x for x in (repo_part, sub) if x)
    name = sanitize_filename(filename)
    if not name:
        raise ValueError(f"非法文件名: {filename}")
    dest = root / sub / name if sub else root / name
    resolved, root_resolved = dest.resolve(), root.resolve()
    if root_resolved not in resolved.parents:
        raise ValueError(f"落盘路径越出模型目录: {dest}")
    return dest


def strip_category_prefix(category: str, rel_path: str) -> str:
    """仓库相对路径里开头的类别段就是落盘根，不能当子目录用。

    Comfy-Org 这类仓库把整棵模型树镜像进仓库（diffusion_models/krea2_turbo.safetensors），
    连类别段一起当子目录就会落出自带名字的套目录 models/diffusion_models/diffusion_models/…；
    模型库按文件名在类别目录树里认文件，套目录里的文件它认得到，清单的就位检查按推荐名精确查却看不到，
    于是同一个文件一边算「已存在」、一边算「缺 13.49 GB」。
    """
    parts = [p for p in str(rel_path or "").replace("\\", "/").split("/") if p]
    name = str(category or "").strip().lower()
    while parts and parts[0].lower() == name:
        parts = parts[1:]
    return "/".join(parts)


def find_existing(category, filename, settings) -> str:
    """全部注册类别目录内是否已有同名文件（含子目录），返回相对该目录的路径或空串。"""
    try:
        roots = category_dirs(category, settings)
    except Exception:
        return ""
    name = sanitize_filename(filename)
    if not name:
        return ""
    for root in roots:
        if not root.is_dir():
            continue
        for candidate in root.rglob(glob.escape(name)):
            if candidate.is_file():
                return candidate.relative_to(root).as_posix()
    return ""


SUBFOLDER_MAX_DEPTH = 3
SUBFOLDER_MAX_ENTRIES = 200


def list_subfolders(category: str, settings: dict) -> list:
    """类别落盘目录下已存在的子目录（相对 posix 路径），供子目录下拉列表。"""
    try:
        root = category_root(category, settings)
    except Exception:
        return []
    if not root.is_dir():
        return []
    out = []
    stack = [("", root, 0)]
    while stack and len(out) < SUBFOLDER_MAX_ENTRIES:
        rel, base, depth = stack.pop()
        for child in sorted(base.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            sub = f"{rel}/{child.name}" if rel else child.name
            out.append(sub)
            if depth + 1 < SUBFOLDER_MAX_DEPTH:
                stack.append((sub, child, depth + 1))
    return sorted(out, key=lambda s: (s.count("/"), s))[:SUBFOLDER_MAX_ENTRIES]


def default_subfolder(category: str, settings: dict, repo: str = "", subfolders: list = None) -> str:
    """默认子目录自动探查：与仓库名对得上的已有目录（同名，或目录名是仓库名前缀）> 根目录。

    LLM 类别落盘已强制按仓库名建子目录，默认落 `models/<LLM 子目录>` 根。
    """
    subs = list_subfolders(category, settings) if subfolders is None else subfolders
    if category == LLM_CATEGORY:
        return ""
    repo_part = (sanitize_filename(str(repo).replace("\\", "/").split("/")[-1]) if repo else "").lower()
    if len(repo_part) < 4:
        return ""
    for sub in subs:
        name = sub.split("/")[-1].lower()
        if repo_part == name or (len(name) >= 4 and repo_part.startswith(name)):
            return sub
    return ""


# ---------------------------------------------------------------------------
# 仓库列表（双源并集）
# ---------------------------------------------------------------------------

class HubError(Exception):
    def __init__(self, message: str, status: int = 502, code: str = ""):
        super().__init__(message)
        self.status = status
        self.code = code


_repo_cache: dict = {}
_ms_exist_cache: dict = {}
_file_cache: dict = {}
MS_PROBE_TTL = 86400.0


def normalize_hf_repos(body) -> list:
    items = body if isinstance(body, list) else (body.get("models") or body.get("items") or [])
    out = []
    for it in items:
        repo = str((it or {}).get("id") or (it or {}).get("modelId") or "").strip()
        if not repo:
            continue
        out.append({"repo": repo, "downloads": int(it.get("downloads") or 0), "likes": int(it.get("likes") or 0)})
    return out


def normalize_ms_repos(body) -> list:
    data = (body or {}).get("Data") or {}
    inner = data.get("Model") if isinstance(data.get("Model"), dict) else data
    items = inner.get("Models") or inner.get("Model") or inner.get("Items") or (inner if isinstance(inner, list) else [])
    out = []
    for it in items:
        name = str((it or {}).get("Name") or "").strip()
        path = str(it.get("Path") or it.get("Namespace") or "").strip()
        repo = f"{path}/{name}" if path and name else str(it.get("RepoId") or "").strip()
        if not repo:
            continue
        out.append({"repo": repo, "downloads": int(it.get("Downloads") or it.get("Pv") or 0),
                    "likes": int(it.get("Stars") or 0)})
    return out


def registry_repos(registry: dict) -> list:
    """注册表里出现的仓库名（分组 + 推荐组合），用于补齐只存在于单源的仓库。"""
    repos = []
    for entry in (registry.get("groups") or []) + (registry.get("bundles") or []):
        for repo in entry.get("repos") or []:
            repo = str(repo).strip()
            if repo and repo not in repos:
                repos.append(repo)
    return repos


def merge_entries(entries: list) -> list:
    """仓库条目并集：可用性标记取或、计数取大，按下载量倒序再按仓库名。"""
    merged = {}
    for it in entries:
        entry = merged.setdefault(it["repo"], {"repo": it["repo"], "on_hf": False, "on_ms": False,
                                               "downloads": 0, "likes": 0})
        entry["on_hf"] = entry["on_hf"] or bool(it.get("on_hf"))
        entry["on_ms"] = entry["on_ms"] or bool(it.get("on_ms"))
        entry["downloads"] = max(entry["downloads"], int(it.get("downloads") or 0))
        entry["likes"] = max(entry["likes"], int(it.get("likes") or 0))
    return sorted(merged.values(), key=lambda e: (-e["downloads"], e["repo"]))


def merge_repo_lists(hf_items: list, ms_items: list, extra_repos: list = None) -> list:
    """双源列表并集；extra_repos 为注册表补充的仓库名（来源待探测）。"""
    entries = [dict(it, on_hf=True) for it in hf_items]
    entries += [dict(it, on_ms=True) for it in ms_items]
    entries += [{"repo": repo, "on_hf": False, "on_ms": False, "downloads": 0, "likes": 0}
                for repo in extra_repos or []]
    return merge_entries(entries)


async def _get_json(session, url, headers, params=None, timeout=40, json_payload=None,
                     owner: str = "") -> dict:
    try:
        async with session.request("PUT" if json_payload is not None else "GET", url,
                                   params=params, json=json_payload, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=timeout),
                                   # 代理客户端接管 DNS 的机器直连必失败（连 hf-mirror.com 都解析不到），
                                   # 而 aiohttp 只认 HTTP_PROXY 环境变量，注册表里的系统代理得自己取
                                   **civitai.system_proxy_kwargs()) as resp:
            if resp.status == 404:
                raise HubError("仓库在该源不存在", 404, "not_found")
            if resp.status == 401:
                raise HubError("该源需要有效 Token（受限仓库或未登录）", 401, "need_token")
            if resp.status != 200:
                raise HubError(f"HTTP {resp.status}", 502)
            return await resp.json(content_type=None)
    except aiohttp.ClientError as e:
        raise HubError(f"网络请求失败: {e}" + unreachable_hint(owner), 502)


def unreachable_hint(source: str) -> str:
    """源连不通时的出路：HF 换镜像端点，ModelScope 查本机网络 / 代理后重试。"""
    if source == "huggingface":
        return HF_UNREACHABLE_HINT
    if source == "modelscope":
        return MS_UNREACHABLE_HINT
    return ""


async def hf_org_repos(session, settings, refresh=False) -> list:
    cached = _repo_cache.get("huggingface")
    if cached and not refresh and time.time() - cached[0] < REPO_CACHE_TTL:
        return cached[1]
    body = await _get_json(session, hf_list_url(settings["hf_endpoint"]),
                           source_headers("huggingface", settings),
                           {"author": ORG, "limit": "1000", "full": "true"}, owner="huggingface")
    items = normalize_hf_repos(body)
    _repo_cache["huggingface"] = (time.time(), items)
    return items


def ms_query_payload(name: str = "", page_size: int = 50, criterion: list = None) -> dict:
    """dolphin/models 请求体：综合排序（SortBy=Default），Name 为名字过滤，站点同款口径。"""
    payload = {"PageSize": page_size, "PageNumber": 1, "SortBy": "Default", "Name": name,
               "IncludePrePublish": True}
    if criterion:
        payload["Criterion"] = criterion
    return payload


async def ms_org_repos(session, settings, refresh=False) -> list:
    """ModelScope 组织列表走站点同款 dolphin 接口，综合排序（与注册表顺序一致，匿名可用）。"""
    cached = _repo_cache.get("modelscope")
    if cached and not refresh and time.time() - cached[0] < REPO_CACHE_TTL:
        return cached[1]
    body = await _get_json(session, f"{MS_BASE}/api/v1/dolphin/models",
                           source_headers("modelscope", settings), timeout=25, owner="modelscope",
                           json_payload=ms_query_payload(page_size=200, criterion=[
                               {"category": "organizations", "predicate": "contains", "values": [ORG]}]))
    items = normalize_ms_repos(body)
    if items:
        _repo_cache["modelscope"] = (time.time(), items)
    return items


async def ms_repo_exists(session, settings, repo: str) -> bool:
    cached = _ms_exist_cache.get(repo)
    if cached and time.time() - cached[0] < MS_PROBE_TTL:
        return cached[1]
    try:
        await _get_json(session, ms_model_url(repo), source_headers("modelscope", settings),
                        timeout=25, owner="modelscope")
        found = True
    except HubError as e:
        if e.status != 404:
            # 连不通 / 要 Token 不是「这个仓库不存在」：写进缓存会把整表钉成「MS」一天，
            # 用户挑中的仓库一到文件清单那步必然失败
            return False
        found = False
    _ms_exist_cache[repo] = (time.time(), found)
    return found


async def list_repos(source: str, settings: dict, refresh=False) -> tuple:
    """Comfy-Org 仓库并集，返回 (仓库列表, 被跳过的源列表)。

    ModelScope 列表未收录的仓库并发探测存在性（缓存 1 天）。列表接口挂掉的源记进 skipped：
    国内网络默认解析不到 huggingface.co，而 ModelScope 整站连不通时列表只剩内置注册表——不把「哪个源
    没拿到数据」记下来，用户看到的就是空列表 / 一堆「未探测」加一句看不懂的 DNS 报错。
    """
    async with aiohttp.ClientSession() as session:
        skipped = []
        try:
            hf_items = await hf_org_repos(session, settings, refresh)
        except HubError:
            if source != "modelscope":
                raise
            hf_items = []
            skipped.append("huggingface")
        try:
            ms_items = await ms_org_repos(session, settings, refresh)
        except HubError:
            ms_items = []
            if source == "modelscope":
                skipped.append("modelscope")
        repos = merge_repo_lists(hf_items, ms_items, registry_repos(load_registry()))
        if source == "modelscope":
            sem = asyncio.Semaphore(MS_PROBE_CONCURRENCY)

            async def probe(entry):
                async with sem:
                    if not entry["on_ms"]:
                        entry["on_ms"] = await ms_repo_exists(session, settings, entry["repo"])

            await asyncio.gather(*(probe(e) for e in repos))
    return repos, skipped


def search_repos(repos: list, query: str) -> list:
    """仓库名子串过滤（大小写不敏感）；空查询返回全部。"""
    q = str(query or "").strip().lower()
    if not q:
        return repos
    return [r for r in repos if q in str(r["repo"]).lower()]


async def global_search_repos(session, source: str, query: str, settings: dict) -> list:
    """跨组织搜索（GGUF 等 LLM 仓库不在 Comfy-Org 下）；ModelScope 走 dolphin 接口，匿名可用。"""
    query = str(query or "").strip()
    if not query:
        return []
    if source == "modelscope":
        try:
            body = await _get_json(session, f"{MS_BASE}/api/v1/dolphin/models",
                                   source_headers(source, settings), timeout=25,
                                   json_payload=ms_query_payload(query))
        except HubError:
            return []
        return [dict(it, on_ms=True) for it in normalize_ms_repos(body)]
    body = await _get_json(session, hf_list_url(settings["hf_endpoint"]),
                           source_headers(source, settings), {"search": query, "limit": "50"},
                           owner="huggingface")
    return [dict(it, on_hf=True) for it in normalize_hf_repos(body)]


# ---------------------------------------------------------------------------
# 文件清单
# ---------------------------------------------------------------------------

def normalize_hf_files(body) -> list:
    out = []
    for s in (body or {}).get("siblings") or []:
        path = str((s or {}).get("rfilename") or "").replace("\\", "/")
        if not path:
            continue
        size = int(((s.get("lfs") or {}).get("size")) or s.get("size") or 0)
        out.append({"path": path, "size": size})
    return out


def normalize_ms_files(files, prefix: str = "") -> list:
    out = []
    for f in files or []:
        name = str((f or {}).get("Name") or "").strip()
        if not name:
            continue
        path = f"{prefix}/{name}" if prefix else name
        if str(f.get("Type") or "").lower() == "blob":
            out.append({"path": path, "size": int(f.get("Size") or 0)})
    return out


def enrich_files(files: list, settings: dict) -> list:
    """过滤非模型文件 + 附类别 / 文件名 / 已存在标记（含所在子目录）。"""
    out = []
    for f in files:
        path = f["path"]
        if not is_model_file(path):
            continue
        category = infer_category(path)
        filename = path.split("/")[-1]
        rel = find_existing(category, filename, settings)
        out.append({"path": path, "size": int(f.get("size") or 0), "category": category,
                    "filename": filename, "exists": bool(rel),
                    "exists_sub": rel.rsplit("/", 1)[0] if "/" in rel else ""})
    return sorted(out, key=lambda e: e["path"])


async def hf_repo_files(session, settings, repo: str, refresh=False) -> list:
    cached = _file_cache.get(("huggingface", repo))
    if cached and not refresh and time.time() - cached[0] < FILE_CACHE_TTL:
        return cached[1]
    body = await _get_json(session, hf_model_url(settings["hf_endpoint"], repo),
                           source_headers("huggingface", settings), {"blobs": "true"},
                           owner="huggingface")
    files = normalize_hf_files(body)
    _file_cache[("huggingface", repo)] = (time.time(), files)
    return files


async def ms_repo_files(session, settings, repo: str, refresh=False) -> list:
    """ModelScope 文件接口按目录分层，从根递归下探（请求上限 60）。"""
    cached = _file_cache.get(("modelscope", repo))
    if cached and not refresh and time.time() - cached[0] < FILE_CACHE_TTL:
        return cached[1]
    headers = source_headers("modelscope", settings)
    collected, dirs, requests = [], [""], 0
    while dirs and requests < 60:
        root = dirs.pop(0)
        body = await _get_json(session, ms_files_url(repo, root), headers, timeout=30,
                               owner="modelscope")
        requests += 1
        entries = ((body or {}).get("Data") or {}).get("Files") or []
        collected.extend(normalize_ms_files(entries, root))
        for e in entries:
            name = str((e or {}).get("Name") or "").strip()
            if str(e.get("Type") or "").lower() == "tree" and name:
                dirs.append(f"{root}/{name}" if root else name)
    _file_cache[("modelscope", repo)] = (time.time(), collected)
    return collected


async def repo_files(source: str, repo: str, settings: dict, refresh=False) -> list:
    async with aiohttp.ClientSession() as session:
        if source == "modelscope":
            files = await ms_repo_files(session, settings, repo, refresh)
        else:
            files = await hf_repo_files(session, settings, repo, refresh)
    return enrich_files(files, settings)


# ---------------------------------------------------------------------------
# 下载（单任务 + HTTP Range 断点续传）
# ---------------------------------------------------------------------------

_download: dict = None
_download_task = None


def part_paths(dest: Path) -> tuple:
    part = dest.parent / (dest.name + ".part")
    return part, Path(str(part) + ".meta.json")


def read_resume_meta(meta_path: Path) -> dict:
    try:
        if meta_path.exists():
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def resume_start(meta: dict, source: str, repo: str, path: str, part_size: int) -> tuple:
    """断点元数据校验：源 / 仓库 / 路径必须完全一致，返回 (续传起点, 原因)。"""
    if not meta:
        return 0, "no_meta"
    if meta.get("source") != source:
        return 0, "source_mismatch"
    if meta.get("repo") != repo or meta.get("path") != path:
        return 0, "repo_mismatch"
    total = int(meta.get("total") or 0)
    if total and part_size >= total:
        return 0, "complete"
    return int(part_size), "resume"


def write_resume_meta(meta_path: Path, state: dict) -> None:
    payload = {"source": state["source"], "repo": state["repo"], "path": state["path"],
               "total": state["total"], "etag": state.get("etag") or "", "done": state["done"]}
    meta_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def download_snapshot() -> dict:
    if not _download:
        return {"state": "idle"}
    return {k: v for k, v in _download.items() if k != "cancel"}


def cancel_download() -> bool:
    if _download and _download.get("state") == "running":
        _download["cancel"] = True
        return True
    return False


def validate_repo(repo: str) -> str:
    repo = str(repo or "").strip().strip("/")
    parts = repo.split("/")
    if len(parts) < 2 or any(not p or p == ".." for p in parts):
        raise HubError(f"非法仓库名: {repo}", 400)
    return "/".join(parts)


def validate_path(path: str) -> str:
    path = str(path or "").replace("\\", "/").strip("/")
    if not path or ".." in path.split("/"):
        raise HubError(f"非法仓库内路径: {path}", 400)
    return path


def validate_civitai_path(path: str) -> str:
    """C 站下载只允许签名端点 /api/download/models/<id>?…（挡 SSRF 与任意主机）。"""
    validated = civitai.download_path(f"{civitai.API_HOST}{str(path or '')}")
    if not validated:
        raise HubError(f"非法 C 站下载地址: {path}", 400)
    return validated


def validate_civitai_id(value) -> str:
    model_id = str(value if value is not None else "").strip()
    if not model_id.isdigit():
        raise HubError("非法 C 站模型 id", 400)
    return model_id


async def start_download(payload: dict, settings: dict) -> dict:
    global _download, _download_task
    if _download and _download.get("state") == "running":
        raise HubError("已有下载任务进行中，请先取消或等待完成", 409, "busy")
    source = str(payload.get("source") or settings["source"])
    if source not in SOURCES:
        raise HubError(f"未知下载源: {source}", 400)
    repo = validate_repo(payload.get("repo"))
    if source == "civitai":
        path = validate_civitai_path(payload.get("path"))
        filename = str(payload.get("filename") or "")
        category = str(payload.get("category") or "loras")
    else:
        path = validate_path(payload.get("path"))
        filename = str(payload.get("filename") or path.split("/")[-1])
        category = str(payload.get("category") or infer_category(path))
    dest = resolve_target(category, payload.get("subfolder"), filename, settings, repo)
    _download = {
        "source": source, "repo": repo, "path": path, "category": category,
        "filename": dest.name, "dest": str(dest), "dest_dir": str(dest.parent),
        "total": 0, "done": 0, "speed": 0.0, "state": "running", "error": "",
        "started": time.time(), "updated": time.time(), "cancel": False,
    }
    _download_task = asyncio.create_task(_run_download(_download, settings))
    return download_snapshot()


def _finish(state: dict, status: str, error: str = "") -> None:
    state["state"] = status
    state["error"] = error
    state["updated"] = time.time()


async def _run_download(state: dict, settings: dict) -> None:
    dest = Path(state["dest"])
    part, meta = part_paths(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        state["total"] = state["done"] = dest.stat().st_size
        _finish(state, "done")
        return
    part_size = part.stat().st_size if part.exists() else 0
    start, reason = resume_start(read_resume_meta(meta), state["source"], state["repo"],
                                 state["path"], part_size)
    if reason == "source_mismatch":
        _finish(state, "error", "断点文件来自另一个源，请删除 .part 后重新开始")
        return
    if reason == "repo_mismatch":
        _finish(state, "error", "断点文件与本次文件不一致，请删除 .part 后重新开始")
        return
    if reason == "complete":
        part.replace(dest)
        meta.unlink(missing_ok=True)
        state["total"] = state["done"] = part_size
        _finish(state, "done")
        return

    headers = source_headers(state["source"], settings)
    if start:
        headers["Range"] = f"bytes={start}-"
    url = resolve_url(state["source"], state["repo"], state["path"], settings)
    # C 站签名地址短时效：续传每次重新请求签名端点；代理按源取，C 站用设置里填的，HF / ModelScope 用系统代理
    proxy_kwargs = (civitai.proxy_kwargs() if state["source"] == "civitai"
                    else civitai.system_proxy_kwargs())
    state["done"] = start
    tick, tick_bytes = time.time(), 0
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=download_timeout(settings),
                                   **proxy_kwargs) as resp:
                if resp.status == 401:
                    raise HubError(civitai.error_message(401) if state["source"] == "civitai"
                                   else "该源需要有效 Token（受限仓库）", 401, "need_token")
                if resp.status == 403:
                    raise HubError("该源拒绝访问（需登录 / 协议限制）", 403)
                if resp.status == 404:
                    raise HubError("文件在该源不存在", 404, "not_found")
                if resp.status == 416:
                    raise HubError("断点位置超出文件大小，请删除 .part 后重新开始", 416)
                if resp.status not in (200, 206):
                    raise HubError(f"HTTP {resp.status}", 502)
                resumed = resp.status == 206
                content_range = resp.headers.get("Content-Range") or ""
                total = int(content_range.rsplit("/", 1)[-1]) if "/" in content_range else 0
                if not total:
                    total = int(resp.headers.get("Content-Length") or 0) + (start if resumed else 0)
                state["total"] = total
                state["etag"] = (resp.headers.get("ETag") or "").strip('"')
                if not resumed:
                    state["done"] = 0
                write_resume_meta(meta, state)
                with open(part, "ab" if resumed else "wb") as f:
                    async for chunk in resp.content.iter_chunked(CHUNK_SIZE):
                        if state["cancel"]:
                            f.flush()
                            write_resume_meta(meta, state)
                            _finish(state, "paused", "已取消（断点保留，可续传）")
                            return
                        f.write(chunk)
                        state["done"] += len(chunk)
                        state["updated"] = time.time()
                        tick_bytes += len(chunk)
                        elapsed = state["updated"] - tick
                        if elapsed >= 0.5:
                            state["speed"] = tick_bytes / elapsed
                            tick, tick_bytes = state["updated"], 0
                if total and state["done"] != total:
                    raise HubError(f"下载不完整（{state['done']}/{total}）", 502)
                part.replace(dest)
                meta.unlink(missing_ok=True)
                state["speed"] = 0.0
                _finish(state, "done")
    except HubError as e:
        _finish(state, "error", str(e))
    except (aiohttp.ClientError, asyncio.IncompleteReadError, OSError) as e:
        _finish(state, "error", f"下载中断: {e}" + unreachable_hint(state["source"]))
    except asyncio.CancelledError:
        _finish(state, "paused", "已取消（断点保留，可续传）")


# ---------------------------------------------------------------------------
# 路由 /neo_model_hub/*
# ---------------------------------------------------------------------------

UI_CATEGORIES = ("diffusion_models", "checkpoints", "vae", "text_encoders", "clip_vision",
                 "loras", "controlnet", "model_patches", "upscale_models", "audio_vae",
                 "audio_encoders")


def ui_categories(settings: dict) -> list:
    """UI 落盘类别：folder_paths 已注册类别 + LLM。"""
    import folder_paths
    cats = [c for c in UI_CATEGORIES if c in folder_paths.folder_names_and_paths]
    return cats + [LLM_CATEGORY]


def _error(e: Exception, source: str = "") -> "web.json_response":
    if isinstance(e, HubError):
        payload = {"success": False, "error": str(e)}
        if e.code:
            payload["code"] = e.code
        if e.status == 404 and source in ("modelscope", "huggingface"):
            payload["code"] = "not_on_source"
            payload["other_source"] = other_source(source)
        return web.json_response(payload, status=e.status)
    return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.get("/neo_model_hub/settings")
async def rs_hub_settings(request):
    settings = load_hub_settings()
    return web.json_response({
        "success": True,
        "settings": settings,
        "registry": load_registry(),
        "categories": ui_categories(settings),
        "sources": list(SOURCES),
        "civitai": {"api_key_set": bool(civitai.api_key()), "proxy": civitai.proxy()},
    })


@routes.post("/neo_model_hub/settings")
async def rs_hub_save_settings(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    settings = save_hub_settings(data if isinstance(data, dict) else {})
    return web.json_response({"success": True, "settings": settings})


@routes.post("/neo_model_hub/repos")
async def rs_hub_repos(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    body = data if isinstance(data, dict) else {}
    source = str(body.get("source") or load_hub_settings()["source"])
    if source not in SOURCES:
        return web.json_response({"success": False, "error": f"未知源: {source}"}, status=400)
    settings = load_hub_settings()
    query = str(body.get("query") or "").strip()
    try:
        repos, skipped = await list_repos(source, settings, bool(body.get("refresh")))
        if query:
            # 跨组织搜索：GGUF 等 LLM 仓库不在 Comfy-Org 下，需要全局结果补进列表
            async with aiohttp.ClientSession() as session:
                extra = await global_search_repos(session, source, query, settings)
            repos = merge_entries(search_repos(repos, query) + extra)
    except Exception as e:
        return _error(e, source)
    return web.json_response({"success": True, "source": source, "repos": repos, "skipped": skipped})


@routes.post("/neo_model_hub/files")
async def rs_hub_files(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    body = data if isinstance(data, dict) else {}
    settings = load_hub_settings()
    source = str(body.get("source") or settings["source"])
    if source not in SOURCES:
        return web.json_response({"success": False, "error": f"未知源: {source}"}, status=400)
    repo = str(body.get("repo") or "").strip()
    if not repo:
        return web.json_response({"success": False, "error": "缺少仓库名"}, status=400)
    try:
        files = await repo_files(source, validate_repo(repo), settings, bool(body.get("refresh")))
    except Exception as e:
        return _error(e, source)
    return web.json_response({"success": True, "source": source, "repo": repo, "files": files,
                              "categories": ui_categories(settings)})


@routes.post("/neo_model_hub/subfolders")
async def rs_hub_subfolders(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    body = data if isinstance(data, dict) else {}
    settings = load_hub_settings()
    category = str(body.get("category") or "").strip()
    if category not in ui_categories(settings):
        return web.json_response({"success": False, "error": f"未知落盘类别: {category}"}, status=400)
    subs = list_subfolders(category, settings)
    return web.json_response({"success": True, "category": category, "subfolders": subs,
                              "default": default_subfolder(category, settings,
                                                            str(body.get("repo") or ""), subs)})


@routes.post("/neo_model_hub/download")
async def rs_hub_download(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    body = data if isinstance(data, dict) else {}
    source = str(body.get("source") or load_hub_settings()["source"])
    try:
        snapshot = await start_download(body, load_hub_settings())
    except Exception as e:
        return _error(e, source)
    return web.json_response({"success": True, "download": snapshot})


@routes.get("/neo_model_hub/progress")
async def rs_hub_progress(request):
    return web.json_response({"success": True, "download": download_snapshot()})


@routes.post("/neo_model_hub/cancel")
async def rs_hub_cancel(request):
    return web.json_response({"success": cancel_download()})


# ---------------------------------------------------------------------------
# C 站（Civitai）源：LoRA 搜索 → 版本/文件清单 → 复用同一套断点续传下载
# API KEY 与代理读画廊设置（configs/gallery_settings.json），见 civitai.py
# ---------------------------------------------------------------------------

CIVITAI_PAGE_SIZE = 24
CIVITAI_CATEGORY = "loras"


async def civitai_search(payload: dict) -> tuple:
    """C 站 LoRA 搜索：返回 (模型列表, 页码, 下一页游标, 底模取值)。"""
    async with aiohttp.ClientSession() as session:
        base_models = await civitai.fetch_enums(session)
        params = civitai.search_params(
            query=str(payload.get("query") or "").strip(),
            types=payload.get("types"),
            base_models=payload.get("base_models"),
            nsfw=bool(payload.get("nsfw")),
            sort=str(payload.get("sort") or civitai.SORTS[0]),
            limit=CIVITAI_PAGE_SIZE,
            cursor=str(payload.get("cursor") or ""),
        )
        status, body = await civitai.api_get(session, "/models", params)
    if status != 200:
        raise HubError(civitai.error_message(status, civitai.error_detail(body)), 502)
    items = [civitai.normalize_model(m) for m in (body.get("items") or [])]
    next_cursor = str(((body.get("metadata") or {}).get("nextCursor")) or "")
    # C 站只按 cursor 翻页，页码是前端翻页记账，按请求回显
    try:
        page = max(1, int(payload.get("page") or 1))
    except (TypeError, ValueError):
        page = 1
    return items, page, next_cursor, base_models


async def civitai_files(model_id: str, settings: dict) -> list:
    """模型详情 → 可下载权重清单（版本 / 触发词 / 已存在标记），落盘固定 loras。"""
    async with aiohttp.ClientSession() as session:
        status, body = await civitai.api_get(session, f"/models/{model_id}")
    if status != 200:
        raise HubError(civitai.error_message(status, civitai.error_detail(body)),
                       404 if status == 404 else 502)
    files = []
    for v in (body.get("modelVersions") or []):
        version_name = str(v.get("name") or "")
        base_model = str(v.get("baseModel") or "")
        words = [str(w) for w in (v.get("trainedWords") or [])]
        for f in civitai.model_files(v):
            filename = sanitize_filename(f["name"])
            if not f["download_path"] or not filename:
                continue
            rel = find_existing(CIVITAI_CATEGORY, filename, settings)
            files.append({"path": f["download_path"], "size": f["size"],
                          "category": CIVITAI_CATEGORY, "filename": filename,
                          "exists": bool(rel),
                          "exists_sub": rel.rsplit("/", 1)[0] if "/" in rel else "",
                          "version_id": v.get("id"), "version_name": version_name,
                          "base_model": base_model, "trained_words": words,
                          "format": f["format"], "primary": f["primary"]})
    return files


@routes.post("/neo_model_hub/civitai/search")
async def rs_hub_civitai_search(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    body = data if isinstance(data, dict) else {}
    try:
        items, page, next_cursor, base_models = await civitai_search(body)
    except Exception as e:
        return _error(e, "civitai")
    return web.json_response({"success": True, "source": "civitai", "items": items,
                              "page": page, "page_size": CIVITAI_PAGE_SIZE,
                              "next_cursor": next_cursor,
                              "types": list(civitai.LORA_TYPES),
                              "base_models": base_models,
                              "sorts": list(civitai.SORTS)})


@routes.post("/neo_model_hub/civitai/files")
async def rs_hub_civitai_files(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    body = data if isinstance(data, dict) else {}
    try:
        model_id = validate_civitai_id(body.get("model_id"))
        files = await civitai_files(model_id, load_hub_settings())
    except Exception as e:
        return _error(e, "civitai")
    return web.json_response({"success": True, "source": "civitai", "model_id": model_id,
                              "files": files, "categories": ui_categories(load_hub_settings())})



