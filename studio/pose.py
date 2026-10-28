# SPDX-License-Identifier: Apache-2.0
r"""Neo Studio「3D 摆姿」页后端：伺服 3d-pose-art 构建产物 + 与页面之间的桥接口。

页面与桥接口只做文件读写，桌面端离线服务同样挂这些路由（app/studio_caps.py 已登记）。
摆姿包 = 3d-pose-art 的 vite 构建产物，落点两级：<数据根>/pose/dist/ 优先（tools\sync_pose_dist.ps1
同步的全量产物，含开发用的 map，约 16MB），随包分发的最小授权副本在 studio/pose_dist/
（tools\build_pose_package.ps1 生成：代码 + CC0 素体 ybot.glb，约 4MB，进 Registry 包与 exe）。
子资源逐请求按这两级找，数据根那份压住随包的同名文件，新构建与用户自备素体因此都优先。两级都没有时
/neo_pose/status 报 installed=false，页面显示「未安装」而不是白屏。

摆姿页在宿主页面里以 iframe 承载，与宿主同源（同源的 /neo_pose/* 与 /view），靠 postMessage
交换消息。子资源（dist 下的 JS/CSS/GLB）由 iframe 内部直接加载，不经 shim。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import mimetypes
import re
import shutil
from pathlib import Path

from aiohttp import web

from . import plugin_paths
from .util import PrefixFilter, _json_safe

logger = logging.getLogger(__name__)
logger.addFilter(PrefixFilter())

routes = web.RouteTableDef()

POSE_DIR = plugin_paths.DATA_ROOT / "pose"
DIST_DIR = POSE_DIR / "dist"
SCENES_DIR = POSE_DIR / "scenes"
PRESETS_DIR = POSE_DIR / "presets"
REFS_DIR = POSE_DIR / "refs"
INDEX_HTML = DIST_DIR / "index.html"
# 随包分发的最小摆姿包：与插件代码同批进 Registry 包与 exe，用户不跑同步脚本也能开页面。
# 它是可重建的产物镜像（tools\build_pose_package.ps1 的落点），运行期只读，任何写入都不落这里。
PACKAGE_DIST = Path(__file__).parent / "pose_dist"
MODELS_DIR = DIST_DIR / "models"          # 自备素体 GLB 的落点（页面按 <key>.glb 取它）
MANIFEST_NAME = "MANIFEST.json"           # 随包发货清单：逐文件 sha256 与体积

# 摆姿页与它的子资源都走这条前缀：vite 产物是 base:'./' 的相对 import，页面必须落在有目录深度的
# URL 上，./assets/x.js 才会解析成 <前缀>/assets/x.js。挂在根级 /neo-pose 上时子资源全解析成
# /assets/*，摆姿页连自己的模块都取不到，所以短路径只做跳转。
# 前缀不进 /neo 命名空间：能力归属表只逐条登记 /neo 前缀下的接口，静态文件逐条打表没有意义；
# 也不进 /extensions，桌面端那条中间件把整段按 no-store 下发，带哈希的 wasm 每次刷新重传。
STATIC_PREFIX = "/pose-dist"
PAGE_URL = f"{STATIC_PREFIX}/index.html"
# 素体与道具的注册表在页面里写的是 origin 根上的绝对路径（/models/<key>.glb、
# /models/props/index.json）：vite 把注册表里的 source 原样发出去，页面在 /pose-dist/ 下
# 打开时这些请求落回 origin 根，前缀伺服一条都接不到。注册表读空的页面不会报错，
# 它按空注册表出控件清单 —— 道具面板空着，加具全部失败，GLB 素体一个都加载不出来。
MODELS_PREFIX = "/models"

# 桥的契约是接口不是代码：宿主、摆姿页、桥接用例三处同名，改动必须同批落地
BRIDGE_MESSAGES = ("pose:ready", "pose:theme", "neo:import-image",
                   "pose:export-image", "pose:save-scene", "pose:open-scene",
                   "pose:call", "pose:state")

# 摆姿、时间轴、导出全在浏览器里跑（three.js），本机服务只提供文件；照片估点、网格、pano 要
# pose-art 那套 Python sidecar（vite dev/preview 才挂载），桌面端进程起不动它们，页面按这几位置灰按钮。
# hostUi 反过来：宿主自带控件面板（pose.js 的工具条 + 侧栏），摆姿页据此收起自己的 demo 控件，
# 面板的动作经 pose:call 落到页面运行时上（动作清单在摆姿页 src/ui/hostCommands.js）。
# body_import 是宿主自己那条路，不依赖 sidecar：随包只发授权干净的 CC0 素体，Mixamo 与 SMPL 派生的
# 那几份由用户自备 GLB 经 /neo_pose/import_model 写进 <数据根>/pose/dist/models/，页面在自己的本地
# 导入区按 key 登记它（登记表在页面侧，宿主不碰）。
BRIDGE_CAPS = {"pose": True, "timeline": True, "export": True, "scene": True,
               "photo3d": False, "mesh": False, "pano": False, "body_import": True,
               "lib_write": False, "hostUi": True}

NOT_INSTALLED_HINT = ("未找到摆姿包：<数据根>/pose/dist 与插件目录的 pose_dist 两级都是空的。跑 "
                      "tools\\sync_pose_dist.ps1 把全量产物同步进数据根，或用随包那份 studio/pose_dist"
                      "（由 tools\\build_pose_package.ps1 生成，代码 + CC0 素体）。")

SCENE_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}")   # 首字符必须是字母数字：挡掉 ".." 与隐藏名
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
PRESET_SUFFIX = ".pose.json"      # 姿势库里一份姿态的文件名：<姿态名>.pose.json
MAX_BODY_BYTES = 48 * 1024 * 1024
# ControlNet 图组一次最多几张：一个视角 6 档，留两个视角的量（面板就是这两档组合）
MAX_SET_FILES = 12
GLB_EXT = ".glb"
GLB_MAGIC = b"glTF"          # glTF 2.0 二进制的文件头：挡掉改名成 .glb 的任意文件
# 一份自备素体的字节上限：GLB 走 base64 进 JSON，编码后膨胀 4/3，取 35MB 时 base64 约 46.7MB，
# 加上 JSON 外壳仍在 48MB 请求体上限内 —— 两条上限在同一次请求里都成立，不会出现「接口说得到、
# transport 先到」。2.9MB 的 Y Bot 远在限内，Mixamo 高模（十几 MB 级）也够。
MAX_GLB_BYTES = 35 * 1024 * 1024

# Windows 的 mimetypes 读注册表：.wasm 报 application/octet-stream 时
# WebAssembly.instantiateStreaming 直接拒收，Draco 解不出 GLB，摆姿页连人物都加载不出来。
EXTRA_TYPES = {".wasm": "application/wasm", ".glb": "model/gltf-binary",
               ".ktx2": "image/ktx2", ".mjs": "text/javascript",
               ".js": "text/javascript", ".css": "text/css", ".json": "application/json"}


@routes.get("/neo-pose")
async def pose_page(request):
    """3D 摆姿页短路径：跳到前缀下的入口页，相对资源才有目录深度可解析。"""
    if active_dist_dir() is None:
        return web.Response(text=_not_installed_html(), content_type="text/html", status=404)
    raise web.HTTPFound(PAGE_URL)


@routes.get("/neo_pose/status")
async def pose_status(request):
    """页面初始化读一次：装没装、能力位、已存场景，页面据此决定显示什么控件。"""
    return web.json_response(_json_safe(status_payload()))


async def pose_static(request):
    """摆姿包的前缀伺服：入口页每次校验，带内容哈希的 assets 长缓存。

    子资源由 iframe 内部直接加载（模块 import、GLB、wasm），不经宿主页面与 shim；
    入口页缓存住的话 WebView2 会连整张模块图一起用旧的，构建一变页面就跑旧代码。
    逐请求走两级落点，数据根那份压住随包的同名文件：新构建与用户自备素体因此优先，
    缺一级不影响另一级 —— 随包副本里只有一个 GLB 也照样能选到素体。
    """
    # 空路径 = 前缀本身（/pose-dist/）：地址栏直接敲前缀也要进页面，与静态服务器的目录口径一致
    return _dist_response(request.match_info["path"] or "index.html")


async def pose_models(request):
    """页面按 origin 根绝对路径要的那一级：素体 GLB 与道具注册表在产物里写死成 /models/...。

    与 /pose-dist/models/... 是同一批文件、同一套校验，两级落点同样数据根优先。
    这条前缀不是可选增强：道具注册表读空时页面不报「缺包」，它按空注册表出清单，
    面板里道具一条都没有、加具逐条失败，GLB 素体也全加载不出来。
    """
    return _dist_response(f"{MODELS_PREFIX}/{request.match_info['path']}")


def _dist_response(rel: str) -> web.StreamResponse:
    """两级落点里逐段找 rel：出根 400，目录按 index.html 进，两处都没有 404。"""
    for root in dist_dirs():
        target = inside_dir(root, rel)
        if target is None:
            return web.Response(status=400)
        if target.is_dir():
            target = target / "index.html"
        if target.is_file():
            return _file_response(target)
    return web.Response(status=404)


def register_static(routes):
    """把摆姿包挂上前缀：ComfyUI 端与桌面端各自直接注册，与伺服前端静态同一条路。

    路由不进模块的 RouteTableDef：能力归属表逐条核对 /neo 前缀下的挂载集合，
    多层静态前缀在那里没有对应形态。目录缺失由 handler 逐请求回 404，装完包不必重启。
    """
    routes.get(STATIC_PREFIX + "/{path:.*}")(pose_static)
    routes.get(MODELS_PREFIX + "/{path:.*}")(pose_models)


@routes.post("/neo_pose/import_image")
async def pose_import_image(request):
    """素材库 → 摆姿参考图：图片落进 pose/refs/，摆姿页用同源 URL 贴上参考平面。"""
    data, err = await _json_body(request)
    if err is not None:
        return err
    filename = str(data.get("filename", ""))
    subfolder = str(data.get("subfolder", ""))
    if not filename or ".." in filename:
        return _bad_request("filename 不合法")
    from .gallery import _find_source_media   # 素材解析与 Gallery 同一套；惰性导入避免 import 期依赖
    source = await asyncio.to_thread(_find_source_media, filename, subfolder)
    if source is None or not source.is_file():
        return web.json_response({"success": False, "error": f"素材不存在：{filename}"}, status=404)
    if source.suffix.lower() not in IMAGE_EXT:
        return _bad_request(f"摆姿参考图只支持图片：{source.suffix}")
    dest = await asyncio.to_thread(_unique_path, REFS_DIR, source.stem, source.suffix.lower())
    await asyncio.to_thread(shutil.copy2, source, dest)
    return web.json_response({"success": True, "name": dest.name,
                              "url": f"/neo_pose/refs/{dest.name}"})


@routes.get("/neo_pose/refs/{name}")
async def pose_ref(request):
    name = request.match_info["name"]
    if not SCENE_NAME_RE.fullmatch(name) or Path(name).suffix.lower() not in IMAGE_EXT:
        return web.Response(status=400)
    target = inside_dir(REFS_DIR, name)
    if target is None or not target.is_file():
        return web.Response(status=404)
    resp = _file_response(target)
    resp.headers["Cache-Control"] = "public, max-age=86400"   # 文件名唯一，内容不会原地变
    return resp


@routes.post("/neo_pose/export_image")
async def pose_export_image(request):
    """摆姿页 canvas 导出 → 素材库「我的上传」：落点复用 Gallery 的 custom 目录，
    Gallery 列表、缩略图与送节点通道因此都不需要第二条路径。"""
    from .gallery import CUSTOM_DIR
    data, err = await _json_body(request)
    if err is not None:
        return err
    raw = str(data.get("data", ""))
    if raw.startswith("data:"):
        _, _, raw = raw.partition(",")
    ext = str(data.get("ext") or ".png").lower()
    if ext not in IMAGE_EXT:
        return _bad_request(f"导出格式不支持：{ext}")
    try:
        body = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        return _bad_request("data 不是 base64 图片")
    if not body:
        return _bad_request("data 为空")
    stem = re.sub(r"[^\w\-]+", "_", str(data.get("name") or "pose")).strip("_")[:48] or "pose"
    dest = await asyncio.to_thread(_unique_path, CUSTOM_DIR, stem, ext)
    await asyncio.to_thread(dest.write_bytes, body)
    return web.json_response({"success": True, "filename": dest.name, "subfolder": "",
                              "size": len(body)})


@routes.get("/neo_pose/scenes")
async def pose_list_scenes(request):
    return web.json_response({"success": True, "scenes": _scene_rows()})


@routes.get("/neo_pose/scene")
async def pose_get_scene(request):
    """读一份场景 JSON：旧场景缺新字段照常返回，字段语义不因此改变。"""
    name = request.rel_url.query.get("name", "")
    if not SCENE_NAME_RE.fullmatch(name):
        return _bad_request("场景名只允许字母数字与 _ . -（64 字符内）")
    path = SCENES_DIR / f"{name}.json"
    if not path.is_file():
        return web.json_response({"success": False, "error": f"场景不存在：{name}"}, status=404)
    try:
        scene = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return web.json_response({"success": False, "error": f"场景读取失败：{exc}"}, status=500)
    return web.json_response(_json_safe({"success": True, "name": name, "scene": scene}))


@routes.post("/neo_pose/scene")
async def pose_save_scene(request):
    """场景落盘：先写 .tmp 再替换，窗口中途关掉不会留下半份 JSON。"""
    data, err = await _json_body(request)
    if err is not None:
        return err
    name = str(data.get("name", ""))
    if not SCENE_NAME_RE.fullmatch(name):
        return _bad_request("场景名只允许字母数字与 _ . -（64 字符内）")
    scene = data.get("scene")
    if not isinstance(scene, dict):
        return _bad_request("scene 需是 JSON 对象")
    await asyncio.to_thread(_write_json_atomic, SCENES_DIR / f"{name}.json", scene)
    return web.json_response({"success": True, "name": name})


@routes.get("/neo_pose/presets")
async def pose_list_presets(request):
    """姿势库列表：摆姿页导出的单份姿态（PoseFile v1），与场景分开存。"""
    return web.json_response({"success": True, "presets": _preset_rows()})


@routes.get("/neo_pose/preset")
async def pose_get_preset(request):
    """读一份姿态：整份 PoseFile 交回宿主，宿主再经 pose:call 装进画布。"""
    name = request.rel_url.query.get("name", "")
    if not SCENE_NAME_RE.fullmatch(name):
        return _bad_request("姿态名只允许字母数字与 _ . -（64 字符内）")
    path = PRESETS_DIR / f"{name}.pose.json"
    if not path.is_file():
        return web.json_response({"success": False, "error": f"姿态不存在：{name}"}, status=404)
    try:
        pose = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return web.json_response({"success": False, "error": f"姿态读取失败：{exc}"}, status=500)
    return web.json_response(_json_safe({"success": True, "name": name, "pose": pose}))


@routes.post("/neo_pose/preset")
async def pose_save_preset(request):
    """姿态落盘：画布导出的 PoseFile 原样存，字段语义由摆姿页定义（v1）。"""
    data, err = await _json_body(request)
    if err is not None:
        return err
    name = str(data.get("name", ""))
    if not SCENE_NAME_RE.fullmatch(name):
        return _bad_request("姿态名只允许字母数字与 _ . -（64 字符内）")
    pose = data.get("pose")
    if not isinstance(pose, dict):
        return _bad_request("pose 需是 JSON 对象")
    await asyncio.to_thread(_write_json_atomic, PRESETS_DIR / f"{name}.pose.json", pose)
    return web.json_response({"success": True, "name": name})


@routes.post("/neo_pose/preset/delete")
async def pose_delete_preset(request):
    """删一份姿态：只接受 UI 上选中的那一个名字，不提供清空姿势库。"""
    data, err = await _json_body(request)
    if err is not None:
        return err
    name = str(data.get("name", ""))
    if not SCENE_NAME_RE.fullmatch(name):
        return _bad_request("姿态名只允许字母数字与 _ . -（64 字符内）")
    path = PRESETS_DIR / f"{name}.pose.json"
    if not path.is_file():
        return web.json_response({"success": False, "error": f"姿态不存在：{name}"}, status=404)
    await asyncio.to_thread(path.unlink)
    return web.json_response({"success": True, "name": name})


@routes.post("/neo_pose/export_set")
async def pose_export_set(request):
    """ControlNet 图组 → 素材库「我的上传」：骨架图 / 深度图 / 剪影图一次一组落进去，
    生成侧（ControlNet 技能）要的就是素材库里的这几张，不另开第二条素材通路。"""
    from .gallery import CUSTOM_DIR
    data, err = await _json_body(request)
    if err is not None:
        return err
    files = data.get("files")
    if not isinstance(files, list) or not files:
        return _bad_request("files 需是非空数组")
    if len(files) > MAX_SET_FILES:
        return _bad_request(f"一次最多 {MAX_SET_FILES} 张")
    # 整批先验完再写：骨架图落盘、深度图被挡下的话，素材库里就留下一组缺一张的图，
    # ControlNet 侧要的是整套，半套只会让人以为导出了。
    staged = []
    for item in files:
        if not isinstance(item, dict):
            return _bad_request("files 的每一项需是对象")
        raw = str(item.get("data", ""))
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        ext = str(item.get("ext") or ".png").lower()
        if ext not in IMAGE_EXT:
            return _bad_request(f"导出格式不支持：{ext}")
        try:
            body = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            return _bad_request(f"data 不是 base64 图片：{item.get('name')}")
        if not body:
            return _bad_request(f"data 为空：{item.get('name')}")
        staged.append((item, ext, body))
    saved = []
    for item, ext, body in staged:
        # 名字是页面拼好的 pose_<场景>_<视角>_<格式>.png：只留文件名安全段，重名追加序号
        stem = re.sub(r"[^\w\-]+", "_", str(item.get("name") or "pose")).strip("_")[:48] or "pose"
        dest = await asyncio.to_thread(_unique_path, CUSTOM_DIR, stem, ext)
        await asyncio.to_thread(dest.write_bytes, body)
        saved.append(dest.name)
    return web.json_response({"success": True, "saved": saved, "count": len(saved)})


@routes.post("/neo_pose/import_model")
async def pose_import_model(request):
    """自备素体 → <数据根>/pose/dist/models/<key>.glb。

    随包只发授权干净的 CC0 素体（授权口径见 models/ATTRIBUTION.md），Mixamo 与 SMPL 派生的那几份
    条款不允许随包分发，由用户自备 GLB 从这条接口写进数据根那一级，页面再在自己的本地导入区按 key
    登记它（登记表在页面侧）。文件名就是 key：页面按 <key>.glb 拼地址，同名替换 = 同一 key 换模型，
    不会跑出第二个 key。只写数据根那一级，随包副本是只读的最小镜像。
    """
    data, err = await _json_body(request)
    if err is not None:
        return err
    key = str(data.get("key") or "").strip()
    if not SCENE_NAME_RE.fullmatch(key):
        return _bad_request("素体 key 只允许字母数字与 _ . -（64 字符内，首字符字母数字）")
    raw = str(data.get("data") or "")
    filename = str(data.get("filename") or "")
    if bool(raw) == bool(filename):
        return _bad_request("data 与 filename 二选一：base64 一份 GLB，或素材库里的一个文件")
    if raw:
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        try:
            body = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            return _bad_request("data 不是 base64 的 GLB")
        origin = "data"
    else:
        if ".." in filename:
            return _bad_request("filename 不合法")
        from .gallery import _find_source_media   # 素材解析与 Gallery 同一套；惰性导入避免 import 期依赖
        source = await asyncio.to_thread(_find_source_media, filename, str(data.get("subfolder", "")))
        if source is None or not source.is_file():
            return web.json_response({"success": False, "error": f"素材不存在：{filename}"}, status=404)
        if source.suffix.lower() != GLB_EXT:
            return _bad_request(f"自备素体只支持 .glb：{source.suffix}")
        body = await asyncio.to_thread(source.read_bytes)
        origin = "gallery"
    if not body:
        return _bad_request("GLB 内容为空")
    if len(body) > MAX_GLB_BYTES:
        return _bad_request(f"GLB 超过 {MAX_GLB_BYTES // (1024 * 1024)}MB 上限")
    if body[:4] != GLB_MAGIC:
        return _bad_request("文件头不是 glTF：只接受 .glb 二进制")
    name = f"{key}{GLB_EXT}"
    dest = inside_dir(MODELS_DIR, name)
    if dest is None:
        return _bad_request("key 不合法")
    await asyncio.to_thread(_write_bytes_atomic, dest, body)
    return web.json_response({"success": True, "key": key, "name": name,
                              "url": f"{STATIC_PREFIX}/models/{name}", "size": len(body),
                              "from": origin, "models_dir": str(MODELS_DIR)})


def dist_dirs() -> tuple:
    """摆姿包的两级落点，数据根在前：随包那份是最小副本，用户同步的全量产物压它。"""
    return (DIST_DIR, PACKAGE_DIST)


def active_dist_dir() -> Path | None:
    """现在生效的那一级 = 入口页在不在的那一级。逐请求问，装包与重装包都不必重启窗口。"""
    for root in dist_dirs():
        if (root / "index.html").is_file():
            return root
    return None


def _package_manifest() -> dict | None:
    """随包发货清单：读不出就当没有 —— 缺清单不影响页面跑，只在 status 里报空。"""
    try:
        payload = json.loads((PACKAGE_DIST / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _model_rows() -> list:
    """两级落点里在着的 GLB 素体文件名（去重排序）：页面内置注册表引用了哪几个、装机后实际在着
    哪几个，一眼对得上 —— 随包只发 CC0 那一份，其余要靠自备导入。"""
    names = set()
    for root in dist_dirs():
        try:
            for path in (root / "models").glob(f"*{GLB_EXT}"):
                names.add(path.name)
        except OSError:
            continue
    return sorted(names)


def status_payload() -> dict:
    active = active_dist_dir()
    manifest = _package_manifest() or {}
    files = manifest.get("files")
    return {
        "success": True,
        "installed": active is not None,
        "dist_dir": str(active) if active is not None else str(DIST_DIR),
        # 生效的那一级：数据根（同步的全量产物 / 自备素体）还是随包副本（最小授权副本）
        "dist_source": "data_root" if active == DIST_DIR else ("package" if active else ""),
        "package_installed": (PACKAGE_DIST / "index.html").is_file(),
        "package_dir": str(PACKAGE_DIST),
        "models_dir": str(MODELS_DIR),
        "models_present": _model_rows(),
        # 随包副本的发货清单：版本、生成时间、文件数与总字节；缺清单时全为空/0
        "manifest_version": str(manifest.get("format") or ""),
        "manifest_built": str(manifest.get("built_utc") or ""),
        "manifest_files": len(files) if isinstance(files, list) else 0,
        "manifest_bytes": int(manifest.get("total_bytes") or 0),
        "data_root": str(plugin_paths.DATA_ROOT),
        "assets_bytes": _tree_bytes((active or DIST_DIR) / "assets"),
        "caps": dict(BRIDGE_CAPS),
        "bridge": list(BRIDGE_MESSAGES),
        "scenes": _scene_rows(),
        "presets": _preset_rows(),
        "hint": "" if active is not None else NOT_INSTALLED_HINT,
    }


def inside_dir(root: Path, rel: str) -> Path | None:
    """root 内的相对路径：URL 里不允许 ..、绝对路径与盘符；符号链接也不给出根外的文件。
    绝对性只看 URL 里的那段文本 —— root 本身是绝对路径，拼接结果永远是绝对的。"""
    text = (rel or "").replace("\\", "/").strip("/")
    if not text or "\x00" in text or ":" in text:
        return None
    candidate = root / text
    if any(part == ".." for part in candidate.parts):
        return None
    resolved_root, resolved = root.resolve(), candidate.resolve()
    if not resolved.is_relative_to(resolved_root):
        return None
    return resolved


def _file_response(path: Path) -> web.FileResponse:
    resp = web.FileResponse(path)
    ctype = EXTRA_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0]
    if ctype:
        resp.headers["Content-Type"] = ctype
    # vite 的 assets/ 里文件名带内容哈希，构建一变名字就变，可以放心长缓存；
    # 未哈希的入口与资源每次校验，避免 WebView2 拿旧模块图跑旧代码。
    hashed = path.parent.name == "assets"
    resp.headers["Cache-Control"] = ("public, max-age=31536000, immutable" if hashed
                                     else "no-cache")
    return resp


def _scene_rows() -> list:
    rows = []
    try:
        for path in SCENES_DIR.glob("*.json"):
            stat = path.stat()
            rows.append({"name": path.stem, "size": stat.st_size, "mtime": int(stat.st_mtime)})
    except OSError:
        return []
    return sorted(rows, key=lambda row: -row["mtime"])


def _preset_rows() -> list:
    """姿势库列表：名字去掉 .pose.json 后缀 —— 接口上的姿态名就是这个名字。"""
    rows = []
    try:
        for path in PRESETS_DIR.glob(f"*{PRESET_SUFFIX}"):
            stat = path.stat()
            rows.append({"name": path.name[:-len(PRESET_SUFFIX)],
                         "size": stat.st_size, "mtime": int(stat.st_mtime)})
    except OSError:
        return []
    return sorted(rows, key=lambda row: -row["mtime"])


def _write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    tmp.replace(path)


def _write_bytes_atomic(path: Path, body: bytes) -> None:
    """GLB 落盘：先写 .tmp 再替换。一份 2.9MB 的模型写一半被窗口关掉截断，页面解 GLB 只会报坏文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.write(body)
    tmp.replace(path)


def _unique_path(directory: Path, stem: str, ext: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    dest = directory / f"{stem}{ext}"
    counter = 1
    while dest.exists():
        dest = directory / f"{stem}_{counter}{ext}"
        counter += 1
    return dest


def _tree_bytes(directory: Path) -> int:
    total = 0
    try:
        for path in directory.rglob("*"):
            if path.is_file():
                total += path.stat().st_size
    except OSError:
        return 0
    return total


async def _json_body(request) -> tuple:
    """带体积上限的 JSON 读取：导出图整张走 body，浏览器一次塞进来的不能是无限的。"""
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


def _not_installed_html() -> str:
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            "<title>3D 摆姿未安装</title></head>"
            '<body style="font:14px/1.7 system-ui;padding:24px;color:#e8e8ee;background:#14141c">'
            '<h3 style="margin:0 0 8px">3D 摆姿未安装</h3><p>' + NOT_INSTALLED_HINT +
            "</p></body></html>")


