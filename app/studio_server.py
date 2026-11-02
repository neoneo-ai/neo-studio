# SPDX-License-Identifier: Apache-2.0
"""Neo Studio 桌面端服务：一个端口上跑完整个 Studio。

桌面端在 ComfyUI 端口之外开一个 HTTP 服务（ComfyUI 端口 + 3），复用插件模块挂在各自 RouteTableDef
上的 handler 与 Studio 前端静态文件：窗口从打开那一刻就是可用的 Studio，并且**整个会话都留在这一
个 origin 上** —— 哪些接口桌面端自服由 app/studio_caps.py 一张表说清楚，表外的路径按同一层的
forwardable() 决定去留：清单内的由这里转发给 ComfyUI 内核（proxy_forward，含 /ws 事件流隧道），
清单外是桌面端没有这条接口（404），409 offline 只由「归内核却没有内核」的路径发出，前端据此门控。
转发时剥掉浏览器的身份头（Origin / Referer / Sec-Fetch-*）并把 Host 改写成内核地址，ComfyUI 的
origin_only 中间件因此照旧生效：内核只认本机脚本与自家前端，浏览器直接打 ComfyUI 端口仍然 403，
这道防线不在代理上让位。
"""

import importlib.util
import os
import sys
import threading
import asyncio
import time
from pathlib import Path

import aiohttp
from aiohttp import web

import studio_caps as caps
import mcp_client
import mcp_routes
import mobile_pair as pair

OFFLINE_ERROR = "ComfyUI 未运行"
DESKTOP_PKG = "_neo_studio_desktop"
DATA_ROOT_ENV = "NEO_STUDIO_DATA"   # 插件模块 import 期认的用户数据根
MCP_PREFIX = "/neo_mcp"
KERNEL_VERSION_PATH = "/neo_studio/kernel_version"   # 内核那份版本快照的专用入口，见 kernel_version

# 转发时逐跳剥掉的头：这些是连接层的事，交给内核与浏览器各自重谈
HOP_BY_HOP = frozenset({"transfer-encoding", "connection", "keep-alive", "upgrade",
                        "proxy-authenticate", "proxy-authorization", "te", "trailer",
                        "content-length", "host"})
# 出图与整片视频是分钟级的响应；连接失败要快点回，页面才知道「内核没了」
PROXY_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=10, sock_read=3600)

# 桌面端进程加载的插件模块，按依赖顺序：handler 只依赖 folder_paths、文件系统与 8080 LLM 服务。
DESKTOP_MODULES = ("util", "civitai", "bookmark", "gallery_lora", "gallery_oss", "gallery",
                 "minimax_h3", "skill", "laya_router", "prompt_names", "prompt_lines", "llm", "lora_tag",
                 "recipes", "video_gen", "image_gen_files", "model_hub", "skill_models",
                 "backyard", "agent", "pose", "frames")
DESKTOP_ROUTE_MODULES = ("gallery_lora", "gallery_oss", "gallery", "bookmark", "lora_tag",
                       "skill", "prompt_names", "llm", "recipes", "video_gen", "image_gen_files", "model_hub",
                       "skill_models", "backyard", "agent", "pose", "frames")

USERDATA_PATH = "/userdata/neo_gallery_data.json"


def load_desktop_modules(plugin_dir: Path) -> list:
    """按目录加载插件的桌面端模块：目录名带连字符不能 import，与 tests 里同一套加载方式。

    这些模块只依赖 folder_paths 与自身，不碰 PromptServer —— 桌面端进程里没有 ComfyUI 运行时。
    """
    pkg = type(sys)(DESKTOP_PKG)
    pkg.__path__ = [str(plugin_dir)]
    sys.modules[DESKTOP_PKG] = pkg

    def load(name):
        mod_name = f"{DESKTOP_PKG}.{name}"
        if mod_name in sys.modules:
            return sys.modules[mod_name]
        spec = importlib.util.spec_from_file_location(mod_name, plugin_dir / f"{name}.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        setattr(pkg, name, mod)
        spec.loader.exec_module(mod)
        return mod

    for name in DESKTOP_MODULES:
        load(name)
    return [sys.modules[f"{DESKTOP_PKG}.{n}"].routes for n in DESKTOP_ROUTE_MODULES]



@web.middleware
async def no_store(request, handler):
    """插件静态文件一律 no-store，与 ComfyUI 的 /extensions 同一套。

    不带 Cache-Control 时 WebView2 按启发式策略缓存 JS：桌面端窗口开着的时候改了 web/*.js，
    回离线页就会把缓存里的旧模块和新拉到的模块拼进同一张模块图 —— 一个 ES 模块链接错误
    （旧 gallery-utils.js 没有新导出）发生在 studio-app.js 执行之前，JS 自己捕获不到，
    整页只剩顶栏：视图不挂、离线横幅不出、顶栏胶囊永远 hidden，连重新拉起的按钮都没有。"""
    resp = await handler(request)
    if request.path.startswith("/extensions/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# 局域网监听把桌面端端口绑到网卡上之后，网段上的设备就是这台机器的另一块屏幕：页面、素材库、
# 摆姿页、配方、技能这些数据路由对私段对端照开——只放一张配对页的话，手机上的素材库是空的、
# 摆姿页报「后端未就绪」，等于把不能用的控件交出去。挡的是桌面管理那一面（MCP 子进程、启动设置、
# 日志、重启 / 关机 / 显存、出码用的令牌数据与桥上的对应口）和 configs 静态目录
# （remote_llm_config.json / backyard_oss.json / model_hub.json 都在这底下）。
LAN_HIDDEN = (
    "/neo_mcp", "/neo_shim/mcp", "/neo_shim/launcher", "/neo_shim/desktop_log",
    "/neo_shim/restart", "/neo_shim/shutdown", "/neo_shim/comfyui_shutdown",
    "/neo_shim/pair_info", "/neo_shim/pair_rotate",
    "/neo_studio/launcher", "/neo_studio/restart", "/neo_studio/shutdown",
    "/neo_studio/log", "/neo_studio/open_log", "/neo_studio/mem_stats",
    "/neo_studio/mcp", "/neo-studio/pair/info", "/neo_studio/pair/info",
    "/neo-studio/launcher", "/neo-studio/settings", "/neo-studio/open_log",
    "/neo-studio/restart", "/neo-studio/shutdown", "/neo-studio/mem_stats",
    "/neo-studio/mcp", "/neo_settings", "/userdata/configs",
)


def lan_path_open(path: str, peer: str) -> bool:
    """这条路径对局域网对端开不开（dsh-desktop 里 isPrivateAddress(transportAddress) 那一层）：
    本机自己（含拿不到对端地址的本地套接字）全通，私段对端通创作面、挡桌面管理与密钥，公网对端全关。"""
    if not peer or pair.is_loopback(peer):
        return True
    return pair.is_private(peer) and not path.startswith(LAN_HIDDEN)


def _peer_ip(request) -> str:
    peer = request.transport.get_extra_info("peername")
    return str(peer[0]) if peer and len(peer) else ""


@web.middleware
async def lan_surface(request, handler):
    """非回环对端只许碰手机那一面：桌面端服务一旦绑上网卡，路由收口就归这一处，
    不在各条 handler 里散着判地址。"""
    if lan_path_open(request.path, _peer_ip(request)):
        return await handler(request)
    if request.path.startswith((MCP_PREFIX, "/neo_studio/")):
        return web.json_response({"success": False, "error": "这条路由只在桌面端窗口里可用"},
                                 status=403)
    return web.Response(text="这条路由只在桌面端窗口里可用", status=403)


async def studio_page(request):
    resp = web.FileResponse(request.app["studio_index"])
    resp.headers["Cache-Control"] = "no-cache"
    return resp


async def userdata_get(request):
    path = request.app["userdata"]
    if not path.exists():
        return web.json_response({})
    return web.FileResponse(path)


async def userdata_post(request):
    body = await request.read()
    path = request.app["userdata"]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(body)
    tmp.replace(path)
    return web.json_response({"success": True})


async def view_file(request):
    """只读 /view：与 ComfyUI 同一套解析（annotated_filepath + type 目录 + subfolder 越界检查）。"""
    folder_paths = sys.modules["folder_paths"]   # build_app 已把 ComfyUI 根加进 sys.path 并加载
    filename = request.rel_url.query.get("filename")
    if not filename:
        return web.Response(status=404)
    filename, output_dir = folder_paths.annotated_filepath(filename)
    if not filename:
        return web.Response(status=400)
    if filename[0] == "/" or ".." in filename:
        return web.Response(status=400)
    if output_dir is None:
        output_dir = folder_paths.get_directory_by_type(request.rel_url.query.get("type", "output"))
    if output_dir is None:
        return web.Response(status=400)
    if "subfolder" in request.rel_url.query:
        full_output_dir = os.path.join(output_dir, request.rel_url.query["subfolder"])
        if os.path.commonpath((os.path.abspath(full_output_dir), output_dir)) != output_dir:
            return web.Response(status=403)
        output_dir = full_output_dir
    file = os.path.join(output_dir, os.path.basename(filename))
    if not os.path.isfile(file):
        # 本机没有这份文件：交给内核。远端内核的输出目录在远端机器上，桌面端这边按本机目录
        # 判存在就是把出图整条挡死（生成成功、页面拿不到图）
        return await proxy_forward(request)
    return web.FileResponse(file)


async def studio_version(request):
    """页面每 5 秒读的那份快照：初始化、能力门控与就绪翻面全认它。

    pywebview 的 js_api 注入晚于页面加载，冷启动那几秒前端只有这份快照知道「桌面端已拉起、
    端口未就绪」，不会先闪「未运行」与「需要 ComfyUI」提示。
    kernel_ready 是生成面的总开关：就绪前后页面是同一个地址，翻面只换这份能力表与事件流目标。
    kernel_port / kernel_origin 是「主画布编辑」那一发的落点 —— 画布只在 ComfyUI 自己的页面上，
    本机内核按页面自己的主机名配端口（局域网对端的主机名就是它那台机器看得到的本机地址），
    远程内核直接用桌面端配的地址。"""
    flags = request.app["flags"]
    launcher = request.app["launcher"]
    kernel_ready = bool(str(flags.get("kernel_base") or ""))
    return web.json_response({
        "success": True,
        "plugin": "Neo Studio",
        "plugin_version": request.app["plugin_version"],
        "comfyui_version": OFFLINE_ERROR,
        "offline": not kernel_ready,
        "starting": bool(flags.get("starting")),
        "kernel_ready": kernel_ready,
        "kernel_port": int(flags.get("kernel_port") or 0),
        "kernel_origin": str(flags.get("kernel_origin") or ""),
        "caps": caps.features(kernel_ready),
        # 「设置 → 关于」里的路径行：桌面端知道自己的数据根、ComfyUI 根与远程地址
        "data_root": str(request.app.get("data_root") or ""),
        "comfy_local": str(request.app.get("comfy_root") or ""),
        "remote": str(launcher.get("remote", "")),
        "recipes": [],
    })


async def comfy_state(request):
    """顶栏状态位的 HTTP 版：pywebview 在导航完成之后才注入 js_api，整页刷新时实测能晚到页面脚本
    之后好几秒（data/studio_desktop.log 里 before_load 与 loaded 隔 7 秒，UI 线程正忙于拖动循环），
    状态位只挂在桥上的话刷新一次就永久消失，就绪后的原地翻面也一起断在这里。
    provider 是 StudioDesktop.comfy_state：探活是阻塞的（probe 1 秒 + 按端口找 PID），丢线程里跑，
    别占着桌面端的事件循环。引导页那一路桌面端还没装配出内核，没有 provider 就明说没有。"""
    provider = request.app.get("kernel_state")
    if provider is None:
        return web.json_response({"success": False, "error": OFFLINE_ERROR}, status=409)
    return web.json_response({"success": True, **await asyncio.to_thread(provider)})


async def desktop_log(request):
    """离线时的「设置 → 日志」：读桌面端拉起 ComfyUI 的完整输出（data/comfy_run.log）。"""
    entries = []
    try:
        with open(request.app["comfy_log"], "r", encoding="utf-8", errors="replace") as f:
            entries = [{"m": line} for line in f.readlines()[-400:]]
    except OSError:
        pass
    return web.json_response({"success": True, "entries": entries})



def _kernel_base(request) -> str:
    """转发目标：桌面端报进来的内核地址，空 = 这轮没有内核。"""
    return str(request.app["flags"].get("kernel_base") or "")


def offline_response(request) -> web.Response:
    """内核不在：与「桌面端不认这条接口」同形，前端据此弹离线提示并照能力表门控。"""
    return web.json_response({"success": False, "offline": True, "error": OFFLINE_ERROR}, status=409)


def _forward_headers(request) -> dict:
    """转发要带的请求头：逐跳头与浏览器身份全部剥掉。

    ComfyUI 的 origin_only 中间件比的是 Origin/Referer 的 host 与请求的 Host。带上门页的
    Origin 进内核就是 403；不送 Host 让 aiohttp 按目标地址定，再摘掉 Origin/Referer 与
    Sec-Fetch-*，内核视之为本机脚本请求 —— 这道防线在 ComfyUI 侧原样留着，浏览器直接打
    ComfyUI 端口照旧被挡，代理只是本机进程替页面发这一发。"""
    headers = {}
    for key, value in request.headers.items():
        low = key.lower()
        if low in HOP_BY_HOP or low in ("origin", "referer") or low.startswith("sec-fetch"):
            continue
        headers[key] = value
    return headers


async def proxy_forward(request, method: str = "", path: str = "") -> web.StreamResponse:
    """把内核的路由原样转一手：请求体与响应体都是流式，不整份进内存。

    出图与整片视频是分钟级响应、上传是几十 MB 的体，两份都过内存就是把桌面端服务做成
    一个缓存层。auto_decompress=False（见 build_app）+ 摘掉逐跳头 = gzip/br 与 Range/206
    的 Content-Range 原样交回浏览器；allow_redirects=False 让 3xx 照原样透传，桌面端不替
    页面决定它最终落在哪台主机上。"""
    base = _kernel_base(request)
    if not base:
        return offline_response(request)
    method = method or request.method
    target = base + (path or request.path)
    if request.query_string:
        target += "?" + request.query_string
    kwargs = {"headers": _forward_headers(request), "allow_redirects": False}
    if request.can_read_body:
        kwargs["data"] = request.content
        kwargs["chunked"] = True
    try:
        async with request.app["proxy_session"].request(method, target, **kwargs) as upstream:
            resp = web.StreamResponse(status=upstream.status,
                                      headers={k: v for k, v in upstream.headers.items()
                                               if k.lower() not in HOP_BY_HOP})
            await resp.prepare(request)
            async for chunk in upstream.content.iter_any():
                await resp.write(chunk)
            await resp.write_eof()
            return resp
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        log = request.app.get("log")
        if log:
            log(f"proxy {method} {target} failed: {exc!r}")
        return offline_response(request)


async def kernel_version(request):
    """内核那份版本快照：设置页要显示的 ComfyUI 版本与内核侧能力表只有内核知道。

    /neo_studio/version 是两端同名的一条 —— 桌面端必须自己答（页面靠它认桌面端的能力表），
    内核那份就从这条专用路由转过去。转发清单不收整条 /neo_ 前缀的默认路径，逐条点名。"""
    return await proxy_forward(request, method="GET", path="/neo_studio/version")


async def studio_ws(request):
    """页面连的 /ws：内核在跑时双向接力到内核的事件流，没在跑时接住挂着。

    两条都要 —— 不接的话离线页每 2 秒刷一次连接错误；不接力的话就绪后的进度、出图、
    队列变化全不来。内核重启时主动以 4000 断开（「服务重启，请重连」），这个码原样交给
    页面：前端 2 秒后重连，桌面端这边每条连接现开一条上行，内核回来隧道跟着回来。"""
    client = web.WebSocketResponse(heartbeat=30.0)
    await client.prepare(request)
    base = _kernel_base(request)
    if not base:
        async for _ in client:
            pass
        return client
    url = base.replace("https://", "wss://").replace("http://", "ws://") + "/ws"
    if request.query_string:
        url += "?" + request.query_string
    try:
        async with request.app["proxy_session"].ws_connect(url, timeout=15) as upstream:
            to_page = asyncio.create_task(_relay(upstream, client))
            to_kernel = asyncio.create_task(_relay(client, upstream))
            try:
                await asyncio.wait({to_page, to_kernel}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                to_page.cancel()
                to_kernel.cancel()
            code = upstream.close_code or client.close_code
            if code and code not in (1000, 1005, 1006):
                await client.close(code=code)   # 内核的重启码原样传下去，前端认它
            await upstream.close()
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        log = request.app.get("log")
        if log:
            log(f"ws tunnel to {url} failed: {exc!r}")
        await client.close(code=4003, message=str(exc).encode("utf-8")[:200])
    return client


async def _relay(src, dst):
    """一条方向上的帧接力：文本与二进制原样搬，连接层的事到这边为止。"""
    async for msg in src:
        if msg.type == aiohttp.WSMsgType.TEXT:
            await dst.send_str(msg.data)
        elif msg.type == aiohttp.WSMsgType.BINARY:
            await dst.send_bytes(msg.data)
        else:
            break


async def proxy_catch(request):
    """表外的请求：清单内的转手给内核，清单外是桌面端没有这条接口（404）。

    带 offline 的响应体是页面的离线信号（shim 见它就广播「需要 ComfyUI」），409 因此只从
    「这条归内核、这一轮却没有内核」的路径发出：清单外的路径在内核在跑时答 409，页面就会在
    出图成功之后弹一条「需要 ComfyUI · 启动内核」。"""
    if not caps.forwardable(request.method, request.path):
        log = request.app.get("log")
        if log:
            log(f"desktop 404 {request.method} {request.path}")
        return web.json_response({"success": False,
                                  "error": f"桌面端没有这条接口：{request.path}"}, status=404)
    return await proxy_forward(request)


async def launcher_get(request):
    """「启动设置」页读的快照：根目录 / 解释器 / 端口 / 插件位置 / 自检状态。"""
    return web.json_response(request.app["launcher"])


async def launcher_post(request):
    """设置页的保存与重试都走这里：校验与进程操作都在桌面端里，桌面端只转达结果。"""
    data = await request.json()
    action = data.get("action", "apply")
    fn = request.app["launcher_api"].get(action)
    if fn is None:
        return web.json_response({"ok": False, "error": f"不支持的操作：{action}"}, status=400)
    if action == "apply":
        # listen 缺省 = 这次没动监听；空串 = 清空（只监听本机）。remote 同理：空串 = 连回本机
        res = fn(data.get("root", ""), data.get("python", ""), data.get("port", 0),
                 data.get("listen"), data.get("remote"))
    elif action == "set_frameless":
        res = fn(bool(data.get("frameless")))
    elif action == "set_dev_mode":
        res = fn(bool(data.get("dev_mode")))
    else:
        res = fn()
    return web.json_response(res)


def _pair_host(request) -> str:
    """请求的 Host 头是否落在本机网卡网段上（局域网来的请求）。

    配对页与令牌校验只认这个：回环（桌面端窗口自己）与公网地址一律不算，
    公网 Host 头扫开也连不上，还会把配对入口暴露到不信任的网段之外。
    """
    ctx = request.app.get("pair_ctx") or {}
    return pair.lan_host(request.headers.get("Host", ""), ctx.get("lan_prefixes", lambda: [])())


def port_of(request) -> int:
    """桌面端服务当前绑定的端口：端口被占时 DesktopServer 会换到下一个空闲端口，
    所以二维码里的端口只能在出码时现问，不能拿启动时算的那个。"""
    return int((request.app.get("pair_ctx") or {}).get("port_get", lambda: 0)())


PAIR_LOOPBACK_TEXT = (
    "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<body style=\"font-family:system-ui,sans-serif;background:#0b0d12;color:#e8ecf4;"
    "padding:28px;line-height:1.7\">"
    "<h2 style=\"font-size:19px\">请在电脑上看这一步</h2>"
    "<p style=\"color:#9fb0c8\">这条地址只有局域网里的设备能打开。"
    "电脑上的 Neo Studio「设置 → 手机连接」里有扫码用的二维码与局域网地址。</p></body>")


async def pair_page(request):
    """手机扫开二维码后的配对页：桌面端服务端口上的独立页面，不需要装 App。

    页面自己要验令牌，服务端在这里只挡两件事：非局域网地址直接来的请求，以及
    页面文件的缓存（页面会带着新令牌反复打开，缓存一次就把过期令牌钉在手机上了）。
    """
    if not _pair_host(request):
        return web.Response(text=PAIR_LOOPBACK_TEXT, content_type="text/html",
                            status=403, headers={"Cache-Control": "no-store"})
    return web.FileResponse(request.app["pair_page"], headers={"Cache-Control": "no-store"})


async def pair_check(request):
    """配对页带着令牌来问一次：令牌有效就把 Studio 的局域网地址交回页面做入口。"""
    host = _pair_host(request)
    if not host:
        return web.json_response({"success": False, "valid": False, "error": "仅限局域网访问"}, status=403)
    now = time.time()
    valid = pair.token_ok(request.app["launcher"], request.query.get("token", ""), now)
    return web.json_response({"success": True, "valid": valid,
                              "base_url": f"http://{host}:{port_of(request)}{pair.STUDIO_PATH}",
                              "seconds_left": pair.seconds_left(request.app["launcher"], now)})


async def pair_info(request):
    """设置页「手机连接」的数据：二维码正文、令牌、剩余秒数、监听是否放开。

    桌面端窗口自己就是回环，这里的地址取请求 Host 头（手机眼中的本机地址），
    头是回环时沿用上次落盘的那份，二维码与手机扫到的始终是同一个地址。
    令牌在这里生成/续期，落盘由桌面端注入的 save 负责。
    """
    ctx = request.app.get("pair_ctx") or {}
    cfg = request.app["launcher"]
    lan_prefixes = ctx.get("lan_prefixes", lambda: [])()
    listen = str(ctx.get("listen_get", lambda: "")())
    host = pair.lan_host(request.headers.get("Host", ""), lan_prefixes)
    # 桌面端窗口自己就是回环：Host 头给不出局域网地址，交 pair.pick_lan_host 挑同一块网卡
    host = host or pair.pick_lan_host(str(cfg.get("pair_host") or ""), listen)
    info = pair.pair_payload(cfg, host, port_of(request), time.time(), lan_open=bool(listen))
    if cfg.get("pair_dirty"):
        cfg.pop("pair_dirty")
        save = ctx.get("save")
        if save:
            await asyncio.to_thread(save)
    return web.json_response(info)


def mcp_config_path(plugin_dir: Path, data_root: Path = None) -> Path:
    """MCP 注册表的落点：用户数据根的 configs/。data_root 没给时落插件的 tmp/ ——
    与 comfy_run.log 的兜底同一套，用户数据不落插件目录是硬规矩。"""
    base = Path(data_root) if data_root else plugin_dir / "tmp"
    return base / "configs" / "mcp_servers.json"


def build_app(root: Path, plugin_dir: Path, flags: dict = None, launcher: dict = None,
              launcher_api: dict = None, comfy_log: Path = None,
              data_root: Path = None, mcp_manager=None, kernel_state=None,
              pair_ctx: dict = None, log=None) -> web.Application:
    """桌面端 app：Studio 页面 + 前端静态文件 + 能力清单里归桌面端的全部路由 + 到内核的转发。
    flags 是桌面端报进来的那份状态（与 StudioDesktop 共用同一份 dict）：kernel_base 是转发目标，
    kernel_port / kernel_origin 是画布链接的落点，starting 随版本快照下发给页面。
    launcher / launcher_api 同样与 StudioDesktop 共用：设置页在桌面端读快照、发保存。
    data_root 是桌面端的用户数据根：插件模块 import 期按它找 gallery / recipes / configs，
    桌面端服务与桌面端拉起的内核因此读同一份数据。
    mcp_manager 与 StudioDesktop 共用同一份会话登记表：关窗收尾要回收的进程与页面连着的是
    同一批；没给时按 data_root 建一个，注册表落在 <data_root>/configs/mcp_servers.json。
    kernel_state 是 StudioDesktop.comfy_state 那份内核状态，顶栏状态位刷新后靠它从 HTTP 侧补上。
    log 是桌面端那份日志函数：转发的失败只活在这一行里，别把「代理没通」写成页面的裸 409。"""
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    import folder_paths   # noqa: F401  gallery 在 import 期就要读 output/input 目录
    # extra_model_paths.yaml 是 ComfyUI 在 main.py 的 apply_custom_paths 里加载的，桌面端进程没有
    # 这条路：不自己加载的话 get_filename_list 只扫 <root>/models/。模型放在 extra 路径的机器上
    # （整合包的 yaml 是 base_path: F:\ → 模型在 F:\models\），离线页的模型下拉就是空表，
    # 技能里已存的模型路径全标「(缺失)」，「修复失效路径」也匹配不到任何候选。
    extra_cfg = Path(root) / "extra_model_paths.yaml"
    if extra_cfg.is_file():
        from utils.extra_config import load_extra_path_config
        load_extra_path_config(str(extra_cfg))

    if data_root:
        os.environ[DATA_ROOT_ENV] = str(data_root)
    routes = web.RouteTableDef()
    routes.get("/neo-studio")(studio_page)
    routes.static("/extensions/comfyui-neo-studio", str(plugin_dir / "web"))
    for table in load_desktop_modules(plugin_dir):
        for route in table:
            if caps.owner(route.method, route.path) == "desktop":
                routes.route(route.method, route.path, **route.kwargs)(route.handler)

    # 摆姿包的静态前缀：数据根里的 vite 产物，逐请求判断装没装，能力表不给静态文件逐条打表
    sys.modules[f"{DESKTOP_PKG}.pose"].register_static(routes)

    routes.get(USERDATA_PATH)(userdata_get)
    routes.post(USERDATA_PATH)(userdata_post)
    routes.get("/neo_studio/version")(studio_version)
    routes.get(KERNEL_VERSION_PATH)(kernel_version)
    routes.get("/neo_studio/comfy_state")(comfy_state)
    routes.get("/neo_studio/log")(desktop_log)
    routes.get("/neo_studio/launcher")(launcher_get)
    routes.post("/neo_studio/launcher")(launcher_post)
    routes.get("/view")(view_file)
    routes.get("/ws")(studio_ws)
    # 手机扫码连接（局域网）：配对页 + 令牌校验 + 设置页轮询的二维码数据
    routes.get(pair.PAIR_PATH)(pair_page)
    routes.get(pair.PAIR_CHECK_PATH)(pair_check)
    routes.get(pair.PAIR_INFO_PATH)(pair_info)

    # aiohttp 默认只收 1MB 请求体：自备素体（35MB GLB 走 base64 约 47MB）与 ControlNet 图组会在
    # handler 之前被 transport 挡成 413，插件端（ComfyUI 的 --max-upload-size 默认 100MB）能跑的
    # 体积到了桌面端就白跑。这里放到接口自身上限之上，让「超过上限」由接口的 400 说清楚。
    pose_mod = sys.modules[f"{DESKTOP_PKG}.pose"]
    app = web.Application(middlewares=[no_store, lan_surface],
                          client_max_size=pose_mod.MAX_BODY_BYTES + 8 * 1024 * 1024)
    app["flags"] = flags if flags is not None else {}
    app["log"] = log
    app["studio_index"] = plugin_dir / "web" / "studio" / "index.html"
    app["userdata"] = Path(folder_paths.get_user_directory()) / "default" / "neo_gallery_data.json"
    app["comfy_log"] = Path(comfy_log) if comfy_log else plugin_dir / "tmp" / "comfy_run.log"
    app["launcher"] = launcher if launcher is not None else {}
    app["launcher_api"] = launcher_api if launcher_api is not None else {}
    # 「设置 → 关于」的路径行读这两份：ComfyUI 根由解释器启动参数决定，数据根由桌面端解析
    app["comfy_root"] = Path(root)
    app["data_root"] = Path(data_root) if data_root else None
    app["plugin_version"] = sys.modules[f"{DESKTOP_PKG}.util"].plugin_version()
    app["kernel_state"] = kernel_state
    # 手机扫码连接的上下文（端口 / 网卡前缀 / 监听是否放开 / 落盘）与配对页文件，
    # 由 app/studio_app.py 装配；没给时配对页与非局域网地址同样一律 403
    app["pair_page"] = plugin_dir / "web" / "studio" / "pair.html"
    app["pair_ctx"] = pair_ctx or {}
    if mcp_manager is not None:
        app["mcp"] = mcp_manager
    else:
        # 注册表还没有文件时内置这一条：插件自带 mcp_server.py，桌面端服务认得自己的解释器与副本路径
        builtin = mcp_client.builtin_server(sys.executable, plugin_dir / "mcp_server.py",
                                            f"http://127.0.0.1:{app['launcher'].get('port') or 8188}")
        app["mcp"] = mcp_client.McpManager(mcp_config_path(plugin_dir, data_root),
                                           defaults=[builtin] if builtin else [])

    app.add_routes(routes)
    app.add_routes(mcp_routes.routes)
    # catch-all 必须最后注册：aiohttp 按注册顺序匹配，静态与浏览路由先占位。
    # 方法要收全：ComfyUI 的 /queue/{id} 与 /history/{id} 是 DELETE，只登记 GET/POST 的话
    # 队列面板的「移出」在桌面端口上直接 405
    app.router.add_route("*", "/{path:.*}", proxy_catch)
    app.on_startup.append(_open_proxy_session)
    app.on_cleanup.append(_close_proxy_session)
    return app


async def _open_proxy_session(app):
    """转发用的连接池：随 app 起、随 app 收，桌面端服务退出时不留半开的到内核连接。

    auto_decompress=False 是硬要求：解掉一份 gzip 再按原 Content-Encoding 头交出去，
    页面拿到的就是坏字节；Range/206 那一路同理，字节流必须原样透传。
    trust_env=False：转发目标只有本机内核与用户在启动设置里填的那台远端，不读系统代理。"""
    app["proxy_session"] = aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(limit=120),
        auto_decompress=False,
        trust_env=False,
        timeout=PROXY_TIMEOUT)


async def _close_proxy_session(app):
    await app["proxy_session"].close()


class DesktopServer:
    """桌面端自己的只读 HTTP 服务：后台线程 + 独立事件循环，随窗口退出。"""

    def __init__(self, app_factory, port: int, bind_hosts=None):
        self.app_factory = app_factory
        self.port = port
        self.bind_hosts = bind_hosts   # 回环之外还要绑的地址（局域网监听放开时给）：每次起服现问
        self.loop = None
        self.thread = None
        self.bound = 0
        self.sites = []   # 起服时绑上的那批 TCPSite（回环 + 局域网网卡）
        self.error = None   # 装配失败的原因（缺依赖 / 目录不可读）：start() 只回 0，原因交给桌面端记日志
        self.ready = threading.Event()

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._serve())
        except Exception as e:
            self.error = e
            self.ready.set()   # app 装配失败：让 start() 立刻拿到 0


    async def _serve(self):
        runner = web.AppRunner(self.app_factory())
        await runner.setup()
        hosts = ["127.0.0.1"]
        extra = [h for h in ((self.bind_hosts or (lambda: []))() or []) if h]
        if any(h in ("0.0.0.0", "::") for h in extra):
            # 全监听已覆盖回环：同一端口上再绑一次 127.0.0.1 会撞
            hosts = [h for h in extra if h in ("0.0.0.0", "::")]
        else:
            hosts += extra
        for port in range(self.port, self.port + 6):
            sites = []
            for host in hosts:
                site = web.TCPSite(runner, host, port)
                try:
                    await site.start()
                except OSError:
                    break
                sites.append(site)
            else:
                self.bound = port
                self.sites = sites
                break
            # 这块端口没绑全（端口被占 / 填的网卡地址不在本机）：整组让位给下一个端口
            for site in sites:
                await site.stop()
        self.ready.set()
        await asyncio.Event().wait()   # 常驻：循环停在这里，直到 stop() 把它叫醒

    def start(self) -> int:
        """起服务，返回实际监听端口；0 = 起不来（桌面端退回启动页）。"""
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self.ready.wait(timeout=30)
        return self.bound

    def stop(self) -> None:
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self.loop.stop)
            if self.thread is not None:
                self.thread.join(timeout=1.5)   # 循环平时停在 Event().wait()，叫醒是毫秒级；上限压在这里，别把关窗拖成「卡死」


