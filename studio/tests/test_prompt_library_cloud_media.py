# SPDX-License-Identifier: Apache-2.0
"""提示词库条目与云端预设媒体的配对（离线单测，全程不发网络请求）。

云端卡的正文只在本机预设池里，视频与图都在 OSS：list_prompts 要把一条提示词钉到云端那条媒体上，
卡片才有 480p 预览可播。配对的依据是目录索引里那条预览的正文首行（旁车写成 `标题：X\n提示词：<首行>`）。
索引没缓存到本地、正文首行撞出两条以上时不钉，卡片保持封面。
"""

import asyncio
import importlib
import json
import shutil
import sys
import unittest
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STUDIO_DIR))

import plugin_paths

CLOUD_DIR = "prompts.chat"
BODY_HEAD = "镜头从街角推进到雨夜的霓虹街角"
INDEX_REV = "2026-11-19T00:00:00Z"


def _oss_cache_dir() -> Path:
    return Path(plugin_paths.GALLERY_DIR) / "oss_cache"


def _write_indexes(items: list[dict], covers: list[dict] | None = None) -> None:
    """把主索引与那一目录的索引落成磁盘缓存的形态（oss_prompt_media_map 只读这一份）

    `covers` 是 v2 主索引给该目录声明的封面候选——目录封面配对读的是这一位。"""
    cache = _oss_cache_dir()
    (cache / CLOUD_DIR).mkdir(parents=True, exist_ok=True)
    entry = {"count": len(items), "index": f"{CLOUD_DIR}/_index.json", "rev": INDEX_REV}
    if covers is not None:
        entry["covers"] = covers
    (cache / "_index.json").write_text(json.dumps({
        "version": 1,
        "generated_at": INDEX_REV,
        "directories": {CLOUD_DIR: entry},
    }, ensure_ascii=False), encoding="utf-8")
    (cache / CLOUD_DIR / "_index.json").write_text(json.dumps({
        "directory": CLOUD_DIR,
        "generated_at": INDEX_REV,
        "items": items,
    }, ensure_ascii=False), encoding="utf-8")


def _write_root_preset_prompt(stem: str, body: str) -> str:
    """随包预设池根层那条：presets/<池名>.txt，扫描名就是池名（与云端目录名同一个）"""
    target = Path(plugin_paths.PROMPTS_DIR) / "presets"
    target.mkdir(parents=True, exist_ok=True)
    (target / f"{stem}.txt").write_text(body, encoding="utf-8")
    return stem


def _write_preset_prompt(stem: str, body: str) -> str:
    """预设池里那条提示词的落点：presets/video/<云端目录>/<名>.txt（与发布时导入的扫描名同形）"""
    rel = ["video", CLOUD_DIR, stem]
    target = Path(plugin_paths.PROMPTS_DIR) / "presets" / rel[0] / rel[1]
    target.mkdir(parents=True, exist_ok=True)
    (target / f"{stem}.txt").write_text(body, encoding="utf-8")
    return f"{rel[0]}/{rel[1]}/{stem}"


def _video_item(stem: str, head: str, preview: bool = True) -> dict:
    item = {
        "filename": f"{stem}.mp4",
        "type": "video",
        "txt_content": f"标题：{stem}\n提示词：{head}",
        "thumbnail": f"thumbnails/{CLOUD_DIR}/{stem}.jpg",
    }
    if preview:
        item["preview"] = f"previews/{CLOUD_DIR}/{stem}.mp4"
    return item


def _image_item(stem: str, head: str) -> dict:
    """导入的提示词：索引存的是整篇正文（没有 `提示词：` 那一行），首行才是配对依据"""
    return {
        "filename": f"{stem}.jpg",
        "type": "image",
        "txt_content": f"{head}\n\n第二段正文",
        "thumbnail": f"thumbnails/{CLOUD_DIR}/{stem}.jpg",
    }


def _entry(entries: list, name: str) -> dict:
    return next((it for it in entries if it["name"] == name), {})


class CloudMediaPairingTests(unittest.TestCase):
    """配对只认正文首行：唯一命中才钉媒体，撞多条与无索引都不钉"""

    def setUp(self):
        self.prompts_dir = Path(plugin_paths.PROMPTS_DIR)
        self.cache_dir = _oss_cache_dir()
        sys.modules.pop("studio.prompt_names", None)
        sys.modules.pop("studio.gallery_oss", None)
        self.gallery_oss = importlib.import_module("studio.gallery_oss")
        self.gallery_oss._oss_index_cache = None
        self.gallery_oss._oss_index_fetch_time = 0.0
        self.prompt_names = importlib.import_module("studio.prompt_names")
        self.addCleanup(self._clean)

    def _clean(self):
        shutil.rmtree(self.cache_dir, ignore_errors=True)
        shutil.rmtree(self.prompts_dir / "presets" / "video" / CLOUD_DIR, ignore_errors=True)
        self.gallery_oss._oss_index_cache = None

    def test_unique_head_match_attaches_media(self):
        _write_indexes([_video_item("01_Remotion", BODY_HEAD)])
        name = _write_preset_prompt("01_Remotion", f"{BODY_HEAD}\n第二行的镜头细节")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertEqual(entry.get("media"), {
            "filename": "01_Remotion.mp4",
            "subfolder": f"{self.gallery_oss.OSS_NAV_PREFIX}/{CLOUD_DIR}",
            "type": "video",
            "preview": True,
        })

    def test_stale_index_cache_adds_no_media(self):
        name = _write_preset_prompt("02_Only_Local", f"{BODY_HEAD}\n云端没有这一条")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertNotIn("media", entry)

    def test_ambiguous_head_adds_no_media(self):
        _write_indexes([_video_item("03_A", BODY_HEAD), _video_item("03_B", BODY_HEAD)])
        name = _write_preset_prompt("03_A", BODY_HEAD)
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertNotIn("media", entry)

    def test_item_without_preview_marks_media_preview_off(self):
        _write_indexes([_video_item("04_Legacy", BODY_HEAD, preview=False)])
        name = _write_preset_prompt("04_Legacy", BODY_HEAD)
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertEqual(entry["media"]["preview"], False)

    def test_truncated_index_preview_pairs_by_prefix(self):
        # 索引只存旁车前 500 字：首行更长的条在索引里是截断的，这一条按前缀配对
        long_head = BODY_HEAD + "，" + "镜头细节" * 200      # 首行远超 500 字
        item = _video_item("08_Long_Head", long_head)
        # 写出侧截到 500 字，`标题：X\n提示词：` 那一头占掉几十字，实存常是 499 这一档
        item["txt_content"] = item["txt_content"][:self.gallery_oss.OSS_DIR_PREVIEW_CHARS - 1]
        _write_indexes([item])
        name = _write_preset_prompt("08_Long_Head", long_head + "\n后面还有整段正文")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertEqual(entry["media"]["filename"], "08_Long_Head.mp4")

    def test_short_preview_without_truncation_needs_the_whole_line(self):
        # 没被截断的那一条仍按整行相等：正文首行是索引那句的延长时不钉
        short_head = "镜头从街角推进"
        _write_indexes([_video_item("09_Short", short_head)])
        name = _write_preset_prompt("09_Short", short_head + "的女孩回头")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertNotIn("media", entry)

    def test_multiline_body_pairs_image_by_first_line(self):
        # 导入的提示词整篇正文进索引：整段相等永远不中，首行相等才钉得上那张真图
        _write_indexes([_image_item("11_Imported", BODY_HEAD)])
        name = _write_preset_prompt("11_Imported", f"{BODY_HEAD}\n\n另一段正文")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertEqual(entry["media"]["filename"], "11_Imported.jpg")
        self.assertEqual(entry["media"]["type"], "image")

    def test_shared_first_line_falls_back_to_the_filename(self):
        # 撞两条的条（`{` 开头的 JSON 提示词）退到文件名：池里的名字与发布文件名同源
        _write_indexes([_image_item("12_Imported_One", "{"), _image_item("13_Imported_Two", "{")])
        name = _write_preset_prompt("12_Imported_One", "{\n\"prompt\": \"内容\"}")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertEqual(entry["media"]["filename"], "12_Imported_One.jpg")



class DirCoverPairingTests(unittest.TestCase):
    """随包预设池的条目补云端目录那张封面：池名对上目录名、正文旁边没有封面 sidecar 才有"""

    def setUp(self):
        self.prompts_dir = Path(plugin_paths.PROMPTS_DIR)
        self.cache_dir = _oss_cache_dir()
        sys.modules.pop("studio.prompt_names", None)
        sys.modules.pop("studio.gallery_oss", None)
        self.gallery_oss = importlib.import_module("studio.gallery_oss")
        self.gallery_oss._oss_index_cache = None
        self.gallery_oss._oss_index_fetch_time = 0.0
        self.prompt_names = importlib.import_module("studio.prompt_names")
        self.addCleanup(self._clean)

    def _clean(self):
        shutil.rmtree(self.cache_dir, ignore_errors=True)
        shutil.rmtree(self.prompts_dir / "presets" / "video" / CLOUD_DIR, ignore_errors=True)
        for suffix in (".txt", ".jpg"):
            Path(self.prompts_dir / "presets" / f"{CLOUD_DIR}{suffix}").unlink(missing_ok=True)
        self.gallery_oss._oss_index_cache = None

    def test_pool_entry_without_sidecar_gets_dir_cover(self):
        _write_indexes([_video_item("10_Pool_Cover", BODY_HEAD)],
                       covers=[{"filename": "10_Pool_Cover.mp4",
                                "thumbnail": f"thumbnails/{CLOUD_DIR}/10_Pool_Cover.jpg"}])
        name = _write_root_preset_prompt(CLOUD_DIR, "整池那条提示词的正文")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertEqual(entry.get("dir_cover"), {
            "filename": "10_Pool_Cover.mp4",
            "subfolder": f"{self.gallery_oss.OSS_NAV_PREFIX}/{CLOUD_DIR}",
        })
        self.assertNotIn("media", entry, "池名那条不是按正文配对的媒体")

    def test_entry_with_sidecar_keeps_its_own_cover(self):
        _write_indexes([_video_item("11_Pool_Cover", BODY_HEAD)],
                       covers=[{"filename": "11_Pool_Cover.mp4",
                                "thumbnail": f"thumbnails/{CLOUD_DIR}/11_Pool_Cover.jpg"}])
        name = _write_root_preset_prompt(CLOUD_DIR, "整池那条提示词的正文")
        (Path(plugin_paths.PROMPTS_DIR) / "presets" / f"{CLOUD_DIR}.jpg").write_bytes(b"\xff\xd8jpg")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertIn("cover", entry, "用户设过的封面 sidecar 优先")
        self.assertNotIn("dir_cover", entry)

    def test_directory_without_cover_candidate_adds_nothing(self):
        _write_indexes([_video_item("12_No_Cover", BODY_HEAD)], covers=[])
        name = _write_root_preset_prompt(CLOUD_DIR, "整池那条提示词的正文")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertNotIn("dir_cover", entry, "云端目录没有封面候选就是文字卡")

    def test_dir_cover_map_skips_the_audio_candidate(self):
        # 音频那条在素材页是装饰波形位，没有缩略图可铺，不能当目录封面
        _write_indexes([_video_item("13_Music", BODY_HEAD)],
                       covers=[{"filename": "13_Music.mp3",
                                "thumbnail": f"thumbnails/{CLOUD_DIR}/13_Music.jpg"},
                               {"filename": "14_Still.jpg",
                                "thumbnail": f"thumbnails/{CLOUD_DIR}/14_Still.jpg"}])
        self.assertEqual(self.gallery_oss.oss_prompt_dir_cover_map()[CLOUD_DIR]["filename"], "14_Still.jpg")

    def test_nested_entry_never_gets_dir_cover(self):
        _write_indexes([_video_item("15_Pool_Cover", BODY_HEAD)],
                       covers=[{"filename": "15_Pool_Cover.mp4",
                                "thumbnail": f"thumbnails/{CLOUD_DIR}/15_Pool_Cover.jpg"}])
        name = _write_preset_prompt("15_Nested", "子目录里那条的正文")
        entry = _entry(self.prompt_names.list_prompt_entries(), name)
        self.assertNotIn("dir_cover", entry, "子目录条目的图位归那条媒体管")


class PreviewKeyLookupTests(unittest.TestCase):
    """媒体路由的那一发预览：目录索引命中后取条目的 preview 键，旧条目没有这一位给 None"""

    def setUp(self):
        self.cache_dir = _oss_cache_dir()
        sys.modules.pop("studio.gallery_oss", None)
        self.gallery_oss = importlib.import_module("studio.gallery_oss")
        self.gallery_oss._oss_index_cache = None
        self.gallery_oss._oss_index_fetch_time = 0.0
        self.addCleanup(self._clean)

    def _clean(self):
        shutil.rmtree(self.cache_dir, ignore_errors=True)
        self.gallery_oss._oss_index_cache = None

    def test_preview_key_resolves_to_previews_path(self):
        _write_indexes([_video_item("05_Remotion", BODY_HEAD)])
        # 路由传进来的 subfolder 是 lowercase 过的目录名（_oss_match_dir 那道口径）
        rel = asyncio.run(self.gallery_oss._find_preview_in_oss_index(
            "05_Remotion.mp4", CLOUD_DIR.lower()))
        self.assertEqual(rel, f"previews/{CLOUD_DIR}/05_Remotion.mp4")

    def test_legacy_item_without_preview_returns_none(self):
        _write_indexes([_video_item("06_Legacy", BODY_HEAD, preview=False)])
        rel = asyncio.run(self.gallery_oss._find_preview_in_oss_index(
            "06_Legacy.mp4", CLOUD_DIR))
        self.assertIsNone(rel)

    def test_original_media_lookup_still_uses_directory_copy(self):
        _write_indexes([_video_item("07_Remotion", BODY_HEAD)])
        rel = asyncio.run(self.gallery_oss._find_in_oss_index("07_Remotion.mp4", CLOUD_DIR))
        self.assertEqual(rel, f"{CLOUD_DIR}/07_Remotion.mp4")


if __name__ == "__main__":
    unittest.main()