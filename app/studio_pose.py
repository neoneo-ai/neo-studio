# SPDX-License-Identifier: Apache-2.0
"""姿势资产自动同步：「启动设置 → 姿势仓库」（launcher_config 的 pose_repo）指向 3d-pose-art 仓库根时，
桌面端每次启动把 dist 姿势包与 pose-lib 场景库补进数据根，姿势页与场景库因此不会停在旧构建上。

姿势页与场景库读的是数据根那一级，且它压住随包副本：pose 数据更新而数据根没跟着同步时，
用户看到的就是一片空白缩略图与素体缺失。同步只在「源比数据根新」时动手——
重复启动、没构建过的仓库都跑不出文件复制；用户在 pose/dist/models 导入的自备素体与 pose/scenes
的存档不在源里，镜像时先存后还。口径与 tools\\sync_pose_dist.ps1、tools\\sync_pose_lib.ps1 一致：
源缺哪级跳哪级，镜像与时间戳对账走 robocopy 的同一套语义。
"""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

POSE_ENV_KEY = "NEO_POSE_REPO"     # 无桌面端配置时的机器级指定（开发机多仓库切换）
LIB_CONTAINER = ("package.json", "pose-lib")   # 认仓库根的最低证据：pose-lib 容器在才谈得上库
PREVIEW_SKIP = ("depth.png",)     # 预览默认档：depth 不进数据根，与 sync_pose_lib.ps1 的默认口径一致
ROBOCOPY_FLAGS = ("/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP",
                  "/R:1", "/W:1", "/COPY:DAT")   # 与 tools 脚本同一调用形态；道具注册表与它的 GLB 同批落地


def pose_repo_dir(path) -> Path | None:
    """姿势仓库根的校验：pose-lib 容器在才算仓库；只认绝对路径。"""
    text = str(path).strip()
    if not text:
        return None
    p = Path(text)
    if not p.is_absolute():
        return None
    try:
        # 目录存在性一路吞掉：校验发生在设置页每次保存，坏路径与失效盘符不许抛到路由上
        if not all((p / part).exists() for part in LIB_CONTAINER):
            return None
    except (OSError, ValueError):
        return None
    return p


def find_pose_repo(cfg: dict, comfy_root) -> Path | None:
    """姿势仓库的三档查找：启动配置 → 环境变量 → ComfyUI 根的同级目录（装机习惯：仓库与 ComfyUI 并排放）。"""
    for cand in (str(cfg.get("pose_repo", "")), os.environ.get(POSE_ENV_KEY, ""),
                 str(Path(str(comfy_root or "")).parent / "3d-pose-art")):
        repo = pose_repo_dir(cand)
        if repo is not None:
            return repo
    return None


def _files(root: Path, skip_suffixes=()):
    out = {}
    if root.is_dir():
        for path in root.rglob("*"):
            if not path.is_dir():
                rel = path.relative_to(root).as_posix()
                if not Path(rel).name.endswith(skip_suffixes):
                    out[rel] = path
    return out


def _copy_tree(src: Path, dst: Path, extra_skip=(), fill_only=False) -> int:
    """只复制「源里更新」的文件（robocopy 的默认对账口径：时间戳 + 字节数）。
    fill_only = 只补目标没有的（robocopy 的 /XC /XN /XO）：两遍同步里补预设集那一级用它，
    同 id 的本地那份因此不会被预设集盖掉。"""
    copied = 0
    for rel, src_f in _files(src, extra_skip).items():
        st = src_f.stat()
        dst_f = dst / rel
        if not dst_f.exists():
            dst_f.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_f, dst_f)
            copied += 1
            continue
        if fill_only:
            continue
        ds = dst_f.stat()
        if int(st.st_mtime) > int(ds.st_mtime) or st.st_size != ds.st_size:
            shutil.copy2(src_f, dst_f)
            copied += 1
    return copied


def _mirror(src: Path, dst: Path, extra_skip=()) -> int:
    """镜像一级子树；源目录不存在时不动目标（源缺档不洗数据根）。"""
    if not src.is_dir():
        return 0
    copied = _copy_tree(src, dst, extra_skip)
    src_set = set(_files(src, extra_skip))
    for rel, path in _files(dst, extra_skip).items():
        if rel not in src_set:
            path.unlink(missing_ok=True)
    dst_dir = dst / src.name
    for _ in range(3):   # 删完文件再收空目录：自底向上，父目录要等子目录先走
        if not dst_dir.is_dir():
            break
        dirs = [d for d in dst_dir.rglob("*") if d.is_dir()]
        for d in sorted(dirs, key=lambda x: len(x.parts), reverse=True):
            if not any(d.iterdir()):
                d.rmdir()
    return copied


def _sync_file(src_f: Path, dst_f: Path) -> bool:
    if not src_f.is_file():
        return False
    if dst_f.exists() and int(src_f.stat().st_mtime) <= int(dst_f.stat().st_mtime):
        return False
    dst_f.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_f, dst_f)
    return True



def _robocopy_mirror(src: Path, dst: Path) -> None:
    """姿势包全量镜像走 robocopy：`*.map` 与 assets 子目录要原样落进数据根，tools 脚本用的就是它。"""
    proc = subprocess.run(["robocopy", str(src), str(dst), *ROBOCOPY_FLAGS],
                          capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=900,
                          **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
    # robocopy 把「复制了文件」也当非零退出（1..7 都是成功），8 起才是真失败
    if proc.returncode >= 8:
        raise RuntimeError(f"robocopy 镜像姿势包失败 rc={proc.returncode}: {proc.stdout[-200:]}")


def sync_dist(repo: Path, data_root: Path) -> dict | None:
    """姿势包镜像进 <数据根>/pose/dist：源没构建过就整级跳过；用户在 models/ 导入的素体先存后还。"""
    src = repo / "dist"
    if not src.is_dir() or not (src / "index.html").is_file():
        return None
    dst = data_root / "pose" / "dist"
    src_files = _files(src)
    dst_files = _files(dst)
    # 源里任何文件在数据根缺失或更新都要动手：手动删过 pose/dist 的下次启动原样补回
    stale = [rel for rel, f in src_files.items()
             if rel not in dst_files or int(f.stat().st_mtime) > int(dst_files[rel].stat().st_mtime)]
    if not stale:
        return {"files": 0}
    models_dir = dst / "models"
    src_model_rels = {rel for rel in src_files if rel.startswith("models/")}
    imported = {}
    if models_dir.is_dir():   # 用户在 models/ 里的文件（glb 与登记 sidecar、props 子目录）都不在源产物里
        for path in models_dir.rglob("*"):
            rel = path.relative_to(models_dir).as_posix()
            if path.is_file() and f"models/{rel}" not in src_model_rels:
                imported[rel.replace("/", "__")] = path
    stash = data_root / "pose" / "_sync_stash"
    for name, path in imported.items():   # 与 tools 脚本同一先存后还：镜像只认源里的文件
        stash.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(stash / name))
    copied = len(stale)
    if os.name == "nt":
        _robocopy_mirror(src, dst)
    else:
        copied += _mirror(src, dst)
    for name, _path in imported.items():
        rel = name.replace("__", "/")
        target = models_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(stash / name), str(target))
    shutil.rmtree(stash, ignore_errors=True)
    for name in ("LICENSE", "NOTICE"):
        if _sync_file(repo / name, dst / name):
            copied += 1
    return {"files": copied}


def _preview_refs(index_file: Path):
    """索引里的预览引用清单：库的预览完整性以它为准，路径逐条去掉前导斜杠。"""
    try:
        data = json.loads(index_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None
    entries = data.get("entries") if isinstance(data.get("entries"), list) else []
    refs = set()
    for entry in entries:
        for rel in (entry.get("preview") or {}).values():
            if rel:
                refs.add(str(rel).replace("\\", "/").lstrip("/"))
    return entries, refs


def _lib_need(repo: Path, dst: Path) -> bool:
    """同步判据：索引缺失 / 预览引用没落地 / 旧版清单没有基座字段 / 源比索引新，任一条成立才动手。"""
    idx = dst / "index.json"
    if not idx.is_file():
        return True
    entries, refs = _preview_refs(idx)
    if entries is None:
        return True
    dest_preview = set(_files(dst / "preview"))
    # 索引里的预览写的是相对 pose/lib 的 `preview/<档位文件>`，对账要落到 preview/ 那一层；
    # 默认档故意不带 depth —— 引用里缺这些不是「没同步」，拿它们当判据每轮启动都会白重建一次索引
    if any(rel.split("preview/", 1)[-1] not in dest_preview
           for rel in refs if not rel.endswith(PREVIEW_SKIP)):
        return True   # 清单里有预览、文件没落地 = 上一轮同步没跑完
    if entries and all(not e.get("charKey") for e in entries):
        return True   # 旧版清单没有基座字段：基座筛选没有落点，重建一次补上
    mtime = idx.stat().st_mtime
    for sub in ("pose-lib/poses", "pose-lib/preview", "pose-lab/poses", "pose-lab/preview"):
        for f in _files(repo / sub).values():
            if f.stat().st_mtime > mtime:
                return True   # 源比索引新 = pose 数据动过了
    return False


def sync_lib(repo: Path, data_root: Path) -> dict | None:
    """场景库同步进 <数据根>/pose/lib：lab 镜像、ship 补缺、预览默认档、合并索引重建，
    与 tools\\sync_pose_lib.ps1 同一口径；源里两级库都没有时整级跳过。"""
    ship, lab = repo / "pose-lib", repo / "pose-lab"
    if not (ship / "poses").is_dir() and not (lab / "poses").is_dir():
        return None
    dst = data_root / "pose" / "lib"
    rebuild = _lib_need(repo, dst)
    mirror_poses = lab if (lab / "poses").is_dir() else ship
    mirror_preview = lab if (lab / "preview").is_dir() else ship
    if not rebuild:   # 没更新就不动文件：一次启动的同步只发生在 pose 数据真的变了之后
        return {"files": 0}
    dst.mkdir(parents=True, exist_ok=True)
    copied = _mirror(mirror_poses / "poses", dst / "poses")
    if mirror_poses is lab and (ship / "poses").is_dir():
        copied += _copy_tree(ship / "poses", dst / "poses", fill_only=True)
    copied += _mirror(mirror_preview / "preview", dst / "preview", extra_skip=PREVIEW_SKIP)
    if mirror_preview is lab and (ship / "preview").is_dir():
        copied += _copy_tree(ship / "preview", dst / "preview", extra_skip=PREVIEW_SKIP, fill_only=True)
    for stale in _files(dst / "preview").values():   # 排除档位是 *depth.png：宽档轮留下的这份镜像的排除口径碰不到
        if stale.name.endswith(PREVIEW_SKIP):
            stale.unlink(missing_ok=True)
    for name in ("categories.json", "ATTRIBUTION.md"):
        src_f = lab / name if (lab / name).is_file() else ship / name
        if _sync_file(src_f, dst / name):
            copied += 1
    for name in ("LICENSE", "NOTICE"):
        if _sync_file(repo / name, dst / name):
            copied += 1
    rebuilt = rebuild_index(repo, dst)
    return {"files": copied + (1 if rebuilt else 0), "index": rebuilt}


def rebuild_index(repo: Path, dst: Path) -> bool:
    """合并索引走姿势仓库自己的 CLI（node scripts/poseLib.mjs merged --out ...）：
    宿主与桌面端都不复刻第二份清单构建逻辑，charKey 由仓库的 lib:bodies 分派结果写进条目。"""
    script = repo / "scripts" / "poseLib.mjs"
    node = shutil.which("node")
    if not script.is_file() or node is None:
        return False
    dst.mkdir(parents=True, exist_ok=True)
    kw = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    # 全部交绝对路径：cwd 在仓库根时，node 会把相对参数的 argv 按 cwd 再解一遍，模块名直接解飞
    try:
        proc = subprocess.run([node, str(script.resolve()), "merged",
                               "--out", str((dst / "index.json").resolve())],
                              cwd=str(repo.resolve()), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=600, **kw)
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0 and (dst / "index.json").is_file()


def auto_sync(data_root: Path, repo, log=lambda line: None) -> dict:
    """一次启动的姿势资产同步：仓库解析 → dist 镜像 → 场景库同步；源缺哪级跳哪级，全程幂等。"""
    started = time.monotonic()
    out = {"repo": str(repo) if repo else "", "dist": 0, "lib": 0, "index": False,
           "seconds": 0.0, "skipped": ""}
    if repo is None:
        out["skipped"] = "未配置姿势仓库"
        return out
    dist = sync_dist(repo, data_root)
    if dist is None:
        out["skipped"] = "仓库没有构建产物 dist"
    else:
        out["dist"] = dist["files"]
    lib = sync_lib(repo, data_root)
    if lib is not None:
        out["lib"] = lib["files"]
        out["index"] = bool(lib.get("index"))
    out["seconds"] = round(time.monotonic() - started, 2)
    log(f"pose auto-sync repo={out['repo']} dist={out['dist']} lib={out['lib']} "
        f"index={'ok' if out['index'] else 'skip'} {out['seconds']}s"
        + (f" skipped={out['skipped']}" if out["skipped"] else ""))
    return out
