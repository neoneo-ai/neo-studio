# SPDX-License-Identifier: Apache-2.0
"""任务中心（task_center.py）离线单测：生成任务快照落 SQLite、重启后读到历史、进行中行排前并清旧。"""
import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

_NODE_DIR = str(Path(__file__).resolve().parent.parent)
_PKG = "neo_task_center_test_pkg"
if _PKG not in sys.modules:
    _pkg = types.ModuleType(_PKG)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG] = _pkg


def _load(name):
    mod_name = f"{_PKG}.{name}"
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(mod_name, Path(_NODE_DIR) / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    setattr(sys.modules[_PKG], name, mod)
    spec.loader.exec_module(mod)
    return mod


task_center = _load("task_center")


class _Req:
    def __init__(self, query=None):
        self.query = query or {}


class TaskCenterCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory(prefix="neo_task_center_")
        self.addCleanup(self.tmpdir.cleanup)
        self.db = Path(self.tmpdir.name) / "studio_tasks.sqlite"
        self._old_db = task_center.TASKS_DB
        task_center.TASKS_DB = self.db


class RecordSnapshotTests(TaskCenterCase):
    def test_image_snapshot_updates_same_row_and_keeps_result(self):
        task_center.record_snapshot("image", {
            "task_id": "img-1", "status": "queued", "prompt": "猫娘立绘",
            "created": 100, "updated": 100,
        })
        task_center.record_snapshot("image", {
            "task_id": "img-1", "status": "succeeded", "prompt": "猫娘立绘",
            "created": 100, "updated": 110, "progress": {"value": 2, "max": 2},
            "images": [{"filename": "neo_paint_1.png", "subfolder": "Neo/Paint",
                        "url": "/view?filename=neo_paint_1.png"}],
        })
        rows = task_center.list_tasks()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["task_id"], "img-1")
        self.assertEqual(row["kind"], "image")
        self.assertEqual(row["status"], "succeeded")
        self.assertEqual(row["label"], "猫娘立绘")
        self.assertEqual(row["page"], "paint")
        self.assertEqual(row["progress"], {"value": 2, "max": 2})
        self.assertEqual(row["result"], {
            "filename": "neo_paint_1.png", "subfolder": "Neo/Paint",
            "url": "/view?filename=neo_paint_1.png", "count": 1,
        })
        self.assertEqual(row["count"], 1)
        self.assertEqual(row["created"], 100.0)
        self.assertEqual(row["updated"], 110.0)

    def test_segment_label_uses_recipe_segment_and_page(self):
        task_center.record_snapshot("segment", {
            "task_id": "seg-1", "status": "queued", "recipe": "R1", "segment": 1,
            "created": 120, "updated": 120,
        }, page="director")
        row = task_center.list_tasks()[0]
        self.assertEqual(row["label"], "R1 第 2 段")
        self.assertEqual(row["page"], "director")

    def test_film_label_uses_recipe_name(self):
        task_center.record_snapshot("film", {
            "task_id": "film-1", "status": "queued", "recipe": "全片A",
            "created": 120, "updated": 120,
        }, page="director")
        row = task_center.list_tasks()[0]
        self.assertEqual(row["label"], "全片A")
        self.assertEqual(row["page"], "director")

    def test_video_result_uses_filename_and_subfolder_fields(self):
        task_center.record_snapshot("simple", {
            "task_id": "vid-1", "status": "succeeded", "prompt": "开场镜头",
            "created": 100, "updated": 110, "filename": "neo_video_1.mp4",
            "subfolder": "Neo/Video",
        }, page="video")
        row = task_center.list_tasks()[0]
        self.assertEqual(row["result"], {
            "filename": "neo_video_1.mp4", "subfolder": "Neo/Video", "url": "", "count": 1,
        })

class ListTasksTests(TaskCenterCase):
    def test_active_rows_sort_before_finished_rows(self):
        task_center.record_snapshot("image", {
            "task_id": "old-done", "status": "succeeded", "prompt": "旧完成",
            "created": 90, "updated": 95,
        })
        task_center.record_snapshot("simple", {
            "task_id": "new-running", "status": "running", "prompt": "跑着",
            "created": 100, "updated": 101,
        })
        task_center.record_snapshot("film", {
            "task_id": "new-queued", "status": "queued", "recipe": "排队",
            "created": 105, "updated": 105,
        })
        rows = task_center.list_tasks()
        self.assertEqual([r["task_id"] for r in rows], ["new-queued", "new-running", "old-done"])
        self.assertEqual([r["status"] for r in rows], ["queued", "running", "succeeded"])


class MarkStaleActiveTests(TaskCenterCase):
    def test_restart_marks_queued_and_running_as_failed(self):
        task_center.record_snapshot("image", {
            "task_id": "live", "status": "running", "prompt": "跑着",
            "created": 100, "updated": 100, "progress": {"value": 1, "max": 4},
        })
        task_center.record_snapshot("film", {
            "task_id": "stale", "status": "queued", "recipe": "排队",
            "created": 101, "updated": 101,
        })
        task_center.record_snapshot("simple", {
            "task_id": "done", "status": "succeeded", "prompt": "完成",
            "created": 102, "updated": 102,
        })
        self.assertEqual(task_center.mark_stale_active("服务重启，任务状态已中断"), 2)
        rows = {row["task_id"]: row for row in task_center.list_tasks()}
        self.assertEqual(rows["live"]["status"], "failed")
        self.assertEqual(rows["live"]["error"], "服务重启，任务状态已中断")
        self.assertIsNone(rows["live"]["progress"])
        self.assertEqual(rows["stale"]["status"], "failed")
        self.assertEqual(rows["done"]["status"], "succeeded")


class TasksRouteTests(TaskCenterCase):
    def test_tasks_route_returns_persisted_rows(self):
        task_center.record_snapshot("voice", {
            "task_id": "voice-1", "status": "succeeded", "prompt": "念白",
            "created": 100, "updated": 110,
            "audios": [{"filename": "voice_1.mp3", "subfolder": "Neo/Voice",
                        "url": "/view?filename=voice_1.mp3"}],
        }, page="gallery")
        resp = asyncio.run(task_center.tasks_route(_Req({"limit": "10", "kind": "voice"})))
        data = json.loads(resp.body)
        self.assertEqual(resp.status, 200)
        self.assertTrue(data["success"])
        self.assertEqual(len(data["rows"]), 1)
        self.assertEqual(data["rows"][0]["task_id"], "voice-1")
        self.assertEqual(data["rows"][0]["page"], "gallery")
        self.assertEqual(data["rows"][0]["result"]["filename"], "voice_1.mp3")

    def tearDown(self):
        task_center.TASKS_DB = self._old_db
