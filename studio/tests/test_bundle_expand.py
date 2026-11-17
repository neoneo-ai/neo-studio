# SPDX-License-Identifier: Apache-2.0
"""NeoBundleExpand 节点离线单测：把 NeoPromptAgent 的 BUNDLE 展开成 prompt + image。

不依赖 ComfyUI 运行中的服务器与真实模型：server/comfy/folder_paths/nodes 用桩模块替换；
复用 image_gen_files._read_image_raw 解析 data URI 参考图，验证接口形状、prompt 回退、
参考图还原成 IMAGE 张量、无参考图/无效 bundle 的降级行为。"""

from stub_env import NODE_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(NODE_STUB_PREFIXES)

import base64
import importlib.util
import io as _io
import os
import sys
import tempfile
import types
import unittest

import numpy as np
import torch

_TMP = tempfile.mkdtemp(prefix="neo_bundle_expand_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

_comfy = types.ModuleType("comfy")
_comfy_cli = types.ModuleType("comfy.cli_args")
_comfy_cli.args = types.SimpleNamespace(listen="127.0.0.1", port=8188, tls_keyfile=None, tls_certfile=None)
_comfy_cli.LatentPreviewMethod = types.SimpleNamespace(NoPreviews="none", Auto="auto", Latent2RGB="latent2rgb", TAESD="taesd")
sys.modules["comfy"] = _comfy
sys.modules["comfy.cli_args"] = _comfy_cli
_comfy_pe = types.ModuleType("comfy.patcher_extension")
_comfy_pe.WrappersMP = types.SimpleNamespace(DIFFUSION_MODEL="DIFFUSION_MODEL")
_comfy_pe.add_wrapper_with_key = lambda *a, **k: None
sys.modules["comfy.patcher_extension"] = _comfy_pe
_comfy_utils = types.ModuleType("comfy.utils")
_comfy_utils.common_upscale = lambda *a, **k: None
sys.modules["comfy.utils"] = _comfy_utils
_comfy_common_dit = types.ModuleType("comfy.ldm.common_dit")
_comfy_common_dit.pad_to_patch_size = lambda *a, **k: None
sys.modules["comfy.ldm.common_dit"] = _comfy_common_dit
_comfy_flux_layers = types.ModuleType("comfy.ldm.flux.layers")
_comfy_flux_layers.timestep_embedding = lambda *a, **k: None
for _name in ("comfy.ldm", "comfy.ldm.flux"):
    sys.modules.setdefault(_name, types.ModuleType(_name))
sys.modules["comfy.ldm.flux.layers"] = _comfy_flux_layers

_comfy_exec = types.ModuleType("comfy_execution")
_comfy_exec_prog = types.ModuleType("comfy_execution.progress")


class _ProgressHandler:
    def __init__(self, name):
        self.name = name
        self.enabled = True


class _ProgressRegistry:
    prompt_id = ""
    nodes = {}
    handlers = {}


_progress_registry = _ProgressRegistry()
_comfy_exec_prog.ProgressHandler = _ProgressHandler
_comfy_exec_prog.get_progress_state = lambda: _progress_registry
_comfy_exec_prog.add_progress_handler = lambda h: _progress_registry.handlers.__setitem__(h.name, h)
_comfy_exec_prog.get_progress_state = lambda: types.SimpleNamespace(prompt_id="", nodes={})
sys.modules["comfy_execution"] = _comfy_exec
sys.modules["comfy_execution.progress"] = _comfy_exec_prog

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: []
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
sys.modules["folder_paths"] = _folder_paths

_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
_nodes.MAX_RESOLUTION = 8192
sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

_PKG = "_neo_bundle_expand_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


bundles = _load("bundles", "bundles.py")
_load("skill", "skill.py")
_load("image_gen", "image_gen.py")
prompts = _load("prompts", "prompts.py")
bundle_expand = _load("bundle_expand", "bundle_expand.py")


def _png_data_uri(w=8, h=6):
    """造一张 w×h 的 PNG data URI，作为 bundle reference（与 NeoPromptAgent 产出同构）。"""
    from PIL import Image
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:, :, 0] = 255  # 纯红，便于断言还原后的张量值
    buf = _io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


class NeoBundleExpandTests(unittest.TestCase):
    def setUp(self):
        bundles._registry.clear()

    def _expand(self, bid):
        return bundle_expand.NeoBundleExpand().expand(bundle=bid)

    def test_input_and_return_types(self):
        spec = bundle_expand.NeoBundleExpand.INPUT_TYPES()
        decl = spec["required"]["bundle"]
        self.assertEqual(decl[0], "STRING")
        self.assertTrue(decl[1]["forceInput"])
        self.assertTrue(decl[1]["tooltip"].strip())   # BUNDLE 连线槽带输入提示词
        n = bundle_expand.MAX_BUNDLE_REFERENCES
        self.assertEqual(n, 9)
        self.assertEqual(bundle_expand.NeoBundleExpand.RETURN_TYPES, ("STRING",) + ("IMAGE",) * n)
        self.assertEqual(bundle_expand.NeoBundleExpand.RETURN_NAMES, ("prompt",) + tuple(f"image_{i}" for i in range(1, n + 1)))
        self.assertEqual(len(bundle_expand.NeoBundleExpand.OUTPUT_TOOLTIPS), n + 1)

    def test_expands_prompt_and_reference_image(self):
        bid = bundles.create_bundle({
            "prompts": ["  a cat walking  ", "second"],
            "references": [{"kind": "data", "data": _png_data_uri(8, 6)}],
            "gen_type": "", "skill_id": "",
        })
        out = self._expand(bid)
        prompt, image1 = out["result"][0], out["result"][1]
        self.assertEqual(prompt, "a cat walking")
        self.assertIsInstance(image1, torch.Tensor)
        self.assertEqual(tuple(image1.shape), (1, 6, 8, 3))
        self.assertTrue(torch.all((image1 >= 0) & (image1 <= 1)))
        # 纯红参考图：R≈1，G/B≈0
        self.assertGreater(image1[0, 0, 0, 0].item(), 0.99)
        self.assertLess(image1[0, 0, 0, 1].item(), 0.01)
        # ui payload：提示词（列表，核心展平约定）+ 缩略图 data URI（供节点内展示）
        self.assertEqual(out["ui"]["prompt"], ["a cat walking"])
        self.assertEqual(len(out["ui"]["images"]), 1)
        self.assertTrue(out["ui"]["images"][0].startswith("data:image/png;base64,"))

    def test_multi_reference_fills_slots_in_order(self):
        bid = bundles.create_bundle({
            "prompts": ["p"],
            "references": [
                {"kind": "data", "data": _png_data_uri(8, 6)},   # image_1
                {"kind": "data", "data": _png_data_uri(4, 3)},    # image_2
            ],
            "gen_type": "", "skill_id": "",
        })
        out = self._expand(bid)
        result = out["result"]
        self.assertEqual(tuple(result[1].shape), (1, 6, 8, 3))   # image_1
        self.assertEqual(tuple(result[2].shape), (1, 3, 4, 3))   # image_2
        self.assertEqual(result[3].shape[0], 0)                  # image_3 未用 → 空批次占位
        self.assertEqual(len(out["ui"]["images"]), 2)

    def test_no_reference_yields_empty_image(self):
        bid = bundles.create_bundle({"prompts": ["p"], "references": [], "gen_type": "", "skill_id": ""})
        out = self._expand(bid)
        prompt, image1 = out["result"][0], out["result"][1]
        self.assertEqual(prompt, "p")
        self.assertEqual(image1.shape[0], 0)
        self.assertEqual(out["ui"]["images"], [])

    def test_missing_bundle_degrades_to_empty(self):
        out = self._expand("bnd_does_not_exist")
        prompt, image1 = out["result"][0], out["result"][1]
        self.assertEqual(prompt, "")
        self.assertEqual(image1.shape[0], 0)

    def test_bad_reference_leaves_slot_empty(self):
        bid = bundles.create_bundle({
            "prompts": ["p"],
            "references": [
                {"kind": "data", "data": "data:image/png;base64,!!not-base64!!"},  # 坏参考，槽位 1 空
                {"kind": "data", "data": _png_data_uri(4, 3)},                       # 好参考落到槽位 2
            ],
            "gen_type": "", "skill_id": "",
        })
        out = self._expand(bid)
        result = out["result"]
        self.assertEqual(result[1].shape[0], 0)                    # image_1 空（坏参考跳过）
        self.assertEqual(tuple(result[2].shape), (1, 3, 4, 3))     # image_2 = 好参考
        # ui 缩略图与输出槽位对齐：坏参考(image_1)为 None，好参考(image_2)保留 data URI
        self.assertIsNone(out["ui"]["images"][0])
        self.assertTrue(out["ui"]["images"][1].startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()

restore(NODE_STUB_PREFIXES, _STUB_SAVED)
