#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
Neo Studio — 提示词库封面回填（数据初始化脚本）

出图页与视频页的产物落在 ComfyUI 的 output 里：图旁有同名 .txt 旁车，图与视频内部还带着
ComfyUI 写的元数据（`studio/util.py` 的 `_extract_media_metadata`）。这一发把两边对上：
每条没有封面的自定义提示词，从产物里挑出「就是用它生成的那一条」，按提示词库封面的同一份
口径写 `<正文>.jpg` 边车（512px 长边的 JPEG；视频取首帧）。默认只出报告，`--apply` 才写。

用法（数据根按 plugin_paths 那三步解析；ComfyUI 根取 data/launcher_config.json）:
    python tools\\fill_prompt_covers.py                      # 只看报告
    python tools\\fill_prompt_covers.py --apply              # 写缺的封面
    python tools\\fill_prompt_covers.py D:\\ComfyUI --apply  # 指定 ComfyUI 根
    python tools\\fill_prompt_covers.py --output-dir D:\\其他产物 --loose --limit 20

参数:
    COMFYUI_ROOT         位置参数：ComfyUI 根，扫 <根>/output
    --output-dir DIR     额外的产物目录，可重复（默认再扫数据根的 gallery/custom）
    --data-root DIR      数据根（prompts/custom 落点）
    --apply              写封面；默认 dry-run 只出报告
    --overwrite          已有封面的条也重写
    --loose              允许「首行出现在元数据文本里」的包含匹配（默认只认整行相等）
    --limit N            最多处理前 N 条（按正文 mtime 倒序，与列表同序）
"""
from __future__ import annotations

import argparse
import importlib.machinery
import json
import os
import shutil
import subprocess
import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLUGIN = "comfyui-neo-studio"
LAUNCHER = REPO / "data" / "launcher_config.json"
# 归一化后短于这个长度的首行没有判别力：一句「你好」能对上任何一张图，跳过不比对
MIN_MATCH_CHARS = 10
# --loose 的包含匹配下限：短句子串到处都在，首行至少这么长才配得上「这张就是它出的」
# （中文一句正文 12 个字起，拉丁文这一发是整句提示词，同一个下限都拦得住杂值）
LOOSE_MATCH_CHARS = 12
TIER_LABELS = {1: "旁车", 2: "元数据", 3: "包含匹配"}


def load_studio():
    """按 conftest 的同一套办法导入插件叶子模块：占位包顶住 studio 这个名字，插件入口不执行。"""
    sys.path.insert(0, str(REPO))
    if "studio" not in sys.modules:
        pkg = types.ModuleType("studio")
        pkg.__path__ = [str(REPO / "studio")]
        pkg.__spec__ = importlib.machinery.ModuleSpec("studio", None, is_package=True)
        sys.modules["studio"] = pkg
    from studio import plugin_paths, prompt_names, util
    return plugin_paths, prompt_names, util


def comfyui_root(argv: list[str]) -> Path:
    """ComfyUI 根：命令行给的第一条，其次 launcher_config.json 的 root，最后仓库同级的 ComfyUI。"""
    for arg in argv[1:]:
        if not arg.startswith("-") and (Path(arg) / "custom_nodes").is_dir():
            return Path(arg)
    try:
        root = Path(str(json.loads(LAUNCHER.read_text(encoding="utf-8")).get("root", "")))
        if (root / "custom_nodes" / PLUGIN).is_dir():
            return root
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        pass
    return REPO.parent / "ComfyUI"


def norm(text: str) -> str:
    """比对用的归一化：空白全去 —— 旁车与元数据里的空格换行差异不算差异"""
    return "".join(str(text or "").split())


def is_video_pool(scan_name: str) -> bool:
    """视频池的条目：`video/` 目录下的正文（约定见 prompt_names），`_V_` 前缀是兼容路径"""
    segments = [p.lower() for p in scan_name.replace("\\", "/").split("/")]
    return "video" in segments[:-1] or "_v_" in segments[-1]


def prompt_first_line(txt_path: Path) -> str:
    """正文首行 = 提示词本体（保存侧写入的第一行，与出图旁车同一条约定）"""
    try:
        with open(txt_path, "r", encoding="utf-8", errors="replace") as f:
            return f.readline().strip()
    except OSError:
        return ""


def media_texts(media: Path, util) -> tuple[list[str], list[str]]:
    """一条产物的来路文本：(旁车首行, 内嵌元数据里的提示词候选)。

    旁车是出图与出视频写的同名 .txt（首行提示词）；内嵌元数据是 ComfyUI 写的 PNG tEXt 与
    mp4 ilst —— `_collect_prompt_texts` 只吃节点里真做提示词的那几个字段，前端导出的
    workflow JSON 里节点 widgets_values 那句提示词也算来路。整份是工作流 JSON 的旁车不是提示词。
    """
    sidecar: list[str] = []
    side_path = media.with_name(media.name + ".txt")
    if side_path.is_file():
        try:
            with open(side_path, "r", encoding="utf-8", errors="replace") as f:
                head = f.readline().strip()
            if head and not head.startswith("{"):  # 整份是工作流 JSON 的旁车不是提示词
                sidecar.append(head)
        except OSError:
            pass
    loose_pool: list[str] = []
    for _key, val in util._extract_media_metadata(media).items():
        graph = val
        if isinstance(val, str):
            try:
                graph = json.loads(val)
            except json.JSONDecodeError:
                graph = None
        if isinstance(graph, dict):
            if "nodes" in graph and isinstance(graph["nodes"], list):
                for node in graph["nodes"]:
                    values = node.get("widgets_values") or [] if isinstance(node, dict) else []
                    loose_pool.extend(v for v in values if isinstance(v, str) and len(v.strip()) >= 8)
            else:
                loose_pool.extend(util._collect_prompt_texts(graph)["positive"])
        elif isinstance(val, str) and len(val.strip()) >= 8:
            loose_pool.append(val)
    return sidecar, loose_pool


def match_tier(key: str, exact: set, meta: set, blob: str, loose: bool) -> int:
    """一条产物对一条提示词的匹配档：1 旁车整行相等，2 内嵌元数据整行相等，3 是 --loose 的包含；对不上回 0。

    key 是归一化后的正文首行，短于判别力下限的条不参与——一句「你好」能对上任何一张图。
    """
    if len(key) < MIN_MATCH_CHARS:
        return 0
    if key in exact:
        return 1
    if key in meta:
        return 2
    if loose and len(key) >= LOOSE_MATCH_CHARS and key in blob:
        return 3
    return 0


def media_entries(media: list[Path], util) -> list[dict]:
    """把每条产物读成一条比对用的条目：旁车整行、元数据整行、--loose 用的拼接文本。

    元数据每条产物只读一次：1293 次文件打开，比对是内存里的集合查找，逐条提示词不再重开文件。
    """
    entries = []
    for path in media:
        ext = path.suffix.lower()
        if ext in util.VIDEO_EXTENSIONS:
            pool = "video"
        elif ext in util.IMG_EXTENSIONS:
            pool = "image"
        else:
            continue
        sidecar, meta_texts = media_texts(path, util)
        entries.append({
            "path": path,
            "pool": pool,
            "mtime": path.stat().st_mtime,
            "exact": {norm(t) for t in sidecar},
            "meta": {norm(t) for t in meta_texts},
            "blob": " ".join(norm(t) for t in sidecar + meta_texts),
        })
    return entries


def plan_covers(prompts: list[dict], entries: list[dict], loose: bool) -> list[dict]:
    """每条提示词 → 最匹配的那一条产物：先比匹配档，同档取最新（图像池只收图，视频池只收视频）"""
    plans = []
    for item in prompts:
        key = norm(item["head"])
        pool = "video" if is_video_pool(item["name"]) else "image"
        best_tier, best = 0, None
        for entry in entries:
            if entry["pool"] != pool:
                continue
            tier = match_tier(key, entry["exact"], entry["meta"], entry["blob"], loose)
            if tier and (not best
                         or tier < best_tier
                         or (tier == best_tier and entry["mtime"] > best["mtime"])):
                best_tier, best = tier, entry
        plans.append({"name": item["name"], "txt": item["txt"], "pool": pool,
                      "tier": best_tier, "file": best["path"] if best else None,
                      "has_cover": item["has_cover"]})
    return plans



def ffmpeg_exe() -> str | None:
    """ffmpeg 解析链与素材页同一道：PATH 里的 ffmpeg，其次 imageio-ffmpeg 自带的二进制"""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def first_frame(video: Path, out: Path, max_side: int, ffmpeg_path: str) -> bool:
    """视频首帧取成一张图：命令与素材页视频缩略图同一条（先 -ss 输入侧定位，失败退成无 -ss）"""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    scale = f"scale={max_side}:{max_side}:force_original_aspect_ratio=decrease"
    for cmd in ([ffmpeg_path, "-ss", "00:00:00.500", "-i", str(video), "-vframes", "1",
                 "-vf", scale, "-an", "-sn", "-y", str(out)],
                [ffmpeg_path, "-i", str(video), "-vframes", "1", "-vf", scale,
                 "-an", "-sn", "-y", str(out)]):
        try:
            if subprocess.run(cmd, capture_output=True, timeout=60, creationflags=flags).returncode == 0:
                return out.is_file()
        except (OSError, subprocess.SubprocessError):
            return False
    return False


def write_cover(media: Path, target: Path, max_side: int, ffmpeg_path: str | None,
                video_exts: set) -> bool:
    """按封面口径写 sidecar：图缩到 max_side 长边，视频先取首帧；先写临时文件再换名。

    透明图铺白底再落 JPEG（与出图写封面那一路同一份口径），失败清掉临时文件回 False。
    """
    from PIL import Image

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.stem + ".tmp.jpg")
    source = media
    cleanup = False
    if media.suffix.lower() in video_exts:
        if not ffmpeg_path:
            return False
        cleanup = True
        source = target.with_name(target.stem + ".tmp_frame.png")
        if not first_frame(media, source, max_side, ffmpeg_path):
            source.unlink(missing_ok=True)
            return False
    try:
        with Image.open(source) as img:
            img.load()
            if img.mode in ("RGBA", "LA", "P"):
                base = Image.new("RGB", img.size, (255, 255, 255))
                base.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
                img = base
            elif img.mode != "RGB":
                img = img.convert("RGB")
            img.thumbnail((max_side, max_side), Image.LANCZOS)
            img.save(tmp, format="JPEG", quality=85, optimize=True)
        tmp.replace(target)
        return True
    except Exception:
        tmp.unlink(missing_ok=True)
        return False
    finally:
        if cleanup:
            source.unlink(missing_ok=True)


def media_paths(roots: list[Path], util) -> list[Path]:
    """全部候选产物：同一棵树只扫一次，跳过软链目录（与素材页的扫描口径同一道）"""
    paths: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        try:
            resolved = root.resolve()
        except OSError:
            continue
        if resolved in seen or not resolved.is_dir():
            continue
        seen.add(resolved)
        for dirpath, dirs, files in os.walk(resolved):
            dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(dirpath, d))]
            for name in files:
                if os.path.splitext(name)[1].lower() in util.ALL_MEDIA_EXTENSIONS:
                    paths.append(Path(dirpath) / name)
    return paths


def main() -> int:
    ap = argparse.ArgumentParser(description="按元信息把已有产物回填成提示词库封面")
    ap.add_argument("comfyui_root", nargs="?", default=None, help="ComfyUI 根（扫 <根>/output）")
    ap.add_argument("--output-dir", action="append", default=[], help="额外的产物目录，可重复")
    ap.add_argument("--data-root", default=None, help="数据根（prompts/custom 落点）")
    ap.add_argument("--apply", action="store_true", help="写封面；默认只出报告")
    ap.add_argument("--overwrite", action="store_true", help="已有封面的条也重写")
    ap.add_argument("--loose", action="store_true", help="允许「首行出现在元数据文本里」的包含匹配")
    ap.add_argument("--limit", type=int, default=0, help="最多处理前 N 条（按正文 mtime 倒序）")
    args = ap.parse_args()

    if args.data_root:
        os.environ["NEO_STUDIO_DATA"] = str(Path(args.data_root).expanduser().resolve())
    plugin_paths, prompt_names, util = load_studio()

    prompts = []
    for item in prompt_names.scan_prompts("custom"):
        txt = prompt_names.resolve_prompt_file(item["name"])
        if not txt:
            continue
        prompts.append({
            "name": item["name"],
            "txt": Path(txt),
            "head": prompt_first_line(Path(txt)),
            "mtime": item.get("_mtime", 0),
            "has_cover": "cover" in item,
        })
    prompts.sort(key=lambda p: -p["mtime"])  # 与提示词库列表同序：最新在前
    if args.limit:
        prompts = prompts[:args.limit]

    roots = [Path(args.comfyui_root) / "output"] if args.comfyui_root else []
    roots.append(comfyui_root(sys.argv) / "output")
    roots.extend(Path(d).expanduser() for d in args.output_dir)
    roots.append(plugin_paths.DATA_ROOT / "gallery" / "custom")
    media = media_paths(roots, util)
    entries = media_entries(media, util)
    plans = plan_covers(prompts, entries, args.loose)
    ffmpeg_path = ffmpeg_exe() if any(p["pool"] == "video" and p["file"] for p in plans) else None
    todo = [p for p in plans if p["file"] and not (p["has_cover"] and not args.overwrite)]
    written = failed = covered = 0
    for plan in plans:
        label = f"{plan['pool']} | {plan['name']}"
        if plan["file"] is None:
            print(f"无匹配 | {label}")
            continue
        source = plan["file"].name
        if plan["has_cover"] and not args.overwrite:
            covered += 1
            print(f"已有封面 | {label} ← {source}")
            continue
        target = plan["txt"].with_suffix(prompt_names.COVER_SUFFIX)
        if not args.apply:
            print(f"待写 | {label} | {TIER_LABELS.get(plan['tier'], '?')} ← {source}")
            continue
        if write_cover(plan["file"], target, prompt_names.COVER_MAX_SIDE, ffmpeg_path,
                       util.VIDEO_EXTENSIONS):
            written += 1
            print(f"已写 | {label} | {TIER_LABELS.get(plan['tier'], '?')} ← {source}")
        else:
            failed += 1
            print(f"写失败 | {label} ← {source}")

    print(f"扫描: {len(prompts)} 条提示词 / {len(media)} 条产物 | 可回填: {len(todo)} | "
          f"{'已写' if args.apply else '待写'}: {written if args.apply else len(todo)} | "
          f"已有封面: {covered} | 写失败: {failed}")
    if not args.apply and todo:
        print("加 --apply 才落盘；先看清单再写。")
    return 0


if __name__ == "__main__":
    sys.exit(main())



