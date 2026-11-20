#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
Neo Studio — 素材库卡片预览预热（素材管线脚本）

素材页的视频卡片是进视口才现压预览的，首屏那一格要等一发 ffmpeg；这一发把要看的目录里的视频
先压成卡片预览，压片函数取插件那一份（studio/gallery.py 的 _video_preview_file）：短边封顶 480、
静音、前 10 秒、落 gallery/preview_cache/，参数与卡片那条永不走偏。新鲜缓存逐条跳过，重复跑是空的。
默认只出报告，--apply 才压。

--drop-legacy 清旧口径留下的缓存：文件名里的键换过四代（按高 360、短边 360、只留 6 秒、按宽 480），
旧键的片在插件里永远不会再被端出来，留着就是纯占地方。删的口径逐条算：只有这一发已经给那条素材压出
短边口径那一份，才删它同一条素材那四个旧后缀的片 —— 新片没落地的素材一个文件都不动，
扫过的目录之外一个文件都不动。

用法（数据根按 plugin_paths 那三步解析；ComfyUI 根取 data/launcher_config.json）:
    python tools\\gallery_preview_warm.py                          # 只看报告
    python tools\\gallery_preview_warm.py --apply                  # 压缺的预览
    python tools\\gallery_preview_warm.py D:\\ComfyUI --apply       # 指定 ComfyUI 根
    python tools\\gallery_preview_warm.py --dirs D:\\a D:\\b --limit 50
    python tools\\gallery_preview_warm.py --apply --drop-legacy    # 压完清掉这一发的旧后缀缓存

参数:
    COMFYUI_ROOT       位置参数：ComfyUI 根，扫 <根>/output
    --dirs DIR         要扫的目录，可重复；给了就只扫这些（不给时扫 ComfyUI 的 output、数据根的
                       gallery/custom 与 gallery_settings.json 的自定义目录，hidden_directories 里的那几条跳过）
    --data-root DIR    数据根（预览缓存落点；默认按 plugin_paths 那三步）
    --limit N          最多处理前 N 条（按 mtime 倒序，最近要看的先热）
    --apply            压缺的预览；不给就是只出报告
    --drop-legacy      与 --apply 同用：删掉这一发已压出新片的那批旧后缀缓存
"""
from __future__ import annotations

import argparse
import importlib.machinery
import json
import os
import sys
import time
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLUGIN = "comfyui-neo-studio"
LAUNCHER = REPO / "data" / "launcher_config.json"
# 文件名里的键换过四代：按高 360（<hash>_360_15）、短边 360（<hash>_sh360_15）、只留 6 秒（<hash>_6s）、
# 按宽 480（<hash>_w480_15）
LEGACY_SUFFIXES = ("360_15", "sh360_15", "6s", "w480_15")


def load_gallery():
    """按 conftest 的同一套办法导入插件模块：占位包顶住 studio 这个名字，插件入口不执行。"""
    sys.path.insert(0, str(REPO))
    if "studio" not in sys.modules:
        pkg = types.ModuleType("studio")
        pkg.__path__ = [str(REPO / "studio")]
        pkg.__spec__ = importlib.machinery.ModuleSpec("studio", None, is_package=True)
        sys.modules["studio"] = pkg
    if "folder_paths" not in sys.modules:
        # 脚本在 ComfyUI 的 python 外面跑时没有 ComfyUI：这一发只认文件路径，两个目录占位就够
        fp = types.ModuleType("folder_paths")
        fp.input_directory = str(REPO / "tmp" / "warm_input")
        fp.output_directory = str(REPO / "tmp" / "warm_output")
        fp.get_input_directory = lambda: fp.input_directory
        fp.get_output_directory = lambda: fp.output_directory
        sys.modules["folder_paths"] = fp
    from studio import gallery
    return gallery


def comfyui_root(argv: list[str]) -> Path:
    """ComfyUI 根：命令行给的第一条，其次 launcher_config.json 的 root，最后仓库同级的 ComfyUI。"""
    for arg in argv[1:]:
        if not arg.startswith("-") and (Path(arg) / "custom_nodes").is_dir():
            return Path(arg)
    try:
        root = Path(str(json.loads(LAUNCHER.read_text(encoding="utf-8-sig")).get("root", "")))
        if (root / "custom_nodes" / PLUGIN).is_dir():
            return root
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    return REPO.parent / "ComfyUI"


def settings_dirs(data_root: Path) -> list[Path]:
    """gallery_settings.json 里的自定义目录：hidden_directories 里的那几条不预热 —— 用户收起来的
    大目录不该被一条命令行全扫一遍。"""
    try:
        cfg = json.loads((data_root / "configs" / "gallery_settings.json").read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(cfg, dict):
        return []
    hidden = {str(d).strip().rstrip("\\/").lower() for d in cfg.get("hidden_directories") or []}
    dirs = []
    for raw in cfg.get("custom_directories") or []:
        text = str(raw).strip().rstrip("\\/")
        if text and text.lower() not in hidden:
            dirs.append(Path(text))
    return dirs


def scan_videos(dirs: list[Path], limit: int, video_ext: set[str]) -> list[Path]:
    """逐目录收视频：点开头的目录跳过（.git、.cache 这类），整批按 mtime 倒序后截前 limit 条。"""
    found: list[Path] = []
    for root in dirs:
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in video_ext:
                continue
            if any(part.startswith(".") for part in path.relative_to(root).parts[:-1]):
                continue
            found.append(path)
    found.sort(key=_mtime, reverse=True)
    return found[:limit] if limit > 0 else found


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _legacy_paths(gallery, source: Path, stat, cache: Path) -> list[Path]:
    """同一条素材在旧键下的那几个文件名：哈希与分桶与缓存键同一份算法，不靠通配扫缓存树。"""
    digest = gallery._thumbnail_hash(source, stat)
    return [cache.parent / f"{digest}_{suffix}.mp4" for suffix in LEGACY_SUFFIXES]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Neo Studio 素材库卡片预览预热")
    parser.add_argument("comfyui_root", nargs="?", default="",
                        help="ComfyUI 根：不给 --dirs 时扫 <根>/output")
    parser.add_argument("--dirs", nargs="*", default=[], help="额外的扫描目录")
    parser.add_argument("--data-root", default="", help="数据根（默认按 plugin_paths 那三步）")
    parser.add_argument("--limit", type=int, default=0, help="最多处理前 N 条（按 mtime 倒序）")
    parser.add_argument("--apply", action="store_true", help="压缺的预览（默认只出报告）")
    parser.add_argument("--drop-legacy", action="store_true", help="与 --apply 同用：删旧后缀缓存")
    args = parser.parse_args(argv[1:])
    if args.drop_legacy and not args.apply:
        print("--drop-legacy 要和 --apply 同用：先把新片压出来，旧片才有得换")
        return 2

    # 数据根要在导入插件之前钉：预览缓存那个落点是插件导入期由 plugin_paths 那三步算出来的，
    # 导入之后再改这个变量，压出来的片已经落进真实数据根了
    if args.data_root:
        os.environ["NEO_STUDIO_DATA"] = str(Path(args.data_root).resolve())
    gallery = load_gallery()
    data_root = Path(args.data_root) if args.data_root else gallery.plugin_paths.DATA_ROOT
    roots = [Path(d) for d in args.dirs]
    if not roots:
        roots = [comfyui_root(argv) / "output", data_root / "gallery" / "custom"]
        roots += settings_dirs(data_root)

    videos = scan_videos(roots, args.limit, set(gallery.VIDEO_EXTENSIONS))
    print(f"扫描 {len(videos)} 条视频（预览缓存 {gallery.VIDEO_PREVIEW_DIR}）")
    fresh = made = failed = dropped = 0
    for source in videos:
        try:
            stat = source.stat()
        except OSError:
            continue
        cache = gallery._video_preview_cache_path(source, stat)
        if gallery._preview_cache_is_fresh(source, cache):
            fresh += 1
            continue
        if not args.apply:
            print(f"  待压 {source}")
            made += 1
            continue
        started = time.monotonic()
        out = gallery._video_preview_file(source)
        if out is None:
            failed += 1
            print(f"  压失败 {source}")
            continue
        made += 1
        print(f"  压出 {out.name} {out.stat().st_size // 1024}KB "
              f"{time.monotonic() - started:.2f}s  {source}")
        if args.drop_legacy:
            for legacy in _legacy_paths(gallery, source, stat, cache):
                if legacy.is_file():
                    legacy.unlink()
                    dropped += 1
    print(f"新鲜 {fresh} / 压出 {made} / 失败 {failed} / 删旧 {dropped}")
    if not args.apply:
        print("只出报告：加 --apply 才压")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
