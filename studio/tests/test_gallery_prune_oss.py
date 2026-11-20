# SPDX-License-Identifier: Apache-2.0
# tools/gallery_prune_oss.py 的三条门禁与键选：前缀拼键、卡名清单读法、本地对账拒删、只删点名的三条子树。

import importlib.util
import os
import sys
import types
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory

_TOOLS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tools"))
_SPEC = importlib.util.spec_from_file_location(
    "gallery_prune_oss", os.path.join(_TOOLS, "gallery_prune_oss.py"))
prune = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(prune)

CLOUD = [
    "neo/presets/index.json",
    "neo/presets/prompts.chat/01_One.jpg",
    "neo/presets/prompts.chat/01_One.txt",
    "neo/presets/prompts.chat/02_Two.jpg",
    "neo/presets/prompts.chat/02_Two.txt",
    "neo/presets/thumbnails/prompts.chat/01_One.jpg",
    "neo/presets/thumbnails/prompts.chat/02_Two.jpg",
    "neo/presets/previews/prompts.chat/01_One.mp4",
    "neo/presets/prompts.chat/01_Third.jpg",
    "neo/presets/prompts.chat2/01_One.jpg",
    "neo/presets/thumbnails/prompts.chat2/01_One.jpg",
]


class PrefixTests(unittest.TestCase):
    def test_prefix_grows_the_trailing_slash(self):
        # 拼键是 prefix + rel_key 直拼：`neo/presets` 少一个斜杠就拼成 neo/presetsprompts.chat/，键全在别名下面
        self.assertEqual(prune.normalize_prefix("neo/presets"), "neo/presets/")
        self.assertEqual(prune.normalize_prefix("/neo/presets/"), "neo/presets/")
        self.assertEqual(prune.normalize_prefix(""), "")


class StemsTests(unittest.TestCase):
    def test_stems_read_from_a_file_and_from_a_comma_list(self):
        with TemporaryDirectory() as tmp:
            target = Path(tmp) / "doomed.txt"
            target.write_text("01_One\n\n02_Two\n", encoding="utf-8")
            self.assertEqual(prune.read_stems(str(target)), ["01_One", "02_Two"])
        self.assertEqual(prune.read_stems("01_One, 02_Two"), ["01_One", "02_Two"])
        self.assertEqual(prune.read_stems("   "), [])


class GuardTests(unittest.TestCase):
    def test_refuses_a_stem_still_present_in_the_local_pack(self):
        # 索引与媒体对不上时删云端，卡就只剩一个加载不出来的图位：点名的卡名在本地包里还有文件就整批拒删
        with TemporaryDirectory() as tmp:
            pack = Path(tmp) / "gallery_pack" / "prompts.chat"
            pack.mkdir(parents=True)
            (pack / "01_One.jpg").write_bytes(b"x")
            (pack / "01_One.txt").write_text("标题：一条还在包里的提示词\n", encoding="utf-8")
            out = StringIO()
            argv = sys.argv
            sys.argv = ["gallery_prune_oss.py", "--source", str(Path(tmp) / "gallery_pack"),
                        "--dir", "prompts.chat", "--stems", "01_One"]
            try:
                with redirect_stdout(out):
                    code = prune.main()
            finally:
                sys.argv = argv
            self.assertEqual(code, 1)
            self.assertIn("拒删", out.getvalue())

    def test_empty_stem_list_refuses_before_any_bucket_work(self):
        out = StringIO()
        argv = sys.argv
        sys.argv = ["gallery_prune_oss.py", "--dir", "prompts.chat", "--stems", "   "]
        try:
            with redirect_stdout(out):
                code = prune.main()
        finally:
            sys.argv = argv
        self.assertEqual(code, 1)
        self.assertIn("空的", out.getvalue())


class _Bucket:
    def __init__(self):
        self.deleted: list[str] = []

    def batch_delete_objects(self, keys):
        self.deleted += list(keys)


class DeleteTests(unittest.TestCase):
    """云端那一步打桩：只验「点名的那几条、三条子树、别处的目录一条都不动」。"""

    def setUp(self):
        self.bucket = _Bucket()
        self._real = sys.modules.get("oss2")
        self._real_exc = sys.modules.get("oss2.exceptions")
        exc = types.ModuleType("oss2.exceptions")

        class OssError(Exception):
            pass

        exc.OssError = OssError
        mod = types.ModuleType("oss2")
        mod.exceptions = exc
        mod.Auth = lambda *a: object()
        mod.Bucket = lambda *a, **kw: self.bucket
        mod.ObjectIteratorV2 = lambda b, prefix="", **kw: [
            types.SimpleNamespace(key=k) for k in CLOUD if k.startswith(prefix)]
        sys.modules["oss2"] = mod
        sys.modules["oss2.exceptions"] = exc
        self._creds = prune.load_credentials
        prune.load_credentials = lambda args: {"endpoint": "ep", "bucket": "bk",
                                               "key_id": "id", "key_secret": "secret",
                                               "config_path": Path("stub")}

    def tearDown(self):
        prune.load_credentials = self._creds
        for name, saved in (("oss2", self._real), ("oss2.exceptions", self._real_exc)):
            if saved is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved

    def _run(self, stems: str, apply: bool, pack: Path) -> tuple[int, str]:
        argv = sys.argv
        sys.argv = ["gallery_prune_oss.py", "--source", str(pack), "--dir", "prompts.chat", "--stems", stems]
        if apply:
            sys.argv.append("--apply")
        out = StringIO()
        try:
            with redirect_stdout(out):
                code = prune.main()
        finally:
            sys.argv = argv
        return code, out.getvalue()

    def test_dry_run_touches_nothing(self):
        with TemporaryDirectory() as tmp:
            code, text = self._run("01_One", False, Path(tmp))
        self.assertEqual(code, 0)
        self.assertEqual(self.bucket.deleted, [])
        self.assertIn("DRY RUN", text)
        self.assertIn("云端命中 4 个键", text)

    def test_apply_deletes_only_the_named_card_and_its_three_subtrees(self):
        with TemporaryDirectory() as tmp:
            code, text = self._run("01_One", True, Path(tmp))
        self.assertEqual(code, 0)
        self.assertEqual(self.bucket.deleted, [
            "neo/presets/previews/prompts.chat/01_One.mp4",
            "neo/presets/prompts.chat/01_One.jpg",
            "neo/presets/prompts.chat/01_One.txt",
            "neo/presets/thumbnails/prompts.chat/01_One.jpg",
        ])
        # 01_Third 与点名的卡名同前缀：键按卡名整段对，不能按前缀吃
        self.assertNotIn("neo/presets/prompts.chat/01_Third.jpg", self.bucket.deleted)
        # 预设前缀下住着 16 个目录，同名卡名住在别的目录里：一条都不许被顺手删掉
        self.assertNotIn("neo/presets/prompts.chat2/01_One.jpg", self.bucket.deleted)
        self.assertNotIn("neo/presets/index.json", self.bucket.deleted)


if __name__ == "__main__":
    unittest.main()
