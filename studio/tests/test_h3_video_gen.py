# SPDX-License-Identifier: Apache-2.0
"""h3_video_gen 的离线单测：mini-executor 的 V3 API 节点分支、{{LENGTH}} 占位符、
视频参数解析、gen_video 技能过滤。

不依赖 ComfyUI 运行中的服务器与真实 H3 模型：server/comfy/folder_paths/nodes 用桩模块替换，
API 节点分支用带 define_schema + classmethod execute（返回 NodeOutput(.args)）的假节点验证。"""

from stub_env import NODE_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(NODE_STUB_PREFIXES)

import base64
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest

import torch
from PIL import Image as _PILImage

_TMP = tempfile.mkdtemp(prefix="neo_h3vidgen_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_MODELS = {
    "diffusion_models": ["krea2/krea2_turbo_fp16.safetensors",
                         "minimax_h3_fl2va_pruned_int8_convrot.safetensors"],
    "text_encoders": ["qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors",
                      "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
    "vae": ["krea2/diffusion_pytorch_model.safetensors", "minimax_h3_video_vae_fp16.safetensors",
            "minimax_h3_audio_vae_fp32.safetensors"],
    "loras": ["h3/style_lora.safetensors"],
    # 特效嵌入 = Comfy-Org/MiniMax-H3 那 10 个社区嵌入文件；桩环境按这台机器的现状少 fire_breath 一个
    "embeddings": ["minimaxh3_art_is_explosion.safetensors", "minimaxh3_blooming_flowers.safetensors",
                   "minimaxh3_bullet_time.safetensors", "minimaxh3_dark_magic.safetensors",
                   "minimaxh3_four_seasons.safetensors", "minimaxh3_kiss_camera.safetensors",
                   "minimaxh3_spiral_ascent.safetensors", "minimaxh3_storm_magic.safetensors",
                   "minimaxh3_truman_show.safetensors"],
}

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
sys.modules["comfy.audio"] = types.ModuleType("comfy.audio")
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
_folder_paths.get_filename_list = lambda folder: list(_MODELS.get(folder, []))
_folder_paths.get_full_path = lambda folder, name: None   # 桩环境没有真实模型文件 → mtimes 为空
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
sys.modules["folder_paths"] = _folder_paths

_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
_nodes.MAX_RESOLUTION = 8192
sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)
# V3 节点（image_gen_edit）导入期要 comfy_api.latest：先备好 ComfyUI 根目录与占位子模块
import _comfy_api_bootstrap  # noqa: E402
_comfy_api_bootstrap.bootstrap(PLUGIN_DIR)

_PKG = "_neo_h3vidgen_pkg"
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


_load("skill", "skill.py")
_load("skill_models", "skill_models.py")   # h3_video_gen 在 import 期就要把它的 folder_paths 绑到本文件的桩上
_load("image_gen", "image_gen.py")
image_gen_edit = _load("image_gen_edit", "image_gen_edit.py")
h3_video_gen = _load("h3_video_gen", "h3_video_gen.py")
video_gen = _load("video_gen", "video_gen.py")


# ---- V3 API 节点假实现：define_schema + classmethod execute，返回 NodeOutput(.args) ----
class _FakeNodeOutput:
    def __init__(self, *args):
        self.args = args


def _data_uri(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


class _ApiSingle:
    """单 IMAGE 输出的 API 节点；execute 把标量 value 广播成张量。"""

    RETURN_TYPES = ("IMAGE",)

    @classmethod
    def define_schema(cls):
        return object()

    @classmethod
    def execute(cls, value):
        return _FakeNodeOutput(torch.full((1, 2, 2, 3), float(value)))


class _ApiAV:
    """双输出 (CONDITIONING, LATENT) 的 API 节点。"""

    RETURN_TYPES = ("CONDITIONING", "LATENT")

    @classmethod
    def define_schema(cls):
        return object()

    @classmethod
    def execute(cls, clip, vae):
        return _FakeNodeOutput("cond", torch.full((1, 2, 2, 3), 9.0))


class _LegacyDecode:
    """legacy FUNCTION 节点：把 latent 原样当作 IMAGE 输出（终端）。"""

    FUNCTION = "decode"
    RETURN_TYPES = ("IMAGE",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",)}}

    def decode(self, latent):
        return latent


class _LegacySource:
    FUNCTION = "src"
    RETURN_TYPES = ("IMAGE",)

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def src(self):
        return torch.ones(1, 2, 2, 3)


class ApiNodeExecutorTests(unittest.TestCase):
    def setUp(self):
        self._orig = dict(_nodes.NODE_CLASS_MAPPINGS)
        _nodes.NODE_CLASS_MAPPINGS.update(
            {"_ApiSingle": _ApiSingle, "_ApiAV": _ApiAV,
             "_LegacyDecode": _LegacyDecode, "_LegacySource": _LegacySource})

    def tearDown(self):
        _nodes.NODE_CLASS_MAPPINGS.clear()
        _nodes.NODE_CLASS_MAPPINGS.update(self._orig)

    def test_api_single_output_terminal(self):
        graph = {"1": {"class_type": "_ApiSingle", "inputs": {"value": 5}}}
        out = image_gen_edit.execute_graph_inprocess(graph)
        self.assertTrue(torch.allclose(out, torch.full((1, 2, 2, 3), 5.0)))

    def test_api_multi_output_downstream_ref(self):
        # _ApiAV 输出 [0]=cond [1]=latent；legacy 解码器取 index 1 作为终端 IMAGE
        graph = {
            "1": {"class_type": "_ApiAV", "inputs": {"clip": "c", "vae": "v"}},
            "2": {"class_type": "_LegacyDecode", "inputs": {"latent": ["1", 1]}},
        }
        out = image_gen_edit.execute_graph_inprocess(graph)
        self.assertTrue(torch.allclose(out, torch.full((1, 2, 2, 3), 9.0)))

    def test_is_api_node_detection(self):
        self.assertTrue(image_gen_edit._is_api_node(_ApiSingle))
        self.assertFalse(image_gen_edit._is_api_node(_LegacySource))

    def test_api_outputs_unwrap_args(self):
        self.assertEqual(image_gen_edit._api_outputs(_FakeNodeOutput(1, 2)), [1, 2])
        self.assertEqual(image_gen_edit._api_outputs((3, 4)), [3, 4])
        self.assertEqual(image_gen_edit._api_outputs(7), [7])


class LengthPlaceholderTests(unittest.TestCase):
    def test_length_substituted_as_int(self):
        template = {"1": {"class_type": "X", "inputs": {"length": "{{LENGTH}}", "n": 3}}}
        graph, _ = h3_video_gen.render_template(template, {"length": 124})
        self.assertEqual(graph["1"]["inputs"]["length"], 124)
        self.assertIsInstance(graph["1"]["inputs"]["length"], int)


class SecondsToFramesTests(unittest.TestCase):
    def test_aligns_to_17k_plus_5_grid(self):
        # 官方公式：24fps 取整后向上对齐到模型的 17k+5 网格
        self.assertEqual(h3_video_gen._seconds_to_frames(5), 124)   # ~5s（默认/训练下限）
        self.assertEqual(h3_video_gen._seconds_to_frames(3), 73)    # 参考工作流 length=73
        self.assertEqual(h3_video_gen._seconds_to_frames(10), 243)

    def test_small_values_clamp_to_min(self):
        self.assertEqual(h3_video_gen._seconds_to_frames(0), 5)     # max(5, ...) 下限
        self.assertEqual(h3_video_gen._seconds_to_frames(1), 39)    # 24 → 对齐到 39

    def test_output_is_on_grid(self):
        for s in (1, 2, 5, 8, 15):
            self.assertEqual(h3_video_gen._seconds_to_frames(s) % 17, 5)


class ResolveVideoParamsTests(unittest.TestCase):
    def _cfg(self):
        return {
            "model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "vae": "minimax_h3_video_vae_fp16.safetensors",
            "width": 1344, "height": 768, "length": 124,
        }

    def setUp(self):
        self._orig_get_video_settings = h3_video_gen.get_video_settings
        h3_video_gen.get_video_settings = lambda: {}

    def tearDown(self):
        h3_video_gen.get_video_settings = self._orig_get_video_settings

    def test_resolves_models_and_dims(self):
        p = h3_video_gen.resolve_video_params({"prompt": " a cat ", "seed": 42}, self._cfg())
        self.assertEqual(p["prompt"], "a cat")
        self.assertEqual(p["model"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")
        self.assertEqual(p["vae"], "minimax_h3_video_vae_fp16.safetensors")
        self.assertEqual((p["width"], p["height"], p["length"]), (1344, 768, 124))
        self.assertEqual(p["seed"], 42)
        self.assertIsNone(p["ref_name"])

    def test_steps_defaults_20_and_reads_from_cfg(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertEqual(p["steps"], 20)   # config 未指定 → 默认 20
        cfg = self._cfg()
        cfg["steps"] = 35
        self.assertEqual(h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)["steps"], 35)

    def test_steps_rendered_into_sampler_as_int(self):
        import json as _json
        cfg = self._cfg()
        cfg["steps"] = 30
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        wf_path = os.path.join(PLUGIN_DIR, "skills", "presets", "minimax_h3_t2v", "workflow.json")
        with open(wf_path, encoding="utf-8") as f:
            template = _json.load(f)
        graph, _ = h3_video_gen.render_template(template, p)
        sampler = next(n for n in graph.values() if n.get("class_type") == "KSampler")
        self.assertEqual(sampler["inputs"]["steps"], 30)   # {{STEPS}} 渲染为 int


    def test_loras_resolved_from_cfg(self):
        # LoRA 复用生图解析：校验存在性 + 强度裁剪
        cfg = self._cfg()
        cfg["loras"] = [{"name": "h3/style_lora.safetensors", "strength": 0.8}]
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["loras"], [{"name": "h3/style_lora.safetensors", "strength": 0.8}])

    def test_no_loras_configured_defaults_empty(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertEqual(p["loras"], [])

    def test_lora_injected_into_h3_model_chain(self):
        # 模板无 LoRA 槽位：动态在 UNETLoader(1) → MiniMaxH3SigmaShift(5) 之间插入 LoraLoaderModelOnly
        import json as _json
        cfg = self._cfg()
        cfg["loras"] = [{"name": "h3/style_lora.safetensors", "strength": 0.8}]
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        wf_path = os.path.join(PLUGIN_DIR, "skills", "presets", "minimax_h3_t2v", "workflow.json")
        with open(wf_path, encoding="utf-8") as f:
            template = _json.load(f)
        graph, _ = h3_video_gen.render_template(template, p)
        lora_nodes = {nid: n for nid, n in graph.items() if n.get("class_type") == "LoraLoaderModelOnly"}
        self.assertEqual(len(lora_nodes), 1)
        nid, node = next(iter(lora_nodes.items()))
        self.assertEqual(node["inputs"]["model"], ["1", 0])
        self.assertEqual(node["inputs"]["lora_name"], "h3/style_lora.safetensors")
        self.assertEqual(node["inputs"]["strength_model"], 0.8)
        self.assertEqual(graph["5"]["inputs"]["model"], [nid, 0])

    def test_node_input_overrides_cfg(self):
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "width": 512, "height": 512, "length": 97}, self._cfg())
        self.assertEqual((p["width"], p["height"], p["length"]), (512, 512, 97))

    def test_body_model_override_wins_over_cfg(self):
        # 会话页自定参数面板填了主模型 = 这一发换模型，技能钉的那一颗让位
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "model": "krea2/krea2_turbo_fp16.safetensors"}, self._cfg())
        self.assertEqual(p["model"], "krea2/krea2_turbo_fp16.safetensors")

    def test_body_encoder_and_vae_overrides(self):
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "text_encoder": "qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors",
             "vae": "krea2/diffusion_pytorch_model.safetensors"}, self._cfg())
        self.assertEqual(p["text_encoder"], "qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors")
        self.assertEqual(p["vae"], "krea2/diffusion_pytorch_model.safetensors")

    def test_body_audio_vae_override(self):
        # 音频 VAE 覆盖同样经存在性适配：桩环境 vae 目录里只有 _fp32 这一颗音频模型
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "audio_vae": "minimax_h3_audio_vae_fp32.safetensors"}, self._cfg())
        self.assertEqual(p["audio_vae"], "minimax_h3_audio_vae_fp32.safetensors")

    def test_body_steps_and_loras_override_cfg(self):
        cfg = self._cfg()
        cfg["steps"] = 30
        cfg["loras"] = [{"name": "h3/style_lora.safetensors", "strength": 0.8}]
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "steps": 12,
             "loras": [{"name": "h3/style_lora.safetensors", "strength": 0.3}]}, cfg)
        self.assertEqual(p["steps"], 12)
        self.assertEqual(p["loras"], [{"name": "h3/style_lora.safetensors", "strength": 0.3}])

    def test_empty_body_override_follows_cfg(self):
        # 面板留空 = 请求体不发值；后端这一发沿用技能钉的模型与步数（与生图覆盖同一口径）
        cfg = self._cfg()
        cfg["steps"] = 30
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "model": "", "loras": [], "steps": 0, "vae": "  "}, cfg)
        self.assertEqual(p["model"], cfg["model"])
        self.assertEqual(p["steps"], 30)
        self.assertEqual(p["vae"], cfg["vae"])
        self.assertEqual(p["loras"], [])

    def test_missing_prompt_raises(self):
        with self.assertRaises(ValueError):
            h3_video_gen.resolve_video_params({"prompt": "   "}, self._cfg())

    def test_missing_model_auto_picks_h3(self):
        # 空值 = 自动挑选 H3（与生图 suggest_model 一致）；_MODELS 里有 h3 模型，应兜底成功
        cfg = self._cfg()
        del cfg["model"]
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["model"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")

    def test_no_h3_model_available_raises(self):
        # 目录里没有 H3 模型、设置与 skill config 都未指定时才报错
        orig = h3_video_gen.suggest_video_model
        h3_video_gen.suggest_video_model = lambda folder: ""
        try:
            cfg = self._cfg()
            del cfg["model"]
            with self.assertRaises(ValueError):
                h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        finally:
            h3_video_gen.suggest_video_model = orig

    def test_cfg_model_wins_over_global(self):
        h3_video_gen.get_video_settings = lambda: {"video_model": "global_only.safetensors"}
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertEqual(p["model"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")

    def test_falls_back_to_global_video_settings(self):
        cfg = self._cfg()
        del cfg["model"]
        h3_video_gen.get_video_settings = lambda: {"video_model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors"}
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["model"], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")

    def test_random_seed_when_absent(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertGreaterEqual(p["seed"], 0)

    def test_reference_image_resolved(self):
        buf = io.BytesIO()
        _PILImage.new("RGB", (4, 4), (255, 0, 0)).save(buf, format="PNG")
        uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "references": [{"kind": "data", "data": uri}]}, self._cfg())
        self.assertIsNotNone(p["ref_name"])
        self.assertTrue(p["ref_name"].startswith("NeoAgent/"))

    def test_references_split_by_media(self):
        # references 按 media 分成三类参考；缺省 media 视为参考图，ref_name 取第一张图
        p = h3_video_gen.resolve_video_params({"prompt": "x", "references": [
            {"kind": "data", "data": _data_uri("image/png", b"img")},
            {"kind": "data", "data": _data_uri("video/mp4", b"vid"), "media": "video"},
            {"kind": "data", "data": _data_uri("audio/wav", b"aud"), "media": "audio"},
        ]}, self._cfg())
        self.assertEqual(len(p["ref_images"]), 1)
        self.assertEqual(len(p["ref_videos"]), 1)
        self.assertEqual(len(p["ref_audios"]), 1)
        self.assertEqual(p["ref_name"], p["ref_images"][0])
        self.assertTrue(p["ref_videos"][0].endswith(".mp4"))
        self.assertTrue(p["ref_audios"][0].endswith(".wav"))

    def test_reference_caps_match_official_slots(self):
        # 参考节点上限 9 图 / 3 视频 / 3 音频，超出的按顺序丢弃
        refs = ([{"kind": "data", "data": _data_uri("image/png", bytes([i]))} for i in range(11)]
                + [{"kind": "data", "data": _data_uri("video/mp4", bytes([i])), "media": "video"} for i in range(5)]
                + [{"kind": "data", "data": _data_uri("audio/wav", bytes([i])), "media": "audio"} for i in range(5)])
        p = h3_video_gen.resolve_video_params({"prompt": "x", "references": refs}, self._cfg())
        self.assertEqual(len(p["ref_images"]), 9)
        self.assertEqual(len(p["ref_videos"]), 3)
        self.assertEqual(len(p["ref_audios"]), 3)

    def test_reference_media_mismatch_dropped(self):
        # media=image 却给 mp4：后缀不符不解析，避免把视频塞进 LoadImage
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "references": [{"kind": "data", "data": _data_uri("video/mp4", b"vid")}]},
            self._cfg())
        self.assertEqual(p["ref_images"], [])
        self.assertIsNone(p["ref_name"])

    def test_input_media_refs_resolved_by_kind(self):
        # 导演配方走 kind=input（input/ 下的相对名）：图/视频/音频分别按后缀识别
        for name in ("ref_a.png", "ref_v.mp4", "ref_s.wav"):
            with open(os.path.join(_INPUT_DIR, name), "wb") as f:
                f.write(b"media")
        p = h3_video_gen.resolve_video_params({"prompt": "x", "references": [
            {"kind": "input", "value": "ref_a.png"},
            {"kind": "input", "value": "ref_v.mp4", "media": "video"},
            {"kind": "input", "value": "ref_s.wav", "media": "audio"},
        ]}, self._cfg())
        self.assertEqual(p["ref_images"], ["ref_a.png"])
        self.assertEqual(p["ref_videos"], ["ref_v.mp4"])
        self.assertEqual(p["ref_audios"], ["ref_s.wav"])

    def test_last_frame_resolved_and_absent_by_default(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertIsNone(p["ref_last"], "未给尾帧时 ref_last 为 None")
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "last_frame": {"kind": "data", "data": _data_uri("image/png", b"last")}},
            self._cfg())
        self.assertIsNotNone(p["ref_last"])
        self.assertTrue(p["ref_last"].startswith("NeoAgent/"))

    def test_audio_vae_resolved(self):
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        self.assertEqual(p["audio_vae"], "minimax_h3_audio_vae_fp32.safetensors")

    def test_cfg_audio_vae_wins_over_autopick(self):
        cfg = self._cfg()
        cfg["audio_vae"] = "minimax_h3_video_vae_fp16.safetensors"  # 用视频 VAE 文件名验证 cfg 优先于自动挑选
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["audio_vae"], "minimax_h3_video_vae_fp16.safetensors")

    def test_no_audio_vae_available_raises(self):
        orig = h3_video_gen.suggest_audio_vae
        h3_video_gen.suggest_audio_vae = lambda: ""
        try:
            with self.assertRaises(ValueError):
                h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
        finally:
            h3_video_gen.suggest_audio_vae = orig

    def test_falls_back_to_global_audio_vae_settings(self):
        # 关掉自动挑选后仍解析成功 → 证明走的是「生视频模型」设置里的 video_audio_vae
        orig = h3_video_gen.suggest_audio_vae
        h3_video_gen.suggest_audio_vae = lambda: ""
        h3_video_gen.get_video_settings = lambda: {"video_audio_vae": "minimax_h3_audio_vae_fp32.safetensors"}
        try:
            p = h3_video_gen.resolve_video_params({"prompt": "x"}, self._cfg())
            self.assertEqual(p["audio_vae"], "minimax_h3_audio_vae_fp32.safetensors")
        finally:
            h3_video_gen.suggest_audio_vae = orig

    def _effect_cfg(self):
        """特效表技能的最小契约：每个特效自带嵌入文件 / 模板 / 步数 / 时长上限 / 首尾同帧。"""
        cfg = self._cfg()
        cfg["effect"] = "bullet_time"
        cfg["effects"] = [
            {"id": "bullet_time", "label": "子弹时间", "embedding": "minimaxh3_bullet_time.safetensors",
             "steps": 28, "max_length": 124, "prompt_default": "a sprinter leaps",
             "prompt_template": "embedding:minimaxh3_bullet_time {text} bullet-time, single shot"},
            {"id": "frozen_moment", "label": "定格瞬间", "steps": 24, "max_length": 124,
             "same_first_last": True, "prompt_template": "{text} locked camera seamless loop"},
            {"id": "dark_magic", "label": "黑暗魔法", "embedding": "minimaxh3_dark_magic.safetensors",
             "steps": 24, "prompt_template": "embedding:minimaxh3_dark_magic {text} dark magic gathers"},
            {"id": "fire_breath", "label": "火焰吐息", "embedding": "minimaxh3_fire_breath.safetensors",
             "steps": 24, "prompt_template": "embedding:minimaxh3_fire_breath {text} fire breath"},
        ]
        return cfg

    def test_effect_selection_injects_the_embedding_segment(self):
        # 官方语法 embedding:<文件名> 逐字进提示词：触发词就是文件名去后缀，改写过的文本特效认不出来
        p = h3_video_gen.resolve_video_params({"prompt": "a hooded figure", "effect": "dark_magic"}, self._effect_cfg())
        self.assertEqual(p["prompt"], "embedding:minimaxh3_dark_magic a hooded figure dark magic gathers")
        self.assertEqual((p["effect"], p["steps"]), ("dark_magic", 24))

    def test_effect_defaults_to_the_skills_own_effect(self):
        p = h3_video_gen.resolve_video_params({"prompt": "a sprinter"}, self._effect_cfg())
        self.assertEqual((p["effect"], p["steps"]), ("bullet_time", 28))
        self.assertIn("embedding:minimaxh3_bullet_time", p["prompt"])

    def test_effect_empty_text_uses_that_effects_default(self):
        p = h3_video_gen.resolve_video_params({"prompt": "  ", "effect": "bullet_time"}, self._effect_cfg())
        self.assertEqual(p["prompt"], "embedding:minimaxh3_bullet_time a sprinter leaps bullet-time, single shot")

    def test_unknown_effect_id_lists_the_effects_that_exist(self):
        with self.assertRaises(ValueError) as ctx:
            h3_video_gen.resolve_video_params({"prompt": "x", "effect": "no_such"}, self._effect_cfg())
        msg = str(ctx.exception)
        self.assertTrue(all(e["id"] in msg for e in self._effect_cfg()["effects"]), msg)

    def test_missing_effect_file_names_the_file_before_queueing(self):
        # ComfyUI 读不到 embedding: 段只 warning 后整段忽略、整发照跑完 → 静默出一发没有特效的片，必须挡在排队列之前
        with self.assertRaises(ValueError) as ctx:
            h3_video_gen.resolve_video_params({"prompt": "x", "effect": "fire_breath"}, self._effect_cfg())
        self.assertIn("minimaxh3_fire_breath.safetensors", str(ctx.exception))

    def test_missing_file_of_another_effect_does_not_block(self):
        # 特效技能一次只跑一个特效：别的特效缺文件不该把这一发挡死
        p = h3_video_gen.resolve_video_params({"prompt": "x", "effect": "bullet_time"}, self._effect_cfg())
        self.assertEqual(p["effect"], "bullet_time")

    def test_effect_contract_clamps_length_and_pins_the_loop_frame(self):
        for name in ("loop_frame.png", "end_frame.png"):
            with open(os.path.join(_INPUT_DIR, name), "wb") as f:
                f.write(b"media")
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "effect": "frozen_moment", "length": 243,
             "references": [{"kind": "input", "value": "loop_frame.png"}]}, self._effect_cfg())
        self.assertEqual((p["length"], p["ref_last"]), (124, "loop_frame.png"))
        explicit = h3_video_gen.resolve_video_params(
            {"prompt": "x", "effect": "frozen_moment", "length": 124,
             "references": [{"kind": "input", "value": "loop_frame.png"}],
             "last_frame": {"kind": "input", "value": "end_frame.png"}}, self._effect_cfg())
        self.assertEqual(explicit["ref_last"], "end_frame.png")   # 用户点了尾帧就按用户的那张

    def test_effect_steps_beat_the_pages_own_steps_override(self):
        # 自定参数面板这一发改的步数是覆盖技能配置的；特效钉着的步数是这一发的契约，特效优先
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "effect": "bullet_time", "steps": 4}, self._effect_cfg())
        self.assertEqual(p["steps"], 28)

    def test_effect_prompt_template_fills_text(self):
        # 特效技能钉提示词：用户那句话只填进 {text}，触发词由模板写死，被改写过的文本认不出镜头
        cfg = self._cfg()
        cfg["prompt_template"] = "locked camera {text} seamless loop"
        p = h3_video_gen.resolve_video_params({"prompt": " a girl in rain "}, cfg)
        self.assertEqual(p["prompt"], "locked camera a girl in rain seamless loop")

    def test_effect_prompt_template_empty_text_uses_default(self):
        cfg = self._cfg()
        cfg["prompt_template"] = "{text} bullet-time"
        cfg["prompt_default"] = "a sprinter leaps"
        self.assertEqual(
            h3_video_gen.resolve_video_params({"prompt": "   "}, cfg)["prompt"],
            "a sprinter leaps bullet-time")

    def test_effect_prompt_template_without_token_replaces_text(self):
        cfg = self._cfg()
        cfg["prompt_template"] = "frozen scene, locked camera"
        self.assertEqual(
            h3_video_gen.resolve_video_params({"prompt": "用户写的那句话"}, cfg)["prompt"],
            "frozen scene, locked camera")

    def test_require_loras_refuses_missing_file(self):
        # 特效本体没落盘就不出片：静默跑一发「没有特效的片」比当场说清缺哪个文件更坏
        cfg = self._cfg()
        cfg["loras"] = [{"name": "h3/effect_style_lora.safetensors", "strength": 1.0}]
        cfg["require_loras"] = True
        with self.assertRaises(ValueError) as ctx:
            h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertIn("effect_style_lora.safetensors", str(ctx.exception))

    def test_require_loras_passes_when_installed(self):
        cfg = self._cfg()
        cfg["loras"] = [{"name": "h3/style_lora.safetensors", "strength": 1.0}]
        cfg["require_loras"] = True
        p = h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)
        self.assertEqual(p["loras"], [{"name": "h3/style_lora.safetensors", "strength": 1.0}])

    def test_loras_stay_optional_without_require_flag(self):
        # 没标 require_loras 的既有技能口径不变：缺文件仍按原样跳过
        cfg = self._cfg()
        cfg["loras"] = [{"name": "h3/not_installed.safetensors", "strength": 1.0}]
        self.assertEqual(h3_video_gen.resolve_video_params({"prompt": "x"}, cfg)["loras"], [])

    def test_same_first_last_defaults_last_frame_to_first(self):
        with open(os.path.join(_INPUT_DIR, "loop_frame.png"), "wb") as f:
            f.write(b"media")
        cfg = self._cfg()
        cfg["same_first_last"] = True
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "references": [{"kind": "input", "value": "loop_frame.png"}]}, cfg)
        self.assertEqual(p["ref_last"], p["ref_name"])

    def test_same_first_last_keeps_an_explicit_last_frame(self):
        for name in ("loop_frame.png", "end_frame.png"):
            with open(os.path.join(_INPUT_DIR, name), "wb") as f:
                f.write(b"media")
        cfg = self._cfg()
        cfg["same_first_last"] = True
        p = h3_video_gen.resolve_video_params(
            {"prompt": "x", "references": [{"kind": "input", "value": "loop_frame.png"}],
             "last_frame": {"kind": "input", "value": "end_frame.png"}}, cfg)
        self.assertEqual(p["ref_last"], "end_frame.png")

    def test_max_length_clamps_a_longer_request(self):
        cfg = self._cfg()
        cfg["length"] = 124
        cfg["max_length"] = 124
        self.assertEqual(h3_video_gen.resolve_video_params({"prompt": "x", "length": 243}, cfg)["length"], 124)

    def test_effect_skill_available_while_one_effect_is_ready(self):
        # 特效技能有一个特效的本体在盘上就可用；缺本体的那一个在特效清单里各自标不可用
        scanned = {s["id"]: s for s in h3_video_gen.scan_skills()}
        row = scanned["effect_h3"]
        self.assertIs(row["available"], True)
        self.assertIs(scanned["minimax_h3_i2v"]["available"], True)
        self.assertEqual(row["effect"], "bullet_time")
        by_id = {e["id"]: e for e in row["effects"]}
        self.assertTrue(by_id["bullet_time"]["ready"])
        self.assertTrue(by_id["frozen_moment"]["ready"], "定格瞬间不吃文件，本体天然就位")
        self.assertIs(by_id["fire_breath"]["ready"], False)   # 桩环境的模型根里就是少这一个

    def test_skills_without_effect_table_expose_no_effects(self):
        scanned = {s["id"]: s for s in h3_video_gen.scan_skills()}
        self.assertNotIn("effects", scanned["minimax_h3_i2v"])


class EffectSkillContractTests(unittest.TestCase):
    """出厂特效技能（effect_h3）：特效本体钉在技能 config 的特效表里——嵌入文件、逐字触发段、步数、
    帧网格、首尾同帧全在特效项上，前端只交一个特效 id。"""

    def _config(self):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "effect_h3", "config.json"),
                  encoding="utf-8") as f:
            return json.load(f)

    def _manifest(self):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "effect_h3", "models.json"),
                  encoding="utf-8") as f:
            return json.load(f)

    def test_effect_table_lists_every_effect_once(self):
        cfg = self._config()
        ids = [e["id"] for e in cfg["effects"]]
        self.assertEqual(len(ids), 11, "11 个特效：10 个社区嵌入 + 不吃文件的定格瞬间")
        self.assertEqual(len(set(ids)), len(ids))
        self.assertIn(cfg["effect"], ids)

    def test_embedding_effects_pin_their_embedding_segment(self):
        for e in self._config()["effects"]:
            stem = str(e.get("embedding") or "").replace(".safetensors", "")
            if not stem:
                continue
            with self.subTest(effect=e["id"]):
                # 触发词 = 文件名去后缀，逐字匹配；模板段被改写过的文本特效认不出来
                self.assertTrue(e["prompt_template"].startswith(f"embedding:{stem} "), e["prompt_template"][:40])
                self.assertIn("{text}", e["prompt_template"])
                self.assertTrue(e["prompt_default"])
                self.assertGreater(int(e["steps"]), 20, "环绕与画面试效在 20 步上会糊")

    def test_frozen_moment_needs_no_file_and_loops(self):
        e = next(x for x in self._config()["effects"] if x["id"] == "frozen_moment")
        self.assertIs(e.get("same_first_last"), True)
        self.assertNotIn("embedding", e)
        self.assertEqual(e["max_length"] % 17, 5, "时长上限要在 H3 的 17k+5 帧网格上")
        self.assertIn("{text}", e["prompt_template"])

    def test_frame_caps_sit_on_the_h3_grid(self):
        for e in self._config()["effects"]:
            cap = e.get("max_length")
            with self.subTest(effect=e["id"]):
                self.assertEqual((cap or 0) % 17, 5 if cap else 0)

    def test_manifest_covers_every_embedding_effect(self):
        cfg = self._config()
        files = self._manifest()["files"]
        self.assertEqual({f["filename"] for f in files},
                         {e["embedding"] for e in cfg["effects"] if e.get("embedding")})
        self.assertEqual({f["effect"] for f in files},
                         {e["id"] for e in cfg["effects"] if e.get("embedding")})
        self.assertTrue(all(f["category"] == "embeddings" for f in files))

    def test_skill_carries_no_lora_dependency(self):
        # 特效本体是官方口径的文本嵌入（embedding: 段），这一发不挂 LoRA，旧社区 LoRA 契约整条不存在
        cfg = self._config()
        self.assertNotIn("loras", cfg)
        self.assertNotIn("require_loras", cfg)
        self.assertTrue(all("loras" not in e for e in cfg["effects"]))
        self.assertTrue(all(f["field"] == "effect" for f in self._manifest()["files"]))


class GenVideoSkillsTests(unittest.TestCase):
    def test_new_presets_are_video_skills(self):
        ids = {s["id"] for s in h3_video_gen._gen_video_skills()}
        self.assertIn("minimax_h3_t2v", ids)
        self.assertIn("minimax_h3_i2v", ids)
        self.assertIn("minimax-h3-r2v", ids)
        self.assertIn("minimax_h3_fl2v", ids)
        self.assertIn("effect_h3", ids)

    def test_image_presets_not_video_skills(self):
        ids = {s["id"] for s in h3_video_gen._gen_video_skills()}
        self.assertNotIn("image_gen", ids)

    def test_skill_label_marks_unavailable(self):
        self.assertEqual(h3_video_gen._skill_label({"cn_name": "H3 文生视频", "name": "t2v"}), "H3 文生视频")
        self.assertEqual(
            h3_video_gen._skill_label({"cn_name": "H3 连续多段合成 (VDN)", "name": "vdn", "available": False}),
            "H3 连续多段合成 (VDN)（不可用）")

    def test_default_video_skill_fewest_steps_among_available(self):
        skills = [
            {"id": "a", "cn_name": "A", "gen_config": {"steps": 20}},
            {"id": "b", "cn_name": "B", "available": False, "gen_config": {"steps": 4}},   # 步数最少但不可用 → 跳过
            {"id": "c", "cn_name": "C"},                                                 # 无 config → 按默认 20
        ]
        self.assertEqual(h3_video_gen._default_video_skill(skills)["id"], "a")

    def test_default_video_skill_falls_back_when_none_available(self):
        skills = [
            {"id": "a", "cn_name": "A", "available": False},
            {"id": "b", "cn_name": "B", "available": False, "gen_config": {"steps": 8}},
        ]
        self.assertEqual(h3_video_gen._default_video_skill(skills)["id"], "b")   # 全不可用 → 全列表里步数最少者

    def test_default_video_skill_empty_list(self):
        self.assertIsNone(h3_video_gen._default_video_skill([]))

    def test_resolve_skill_id_accepts_marked_label_and_legacy_value(self):
        orig = h3_video_gen._gen_video_skills
        h3_video_gen._gen_video_skills = lambda: [
            {"id": "vdn", "cn_name": "H3 连续多段合成 (VDN)", "name": "vdn", "available": False},
        ]
        try:
            self.assertEqual(h3_video_gen._resolve_skill_id("H3 连续多段合成 (VDN)（不可用）"), "vdn")
            self.assertEqual(h3_video_gen._resolve_skill_id("H3 连续多段合成 (VDN)"), "vdn")   # 旧工作流存的是无后缀值
        finally:
            h3_video_gen._gen_video_skills = orig


# ---- 真实模板端到端：假节点替代 H3/加载器，跑 preset 里的真实 workflow.json ----
class _F_UNETLoader:
    FUNCTION = "load"
    RETURN_TYPES = ("MODEL",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"unet_name": ("x",), "weight_dtype": ("y",)}}
    def load(self, unet_name, weight_dtype): return (torch.zeros(1),)


class _F_CLIPLoader:
    FUNCTION = "load"
    RETURN_TYPES = ("CLIP",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"clip_name": ("x",), "type": ("y",), "device": ("z",)}}
    def load(self, clip_name, type, device): return (torch.zeros(1),)


class _F_VAELoader:
    FUNCTION = "load"
    RETURN_TYPES = ("VAE",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"vae_name": ("x",)}}
    def load(self, vae_name): return (f"VAE:{vae_name}",)


class _F_LoadImage:
    FUNCTION = "load"
    RETURN_TYPES = ("IMAGE", "MASK")
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"image": ("x",)}}
    def load(self, image): return (torch.zeros(1, 4, 4, 3), torch.zeros(1, 4, 4))


class _F_KSampler:
    FUNCTION = "sample"
    RETURN_TYPES = ("LATENT", "MODEL")
    @classmethod
    def INPUT_TYPES(cls): return {"required": {}}
    def sample(self, model, seed, steps, cfg, sampler_name, scheduler,
               positive, negative, latent_image, denoise=1.0):
        return (latent_image, model)


class _F_VAEDecode:
    FUNCTION = "decode"
    RETURN_TYPES = ("IMAGE",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}
    def decode(self, samples, vae): return torch.zeros(1, 4, 8, 8, 3)


class _F_H3ImageToVideo:
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, clip, vae, prompt, width, height, length, first_frame=None, last_frame=None):
        return _FakeNodeOutput("cond", torch.zeros(1))


class _F_H3SigmaShift:
    RETURN_TYPES = ("MODEL",)
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, model, shift_video, shift_audio):
        return _FakeNodeOutput(model)


class _F_LTXVSeparateAV:
    RETURN_TYPES = ("LATENT", "LATENT")
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, av_latent):
        return _FakeNodeOutput(torch.zeros(1), torch.zeros(1))


class _F_VAEDecodeAudio:
    RETURN_TYPES = ("AUDIO",)
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, vae, samples):
        if "audio" not in str(vae).lower():
            raise AssertionError(f"VAEDecodeAudio 必须接音频 VAE，实际: {vae}")
        return _FakeNodeOutput("audio")


class _F_LoadVideo:
    FUNCTION = "load"
    RETURN_TYPES = ("VIDEO",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"file": ("x",)}}
    def load(self, file): return (f"video:{file}",)


class _F_LoadAudio:
    FUNCTION = "load"
    RETURN_TYPES = ("AUDIO",)
    @classmethod
    def INPUT_TYPES(cls): return {"required": {"audio": ("x",)}}
    def load(self, audio): return (f"audio:{audio}",)


class _F_GetVideoComponents:
    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "INT")
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, video):
        return _FakeNodeOutput(torch.zeros(1, 4, 4, 3), "video_audio", 24.0, 8)


class _F_H3ReferenceToVideo:
    """假参考节点：校验点号 autogrow 输入被收成嵌套 dict（ref_images.ref_image_0 → {"ref_image_0": ...}）。"""

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, clip, vae, audio_vae, prompt, width, height, length, ref_image_size="match",
                ref_images=None, ref_videos=None, ref_video_audios=None, ref_audios=None):
        for group in (ref_images, ref_videos, ref_audios):
            if group is not None:
                assert isinstance(group, dict), f"autogrow 参考应为嵌套 dict，实际: {type(group)}"
        return _FakeNodeOutput("cond", torch.zeros(1))


class _F_CreateVideo:
    RETURN_TYPES = ("VIDEO",)
    @classmethod
    def define_schema(cls): return object()
    @classmethod
    def execute(cls, images, fps, audio=None, bit_depth=8):
        return _FakeNodeOutput(("video", images, fps, audio))


class RealTemplateExecutionTests(unittest.TestCase):
    _FAKES = {
        "UNETLoader": _F_UNETLoader, "CLIPLoader": _F_CLIPLoader, "VAELoader": _F_VAELoader,
        "LoadImage": _F_LoadImage, "KSampler": _F_KSampler, "VAEDecode": _F_VAEDecode,
        "MiniMaxH3ImageToVideo": _F_H3ImageToVideo, "MiniMaxH3SigmaShift": _F_H3SigmaShift,
        "LTXVSeparateAVLatent": _F_LTXVSeparateAV,
        "VAEDecodeAudio": _F_VAEDecodeAudio, "CreateVideo": _F_CreateVideo,
        "MiniMaxH3ReferenceToVideo": _F_H3ReferenceToVideo, "LoadVideo": _F_LoadVideo,
        "LoadAudio": _F_LoadAudio, "GetVideoComponents": _F_GetVideoComponents,
    }

    def setUp(self):
        self._orig = dict(_nodes.NODE_CLASS_MAPPINGS)
        _nodes.NODE_CLASS_MAPPINGS.update(self._FAKES)

    def tearDown(self):
        _nodes.NODE_CLASS_MAPPINGS.clear()
        _nodes.NODE_CLASS_MAPPINGS.update(self._orig)

    def _run_preset(self, preset, with_ref):
        import json as _json
        wf_path = os.path.join(PLUGIN_DIR, "skills", "presets", preset, "workflow.json")
        with open(wf_path, encoding="utf-8") as f:
            template = _json.load(f)
        cfg = {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
               "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
               "vae": "minimax_h3_video_vae_fp16.safetensors"}
        body = {"prompt": "a cat walks"}
        if with_ref:
            buf = io.BytesIO()
            _PILImage.new("RGB", (4, 4)).save(buf, format="PNG")
            uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
            body["references"] = [{"kind": "data", "data": uri}]
        params = h3_video_gen.resolve_video_params(body, cfg)
        graph, _ = h3_video_gen.render_template(template, params)
        out = image_gen_edit.execute_graph_inprocess(graph, output_type="VIDEO")
        self.assertEqual(out[0], "video")      # 末端 CreateVideo 的 VIDEO marker
        self.assertEqual(out[2], 24)           # fps=24
        self.assertEqual(out[3], "audio")      # 音频来自 VAEDecodeAudio

    def test_t2v_template_executes(self):
        self._run_preset("minimax_h3_t2v", with_ref=False)

    def test_i2v_template_executes(self):
        self._run_preset("minimax_h3_i2v", with_ref=True)

    def _r2v_template(self):
        import json as _json
        wf_path = os.path.join(PLUGIN_DIR, "skills", "presets", "minimax-h3-r2v", "workflow.json")
        with open(wf_path, encoding="utf-8") as f:
            return _json.load(f)

    def _preset_template(self, preset):
        import json as _json
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", preset, "workflow.json"), encoding="utf-8") as f:
            return _json.load(f)

    def _fl2v_cfg(self):
        return {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                "vae": "minimax_h3_video_vae_fp16.safetensors"}

    def test_fl2v_template_wires_first_and_last_frame(self):
        # 首尾帧：两个 LoadImage 分别接 first_frame / last_frame
        body = {"prompt": "a cat walks",
                "references": [{"kind": "data", "data": _data_uri("image/png", b"first")}],
                "last_frame": {"kind": "data", "data": _data_uri("image/png", b"last")}}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._preset_template("minimax_h3_fl2v"), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["13", "9"])
        self.assertEqual(graph["4"]["inputs"]["first_frame"], ["9", 0])
        self.assertEqual(graph["4"]["inputs"]["last_frame"], ["13", 0])
        self.assertEqual(image_gen_edit.execute_graph_inprocess(graph, output_type="VIDEO")[0], "video")

    def test_fl2v_without_last_frame_prunes_last_node(self):
        # 只给首帧 → 尾帧 LoadImage 与连线一并裁掉（退化为 I2VA）
        body = {"prompt": "x", "references": [{"kind": "data", "data": _data_uri("image/png", b"first")}]}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._preset_template("minimax_h3_fl2v"), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["9"])
        self.assertIn("first_frame", graph["4"]["inputs"])
        self.assertNotIn("last_frame", graph["4"]["inputs"])

    def test_fl2v_without_first_frame_prunes_first_node(self):
        # 只给尾帧 → 首帧 LoadImage 裁掉（退化为 L2VA，模板仍可执行）
        body = {"prompt": "x", "last_frame": {"kind": "data", "data": _data_uri("image/png", b"last")}}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._preset_template("minimax_h3_fl2v"), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["13"])
        self.assertNotIn("first_frame", graph["4"]["inputs"])
        self.assertIn("last_frame", graph["4"]["inputs"])

    def test_fl2v_needs_at_least_one_frame(self):
        params = h3_video_gen.resolve_video_params({"prompt": "x"}, self._fl2v_cfg())
        with self.assertRaises(ValueError):
            h3_video_gen.render_template(self._preset_template("minimax_h3_fl2v"), params)

    def _nodes_of(self, graph, class_type):
        return sorted(nid for nid, n in graph.items() if n.get("class_type") == class_type)

    def test_r2v_template_executes_with_all_reference_kinds(self):
        # 参考图/参考视频/参考音频各自填入对应槽位；未挂的槽位连同加载链裁掉
        cfg = {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
               "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
               "vae": "minimax_h3_video_vae_fp16.safetensors"}
        body = {"prompt": "a cat walks", "references": [
            {"kind": "data", "data": _data_uri("image/png", b"img1")},
            {"kind": "data", "data": _data_uri("image/png", b"img2")},
            {"kind": "data", "data": _data_uri("video/mp4", b"vid1"), "media": "video"},
            {"kind": "data", "data": _data_uri("audio/wav", b"aud1"), "media": "audio"},
        ]}
        params = h3_video_gen.resolve_video_params(body, cfg)
        graph, _ = h3_video_gen.render_template(self._r2v_template(), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["21", "22"])
        self.assertEqual(self._nodes_of(graph, "LoadVideo"), ["31"])
        self.assertEqual(self._nodes_of(graph, "GetVideoComponents"), ["41"])
        self.assertEqual(self._nodes_of(graph, "LoadAudio"), ["51"])
        ref_in = graph["5"]["inputs"]
        self.assertIn("ref_images.ref_image_1", ref_in)
        self.assertNotIn("ref_images.ref_image_2", ref_in)   # 只挂 2 张图 → 其余槽位裁掉
        self.assertNotIn("ref_videos.ref_video_1", ref_in)
        self.assertIn("ref_audios.ref_audio_0", ref_in)
        self.assertNotIn("{{", json.dumps(graph), "渲染后不应残留占位符")
        out = image_gen_edit.execute_graph_inprocess(graph, output_type="VIDEO")
        self.assertEqual(out[0], "video")
        self.assertEqual(out[2], 24)
        self.assertEqual(out[3], "audio")

    def test_r2v_template_single_image_prunes_video_and_audio(self):
        cfg = {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
               "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
               "vae": "minimax_h3_video_vae_fp16.safetensors"}
        body = {"prompt": "x", "references": [{"kind": "data", "data": _data_uri("image/png", b"only")}]}
        params = h3_video_gen.resolve_video_params(body, cfg)
        graph, _ = h3_video_gen.render_template(self._r2v_template(), params)
        self.assertEqual(self._nodes_of(graph, "LoadImage"), ["21"])
        for cls in ("LoadVideo", "GetVideoComponents", "LoadAudio"):
            self.assertEqual(self._nodes_of(graph, cls), [], f"{cls} 无对应参考时应整条裁掉")
        self.assertIn("ref_images.ref_image_0", graph["5"]["inputs"])
        self.assertNotIn("ref_images.ref_image_1", graph["5"]["inputs"])
        self.assertNotIn("ref_videos.ref_video_0", graph["5"]["inputs"])
        self.assertNotIn("ref_audios.ref_audio_0", graph["5"]["inputs"])
        self.assertEqual(image_gen_edit.execute_graph_inprocess(graph, output_type="VIDEO")[0], "video")

    def test_r2v_template_keeps_demo_slots(self):
        # 模板只写演示槽（2 图 / 1 视频 / 1 音频），其余槽位靠运行时克隆补齐
        wf = self._r2v_template()
        for cls, n in (("LoadImage", 2), ("LoadVideo", 1), ("LoadAudio", 1)):
            self.assertEqual(len([node for node in wf.values() if node.get("class_type") == cls]), n)
        # 参考视频/音频槽位导出即默认跳过（bypass mode 4，占位文件不在 input 目录 → 灌画布不红框）
        for cls in ("LoadVideo", "LoadAudio"):
            for node in wf.values():
                if node.get("class_type") == cls:
                    self.assertEqual(node.get("mode"), 4, f"{cls} 参考槽应默认跳过")
        for node in wf.values():
            if node.get("class_type") == "LoadImage":
                self.assertIsNone(node.get("mode"), "LoadImage 参考槽不跳过")

    def test_r2v_expands_extra_image_slots(self):
        # 5 张参考图 → 克隆补齐 0 基槽位 ref_image_2..4
        body = {"prompt": "x", "references": [
            {"kind": "data", "data": _data_uri("image/png", bytes([i]))} for i in range(5)]}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._r2v_template(), params)
        ref_in = graph["5"]["inputs"]
        self.assertEqual(sorted(int(k.rsplit("_", 1)[1]) for k in ref_in if k.startswith("ref_images.")),
                         [0, 1, 2, 3, 4])
        for i in range(5):
            src = ref_in[f"ref_images.ref_image_{i}"][0]
            self.assertEqual(graph[src]["inputs"]["image"], params["ref_images"][i])
        self.assertEqual(image_gen_edit.execute_graph_inprocess(graph, output_type="VIDEO")[0], "video")

    def test_r2v_expands_video_and_audio_chains(self):
        # 2 段参考视频克隆整条 LoadVideo + GetVideoComponents 链，2 段参考音频克隆 LoadAudio
        body = {"prompt": "x", "references":
                [{"kind": "data", "data": _data_uri("video/mp4", bytes([i])), "media": "video"} for i in range(2)]
                + [{"kind": "data", "data": _data_uri("audio/wav", bytes([i])), "media": "audio"} for i in range(2)]}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._r2v_template(), params)
        ref_in = graph["5"]["inputs"]
        videos = self._nodes_of(graph, "LoadVideo")
        self.assertEqual(len(videos), 2)
        self.assertEqual(len(self._nodes_of(graph, "GetVideoComponents")), 2)
        self.assertEqual(len(self._nodes_of(graph, "LoadAudio")), 2)
        for i in range(2):
            comp = ref_in[f"ref_videos.ref_video_{i}"][0]
            self.assertEqual(graph[comp]["inputs"]["video"], [videos[i], 0])
            aud = ref_in[f"ref_audios.ref_audio_{i}"][0]
            self.assertEqual(graph[aud]["inputs"]["audio"], params["ref_audios"][i])

    def test_r2v_expansion_capped_at_max_refs(self):
        # 12 张图 → 按 config.json 的 max_refs=9 截断，槽位补齐到 0..8
        body = {"prompt": "x", "references": [
            {"kind": "data", "data": _data_uri("image/png", bytes([i]))} for i in range(12)]}
        params = h3_video_gen.resolve_video_params(body, self._fl2v_cfg())
        graph, _ = h3_video_gen.render_template(self._r2v_template(), params)
        self.assertEqual(sorted(int(k.rsplit("_", 1)[1]) for k in graph["5"]["inputs"]
                                if k.startswith("ref_images.")), list(range(9)))


class ReferenceTagTests(unittest.TestCase):
    """参考标签兜底：参考挂上了但提示词没写标签时补一行指代。

    没标签 = 参考零条件化（NeoL0 v2 的 G5 与无参考基线逐帧相同），所以缺标签必须补，
    而图生 / 首尾帧的首帧走 first_frame 锚点，补了反而是悬空标签。
    """

    _CFG = {"model": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            "text_encoder": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            "vae": "minimax_h3_video_vae_fp16.safetensors"}

    def _template(self, preset):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", preset, "workflow.json"),
                  encoding="utf-8") as f:
            return json.load(f)

    def _params(self, prompt, images=0, videos=0, audios=0):
        refs = ([{"kind": "data", "data": _data_uri("image/png", bytes([i]))} for i in range(images)]
                + [{"kind": "data", "data": _data_uri("video/mp4", bytes([i])), "media": "video"}
                   for i in range(videos)]
                + [{"kind": "data", "data": _data_uri("audio/wav", bytes([i])), "media": "audio"}
                   for i in range(audios)])
        return h3_video_gen.resolve_video_params({"prompt": prompt, "references": refs}, self._CFG)

    def test_missing_tags_are_appended_for_every_kind(self):
        template = self._template("minimax-h3-r2v")
        params = self._params("a cat walks the loft", images=1, videos=1, audios=1)
        h3_video_gen.ensure_reference_tags(template, params)
        for tag in ("<Picture 1>", "<Video 1>", "<Audio 1>"):
            self.assertIn(tag, params["prompt"])
        graph, _ = h3_video_gen.render_template(template, params)   # 补的标签要真的进条件节点
        self.assertIn("<Video 1>", graph["5"]["inputs"]["prompt"])

    def test_numbering_follows_reference_count(self):
        params = self._params("walk", images=3, videos=2)
        h3_video_gen.ensure_reference_tags(self._template("minimax-h3-r2v"), params)
        for tag in ("<Picture 1>", "<Picture 2>", "<Picture 3>", "<Video 1>", "<Video 2>"):
            self.assertEqual(params["prompt"].count(tag), 1)
        self.assertNotIn("<Picture 4>", params["prompt"])
        self.assertNotIn("<Video 3>", params["prompt"])

    def test_kind_already_tagged_is_not_duplicated(self):
        params = self._params("<Picture 1> 是主角", images=2, videos=1)
        h3_video_gen.ensure_reference_tags(self._template("minimax-h3-r2v"), params)
        self.assertEqual(params["prompt"].count("<Picture"), 1)   # 用户写的指代保持原样
        self.assertIn("<Video 1>", params["prompt"])

    def test_keyframe_template_gets_no_tags(self):
        # 图生技能的首帧进 first_frame 锚点，不是参考槽：补标签会凭空多一个没有对象的 <Picture 1>
        params = self._params("a cat walks", images=1)
        h3_video_gen.ensure_reference_tags(self._template("minimax_h3_i2v"), params)
        self.assertEqual(params["prompt"], "a cat walks")

    def test_kind_without_template_slot_gets_no_tag(self):
        # 模板没声明该类型的槽位（那条加载链会被整条裁掉）时不加标签，否则是悬空标签
        template = self._template("minimax-h3-r2v")
        del template["5"]["inputs"]["ref_audios.ref_audio_0"]
        params = self._params("walk", audios=1)
        h3_video_gen.ensure_reference_tags(template, params)
        self.assertNotIn("<Audio", params["prompt"])


class VideoModelsSortTests(unittest.TestCase):
    """/neo_video_gen/models 下拉展示：H3 相关靠前（与生图 krea2-first 独立）。"""

    def test_scan_video_models_sorts_h3_first(self):
        out = video_gen.scan_video_models()
        self.assertEqual(out["diffusion_models"][0], "minimax_h3_fl2va_pruned_int8_convrot.safetensors")
        self.assertEqual(out["text_encoders"][0], "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")
        self.assertEqual(out["vae"][:2], ["minimax_h3_audio_vae_fp32.safetensors",
                                          "minimax_h3_video_vae_fp16.safetensors"])
        self.assertIn("loras", out, "生视频模型接口应返回 loras 列表供 LoRA 下拉")

    def test_video_display_sort_prefers_h3_then_name(self):
        files = ["zeta.safetensors", "Minimax_H3/base.safetensors", "alpha.safetensors"]
        self.assertEqual(video_gen._video_display_sort(files),
                         ["Minimax_H3/base.safetensors", "alpha.safetensors", "zeta.safetensors"])


class VdnSkillTests(unittest.TestCase):
    """VDN 加速 skill：未装 ComfyUI-VDN-H3 时的明确报错 + 4 个 VDN preset 的结构校验。"""

    def test_vdn_missing_plugin_raises_clear_error(self):
        graph = {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "60": {"class_type": "ApplyVDNH3Advanced",
                   "inputs": {"model": ["1", 0], "vdn_checkpoint": "stage-dmd-step-250"}},
        }
        self.assertNotIn("ApplyVDNH3Advanced", _nodes.NODE_CLASS_MAPPINGS)
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_gen._require_vdn_plugin(graph)
        self.assertIn("ComfyUI-VDN-H3", str(ctx.exception))

    def test_vdn_registered_passes(self):
        class _FakeVdn:
            pass
        graph = {"60": {"class_type": "ApplyVDNH3Advanced", "inputs": {}}}
        _nodes.NODE_CLASS_MAPPINGS["ApplyVDNH3Advanced"] = _FakeVdn
        try:
            h3_video_gen._require_vdn_plugin(graph)   # 已注册 → 不报错
        finally:
            del _nodes.NODE_CLASS_MAPPINGS["ApplyVDNH3Advanced"]

    def test_non_vdn_graph_passes(self):
        graph = {"1": {"class_type": "UNETLoader", "inputs": {}},
                 "5": {"class_type": "MiniMaxH3SigmaShift", "inputs": {}}}
        h3_video_gen._require_vdn_plugin(graph)   # 无 VDN 节点 → 不报错

    def test_vdn_presets_wired_and_steps8(self):
        base = os.path.join(PLUGIN_DIR, "skills", "presets")
        for p in ("minimax_h3_vdn_t2v", "minimax_h3_vdn_i2v", "minimax_h3_vdn_fl2v", "minimax-h3-vdn-r2v"):
            wf = json.load(open(os.path.join(base, p, "workflow.json"), encoding="utf-8"))
            cfg = json.load(open(os.path.join(base, p, "config.json"), encoding="utf-8"))
            vdn = [nid for nid, n in wf.items() if str(n.get("class_type", "")).startswith("ApplyVDNH3")]
            self.assertEqual(len(vdn), 1, f"{p} 应恰有一个 VDN 节点")
            unet = [nid for nid, n in wf.items() if n.get("class_type") == "UNETLoader"]
            self.assertEqual(wf[vdn[0]]["inputs"]["model"], [unet[0], 0], f"{p} VDN 应接在 UNETLoader 之后")
            shifts = [n for n in wf.values() if n.get("class_type") == "MiniMaxH3SigmaShift"]
            self.assertTrue(any(n["inputs"]["model"] == [vdn[0], 0] for n in shifts), f"{p} SigmaShift 应接 VDN 输出")
            self.assertEqual(cfg.get("steps"), 8, f"{p} steps 应为 8")


if __name__ == "__main__":
    unittest.main()

restore(NODE_STUB_PREFIXES, _STUB_SAVED)
