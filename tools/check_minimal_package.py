#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""最小整合包自检：预设要的节点在包里有没有、包干不干净。

两种模式：
  --comfyui <ComfyUI 根> --studio <Neo-Studio 根> [--custom-nodes <目录>]
      只核对节点可满足性（构建前拿它反推缺哪些插件）。
  --package <整合包根>
      整包体检：布局与启动文件、空 models、随包配置里的开发机盘符、密钥文件、
      comfyui-krea2edit 痕迹，外加节点可满足性。
用法（仓库根运行）:
  python tools/check_minimal_package.py --package <package root>
  python tools/check_minimal_package.py --comfyui <ComfyUI root> --studio <repo root>/studio
"""

import argparse
import json
import os
import re
import subprocess
import sys

# 节点注册表：老式是 NODE_CLASS_MAPPINGS 字典（键在行尾闭合的也有），
# 0.42 起核心与新插件走 io.ComfyNode 的 node_id="..." 声明，注册名以它为准。
_MAP_BLOCK = re.compile(r"NODE_CLASS_MAPPINGS[^=]{0,60}=\s*\{(.*?)\}", re.S)
_MAP_KEY = re.compile(r"[\"']([A-Za-z_][A-Za-z0-9_ .]*)[\"']\s*:")
_NODE_ID = re.compile(r"node_id\s*=\s*[\"']([A-Za-z_][A-Za-z0-9_ .]*)[\"']")
# 随包配置与启动文件里不该出现的开发机盘符：单个字母加冒号加斜杠，http:// 这种不算
_DRIVE_PATH = re.compile(r"\b[A-Za-z]:[\\/]{1,2}[^\s\"']*")
# 随包不该带的密钥文件（AGENTS: Data, Config, and Secrets）
SECRET_FILES = ("remote_llm_config.json", "backyard_oss.json")
# 整合包不含的插件与节点前缀：comfyui-krea2edit
EXCLUDED_PLUGIN = "krea2edit"


def _json(path):
    """读一个 JSON：Windows 上写过的文件常带 UTF-8 BOM，utf-8-sig 两种都吃。"""
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def _py_files(root):
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git", ".venv", "node_modules",
                                               "examples", "docs")]
        for name in names:
            if name.endswith(".py"):
                yield os.path.join(dirpath, name)


def mapping_keys(path):
    """一个 .py 里注册出去的节点名：NODE_CLASS_MAPPINGS 的键 + io.ComfyNode 的 node_id。

    字典里嵌了字典的插件会截在第一个 `}`（这类注册表罕见），漏掉的由清单里的
    nodes 字段兜底核对。
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return set()
    keys = set()
    for block in _MAP_BLOCK.findall(text):
        keys.update(_MAP_KEY.findall(block))
    keys.update(_NODE_ID.findall(text))
    return keys


def provided_nodes(comfyui, custom_nodes):
    """内核与 custom_nodes 提供的节点名，值是提供它的目录名（内核记 <core>）。"""
    provided = {}
    core_files = [os.path.join(comfyui, "nodes.py")]
    extras = os.path.join(comfyui, "comfy_extras")
    if os.path.isdir(extras):
        core_files.extend(_py_files(extras))
    for path in core_files:
        for name in mapping_keys(path):
            provided.setdefault(name, "<core>")
    silent = []
    if os.path.isdir(custom_nodes):
        for plugin in sorted(os.listdir(custom_nodes)):
            base = os.path.join(custom_nodes, plugin)
            if not os.path.isdir(base) or plugin.endswith(".disabled"):
                continue
            found = set()
            for path in _py_files(base):
                found.update(mapping_keys(path))
            if not found:
                silent.append(plugin)   # 块外注册（registry.map_node 那类），本脚本判不出
            for name in found:
                provided.setdefault(name, plugin)
    return provided, silent


def required_nodes(studio):
    """内置技能（预设 + 任务）工作流用到的 class_type，值是用到它的技能 id。"""
    required = {}
    for group in ("presets", "tasks"):
        base = os.path.join(studio, "skills", group)
        if not os.path.isdir(base):
            continue
        for sid in sorted(os.listdir(base)):
            wf = os.path.join(base, sid, "workflow.json")
            if not os.path.isfile(wf):
                continue
            graph = _json(wf)
            for node in graph.values():
                if isinstance(node, dict) and node.get("class_type"):
                    required.setdefault(node["class_type"], set()).add(sid)
    return required


def check_nodes(comfyui, studio, custom_nodes, report):
    provided, silent = provided_nodes(comfyui, custom_nodes)
    required = required_nodes(studio)
    if not provided:
        report.fail(f"没从 {comfyui} 抓到任何内核节点定义")
        return
    missing = {n: s for n, s in required.items() if n not in provided}
    by_owner = {}
    for name, owner in provided.items():
        if name in required:
            by_owner.setdefault(owner, []).append(name)
    report.info(f"内置技能用到 {len(required)} 个节点，可提供 {len(required) - len(missing)} 个")
    for owner in sorted(by_owner, key=lambda o: (o != "<core>", o)):
        names = sorted(by_owner[owner])
        head = ", ".join(names[:6]) + (" ..." if len(names) > 6 else "")
        report.info(f"  {owner:34s} {len(names):3d}  {head}")
    if silent:
        report.info(f"  扫不到注册表的目录: {', '.join(silent)}")
    manifest = os.path.join(os.path.dirname(studio), "tools", "minimal_plugins.json")
    if os.path.isfile(manifest):
        pins = _json(manifest)
        for plugin in pins["required"]:
            present = os.path.isdir(os.path.join(custom_nodes, plugin["name"]))
            (report.ok(f"插件在位 {plugin['name']}") if present
             else report.fail(f"缺插件 {plugin['name']}（清单要求）"))
            for node in plugin["nodes"]:
                if node in required and node not in provided:
                    report.fail(f"{plugin['name']} 未提供技能要用的 {node}")
        report.ok(f"插件清单 {os.path.basename(manifest)} 已核对")
    for name in sorted(missing):
        report.fail(f"缺节点 {name}（用在 {', '.join(sorted(missing[name]))}）")


def check_package(package, report):
    comfyui = os.path.join(package, "ComfyUI")
    studio = os.path.join(package, "Neo-Studio")
    launcher = "NeoStudio.vbs"
    targets = (
        (f"{launcher}", os.path.isfile(os.path.join(package, launcher))),
        ("ComfyUI/main.py", os.path.isfile(os.path.join(comfyui, "main.py"))),
        ("Neo-Studio/app/studio_app.py", os.path.isfile(os.path.join(studio, "app", "studio_app.py"))),
        ("Neo-Studio/studio/__init__.py", os.path.isfile(os.path.join(studio, "studio", "__init__.py"))),
        ("Neo-Studio/neo-studio-app.vbs", os.path.isfile(os.path.join(studio, "neo-studio-app.vbs"))),
        ("Neo-Studio/neo-studio.ps1", os.path.isfile(os.path.join(studio, "neo-studio.ps1"))),
        ("Neo-Studio/tools/install_plugin.ps1", os.path.isfile(os.path.join(studio, "tools", "install_plugin.ps1"))),
    )
    for rel, exists in targets:
        (report.ok(rel) if exists else report.fail(f"缺 {rel}"))

    pythonw = os.path.isfile(os.path.join(package, "python", "pythonw.exe"))
    link = os.path.join(package, "python.link.txt")
    if pythonw:
        report.ok("python/pythonw.exe 在位")
    elif os.path.isfile(link):
        report.ok(f"python/ 是指向外部可移植 Python 的链接，见 {os.path.basename(link)}")
    else:
        report.fail("python/ 既没复制也不是链接（启动器找不到 pythonw.exe）")

    models = os.path.join(comfyui, "models")
    found = [os.path.join(dp, n) for dp, _, ns in os.walk(models) for n in ns if n != ".keep"]
    if not os.path.isdir(models):
        report.fail("缺 models/ 目录树")
    elif found:
        size = sum(os.path.getsize(p) for p in found)
        report.fail(f"models/ 里有 {len(found)} 个文件 / {size / 1024 / 1024:.1f}MB（整合包不随包发模型）")
    else:
        report.ok("models/ 只有空目录树")

    pointer = os.path.join(comfyui, "custom_nodes", "comfyui-neo-studio", "configs", "data_root.json")
    if os.path.isfile(pointer):
        root = _json(pointer).get("data_root", "")
        (report.ok(f"data_root 指针落在包内: {root}") if root.lower().startswith(package.lower())
         else report.fail(f"data_root 指针指向包外: {root}"))
    else:
        report.ok("没有 data_root 指针（首次启动自建 Neo-Studio/data）")

    scan = [os.path.join(comfyui, "extra_model_paths.yaml"),
            os.path.join(package, launcher),
            os.path.join(package, "NeoStudio.bat")]
    scan += [os.path.join(studio, n) for n in ("neo-studio.bat", "neo-studio.ps1", "neo-studio-app.vbs")]
    for path in scan:
        if not os.path.isfile(path):
            continue
        rel = os.path.relpath(path, package)
        with open(path, encoding="utf-8", errors="replace") as f:
            hits = [ln.strip() for ln in f if _DRIVE_PATH.search(ln)]
        (report.fail(f"{rel} 带盘符路径: {hits[0]}") if hits else report.ok(f"{rel} 无盘符路径"))

    for dirpath, dirs, names in os.walk(package):
        for name in names:
            if name in SECRET_FILES:
                report.fail(f"随包带了密钥文件: {os.path.join(dirpath, name)}")
        for name in dirs:
            if EXCLUDED_PLUGIN in name.lower() and not name.endswith(".disabled"):
                report.fail(f"随包带了被排除的插件目录: {os.path.join(dirpath, name)}")
    report.ok("密钥文件与 comfyui-krea2edit 痕迹：无")

    manifest = os.path.join(studio, "tools", "minimal_plugins.json")
    if os.path.isfile(manifest):
        check_plugin_imports(package, _json(manifest)["required"], report)


_SMOKE_CODE = """import importlib, json, sys
plan = json.loads(sys.argv[1])
for name, mods in plan.items():
    for mod in mods:
        try:
            importlib.import_module(mod)
            print("OK", name, mod)
        except Exception as exc:
            print("ERR", name, mod, type(exc).__name__ + ": " + str(exc)[:90])
"""


def check_plugin_imports(package, plugins, report):
    """插件依赖在包内 Python 里 import 得出吗：预装漏没漏，一次 import 就见底。

    清单里 import_notes 点过名的模块不跑（当前 numpy 版本下必然失败，原因由清单说清）。
    """
    plan = {p["name"]: [m for m in p.get("import_smoke", []) if m not in p.get("import_notes", {})]
            for p in plugins}
    plan = {k: v for k, v in plan.items() if v}
    for plugin in plugins:
        for mod, note in plugin.get("import_notes", {}).items():
            report.info(f"  {plugin['name']} {mod}: {note}")
    if not plan:
        return
    py = os.path.join(package, "python", "python.exe")
    if not os.path.isfile(py):
        report.info("  包内没有 python/python.exe，插件依赖未核对")
        return
    try:
        out = subprocess.run([py, "-c", _SMOKE_CODE, json.dumps(plan)], capture_output=True,
                             text=True, encoding="utf-8", errors="replace", timeout=900)
    except (OSError, subprocess.SubprocessError) as exc:
        report.fail(f"插件依赖 import 跑不起来: {exc}")
        return
    done = {}
    for line in out.stdout.splitlines():
        parts = line.split(" ", 2)
        if len(parts) < 3 or parts[0] not in ("OK", "ERR"):
            continue
        status, plugin, rest = parts[0], parts[1], parts[2]
        done.setdefault(plugin, []).append((status, rest))
        if status == "ERR":
            report.fail(f"{plugin} 依赖 import 失败: {rest}")
    for plugin, results in sorted(done.items()):
        failed = [r for s, r in results if s == "ERR"]
        if not failed:
            report.ok(f"{plugin} 依赖 import 通过（{len(results)} 个模块）")
    smoke_plugins = set(plan)
    for plugin in sorted(smoke_plugins - set(done)):
        report.fail(f"{plugin} 依赖 import 没跑完（包内 python 起不来或被中断）")


class Report:
    def __init__(self):
        self.lines = []
        self.oks = []
        self.failed = []

    def ok(self, msg):
        self.oks.append(msg)
        self.lines.append(f"[OK]   {msg}")
        return self

    def fail(self, msg):
        self.failed.append(msg)
        self.lines.append(f"[FAIL] {msg}")
        return self

    def info(self, msg):
        self.lines.append(msg)


def main():
    ap = argparse.ArgumentParser(description="最小整合包自检")
    ap.add_argument("--package", help="整合包根：整包体检")
    ap.add_argument("--comfyui", help="ComfyUI 根：只核对节点可满足性")
    ap.add_argument("--studio", help="Neo-Studio 根（含 studio/ 插件源码）")
    ap.add_argument("--custom-nodes", help="custom_nodes 目录，默认 <comfyui>/custom_nodes")
    args = ap.parse_args()
    if not (args.package or (args.comfyui and args.studio)):
        ap.error("需要 --package，或 --comfyui 加 --studio")

    package = os.path.abspath(args.package) if args.package else None
    comfyui = os.path.abspath(args.comfyui or os.path.join(package, "ComfyUI"))
    # 整包模式下插件源码在 Neo-Studio/studio，技能预设与 tools 清单都在它周围
    studio = os.path.abspath(args.studio or os.path.join(package, "Neo-Studio", "studio"))
    custom_nodes = os.path.abspath(args.custom_nodes or os.path.join(comfyui, "custom_nodes"))
    if not os.path.isdir(comfyui) or not os.path.isdir(studio):
        print(f"[FAIL] 路径不存在: {comfyui} / {studio}")
        return 2

    report = Report()
    if package:
        check_package(package, report)
    check_nodes(comfyui, studio, custom_nodes, report)
    for line in report.lines:
        print(line)
    tag = "整包体检" if package else "源码核对"
    print(f"[{'PASS' if not report.failed else 'FAIL'}] {tag}：{len(report.oks)} 项通过，{len(report.failed)} 项失败")
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())

