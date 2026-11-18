#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
r"""把一个技能目录根上传成 Neo Studio「技能」的云端订阅源（OSS）。

读侧是 studio/skill_cloud.py：清单在 `<前缀>/index.json`，技能包在 `<前缀>/<id>/<version>.zip`。
这条脚本产的就是那棵树，形状对齐，读侧不必为上传侧改一行：

    <前缀>/index.json              清单（格式 neo-skill-cloud/1，纯数据，没有可执行代码）
    <前缀>/<id>/<version>.zip      一份技能包：skill.md + 其它 .md/.txt，与「ZIP 导入」那条口吃的包同形

版本号取 skill.md frontmatter 的 `version`，没写就是 1；每包的 sha256 由脚本算好写进清单，
读侧下载后先验这一份指纹，指纹不符就拒装。

id 撞内置技能（studio/skills/presets 与 studio/skills/tasks）的直接跳过不发：读侧对同名条目
只会报「与内置技能同名」，发上去就是一条永远装不上的行。预设只读、只有 custom 可删这两条规则
由读侧守着，这条脚本只负责不发那种行。

凭据与素材库/姿势库上传脚本同一条链：命令行 > OSS_* 环境变量 > <数据根>/configs/backyard_oss.json。
默认不上传：先跑一遍看清单与包，加 --apply 才动云端。

用法：
    python tools/skills_deploy_oss.py --source "D:\\work\\neo-skills"
    python tools/skills_deploy_oss.py --source "D:\\work\\neo-skills" --skills story_board film_lut
    python tools/skills_deploy_oss.py --source "D:\\work\\neo-skills" --apply
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_PREFIX = "neo/skills/"
CLOUD_FORMAT = "neo-skill-cloud/1"
SKILL_FILE_EXTS = (".md", ".txt")          # 与 studio/skill.py 受支持文件同集合：别的文件装进包也是丢
MAIN_MD = "skill.md"
FM_LINE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$")
SHIPPED_SKILL_DIRS = (REPO / "studio" / "skills" / "presets", REPO / "studio" / "skills" / "tasks")


def data_root() -> Path:
    env = os.environ.get("NEO_STUDIO_DATA", "").strip()
    return Path(env) if env else REPO / "data"


def load_credentials(args) -> dict:
    """endpoint / bucket / AK：命令行 > 环境变量 > backyard_oss.json（与 pose_deploy_oss.py 同一条链）。"""
    path = Path(args.config) if args.config else data_root() / "configs" / "backyard_oss.json"
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    return {
        "endpoint": args.endpoint or os.environ.get("OSS_ENDPOINT", "") or cfg.get("endpoint", ""),
        "bucket": args.bucket or os.environ.get("OSS_BUCKET", "") or cfg.get("bucket", ""),
        "key_id": args.access_key_id or os.environ.get("OSS_ACCESS_KEY_ID", "") or cfg.get("access_key_id", ""),
        "key_secret": args.access_key_secret or os.environ.get("OSS_ACCESS_KEY_SECRET", "")
        or cfg.get("access_key_secret", ""),
        "config_path": path,
    }


def frontmatter(text: str) -> dict:
    """skill.md 的 frontmatter 里那几个标量（name / cn_name / description / version）。

    只吃标量行，不引 yaml：清单只要这四样，嵌套结构与列表在这里没有消费者。
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        found = FM_LINE.match(line)
        if found:
            meta[found.group(1)] = found.group(2).strip().strip("\"'")
    return meta


def shipped_skill_ids() -> set:
    """内置技能 id（预设 + 任务）：这些 id 的云端条目永远装不上，不发。"""
    ids = set()
    for base in SHIPPED_SKILL_DIRS:
        if base.is_dir():
            ids |= {p.name for p in base.iterdir() if p.is_dir()}
    return ids

def skill_files(skill_dir: Path) -> list:
    """包里要带的文件：.md/.txt 全带（含子目录），相对路径用正斜杠，与读侧的收集口径一致。"""
    files = []
    for f in sorted(skill_dir.rglob("*")):
        if not f.is_file() or not f.name.lower().endswith(SKILL_FILE_EXTS):
            continue
        files.append((f, f.relative_to(skill_dir).as_posix()))
    return files


def build_package(skill_dir: Path, out_dir: Path) -> tuple:
    """打一份技能包 → (zip 路径, sha256, size)：同一份内容重跑算出同一个 sha256。

    zip 里不落时间戳（逐条 zf.writestr 写内容而不是 zf.write 带文件 mtime）：包字节只随内容变，
    读侧的指纹校验与「同版本不报可更新」才不会被一次重新打包顶开。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    pkg = out_dir / "package.zip"
    with zipfile.ZipFile(pkg, "w", zipfile.ZIP_DEFLATED) as zf:
        for f, rel in skill_files(skill_dir):
            zf.writestr(zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0)), f.read_bytes())
    blob = pkg.read_bytes()
    return pkg, hashlib.sha256(blob).hexdigest(), len(blob)


def collect(source: Path, only: list, out_dir: Path) -> list:
    """源目录根里能发的技能 → 清单行 + 包：缺主文件、撞内置 id 的逐条跳过并说清为什么。"""
    blocked = shipped_skill_ids()
    wanted = {s.strip() for s in only if s.strip()}
    rows = []
    for skill_dir in sorted(p for p in source.iterdir() if p.is_dir()):
        sid = skill_dir.name
        if wanted and sid not in wanted:
            continue
        main = next((p for p in skill_dir.iterdir() if p.name.lower() == MAIN_MD), None)
        if main is None:
            print(f"[SKIP] {sid}：目录里没有 skill.md，读侧会造一份空技能，不发")
            continue
        if sid in blocked:
            print(f"[SKIP] {sid}：与内置技能同名，读侧对这一行只会报「与内置技能同名」，不发")
            continue
        meta = frontmatter(main.read_text(encoding="utf-8", errors="replace"))
        version = (meta.get("version") or "1").strip()
        pkg, sha, size = build_package(skill_dir, out_dir / version / sid)
        stamp = datetime.fromtimestamp(main.stat().st_mtime, timezone.utc)
        rows.append({
            "id": sid,
            "name": meta.get("cn_name") or meta.get("name") or sid,
            "version": version,
            "description": meta.get("description") or "",
            "updated_at": stamp.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "zip": f"{sid}/{version}.zip",
            "sha256": sha,
            "size": size,
        })
        print(f"  SKILL {sid} · v{version} · {size} bytes · {sha[:12]}")
    return rows


def build_index(rows: list) -> dict:
    return {
        "format": CLOUD_FORMAT,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "count": len(rows),
        "skills": rows,
    }


def put_file(bucket, key: str, path: Path, attempts: int = 3) -> None:
    """一份文件传三次再报：整批几十条键，OSS 网关偶发一条 502 会让脚本从第一个文件重来。"""
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
    """清单最后传，同理：包都传完了、清单没传上去，读侧看到的就还是上一版清单。"""
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
    parser = argparse.ArgumentParser(description="上传 Neo Studio 云端技能订阅源（OSS）")
    parser.add_argument("--source", required=True,
                        help="技能目录根：每个子目录一份技能（skill.md + 其它 .md/.txt）")
    parser.add_argument("--skills", nargs="*", default=[], help="只发点名的那几份；默认发源目录根里全部能发的")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX, help=f"OSS 键前缀，默认 {DEFAULT_PREFIX}")
    parser.add_argument("--out", default="", help="包与清单的落点，默认 <仓库>/build/skills_cloud")
    parser.add_argument("--config", default="", help="凭据 JSON，默认 <数据根>/configs/backyard_oss.json")
    parser.add_argument("--endpoint", default="")
    parser.add_argument("--bucket", default="")
    parser.add_argument("--access-key-id", default="")
    parser.add_argument("--access-key-secret", default="")
    parser.add_argument("--apply", action="store_true", help="真上传；不加就只列清单与包（默认不动云端）")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    if not source.is_dir():
        print(f"[ERROR] --source 不是目录：{source}")
        return 1
    out_dir = Path(args.out) if args.out else REPO / "build" / "skills_cloud"
    rows = collect(source, args.skills, out_dir)
    if not rows:
        print("[ERROR] 没有可发的技能（每条都跳过了，逐条原因在上面的 [SKIP] 行里）")
        return 1
    index = build_index(rows)
    index_file = out_dir / "index.json"
    index_file.parent.mkdir(parents=True, exist_ok=True)
    index_file.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")

    prefix = args.prefix.strip().lstrip("/")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    print(f"[PLAN] {len(rows)} 份技能 → {prefix}index.json")
    for row in rows:
        print(f"  KEY {prefix}{row['zip']} · sha256={row['sha256'][:12]}")
    print(f"[OUT] 包与清单在 {out_dir}")
    if not args.apply:
        print("[DRYRUN] 未加 --apply：云端一字未动")
        return 0

    creds = load_credentials(args)
    missing = [name for name, key in (("endpoint", "endpoint"), ("bucket", "bucket"),
                                      ("access_key_id", "key_id"), ("access_key_secret", "key_secret"))
               if not creds[key]]
    if missing:
        print(f"[ERROR] 缺凭据：{'、'.join(missing)}（命令行 / OSS_* 环境变量 / {creds['config_path']} 任一处给齐）")
        return 1
    try:
        import oss2
    except ImportError:
        print("[ERROR] 未安装 oss2（pip install oss2）；素材库与姿势库的上传脚本用同一个依赖")
        return 1
    bucket = oss2.Bucket(oss2.Auth(creds["key_id"], creds["key_secret"]), creds["endpoint"], creds["bucket"])
    for row in rows:   # 包先传完，清单最后传：读侧拿到新清单时，清单点名的包一定已在云上
        put_file(bucket, prefix + row["zip"], out_dir / row["version"] / row["id"] / "package.zip")
        print(f"[PUT] {prefix}{row['zip']}")
    put_bytes(bucket, prefix + "index.json", index_file.read_bytes())
    print(f"[PUT] {prefix}index.json · {len(rows)} 条")
    print(f"[DONE] 读侧配置：<数据根>/configs/oss_presets.json 的 skill_index_url = "
          f"该 bucket 公开读地址 + {prefix}index.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())


