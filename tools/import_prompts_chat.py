#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""把 prompts.chat 的精选提示词产成云端图库预设——产物全在 OSS，代码包里一个文件都不留。

公开接口 `GET https://prompts.chat/api/prompts`（page / perPage / type / tag / sort），条目里
`content` 是正文、`type` 分 IMAGE 与 VIDEO、`mediaUrl` 是作者自己传的示例产物。只取这两型：
`type=IMAGE` 是出图要的、`type=VIDEO` 是出视频要的，那 3000 条「Act as a linux terminal」的
聊天条一型都不沾。

许可（站上的 LICENSE 文件原文）：提示词文本与数据是 CC0 1.0 公有领域——复制、修改、商用自由，
不必署名；站的代码是 MIT。mediaUrl 那张图不在这条措辞里：它是站上一位作者上传的产物，托管还在
站外第三方（prompts-chat-space.fra1.digitaloceanspaces.com、pbs.twimg.com、cdn1.wiro.ai、
v3b.fal.media），推特与第三方渲染链会过期、会防盗链。本地排版的文字卡也不是任何真实产物。
两边都不进代码包：产物落进构建目录（默认 tmp\\gallery_pack，在 .gitignore 里），与素材预设
同一条链交给 tools\\gallery_preprocess.py 出缩略图与 index.json、tools\\gallery_deploy_oss.py
上云，素材库把它读成一张云端预设卡。

产物口径就是图库预设那一套（`studio/gallery.py` 读旁车，灯箱按「标签：值」分段，`/neo_gallery/txt`
读全文）：`<out>/prompts.chat/<NN>_<名称>.<媒体>` + 同名 `.txt` 旁车。没有 mediaUrl 的条排一张
预览图占住图位——`gallery_preprocess.py` 的 `scan_directory()` 对只有 `.txt` 的条目直接跳过，
云端卡没有图位就不出卡。清单写在产物目录之外（`<out>/prompts.chat.manifest.json`）：
`gallery_deploy_oss.py` 把 --source 目录里每个文件都当对象上传，清单混进去就是云上多出的一份文件。

Usage:
  python tools/import_prompts_chat.py --list                                        # 只出报告
  python tools/import_prompts_chat.py --type IMAGE --top 20
  python tools/import_prompts_chat.py --build --top 20 --pages 2                   # 产进 tmp\\gallery_pack
  python tools/gallery_preprocess.py --presets tmp\\gallery_pack --output tmp\\gallery_pack --dirs prompts.chat
  python tools/gallery_deploy_oss.py --source tmp\\gallery_pack --bucket <bucket> --prefix neo/presets/

默认只出报告，--build 才产文件；同名旁车已有就不动，--overwrite 才重写。视频条的缩略图要 ffmpeg
出首帧，ffmpeg 不在 PATH 时 gallery_preprocess.py 给一条 WARN，那张卡没有预览。
"""
from __future__ import annotations

import argparse
import colorsys
import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

API_URL = "https://prompts.chat/api/prompts"
HOME_URL = "https://prompts.chat/"
DIR_NAME = "prompts.chat"            # 云端目录名 = 素材库里的一张卡
PER_PAGE = 100                       # 接口一页的上限（服务端 MAX_API_PER_PAGE）
NAME_MAX = 42                        # 卡名要一眼读完，标题截到这里
TAG_MAX = 5                          # 旁车里最多记这几枚标签
MIN_BODY_CHARS = 40                  # 正文短过这个数的条在卡上读不出内容
PREVIEW_MAX_SIDE = 768               # 排版预览的长边，云端缩略图从它出
PREVIEW_CHARS = 320                  # 排版预览只铺开头这一段正文
MAX_MEDIA_BYTES = 24 * 1024 * 1024   # 站上原图能到几十 MB，超量的条落排版预览
UA = "neo-studio-import/1.0"
# gallery_preprocess.py 认的扩展名，与它同一份口径：不在集合里的媒体上不了云
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"}
CT_EXTS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
           "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm",
           "video/quicktime": ".mov"}
FONT_BOLD = (
    r"C:\Windows\Fonts\msyhbd.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
)
FONT_REGULAR = (
    r"C:\Windows\Fonts\msyh.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
)
# Windows 的目录名不能带这些，emoji 与变体选择符在文件名里只会落成一串问号。
STRIP = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f️‍\U0001F000-\U0001FAFF]|[\u2600-\u27bf]')
SPACES = re.compile(r"\s+")
TOKENS = re.compile(r"[A-Za-z0-9@._#%+\-]+|\s+|.")


def main() -> int:
    """报告 → --build 产进构建目录 → 打印把这份目录推上云的两条命令"""
    args = _parse_args()
    plans: list[dict] = []
    taken: set[str] = set()
    for type_ in (("IMAGE", "VIDEO") if args.type == "both" else (args.type,)):
        for rank, row in enumerate(candidates(type_, args.top, args.tag, args.pages), start=1):
            plans.append(_plan(row, rank, taken))

    for plan in plans:
        print(f"{_type_label(plan['type'])} | {plan['stem']} | 图位 {_slot_note(plan)}"
              f" | 标签 {plan['tags'][:3] or '无'} | ↑{plan['votes']}")
    if not plans:
        print("候选: 0（接口没返回这个型的条，检查 --type / --tag）")
        return 1
    with_media = sum(1 for plan in plans if plan["media_url"])
    print(f"候选: {len(plans)}（示例产物 {with_media} / 排版预览 {len(plans) - with_media}）")
    out = Path(args.out)
    if not args.build:
        print(f"未产出（--build 才产进 {out / DIR_NAME}）")
        return 0

    src = out / DIR_NAME
    src.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []
    built = existing = failed = 0
    for plan in plans:
        state, row = _place(plan, src, args.overwrite)
        if state == "已有":
            existing += 1
        elif row is None:
            failed += 1
        else:
            built += 1
            rows.append(row)
        print(f"{state} | {plan['stem']}")
    if rows:
        _write_manifest(out, rows)
    print(f"产出: {built} | 已有跳过: {existing} | 失败: {failed} | 目录 {src}")
    print(f"下一步：python tools\\gallery_preprocess.py --presets {out} --output {out} --dirs {DIR_NAME}")
    print(f"      python tools\\gallery_deploy_oss.py --source {out} --bucket <bucket> --prefix neo/presets/")
    print("视频条的缩略图要 ffmpeg 出首帧；ffmpeg 不在 PATH 时那张卡没有预览。")
    return 0


# ============================================================================
# 取数、判名与一条的落点
# ============================================================================

def fetch_page(type_: str, page: int, tag: str | None = None) -> dict:
    """接口的一页：type 落类别，sort 走 upvotes（站上「优秀的提示词」就是这条排序）"""
    params = {"page": page, "perPage": PER_PAGE, "sort": "upvotes"}
    if type_:
        params["type"] = type_
    if tag:
        params["tag"] = tag
    req = urllib.request.Request(f"{API_URL}?{urllib.parse.urlencode(params)}",
                                 headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def candidates(type_: str, top: int, tag: str | None, pages: int) -> list[dict]:
    """按 upvotes 翻页收候选：只留正文读得出内容的条，同一 slug 只留第一份"""
    out: list[dict] = []
    seen: set[str] = set()
    for page in range(1, max(1, pages) + 1):
        try:
            data = fetch_page(type_, page, tag)
        except (urllib.error.URLError, OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            print(f"第 {page} 页取数失败：{exc.__class__.__name__}")
            break
        for row in data.get("prompts") or []:
            title = str(row.get("title") or "").strip()
            body = str(row.get("content") or "").strip()
            slug = str(row.get("slug") or "")
            if not title or len(body) < MIN_BODY_CHARS or slug in seen:
                continue
            seen.add(slug)
            out.append(row)
            if len(out) >= top:
                return out
        if page >= int(data.get("totalPages") or 0):
            break
    return out


def scan_name(title: str, taken: set[str]) -> str:
    """标题 → 卡名：去掉文件系统不能要的字符与 emoji，截到一眼读完的长度，撞名加序号"""
    base = SPACES.sub(" ", STRIP.sub("", title)).strip(" .")[:NAME_MAX].rstrip(" .")
    name, serial = base or "untitled", 2
    while name.lower() in taken:
        tail = f" {serial}"
        name = base[:NAME_MAX - len(tail)].rstrip(" .") + tail
        serial += 1
    taken.add(name.lower())
    return name


def _plan(row: dict, rank: int, taken: set[str]) -> dict:
    """一条候选的全部落点信息：卡名、图位要用的链、旁车要写的字段"""
    title = SPACES.sub(" ", str(row.get("title") or "")).strip()
    name = scan_name(title, taken)
    # 云端目录是扁平的一张卡一对文件，名字里的空白按图库预设那一份口径去掉
    return {
        "stem": f"{rank:02d}_{SPACES.sub('', name)}",
        "title": title,
        "type": str(row.get("type") or ""),
        "body": str(row.get("content") or "").strip(),
        "description": str(row.get("description") or "").strip(),
        "tags": [str(t.get("tag", {}).get("name") or "") for t in (row.get("tags") or []) if t.get("tag")],
        "media_url": str(row.get("mediaUrl") or "").strip(),
        "slug": str(row.get("slug") or ""),
        "author": str((row.get("author") or {}).get("username") or ""),
        "votes": int(row.get("voteCount") or (row.get("_count") or {}).get("votes") or 0),
    }


def sidecar_text(plan: dict) -> str:
    """旁车按图库的「标签：值」版式写：灯箱分段读它，卡片预览取前两行（标题 + 正文首行）"""
    lines = [f"标题：{plan['title']}", f"提示词：{plan['body']}"]
    tail = []
    if plan["description"]:
        tail.append(f"说明：{plan['description']}")
    if plan["tags"]:
        tail.append("标签：" + ", ".join(plan["tags"][:TAG_MAX]))
    tail.append(f"来源：{HOME_URL}p/{plan['slug']}（提示词正文 CC0 1.0）")
    return "\n".join(lines) + "\n\n" + "\n".join(tail) + "\n"


def _place(plan: dict, src: Path, overwrite: bool) -> tuple[str, dict | None]:
    """写一条的产物：正文进旁车，图位优先是站上那条示例产物，拉不动落本地排版预览

    回 (报告行, 清单行)，清单行是 None 表示这条没产出（示例产物拉不动、排版预览也出不来）。
    """
    side = src / (plan["stem"] + ".txt")
    if side.is_file() and not overwrite:
        return "已有", None
    src.mkdir(parents=True, exist_ok=True)
    media, slot = src / (plan["stem"] + ".jpg"), "排版预览"
    if plan["media_url"]:
        got = _download_media(plan["media_url"], plan["stem"], src)
        if got:
            media, slot = got, f"示例产物{got.suffix}"
    if not media.is_file() and not preview_image(plan["title"], plan["body"],
                                                 _type_label(plan["type"]), media):
        return "失败（图位出不来）", None
    tmp = side.with_name(side.name + ".tmp")
    tmp.write_text(sidecar_text(plan), encoding="utf-8")
    tmp.replace(side)
    return f"产出+{slot}", {
        "stem": plan["stem"],
        "title": plan["title"],
        "type": plan["type"],
        "media": media.name,
        "slot": slot,
        "slug": plan["slug"],
        "url": f"{HOME_URL}p/{plan['slug']}",
        "media_url": plan["media_url"],
        "author": plan["author"],
        "votes": plan["votes"],
        "tags": plan["tags"][:TAG_MAX],
        "txt_sha256": _sha256(side),
        "media_sha256": _sha256(media),
    }


# ============================================================================
# 图位：站上那条示例产物，或本地排版的预览
# ============================================================================

def _download_media(url: str, stem: str, src: Path, cap: int = MAX_MEDIA_BYTES) -> Path | None:
    """把站上那条示例产物落到构建目录，回它的文件名；类型不认识、超量、拉不动都回 None

    链上常没有后缀（cdn1.wiro.ai/<hash>、pbs.twimg.com/media/<id>?format=jpg），后缀认不出就认
    响应的 content-type，两边都不认的媒体 gallery_preprocess.py 收不了。落全了才改名占位：
    半截的媒体会让那张云端卡永远加载不出来。
    """
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": HOME_URL})
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            content_type = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
            ext = _media_ext(url, content_type)
            if not ext:
                return None
            dest = src / f"{stem}{ext}"
            tmp = dest.with_name(dest.name + ".tmp")
            got = 0
            with open(tmp, "wb") as fh:
                while chunk := resp.read(1 << 16):
                    got += len(chunk)
                    if got > cap:
                        tmp.unlink(missing_ok=True)
                        return None
                    fh.write(chunk)
            tmp.replace(dest)
            return dest
    except (urllib.error.URLError, OSError):
        return None


def _media_ext(url: str, content_type: str) -> str:
    """图位的扩展名：URL 后缀优先，链上没有后缀就认 content-type"""
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    if suffix in IMG_EXTS | VIDEO_EXTS:
        return suffix
    return CT_EXTS.get(content_type, "")


def preview_image(title: str, body: str, label: str, target: Path,
                  max_side: int = PREVIEW_MAX_SIDE) -> bool:
    """排版预览：这条没有示例产物时占住图位，缩略图由 gallery_preprocess.py 从这张出

    底色从标题的 sha256 取色——同一条每次跑出来字节一致，重跑不会产出「看起来变了」的预览。
    """
    from PIL import Image, ImageDraw

    top, bottom = _palette(title)
    img = Image.new("RGB", (max_side, max_side))
    draw = ImageDraw.Draw(img)
    for y in range(max_side):
        t = y / (max_side - 1)
        draw.line((0, y, max_side, y),
                  fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    pad = int(max_side * 0.07)
    title_font = _font(int(max_side * 0.085), True)
    body_font = _font(int(max_side * 0.05), False)
    foot_font = _font(int(max_side * 0.04), False)
    width = max_side - pad * 2
    y = pad
    for line in _wrap(title, title_font, width)[:3]:
        draw.text((pad, y), line, font=title_font, fill=(246, 246, 250))
        y += int(max_side * 0.112)
    y += int(max_side * 0.035)
    excerpt = SPACES.sub(" ", body)[:PREVIEW_CHARS]
    for line in _wrap(excerpt, body_font, width)[:7]:
        draw.text((pad, y), line, font=body_font, fill=(203, 210, 224))
        y += int(max_side * 0.07)
    draw.text((pad, max_side - pad - int(max_side * 0.06)),
              f"prompts.chat · {label}", font=foot_font, fill=(146, 156, 176))
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.stem + ".tmp.jpg")
    try:
        img.save(tmp, format="JPEG", quality=85, optimize=True)
        tmp.replace(target)
        return True
    except OSError:
        tmp.unlink(missing_ok=True)
        return False


def _palette(title: str) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    seed = int(hashlib.sha256(title.encode("utf-8")).hexdigest()[:6], 16)
    hue = (seed % 360) / 360.0
    top = tuple(int(c * 255) for c in colorsys.hsv_to_rgb(hue, 0.52, 0.40))
    bottom = tuple(int(c * 255) for c in colorsys.hsv_to_rgb((hue + 0.13) % 1.0, 0.62, 0.17))
    return top, bottom


def _font(size: int, bold: bool):
    """系统里找得到的第一份 CJK 字体；全落空退成 PIL 默认位图字体（拉丁文还能读）"""
    from PIL import ImageFont

    for path in (FONT_BOLD if bold else FONT_REGULAR):
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _measure(font, text: str) -> float:
    try:
        return float(font.getlength(text))
    except AttributeError:  # 默认位图字体没有 getlength
        return len(text) * 11.0


def _wrap(text: str, font, width: int) -> list[str]:
    """按像素宽断行：拉丁词整块走，CJK 逐字走（中文标题不留半个字在行尾）"""
    lines: list[str] = []
    cur = ""
    for token in TOKENS.findall(text):
        probe = cur + token
        if not cur.strip() or _measure(font, probe) <= width:
            cur = probe
        else:
            lines.append(cur.strip())
            cur = token.strip()
    if cur.strip():
        lines.append(cur.strip())
    return lines


def _write_manifest(out: Path, rows: list[dict]) -> None:
    """清单写在产物目录之外：上云那一步把 --source 里每个文件都当对象上传，混进去就是云上多出的一份

    逐条记 url / 作者 / 标签与正文和媒体的 sha256：云上那份与本地这份对不对得上、某条是从哪一站
    来的，都只看这份清单。
    """
    target = out / f"{DIR_NAME}.manifest.json"
    known: dict[str, dict] = {}
    if target.is_file():
        try:
            loaded = json.loads(target.read_text(encoding="utf-8-sig"))
            old = loaded.get("entries") if isinstance(loaded, dict) else []
            known = {str(r.get("stem")): r for r in (old or []) if isinstance(r, dict)}
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            known = {}  # 外部编辑器写坏时当空表重建
    known.update({str(row["stem"]): row for row in rows})
    doc = {
        "directory": DIR_NAME,
        "source": API_URL,
        "homepage": HOME_URL,
        "license": ("Prompt text is CC0 1.0 Universal (public domain; copy, modify, commercial use, "
                    "no attribution required); the site's code is MIT. mediaUrl files are uploads by "
                    "prompts.chat authors hosted on third-party CDNs, not covered by that text license; "
                    "preview images are rendered by this repo. Media and previews ship on OSS only, "
                    "never inside the plugin package."),
        "imported": date.today().isoformat(),
        "entries": [known[k] for k in sorted(known)],
    }
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(target)


def _slot_note(plan: dict) -> str:
    return "示例产物（站上的链）" if plan["media_url"] else "排版预览"


def _type_label(type_: str) -> str:
    return {"IMAGE": "图像", "VIDEO": "视频"}.get(str(type_), str(type_))


def _sha256(path: Path) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _parse_args():
    ap = argparse.ArgumentParser(
        description="把 prompts.chat 的精选提示词产成云端图库预设的构建目录（产物上云，不进代码包）")
    ap.add_argument("--type", choices=("IMAGE", "VIDEO", "both"), default="both",
                    help="取哪一型（IMAGE=出图，VIDEO=出视频），默认两型都要")
    ap.add_argument("--top", type=int, default=20, help="每一型最多取前 N 条（按 upvotes）")
    ap.add_argument("--tag", default=None, help="只要带这个 tag slug 的条，例如 nano-banana")
    ap.add_argument("--pages", type=int, default=6, help="最多翻几页，每页 100 条")
    ap.add_argument("--list", action="store_true",
                    help="只出报告（默认就是只出报告，这个开关给脚本显式用）")
    ap.add_argument("--build", action="store_true", help="产文件进 --out 的构建目录")
    ap.add_argument("--out", default=str(Path("tmp") / "gallery_pack"),
                    help="构建目录（默认 tmp\\gallery_pack，在 .gitignore 里，产物永不进 git）")
    ap.add_argument("--overwrite", action="store_true", help="同名旁车也重写")
    return ap.parse_args()


if __name__ == "__main__":
    sys.exit(main())