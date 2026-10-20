"""Neo Studio 桌面端（app/studio_app.py）单测：路径解析、探活、几何持久化、单实例。"""

import inspect
import json
import logging
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

_APP_DIR = pathlib.Path(__file__).resolve().parent.parent
_REPO_ROOT = _APP_DIR.parent
_PLUGIN_DIR = _REPO_ROOT / "studio"
_COMFY_ROOT = _REPO_ROOT.parent / "ComfyUI"
sys.path.insert(0, str(_APP_DIR))

import studio_app as app


class FrozenPathTests(unittest.TestCase):
    def test_source_layout(self):
        # 源码运行：插件源码在仓库的 studio/，应用状态在仓库的 data/
        self.assertEqual(app.APP_DIR, _APP_DIR)
        self.assertEqual(app.REPO_ROOT, _REPO_ROOT)
        self.assertEqual(app.PLUGIN_SOURCE_DIR, _PLUGIN_DIR)
        self.assertEqual(app.state_dir(), _REPO_ROOT / "data")

    def test_studio_icon_is_a_bundled_resource(self):
        self.assertEqual(app.STUDIO_ICON, _PLUGIN_DIR / "web" / "neo-studio.ico")

    def test_state_dir_prefers_exe_side_data(self):
        # exe 可以放在任意可写目录：状态目录就在它旁边的 data/
        with tempfile.TemporaryDirectory() as tmp:
            exe_dir = pathlib.Path(tmp) / "新影工坊"
            exe_dir.mkdir()
            self.assertEqual(app.pick_state_dir(exe_dir, str(pathlib.Path(tmp) / "appdata")),
                             exe_dir / "data")

    def test_state_dir_falls_back_to_appdata(self):
        # exe 旁的 data/ 写不出来（那里是个文件）：退到 %APPDATA%\Neo Studio
        with tempfile.TemporaryDirectory() as tmp:
            exe_dir = pathlib.Path(tmp) / "exe"
            exe_dir.mkdir()
            (exe_dir / "data").write_text("x", encoding="utf-8")
            appdata = pathlib.Path(tmp) / "appdata"
            self.assertEqual(app.pick_state_dir(exe_dir, str(appdata)), appdata / app.APP_NAME)
            self.assertTrue((appdata / app.APP_NAME).is_dir())


class ResolveTests(unittest.TestCase):
    def test_root_default_is_comfyui(self):
        # 目标布局：Neo-Studio 与 ComfyUI 内核并排放在同一个工作区里
        self.assertEqual(app.resolve_root(""), _COMFY_ROOT)
        self.assertTrue(app.root_ok(_COMFY_ROOT))

    def test_root_explicit(self):
        self.assertEqual(app.resolve_root("D:/ComfyUI"), pathlib.Path("D:/ComfyUI"))

    def test_python_prefers_sibling_dir(self):
        # 整合包布局：python 与 ComfyUI 同级，优先于 ComfyUI 内部
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "ComfyUI"
            root.mkdir()
            (pathlib.Path(tmp) / "python").mkdir()
            (root / "python").mkdir()
            sibling = root.parent / "python" / "python.exe"
            sibling.write_text("")
            (root / "python" / "python.exe").write_text("")
            self.assertEqual(app.resolve_python(root, ""), sibling)

    def test_python_fallback_inner(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "ComfyUI"
            (root / "python").mkdir(parents=True)
            inner = root / "python" / "python.exe"
            inner.write_text("")
            self.assertEqual(app.resolve_python(root, ""), inner)

    def test_python_explicit_wins(self):
        self.assertEqual(app.resolve_python(pathlib.Path("D:/ComfyUI"), "D:/x/python.exe"),
                         pathlib.Path("D:/x/python.exe"))

    def test_python_missing_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                app.resolve_python(pathlib.Path(tmp) / "ComfyUI", "")

    def test_find_python_returns_none_when_missing(self):
        """找不到解释器不是异常：引导页负责让用户选一个，桌面端不能因此退出进程。"""
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(app.find_python(pathlib.Path(tmp) / "ComfyUI", ""))


class _Resp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ProbeTests(unittest.TestCase):
    def test_probe_ready(self):
        with patch.object(app.urllib.request, "urlopen", lambda url, timeout=3.0: _Resp()):
            self.assertTrue(app.probe("http://127.0.0.1:8188"))

    def test_probe_down(self):
        def _boom(url, timeout=3.0):
            raise ConnectionRefusedError()

        with patch.object(app.urllib.request, "urlopen", _boom):
            self.assertFalse(app.probe("http://127.0.0.1:8188"))

    def test_probe_hits_the_target_base(self):
        # 探活打的是目标 base 上的 /neo_studio/version：远程模式因此天然探的是远端
        seen = []
        with patch.object(app.urllib.request, "urlopen",
                          lambda url, timeout=3.0: seen.append(url) or _Resp()):
            self.assertTrue(app.probe("http://192.168.0.20:8188"))
        self.assertEqual(seen, ["http://192.168.0.20:8188/neo_studio/version"])

    def test_wait_ready_polls_until_ready(self):
        seq = [False, False, True]

        def _probe(base, timeout=3.0):
            return seq.pop(0) if seq else False

        with patch.object(app, "probe", _probe), patch.object(app, "POLL_INTERVAL", 0):
            self.assertTrue(app.wait_ready("http://127.0.0.1:8188", 5))

    def test_attach_wait_gives_up_when_the_port_dies(self):
        # 关完立刻重开：附着到正在死的那路，连续两轮没人监听就是死了，不该对着空端口等满超时
        seen = []

        def _busy():
            seen.append(1)
            return len(seen) == 1

        with patch.object(app, "probe", lambda base, timeout=3.0: False), \
             patch.object(app, "POLL_INTERVAL", 0):
            self.assertFalse(app.wait_attach("http://127.0.0.1:8188", 90, _busy))
        self.assertEqual(len(seen), 3, "有人监听一轮 + 没人监听两轮就收手")

    def test_attach_wait_keeps_polling_a_live_port(self):
        # 附着的那路还在导入自定义节点：端口有人监听，就该继续等而不是提前收手
        polls = []

        def _probe(base, timeout=3.0):
            polls.append(base)
            return False

        with patch.object(app, "probe", _probe), patch.object(app, "POLL_INTERVAL", 0):
            self.assertFalse(app.wait_attach("http://127.0.0.1:8188", 0.2, lambda: True))
        self.assertGreater(len(polls), 3, "端口有人监听就不许提前收手")

    def test_start_comfy_argv(self):
        with patch.object(app.subprocess, "Popen") as popen, patch.object(app, "assign_comfy_job"):
            app.start_comfy(pathlib.Path("D:/python/python.exe"), pathlib.Path("D:/ComfyUI"), 8188)
        self.assertEqual(popen.call_args[0][0],
                         [str(pathlib.Path("D:/python/python.exe")), str(pathlib.Path("D:/ComfyUI") / "main.py"),
                          "--port", "8188"])
        # 桌面端用 pythonw 启动时没有控制台，子进程必须压制新建的控制台窗口
        self.assertEqual(popen.call_args.kwargs["creationflags"], app.NO_WINDOW)
        # CREATE_NO_WINDOW 下不重定向就等于把启动报错丢进黑洞：必须落到 data/comfy_run.log
        self.assertIs(popen.call_args.kwargs["stderr"], app.subprocess.STDOUT)
        self.assertIn("comfy_run.log", popen.call_args.kwargs["stdout"].name)
        popen.call_args.kwargs["stdout"].close()

    def test_start_comfy_argv_with_listen(self):
        # 局域网监听就是 ComfyUI 的 --listen，空值不传（ComfyUI 默认只监听 127.0.0.1）
        with patch.object(app.subprocess, "Popen") as popen, patch.object(app, "assign_comfy_job"):
            app.start_comfy(pathlib.Path("D:/python/python.exe"), pathlib.Path("D:/ComfyUI"), 8188,
                            "127.0.0.1,192.168.0.7")
        self.assertEqual(popen.call_args[0][0],
                         [str(pathlib.Path("D:/python/python.exe")), str(pathlib.Path("D:/ComfyUI") / "main.py"),
                          "--port", "8188", "--listen", "127.0.0.1,192.168.0.7"])
        popen.call_args.kwargs["stdout"].close()

    def test_start_comfy_argv_with_cors(self):
        # 页面钉在桌面端口上直连 8188：不给 --enable-cors-header，ComfyUI 的 origin_only 直接 403
        with patch.object(app.subprocess, "Popen") as popen, patch.object(app, "assign_comfy_job"):
            app.start_comfy(pathlib.Path("D:/python/python.exe"), pathlib.Path("D:/ComfyUI"), 8188,
                            cors="http://127.0.0.1:8191")
        self.assertEqual(popen.call_args[0][0],
                         [str(pathlib.Path("D:/python/python.exe")), str(pathlib.Path("D:/ComfyUI") / "main.py"),
                          "--port", "8188", "--enable-cors-header", "http://127.0.0.1:8191"])
        popen.call_args.kwargs["stdout"].close()


class ComfyCorsTests(unittest.TestCase):
    def test_loopback_desktop_page_gets_the_origin(self):
        self.assertEqual(app.comfy_cors("", "", 8191), "http://127.0.0.1:8191")

    def test_lan_listen_remote_and_missing_service_get_nothing(self):
        # 暴露到网卡的实例与远端机器上的实例不在 origin_only 上让位；桌面服务没起来时直连也没有目标
        self.assertEqual(app.comfy_cors("127.0.0.1,192.168.0.7", "", 8191), "")
        self.assertEqual(app.comfy_cors("", "http://192.168.0.9:8188", 8191), "")
        self.assertEqual(app.comfy_cors("", "", 0), "")


class FreeComfyPortTests(unittest.TestCase):
    def test_requested_port_when_free(self):
        with patch.object(app, "port_busy", lambda port: False):
            self.assertEqual(app.free_comfy_port(8188, 8191), 8188)

    def test_skips_busy_ports_and_the_desktop_service(self):
        # 8188 被残留进程占着、8189 是别人的服务、8191 是桌面端素材服务：只能用 8190
        busy = {8188, 8189, 8191}
        with patch.object(app, "port_busy", lambda port: port in busy):
            self.assertEqual(app.free_comfy_port(8188, 8191), 8190)

    def test_falls_back_to_requested_when_nothing_free(self):
        with patch.object(app, "port_busy", lambda port: True):
            self.assertEqual(app.free_comfy_port(8188, 8191), 8188)


class PortOwnerTests(unittest.TestCase):
    NETSTAT = ("  Proto  Local Address          Foreign Address        State           PID\n"
               "  TCP    127.0.0.1:8188         0.0.0.0:0              LISTENING       12345\n"
               "  TCP    [::1]:8188             [::]:0                 LISTENING       12345\n"
               "  TCP    127.0.0.1:8189         127.0.0.1:52000        ESTABLISHED   999\n")

    def test_port_owner_from_netstat(self):
        with patch.object(app.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=self.NETSTAT)):
            self.assertEqual(app.port_owner(8188), 12345)

    def test_port_owner_missing_is_zero(self):
        with patch.object(app.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=self.NETSTAT)):
            self.assertEqual(app.port_owner(8187), 0)

    def test_kill_pid_uses_kernel32(self):
        # 必须用 PROCESS_TERMINATE(0x0001)：0x1000 拿到的句柄没有终止权，TerminateProcess 会失败
        calls = []
        kernel32 = SimpleNamespace(OpenProcess=lambda *a: calls.append(("open", a)) or 7,
                                   TerminateProcess=lambda h, c: calls.append(("term", h)) or 1,
                                   CloseHandle=lambda h: calls.append(("close", h)))
        with patch.object(app, "k32", kernel32):
            self.assertTrue(app.kill_pid(4321))
        self.assertEqual(calls, [("open", (0x0001, False, 4321)), ("term", 7), ("close", 7)])

    def test_kill_pid_without_handle_reports_failure(self):
        # 没有权限时 OpenProcess 返回 0，必须报失败让桌面端日志说清原因
        kernel32 = SimpleNamespace(OpenProcess=lambda *a: 0)
        with patch.object(app, "k32", kernel32):
            self.assertFalse(app.kill_pid(4321))

    def test_pid_alive_checks_openprocess(self):
        calls = []
        kernel32 = SimpleNamespace(OpenProcess=lambda *a: calls.append(a) or 7,
                                   CloseHandle=lambda h: calls.append(("close", h)))
        with patch.object(app, "k32", kernel32):
            self.assertTrue(app.pid_alive(4321))
        self.assertEqual(calls, [(0x1000, False, 4321), ("close", 7)])
        dead = SimpleNamespace(OpenProcess=lambda *a: 0)
        with patch.object(app, "k32", dead):
            self.assertFalse(app.pid_alive(4321))


class ComfyJobTests(unittest.TestCase):
    def test_start_comfy_assigns_the_kill_job(self):
        # 桌面端拉起的那路一出生就挂进作业：收尾链被 Ctrl+C / 任务管理器 / 注销掐断时，
        # 内核照样在桌面端进程退出时带走它，端口上留不下孤儿
        with patch.object(app.subprocess, "Popen") as popen, patch.object(app, "assign_comfy_job") as job:
            app.start_comfy(pathlib.Path("D:/python/python.exe"), pathlib.Path("D:/ComfyUI"), 8188)
            popen.call_args.kwargs["stdout"].close()
        self.assertIs(job.call_args[0][0], popen.return_value)

    def test_job_close_kills_the_child(self):
        # 真实进程 + 真实作业：关句柄就是桌面端进程退出时 OS 收句柄的那一步，子进程必须跟着没
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                                creationflags=app.NO_WINDOW)
        try:
            self.assertTrue(app.assign_comfy_job(proc))
            app.k32.CloseHandle(app.COMFY_JOB)
            app.COMFY_JOB = None
            started = time.monotonic()
            proc.wait(timeout=20)   # 子进程自己要睡 120 秒，能回来就是 OS 动的手
            self.assertLess(time.monotonic() - started, 60, "作业句柄一关，子进程必须被 OS 终止")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._file = app.GEOMETRY_FILE
        app.GEOMETRY_FILE = pathlib.Path(self._tmp.name) / "configs" / "studio_window.json"

    def tearDown(self):
        app.GEOMETRY_FILE = self._file
        self._tmp.cleanup()

    def test_missing_file_defaults(self):
        self.assertEqual(app.load_geometry(), {})

    def test_round_trip(self):
        window = SimpleNamespace(width=1440, height=900, x=100, y=60)
        app.save_geometry(window)
        self.assertEqual(app.load_geometry(), {"width": 1440, "height": 900, "x": 100, "y": 60})

    def test_bad_json_is_ignored(self):
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text("not json", encoding="utf-8")
        self.assertEqual(app.load_geometry(), {})

    def test_partial_geometry_keeps_valid_keys(self):
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text(json.dumps({"width": 1200, "x": "bad"}), encoding="utf-8")
        self.assertEqual(app.load_geometry(), {"width": 1200})

    def test_offscreen_position_is_dropped_on_load(self):
        # 最小化时保存的 -32000 系坐标：下次启动窗口在屏幕外看不见，位置丢弃回退默认
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text(json.dumps({"width": 900, "height": 600, "x": -21332, "y": -21332}),
                                     encoding="utf-8")
        self.assertEqual(app.load_geometry(), {"width": 900, "height": 600})

    def test_minimized_geometry_is_not_saved(self):
        # 最小化关闭：位置 -32000 系、尺寸是最小化态假值，整份几何跳过，保留上次的好值
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text(json.dumps({"width": 1440, "height": 900, "x": 100, "y": 60}),
                                     encoding="utf-8")
        window = SimpleNamespace(width=158, height=26, x=-21332, y=-21332)
        app.save_geometry(window)
        self.assertEqual(app.load_geometry(), {"width": 1440, "height": 900, "x": 100, "y": 60})


    def test_destroyed_window_is_skipped(self):
        # 窗口销毁后读属性会抛：几何直接跳过，绝不能把关窗后面的收尾截断
        app.GEOMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        app.GEOMETRY_FILE.write_text(json.dumps({"width": 1440, "height": 900, "x": 100, "y": 60}),
                                     encoding="utf-8")
        app.save_geometry(_DeadWindow())
        self.assertEqual(app.load_geometry(), {"width": 1440, "height": 900, "x": 100, "y": 60})


class FolderPickerTests(unittest.TestCase):
    def test_picker_delegates_to_pywebview_folder_dialog(self):
        """SHBrowseForFolder 在新样式下把「文件夹」编辑框换成提示文字，flags 怎么叠都控不住；
        自己 CoCreateInstance 建 FileOpenDialog 在这台机器上是 REGDB_E_CLASSNOTREG（经典 CLSID 没注册，
        注册着的 4dde 变体只认 IUnknown）。选择器必须交给 pywebview 的 FOLDER 对话框 ——
        WinForms 的 CreateVistaDialog 才拿得到现代对话框。"""
        calls = []

        def fake(dialog_type, directory=None, **kw):
            calls.append({"dialog_type": dialog_type, "directory": directory})
            return ("D:\\ComfyUI",)

        with patch.object(app, "_studio_window", SimpleNamespace(create_file_dialog=fake)):
            self.assertEqual(app.pick_folder("D:\\x"), "D:\\ComfyUI")
        self.assertEqual(calls[0]["dialog_type"], app.FileDialog.FOLDER)
        self.assertEqual(calls[0]["directory"], "D:\\x")

    def test_picker_cancels_to_empty(self):
        """取消（pywebview 回 None）必须回空串：调用方靠空串判定「没选」。"""
        with patch.object(app, "_studio_window",
                          SimpleNamespace(create_file_dialog=lambda *a, **k: None)):
            self.assertEqual(app.pick_folder(""), "")

    def test_raw_com_picker_is_gone(self):
        """ctypes 手搓 COM 的那套（GUID / vtable 槽位 / _com）整块删掉，不能留半截死代码。"""
        for name in ("_GUID", "_CLSID_FILEOPEN", "_IID_FILEOPEN", "_IID_SHELLITEM",
                     "_com", "_FOS", "_SHOW", "_GET_RESULT", "_SET_FOLDER"):
            self.assertFalse(hasattr(app, name), name)
        # 窗口起来之前弹选择器那路随引导页一起删了：选择只在引导页发生，宿主永远在
        self.assertNotIn("OpenFolderDialog", inspect.getsource(app.pick_folder))

    def test_pick_python_delegates_to_pywebview_open_dialog(self):
        calls = []

        def fake(dialog_type, directory=None, file_types=None, **kw):
            calls.append({"dialog_type": dialog_type, "directory": directory, "file_types": file_types})
            return ("D:\\python\\python.exe",)

        with patch.object(app, "_studio_window", SimpleNamespace(create_file_dialog=fake)):
            self.assertEqual(app.pick_python_file("D:\\python"), "D:\\python\\python.exe")
        self.assertEqual(calls[0]["dialog_type"], app.FileDialog.OPEN)
        self.assertEqual(calls[0]["directory"], "D:\\python")
        self.assertEqual(calls[0]["file_types"], app.PY_FILE_TYPES)

    def test_pick_folder_starts_at_given_path(self):
        """打开时定位到传进来的目录，别每次从桌面根开始翻。"""
        sig = inspect.signature(app.pick_folder)
        self.assertIn("start", sig.parameters)
        self.assertEqual(sig.parameters["start"].default, "")


class GuidePageTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(app, "log_line", lambda text: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_guide_page_needs_no_desktop_service(self):
        """根目录无效时 build_app 连 folder_paths 都 import 不了，服务本来就起不来：
        引导页只能走 load_html + js_api，两个路径框、校验与开始全在桌面端里。"""
        html = app.guide_html({"root": "D:/ComfyUI", "python": "D:/python/python.exe"})
        self.assertIn("id=root", html)
        self.assertIn("id=py", html)
        for fn in ("check_setup", "pick_root", "pick_python", "start_setup"):
            self.assertIn("api()." + fn, html)
        self.assertIn("D:/ComfyUI", html)
        self.assertIn("D:/python/python.exe", html)

    def test_check_setup_needs_main_py_and_a_real_file(self):
        desktop = app.StudioDesktop("", None, 8188, pathlib.Path("root"))
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp) / "ComfyUI"
            root.mkdir()
            py = pathlib.Path(tmp) / "python.exe"
            py.write_text("")
            self.assertFalse(desktop.check_setup(str(root), str(py))["root_ok"])
            (root / "main.py").write_text("")
            res = desktop.check_setup(str(root), str(py))
            self.assertTrue(res["root_ok"])
            self.assertTrue(res["python_ok"])
            self.assertFalse(desktop.check_setup("", "")["root_ok"])
            self.assertFalse(desktop.check_setup(str(root), str(root / "nope.exe"))["python_ok"])

    def test_start_setup_refuses_without_the_desktop_service(self):
        """根目录补完了服务才装配得起来：服务起不来就不谈拉起，原因回给引导页显示。"""
        desktop = app.StudioDesktop("", None, 8188, pathlib.Path("root"))
        desktop.ensure_server = lambda: False
        apply = MagicMock()
        with patch.object(desktop, "apply_launcher", apply):
            res = desktop.start_setup("D:/ComfyUI", "D:/python/python.exe")
        self.assertFalse(res["ok"])
        self.assertIn("桌面端服务", res["error"])
        apply.assert_not_called()
        self.assertEqual(desktop.launcher["root"], "D:/ComfyUI")

    def test_start_setup_applies_once_the_service_is_up(self):
        desktop = app.StudioDesktop("", None, 8188, pathlib.Path("root"))
        desktop.ensure_server = lambda: True
        calls = []
        with patch.object(desktop, "apply_launcher",
                          lambda root, python, port: calls.append((root, python, port)) or {"ok": True}):
            self.assertEqual(desktop.start_setup("D:/ComfyUI", "D:/python/python.exe"), {"ok": True})
        self.assertEqual(calls, [("D:/ComfyUI", "D:/python/python.exe", 8188)])


class SplashPageTests(unittest.TestCase):
    def test_splash_page_animates_and_reports_the_real_stage(self):
        """冷启动要扫模型目录、装依赖、起桌面端服务：启动页不能是一行静止文字，
        阶段行还得报真实进度 —— 写死一句「请稍候」在慢的那路上就是假承诺。"""
        html = app.splash_html()
        self.assertIn("@keyframes ns-rise", html)
        self.assertIn("@keyframes ns-wave", html)
        self.assertIn('mask="url(#ns-splash-mask)"', html)
        self.assertIn("prefers-reduced-motion", html)   # 系统开了减少动画时浪线要停住
        self.assertIn("api.comfy_state()", html)
        self.assertIn("已拉起 ComfyUI", html)
        self.assertIn("ComfyUI 就绪", html)


class AlertTests(unittest.TestCase):
    def test_alert_uses_message_box(self):
        calls = []
        user32 = SimpleNamespace(MessageBoxW=lambda *a: calls.append(a))
        with patch.object(app.ctypes, "windll", SimpleNamespace(user32=user32)):
            app.alert("未找到 python")
        self.assertEqual(calls[0][1], "未找到 python")
        self.assertEqual(calls[0][2], "Neo Studio")

    def test_missing_pywebview_alerts_and_exits(self):
        with patch.object(app, "webview", None), patch.object(app, "alert") as alert, \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 1)
            self.assertIn("pywebview", alert.call_args[0][0])


class DesktopLogTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._log = app.DESKTOP_LOG
        app.DESKTOP_LOG = pathlib.Path(self._tmp.name) / "studio_desktop.log"

    def tearDown(self):
        app.DESKTOP_LOG = self._log
        self._tmp.cleanup()

    def test_log_line_appends(self):
        app.log_line("start port=8188")
        app.log_line("webview start")
        text = app.DESKTOP_LOG.read_text(encoding="utf-8")
        self.assertIn("start port=8188", text)
        self.assertIn("webview start", text)
        self.assertEqual(text.count("\n"), 1)

    def test_log_line_keeps_only_the_tail(self):
        # 日志只增不减：反复开关机会把文件拖大，超上限时从整行开头截尾
        with patch.object(app, "LOG_MAX", 200):
            for i in range(20):
                app.log_line(f"line-{i:02d} " + "x" * 20)
        text = app.DESKTOP_LOG.read_text(encoding="utf-8")
        self.assertLess(len(text), 300, "超上限要裁到尾部，不能无限增长")
        self.assertIn("line-19", text)
        self.assertNotIn("line-00", text)

    def test_log_line_survives_concurrent_writers(self):
        # pywebview 把每个 js_api 调用丢进自己的线程：并发写（前端错误 + 跳转）不能丢行
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(app.log_line, [f"line-{i:02d}" for i in range(40)]))
        text = app.DESKTOP_LOG.read_text(encoding="utf-8")
        missing = [f"line-{i:02d}" for i in range(40) if f"line-{i:02d}" not in text]
        self.assertEqual(missing, [], "并发写日志丢了行")

    def test_pywebview_logger_writes_to_desktop_log(self):
        # pythonw 的 sys.stderr 是 None，pywebview 的控制台 handler 会在写日志时抛异常打断窗口创建；
        # 导入桌面端时先把 pywebview 日志接到桌面端日志文件，_setup_logger 就不会再挂控制台 handler
        handlers = logging.getLogger("pywebview").handlers
        self.assertTrue(any(isinstance(h, logging.FileHandler) for h in handlers))


class WebCacheTests(unittest.TestCase):
    """WebView2 的 HTTP 缓存跨会话留着：缓存里的旧插件 JS 会被直接端出来用（不发请求），
    与新拉到的模块拼进同一张 ES 模块图，一个链接错误就让整页只剩顶栏。开窗口前必须清掉。"""

    def test_purge_removes_cached_extension_scripts(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = pathlib.Path(tmp) / "EBWebView" / "Default" / "Cache" / "Cache_Data"
            data.mkdir(parents=True)
            (data / "f_001ed1").write_text("old gallery-utils.js", encoding="utf-8")
            with patch.object(app, "WEBVIEW_CACHE", data.parent):
                app.purge_web_cache()
            self.assertFalse((data.parent).exists(), "历史缓存要整份清掉")

    def test_purge_tolerates_missing_cache(self):
        # 首次启动没有缓存目录：清缓存不能抛，也不能碰 profile 里的 localStorage
        with tempfile.TemporaryDirectory() as tmp:
            profile = pathlib.Path(tmp) / "studio_profile"
            (profile / "EBWebView" / "Default" / "Local Storage").mkdir(parents=True)
            with patch.object(app, "WEBVIEW_CACHE", profile / "EBWebView" / "Default" / "Cache"):
                app.purge_web_cache()
            self.assertTrue((profile / "EBWebView" / "Default" / "Local Storage").exists())


class SingletonTests(unittest.TestCase):
    """单实例锁是命名互斥体：句柄活着 = 锁被占，CloseHandle = 释放。测试用假 kernel32。"""
    class _K32:
        def __init__(self):
            self.names = {}
            self.last = 0

        def CreateMutexW(self, sec, owner, name):
            if name in self.names:
                self.last = app.ERROR_ALREADY_EXISTS
                return 7
            h = len(self.names) + 100
            self.names[name] = h
            self.last = 0
            return h

        def CloseHandle(self, h):
            self.names = {n: v for n, v in self.names.items() if v != h}
            return True

        def GetLastError(self):
            return self.last

    def setUp(self):
        self.k32 = self._K32()
        patcher = patch.object(app, "k32", self.k32)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_second_instance_exits(self):
        first = app.singleton()
        self.assertIsNotNone(first)
        self.assertIsNone(app.singleton())
        app.k32.CloseHandle(first)

    def test_lock_released_after_close(self):
        first = app.singleton()
        app.k32.CloseHandle(first)
        second = app.singleton()
        self.assertIsNotNone(second)
        app.k32.CloseHandle(second)

    def test_release_frees_the_mutex_for_a_relaunch(self):
        # 锁平时只由系统在进程退出时释放：关窗收尾那一两秒里重开就被「窗口已在运行」拦住
        first = app.singleton()
        app.SINGLETON_HANDLE = first
        self.addCleanup(setattr, app, "SINGLETON_HANDLE", None)
        app.release_singleton()
        self.assertIsNone(app.SINGLETON_HANDLE)
        second = app.singleton()
        self.assertIsNotNone(second, "交还之后重开必须拿得到锁")
        app.k32.CloseHandle(second)

    def test_singleton_takes_no_port(self):
        # 单实例锁不许再占 8189：那个监听在 netstat 里像第二路 ComfyUI，用户会读成「起了两个端口」
        src = inspect.getsource(app.singleton)
        self.assertNotIn("bind", src)
        self.assertIn("CreateMutexW", src)


class _Event:
    """pywebview 的 events.closing 支持 `+= callable`；mock 里用同样的 += 语义。"""
    def __init__(self):
        self.handlers = []

    def __iadd__(self, fn):
        self.handlers.append(fn)
        return self


def _fake_window():
    # 带几何值：关窗处理器里的 save_geometry 要读 width/height/x/y；loaded 处理器要记当前页面
    # 方法表照真实 pywebview 6 的 Window 抄：销毁是 destroy()，没有 close()；
    # native 是 WinForms 控件，Invoke 把委托丢回窗口所属线程执行（拖动、样式位都靠它）
    return SimpleNamespace(events=SimpleNamespace(closing=_Event(), closed=_Event(), loaded=_Event(),
                                                  shown=_Event()),
                           evaluate_js=MagicMock(), load_url=MagicMock(), destroy=MagicMock(),
                           get_current_url=lambda: "http://127.0.0.1:8188/neo-studio",
                           width=1200, height=800, x=100, y=100,
                           native=SimpleNamespace(Handle=SimpleNamespace(ToInt64=lambda: 1234),
                                                  Invoke=lambda fn: fn()),
                           minimize=MagicMock(), maximize=MagicMock(), restore=MagicMock(),
                           toggle_fullscreen=MagicMock())


class _DeadWindow:
    """窗口已销毁：读几何属性直接抛。用户现场就是它把关窗收尾整截断的。"""

    def __init__(self):
        self.events = SimpleNamespace(closing=_Event(), closed=_Event(), loaded=_Event(), shown=_Event())
        self.evaluate_js = MagicMock()
        self.load_url = MagicMock()
        self.destroy = MagicMock()
        self.get_current_url = lambda: "http://127.0.0.1:8188/neo-studio"
        self.native = SimpleNamespace(Handle=SimpleNamespace(ToInt64=lambda: 0))   # 已销毁：句柄为 0

    @property
    def width(self):
        raise RuntimeError("窗口已销毁")


def _fake_webview(create_window, start=None):
    return SimpleNamespace(create_window=create_window, settings={},
                           start=start or (lambda *a, **k: None))


def _fake_desktop_server(port=8191):
    """桌面端只读服务的替身：main() 里只关心绑定端口与收尾，不起真服务。
    bound 起先为 0，start() 之后才落定 —— 与真 DesktopServer 一致，桌面端靠它判定服务是否已在。"""
    def make(factory, port_arg):
        srv = SimpleNamespace(bound=0, error=None, stop=lambda: None)
        srv.start = lambda: setattr(srv, "bound", port) or port
        return srv

    return make


class _SyncThread(threading.Thread):
    """后台线程在测试里同步跑完：启动序列的落点（跳哪一页、带走哪个进程）要能被断言，
    不能赌调度 —— 窗口先出后自检与拉起都在后台线程，异步跑就变成随机通过。"""

    def start(self):
        self.run()

    def join(self, timeout=None):
        return None



class StudioDesktopTests(unittest.TestCase):
    def setUp(self):
        # 假 pid 的关窗记录不能写进真实桌面端日志 data/studio_desktop.log
        patcher = patch.object(app, "log_line", lambda text: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_copy_keys_open_the_webview_accelerators(self):
        """Ctrl+C / Ctrl+V / Ctrl+A 要在生产窗口里活着：pywebview 把加速器键绑在 debug 上，
        非 dev 窗口建核后补开，划词复制才有原生出口（页面跑在非安全上下文，navigator.clipboard 不存在）"""
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        settings = SimpleNamespace(AreBrowserAcceleratorKeysEnabled=False, AreDevToolsEnabled=False)
        desktop._window = SimpleNamespace(browser=SimpleNamespace(
            webview=SimpleNamespace(CoreWebView2=SimpleNamespace(Settings=settings))))
        desktop.enable_copy_keys()
        self.assertTrue(settings.AreBrowserAcceleratorKeysEnabled, "复制按键要放行")
        self.assertFalse(settings.AreDevToolsEnabled, "开发者工具不跟着一起开")

    def test_copy_keys_degrades_when_the_webview_controls_are_gone(self):
        """pywebview 内部结构换了形状：显示处理器不能抛在事件里，留一行日志，复制只剩页内图标钮一条路"""
        logs = []
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        desktop._window = SimpleNamespace(browser=SimpleNamespace())
        with patch.object(app, "log_line", lambda text: logs.append(text)):
            desktop.enable_copy_keys()
        self.assertEqual(len(logs), 1, f"要留一条说明退化的日志：{logs}")
        self.assertIn("accelerator keys skipped", logs[0])

    def test_copy_keys_before_the_window_exists_do_nothing(self):
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        desktop._window = None
        desktop.enable_copy_keys()

    def test_go_studio_loads_studio_url(self):
        loader = MagicMock()
        rearm = MagicMock()
        logs = []
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", None, 8188, pathlib.Path("root"))
        desktop.loader = loader
        desktop.rearm = rearm
        with patch.object(app, "log_line", lambda text: logs.append(text)):
            desktop.go_studio()
        loader.assert_called_once_with("http://127.0.0.1:8188/neo-studio")
        rearm.assert_called_once_with()
        self.assertEqual(logs, ["goto http://127.0.0.1:8188/neo-studio"], "每次整页跳转记一行")

    def test_web_log_is_flattened_for_grep(self):
        # 页面把未捕获错误折成一行报给桌面端：栈是多行的，落盘要一行一条才好 grep
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        logs = []
        with patch.object(app, "log_line", lambda text: logs.append(text)):
            desktop.log("STARTUP FAILED TypeError: x\n    at route (studio-app.js:1)\n    at y")
        self.assertEqual(logs, ["[web] STARTUP FAILED TypeError: x at route (studio-app.js:1) at y"])

    def test_back_js_skips_studio_page(self):
        # Studio 页自己就是主页，返回胶囊只给主画布和启动页用；无边框时启动页/引导页由它挂拖动
        self.assertIn("neo-studio-back", app.BACK_JS)
        self.assertIn("go_studio", app.BACK_JS)
        self.assertIn("/neo-studio", app.BACK_JS)
        self.assertIn("win_start_drag", app.BACK_JS)

    def test_back_js_follows_the_studio_language(self):
        # 主画布的语言存在 localStorage（与 js/core/i18n.js 同一份）：整页刷新后重挂的胶囊要按语言出文案
        self.assertIn("neo_studio_lang", app.BACK_JS)
        self.assertIn("Back to Studio", app.BACK_JS)
        # 左上角是工作流页签，56px 那排是 ComfyUI 自己的菜单栏：胶囊挂视口右上角才不挡菜单
        self.assertIn("top:8px;right:8px", app.BACK_JS)
        self.assertNotIn("top:56px;left:8px", app.BACK_JS)

    def test_window_state_gates_the_custom_titlebar(self):
        # 无边框才出顶栏控件；最大化 / 全屏状态由桌面端自己记 —— pywebview 的 Window 属性是建窗初值
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"frameless": False})
        desktop._window = _fake_window()
        self.assertEqual(desktop.window_state(), {"frameless": False, "maximized": False, "fullscreen": False})
        desktop.frameless = True
        desktop.maximized = True
        desktop.fullscreen = True
        self.assertEqual(desktop.window_state(), {"frameless": True, "maximized": True, "fullscreen": True})

    def test_win_maximize_fills_the_work_area_when_frameless(self):
        # 无边框下系统 maximize 给的是整屏矩形，任务栏会被盖住：铺工作区，再点一下还原回原矩形
        window = _fake_window()
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"frameless": True})
        desktop._window = window
        pos = []
        u32 = SimpleNamespace(SetWindowPos=lambda h, a, x, y, w, ht, f: pos.append((x, y, w, ht)))
        with patch.object(app, "u32", u32), \
             patch.object(app, "work_area", lambda: (0, 0, 1920, 1040)), \
             patch.object(app, "window_rect", lambda hwnd: (100, 100, 700, 500)):
            self.assertTrue(desktop.win_maximize()["maximized"])
            self.assertFalse(desktop.win_maximize()["maximized"])
        self.assertEqual(pos, [(0, 0, 1920, 1040), (100, 100, 600, 400)])
        window.maximize.assert_not_called()
        window.restore.assert_not_called()

    def test_win_maximize_uses_the_window_when_framed(self):
        window = _fake_window()
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"frameless": False})
        desktop._window = window
        self.assertTrue(desktop.win_maximize()["maximized"])
        self.assertFalse(desktop.win_maximize()["maximized"])
        window.maximize.assert_called_once()
        window.restore.assert_called_once()

    def test_ensure_resizable_frame_only_touches_borderless(self):
        # pywebview 的 frameless 把可拖拽边框一起摘掉：窗口显示后补回 WS_THICKFRAME，有框那一路不动
        window = _fake_window()
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"frameless": True})
        desktop._window = window
        frames = []
        with patch.object(app, "set_window_frame", lambda hwnd, on: frames.append(on)):
            desktop.ensure_resizable_frame()
            desktop.frameless = False
            desktop.ensure_resizable_frame()
        self.assertEqual(frames, [True])

    def test_set_window_frame_pins_the_dwm_border_color(self):
        # 补回的 WS_THICKFRAME 那一圈由 DWM 按系统主题色画：浅色主题下拖边框缩放时那条线就是白的
        styles, attrs = [], []
        u32 = SimpleNamespace(GetWindowLongW=lambda h, i: 0x00C40000,
                              SetWindowLongW=lambda h, i, v: styles.append(v),
                              SetWindowPos=lambda *a: None)
        dwm = SimpleNamespace(DwmSetWindowAttribute=lambda h, a, p, n: attrs.append(a))
        with patch.object(app, "u32", u32), patch.object(app, "dwm", dwm):
            app.set_window_frame(1, True)
        self.assertFalse(styles[0] & app.WS_CAPTION, "无边框摘掉标题栏")
        self.assertTrue(styles[0] & app.WS_THICKFRAME, "可拖拽缩放边框要补回来")
        self.assertEqual(attrs, [app.DWMWA_BORDER_COLOR, app.DWMWA_CAPTION_COLOR],
                         "重贴样式位时把 DWM 边框与标题栏颜色一起钉成页面底色")
        self.assertEqual(app._colorref(app.WINDOW_BG), 0x001B1717,
                         "COLORREF 是 0x00bbggrr，照网页那串顺序传进去颜色是反的")

    def test_win_fullscreen_reapplies_the_frame(self):
        # pywebview 退出全屏把 FormBorderStyle 写回建窗时的值，标题栏跟着回来：按桌面端自己那份状态重贴
        window = _fake_window()
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"frameless": True})
        desktop._window = window
        frames = []
        with patch.object(app, "set_window_frame", lambda hwnd, on: frames.append(on)):
            self.assertTrue(desktop.win_fullscreen()["fullscreen"])
            self.assertFalse(desktop.win_fullscreen()["fullscreen"])
        self.assertEqual(frames, [True, True])
        self.assertEqual(window.toggle_fullscreen.call_count, 2)

    def test_win_start_drag_follows_the_cursor_until_the_button_lets_go(self):
        # 拖动是桌面端自己在窗口线程上跟光标搬窗口：交回系统那条路（ReleaseCapture + WM_NCLBUTTONDOWN/
        # HTCAPTION，或 WM_SYSCOMMAND·SC_MOUSEMOVE）在这套窗口上起不来，WinForms 的 Form 把非客户区
        # 按下自己吞了，拖动循环 0ms 返回、窗口纹丝不动
        window = _fake_window()
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        desktop._window = window
        moves = []
        capture = []
        with patch.object(app, "u32", SimpleNamespace(SetWindowPos=lambda *a: moves.append(a),
                                                      SetCapture=lambda h: capture.append(("take", h)),
                                                      ReleaseCapture=lambda: capture.append(("drop",)),
                                                      GetSystemMetrics=lambda n: 4)), \
             patch.object(app, "window_rect", lambda hwnd: (300, 200, 900, 700)), \
             patch.object(app, "_cursor_pos", iter([(320, 240), (330, 250), (380, 270)]).__next__), \
             patch.object(app, "_left_button_down", iter([True, True, False]).__next__):
            desktop.win_start_drag()
        # 抓取偏移 = 按下时光标在窗口里的位置（这里是 (20, 40)），拖动中恒不变
        self.assertEqual([(m[0], m[2], m[3]) for m in moves], [(1234, 310, 210), (1234, 360, 230)])
        self.assertEqual(moves[0][6], app.SWP_NOSIZE | app.SWP_NOZORDER | app.SWP_NOACTIVATE)
        # 捕获要在窗口线程上拿、松手还回去：捕获不在桌面端窗口上的话 WebView2 继续吃鼠标消息，
        # 松手也传不过来（这正是拖动循环 0ms 返回的那个坑）
        self.assertEqual(capture, [("take", 1234), ("drop",)])

    def test_press_inside_the_drag_threshold_moves_nothing(self):
        # 最大化下单击顶栏不许还原窗口：按下没走出系统拖动阈值，窗口一动不动，最大化留着
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"frameless": True})
        desktop._window = _fake_window()
        desktop.maximized = True
        moved, stopped, logs = [], [], []
        with patch.object(app.StudioDesktop, "win_maximize", lambda self: stopped.append("maximized")), \
             patch.object(app, "u32", SimpleNamespace(SetWindowPos=lambda *a: moved.append(a),
                                                      SetCapture=lambda h: None,
                                                      ReleaseCapture=lambda: None,
                                                      GetSystemMetrics=lambda n: 8)), \
             patch.object(app, "window_rect", lambda hwnd: (100, 100, 700, 500)), \
             patch.object(app, "_cursor_pos", iter([(150, 130), (152, 132), (157, 137)]).__next__), \
             patch.object(app, "_left_button_down", iter([True, True, False]).__next__), \
             patch.object(app, "log_line", lambda text: logs.append(text)):
            desktop.win_start_drag()
        self.assertEqual(stopped, [], "没走出阈值不许还原最大化")
        self.assertEqual(moved, [], "没走出阈值不许搬窗口")
        self.assertIn("drag 0 steps", logs)

    def test_maximize_exits_once_the_drag_threshold_is_crossed(self):
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"frameless": True})
        desktop._window = _fake_window()
        desktop.maximized = True
        moved, stopped = [], []
        with patch.object(app.StudioDesktop, "win_maximize", lambda self: stopped.append("maximized")), \
             patch.object(app, "u32", SimpleNamespace(SetWindowPos=lambda *a: moved.append(a),
                                                      SetCapture=lambda h: None,
                                                      ReleaseCapture=lambda: None,
                                                      GetSystemMetrics=lambda n: 8)), \
             patch.object(app, "window_rect", lambda hwnd: (100, 100, 700, 500)), \
             patch.object(app, "_cursor_pos", iter([(150, 130), (170, 150)]).__next__), \
             patch.object(app, "_left_button_down", iter([True, False]).__next__):
            desktop.win_start_drag()
        self.assertEqual(stopped, ["maximized"], "走出阈值才还原")
        self.assertEqual([(m[2], m[3]) for m in moved], [(100, 100)], "抓取偏移按还原后的新矩形重算")

    def test_win_start_drag_leaves_fullscreen_and_maximize_first(self):
        # 全屏 / 最大化时拖动先退出：整屏或整块工作区大小的窗口跟着光标跑，看着就像坏了；
        # pywebview 那边还会停在全屏态，再点全屏按钮窗口会跳回旧矩形
        for state in ("fullscreen", "maximized"):
            desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"frameless": True})
            desktop._window = _fake_window()
            setattr(desktop, state, True)
            stopped = []
            with patch.object(app.StudioDesktop, "win_maximize", lambda self: stopped.append("maximized")), \
                 patch.object(app.StudioDesktop, "win_fullscreen", lambda self: stopped.append("fullscreen")), \
                 patch.object(app, "u32", SimpleNamespace(SetWindowPos=lambda *a: None,
                                                          SetCapture=lambda h: None,
                                                          ReleaseCapture=lambda: None,
                                                          GetSystemMetrics=lambda n: 4)), \
                 patch.object(app, "window_rect", lambda hwnd: (100, 100, 700, 500)), \
                 patch.object(app, "_cursor_pos", iter([(150, 130), (170, 150)]).__next__), \
                 patch.object(app, "_left_button_down", iter([True, False]).__next__):
                desktop.win_start_drag()
            self.assertEqual(stopped, [state])

    def test_win_start_drag_runs_on_the_window_thread(self):
        window = _fake_window()
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        desktop._window = window
        invoked = []
        window.native.Invoke = lambda fn: invoked.append(fn) or fn()
        with patch.object(app, "u32", SimpleNamespace(SetWindowPos=lambda *a: None,
                                                      SetCapture=lambda h: None,
                                                      ReleaseCapture=lambda: None,
                                                      GetSystemMetrics=lambda n: 4)), \
             patch.object(app, "window_rect", lambda hwnd: (0, 0, 100, 100)), \
             patch.object(app, "_cursor_pos", lambda: (10, 10)), \
             patch.object(app, "_left_button_down", lambda: False):
            desktop.win_start_drag()
        self.assertEqual(len(invoked), 1, "拖动要在窗口所属线程上跑，SetCapture 只认所属线程")

    def test_js_api_never_exposes_the_window_object(self):
        # pywebview 注入 window.pywebview 前会递归遍历 js_api 的非下划线属性
        # （webview.util.inject_pywebview）。窗口对象露在明面上 = 把 WinForms 整张对象图喂进
        # 递归，pythonnet 每次属性访问都造新对象、id 去重失效， Bounds 链爆到递归上限，开机即卡死
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        desktop._window = _fake_window()
        exposed = [n for n in dir(desktop) if not n.startswith("_")]
        self.assertNotIn("window", exposed)
        for name in ("window_state", "win_minimize", "win_maximize", "win_fullscreen",
                     "win_close", "win_start_drag", "set_frameless"):
            self.assertIn(name, exposed)

    def test_win_close_goes_through_the_window(self):
        # 关闭走 window.destroy()：pywebview 6 的 Window 没有 close()，调它就是 AttributeError。
        # 关窗收尾链（存几何、带走 ComfyUI）由 closing 事件驱动
        window = _fake_window()
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        desktop._window = window
        desktop.win_close()
        window.destroy.assert_called_once()

    def test_starting_flag_is_shared_with_desktop_service(self):
        # 启动中标记由桌面端服务与 js_api 共用同一份 dict：js_api 注入之前页面也能拿到
        flags = {"starting": False}
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"), "", "", 0, flags)
        self.assertTrue(flags["starting"], "桌面端拉起 ComfyUI 即置启动中")
        desktop.starting = False
        self.assertFalse(flags["starting"], "就绪后收掉启动中，桌面端服务同步")

    def test_state_of_desktop_spawned_comfy(self):
        # 桌面端拉起的那路以端口探活为准：TerminateProcess 是异步的，进程还在收尾时端口已关
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False):
            self.assertTrue(desktop.comfy_state()["starting"], "桌面端拉起且端口未就绪要报启动中")
        with patch.object(app, "probe", lambda port, timeout=3.0: True):
            self.assertEqual(desktop.comfy_state(),
                             {"port": 8188, "pid": 1234, "mine": True, "running": True,
                              "ready": True, "starting": False})
        with patch.object(app, "probe", lambda port, timeout=3.0: False):
            self.assertFalse(desktop.comfy_state()["running"])
            self.assertFalse(desktop.comfy_state()["starting"], "就绪过一次后不再报启动中")

    def test_state_of_external_comfy_by_port(self):
        # 外部启动的 ComfyUI 没有 Popen 句柄：按端口找 PID，缓存后只用 OpenProcess 复查
        runs = []
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "port_owner", lambda port: runs.append(port) or 4321), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "probe", lambda port, timeout=3.0: True):
            state = {"port": 8188, "pid": 4321, "mine": False, "running": True, "ready": True,
                     "starting": False}
            self.assertEqual(desktop.comfy_state(), state)
            self.assertEqual(desktop.comfy_state(), state)
        self.assertEqual(runs, [8188], "缓存的 PID 还活着时不该重跑 netstat")

    def test_state_when_nothing_listens(self):
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "port_owner", lambda port: 0), \
             patch.object(app, "probe", lambda port, timeout=3.0: False):
            self.assertFalse(desktop.comfy_state()["running"])

    def test_external_comfy_running_follows_the_probe_not_the_pid(self):
        # 顶栏胶囊与离线横幅必须读同一份就绪判据：端口上有 PID 只说明有人在监听，
        # 插件还在导入自定义节点时服务不认 —— 报「进程活着」就是胶囊「运行中」+ 横幅「未运行」
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "port_owner", lambda port: 4321), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "probe", lambda port, timeout=3.0: False):
            state = desktop.comfy_state()
        self.assertEqual(state["pid"], 4321, "提示里照旧报端口上那路外部 ComfyUI 的 PID")
        self.assertFalse(state["running"], "服务没就绪就不许报运行中")
        self.assertFalse(state["ready"])

    def test_stop_terminates_desktop_comfy(self):
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 0):
            desktop.comfy_stop()
        comfy.terminate.assert_called_once()

    def test_stop_kills_port_owner_that_is_not_the_popen(self):
        # 监听者未必是桌面端的 Popen：terminate 后按端口反复杀到没人监听
        kills, owners = [], iter([4321, 0])
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: next(owners)), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or True):
            desktop.comfy_stop()
        comfy.terminate.assert_called_once()
        self.assertEqual(kills, [4321])

    def test_stop_reports_kill_without_permission(self):
        # OpenProcess 拿不到句柄（权限不足）：报失败并停下，不无限循环杀同一个 PID
        kills, owners, logs = [], iter([4321, 4321, 4321]), []
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "port_owner", lambda port: next(owners)), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or False), \
             patch.object(app, "log_line", lambda text: logs.append(text)):
            desktop.comfy_stop()
        self.assertEqual(kills, [4321], "杀不动就不该反复重试")
        self.assertIn("权限", logs[0])

    def test_stop_skips_owner_that_is_already_exiting(self):
        # terminate 后 netstat 可能还列着正在收尾的进程：它已死，不该报「没有权限」
        kills, logs = [], []
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 4321), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or True), \
             patch.object(app, "log_line", lambda text: logs.append(text)):
            desktop.comfy_stop()
        self.assertEqual(kills, [], "收尾中的进程不该再去杀")
        self.assertNotIn("权限", "".join(logs))

    def test_close_kills_only_the_desktop_spawned_process(self):
        # 关窗只认自己那份 PID：不扫端口，扫监听者会在关窗路上误杀抢端口的残留进程
        touched, flags = [], {"starting": True}
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"), "", "", 0, flags)
        with patch.object(app, "port_owner", lambda port: touched.append(port) or 4321), \
             patch.object(app, "kill_pid", lambda pid: touched.append(pid) or True), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(app, "log_line", lambda text: None):
            desktop.comfy_close()
        comfy.terminate.assert_called_once()
        self.assertEqual(touched, [], "关窗不该按端口扫进程")
        self.assertFalse(flags["starting"], "关窗收掉启动中")

    def test_close_falls_back_to_its_own_pid_when_the_child_wont_exit(self):
        # 回收超时（进程真没退出）：按 PID 兜底强杀，范围不外扩。
        # 判活不能用 Popen.poll() —— 子进程句柄被回收后它会谎报「已退出」，兜底整条失效
        kills = []
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(),
                                wait=MagicMock(side_effect=subprocess.TimeoutExpired("comfy", 3)))
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or True), \
             patch.object(app, "log_line", lambda text: None):
            desktop.comfy_close()
        self.assertEqual(kills, [1234])

    def test_close_reaps_the_child_it_terminated(self):
        # TerminateProcess 之后进程只剩一个内核对象：不 reap 就一直能被 OpenProcess 打开，
        # pid_alive 永远报「还活着」—— 关窗固定睡满等待上限（用户读成卡死），兜底强杀也必然失败
        logs, kills = [], []
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or True), \
             patch.object(app, "log_line", lambda text: logs.append(text)):
            desktop.comfy_close()
        comfy.wait.assert_called_once()
        self.assertEqual(kills, [], "回收到位就不需要兜底强杀")
        self.assertNotIn("kill", "".join(logs), "不该再报那行误导的「close kill」")

    def test_stop_reaps_before_sweeping_the_port(self):
        # 僵尸 PID 上 OpenProcess 拿得到句柄、TerminateProcess 必失败：
        # 停止路径那行「没有权限终止该进程」就是这么来的
        kills, logs = [], []
        comfy = SimpleNamespace(pid=1234, poll=lambda: None, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 0), \
             patch.object(app, "kill_pid", lambda pid: kills.append(pid) or True), \
             patch.object(app, "log_line", lambda text: logs.append(text)):
            desktop.comfy_stop()
        comfy.wait.assert_called_once()
        self.assertNotIn("权限", "".join(logs))

    def test_close_is_idempotent(self):
        # closing、closed、退出兜底三处都会调它：只带走一次
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(app, "log_line", lambda text: None):
            desktop.comfy_close()
            desktop.comfy_close()
        comfy.terminate.assert_called_once()

    def test_close_leaves_external_comfy_alone(self):
        # 用户自己启动的 ComfyUI 没有桌面端的句柄：关窗完全不动，避免误杀
        touched = []
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "port_owner", lambda port: touched.append(port) or 4321), \
             patch.object(app, "kill_pid", lambda pid: touched.append(pid) or True), \
             patch.object(app, "log_line", lambda text: None):
            desktop.comfy_close()
        self.assertEqual(touched, [])

    def test_jump_waits_by_attach_for_a_foreign_comfy(self):
        # 附着的那路（桌面端没有句柄）：端口死了要收手回离线页，不能等满超时把窗口卡在「启动中」
        calls = []
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"))
        with patch.object(app, "wait_attach", lambda *a: calls.append("attach") or False), \
             patch.object(app, "wait_ready", lambda *a: calls.append("ready") or False), \
             patch.object(app, "log_line", lambda text: None):
            desktop._jump_when_ready()
        self.assertEqual(calls, ["attach"])
        self.assertFalse(desktop.starting, "收手要收掉启动中，横幅回到「未运行 + 启动」")

    def test_jump_waits_for_the_spawned_child_to_bind_the_port(self):
        # 自己拉起的那路：端口在绑上之前一直是空的，必须按 wait_ready 等，不能按「没人监听」收手
        calls = []
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        with patch.object(app, "wait_attach", lambda *a: calls.append("attach") or False), \
             patch.object(app, "wait_ready", lambda *a: calls.append("ready") or False), \
             patch.object(app, "log_line", lambda text: None):
            desktop._jump_when_ready()
        self.assertEqual(calls, ["ready"])

    def test_start_respawns_after_stop(self):
        comfy = SimpleNamespace(pid=1234, poll=lambda: 1, terminate=MagicMock())
        desktop = app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"))
        spawned = SimpleNamespace(pid=9999, poll=lambda: None)
        with patch.object(app, "start_comfy", lambda python, root, port, listen, cors: spawned), \
             patch.object(app, "resolve_python", lambda root, arg: pathlib.Path("python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "port_busy", lambda port: False), \
             patch.object(app, "free_comfy_port", lambda port, desktop_port: port), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "log_line", lambda text: None):
            state = desktop.comfy_start()
        self.assertIs(desktop.comfy, spawned)
        self.assertEqual((state["pid"], state["running"], state["ready"]), (9999, False, False))

    def test_start_attaches_when_port_busy(self):
        # 端口上已有一路 ComfyUI（插件没加载时探测会失败，桌面端别上当）：只附着，不在 8189 拉第二路
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", None, 8188, pathlib.Path("root"))
        spawned = []
        logs = []
        no_thread = lambda target, daemon=True: SimpleNamespace(start=lambda: None)
        with patch.object(app, "port_busy", lambda port: True), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: spawned.append(port) or MagicMock()), \
             patch.object(app, "resolve_python", lambda root, arg: pathlib.Path("python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 4321), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app.threading, "Thread", no_thread), \
             patch.object(app, "log_line", lambda text: logs.append(text)):
            state = desktop.comfy_start()
        self.assertEqual(spawned, [], "端口已有人监听就不许拉第二路")
        self.assertIsNone(desktop.comfy, "附着：桌面端没有句柄，关窗谁都不碰")
        self.assertEqual(state["pid"], 4321, "状态报端口上那路外部 ComfyUI")
        self.assertIn("comfy attach port=8188", logs)

    def test_stop_pulls_window_back_to_offline_gallery(self):
        loader = MagicMock()
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", None, 8188,
                                pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio")
        desktop.loader = loader
        desktop.rearm = MagicMock()
        with patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 0), \
             patch.object(app, "log_line", lambda text: None):
            state = desktop.comfy_stop()
        # ComfyUI 停了，页面是它的：窗口退回桌面端的只读素材页，不留死页面
        self.assertFalse(state["ready"])
        loader.assert_called_once_with("http://127.0.0.1:8191/neo-studio")
        desktop.rearm.assert_called_once_with()

    def test_start_jumps_to_full_studio_when_ready(self):
        comfy = SimpleNamespace(pid=1, poll=lambda: 0, terminate=MagicMock())
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", comfy, 8188,
                                pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio")
        desktop.loader = MagicMock()
        desktop.rearm = MagicMock()
        spawned = SimpleNamespace(pid=9999, poll=lambda: None)
        no_thread = lambda target, daemon=True: SimpleNamespace(start=lambda: None)
        with patch.object(app, "start_comfy", lambda python, root, port, listen, cors: spawned), \
             patch.object(app, "resolve_python", lambda root, arg: pathlib.Path("python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "port_busy", lambda port: False), \
             patch.object(app, "free_comfy_port", lambda port, desktop_port: port), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "log_line", lambda text: None), \
             patch.object(app.threading, "Thread", no_thread):
            desktop.comfy_start()
        with patch.object(app, "wait_ready", lambda port, seconds: True), \
             patch.object(app, "log_line", lambda text: None):
            desktop._jump_when_ready()
        loader = desktop.loader
        loader.assert_called_once_with("http://127.0.0.1:8188/neo-studio")

    def test_offline_page_jumps_when_comfy_gets_ready_after_the_budget(self):
        # 用户现场：READY_TIMEOUT 用完 _jump_when_ready 就收手，ComfyUI 之后才就绪
        # （自定义节点导入慢、或用户自己在外面起的那路）—— 窗口不能永远停在「未运行」横幅上，
        # 顶栏胶囊那份 5 秒探活就是收尾
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", None, 8188,
                                    pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio")
        desktop.loader = MagicMock()
        desktop.rearm = MagicMock()
        with patch.object(app, "port_owner", lambda port: 4321), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "log_line", lambda text: None):
            desktop._goto(desktop.offline_url)
            state = desktop.comfy_state()
        self.assertTrue(state["ready"])
        desktop.loader.assert_called_with("http://127.0.0.1:8188/neo-studio")
        self.assertEqual(desktop.page, "http://127.0.0.1:8188/neo-studio", "跳完认页，别反复跳")

    def test_ready_poll_does_not_jump_from_the_full_studio_page(self):
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", None, 8188,
                                    pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio")
        desktop.loader = MagicMock()
        desktop.rearm = MagicMock()
        with patch.object(app, "port_owner", lambda port: 4321), \
             patch.object(app, "pid_alive", lambda pid: True), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "log_line", lambda text: None):
            desktop._goto(desktop.url)
            for _ in range(3):
                desktop.comfy_state()
        self.assertEqual(desktop.loader.call_count, 1, "完整 Studio 里探活不许把页面跳走")

    def test_direct_needs_the_desktop_spawned_loopback_child(self):
        # 直连那路的判定必须与 comfy_cors 的取值条件同源：flag 没给出去，页面直连必 403
        comfy = SimpleNamespace(pid=1234, poll=lambda: None)
        self.assertTrue(app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"), desktop_port=8191).direct)
        self.assertFalse(app.StudioDesktop("u", comfy, 8188, pathlib.Path("root")).direct,
                         "桌面端服务没绑定端口，就没有 origin 可放行")
        self.assertFalse(app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"), desktop_port=8191,
                                           launcher={"listen": "192.168.0.7"}).direct,
                         "局域网监听保留整页跳转，origin_only 不在网卡实例上让位")
        self.assertFalse(app.StudioDesktop("u", comfy, 8188, pathlib.Path("root"), desktop_port=8191,
                                           launcher={"remote": "http://192.168.0.9:8188"}).direct,
                         "远端机器上的进程加不了 flag")
        self.assertFalse(app.StudioDesktop("u", None, 8188, pathlib.Path("root"), desktop_port=8191).direct,
                         "附着的那路没有句柄，flag 给不出去")

    def test_ready_in_place_reports_the_base_instead_of_navigating(self):
        # 就绪不再整页跳转：跳转会把导演编辑器与表单里未保存的内容全清掉
        comfy = SimpleNamespace(pid=1234, poll=lambda: None)
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", comfy, 8188,
                                    pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio", 8191)
        desktop.loader = MagicMock()
        desktop.rearm = MagicMock()
        desktop.page = desktop.offline_url
        with patch.object(app, "wait_ready", lambda base, seconds: True), \
             patch.object(app, "log_line", lambda text: None):
            desktop._jump_when_ready()
        desktop.loader.assert_not_called()
        self.assertEqual(desktop.flags["comfy_base"], "http://127.0.0.1:8188")
        self.assertFalse(desktop.starting, "接上前收掉启动中")

    def test_ready_from_the_offline_page_still_jumps_when_direct_is_off(self):
        # 附着的那路没有 CORS 可用：照旧整页跳过去，别停在「未运行」横幅上
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", None, 8188,
                                    pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio", 8191)
        desktop.loader = MagicMock()
        desktop.rearm = MagicMock()
        desktop.page = desktop.offline_url
        with patch.object(app, "wait_attach", lambda base, seconds, busy: True), \
             patch.object(app, "log_line", lambda text: None):
            desktop._jump_when_ready()
        desktop.loader.assert_called_once_with("http://127.0.0.1:8188/neo-studio")

    def test_ready_poll_reports_the_base_and_stays_on_the_page(self):
        # 顶栏那份 5 秒探活是直连那路的收尾：报出 comfy_base 让页面原地翻面，不碰窗口导航
        comfy = SimpleNamespace(pid=1234, poll=lambda: None)
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", comfy, 8188,
                                    pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio", 8191)
        desktop.loader = MagicMock()
        desktop.rearm = MagicMock()
        desktop.page = desktop.offline_url
        with patch.object(app, "probe", lambda base, timeout=3.0: True), \
             patch.object(app, "log_line", lambda text: None):
            state = desktop.comfy_state()
        self.assertTrue(state["ready"])
        self.assertEqual(desktop.flags["comfy_base"], "http://127.0.0.1:8188")
        desktop.loader.assert_not_called()

    def test_stop_clears_the_base_and_does_not_reload_the_page(self):
        comfy = SimpleNamespace(pid=1234, poll=lambda: 1, terminate=MagicMock(), wait=MagicMock())
        desktop = app.StudioDesktop("http://127.0.0.1:8188/neo-studio", comfy, 8188,
                                    pathlib.Path("root"), "", "http://127.0.0.1:8191/neo-studio", 8191)
        desktop.loader = MagicMock()
        desktop.rearm = MagicMock()
        desktop.flags["comfy_base"] = "http://127.0.0.1:8188"
        desktop.page = desktop.offline_url
        with patch.object(app, "probe", lambda base, timeout=3.0: False), \
             patch.object(app, "port_owner", lambda port: 0), \
             patch.object(app, "reap", lambda proc, seconds: None), \
             patch.object(app, "log_line", lambda text: None):
            state = desktop.comfy_stop()
        self.assertFalse(state["ready"])
        self.assertEqual(desktop.flags["comfy_base"], "", "生成类目标随进程一起收，页面回到离线形态")
        desktop.loader.assert_not_called()


    def test_pill_is_reinjected_after_every_page_load(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        logs = []
        # loaded 处理器在 main() 之后手动触发，log_line 的桩要一直挂着
        patcher = patch.object(app, "log_line", lambda text: logs.append(text))
        patcher.start()
        self.addCleanup(patcher.stop)
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "port_busy", lambda port: True), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 开窗那行带上起始页面：窗口停在启动页、离线页还是完整 Studio，事后看日志就知道
        self.assertTrue(any(line.startswith("webview start geo=") and "page=splash" in line
                            for line in logs), logs)
        # 主画布整页刷新后由 loaded 事件重新注入，返回入口不会随刷新消失

        self.assertEqual(len(window.events.loaded.handlers), 1)
        window.events.loaded.handlers[0]()
        window.evaluate_js.assert_called_once_with(app.BACK_JS)
        # 每次整页加载记一行当前页面
        self.assertEqual(logs[-1], f"page loaded {window.get_current_url()}")
        # js_api 只挂 load_url 绑定方法，不挂窗口对象（挂窗口会让 create_proxy 爆栈）
        api = cw.call_args.kwargs["js_api"]
        self.assertIs(api.loader, window.load_url)
        # load_url 会清空 events.loaded，返回后 rearm 重新挂上，胶囊不会永久消失
        api.rearm()
        self.assertEqual(len(window.events.loaded.handlers), 2)
        window.events.loaded.handlers[1]()
        self.assertEqual(window.evaluate_js.call_count, 2)
        self.assertEqual(sum(1 for line in logs if line.startswith("page loaded ")), 2)


class MainWindowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._log = app.DESKTOP_LOG
        self._geo = app.GEOMETRY_FILE
        # 关窗会落几何与启动日志：测试里全指到临时目录，别写进真实的 data
        app.DESKTOP_LOG = pathlib.Path(self._tmp.name) / "studio_desktop.log"
        app.GEOMETRY_FILE = pathlib.Path(self._tmp.name) / "studio_window.json"
        self.port_busy = False   # 默认端口空闲 = 冷启动；热启动的测试自己置 True
        patcher = patch.object(app, "port_busy", lambda port: self.port_busy)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(app.threading, "Thread", _SyncThread)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        app.DESKTOP_LOG = self._log
        app.GEOMETRY_FILE = self._geo
        self._tmp.cleanup()

    def test_warm_start_loads_url_directly(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        touched = []
        self.port_busy = True
        start = lambda *a, **k: a[0] and a[0]()
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "port_owner", lambda port: touched.append(port) or 4321), \
             patch.object(app, "kill_pid", lambda pid: touched.append(pid) or True), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
            self.assertEqual(len(window.events.closing.handlers), 1)
            # 热启动：ComfyUI 是用户自己开的，桌面端没有句柄 → 关窗一个进程都不碰
            window.events.closing.handlers[0]()
        self.assertEqual(touched, [], "非桌面端拉起的 ComfyUI 关窗不许动")
        self.assertTrue(app.GEOMETRY_FILE.exists(), "关窗要存几何")
        # 窗口先出启动页，后台探活就绪后整页跳进完整 Studio；用户自己的 ComfyUI 不被桌面端接管
        self.assertEqual(cw.call_args.kwargs["html"], app.splash_html())
        self.assertIsNone(cw.call_args.kwargs["js_api"].comfy)
        self.assertFalse(cw.call_args.kwargs["js_api"].flags["starting"], "已就绪不报启动中")
        window.load_url.assert_called_once_with("http://127.0.0.1:8188/neo-studio")

    def test_links_stay_in_desktop_window(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        fake = _fake_webview(cw)
        self.port_busy = True
        with patch.object(app, "webview", fake), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 「⤒ 主画布编辑」与顶栏「🎬 新影工坊」的 _blank 链接留在桌面端窗口内导航；blob 下载仍放行

        self.assertFalse(fake.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"])
        self.assertTrue(fake.settings["ALLOW_DOWNLOADS"])

    def test_frameless_config_reaches_the_window(self):
        # 无边框不走 pywebview 的 frameless（那条路连可拖拽边框一起摘）：建窗保持有框，样式位自己摘
        # pywebview 的 easy_drag 是全局 mousedown，点卡片会拖着窗口跑，必须关
        window = _fake_window()
        cw = MagicMock(return_value=window)
        self.port_busy = True
        start = lambda *a, **k: a[0] and a[0]()
        frames = []
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(app, "CONFIG_FILE", pathlib.Path(tmp) / "launcher_config.json"), \
             patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "set_window_frame", lambda hwnd, on: frames.append(on)), \
             patch.object(sys, "argv", ["studio_app.py"]):
            app.save_config(_COMFY_ROOT, pathlib.Path(sys.executable), 8188, {"frameless": True})
            self.assertEqual(app.main(), 0)
            window.events.shown.handlers[0]()   # 窗口显示：无边框补回可拖拽边框
        self.assertTrue(cw.call_args.kwargs["frameless"], "无边框要在建窗时就生效")
        self.assertFalse(cw.call_args.kwargs["easy_drag"])
        self.assertIs(cw.call_args.kwargs["js_api"]._window, window, "窗口操作要拿到窗口对象")
        self.assertEqual(frames, [True], "补边框只认无边框那一路")

    def test_window_background_is_the_page_color(self):
        # pywebview 的 background_color 默认白色，同时定 Form.BackColor 与 WebView2 的 DefaultBackgroundColor：
        # 拖边框缩放的模态循环里新客户区先刷它，白色就是白窗闪一下
        window = _fake_window()
        cw = MagicMock(return_value=window)
        self.port_busy = True
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        self.assertEqual(cw.call_args.kwargs["background_color"], app.WINDOW_BG)

    def test_fullscreen_close_does_not_save_the_screen_rect(self):
        # 全屏时窗口是整屏矩形：存下来下次开机窗口直接铺满屏幕，几何只存窗口态的那份
        window = _fake_window()
        cw = MagicMock(return_value=window)
        self.port_busy = True
        start = lambda *a, **k: a[0] and a[0]()
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
            cw.call_args.kwargs["js_api"].win_fullscreen()
            window.events.closing.handlers[0]()
        self.assertFalse(app.GEOMETRY_FILE.exists(), "全屏关窗不存几何")

    def test_cold_start_loads_offline_gallery(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        # webview.start 阻塞到窗口关闭：这里同步跑完后台启动序列，再触发关窗事件
        opened = {}

        def wait(port, seconds):
            opened.update(cw.call_args.kwargs["js_api"].flags)   # 等就绪那一刻就是「启动中」
            return False

        def start(*a, **k):
            a[0]()
            window.events.closing.handlers[0]()

        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: comfy), \
             patch.object(app, "wait_ready", wait), \
             patch.object(app, "alert", lambda text: None), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 窗口先出启动页，后台拉起 ComfyUI 后进桌面端只读服务的离线素材页，就绪后整页跳到完整 Studio
        self.assertEqual(cw.call_args.kwargs["html"], app.splash_html())
        self.assertEqual(cw.call_args.kwargs["js_api"].offline_url, "http://127.0.0.1:8191/neo-studio")
        window.load_url.assert_called_once_with("http://127.0.0.1:8191/neo-studio")
        # 桌面端只读服务与 js_api 共用启动中标记：窗口第一次 /neo_studio/version 就是「启动中」
        self.assertTrue(opened["starting"], "拉起 ComfyUI 后报启动中")
        self.assertIs(cw.call_args.kwargs["js_api"].comfy, comfy)
        # 关窗带走桌面端自己拉起的这路：拉起阶段不碰它，关窗才 terminate（退出兜底不重复杀）
        self.assertEqual(len(window.events.closing.handlers), 1)
        comfy.terminate.assert_called_once()
        self.assertFalse(cw.call_args.kwargs["js_api"].flags["starting"], "关窗收掉启动中")

    def test_close_chain_kills_comfy_when_geometry_save_fails(self):
        # 用户现场：窗口已销毁，读几何属性抛异常。收尾顺序必须是先带走 ComfyUI，
        # 否则这条链在第一步就断，进程变孤儿占着端口
        window = _DeadWindow()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        start = lambda *a, **k: (a[0](), window.events.closing.handlers[0]())
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: comfy), \
             patch.object(app, "wait_ready", lambda port, seconds: True), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        comfy.terminate.assert_called_once()
        self.assertFalse(app.GEOMETRY_FILE.exists(), "读不到几何就不写文件")

    def test_close_kills_comfy_before_the_stopping_hint(self):
        # 先杀进程再挂提示：evaluate_js 要等 UI 线程回消息循环才执行，卡在这里不能拖住带走内核
        window = _fake_window()
        order = []
        window.evaluate_js = lambda script: order.append("hint") if script is app.CLOSING_JS else None
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=lambda: order.append("kill"), wait=lambda *a, **k: None)
        start = lambda *a, **k: (a[0](), window.events.closing.handlers[0]())
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: comfy), \
             patch.object(app, "wait_ready", lambda port, seconds: True), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        self.assertEqual(order, ["kill", "hint"], "先带走进程，再挂「正在停止 ComfyUI」盖住收服务的等待")
        self.assertTrue(window.destroy.called, "收尾走完要由收尾线程销毁窗口")

    def test_close_hint_skipped_for_external_comfy(self):
        # 用户自己启动的那路桌面端不杀：提示不能写「正在停止 ComfyUI」
        window = _fake_window()
        cw = MagicMock(return_value=window)
        self.port_busy = True
        start = lambda *a, **k: window.events.closing.handlers[0]()
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        self.assertNotIn(app.CLOSING_JS, [c[0][0] for c in window.evaluate_js.call_args_list])

    def test_closing_handler_defers_teardown_off_the_ui_thread(self):
        # closing 同步跑在 UI 线程：evaluate_js 要等这个线程回消息循环才执行，在处理器里调直接死锁；
        # 收尾睡多久窗口就冻多久。所以处理器只放行关闭（返回 False），提示与收尾都归后台线程。
        window = _fake_window()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: comfy), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        handler = window.events.closing.handlers[0]
        src = inspect.getsource(handler)
        self.assertIs(handler(), False, "第一次 closing 要放行关闭，窗口才画得出提示")
        for banned in ("evaluate_js", "comfy_close", "server.stop"):
            self.assertNotIn(banned, src, f"收尾不能留在 UI 线程上：{banned}")
        self.assertIn("save_geometry", src, "几何要在窗口销毁前读走")

    def test_closing_releases_the_singleton_first(self):
        # 收尾（杀 ComfyUI、收桌面端服务）要跑一两秒，窗口在这之后才落地：
        # 锁按进程退出才释放的话，这期间重开一律弹「窗口已在运行」，用户读成「关完要等一会才能启动」
        window = _fake_window()
        cw = MagicMock(return_value=window)
        released = []
        self.addCleanup(setattr, app, "SINGLETON_HANDLE", None)
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "release_singleton", lambda: released.append("released")), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
            window.events.closing.handlers[0]()
        self.assertEqual(released, ["released"])

    def test_exit_kills_comfy_when_no_close_event_fires(self):
        # destroy / 后端直接销毁窗口时 closing 可能根本不触发：进程退出前必须收掉桌面端拉起的 ComfyUI
        window = _fake_window()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        with patch.object(app, "webview", _fake_webview(cw, lambda *a, **k: a[0]())), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: comfy), \
             patch.object(app, "wait_ready", lambda port, seconds: True), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        self.assertEqual(len(window.events.closing.handlers), 1)
        comfy.terminate.assert_called_once()

    def test_cold_start_without_desktop_service_falls_back_to_splash(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        comfy = SimpleNamespace(pid=1234, terminate=MagicMock(), wait=MagicMock())
        with patch.object(app, "webview", _fake_webview(cw, lambda *a, **k: a[0]())), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", lambda factory, port: SimpleNamespace(
                 start=lambda: 0, stop=lambda: None, bound=0, error=None)), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: comfy), \
             patch.object(app, "wait_ready", lambda port, seconds: False), \
             patch.object(app, "alert", lambda text: None), \
             patch.object(app, "pid_alive", lambda pid: False), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 桌面端服务起不来（端口全被占）就没有离线页可去：窗口停在启动页，不往空地址跳
        self.assertEqual(cw.call_args.kwargs["html"], app.splash_html())
        window.load_url.assert_not_called()

    def test_missing_python_opens_the_guide_page(self):
        """解释器找不到不能退出进程：窗口开在引导页让用户选，进程一个都不拉。"""
        window = _fake_window()
        cw = MagicMock(return_value=window)
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: None), \
             patch.object(app, "start_comfy", MagicMock()) as spawn, \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        launcher = cw.call_args.kwargs["js_api"].launcher
        self.assertEqual(cw.call_args.kwargs["html"], app.guide_html(launcher))
        self.assertEqual(launcher["state"], app.ST_NO_PYTHON)
        self.assertEqual(launcher["python"], "")
        spawn.assert_not_called()

    def test_unresolvable_root_opens_the_guide_page(self):
        """exe 被拷到别处：根目录推不出来也开引导页，不再窗口前弹原生目录选择器。"""
        window = _fake_window()
        cw = MagicMock(return_value=window)
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "resolve_root", lambda root: None), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "start_comfy", MagicMock()) as spawn, \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        launcher = cw.call_args.kwargs["js_api"].launcher
        self.assertEqual(cw.call_args.kwargs["html"], app.guide_html(launcher))
        self.assertEqual(launcher["state"], app.ST_BAD_ROOT)
        self.assertEqual(launcher["root"], "")
        spawn.assert_not_called()

    def test_guide_start_installs_the_plugin_it_serves_from(self):
        """用户现场：exe 在别处，选中的根目录里还没装插件。「开始」要走正常启动那套自检，
        先把内置副本装进 custom_nodes —— 直接拿不存在的目录装配，桌面端服务在 import 期就抛
        FileNotFoundError(2)，用户只看到一句「起不来」。"""
        window = _fake_window()
        cw = MagicMock(return_value=window)
        root = pathlib.Path(self._tmp.name) / "ComfyUI"
        root.mkdir(parents=True)
        (root / "main.py").write_text("", encoding="utf-8")
        bundled = pathlib.Path(self._tmp.name) / "bundled" / "comfyui-neo-studio"
        (bundled / "web").mkdir(parents=True)
        (bundled / "util.py").write_text("", encoding="utf-8")
        py = pathlib.Path(self._tmp.name) / "python.exe"
        py.write_text("", encoding="utf-8")
        ensure = app.ensure_plugin
        spawn = MagicMock(return_value=SimpleNamespace(pid=4321, poll=lambda: 0))
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "resolve_root", lambda r: root), \
             patch.object(app, "find_python", lambda r, p: pathlib.Path(p) if p else None), \
             patch.object(app, "CONFIG_FILE", pathlib.Path(self._tmp.name) / "launcher_config.json"), \
             patch.object(app, "ensure_plugin", lambda d: ensure(d, bundled)), \
             patch.object(app, "deps_ok", lambda p: True), \
             patch.object(app, "port_owner", lambda port: 0), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "start_comfy", spawn), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
            res = cw.call_args.kwargs["js_api"].start_setup(str(root), str(py))
        installed = root / "custom_nodes" / "comfyui-neo-studio"
        self.assertTrue(res["ok"], res)
        self.assertTrue((installed / "util.py").is_file(), "内置副本要装进用户选的根目录")
        self.assertEqual(cw.call_args.kwargs["js_api"].launcher["plugin_dir"], str(installed))
        spawn.assert_called_once()


    def test_start_passes_studio_icon(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        start = MagicMock()
        set_id = MagicMock()
        self.port_busy = True
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app.ctypes.windll.shell32, "SetCurrentProcessExplicitAppUserModelID", set_id), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        # 图标走 pywebview 的 start(icon=...)：create_window 没有 icon 参数，
        # edgechromium 后端（winforms）读 _state['icon'] 设 Form.Icon

        self.assertEqual(start.call_args.kwargs["icon"], str(app.STUDIO_ICON))
        # 不设 AppUserModelID 时任务栏按钮会与其他 pythonw 窗口合并成通用 Python 图标
        set_id.assert_called_once_with(app.APP_ID)

    def test_missing_icon_passes_none(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        start = MagicMock()
        set_id = MagicMock()
        self.port_busy = True
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "STUDIO_ICON", pathlib.Path("D:/nope/neo-studio.ico")), \
             patch.object(app.ctypes.windll.shell32, "SetCurrentProcessExplicitAppUserModelID", set_id), \
             patch.object(sys, "argv", ["studio_app.py"]):

            self.assertEqual(app.main(), 0)
        # 缺 .ico 时传 None，让 pywebview 回退到 pythonw 自己的图标，也不设 AppUserModelID
        self.assertIsNone(start.call_args.kwargs["icon"])
        set_id.assert_not_called()

    def test_window_ships_with_text_selection(self):
        """划词复制的前提：pywebview 默认 text_select=False，注入页面的 customize.js 给非表单元素
        preventDefault selectstart，聊天正文一个字都选不动；加速器键与原生按键随窗口显示补开"""
        window = _fake_window()
        cw = MagicMock(return_value=window)
        self.port_busy = True
        with patch.object(app, "webview", _fake_webview(cw)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        self.assertIs(True, cw.call_args.kwargs["text_select"], "要显式开划词选择")
        desktop = cw.call_args.kwargs["js_api"]
        self.assertIn(desktop.enable_copy_keys, window.events.shown.handlers,
                      "复制按键补开要挂在窗口显示之后，建核前拿不到设置")

    def test_busy_port_never_spawns_second_comfy(self):
        # 用户现场：8188 已有一路 ComfyUI，但它的 /neo_studio/version 探不到（插件没加载或还在导入
        # 自定义节点）。桌面端必须附着，不能跑到 8189 拉第二路 —— 关窗只带走自己那路，8188 还剩着
        window = _fake_window()
        cw = MagicMock(return_value=window)
        start = lambda *a, **k: a[0]()
        spawned = []
        self.port_busy = True
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: spawned.append(port) or MagicMock()), \
             patch.object(app, "wait_ready", lambda port, seconds: False), \
             patch.object(app, "wait_attach", lambda *a: False), \
             patch.object(app, "port_owner", lambda port: 4321), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        self.assertEqual(spawned, [], "端口上已有人监听就不许拉第二路")
        self.assertIsNone(cw.call_args.kwargs["js_api"].comfy, "附着：桌面端没有句柄，关窗谁都不碰")
        window.load_url.assert_called_once_with("http://127.0.0.1:8191/neo-studio")

    def test_busy_port_with_studio_route_attaches_directly(self):
        window = _fake_window()
        cw = MagicMock(return_value=window)
        start = lambda *a, **k: a[0]()
        spawned = []
        self.port_busy = True
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: True), \
             patch.object(app, "start_comfy", lambda python, root, port, listen, cors: spawned.append(port) or MagicMock()), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        self.assertEqual(spawned, [], "热启动同样不许拉第二路")
        window.load_url.assert_called_once_with("http://127.0.0.1:8188/neo-studio")

    def test_close_during_spawn_kills_the_process_it_just_started(self):
        """窗口先出之后，用户可以在自检与拉起之间关窗。收尾线程收的是「当时已有」的那路，
        正好压在拉起这一刻的话必须把刚起的那路立刻收掉，否则桌面端退出后留一路孤儿 ComfyUI。"""
        window = _fake_window()
        cw = MagicMock(return_value=window)
        start = lambda *a, **k: a[0]()
        proc = SimpleNamespace(pid=4321, terminate=MagicMock(), wait=MagicMock())

        def spawn(python, root, port, listen, cors):
            cw.call_args.kwargs["js_api"].closing = True   # 用户就在这一刻关了窗
            return proc

        self.port_busy = False
        with patch.object(app, "webview", _fake_webview(cw, start)), \
             patch.object(app, "singleton", lambda: 7), \
             patch.object(app, "DesktopServer", _fake_desktop_server()), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "find_python", lambda root, p: pathlib.Path("D:/python/python.exe")), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(app, "start_comfy", spawn), \
             patch.object(sys, "argv", ["studio_app.py"]):
            self.assertEqual(app.main(), 0)
        proc.terminate.assert_called_once_with()
        window.load_url.assert_not_called()

class LauncherConfigTests(unittest.TestCase):
    def test_config_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(app, "CONFIG_FILE", pathlib.Path(tmp) / "launcher_config.json"):
                self.assertTrue(app.save_config(pathlib.Path("D:/ComfyUI"), "D:/python/python.exe", 8188,
                                                {"frameless": True}))
                self.assertEqual(app.load_config(),
                                 {"version": app.CONFIG_VERSION, "root": str(pathlib.Path("D:/ComfyUI")),
                                  "python": "D:/python/python.exe", "port": 8188, "frameless": True,
                                  "dev_mode": False, "listen": "", "remote": ""})

    def test_config_roundtrip_with_all_toggles(self):
        # 「保存并重启」把根目录 / 解释器 / 端口连同开关与远程地址一起落盘：不能被它写没
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(app, "CONFIG_FILE", pathlib.Path(tmp) / "launcher_config.json"):
                self.assertTrue(app.save_config(pathlib.Path("D:/ComfyUI"), "D:/python/python.exe", 8188,
                                                {"frameless": False, "dev_mode": True,
                                                 "listen": "127.0.0.1,192.168.0.7",
                                                 "remote": "http://192.168.0.20:8188"}))
                self.assertEqual(app.load_config()["dev_mode"], True)
                self.assertEqual(app.load_config()["listen"], "127.0.0.1,192.168.0.7")
                self.assertEqual(app.load_config()["frameless"], False)
                self.assertEqual(app.load_config()["remote"], "http://192.168.0.20:8188")

    def test_set_frameless_keeps_the_rest_of_the_config(self):
        # 无边框开关只改自己那一项：根目录 / 解释器 / 端口不能被它带跑
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(app, "CONFIG_FILE", pathlib.Path(tmp) / "launcher_config.json"), \
                 patch.object(app, "log_line", lambda text: None):
                app.save_config(pathlib.Path("D:/ComfyUI"), "D:/python/python.exe", 8188, {"frameless": False})
                desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("D:/ComfyUI"),
                                        launcher={"root": "D:/ComfyUI", "port": 8188, "frameless": False})
                self.assertFalse(desktop.frameless, "配置里的 frameless 要读进桌面端")
                self.assertTrue(desktop.set_frameless(True)["ok"])
                self.assertEqual(app.load_config(),
                                 {"version": app.CONFIG_VERSION, "root": str(pathlib.Path("D:/ComfyUI")),
                                  "python": "D:/python/python.exe", "port": 8188, "frameless": True,
                                  "dev_mode": False, "listen": "", "remote": ""})
                self.assertTrue(desktop.launcher["frameless"], "设置页快照要同步")

    def test_load_config_missing_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(app, "CONFIG_FILE", pathlib.Path(tmp) / "none.json"):
                self.assertEqual(app.load_config(), {})

    def test_config_without_frameless_defaults_to_borderless(self):
        # 无边框是新默认：老配置没这一项也走无边框，用户在设置里勾掉才回系统标题栏
        with tempfile.TemporaryDirectory() as tmp:
            cfg = pathlib.Path(tmp) / "launcher_config.json"
            cfg.write_text(json.dumps({"version": app.CONFIG_VERSION, "root": "D:/ComfyUI"}), encoding="utf-8")
            with patch.object(app, "CONFIG_FILE", cfg):
                loaded = app.load_config()
                self.assertNotIn("frameless", loaded)
                self.assertTrue(app.StudioDesktop("u", None, 8188, pathlib.Path("D:/ComfyUI"),
                                                launcher=loaded).frameless)

    def test_root_priority_cli_then_config_then_plugin(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = pathlib.Path(tmp) / "launcher_config.json"
            cfg.write_text(json.dumps({"version": 1, "root": "D:/FromConfig"}), encoding="utf-8")
            with patch.object(app, "CONFIG_FILE", cfg):
                self.assertEqual(app.resolve_root("D:/FromCli"), pathlib.Path("D:/FromCli"))
                self.assertEqual(app.resolve_root(""), pathlib.Path("D:/FromConfig"))
            with patch.object(app, "CONFIG_FILE", pathlib.Path(tmp) / "none.json"):
                self.assertEqual(app.resolve_root(""), _COMFY_ROOT)

    def test_root_none_when_portable_has_nothing_to_infer(self):
        # exe 拷到任意目录、没有配置：往上找不出带 main.py 的根，交给 main 弹目录选择器
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(app, "CONFIG_FILE", pathlib.Path(tmp) / "none.json"), \
                 patch.object(app, "EXE_DIR", pathlib.Path(tmp) / "tools"):
                self.assertIsNone(app.resolve_root(""))

    def test_frozen_exe_infers_root_from_its_own_location(self):
        # exe 在 <root>/custom_nodes/comfyui-neo-studio/tools：上三级就是 ComfyUI 根，双击不该弹选择器
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "main.py").write_text("", encoding="utf-8")
            exe_dir = root / "custom_nodes" / "comfyui-neo-studio" / "tools"
            exe_dir.mkdir(parents=True)
            with patch.object(app, "CONFIG_FILE", root / "none.json"), \
                 patch.object(app, "EXE_DIR", exe_dir):
                self.assertEqual(app.resolve_root(""), root)

    def test_frozen_onedir_package_infers_root_one_level_deeper(self):
        # 目录版多一层包目录（tools/neo-studio/Neo-Studio.exe）：往上找根不能只认固定三级
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "main.py").write_text("", encoding="utf-8")
            exe_dir = root / "custom_nodes" / "comfyui-neo-studio" / "tools" / "neo-studio"
            exe_dir.mkdir(parents=True)
            with patch.object(app, "CONFIG_FILE", root / "none.json"), \
                 patch.object(app, "EXE_DIR", exe_dir):
                self.assertEqual(app.resolve_root(""), root)


class ListenTests(unittest.TestCase):
    def test_empty_listen_is_the_comfyui_default(self):
        # 留空 = 不传 --listen，ComfyUI 自己默认只监听 127.0.0.1
        self.assertEqual(app.comfy_listen(""), "")
        self.assertEqual(app.comfy_listen("  ,  "), "")

    def test_wildcard_covers_loopback(self):
        self.assertEqual(app.comfy_listen("0.0.0.0"), "0.0.0.0")
        self.assertEqual(app.comfy_listen("0.0.0.0, ::"), "0.0.0.0,::")

    def test_specific_nic_keeps_loopback_listening(self):
        # 桌面端窗口跳的是 http://127.0.0.1:端口，端口探测也认回环：只监听网卡会把在跑的那路读成空位
        self.assertEqual(app.comfy_listen("192.168.0.7"), "127.0.0.1,192.168.0.7")
        self.assertEqual(app.comfy_listen("192.168.0.7, 10.0.0.5"), "127.0.0.1,192.168.0.7,10.0.0.5")
        self.assertEqual(app.comfy_listen("127.0.0.1,192.168.0.7"), "127.0.0.1,192.168.0.7",
                         "规范化要能重复套用")

    def test_not_an_address_is_rejected(self):
        for raw in ("0.0.0.0:8188", "http://192.168.0.7", "192.168.0", "192.168.0.7,10.0.0",
                    "192.168.0.7 --listen"):
            self.assertIsNone(app.comfy_listen(raw), raw)

    def test_desktop_normalizes_the_saved_listen(self):
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"listen": "192.168.0.7"})
        self.assertEqual(desktop.listen, "127.0.0.1,192.168.0.7")
        self.assertEqual(app.StudioDesktop("u", None, 8188, pathlib.Path("root"),
                                         launcher={"listen": "not-an-ip"}).listen, "",
                         "手改坏的配置退回只监听本机")

    def test_start_passes_the_listen_to_comfyui(self):
        spawned = SimpleNamespace(pid=9999, poll=lambda: None)
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), launcher={"listen": "192.168.0.7"})
        argv = []
        with patch.object(app, "start_comfy",
                          lambda python, root, port, listen, cors: argv.append(listen) or spawned), \
             patch.object(app, "resolve_python", lambda root, arg: pathlib.Path("python.exe")), \
             patch.object(app, "port_busy", lambda port: False), \
             patch.object(app, "free_comfy_port", lambda port, desktop_port: port), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "log_line", lambda text: None), \
             patch.object(app.threading, "Thread",
                          lambda target, daemon=True: SimpleNamespace(start=lambda: None)):
            desktop.comfy_start()
        self.assertEqual(argv, ["127.0.0.1,192.168.0.7"])

    def test_start_passes_the_cors_origin_only_for_loopback(self):
        # flag 与 direct 必须同源：局域网监听那路不给，页面就照旧整页跳转
        seen = []
        spawned = SimpleNamespace(pid=9999, poll=lambda: None)

        def spawn(python, root, port, listen, cors):
            seen.append(cors)
            return spawned

        with patch.object(app, "start_comfy", spawn), \
             patch.object(app, "resolve_python", lambda root, arg: pathlib.Path("python.exe")), \
             patch.object(app, "port_busy", lambda port: False), \
             patch.object(app, "free_comfy_port", lambda port, desktop_port: port), \
             patch.object(app, "probe", lambda port, timeout=3.0: False), \
             patch.object(app, "log_line", lambda text: None), \
             patch.object(app.threading, "Thread",
                          lambda target, daemon=True: SimpleNamespace(start=lambda: None)):
            app.StudioDesktop("u", None, 8188, pathlib.Path("root"), desktop_port=8191).comfy_start()
            app.StudioDesktop("u", None, 8188, pathlib.Path("root"), desktop_port=8191,
                              launcher={"listen": "192.168.0.7"}).comfy_start()
        self.assertEqual(seen, ["http://127.0.0.1:8191", ""])

    def test_apply_rejects_a_non_address(self):
        # 监听地址不是 IP 就报错：不能把垃圾喂给 ComfyUI 的 --listen
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "main.py").write_text("", encoding="utf-8")
            desktop = app.StudioDesktop("u", None, 8188, root, str(sys.executable),
                                        launcher={"root": str(root), "port": 8188})
            res = desktop.apply_launcher(str(root), str(sys.executable), 8188, "192.168.0.7:8188")
            self.assertFalse(res["ok"])
            self.assertIn("监听地址", res["error"])

    def test_apply_saves_the_normalized_listen(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "main.py").write_text("", encoding="utf-8")
            desktop = app.StudioDesktop("u", None, 8188, root, str(sys.executable),
                                        launcher={"root": str(root), "port": 8188})
            with patch.object(app, "CONFIG_FILE", pathlib.Path(tmp) / "launcher_config.json"), \
                 patch.object(app, "log_line", lambda text: None), \
                 patch.object(app, "startup_state", lambda *a: ("ok", "")), \
                 patch.object(desktop, "comfy_stop", lambda: {"running": False}), \
                 patch.object(desktop, "comfy_start", lambda: {"ok": True, "port": 8188}):
                res = desktop.apply_launcher(str(root), str(sys.executable), 8188, "192.168.0.7")
                self.assertTrue(res["ok"], res)
                self.assertEqual(app.load_config()["listen"], "127.0.0.1,192.168.0.7")
                self.assertEqual(desktop.launcher["listen"], "127.0.0.1,192.168.0.7")
                self.assertEqual(desktop.listen, "127.0.0.1,192.168.0.7")


def _no_local_path(*a, **k):
    raise AssertionError("远程模式不该走本机进程 / 本机端口那条路")


class RemoteTargetTests(unittest.TestCase):
    """远程 ComfyUI：窗口指向远端，本机只探活与跳转，不拉进程、不探本机端口、不杀进程。"""

    REMOTE = "http://192.168.0.20:8188"

    def _desktop(self, **launcher):
        return app.StudioDesktop("http://127.0.0.1:8188/neo-studio", None, 8188,
                                 pathlib.Path("root"), launcher=launcher)

    def test_comfy_remote_normalizes_a_base_url(self):
        for raw, want in (("http://192.168.0.20:8188", self.REMOTE),
                          ("192.168.0.20:8188", self.REMOTE),
                          ("  http://192.168.0.20:8188/  ", self.REMOTE),
                          ("https://studio.example.com", "https://studio.example.com"),
                          ("localhost:8188", "http://localhost:8188")):
            self.assertEqual(app.comfy_remote(raw), want, raw)

    def test_empty_remote_is_local_mode(self):
        self.assertEqual(app.comfy_remote(""), "")
        self.assertEqual(app.comfy_remote("   "), "")

    def test_junk_is_rejected(self):
        # 桌面端拿它拼 /neo-studio 与探活：path / query / 锚点 / 凭据 / 非 http 一律不收
        for raw in ("ftp://192.168.0.20", "http://192.168.0.20/some/path", "http://host?a=1",
                    "http://host#frag", "http://user:pw@192.168.0.20", "http://host:99999", "http://"):
            self.assertIsNone(app.comfy_remote(raw), raw)

    def test_the_window_points_at_the_remote(self):
        desktop = self._desktop(remote=self.REMOTE)
        self.assertEqual(desktop.base, self.REMOTE)
        self.assertEqual(desktop.url, f"{self.REMOTE}/neo-studio")
        local = self._desktop()
        self.assertEqual((local.remote, local.base, local.url),
                         ("", "http://127.0.0.1:8188", "http://127.0.0.1:8188/neo-studio"))

    def test_target_busy_probes_the_remote_and_the_local_port_otherwise(self):
        remote, local = self._desktop(remote=self.REMOTE), self._desktop()
        with patch.object(app, "probe", lambda base, timeout=3.0: True), \
             patch.object(app, "port_busy", _no_local_path):
            self.assertTrue(remote.target_busy())
        with patch.object(app, "port_busy", lambda port: True), \
             patch.object(app, "probe", _no_local_path):
            self.assertTrue(local.target_busy())

    def test_remote_state_probes_the_remote_and_reports_no_local_process(self):
        desktop = self._desktop(remote=self.REMOTE)
        with patch.object(app, "probe", lambda base, timeout=3.0: True), \
             patch.object(app, "port_owner", _no_local_path), \
             patch.object(app, "pid_alive", _no_local_path):
            self.assertEqual(desktop.comfy_state(),
                             {"port": 8188, "pid": 0, "mine": False, "running": True,
                              "ready": True, "starting": False, "remote": self.REMOTE})

    def test_remote_start_never_touches_the_local_ports(self):
        desktop = self._desktop(remote=self.REMOTE)
        with patch.object(app, "start_comfy", _no_local_path), \
             patch.object(app, "port_busy", _no_local_path), \
             patch.object(app, "free_comfy_port", _no_local_path), \
             patch.object(app, "port_owner", _no_local_path), \
             patch.object(app, "kill_pid", _no_local_path), \
             patch.object(app, "probe", lambda base, timeout=3.0: False), \
             patch.object(app, "log_line", lambda text: None), \
             patch.object(app.threading, "Thread",
                          lambda target, daemon=True: SimpleNamespace(start=lambda: None)):
            state = desktop.comfy_start()
        self.assertIsNone(desktop.comfy)
        self.assertFalse(state["running"])

    def test_remote_stop_leaves_the_remote_process_alone(self):
        desktop = app.StudioDesktop("u", None, 8188, pathlib.Path("root"), "",
                                    "http://127.0.0.1:8191/neo-studio",
                                    launcher={"remote": self.REMOTE})
        gone = []
        with patch.object(app, "kill_pid", _no_local_path), \
             patch.object(app, "port_owner", _no_local_path), \
             patch.object(app, "probe", lambda base, timeout=3.0: False), \
             patch.object(app, "log_line", lambda text: None), \
             patch.object(desktop, "_goto", lambda url: gone.append(url)):
            state = desktop.comfy_stop()
        self.assertEqual(gone, ["http://127.0.0.1:8191/neo-studio"], "窗口退回离线页")
        self.assertFalse(state["running"])


    def _apply(self, desktop, root, *args):
        """把「保存并重启」里与远程无关的部分都按掉，只留校验 + 落盘 + 改窗口目标。
        断言要在 CONFIG_FILE 还换着的时候读，出了 with 就是真配置了。"""
        with patch.object(app, "CONFIG_FILE", root.parent / "launcher_config.json"), \
             patch.object(app, "log_line", lambda text: None), \
             patch.object(app, "startup_state", lambda *a: ("ok", "")), \
             patch.object(desktop, "comfy_stop", lambda: {"running": False}), \
             patch.object(desktop, "comfy_start", lambda: {"ok": True}):
            res = desktop.apply_launcher(str(root), str(sys.executable), 8188, *args)
            return res, app.load_config()

    def _root(self, tmp):
        root = pathlib.Path(tmp) / "ComfyUI"
        root.mkdir()
        (root / "main.py").write_text("", encoding="utf-8")
        return root

    def test_apply_rejects_a_bad_remote(self):
        # 远程地址不是 http(s)://主机[:端口] 就报错：不能把垃圾喂给窗口
        with tempfile.TemporaryDirectory() as tmp:
            root = self._root(tmp)
            desktop = app.StudioDesktop("u", None, 8188, root, str(sys.executable),
                                        launcher={"root": str(root), "port": 8188})
            res, _ = self._apply(desktop, root, "", "http://host/path")
            self.assertFalse(res["ok"])
            self.assertIn("远程地址", res["error"])

    def test_apply_saves_the_remote_and_moves_the_window_there(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._root(tmp)
            desktop = app.StudioDesktop("u", None, 8188, root, str(sys.executable),
                                        launcher={"root": str(root), "port": 8188})
            res, cfg = self._apply(desktop, root, "", self.REMOTE)
            self.assertTrue(res["ok"], res)
            self.assertEqual(cfg["remote"], self.REMOTE)
            self.assertEqual(desktop.remote, self.REMOTE)
            self.assertEqual(desktop.url, f"{self.REMOTE}/neo-studio")

    def test_apply_without_remote_keeps_the_saved_one(self):
        # 引导页那条路不碰远程：remote 为 None = 沿用已存的
        with tempfile.TemporaryDirectory() as tmp:
            root = self._root(tmp)
            desktop = app.StudioDesktop("u", None, 8188, root, str(sys.executable),
                                        launcher={"root": str(root), "port": 8188, "remote": self.REMOTE})
            res, cfg = self._apply(desktop, root)
            self.assertTrue(res["ok"], res)
            self.assertEqual(desktop.remote, self.REMOTE)
            self.assertEqual(cfg["remote"], self.REMOTE)

    def test_clearing_the_remote_returns_to_local_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = self._root(tmp)
            desktop = app.StudioDesktop("u", None, 8188, root, str(sys.executable),
                                        launcher={"root": str(root), "port": 8188, "remote": self.REMOTE})
            res, cfg = self._apply(desktop, root, "", "")
            self.assertTrue(res["ok"], res)
            self.assertEqual(desktop.remote, "")
            self.assertEqual(desktop.base, "http://127.0.0.1:8188")
            self.assertEqual(cfg["remote"], "")


class StartupStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / "ComfyUI"
        self.root.mkdir(parents=True)
        (self.root / "main.py").write_text("", encoding="utf-8")
        self.python = pathlib.Path(self.tmp.name) / "python.exe"
        self.python.write_text("", encoding="utf-8")
        self.plugin = app.plugin_dir_for(self.root)
        self.source = pathlib.Path(self.tmp.name) / "bundled" / "comfyui-neo-studio"
        (self.source / "web").mkdir(parents=True)
        (self.source / "requirements.txt").write_text("pyyaml\n", encoding="utf-8")
        self.patcher = patch.object(app, "PLUGIN_SOURCE_DIR", self.source)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def test_plugin_dir_derived_from_root(self):
        self.assertEqual(self.plugin, self.root / "custom_nodes" / "comfyui-neo-studio")

    def test_bad_root(self):
        st, msg = app.startup_state(self.root.parent, self.python, self.plugin)
        self.assertEqual(st, app.ST_BAD_ROOT)
        self.assertIn("main.py", msg)

    def test_missing_python(self):
        st, msg = app.startup_state(self.root, self.root / "nope.exe", self.plugin)
        self.assertEqual(st, app.ST_NO_PYTHON)
        self.assertIn(str(self.root / "nope.exe"), msg)

    def test_missing_plugin_installed_without_user_action(self):
        # 自动安装：用户不动手，内置副本落进 custom_nodes
        app.startup_state(self.root, self.python, self.plugin)
        self.assertTrue((self.plugin / "web").is_dir())
        self.assertTrue((self.plugin / "requirements.txt").is_file())

    def test_existing_plugin_syncs_code_and_keeps_user_files(self):
        # 源码运行（开发模式）：studio/ 每次同步进已装的副本，目标里的用户文件一样不删
        self.plugin.mkdir(parents=True)
        marker = self.plugin / "user-file.txt"
        marker.write_text("keep", encoding="utf-8")
        ok, msg = app.ensure_plugin(self.plugin, self.source)
        self.assertTrue(ok)
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
        self.assertTrue((self.plugin / "requirements.txt").is_file(), "开发模式同步代码进已装副本")

    def test_unwritable_custom_nodes_reports_the_path(self):
        self.plugin.parent.write_text("x", encoding="utf-8")   # custom_nodes 位置被文件占住
        ok, msg = app.ensure_plugin(self.plugin, self.source)
        self.assertFalse(ok)
        self.assertIn(str(self.plugin.parent), msg)
        st, _ = app.startup_state(self.root, self.python, self.plugin)
        self.assertEqual(st, app.ST_INSTALL_FAIL)

    def test_deps_safety_net_blocks_start(self):
        # 假解释器跑不出依赖探测：不启动 ComfyUI，给出可执行的 pip 命令
        st, msg = app.startup_state(self.root, self.python, self.plugin)
        self.assertEqual(st, app.ST_NO_DEPS)
        self.assertIn("pip install -r", msg)
        self.assertIn(str(self.plugin / "requirements.txt"), msg)

    def test_deps_probe_accepts_the_real_interpreter(self):
        # 真数据：跑测试的这个 ComfyUI 解释器必须过探测（ComfyUI 自带 yaml / Pillow / aiohttp）
        self.assertTrue(app.deps_ok(pathlib.Path(sys.executable)))

    def test_install_deps_needs_the_manifest(self):
        res = app.install_deps(self.python, self.root / "nope")
        self.assertFalse(res["ok"])
        self.assertIn("requirements.txt", res["error"])


class PluginUpdateTests(unittest.TestCase):
    """exe 内置副本比 custom_nodes 里那份新时的覆盖更新；git 检出不碰。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.tmp.name)
        self.plugin = self.base / "ComfyUI" / "custom_nodes" / "comfyui-neo-studio"
        self.source = self.base / "bundled" / "comfyui-neo-studio"
        (self.source / "web").mkdir(parents=True)
        self.state = self.base / "state"
        self.state.mkdir()
        self.patcher = patch.object(app, "STATE", self.state)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def _bundle(self, version):
        (self.source / "pyproject.toml").write_text(f'version = "{version}"\n', encoding="utf-8")

    def _installed(self, version):
        self.plugin.mkdir(parents=True, exist_ok=True)
        if version:
            (self.plugin / "pyproject.toml").write_text(f'version = "{version}"\n', encoding="utf-8")
        (self.plugin / "old-code.js").write_text("stale", encoding="utf-8")
        (self.plugin / "configs" / "skill_overrides").mkdir(parents=True, exist_ok=True)
        (self.plugin / "configs" / "llm_providers.json").write_text("{}", encoding="utf-8")
        custom = self.plugin / "skills" / "custom"
        custom.mkdir(parents=True, exist_ok=True)
        (custom / "mine.md").write_text("mine", encoding="utf-8")

    def _frozen(self):
        return patch.object(app, "IS_FROZEN", True)

    def test_newer_bundled_release_replaces_the_copy(self):
        self._bundle("1.2.0")
        self._installed("1.1.0")
        with self._frozen():
            ok, msg = app.ensure_plugin(self.plugin, self.source)
        self.assertTrue(ok, msg)
        self.assertTrue((self.plugin / "web").is_dir())
        self.assertFalse((self.plugin / "old-code.js").exists(), "代码文件按新副本换")
        # 用户数据归桌面端的数据根，不跟着插件副本走：覆盖更新只换代码
        self.assertFalse((self.plugin / "configs" / "llm_providers.json").exists())
        self.assertFalse((self.plugin / "skills" / "custom").exists())
        self.assertFalse((self.state / "plugin_old").exists())
        self.assertFalse((self.state / "plugin_update").exists())

    def test_install_leaves_a_data_pointer_for_the_kernel(self):
        # 用户不经桌面端自己起 ComfyUI 时，插件靠这份指针找到桌面端的数据根
        self._bundle("1.2.0")
        with self._frozen():
            ok, msg = app.ensure_plugin(self.plugin, self.source)
        self.assertTrue(ok, msg)
        cfg = json.loads((self.plugin / "configs" / "data_root.json").read_text(encoding="utf-8"))
        self.assertEqual(pathlib.Path(cfg["data_root"]), self.state.resolve())

    def test_copy_without_version_gets_the_release(self):
        # 旧版 exe 装的副本没有 pyproject.toml：顶栏报 unknown，就是靠这一步补上
        self._bundle("1.2.0")
        self._installed("")
        with self._frozen():
            ok, msg = app.ensure_plugin(self.plugin, self.source)
        self.assertTrue(ok, msg)
        self.assertEqual(app.pyproject_version(self.plugin), "1.2.0")

    def test_same_or_older_bundled_version_left_alone(self):
        self._bundle("1.2.0")
        self._installed("1.2.0")
        with self._frozen():
            app.ensure_plugin(self.plugin, self.source)
        self.assertTrue((self.plugin / "old-code.js").exists())
        self.assertFalse((self.plugin / "web").exists())
        self._installed("1.3.0")
        with self._frozen():
            app.ensure_plugin(self.plugin, self.source)
        self.assertFalse((self.plugin / "web").exists(), "已装的比内置的新：不降级")

    def test_git_checkout_left_alone(self):
        # git 检出归 ComfyUI-Manager 与用户自己更新
        self._bundle("1.2.0")
        self._installed("1.0.0")
        (self.plugin / ".git").mkdir()
        with self._frozen():
            app.ensure_plugin(self.plugin, self.source)
        self.assertFalse((self.plugin / "web").exists())

    def test_source_run_syncs_the_installed_copy(self):
        # 开发模式：studio/ 就是插件本身，每次启动同步进已装副本，版本比较不参与
        self._bundle("1.2.0")
        self._installed("1.0.0")
        (self.source / "web" / "index.html").write_text("new", encoding="utf-8")
        app.ensure_plugin(self.plugin, self.source)
        self.assertEqual((self.plugin / "web" / "index.html").read_text(encoding="utf-8"), "new")
        self.assertTrue((self.plugin / "old-code.js").exists(), "同步从不删除目标目录里的文件")
        self.assertTrue((self.plugin / "skills" / "custom" / "mine.md").exists())

    def test_locked_plugin_dir_keeps_the_old_copy(self):
        # ComfyUI 正在跑时目录被占用：换目录失败就原样留着，下次启动再更新
        self._bundle("1.2.0")
        self._installed("1.0.0")
        with self._frozen(), patch.object(app.shutil, "move", side_effect=OSError("占用")):
            ok, msg = app.ensure_plugin(self.plugin, self.source)
        self.assertTrue(ok)
        self.assertEqual("", msg)
        self.assertTrue((self.plugin / "old-code.js").exists())
        self.assertFalse((self.plugin / "web").exists())



class PluginSyncTests(unittest.TestCase):
    """源码运行时的同步：只覆盖同名代码，目标目录里的东西一样不删。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.tmp.name)
        self.source = self.base / "studio"
        self.plugin = self.base / "ComfyUI" / "custom_nodes" / "comfyui-neo-studio"
        for rel in ("web/studio", "tests", "__pycache__", "data", "configs"):
            (self.source / rel).mkdir(parents=True)
        # 源文件比目标长一档：NTFS 的修改时间粒度是 10ms，同为 3 字节的两份在同一 tick 里
        # 写出来时大小与 mtime 全对得上，同步会跳过那一个，用例就在「old」上红
        (self.source / "web" / "studio" / "index.html").write_text("new-code", encoding="utf-8")
        (self.source / "pyproject.toml").write_text('version = "1.2.0"\n', encoding="utf-8")
        (self.source / "configs" / "laya_config.json").write_text("{}", encoding="utf-8")
        (self.source / "tests" / "test_x.py").write_text("x", encoding="utf-8")
        (self.source / "__pycache__" / "a.pyc").write_text("x", encoding="utf-8")
        (self.source / "data" / "run.json").write_text("{}", encoding="utf-8")
        self.plugin.mkdir(parents=True)
        (self.plugin / "web" / "studio").mkdir(parents=True)
        (self.plugin / "web" / "studio" / "index.html").write_text("old", encoding="utf-8")
        (self.plugin / "configs").mkdir()
        (self.plugin / "configs" / "gallery_settings.json").write_text("user", encoding="utf-8")
        (self.plugin / "extra.js").write_text("keep", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def _index(self) -> pathlib.Path:
        return self.plugin / "web" / "studio" / "index.html"

    def test_changed_code_lands_and_target_only_files_survive(self):
        self.assertGreater(app.sync_plugin(self.plugin, self.source), 0)
        self.assertEqual(self._index().read_text(encoding="utf-8"), "new-code")
        self.assertEqual((self.plugin / "extra.js").read_text(encoding="utf-8"), "keep")
        self.assertEqual((self.plugin / "configs" / "gallery_settings.json").read_text(encoding="utf-8"), "user")

    def test_second_sync_copies_nothing(self):
        app.sync_plugin(self.plugin, self.source)
        mtime = self._index().stat().st_mtime_ns
        self.assertEqual(app.sync_plugin(self.plugin, self.source), 0)
        self.assertEqual(self._index().stat().st_mtime_ns, mtime)

    def test_dev_only_dirs_stay_out(self):
        app.sync_plugin(self.plugin, self.source)
        self.assertFalse((self.plugin / "tests").exists())
        self.assertFalse((self.plugin / "__pycache__").exists())
        self.assertFalse((self.plugin / "data").exists())

    def test_locked_file_is_skipped_without_raising(self):
        # ComfyUI 正在跑、文件被占用：跳过那一个，下次启动再补，同步不能抛
        with patch.object(app.shutil, "copy2", side_effect=OSError("占用")):
            self.assertEqual(app.sync_plugin(self.plugin, self.source), 0)
        self.assertEqual(self._index().read_text(encoding="utf-8"), "old")

    def test_git_checkout_is_not_synced(self):
        # git 检出归 ComfyUI-Manager 与用户自己更新
        (self.plugin / ".git").mkdir()
        ok, msg = app.ensure_plugin(self.plugin, self.source)
        self.assertTrue(ok, msg)
        self.assertEqual(self._index().read_text(encoding="utf-8"), "old")


# git 取数在导入期完成：跑完窗口几何那批用例后，进程里的子进程会全部启动即没
# （git 与 python -c 一样返回 0xC000013A），在测试执行期调 git 只能读到空输出。
_TRACKED_CONFIGS = frozenset(subprocess.run(
    ["git", "-C", str(_PLUGIN_DIR), "ls-files", "configs"], capture_output=True, text=True).stdout.split())
_IGNORED_CONFIGS = frozenset(
    f"configs/{name}" for name in
    ("remote_llm_config.json", "backyard_oss.json", "model_hub.json", "video_gen.json",
     "image_gen.json", "gallery_settings.json", "bookmarks.json", "gallery_dim_cache.json")
    if subprocess.run(["git", "-C", str(_PLUGIN_DIR), "check-ignore", "-q", f"configs/{name}"],
                      capture_output=True).returncode == 0)


class EmbeddedConfigsTests(unittest.TestCase):
    """进包的 configs 只能是预设：用户配置与密钥不进包，也不覆盖用户已有文件。"""

    PRESETS = {"laya_config.json", "llm_providers.json", "model_registry.json", "oss_presets.json"}
    USER_FILES = ("remote_llm_config.json", "backyard_oss.json", "model_hub.json", "video_gen.json",
                  "image_gen.json", "gallery_settings.json", "bookmarks.json", "gallery_dim_cache.json")

    def test_tracked_configs_are_presets_only(self):
        self.assertEqual(_TRACKED_CONFIGS, {f"configs/{n}" for n in self.PRESETS})

    def test_user_configs_are_ignored(self):
        self.assertEqual(_IGNORED_CONFIGS, {f"configs/{n}" for n in self.USER_FILES})

    def test_exe_bundle_takes_tracked_files_only(self):
        # 内置副本的边界就是「git 已跟踪」：用户配置与密钥不在跟踪列表里，进不了 exe
        script = (_REPO_ROOT / "tools" / "build_studio_exe.ps1").read_text(encoding="utf-8")
        self.assertIn("git ls-files", script)
        self.assertIn("bundled/comfyui-neo-studio", script)
        # 分发形态两种都给：单文件与目录版（目录版启动不解包）
        self.assertIn("onedir", script)
        self.assertIn("tools/neo-studio", script)
        spec = (_REPO_ROOT / "tools" / "Neo-Studio.spec").read_text(encoding="utf-8")
        self.assertIn("bundled/comfyui-neo-studio", spec)
        # 副本必须带 pyproject.toml：插件版本号只从它读，缺了顶栏就是「Neo Studio unknown」
        self.assertNotIn("pyproject", script, "内置副本不该排除 pyproject.toml")
        for name in self.USER_FILES:
            self.assertNotIn(name, spec, f"打包配置不该提到 {name}")


if __name__ == "__main__":
    unittest.main()
