# SPDX-License-Identifier: Apache-2.0
"""Backyard 预处理与 OSS key 前缀（backyard.py）离线单测。

三处真实故障：配置里存的 gallery/presets/ 按插件根解析会扫到插件目录那份空 gallery，
写出空 index.json；前缀写成 /neo/presets 时 key 拼成 neo/presetsindex.json，云端
neo/presets/index.json 永远读不到；增量跑只扫一个新目录，合并基准取不到云端 index
就会把云端其余目录全冲掉。
"""
import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

_NODE_DIR = str(Path(__file__).resolve().parent.parent)

# backyard 用相对导入（.plugin_paths / .util），目录名带连字符不能 import，测试里造一个包壳
_PKG = "neo_backyard_test_pkg"
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


_load("util")
plugin_paths = _load("plugin_paths")
backyard = _load("backyard")


def _make_preset_dir(parent: Path, name: str) -> Path:
    """造一个预设目录：png + 同名 txt（素材库预设的落盘形态）。"""
    from PIL import Image
    d = parent / name
    d.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), (200, 40, 40)).save(d / "001_逆命剑胚.png")
    (d / "001_逆命剑胚.txt").write_text("画面风格：仙侠，逆光", encoding="utf-8")
    return d


def _write_index(path: Path, dirs: dict, base_url: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "base_url": base_url, "directories": dirs},
                               ensure_ascii=False), encoding="utf-8")


def _cloud_dir(name: str) -> dict:
    return {name: {"name": name, "items": [{"filename": "a.jpg", "type": "image"}]}}


def _write_oss_cfg(cfg: dict | None) -> Path:
    """钉住 configs/oss_presets.json：内置预设会被 conftest 补进临时数据根，不钉住就会拉到真云端 index。"""
    p = plugin_paths.CONFIGS_DIR / "oss_presets.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    if cfg is None:
        p.unlink(missing_ok=True)
    else:
        p.write_text(json.dumps(cfg), encoding="utf-8")
    return p


class KeyPrefix(unittest.TestCase):
    def test_prefix_gets_trailing_slash(self):
        # 前缀写成 /neo/presets 时 f"{prefix}{rel}" 拼出 neo/presetsindex.json
        self.assertEqual(backyard._key_prefix("/neo/presets"), "neo/presets/")
        self.assertEqual(backyard._key_prefix("neo/presets"), "neo/presets/")
        self.assertEqual(backyard._key_prefix("gallery/presets/"), "gallery/presets/")
        self.assertEqual(backyard._key_prefix(""), "")


class ResolveDir(unittest.TestCase):
    def test_relative_path_resolves_to_data_root(self):
        # 插件目录那份 gallery/presets 是空的，按插件根解析预处理扫不到任何素材
        self.assertEqual(backyard._resolve_dir("gallery/presets/"),
                         (plugin_paths.DATA_ROOT / "gallery/presets").resolve())
        # 绝对路径原样透传；用 Windows 盘符写法的话 Linux 上它是相对路径，断言会挂
        abs_path = plugin_paths.DATA_ROOT / "presets"
        self.assertEqual(backyard._resolve_dir(str(abs_path)), abs_path.resolve())


class SingleDirSource(unittest.TestCase):
    """源目录内直接放素材（data/gallery/presets/仙侠玄幻人物）时按增量处理。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="neo_backyard_pre_")
        self.root = Path(self._tmp.name)
        self.src = _make_preset_dir(self.root, "仙侠玄幻人物")
        self.out = self.root / "out"
        _write_oss_cfg({"enabled": False})
        _write_index(self.out / "index.json", _cloud_dir("26-06-25"), "https://cdn/neo/presets")

    def tearDown(self):
        _write_oss_cfg(None)
        self._tmp.cleanup()

    def test_source_dir_with_loose_media_scans_as_one_directory(self):
        backyard.run_preprocess(str(self.src), str(self.out), 64, True, None)
        index = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        self.assertIn("仙侠玄幻人物", index["directories"])
        self.assertIn("26-06-25", index["directories"])
        self.assertEqual(index["base_url"], "https://cdn/neo/presets")
        self.assertTrue((self.out / "仙侠玄幻人物" / "001_逆命剑胚.png").exists())
        self.assertTrue((self.out / "仙侠玄幻人物" / "001_逆命剑胚.txt").exists())
        self.assertTrue((self.out / "thumbnails" / "仙侠玄幻人物" / "001_逆命剑胚.jpg").exists())
        dir_index = json.loads((self.out / "仙侠玄幻人物" / "index.json").read_text(encoding="utf-8"))
        entry = dir_index["items"][0]
        self.assertEqual(entry["thumbnail"], "thumbnails/仙侠玄幻人物/001_逆命剑胚.jpg")
        self.assertEqual(entry["txt_content"], "画面风格：仙侠，逆光")


class CloudMergeBase(unittest.TestCase):
    """增量合并基准优先取 configs/oss_presets.json -> index_url（本地没跑过预处理时唯一基准）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="neo_backyard_pre_")
        self.root = Path(self._tmp.name)
        self.src = _make_preset_dir(self.root, "presets")
        _make_preset_dir(self.src, "仙侠玄幻人物")
        self.out = self.root / "out"
        self.out.mkdir()
        remote = self.root / "remote_index.json"
        _write_index(remote, _cloud_dir("26-06-25"))
        _write_oss_cfg({
            "enabled": True,
            "index_url": remote.as_uri(),
            "base_url": "https://mediai.oss-cn-hangzhou.aliyuncs.com/neo/presets",
        })

    def tearDown(self):
        _write_oss_cfg(None)
        self._tmp.cleanup()

    def test_incremental_dirs_merge_cloud_index(self):
        backyard.run_preprocess(str(self.src), str(self.out), 64, True, ["仙侠玄幻人物"])
        index = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        self.assertIn("仙侠玄幻人物", index["directories"])
        self.assertIn("26-06-25", index["directories"])
        self.assertEqual(index["base_url"], "https://mediai.oss-cn-hangzhou.aliyuncs.com/neo/presets")

    def test_cloud_index_unreachable_falls_back_to_local(self):
        _write_oss_cfg({"enabled": True, "index_url": "file:///nope/none.json"})
        _write_index(self.out / "index.json", _cloud_dir("本地基准目录"))
        backyard.run_preprocess(str(self.src), str(self.out), 64, True, ["仙侠玄幻人物"])
        index = json.loads((self.out / "index.json").read_text(encoding="utf-8"))
        self.assertIn("仙侠玄幻人物", index["directories"])
        self.assertIn("本地基准目录", index["directories"])


class FullScan(unittest.TestCase):
    def test_full_scan_rebuilds_index_from_scratch(self):
        tmp = tempfile.TemporaryDirectory(prefix="neo_backyard_pre_")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        src = root / "presets"
        _make_preset_dir(src, "a")
        _make_preset_dir(src, "b")
        out = root / "out"
        _write_index(out / "index.json", _cloud_dir("旧目录"))
        backyard.run_preprocess(str(src), str(out), 64, True, None)
        index = json.loads((out / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(set(index["directories"]), {"a", "b"})


class SplitIndexLayout(unittest.TestCase):
    """主索引只留目录元数据，items 落在 <dir>/index.json：整包索引不再随素材数量膨胀。"""

    def test_dir_items_land_in_their_own_index(self):
        tmp = tempfile.TemporaryDirectory(prefix="neo_backyard_pre_")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        src = root / "presets"
        _make_preset_dir(src, "仙侠玄幻人物")
        out = root / "out"
        backyard.run_preprocess(str(src), str(out), 64, True, None)
        master = json.loads((out / "index.json").read_text(encoding="utf-8"))
        entry = master["directories"]["仙侠玄幻人物"]
        self.assertEqual(master["version"], 2)
        self.assertNotIn("items", entry)
        self.assertEqual(entry["count"], 1)
        self.assertEqual(entry["index"], "仙侠玄幻人物/index.json")
        self.assertEqual(entry["covers"][0]["thumbnail"], "thumbnails/仙侠玄幻人物/001_逆命剑胚.jpg")
        dir_index = json.loads((out / "仙侠玄幻人物" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(dir_index["generated_at"], entry["rev"])
        self.assertEqual(dir_index["items"][0]["filename"], "001_逆命剑胚.png")


class UploadIndexRefresh(unittest.TestCase):
    """上传成功后强刷素材库的云端索引：_fetch_oss_index 默认按 sync_interval_hours（24h）
    缓存，不刷新的话刚传完的目录在素材页看不到，得等缓存过期或重启 ComfyUI。"""

    class _Req:
        def __init__(self, payload):
            self._payload = payload

        async def json(self):
            return self._payload

    class _Resp:
        def __init__(self):
            self.headers = {}

        async def prepare(self, request):
            return True

        async def write(self, data):
            pass

    def setUp(self):
        self._prev = (backyard.web, backyard.run_oss_upload,
                      backyard._sse_stream, backyard._fetch_cloud_index)
        self.refreshed = 0

        async def _stream(response, run_fn, done_event):
            run_fn()

        async def _fetch():
            self.refreshed += 1

        backyard.web = types.SimpleNamespace(StreamResponse=self._Resp,
                                             json_response=lambda d, **k: d)
        backyard._sse_stream = _stream
        backyard._fetch_cloud_index = _fetch

    def tearDown(self):
        (backyard.web, backyard.run_oss_upload,
         backyard._sse_stream, backyard._fetch_cloud_index) = self._prev

    def _upload(self, counts, dry_run):
        backyard.run_oss_upload = lambda *a, **k: counts
        asyncio.run(backyard.upload_route(
            self._Req({"source_dir": "gallery/presets_dist", "dry_run": dry_run})))

    def test_uploaded_refreshes_gallery_index(self):
        self._upload({"uploaded": 12, "skipped": 589, "failed": 0, "total": 601}, False)
        self.assertEqual(self.refreshed, 1)

    def test_dry_run_keeps_index_untouched(self):
        self._upload({"uploaded": 601, "skipped": 0, "failed": 0, "total": 601}, True)
        self.assertEqual(self.refreshed, 0)

    def test_all_skipped_keeps_index_untouched(self):
        # ETag 全同说明云端 index.json 已是最新，重取一次只是白跑一趟网络
        self._upload({"uploaded": 0, "skipped": 601, "failed": 0, "total": 601}, False)
        self.assertEqual(self.refreshed, 0)

    def test_failed_upload_keeps_index_untouched(self):
        def _boom(*a, **k):
            raise RuntimeError("oss2 未安装")

        backyard.run_oss_upload = _boom
        asyncio.run(backyard.upload_route(
            self._Req({"source_dir": "gallery/presets_dist", "dry_run": False})))
        self.assertEqual(self.refreshed, 0)


class UploadPlan(unittest.TestCase):
    """上传页的待上传清单：云端没有、rev 与云端不同、本地主索引还没这条（--draft）要分开列，
    用户点执行前得先看清要传哪些目录、多大体量。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="neo_backyard_plan_")
        self.addCleanup(self._tmp.cleanup)
        self.out = Path(self._tmp.name)
        names = ("仙侠玄幻人物", "古代乡村人物", "现代都市人物", "现代西方人物")
        for name in names:
            (self.out / name).mkdir()
            (self.out / name / "001.png").write_bytes(b"png")
            (self.out / name / "index.json").write_text(
                json.dumps({"version": 2, "name": name, "generated_at": "R",
                            "items": [{"filename": "001.png", "type": "image"}]}),
                encoding="utf-8")
            (self.out / "thumbnails" / name).mkdir(parents=True)
            (self.out / "thumbnails" / name / "001.jpg").write_bytes(b"jpg")
        # 现代西方人物只写了目录索引（--draft），主索引没这条
        (self.out / "index.json").write_text(json.dumps({
            "version": 2,
            "directories": {
                "仙侠玄幻人物": {"count": 1, "index": "仙侠玄幻人物/index.json", "rev": "R1", "covers": []},
                "古代乡村人物": {"count": 1, "index": "古代乡村人物/index.json", "rev": "R2", "covers": []},
                "现代都市人物": {"count": 1, "index": "现代都市人物/index.json", "rev": "R3", "covers": []},
            },
        }, ensure_ascii=False), encoding="utf-8")
        self._prev_cloud = backyard._cloud_master_index
        backyard._cloud_master_index = lambda: {"directories": {
            "仙侠玄幻人物": {"count": 1, "rev": "R1"},
            "古代乡村人物": {"count": 1, "rev": "OLD"},
        }}

    def tearDown(self):
        backyard._cloud_master_index = self._prev_cloud

    def test_states_split_by_cloud(self):
        plan = backyard.build_upload_plan(self.out)
        states = {d["name"]: d["state"] for d in plan["directories"]}
        self.assertEqual(states["仙侠玄幻人物"], "synced")
        self.assertEqual(states["古代乡村人物"], "updated")
        self.assertEqual(states["现代都市人物"], "pending")
        self.assertEqual(states["现代西方人物"], "unpublished")

    def test_pending_totals_skip_synced_dirs(self):
        plan = backyard.build_upload_plan(self.out)
        self.assertEqual(plan["pending_dirs"], 3)
        self.assertEqual(plan["pending_files"], 9)
        self.assertEqual(plan["cloud_dirs"], 2)

    def test_draft_dir_counts_from_its_own_index(self):
        # --draft 只写目录索引，主索引没这条：清单要列成未发布，计数取自目录索引
        (self.out / "index.json").write_text(json.dumps({"version": 2, "directories": {}}),
                                             encoding="utf-8")
        plan = backyard.build_upload_plan(self.out)
        entry = next(d for d in plan["directories"] if d["name"] == "仙侠玄幻人物")
        self.assertEqual(entry["state"], "unpublished")
        self.assertEqual(entry["count"], 1)

    def test_missing_cloud_index_marks_every_dir_pending(self):
        backyard._cloud_master_index = lambda: None
        plan = backyard.build_upload_plan(self.out)
        self.assertFalse(plan["cloud_known"])
        self.assertEqual(plan["pending_dirs"], 4)


class SseStreamProgress(unittest.TestCase):
    """进度要边跑边到：run_fn 是同步阻塞的，在事件循环线程里跑它，循环就没机会写帧，
    整段输出只能等任务结束一次性吐 —— 上传进度就是这么丢的。"""

    class _Resp:
        def __init__(self, gate):
            self.headers = {}
            self.gate = gate
            self.frames = []

        async def prepare(self, request):
            return True

        async def write(self, data):
            payload = json.loads(data.decode().removeprefix("data: ").strip())
            self.frames.append(payload.get("msg", ""))
            # 收到第一行才放行 run_fn：这一行就只能是跑中途到的
            if "first" in payload.get("msg", ""):
                self.gate.set()


    def test_lines_arrive_while_run_fn_is_running(self):
        import threading
        gate = threading.Event()
        resp = self._Resp(gate)
        finished = []

        def _run():
            print("first")
            print("  [1/2] (50%) a.png", end="")
            # 前端收到第一行才继续：卡在这里就是「循环没机会写帧」的现场
            gate.wait(2)
            print(" [OK]")
            finished.append(True)

        async def _main():
            await backyard._sse_stream(resp, _run, asyncio.Event())

        asyncio.run(_main())
        self.assertEqual(resp.frames[:2], ["first\n", "  [1/2] (50%) a.png [OK]\n"])
        self.assertTrue(finished)


if __name__ == "__main__":
    unittest.main()
