"""Neo Studio Backyard：Gallery 预处理 + OSS 上传管理（独立 Web 页面）。

页面路径 /neo-studio-backyard → web/backyard/index.html。
配置独立存储在 configs/backyard_oss.json，与 oss_presets.json 互不干扰。
"""

import asyncio
import json
import logging
import shutil
import subprocess
import time
from pathlib import Path

from aiohttp import web

routes = web.RouteTableDef()

from . import plugin_paths
from .util import PrefixFilter

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

CONFIG_PATH = plugin_paths.CONFIGS_DIR / "backyard_oss.json"

# 打包版里没有控制台，ffmpeg 派生时会自己开一个窗口。预处理一次要出几十条视频封面，
# 屏幕上就是一闪一片黑框。CREATE_NO_WINDOW 只在 Windows 上存在，非 Windows 取 0。
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_config(cfg: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def _mask_config(cfg: dict) -> dict:
    out = dict(cfg)
    for key in ("access_key_id", "access_key_secret"):
        val = out.get(key, "")
        if len(val) > 8:
            out[key] = val[:4] + "*" * (len(val) - 8) + val[-4:]
        elif val:
            out[key] = "*" * len(val)
    return out


def _resolve_dir(p: str) -> Path:
    """相对路径基于数据根解析，绝对路径原样返回。

    配置里存的是 gallery/presets/ 这种相对路径，素材在数据根的 gallery 下；插件目录那份
    gallery/presets 是空的，按插件根解析会让预处理扫到空目录，写出一个空 index.json。"""
    path = Path(p)
    if not path.is_absolute():
        path = plugin_paths.DATA_ROOT / path
    return path.resolve()


def _key_prefix(prefix: str) -> str:
    """OSS key 前缀归一化：去掉首部 /，补上尾部 /。

    前缀写成 /neo/presets 时 f"{prefix}{rel}" 拼出 neo/presetsindex.json，和云端
    neo/presets/index.json 不是同一个 key，上传成功的索引素材库永远读不到。"""
    p = (prefix or "").strip().lstrip("/")
    if p and not p.endswith("/"):
        p += "/"
    return p


# ====== SSE helper ======

class _SseLineWriter:
    """redirect_stdout 的落点：攒够一行就交给事件循环。run_fn 跑在工作线程，
    线程里直接 put_nowait 不会唤醒循环上的 getter，所以走 call_soon_threadsafe。"""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue):
        self._loop = loop
        self._queue = queue
        self._buf = ""

    def write(self, text: str) -> None:
        self._buf += text
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._loop.call_soon_threadsafe(self._queue.put_nowait, line + "\n")

    def flush(self) -> None:
        # print(end="") 留下的半行交给下一个换行：在这里吐会把一行进度劈成两行
        pass

    def finish(self) -> None:
        if self._buf:
            self._queue.put_nowait(self._buf + "\n")
            self._buf = ""

    def isatty(self) -> bool:
        return False


async def _sse_stream(response: web.StreamResponse, run_fn, done_event: asyncio.Event):
    """将 run_fn 的 stdout 以 SSE 帧推送到前端，完成后发 done 帧。

    run_fn 是同步阻塞的（扫素材、逐个文件传 OSS）。在事件循环线程里跑它，循环就没有
    机会写帧，整段输出只能等任务结束一次性吐给前端 —— 上传进度就是这么丢的。"""
    import contextlib

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    writer = _SseLineWriter(loop, queue)

    async def _runner():
        try:
            with contextlib.redirect_stdout(writer):
                await asyncio.to_thread(run_fn)
        except Exception as e:
            queue.put_nowait(f"[ERROR] {e}\n")
        finally:
            writer.finish()
            done_event.set()

    runner_task = asyncio.create_task(_runner())

    try:
        while not done_event.is_set():
            get_task = asyncio.ensure_future(queue.get())
            done_task = asyncio.ensure_future(done_event.wait())
            done, pending = await asyncio.wait([get_task, done_task], return_when=asyncio.FIRST_COMPLETED)
            # 循环上同时完成时，取到行的 get_task 会落进 pending：取消它就是丢掉一行进度
            for task in pending:
                task.cancel()
            if get_task in done:
                payload = json.dumps({"msg": get_task.result()}, ensure_ascii=False)
                await response.write(f"data: {payload}\n\n".encode())
        while not queue.empty():
            payload = json.dumps({"msg": queue.get_nowait()}, ensure_ascii=False)
            await response.write(f"data: {payload}\n\n".encode())
    except (ConnectionResetError, asyncio.CancelledError):
        runner_task.cancel()
    finally:
        if not runner_task.done():
            runner_task.cancel()
        payload = json.dumps({"done": True}, ensure_ascii=False)
        try:
            await response.write(f"data: {payload}\n\n".encode())
        except Exception:
            pass


# ====== Preprocess core ======

IMG_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv"}
ALL_MEDIA_EXTENSIONS = IMG_EXTENSIONS | VIDEO_EXTENSIONS


def _generate_image_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    try:
        from PIL import Image
        with Image.open(source_path) as img:
            if img.mode not in ("RGB", "L", "RGBA"):
                img = img.convert("RGB")
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            if img.mode == "RGBA":
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            img.save(cache_path, "JPEG", quality=85)
            return True
    except Exception as e:
        print(f"  [WARN] thumbnail failed {source_path.name}: {e}")
        return False


def _generate_video_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    try:
        ffmpeg_path = shutil.which("ffmpeg")
        if not ffmpeg_path:
            print("  [WARN] ffmpeg not found, skipping video thumbnail")
            return False
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        thumb_args = ["-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease",
                      "-q:v", "4", "-threads", "1", "-an", "-sn"]
        cmd = [ffmpeg_path, "-ss", "00:00:00.500", "-i", str(source_path), "-vframes", "1", *thumb_args, "-y", str(cache_path)]
        result = subprocess.run(cmd, capture_output=True, timeout=30, creationflags=NO_WINDOW)
        if result.returncode != 0:
            cmd = [ffmpeg_path, "-i", str(source_path), "-vframes", "1", *thumb_args, "-y", str(cache_path)]
            result = subprocess.run(cmd, capture_output=True, timeout=30, creationflags=NO_WINDOW)
            if result.returncode != 0:
                return False
        if cache_path.stat().st_size < 1024:
            cache_path.unlink(missing_ok=True)
            return False
        return True
    except Exception:
        return False


def _generate_thumbnail(source_path: Path, cache_path: Path, size: int) -> bool:
    if source_path.suffix.lower() in VIDEO_EXTENSIONS:
        return _generate_video_thumbnail(source_path, cache_path, size)
    return _generate_image_thumbnail(source_path, cache_path, size)


def _parse_txt_preview(txt_path: Path, max_chars: int = 500) -> str:
    import re
    if not txt_path or not txt_path.exists():
        return ""
    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            raw = f.read(max_chars)
        lines = raw.strip().splitlines()[:2]
        result = []
        for line in lines:
            m = re.match(r"^\d+\s*\|\s*(.*)", line)
            result.append(m.group(1).strip() if m else line.strip())
        return "\n".join(result)
    except Exception:
        return ""


def _load_existing_index(index_path: Path) -> dict | None:
    """加载已有 index.json 用于增量合并。"""
    if not index_path.exists():
        return None
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data.get("directories"), dict):
            return data
    except Exception as e:
        print(f"  [WARN] 加载已有 index 失败: {e}")
    return None


def _write_dir_index(out: Path, dir_name: str, entries: list) -> str:
    """写目录级索引 <dir>/index.json，返回 rev（插件据此判断本地目录缓存是否过期）。"""
    rev = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload = {"version": 2, "name": dir_name, "generated_at": rev, "items": entries}
    path = out / dir_name / "index.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return rev


def _master_entry(dir_name: str, entries: list, rev: str) -> dict:
    """主索引条目：计数 + 目录索引路径 + rev + 卡片封面，不含 items。"""
    covers = [{"filename": e["filename"], "thumbnail": e["thumbnail"]}
              for e in entries if e.get("thumbnail")][:2]
    return {"count": len(entries), "index": f"{dir_name}/index.json", "rev": rev, "covers": covers}


def _oss_presets_config() -> dict:
    """云端预设源配置（configs/oss_presets.json）：index_url 是增量合并的基准。"""
    try:
        data = json.loads((plugin_paths.CONFIGS_DIR / "oss_presets.json").read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _fetch_index_from_url(url: str) -> dict | None:
    """拉云端最新的 index.json 作为增量合并基准。"""
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  [WARN] 拉取云端 index 失败: {e}")
        return None
    if isinstance(data.get("directories"), dict):
        return data
    return None


def run_preprocess(source_dir: str, output_dir: str, size: int = 320, copy_media: bool = True, dirs: list | None = None) -> dict:
    """执行预处理，返回摘要。dirs 非空、或源目录内直接放素材时为增量模式（合并到已有 index）。"""
    src = Path(source_dir).resolve()
    out = Path(output_dir).resolve()
    if not src.exists():
        raise FileNotFoundError(f"源目录不存在: {src}")
    out.mkdir(parents=True, exist_ok=True)

    thumb_dir = out / "thumbnails"
    thumb_dir.mkdir(parents=True, exist_ok=True)

    if dirs:
        subdirs = []
        for d in dirs:
            p = src / d
            if not p.is_dir():
                print(f"  [WARN] 目录不存在，跳过: {p}")
                continue
            subdirs.append(p)
        if not subdirs:
            raise ValueError("没有有效的子目录可处理")
    else:
        subdirs = sorted([p for p in src.iterdir() if p.is_dir()])
        # 源目录本身就是单个预设目录（gallery/presets/仙侠玄幻人物 这种直接放 png+txt 的目录）：
        # 整轮只可能产出一个目录，按增量处理，别把云端其余目录冲掉
        if not subdirs and any(p.suffix.lower() in ALL_MEDIA_EXTENSIONS for p in src.iterdir() if p.is_file()):
            subdirs = [src]

    index_path = out / "index.json"
    oss_cfg = _oss_presets_config()
    existing = None
    if dirs or subdirs == [src]:
        url = str(oss_cfg.get("index_url", "")).strip() if oss_cfg.get("enabled", True) else ""
        if url:
            existing = _fetch_index_from_url(url)
            if existing:
                print(f"  增量模式: 合并云端 {len(existing['directories'])} 个目录 ← {url}")
        if existing is None:
            existing = _load_existing_index(index_path)
            if existing:
                print(f"  增量模式: 合并到已有 {len(existing['directories'])} 个目录")

    index = {"version": 2, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "base_url": "", "directories": {}}
    index["base_url"] = (existing.get("base_url") if existing else "") or str(oss_cfg.get("base_url", "")).strip()

    total_items = 0
    total_thumbs = 0

    for subdir in subdirs:
        dir_name = subdir.name
        print(f"\n[{dir_name}] 扫描中...")
        dir_entries = []
        stems: dict[str, list[Path]] = {}

        for p in subdir.iterdir():
            if not p.is_file():
                continue
            lower = p.suffix.lower()
            if lower not in ALL_MEDIA_EXTENSIONS and lower != ".txt":
                continue
            stems.setdefault(p.stem, []).append(p)

        for stem, files in sorted(stems.items()):
            media_file = None
            media_type = None
            txt_file = None
            for f in files:
                if f.suffix.lower() in VIDEO_EXTENSIONS:
                    media_file = f
                    media_type = "video"
                elif f.suffix.lower() in IMG_EXTENSIONS:
                    if media_file is None:
                        media_file = f
                        media_type = "image"
                elif f.suffix.lower() == ".txt":
                    txt_file = f
            if not media_file:
                continue

            thumb_path = thumb_dir / dir_name / f"{stem}.jpg"
            thumb_ok = False
            if not thumb_path.exists():
                thumb_ok = _generate_thumbnail(media_file, thumb_path, size)
                if thumb_ok:
                    total_thumbs += 1
            else:
                thumb_ok = True

            thumb_rel = f"thumbnails/{dir_name}/{stem}.jpg" if thumb_ok else ""
            txt_content = _parse_txt_preview(txt_file)
            dir_entries.append({
                "filename": media_file.name,
                "type": media_type,
                "size": media_file.stat().st_size,
                "mtime": media_file.stat().st_mtime,
                "txt_content": txt_content,
                "thumbnail": thumb_rel,
            })

            if copy_media:
                dest_subdir = out / dir_name
                dest_subdir.mkdir(parents=True, exist_ok=True)
                dest_media = dest_subdir / media_file.name
                if not dest_media.exists():
                    shutil.copy2(media_file, dest_media)
                if txt_file:
                    dest_txt = dest_subdir / txt_file.name
                    if not dest_txt.exists():
                        shutil.copy2(txt_file, dest_txt)

            total_items += 1

        rev = _write_dir_index(out, dir_name, dir_entries)
        index["directories"][dir_name] = _master_entry(dir_name, dir_entries, rev)
        print(f"  {len(dir_entries)} 个文件, {sum(1 for e in dir_entries if e['thumbnail'])} 张缩略图")

    # 增量合并：保留未触及的目录
    if existing:
        merged = dict(existing["directories"])
        merged.update(index["directories"])
        index["directories"] = merged
        # 保留 categories
        if existing.get("categories"):
            index["categories"] = existing["categories"]

    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    total_dirs = len(index["directories"])
    print(f"\n{'='*50}")
    print(f"完成: {total_items} 个新文件, {total_thumbs} 张新缩略图")
    print(f"索引共 {total_dirs} 个目录 → {index_path}")
    return {"items": total_items, "thumbnails": total_thumbs, "total_dirs": total_dirs, "index_path": str(index_path)}


# ====== OSS Upload core ======

def run_oss_upload(source_dir: str, cfg: dict, dry_run: bool = False) -> dict:
    """执行 OSS 上传。"""
    import hashlib
    import mimetypes

    try:
        import oss2
    except ImportError:
        raise RuntimeError("oss2 未安装，请运行: pip install oss2")

    src = Path(source_dir).resolve()
    if not src.exists():
        raise FileNotFoundError(f"源目录不存在: {src}")
    index_path = src / "index.json"
    if not index_path.exists():
        raise FileNotFoundError("index.json 不存在，请先执行预处理")

    bucket_name = cfg.get("bucket", "")
    prefix = _key_prefix(cfg.get("prefix", ""))
    endpoint = cfg.get("endpoint", "")
    access_key_id = cfg.get("access_key_id", "")
    access_key_secret = cfg.get("access_key_secret", "")

    if not dry_run:
        if not all([bucket_name, endpoint, access_key_id, access_key_secret]):
            raise ValueError("OSS 配置不完整（bucket/endpoint/access_key_id/access_key_secret）")
        auth = oss2.Auth(access_key_id, access_key_secret)
        bucket = oss2.Bucket(auth, endpoint, bucket_name)
        bucket.get_bucket_info()
        print(f"[OK] 已连接 bucket: {bucket_name}")

    files = []
    for p in sorted(src.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(src).as_posix()
        files.append((p, rel))

    total = len(files)
    print(f"共 {total} 个文件待上传")

    uploaded = 0
    skipped = 0
    failed = 0
    STATIC_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".mp4", ".webm", ".mov"}

    for i, (local_path, rel_key) in enumerate(files):
        oss_key = f"{prefix}{rel_key}" if prefix else rel_key
        content_type = mimetypes.guess_type(str(local_path))[0] or "application/octet-stream"
        file_size = local_path.stat().st_size
        pct = (i + 1) / total * 100
        print(f"  [{i+1}/{total}] ({pct:.0f}%) {rel_key} ({file_size:,} bytes)", end="")

        if dry_run:
            print(" [DRY RUN]")
            uploaded += 1
            continue

        try:
            remote_meta = bucket.head_object(oss_key)
            remote_etag = remote_meta.etag.lower().strip('"')
            h = hashlib.md5()
            with open(local_path, "rb") as f:
                for chunk in iter(lambda: f.read(8192), b""):
                    h.update(chunk)
            if remote_etag == h.hexdigest():
                print(" [SKIP]")
                skipped += 1
                continue
        except oss2.exceptions.NoSuchKey:
            pass
        except Exception:
            pass

        headers = {"Content-Type": content_type}
        if local_path.suffix.lower() in STATIC_EXTENSIONS:
            headers["Cache-Control"] = "max-age=2592000"
        try:
            bucket.put_object_from_file(oss_key, str(local_path), headers=headers)
            print(" [OK]")
            uploaded += 1
        except Exception as e:
            print(f" [FAIL] {e}")
            failed += 1

    print(f"\n上传完成: {uploaded} 成功, {skipped} 跳过, {failed} 失败")
    if not dry_run and uploaded > 0:
        endpoint_base = endpoint.replace("https://", "").replace("http://", "")
        public_url = f"https://{bucket_name}.{endpoint_base}/{prefix}index.json"
        print(f"\nIndex URL: {public_url}")

    return {"uploaded": uploaded, "skipped": skipped, "failed": failed, "total": total}


# ====== Upload plan (待上传目录清单) ======

def _cloud_master_index() -> dict | None:
    """素材库缓存的云端主索引（gallery/oss_cache/_index.json）：不联网，上传页据此
    判断哪些目录云端还没有。None = 云端索引从没同步过，无从比对。"""
    from .gallery_oss import _load_oss_index_from_disk
    index = _load_oss_index_from_disk()
    if isinstance((index or {}).get("directories"), dict):
        return index
    return None


def _dir_payload(out: Path, name: str) -> tuple[int, int]:
    """一个目录要传的文件数与字节数：<dir>/ 素材 + 目录索引 + thumbnails/<dir>/。"""
    files = 0
    size = 0
    for base in (out / name, out / "thumbnails" / name):
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if p.is_file():
                files += 1
                size += p.stat().st_size
    return files, size


def build_upload_plan(out: Path) -> dict:
    """逐目录列出待上传状态：云端主索引里没有、rev 与云端不同、本地主索引还没这条（--draft）。"""
    master = _load_existing_index(out / "index.json") or {"directories": {}}
    cloud_dirs = (_cloud_master_index() or {}).get("directories", {})
    names = sorted(p.name for p in out.iterdir() if p.is_dir() and p.name != "thumbnails")

    directories = []
    pending_files = 0
    pending_bytes = 0
    for name in names:
        entry = master["directories"].get(name) or {}
        files, size = _dir_payload(out, name)
        count = entry.get("count")
        if count is None:
            count = len(_dir_index_items(out / name / "index.json"))
        if not entry:
            state = "unpublished"
        elif not cloud_dirs:
            state = "pending"
        elif not cloud_dirs.get(name):
            state = "pending"
        elif cloud_dirs[name].get("rev") != entry.get("rev"):
            # 云端是旧版：v1 整包索引的条目没有 rev，v2 重扫过的目录 rev 对不上
            state = "updated"
        else:
            state = "synced"
        if state != "synced":
            pending_files += files
            pending_bytes += size
        directories.append({"name": name, "count": int(count or 0), "files": files,
                            "bytes": size, "state": state})

    return {
        "source_dir": str(out),
        "cloud_known": bool(cloud_dirs),
        "cloud_dirs": len(cloud_dirs),
        "pending_dirs": sum(1 for d in directories if d["state"] != "synced"),
        "pending_files": pending_files,
        "pending_bytes": pending_bytes,
        "directories": directories,
    }


# ====== Routes ======

@routes.get("/neo-studio-backyard")
async def backyard_page_route(request):
    """Backyard 独立页面短路径。"""
    return web.FileResponse(Path(__file__).parent / "web" / "backyard" / "index.html")


@routes.get("/neo_backyard/config")
async def get_config_route(request):
    cfg = _load_config()
    return web.json_response({"success": True, "config": _mask_config(cfg)})


@routes.post("/neo_backyard/config")
async def save_config_route(request):
    body = await request.json()
    cfg = _load_config()
    masked = _mask_config(cfg)
    for key in ("access_key_id", "access_key_secret", "endpoint", "bucket", "prefix", "source_dir", "output_dir"):
        val = body.get(key, "")
        # 掩码串原样提交才表示「这一项没动」。按「含 * 就丢」判，用户在掩码上改一个字符
        # 点保存，界面报「已保存」，文件里还是旧值 —— 密钥永远写不进去。
        if val and val != masked.get(key, ""):
            cfg[key] = val
    _save_config(cfg)
    return web.json_response({"success": True, "config": _mask_config(cfg)})


@routes.post("/neo_backyard/preprocess")
async def preprocess_route(request):
    body = await request.json()
    source_dir = body.get("source_dir", "")
    output_dir = body.get("output_dir", "")
    size = int(body.get("size", 320))
    copy_media = body.get("copy_media", True)
    dirs = body.get("dirs") or None

    if not source_dir or not output_dir:
        return web.json_response({"success": False, "error": "source_dir 和 output_dir 不能为空"}, status=400)

    source_dir = str(_resolve_dir(source_dir))
    output_dir = str(_resolve_dir(output_dir))

    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    await response.prepare(request)

    done_event = asyncio.Event()

    def _run():
        try:
            run_preprocess(source_dir, output_dir, size, copy_media, dirs)
        except Exception as e:
            print(f"[ERROR] {e}")

    await _sse_stream(response, _run, done_event)
    return response


async def _fetch_cloud_index():
    """强刷素材库的云端索引缓存（内存 + gallery/oss_cache/_index.json）。"""
    from .gallery_oss import _fetch_oss_index
    return await _fetch_oss_index(force=True)


@routes.get("/neo_backyard/upload_plan")
async def upload_plan_route(request):
    """上传页打开时先列出每个目录要传多少、云端有没有，再决定传不传。"""
    source_dir = request.query.get("source_dir", "")
    if not source_dir:
        return web.json_response({"success": False, "error": "source_dir 不能为空"}, status=400)
    out = _resolve_dir(source_dir)
    if not out.is_dir():
        return web.json_response({"success": False, "error": f"目录不存在: {out}"}, status=404)
    return web.json_response({"success": True, **build_upload_plan(out)})


@routes.post("/neo_backyard/upload")
async def upload_route(request):
    body = await request.json()
    source_dir = body.get("source_dir", "")
    dry_run = body.get("dry_run", False)

    if not source_dir:
        return web.json_response({"success": False, "error": "source_dir 不能为空"}, status=400)

    source_dir = str(_resolve_dir(source_dir))
    cfg = _load_config()
    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    await response.prepare(request)

    done_event = asyncio.Event()
    result = {}

    def _run():
        try:
            result.update(run_oss_upload(source_dir, cfg, dry_run))
        except Exception as e:
            print(f"[ERROR] {e}")

    await _sse_stream(response, _run, done_event)
    # 素材页的云端目录来自 _fetch_oss_index 的缓存，默认 24 小时才重取一次；刚传完
    # 不强刷的话，新目录要等缓存过期或重启 ComfyUI 才出现在素材页。全跳过时云端没变，不刷。
    if not dry_run and result.get("uploaded"):
        try:
            await _fetch_cloud_index()
        except Exception as e:
            print(f"[Neo Studio] 云端索引刷新失败: {e}")
    return response


def _dir_index_items(path: Path) -> list:
    """读目录级索引的 items；文件缺失就当空目录。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    items = data.get("items")
    return items if isinstance(items, list) else []


@routes.get("/neo_backyard/index")
async def get_index_route(request):
    """返回当前输出目录的 index.json 摘要（已上传到 OSS 的数据）。"""
    cfg = _load_config()
    output_dir = cfg.get("output_dir", "")
    if not output_dir:
        return web.json_response({"success": False, "error": "未配置输出目录"}, status=400)
    index_path = _resolve_dir(output_dir) / "index.json"
    if not index_path.exists():
        return web.json_response({"success": True, "exists": False, "directories": {}})
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)

    out_dir = index_path.parent
    dirs_summary = {}
    for name, info in (data.get("directories") or {}).items():
        items = info.get("items")
        if items is None:
            # v2 主索引只声明计数，图片/视频构成在目录自己的 index.json 里
            items = _dir_index_items(out_dir / name / "index.json")
        count = info.get("count")
        dirs_summary[name] = {
            "count": len(items) if count is None else int(count),
            "images": sum(1 for i in items if i.get("type") == "image"),
            "videos": sum(1 for i in items if i.get("type") == "video"),
        }
    return web.json_response({
        "success": True,
        "exists": True,
        "base_url": data.get("base_url", ""),
        "generated_at": data.get("generated_at", ""),
        "total_dirs": len(dirs_summary),
        "total_items": sum(d["count"] for d in dirs_summary.values()),
        "directories": dirs_summary,
    })


@routes.get("/neo_backyard/dirs")
async def list_dirs_route(request):
    """列出输出目录的结构（供前端浏览/管理）。"""
    output_dir = request.query.get("path", "")
    if not output_dir:
        return web.json_response({"success": False, "error": "path 参数不能为空"}, status=400)
    p = _resolve_dir(output_dir)
    if not p.exists() or not p.is_dir():
        return web.json_response({"success": False, "error": f"目录不存在: {p}"}, status=404)

    entries = []
    for item in sorted(p.iterdir()):
        entry = {"name": item.name, "is_dir": item.is_dir()}
        if item.is_file():
            entry["size"] = item.stat().st_size
        else:
            count = sum(1 for _ in item.rglob("*") if _.is_file())
            entry["file_count"] = count
        entries.append(entry)

    return web.json_response({"success": True, "path": str(p), "entries": entries})


@routes.post("/neo_backyard/delete")
async def delete_route(request):
    """删除输出目录中的文件或子目录。"""
    body = await request.json()
    output_dir = body.get("output_dir", "")
    name = body.get("name", "")

    if not output_dir or not name:
        return web.json_response({"success": False, "error": "output_dir 和 name 不能为空"}, status=400)

    base = _resolve_dir(output_dir)
    target = (base / name).resolve()

    if not str(target).startswith(str(base)):
        return web.json_response({"success": False, "error": "路径越界"}, status=403)
    if not target.exists():
        return web.json_response({"success": False, "error": f"不存在: {name}"}, status=404)

    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()

    return web.json_response({"success": True, "deleted": name})