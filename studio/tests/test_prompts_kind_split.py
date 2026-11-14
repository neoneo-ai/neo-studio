# SPDX-License-Identifier: Apache-2.0
"""自定义提示词的图像 / 视频分池（离线单测，全程不依赖 ComfyUI）。

写侧按名字首段落目录：`video/名字` 进 custom/video/（视频池），其余进 custom 根层（图像池）。
旧平铺的自定义文件靠正文判类搬进 video/，一次性，判过的记在 _kind_split.json，不再逐文件重扫。
读侧、标签索引、@ 点名与删除都按同一条扫描名（带 video/ 前缀）走 —— 这条链断一处就是
「列表里有它、点开是空的」那种用户可见故障。
"""

import asyncio
import builtins
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _NODE_DIR)
# ComfyUI 根有两种落点：仓库的上级目录，与整合包里的同级 ComfyUI（.vscode/settings.json 的 extraPaths）
for _cand in (os.path.join(_NODE_DIR, "..", ".."), os.path.join(_NODE_DIR, "..", "..", "ComfyUI")):
    if os.path.isfile(os.path.join(_cand, "folder_paths.py")):
        sys.path.insert(0, os.path.abspath(_cand))
        break

_PKG_NAME = "_neo_prompts_kind_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg


class _FakeRoutes:
    def _deco(self, *a, **k):
        def wrapper(fn):
            return fn
        return wrapper

    def get(self, *a, **k):
        return self._deco()

    def post(self, *a, **k):
        return self._deco()


class _FakePromptServer:
    class instance:
        routes = _FakeRoutes()


_prev_server = sys.modules.get("server")
_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

_import_error = ""
try:
    names_mod = importlib.import_module(f"{_PKG_NAME}.prompt_names")
    prompts_mod = importlib.import_module(f"{_PKG_NAME}.prompts")
    KIND_AVAILABLE = True
except Exception as _e:
    names_mod = prompts_mod = None
    KIND_AVAILABLE = False
    _import_error = str(_e)
finally:
    if _prev_server is None:
        sys.modules.pop("server", None)
    else:
        sys.modules["server"] = _prev_server

# 判类样本取自出厂预设与用户自己写的镜头脚本：出厂视频预设与镜头脚本判成视频，
# 出厂图像预设（含「一个动作的一句话」那种）留在图像侧
VIDEO_SCRIPT = ("镜头从海面俯拍推进，首帧是空镜，运镜缓慢环绕主角，尾帧定格在夕阳，"
                "时长 8 秒，转场接下一段动画，配乐渐强，音效铺开，节奏一镜到底。")
EN_VIDEO_SCRIPT = ("A cinematic tracking shot of a red cup, slow motion camera pan, 6 seconds, "
                   "transition into animation, film footage with frames fading out.")
IMAGE_PHOTO = "一只红色陶瓷杯的白底产品图，柔和棚光，细节清晰，产品摄影。"
IMAGE_ACTION = "女孩在雨中撑伞走过，特写，画面渐暗，动作缓慢。"

@unittest.skipUnless(KIND_AVAILABLE, f"prompt modules unavailable: {_import_error}")
class ClassifyKindTests(unittest.TestCase):
    """classify_prompt_kind：只看正文特征，够 _VIDEO_KIND_SCORE 才算视频"""

    def test_shot_script_is_video(self):
        self.assertEqual(names_mod.classify_prompt_kind(VIDEO_SCRIPT), names_mod.KIND_VIDEO)

    def test_english_shot_script_is_video(self):
        self.assertEqual(names_mod.classify_prompt_kind(EN_VIDEO_SCRIPT), names_mod.KIND_VIDEO)

    def test_photo_text_stays_image(self):
        self.assertEqual(names_mod.classify_prompt_kind(IMAGE_PHOTO), names_mod.KIND_IMAGE)

    def test_composition_words_alone_stay_image(self):
        """特写 / 画面 / 缓慢这类构图词在图像提示词里也常出现：只记半分，不足以判成视频"""
        self.assertEqual(names_mod.classify_prompt_kind(IMAGE_ACTION), names_mod.KIND_IMAGE)

    def test_empty_text_is_image(self):
        self.assertEqual(names_mod.classify_prompt_kind(""), names_mod.KIND_IMAGE)


@unittest.skipUnless(KIND_AVAILABLE, f"prompt modules unavailable: {_import_error}")
class MigrationTests(unittest.TestCase):
    """migrate_custom_prompt_kinds：只搬根层高置信视频，一次性，标签索引跟着改名"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="neo_kind_split_")
        self.custom = os.path.join(self.root, "custom")
        self.marker = os.path.join(self.custom, "_kind_split.json")
        self.tags = os.path.join(self.custom, "_tags_index.json")
        os.makedirs(self.custom, exist_ok=True)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def write(self, rel, text):
        path = os.path.join(self.custom, *rel.split("/")) + ".txt"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def migrate(self):
        return names_mod.migrate_custom_prompt_kinds(self.custom, self.marker, self.tags)

    def read_tags(self):
        if not os.path.exists(self.tags):
            return {}
        with open(self.tags, encoding="utf-8") as f:
            return json.load(f)

    def test_video_file_moves_and_keeps_its_tags(self):
        self.write("镜头A", VIDEO_SCRIPT)
        self.write("红杯", IMAGE_PHOTO)
        with open(self.tags, "w", encoding="utf-8") as f:
            json.dump({"镜头A": ["运镜"], "红杯": ["产品"]}, f, ensure_ascii=False)

        moved = self.migrate()

        self.assertEqual(moved, ["video/镜头A"])
        self.assertFalse(os.path.exists(os.path.join(self.custom, "镜头A.txt")))
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "video", "镜头A.txt")))
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "红杯.txt")))
        self.assertEqual(self.read_tags(), {"红杯": ["产品"], "video/镜头A": ["运镜"]})

    def test_second_run_judges_only_what_is_newer_than_the_marker(self):
        self.write("镜头A", VIDEO_SCRIPT)
        self.migrate()
        # 第二次跑只判比标记新的文件：判过的那条不再被打开（全量重扫就是每次启动逐文件往返）
        opened = []
        real_open = open

        def spy(*a, **k):
            opened.append(str(a[0]))
            return real_open(*a, **k)

        builtins.open = spy
        try:
            self.write("红杯", IMAGE_PHOTO)
            moved = self.migrate()
        finally:
            builtins.open = real_open

        self.assertEqual(moved, [])
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "红杯.txt")))
        self.assertFalse([p for p in opened if p.endswith("镜头A.txt")])

    def test_dropping_the_marker_rescans_without_moving_twice(self):
        self.write("镜头A", VIDEO_SCRIPT)
        self.write("红杯", IMAGE_PHOTO)
        self.migrate()
        os.remove(self.marker)
        second = self.migrate()
        self.assertEqual(second, [])
        self.assertEqual(sorted(os.listdir(os.path.join(self.custom, "video"))), ["镜头A.txt"])
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "红杯.txt")))

    def test_collections_and_underscore_files_stay_put(self):
        """collections/ 与 _ 前缀的索引不在分家范围内：集合文件按行是另一套口径，不搬"""
        self.write("collections/镜头集", VIDEO_SCRIPT)
        self.write("_draft", "不是提示词")
        self.assertEqual(self.migrate(), [])
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "collections", "镜头集.txt")))
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "_draft.txt")))

    def test_broken_marker_reads_as_never_run(self):
        with open(self.marker, "w", encoding="utf-8") as f:
            f.write("{not json")
        self.write("镜头A", VIDEO_SCRIPT)
        self.assertEqual(self.migrate(), ["video/镜头A"])


@unittest.skipUnless(KIND_AVAILABLE, f"prompt modules unavailable: {_import_error}")
class SaveRouteTests(unittest.TestCase):
    """保存与删除按名字首段落目录，索引键与读侧扫描名同一份"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="neo_kind_routes_")
        self.custom = os.path.join(self.root, "custom")
        self.presets = os.path.join(self.root, "presets")
        os.makedirs(self.custom, exist_ok=True)
        os.makedirs(self.presets, exist_ok=True)
        self.saved = {
            "prompts": (prompts_mod.CUSTOM_DIR, prompts_mod.PRESETS_DIR),
            "names": (names_mod.CUSTOM_DIR, names_mod.PRESETS_DIR,
                      names_mod.CUSTOM_TAGS_FILE, names_mod.PRESETS_TAGS_FILE),
        }
        prompts_mod.CUSTOM_DIR = self.custom
        prompts_mod.PRESETS_DIR = self.presets
        names_mod.CUSTOM_DIR = self.custom
        names_mod.PRESETS_DIR = self.presets
        names_mod.CUSTOM_TAGS_FILE = os.path.join(self.custom, "_tags_index.json")
        names_mod.PRESETS_TAGS_FILE = os.path.join(self.presets, "_tags_index.json")
        self.addCleanup(self._restore)
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def _restore(self):
        prompts_mod.CUSTOM_DIR, prompts_mod.PRESETS_DIR = self.saved["prompts"]
        (names_mod.CUSTOM_DIR, names_mod.PRESETS_DIR,
         names_mod.CUSTOM_TAGS_FILE, names_mod.PRESETS_TAGS_FILE) = self.saved["names"]

    def save(self, name, text="一条提示词"):
        req = _Request({"name": name, "text": text})
        return asyncio.run(prompts_mod.rs_prompts_save_prompt(req))

    def delete(self, name):
        return asyncio.run(prompts_mod.rs_prompts_delete_prompt(_Request({"name": name})))

    def test_video_name_saves_into_video_dir(self):
        self.assertEqual(self.save("video/镜头A").status, 200)
        self.assertEqual(_read(os.path.join(self.custom, "video", "镜头A.txt")), "一条提示词")
        self.assertFalse(os.path.exists(os.path.join(self.custom, "video镜头A.txt")))
        self.assertEqual(_json_tags(names_mod.CUSTOM_TAGS_FILE), {"video/镜头A": []})

    def test_plain_name_saves_into_image_root(self):
        self.assertEqual(self.save("红杯").status, 200)
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "红杯.txt")))

    def test_presets_prefix_keeps_the_presets_source(self):
        self.assertEqual(self.save("presets/红杯预设").status, 200)
        self.assertTrue(os.path.isfile(os.path.join(self.presets, "红杯预设.txt")))
        self.assertEqual(_json_tags(names_mod.PRESETS_TAGS_FILE), {"红杯预设": []})

    def test_video_subdir_name_saves_nested(self):
        self.assertEqual(self.save("video/运镜/环绕").status, 200)
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "video", "运镜", "环绕.txt")))

    def test_same_name_gets_a_counter_suffix(self):
        self.save("红杯", "第一版")
        self.save("红杯", "第二版")
        self.assertEqual(_read(os.path.join(self.custom, "红杯.txt")), "第一版")
        self.assertEqual(_read(os.path.join(self.custom, "红杯-1.txt")), "第二版")

    def test_name_that_cleans_to_nothing_is_rejected(self):
        self.assertEqual(self.save("///").status, 400)
        self.assertEqual(self.save("").status, 400)
        self.assertEqual(self.save("presets/").status, 400)

    def test_moved_prompt_reads_and_lists_with_its_prefix(self):
        self.save("video/镜头A", VIDEO_SCRIPT)
        self.assertEqual(names_mod.read_prompt_text("video/镜头A"), VIDEO_SCRIPT)
        rows = names_mod.iter_prompt_names("custom")
        self.assertIn("video/镜头A", [r["name"] for r in rows])
        self.assertTrue(names_mod.is_video_prompt("video/镜头A"))

    def test_delete_removes_the_file_and_its_tag_key(self):
        self.save("video/镜头A")
        self.assertEqual(self.delete("video/镜头A").status, 200)
        self.assertFalse(os.path.exists(os.path.join(self.custom, "video", "镜头A.txt")))
        self.assertEqual(_json_tags(names_mod.CUSTOM_TAGS_FILE), {})

    def test_bare_name_does_not_delete_the_video_prompt(self):
        """扫描名带前缀：裸名字是另一条名字，删不到视频池那一发（404 而不是删错文件）"""
        self.save("video/镜头A")
        self.assertEqual(self.delete("镜头A").status, 404)
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "video", "镜头A.txt")))


class _Request:
    """那两条 POST 路由只要一个 await request.json()"""

    def __init__(self, data):
        self._data = data

    async def json(self):
        return self._data


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _json_tags(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


if __name__ == "__main__":
    unittest.main()

