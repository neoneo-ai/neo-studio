# SPDX-License-Identifier: Apache-2.0
"""离线单测的 comfy_api 引导：把 ComfyUI 根目录加进 sys.path，并补齐 comfy_api.latest 的导入期依赖。

V3 节点（image_gen_edit.py 的 NeoImageGenEdit）导入时会执行 `from comfy_api.latest import io`，
因此在把 comfy / comfy_execution 桩掉的测试环境里，也要先给 comfy_api 备好它需要的子模块占位。
"""

import os
import sys
import types


def _stub_module(name: str) -> None:
    """在 sys.modules 里补一个空壳模块，连带补齐它的父包链。"""
    parts = name.split(".")
    for cut in range(1, len(parts)):
        parent = ".".join(parts[:cut])
        if parent not in sys.modules:
            pkg = types.ModuleType(parent)
            pkg.__path__ = []
            sys.modules[parent] = pkg
    if name in sys.modules:
        return
    mod = types.ModuleType(name)
    setattr(sys.modules[".".join(parts[:-1])], parts[-1], mod)
    sys.modules[name] = mod


def _drop_stub(root: str) -> None:
    """删掉别的测试模块留下的假 comfy_api（无 __file__ 的替身），让真实包可导入。"""
    mod = sys.modules.get(root)
    if mod is None or getattr(mod, "__file__", None) is not None:
        return
    for key in [k for k in sys.modules if k == root or k.startswith(root + ".")]:
        del sys.modules[key]


def _comfy_root(plugin_dir: str) -> str:
    """插件在 ComfyUI/custom_nodes 下时根是它的上两级；独立仓库里内核与 studio/ 并排摆放。"""
    above = os.path.dirname(os.path.dirname(plugin_dir))
    for cand in (above, os.path.join(above, "ComfyUI")):
        if os.path.isdir(os.path.join(cand, "comfy_api", "latest")):
            return cand
    return above


def comfy_root() -> str:
    """内核根目录：本模块在 studio/tests 下，插件目录就是它的父目录。"""
    return _comfy_root(os.path.dirname(os.path.dirname(__file__)))


def comfy_file(*parts: str) -> str:
    """内核根目录下的真实文件：离线测试拿核心源码当桩蓝本时用（本模块在 studio/tests 下）。"""
    return os.path.join(comfy_root(), *parts)


def bootstrap(plugin_dir: str) -> None:
    """让 comfy_api 可在离线测试里导入（须在 _load 插件模块前调用）。"""
    root = _comfy_root(plugin_dir)
    if root not in sys.path:
        sys.path.insert(0, root)
    _drop_stub("comfy_api")
    comfy = sys.modules.get("comfy")
    if comfy is not None and getattr(comfy, "__file__", None) is None:
        # 2026-11 起内核的 comfy_api/latest/_input_impl/video_types.py 在模块作用域
        # import comfy.memory_management，而离线桩的 comfy 是无 __path__ 的 ModuleType：子模块
        # 连磁盘查找都到不了，收集期直接 ImportError，CI 的 Kernel plugin tests 整步 exit 2
        # 就是这么来的（本机钉的内核还没有那行 import，所以本地绿、CI 恒红）。
        # 只桩这一个新导入点，别把内核内存模块拉起来：它经 comfy.quant_ops 会带出真
        # comfy.model_management，顶掉测试自己注册的桩位，clear_memory_route 那类走
        # `comfy.model_management.xxx()` 的用例 patch 就落空了。
        _stub_module("comfy.memory_management")
    if "comfy_execution.utils" not in sys.modules:
        mod = types.ModuleType("comfy_execution.utils")
        mod.get_executing_context = lambda: None
        sys.modules["comfy_execution.utils"] = mod
    if "comfy_execution.graph_utils" not in sys.modules:
        mod = types.ModuleType("comfy_execution.graph_utils")
        mod.ExecutionBlocker = type("ExecutionBlocker", (), {})
        sys.modules["comfy_execution.graph_utils"] = mod
    progress = sys.modules.get("comfy_execution.progress")
    if progress is not None and not hasattr(progress, "PreviewImageTuple"):
        progress.PreviewImageTuple = tuple
