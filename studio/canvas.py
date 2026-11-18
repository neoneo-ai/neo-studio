# SPDX-License-Identifier: Apache-2.0
"""Neo Studio「画布」后端：画布数据落数据根 canvas/，本机服务只做文件读写。

画布是用户数据：随数据根走，插件目录里不留副本；内核与桌面端离线服务挂的是同一批 handler
（app/studio_caps.py 的 _CANVAS），页面在两种运行下写的是同一份文件。
一次保存写的是整份画布（节点 + 连线 + 视口 + 背景），读侧容忍缺字段与未知键 —— 页面与
exe 版本不同步时旧文件照样打得开，新字段来了旧页面也不会读崩。
删除只有 UI 上那一条单条路由：canvas/ 下全是用户铺的东西，没有整目录清的动作。
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from pathlib import Path

from aiohttp import web

from .plugin_paths import CANVAS_DIR

logger = logging.getLogger(__name__)

# 一张画布的量级上限：画布页 MVP 没有 LOD 与虚拟化，超出去是页面自己画不动了，
# 后端在写入这一层挡掉，不让一份写不完的 JSON 留在数据根里
MAX_NODES = 400
MAX_CONNECTIONS = 800
TITLE_MAX = 120
# 画布 id 直接拼进文件名：只认这一形状，路径穿越在入口就挡掉
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NODE_TYPES = ("image", "text")
BACKGROUND_MODES = ("dots", "lines", "blank")
DEFAULT_VIEWPORT = {"x": 0.0, "y": 0.0, "k": 1.0}
DEFAULT_BACKGROUND = "dots"

routes = web.RouteTableDef()
# 页面是「改一下就存一次」的写法，两次保存可能在同一轮网络请求里撞上来：
# 写入走 tmp + os.replace，画布文件与索引要在同一把锁里换完，否则索引里的 updated
# 会指着一份已经被后一轮覆盖掉的文件
_canvas_lock = threading.Lock()


def _project_path(project_id: str) -> Path | None:
    if not ID_RE.match(str(project_id or "")):
        return None
    return CANVAS_DIR / f"{project_id}.json"


def _index_path() -> Path:
    return CANVAS_DIR / "index.json"


def _read_json(path: Path):
    try:
        # utf-8-sig：手工保存与 PowerShell 重定向写出的文件带 BOM，严格 utf-8 读会把它变成
        # JSONDecodeError，画布就此打不开
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("[canvas] read failed %s: %s", path.name, exc)
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _num(value, default: float) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out else default    # NaN 进了文件，画布就永远回不来了


def _clean_node(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    nid = str(raw.get("id") or "").strip()
    if not nid:
        return None
    return {
        "id": nid[:64],
        "type": raw.get("type") if raw.get("type") in NODE_TYPES else "text",
        "title": str(raw.get("title") or "")[:TITLE_MAX],
        "position": {"x": _num((raw.get("position") or {}).get("x"), 0.0),
                     "y": _num((raw.get("position") or {}).get("y"), 0.0)},
        "width": max(1.0, _num(raw.get("width"), 340.0)),
        "height": max(1.0, _num(raw.get("height"), 240.0)),
        "metadata": raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {},
    }


def _clean_connection(raw, node_ids: set) -> dict | None:
    if not isinstance(raw, dict):
        return None
    src, dst = str(raw.get("fromNodeId") or ""), str(raw.get("toNodeId") or "")
    # 端点已经不在了的连线与自己连自己：画不出路径，留着页面每帧都要为它算一次空值
    if not src or not dst or src == dst or src not in node_ids or dst not in node_ids:
        return None
    return {"id": str(raw.get("id") or f"conn-{src}-{dst}")[:64], "fromNodeId": src, "toNodeId": dst}


def _clean_project(payload: dict) -> dict:
    """页面交来的整份画布归一化：缺字段回默认值，未知键整份忽略。"""
    nodes = []
    for item in (payload.get("nodes") or [])[:MAX_NODES]:
        node = _clean_node(item)
        if node:
            nodes.append(node)
    node_ids = {node["id"] for node in nodes}
    connections = []
    for item in (payload.get("connections") or [])[:MAX_CONNECTIONS]:
        conn = _clean_connection(item, node_ids)
        if conn:
            connections.append(conn)
    viewport = payload.get("viewport") if isinstance(payload.get("viewport"), dict) else {}
    return {
        "nodes": nodes,
        "connections": connections,
        "viewport": {"x": _num(viewport.get("x"), 0.0), "y": _num(viewport.get("y"), 0.0),
                     "k": max(0.05, min(5.0, _num(viewport.get("k"), 1.0)))},
        "background_mode": payload.get("background_mode")
                           if payload.get("background_mode") in BACKGROUND_MODES else DEFAULT_BACKGROUND,
    }



def _index_list():
    """索引条目 + 索引没记上的画布文件：index.json 是可删的缓存，删掉只从文件重建。"""
    entries = []
    known = set()
    raw = _read_json(_index_path())
    for item in (raw or {}).get("projects") or []:
        if not isinstance(item, dict):
            continue
        pid = str(item.get("id") or "")
        if not ID_RE.match(pid) or pid in known:
            continue
        known.add(pid)
        entries.append({"id": pid, "title": str(item.get("title") or "")[:TITLE_MAX],
                        "updated": _num(item.get("updated"), 0.0)})
    try:
        files = sorted(CANVAS_DIR.glob("*.json"))
    except OSError:
        files = []
    for path in files:
        pid = path.stem
        if pid == "index" or pid in known or not ID_RE.match(pid):
            continue
        data = _read_json(path)
        if not data:
            continue
        entries.append({"id": pid, "title": str(data.get("title") or pid)[:TITLE_MAX],
                        "updated": _num(data.get("updated"), 0.0)})
    entries.sort(key=lambda e: e["updated"], reverse=True)
    return entries


def _index_save(entries) -> None:
    _write_json(_index_path(), {"version": 1, "projects": entries})


def _index_touch(entries, project_id: str, title: str, updated: float):
    """索引里这一条换新：索引被删过的画布从这条回到列表上。"""
    out = [e for e in entries if e["id"] != project_id]
    out.append({"id": project_id, "title": title, "updated": updated})
    out.sort(key=lambda e: e["updated"], reverse=True)
    return out


@routes.get("/neo_canvas/list")
async def canvas_list(request):
    """画布列表：只报文件还在的那几条，文件没了的条目不往用户面前递。"""
    projects = [e for e in _index_list() if _project_path(e["id"]) and _project_path(e["id"]).exists()]
    return web.json_response({"success": True, "projects": projects})


@routes.get("/neo_canvas/project")
async def canvas_project(request):
    """读一张画布：缺视口与连线时回默认值，页面拿到的一定是写得动的形状。"""
    path = _project_path(request.rel_url.query.get("id", ""))
    if not path:
        return web.json_response({"success": False, "error": "id 不合法"}, status=400)
    data = _read_json(path)
    if not data:
        return web.json_response({"success": False, "error": "画布不存在或已损坏"}, status=404)
    project = _clean_project(data)
    project["id"] = path.stem
    project["title"] = str(data.get("title") or path.stem)[:TITLE_MAX]
    project["updated"] = _num(data.get("updated"), 0.0)
    return web.json_response({"success": True, "project": project})


@routes.post("/neo_canvas/project")
async def canvas_save(request):
    """保存一张画布：没有 id 就是新建，回来的 id 页面拿去接着改。"""
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return web.json_response({"success": False, "error": "请求体不是 JSON"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"success": False, "error": "请求体不是对象"}, status=400)
    project_id = str(payload.get("id") or "").strip()
    title = str(payload.get("title") or "").strip()[:TITLE_MAX]
    with _canvas_lock:
        if not project_id:
            project_id = f"canvas-{int(time.time() * 1000):x}"   # 新建：时间戳就是 id，同一毫秒两次保存不会撞
        path = _project_path(project_id)
        if not path:
            return web.json_response({"success": False, "error": "id 不合法"}, status=400)
        if not title and path.exists():
            title = str((_read_json(path) or {}).get("title") or "")[:TITLE_MAX]
        title = title or "未命名画布"
        updated = time.time()
        _write_json(path, {"id": project_id, "title": title, "updated": updated,
                           **_clean_project(payload)})
        _index_save(_index_touch(_index_list(), project_id, title, updated))
    return web.json_response({"success": True, "id": project_id, "title": title, "updated": updated})


@routes.post("/neo_canvas/rename")
async def canvas_rename(request):
    """重命名：画布文件里的标题与索引里那一条一起换，列表与文件才是同一个名字。"""
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return web.json_response({"success": False, "error": "请求体不是 JSON"}, status=400)
    path = _project_path(str((payload or {}).get("id") or ""))
    title = str((payload or {}).get("title") or "").strip()[:TITLE_MAX]
    if not path:
        return web.json_response({"success": False, "error": "id 不合法"}, status=400)
    if not title:
        return web.json_response({"success": False, "error": "名字不能为空"}, status=400)
    with _canvas_lock:
        data = _read_json(path)
        if not data:
            return web.json_response({"success": False, "error": "画布不存在"}, status=404)
        data["title"] = title
        data["updated"] = time.time()
        _write_json(path, data)
        _index_save(_index_touch(_index_list(), path.stem, title, data["updated"]))
    return web.json_response({"success": True, "id": path.stem, "title": title})


@routes.post("/neo_canvas/delete")
async def canvas_delete(request):
    """删一张画布：UI 上一次只删当前这一张，canvas/ 下别人的画布一张都不碰。"""
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return web.json_response({"success": False, "error": "请求体不是 JSON"}, status=400)
    path = _project_path(str((payload or {}).get("id") or ""))
    if not path:
        return web.json_response({"success": False, "error": "id 不合法"}, status=400)
    with _canvas_lock:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            return web.json_response({"success": False, "error": f"删除失败：{exc}"}, status=500)
        _index_save([e for e in _index_list() if e["id"] != path.stem])
    return web.json_response({"success": True, "id": path.stem})
