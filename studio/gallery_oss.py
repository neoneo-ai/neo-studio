# SPDX-License-Identifier: Apache-2.0
# Neo Studio — OSS Remote Presets (Cloud Presets) module
#
# Split out of gallery.py. Self-contained for paths: computes them from the
# custom node directory (this file sits next to gallery.py). Routes register
# at import time; gallery.py imports this module to pick them up.

import asyncio
import json
import os
import random
import re
from pathlib import Path
import aiohttp
from aiohttp import web
routes = web.RouteTableDef()

from . import plugin_paths
from .util import IMG_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS

# ---------------------------------------------------------------------------
# Paths (self-contained: this file lives next to gallery.py)
# ---------------------------------------------------------------------------
CONFIGS_DIR = plugin_paths.CONFIGS_DIR
GALLERY_DIR = plugin_paths.GALLERY_DIR
OSS_CACHE_DIR = GALLERY_DIR / "oss_cache"
OSS_INDEX_CACHE_FILE = OSS_CACHE_DIR / "_index.json"
# 提示词池的预设侧：云端提示词目录镜像进池子就落在这底下两处
PRESETS_DIR = plugin_paths.PROMPTS_DIR / "presets"
PRESETS_TAGS_FILE = PRESETS_DIR / "_tags_index.json"

# Module-level state
_oss_index_cache: dict | None = None
_oss_index_fetch_time: float = 0.0

# 云端预设只有一个位置：索引里的每个目录都是一张 Cloud Presets 卡。旧索引顶层的
# "categories" 映射（把预设目录挂进 StoryBoard/CharacterSheet 主目录的废弃设计）读取时
# 忽略，卡片一律回到 Cloud Presets，索引不用重发。
# Directory tags: a per-directory "tags" list in the master index — a virtual label that is
# independent from the card location. "categories" owns the single home position, tags only
# describe the directory (a directory can carry many), so tagging never moves a card.
# Indexes without a "tags" field have no tags. The sheet tag is named after the artifact these
# directories hold (GenerateCharacterSheet output); the bare word "character" is already taken by
# the archive category, so reusing it in the same index.json reads as two different things.
OSS_TAG_CHARACTER_SHEET = "character-sheet"
# 目录索引条目里 txt_content 的长度上限：tools/gallery_preprocess.py 的 parse_txt_preview 存旁车前 500 字，
# 首行更长的条在索引里是截断的，提示词配对对这种条按前缀比（见 oss_prompt_media_map）。
OSS_DIR_PREVIEW_CHARS = 500
# 云端预设卡的导航前缀（卡片路径、封面 key、首页 token 共用）。
OSS_NAV_PREFIX = "Cloud Presets"
# 带这个标签的云端目录是提示词池的镜像源：目录里每一条都是一条提示词。标签值由发布侧
# tools/gallery_preprocess.py 的 --tag 写进主索引，两边必须一字不差。
OSS_TAG_PROMPTS = "prompts"
# 标题落进池子当名字的长度上限：与 tools/import_prompts_chat.py 的截法同一口径，
# 两边名字对不上时镜像会重下一遍，池子里同一条出现两张卡。
MIRROR_NAME_MAX = 50
# 文件系统不能要的字符、emoji 与变体选择符：发布器那份 STRIP 的复制，两处必须一字不差。
_NAME_STRIP = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f️‍\U0001F000-\U0001FAFF]|[\u2600-\u27bf]')
# 比对键只留字母数字与汉字：标题与镜像名差在标点、空白与大小写上，这些位不参与认条
_MIRROR_KEY_STRIP = re.compile(r"[^0-9a-z\u4e00-\u9fff]+")
# 短过这个数的键谁都像谁（"Mine" 这种整名四个字母），不拿它认条，也不拿它删条
_MIRROR_KEY_MIN = 8
# 正文前缀比不拢才判同一条的下限：正文比这短的条只按标题认，前缀太短会贴到别的条上
_MIRROR_BODY_MIN = 120
# 旁车尾部那几行是发布器记的来路，不进正文
_MIRROR_TAIL_LABEL = re.compile(r"^(说明|标签|来源)：(.*)$")
_MIRROR_TAG_MAX = 5
# 正文旁边那张封面的名字：与 prompt_names.COVER_SUFFIX 同一份，卡片认的就是这一位
_MIRROR_COVER_SUFFIX = ".jpg"


def _oss_index_dirs(index: dict) -> list[str]:
    """云端预设目录名：索引里的每个目录都是一张卡。

    旧索引顶层的 categories 映射不参与归属；`_root` 与旧版内嵌目录索引条目
    （键形如 `<目录>/index.json`）不是目录卡。"""
    return [name for name in (index or {}).get("directories", {})
            if name != "_root" and not name.endswith("/index.json")]


def _oss_dir_entry(index: dict, dir_name: str) -> dict:
    """主索引里一个目录的条目。旧版索引的条目自带 items，直接当计数与封面来源。"""
    entry = (index or {}).get("directories", {}).get(dir_name)
    return entry if isinstance(entry, dict) else {}


def _oss_dir_count(index: dict, dir_name: str) -> int:
    """目录卡片计数：v2 主索引声明 count，旧版索引数 items。"""
    entry = _oss_dir_entry(index, dir_name)
    if "count" in entry:
        try:
            return int(entry["count"])
        except (TypeError, ValueError):
            return 0
    return len(entry.get("items", []))


def _oss_total_items(index: dict) -> int:
    return sum(_oss_dir_count(index, d) for d in (index or {}).get("directories", {}))


def _oss_dir_tags(index: dict, dir_name: str) -> list[str]:
    """目录标签列表：小写去重；没有 tags 字段返回空。"""
    raw = _oss_dir_entry(index, dir_name).get("tags")
    if not isinstance(raw, list):
        return []
    tags: list[str] = []
    for tag in raw:
        if not isinstance(tag, str):
            continue
        lowered = tag.strip().lower()
        if lowered and lowered not in tags:
            tags.append(lowered)
    return tags


def _oss_tagged_dirs(index: dict, tag: str) -> list[str]:
    """按标签取云端目录名：排除 _root 与旧版内嵌目录索引条目。"""
    target = (tag or "").strip().lower()
    if not target:
        return []
    return [name for name in (index or {}).get("directories", {})
            if name != "_root" and not name.endswith("/index.json")
            and target in _oss_dir_tags(index, name)]


def _oss_tagged_dir_tokens(index: dict, tag: str) -> list[str]:
    """带标签目录的画廊 token（"Cloud Presets/明朝人物" 形式）。

    前端按 token 逐字匹配卡片位置，首页角色图标记才能认得云端目录。"""
    return [f"{OSS_NAV_PREFIX}/{name}" for name in _oss_tagged_dirs(index, tag)]


def _get_oss_config() -> dict:
    """Read OSS presets configuration from configs/oss_presets.json."""
    try:
        config_path = CONFIGS_DIR / "oss_presets.json"
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _is_oss_enabled() -> bool:
    cfg = _get_oss_config()
    return bool(cfg.get("enabled")) and bool(cfg.get("index_url"))


def _get_oss_cache_dir() -> Path:
    """云端预设文件的本地缓存根：配置里的 cache_dir，缺省落在 Gallery 自己的缓存下。

    同一批云端文件曾按分类落进 output/StoryBoard/presets 与
    output/CharacterSheet/presets，把插件缓存写进用户 output 树；分类去掉后只剩这一处。"""
    cfg = _get_oss_config()
    custom = cfg.get("cache_dir", "")
    if custom:
        p = Path(custom)
        p.mkdir(parents=True, exist_ok=True)
        return p
    OSS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return OSS_CACHE_DIR


async def _fetch_oss_index(force: bool = False) -> dict | None:
    """Download and cache the OSS index.json. Returns parsed dict or None.

    Respects sync_interval_hours unless force=True.
    """
    global _oss_index_cache, _oss_index_fetch_time

    if not _is_oss_enabled():
        return None

    import time as _time

    cfg = _get_oss_config()
    interval_hours = cfg.get("sync_interval_hours", 24)

    if not force and _oss_index_cache is not None:
        elapsed_hours = (_time.time() - _oss_index_fetch_time) / 3600
        if elapsed_hours < interval_hours:
            return _oss_index_cache

    index_url = cfg["index_url"]

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(index_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status != 200:
                    print(f"[Neo Gallery] OSS index fetch failed: HTTP {resp.status}")
                    return _oss_index_cache
                data = await resp.read()

        index = json.loads(data.decode("utf-8"))

        cache_dir = _get_oss_cache_dir()
        cache_file = cache_dir / "_index.json"
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)

        _oss_index_cache = index
        _oss_index_fetch_time = _time.time()
        print(f"[Neo Gallery] OSS index synced: {len(index.get('directories', {}))} directories")
        return index

    except Exception as e:
        print(f"[Neo Gallery] OSS index fetch error: {e}")
        if OSS_INDEX_CACHE_FILE.exists():
            try:
                with open(OSS_INDEX_CACHE_FILE, "r", encoding="utf-8") as f:
                    _oss_index_cache = json.load(f)
                return _oss_index_cache
            except Exception:
                pass
        return _oss_index_cache


def _load_oss_index_from_disk() -> dict | None:
    """Load cached index.json from disk (used at startup before any async fetch)."""
    global _oss_index_cache, _oss_index_fetch_time
    if _oss_index_cache is not None:
        return _oss_index_cache
    cache_file = _get_oss_cache_dir() / "_index.json"
    if cache_file.exists():
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                _oss_index_cache = json.load(f)
            # 年龄取缓存文件自己的时间：盖成"现在"会让每次启动都把旧索引当成刚拉过，
            # sync_interval_hours 的窗口被重启一路重置，新发布的卡在窗口里永远不出现。
            _oss_index_fetch_time = cache_file.stat().st_mtime
            return _oss_index_cache
        except Exception:
            pass
    return None


async def _download_oss_file(remote_rel_path: str) -> Path | None:
    """Download a single file from OSS to local cache. Returns local cache path or None."""
    cfg = _get_oss_config()
    base_url = cfg.get("base_url", "").rstrip("/")
    if not base_url:
        return None

    cache_dir = _get_oss_cache_dir()
    local_path = cache_dir / remote_rel_path
    if local_path.exists():
        return local_path

    local_path.parent.mkdir(parents=True, exist_ok=True)
    url = f"{base_url}/{remote_rel_path}"

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    print(f"[Neo Gallery] OSS download failed ({resp.status}): {remote_rel_path}")
                    return None
                data = await resp.read()

        with open(local_path, "wb") as f:
            f.write(data)
        return local_path

    except Exception as e:
        print(f"[Neo Gallery] OSS download error: {e}")
        return None


async def _fetch_oss_dir_index(index: dict, dir_name: str, force: bool = False) -> list[dict]:
    """Items of one remote directory: the per-directory index is downloaded on entry.

    主索引只声明目录索引的路径与 rev；rev 不变就用 oss_cache/<dir>/_index.json 里的缓存，
    拉取失败退回旧缓存，断网时目录页不会变成空页。旧版索引条目自带 items，直接返回。
    force 越过 rev 那一发比较照拉一次（手动刷新云端索引）：拉失败仍退回旧缓存。"""
    entry = _oss_dir_entry(index, dir_name)
    items = entry.get("items")
    if isinstance(items, list):
        return items
    rel = str(entry.get("index", "")).strip("/")
    if not rel:
        return []

    cache_file = _get_oss_cache_dir() / dir_name / "_index.json"
    cached = None
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached = None
        if (not force and isinstance(cached, dict)
                and cached.get("generated_at", "") == str(entry.get("rev", ""))):
            return cached.get("items", [])

    base_url = str(index.get("base_url") or _get_oss_config().get("base_url", "")).rstrip("/")
    if base_url:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{base_url}/{rel}", timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status != 200:
                        print(f"[Neo Gallery] OSS dir index fetch failed ({resp.status}): {rel}")
                    else:
                        data = json.loads((await resp.read()).decode("utf-8"))
                        if isinstance(data.get("items"), list):
                            cache_file.parent.mkdir(parents=True, exist_ok=True)
                            cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                            return data["items"]
        except Exception as e:
            print(f"[Neo Gallery] OSS dir index fetch error: {e}")

    if isinstance(cached, dict):
        return cached.get("items", [])
    return []


def _dir_index_is_current(index: dict, dir_name: str) -> bool:
    """磁盘上那份目录索引缓存是不是主索引当前 rev 的那一份（空目录刷新到位也算）。"""
    cache_file = _get_oss_cache_dir() / dir_name / "_index.json"
    if not cache_file.exists():
        return False
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return str(cached.get("generated_at", "")) == str(_oss_dir_entry(index, dir_name).get("rev", ""))


async def _refresh_dir_indexes(index: dict) -> int:
    """逐目录强制重拉目录索引，数刷新到位的目录数。

    只刷主索引不够：提示词库的云端配对（oss_prompt_media_map / oss_prompt_dir_cover_map）与素材页的
    封面都只读磁盘上那份目录索引缓存，缓存停在旧 rev 上，新发布的卡与预览就还停在旧那一叠上。
    并发夹到 8 发，一次点击最多一单小 JSON；拉失败的目录留着旧缓存照旧能用。"""
    dirs = _oss_index_dirs(index)
    if not dirs:
        return 0
    sem = asyncio.Semaphore(8)

    async def one(name: str) -> None:
        async with sem:
            await _fetch_oss_dir_index(index, name, force=True)

    await asyncio.gather(*(one(name) for name in dirs))
    return sum(1 for name in dirs if _dir_index_is_current(index, name))


def _oss_match_dir(dirs: list[str], subdir: str) -> str | None:
    """Resolve a navigation subfolder to an index directory name.

    路由传进来的 subfolder 是 lowercase 过的，索引里的目录名保留原大小写；
    精确匹配会让 Style_A 这种 ASCII 目录名查不到，媒体请求 404。"""
    if subdir in dirs:
        return subdir
    lowered = subdir.lower()
    for name in dirs:
        if name.lower() == lowered:
            return name
    return None


async def _find_in_oss_index(filename: str, subdir: str) -> str | None:
    """Look up a file in the OSS index. Returns the remote relative path or None.

    只查 subdir 自己的目录索引：调用方的 subfolder 就是从导航路径取出的目录名。"""
    index = _oss_index_cache or _load_oss_index_from_disk()
    if not index:
        return None

    dirs = _oss_index_dirs(index)
    if subdir:
        target = _oss_match_dir(dirs, subdir)
        if target is None:
            return None
        targets = [target]
    else:
        targets = dirs

    for dir_name in targets:
        for item in await _fetch_oss_dir_index(index, dir_name):
            if item.get("filename") == filename:
                return f"{dir_name}/{filename}"
    return None


async def _find_preview_in_oss_index(filename: str, subdir: str) -> str | None:
    """云端目录里那条媒体的卡片预览键（previews/<目录>/<名>.mp4）；这条没有预览给 None。

    预览是发布时 `--preview` 压的 480p 静音片，键存在目录索引条目上，旧索引没有这一位。"""
    index = _oss_index_cache or _load_oss_index_from_disk()
    if not index:
        return None

    target = _oss_match_dir(_oss_index_dirs(index), subdir)
    if target is None:
        return None
    for item in await _fetch_oss_dir_index(index, target):
        if item.get("filename") == filename:
            rel = str(item.get("preview", "")).strip("/")
            return rel or None
    return None


def _oss_body_text(txt_content) -> str:
    """目录索引那条预览里的正文：旁车写成 `标题：X` + `提示词：<正文>`，取后者；导入的提示词没有这一行，整段就是正文。"""
    text = str(txt_content or "")
    _, sep, tail = text.partition("提示词：")
    return tail if sep else text



def _oss_body_prefix(txt_content) -> str:
    """目录索引那条预览里的正文首行：旁车写成 `标题：X\n提示词：<正文首行>`，取 `提示词：` 之后。

    导入的提示词（prompts.chat）没有这一行，整段存的就是正文；配对只认首行，这里只回第一行——
    拿整段（带换行）去和本地首行做整行相等永远比不中，那批真图就一直上不了卡。"""
    body = _oss_body_text(txt_content)
    return (body.splitlines() or [""])[0].strip()


def oss_prompt_media_map() -> dict[str, list[dict]]:
    """云端各目录的媒体清单（文件名 / 类型 / 有无预览 / 正文首行）——只读磁盘缓存，不联网。

    提示词库要把一条提示词钉到云端那条媒体上才有预览可播。索引目录缓存不在本地时这里就是空表：
    配对不发网络请求，卡片保持封面。
    """
    index = _load_oss_index_from_disk()
    if not index:
        return {}

    out: dict[str, list[dict]] = {}
    for dir_name in _oss_index_dirs(index):
        cache_file = OSS_CACHE_DIR / dir_name / "_index.json"
        if not cache_file.exists():
            continue
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rows = []
        for item in data.get("items", []):
            if not isinstance(item, dict) or item.get("type") not in ("video", "image"):
                continue
            preview_text = str(item.get("txt_content", ""))
            prefix = _oss_body_prefix(preview_text)
            body = _oss_body_text(preview_text)
            rows.append({
                "filename": str(item.get("filename", "")),
                "type": str(item.get("type", "")),
                "preview": bool(str(item.get("preview", "")).strip("/")),
                "prefix": prefix,
                "body": body.strip(),
                # 发布时预览只存旁车前 500 字：正文里一个换行都没有又顶到上限，说明首行本身被截断了，
                # 比对要按前缀走（多段正文有换行，整行相等那条路够用）。
                "truncated": len(body) >= OSS_DIR_PREVIEW_CHARS - 40 and "\n" not in body.rstrip("\n"),
            })
        if rows:
            out[dir_name] = rows
    return out


def oss_prompt_dir_cover_map() -> dict[str, dict]:
    """云端各目录的一张封面（目录名 → 文件名 / 导航 subfolder）——只读磁盘索引缓存，不联网。

    随包预设池只有 .txt，池名就是发布时那个云端目录名：池里没带封面 sidecar 的条目拿这张
    目录封面补上卡片那张图。索引里 covers 的顺序是发布时的顺序，取第一份带缩略图的；
    音频那条在素材页是装饰波形位，没有缩略图可铺。目录索引缓存不在本地时这里就是空表。
    """
    index = _load_oss_index_from_disk()
    if not index:
        return {}

    out: dict[str, dict] = {}
    for dir_name in _oss_index_dirs(index):
        entry = _oss_dir_entry(index, dir_name)
        candidates = entry.get("covers")
        candidates = list(candidates) if isinstance(candidates, list) else list(entry.get("items", []))
        for item in candidates:
            if not isinstance(item, dict) or not item.get("filename") or not item.get("thumbnail"):
                continue
            if _oss_cover_kind(str(item["filename"])) == "audio":
                continue
            out[dir_name] = {
                "filename": str(item["filename"]),
                "subfolder": f"{OSS_NAV_PREFIX}/{dir_name}",
            }
            break
    return out


def _mirror_name(title: str) -> str:
    """云端标题 → 池子里那条提示词的名字：去非法字符、压空白，按词边界截短"""
    base = re.sub(r"\s+", " ", _NAME_STRIP.sub("", str(title or ""))).strip(" .")
    if len(base) <= MIRROR_NAME_MAX:
        return base
    cut = base[:MIRROR_NAME_MAX]
    return (cut.rsplit(" ", 1)[0] if " " in cut else cut).rstrip(" .")


def _mirror_key(text: str) -> str:
    """标题 / 池里的名字 → 比对键：小写，只留字母数字与汉字"""
    return _MIRROR_KEY_STRIP.sub("", str(text or "").lower())


def _mirror_is_same(local_name: str, title: str) -> bool:
    """池里那个名字与云端这条标题是不是同一条：镜像名是标题的前截，两边比前缀

    池里那批镜像名是按标题前截落的（发布器换过截法、标点位置也变过），整名相等认不得它们；
    只比一头的话「云端删掉的条」与「名字被截短的同一句」分不开。前缀这一比要有下限：
    短名（"Mine" 这种四个字母的）谁都接得上前缀，整名相等没有歧义，相等就认。
    """
    a, b = _mirror_key(local_name), _mirror_key(title)
    if not a or not b:
        return False
    if a == b:
        return True
    short, long = (a, b) if len(a) <= len(b) else (b, a)
    return len(short) >= _MIRROR_KEY_MIN and long.startswith(short)


def _mirror_row_title(filename: str, txt_content: str) -> str:
    """目录索引那条条目的标题：旁车预览首行是 `标题：X`，旧索引没有这一行时取文件名"""
    first = (str(txt_content or "").splitlines() or [""])[0].strip()
    if first.startswith("标题："):
        return first[len("标题："):].strip()
    return Path(str(filename)).stem


def _mirror_pools(dir_name: str) -> tuple[Path, Path]:
    """一个云端提示词目录在提示词池里的两处落点：图像条 presets/<目录>/，视频条 presets/video/<目录>/

    池子类别就是目录位置（与 prompt_names 的 video/ 约定同一份），云端条目的 type 决定它进哪一处。
    """
    return PRESETS_DIR / dir_name, PRESETS_DIR / "video" / dir_name


def _mirror_files(dir_name: str) -> list[Path]:
    """池里已落的镜像条目：两处池子里的 .txt（`_` 开头的是索引与记账文件，不是提示词）"""
    files: list[Path] = []
    for pool in _mirror_pools(dir_name):
        if pool.is_dir():
            files.extend(p for p in pool.glob("*.txt") if not p.name.startswith("_"))
    return files


def _mirror_sidecar_split(text: str) -> tuple[str, str, list[str]]:
    """旁车全文 → (标题, 正文, 标签)：正文只取 `提示词：` 那一段

    尾部 `说明：` `标签：` `来源：` 那几行是发布器记的来路，连正文一起进提示词框的话，
    「填入绘画页」会把它一起贴进生成面板。
    """
    lines = str(text or "").splitlines()
    title = ""
    if lines and lines[0].startswith("标题："):
        title = lines[0][len("标题："):].strip()
        lines = lines[1:]
    if lines and lines[0].startswith("提示词："):
        lines[0] = lines[0][len("提示词："):]
    tags: list[str] = []
    while lines:
        hit = _MIRROR_TAIL_LABEL.match(lines[-1].strip())
        if not hit:
            break
        if hit.group(1) == "标签":
            tags = [t.strip() for t in hit.group(2).split(",") if t.strip()] + tags
        lines.pop()
    while lines and not lines[-1].strip():
        lines.pop()
    return title, "\n".join(lines).strip(), tags[:_MIRROR_TAG_MAX]


def _mirror_cover(txt_path: Path) -> Path:
    """正文旁边那张封面 sidecar：卡片只有图位与预览的入口都在它身上"""
    return txt_path.with_name(txt_path.name[:-4] + _MIRROR_COVER_SUFFIX)


def _mirror_row_thumb(item: dict) -> str:
    """目录索引那条条目的缩略图键（发布时出的那张封面）；没有这一位回空"""
    return str(item.get("thumbnail", "")).strip("/")


def _mirror_write_cover(src, cover: Path) -> bool:
    """把云端那张缩略图落成正文旁边的封面：先写 .tmp 再换，半途断网不留半张图"""
    try:
        data = Path(src).read_bytes()
    except OSError:
        return False
    if not data:
        return False
    tmp = cover.with_name(cover.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, cover)
    return True


def _mirror_tags_apply(updates: dict[str, list[str]], drops: list[str]) -> None:
    """标签索引按这一发镜像换新：补进来的条带云端那几枚标签，删掉的条连键一起收

    键是列表里的显示名（视频池那一份带 `video/` 前缀）。删掉的条留着键，筛子的标签计数
    就数到一张不存在的卡上。索引读坏了不写：这一发镜像只动它自己那批键。
    """
    if not updates and not drops:
        return
    if not PRESETS_TAGS_FILE.exists():
        index: dict = {}
    else:
        try:
            loaded = json.loads(PRESETS_TAGS_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        index = loaded if isinstance(loaded, dict) else {}
    for key in drops:
        index.pop(key, None)
    for key, tags in updates.items():
        index[key] = tags
    PRESETS_TAGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PRESETS_TAGS_FILE.with_name(PRESETS_TAGS_FILE.name + ".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, PRESETS_TAGS_FILE)


async def sync_prompt_mirror(index: dict) -> dict:
    """云端提示词目录 → 提示词池：缺的条补进池子，云端删掉的条一并从池子里收掉。

    提示词库的卡片单位是 prompts/presets 下的 .txt：只刷索引的话，云端新发的条进不了池子、
    云端删掉的条还留在池子里，用户在界面上看到的就是「刷新了，数量没变，旧卡还在」。
    只动带 prompts 标签的那几处镜像目录——出厂预设池、collections/ 与用户的 custom 池不碰。
    目录索引没刷到主索引当前 rev（断网、拉失败）时不删：拿旧那一叠当依据删条目，一次断网清掉整池。
    """
    result = {"directories": 0, "imported": 0, "pruned": 0, "covers": 0}
    dirs = _oss_tagged_dirs(index, OSS_TAG_PROMPTS)
    result["directories"] = len(dirs)
    if not dirs:
        return result

    sem = asyncio.Semaphore(8)
    updates: dict[str, list[str]] = {}
    drops: list[str] = []

    async def _fetch(rel: str) -> Path | None:
        async with sem:
            return await _download_oss_file(rel)

    for dir_name in dirs:
        rows = [item for item in await _fetch_oss_dir_index(index, dir_name)
                if isinstance(item, dict) and item.get("filename")]
        if not rows:
            continue
        titles = {str(item["filename"]): _mirror_row_title(item["filename"], item.get("txt_content", ""))
                  for item in rows}
        previews = {str(item["filename"]): _mirror_body_key(item.get("txt_content", "")) for item in rows}
        existing = [(path, _mirror_local_body_key(path)) for path in _mirror_files(dir_name)]
        taken = {_mirror_key(path.name[:-4]) for path, _ in existing}
        missing = [item for item in rows
                   if not any(_mirror_pair(path.name[:-4], key, titles[str(item["filename"])],
                                           previews[str(item["filename"])])
                              for path, key in existing)]
        got = await asyncio.gather(*(
            _fetch(f"{dir_name}/{Path(str(item['filename'])).stem}.txt") for item in missing))

        new_covers: list[tuple[Path, str]] = []
        for item, sidecar in zip(missing, got):
            if sidecar is None:
                continue
            try:
                text = Path(sidecar).read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            title, body, tags = _mirror_sidecar_split(text)
            if not body:
                continue
            name = _mirror_name(title or titles[str(item["filename"])])
            if not name or _mirror_key(name) in taken:
                continue
            is_video = str(item.get("type", "")) == "video"
            pool = _mirror_pools(dir_name)[1 if is_video else 0]
            pool.mkdir(parents=True, exist_ok=True)
            target = pool / f"{name}.txt"
            tmp = target.with_name(target.name + ".tmp")
            tmp.write_text(body + "\n", encoding="utf-8")
            os.replace(tmp, target)
            taken.add(_mirror_key(name))
            updates[f"{'video/' if is_video else ''}{dir_name}/{name}"] = tags
            result["imported"] += 1
            thumb = _mirror_row_thumb(item)
            if thumb:
                new_covers.append((_mirror_cover(target), thumb))

        # 图位补齐：卡片没有封面 sidecar 就只剩文字位，视频那条连 480p 预览都不挂
        # （前端 cardCoverSrc / cloudPreviewMedia 两条路都从这一位起步）。
        # 上一发只落了 .txt 的条目在这一发把图补上；正文对上多条就不动，宁缺不猜。
        cover_jobs = list(new_covers)
        for path, key in existing:
            cover = _mirror_cover(path)
            if cover.exists():
                continue
            hits = [item for item in rows
                    if _mirror_pair(path.name[:-4], key, titles[str(item["filename"])],
                                    previews[str(item["filename"])])]
            thumb = _mirror_row_thumb(hits[0]) if len(hits) == 1 else ""
            if thumb:
                cover_jobs.append((cover, thumb))
        fetched = await asyncio.gather(*(_fetch(rel) for _, rel in cover_jobs))
        for (cover, _), src in zip(cover_jobs, fetched):
            if src is not None and _mirror_write_cover(src, cover):
                result["covers"] += 1

        if not _dir_index_is_current(index, dir_name):
            continue
        for path, key in existing:
            name = path.name[:-4]
            if any(_mirror_pair(name, key, title, previews[filename])
                   for filename, title in titles.items()):
                continue
            try:
                path.unlink()
            except OSError:
                continue
            _mirror_cover(path).unlink(missing_ok=True)
            result["pruned"] += 1
            drops.extend([f"{dir_name}/{name}", f"video/{dir_name}/{name}"])

    _mirror_tags_apply(updates, drops)
    return result


def _mirror_body_key(content) -> str:
    """目录索引那条预览的正文键：预览是旁车正文的前一段，掐掉头尾记账行后仍是同一段的前缀"""
    return _mirror_key(_mirror_sidecar_split(str(content))[1])


def _mirror_local_body_key(txt_path: Path) -> str:
    """池里那条 .txt 的正文键；读不出来（编码坏了）给空，这一发只按标题认它"""
    try:
        text = txt_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    return _mirror_key(text)


def _mirror_pair(local_name: str, local_key: str, title: str, preview_key: str) -> bool:
    """池里一个文件与云端一个条目是不是同一条：先比标题前缀，比不拢再比正文前缀

    池里的名字取的是旁车标题的前截，索引里的标题取的是预览首行——预览掐在 500 字里就没有
    `标题：` 那一行，只能退回文件名 stem，发布器换过截法的老名字（池里 "Cat" 对云端 "Dog fun"）
    更比不拢。只比标题时这些条每一发都判成「云端删掉的」剪掉、下一发又判成「缺的」补回，
    提示词库的卡就在刷新之间来回跳。发布器记的正文两边同源，比它才认得出来；
    正文短于 _MIRROR_BODY_MIN 的条不拿前缀当依据，免得贴到别的条上。
    """
    if _mirror_is_same(local_name, title):
        return True
    return bool(local_key) and len(preview_key) >= _MIRROR_BODY_MIN and local_key.startswith(preview_key)


async def _find_thumbnail_in_oss_index(filename: str, subdir: str) -> str | None:
    """Look up a thumbnail in the OSS index. Returns the remote relative path or None."""
    index = _oss_index_cache or _load_oss_index_from_disk()
    if not index:
        return None

    dirs = _oss_index_dirs(index)
    if subdir:
        target = _oss_match_dir(dirs, subdir)
        if target is None:
            return None
        targets = [target]
    else:
        targets = dirs

    for dir_name in targets:
        for item in await _fetch_oss_dir_index(index, dir_name):
            if item.get("filename") == filename and item.get("thumbnail"):
                return item["thumbnail"]
    return None


def _oss_directories_to_gallery_dirs(index: dict) -> list[dict]:
    """Convert OSS index directories to gallery directory response format.

    云端预设目录的卡片路径固定是 "Cloud Presets/<目录>"。
    """
    result = []
    for dir_name in _oss_index_dirs(index):
        result.append({
            "name": dir_name,
            "path": f"{OSS_NAV_PREFIX}/{dir_name}",
            "read_only": True,
            "source": "oss",
            "subdirs": {},
            "root_count": _oss_dir_count(index, dir_name),
            "items": [],
        })

    return result


def _oss_cover_kind(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in IMG_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    return "other"


def _collect_oss_covers(covers: dict, index: dict, path_prefix: str = OSS_NAV_PREFIX):
    """Collect cover images from OSS index for each remote directory.

    `path_prefix` is the navigation prefix the caller's cards sit under: the home
    page uses "Cloud Presets", a main dir's read-only preset card uses "<主目录>/presets"."""
    for dir_name in _oss_index_dirs(index):
        entry = _oss_dir_entry(index, dir_name)
        # v2 主索引给每个目录带一份 covers；旧版索引从 items 里现抽
        candidates = entry.get("covers")
        candidates = list(candidates) if isinstance(candidates, list) else list(entry.get("items", []))
        random.shuffle(candidates)
        cover_items = []
        for item in candidates[:2]:
            if not isinstance(item, dict) or not item.get("filename"):
                continue
            kind = _oss_cover_kind(item["filename"])
            if kind == "audio":
                # Audio renders as a decorative waveform tile; no thumbnail needed.
                cover_items.append({
                    "filename": item["filename"],
                    "name": Path(item["filename"]).stem,
                    "subfolder": f"{path_prefix}/{dir_name}",
                    "kind": "audio",
                })
            elif item.get("thumbnail"):
                # Media covers resolve through the /neo_gallery/thumbnail proxy
                # (subfolder points at the OSS dir); the index "thumbnail" is a
                # remote relative path, not a browser URL.
                cover_items.append({
                    "filename": item["filename"],
                    "name": Path(item["filename"]).stem,
                    "subfolder": f"{path_prefix}/{dir_name}",
                    "kind": kind,
                })
        if cover_items:
            covers[f"{path_prefix}/{dir_name}"] = cover_items


def _oss_dir_cards(index: dict) -> dict:
    """subdirs mapping (dir name -> image_count) for every remote preset directory."""
    return {dname: {"image_count": _oss_dir_count(index, dname)}
            for dname in _oss_index_dirs(index)}


async def _oss_dir_items(index: dict, dir_name: str, subfolder_prefix: str) -> list[dict]:
    """Item entries of one OSS remote directory, with the navigation subfolder prefix."""
    items = []
    for item in await _fetch_oss_dir_index(index, dir_name):
        entry = {
            "name": Path(item["filename"]).stem,
            "filename": item["filename"],
            "type": item.get("type", "image"),
            "category": "",
            "subfolder": f"{subfolder_prefix}/{dir_name}",
            "mtime": item.get("mtime", 0),
            "source": "oss",
        }
        txt = item.get("txt_content", "")
        if txt:
            entry["txt_content"] = txt
        items.append(entry)
    return items


def _oss_dir_visible(dir_name: str, hidden: set) -> bool:
    """Home hide switch records cloud preset dirs by their card path "Cloud Presets/<dir>"."""
    return f"cloud presets/{dir_name}".lower() not in hidden


async def _handle_oss_gallery_list(dir_name_param: str, rel_path_param: str,
                                    include_dirs: bool, include_items: bool,
                                    include_covers: bool, search_mode: bool,
                                    hidden: set | None = None) -> web.Response:
    """Handle /neo_gallery/list for Cloud Presets (OSS remote directories)."""
    oss_index = await _fetch_oss_index()
    if not oss_index:
        return web.json_response({"error": "OSS not configured or index unavailable"}, status=404)

    hidden = hidden or set()
    dir_name_lower = dir_name_param.lower()

    # "Cloud Presets" — show subdirectory cards
    if dir_name_lower == "cloud presets":
        resp_dir = {
            "name": "Cloud Presets",
            "path": "Cloud Presets",
            "read_only": True,
            "source": "oss",
            "subdirs": {k: v for k, v in _oss_dir_cards(oss_index).items()
                        if _oss_dir_visible(k, hidden)},
            "root_count": 0,
            "items": [],
        }

        response_data = {"directories": [resp_dir], "total": 0}
        if include_covers:
            covers = {}
            _collect_oss_covers(covers, oss_index)
            response_data["covers"] = covers
        return web.json_response(response_data)

    # "Cloud Presets/<subdir>" — show items from that subdir
    if dir_name_lower.startswith("cloud presets/"):
        subdir_name = dir_name_param[len("Cloud Presets/"):]
        if subdir_name not in _oss_index_dirs(oss_index):
            return web.json_response({"error": f"OSS directory not found: {subdir_name}"}, status=404)

        if not _oss_dir_visible(subdir_name, hidden):
            return web.json_response({"directories": [], "total": 0})

        items = await _oss_dir_items(oss_index, subdir_name, OSS_NAV_PREFIX)

        resp_dir = {
            "name": f"Cloud Presets/{subdir_name}",
            "path": f"Cloud Presets/{subdir_name}",
            "read_only": True,
            "source": "oss",
            "subdirs": {},
            "root_count": len(items),
            "items": items,
        }

        response_data = {"directories": [resp_dir], "total": len(items)}
        if include_covers:
            covers = {}
            _collect_oss_covers(covers, oss_index)
            response_data["covers"] = covers
        return web.json_response(response_data)

    return web.json_response({"error": "Invalid Cloud Presets path"}, status=400)


@routes.post("/neo_gallery/sync_oss")
async def sync_oss_index(request):
    """Manually trigger OSS index sync (force re-download of index.json).

    逐目录索引同一发一起重拉：只换主索引的话，读磁盘目录缓存的那几页（提示词库的云端配对、素材页封面）
    还停在旧 rev 上，用户在界面上看不出这一发刷新了什么。
    云端提示词目录跟着这一发镜像进提示词池（sync_prompt_mirror）：池子那批 .txt 才是提示词库的卡片单位。
    """
    if not _is_oss_enabled():
        # reason 是给前端的机器可读原因：前端要区分「这一页没有云端预设可刷」与「刷失败了」，
        # 不该去比后端那句英文。
        return web.json_response({"success": False, "error": "OSS not configured",
                                  "reason": "not_configured"}, status=400)

    try:
        index = await _fetch_oss_index(force=True)
        if index:
            refreshed = await _refresh_dir_indexes(index)
            return web.json_response({
                "success": True,
                "directories": len(index.get("directories", {})),
                "items": _oss_total_items(index),
                "refreshed": refreshed,
                "mirror": await sync_prompt_mirror(index),
                "generated_at": index.get("generated_at", ""),
            })
        return web.json_response({"success": False, "error": "Failed to fetch index"}, status=500)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.get("/neo_gallery/oss_status")
async def oss_status(request):
    """Return OSS connection status and cached index info."""
    cfg = _get_oss_config()
    enabled = _is_oss_enabled()
    index = _load_oss_index_from_disk()

    result = {
        "enabled": enabled,
        "index_url": cfg.get("index_url", ""),
        "base_url": cfg.get("base_url", ""),
        "available": index is not None,
    }

    if index:
        result["directories"] = len(index.get("directories", {}))
        result["items"] = _oss_total_items(index)
        result["generated_at"] = index.get("generated_at", "")

    return web.json_response(result)
