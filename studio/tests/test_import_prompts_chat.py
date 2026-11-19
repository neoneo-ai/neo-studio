#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""prompts.chat 导入器的契约：产物只进构建目录、图位与旁车成对、清单不进上传目录

跑法：python -m pytest studio/tests/test_import_prompts_chat.py -q
网络与 OSS 都不进用例：取数打桩成一份内存里的接口响应，示例产物的下载同样打桩。
"""
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PRESETS = REPO / "studio" / "prompts" / "presets"
sys.path.insert(0, str(REPO / "tools"))

import import_prompts_chat as ic


def _row(**over):
    row = {
        "title": "Photorealistic Selfie Portrait",
        "slug": "photorealistic-selfie-portrait",
        "content": "ultra realistic skin texture, 85mm lens, soft window light, natural pores. " * 2,
        "description": "Realistic selfie prompt",
        "type": "IMAGE",
        "mediaUrl": None,
        "tags": [{"tag": {"name": "photorealistic", "slug": "photorealistic"}}],
        "author": {"username": "d12345"},
        "voteCount": 96,
    }
    return {**row, **over}


def _plan(row, rank=1, taken=None):
    return ic._plan(row, rank, taken if taken is not None else set())


def _fake_download(ext):
    """把示例产物的下载打桩成一份落好的文件——真下载要联网，不进用例"""
    def download(url, stem, src, cap=ic.MAX_MEDIA_BYTES):
        dest = src / f"{stem}{ext}"
        dest.write_bytes(b"stub-media")
        return dest
    return download


def test_stem_is_serial_and_spaceless(tmp_path):
    """卡名在云端目录里是扁平的一个文件：标题里的空白按图库预设那一份口径去掉"""
    plan = _plan(_row(title="Photorealistic Selfie Portrait 🎨"))
    assert plan["stem"] == "01_PhotorealisticSelfiePortrait"
    plan2 = _plan(_row(title="写实人像"), rank=2)
    assert plan2["stem"] == "02_写实人像"


def test_sidecar_text_leads_with_title_and_body():
    """卡片预览取旁车前两行：标题与正文首行必须在最前，来源与标签跟在空行后"""
    text = ic.sidecar_text(_plan(_row()))
    lines = text.splitlines()
    assert lines[0].startswith("标题：")
    assert lines[1].startswith("提示词：ultra realistic")
    assert lines[2] == ""
    joined = "\n".join(lines[3:])
    assert "标签：photorealistic" in joined
    assert "来源：https://prompts.chat/p/photorealistic-selfie-portrait" in joined
    assert "CC0" in joined


def test_media_ext_prefers_url_suffix_then_content_type():
    """链上常没有后缀（cdn1.wiro.ai/<hash>），后缀认不出才认 content-type"""
    assert ic._media_ext("https://x/a.webp", "") == ".webp"
    assert ic._media_ext("https://cdn1.wiro.ai/9f21c0", "image/jpeg") == ".jpg"
    assert ic._media_ext("https://cdn1.wiro.ai/9f21c0", "video/mp4") == ".mp4"
    assert ic._media_ext("https://cdn1.wiro.ai/9f21c0", "application/octet-stream") == ""


def test_preview_is_deterministic_jpeg(tmp_path):
    """同一条每次排出来字节一致：重跑不能产出「看起来变了」的预览"""
    first = tmp_path / "a.jpg"
    second = tmp_path / "b.jpg"
    assert ic.preview_image("写实人像", "正文正文正文", "图像", first)
    assert ic.preview_image("写实人像", "正文正文正文", "图像", second)
    assert first.read_bytes() == second.read_bytes()
    assert first.read_bytes()[:2] == b"\xff\xd8"


def test_place_with_media_writes_a_pair(tmp_path, monkeypatch):
    """有示例产物的条：图位是站上那份媒体，旁车同名——gallery_preprocess.py 只认成对的 stem"""
    monkeypatch.setattr(ic, "_download_media", _fake_download(".jpg"))
    src = tmp_path / ic.DIR_NAME
    state, row = ic._place(_plan(_row(mediaUrl="https://x/a.jpg")), src, False)
    assert state == "产出+示例产物.jpg"
    assert (src / "01_PhotorealisticSelfiePortrait.jpg").is_file()
    assert (src / "01_PhotorealisticSelfiePortrait.txt").is_file()
    assert row["media"] == "01_PhotorealisticSelfiePortrait.jpg"
    assert row["txt_sha256"] == hashlib.sha256(
        (src / "01_PhotorealisticSelfiePortrait.txt").read_bytes()).hexdigest()


def test_place_without_media_fills_the_slot_with_a_preview(tmp_path):
    """没有 mediaUrl 的条也出图位：gallery_preprocess.py 的 scan_directory 对只有 .txt 的条目直接跳过"""
    src = tmp_path / ic.DIR_NAME
    state, row = ic._place(_plan(_row()), src, False)
    assert state == "产出+排版预览"
    assert (src / "01_PhotorealisticSelfiePortrait.jpg").read_bytes()[:2] == b"\xff\xd8"
    assert row["slot"] == "排版预览"
    assert row["media_url"] == ""


def test_place_skips_an_existing_sidecard_and_overwrites_on_request(tmp_path, monkeypatch):
    """同名旁车已有就不动（重复跑不重写已上云的条），--overwrite 才重写"""
    monkeypatch.setattr(ic, "_download_media", _fake_download(".jpg"))
    src = tmp_path / ic.DIR_NAME
    side = src / "01_PhotorealisticSelfiePortrait.txt"
    side.parent.mkdir(parents=True)
    side.write_text("用户自己写过的旁车", encoding="utf-8")
    state, row = ic._place(_plan(_row(mediaUrl="https://x/a.jpg")), src, False)
    assert (state, row) == ("已有", None)
    assert side.read_text(encoding="utf-8") == "用户自己写过的旁车"
    state, row = ic._place(_plan(_row(mediaUrl="https://x/a.jpg")), src, True)
    assert state.startswith("产出+")
    assert side.read_text(encoding="utf-8").startswith("标题：")


def test_place_reports_failure_when_no_slot_can_be_written(tmp_path, monkeypatch):
    """媒体拉不动、排版预览也出不来时这条不产出，旁车不能被一份没有图位的正文占住"""
    monkeypatch.setattr(ic, "preview_image", lambda *a, **k: False)
    src = tmp_path / ic.DIR_NAME
    state, row = ic._place(_plan(_row()), src, False)
    assert state == "失败（图位出不来）" and row is None
    assert list(src.glob("*")) == []


def test_manifest_sits_outside_the_upload_dir(tmp_path):
    """上云那一步把 --source 里每个文件都当对象上传：清单混进产物目录就是云上多出的一份文件"""
    out = tmp_path / "pack"
    src = out / ic.DIR_NAME
    src.mkdir(parents=True)
    (src / "01_a.txt").write_text("标题：A\n提示词：body\n", encoding="utf-8")
    ic._write_manifest(out, [{"stem": "01_a", "title": "A", "url": "https://prompts.chat/p/a"}])
    doc = json.loads((out / "prompts.chat.manifest.json").read_text(encoding="utf-8"))
    assert doc["entries"][0]["stem"] == "01_a"
    assert "CC0" in doc["license"]
    assert [p.name for p in sorted(src.iterdir())] == ["01_a.txt"]


def test_report_only_run_writes_nothing(tmp_path, monkeypatch):
    page = {"prompts": [_row()], "totalPages": 1}
    monkeypatch.setattr(ic, "fetch_page", lambda type_, page_no, tag=None: page)
    out = tmp_path / "pack"
    monkeypatch.setattr(sys, "argv", ["prog", "--top", "1", "--out", str(out)])
    assert ic.main() == 0
    assert not out.exists()


def test_build_lands_in_the_build_dir_only(tmp_path, monkeypatch):
    """产物一个文件都不进代码包：预设池里不许出现 prompts.chat 目录"""
    page = {"prompts": [_row(), _row(title="写实人像", slug="x2", mediaUrl="https://x/b.jpg")],
            "totalPages": 1}
    monkeypatch.setattr(ic, "fetch_page", lambda type_, page_no, tag=None: page)
    monkeypatch.setattr(ic, "_download_media", _fake_download(".jpg"))
    out = tmp_path / "pack"
    monkeypatch.setattr(sys, "argv", ["prog", "--type", "IMAGE", "--top", "2",
                                      "--build", "--out", str(out)])
    assert ic.main() == 0
    src = out / ic.DIR_NAME
    assert sorted(p.name for p in src.iterdir()) == [
        "01_PhotorealisticSelfiePortrait.jpg", "01_PhotorealisticSelfiePortrait.txt",
        "02_写实人像.jpg", "02_写实人像.txt"]
    assert (out / "prompts.chat.manifest.json").is_file()
    # gallery_preprocess.py 的成对口径：每个 stem 都得有媒体 + 旁车
    for stem in {p.stem for p in src.iterdir()}:
        assert (src / (stem + ".txt")).is_file()
        assert (src / (stem + ".jpg")).is_file()
    assert not (PRESETS / ic.DIR_NAME).exists()
    assert not (PRESETS / "video" / ic.DIR_NAME).exists()


def test_empty_candidates_reports_and_exits_nonzero(tmp_path, monkeypatch):
    monkeypatch.setattr(ic, "fetch_page", lambda type_, page_no, tag=None: {"prompts": [], "totalPages": 1})
    monkeypatch.setattr(sys, "argv", ["prog", "--top", "5", "--type", "VIDEO"])
    assert ic.main() == 1