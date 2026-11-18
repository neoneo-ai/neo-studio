# SPDX-License-Identifier: Apache-2.0
r"""Neo Studio「技能」的云端订阅源：读 OSS 上的一份技能清单，按清单把技能装进 skills/custom/。

配置只有一份：`configs/oss_presets.json` 的 `skill_index_url`，与素材库云端预设、云端姿势库同一份、
同一 bucket（`tools\gallery_deploy_oss.py` 生成读侧那行配置，技能索引在同 bucket 的 `neo/skills/`）。
清单是纯数据：`skills[]` 每行只有 id / name / version / zip / sha256 / description，没有可执行代码；
下载下来的 zip 只走 `skill.py` 那条既有的技能包安装口（`_upload_from_zip`），装进 `skills/custom/`，
于是「预设只读、只有 USR 可删、中文名撞名 409」三条既有规则一字不动地全生效。

`skill_index_url` 缺失 = 未配置：技能页的「云端技能」入口整条不出现（`enabled` 关掉整片云端时一并关）。
拉取只在两处发生：打开云端技能面板、点面板里的「刷新清单」。启动不拉，也没有定时器拉。
拉取失败回落到上次成功的缓存索引，面板写明原因与最近成功时间——断网时已装的那份照常用。

已装版本记在 `configs/skill_source_stamp.json`（技能 id → 安装时的清单行 + 装完的目录指纹）：
清单版本更高就是「可升级」；只有本地目录指纹与安装时记下的一致才覆盖安装，
用户自己改过的技能只报「本地已修改」，要用户在面板上点名才动它。
`gallery/skill_cache/` 与那份戳记都整棵可删可重建：删了就是重新拉清单，已装的技能不动。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path

import aiohttp
from aiohttp import web

from . import plugin_paths
from .skill import (SKILL_CUSTOM_DIR, _list_all_skill_files, _normalize_skill_id, _skills_lock,
                    _skill_dir, _skill_source, _upload_from_zip)
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

routes = web.RouteTableDef()

OSS_PRESETS_FILE = plugin_paths.CONFIGS_DIR / "oss_presets.json"
# 缓存根在素材自己的缓存那一族里（与 lora_cache / oss_cache 同级），删它等于「云端清单清空」
CACHE_DIR = plugin_paths.GALLERY_DIR / "skill_cache"
INDEX_CACHE_FILE = CACHE_DIR / "_index.json"
# 已装版本的戳记：可删的缓存，读侧一律不抛，读不出只退化成「本地已修改」
STAMP_FILE = plugin_paths.CONFIGS_DIR / "skill_source_stamp.json"

DEFAULT_TTL_HOURS = 24
MAX_INDEX_BYTES = 2 * 1024 * 1024
MAX_ZIP_BYTES = 16 * 1024 * 1024
FETCH_TIMEOUT = aiohttp.ClientTimeout(total=60, connect=10)
MAX_ROWS = 500

# 清单行的 zip 落点：相对索引基址的路径，绝对地址只认 http(s) 且不带登录信息
_SAFE_REL = re.compile(r"^[A-Za-z0-9._/-]+$")
_ABS_URL = re.compile(r"^https?://[^\s]+$")

CLOUD_HINT_NOT_CONFIGURED = (
    "云端技能源未配置：在 <数据根>/configs/oss_presets.json 里写 skill_index_url"
    "（预设索引同 bucket 的 neo/skills/index.json），上传跑 tools\\skills_deploy_oss.py。")


def presets_config() -> dict:
    """oss_presets.json 的那份配置：读不出（缺文件 / 坏 JSON）就当没配置，云端技能源整片不可用。"""
    try:
        payload = json.loads(OSS_PRESETS_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def source_urls(cfg: dict | None = None) -> dict:
    """云端技能索引与 zip 基址：skill_index_url 是唯一的源，没写就是未配置。

    不做 bucket 推导：技能索引前缀由发布者决定，猜一个 bucket 段只会把请求打到别人的目录上。
    """
    cfg = presets_config() if cfg is None else cfg
    url = str(cfg.get("skill_index_url") or "").strip()
    if not url or not cfg.get("enabled", True):
        return {"enabled": False, "index_url": "", "base_url": ""}
    return {"enabled": True, "index_url": url, "base_url": url.rsplit("/", 1)[0] + "/"}


def _ttl_hours(cfg: dict) -> float:
    try:
        hours = float(cfg.get("sync_interval_hours", DEFAULT_TTL_HOURS))
    except (TypeError, ValueError):
        return DEFAULT_TTL_HOURS
    return hours if hours > 0 else DEFAULT_TTL_HOURS



# ==========================================
# 清单索引：缓存 + 拉取（TTL 看缓存文件 mtime，不另立内存缓存）
# ==========================================

def read_cached_index() -> dict | None:
    """缓存的那份索引：读不出返回 None（第一次用、缓存被删、半份文件）。"""
    try:
        payload = json.loads(INDEX_CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def cached_index_age_hours() -> float | None:
    """缓存索引的年龄（小时）；没有缓存时是 None，调用处据此决定要不要拉取。"""
    try:
        return (time.time() - INDEX_CACHE_FILE.stat().st_mtime) / 3600
    except OSError:
        return None


async def _http_get(url: str) -> tuple:
    """一次公开 GET → (body, status)；网络层异常是 (None, 0)。

    云端清单与 zip 都是公开可读的对象，与素材库云端预设同一口径：签名、上传、后台轮询都不在这条路上。
    """
    try:
        async with aiohttp.ClientSession(timeout=FETCH_TIMEOUT) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    return None, resp.status
                return await resp.read(), 200
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        logger.warning("[Neo Studio] 云端技能清单请求失败 %s: %s", url, exc)
        return None, 0


def _write_atomic(path: Path, body: bytes) -> None:
    """缓存落盘先写 .tmp 再替换：窗口中途关掉不会留下半份索引卡在缓存里。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.write(body)
    tmp.replace(path)


async def load_index(force: bool = False) -> tuple:
    """云端清单 → (index, source, reason)，source 是 cloud / cache / none。

    TTL 看缓存文件的 mtime（配置里的 sync_interval_hours）：清单只有几十 KB，面板开一天和开一秒
    取它花的钱一样。拉取失败回落到旧缓存——断网时面板还在，只是不刷新，reason 讲清为什么拿不到新的。
    """
    cfg = presets_config()
    urls = source_urls(cfg)
    if not urls["enabled"]:
        return None, "none", "not_configured"
    age = cached_index_age_hours()
    if age is not None and not force and age < _ttl_hours(cfg):
        cached = read_cached_index()
        if cached is not None:
            return cached, "cache", "ok"
    body, status = await _http_get(urls["index_url"])
    cached = read_cached_index()
    if body is None:
        return (cached, "cache", "fetch_failed") if cached is not None else (None, "none", "fetch_failed")
    if len(body) > MAX_INDEX_BYTES:
        logger.warning("[Neo Studio] 云端技能清单超过 %dMB 上限", MAX_INDEX_BYTES // (1024 * 1024))
        return (cached, "cache", "bad_index") if cached is not None else (None, "none", "bad_index")
    try:
        index = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        logger.warning("[Neo Studio] 云端技能清单不是合法 JSON（HTTP %s）", status)
        return (cached, "cache", "bad_index") if cached is not None else (None, "none", "bad_index")
    if not isinstance(index, dict):
        return (cached, "cache", "bad_index") if cached is not None else (None, "none", "bad_index")
    await asyncio.to_thread(_write_atomic, INDEX_CACHE_FILE, body)
    return index, "cloud", "ok"


def index_rows(index: dict | None) -> list[dict]:
    """清单里的技能行：只留形状对得上的那几条，坏行跳过不发（一份坏行不该让整张清单读不出）。

    id 走技能目录名口径（`_normalize_skill_id` 清完非法字符必须与原值一字不差），
    zip 只收索引基址下的相对路径与不带登录信息的 http(s) 绝对地址。
    """
    base_url = source_urls()["base_url"]
    rows = []
    raw = (index or {}).get("skills")
    if not isinstance(raw, list):
        return rows
    for entry in raw[:MAX_ROWS]:
        if not isinstance(entry, dict):
            continue
        raw_id = str(entry.get("id") or "")
        sid = _normalize_skill_id(raw_id)
        zip_ref = str(entry.get("zip") or entry.get("zip_url") or "").strip().replace("\\", "/")
        sha = str(entry.get("sha256") or "").strip().lower()
        parts = zip_ref.split("/")
        if not sid or sid != raw_id or not zip_ref or len(sha) != 64:
            continue
        if _ABS_URL.match(zip_ref):
            url = zip_ref
        elif ".." in parts or not _SAFE_REL.match(zip_ref):
            continue
        else:
            url = base_url + zip_ref
        rows.append({
            "id": sid,
            "name": str(entry.get("name") or sid).strip() or sid,
            "version": str(entry.get("version") or "").strip(),
            "description": str(entry.get("description") or "").strip(),
            "updated_at": str(entry.get("updated_at") or "").strip(),
            "zip_url": url,
            "sha256": sha,
        })
    return rows


# ==========================================
# 已装状态：戳记 + 目录指纹
# ==========================================

def _stamps() -> dict:
    """已装清单：戳记被删、写坏、被旧版本写过都只退化成「本地已修改」，读侧一律不抛。"""
    try:
        cfg = json.loads(STAMP_FILE.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    skills = cfg.get("skills") if isinstance(cfg, dict) else None
    return dict(skills) if isinstance(skills, dict) else {}


def _write_stamps(stamps: dict) -> None:
    STAMP_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STAMP_FILE.with_name(STAMP_FILE.name + ".tmp")
    tmp.write_text(json.dumps({"version": 1, "skills": stamps}, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    tmp.replace(STAMP_FILE)


def dir_digest(skill_dir: str) -> str:
    """技能目录的指纹：受支持文件（.md/.txt）按相对路径排序后逐份读字节。

    安装时记一份、覆盖安装前比一份——用户改过一个 .md 就是「本地已修改」。只认字节，
    不认清单版本：发布者把某行的说明改了也会顶高版本，那份字节没动过就不该报本地已修改。
    """
    digester = hashlib.sha256()
    try:
        rels = sorted(_list_all_skill_files(skill_dir))
    except OSError:
        return ""
    for rel in rels:
        try:
            with open(os.path.join(skill_dir, rel), "rb") as fh:
                blob = fh.read()
        except OSError:
            return ""
        digester.update(rel.encode("utf-8"))
        digester.update(blob)
    return digester.hexdigest()


def skill_state(cloud: dict, stamps: dict) -> str:
    """一行清单在本地是什么状态：not_installed / installed / upgrade / local_modified / blocked_preset。"""
    sid = cloud["id"]
    d = _skill_dir(sid)
    if not d:
        return "not_installed"
    if _skill_source(d) != "custom":
        return "blocked_preset"   # 与内置技能同名：装了也读不到那一份，云端不发这一条
    stamp = stamps.get(sid) if isinstance(stamps.get(sid), dict) else None
    recorded = str((stamp or {}).get("dir_digest") or "")
    if not recorded or recorded != dir_digest(d):
        return "local_modified"   # 没有戳记 = 用户自己建的同名技能，不覆盖
    installed = str((stamp or {}).get("version") or "")
    return "upgrade" if cloud["version"] and installed != cloud["version"] else "installed"


def catalog(index: dict | None, source: str, reason: str) -> dict:
    """云端技能面板要的那一份：清单行 + 每行的本地状态 + 这一发的来源、原因与最近成功时间。"""
    cfg = presets_config()
    urls = source_urls(cfg)
    stamps = _stamps()
    rows = []
    for cloud in index_rows(index):
        stamp = stamps.get(cloud["id"]) if isinstance(stamps.get(cloud["id"]), dict) else None
        rows.append({
            "id": cloud["id"],
            "name": cloud["name"],
            "version": cloud["version"],
            "description": cloud["description"],
            "updated_at": cloud["updated_at"],
            "state": skill_state(cloud, stamps),
            "installed_version": str((stamp or {}).get("version") or ""),
        })
    return {
        "enabled": urls["enabled"],
        "index_url": urls["index_url"],
        "source": source,
        "reason": reason,
        "hint": "" if urls["enabled"] else CLOUD_HINT_NOT_CONFIGURED,
        "ttl_hours": _ttl_hours(cfg),
        "age_hours": cached_index_age_hours(),
        "updated_at": str((index or {}).get("updated_at") or "").strip(),
        "skills": rows,
    }


def resolve_zip_url(skill_id: str) -> dict:
    """按 id 在缓存的清单里取那一行的 zip 与指纹：清单没成功拉过、行没有、id 对不上都是失败。

    失败带一个 ASCII 码（index_missing / bad_id / not_in_index），面板据此分支，不读中文文案。
    """
    index = read_cached_index()
    if index is None:
        return {"success": False, "status": 409, "code": "index_missing",
                "message": "云端技能清单还没成功拉取过：先在面板上刷新清单"}
    sid = _normalize_skill_id(skill_id)
    if not sid:
        return {"success": False, "status": 400, "code": "bad_id", "message": "Skill id required"}
    for row in index_rows(index):
        if row["id"] == sid:
            return {"success": True, "row": row}
    return {"success": False, "status": 404, "code": "not_in_index", "message": f"云端清单里没有技能 {sid}"}


def install_row(row: dict, zip_bytes: bytes, allow_modified: bool) -> dict:
    """把清单里的一行装进 skills/custom/：指纹先验、内置同名先拒、本地改过要先确认，最后才动文件。

    每条拒绝都带 ASCII 码，面板据此决定要不要给「确认覆盖」那一步。
    """
    sid = row["id"]
    if hashlib.sha256(zip_bytes).hexdigest() != row["sha256"]:
        logger.warning("[Neo Studio] 云端技能 %s 下载内容指纹与清单不符", sid)
        return {"success": False, "status": 409, "code": "fingerprint_mismatch",
                "message": "下载的技能包与清单指纹不符：云端文件与清单不是同一份，未安装"}
    existing = _skill_dir(sid)
    if existing and _skill_source(existing) != "custom":
        return {"success": False, "status": 409, "code": "preset_conflict",
                "message": f"技能 {sid} 与内置技能同名：内置技能只读，云端这份不发这一条"}
    stamps = _stamps()
    if existing and skill_state(row, stamps) == "local_modified" and not allow_modified:
        return {"success": False, "status": 409, "code": "local_modified",
                "message": "本地技能已修改：要覆盖请点「确认覆盖」"}

    with _skills_lock:
        result = _upload_from_zip(zip_bytes, sid)
        if not result.get("success"):
            return {"success": False, "status": result.get("status", 500), "code": "upload_failed",
                    "message": result.get("message", "安装失败")}
        # 戳记记安装后的目录指纹：装完就是「与云端一致」，之后用户改一个字节才报本地已修改
        stamps[sid] = {"version": row["version"], "sha256": row["sha256"],
                       "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "dir_digest": dir_digest(os.path.join(SKILL_CUSTOM_DIR, sid))}
        try:
            _write_stamps(stamps)
        except OSError as exc:
            logger.warning("[Neo Studio] 写技能订阅戳记失败：%s", exc)
    return {"success": True, "id": sid, "version": row["version"], "code": "installed"}


# ==========================================
# API Routes（技能云端订阅源）
# ==========================================

@routes.get("/rs_prompts/skill_sources")
async def rs_prompts_skill_sources(request):
    """云端技能清单与每行的本地状态：?force=1 是面板上那枚「刷新清单」。"""
    force = (request.query.get("force") or "").strip().lower() in ("1", "true", "yes")
    index, source, reason = await load_index(force=force)
    return web.json_response(catalog(index, source, reason))


@routes.post("/rs_prompts/install_skill_source")
async def rs_prompts_install_skill_source(request):
    """按 id 安装/更新云端技能：下载 zip 验指纹，走既有的技能包安装口装进 skills/custom/。

    成功与失败都回 JSON 并带 code：面板要按 code 决定「本地已修改 → 确认覆盖」这一步，
    不拿中文文案去匹配。
    """
    def refuse(status: int, code: str, message: str) -> web.Response:
        return web.json_response({"success": False, "code": code, "message": message}, status=status)

    try:
        data = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return refuse(400, "bad_body", "Invalid JSON body")
    if not isinstance(data, dict):
        return refuse(400, "bad_body", "Request body must be a JSON object")
    found = resolve_zip_url(data.get("id", ""))
    if not found.get("success"):
        return refuse(found.get("status", 404), found.get("code", "not_in_index"),
                      found.get("message", "Skill not in index"))
    row = found["row"]
    body, status = await _http_get(row["zip_url"])
    if body is None:
        return refuse(409, "download_failed", f"下载技能包失败（HTTP {status}）：未安装")
    if not body:
        return refuse(409, "zip_empty", "技能包为空：未安装")
    if len(body) > MAX_ZIP_BYTES:
        return refuse(409, "zip_empty", "技能包超过 16MB 上限：未安装")
    result = install_row(row, body, bool(data.get("allow_modified")))
    if not result.get("success"):
        return refuse(result.get("status", 500), result.get("code", "upload_failed"),
                      result.get("message", "安装失败"))
    return web.json_response(result)


