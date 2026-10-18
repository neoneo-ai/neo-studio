# SPDX-License-Identifier: Apache-2.0
# Neo Studio — Video Recipe Module
# A recipe = a named combination: prompt text + ordered assets (images/videos),
# stored in its own preset directory with an assets/ folder.
# 收藏（本地/C 站）后端逻辑已统一收敛到 bookmark.py，本模块只保留配方职责。

import os
import re
import io
import json
import shutil
import asyncio
import datetime
import hashlib
import logging
import mimetypes
import tempfile
import zipfile
from pathlib import Path
import aiohttp
from aiohttp import web

routes = web.RouteTableDef()

logger = logging.getLogger(__name__)


from .gallery import (
    AUDIO_EXTENSIONS,
    IMG_EXTENSIONS,
    VIDEO_EXTENSIONS,
    _copy_media_to_input,
)
from .bookmark import (
    _download_bytes,
    _media_ext_from_url_or_bytes,
)
from .gallery_lora import LORA_CACHE_DIR, _load_lora_index
from .util import PrefixFilter, _extract_media_metadata, _json_safe
from . import plugin_paths

logger.addFilter(PrefixFilter())


def _llm():
    """LLM 惰性导入：桌面端只读写配方文件时不加载 LLM 依赖。"""
    from . import llm
    return llm


RECIPES_DIR = plugin_paths.RECIPES_DIR
CUSTOM_DIR = RECIPES_DIR / "custom"      # 用户保存的配方
PRESETS_DIR = RECIPES_DIR / "presets"    # 内置预设（只读）
THUMB_DIR = RECIPES_DIR / ".thumbs"      # 封面/网格缩略图缓存（按内容哈希命名，可整目录删除重建）
THUMB_SIZE = 256                         # 详情网格尺寸；卡片封面用 112

_sanitize_name_re = re.compile(r"[^\w\- ]+")  # keep letters/digits/_/- and spaces


def _ensure_dirs() -> None:
    for d in (RECIPES_DIR, CUSTOM_DIR, PRESETS_DIR, THUMB_DIR):
        d.mkdir(parents=True, exist_ok=True)
    # 旧版直接放在 recipes/ 下的配方目录迁移到 custom/
    for p in RECIPES_DIR.iterdir():
        if p.is_dir() and p.name not in ("custom", "presets") and (p / "recipe.json").exists():
            target = CUSTOM_DIR / p.name
            if not target.exists():
                shutil.move(str(p), str(target))


def _valid_name(name: str) -> bool:
    return bool(name) and ".." not in name and "/" not in name and "\\" not in name


def _find_recipe_dir(name: str) -> Path | None:
    """Locate a recipe folder; user recipes (custom) take precedence over presets."""
    if not _valid_name(name):
        return None
    for base in (CUSTOM_DIR, PRESETS_DIR):
        if (base / name / "recipe.json").is_file():
            return base / name
    return None


def _recipe_asset_path(recipe_dir: Path, file: str, dir_param: str) -> Path | None:
    """配方资产的物理路径：dir=samples 只读示例结果；未指定时 assets 优先、samples 兜底。"""
    search_dirs = [recipe_dir / "samples"] if dir_param == "samples" else [recipe_dir / "assets", recipe_dir / "samples"]
    for base in search_dirs:
        candidate = base / file
        if candidate.is_file():
            return candidate
    return None


def _recipe_thumb_path(source_path: Path, size: int) -> Path:
    """缩略图缓存路径：源文件绝对路径 + 大小 + mtime 参与哈希，覆盖写入后旧缓存自然失效。"""
    stat = source_path.stat()
    key = f"{source_path.resolve().as_posix()}|{stat.st_size}|{int(stat.st_mtime)}"
    return THUMB_DIR / f"{hashlib.md5(key.encode()).hexdigest()[:12]}_{size}.jpg"


def _kind_of(asset_file: Path) -> str:
    if asset_file.suffix.lower() in VIDEO_EXTENSIONS:
        return "video"
    if asset_file.suffix.lower() in AUDIO_EXTENSIONS:
        return "audio"
    return "image"


def _norm_result(ref) -> dict | None:
    """规范化一条配方结果引用：只记 output 目录产物的路径，不复制文件。非法返回 None。"""
    if not isinstance(ref, dict):
        return None
    filename = str(ref.get("filename", "")).strip()
    subfolder = str(ref.get("subfolder", "") or "").strip().strip("/")
    if not _valid_name(filename) or not filename:
        return None
    if ".." in subfolder or "\\" in subfolder:
        return None
    if str(ref.get("type", "output") or "output") != "output":
        return None   # 只记执行产物；input/temp 是输入资产
    kind = str(ref.get("kind", "") or "")
    if kind not in ("image", "video", "audio"):
        kind = _kind_of(Path(filename))
    item = {"filename": filename, "subfolder": subfolder, "kind": kind}
    for key in ("segment", "seed"):   # 单段重生成产物带的来源信息（可选）：面板据此标注「第 k 段」
        if ref.get(key) is not None:
            try:
                item[key] = int(ref[key])
            except (TypeError, ValueError):
                pass
    # layout：拼接成片的真实段边界（逐段保留帧数），供后续单段重生成按该成片取锚点帧
    layout = ref.get("layout")
    if isinstance(layout, (list, tuple)):
        counts = []
        for value in layout:
            try:
                counts.append(int(value))
            except (TypeError, ValueError):
                counts = []
                break
        if counts and all(n > 0 for n in counts):
            item["layout"] = counts
    return item


def _result_path(ref: dict) -> Path | None:
    """结果引用 → 物理文件路径；越出 output 目录或文件不存在返回 None。"""
    import folder_paths as _folder_paths
    name = f"{ref['subfolder']}/{ref['filename']}" if ref.get("subfolder") else ref["filename"]
    try:
        path = Path(_folder_paths.get_annotated_filepath(name, _folder_paths.get_output_directory()))
    except ValueError:
        return None
    return path if path.is_file() else None


def _scan_recipe_dir(recipe_dir: Path, source: str) -> dict | None:
    """Return recipe metadata (name, prompt, asset list + cover) for one folder."""
    meta_path = recipe_dir / "recipe.json"
    if not meta_path.exists():
        return None

    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        return None

    assets_dir = recipe_dir / "assets"
    if not assets_dir.exists():
        empty_dir = True
    else:
        empty_dir = False

    # 优先按 recipe.json 记录的 assets 顺序还原（保存时把前端按参数序号排好的顺序写入）
    ordered = meta.get("assets", [])
    if isinstance(ordered, str):
        ordered = [ordered]

    existing = {}
    # 保存时按加载节点类型记录的 kind 优先；后缀判定仅兜底手动放入的文件
    kinds = meta.get("kinds") or {}
    if not empty_dir:
        for f in assets_dir.iterdir():
            if f.is_file() and f.suffix.lower() in (IMG_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS):
                if f.stem.startswith("_cover") or f.stem.startswith("_preview"):
                    continue  # 元数据封面，不视为资源资产
                existing[f.name] = {"file": f.name, "kind": kinds.get(f.name) or _kind_of(f)}

    assets = []
    for name in ordered:
        if name in existing:
            assets.append(existing.pop(name))
    # 目录里存在但未在 recipe.json 记录的（用户手动放入）按目录顺序补尾
    assets.extend(existing.values())

    # 示例结果（samples/，随保存与侧边栏追加累积，用于封面与预览展示）
    samples_dir = recipe_dir / "samples"
    sample_kinds = meta.get("sample_kinds") or {}
    samples = []
    if samples_dir.exists():
        for f in sorted(samples_dir.iterdir()):
            if f.is_file() and f.suffix.lower() in (IMG_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS):
                if f.stem.startswith("_cover") or f.stem.startswith("_preview"):
                    continue
                samples.append({"file": f.name, "kind": sample_kinds.get(f.name) or _kind_of(f)})

    cover = None
    for name in ("_preview.jpg", "_preview.png", "_cover.jpg", "_cover.png"):
        if (assets_dir / name).exists():
            cover = name
            break
    if cover is None:
        cover = next((s["file"] for s in samples if s["kind"] == "image"), None)
    if cover is None:
        cover = next((a["file"] for a in assets if a["kind"] == "image"), None)

    # 结果路径（results）：只记 output 目录产物，文件被删掉（含在别处删）后自动不再列出
    results = []
    for r in meta.get("results", []) or []:
        item = _norm_result(r)
        if item is None or _result_path(item) is None:
            continue
        results.append({**item, "at": str((r or {}).get("at", "") or "")})

    result = {
        "name": recipe_dir.name,
        "source": source,
        "prompt": meta.get("prompt", ""),
        "created_at": meta.get("created_at", ""),
        "mtime": meta_path.stat().st_mtime,
        "asset_count": len(assets),
        "sample_count": len(samples),
        "cover": cover,
        "assets": assets,
        "loras": meta.get("loras", []) or [],
        "samples": samples,
        "results": results,
        "result_count": len(results),
        "gen_type": meta.get("gen_type", ""),
    }
    # video_director 配方：透传结构化多段字段（缺省 type 的旧扁平配方不受影响）
    if meta.get("type") == "video_director":
        result["type"] = "video_director"
        result["shared"] = meta.get("shared") or {}
        result["segments"] = meta.get("segments") or []
        if meta.get("story"):
            result["story"] = meta["story"]   # 自动故事板内容（可选）：重新打开编辑器时回显
        if meta.get("setup"):
            result["setup"] = meta["setup"]   # 统一设置区状态（可选）：重新打开编辑器时回显
    return result


def _copy_ref_into_dir(ref: dict, dest_dir: Path) -> str | None:
    """Resolve a Comfy file ref {filename, subfolder, type} to its physical path and
    copy it into dest_dir. Deduplicates by content (size + md5) against files already
    in dest_dir; renames on filename collision. Returns the destination filename or None."""
    filename = str(ref.get("filename", "")).strip()
    if not filename or ".." in filename:
        return None

    import folder_paths as _folder_paths

    base_dir = _folder_paths.get_input_directory()
    ftype = ref.get("type", "input")
    if ftype == "output":
        base_dir = _folder_paths.get_output_directory()
    elif ftype == "temp":
        base_dir = _folder_paths.get_temp_directory()

    name = filename
    subfolder = str(ref.get("subfolder", "") or "").strip("/")
    if subfolder:
        name = subfolder + "/" + filename

    try:
        source_path = Path(_folder_paths.get_annotated_filepath(name, base_dir))
    except ValueError:
        source_path = None
    if source_path is None or not source_path.is_file():
        # 引用不在 Comfy 目录里但已是本配方资产（如刚生成的分镜关键帧）：按名沿用，不重复拷贝
        already = dest_dir / Path(filename).name
        return already.name if already.is_file() else None

    source_size = source_path.stat().st_size
    source_md5 = hashlib.md5()
    with source_path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            source_md5.update(chunk)
    source_md5 = source_md5.hexdigest()

    if dest_dir.exists():
        for f in dest_dir.iterdir():
            if not f.is_file() or f.stat().st_size != source_size:
                continue
            h = hashlib.md5()
            with open(f, "rb") as fh:
                for chunk in iter(lambda: fh.read(8192), b""):
                    h.update(chunk)
            if h.hexdigest() == source_md5:
                return f.name

    dest = dest_dir / Path(filename).name
    if dest.exists():
        stem = Path(filename).stem
        ext = Path(filename).suffix
        counter = 1
        while (dest_dir / f"{stem}_{counter}{ext}").exists():
            counter += 1
        dest = dest_dir / f"{stem}_{counter}{ext}"

    shutil.copy2(source_path, dest)
    return dest.name


def _append_samples(recipe_dir: Path, refs: list) -> tuple[int, int]:
    """Append executed-output refs into the recipe's samples dir (content-deduped),
    merging into recipe.json. Returns (added, skipped)."""
    meta_path = recipe_dir / "recipe.json"
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        meta = {}

    samples = meta.get("samples", []) or []
    if isinstance(samples, str):
        samples = [samples]
    sample_kinds = meta.get("sample_kinds", {}) or {}

    samples_dir = recipe_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)

    added = 0
    skipped = 0
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        copied_name = _copy_ref_into_dir(ref, samples_dir)
        if not copied_name:
            continue
        if copied_name in samples:
            skipped += 1
            continue
        samples.append(copied_name)
        kind = str(ref.get("kind", "") or "")
        if kind in ("image", "video", "audio"):
            sample_kinds[copied_name] = kind
        added += 1

    meta["samples"] = samples
    meta["sample_kinds"] = sample_kinds
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return added, skipped


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@routes.post("/rs_recipes/list")
async def rs_recipes_list(request):
    _ensure_dirs()
    recipes = []
    for source, base in (("preset", PRESETS_DIR), ("custom", CUSTOM_DIR)):
        metas = []
        for p in base.iterdir():
            if not p.is_dir():
                continue
            meta = _scan_recipe_dir(p, source)
            if meta:
                metas.append(meta)
        # 最近修改的配方排在最前（新建/复制/保存都会刷新 recipe.json 的 mtime）
        metas.sort(key=lambda m: m.get("mtime") or 0, reverse=True)
        recipes.extend(metas)
    return web.json_response(recipes)


@routes.post("/rs_recipes/load")
async def rs_recipes_load(request):
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        source = "custom" if recipe_dir.parent == CUSTOM_DIR else "preset"
        meta = _scan_recipe_dir(recipe_dir, source)
        return web.json_response({"success": True, "recipe": meta})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

# 每段参考素材上限：与 MiniMaxH3ReferenceToVideo 的 autogrow 槽位一致（图 9 / 视频 3 / 音频 3）
_DIRECTOR_REF_CAPS = {"images": 9, "videos": 3, "audios": 3}

# 段级生成模式（与 ComfyUI_MiniMaxH3_Director 的任务模式对齐）：
# t2v 文生 / i2v 首帧 / l2v 尾帧 / fl2v 首尾帧 / r2v 全参考 / v2v 视频编辑 / rv2v 视频+参考图编辑
# 帧模式（t2v/i2v/l2v/fl2v）载入时一律按段的首/尾帧资产推导（旧显式值静默重映射），不暴露给 UI；
# r2v/v2v/rv2v 保持显式有效。全局可再取 mixed（逐段 seg.mode 生效）
_DIRECTOR_MODES = ("t2v", "i2v", "l2v", "fl2v", "r2v", "v2v", "rv2v")

# 身份参考图上限：与 h3_video_director 的身份继承上限一致（关键帧没脸时靠它保住角色身份）
_DIRECTOR_IDENTITY_CAP = 4


def _normalize_director(data: dict, orig_to_copied: dict, existing_assets: set | None = None) -> tuple[dict, list]:
    """校验并规范化 video_director 配方的 shared/segments；非法抛 ValueError（消息可直接回前端）。

    段级 skill_id / prompt 允许为空（草稿保存：前端只提示、不阻止，执行时再校验）。
    first_frame / refs.* 由前端以**原始文件名**
    引用，orig_to_copied 把原始名映射到已落盘 assets 的最终名（同名不同内容可能被重命名），
    规范化时回写为最终名使 recipe.json 与 assets/ 自洽。existing_assets 是本次保存前已在
    assets/ 的文件名集合：引用这些名字（上次保存回写的最终名）直接保留，重存旧配方不报错。
    v1 执行仅用每段首帧图，其余 refs 原样保留。
    """
    shared_raw = data.get("shared") or {}
    if not isinstance(shared_raw, dict):
        raise ValueError("shared 必须是对象")

    def _si(v, d):
        try:
            return int(v)
        except (TypeError, ValueError):
            return d

    shared = {
        "width": _si(shared_raw.get("width"), 1344),
        "height": _si(shared_raw.get("height"), 768),
        "seed": _si(shared_raw.get("seed"), 0),   # -1 = 每次运行随机取种子
    }
    # 全局生成模式：具体模式全体统一，mixed 每段独立（seg.mode）；缺省不写，执行时按首帧/参考推断
    shared_mode = str(shared_raw.get("mode") or "").strip()
    if shared_mode in _DIRECTOR_MODES + ("mixed",):
        shared["mode"] = shared_mode
    # 身份参考（配方「角色参考图」是否作为各段身份参考）：默认开，编辑器里显式关掉才落盘（对比测试用）
    if shared_raw.get("identity_refs") is False:
        shared["identity_refs"] = False
    # 多帧单次分块秒数：连续兼容段合并成一次 ref2va 运行（总时长 ≤ 该值）；0 = 关闭（纯逐段生成）
    try:
        chunk_sec = float(shared_raw.get("chunk_sec"))
    except (TypeError, ValueError):
        chunk_sec = None
    if chunk_sec is not None and 0 <= chunk_sec <= 120:
        shared["chunk_sec"] = int(chunk_sec)
    # 整片运行参数（编辑器「分镜时间线」页保存，Studio 生成面板只发 recipe/only_segments）：
    # 不给就不落盘，执行时沿用 steps=-1（各段技能 config）、continuity=True、context_frames=22
    if shared_raw.get("steps") is not None:
        shared["steps"] = min(100, max(-1, _si(shared_raw.get("steps"), -1)))
    if shared_raw.get("continuity") is not None:
        shared["continuity"] = bool(shared_raw.get("continuity"))
    if shared_raw.get("context_frames") is not None:
        shared["context_frames"] = min(362, max(0, _si(shared_raw.get("context_frames"), 22)))

    segs_raw = data.get("segments")
    if not isinstance(segs_raw, list) or not segs_raw:
        raise ValueError("video_director 配方至少需要一个段")

    segments = []
    for idx, s in enumerate(segs_raw):
        if not isinstance(s, dict):
            raise ValueError(f"第 {idx + 1} 段不是对象")
        # 提示词 / 技能允许为空（草稿）：前端保存只提示、不阻止，后端同样放行，执行时再校验
        prompt = str(s.get("prompt") or "").strip()
        skill_id = str(s.get("skill_id") or "").strip()

        dur = s.get("duration_sec")
        try:
            dur = float(dur) if dur is not None else None
        except (TypeError, ValueError):
            dur = None

        refs = s.get("refs") or {}
        if not isinstance(refs, dict):
            raise ValueError(f"第 {idx + 1} 段 refs 必须是对象")

        def _resolve_ref(fname, where):
            stored = orig_to_copied.get(str(fname))
            if stored:
                return stored
            if existing_assets and str(fname) in existing_assets:
                return str(fname)   # 上次保存已落盘的资产（回写后的最终名），直接保留
            raise ValueError(f"第 {idx + 1} 段 {where} 引用了未保存的资产：{fname}")

        first_frame = str(s.get("first_frame") or "").strip()
        last_frame = str(s.get("last_frame") or "").strip()
        seg = {"skill_id": skill_id, "prompt": prompt, "duration_sec": dur}
        # 段级模式仅在混合模式下有意义；保留合法值（t2v/i2v/fl2v/r2v/v2v/rv2v），其余丢弃
        seg_mode = str(s.get("mode") or "").strip()
        if seg_mode in _DIRECTOR_MODES:
            seg["mode"] = seg_mode
        if first_frame:
            seg["first_frame"] = _resolve_ref(first_frame, "first_frame")
        if last_frame:
            seg["last_frame"] = _resolve_ref(last_frame, "last_frame")
        # 分镜关键帧：由「生成图片分镜」直接落在配方 assets/，与 first_frame 同源解析。
        # 引用不在资产里（旧配方的 input 产物已清理）时丢掉该引用而不是拒绝保存：
        # 缩略图显示为「无」，重新生成分镜即回填；storyboard_prompt 快照仍保留。
        storyboard = str(s.get("storyboard") or "").strip()
        if storyboard:
            sb_stored = orig_to_copied.get(storyboard)
            if not sb_stored and existing_assets and storyboard in existing_assets:
                sb_stored = storyboard
            if sb_stored:
                seg["storyboard"] = sb_stored
        # storyboard_prompt 是分镜提示词快照（可缺省回落到 prompt）
        storyboard_prompt = str(s.get("storyboard_prompt") or "").strip()
        if storyboard_prompt:
            seg["storyboard_prompt"] = storyboard_prompt
        kept_refs = {}
        for k in ("images", "videos", "audios"):
            vals = [str(x) for x in (refs.get(k) or []) if str(x)][:_DIRECTOR_REF_CAPS[k]]
            if vals:
                kept_refs[k] = [_resolve_ref(v, f"refs.{k}") for v in vals]
        if kept_refs:
            seg["refs"] = kept_refs
        segments.append(seg)
    return shared, segments


def _normalize_director_story(data: dict, orig_to_copied: dict, existing_assets: set | None = None) -> dict | None:
    """规范化自动故事板的可选内容：主题 / 故事脚本 / 角色参考图 / 拆分粒度 / 图片分镜设置。

    参考图 filename 与段首帧一样由前端以原始名引用，这里回写为落盘 assets 的最终名。
    引用未落盘资产的条目直接丢弃：参考图只用于 r2i 图片分镜，缺一条不该让整份配方保存失败。
    image_mode（t2i/r2i）/ frame_source（storyboard/grid）非法值丢弃；image_skill 为所选生图技能 id。
    完全没有内容时返回 None（不写进 recipe.json）。
    """
    raw = data.get("story")
    if not isinstance(raw, dict):
        return None

    def _kept_refs(key):
        kept = []
        for r in (raw.get(key) or []):
            if not isinstance(r, dict):
                continue
            fname = str(r.get("filename") or "").strip()
            stored = orig_to_copied.get(fname)
            if not stored and existing_assets and fname in existing_assets:
                stored = fname   # 上次保存已落盘的参考图（回写后的最终名），直接保留
            if not stored:
                continue
            entry = {"filename": stored}
            desc = str(r.get("desc") or "").strip()
            if desc:
                entry["desc"] = desc
            kept.append(entry)
        return kept

    try:
        segment_seconds = int(raw.get("segment_seconds"))
    except (TypeError, ValueError):
        segment_seconds = None

    # 图片分镜设置：非法/缺省值丢弃（不落盘），前端按默认 t2i + storyboard 回显
    image_mode = str(raw.get("image_mode") or "").strip()
    if image_mode not in ("t2i", "r2i"):
        image_mode = None
    frame_source = str(raw.get("frame_source") or "").strip()
    if frame_source not in ("storyboard", "grid"):
        frame_source = None   # 旧配方的 unified 值随非法值丢弃，前端按默认回落
    image_skill = str(raw.get("image_skill") or "").strip() or None

    story = {
        "idea": str(raw.get("idea") or "").strip() or None,
        "story": str(raw.get("story") or "").strip() or None,
        "characters": _kept_refs("characters"),
        "segment_seconds": segment_seconds,
        "image_mode": image_mode,
        "image_skill": image_skill,
        "frame_source": frame_source,
    }
    if all(v is None or v == [] for v in story.values()):
        return None
    return story


def _normalize_director_setup(data: dict, orig_to_copied: dict, existing_assets: set | None = None) -> dict | None:
    """规范化「🎯 统一设置」区的可选内容：统一参考素材 / 首帧 / 尾帧（编辑器里已选中的状态）+ 优化前后提示词对照。

    仅用于重新打开时回显，执行读各段自己的字段。引用名与段参考一样回写为落盘最终名；
    引用未保存资产的条目直接丢弃——缺一条不该让整份配方保存失败。
    完全没有内容时返回 None（不写进 recipe.json）。
    """
    raw = data.get("setup")
    if not isinstance(raw, dict):
        return None

    def _resolve(fname):
        fname = str(fname or "").strip()
        if not fname:
            return None
        stored = orig_to_copied.get(fname)
        if stored:
            return stored
        if existing_assets and fname in existing_assets:
            return fname   # 上次保存已落盘的资产（回写后的最终名），直接保留
        return None

    def _str_list(key):
        vals = raw.get(key)
        if not isinstance(vals, list):
            return None
        kept = []
        for v in vals:
            s = v.strip() if isinstance(v, str) else (str(v) if isinstance(v, (int, float)) else "")
            if s:
                kept.append(s)
        return kept or None

    refs_raw = raw.get("refs") or {}
    if not isinstance(refs_raw, dict):
        refs_raw = {}
    kept_refs = {}
    for k in ("images", "videos", "audios"):
        vals = [v for v in (_resolve(x) for x in (refs_raw.get(k) or [])) if v][:_DIRECTOR_REF_CAPS[k]]
        if vals:
            kept_refs[k] = vals

    setup = {}
    if kept_refs:
        setup["refs"] = kept_refs
    first_frame = _resolve(raw.get("first_frame"))
    last_frame = _resolve(raw.get("last_frame"))
    if first_frame:
        setup["first_frame"] = first_frame
    if last_frame:
        setup["last_frame"] = last_frame
    orig_prompts = _str_list("orig_prompts")   # 优化前各段原文快照（对照左栏）
    opt_prompts = _str_list("opt_prompts")     # 最近一次优化结果（对照右栏）
    if orig_prompts:
        setup["orig_prompts"] = orig_prompts
    if opt_prompts:
        setup["opt_prompts"] = opt_prompts
    if not kept_refs and not first_frame and not last_frame and not orig_prompts and not opt_prompts:
        return None
    return setup


@routes.post("/rs_recipes/save")
async def rs_recipes_save(request):
    try:
        data = await request.json()
        raw_name = str(data.get("name", "")).strip()
        if not raw_name:
            return web.json_response({"success": False, "error": "Name required"}, status=400)
        name = _sanitize_name_re.sub("", raw_name).strip().replace(" ", "-")
        if not name:
            return web.json_response({"success": False, "error": "Invalid name"}, status=400)

        _ensure_dirs()
        if (PRESETS_DIR / name / "recipe.json").is_file():
            return web.json_response({"success": False, "error": "Name already used by a preset recipe"}, status=409)
        recipe_dir = CUSTOM_DIR / name
        assets_dir = recipe_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)

        # Assets passed as Comfy file refs {filename, subfolder, type, kind}; copy each in.
        # kind 由前端按加载节点类型判定（同一 mp4 既可作视频也可作音频），记录进
        # kinds 映射，扫描时优先使用；后缀判定仅作手动放文件时的兜底。
        copied = []
        kinds = {}
        orig_to_copied = {}   # 原始文件名 → 落盘 assets 的最终名（供 director 段引用回写）

        # 重存同一配方：先读旧 meta，保留磁盘上仍在的既有资产与示例结果（samples 随保存/追加累积）
        old_assets, old_kinds, old_samples, old_sample_kinds, old_results = [], {}, [], {}, []
        meta_path = recipe_dir / "recipe.json"
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    old_meta = json.load(f)
                old_samples = old_meta.get("samples", []) or []
                old_sample_kinds = old_meta.get("sample_kinds", {}) or {}
                old_results = old_meta.get("results", []) or []   # 结果路径是执行历史，重存不清空
                for a in old_meta.get("assets", []) or []:
                    if isinstance(a, str) and (assets_dir / a).is_file():
                        old_assets.append(a)
                for k, v in (old_meta.get("kinds") or {}).items():
                    if (assets_dir / k).is_file():
                        old_kinds[k] = v
            except Exception:
                pass

        for ref in data.get("assets", []) or []:
            if not isinstance(ref, dict):
                continue
            copied_name = _copy_ref_into_dir(ref, assets_dir)
            if copied_name:
                copied.append(copied_name)
                orig_to_copied[str(ref.get("filename", ""))] = copied_name
                kind = str(ref.get("kind", "") or "")
                if kind in ("image", "video", "audio"):
                    kinds[copied_name] = kind

        # 既有资产并入清单（本次未重传的也保留），kinds 同理
        for a in old_assets:
            if a not in copied:
                copied.append(a)
        for k, v in old_kinds.items():
            kinds.setdefault(k, v)

        # 记录当前工作流加载的 LoRA（名称 + 强度），随配方保存便于还原参考
        loras = []
        for lo in (data.get("loras") or []):
            if not isinstance(lo, dict):
                continue
            nm = str(lo.get("name", "") or "").strip()
            if not nm:
                continue
            try:
                st = float(lo.get("strength", 1.0))
            except (TypeError, ValueError):
                st = 1.0
            loras.append({"name": nm, "strength": st})

        rtype = str(data.get("type") or "").strip()
        director_shared, director_segments, director_story, director_setup = None, None, None, None
        if rtype == "video_director":
            # 已落盘 assets（旧清单 + 本次拷贝 + 目录里实际文件，含刚生成的分镜关键帧）：
            # 段 / 故事板参考图引用其中任一名字都合法，重存旧配方不报错
            existing_assets = set(copied)
            existing_assets.update(f.name for f in assets_dir.iterdir() if f.is_file())
            try:
                director_shared, director_segments = _normalize_director(data, orig_to_copied, existing_assets)
            except ValueError as e:
                return web.json_response({"success": False, "error": str(e)}, status=400)
            director_story = _normalize_director_story(data, orig_to_copied, existing_assets)
            director_setup = _normalize_director_setup(data, orig_to_copied, existing_assets)

        recipe = {
            "name": name,
            "prompt": data.get("prompt", ""),
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "assets": copied,
            "kinds": kinds,
            "loras": loras,
            "samples": old_samples,
            "sample_kinds": old_sample_kinds,
            "results": old_results,
            "gen_type": str(data.get("gen_type") or "").strip(),
        }
        if rtype == "video_director":
            recipe["type"] = "video_director"
            recipe["shared"] = director_shared
            recipe["segments"] = director_segments
            if director_story:
                recipe["story"] = director_story
            if director_setup:
                recipe["setup"] = director_setup
        with open(recipe_dir / "recipe.json", "w", encoding="utf-8") as f:
            json.dump(recipe, f, ensure_ascii=False, indent=2)

        # 勾选「同时保存结果」时，本次执行的输出追加进 samples/（内容去重）
        sample_added = 0
        results_refs = [r for r in (data.get("results") or []) if isinstance(r, dict)]
        if results_refs:
            sample_added, _ = _append_samples(recipe_dir, results_refs)

        return web.json_response({"success": True, "name": name, "asset_count": len(copied), "sample_added": sample_added})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.post("/rs_recipes/append_results")
async def rs_recipes_append_results(request):
    """把当前工作流最近一次执行的输出追加为配方示例结果（内容去重）。"""
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        if recipe_dir.parent == PRESETS_DIR:
            return web.json_response({"success": False, "error": "Preset recipes are read-only"}, status=403)
        refs = [r for r in (data.get("results") or []) if isinstance(r, dict)]
        added, skipped = _append_samples(recipe_dir, refs)
        return web.json_response({"success": True, "added": added, "skipped": skipped})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


def add_recipe_results(name: str, refs: list) -> tuple[int, int]:
    """把执行产物的路径并进配方的 results（只记路径不复制文件，按 filename+subfolder 去重）。

    返回 (added, skipped)；配方不存在抛 ValueError（HTTP 语义由调用方决定）。
    """
    recipe_dir = _find_recipe_dir(name)
    if recipe_dir is None:
        raise ValueError(f"配方不存在：{name}")
    meta_path = recipe_dir / "recipe.json"
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception as e:
        raise ValueError(f"配方读取失败：{name}（{e}）")

    results = meta.get("results", []) or []
    if not isinstance(results, list):
        results = []
    seen = {(str(r.get("filename", "")), str(r.get("subfolder", "") or ""))
            for r in results if isinstance(r, dict)}
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    added = 0
    skipped = 0
    for ref in (refs or []):
        item = _norm_result(ref)
        if item is None or _result_path(item) is None:
            continue
        key = (item["filename"], item["subfolder"])
        if key in seen:
            skipped += 1
            continue
        seen.add(key)
        results.append({**item, "at": stamp})
        added += 1

    if added:
        meta["results"] = results
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    return added, skipped


def is_preset_recipe(name: str) -> bool:
    """配方是否为内置预设（只读）。"""
    recipe_dir = _find_recipe_dir(name)
    return recipe_dir is not None and recipe_dir.parent == PRESETS_DIR


def list_recipe_results(name: str) -> list:
    """配方已记录且仍存在的产物（新 → 旧），每项在 results 字段外附 path（物理路径，供内部使用）。"""
    recipe_dir = _find_recipe_dir(name)
    if recipe_dir is None:
        return []
    try:
        with open(recipe_dir / "recipe.json", "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        return []
    out = []
    for ref in reversed(meta.get("results", []) or []):
        item = _norm_result(ref)
        if item is None:
            continue
        path = _result_path(item)
        if path is None:
            continue   # 文件已不在（外部删掉）→ 不列出
        out.append({**item, "at": str((ref or {}).get("at", "") or ""), "path": str(path)})
    return out


@routes.post("/rs_recipes/add_results")
async def rs_recipes_add_results(request):
    """把本次执行产物的路径记进配方 results（只记路径不复制文件，按 filename+subfolder 去重）。"""
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        if recipe_dir.parent == PRESETS_DIR:
            return web.json_response({"success": False, "error": "Preset recipes are read-only"}, status=403)
        added, skipped = add_recipe_results(name, data.get("results") or [])
        return web.json_response({"success": True, "added": added, "skipped": skipped})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.post("/rs_recipes/delete_sample")
async def rs_recipes_delete_sample(request):
    try:
        data = await request.json()
        name = data.get("name", "")
        file = str(data.get("file", ""))
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        if recipe_dir.parent == PRESETS_DIR:
            return web.json_response({"success": False, "error": "Preset recipes are read-only"}, status=403)
        if not file or ".." in file or "/" in file or "\\" in file:
            return web.json_response({"success": False, "error": "Invalid file"}, status=400)

        meta_path = recipe_dir / "recipe.json"
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            return web.json_response({"success": False, "error": "Recipe meta unreadable"}, status=500)

        meta["samples"] = [s for s in (meta.get("samples", []) or []) if s != file]
        meta["sample_kinds"] = {k: v for k, v in (meta.get("sample_kinds", {}) or {}).items() if k != file}
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        target = recipe_dir / "samples" / file
        if target.is_file():
            target.unlink()
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.post("/rs_recipes/delete_result")
async def rs_recipes_delete_result(request):
    """从配方结果里摘掉一条，并删除 output 目录里的真实产物（连同同名 .txt 旁车）。"""
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        if recipe_dir.parent == PRESETS_DIR:
            return web.json_response({"success": False, "error": "Preset recipes are read-only"}, status=403)

        item = _norm_result({"filename": data.get("filename", ""), "subfolder": data.get("subfolder", ""),
                             "kind": data.get("kind", "")})
        if item is None:
            return web.json_response({"success": False, "error": "Invalid file"}, status=400)

        meta_path = recipe_dir / "recipe.json"
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            return web.json_response({"success": False, "error": "Recipe meta unreadable"}, status=500)

        meta["results"] = [r for r in (meta.get("results", []) or []) if not (
            isinstance(r, dict)
            and str(r.get("filename", "")) == item["filename"]
            and str(r.get("subfolder", "") or "") == item["subfolder"]
        )]
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        deleted = False
        target = _result_path(item)
        if target is not None:
            target.unlink()
            deleted = True
            sidecar = target.with_suffix(".txt")   # 提示词元数据旁车，与画廊删除口径一致
            if sidecar.is_file():
                sidecar.unlink()
        return web.json_response({"success": True, "deleted": deleted})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.post("/rs_recipes/delete")
async def rs_recipes_delete(request):
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        if recipe_dir.parent == PRESETS_DIR:
            return web.json_response({"success": False, "error": "Preset recipes are read-only"}, status=403)
        shutil.rmtree(recipe_dir, ignore_errors=True)
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.post("/rs_recipes/copy")
async def rs_recipes_copy(request):
    """复制配方（含资源/示例/director 分段）为新的 custom 配方，自动生成不冲突的名字。"""
    try:
        data = await request.json()
        name = str(data.get("name", "")).strip()
        src = _find_recipe_dir(name)
        if src is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)

        # 目标名：源名-copy，冲突（custom 或 preset 已占用）则 -2/-3...
        candidate = f"{name}-copy"
        n = 2
        while _find_recipe_dir(candidate) is not None:
            candidate = f"{name}-{n}"
            n += 1

        _ensure_dirs()
        dest = CUSTOM_DIR / candidate
        shutil.copytree(src, dest)

        # 改写新目录 recipe.json 的 name，使列表/发送按新名工作
        meta_path = dest / "recipe.json"
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        meta["name"] = candidate
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        return web.json_response({"success": True, "name": candidate})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

# 导演配方模式标签（Readme 展示用）
_README_MODE_LABELS = {
    "cn": {"t2v": "文生视频", "i2v": "图生视频", "l2v": "尾帧", "fl2v": "首尾帧",
           "r2v": "参考生视频", "v2v": "视频编辑", "rv2v": "参考视频编辑",
           "mixed": "混合（逐段）"},
    "en": {"t2v": "text-to-video", "i2v": "image-to-video", "l2v": "last frame",
           "fl2v": "first & last frame",
           "r2v": "reference-to-video", "v2v": "video edit", "rv2v": "reference video edit",
           "mixed": "mixed (per segment)"},
}

# Readme 文案模板（cn/en），占位符：name/type/mode/width/height/total/assets/import_step/use_step
_README_TEMPLATES = {
    "cn": {
        "title": "# 配方包：{name}",
        "contents": "【包内容】", "name_line": "- 配方名：{name}",
        "director_type": "- 类型：分镜视频导演配方（{segs} 段）",
        "normal_type": "- 类型：普通配方（{assets} 个资源）",
        "mode": "- 模式：{mode}", "resolution": "- 分辨率：{width}×{height}",
        "total": "- 总时长 {total}s",
        "samples": "- 示例结果：{samples} 个（samples/ 目录）",
        "usage": "【快速应用】",
        "install_step": "1. 安装 Neo Studio 插件：https://github.com/neoneo-ai/neo-studio",
        "import_step": "2. 在 ComfyUI 侧边栏「配方」页点「📦 导入」，选择本 zip 包完成导入。",
        "use_director": "3. 添加 NeoH3VideoDirector 节点，在 recipe（配方）下拉中选择该配方后运行。",
        "use_normal": '3. 在配方列表点该配方的「✈️ 发送到工作流」，即可将配方包含的图片、音频等参考资源和提示词载入工作流。',
    },
    "en": {
        "title": "# Recipe package: {name}",
        "contents": "[Contents]", "name_line": "- Recipe: {name}",
        "director_type": "- Type: multi-segment video director recipe ({segs} segments)",
        "normal_type": "- Type: standard recipe ({assets} assets)",
        "mode": "- Mode: {mode}", "resolution": "- Resolution: {width}x{height}",
        "total": "- Total duration: {total}s",
        "samples": "- Sample results: {samples} (in samples/)",
        "usage": "[Quick start]",
        "install_step": "1. Install the Neo Studio plugin: https://github.com/neoneo-ai/neo-studio",
        "import_step": '2. In the ComfyUI sidebar, open the "Recipes" page and click "📦 Import" to import this zip.',
        "use_director": "3. Add a NeoH3VideoDirector node, select this recipe from the recipe dropdown, then run it.",
        "use_normal": '3. In the recipe list, click "✈️ Send to workflow" on this recipe to load its prompt and reference assets into the workflow.',
    },
}


def _readme_language(meta: dict) -> str:
    """Readme 语言：远程配置 readme_language（en/cn）优先，auto/缺省按配方名与提示词判断。"""
    try:
        pref = str(_llm()._load_remote_config().get("readme_language", "auto")).lower()
    except Exception:
        pref = "auto"
    if pref in ("en", "cn"):
        return pref
    text = f"{meta.get('name', '')} {meta.get('prompt', '')}"
    return "cn" if _llm()._detect_language(text) == "Chinese" else "en"


def _readme_text(meta: dict) -> str:
    """生成导出包内的 Readme.txt（按配置/自动判断输出中文或英文）：包内容、来源、快速应用。"""
    lang = _readme_language(meta)
    t = _README_TEMPLATES[lang]
    name = meta.get("name", "")
    is_director = meta.get("type") == "video_director"
    lines = [t["title"].format(name=name), "", t["contents"], t["name_line"].format(name=name)]
    if is_director:
        shared = meta.get("shared") or {}
        segs = meta.get("segments") or []
        total = sum(float(s.get("duration_sec") or 0) for s in segs)
        mode = shared.get("mode") or "mixed"
        lines.append(t["director_type"].format(segs=len(segs)))
        if mode:
            lines.append(t["mode"].format(mode=_README_MODE_LABELS[lang].get(mode, mode)))
        if shared.get("width") and shared.get("height"):
            lines.append(t["resolution"].format(width=shared["width"], height=shared["height"]))
        if total:
            lines.append(t["total"].format(total=f"{total:g}"))
    else:
        assets = meta.get("assets") or []
        lines.append(t["normal_type"].format(assets=len(assets)))
    if meta.get("sample_count"):
        lines.append(t["samples"].format(samples=meta["sample_count"]))
    lines += [
        "",
        t["usage"],
        t["install_step"],
        t["import_step"],
        t["use_director"] if is_director else t["use_normal"],
    ]
    return "\n".join(lines) + "\n"


@routes.get("/rs_recipes/export")
async def rs_recipes_export(request):
    """把整个配方目录导出为 zip（顶层目录 = 配方名），包内附中文 Readme.txt（内容/来源/快速应用）。"""
    try:
        name = request.rel_url.query.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        meta = _scan_recipe_dir(recipe_dir, "custom" if recipe_dir.parent == CUSTOM_DIR else "preset")
        if meta is None:
            return web.json_response({"success": False, "error": "Recipe meta unreadable"}, status=500)

        tmpdir = tempfile.mkdtemp(prefix="neo_recipe_export_")
        try:
            staged = Path(tmpdir) / meta["name"]
            shutil.copytree(recipe_dir, staged)
            (staged / "Readme.txt").write_text(_readme_text(meta), encoding="utf-8")
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in sorted(staged.rglob("*")):
                    if f.is_file():
                        zf.write(f, f.relative_to(tmpdir).as_posix())
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

        return web.Response(
            body=buf.getvalue(),
            content_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{meta["name"]}.zip"'},
        )
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.post("/rs_recipes/import")
async def rs_recipes_import(request):
    """导入配方 zip（file 字段）：包内须含 recipe.json；重名自动 -copy/-2/…，落盘到 custom/。"""
    try:
        zip_bytes = None
        reader = await request.multipart()
        async for part in reader:
            if part.name == "file" and part.filename:
                zip_bytes = await part.read()
        if zip_bytes is None:
            return web.json_response({"success": False, "error": "No zip file"}, status=400)

        tmpdir = tempfile.mkdtemp(prefix="neo_recipe_import_")
        try:
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                for info in zf.infolist():
                    parts = [p for p in info.filename.replace("\\", "/").split("/") if p not in ("", ".")]
                    if os.path.isabs(info.filename) or any(p == ".." for p in parts):
                        return web.json_response({"success": False, "error": f"Unsafe path in zip: {info.filename}"}, status=400)
                zf.extractall(tmpdir)

            entries = [e for e in os.listdir(tmpdir) if not e.startswith("__MACOSX") and not e.startswith(".")]
            root = Path(tmpdir)
            if len(entries) == 1 and (root / entries[0]).is_dir():
                root = root / entries[0]
            meta_path = root / "recipe.json"
            if not meta_path.is_file():
                return web.json_response({"success": False, "error": "zip 内未找到 recipe.json"}, status=400)

            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                return web.json_response({"success": False, "error": "Recipe meta unreadable"}, status=500)

            raw_name = str(meta.get("name") or root.name).strip()
            name = _sanitize_name_re.sub("", raw_name).strip().replace(" ", "-")
            if not name:
                return web.json_response({"success": False, "error": "Invalid recipe name"}, status=400)

            # 与既有配方（custom / preset）重名时自动 -copy/-2/…，口径与 copy 端点一致
            candidate = name
            n = 2
            while _find_recipe_dir(candidate) is not None:
                candidate = f"{name}-{'copy' if n == 2 else n}"
                n += 1

            _ensure_dirs()
            dest = CUSTOM_DIR / candidate
            shutil.copytree(root, dest)
            meta["name"] = candidate
            with open(dest / "recipe.json", "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            return web.json_response({"success": True, "name": candidate})
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.get("/rs_recipes/asset")
async def rs_recipes_asset(request):
    recipe = request.rel_url.query.get("recipe", "")
    file = request.rel_url.query.get("file", "")
    if not recipe or not file or ".." in recipe or ".." in file or "/" in file or "\\" in file:
        return web.Response(status=400)

    dir_param = request.rel_url.query.get("dir", "")
    recipe_dir = _find_recipe_dir(recipe)
    asset_path = _recipe_asset_path(recipe_dir, file, dir_param) if recipe_dir is not None else None
    if asset_path is None:
        return web.Response(status=404)

    suffix = asset_path.suffix.lower()
    content_type = "image/png"
    if suffix in VIDEO_EXTENSIONS:
        content_type = "video/mp4"
    elif suffix in AUDIO_EXTENSIONS:
        content_type = mimetypes.guess_type(asset_path.name)[0] or "audio/mpeg"
    elif suffix in IMG_EXTENSIONS:
        content_type = mimetypes.guess_type(asset_path.name)[0] or "image/png"

    with open(asset_path, "rb") as f:
        return web.Response(body=f.read(), content_type=content_type)


@routes.get("/rs_recipes/thumbnail")
async def rs_recipes_thumbnail(request):
    """配方封面/网格缩略图：命中缓存直接回 JPEG，未命中现生成（gallery 的 PIL / ffmpeg 通道）。"""
    recipe = request.rel_url.query.get("recipe", "")
    file = request.rel_url.query.get("file", "")
    if not recipe or not file or ".." in recipe or ".." in file or "/" in file or "\\" in file:
        return web.Response(status=400)

    recipe_dir = _find_recipe_dir(recipe)
    asset_path = _recipe_asset_path(recipe_dir, file, request.rel_url.query.get("dir", "")) if recipe_dir is not None else None
    if asset_path is None:
        return web.Response(status=404)

    try:
        size = max(32, min(int(request.rel_url.query.get("size", THUMB_SIZE)), 1024))
    except ValueError:
        size = THUMB_SIZE

    thumb_path = _recipe_thumb_path(asset_path, size)
    if not thumb_path.is_file():
        from .gallery import _generate_thumbnail   # 循环导入约束：函数内延迟导入
        if not _generate_thumbnail(asset_path, thumb_path, size):
            return web.Response(status=404)

    with open(thumb_path, "rb") as f:
        return web.Response(body=f.read(), content_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=31536000, immutable"})


@routes.get("/rs_recipes/workflow")
async def rs_recipes_workflow(request):
    """Read the ComfyUI workflow/prompt embedded in a recipe sample's metadata."""
    recipe = request.rel_url.query.get("recipe", "")
    file = request.rel_url.query.get("file", "")
    if not recipe or not file or ".." in recipe or ".." in file or "/" in file or "\\" in file:
        return web.Response(status=400)
    recipe_dir = _find_recipe_dir(recipe)
    sample_path = recipe_dir / "samples" / file if recipe_dir else None
    if sample_path is None or not sample_path.is_file():
        return web.Response(status=404)

    raw = _extract_media_metadata(sample_path)
    for key in ("prompt", "workflow"):
        val = raw.get(key)
        if isinstance(val, str):
            try:
                raw[key] = json.loads(val)
            except ValueError:
                raw[key] = None
    prompt = raw.get("prompt")
    workflow = raw.get("workflow")
    return web.json_response(_json_safe({
        "has": bool(prompt or workflow),
        "workflow": workflow if isinstance(workflow, dict) else None,
        "prompt": prompt if isinstance(prompt, dict) else None,
    }))



@routes.post("/rs_recipes/send_to_workflow")
async def rs_recipes_send_to_workflow(request):
    """Copy every asset of a recipe into Comfy's input dir, returning the resolved
    Comfy filename per asset so the frontend can fill load widgets in one pass."""
    try:
        data = await request.json()
        name = data.get("name", "")
        recipe_dir = _find_recipe_dir(name)
        if recipe_dir is None:
            return web.json_response({"success": False, "error": "Recipe not found"}, status=404)
        source = "custom" if recipe_dir.parent == CUSTOM_DIR else "preset"
        meta = _scan_recipe_dir(recipe_dir, source)

        assets_dir = recipe_dir / "assets"
        out_assets = []
        for asset in meta["assets"]:
            asset_path = assets_dir / asset["file"]
            if not asset_path.is_file():
                continue
            resolved, _ = _copy_media_to_input(asset_path, asset["file"])
            out_assets.append({"file": resolved, "kind": asset["kind"]})

        return web.json_response({"success": True, "name": name, "assets": out_assets})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


def list_director_recipes() -> list:
    """返回 type==video_director 的配方名列表（custom 与 presets 合并去重），供 director 节点下拉。

    顺序与配方面板侧栏一致：custom 在前、presets 在后，组内按最近修改时间倒序；
    重名时 custom 优先（与 _find_recipe_dir 一致）。"""
    _ensure_dirs()
    names = []
    seen = set()
    for base in (CUSTOM_DIR, PRESETS_DIR):
        if not base.exists():
            continue
        metas = []
        for d in base.iterdir():
            meta_path = d / "recipe.json"
            if not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if meta.get("type") == "video_director":
                metas.append((meta_path.stat().st_mtime, d.name))
        for _mtime, name in sorted(metas, key=lambda t: t[0], reverse=True):
            if name not in seen:
                seen.add(name)
                names.append(name)
    return names


def _director_identity_images(meta: dict, assets_dir: Path) -> list[str]:
    """配方「角色参考图」（story.characters）→ input 相对名，供视频段身份参考。

    按角色顺序去重、缺文件的跳过、上限 4 张（与 h3_video_director 的身份继承上限一致）。
    """
    story = meta.get("story") if isinstance(meta.get("story"), dict) else {}
    names = []
    for ref in (story.get("characters") or []):
        fn = str((ref or {}).get("filename") or "").strip()
        if not fn or fn in names:
            continue
        src = assets_dir / fn
        if not src.is_file():
            continue
        resolved, _skipped = _copy_media_to_input(src, fn)
        if resolved:
            names.append(resolved)
        if len(names) >= _DIRECTOR_IDENTITY_CAP:
            break
    return names


def load_director_spec(name: str) -> dict:
    """读取 video_director 配方，把每段有效首帧图解析成 input 相对名（复制进 input/）。

    返回 {shared, segments}；segments 每项含 skill_id/prompt/duration_sec/ref_input。
    ref_input 为该段用于 I2V 首帧的 input 文件名（first_frame 或 refs.images[0]，
    i2v/fl2v 段两者皆无时回退该段落盘的分镜关键帧 storyboard），无则 None。
    额外返回 identity_images：配方「角色参考图」解析出的身份参考图（有才写该键），
    供导演运行时给各段注入身份参考（分镜关键帧不含面部时靠它保住角色身份）。
    """
    recipe_dir = _find_recipe_dir(name)
    if recipe_dir is None:
        raise ValueError(f"配方不存在：{name}")
    meta_path = recipe_dir / "recipe.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise ValueError(f"配方读取失败：{name}（{e}）")
    if meta.get("type") != "video_director":
        raise ValueError(f"配方不是 video_director 类型：{name}")

    assets_dir = recipe_dir / "assets"
    director_shared = meta.get("shared") or {}
    shared_mode = str(director_shared.get("mode") or "").strip()
    segments = []
    for seg in (meta.get("segments") or []):
        img = str(seg.get("first_frame") or "").strip()
        if not img:
            imgs = (seg.get("refs") or {}).get("images") or []
            img = str(imgs[0]).strip() if imgs else ""
        ref_input = None
        if img:
            src = assets_dir / img
            if src.is_file():
                resolved, _skipped = _copy_media_to_input(src, img)
                ref_input = resolved
        # 尾帧（首尾帧技能）：与首帧同样解析成 input 相对名
        last_input = None
        last_img = str(seg.get("last_frame") or "").strip()
        if last_img:
            src = assets_dir / last_img
            if src.is_file():
                resolved, _skipped = _copy_media_to_input(src, last_img)
                last_input = resolved
        # 多路参考素材：图 / 视频 / 音频按类型解析成 input 相对名，供参考生视频（ref2va）技能使用
        refs_out = {}
        seg_refs = seg.get("refs") if isinstance(seg.get("refs"), dict) else {}
        for key in _DIRECTOR_REF_CAPS:
            names = []
            for fn in (seg_refs.get(key) or []):
                src = assets_dir / str(fn)
                if not src.is_file():
                    continue
                resolved, _skipped = _copy_media_to_input(src, str(fn))
                names.append(resolved)
            if names:
                refs_out[key] = names
        # 旧 v2v/rv2v 配方携带独立 source_video：并入参考视频首位（第一个参考视频即源视频）
        sv_name = str(seg.get("source_video") or "").strip()
        if sv_name:
            src = assets_dir / sv_name
            if src.is_file():
                resolved, _skipped = _copy_media_to_input(src, sv_name)
                refs_out["videos"] = [resolved] + [v for v in (refs_out.get("videos") or []) if v != resolved]
        # 有效生成模式：帧模式（t2v/i2v/l2v/fl2v）一律按首/尾帧资产推导（旧显式值静默重映射）；
        # 全参考（r2v，含旧 v2v/rv2v）保持显式有效（shared 优先、再段级）
        seg_mode = str(seg.get("mode") or "").strip()
        if last_input and ref_input:
            mode = "fl2v"
        elif ref_input:
            mode = "i2v"
        elif last_input:
            mode = "l2v"
        elif refs_out.get("videos") or refs_out.get("audios"):
            mode = "r2v"
        else:
            mode = "t2v"
        for explicit in (shared_mode, seg_mode):
            if explicit in ("r2v", "v2v", "rv2v"):
                mode = "r2v"
                break
        # 多帧单次分块的关键帧锚点：first_frame 优先，其次分镜图（与模式推断无关，仅分块规划读取）
        keyframe = None
        ff_img = str(seg.get("first_frame") or "").strip()
        if ff_img:
            src = assets_dir / ff_img
            if src.is_file():
                keyframe, _skipped = _copy_media_to_input(src, ff_img)
        else:
            sb_key = str(seg.get("storyboard") or "").strip()
            if sb_key:
                src = assets_dir / sb_key
                if src.is_file():
                    keyframe, _skipped = _copy_media_to_input(src, sb_key)
        segments.append({
            "skill_id": str(seg.get("skill_id") or ""),
            "prompt": seg.get("prompt", ""),
            "duration_sec": seg.get("duration_sec"),
            "ref_input": ref_input,
            "last_input": last_input,
            "refs": refs_out,
            "mode": mode,
            "keyframe": keyframe,
        })
    out = {"shared": director_shared, "segments": segments}
    # 身份参考默认开（配方「角色参考图」→ 各段身份参考）；配方里显式关掉时既不解析也不注入
    if director_shared.get("identity_refs") is not False:
        identity_images = _director_identity_images(meta, assets_dir)
        if identity_images:
            out["identity_images"] = identity_images
    return out


def _director_default_dims(segments, shared=None):
    """取 director 节点 widget 动态填充的默认值：width/height/steps 优先配方 shared（编辑器保存值），
    缺省时回退首段 skill config；无有效段或读取失败回退 H3 默认。"""
    width, height, steps = 1344, 768, 20
    try:
        from .skill import get_skill_gen_config
        from .h3_video_gen import _resolve_skill_id
        for seg in segments or []:
            sid = str((seg or {}).get("skill_id") or "").strip()
            if not sid:
                continue
            cfg = get_skill_gen_config(_resolve_skill_id(sid)) or {}
            width = int(cfg.get("width") or 1344)
            height = int(cfg.get("height") or 768)
            steps = int(cfg.get("steps") or 20)
            break
    except Exception:
        pass
    shared = shared or {}
    if int(shared.get("width") or 0) > 0:
        width = int(shared["width"])
    if int(shared.get("height") or 0) > 0:
        height = int(shared["height"])
    if int(shared.get("steps") or 0) > 0:
        steps = int(shared["steps"])
    return {"width": width, "height": height, "steps": steps}


@routes.get("/rs_recipes/director_spec")
async def rs_recipes_director_spec(request):
    """返回 video_director 配方的 {shared, segments}（首帧已解析为 input 名），供节点时间轴预览。"""
    name = (request.rel_url.query.get("name") or "").strip()
    if not name:
        return web.json_response({"success": False, "error": "缺少配方名"}, status=400)
    try:
        # load_director_spec 会把每段首/尾帧与参考素材复制进 input/，逐文件同步 I/O；
        # 桌面端所有请求共用一个事件循环，这段留在循环上会把并发的首页 list 挤到几秒后。
        spec = await asyncio.to_thread(load_director_spec, name)
        defaults = await asyncio.to_thread(_director_default_dims,
                                           spec.get("segments") or [], spec.get("shared"))
        return web.json_response({"success": True, "name": name, **spec, "defaults": defaults})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


def _read_input_image_bytes(filename, subfolder=""):
    """读取 input/ 下图片字节，供多模态 LLM 参考；读不到返回 None。"""
    filename = str(filename or "").strip()
    if not filename or ".." in filename:
        return None
    import folder_paths as _fp
    name = filename
    subfolder = str(subfolder or "").strip("/")
    if subfolder:
        name = subfolder + "/" + filename
    try:
        p = Path(_fp.get_annotated_filepath(name, _fp.get_input_directory()))
    except ValueError:
        return None
    if not p.is_file():
        return None
    return p.read_bytes()


def _collect_ref_bytes(refs):
    """从 [{filename, subfolder?}] 里 best-effort 读图片字节列表（缺失跳过）。"""
    byte_list = []
    for r in (refs or []):
        if not isinstance(r, dict):
            continue
        fn = str(r.get("filename") or "").strip()
        if not fn:
            continue
        b = _read_input_image_bytes(fn, r.get("subfolder"))
        if b:
            byte_list.append(b)
    return byte_list


def _parse_segments(raw):
    """把 LLM 返回的分段文本解析为 [{prompt, duration_sec, storyboard_prompt?}]；容错剥掉 ```json 包裹与多余文字。"""
    if not raw:
        return []
    text = str(raw).strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("["), text.rfind("]")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    try:
        data = json.loads(text)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or "").strip()
        if not prompt:
            continue
        try:
            dur = int(round(float(item.get("duration_sec"))))
        except (TypeError, ValueError):
            dur = 0
        entry = {"prompt": prompt, "duration_sec": dur}
        sb_prompt = str(item.get("storyboard_prompt") or "").strip()
        if sb_prompt:
            entry["storyboard_prompt"] = sb_prompt
        out.append(entry)
    return out


@routes.post("/rs_recipes/director_generate_segments")
async def rs_recipes_director_generate_segments(request):
    """文字故事板一步到位：主题（idea）或已写好的故事脚本（script）→ LLM 直接输出分段 JSON
    （每段 prompt / duration_sec / storyboard_prompt）。角色参考图以多模态附上锁角色身份，
    provider 不支持视觉时自动回退纯文本。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是有效 JSON"}, status=400)
    idea = str(data.get("idea") or "").strip()
    script = str(data.get("script") or "").strip()
    if not idea and not script:
        return web.json_response({"success": False, "error": "请填写故事主题"}, status=400)
    try:
        seg_sec = int(data.get("segment_seconds") or 5)   # 缺省 5 秒：出片默认一段短片，多段由调用方点名
    except (TypeError, ValueError):
        seg_sec = 5
    seg_sec = max(1, min(3600, seg_sec))

    parts = [f"目标每段时长：约 {seg_sec} 秒", ""]
    if script:
        parts.append("已确认的故事脚本（按原剧情拆分，不要改写情节）：\n" + script)
    else:
        parts.append("故事主题 / 想法：\n" + idea)

    char_names = [str(n).strip() for n in (data.get("characters") or []) if str(n or "").strip()]
    result = await asyncio.to_thread(
        _llm().run_llm_task, "director_story", "\n".join(parts),
        images=_collect_ref_bytes([{"filename": n} for n in dict.fromkeys(char_names)]) or None)
    if "error" in result:
        return web.json_response({"success": False, "error": result["error"]}, status=422)
    segments = _parse_segments(result.get("segments") or "")
    if not segments:
        return web.json_response({"success": False, "error": "生成结果解析失败，请重试"}, status=422)
    return web.json_response({"success": True, "segments": segments})


def _llm_sse_response(gen, empty_msg):
    """把 llm.run_llm_task_stream 生成器包成 SSE 响应：只推正文（过滤 thinking），空结果补 [ERROR]，末尾 [DONE]。"""
    async def event_stream():
        loop = asyncio.get_running_loop()

        def next_chunk():
            try:
                return next(gen)
            except StopIteration:
                return None

        acc = []
        while True:
            chunk = await loop.run_in_executor(None, next_chunk)
            if chunk is None:
                break
            if chunk.get("kind", "content") == "thinking":
                continue   # 思考过程不进提示词正文
            text = chunk.get("text") or ""
            acc.append(text)
            yield ("data: " + json.dumps({"text": text}) + "\n\n").encode()
        if not "".join(acc).strip():
            yield ("data: " + json.dumps({"text": f"[ERROR] {empty_msg}"}) + "\n\n").encode()
        yield b"data: [DONE]\n\n"

    return web.Response(body=event_stream(), content_type="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@routes.post("/rs_recipes/director_optimize_prompts")
async def rs_recipes_director_optimize_prompts(request):
    """把单段提示词按 H3 官方格式重写（段落结构 / 参考标签 / 时间戳）。前端逐段循环调用，一次一段；SSE 流式回传正文。"""
    try:
        data = await request.json()
    except Exception:
        return web.Response(text="data: [ERROR] 请求体不是有效 JSON\n\ndata: [DONE]\n\n", content_type="text/event-stream")
    prompt = str(data.get("prompt") or "").strip()
    if not prompt:
        return web.Response(text="data: [ERROR] 没有提示词可优化\n\ndata: [DONE]\n\n", content_type="text/event-stream")
    logger.info("[Neo Studio] director_optimize_prompts: prompt_len=%d, duration_sec=%s", len(prompt), data.get("duration_sec"))
    try:
        dur = int(round(float(data.get("duration_sec"))))
    except (TypeError, ValueError):
        dur = 0

    mode = str(data.get("mode") or "t2v").strip()
    # 该段自己的参考素材（仅全参考模式由前端携带）：清单写进本段块内，<Picture N> 等标签按本段顺序编号
    ref_lines = []
    image_names = []
    seg_refs = data.get("refs") or {}
    if not isinstance(seg_refs, dict):
        seg_refs = {}
    for key, label, tag in (("images", "参考图", "Picture"), ("videos", "参考视频", "Video"), ("audios", "参考音频", "Audio")):
        names = [str(n).strip() for n in (seg_refs.get(key) or []) if str(n or "").strip()]
        if not names:
            continue
        if key == "images":
            image_names.extend(names)
        ref_lines.append(f"{label}（在提示词中按顺序引用为 <{tag} 1>…<{tag} {len(names)}>）：")
        ref_lines.extend(f"- {n}" for n in names)

    parts = [f"生成模式：{mode}", f"本段时长：约 {dur} 秒", ""]
    if ref_lines:
        parts.append("\n".join(ref_lines) + "\n")
    parts.append("该段现有提示词（重写为一条成品提示词）：\n" + prompt)
    images = _collect_ref_bytes([{"filename": n} for n in dict.fromkeys(image_names)]) or None
    return _llm_sse_response(_llm().run_llm_task_stream("director_optimize", "\n".join(parts), images=images), "优化结果为空，请重试")


@routes.post("/rs_recipes/director_modify_segment")
async def rs_recipes_director_modify_segment(request):
    """单段提示词修改：现有提示词 + 用户修改指令 → LLM 按 H3 格式输出修改后的成品提示词；SSE 流式回传。"""
    try:
        data = await request.json()
    except Exception:
        return web.Response(text="data: [ERROR] 请求体不是有效 JSON\n\ndata: [DONE]\n\n", content_type="text/event-stream")
    prompt = str(data.get("prompt") or "").strip()
    instruction = str(data.get("instruction") or "").strip()
    if not prompt and not instruction:
        return web.Response(text="data: [ERROR] 没有提示词或修改指令\n\ndata: [DONE]\n\n", content_type="text/event-stream")
    logger.info("[Neo Studio] director_modify_segment: prompt_len=%d, instruction='%s'", len(prompt), instruction[:80])
    try:
        dur = int(round(float(data.get("duration_sec"))))
    except (TypeError, ValueError):
        dur = 0

    mode = str(data.get("mode") or "t2v").strip()
    ref_lines = []
    image_names = []
    seg_refs = data.get("refs") or {}
    if not isinstance(seg_refs, dict):
        seg_refs = {}
    for key, label, tag in (("images", "参考图", "Picture"), ("videos", "参考视频", "Video"), ("audios", "参考音频", "Audio")):
        names = [str(n).strip() for n in (seg_refs.get(key) or []) if str(n or "").strip()]
        if not names:
            continue
        if key == "images":
            image_names.extend(names)
        ref_lines.append(f"{label}（在提示词中按顺序引用为 <{tag} 1>…<{tag} {len(names)}>）：")
        ref_lines.extend(f"- {n}" for n in names)

    parts = [f"生成模式：{mode}", f"本段时长：约 {dur} 秒", ""]
    if ref_lines:
        parts.append("\n".join(ref_lines) + "\n")
    if prompt:
        parts.append("该段现有提示词：\n" + prompt)
    if instruction:
        parts.append("修改指令：\n" + instruction)
    images = _collect_ref_bytes([{"filename": n} for n in dict.fromkeys(image_names)]) or None
    return _llm_sse_response(_llm().run_llm_task_stream("director_modify_segment", "\n".join(parts), images=images), "修改结果为空，请重试")


@routes.post("/rs_recipes/grid_split")
async def rs_recipes_grid_split(request):
    """宫格图自动切分：均匀间隙检测（或手动行列）→ 各格落 input/，返回文件名与预览地址；
    另从原图元信息（ComfyUI 写进 PNG 的 API 格式 prompt）里提取该宫格图包含的提示词（`prompts`）。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是有效 JSON"}, status=400)
    filename = str(data.get("filename") or "").strip()
    if not filename or ".." in filename:
        return web.json_response({"success": False, "error": "缺少有效的图片文件名"}, status=400)
    rows = data.get("rows")
    cols = data.get("cols")

    def _si(v):
        try:
            n = int(v)
        except (TypeError, ValueError):
            return None
        return n if 1 <= n <= MAX_GRID_CELLS else None

    import folder_paths as _fp
    from PIL import Image
    from .grid_split import MAX_GRID_CELLS, detect_grid, metadata_prompts, split_image, trim_cell
    try:
        src = Path(_fp.get_annotated_filepath(filename, _fp.get_input_directory()))
    except ValueError:
        return web.json_response({"success": False, "error": f"无法定位图片：{filename}"}, status=400)
    if not src.is_file():
        return web.json_response({"success": False, "error": f"图片不存在：{filename}"}, status=404)
    try:
        img = Image.open(src)
        info = dict(img.info)   # 原图元信息（PNG 文本块）：切出来的格子不带元信息，提示词只能从原图取
        img = img.convert("RGB")
        grid = detect_grid(img, rows=_si(rows), cols=_si(cols))
        cells = split_image(img, grid)
    except Exception as e:
        return web.json_response({"success": False, "error": f"切分失败：{e}"}, status=500)

    stamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    out_dir = _fp.get_input_directory()
    panels = []
    for i, cell in enumerate(cells):
        cell = trim_cell(cell)
        name = f"neo_grid_{stamp}_{i:02d}.png"
        cell.save(Path(out_dir) / name)
        panels.append({
            "filename": name,
            "width": cell.width,
            "height": cell.height,
            "preview_url": f"/view?filename={name}&subfolder=&type=input",
        })
    return web.json_response({"success": True, "rows": grid["rows"], "cols": grid["cols"],
                              "panels": panels, "prompts": metadata_prompts(info)})


@routes.post("/rs_recipes/image_sizes")
async def rs_recipes_image_sizes(request):
    """批量读图片尺寸（首帧比例一致性检查用）：input/ 优先、配方 assets 兜底，非图片/缺失跳过。"""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "请求体不是有效 JSON"}, status=400)
    filenames = data.get("filenames") or []
    if not isinstance(filenames, list):
        return web.json_response({"success": False, "error": "filenames 必须是数组"}, status=400)
    recipe = str(data.get("recipe") or "").strip()

    import folder_paths as _fp
    from PIL import Image
    in_dir = Path(_fp.get_input_directory())
    recipe_dir = _find_recipe_dir(recipe) if recipe else None
    sizes = []
    for name in filenames[:64]:
        name = str(name or "").strip()
        if not name or ".." in name:
            continue
        candidates = [in_dir / name]
        if recipe_dir is not None:
            candidates.append(recipe_dir / "assets" / name)
        for path in candidates:
            if not path.is_file():
                continue
            try:
                with Image.open(path) as im:
                    sizes.append({"filename": name, "width": im.width, "height": im.height})
            except Exception:
                pass
            break
    return web.json_response({"success": True, "sizes": sizes})


@routes.post("/rs_recipes/director_describe_panel")
async def rs_recipes_director_describe_panel(request):
    """宫格拆分后逐格 LLM 描述（单格）：一张分镜图（该段首帧，多模态）→ 一条 H3 i2v 成品提示词。

    前端按格子自动循环调用本端点，每次只处理一格，降低单次大模型负担并支持逐格进度反馈。"""
    try:
        data = await request.json()
    except Exception:
        return web.Response(text="data: [ERROR] 请求体不是有效 JSON\n\ndata: [DONE]\n\n", content_type="text/event-stream")
    name = str(data.get("panel") or "").strip()
    if not name:
        return web.Response(text="data: [ERROR] 缺少格子图\n\ndata: [DONE]\n\n", content_type="text/event-stream")
    logger.info("[Neo Studio] director_describe_panel: panel='%s', duration_sec=%s", name, data.get("duration_sec"))
    try:
        dur = int(round(float(data.get("duration_sec") or 5)))
    except (TypeError, ValueError):
        dur = 5
    lines = [f"这是分镜图（该段首帧），本段约 {dur} 秒。以画面锁定人物/场景/风格，重点写出这一段发生的故事情节与动作推进（不要复述画面内容），生成一条可直接提交的 H3 i2v 成品提示词。"]
    # 宫格拆分上下文（全部可选，缺失/非法时静默降级为仅图+时长）：本格序号、九宫格行列、全局故事参考（原宫格提示词）、上一段结果
    def _opt_int(v):
        try:
            return int(round(float(v)))
        except (TypeError, ValueError):
            return None

    idx = _opt_int(data.get("panel_index"))
    total = _opt_int(data.get("panel_total"))
    if idx is not None and total is not None and 1 <= idx <= total:
        pos = f"这一段是整片的第 {idx} 段（共 {total} 段）"
        rn, cn = _opt_int(data.get("rows")), _opt_int(data.get("cols"))
        if rn and cn and rn * cn == total:
            r, c = (idx - 1) // cn + 1, (idx - 1) % cn + 1
            pos += f"，对应 {rn}×{cn} 九宫格分镜图的第 {idx} 格（第 {r} 行第 {c} 列，行优先）"
        lines.append(pos + "。请按该段在全片中的位置安排动作承接与情绪走向，不要复述其它格的内容。")
    raw_prompts = data.get("grid_prompts")
    grid_prompts = [str(t).strip() for t in raw_prompts if str(t or "").strip()] if isinstance(raw_prompts, list) else []
    if grid_prompts:
        lines.append("全局故事参考（仅供理解全片故事与风格，不要照抄进视频提示词）：\n" + "\n".join(grid_prompts))
    prev = str(data.get("prev_prompt") or "").strip()
    if prev:
        head = f"上一段（第 {idx - 1} 段）已生成的提示词" if idx else "上一段已生成的提示词"
        lines.append(f"{head}，本段需与之承接、避免重复：\n{prev}")
    text = "\n".join(lines)
    return _llm_sse_response(_llm().run_llm_task_stream("director_panel_describe", text, images=_collect_ref_bytes([{"filename": name}]) or None), "描述结果为空，请重试")



def _normalize_loras(raw) -> list:
    """Coerce an untrusted loras payload into [{name, strength}] (strength default 1.0)."""
    out = []
    for lo in (raw or []):
        if not isinstance(lo, dict):
            continue
        nm = str(lo.get("name", "") or "").strip()
        if not nm:
            continue
        try:
            st = float(lo.get("strength", 1.0))
        except (TypeError, ValueError):
            st = 1.0
        out.append({"name": nm, "strength": st})
    return out


@routes.post("/rs_recipes/save_from_civitai")
async def rs_recipes_save_from_civitai(request):
    """Create a user recipe from resolved Civitai metadata, downloading example media."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)

    name = _sanitize_name_re.sub("_", str(data.get("name") or "").strip())[:60]
    if not name:
        name = f"civitai_{int(datetime.datetime.now().timestamp())}"
    prompt = str(data.get("prompt") or "")
    images = data.get("images") or []
    if isinstance(images, str):
        images = [images]
    loras = _normalize_loras(data.get("loras"))

    recipe_dir = CUSTOM_DIR / name
    samples_dir = recipe_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)

    # 下载示例图到 samples/（作为配方封面与预览）
    samples = []
    sample_kinds = {}
    async with aiohttp.ClientSession() as session:
        for url in images[:8]:
            if not isinstance(url, str) or not url.startswith("http"):
                continue
            blob = await _download_bytes(session, url)
            if not blob:
                continue
            target = samples_dir / (f"sample_{len(samples):02d}" + _media_ext_from_url_or_bytes(url, blob))
            with open(target, "wb") as f:
                f.write(blob)
            samples.append(target.name)
            sample_kinds[target.name] = _kind_of(target)

    recipe = {
        "name": name,
        "prompt": prompt,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "assets": [],
        "kinds": {},
        "loras": loras,
        "samples": samples,
        "sample_kinds": sample_kinds,
        "source": "civitai",
        "civitai_model_id": data.get("model_id"),
    }
    with open(recipe_dir / "recipe.json", "w", encoding="utf-8") as f:
        json.dump(recipe, f, indent=2)
    return web.json_response({"success": True, "name": name, "samples": samples})


@routes.get("/rs_recipes/cached_loras")
async def rs_recipes_cached_loras(request):
    """List locally-cached Civitai LORAs (gallery lora cache) usable as recipe sources."""
    index = _load_lora_index()
    items = []
    for rel, info in index.items():
        if not isinstance(info, dict) or info.get("status") != "ok" or not info.get("cache_dir"):
            continue
        cache_dir = info["cache_dir"]
        preview = None
        cdir = LORA_CACHE_DIR.joinpath(*cache_dir.split("/"))
        if cdir.is_dir():
            for p in sorted(cdir.iterdir()):
                if p.is_file() and p.suffix.lower() in (IMG_EXTENSIONS | VIDEO_EXTENSIONS):
                    preview = {"filename": p.name, "subfolder": f"Lora/{cache_dir}"}
                    break
        items.append({
            "lora_rel": rel,
            "model_name": info.get("model_name") or "",
            "version_name": info.get("version_name") or "",
            "images": int(info.get("images") or 0),
            "preview": preview,
        })
    return web.json_response({"success": True, "items": items})


@routes.post("/rs_recipes/save_from_cached_lora")
async def rs_recipes_save_from_cached_lora(request):
    """Create a user recipe from a locally-cached Civitai LORA (media + prompt from cache)."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)
    lora_rel = str(data.get("lora_rel") or "").strip()
    info = _load_lora_index().get(lora_rel)
    if not isinstance(info, dict) or info.get("status") != "ok" or not info.get("cache_dir"):
        return web.json_response({"success": False, "error": "该 LORA 无缓存数据"}, status=404)

    cdir = LORA_CACHE_DIR.joinpath(*info["cache_dir"].split("/"))
    if not cdir.is_dir():
        return web.json_response({"success": False, "error": "缓存目录不存在"}, status=404)

    model_name = info.get("model_name") or Path(lora_rel).stem
    name = _sanitize_name_re.sub("_", str(data.get("name") or model_name).strip())[:60]
    if not name:
        name = f"lora_{int(datetime.datetime.now().timestamp())}"
    recipe_dir = CUSTOM_DIR / name
    samples_dir = recipe_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=True)

    # 复制缓存示例图到 samples/，并读取首个示例的提示词
    prompt = ""
    samples = []
    sample_kinds = {}
    for p in sorted(cdir.iterdir()):
        if not p.is_file() or p.suffix.lower() not in (IMG_EXTENSIONS | VIDEO_EXTENSIONS):
            continue
        if len(samples) >= 8:
            break
        dest = samples_dir / p.name
        shutil.copy2(p, dest)
        samples.append(dest.name)
        sample_kinds[dest.name] = _kind_of(dest)
        if not prompt:
            txt = p.with_suffix(".txt")
            if txt.is_file():
                try:
                    prompt = txt.read_text(encoding="utf-8").strip()
                except Exception:
                    pass

    recipe = {
        "name": name,
        "prompt": prompt,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "assets": [],
        "kinds": {},
        "loras": [{"name": Path(lora_rel).stem, "strength": 1.0}],
        "samples": samples,
        "sample_kinds": sample_kinds,
        "source": "civitai",
    }
    with open(recipe_dir / "recipe.json", "w", encoding="utf-8") as f:
        json.dump(recipe, f, indent=2)
    return web.json_response({"success": True, "name": name, "samples": samples})