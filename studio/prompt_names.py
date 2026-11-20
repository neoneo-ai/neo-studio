# SPDX-License-Identifier: Apache-2.0
# Neo Studio — 提示词读侧（名字与标签、整篇正文、随机抽条）。
# 只碰数据根的 prompts/ 目录与每来源一份 _tags_index.json，不依赖 PromptServer / 节点 / LLM / 显存，
# 因此 ComfyUI 内注册与桌面端离线服务共用这一份实现；写侧（保存 / 删除 / 标签索引更新）在 prompts.py。

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import time

from aiohttp import web

from . import plugin_paths
from . import prompt_lines
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

PROMPTS_DIR = str(plugin_paths.PROMPTS_DIR)
PRESETS_DIR = os.path.join(PROMPTS_DIR, "presets")
CUSTOM_DIR = os.path.join(PROMPTS_DIR, "custom")
PRESETS_TAGS_FILE = os.path.join(PRESETS_DIR, "_tags_index.json")
CUSTOM_TAGS_FILE = os.path.join(CUSTOM_DIR, "_tags_index.json")
# 自定义池与预设池同一约定：video/ 目录（含其子目录）是视频提示词，根层是图像提示词。
# _kind_split.json 是旧平铺文件分家的记账标记（见 migrate_custom_prompt_kinds），删掉它就重跑一遍。
KIND_VIDEO = "video"
KIND_IMAGE = "image"
KIND_SPLIT_FILE = os.path.join(CUSTOM_DIR, "_kind_split.json")
# 提示词封面是正文旁边的 sidecar：`custom/<扫描名>.jpg`，写下去就是 512px 长边的 JPEG，
# 读侧直接回文件，不再逐尺寸现生成（所以这一层没有要清的缩略图缓存目录）。
# 预设池是代码目录、出厂只读，用户封面不往代码目录里写，presets 侧因此永远没有封面。
COVER_SUFFIX = ".jpg"
COVER_MAX_SIDE = 512
# 封面旁边那条小指针 `<扫描名>.cover.json`：记这张封面是从素材库哪条产物缩出来的。封面的 JPEG 认不出
# 自己的来路，视频池的卡片要自动播本地那条成片时，只有这一发说得出「就是这条播出来的那一条」。
COVER_SOURCE_SUFFIX = ".cover.json"
# 卡片上的正文摘要位：一条只读正文开头那一段、压成一行，一次最多铺一页的条数（见提示词库页的分页）。
# 整篇正文不在列表里读——列表扫的是目录，摘要只按名字开那一页的文件，SMB 上不会为一页扫整棵树。
PREVIEW_CHARS = 220
PREVIEW_MAX_NAMES = 32

for _dir in (PROMPTS_DIR, PRESETS_DIR, CUSTOM_DIR):
    os.makedirs(_dir, exist_ok=True)


def tags_file_path(source: str) -> str:
    """来源对应的标签索引文件：presets 与 custom 各一份"""
    return PRESETS_TAGS_FILE if source == "presets" else CUSTOM_TAGS_FILE


def load_tags_index(tags_file: str) -> dict:
    """读一份标签索引：文件缺失或被外部编辑器写坏时当空表，不阻断列表"""
    if not os.path.exists(tags_file):
        return {}
    try:
        with open(tags_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Error loading tags index from {tags_file}: {e}")
        return {}


def iter_prompt_names(source: str) -> list:
    """一个来源的全部提示词名字：只从目录列表取名字，一个来源只开一份标签索引。

    @ 点名弹层要的是名字与标签，正文是选中那一发才读；这里不逐个 stat 文件，
    一次弹层就是两次目录列表加两次索引打开，SMB 上不再逐文件往返。
    """
    base_dir = PRESETS_DIR if source == "presets" else CUSTOM_DIR
    index = load_tags_index(tags_file_path(source))
    prompts: list = []

    def walk(dir_path: str, prefix: str) -> None:
        try:
            entries = sorted(os.scandir(dir_path), key=lambda e: e.name)
        except OSError as e:
            logger.warning(f"Cannot scan prompts dir {dir_path}: {e}")
            return
        for entry in entries:
            if entry.is_dir():
                walk(entry.path, f"{prefix}{entry.name}/")
            elif entry.name.endswith(".txt") and not entry.name.startswith("_"):
                display = f"{prefix}{entry.name[:-4]}" if prefix else entry.name[:-4]
                prompts.append({"name": display, "source": source, "tags": index.get(display, [])})

    if os.path.isdir(base_dir):
        walk(base_dir, "")
    return prompts


def scan_prompts(source: str) -> list:
    """一个来源（presets / custom）的全部提示词条目：带 mtime，供列表把最新排前面。

    标签索引按来源读一次交进扫描：每个 .txt 各读一遍同一份 _tags_index.json 的话，
    一次列表就是上百次文件打开，SMB 上是逐文件往返。
    """
    base_dir = PRESETS_DIR if source == "presets" else CUSTOM_DIR
    if not os.path.isdir(base_dir):
        return []
    tags_index = load_tags_index(tags_file_path(source))
    prompts: list = []

    def walk(dir_path: str, prefix: str) -> None:
        entries = sorted(os.listdir(dir_path))
        present = set(entries)   # 指针在同一次目录列表里认，不逐条 stat：SMB 上一次列表就是一趟往返
        for entry in entries:
            full_path = os.path.join(dir_path, entry)
            if os.path.isdir(full_path):
                walk(full_path, f"{prefix}{entry}/" if prefix else f"{entry}/")
            elif entry.endswith(".txt") and not entry.startswith("_"):
                name = entry[:-4]  # 去掉 .txt 后缀
                display_name = f"{prefix}{name}" if prefix else name
                item = {
                    "name": display_name,
                    "tags": tags_index.get(display_name, []),
                    "source": source,
                    "_mtime": os.path.getmtime(full_path),
                }
                cover = full_path[:-4] + COVER_SUFFIX
                if os.path.isfile(cover):
                    item["cover"] = int(os.path.getmtime(cover))  # 卡片上的 URL 带这一位换缓存
                    pointer = full_path[:-4] + COVER_SOURCE_SUFFIX
                    if os.path.basename(pointer) in present:
                        media = _read_cover_source(pointer)
                        if media:
                            item["cover_media"] = media
                prompts.append(item)

    walk(base_dir, "")
    return prompts


def list_prompt_entries() -> list:
    """整份条目：每组内按 mtime 倒序，custom 在前、presets 在后（@ 点名那份同名同序）

    云端预设目录里的条目会多一个 `media` 键：正文与云端那条媒体配上对才有，见 _attach_cloud_media；
    随包预设池里没带封面 sidecar 的条目会多一个 `dir_cover` 键，见 _attach_cloud_dir_covers。
    """
    groups = [scan_prompts("custom"), scan_prompts("presets")]
    for group in groups:
        group.sort(key=lambda item: -item["_mtime"])
    combined = groups[0] + groups[1]
    _attach_cloud_media(combined)
    _attach_cloud_dir_covers(combined)
    return combined


def _attach_cloud_media(entries: list) -> None:
    """云端预设目录里的条目：把正文钉到云端那条媒体上，卡片才有图与预览可播。

    云端卡的正文只在本机预设池里，视频与图都在 OSS——配对先认目录索引里那条预览的正文首行，
    与本地正文的首行整行相等才算命中（索引里被 500 字截断的那一条按前缀比）。撞两条以上时退到
    文件名：池里的条目名与发布时的文件名同源，去序号与标点之后相等（云端名被截断的按前缀比）。
    两条路都撞、都空就不钉——宁可不播也不播错的片。目录索引没缓存到本地时这里什么都不做。
    """
    try:
        from . import gallery_oss
    except Exception:
        return
    media_map = gallery_oss.oss_prompt_media_map()
    if not media_map:
        return

    by_dir = {name.lower(): (name, rows) for name, rows in media_map.items()}
    for item in entries:
        parts = str(item["name"]).split("/")
        if len(parts) < 2:
            continue
        hit = by_dir.get(parts[-2].lower())
        if hit is None:
            continue
        dir_name, rows = hit
        body = read_prompt_text(str(item["name"]))
        first_line = ((body or "").splitlines() or [""])[0].strip()
        # 三级口径，先严后宽：整段正文相等（发布时的原样）→ 首行相等（导入的整篇正文）→ 文件名同源
        matched = [row for row in rows if row["body"] == first_line]
        if len(matched) != 1:
            matched = [row for row in rows if _head_pairs_with(row["prefix"], row["truncated"], first_line)]
        if len(matched) != 1:
            matched = [row for row in rows if _stem_pairs_with(row["filename"], parts[-1])]
        if len(matched) != 1:
            continue
        item["media"] = {
            "filename": matched[0]["filename"],
            "subfolder": f"{gallery_oss.OSS_NAV_PREFIX}/{dir_name}",
            "type": matched[0]["type"],
            "preview": matched[0]["preview"],
        }


def _head_pairs_with(prefix: str, truncated: bool, head: str) -> bool:
    """索引里那条预览的正文首行与本地正文首行是不是同一条：整行相等才算命中。

    目录索引只存旁车前 500 字，首行更长的条在索引里是截断的——整行相等对那种条永远配不上，
    截断位之后没有可比内容，所以截断的条按前缀比。
    """
    if not prefix or not head:
        return False
    if prefix == head:
        return True
    return truncated and head.startswith(prefix)


def _stem_pairs_with(filename: str, name: str) -> bool:
    """发布文件名与池里那条的名字是不是同一份：去 `NN_` 序号与标点后相等。

    发布时文件名会截短（`05_CorporateStudioPortrait(AutoOutfitfor.jpg`），所以短的一头当前缀比；
    名字太短（去标点后不到 6 个字）没有判别力，不参与。"""
    def norm(text: str) -> str:
        return re.sub(r"[^0-9a-z]+", "", text.lower())

    left = norm(re.sub(r"^\d+_", "", os.path.splitext(str(filename))[0]))
    right = norm(re.sub(r"^\d+_", "", str(name)))
    if len(left) < 6 or len(right) < 6:
        return False
    return left == right or left.startswith(right) or right.startswith(left)



def _attach_cloud_dir_covers(entries: list) -> None:
    """随包预设池的条目补上云端目录那张封面：扫描名就是池名、正文旁边没有封面 sidecar 的那一条才有。

    随包预设池只发 .txt，卡片一直是文字位；发布链把池名与云端目录名发成同一个名字，
    目录索引里那张封面就是这批条目的图。已有封面 sidecar 与已钉上媒体的条目不覆盖，
    子目录条目（`video/<目录>/<条>`）的图位归那条媒体管，这里也不动。
    目录索引缓存不在本地时 oss_prompt_dir_cover_map 是空表，不发网络请求。
    """
    try:
        from . import gallery_oss
    except Exception:
        return
    dir_covers = gallery_oss.oss_prompt_dir_cover_map()
    if not dir_covers:
        return

    by_pool = {name.lower(): row for name, row in dir_covers.items()}
    for item in entries:
        name = str(item["name"])
        if item.get("cover") or item.get("media") or "/" in name:
            continue
        row = by_pool.get(name.lower())
        if row:
            item["dir_cover"] = row


def resolve_prompt_file(name: str) -> str | None:
    """扫描名 → .txt 物理路径：`presets/` 前缀认来源目录，其余 custom 优先、presets 兜底。

    越界判定与 resolve_collection_file 同一道：realpath 之后必须仍在来源目录内，
    `..` 与绝对路径因此永远落不进提示词树。
    """
    bare = name[len("presets/"):] if name.startswith("presets/") else (name or "")
    rel = os.path.normpath(bare.replace("\\", "/"))
    if not rel or rel.startswith(".") or os.path.isabs(rel) or ".." in rel.split(os.sep):
        return None
    bases = (PRESETS_DIR,) if name.startswith("presets/") else (CUSTOM_DIR, PRESETS_DIR)
    for base in bases:
        root = os.path.realpath(base)
        candidate = os.path.realpath(os.path.join(root, f"{rel}.txt"))
        try:
            inside = os.path.commonpath([candidate, root]) == root
        except ValueError:  # 跨盘符等异常情形，跳过该目录
            continue
        if inside and os.path.isfile(candidate):
            return candidate
    return None


def _inside_custom(txt_path: str) -> bool:
    """正文落在自定义池的树里（含子目录）：封面 sidecar 只跟着这一侧走"""
    root = os.path.realpath(CUSTOM_DIR)
    try:
        return os.path.commonpath([os.path.realpath(txt_path), root]) == root
    except ValueError:  # 跨盘符等异常情形，认不出就不给写
        return False


def prompt_cover_file(name: str) -> str | None:
    """封面的物理路径：正文旁边的 `<扫描名>.jpg`，没有封面给 None"""
    txt = resolve_prompt_file(name)
    if txt is None:
        return None
    cover = txt[:-4] + COVER_SUFFIX
    return cover if os.path.isfile(cover) else None


def prompt_cover_target(name: str) -> str | None:
    """封面要写到哪：自定义池正文旁边的 sidecar；预设池只读、名字解析不到正文都给 None"""
    txt = resolve_prompt_file(name)
    if txt is None or not _inside_custom(txt):
        return None
    return txt[:-4] + COVER_SUFFIX


def write_cover_source(cover_path: str, filename: str, subfolder: str, kind: str,
                       size: tuple[int, int] | None = None) -> None:
    """把封面的来路落在它旁边那条指针里：视频池的卡片自动播的就是这条成片（见 scan_prompts 的 cover_media）。

    写指针只跟着「设封面」那一发；写坏了不影响封面本身，卡片落一张静封面，预览位空着。
    size 是封面 JPEG 自己的像素尺寸，记成 w/h：瀑布流的卡片落位就要定高，等画面到位再量比例
    会让整页重排一次；量不到就不写这一发，卡片退回探测。
    """
    row = {"filename": filename, "subfolder": subfolder, "kind": kind}
    if size and size[0] > 0 and size[1] > 0:
        row["w"], row["h"] = int(size[0]), int(size[1])
    try:
        with open(cover_path[:-4] + COVER_SOURCE_SUFFIX, "w", encoding="utf-8") as f:
            json.dump(row, f, ensure_ascii=False)
    except OSError as e:
        logger.warning(f"Cannot write cover source for {cover_path}: {e}")


def _read_cover_source(pointer: str) -> dict | None:
    """读那条指针：文件缺失、被外部编辑器写坏、没有 filename 都给 None（卡片落一张静封面）"""
    try:
        with open(pointer, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.warning(f"Error loading cover source {pointer}: {e}")
        return None
    if not isinstance(data, dict) or not data.get("filename"):
        return None
    media = {
        "filename": str(data["filename"]),
        "subfolder": str(data.get("subfolder") or ""),
        "kind": data.get("kind") if data.get("kind") in ("image", "video") else "image",
    }
    # 这条指针记尺寸的写法之前写的封面没有这一发：读不出就不带，卡片退回探测那张封面
    w, h = data.get("w"), data.get("h")
    if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
        media["w"], media["h"] = w, h
    return media


def read_prompt_text(name: str) -> str | None:
    """按扫描名读整篇正文：路径由 resolve_prompt_file 定，选中那一发才打开文件"""
    filepath = resolve_prompt_file(name)
    if filepath is None:
        return None
    with open(filepath, "r", encoding="utf-8") as f:
        return f.read()


def prompt_preview_texts(names: list) -> dict:
    """一批提示词的卡片摘要：正文压成一行、截到 PREVIEW_CHARS。

    名字解析不到正文、正文是空的、文件开不动的都不落键——卡片没有摘要位就落名字与标签，
    不给界面铺一句「读取失败」。
    """
    previews: dict = {}
    for name in names:
        filepath = resolve_prompt_file(name)
        if filepath is None:
            continue
        try:
            with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                head = f.read(PREVIEW_CHARS * 4)
        except OSError as e:
            logger.warning(f"Cannot read prompt preview {name}: {e}")
            continue
        line = " ".join(head.split())
        if not line:
            continue
        previews[name] = line[:PREVIEW_CHARS] + ("…" if len(line) > PREVIEW_CHARS else "")
    return previews


def iter_collection_files() -> list:
    """列出全部多行集合：返回 [(显示名, source, 文件路径)]，custom 同名优先于 presets。"""
    found = []
    seen = set()
    for source, base_dir in (("custom", CUSTOM_DIR), ("presets", PRESETS_DIR)):
        root = os.path.realpath(os.path.join(base_dir, "collections"))
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for fn in sorted(filenames):
                if not fn.endswith('.txt') or fn.startswith('_'):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
                display = f"collections/{rel[:-4]}"
                if display in seen:
                    continue
                seen.add(display)
                found.append((display, source, os.path.join(dirpath, fn)))
    return found


def resolve_collection_file(name: str, source: str = "custom") -> str | None:
    """把 collections/<路径> 名称解析到对应来源目录下的真实文件，拒绝目录穿越。"""
    if name.startswith("collections/"):
        name = name[len("collections/"):]
    rel = os.path.normpath(name)
    if not rel or rel.startswith(".") or os.path.isabs(rel) or ".." in rel.split(os.sep):
        return None

    search_dirs = [PRESETS_DIR, CUSTOM_DIR] if source == "presets" else [CUSTOM_DIR, PRESETS_DIR]
    for base_dir in search_dirs:
        root = os.path.realpath(os.path.join(base_dir, "collections"))
        candidate = os.path.realpath(os.path.join(root, f"{rel}.txt"))
        try:
            inside = os.path.commonpath([candidate, root]) == root
        except ValueError:  # 跨盘符等异常情形，跳过该目录
            continue
        if inside and os.path.isfile(candidate):
            return candidate
    return None


def is_video_prompt(name: str) -> bool:
    """视频提示词 = 扫描名首段是 video（presets / custom 下的 video 目录，含其子目录）。

    扫描名带目录前缀（`video/foo`），collections 的名字前缀是 `collections/`，落在图像一侧。
    前端提示词管理页与预设选择浮层读的是同一条规则（js/core/preset-picker.js 的 isVideoPromptName）。
    """
    return (name or "").split("/")[0] == "video"


# 旧平铺的自定义提示词只能靠正文判：视频提示词写的是「一段镜头里发生了什么」
# （运镜、首尾帧、时长、转场、配乐），图像提示词写的是「一张图里有什么」。
# 强标记是视频独有的说法，弱标记（特写 / 画面 / 运动这类构图词）在图像提示词里也常出现，记半分。
_VIDEO_MARKERS = (
    "视频", "镜头", "运镜", "分镜", "首帧", "尾帧", "关键帧", "转场", "慢动作", "长镜头",
    "逐帧", "时长", "秒", "动画", "俯拍", "仰拍", "跟拍", "环绕", "景别", "出场",
    "入画", "走位", "节奏", "配乐", "音效", "对白", "影片", "片段", "一镜", "升格",
)
_WEAK_MARKERS = ("特写", "全景", "中景", "远景", "画面", "动态", "运动", "缓慢", "渐变", "音乐")
_EN_VIDEO_MARKERS = (
    "video", "footage", "clip", "timelapse", "slow motion", "tracking", "dolly", "pan",
    "tilt", "zoom", "sequence", "transition", "animation", "animated", "cinematic",
    "camera", "shot", "frames", "seconds", "scene", "film", "motion", "movement", "loop", "fade",
)
# 分家阈值按实测数据定：出厂视频预设 23 条里 16 条在 12.5 分以上（couple 与 minimax 的整段镜头脚本），
# 7 条「一句话镜头」在 9 分以下；出厂图像预设（集合长文除外）在 4 分以下；用户已有的平铺自定义
# 21 条全在图像侧、custom/video 的 28 条全部判成视频。阈值取 10 落在这条空隙里：
# 一句话镜头脚本会留在图像侧，分家只做高置信移动，判错的代价在用户那边是一发能改的名字。
_VIDEO_KIND_SCORE = 10


def classify_prompt_kind(text: str) -> str:
    """按正文特征判一条提示词是视频还是图像：强标记记 1 分、构图词记 0.5 分，够 _VIDEO_KIND_SCORE 才算视频。"""
    low = (text or "").lower()
    score = sum((text or "").count(m) for m in _VIDEO_MARKERS)
    score += sum(len(re.findall(rf"\b{re.escape(m)}\b", low)) for m in _EN_VIDEO_MARKERS)
    score += 0.5 * sum((text or "").count(m) for m in _WEAK_MARKERS)
    return KIND_VIDEO if score >= _VIDEO_KIND_SCORE else KIND_IMAGE


def migrate_custom_prompt_kinds(custom_dir: str = CUSTOM_DIR, marker: str = KIND_SPLIT_FILE,
                                tags_file: str = CUSTOM_TAGS_FILE) -> list:
    """旧平铺的自定义提示词分家：明显是视频的搬进 custom/video/，其余留在根层当图像。

    只扫根层 .txt（video/ 与 collections/ 的子树、_ 前缀的索引与标记都不动），判过一次的记进
    _kind_split.json 的 done_at，之后每次启动只判比它新的文件 —— 全量重扫就是每次启动逐个打开
    图像提示词，SMB 上是逐文件往返。删掉这个标记等于重跑：搬走的不回到根层，留下的判法不变。
    标签索引里的键跟着扫描名改名（名字 → video/名字），@ 点名弹层与预设选择器读的就是这个键。
    """
    video_dir = os.path.join(custom_dir, KIND_VIDEO)
    stamps = _load_kind_split(marker)
    boundary = stamps["done_at"]
    moved: list = []
    try:
        entries = list(os.scandir(custom_dir))
    except OSError as e:
        logger.warning(f"Cannot scan custom prompts dir {custom_dir}: {e}")
        return moved

    renames: dict = {}
    for entry in entries:
        if not entry.name.endswith(".txt") or entry.name.startswith("_"):
            continue
        try:
            if entry.stat().st_mtime <= boundary:
                continue
            if not entry.is_file():
                continue
            with open(entry.path, "r", encoding="utf-8", errors="ignore") as f:
                kind = classify_prompt_kind(f.read())
            if kind != KIND_VIDEO:
                continue
            os.makedirs(video_dir, exist_ok=True)
            os.replace(entry.path, os.path.join(video_dir, entry.name))
        except OSError as e:
            logger.warning(f"Cannot split custom prompt {entry.path}: {e}")
            continue
        name = entry.name[:-4]
        renames[name] = f"{KIND_VIDEO}/{name}"
        moved.append(f"{KIND_VIDEO}/{name}")

    if not renames:
        return []
    _rename_tags_keys(tags_file, renames)
    # 标记只在这一趟真的搬了东西时写：每次启动多一发写盘没有意义
    _save_kind_split(marker, time.time(), sorted(set(stamps["moved"]) | set(moved)))
    logger.info(f"Custom prompts split into {KIND_VIDEO}/: {len(renames)} moved")
    return moved


def _load_kind_split(marker: str) -> dict:
    """读分家标记：文件缺失或被外部编辑器写坏时当「从没跑过」，全量判一遍"""
    try:
        with open(marker, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {"done_at": 0.0, "moved": []}
    try:
        done_at = float(data.get("done_at", 0))
    except (TypeError, ValueError):
        done_at = 0.0
    moved = data.get("moved")
    return {"done_at": done_at, "moved": [str(m) for m in moved] if isinstance(moved, list) else []}


def _save_kind_split(marker: str, done_at: float, moved: list) -> None:
    try:
        with open(marker, "w", encoding="utf-8") as f:
            json.dump({"done_at": done_at, "moved": moved}, f, ensure_ascii=False)
    except OSError as e:
        logger.warning(f"Cannot write prompt kind marker {marker}: {e}")


def _rename_tags_keys(tags_file: str, renames: dict) -> None:
    """搬家后把标签索引的键改成新扫描名：索引不存在（下一次保存自会建）就没得改"""
    if not renames or not os.path.exists(tags_file):
        return
    index = load_tags_index(tags_file)
    changed = [(old, new) for old, new in renames.items() if old in index]
    if not changed:
        return
    for old, new in changed:
        index[new] = index.pop(old)
    try:
        with open(tags_file, "w", encoding="utf-8") as f:
            json.dump(index, f, indent=2, ensure_ascii=False)
    except OSError as e:
        logger.warning(f"Cannot rewrite tags index {tags_file}: {e}")


def iter_random_candidates(kind: str = "") -> list:
    """运行时随机候选池：collections 文件按行拆成多条（复用解析缓存），普通预设文件整篇一条。

    kind="image" 只留图像提示词、kind="video" 只留视频提示词、空值不筛 —— 绘画页 / 视频页的「随机」各自
    只要自己那一池，Prompt Agent 节点的运行时随机要的是混池，走空值这条。
    """
    kind = (kind or "").strip().lower()
    pool: list = []
    for source, base_dir in (("custom", CUSTOM_DIR), ("presets", PRESETS_DIR)):
        for dirpath, dirnames, filenames in os.walk(base_dir):
            # collections 子树交给下方按行展开，这里跳过避免整篇重复入池
            if os.path.relpath(dirpath, base_dir).split(os.sep)[0] == "collections":
                dirnames[:] = []
                continue
            for fn in sorted(filenames):
                if fn.endswith(".txt") and not fn.startswith("_"):
                    rel = os.path.relpath(os.path.join(dirpath, fn), base_dir).replace(os.sep, "/")
                    if kind and is_video_prompt(rel) != (kind == "video"):
                        continue
                    try:
                        with open(os.path.join(dirpath, fn), "r", encoding="utf-8", errors="ignore") as f:
                            content = f.read().strip()
                    except OSError:
                        continue
                    if content:
                        pool.append(content)
    for display, _, filepath in iter_collection_files():
        if kind and is_video_prompt(display) != (kind == "video"):
            continue
        try:
            pool.extend(text for _, text in prompt_lines.load_entries(filepath))
        except OSError:
            pass
    # 去重（同一段提示词可能存于多个文件）：保序，保证批量抽样不重复
    return list(dict.fromkeys(p for p in pool if p.strip()))


def sample_runtime_prompts(count: int, kind: str = "") -> list:
    """从混合池中不重复抽取 count 条；池子不足时全量乱序返回。kind 筛池子，空值不筛。"""
    pool = iter_random_candidates(kind)
    if not pool:
        return []
    if len(pool) <= count:
        random.shuffle(pool)
        return pool
    return random.sample(pool, count)


# ===========================================================================
# 路由（桌面端离线服务与 ComfyUI 内注册共用）
# ===========================================================================

routes = web.RouteTableDef()


@routes.post("/rs_prompts/list_prompt_names")
async def list_prompt_names_route(request):
    """@ 点名弹层的候选：两个来源的名字与标签，custom 在前、presets 在后（与 list_prompts 同序）"""
    rows = await asyncio.to_thread(lambda: iter_prompt_names("custom") + iter_prompt_names("presets"))
    return web.json_response(rows)


@routes.post("/rs_prompts/list_prompts")
async def list_prompts_route(request):
    """提示词管理页与预设浮层要的整份条目：扫描名、标签、来源（配方不入池）"""
    try:
        return web.json_response(await asyncio.to_thread(list_prompt_entries))
    except Exception as e:
        logger.error(f"Error listing prompts: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/prompt_previews")
async def prompt_previews_route(request):
    """卡片上的正文摘要：一页一批发（名字最多 PREVIEW_MAX_NAMES 条），整篇正文仍是选中那一发才读"""
    try:
        data = await request.json()
        names = [str(n) for n in (data.get("names") or []) if str(n).strip()][:PREVIEW_MAX_NAMES]
        return web.json_response({"previews": await asyncio.to_thread(prompt_preview_texts, names)})
    except Exception as e:
        logger.error(f"Error building prompt previews: {e}")
        return web.Response(status=500, text=str(e))


@routes.get("/rs_prompts/prompt_cover")
async def prompt_cover_route(request):
    """卡片上的封面：直接回 sidecar 的 JPEG（写下去就是 512px 长边，不逐尺寸现生成）。

    URL 上的 `v=` 是列表里那份封面 mtime，前端换封面就换 URL。缓存必须救得回来：一年期
    `immutable` 把 ComfyUI 重启窗口里那一次失败响应钉死在 URL 上，浏览器连硬刷都不发请求，
    卡片便永久空白。`max-age=0, must-revalidate` 让每次进页面都带条件请求，FileResponse 报
    `Last-Modified` 并自判 `If-Modified-Since`，文件没变回 304、变了就重新取图。
    名字解析不到封面就是 404，卡片落正文摘要位。
    """
    cover = await asyncio.to_thread(prompt_cover_file, request.rel_url.query.get("name", ""))
    if cover is None:
        return web.Response(status=404)
    return web.FileResponse(cover, headers={"Cache-Control": "public, max-age=0, must-revalidate"})


@routes.post("/rs_prompts/list_prompt_lines")
async def list_prompt_lines_route(request):
    """按页列出多行集合（collections/ 目录约定）里的提示词：一行一条。"""
    try:
        data = await request.json()
        name = str(data.get("name", "")).strip()
        if not name:
            return web.Response(status=400, text="Name required")
        offset = max(int(data.get("offset", 0)), 0)
        limit = min(max(int(data.get("limit", 200)), 1), 1000)
        query = str(data.get("query", "")).strip().lower()

        # name="*"：跨全部集合聚合搜索，行附带来源集合供前端路由点击
        if name == "*":
            hits = []
            for display, source, filepath in iter_collection_files():
                try:
                    entries = prompt_lines.load_entries(filepath)
                except OSError:
                    continue
                hits.extend(
                    (display, source, t, s) for t, s in entries
                    if not query or query in t.lower()
                )
            page = hits[offset:offset + limit]
            return web.json_response({
                "total": len(hits),
                "titles": [t for _, _, t, _ in page],
                "texts": [s for _, _, _, s in page],
                "names": [n for n, _, _, _ in page],
                "sources": [src for _, src, _, _ in page],
            })

        filepath = resolve_collection_file(name, str(data.get("source", "custom")))
        if filepath is None:
            return web.Response(status=404, text="Collection not found")

        entries = prompt_lines.load_entries(filepath)
        if query:
            entries = [(t, s) for t, s in entries if query in t.lower()]
        page = entries[offset:offset + limit]
        return web.json_response({
            "total": len(entries),
            "titles": [t for t, _ in page],
            "texts": [s for _, s in page],
        })
    except Exception as e:
        logger.error(f"Error listing prompt lines: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/load_prompt")
async def load_prompt_route(request):
    """读一条提示词的整篇正文：选中那一发才打开文件"""
    try:
        data = await request.json()
        name = str(data.get("name") or "")
        if not name:
            return web.Response(status=400, text="Name required")
        text = await asyncio.to_thread(read_prompt_text, name)
        if text is None:
            return web.Response(status=404, text="Prompt not found")
        return web.json_response({"text": text})
    except Exception as e:
        logger.error(f"Error loading prompt: {e}")
        return web.Response(status=500, text=str(e))


@routes.post("/rs_prompts/random_prompts")
async def random_prompts_route(request):
    """运行时随机：从池子不重复抽取 count 条（与 NeoPromptAgent 同池，供批量生成使用）

    kind 选池子："image" 排除 video 目录的提示词，"video" 只取它们，空 / 不传 = 混池（节点与旧调用方）。
    """
    try:
        data = await request.json()
        count = max(1, min(int(data.get("count", 1) or 1), 16))
        kind = str(data.get("kind", "") or "")
        return web.json_response({"texts": await asyncio.to_thread(sample_runtime_prompts, count, kind)})
    except Exception as e:
        logger.error(f"Error sampling random prompts: {e}")
        return web.Response(status=500, text=str(e))


# 启动即分家（与 plugin_paths 里 seed_presets() 同一时机，插件注册与桌面端离线服务都会 import 这一层）：
# 读侧与写侧现在都按目录判类别，旧平铺文件不分家就永远混在图像池里。搬文件坏了不挡读侧与写侧，记一行继续起。
try:
    migrate_custom_prompt_kinds()
except OSError as e:
    logger.warning(f"Custom prompt kind split skipped: {e}")

