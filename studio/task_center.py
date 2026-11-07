# SPDX-License-Identifier: Apache-2.0
"""本地任务中心：把顶栏队列面板看到的生成任务落到数据根 SQLite，离线重启后仍有历史。"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import contextmanager

from aiohttp import web

from .plugin_paths import TASKS_DB

logger = logging.getLogger(__name__)

TASK_KINDS = ("image", "voice", "simple", "film", "segment", "assemble")
TASK_PAGES = {"image": "paint", "voice": "gallery", "simple": "video",
             "film": "director", "segment": "director", "assemble": "director"}
ACTIVE_STATUSES = ("queued", "running")
MAX_TASKS = 200
TASK_TTL = 7 * 24 * 3600.0
TASK_HISTORY_LIMIT = 48

_SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    prompt_id TEXT,
    status TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    page TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    progress_json TEXT,
    result_json TEXT,
    error TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 1,
    created REAL NOT NULL,
    updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_studio_tasks_created ON tasks(created DESC);
CREATE INDEX IF NOT EXISTS ix_studio_tasks_status ON tasks(status);
"""

routes = web.RouteTableDef()


@contextmanager
def _db():
    TASKS_DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(TASKS_DB), timeout=1.0)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    conn.commit()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

def _json(value) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except TypeError:
        return "{}"


def _loads(raw: str):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def _number(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _label(kind: str, snap: dict) -> str:
    recipe = str(snap.get("recipe") or "")
    if kind == "film":
        return recipe
    if kind == "segment":
        return f"{recipe} 第 {int(snap.get('segment') or 0) + 1} 段"
    if kind == "assemble":
        return f"{recipe} 拼接 {len(snap.get('use') or [])} 段"
    return str(snap.get("prompt") or "")[:40]


def _payload(snap: dict) -> dict:
    keys = ("prompt_id", "seed", "skill_id", "prompt", "model", "recipe", "segment",
            "use", "film", "width", "height", "length", "blend", "frames", "warnings")
    payload = {}
    for key in keys:
        value = snap.get(key)
        if value in (None, "", []):
            continue
        payload[key] = value
    return payload


def _result(kind: str, snap: dict) -> dict | None:
    if kind == "image":
        entries = snap.get("images") or []
    elif kind == "voice":
        entries = snap.get("audios") or []
    else:
        filename = snap.get("filename")
        entry = {"filename": filename, "subfolder": snap.get("subfolder", "")} if filename else None
        entries = [entry] if entry else []
    entry = entries[0] if entries else None
    filename = str(entry.get("filename") if isinstance(entry, dict) else entry or "")
    if not filename:
        return None
    subfolder = str(entry.get("subfolder", "") if isinstance(entry, dict) else "")
    url = str(entry.get("url", "") if isinstance(entry, dict) else "")
    return {"filename": filename, "subfolder": subfolder, "url": url, "count": len(entries)}


def _row_to_task(row) -> dict:
    result = _loads(row["result_json"])
    if result:
        result["count"] = int(row["count"])
    return {
        "task_id": row["task_id"],
        "kind": row["kind"],
        "status": row["status"],
        "label": row["label"],
        "page": row["page"],
        "progress": _loads(row["progress_json"]),
        "created": row["created"],
        "updated": row["updated"],
        "result": result,
        "count": int(row["count"]),
        "error": row["error"],
    }


def _prune(conn, now: float) -> None:
    conn.execute("DELETE FROM tasks WHERE status NOT IN (?, ?) AND updated < ?",
                 (*ACTIVE_STATUSES, now - TASK_TTL))
    total = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    if total <= MAX_TASKS:
        return
    conn.execute("""
        DELETE FROM tasks WHERE task_id IN (
            SELECT task_id FROM tasks
            WHERE status NOT IN (?, ?)
            ORDER BY updated ASC
            LIMIT ?
        )
    """, (*ACTIVE_STATUSES, total - MAX_TASKS))



def record_snapshot(kind: str, snap: dict, page: str = "") -> bool:
    """落一条任务快照；写库失败不能把生成请求本身带崩。"""
    task_id = str((snap or {}).get("task_id") or "")
    if not task_id or kind not in TASK_KINDS:
        return False
    snap = snap or {}
    created = _number(snap.get("created"), time.time())
    updated = _number(snap.get("updated"), created)
    result = _result(kind, snap)
    count = int((result or {}).get("count") or 0)
    row = (task_id, kind, snap.get("prompt_id"), str(snap.get("status") or "queued"),
           _label(kind, snap), page or TASK_PAGES.get(kind, ""),
           _json(_payload(snap)), _json(snap.get("progress")),
           _json(result) if result else None, str(snap.get("error") or ""),
           count, created, updated)
    try:
        with _db() as conn:
            conn.execute("""
                INSERT INTO tasks (task_id, kind, prompt_id, status, label, page,
                    payload_json, progress_json, result_json, error, count, created, updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(task_id) DO UPDATE SET
                    kind = excluded.kind,
                    prompt_id = excluded.prompt_id,
                    status = excluded.status,
                    label = excluded.label,
                    page = excluded.page,
                    payload_json = excluded.payload_json,
                    progress_json = excluded.progress_json,
                    result_json = excluded.result_json,
                    error = excluded.error,
                    count = excluded.count,
                    updated = excluded.updated
            """, row)
            _prune(conn, updated)
        return True
    except (OSError, sqlite3.Error, TypeError, ValueError) as e:
        logger.warning(f"task center ignored {kind}/{task_id[:8]}: {e}")
        return False


def list_tasks(limit: int = TASK_HISTORY_LIMIT, kind: str | None = None) -> list:
    """按提交时间倒序返回持久任务；进行中的行排在前，面板播种时先拿到还活着的。"""
    try:
        limit = max(1, min(int(limit), MAX_TASKS))
    except (TypeError, ValueError):
        limit = TASK_HISTORY_LIMIT
    wanted = str(kind or "")
    try:
        with _db() as conn:
            rows = conn.execute("""
                SELECT task_id, kind, status, label, page, progress_json, result_json,
                       error, count, created, updated
                FROM tasks
                WHERE (? = '' OR kind = ?)
                ORDER BY CASE WHEN status IN (?, ?) THEN 0 ELSE 1 END, created DESC
                LIMIT ?
            """, (wanted, wanted, *ACTIVE_STATUSES, limit)).fetchall()
        return [_row_to_task(row) for row in rows]
    except (OSError, sqlite3.Error, TypeError, ValueError) as e:
        logger.warning(f"task center list failed: {e}")
        return []


def mark_stale_active(reason: str) -> int:
    """重启接不回 ComfyUI 队列时，把上次留下的 queued/running 收进失败态。"""
    reason = str(reason or "服务重启，任务状态已中断")
    now = time.time()
    try:
        with _db() as conn:
            cur = conn.execute("UPDATE tasks SET status = 'failed', progress_json = NULL, "
                               "error = ?, updated = ? WHERE status IN (?, ?)",
                               (reason, now, *ACTIVE_STATUSES))
            return cur.rowcount
    except (OSError, sqlite3.Error) as e:
        logger.warning(f"task center stale cleanup failed: {e}")
        return 0


@routes.get("/neo_studio/tasks")
async def tasks_route(request):
    try:
        limit = int(request.query.get("limit") or TASK_HISTORY_LIMIT)
    except (TypeError, ValueError):
        limit = TASK_HISTORY_LIMIT
    rows = list_tasks(limit=limit, kind=request.query.get("kind"))
    return web.json_response({"success": True, "rows": rows})
