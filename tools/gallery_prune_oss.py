#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""按点名的卡名删掉云端图库预设里的那一条：媒体、缩略图、视频预览、旁车正文一起走。

`gallery_deploy_oss.py` 只上传不删，云端要撤一条没有通路。这一条按卡名点删——只动点名的
`<目录>/<名>` 与它在 `thumbnails/<目录>/`、`previews/<目录>/` 下的同名片段，不扫整棵、不做「索引
没点名就删」那种批量清空（预设库前缀下住着 16 个目录，批量口径一次就把别人的目录清了）。

默认只列不发，`--apply` 才删。删之前先对账本地构建目录：点名的卡名在 `<source>/<目录>/` 里还留着
文件就整批拒删——那说明索引与媒体对不上，删云端只会把卡删成图位空白。凭据链与姿势库、技能包同一条：
命令行 > `OSS_*` 环境变量 > `<数据根>/configs/backyard_oss.json`。前缀补成 `neo/presets/` 那种带尾
斜杠的形状：`gallery_deploy_oss.py` 是 `prefix + rel_key` 直接拼，少一个斜杠会写成 `neo/presetsxxx`。

用法：
    python tools/gallery_prune_oss.py --dir prompts.chat --stems doomed.txt            # 只列
    python tools/gallery_prune_oss.py --dir prompts.chat --stems doomed.txt --apply    # 真删
"""

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_PREFIX = "neo/presets/"
REPO = Path(__file__).resolve().parents[1]


def data_root() -> Path:
    env = os.environ.get("NEO_STUDIO_DATA", "").strip()
    return Path(env) if env else REPO / "data"


def load_credentials(args) -> dict:
    """endpoint / bucket / AK：命令行 > 环境变量 > backyard_oss.json（与姿势库、技能包同一条链）。"""
    path = Path(args.config) if args.config else data_root() / "configs" / "backyard_oss.json"
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        cfg = {}
    return {
        "endpoint": args.endpoint or os.environ.get("OSS_ENDPOINT", "") or cfg.get("endpoint", ""),
        # bucket 是 backyard_oss.json 里的那个键名（studio/backyard.py 读的也是它）
        "bucket": args.bucket or os.environ.get("OSS_BUCKET", "") or cfg.get("bucket", ""),
        "key_id": args.access_key_id or os.environ.get("OSS_ACCESS_KEY_ID", "") or cfg.get("access_key_id", ""),
        "key_secret": args.access_key_secret or os.environ.get("OSS_ACCESS_KEY_SECRET", "")
        or cfg.get("access_key_secret", ""),
        "config_path": path,
    }


def normalize_prefix(prefix: str) -> str:
    """前缀长成 `neo/presets/`：拼键是 prefix + rel_key，少尾斜杠会拼出 neo/presetsprompts.chat/。"""
    prefix = prefix.strip().lstrip("/")
    return prefix + "/" if prefix and not prefix.endswith("/") else prefix


def read_stems(target: str) -> list[str]:
    """点名的卡名：一个文件一行，也接受命令行直接给的逗号分隔列表。"""
    raw = Path(target).read_text(encoding="utf-8-sig") if Path(target).is_file() else target
    return [line.strip() for line in raw.replace(",", "\n").splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", default=str(REPO / "tmp" / "gallery_pack"),
                        help="本地构建目录，用来对账「点名的卡是不是真的已经从包里删掉了」")
    parser.add_argument("--dir", required=True, help="预设库里的目录名，例如 prompts.chat")
    parser.add_argument("--stems", required=True, help="卡名清单文件（一行一个），或逗号分隔的卡名")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help=f"OSS 键前缀，默认 {DEFAULT_PREFIX}")
    parser.add_argument("--config", default="", help="凭据 JSON，默认 <数据根>/configs/backyard_oss.json")
    parser.add_argument("--endpoint", default="")
    parser.add_argument("--bucket", default="")
    parser.add_argument("--access-key-id", default="")
    parser.add_argument("--access-key-secret", default="")
    parser.add_argument("--apply", action="store_true", help="真删；不加就只列要删的键")
    args = parser.parse_args()

    stems = read_stems(args.stems)
    if not stems:
        print("[ERROR] 卡名清单是空的")
        return 1
    prefix = normalize_prefix(args.prefix)
    src_dir = Path(args.source) / args.dir
    kept = [stem for stem in stems if any(src_dir.glob(f"{stem}.*"))]
    if kept:
        print(f"[ERROR] {len(kept)} 条在 {src_dir} 里还有文件，索引与媒体对不上，整批拒删：")
        for stem in kept[:10]:
            print(f"  {stem}")
        return 1

    creds = load_credentials(args)
    if not (creds["endpoint"] and creds["bucket"] and creds["key_id"] and creds["key_secret"]):
        print(f"[ERROR] 凭据不全（读 {creds['config_path']}；命令行与 OSS_* 环境变量可覆盖）")
        return 1
    try:
        import oss2
    except ImportError:
        print("[ERROR] oss2 未安装：pip install oss2")
        return 1

    bucket = oss2.Bucket(oss2.Auth(creds["key_id"], creds["key_secret"]), creds["endpoint"], creds["bucket"])
    want = set(stems)
    subtrees = (args.dir, f"thumbnails/{args.dir}", f"previews/{args.dir}")
    listed = []
    # 直连走系统代理时列键这一步偶发 502：抛栈看不出是哪一步断的，这里必须报清「云端没动」
    try:
        for sub in subtrees:
            listed.extend(obj.key for obj in oss2.ObjectIteratorV2(bucket, prefix=f"{prefix}{sub}/"))
    except (oss2.exceptions.OssError, OSError) as exc:
        print(f"[ERROR] 列云端键失败：{exc.__class__.__name__} {exc}；云端没动，重跑同一条清单即可")
        return 1
    doomed = sorted(key for key in listed if not key.endswith("/") and Path(key).stem in want)
    missing = sorted(want - {Path(key).stem for key in doomed})
    print(f"点名 {len(want)} 条 · 云端命中 {len(doomed)} 个键 · 云端本就没有 {len(missing)} 条")
    for key in doomed[:12]:
        print(f"  {key}")
    if not args.apply:
        print("\n[DRY RUN] 没加 --apply：云端没动")
        return 0
    deleted = 0
    try:
        for start in range(0, len(doomed), 1000):
            bucket.batch_delete_objects(doomed[start:start + 1000])
            deleted += len(doomed[start:start + 1000])
            print(f"已删 {deleted}/{len(doomed)}")
    except (oss2.exceptions.OssError, OSError) as exc:
        print(f"[ERROR] 删到 {deleted}/{len(doomed)} 个键时断了：{exc.__class__.__name__} {exc}；"
              f"已删的键不会再被点名，重跑同一条清单接着删剩下的")
        return 1
    print(f"云端已删 {deleted} 个键（{args.dir} 的 {len(want)} 条）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
