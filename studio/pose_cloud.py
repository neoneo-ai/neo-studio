# SPDX-License-Identifier: Apache-2.0
r"""Neo Studio「3D 姿势」的云端姿势库与云端道具：读 OSS 上的一棵姿势树，缓存进数据根，页面只吃本机地址。

配置只有一份：`configs/oss_presets.json`（与素材库云端预设同一份，口径见 studio/AGENTS.md 的
「pose bridge … reuses `configs/oss_presets.json`」）。云端那棵树由 `tools\pose_deploy_oss.py`
上传，形状是 `index.json` + `poses/**.scene.json` + `preview/*.png` + `props/*.glb`，
前缀默认落在预设同一 bucket 的 `neo/pose/`。

页面侧不直连 OSS 取数据文件：场景 JSON 与道具 GLB 要走姿势页自己的本机地址
（`/pose-lib/...` 与 `/models/props/<file>.glb`），那两级伺服只看数据根与随包副本。
本模块把云端那批落进 `<数据根>/pose/oss_cache/`，道具那一级由 pose.py 的 props 支路当第三级吃进去。
预览图是唯一直连的：卡片封面就是一张 `<img>`，直连 OSS URL 不碰姿势页契约。

三条接口都在文件层（状态 / 索引 / 取文件），桌面端离线服务同样挂它们（app/studio_caps.py::_POSE）。
缓存整棵可删可重建：删掉 OSS 缓存不影响本机库与随包道具。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

import aiohttp
from aiohttp import web

from . import plugin_paths
from .pose import inside_dir
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

routes = web.RouteTableDef()

OSS_PRESETS_FILE = plugin_paths.CONFIGS_DIR / "oss_presets.json"
# 缓存根在姿势自己的数据根子树下：与 pose/dist、pose/lib 同级，删它等于「云端副本清空」
CACHE_DIR = plugin_paths.DATA_ROOT / "pose" / "oss_cache"
INDEX_CACHE_FILE = CACHE_DIR / "_index.json"
# 道具的缓存落点与页面要的地址同形（/models/props/<file>.glb），pose.py 的两级落点
# 因此把这一级当第三级吃进去：注册表格式、GLB 校验与页面契约一字不改
CLOUD_PROPS_DIR = CACHE_DIR / "models" / "props"
# 道具在两侧的落点：本机这一级叫 models/props（页面写死的地址），云端树里那一叫 props
CLOUD_PROPS_LOCAL = "models/props"
CLOUD_PROPS_KEY = "props"


# 预设索引是 https://<host>/neo/presets/index.json：去掉文件名与 presets 那一段再接
# pose/index.json 就是云端姿势索引 —— 不写 pose_index_url 也指得对，与上传脚本的默认前缀同口径
DEFAULT_POSE_DIR_NAME = "pose"

MAX_INDEX_BYTES = 4 * 1024 * 1024
MAX_SCENE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_GLB_BYTES = 48 * 1024 * 1024
GLB_MAGIC = b"glTF"
FILE_EXT = {".json", ".png", ".webp", ".glb"}
DEFAULT_TTL_HOURS = 24
FETCH_TIMEOUT = aiohttp.ClientTimeout(total=60, connect=10)

CLOUD_HINT_NOT_CONFIGURED = ("云端姿势库未配置：在 <数据根>/configs/oss_presets.json 里写 pose_index_url"
                             "（预设索引同 bucket 的 neo/pose/index.json），上传跑 tools\\pose_deploy_oss.py。")


def presets_config() -> dict:
    """oss_presets.json 的那份配置：读不出（缺文件 / 坏 JSON）就当没配置，云端整片不可用。"""
    try:
        payload = json.loads(OSS_PRESETS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def cloud_urls(cfg: dict | None = None) -> dict:
    """云端索引与文件基址：pose_index_url 写了就用它，没写就从预设索引的目录推。"""
    cfg = presets_config() if cfg is None else cfg
    url = str(cfg.get("pose_index_url") or "").strip()
    if not url:
        presets_index = str(cfg.get("index_url") or "").strip()
        if not presets_index:
            return {"enabled": False, "index_url": "", "base_url": ""}
        parent = presets_index.rsplit("/", 1)[0].rsplit("/", 1)[0]
        url = f"{parent}/{DEFAULT_POSE_DIR_NAME}/index.json"
    return {"enabled": bool(cfg.get("enabled", True)), "index_url": url,
            "base_url": url.rsplit("/", 1)[0] + "/"}


def _ttl_hours(cfg: dict) -> float:
    try:
        hours = float(cfg.get("sync_interval_hours", DEFAULT_TTL_HOURS))
    except (TypeError, ValueError):
        return DEFAULT_TTL_HOURS
    return hours if hours > 0 else DEFAULT_TTL_HOURS


def _scene_row(entry: dict) -> dict | None:
    """云端索引里的一条场景：字段名与 pose/lib/index.json 的条目同名，前端一套渲染吃两份库。"""
    if not isinstance(entry, dict):
        return None
    path = str(entry.get("path") or "")
    ident = str(entry.get("id") or "")
    if not ident or not path.lower().endswith(".json"):
        return None
    preview = entry.get("preview")
    return {
        "id": ident,
        "label": str(entry.get("label") or ident),
        "path": path,
        "kind": "scene",
        "people": int(entry.get("people") or 0),
        "props": int(entry.get("props") or 0),
        "categories": list(entry.get("categories") or []),
        "groups": list(entry.get("groups") or ["other"]),
        "tags": list(entry.get("tags") or []),
        "charKey": str(entry.get("charKey") or ""),
        "gender": str(entry.get("gender") or ""),
        "preview": preview if isinstance(preview, dict) else {},
        "updatedAt": str(entry.get("updatedAt") or ""),
        "size": int(entry.get("size") or 0),
        "license": str(entry.get("license") or ""),
        "origin": "cloud",
        "cloud": True,
    }


def _prop_row(entry: dict) -> dict | None:
    """云端道具行：file 保持裸文件名（道具注册表的口径），本机落点是 models/props/<file>，
    云端键是 props/<file> —— 页面那条 /models/props/<file>.glb 因此一字不改。
    registry 是道具注册表的那一行原样（scale 与 grab / handleR / standing 握点），伺服注册表时补给它。
    preview 也是注册表那一行的相对路径（preview/x.png）：面板的缩略图直连 OSS 的 props/preview/。"""
    if not isinstance(entry, dict):
        return None
    filename = str(entry.get("file") or "").strip()
    if not filename or "/" in filename or "\\" in filename:
        return None
    ident = str(entry.get("id") or filename.rsplit(".", 1)[0])
    registry = entry.get("registry") if isinstance(entry.get("registry"), dict) else {}
    preview = str(registry.get("preview") or "").replace("\\", "/")
    if preview.startswith("/") or ".." in preview:
        preview = ""      # 预览路径必须留在 props 目录里：跑出去的那一行不给面板出图
    return {
        "id": ident,
        "label": str(entry.get("label") or ident),
        "file": filename,
        "path": f"{CLOUD_PROPS_LOCAL}/{filename}",
        "preview": preview,
        "char": str(entry.get("char") or ""),
        "gender": str(entry.get("gender") or ""),
        "license": str(entry.get("license") or ""),
        "source": str(entry.get("source") or ""),
        "size": int(entry.get("size") or 0),
        "registry": registry,
        "cloud": True,
    }


def cloud_rows(index: dict | None) -> tuple:

    """索引 → (场景行, 道具行)：坏行整条丢掉，不给前端留一条点了只会失败的卡。"""
    scenes, props = [], []
    for entry in (index or {}).get("entries") or []:
        row = _scene_row(entry)
        if row is not None:
            scenes.append(row)
    for entry in (index or {}).get("props") or []:
        row = _prop_row(entry)
        if row is not None:
            props.append(row)
    return scenes, props


def allowed_paths(index: dict | None) -> set:
    """索引点名的云端文件：场景文件 + 预览图 + 道具 GLB（含道具预览图）。取文件接口只认这份集合。"""
    scenes, props = cloud_rows(index)
    paths = {row["path"] for row in scenes} | {row["path"] for row in props}
    for row in scenes:
        paths.update(str(p) for p in (row["preview"] or {}).values() if p)
    paths.update(f"{CLOUD_PROPS_LOCAL}/{row['preview']}" for row in props if row["preview"])
    return paths


def prop_registry_rows() -> list:
    """云端道具的注册表行，伺服 `/models/props/index.json` 时补进本机那几行（pose.py 调它）。

    只读缓存的索引，一次网络都不发：伺服注册表是姿势页的开局路径，那条路上不能等 OSS。
    行照云端索引里那份原样给，只把 hidden 改写成 true —— 姿势页自己的道具面板也吃这份注册表，
    那里没有「先把 GLB 取进缓存再加具」这一步，列出来就是一个只会加载失败的物体；宿主面板
    （pose.js）从 /neo_pose/cloud_index 列它们，加具时页面按这一行取 scale 与握点。
    """
    _, props = cloud_rows(read_cached_index())
    rows = []
    for row in props:
        registry = dict(row["registry"])
        registry["file"] = row["file"]          # 行的键与落点必须同名，注册表口径就是裸文件名
        registry.setdefault("label", row["label"])
        registry["hidden"] = True
        rows.append(registry)
    return rows


def read_cached_index() -> dict | None:
    """缓存的那份索引：读不出返回 None（第一次用、缓存被删、半份文件）。"""
    try:
        payload = json.loads(INDEX_CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def cached_index_age_hours():
    """缓存索引的年龄（小时）；没有缓存时是 None，调用处据此决定要不要拉取。"""
    try:
        return (time.time() - INDEX_CACHE_FILE.stat().st_mtime) / 3600
    except OSError:
        return None


async def _http_get(url: str) -> tuple:
    """一次公开 GET → (body, status)；网络层异常是 (None, 0)。

    云端预设是公开可读的对象，与素材库云端预设同一口径：签名、上传、后台轮询都不在这条路上。
    """
    try:
        async with aiohttp.ClientSession(timeout=FETCH_TIMEOUT) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    return None, resp.status
                return await resp.read(), 200
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        logger.warning("[Neo Pose] 云端请求失败 %s: %s", url, exc)
        return None, 0


def _validate_body(rel: str, body: bytes):
    """按扩展名验一份云端文件的形状：体积上限、GLB 魔数、JSON 可解析。

    道具 GLB 截断一半落进缓存，页面解 GLB 只会说「坏文件」，刷新还会拿同一份坏缓存；
    在这拦住，坏文件就不进缓存目录。
    """
    suffix = Path(rel).suffix.lower()
    if suffix not in FILE_EXT:
        return f"不支持的文件类型：{suffix or '无扩展名'}"
    limit = {".glb": MAX_GLB_BYTES, ".json": MAX_SCENE_BYTES}.get(suffix, MAX_IMAGE_BYTES)
    if not body:
        return "云端文件为空"
    if len(body) > limit:
        return f"云端文件超过 {limit // (1024 * 1024)}MB 上限"
    if suffix == ".glb" and body[:4] != GLB_MAGIC:
        return "文件头不是 glTF：只接受 .glb 二进制"
    if suffix == ".json":
        try:
            json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return "云端 JSON 解析失败"
    return None


def _write_atomic(path: Path, body: bytes) -> None:
    """缓存落盘先写 .tmp 再替换：窗口中途关掉不会留下半份 GLB 卡在缓存里。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.write(body)
    tmp.replace(path)


async def load_index(force: bool = False) -> tuple:
    """云端索引 → (index, source)，source 是 cloud / cache / none。

    TTL 看缓存文件的 mtime（配置里的 sync_interval_hours），不另立内存缓存：索引只有几十 KB，
    窗口开一天和开一秒取它花的钱一样。拉取失败回落到旧缓存 —— 断网时云端卡片还在，只是不刷新。
    """
    cfg = presets_config()
    urls = cloud_urls(cfg)
    if not urls["enabled"] or not urls["index_url"]:
        return None, "none"
    age = cached_index_age_hours()
    if age is not None and not force and age < _ttl_hours(cfg):
        cached = read_cached_index()
        if cached is not None:
            return cached, "cache"
    body, status = await _http_get(urls["index_url"])
    cached = read_cached_index()
    if body is None or len(body) > MAX_INDEX_BYTES:
        return (cached, "cache") if cached is not None else (None, "none")
    try:
        index = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        logger.warning("[Neo Pose] 云端索引不是合法 JSON（HTTP %s）", status)
        return (cached, "cache") if cached is not None else (None, "none")
    if not isinstance(index, dict):
        return (cached, "cache") if cached is not None else (None, "none")
    await asyncio.to_thread(_write_atomic, INDEX_CACHE_FILE, body)
    return index, "cloud"


@routes.get("/neo_pose/cloud_status")
async def pose_cloud_status(request):
    """云端可用性：不发网络请求 —— 配没配置、缓存新不新鲜、缓存占多少，一眼看出来。"""
    urls = cloud_urls()
    cached = read_cached_index()
    scenes, props = cloud_rows(cached)
    age = cached_index_age_hours()
    cache_bytes = 0
    if CACHE_DIR.is_dir():
        cache_bytes = sum(p.stat().st_size for p in CACHE_DIR.rglob("*") if p.is_file())
    return web.json_response({
        "success": True,
        "enabled": bool(urls["enabled"] and urls["index_url"]),
        "available": cached is not None,
        "index_url": urls["index_url"],
        "base_url": urls["base_url"],
        "cache_dir": str(CACHE_DIR),
        "scenes": len(scenes),
        "props": len(props),
        "cache_age_hours": round(age, 2) if age is not None else None,
        "cache_bytes": cache_bytes,
        "hint": "" if urls["enabled"] and urls["index_url"] else CLOUD_HINT_NOT_CONFIGURED,
    })


@routes.get("/neo_pose/cloud_index")
async def pose_cloud_index(request):
    """云端场景与道具清单：行字段与 pose/lib 的条目同名，前端一套渲染吃两份库。"""
    force = str(request.rel_url.query.get("refresh") or "") in ("1", "true")
    index, source = await load_index(force)
    urls = cloud_urls()
    configured = bool(urls["enabled"] and urls["index_url"])
    if index is None:
        return web.json_response({
            "success": False,
            "enabled": configured,
            "entries": [], "props": [],
            "error": "云端索引读不到：检查 pose_index_url 与网络" if configured else CLOUD_HINT_NOT_CONFIGURED,
        }, status=502 if configured else 400)
    scenes, props = cloud_rows(index)
    return web.json_response({
        "success": True,
        "kind": "neo-pose-cloud",
        "source": source,
        "generated_at": str(index.get("generatedAt") or index.get("generated_at") or ""),
        "base_url": urls["base_url"],
        "count": len(scenes),
        "groups": index.get("groups") if isinstance(index.get("groups"), list) else [],
        "entries": scenes,
        "props": props,
    })


@routes.get("/neo_pose/cloud_file")
async def pose_cloud_file(request):
    """云端的一份文件 → 本机伺服：缓存命中直接给，未命中下载后原子落盘再给。

    路径只认索引点名的那批（场景 JSON / 预览图 / 道具 GLB）：越界与没点名的都是 400 ——
    这条接口不许变成任意 URL 的代理。
    """
    rel = str(request.rel_url.query.get("path") or "")
    # 「相对路径」在这条接口上是字面意思：带前导斜杠的写法（/etc/passwd）先拒，不剥掉后当缓存内的一条
    if rel.startswith("/") or rel.startswith("\\"):
        return web.json_response({"success": False, "error": "path 只允许云端缓存内的相对路径"}, status=400)
    target = inside_dir(CACHE_DIR, rel)
    if target is None:
        return web.json_response({"success": False, "error": "path 只允许云端缓存内的相对路径"}, status=400)

    index, _ = await load_index()
    if index is None:
        return web.json_response({"success": False, "error": CLOUD_HINT_NOT_CONFIGURED}, status=400)
    norm = str(target.relative_to(CACHE_DIR)).replace("\\", "/")
    if norm not in allowed_paths(index):
        return web.json_response({"success": False, "error": f"云端索引里没有这一条：{norm}"}, status=400)
    urls = cloud_urls()
    if not target.is_file():
        # 道具两侧的落点不同名：本机是 models/props/<file>，云端树里那一份叫 props/<file>。
        # 预览图带着子目录（models/props/preview/x.png ↔ props/preview/x.png），换前缀要整段尾巴换，
        # 只取文件名的话预览图就永远 404。场景与场景预览本来就同名，不碰。
        key = (f"{CLOUD_PROPS_KEY}/{norm[len(CLOUD_PROPS_LOCAL) + 1:]}"
               if norm.startswith(f"{CLOUD_PROPS_LOCAL}/") else norm)
        body, status = await _http_get(urls["base_url"] + key)

        if body is None:
            return web.json_response({"success": False, "error": f"云端取文件失败（HTTP {status or '网络'}）"},
                                     status=404 if status == 404 else 502)
        bad = _validate_body(norm, body)
        if bad is not None:
            return web.json_response({"success": False, "error": bad}, status=502)
        await asyncio.to_thread(_write_atomic, target, body)
    from .pose import _file_response

    return _file_response(target)

