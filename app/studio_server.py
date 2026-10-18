# SPDX-License-Identifier: Apache-2.0
"""Neo Studio 桌面端服务：ComfyUI 没在跑时，窗口里也能用大部分 Studio 功能。

桌面端在 ComfyUI 端口之外开一个 HTTP 服务（ComfyUI 端口 + 3），复用插件模块挂在各自 RouteTableDef
上的 handler 与 Studio 前端静态文件：窗口从打开那一刻就是可用的 Studio。哪些接口桌面端能服务、哪些
必须 ComfyUI 在跑，由 app/studio_caps.py 一张表说清楚 —— 桌面端按它挂载，表外的一律 409 offline，
前端据此门控。桌面端自己拉起的 ComfyUI 就绪后，页面留在本端口上把生成类请求直连过去（app/studio_app.py
的 comfy_cors）；局域网监听与远程那路仍由桌面端整页跳到 ComfyUI 端口的完整 Studio。
"""

import importlib.util
import os
import sys
import threading
import asyncio
from pathlib import Path

from aiohttp import web

import studio_caps as caps
import mcp_client
import mcp_routes

OFFLINE_ERROR = "ComfyUI 未运行"
DESKTOP_PKG = "_neo_studio_desktop"
DATA_ROOT_ENV = "NEO_STUDIO_DATA"   # 插件模块 import 期认的用户数据根

# 桌面端进程加载的插件模块，按依赖顺序：handler 只依赖 folder_paths、文件系统与 8080 LLM 服务。
DESKTOP_MODULES = ("util", "civitai", "bookmark", "gallery_lora", "gallery_oss", "gallery",
                 "minimax_h3", "skill", "laya_router", "prompt_lines", "llm", "lora_tag",
                 "recipes", "video_gen", "image_gen_files", "model_hub", "backyard")
DESKTOP_ROUTE_MODULES = ("gallery_lora", "gallery_oss", "gallery", "bookmark", "lora_tag",
                       "skill", "llm", "recipes", "video_gen", "image_gen_files", "model_hub",
                       "backyard")

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
        return web.Response(status=404)
    return web.FileResponse(file)


async def studio_version(request):
    """离线快照：页面靠它完成初始化，并拿到桌面端能力表决定哪些功能可用。
    starting 一并下发：pywebview 的 js_api 注入晚于页面加载，冷启动那几秒前端只有这份快照
    知道「桌面端已拉起、端口未就绪」，不会先闪「未运行」与「需要 ComfyUI」提示。
    routes 是归属表（caps.route_list）；comfy_base 非空表示这路 ComfyUI 认桌面端 origin，
    页面原地把生成类请求切过去，不整页跳转。"""
    flags = request.app["flags"]
    return web.json_response({
        "success": True,
        "plugin": "Neo Studio",
        "plugin_version": request.app["plugin_version"],
        "comfyui_version": OFFLINE_ERROR,
        "offline": True,
        "starting": bool(flags.get("starting")),
        "caps": caps.features(),
        "routes": caps.route_list(),
        "comfy_base": str(flags.get("comfy_base", "")),
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



async def studio_ws(request):
    """shim 会连 /ws：接住连接挂着，避免页面刷连接错误。"""
    ws = web.WebSocketResponse(heartbeat=30.0)
    await ws.prepare(request)
    async for _ in ws:
        pass
    return ws


async def offline(request):
    """桌面端服务不认的插件接口一律明确回「ComfyUI 未运行」，不让前端拿到裸 404。"""
    if request.path.startswith(("/neo_", "/rs_", "/userdata/", "/api/")):
        return web.json_response({"success": False, "offline": True, "error": OFFLINE_ERROR}, status=409)
    return web.Response(status=404)


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


def mcp_config_path(plugin_dir: Path, data_root: Path = None) -> Path:
    """MCP 注册表的落点：用户数据根的 configs/。data_root 没给时落插件的 tmp/ ——
    与 comfy_run.log 的兜底同一套，用户数据不落插件目录是硬规矩。"""
    base = Path(data_root) if data_root else plugin_dir / "tmp"
    return base / "configs" / "mcp_servers.json"


def build_app(root: Path, plugin_dir: Path, flags: dict = None, launcher: dict = None,
              launcher_api: dict = None, comfy_log: Path = None,
              data_root: Path = None, mcp_manager=None, kernel_state=None) -> web.Application:
    """桌面端 app：Studio 页面 + 前端静态文件 + 能力清单里归桌面端的全部路由。
    flags 是桌面端的启动中标记（与 StudioDesktop 共用同一份 dict），随版本快照下发给页面。
    launcher / launcher_api 同样与 StudioDesktop 共用：设置页在桌面端读快照、发保存。
    data_root 是桌面端的用户数据根：插件模块 import 期按它找 gallery / recipes / configs，
    桌面端服务与桌面端拉起的内核因此读同一份数据。
    mcp_manager 与 StudioDesktop 共用同一份会话登记表：关窗收尾要回收的进程与页面连着的是
    同一批；没给时按 data_root 建一个，注册表落在 <data_root>/configs/mcp_servers.json。
    kernel_state 是 StudioDesktop.comfy_state 那份内核状态，顶栏状态位刷新后靠它从 HTTP 侧补上。"""
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

    routes.get(USERDATA_PATH)(userdata_get)
    routes.post(USERDATA_PATH)(userdata_post)
    routes.get("/neo_studio/version")(studio_version)
    routes.get("/neo_studio/comfy_state")(comfy_state)
    routes.get("/neo_studio/log")(desktop_log)
    routes.get("/neo_studio/launcher")(launcher_get)
    routes.post("/neo_studio/launcher")(launcher_post)
    routes.get("/view")(view_file)
    routes.get("/ws")(studio_ws)

    app = web.Application(middlewares=[no_store])
    app["flags"] = flags if flags is not None else {}
    app["studio_index"] = plugin_dir / "web" / "studio" / "index.html"
    app["userdata"] = Path(folder_paths.get_user_directory()) / "default" / "neo_gallery_data.json"
    app["comfy_log"] = Path(comfy_log) if comfy_log else plugin_dir / "tmp" / "comfy_run.log"
    app["launcher"] = launcher if launcher is not None else {}
    app["launcher_api"] = launcher_api if launcher_api is not None else {}
    app["plugin_version"] = sys.modules[f"{DESKTOP_PKG}.util"].plugin_version()
    app["kernel_state"] = kernel_state
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
    # catch-all 必须最后注册：aiohttp 按注册顺序匹配，静态与浏览路由先占位
    app.router.add_route("GET", "/{path:.*}", offline)
    app.router.add_route("POST", "/{path:.*}", offline)
    return app


class DesktopServer:
    """桌面端自己的只读 HTTP 服务：后台线程 + 独立事件循环，随窗口退出。"""

    def __init__(self, app_factory, port: int):
        self.app_factory = app_factory
        self.port = port
        self.loop = None
        self.thread = None
        self.bound = 0
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
        for port in range(self.port, self.port + 6):
            site = web.TCPSite(runner, "127.0.0.1", port)
            try:
                await site.start()
                self.bound = port
                break
            except OSError:
                continue
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


