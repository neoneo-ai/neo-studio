"""Neo Studio 桌面端（pywebview + WebView2）：拉起 ComfyUI，窗口加载 /neo-studio。

与 neo-studio.ps1 同一套探活逻辑（GET /neo_studio/version 同时确认 ComfyUI 在跑与插件已加载），
差别是窗口由桌面端托管：几何存 data/studio_window.json（屏幕外位置自动丢弃，回退默认），
localStorage 落在 data/studio_profile
（private_mode=False），_blank 链接在桌面端窗口内导航（主画布交接与返回 Studio 都不出窗口），blob 下载放行。
全程无控制台窗口：neo-studio-app.vbs 双击用 pythonw 启动，提示走系统消息框，排查看
data/studio_desktop.log；ComfyUI 日志在 Studio「设置 → 日志」看（/neo_studio/log 读 app.logger 环形缓冲），
ComfyUI 起不来时看 data/comfy_run.log（桌面端拉起它的完整 stdout/stderr，端口冲突与导入报错都在里面）。
窗口先出（引导页 / 启动页），自检、桌面端服务（app/studio_server.py，无 ComfyUI 运行时的本机服务）、
拉起 ComfyUI 都在后台线程走完：ComfyUI 已在运行时进 ComfyUI 端口的完整 Studio；冷启动进桌面端服务的
Studio 页并停在上面 —— 桌面端自己拉起的那路就绪后页面原地接上生成（见 comfy_cors），不整页跳转，
导演编辑器与表单里未保存的内容留在页面上；局域网监听与远程那路加不了 CORS，照旧整页跳转。
ComfyUI 停止后页面翻回离线形态，浏览不受影响，生成类请求由桌面端回 409 offline。
桌面端拉起 ComfyUI 的这段时间 starting 为真（comfy_state 与桌面端 /neo_studio/version 共用同一份标记，
js_api 注入之前页面就知道在启动中），界面只出「ComfyUI 启动中…」，收起未运行横幅、
启动按钮与「需要 ComfyUI」提示。
窗口与任务栏图标用 studio/web/neo-studio.ico（tools/make_studio_icon.py 生成）。

用法：python app/studio_app.py [--port 8188] [--python <python.exe>] [--root <ComfyUI 根>]
                              [--cdp <port>] [--debug]
 桌面端是启动器：关窗只关窗口。顶栏只有「● 运行中 / 启动中 / 已停止」状态位，端口 / PID / 谁启动进 tooltip；
 内核启停在「设置 → 启动设置」，状态由桌面端的 js_api 报（端口 / PID / 谁启动 / 就绪）：
 停止内核 terminate（并按端口找监听者 PID 一并终止，外部启动的同样杀得掉），页面翻回离线形态；
 桌面端拉起的那路挂进 Job Object（KILL_ON_JOB_CLOSE）：桌面端进程一死 OS 连带杀掉它，收尾被 Ctrl+C /
 任务管理器 / 注销打断也留不下孤儿；用户自己启动的那路没有句柄，桌面端从不碰它；
 启动内核重新拉起，显示「启动中…」，就绪后页面原地接上生成（局域网监听与远程那路整页跳过去）。
 源码运行时每次启动把 studio/ 同步进 custom_nodes，桌面端与 ComfyUI 页面跑同一份代码。

"""

import argparse
import ctypes
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from urllib.parse import urlsplit
from pathlib import Path
from typing import Optional

from studio_server import DesktopServer, build_app
import mcp_client

IS_MAC = sys.platform == "darwin"
IS_WINDOWS = sys.platform == "win32"
IS_FROZEN = bool(getattr(sys, "frozen", False))
if not IS_WINDOWS:
    import fcntl
    import signal
APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parent
EXE_DIR = Path(sys.executable).resolve().parent if IS_FROZEN else APP_DIR
RES_DIR = Path(getattr(sys, "_MEIPASS", EXE_DIR))
# 内核插件装进 ComfyUI 后的目录名，与 studio/pyproject.toml 的 package name 逐字对齐：
# 前端静态文件走 /extensions/<目录名>/，大小写敏感，两边拼出来的 URL 必须一致。
PLUGIN_NAME = "comfyui-neo-studio"
# 桌面端服务加载的插件源码：源码运行是仓库里的 studio/，exe 里是随包的内置副本，
# 同时也是自动装进 custom_nodes 的源。
PLUGIN_SOURCE_DIR = RES_DIR / "bundled" / PLUGIN_NAME if IS_FROZEN else REPO_ROOT / "studio"

APP_NAME = "Neo Studio"
_state_dir: Optional[Path] = None


def _writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        mark = path / ".write-test"
        mark.write_text("", encoding="utf-8")
        mark.unlink()
        return True
    except OSError:
        return False


def _mac_state_dir() -> Path:
    """macOS 打包后的状态目录：~/Library/Application Support/Neo Studio。

    .app 里的 Resources 可能只读，状态不能塞进 bundle 旁边；macOS 原生位置是 Application Support。"""
    return Path.home() / "Library" / "Application Support" / APP_NAME


def pick_state_dir(exe_dir: Path, appdata: str = "") -> Path:
    """exe 旁的 data/ 优先；exe 丢在不可写目录时按平台回退。"""
    cand = exe_dir / "data"
    if _writable(cand):
        return cand
    base = _mac_state_dir() if IS_MAC else Path(appdata or str(exe_dir)) / APP_NAME
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return base


def state_dir() -> Path:
    """日志 / 窗口几何 / 浏览器 profile / 启动配置的落点，只算一次。

    源码运行 = 仓库的 data/；exe 运行 = pick_state_dir(EXE_DIR)。应用状态只属于桌面端，
    不落在内核插件目录里。
    """
    global _state_dir
    if _state_dir is not None:
        return _state_dir
    if IS_FROZEN:
        _state_dir = _mac_state_dir() if IS_MAC else pick_state_dir(EXE_DIR, os.environ.get("APPDATA", ""))
    else:
        _state_dir = REPO_ROOT / "data"
    return _state_dir


STATE = state_dir()
DESKTOP_LOG = STATE / "studio_desktop.log"
COMFY_LOG = STATE / "comfy_run.log"
GEOMETRY_FILE = STATE / "studio_window.json"
PROFILE_DIR = STATE / "studio_profile"
CONFIG_FILE = STATE / "launcher_config.json"   # 记住的 root / python / port
LOG_MAX = 200_000   # 桌面端日志上限：反复开关机只增不减，写入前裁到尾部
LOG_LOCK = threading.Lock()   # js_api 调用各在自己的线程里跑，读全文再写回必须串行
DESKTOP_LOG.parent.mkdir(parents=True, exist_ok=True)

# pythonw 的 sys.stderr 是 None：pywebview 的 _setup_logger 挂的控制台 handler 会在写日志时抛异常，
# 打断窗口创建。先把它的日志接到桌面端日志文件，_setup_logger 看到已有 handler 就不会再挂控制台 handler。
pyw_log = logging.getLogger("pywebview")
pyw_log.addHandler(logging.FileHandler(str(DESKTOP_LOG), encoding="utf-8"))
pyw_log.setLevel(logging.INFO)

try:
    import webview
    from webview import FileDialog
except ImportError:
    webview = None

DEFAULT_PORT = 8188
SINGLETON_MUTEX = "Local\\Neo.Studio.SingleInstance"   # 单实例锁走命名互斥体，不占端口
ERROR_ALREADY_EXISTS = 183
DESKTOP_PORT_OFFSET = 3   # 桌面端只读素材服务：避开 ComfyUI 的 8188
READY_TIMEOUT = 90      # ComfyUI 冷启动（扫描模型目录）留 90 秒

POLL_INTERVAL = 2.0
WEBVIEW_CACHE = PROFILE_DIR / "EBWebView" / "Default" / "Cache"   # WebView2 的 HTTP 缓存，跨会话留着

# coreclr 兜底要的运行时配置：System.Windows.Forms 在 Microsoft.WindowsDesktop.App 里，
# clr_loader 默认只会挑 Microsoft.NETCore.App，不给这份配置兜底必崩
CORECLR_CONFIG = (RES_DIR / "runtime" / "coreclr.runtimeconfig.json") if IS_FROZEN else (REPO_ROOT / "tools" / "coreclr.runtimeconfig.json")
APP_ID = "Neo.Studio"
GUI_BACKEND = "cocoa" if IS_MAC else "edgechromium"   # macOS 用 Cocoa WebView；Windows 用 WebView2
STUDIO_ICON = (RES_DIR / "web" / ("neo-studio.icns" if IS_MAC else "neo-studio.ico")) if IS_FROZEN else (PLUGIN_SOURCE_DIR / "web" / ("neo-studio.icns" if IS_MAC else "neo-studio.ico"))   # tools/make_studio_icon.py 生成（mac 侧另有 .icns）
NO_WINDOW = subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0   # 桌面端无控制台时子进程会新建控制台窗口，Windows 必须压制


def _child_spawn_kwargs() -> dict:
    """Windows 隐藏控制台；macOS 新会话让 terminate/kill 可以打到进程组，后续本地模式更可靠。"""
    if IS_WINDOWS:
        return {"creationflags": NO_WINDOW}
    if IS_MAC:
        return {"start_new_session": True}
    return {}
WINDOW_BG = "#17171b"
# 拖边框缩放走系统缩放模态循环，循环里 Form 与 Dock=Fill 的 WebView2 子控件被一起改尺寸，
# 新暴露的客户区先由各自的背景色刷出来，页面合成落后一帧 —— 底色是白的就是白窗闪一下。
# pywebview 的 background_color 默认 #FFFFFF，且同时定 Form.BackColor 与 WebView2 的
# DefaultBackgroundColor，建窗时必须显式给成页面底色（studio/web/studio/style.css 的 body 背景）。

if IS_WINDOWS:
    from ctypes import wintypes
    PROCESS_TERMINATE = 0x0001
    PROCESS_QUERY_LIMITED = 0x1000
    # restype 默认是 c_int，64 位句柄会被截断，TerminateProcess 拿到无效句柄静默失败
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.TerminateProcess.restype = wintypes.BOOL
    k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CreateMutexW.restype = wintypes.HANDLE
    k32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    k32.GetLastError.restype = wintypes.DWORD
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.SetInformationJobObject.restype = wintypes.BOOL
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    k32.AssignProcessToJobObject.restype = wintypes.BOOL
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

    # 无边框窗口：pywebview 的 frameless 只在建窗时生效，运行中切换走 Win32 样式位。
    # 只摘 WS_CAPTION（标题栏 + 系统按钮），WS_THICKFRAME 留着 —— 窗口边缘仍可拖拽缩放。
    u32 = ctypes.windll.user32
    GWL_STYLE = -16
    WS_CAPTION = 0x00C80000
    WS_THICKFRAME = 0x00040000
    SWP_NOSIZE = 0x0001
    SWP_NOMOVE = 0x0002
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    SWP_FRAMECHANGED = 0x0020
    VK_LBUTTON = 0x01
    SPI_GETWORKAREA = 0x0030
    SM_CXDRAG = 116   # 系统拖动阈值：按下后光标走出这个距离才算真拖动
    # 默认按 c_int 传句柄，64 位上的 HWND 会被截断，样式位与拖动消息都作用到别的窗口上
    u32.GetWindowLongW.argtypes = [wintypes.HWND, wintypes.INT]
    u32.SetWindowLongW.argtypes = [wintypes.HWND, wintypes.INT, wintypes.LONG]
    u32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.INT, wintypes.INT,
                                 wintypes.INT, wintypes.INT, wintypes.UINT]
    u32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    u32.SystemParametersInfoW.argtypes = [wintypes.UINT, wintypes.UINT, ctypes.c_void_p, wintypes.UINT]

    # 补回的 WS_THICKFRAME 那一圈由 DWM 按系统主题色画：浅色主题下缩放时边框线本身就是白的，
    # 钉成页面底色。Win10 不认这两个属性，DwmSetWindowAttribute 只回非零 HRESULT，没有分支要走。
    DWMWA_BORDER_COLOR = 34
    DWMWA_CAPTION_COLOR = 35
    dwm = ctypes.windll.dwmapi
    dwm.DwmSetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
else:
    k32 = u32 = dwm = None


def _apple_escape(text: str) -> str:
    """AppleScript 字符串字面量里只有反斜杠和引号会破坏语句；换行转成空格，消息框保持一行。"""
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\r", " ").replace("\n", " ")


if IS_WINDOWS:
    class POINT(ctypes.Structure):
        _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

    u32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
    u32.SetCapture.argtypes = [wintypes.HWND]
    u32.GetAsyncKeyState.argtypes = [wintypes.INT]
    u32.GetAsyncKeyState.restype = wintypes.SHORT
    u32.GetSystemMetrics.argtypes = [wintypes.INT]
    u32.GetSystemMetrics.restype = wintypes.INT

    def _cursor_pos() -> tuple:
        pt = POINT()
        u32.GetCursorPos(ctypes.byref(pt))
        return pt.x, pt.y

    def _left_button_down() -> bool:
        """左键还按着没有：桌面端的拖动循环靠它收尾（鼠标可能已经在窗口外面，只有全局键态靠得住）。"""
        return bool(u32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)

    def _colorref(hex_color: str) -> int:
        """#rrggbb → COLORREF：Win32 的颜色是 0x00bbggrr，照网页那串顺序传进去颜色是反的。"""
        h = hex_color.lstrip("#")
        return int(h[4:6], 16) << 16 | int(h[2:4], 16) << 8 | int(h[0:2], 16)

    def set_window_frame(hwnd: int, frameless: bool) -> None:
        # WS_THICKFRAME 恒置：pywebview 的 frameless 走 FormBorderStyle=None，可拖拽边框一起摘掉，
        # 这里补回来；有框时它本来就在，等于不动
        style = u32.GetWindowLongW(hwnd, GWL_STYLE)
        style = (style & ~WS_CAPTION if frameless else style | WS_CAPTION) | WS_THICKFRAME
        u32.SetWindowLongW(hwnd, GWL_STYLE, style)
        bg = ctypes.c_int(_colorref(WINDOW_BG))
        dwm.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ctypes.byref(bg), 4)
        dwm.DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ctypes.byref(bg), 4)
        u32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED)

    def window_rect(hwnd: int) -> tuple:
        r = wintypes.RECT()
        u32.GetWindowRect(hwnd, ctypes.byref(r))
        return (r.left, r.top, r.right, r.bottom)

    def work_area() -> tuple:
        """主屏去掉任务栏的那块：无边框窗口走系统 maximize 是整屏矩形，任务栏会被盖住。"""
        r = wintypes.RECT()
        u32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(r), 0)
        return (r.left, r.top, r.right, r.bottom)
else:
    def _cursor_pos() -> tuple:
        return 0, 0

    def _left_button_down() -> bool:
        return False

    def set_window_frame(hwnd: int, frameless: bool) -> None:
        """macOS 第一版走原生标题栏；自绘无边框窗口尚未移植，这里保持 no-op。"""

    def window_rect(hwnd: int) -> tuple:
        return 0, 0, 0, 0

    def work_area() -> tuple:
        return 0, 0, 0, 0


def alert(text: str) -> None:
    """pythonw 没有 stdout，提示走系统消息框；macOS 用 AppleScript alert，Linux 只写日志。"""
    if IS_WINDOWS:
        ctypes.windll.user32.MessageBoxW(0, text, "Neo Studio", 0x40)
        return
    if IS_MAC:
        try:
            subprocess.run(["/usr/bin/osascript", "-e", f'display alert "{_apple_escape(text)}"'],
                           timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            log_line(f"alert failed text={text}")
        return
    log_line(f"alert {text}")


def log_line(text: str) -> None:
    """桌面端自己的落盘日志：双击启动没有控制台，排查全靠它。只留尾部，别让它无限长。
    pywebview 把每个 js_api 调用丢进自己的线程，日志又是读全文再写回：不加锁并发写会丢行。"""
    line = f"[{time.strftime('%H:%M:%S')}] {text}"
    with LOG_LOCK:
        DESKTOP_LOG.parent.mkdir(parents=True, exist_ok=True)
        prev = DESKTOP_LOG.read_text(encoding="utf-8") + "\n" if DESKTOP_LOG.exists() else ""
        if len(prev) > LOG_MAX:
            prev = prev[-LOG_MAX:]
            prev = prev[prev.index("\n") + 1:] if "\n" in prev else prev   # 从整行开头截，别留半行
        DESKTOP_LOG.write_text(prev + line, encoding="utf-8")


def resolve_root(root: str) -> Optional[Path]:
    """CLI > 启动配置 > 桌面端自身位置推导。

    每一层父目录先找同级的 ComfyUI/（Neo-Studio 与内核并排摆放的布局），再找该目录自身
    （桌面端跑在 ComfyUI/custom_nodes/<插件> 里、exe 在插件 tools 的包目录里都靠这条）。
    推导出的位置必须真有 main.py。两条都落空返回 None，让 main 出引导页。
    """
    if root:
        return Path(root)
    cfg = load_config()
    if cfg.get("root"):
        return Path(cfg["root"])
    for cand in EXE_DIR.parents:
        for guess in (cand / "ComfyUI", cand):
            if root_ok(guess):
                return guess
    return None


def find_python(root: Path, python: str) -> Optional[Path]:
    """Windows 整合包布局优先；macOS 再找常见 venv/bin/python。找不到回 None。

    找不到不是错误：引导页负责让用户选一个。"""
    if python:
        return Path(python)
    for cand in (root.parent / "python" / "python.exe", root / "python" / "python.exe"):
        if cand.exists():
            return cand
    for cand in (root.parent / "python" / "bin" / "python", root / "python" / "bin" / "python",
                 root / "venv" / "bin" / "python", root / ".venv" / "bin" / "python"):
        if cand.exists():
            return cand
    return None


def resolve_python(root: Path, python: str) -> Path:
    py = find_python(root, python)
    if py is None:
        raise FileNotFoundError("未找到 python：在首次设置里选 python.exe，或用 --python <python.exe 路径> 指定")
    return py


# ---------------------------------------------------------------------------
# 启动配置与拉起前自检
# ---------------------------------------------------------------------------

CONFIG_VERSION = 1

# 自检状态：写进启动快照给「启动设置」页与离线横幅看
ST_OK = "ok"
ST_BAD_ROOT = "bad_root"
ST_NO_PYTHON = "missing_python"
ST_NO_DEPS = "deps_missing"
ST_INSTALL_FAIL = "install_failed"
ST_REMOTE = "remote_ok"          # 纯远程模式：本机不要求 ComfyUI root / Python
ST_REMOTE_DOWN = "remote_down"   # 远程地址有效，但远端现在不可达；引导页或启动设置可重连

# 插件 import 期硬依赖。ComfyUI 自带 pyyaml / Pillow / aiohttp，任何跑得起来的
# ComfyUI 环境都满足；openai / pypinyin / laya 是懒导入或自带降级，不检查也不拦。
DEPS_PROBE = ("import importlib.util, sys; sys.exit(0 if all("
              "importlib.util.find_spec(m) for m in ('yaml', 'PIL', 'aiohttp')) else 1)")


def plugin_dir_for(root: Path) -> Path:
    return root / "custom_nodes" / PLUGIN_NAME


def root_ok(root: Path) -> bool:
    return root.is_dir() and (root / "main.py").is_file()


def load_config() -> dict:
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(root: Path, python: str, port: int, flags: dict) -> bool:
    """写启动配置：开关与远程地址跟着根目录 / 解释器 / 端口一起落盘，「保存并重启」不能把它们写没。"""
    root_s = "" if not root or str(root) in ("", ".") else str(root)
    return write_config({"version": CONFIG_VERSION, "root": root_s, "python": str(python or ""),
                         "port": int(port), "frameless": bool(flags.get("frameless", not IS_MAC)),
                         "dev_mode": bool(flags.get("dev_mode")),
                         "listen": str(flags.get("listen", "")),
                         "remote": str(flags.get("remote", ""))})


def write_config(cfg: dict) -> bool:
    try:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_FILE.with_name(CONFIG_FILE.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        os.replace(tmp, CONFIG_FILE)
        return True
    except OSError:
        return False


def deps_ok(python: Path) -> bool:
    """目标 Python 是否具备插件 import 期硬依赖。"""
    if not Path(python).is_file():
        return False
    try:
        proc = subprocess.run([str(python), "-c", DEPS_PROBE],
                              timeout=180, **_child_spawn_kwargs())
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0


def install_deps(python: Path, plugin_dir: Path) -> dict:
    """装插件 requirements.txt 的依赖。联网安装，只由用户在「启动设置」点按钮触发。"""
    req = plugin_dir / "requirements.txt"
    if not req.is_file():
        return {"ok": False, "error": f"找不到依赖清单：{req}"}
    proc = subprocess.run([str(python), "-m", "pip", "install", "--no-warn-script-location",
                           "-r", str(req)], **_child_spawn_kwargs())
    if proc.returncode:
        return {"ok": False, "error": f"pip 退出码 {proc.returncode}，检查网络与代理后重试。"}
    return {"ok": True, "msg": "依赖安装完成。"}


def pyproject_version(plugin_dir: Path) -> str:
    """目录里 pyproject.toml 的版本号；读不到回空串（比任何 release 都旧）。"""
    try:
        text = (Path(plugin_dir) / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        return ""
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    return m.group(1) if m else ""


def _ver(text: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", text))


# 装进 custom_nodes 的只有代码与内置预设：用户数据归桌面端的数据根，插件按 NEO_STUDIO_DATA 与
# 插件目录里的指针去找。开发目录里的运行数据不能跟着进内核。
INSTALL_SKIP = ("build", "dist", "tests", "docs", "node_modules", "__pycache__", ".git", ".github",
                ".pytest_cache", "test-results", "tmp", "data", "gallery", "locals",
                "prompts/custom", "prompts/templates/custom", "prompts/_tags_index.json",
                "skills/custom", "recipes/custom", "recipes/.thumbs", "configs/skill_overrides")
INSTALL_SKIP_FILES = ("remote_llm_config.json", "model_config.json", "gallery_settings.json",
                      "image_gen.json", "video_gen.json", "bookmarks.json", "model_hub.json",
                      "backyard_oss.json", "studio_window.json", "gallery_dim_cache.json",
                      "laya_token.json", "neo_repair_mappings.json")


def install_ignore(source_dir: Path):
    """copytree 过滤器：按相对路径挡掉开发产物与用户数据，只放行代码与内置预设。"""
    src = str(source_dir)

    def ignore(directory: str, names: list) -> set:
        rel = os.path.relpath(directory, src).replace("\\", "/")
        prefix = "" if rel == "." else rel + "/"
        skipped = set()
        for name in names:
            path = prefix + name
            if any(path == p or path.startswith(p + "/") for p in INSTALL_SKIP):
                skipped.add(name)
            elif name in INSTALL_SKIP_FILES:
                skipped.add(name)
            elif name.endswith((".log", ".spec")):
                skipped.add(name)
        return skipped

    return ignore


def write_data_pointer(plugin_dir: Path) -> None:
    """把数据根写进插件目录：用户不经桌面端自己起 ComfyUI 时，插件靠它找到同一份用户数据。"""
    cfg = {"version": 1, "data_root": str(STATE.resolve())}
    target = plugin_dir / "configs" / "data_root.json"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        os.replace(tmp, target)
    except OSError as exc:
        log_line(f"data pointer failed: {exc}")


def update_plugin(plugin_dir: Path, source_dir: Path) -> None:
    """内置副本覆盖更新：新副本先在状态目录拼好，再把旧副本换出去。

    只有换目录这一步碰到旧副本：ComfyUI 正在跑时目录被占用，move 直接失败，旧副本原样留着，
    下次启动再更新。新副本没搬进去就把旧副本搬回来，绝不让 custom_nodes 空在那个位置。
    用户数据不在插件目录里，覆盖它不影响数据。
    """
    staging = STATE / "plugin_update"
    backup = STATE / "plugin_old"
    try:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.copytree(source_dir, staging, ignore=install_ignore(source_dir))
        shutil.rmtree(backup, ignore_errors=True)
        shutil.move(str(plugin_dir), str(backup))
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        log_line(f"plugin update skipped: {exc}")
        return
    try:
        shutil.move(str(staging), str(plugin_dir))
    except OSError as exc:
        shutil.move(str(backup), str(plugin_dir))
        log_line(f"plugin update failed: {exc}")
        return
    shutil.rmtree(backup, ignore_errors=True)
    log_line("plugin update done")


def sync_plugin(plugin_dir: Path, source_dir: Path) -> int:
    """源码运行时的同步：studio/ 覆盖进 custom_nodes，桌面端与 ComfyUI 页面跑同一份代码。

    只覆盖同名文件，从不删目标目录里的任何东西：用户配置、数据指针、装好的依赖都留在原地。
    大小与修改时间都对得上的跳过；ComfyUI 正在跑、文件被占用时跳过那一个，下次启动再补。
    """
    ignore = install_ignore(source_dir)
    copied = 0
    for dirpath, dirs, names in os.walk(source_dir):
        rel = Path(dirpath).relative_to(source_dir)
        skipped = ignore(dirpath, dirs + names)
        dirs[:] = [d for d in dirs if d not in skipped]
        for name in names:
            if name in skipped:
                continue
            src = Path(dirpath) / name
            dst = plugin_dir / rel / name
            try:
                if dst.exists():
                    s, d = src.stat(), dst.stat()
                    if s.st_size == d.st_size and s.st_mtime_ns == d.st_mtime_ns:
                        continue
                    # 目标比源新就是有人直接改了 custom_nodes 里的产物，这次覆盖会丢掉那份改动
                    if d.st_mtime_ns > s.st_mtime_ns:
                        log_line(f"plugin sync overwrote edited {rel / name}")
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                copied += 1
            except OSError as exc:
                log_line(f"plugin sync skip {name}: {exc}")
    if copied:
        log_line(f"plugin sync {copied} files -> {plugin_dir}")
    return copied


def ensure_plugin(plugin_dir: Path, source_dir: Path = PLUGIN_SOURCE_DIR) -> tuple[bool, str]:
    """custom_nodes 里的插件副本：缺失就装内置副本，存在就跟着同步。

    源码运行那份就是开发中的插件本身，每次启动把 studio/ 同步进去，桌面端与 ComfyUI 页面跑同一份代码。
    exe 只认内置副本的 release：版本更新才换目录。git 检出归 ComfyUI-Manager 与用户自己维护，都不覆盖。
    """
    if plugin_dir.is_dir():
        if not (plugin_dir / ".git").exists():
            if IS_FROZEN:
                new, old = pyproject_version(source_dir), pyproject_version(plugin_dir)
                if _ver(new) > _ver(old):
                    log_line(f"plugin update {old or '无版本号'} -> {new}")
                    update_plugin(plugin_dir, source_dir)
            else:
                sync_plugin(plugin_dir, source_dir)
        write_data_pointer(plugin_dir)
        return True, ""
    if not source_dir.is_dir():
        return False, "启动器没有内置插件副本，请手动安装 Neo Studio 后重试。"
    custom_nodes = plugin_dir.parent
    try:
        custom_nodes.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_dir, plugin_dir, ignore=install_ignore(source_dir))
    except OSError as exc:
        return False, f"写入 {custom_nodes} 失败：{exc}"
    write_data_pointer(plugin_dir)
    return True, ""


def remote_startup_state(remote: str, timeout: float = 2.0) -> tuple[str, str]:
    """纯远程模式的启动状态：远端地址有效、能答话就是 ok；答不通是 remote_down。

    远端 Neo Studio 插件是数据的真正归属，本机不需要 ComfyUI 根目录、解释器、插件副本与依赖自检。
    这里只问远端是否就绪，不替远端装插件或启动进程。"""
    if not remote:
        return ST_BAD_ROOT, "远程地址为空"
    if probe(remote, timeout):
        return ST_REMOTE, ""
    return ST_REMOTE_DOWN, (f"远程 ComfyUI 不可达：{remote}。检查远端是否已启动、是否开启局域网监听、"
                            f"防火墙是否放行该端口，并确认远端已安装 Neo Studio 插件。")


def startup_state(root: Path, python: Path, plugin_dir: Path) -> tuple[str, str]:
    """拉起 ComfyUI 前的自检；插件缺失直接自动安装，不需要用户动手。"""
    if not root_ok(root):
        return ST_BAD_ROOT, f"不是 ComfyUI 根目录（找不到 main.py）：{root}"
    if not Path(python).is_file():
        return ST_NO_PYTHON, f"Python 解释器不存在：{python}"
    ok, msg = ensure_plugin(plugin_dir)
    if not ok:
        return ST_INSTALL_FAIL, msg
    if not deps_ok(python):
        return ST_NO_DEPS, (f"目标 Python 缺少插件依赖，在「启动设置」点「安装依赖」，或手动执行：\n"
                            f'"{python}" -m pip install -r "{plugin_dir / "requirements.txt"}"')
    return ST_OK, ""


def probe(base: str, timeout: float = 3.0) -> bool:
    """探一路 ComfyUI 是否就绪：GET /neo_studio/version 同时确认在跑与插件已加载。
    base 是目标地址 —— 本机模式是 http://127.0.0.1:端口，远程模式是远端的 http(s)://主机[:端口]。"""
    try:
        with urllib.request.urlopen(f"{base}/neo_studio/version", timeout=timeout):
            return True
    except Exception:
        return False


def wait_ready(base: str, seconds: float) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if probe(base):
            return True
        time.sleep(POLL_INTERVAL)
    return probe(base)


def wait_attach(base: str, seconds: float, busy) -> bool:
    """附着的那路（桌面端没有句柄）等就绪。自己拉起的那路端口是「还没绑上」，这里等的是空端口；
    附着的那路是「有人监听」，连续两轮没人监听就是那路死了 —— 收手回离线页，
    别对着空地址等满超时（关完立刻重开就会撞上这一下）。busy 报目标上有没有人监听。"""
    deadline = time.time() + seconds
    free = 0
    while time.time() < deadline:
        if probe(base):
            return True
        free = free + 1 if not busy() else 0
        if free >= 2:
            return False
        time.sleep(POLL_INTERVAL)
    return probe(base)


def on_screen(x: int, y: int, w: int, h: int) -> bool:
    """位置必须与可见屏幕相交；macOS 第一版用保守下界，避免最小化态的 -32000 坐标落盘。"""
    if IS_WINDOWS:
        u = ctypes.windll.user32
        vx, vy = u.GetSystemMetrics(76), u.GetSystemMetrics(77)
        vw, vh = u.GetSystemMetrics(78), u.GetSystemMetrics(79)
        return x < vx + vw and x + w > vx and y < vy + vh and y + h > vy
    return x >= -20000 and y >= -20000


def load_geometry() -> dict:
    try:
        data = json.loads(GEOMETRY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    geo = {key: int(data[key]) for key in ("width", "height", "x", "y") if isinstance(data.get(key), int)}
    if not on_screen(geo.get("x", 0), geo.get("y", 0), geo.get("width", 1440), geo.get("height", 900)):
        geo.pop("x", None)
        geo.pop("y", None)
    return geo


def save_geometry(window) -> None:
    try:
        geo = {"width": window.width, "height": window.height, "x": window.x, "y": window.y}
    except Exception:
        return   # 窗口已销毁读不到属性：几何之前存过，不能让它挡住关窗后面的收尾
    # 最小化关闭时位置是 -32000 系、尺寸是最小化态的假值（158x26），整份几何都不值得存
    if not on_screen(geo["x"], geo["y"], geo["width"], geo["height"]):
        return
    GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    GEOMETRY_FILE.write_text(json.dumps(geo), encoding="utf-8")


def lan_ips() -> list:
    """本机非回环 IPv4，给「局域网监听」当提示地址。走本机主机名解析，不出网。"""
    try:
        addrs = socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        return []
    return [a for a in addrs if not a.startswith("127.")]


def comfy_listen(raw: str) -> Optional[str]:
    """ComfyUI 的 --listen 值：空串 = 不传（ComfyUI 默认只监听 127.0.0.1，只有本机）；
    填 IP = 局域网可访问，逗号分隔多块网卡；非法地址回 None，由调用方报错。
    只监听某块网卡时把 127.0.0.1 一起带上 —— 桌面端窗口跳的是 http://127.0.0.1:端口，
    回环上没人听的话窗口打不开，port_busy 也会把在跑的 ComfyUI 读成空位再拉一路。"""
    addrs = [a.strip() for a in str(raw).strip().split(",") if a.strip()]
    if not addrs:
        return ""
    for a in addrs:
        try:
            ipaddress.ip_address(a)
        except ValueError:
            return None
    if any(a in ("0.0.0.0", "::") for a in addrs):   # 全监听已覆盖回环，不重复加
        return ",".join(addrs)
    if "127.0.0.1" not in addrs:
        addrs.insert(0, "127.0.0.1")
    return ",".join(addrs)


def comfy_remote(raw: str) -> Optional[str]:
    """远程 ComfyUI 的 base：http(s)://主机[:端口]，空 = 连本机（现有行为）。
    只认 scheme 与主机端口，path / query / 凭据一律拒 —— 桌面端拿它拼 /neo-studio 与探活，
    不能让启动配置里的值变成任意 URL。非法值回 None，由调用方报错。"""
    value = str(raw).strip()
    if not value:
        return ""
    if "://" not in value:
        value = "http://" + value
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    return f"{parsed.scheme}://{parsed.hostname}" + (f":{port}" if port else "")


def comfy_cors(listen: str, remote: str, desktop_port: int) -> str:
    """桌面端拉起的 ComfyUI 允许 Studio 页面直连的 origin；不给 = 空串。

    ComfyUI 的 --enable-cors-header 与它的 origin_only 中间件互斥（ComfyUI/server.py:280）：
    不给这个 flag，从桌面端口 origin 发往 8188 的请求会因 Host/Origin 不等直接 403，页面只能整页
    搬到 8188（未保存的编辑全丢）。给了，本机回环上的页面就能原地直连。
    局域网监听与远程模式不给 —— 那两路保留整页跳转，origin_only 这道防线不在暴露到网卡的实例上让位。"""
    if listen or remote or not desktop_port:
        return ""
    return f"http://127.0.0.1:{desktop_port}"


def start_comfy(python: Path, root: Path, port: int, listen: str = "", cors: str = "") -> subprocess.Popen:
    """启动输出落 data/comfy_run.log：CREATE_NO_WINDOW 下不重定向，端口冲突与导入报错就全进黑洞。"""
    COMFY_LOG.parent.mkdir(parents=True, exist_ok=True)
    log = open(COMFY_LOG, "wb", buffering=0)
    log.write(f"=== {time.strftime('%H:%M:%S')} port={port} listen={listen or '127.0.0.1'} {python}\n".encode("utf-8"))
    env = {**os.environ, "NEO_STUDIO_DATA": str(STATE)}
    argv = [str(python), str(root / "main.py"), "--port", str(port)]
    if listen:
        argv += ["--listen", listen]
    if cors:
        argv += ["--enable-cors-header", cors]
    proc = subprocess.Popen(argv,
                            cwd=str(root), env=env, stdout=log, stderr=subprocess.STDOUT,
                            **_child_spawn_kwargs())
    assign_comfy_job(proc)
    return proc


COMFY_CHILD = STATE / "comfy_child.json"


def spawn_comfy(python: Path, root: Path, port: int, listen: str = "",
                cors: str = "") -> subprocess.Popen:
    """拉起 ComfyUI，并把「这一路是桌面端起的」记进数据根。

    收尾链之外还有两条路会让进程活下来：附着到上一轮的残留（self.comfy 是 None），
    以及桌面端在收尾跑到之前被结束。标记是下一轮关窗仍然认得它的依据 —— 用户自己
    启动的 ComfyUI 没有标记，关窗不碰。
    """
    proc = start_comfy(python, root, port, listen, cors)
    try:
        COMFY_CHILD.parent.mkdir(parents=True, exist_ok=True)
        tmp = COMFY_CHILD.with_name(COMFY_CHILD.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"pid": proc.pid, "port": port}, f)
        os.replace(tmp, COMFY_CHILD)
    except OSError:
        log_line(f"comfy child marker failed pid={proc.pid}")
    return proc


def comfy_child_marker() -> dict:
    """桌面端上一轮拉起、还没被收走的 ComfyUI：{pid, port}；没有可用标记返回 {}。"""
    try:
        with open(COMFY_CHILD, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    pid, port = int(data.get("pid") or 0), int(data.get("port") or 0)
    return {"pid": pid, "port": port} if pid and port else {}


def forget_comfy_child() -> None:
    try:
        COMFY_CHILD.unlink()
    except OSError:
        pass


def port_busy(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def free_comfy_port(preferred: int, desktop_port: int) -> int:
    """端口被残留进程占着时往上找空位：硬撞 8188 会让拉起的 ComfyUI 立刻退出且毫无提示。"""
    if not port_busy(preferred):
        return preferred
    for port in range(preferred + 1, preferred + 40):
        if port != desktop_port and not port_busy(port):
            return port
    return preferred


def reap(proc: subprocess.Popen, timeout: float) -> None:
    """回收子进程。TerminateProcess 之后进程只剩一个内核对象，不 reap 就一直能被 OpenProcess 打开，
    pid_alive 永远报「还活着」：关窗因此固定睡满等待上限（用户读成卡死），胶囊停止也因此在僵尸 PID 上
    强杀失败（「没有权限终止该进程」）。"""
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        pass


def _posix_port_owner(port: int) -> int:
    """macOS/Linux 按 TCP LISTEN 找 PID；lsof 不在则当作没人监听。"""
    if not shutil.which("lsof"):
        return 0
    out = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP=LISTEN", "-t"],
                         capture_output=True, text=True, errors="replace")
    for line in out.stdout.splitlines():
        try:
            return int(line.split()[0])
        except (IndexError, ValueError):
            continue
    return 0


def port_owner(port: int) -> int:
    """按监听端口找进程 PID；没有监听者返回 0。"""
    if IS_WINDOWS:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True,
                             encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
        for line in out.stdout.splitlines():
            f = line.split()
            if len(f) >= 5 and f[3] == "LISTENING" and f[1].split(":")[-1] == str(port):
                return int(f[4])
        return 0
    return _posix_port_owner(port)


def kill_pid(pid: int) -> bool:
    """按 PID 终止进程：用户自己启动的 ComfyUI 没有桌面端的 Popen 句柄。"""
    if pid <= 0:
        return False
    if IS_WINDOWS:
        h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if not h:
            return False
        ok = k32.TerminateProcess(h, 0)
        k32.CloseHandle(h)
        return bool(ok)
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return False
    return True


def pid_alive(pid: int) -> bool:
    """进程是否还活着；比每次重跑端口列表便宜。"""
    if pid <= 0:
        return False
    if IS_WINDOWS:
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED, False, pid)
        if h:
            k32.CloseHandle(h)
        return bool(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # POSIX 下 EPERM 说明 PID 存在但不属于本用户；桌面端第一版没有跨用户杀进程的需求。
        return True
    except OSError:
        return False
    return True


COMFY_JOB = None   # 关句柄等于「杀作业里的全部进程」，所以它必须活到桌面端进程结束


def assign_comfy_job(proc: subprocess.Popen) -> bool:
    """Windows Job Object；macOS/Linux 第一版 no-op。"""
    if not IS_WINDOWS:
        return False
    global COMFY_JOB
    KILL_ON_JOB_CLOSE = 0x2000
    EXTENDED_LIMIT_INFO = 9

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [("ReadOpCount", ctypes.c_ulonglong), ("WriteOpCount", ctypes.c_ulonglong),
                    ("OtherOpCount", ctypes.c_ulonglong), ("ReadByteCount", ctypes.c_ulonglong),
                    ("WriteByteCount", ctypes.c_ulonglong), ("OtherByteCount", ctypes.c_ulonglong)]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        # JOBOBJECT_BASIC_LIMIT_INFORMATION 摊平在前九个字段里，与 Win32 布局一致
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD), ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    if COMFY_JOB is None:
        COMFY_JOB = k32.CreateJobObjectW(None, None)
        if not COMFY_JOB:
            log_line("comfy job create failed")
            return False
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.LimitFlags = KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(COMFY_JOB, EXTENDED_LIMIT_INFO, ctypes.byref(info),
                                           ctypes.sizeof(info)):
            log_line("comfy job limit failed")
            k32.CloseHandle(COMFY_JOB)
            COMFY_JOB = None
            return False
    if not k32.AssignProcessToJobObject(COMFY_JOB, proc._handle):
        log_line(f"comfy job assign pid={proc.pid} failed")
        return False
    return True


BACK_JS = """
(() => {
    const inject = () => {
        if (location.pathname.startsWith('/neo-studio')) return;   // Studio 页自己就是主页，不需要返回胶囊
        if (document.getElementById('neo-studio-back')) return;
        // 语言跟着 Studio 那份存储与判定规则：主画布是整页刷新，胶囊文案要跟着界面语言重建
        let lang = '';
        try { lang = localStorage.getItem('neo_studio_lang'); } catch { lang = ''; }
        if (lang !== 'zh' && lang !== 'en') lang = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
        const en = lang === 'en';
        const b = document.createElement('button');
        b.id = 'neo-studio-back';
        b.textContent = en ? 'Back to Studio' : '返回 Studio';
        b.title = en ? 'Back to Neo Studio' : '返回 Neo Studio 主页';
        // 挂视口右上角：左上角是工作流页签，56px 那排是 ComfyUI 自己的菜单栏，胶囊挤进去会盖住菜单
        b.style.cssText = 'position:fixed;top:8px;right:8px;z-index:100000;padding:5px 12px;'
            + 'border-radius:14px;border:1px solid #4a4a4f;background:#26262a;color:#d7dae0;'
            + 'font:12px system-ui;line-height:1;cursor:pointer';
        b.onmouseenter = () => { b.style.background = '#333338'; };
        b.onmouseleave = () => { b.style.background = '#26262a'; };
        b.onclick = () => window.pywebview.api.go_studio();
        document.body.appendChild(b);
        // 无边框窗口：启动页与引导页没有顶栏，整页空白处按下即拖窗（控件与输入区排除在外）
        const api = window.pywebview.api;
        if (!api.window_state || window.__neoDrag) return;
        window.__neoDrag = true;
        api.window_state().then(s => {
            if (!s.frameless) return;
            document.documentElement.style.cursor = 'move';
            document.addEventListener('mousedown', e => {
                if (e.button === 0 && !e.target.closest('button,input,select,textarea,a,label'))
                    window.pywebview.api.win_start_drag();
            });
        });
    };
    // loaded 早于 pywebview api 注入完成：重试几轮再放弃，避免常驻轮询
    let tries = 0;
    const tick = () => {
        if (window.pywebview && window.pywebview.api) inject();
        else if (tries++ < 10) setTimeout(tick, 300);
    };
    tick();
})();
"""


CLOSING_JS = """
(() => {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:100002;display:grid;place-items:center;'
        + 'background:rgba(20,20,24,.94);color:#d7dae0;font:15px system-ui;pointer-events:none';
    o.textContent = '正在停止 ComfyUI…';
    document.documentElement.appendChild(o);
})();
"""


class StudioDesktop:
    """桌面端的 js_api：顶栏「返回 Studio」胶囊、ComfyUI 运行状态与退出、无边框窗口操作。
    js_api 上只许挂 url、字符串、dict 与绑定方法：pywebview 注入 window.pywebview 前会
    递归遍历 js_api 的非下划线属性（webview.util.inject_pywebview），挂窗口对象会把
    WinForms 整张对象图喂进递归（pythonnet 每次属性访问都造新对象，id 去重失效），开机即卡死。"""

    def __init__(self, url: str, comfy, port: int, root: Path, python_arg: str = "", offline_url: str = "",
                 desktop_port: int = 0, flags: dict = None, launcher: dict = None):
        self.url = url
        self.offline_url = offline_url
        self.desktop_port = desktop_port
        self.comfy = comfy
        self.port = port
        self.root = root
        self.python_arg = python_arg
        self.pid = comfy.pid if comfy is not None else 0
        # 启动中标记与桌面端只读服务共用同一份：js_api 注入之前页面就能从版本快照拿到「启动中」
        self.flags = flags if flags is not None else {"starting": False}
        # 启动设置快照：桌面端服务与 js_api 共用同一份 dict，设置页与离线横幅都读它
        self.launcher = launcher if launcher is not None else {}
        # 无边框窗口：Windows 默认开；macOS 第一版用原生标题栏。运行中由 set_frameless 改样式位。
        self.frameless = bool(self.launcher.get("frameless", not IS_MAC))
        self.listen = comfy_listen(self.launcher.get("listen", "")) or ""   # 局域网监听：空 = 只监听本机
        # 远程 ComfyUI：非空时窗口指向远端，本机不拉进程（远端进程不归本机管）
        self.remote = comfy_remote(self.launcher.get("remote", "")) or ""
        if self.remote:
            self.url = self.studio_url()
        self.fullscreen = False
        self.maximized = False    # 无边框下最大化是桌面端自己铺的矩形，系统不认 WS_MAXIMIZE，状态自己记
        self._restore_rect: tuple | None = None   # 铺满前的矩形，点一下还原回这里
        self._window = None
        self.starting = comfy is not None
        self.loader = None
        self.rearm = None
        # 桌面端服务由 main() 注入：引导页补完根目录才装配得起来，start_setup 需要再叫一次
        self.ensure_server = None
        self._closed = False
        # 关窗与后台启动序列撞在一起时的闸门：拉起 ComfyUI 前后各看一次，别让刚起的那路变孤儿
        self.closing = False
        # 窗口当前停在哪个页面：离线页的收尾要认页，只认「停在离线页」这一种
        self.page = ""

    @property
    def starting(self) -> bool:
        return self.flags["starting"]

    @starting.setter
    def starting(self, value: bool) -> None:
        self.flags["starting"] = bool(value)

    @property
    def base(self) -> str:
        """探活与拼页面地址用的目标：远程模式是远端，本机模式是回环上的端口。"""
        return self.remote or f"http://127.0.0.1:{self.port}"

    @property
    def direct(self) -> bool:
        """页面钉在桌面端端口、生成类请求由页面直连 ComfyUI：桌面端自己拉起的那路 + 只监听本机。

        必须与 comfy_cors 的取值条件同源：flag 没给出去，页面直连必 403，这路就只能整页跳转。
        附着的那路（self.comfy 是 None）与远程那路加不了 flag，照旧跳转。"""
        return self.comfy is not None and not self.listen and not self.remote and bool(self.desktop_port)

    def studio_url(self) -> str:
        return self.base + "/neo-studio"

    def target_busy(self) -> bool:
        """目标上有没有人监听：本机模式探回环端口，远程模式探远端（远端没有本机端口可探）。"""
        return probe(self.base, 0.5) if self.remote else port_busy(self.port)

    def go_studio(self) -> None:
        self._goto(self.url)

    def open_url(self, url: str) -> dict:
        """「设置 → 关于」里的外链（仓库地址）：无边框窗口内不开新页，交给系统默认浏览器。
        只认 http(s) 且带主机名：file:// 与 javascript: 这类载荷经桥进来就是本机执行入口。"""
        parts = urlsplit(str(url or ""))
        if parts.scheme not in ("http", "https") or not parts.netloc:
            log_line(f"open_url rejected url={url!r}")
            return {"ok": False, "error": "只允许打开 http(s) 链接"}
        log_line(f"open_url {parts.geturl()}")
        webbrowser.open(parts.geturl())
        return {"ok": True}

    def _goto(self, target: str) -> None:
        if not target or self.loader is None:
            return
        target = self.studio_target(target)
        self.page = target
        log_line(f"goto {target}")
        self.loader(target)
        self.rearm()

    def studio_target(self, target: str) -> str:
        """整页跳到 ComfyUI 端口的完整 Studio 时，把桌面端 origin 挂在 URL 上。

        MCP 注册表与 stdio 会话只活在桌面端进程里（app/mcp_routes.py）：页面在 8188 上打
        /neo_mcp/* 只会拿到 404，MCP 栏就只剩一句「桌面端服务未就绪」。页面拿到这个参数
        就把那族请求送回桌面端口（studio/web/studio/shim/route.js）。
        直连那路页面本来就钉在桌面端端口上，离线页 / 引导页也在本进程上，都不带。"""
        if self.direct or not self.desktop_port or target != self.url:
            return target
        sep = "&" if "?" in target else "?"
        return f"{target}{sep}neo_desktop=http://127.0.0.1:{self.desktop_port}"

    def _leave_offline(self, ready: bool) -> None:
        """窗口停在离线页、服务已经答话：接上 ComfyUI，横幅随状态一起收。
        _jump_when_ready 只有 READY_TIMEOUT 一份预算，用完就不管了 —— 导入自定义节点慢的那路、
        用户自己在外面起的那路从此没人收尾：横幅停在「ComfyUI 未运行」上，顶栏胶囊报运行中，
        生成入口全被离线闸门拦住，谁都不认账。收尾搭在顶栏那份 5 秒探活上：页面活着就有探活，
        跳完 page 变了自然收手，不额外起线程、不额外加定时器。
        直连那路（direct）不跳：页面本来就钉在桌面端端口上，报出 comfy_base 让它原地翻面，
        整页跳转会把导演编辑器与表单里未保存的内容全清掉。"""
        if not ready:
            return
        if self.direct:
            self.flags["comfy_base"] = self.base
            return
        if self.offline_url and self.page == self.offline_url:
            self.starting = False
            log_line("comfy ready jump from offline")
            self._goto(self.url)

    def log(self, message: str) -> None:
        """页面把前端未捕获错误与启动失败写进桌面端日志：白屏只有 DevTools 能看太晚，
        折成一行便于 grep（data/studio_desktop.log）。"""
        log_line("[web] " + " ".join(message.split()))

    def _jump_when_ready(self) -> None:
        """离线页里点「重新拉起」：就绪后接上完整 Studio。直连那路只报地址，页面原地翻面。"""
        ready = (wait_ready(self.base, READY_TIMEOUT) if self.comfy is not None
                 else wait_attach(self.base, READY_TIMEOUT, self.target_busy))
        if ready:
            self.starting = False
            if self.direct:
                self.flags["comfy_base"] = self.base
                log_line(f"comfy ready in-place {self.base}")
            else:
                self._goto(self.url)
        else:
            self.starting = False   # 没起来：离线横幅回到「未运行 + 启动」，别卡在启动中
            log_line("comfy restart not ready")
            if self.remote:
                state, msg = remote_startup_state(self.base, timeout=1.0)
                self.launcher.update(state=state, error=msg)


    def comfy_state(self) -> dict:
        """顶栏胶囊要的运行状态：外部启动的 ComfyUI 没有 Popen 句柄，按端口找 PID 并缓存。
        桌面端拉起的那路以端口探活为准 —— TerminateProcess 是异步的，进程还在收尾时端口已关，
        报「进程活着」会让胶囊显示运行中而服务其实已经没了。附着的那路同理按探活报：
        端口上有 PID 只说明有人在监听，插件没加载完时服务还不认，胶囊不能先说运行中。
        starting：桌面端拉起的进程还活着、端口还没就绪 —— 这段时间前端只出「启动中」，收起其余离线提示。
        远程模式没有本机 PID 可报，运行与否只看远端探活；remote 带上远端地址供界面标注。"""
        if self.remote:
            ready = probe(self.base, 1.0)
            self._leave_offline(ready)
            return {"port": urlsplit(self.base).port or DEFAULT_PORT, "pid": 0, "mine": False,
                    "running": ready, "ready": ready, "starting": False, "remote": self.base}
        ready = probe(self.base, 1.0)
        self._leave_offline(ready)
        if self.comfy is not None:
            if ready:
                self.starting = False
            return {"port": self.port, "pid": self.comfy.pid, "mine": True,
                    "running": ready, "ready": ready,
                    "starting": self.starting and self.comfy.poll() is None}
        if not self.pid or not pid_alive(self.pid):
            self.pid = port_owner(self.port)
        return {"port": self.port, "pid": self.pid, "mine": False,
                "running": ready, "ready": ready, "starting": False}

    def comfy_stop(self) -> dict:
        self.flags["comfy_base"] = ""   # 生成类目标随进程一起收：页面下一轮快照就回到离线形态
        if self.remote:
            # 远程内核由远端机器自己起停：窗口退回离线页，不碰远端进程
            log_line(f"comfy stop skipped remote={self.base}")
            self._goto(self.offline_url)
            return self.comfy_state()
        if self.comfy is not None:
            self.comfy.terminate()
            reap(self.comfy, 2)   # 不 reap 的话下面按 PID 判活会一直「活着」，强杀必然失败
            self.starting = False
        # 监听端口的未必是桌面端的 Popen（子进程、端口被占时的残留）：按端口反复杀到没人监听
        for _ in range(10):
            pid = port_owner(self.port)
            if not pid:
                break
            if not pid_alive(pid):
                break   # 正在收尾，端口马上空
            if not kill_pid(pid):
                log_line(f"comfy kill {pid} 失败：没有权限终止该进程")
                break
            time.sleep(0.5)
        self.pid = 0
        forget_comfy_child()   # 停止已经把进程收走：标记留着会让下一轮关窗去找一个没有的 PID
        st = self.comfy_state()
        log_line(f"comfy stop {st}")
        # 直连那路的窗口本来就钉在桌面端页面上，停完不用跳；跳一次等于整页刷新，白丢未保存的编辑
        if not st["ready"] and self.page != self.offline_url:
            self._goto(self.offline_url)   # 窗口退回桌面端的只读素材库，不对着死页面干等
        return st

    def comfy_close(self) -> None:
        """关窗时带走桌面端自己拉起的 ComfyUI。

        只认自己那份 PID：terminate 之后回收子进程，回收超时（真没退出）才按 PID 兜底强杀。
        必须回收 —— 不回收的话进程只剩内核对象，pid_alive 会一直报「还活着」，关窗固定睡满
        等待上限、兜底强杀也必然失败；回收刚成功时进程对象也还会残留几毫秒，判活会读到假活。
        不做 comfy_stop 的按端口扫荡 —— 关窗路上重扫监听者会误杀抢端口的残留进程。
        附着模式（self.comfy 是 None）只认数据根里的标记：上一轮桌面端拉起、在收尾跑到之前
        活下来的 ComfyUI 才是我们的，按端口核对过 PID 才杀。用户自己启动的那路没有标记，
        关窗不碰；插件代码在孤儿进程内存里是旧的，放它活着，下一轮导出全落在旧路径上。"""
        if self._closed:
            return
        self._closed = True
        self.starting = False
        if self.comfy is not None:
            pid = self.comfy.pid
            self.comfy.terminate()
            try:
                self.comfy.wait(timeout=1.2)   # terminate 是异步的，正常收尾远快于此；等满上限就是「关得慢」
            except subprocess.TimeoutExpired:
                kill_pid(pid)
                log_line(f"comfy close kill pid={pid}")
            log_line(f"comfy closed with desktop pid={pid}")
        else:
            marker = comfy_child_marker()
            if marker and port_owner(marker["port"]) == marker["pid"]:
                if kill_pid(marker["pid"]):
                    log_line(f"comfy closed attached pid={marker['pid']}")
                else:
                    log_line(f"comfy close attached pid={marker['pid']} 失败：没有权限终止该进程")
        forget_comfy_child()

    def comfy_start(self) -> dict:
        """胶囊的启动路径：停止后重新拉起 ComfyUI，就绪后接上完整 Studio（直连那路原地翻面）。"""
        self.flags["comfy_base"] = ""
        if self.remote:
            # 远程内核由远端机器自己起：这里只做探活 + 跳转，本机不拉进程、不探本机端口
            self.comfy = None
            self.pid = 0
            self.starting = False
            log_line(f"comfy reconnect {self.base}")
            threading.Thread(target=self._jump_when_ready, daemon=True).start()
            return self.comfy_state()
        if not IS_FROZEN and root_ok(self.root):
            sync_plugin(plugin_dir_for(self.root), PLUGIN_SOURCE_DIR)   # 改完代码点一下启动就生效
        if self.comfy is not None:
            # 刚停止的进程可能还在收尾（TerminateProcess 异步），等它退出再拉起，避免端口冲突
            for _ in range(60):
                if self.comfy.poll() is not None:
                    break
                time.sleep(0.5)
        if port_busy(self.port):
            # 端口上已有一路 ComfyUI 在跑：附着上去，绝不在旁边拉第二路
            self.comfy = None
            self.pid = 0
            self.starting = False
            log_line(f"comfy attach port={self.port}")
            threading.Thread(target=self._jump_when_ready, daemon=True).start()
            return self.comfy_state()
        self.port = free_comfy_port(self.port, self.desktop_port)
        self.comfy = spawn_comfy(resolve_python(self.root, self.python_arg), self.root, self.port,
                                 self.listen, comfy_cors(self.listen, self.remote, self.desktop_port))
        self.url = self.studio_url()
        self.pid = self.comfy.pid
        self.starting = True
        log_line(f"comfy spawn pid={self.comfy.pid} port={self.port} listen={self.listen or '127.0.0.1'}")
        threading.Thread(target=self._jump_when_ready, daemon=True).start()
        return self.comfy_state()



    def launcher_state(self) -> dict:
        """「启动设置」页的快照：根目录 / 解释器 / 端口 / 插件位置 / 自检状态。"""
        return dict(self.launcher)

    def set_frameless(self, on: bool) -> dict:
        """无边框窗口开关：Windows 立刻摘掉 / 装回标题栏；macOS 第一版只走原生标题栏。"""
        if not IS_WINDOWS:
            self.frameless = False
            self.launcher["frameless"] = False
            return {"ok": False, "frameless": False,
                    "error": "macOS 第一版尚未移植自绘无边框窗口，继续使用系统标题栏"}
        self.frameless = bool(on)
        self.launcher["frameless"] = self.frameless
        if self._window is not None:
            set_window_frame(self._hwnd(), self.frameless)
        cfg = load_config()
        cfg["frameless"] = self.frameless
        if not write_config(cfg):
            return {"ok": False, "error": f"写入启动配置失败：{CONFIG_FILE}"}
        log_line(f"frameless {self.frameless}")
        return {"ok": True, "frameless": self.frameless,
                "msg": "无边框窗口已开启" if self.frameless else "已恢复系统标题栏"}

    def _hwnd(self) -> int:
        if not IS_WINDOWS:
            return 0
        return int(self._window.native.Handle.ToInt64())

    def set_dev_mode(self, on: bool) -> dict:
        """开发模式开关：写进启动配置，下次开机走 webview.start(debug=True)。pywebview 在
        CoreWebView2 建环境时定值（AreBrowserAcceleratorKeysEnabled / AreDefaultContextMenusEnabled /
        AreDevToolsEnabled 全等于 debug），运行中的窗口改不了，勾完要重启窗口。"""
        self.launcher["dev_mode"] = bool(on)
        cfg = load_config()
        cfg["dev_mode"] = self.launcher["dev_mode"]
        if not write_config(cfg):
            return {"ok": False, "error": f"写入启动配置失败：{CONFIG_FILE}"}
        log_line(f"dev_mode {self.launcher['dev_mode']}")
        return {"ok": True, "dev_mode": self.launcher["dev_mode"],
                "msg": ("开发模式已开启，重启窗口后生效：F5 / Ctrl+F5 刷新、右键菜单、开发者工具"
                        if self.launcher["dev_mode"] else "开发模式已关闭，重启窗口后生效")}

    def ensure_resizable_frame(self) -> None:
        """pywebview 的 frameless 走 FormBorderStyle=None，可拖拽边框一起摘掉：窗口显示后补回 WS_THICKFRAME。"""
        if self.frameless and self._window is not None:
            set_window_frame(self._hwnd(), True)

    def enable_copy_keys(self) -> None:
        """非 dev 窗口放开原生复制按键：pywebview 把 AreBrowserAcceleratorKeysEnabled 绑在 debug 上
        （platforms/edgechromium.py 建核时写死），Ctrl+C / Ctrl+V / Ctrl+A 在 WebView2 层就被吞了；
        页面又跑在 http://127.0.0.1 非安全上下文，navigator.clipboard 不存在，复制没有原生出口。
        建核后补开加速器键，DevTools 与右键菜单保持关，开发模式另开。"""
        if self._window is None or not IS_WINDOWS:
            return
        try:
            settings = self._window.browser.webview.CoreWebView2.Settings
        except AttributeError as e:
            log_line(f"accelerator keys skipped: {e}")   # pywebview 内部结构变了，复制只剩页内图标钮一条路
            return
        settings.AreBrowserAcceleratorKeysEnabled = True

    def window_state(self) -> dict:
        """顶栏自绘标题栏要的状态：frameless 决定控件出不出，maximized / fullscreen 决定图标。
        pywebview 的 Window.maximized / .fullscreen 是建窗时的初值，运行中不跟着变，状态由桌面端自己记。"""
        return {"frameless": self.frameless, "maximized": self.maximized, "fullscreen": self.fullscreen}

    def win_minimize(self) -> None:
        self._window.minimize()

    def win_maximize(self) -> dict:
        if not IS_WINDOWS:
            # macOS 原生标题栏：系统 zoom/restore 自己管还原态，第一版不跟 Win32 那套工作区矩形。
            if self.maximized:
                self._window.restore()
                self.maximized = False
            else:
                self._window.maximize()
                self.maximized = True
            return self.window_state()
        # 无边框下系统 maximize 给的是整屏矩形，任务栏会被盖住：自己铺工作区，还原用的几何留着
        if self.maximized:
            self.maximized = False
            if self._restore_rect is not None:
                left, top, right, bottom = self._restore_rect
                self._restore_rect = None
                u32.SetWindowPos(self._hwnd(), 0, left, top, right - left, bottom - top, SWP_NOZORDER)
            else:
                self._window.restore()
        elif self.frameless:
            self._restore_rect = window_rect(self._hwnd())
            left, top, right, bottom = work_area()
            u32.SetWindowPos(self._hwnd(), 0, left, top, right - left, bottom - top, SWP_NOZORDER)
            self.maximized = True
        else:
            self._window.maximize()
            self.maximized = True
        return self.window_state()

    def win_fullscreen(self) -> dict:
        self._window.toggle_fullscreen()
        self.fullscreen = not self.fullscreen
        # pywebview 退出全屏会把 FormBorderStyle 写回建窗时的值，标题栏跟着回来：按我们的状态重贴
        if self._window is not None:
            set_window_frame(self._hwnd(), self.frameless)
        return self.window_state()

    def win_close(self) -> None:
        log_line("win_close")
        self._window.destroy()

    def win_start_drag(self) -> None:
        """无边框拖动：桌面端自己跟住光标搬窗口。
        把按下交回系统走原生标题栏循环这条路在这里走不通 —— WinForms 的 Form 自己吞掉非客户区
        按下，消息到不了默认处理，拖动循环 0ms 返回、窗口纹丝不动（补 WS_CAPTION、换
        WM_SYSCOMMAND·SC_MOUSEMOVE 都一样，实测过）。所以自己循环：按「光标 - 抓取偏移」
        SetWindowPos，左键一松就停。
        必须跑在窗口所属线程上：SetCapture 只认窗口的所属线程，捕获不过来的话 WebView2 继续吃
        鼠标消息（拖动时选中文本之类），松手也传不到这边。
        macOS 第一版走原生标题栏：自绘无边框拖动尚未移植，这里明确 no-op。"""
        if not IS_WINDOWS:
            log_line("drag skipped: no custom frameless drag on this platform")
            return

        def _drag() -> None:
            hwnd = self._hwnd()
            left, top, _, _ = window_rect(hwnd)
            x0, y0 = _cursor_pos()
            dx, dy = x0 - left, y0 - top   # 抓取偏移：光标在窗口里的位置拖动中不许变
            threshold = max(u32.GetSystemMetrics(SM_CXDRAG), 2)
            u32.SetCapture(hwnd)
            steps = 0
            while _left_button_down():
                x, y = _cursor_pos()
                if not steps:
                    if abs(x - x0) < threshold and abs(y - y0) < threshold:
                        time.sleep(0.008)
                        continue
                    resized = self.fullscreen or self.maximized
                    if self.fullscreen:
                        self.win_fullscreen()   # 全屏时先退出全屏：整屏窗口跟着光标跑，pywebview 还停在全屏态
                    elif self.maximized:
                        self.win_maximize()   # 最大化时先还原：不然整块工作区大小的窗口跟着光标跑
                    if resized:
                        left, top, _, _ = window_rect(hwnd)
                        dx, dy = x - left, y - top   # 还原换了窗口矩形，抓取偏移按光标在新矩形里的位置重算
                u32.SetWindowPos(hwnd, 0, x - dx, y - dy, 0, 0,
                                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
                steps += 1
                time.sleep(0.008)
            u32.ReleaseCapture()
            log_line(f"drag {steps} steps")   # 0 = 按下没走出阈值，或左键已经不在了

        native = getattr(self._window, "native", None)
        if native is None:
            _drag()
            return
        import clr                      # noqa: F401  pythonnet 的导入钩子，System 靠它才认
        from System import Func, Type
        native.Invoke(Func[Type](_drag))

    def pick_root(self) -> str:
        """原生目录选择器，只回路径；校验交给「保存并重启」，选完还能改。"""
        return pick_folder(str(self.launcher.get("root", "")))

    def pick_python(self) -> str:
        """原生文件对话框选 python.exe：起始目录落在当前解释器所在的文件夹。"""
        cur = Path(str(self.launcher.get("python", "")))
        return pick_python_file(str(cur.parent) if cur.parent.is_dir() else "")

    def check_setup(self, root: str, python: str) -> dict:
        """引导页的实时校验：根目录要有 main.py，解释器要真是文件。"""
        root_s, py_s = str(root).strip(), str(python).strip()
        # 空串会变相对路径 "."：启动器在 ComfyUI 目录里跑时那就是个合法根目录，必须挡掉
        return {"root_ok": bool(root_s) and root_ok(Path(root_s)),
                "python_ok": bool(py_s) and Path(py_s).is_file(),
                "root": root_s, "python": py_s}

    def start_setup(self, root: str, python: str) -> dict:
        """引导页的「开始」：根目录补完了桌面端服务才装配得起来，起完再走保存并拉起。"""
        self.launcher.update(root=str(root).strip(), python=str(python).strip())
        if not self.ensure_server():
            return {"ok": False, "error": self.launcher.get("error")
                            or "桌面端服务起不来，原因见启动器日志"}
        return self.apply_launcher(root, python, self.port)

    def start_remote(self, remote: str) -> dict:
        """macOS 远程引导页：保存一个远端地址并连过去。本机不装插件、不找 Python、不起 ComfyUI。"""
        base = comfy_remote(remote)
        if base is None:
            return {"ok": False, "error": "远程地址无效：请输入 http://主机:端口"}
        self.remote = base
        self.url = self.studio_url()
        self.root, self.python_arg = Path(""), ""
        self.offline_url = ""
        self.launcher.update(remote=base, root="", python="", plugin_dir=str(PLUGIN_SOURCE_DIR),
                             state=ST_REMOTE, error="")
        if not save_config(Path(""), "", self.port, self.launcher):
            return {"ok": False, "error": f"写入启动配置失败：{CONFIG_FILE}"}
        log_line(f"remote guide saved {base}")
        state, msg = remote_startup_state(base)
        self.launcher.update(state=state, error=msg)
        st = self.comfy_start()
        self.launcher.update(comfy=st)
        if state == ST_REMOTE:
            return {"ok": True, "state": state, "comfy": st, "msg": "已连接远端 ComfyUI"}
        return {"ok": True, "state": state, "comfy": st, "error": msg,
                "msg": "远程地址已保存，当前不可达，稍后会继续重连"}

    def apply_launcher(self, root: str, python: str, port: int, listen: str = None,
                       remote: str = None) -> dict:
        """保存启动设置并重启 ComfyUI：换根目录、换解释器、换端口、换监听地址、换远程地址都走这一条路。"""
        root_s, py_s = str(root).strip(), str(python).strip()
        root_p, py = Path(root_s), Path(py_s)
        base = self.remote if remote is None else comfy_remote(remote)
        if base is None:
            return {"ok": False, "error": f"远程地址不是 http(s)://主机[:端口]（留空 = 连本机）：{remote}"}
        try:
            port = int(port)
        except (TypeError, ValueError):
            return {"ok": False, "error": f"端口不是数字：{port}"}
        if not 1024 <= port <= 65535:
            return {"ok": False, "error": f"端口需在 1024-65535 之间：{port}"}
        # listen 为 None = 这次没动监听（引导页那条路），沿用已存的
        addr = self.listen if listen is None else comfy_listen(listen)
        if addr is None:
            return {"ok": False, "error": f"监听地址不是 IP（逗号分隔多个，留空 = 只监听本机）：{listen}"}

        remote_only = bool(base) and (not root_s or not py_s)
        if remote_only:
            self.listen = addr
            self.remote = base
            self.launcher.update(listen=addr, remote=base, port=port,
                                 root="", python="", plugin_dir=str(PLUGIN_SOURCE_DIR))
            if not save_config(Path(""), "", port, self.launcher):
                return {"ok": False, "error": f"写入启动配置失败：{CONFIG_FILE}"}
            self.root, self.python_arg, self.port = Path(""), "", port
            self.url = self.studio_url()
            self.offline_url = ""   # 纯远程模式不拿本机只读服务当离线页
            log_line(f"launcher apply remote-only {base} port={port}")
            state, msg = remote_startup_state(base)
            self.launcher.update(state=state, error=msg)
            st = self.comfy_start()
            self.launcher.update(comfy=st)
            return {"ok": True, "state": state, "comfy": st,
                    "msg": "已保存，正在连接远端 ComfyUI…"}

        if not root_s or not root_ok(root_p):
            return {"ok": False, "error": f"不是 ComfyUI 根目录（找不到 main.py）：{root_s}"}
        if not py_s or not py.is_file():
            return {"ok": False, "error": f"Python 解释器不存在：{py_s}"}
        self.listen = addr
        self.remote = base
        self.launcher["listen"] = addr
        self.launcher["remote"] = base
        if not save_config(root_p, py, port, self.launcher):
            return {"ok": False, "error": f"写入启动配置失败：{CONFIG_FILE}"}
        self.root, self.python_arg, self.port = root_p, str(py), port
        self.url = self.studio_url()
        self.launcher.update(root=str(root_p), python=str(py), port=port,
                             plugin_dir=str(plugin_dir_for(root_p)))
        log_line(f"launcher apply root={root_p} python={py} port={port} "
                 f"listen={addr or '127.0.0.1'} remote={base or '本机'}")
        self.comfy_stop()   # 带走旧进程，窗口退回离线页
        state, msg = startup_state(root_p, py, plugin_dir_for(root_p))
        self.launcher.update(state=state, error=msg)
        if state != ST_OK:
            return {"ok": False, "error": msg, "state": state}
        st = self.comfy_start()
        self.launcher.update(comfy=st)
        return {"ok": True, "state": state, "comfy": st,
                "msg": "已保存，正在连接远端 ComfyUI…" if self.remote else "已保存，ComfyUI 重启中…"}

    def install_plugin(self) -> dict:
        """自动安装失败后的重试：把内置副本装进 custom_nodes，成功就接着拉起。"""
        plugin_dir = plugin_dir_for(self.root)
        ok, msg = ensure_plugin(plugin_dir)
        if not ok:
            self.launcher.update(state=ST_INSTALL_FAIL, error=msg)
            log_line(f"install plugin failed: {msg}")
            return {"ok": False, "error": msg}
        self.launcher.update(plugin_dir=str(plugin_dir), state=ST_OK, error="")
        log_line(f"plugin installed {plugin_dir}")
        return self.comfy_start()

    def install_deps(self) -> dict:
        """联网装插件依赖：只在依赖安全网失败时出现，由用户显式点。"""
        res = install_deps(self.python_arg, plugin_dir_for(self.root))
        log_line(f"install deps {res}")
        if res["ok"]:
            self.launcher.update(state=ST_OK, error="")
        return res


def purge_web_cache() -> None:
    """开窗口前清掉 WebView2 的 HTTP 缓存。

    桌面端静态文件已经 no-store，但历史缓存里的旧插件 JS 会被直接端出来用（不发请求）：
    改了 web/*.js 之后，旧模块和新拉到的模块拼进同一张 ES 模块图，一个链接错误
    （旧 gallery-utils.js 没有新导出）就让 studio-app.js 整份不执行 —— 视图不挂、
    离线横幅不出、顶栏胶囊永远 hidden，窗口只剩顶栏，连重新拉起 ComfyUI 的按钮都没有。"""
    shutil.rmtree(WEBVIEW_CACHE, ignore_errors=True)


PY_FILE_TYPES = ("Python 解释器 (*.exe)",)
_studio_window = None   # main() 建好窗口后回填：对话框走窗口模态，选择框贴着窗口


def _on_sta(call):
    """对话框是 STA 的 COM 对象；js_api 的调用线程来自线程池，apartment 不由我们定。

    macOS/Linux 直接用 pywebview 的 native 对话框。"""
    if not IS_WINDOWS:
        return call()

    out: list = [None]

    def run():
        try:
            ctypes.windll.ole32.OleInitialize(None)
            out[0] = call()
        except Exception as exc:
            out[0] = exc

    t = threading.Thread(target=run)
    t.start()
    t.join()
    if isinstance(out[0], Exception):
        raise out[0]
    return out[0]


def _dialog_result(result) -> str:
    if isinstance(result, (list, tuple)):
        return result[0] if result else ""
    return str(result or "")


def pick_folder(start: str = "") -> str:
    """原生目录选择器：macOS 走 pywebview Cocoa dialog，Windows 走 WinForms 目录对话框。"""
    if _studio_window is None:
        return ""
    res = _on_sta(lambda: _studio_window.create_file_dialog(FileDialog.FOLDER, directory=start))
    return _dialog_result(res)


def pick_python_file(start: str = "") -> str:
    """选解释器：macOS 选 venv/bin/python 或裸 python；Windows 选 python.exe。"""
    if _studio_window is None:
        return ""
    file_types = (("可执行文件", "*.python*") if IS_MAC else PY_FILE_TYPES) if not IS_WINDOWS else PY_FILE_TYPES
    res = _on_sta(lambda: _studio_window.create_file_dialog(FileDialog.OPEN, directory=start,
                                                            file_types=file_types))
    return _dialog_result(res)


SPLASH_JS = """
(function () {
    var stage = document.getElementById('stage');
    var tries = 0;
    async function poll() {
        var api = window.pywebview && window.pywebview.api;
        if (api) {
            try {
                var s = await api.comfy_state();
                stage.textContent = s.ready ? 'ComfyUI 就绪，正在进入'
                    : s.starting ? '已拉起 ComfyUI（PID ' + s.pid + '），正在等待就绪'
                    : '正在自检与准备桌面端服务';
                if (s.ready) return;   // 就绪这一刻桌面端随即接上生成，不再问
            } catch (e) {}   // 窗口收尾路上 api 调用会 reject：阶段行停在上一句文案
        } else if (tries++ >= 20) {
            return;   // 桌面端方法始终没挂上：动画照跑，阶段行留在初始文案
        }
        setTimeout(poll, 900);
    }
    poll();
})();
"""


def splash_html() -> str:
    """冷启动时先出窗口显示的启动页：ComfyUI 就绪前不让用户对着空白干等。

    动画照 ComfyUI 前端启动页那套机制：品牌图形当遮罩，遮罩里一条浪线横向滚、整组随呼吸上浮，
    浪头漫过图形就是「就绪在望」。阶段行走 js_api 报真实进度 —— 冷启动要扫模型目录、装依赖、
    起桌面端服务，写死一句「请稍候」在慢的那路上就是假承诺。
    """
    return ('<!doctype html><meta charset=utf-8><title>新影工坊 · Neo Studio</title>'
            '<style>'
            'html,body{height:100%;margin:0;overflow:hidden;background:#1e1e1e;color:#d7dae0;'
            'font-family:system-ui}'
            '#splash{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;'
            'justify-content:center;contain:strict}'
            '#splash svg{width:min(190px,42vw);height:auto;transform:translateZ(0)}'
            '#splash .wave-group{animation:ns-rise 4s ease-in-out infinite alternate;'
            'will-change:transform;transform:translateZ(0)}'
            '#splash .wave-path{animation:ns-wave 1.2s linear infinite;'
            'will-change:transform;transform:translateZ(0)}'
            '#stage::after{content:"\\2026";animation:ns-dots 1.2s steps(1,end) infinite}'
            '@keyframes ns-rise{from{transform:translateY(150px)}to{transform:translateY(-40px)}}'
            '@keyframes ns-wave{from{transform:translateX(0)}to{transform:translateX(-240px)}}'
            '@keyframes ns-dots{0%{content:"\\2026"}25%{content:""}50%{content:" \\b7"}75%{content:" \\b7\\b7"}}'
            '@media (prefers-reduced-motion:reduce){#splash .wave-group,#splash .wave-path{animation:none;'
            'will-change:auto}#splash .wave-group{transform:translateY(-40px)}}'
            'h1{font-size:20px;font-weight:600;margin:20px 0 0}'
            '#stage{font-size:13px;color:#8a8f98;margin-top:8px}'
            '</style>'
            '<div id="splash" role="status" aria-label="正在启动 ComfyUI">'
            # 场记板当遮罩：斜条与播放三角挖空，浪线漫过去时图形认得出来
            '<svg viewBox="0 0 240 200" fill="none" xmlns="http://www.w3.org/2000/svg">'
            '<defs><mask id="ns-splash-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="200">'
            '<rect x="14" y="16" width="212" height="36" rx="10" fill="#fff"/>'
            '<rect x="14" y="58" width="212" height="126" rx="14" fill="#fff"/>'
            '<g fill="#000">'
            '<path d="M22 16h26l-34 36h-26zM74 16h26l-34 36h-26zM126 16h26l-34 36h-26zM178 16h26l-34 36h-26z"/>'
            '<path d="M98 92l44 29-44 29z"/></g></mask></defs>'
            '<g mask="url(#ns-splash-mask)"><g class="wave-group">'
            '<path class="wave-path" d="M0 60Q60 20 120 60T240 60T360 60T480 60V400H0Z" fill="#2f6feb"/>'
            '</g></g>'
            '<g fill="none" stroke="currentColor" stroke-width="2" opacity="0.4">'
            '<rect x="14" y="16" width="212" height="36" rx="10"/>'
            '<rect x="14" y="58" width="212" height="126" rx="14"/>'
            '<path d="M98 92l44 29-44 29z"/></g></svg>'
            '<h1>新影工坊 · Neo Studio</h1>'
            '<div id="stage">正在启动 ComfyUI，请稍候</div>'
            '</div>'
            '<script>' + SPLASH_JS + '</script>')


GUIDE_JS = """
var S = __STATE__;
var el = function (id) { return document.getElementById(id); };
el('root').value = S.root || '';
el('py').value = S.python || '';
function api() { return window.pywebview && window.pywebview.api; }
function mark(id, ok, okText, badText) {
  var n = el(id);
  n.textContent = ok ? okText : badText;
  n.className = 'st ' + (ok ? 'ok' : 'bad');
}
async function refresh() {
  var r = await api().check_setup(el('root').value, el('py').value);
  mark('rst', r.root_ok, '找到 main.py：' + r.root, '需要选择：这个目录下没有 main.py');
  mark('pst', r.python_ok, '' + r.python, '需要选择：请指向 python.exe');
  el('go').disabled = !(r.root_ok && r.python_ok);
}
el('broot').onclick = async function () {
  var p = await api().pick_root();
  if (p) { el('root').value = p; await refresh(); }
};
el('bpy').onclick = async function () {
  var p = await api().pick_python();
  if (p) { el('py').value = p; await refresh(); }
};
el('root').onchange = refresh;
el('py').onchange = refresh;
el('go').onclick = async function () {
  el('go').disabled = true;
  el('msg').textContent = '正在拉起 ComfyUI，就绪后自动进入…';
  var r = await api().start_setup(el('root').value, el('py').value);
  if (!r.ok) { el('msg').textContent = r.error || '启动失败'; el('go').disabled = false; }
};
refresh();
"""


REMOTE_GUIDE_JS = """
var S = __STATE__;
var el = function (id) { return document.getElementById(id); };
function api() { return window.pywebview && window.pywebview.api; }
el('remote').value = S.remote || '';
el('msg').textContent = S.error || '';
el('msg').className = S.error ? 'bad' : '';
el('go').onclick = async function () {
  el('go').disabled = true;
  el('msg').textContent = '正在连接远端 ComfyUI…';
  el('msg').className = '';
  var r = await api().start_remote(el('remote').value);
  if (!r.ok) {
    el('go').disabled = false;
    el('msg').textContent = r.error || '连接失败';
    el('msg').className = 'bad';
  }
};
"""


def remote_guide_html(state: dict) -> str:
    """macOS 远程引导页：只要一个远端 ComfyUI 地址，本机不找 root、不装插件、不起进程。"""
    return ('<!doctype html><meta charset=utf-8><title>新影工坊 · Neo Studio 远程连接</title>'
            '<style>'
            'html,body{height:100%;margin:0;background:#1e1e1e;color:#d7dae0;font:14px/1.7 system-ui}'
            '.wrap{max-width:820px;margin:0 auto;padding:40px 32px}'
            'h1{font-size:20px;font-weight:600;margin:0}'
            '.sub{font-size:13px;color:#8a8f98;margin:6px 0 26px}'
            '.row{margin-bottom:20px}'
            '.row b{display:block;margin-bottom:6px}'
            '.line{display:flex;gap:8px}'
            'input{flex:1;min-width:0;background:#262626;color:#d7dae0;border:1px solid #3d3d3d;'
            'border-radius:6px;padding:8px 10px;font:13px system-ui}'
            'button{background:#2f6feb;color:#fff;border:0;border-radius:6px;padding:8px 16px;'
            'font:13px system-ui;cursor:pointer}'
            'button:disabled{opacity:.45;cursor:default}'
            '.go{margin-top:6px;text-align:right}'
            '#msg{font-size:13px;color:#8a8f98;margin-top:14px;white-space:pre-wrap}'
            '.bad{color:#e0a94a}'
            '</style>'
            '<div class=wrap>'
            '<h1>新影工坊 · Neo Studio</h1>'
            '<div class=sub>输入局域网内那台 ComfyUI 的地址。本机不需要安装 ComfyUI，也不需要选择根目录。</div>'
            '<div class=row><b>远程 ComfyUI 地址</b><div class=line>'
            '<input id=remote spellcheck=false placeholder="http://192.168.0.7:8188"></div>'
            '<div class=sub>远端需要已启动 ComfyUI，并已开启 --listen 与 Neo Studio 插件。</div></div>'
            '<div class=go><button id=go>连接</button></div>'
            '<div id=msg></div>'
            '</div>'
            '<script>' + REMOTE_GUIDE_JS.replace("__STATE__", json.dumps(state, ensure_ascii=False)) + '</script>')


def guide_html(state: dict) -> str:
    """首次设置页：macOS 远程第一版走远程引导，Windows 仍走补齐 ComfyUI 根目录与解释器的本地引导。"""
    if state.get("remote_guide"):
        return remote_guide_html(state)
    """补齐 ComfyUI 根目录与 Python 解释器，自动找到的直接预填，缺哪个补哪个。

    页面走 load_html + js_api，不碰桌面端服务 —— 根目录无效时 build_app 连 folder_paths 都 import 不了，
    服务本来就起不来。校验与拉起都在桌面端里，页面只收路径和显示原因。"""
    return ('<!doctype html><meta charset=utf-8><title>新影工坊 · Neo Studio 首次设置</title>'
            '<style>'
            'html,body{height:100%;margin:0;background:#1e1e1e;color:#d7dae0;font:14px/1.7 system-ui}'
            '.wrap{max-width:820px;margin:0 auto;padding:40px 32px}'
            'h1{font-size:20px;font-weight:600;margin:0}'
            '.sub{font-size:13px;color:#8a8f98;margin:6px 0 26px}'
            '.row{margin-bottom:20px}'
            '.row b{display:block;margin-bottom:6px}'
            '.line{display:flex;gap:8px}'
            'input{flex:1;min-width:0;background:#262626;color:#d7dae0;border:1px solid #3d3d3d;'
            'border-radius:6px;padding:8px 10px;font:13px system-ui}'
            'button{background:#2f6feb;color:#fff;border:0;border-radius:6px;padding:8px 16px;'
            'font:13px system-ui;cursor:pointer}'
            'button:disabled{opacity:.45;cursor:default}'
            '.st{font-size:12px;margin-top:5px}'
            '.ok{color:#7ec699}.bad{color:#e0a94a}'
            '.go{margin-top:6px;text-align:right}'
            '#msg{font-size:13px;color:#8a8f98;margin-top:14px;white-space:pre-wrap}'
            '</style>'
            '<div class=wrap>'
            '<h1>新影工坊 · Neo Studio 首次设置</h1>'
            '<div class=sub>补齐下面两项，启动器会写入配置并拉起 ComfyUI。已自动找到的直接沿用。</div>'
            '<div class=row><b>① ComfyUI 根目录</b><div class=line>'
            '<input id=root spellcheck=false><button id=broot>选择…</button></div>'
            '<div id=rst class=st></div></div>'
            '<div class=row><b>② Python 解释器</b><div class=line>'
            '<input id=py spellcheck=false><button id=bpy>选择…</button></div>'
            '<div id=pst class=st></div></div>'
            '<div class=go><button id=go>开始</button></div>'
            '<div id=msg></div>'
            '</div>'
            '<script>' + GUIDE_JS.replace("__STATE__", json.dumps(state, ensure_ascii=False)) + '</script>')


SINGLETON_LOCK_FILE = STATE / "single_instance.lock"


def singleton():
    """已有桌面端窗口返回 None：第二个实例直接退出，避免多窗口抢显存。

    Windows 仍用命名互斥体；macOS 第一版用同一份数据目录里的 flock。锁文件不占端口，
    也不会像 ComfyUI 残留标记那样混进素材库或启动配置。"""
    if IS_WINDOWS:
        h = k32.CreateMutexW(None, False, SINGLETON_MUTEX)
        if k32.GetLastError() == ERROR_ALREADY_EXISTS:
            k32.CloseHandle(h)
            return None
        return h or None
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        fd = os.open(SINGLETON_LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    try:
        os.truncate(fd, 0)
        os.write(fd, str(os.getpid()).encode("utf-8"))
        os.fsync(fd)
    except OSError:
        pass   # 锁仍有效；写入 PID 只是给调试时看，失败不能把单实例拦住
    return fd


SINGLETON_HANDLE = None


def release_singleton() -> None:
    """交还互斥体/文件锁。锁只在进程退出时由系统释放，关窗收尾那一两秒里重开就被「窗口已在运行」拦住 ——
    用户读成「关完要等一会才能启动」。收尾一开头就交还，窗口还没落地也能重开。"""
    global SINGLETON_HANDLE
    if SINGLETON_HANDLE:
        if IS_WINDOWS:
            k32.CloseHandle(SINGLETON_HANDLE)
        else:
            try:
                fcntl.flock(SINGLETON_HANDLE, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(SINGLETON_HANDLE)
            except OSError:
                pass
        SINGLETON_HANDLE = None


def ensure_clr() -> None:
    """开窗口前把 pythonnet 的 CLR 宿主装好，netfx 起不来就换 coreclr。

    macOS Cocoa 不需要 pythonnet；这里只在 Windows edgechromium 前跑一次。"""
    if not IS_WINDOWS:
        return
    try:
        import clr  # noqa: F401
        return
    except Exception as exc:
        log_line(f"clr netfx failed: {exc!r}")
    if CORECLR_CONFIG.exists():
        os.environ.setdefault("PYTHONNET_CORECLR_RUNTIME_CONFIG", str(CORECLR_CONFIG))
    import pythonnet
    pythonnet.set_runtime("coreclr")
    import clr  # noqa: F401
    log_line("clr switched to coreclr")


def main() -> int:
    ap = argparse.ArgumentParser(description="Neo Studio 桌面端")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--python", default="")
    ap.add_argument("--root", default="")
    ap.add_argument("--remote", default="", help="远程 ComfyUI：http(s)://主机[:端口]；空 = 连本机/读取已存配置")
    ap.add_argument("--cdp", type=int, default=0, help="WebView2 远程调试端口（E2E 用）")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    if webview is None:
        alert("缺少 pywebview：用整合包 python 执行 pip install pywebview")
        return 1

    cfg = load_config()
    raw_remote = args.remote if args.remote else str(cfg.get("remote", ""))
    remote = comfy_remote(raw_remote)
    if remote is None:
        alert(f"远程地址无效：{raw_remote}（需要 http(s)://主机[:端口]，或留空连本机）")
        return 1

    port = args.port or int(cfg.get("port") or DEFAULT_PORT)
    log_line(f"start port={port} state={STATE}")
    lock = singleton()
    if lock is None:
        log_line("singleton busy")
        alert("Neo Studio 窗口已在运行")
        return 0
    global SINGLETON_HANDLE
    SINGLETON_HANDLE = lock   # 句柄活到进程结束锁才成立；交还点在 on_closing

    # 纯远程 macOS 第一版：有 remote 就完全绕开本机 ComfyUI 根目录、解释器与桌面端只读服务。
    # 本地模式仍保留给 Windows；macOS 无 remote 时先走远程引导页，避免把本机自检当必选项。
    remote_only = bool(remote) and (IS_MAC or bool(args.remote)) and not args.root
    if remote_only:
        root = None
        python = None
        plugin_dir = serve_dir = PLUGIN_SOURCE_DIR
        need_guide = False
    else:
        root = resolve_root(args.root)
        python = find_python(root, args.python or cfg.get("python", "")) if root is not None else None
        # 根目录无效或解释器找不到：窗口先开在引导页补齐，选完再起服务、拉起 ComfyUI
        need_guide = root is None or not root_ok(root) or python is None
        plugin_dir = plugin_dir_for(root) if root is not None else PLUGIN_SOURCE_DIR
        # flags 由桌面端服务与 js_api 共用：拉起 ComfyUI 的那一刻起，页面的版本快照就是「启动中」
        # 插件缺失且自动安装失败：桌面端服务退回内置副本，素材库照旧离线可浏览
        serve_dir = plugin_dir if plugin_dir.is_dir() else PLUGIN_SOURCE_DIR
    flags = {"starting": False}
    remote_guide = IS_MAC and not remote_only and not remote
    launcher = {"root": str(root or ""), "python": str(python or ""), "port": port,
                "plugin_dir": str(plugin_dir), "state_dir": str(STATE),
                "portable": IS_FROZEN, "state": ST_REMOTE if remote_only else ST_OK, "error": "",
                # 无边框是 Windows 新默认；macOS 第一版用原生标题栏，老配置也不能把自绘拖动带过来
                "frameless": bool(cfg.get("frameless", not IS_MAC)),
                # 开发模式默认关：pywebview 把 WebView2 的刷新键 / 右键菜单 / 开发者工具全绑在 debug 上
                "dev_mode": bool(cfg.get("dev_mode")),
                # 局域网监听默认空 = ComfyUI 只监听 127.0.0.1；lan_ips 是给设置页抄的提示地址
                # remote 非空 = 连远端那台 ComfyUI：本机不拉进程，窗口直接指向远端
                "listen": comfy_listen(cfg.get("listen", "")) or "", "lan_ips": lan_ips(),
                "remote": remote, "remote_guide": remote_guide,
                "remote_only": remote_only, "platform": "mac" if IS_MAC else "windows"}
    launcher_api: dict = {}   # 桌面端路由延迟取桌面端的方法：服务先起，桌面端的方法随后补上
    if need_guide:
        state, msg = ((ST_REMOTE_DOWN, "还没填写远程 ComfyUI 地址")
                      if remote_guide
                      else (ST_BAD_ROOT, "还没确定 ComfyUI 根目录")
                      if root is None or not root_ok(root)
                      else (ST_NO_PYTHON, "还没确定 Python 解释器"))
        launcher.update(state=state, error=msg)
        log_line(f"startup state={state} {msg}")
    # build_app 要把根目录加进 sys.path 才能 import folder_paths：根目录无效时装配必崩。
    # 引导页补完根目录后由 ensure_server 重取，服务才装配得起来。
    boot = {"root": root, "serve_dir": serve_dir}
    # MCP 会话登记表与桌面端服务共用：页面连上的那批进程，关窗收尾回收的也是这批
    # 注册表还没有文件时内置这一条：插件自带 mcp_server.py，解释器与副本路径只有桌面端知道
    builtin = mcp_client.builtin_server(python, serve_dir / "mcp_server.py",
                                         f"http://127.0.0.1:{port}")
    mcp = mcp_client.McpManager(STATE / "configs" / "mcp_servers.json", log_line,
                                defaults=[builtin] if builtin else [])
    server = DesktopServer(lambda: build_app(boot["root"], boot["serve_dir"], flags, launcher,
                                           launcher_api, COMFY_LOG, data_root=STATE,
                                           mcp_manager=mcp,
                                           kernel_state=lambda: desktop.comfy_state()),
                         port + DESKTOP_PORT_OFFSET)
    offline_url = ""

    def start_server() -> bool:
        """起桌面端只读服务；起不来（端口被占 / 装配报错）只回 False，原因只能靠这行日志。"""
        nonlocal offline_url
        if server.bound:
            return True
        if not server.start():
            log_line(f"desktop service failed: {server.error!r}")
            return False
        log_line(f"desktop service port={server.bound}")
        offline_url = f"http://127.0.0.1:{server.bound}/neo-studio"
        return True

    def ensure_server() -> bool:
        """引导页的「开始」：根目录补完了才谈得上起服务，起完把离线页地址交回已开好的窗口。"""
        boot["root"] = Path(launcher["root"])
        plugin_dir = plugin_dir_for(boot["root"])
        # 与正常启动同一套自检：插件没装进用户选的根目录就先装内置副本 —— 桌面端服务要
        # 从那儿 exec_module 挂 gallery 等模块，目录不存在时装配直接抛 FileNotFoundError
        state, msg = startup_state(boot["root"], Path(launcher["python"]), plugin_dir)
        launcher.update(state=state, error=msg)
        if state == ST_BAD_ROOT:
            return False
        boot["serve_dir"] = plugin_dir if plugin_dir.is_dir() else PLUGIN_SOURCE_DIR
        if not start_server():
            return False
        desktop.desktop_port = server.bound
        desktop.offline_url = offline_url
        return True

    desktop = StudioDesktop(f"http://127.0.0.1:{port}/neo-studio", None, port, root or Path(""),
                        str(python or ""), "", port + DESKTOP_PORT_OFFSET, flags, launcher)
    desktop.ensure_server = ensure_server
    launcher_api.update(apply=desktop.apply_launcher, start_remote=desktop.start_remote,
                        install_plugin=desktop.install_plugin,
                        install_deps=desktop.install_deps, pick_root=desktop.pick_root,
                        set_frameless=desktop.set_frameless, set_dev_mode=desktop.set_dev_mode,
                        state=desktop.launcher_state)
    geo = load_geometry()
    # background_color 显式给页面底色：pywebview 用它同时定 Form.BackColor 与 WebView2 的
    # DefaultBackgroundColor，默认白色 —— 拖边框缩放的模态循环里新客户区先刷它，白窗就是这么闪出来的
    kw = dict(width=geo.get("width", 1440), height=geo.get("height", 900),
             x=geo.get("x"), y=geo.get("y"), min_size=(900, 600),
             frameless=desktop.frameless, easy_drag=False, js_api=desktop,
             # text_select 显式开：pywebview 默认 False，注入页面的 customize.js 给非表单元素
             # preventDefault selectstart，聊天正文与右栏回答一个字都选不动，划词复制整条没有出口
             text_select=True,
             background_color=WINDOW_BG)
    # easy_drag 关掉：pywebview 的简易拖动是全局 mousedown，无边框时点任何卡片都会拖着窗口跑；
    # 拖动改由顶栏空白处按下交回系统（StudioDesktop.win_start_drag）
    # 窗口先出：起解释器查依赖、装配桌面端服务、拉起 ComfyUI 全在后台线程走完。
    # 引导页等用户补齐根目录与解释器，其余停在启动页，就绪后由后台线程把窗口指过去。
    if need_guide:
        window = webview.create_window("新影工坊 · Neo Studio", html=guide_html(launcher), **kw)
    else:
        window = webview.create_window("新影工坊 · Neo Studio", html=splash_html(), **kw)
    desktop.loader = window.load_url
    desktop._window = window
    # 原生窗口在 start() 里才建出来，建窗时拿不到 hwnd：无边框补边框挂在窗口显示之后
    window.events.shown += desktop.ensure_resizable_frame
    window.events.shown += desktop.enable_copy_keys
    global _studio_window
    _studio_window = window


    def arm_pill() -> None:
        def on_loaded() -> None:
            # 每次整页加载记一行：窗口停在离线页还是完整 Studio，事后看日志就知道
            log_line(f"page loaded {window.get_current_url()}")
            # 主画布是整页刷新，返回入口只能由桌面端在每次页面加载后重新挂上
            window.evaluate_js(BACK_JS)
        window.events.loaded += on_loaded

    desktop.rearm = arm_pill
    arm_pill()
    # 关窗：存几何 → 挂「正在停止 ComfyUI」→ 带走桌面端自己拉起的 ComfyUI → 收桌面端服务 → 销毁窗口。
    # 几何必须在 UI 线程上先读（窗口销毁后读属性会抛，收尾链断在半路、进程变孤儿）。
    # 收尾不在 UI 线程做：FormClosing 里睡多久窗口就冻多久（桌面端服务正忙时 join 能吃满 5 秒），
    # 用户读成卡死。evaluate_js 也是等 UI 线程回消息循环才执行的，在 closing 里调直接死锁 ——
    # 所以第一次 closing 只放行关闭，提示与收尾在后台线程走完，最后 destroy 触发第二次 closing 放行。
    closing = {"vetoed": False, "thread": None}

    def close_out() -> None:
        try:
            desktop.comfy_close()   # 先带走内核：evaluate_js 要等 UI 线程回消息循环，卡住也不能拖住杀进程
            if desktop.comfy is not None:
                window.evaluate_js(CLOSING_JS)   # 窗口停在提示上，直到收尾走完
            mcp.close_all()   # 用户连过的外部 MCP 进程：不收就在后台读着已关的 stdin 挂着，netstat 里多一个「关不掉的 ComfyUI」
            server.stop()
        finally:
            window.destroy()   # 收尾出异常也不能把窗口留成关不掉

    def on_closing() -> None:
        if closing["vetoed"]:
            return   # 后台收尾走完后的第二次 FormClosing：放行
        closing["vetoed"] = True
        release_singleton()   # 收尾跑完之前重开不该被「窗口已在运行」拦住
        desktop.closing = True
        if not desktop.fullscreen:
            save_geometry(window)   # 全屏时窗口是整屏矩形，存下来下次开机窗口会铺满屏幕
        closing["thread"] = threading.Thread(target=close_out, daemon=True)
        closing["thread"].start()
        return False

    window.events.closing += on_closing
    window.events.closed += lambda: desktop.comfy_close()


    def spawn_ready():
        if wait_ready(desktop.base, READY_TIMEOUT):
            desktop.starting = False   # 接上前收掉「启动中」，页面直接是完整 Studio
            if desktop.direct:
                desktop.flags["comfy_base"] = desktop.base   # 页面原地翻面，不整页跳转
                log_line(f"comfy ready in-place {desktop.base}")
            else:
                log_line(f"comfy ready jump {desktop.url}")
                desktop._goto(desktop.url)
        else:
            desktop.starting = False
            log_line("comfy not ready")
            alert(f"ComfyUI {READY_TIMEOUT} 秒内未就绪，启动输出见 {COMFY_LOG}")
            desktop.comfy_close()
            window.destroy()

    def boot_sequence() -> None:
        """窗口先出之后在后台走完的启动序列：自检 → 桌面端服务 → 拉起 ComfyUI → 把窗口指过去。"""
        if remote_only:
            state, msg = remote_startup_state(desktop.remote, timeout=2.0)
            launcher.update(state=state, error=msg)
            log_line(f"startup state={state} {msg}")
            if desktop.closing:
                return
            if state == ST_REMOTE:
                desktop.starting = True
                threading.Thread(target=desktop._jump_when_ready, daemon=True).start()
                return
            desktop.starting = False
            window.load_html(guide_html(launcher))
            desktop.rearm()
            return
        state, msg = startup_state(root, python, plugin_dir)
        launcher.update(state=state, error=msg)
        log_line(f"startup state={state} {msg}")
        start_server()
        desktop.desktop_port = server.bound
        desktop.offline_url = offline_url
        # 存在性只问端口：端口上有人监听就是有一路 ComfyUI 在跑。不能拿 /neo_studio/version 这种
        # Neo 专属路由当存在性判据 —— 那路插件没加载或还在导入自定义节点时探测会失败，桌面端就在旁边
        # 8189 拉第二路，关窗只带走自己那路，用户看到「两个端口，杀掉一个还剩一个」。
        # 远程模式没有本机端口可探、也不拉本机进程：窗口直接指向远端，通不通看远端探活
        if state == ST_OK and not desktop.remote and not port_busy(port) and not desktop.closing:
            desktop.port = free_comfy_port(port, desktop.desktop_port)
            desktop.comfy = spawn_comfy(python, root, desktop.port, desktop.listen,
                                        comfy_cors(desktop.listen, desktop.remote, desktop.desktop_port))
            desktop.pid = desktop.comfy.pid
            desktop.url = desktop.studio_url()
            desktop.starting = True
            log_line(f"comfy spawn pid={desktop.pid} port={desktop.port} listen={desktop.listen or '127.0.0.1'}")
            if desktop.closing:
                # 关窗正好压在拉起这一刻：收尾线程已经收过一轮，刚起的那路立刻收掉，不留孤儿
                desktop.comfy_close()
                return
        # 已就绪直接进 ComfyUI 的完整 Studio；冷启动进桌面端服务的 Studio 页，直连那路就绪后原地接上生成
        ready = desktop.comfy is None and probe(desktop.base)
        desktop._goto(desktop.url if ready else offline_url)
        if desktop.comfy is not None:
            spawn_ready()
        elif not ready:
            # 附着的那路还在导入自定义节点：就绪后跳过去，别停在离线页干等
            desktop._jump_when_ready()

    # 任务栏图标：pythonw 没有 AppUserModelID，任务栏按钮会与其他 pythonw 窗口合并成通用 Python 图标；
    # 显式设 ID 后 start(icon=...) 才落到桌面端自己的图标（edgechromium 后端读 _state['icon']）
    icon = str(STUDIO_ICON) if STUDIO_ICON.exists() else None
    if icon and IS_WINDOWS:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)

    # 配方导出 / 模型库的 blob 下载要放行；「⤒ 主画布编辑」与顶栏「新影工坊」这类 _blank 链接
    # 留在桌面端窗口里：edgechromium 的 NewWindowRequested 走 load_url，交接与返回都不弹浏览器标签页
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = False
    # 开发模式只给能力，不自动弹 DevTools：edgechromium 在 debug 时会 OpenDevToolsWindow，改按 F12 手动开
    webview.settings["OPEN_DEVTOOLS_IN_DEBUG"] = False
    if args.cdp:
        webview.settings["REMOTE_DEBUGGING_PORT"] = args.cdp
    # 设置里勾的开发模式与 --debug 同一条路：CoreWebView2 建环境时定值，运行中改不了，勾完要重启窗口
    debug = args.debug or launcher["dev_mode"]
    ensure_clr()
    log_line(f"webview start geo={geo} page={'guide' if need_guide else 'splash'} debug={debug}")
    purge_web_cache()   # 历史缓存里的旧插件 JS 会把模块图撕开，开窗口前清掉
    on_start = None if need_guide else (lambda: threading.Thread(target=boot_sequence,
                                                                 daemon=True).start())
    webview.start(on_start, private_mode=False, storage_path=str(PROFILE_DIR), gui=GUI_BACKEND,
                  debug=debug, icon=icon)
    log_line("webview end")
    if closing["thread"] is not None:
        closing["thread"].join(10)   # 收尾线程还在跑就退进程 = 留孤儿
    desktop.comfy_close()   # 窗口循环结束就是要退进程：桌面端拉起的 ComfyUI 必须跟着走，别留孤儿
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log_line("EXC " + repr(e))
        alert(str(e))
        sys.exit(1)
