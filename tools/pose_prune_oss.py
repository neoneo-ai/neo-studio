#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""清掉 OSS 上云端姿势树里索引没点名的那批：只留随包预设库 pose-lib 与授权干净的道具。

上传口径见 tools/pose_deploy_oss.py（--source 只指 pose-lib/，道具逐件过授权行）。合并库曾经被
整棵传上去过，这一条把索引没点名的键（lab 场景与它们的预览图、授权不干净的道具）从 <前缀>/ 下删
干净：允许集直接复用上传脚本的 build_props + collect_files，两处永远同口径。默认只列不发，--apply 才删。

用法：
    python tools/pose_prune_oss.py --source "<pose repo>\\pose-lib"
    python tools/pose_prune_oss.py --source "<pose repo>\\pose-lib" --apply
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pose_deploy_oss import (  # noqa: E402
    ATTRIBUTION_PARTS, DEFAULT_PREFIX, PROPS_DIR_PARTS, build_props,
    collect_files, load_credentials)


def normalize_prefix(prefix: str) -> str:
    """OSS 键前缀长成一个目录：`neo/pose/` 传成 `neo/pose//` 的允许集一条都对不上，清理会把整棵当多余。"""
    prefix = prefix.strip().lstrip("/")
    return prefix + "/" if prefix and not prefix.endswith("/") else prefix


def allow_keys(source: Path, props_dir: Path, attribution: Path, prefix: str) -> set:
    """索引点名的那批云端键：道具授权、条目过滤与上传清单全走上传脚本那三个函数。"""
    props = build_props(props_dir, props_dir / "index.json", attribution, [])
    keys = {prefix + rel for _, rel in collect_files(source, props_dir, props)}
    keys.add(prefix + "index.json")
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", required=True, help="姿势仓库的随包预设库 pose-lib/")
    parser.add_argument("--props-dir", default="",
                        help="道具注册表与 GLB 的目录，默认 <姿势仓库>/dist/models/props（与上传脚本同一落点）")
    parser.add_argument("--attribution", default="",
                        help="道具授权文件，默认 <姿势仓库>/public/models/ATTRIBUTION.md（与上传脚本同一条门禁）")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--config", default="")
    parser.add_argument("--endpoint", default="")
    parser.add_argument("--bucket", default="")
    parser.add_argument("--access-key-id", default="")
    parser.add_argument("--access-key-secret", default="")
    parser.add_argument("--apply", action="store_true", help="真删；不加就只列要删的键")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    lib_entries = json.loads((source / "index.json").read_text(encoding="utf-8")).get("entries") or []
    if any("origin" in entry for entry in lib_entries):
        print(f"[ERROR] {source} 是合并库（条目带 origin）：允许集必须来自随包预设库 pose-lib/")
        return 1
    props_dir = Path(args.props_dir) if args.props_dir else source.parent.joinpath(*PROPS_DIR_PARTS)
    attribution = Path(args.attribution) if args.attribution else source.parent.joinpath(*ATTRIBUTION_PARTS)
    prefix = normalize_prefix(args.prefix)
    keep = allow_keys(source, props_dir, attribution, prefix)

    creds = load_credentials(args)
    if not (creds["endpoint"] and creds["bucket"] and creds["key_id"] and creds["key_secret"]):
        print(f"[ERROR] 凭据不全（读 {creds['config_path']}；命令行与环境变量可覆盖）")
        return 1
    import oss2

    bucket = oss2.Bucket(oss2.Auth(creds["key_id"], creds["key_secret"]), creds["endpoint"], creds["bucket"])
    keys = [obj.key for obj in oss2.ObjectIteratorV2(bucket, prefix=args.prefix) if not obj.key.endswith("/")]
    doomed = sorted(set(keys) - keep)
    print(f"云端 {args.prefix} 下 {len(keys)} 个键 · 索引点名 {len(keep)} 个 · 要删 {len(doomed)} 个")
    for key in doomed[:5]:
        print(f"  {key}")
    if not args.apply:
        print("\n[DRY RUN] 没加 --apply：云端没动")
        return 0
    for start in range(0, len(doomed), 1000):
        bucket.batch_delete_objects(doomed[start:start + 1000])
        print(f"已删 {min(start + 1000, len(doomed))}/{len(doomed)}")
    left = [obj.key for obj in oss2.ObjectIteratorV2(bucket, prefix=args.prefix) if not obj.key.endswith("/")]
    print(f"清理后云端 {len(left)} 个键（索引点名 {len(keep)} 个）")
    return 0 if len(left) == len(keep) else 1


if __name__ == "__main__":
    sys.exit(main())
