# SPDX-License-Identifier: Apache-2.0
r"""Neo Studio「视频抽帧」后端：把素材库里的视频按分段回给播放器，把抽出来的一帧 PNG 写进素材库。

抽帧本身在浏览器里跑（video seek + canvas 取帧），本机服务只做两件事，都是文件层：桌面端离线
服务也挂这两条路由（app/studio_caps.py 已登记），页面独立于摆姿页与素材库页。

视频不回全长响应的话抽不出正确的帧：Gallery 的 /neo_gallery/video 把整份文件一次读进内存，
浏览器没有分段响应时只会顺序往后读，seek 落回开头 —— 抽出来的帧全是片头那一帧。
FileResponse 自己处理 Range，seek 才有帧定位（aiohttp 3.14 的 FileResponse 带 Range 解析）。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import mimetypes
import re
from pathlib import Path

from aiohttp import web

from .util import PrefixFilter, VIDEO_EXTENSIONS

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

routes = web.RouteTableDef()

# 帧只有 PNG：浏览器 canvas.toDataURL("image/png") 给的就是这一种，后端不收别的格式
FRAME_EXT = ".png"
# 与摆姿导出同一条上限：桌面端服务的请求体上限按这值装配（app/studio_server.py），
# 一帧 4K PNG 编码后仍在限内，接口先到不会让 transport 先截断
MAX_BODY_BYTES = 48 * 1024 * 1024
STEM_MAX = 64


@routes.get("/neo_frames/video")
async def frames_video(request):
    """素材库里的一条视频 → 抽帧页的播放器：素材解析与 Gallery 同一套，回的是分段响应。"""
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "")
    if not filename or ".." in filename:
        return _bad_request("filename 不合法")
    from .gallery import _find_source_media   # 素材解析与 Gallery 同一套；惰性导入避免 import 期依赖
    source = await asyncio.to_thread(_find_source_media, filename, subfolder)
    if source is None or not source.is_file():
        return web.json_response({"success": False, "error": f"素材不存在：{filename}"}, status=404)
    if source.suffix.lower() not in VIDEO_EXTENSIONS:
        return _bad_request(f"抽帧只支持视频：{source.suffix}")
    resp = web.FileResponse(source)
    ctype = mimetypes.guess_type(source.name)[0]
    if ctype:
        resp.headers["Content-Type"] = ctype
    resp.headers["Cache-Control"] = "public, max-age=86400"   # seek 是反复打的：分段复用缓存，抽一批帧不该重传
    return resp


@routes.post("/neo_frames/save")
async def frames_save(request):
    """抽出来的一帧 → 素材库的 Frames 目录（output/Frames）。

    一条请求一帧：逐帧存与「全部存进素材库」是同一条路径，批量只是页面连着发。一次塞一批的
    话整批体积会撞上请求体上限，而用户要的通常是其中某一张 —— 逐条发不会出现「存了一半」。
    """
    from .gallery import FRAMES_DIR as SAVE_DIR, FRAMES_DIR_NAME as SAVE_SUBFOLDER
    data, err = await _json_body(request)
    if err is not None:
        return err
    raw = str(data.get("data", ""))
    if raw.startswith("data:"):
        _, _, raw = raw.partition(",")
    try:
        body = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        return _bad_request("data 不是 base64 图片")
    if not body:
        return _bad_request("data 为空")
    # 帧名是页面按播放位置拼的 frame-00:07.125：Windows 不吃冒号，落到文件名上换成下划线
    stem = re.sub(r"[^\w\-]+", "_", str(data.get("name") or "frame")).strip("_")[:STEM_MAX] or "frame"
    dest = await asyncio.to_thread(_unique_path, SAVE_DIR, stem, FRAME_EXT)
    await asyncio.to_thread(dest.write_bytes, body)
    return web.json_response({"success": True, "filename": dest.name,
                              "subfolder": SAVE_SUBFOLDER, "size": len(body)})


# ====== 接口层的叶工具：只给上面两条 handler 用，不出模块 ======

async def _json_body(request) -> tuple:
    """带体积上限的 JSON 读取：一帧 PNG 整张走 body，浏览器一次塞进来的不能是无限的。"""
    if (request.content_length or 0) > MAX_BODY_BYTES:
        return None, _bad_request(f"请求体超过 {MAX_BODY_BYTES // (1024 * 1024)}MB")
    try:
        data = await request.json()
    except (json.JSONDecodeError, ValueError):
        return None, _bad_request("请求体不是 JSON")
    if not isinstance(data, dict):
        return None, _bad_request("请求体需是 JSON 对象")
    return data, None


def _bad_request(text: str) -> web.Response:
    return web.json_response({"success": False, "error": text}, status=400)


def _unique_path(directory: Path, stem: str, ext: str) -> Path:
    """同名的帧依次追加序号：同一秒内抽两帧（间隔小于 1 秒）不会互相覆盖。"""
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory / f"{stem}{ext}"
    counter = 1
    while dest.exists():
        dest = directory / f"{stem}_{counter}{ext}"
        counter += 1
    return dest
