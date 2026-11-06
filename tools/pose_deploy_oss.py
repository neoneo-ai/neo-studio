#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
r"""把一棵姿势库上传成 Neo Studio「3D 姿势」的云端场景库与云端道具（OSS）。

读侧是 studio/pose_cloud.py：索引在 `<前缀>/index.json`，文件在 `<前缀>/<相对路径>`。
这条脚本产的就是那棵树，形状对齐，读侧不必为上传侧改一行：

    <前缀>/index.json                   云端清单（格式 neo-pose-cloud/1）
    <前缀>/poses/<组>/<id>.scene.json   整场场景文件（3dpose.scene/1）
    <前缀>/preview/<...>.png            卡片预览图
    <前缀>/props/<file>.glb             云端道具（授权行给「可再分发」才发，注册表行随条目一起上云）

云端道具的授权逐件读姿势仓库的授权文件：那一行给「可再分发」才发。CC0（Poly Haven、BlenderKit
cc_zero）与本项目自制给这一行；BlenderKit Royalty Free 只写「可商用」，"来源与授权待确认" 与
Mixamo「仅个人使用」连商用都没落定 —— 随包白名单只有两件，挡不住整棵道具树，逐件读授权行才挡得住。
注册表那一行（scale 与 grab / handleR / standing 握点）原样进索引条目：页面对 GLB 先归一成
1 单位高、再乘注册表 scale，少这一行的道具就是一把 1 米长的手枪。

--source 只指姿势仓库的随包预设库 pose-lib/（npm run lib -- shipped 的那一棵）。合并库
<数据根>/pose/lib 是 pose-lib + pose-lab 两根的合并结果（tools/sync_pose_lib.ps1 的口径），
pose-lab 是作者自己的实验姿态、不发布：这份脚本见到带 origin 的合并索引直接拒传。

凭据从 <数据根>/configs/backyard_oss.json 读（AGENTS：deploy 脚本凭据从这份读），键名与
studio/backyard.py 读的同一条：bucket / endpoint / access_key_id / access_key_secret。
优先级命令行 > OSS_* 环境变量 > 配置文件 —— shell 里残留的 OSS_ENDPOINT 会盖掉配置文件。
默认不上传：加 --apply 才动云端，先跑一遍看清单。

用法（--source 是姿势仓库的 pose-lib/，不是数据根的合并库）：
    python tools/pose_deploy_oss.py --source "<pose repo>\pose-lib"
    python tools/pose_deploy_oss.py --source "<pose repo>\pose-lib" --apply
    python tools/pose_deploy_oss.py --source "<pose repo>\pose-lib" --props stick.glb katana.glb --apply
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_PREFIX = "neo/pose/"
CLOUD_FORMAT = "neo-pose-cloud/1"
SHIPPED_PROPS = REPO / "studio" / "pose_dist" / "models" / "props"
# 道具在姿势仓库里的落点（注册表 _readme 自己说的两处）：注册表与 GLB 在 dist/models/props，
# 授权逐件登记在 public/models/ATTRIBUTION.md
PROPS_DIR_PARTS = ("dist", "models", "props")
ATTRIBUTION_PARTS = ("public", "models", "ATTRIBUTION.md")
# 授权行给不给「可再分发」：CC0 与本项目自制给（随产物分发 / 可随产物与插件包分发 / 可商用可再分发），
# Royalty Free、免版税、「授权待确认」、「不随仓库分发」、「仅个人使用」都不给
DISTRIBUTE_GRANT = re.compile(r"可[^|\n]{0,12}分发|随产物分发")
DISTRIBUTE_BLOCK = re.compile(r"待确认|不随仓库分发|禁止[^|\n]{0,12}分发|仅个人|[Rr]oyalty|免版税")
# 注册表标签以「测试」「单测」开头的是仓库自己的基准件：面板上出现「测试箱体」就是发了个用户看不懂的控件
TEST_LABEL_RE = re.compile(r"^(测试|单测)")


def data_root() -> Path:
    env = os.environ.get("NEO_STUDIO_DATA", "").strip()
    return Path(env) if env else REPO / "data"


def load_credentials(args) -> dict:
    """endpoint / bucket / AK：命令行 > 环境变量 > backyard_oss.json。"""
    path = Path(args.config) if args.config else data_root() / "configs" / "backyard_oss.json"
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    return {
        "endpoint": args.endpoint or os.environ.get("OSS_ENDPOINT", "") or cfg.get("endpoint", ""),
        # bucket 是 backyard_oss.json 里的那个键名（studio/backyard.py 读的也是它），不是 bucket_name
        "bucket": args.bucket or os.environ.get("OSS_BUCKET", "") or cfg.get("bucket", ""),
        "key_id": args.access_key_id or os.environ.get("OSS_ACCESS_KEY_ID", "") or cfg.get("access_key_id", ""),
        "key_secret": args.access_key_secret or os.environ.get("OSS_ACCESS_KEY_SECRET", "")
        or cfg.get("access_key_secret", ""),
        "config_path": path,
    }


def build_index(source: Path, props: list) -> dict:
    """pose/lib 的清单 → 云端清单：条目只留文件真在着的那批，字段与 pose/lib 的条目同名。"""
    lib_index = json.loads((source / "index.json").read_text(encoding="utf-8"))
    entries = []
    for entry in lib_index.get("entries") or []:
        rel = str(entry.get("path") or "")
        file = source / rel
        if not rel.endswith(".json") or not file.is_file():
            continue
        previews = {}
        for size, rel_preview in (entry.get("preview") or {}).items():
            if rel_preview and (source / str(rel_preview)).is_file():
                previews[size] = rel_preview
        entries.append({
            "id": entry.get("id"),
            "label": entry.get("label") or entry.get("id"),
            "path": rel,
            "size": file.stat().st_size,
            "groups": entry.get("groups") or [],
            "categories": entry.get("categories") or [],
            "tags": entry.get("tags") or [],
            "charKey": entry.get("charKey") or "",
            "gender": entry.get("gender") or "",
            "people": entry.get("people") or 0,
            "props": entry.get("props") or 0,
            "preview": previews,
            "updatedAt": entry.get("updatedAt") or "",
            "license": entry.get("license") or "",
        })
    return {
        "format": CLOUD_FORMAT,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "count": len(entries),
        "groups": lib_index.get("groups") or [],
        "entries": entries,
        "props": props,
    }


def license_lines(attribution: Path) -> dict:
    """授权文件 → 每个 GLB 的授权文本：表格行加上点名它的说明段。

    自制那两条（stick / sword）的「可随产物与插件包分发」写在表格外的引文里，只看表格会漏掉它们。
    """
    by_file = {}
    try:
        lines = attribution.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    for line in lines:
        text = line.strip()
        if not (text.startswith("|") or text.startswith(">")):
            continue
        for leaf in re.findall(r"`([\w.\-]+\.glb)`", line):
            by_file.setdefault(leaf, []).append(line)
    return by_file


def redistributable(lines: list) -> bool:
    """一条授权给不给「可再分发」：CC0 与自制给，Royalty Free 与「授权待确认」不给。"""
    text = " ".join(lines)
    return bool(DISTRIBUTE_GRANT.search(text)) and not DISTRIBUTE_BLOCK.search(text)


def license_label(lines: list) -> str:
    """授权行里的授权名：注册表自己登记了授权（BlenderKit 的 cc_zero）用它那份，没登记的从授权行读。"""
    text = " ".join(lines)
    if "CC0" in text:
        return "CC0（公有领域，可商用可再分发）"
    if "本项目自制" in text:
        return "本项目自制（可再分发）"
    return "授权行给再分发"


def source_home(lines: list) -> str:
    """授权行里的来源页：CC0 的署名可选，来源页随条目一起上云才查得出处（自制那两条没有上游）。"""
    for line in lines:
        hit = re.search(r"https?://[^\s)）|，,]+", line)
        if hit:
            return hit.group(0).rstrip("/")
    return ""


def build_props(props_dir: Path, registry_path: Path, attribution: Path, wanted: list) -> list:
    """云端道具行 = 道具注册表的一行原样 + 字节数：--props 只在授权行给再分发的那批里再挑。

    注册表那一行整条上云、一个字不改：页面先把 GLB 归一成「1 单位高」，再乘注册表的 scale，
    握点（grab / handleR / standing）也按那一行还原成米。少这一行的云端道具就是一把 1 米长的手枪，
    所以「授权给不给再分发」与「注册表里有没有这一行」两条一起决定发哪件。
    """
    try:
        rows = json.loads(registry_path.read_text(encoding="utf-8")).get("props") or []
    except (OSError, json.JSONDecodeError):
        print(f"[SKIP] 读不到道具注册表 {registry_path}：本次不发道具")
        return []
    wanted = {Path(str(name)).name for name in (wanted or [])}
    licenses = license_lines(attribution)
    out = []
    for row in rows:
        leaf = str(row.get("file") or "")
        if not leaf or (wanted and leaf not in wanted):
            continue
        label = str(row.get("label") or leaf)
        if TEST_LABEL_RE.match(label):
            print(f"[SKIP] {leaf}：注册表标签「{label}」是仓库自己的基准件")
            continue
        lines = licenses.get(leaf)
        if not lines:
            print(f"[SKIP] {leaf}：{attribution.name} 里没有这一行")
            continue
        if not redistributable(lines):
            print(f"[SKIP] {leaf}：授权行没给再分发 —— {lines[0].strip()[:60]}…")
            continue
        found = next((cand for cand in (props_dir / leaf, SHIPPED_PROPS / leaf) if cand.is_file()), None)
        if found is None:
            print(f"[SKIP] {leaf}：授权干净但 GLB 不在 {props_dir}")
            continue
        out.append({"id": leaf.rsplit(".", 1)[0], "label": label, "file": leaf,
                    "size": found.stat().st_size,
                    "license": str(row.get("license") or license_label(lines)),
                    "source": str(row.get("source") or source_home(lines) or "pose-repo"),
                    "registry": row})
        print(f"  PROP {leaf} · {label} · scale={row.get('scale', 1)} · {out[-1]['license'][:34]}")
    return out


def collect_files(source: Path, props_dir: Path, props: list) -> list:
    """要上传的文件：场景 + 预览 + 授权干净的道具。道具的键前缀是 props/，读侧落点是 models/props/。"""
    files = []
    if (source / "poses").is_dir():
        files += [(p, p.relative_to(source).as_posix()) for p in sorted((source / "poses").rglob("*.json"))]
    if (source / "preview").is_dir():
        files += [(p, p.relative_to(source).as_posix()) for p in sorted((source / "preview").rglob("*.png"))]
    for row in props:
        for cand in (props_dir / row["file"], source / "props" / row["file"], SHIPPED_PROPS / row["file"]):
            if cand.is_file():
                files.append((cand, f"props/{row['file']}"))
                break
    return files


def put_file(bucket, key: str, path: Path, attempts: int = 3) -> None:
    """一份文件传三次再报：整批是 500 多个键，OSS 网关偶发一条 502 会让脚本从第一个文件重来。"""
    for try_no in range(attempts):
        try:
            bucket.put_object_from_file(key, str(path))
            return
        except Exception as exc:
            if try_no == attempts - 1:
                raise
            print(f"[RETRY {try_no + 1}] {key}: {exc}")
            time.sleep(1.5 * (try_no + 1))


def put_bytes(bucket, key: str, body: bytes, attempts: int = 3) -> None:
    """索引那一份同理：文件都传完了、索引没传上去，读侧看到的就还是上一版清单。"""
    for try_no in range(attempts):
        try:
            bucket.put_object(key, body)
            return
        except Exception as exc:
            if try_no == attempts - 1:
                raise
            print(f"[RETRY {try_no + 1}] {key}: {exc}")
            time.sleep(1.5 * (try_no + 1))


def main() -> int:
    parser = argparse.ArgumentParser(description="上传 Neo Studio 云端姿势库（OSS）")
    parser.add_argument("--source", required=True,
                        help="姿势仓库的随包预设库 pose-lib/（index.json + poses/ + preview/）；带 origin 的合并库拒传")
    parser.add_argument("--props-dir", default="",
                        help="道具注册表与 GLB 的目录，默认 <姿势仓库>/dist/models/props（--source 的那棵树的上两级）")
    parser.add_argument("--attribution", default="",
                        help="道具授权文件，默认 <姿势仓库>/public/models/ATTRIBUTION.md：授权行给「可再分发」才发")
    parser.add_argument("--props", nargs="*", default=[],
                        help="只发点名的那几件；默认发授权行给再分发的全部（授权行不给的，点名也不发）")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help=f"OSS 键前缀，默认 {DEFAULT_PREFIX}")
    parser.add_argument("--config", default="", help="凭据 JSON，默认 <数据根>/configs/backyard_oss.json")
    parser.add_argument("--endpoint", default="")
    parser.add_argument("--bucket", default="")
    parser.add_argument("--access-key-id", default="")
    parser.add_argument("--access-key-secret", default="")
    parser.add_argument("--index-out", default="", help="生成的云端索引另存一份（默认只写 source/_cloud_index.json）")
    parser.add_argument("--apply", action="store_true", help="真上传；不加就只列清单（默认不动云端）")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    if not (source / "index.json").is_file():
        print(f"[ERROR] {source} 里没有 index.json（先跑 tools\\sync_pose_lib.ps1 同步出 pose/lib）")
        return 1
    props_dir = Path(args.props_dir) if args.props_dir else source.parent.joinpath(*PROPS_DIR_PARTS)
    attribution = Path(args.attribution) if args.attribution else source.parent.joinpath(*ATTRIBUTION_PARTS)

    lib_entries = json.loads((source / "index.json").read_text(encoding="utf-8")).get("entries") or []
    # 合并库（pose-lib + pose-lab）的条目带 origin：pose-lab 是作者自己的实验姿态，授权没走到它头上
    # —— 道具的授权行只挡道具，挡不住整棵场景树，所以合并库整棵拒传
    if any("origin" in entry for entry in lib_entries):
        print(f"[ERROR] {source} 是合并库：条目带 origin（pose-lib + pose-lab 合并结果），pose-lab 不发布")
        print("        --source 指姿势仓库的随包预设库：python tools\\pose_deploy_oss.py --source \"<pose repo>\\pose-lib\"")
        return 1
    props = build_props(props_dir, props_dir / "index.json", attribution, args.props)
    index = build_index(source, props)
    files = collect_files(source, props_dir, props)
    prefix = args.prefix.strip().lstrip("/")
    if prefix and not prefix.endswith("/"):
        prefix += "/"

    print(f"云端索引: {prefix}index.json")
    print(f"场景 {index['count']} 条（pose/lib 清单 {len(lib_entries)} 条，缺文件的条目已过滤）")
    print(f"道具 {len(props)} 件 · 待上传文件 {len(files) + 1} 个")
    for _, rel in files:
        print(f"  {prefix}{rel}")

    tmp_index = source / "_cloud_index.json"
    payload = json.dumps(index, ensure_ascii=False, indent=1)
    if args.index_out:
        Path(args.index_out).write_text(payload, encoding="utf-8")
        print(f"索引副本: {args.index_out}")

    if not args.apply:
        # 干跑不落 staging 文件：pose/lib 是数据根里同步出来的库目录，跑一遍就在库里留一份没人读的清单
        print("\n[DRY RUN] 没加 --apply：云端与数据根都没动。要落一份看内容就加 --index-out tmp/index.json")
        print("读侧落点：<数据根>/configs/oss_presets.json 的 pose_index_url = "
              f"https://<bucket>.<endpoint>/{prefix}index.json")
        return 0

    tmp_index.write_text(payload, encoding="utf-8")

    creds = load_credentials(args)
    if not (creds["endpoint"] and creds["bucket"] and creds["key_id"] and creds["key_secret"]):
        print(f"[ERROR] 凭据不全（读 {creds['config_path']}；命令行与环境变量可覆盖）")
        return 1
    try:
        import oss2
    except ImportError:
        print("[ERROR] 未安装 oss2（pip install oss2）")
        return 1

    bucket = oss2.Bucket(oss2.Auth(creds["key_id"], creds["key_secret"]), creds["endpoint"], creds["bucket"])
    total = len(files) + 1
    done = 0
    for path, rel in files:
        put_file(bucket, prefix + rel, path)
        done += 1
        print(f"[{done}/{total}] {prefix}{rel}")
    put_bytes(bucket, prefix + "index.json", tmp_index.read_bytes())
    print(f"[{total}/{total}] {prefix}index.json")
    endpoint_host = creds["endpoint"].replace("https://", "").replace("http://", "")
    print(f"\n上传完成。读侧配置：<数据根>/configs/oss_presets.json 的 pose_index_url = "
          f"https://{creds['bucket']}.{endpoint_host}/{prefix}index.json")
    tmp_index.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

