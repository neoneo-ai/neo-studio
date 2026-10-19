# SPDX-License-Identifier: Apache-2.0
"""image_gen 的离线单测：比例/尺寸、输出路径消毒、请求解析、工作流模板渲染与技能路由。

不依赖 ComfyUI 运行中的服务器：server / folder_paths 用桩模块替换。
"""

from stub_env import NODE_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(NODE_STUB_PREFIXES)

import asyncio
import base64
import enum
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest

_TMP = tempfile.mkdtemp(prefix="neo_image_gen_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
_MODEL_DIR = os.path.join(_TMP, "models")   # 桩 get_full_path 的落点：模型文件真实存在时才有 mtime
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_MODELS = {
    "diffusion_models": ["krea2/krea2_turbo_fp16.safetensors"],
    "text_encoders": ["qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors"],
    "vae": ["krea2/diffusion_pytorch_model.safetensors",
            "qwen_image/qwen_image_vae.safetensors"],
    "loras": ["style_a.safetensors", "sub/style_b.safetensors",
              "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors"],
}

_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(
        get=lambda path: (lambda func: func),
        post=lambda path: (lambda func: func),
    ),
    prompt_queue=types.SimpleNamespace(),
    send_sync=lambda event, data, sid=None: None,
))
sys.modules["server"] = _server

_comfy = types.ModuleType("comfy")
_comfy_cli = types.ModuleType("comfy.cli_args")


class _LatentPreviewMethod(enum.Enum):
    NoPreviews = "none"
    Auto = "auto"
    Latent2RGB = "latent2rgb"
    TAESD = "taesd"


_comfy_cli.LatentPreviewMethod = _LatentPreviewMethod
_comfy_cli.args = types.SimpleNamespace(listen="127.0.0.1", port=8188,
                                        tls_keyfile=None, tls_certfile=None,
                                        preview_method=_LatentPreviewMethod.NoPreviews)
sys.modules["comfy"] = _comfy
sys.modules["comfy.cli_args"] = _comfy_cli

# image_gen 顶部 import get_progress_state；桩掉 comfy_execution.progress，
# 单测里换 _progress_registry_holder["registry"] 模拟核心每次执行重建 registry
_comfy_exec = types.ModuleType("comfy_execution")
_comfy_exec_prog = types.ModuleType("comfy_execution.progress")
_progress_registry_holder = {"registry": types.SimpleNamespace(prompt_id="", nodes={}, handlers={})}
_comfy_exec_prog.get_progress_state = lambda: _progress_registry_holder["registry"]


class _ProgressHandlerStub:
    def __init__(self, name):
        self.name = name


def _add_progress_handler_stub(handler):
    _progress_registry_holder["registry"].handlers[handler.name] = handler


_comfy_exec_prog.ProgressHandler = _ProgressHandlerStub
_comfy_exec_prog.add_progress_handler = _add_progress_handler_stub
sys.modules["comfy_execution"] = _comfy_exec
sys.modules["comfy_execution.progress"] = _comfy_exec_prog

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: list(_MODELS.get(folder, []))
_folder_paths.get_full_path = lambda folder, name: os.path.join(_MODEL_DIR, folder, name)
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
sys.modules["folder_paths"] = _folder_paths

# skill.py 顶层 import nodes（运行期才读 NODE_CLASS_MAPPINGS）：桩掉避免拉起真实 ComfyUI
_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
sys.modules["nodes"] = _nodes

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)

# image_gen 含相对导入（from .util import ...），需先建虚拟包再加载
_pkg = types.ModuleType("_neo_imgen_pkg")
_pkg.__path__ = [PLUGIN_DIR]
sys.modules["_neo_imgen_pkg"] = _pkg

_util_mod = types.ModuleType("_neo_imgen_pkg.util")
import logging as _logging
class _PF(_logging.Filter):
    def filter(self, record):
        return True
_util_mod.PrefixFilter = _PF
# image_gen 在模块导入期就要这两个比例工具（技能模板 {{ASPECT_RATIO}} 的 combo label 表与解析）：
# 桩里镜像 studio/util.py 的同名定义
_util_mod.ASPECT_LABELS = {"1:1": "1:1 (Square)", "2:3": "2:3 (Portrait Photo)", "3:2": "3:2 (Photo)",
                           "3:4": "3:4 (Portrait Standard)", "4:3": "4:3 (Standard)",
                           "9:16": "9:16 (Portrait Widescreen)", "16:9": "16:9 (Widescreen)",
                           "21:9": "21:9 (Ultrawide)"}


def _stub_ratio_pair(text):
    head = str(text or "").strip().split(" ")[0].lower().replace("x", ":").replace("/", ":")
    parts = head.split(":")
    if len(parts) != 2:
        return None
    try:
        w, h = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    return (w, h) if w > 0 and h > 0 else None


_util_mod.ratio_pair = _stub_ratio_pair
sys.modules["_neo_imgen_pkg.util"] = _util_mod
_pkg.util = _util_mod

_spec = importlib.util.spec_from_file_location(
    "_neo_imgen_pkg.image_gen_files", os.path.join(PLUGIN_DIR, "image_gen_files.py"))
image_gen_files = importlib.util.module_from_spec(_spec)
sys.modules["_neo_imgen_pkg.image_gen_files"] = image_gen_files
_spec.loader.exec_module(image_gen_files)
_pkg.image_gen_files = image_gen_files

_spec = importlib.util.spec_from_file_location(
    "_neo_imgen_pkg.image_gen", os.path.join(PLUGIN_DIR, "image_gen.py"))
image_gen = importlib.util.module_from_spec(_spec)
sys.modules["_neo_imgen_pkg.image_gen"] = image_gen
_spec.loader.exec_module(image_gen)
_pkg.image_gen = image_gen

# image_gen 的路由处理器内惰性 `from . import skill`；把 skill.py 注册到虚拟包下，
# 让单测里相对导入可解析（与 test_skills 的桩策略一致）
_spec = importlib.util.spec_from_file_location(
    "_neo_imgen_pkg.skill", os.path.join(PLUGIN_DIR, "skill.py"))
_skill_mod = importlib.util.module_from_spec(_spec)
sys.modules["_neo_imgen_pkg.skill"] = _skill_mod
_spec.loader.exec_module(_skill_mod)
_pkg.skill = _skill_mod


def base_settings():
    return dict(image_gen.DEFAULT_SETTINGS)


def load_preset_template(skill: str) -> dict:
    """读预设技能的 workflow.json（模板链路已写进文件，测试直接按它渲染）。"""
    with open(os.path.join(PLUGIN_DIR, "skills", "presets", skill, "workflow.json"),
              encoding="utf-8") as f:
        return json.load(f)


def load_preset_config(skill: str) -> dict:
    """读预设技能的 config.json（min_refs / max_refs 等渲染约束按文件里的真实值测）。"""
    with open(os.path.join(PLUGIN_DIR, "skills", "presets", skill, "config.json"),
              encoding="utf-8") as f:
        return json.load(f)


def write_png(path: str, width: int, height: int) -> bytes:
    from PIL import Image
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with Image.new("RGB", (width, height), (200, 30, 30)) as img:
        img.save(path, format="PNG")
    with open(path, "rb") as f:
        return f.read()


class RatioTests(unittest.TestCase):
    def test_parse_ratio(self):
        self.assertAlmostEqual(image_gen.parse_ratio("16:9"), 16 / 9)
        self.assertAlmostEqual(image_gen.parse_ratio("16x9"), 16 / 9)
        self.assertAlmostEqual(image_gen.parse_ratio("1.5"), 1.5)
        self.assertIsNone(image_gen.parse_ratio("bad"))
        self.assertIsNone(image_gen.parse_ratio("0"))

    def test_size_from_ratio(self):
        self.assertEqual(image_gen.size_from_ratio(2 / 3, 1536), (1024, 1536))
        self.assertEqual(image_gen.size_from_ratio(1.0, 1024), (1024, 1024))

    def test_explicit_dimensions_rounded(self):
        w, h = image_gen.resolve_dimensions(base_settings(), width=1000, height=1000)
        self.assertEqual((w, h), (1008, 1008))


class PrefixTests(unittest.TestCase):
    def test_traversal_rejected(self):
        with self.assertRaises(ValueError):
            image_gen.safe_prefix("NeoAgent/../../evil")

    def test_sanitized(self):
        self.assertEqual(image_gen.safe_prefix("a\\b<>c"), "a/bc")

    def test_slug(self):
        self.assertEqual(image_gen.slug_from_text("A red fox jumps over the fence"),
                         "a_red_fox_jumps_over_the")
        self.assertEqual(image_gen.slug_from_text("你好世界"), "")


class SuggestTests(unittest.TestCase):
    """自动挑选：Krea2 只精确匹配 Qwen3-VL-4B，8B/32B 不参与（挑了必报 conditioning 维度错误）"""

    def setUp(self):
        self._orig = image_gen_files._folder_files

    def tearDown(self):
        image_gen_files._folder_files = self._orig

    def _with_files(self, files):
        image_gen_files._folder_files = lambda folder: files

    def test_encoder_prefers_4b_over_8b(self):
        self._with_files(["qwen3vl_8b_fp8_scaled.safetensors", "qwen3vl_4b_fp8_scaled.safetensors"])
        self.assertEqual(image_gen.suggest_model("text_encoders"),
                         "qwen3vl_4b_fp8_scaled.safetensors")

    def test_encoder_ignores_8b_and_32b(self):
        self._with_files(["qwen3vl_8b_nvfp4.safetensors",
                          "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"])
        self.assertEqual(image_gen.suggest_model("text_encoders"), "")

    def test_vae_prefers_qwen_image(self):
        self._with_files(["Krea2-HD-vae.safetensors", "qwen_image_vae.safetensors"])
        self.assertEqual(image_gen.suggest_model("vae"), "qwen_image_vae.safetensors")


class ScanModelsTests(unittest.TestCase):
    """下拉展示：krea2 相关靠前；各目录自动挑选结果（LoRA 无名称线索，不给出建议）。"""

    def test_scan_models_sorts_krea2_first(self):
        out = image_gen.scan_models()
        self.assertEqual(out["loras"][0], "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")
        self.assertEqual(out["vae"][0], "krea2/diffusion_pytorch_model.safetensors")

    def test_scan_models_no_lora_suggestion(self):
        out = image_gen.scan_models()
        self.assertEqual(out["suggested_loras"], "")

    def test_scan_models_carries_file_mtime(self):
        """下拉显示更新时间：mtimes_* 是「模型名 → epoch 秒」；文件取不到的目录留空，列表照常。"""
        stamp = 1700000000.0
        for name in _MODELS["vae"]:
            path = os.path.join(_MODEL_DIR, "vae", name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w"):
                pass
            os.utime(path, (stamp, stamp))
        out = image_gen.scan_models()
        self.assertEqual(set(out["mtimes_vae"]), set(_MODELS["vae"]))
        self.assertEqual(out["mtimes_vae"]["qwen_image/qwen_image_vae.safetensors"], stamp)
        self.assertEqual(out["mtimes_loras"], {}, "桩目录里没有 LoRA 文件 → 无时间，loras 列表照常给出")
        self.assertTrue(out["loras"])

    def test_display_sort_prefers_krea2_then_name(self):
        files = ["zeta.safetensors", "Krea2/base.safetensors", "alpha.safetensors"]
        self.assertEqual(image_gen._display_sort(files),
                         ["Krea2/base.safetensors", "alpha.safetensors", "zeta.safetensors"])


class ResolveTests(unittest.TestCase):
    def test_auto_model_selection(self):
        params = image_gen.resolve_request({"prompt": "a cat"}, base_settings())
        self.assertEqual(params["model"], "krea2/krea2_turbo_fp16.safetensors")
        self.assertEqual(params["text_encoder"], "qwen3vl/qwen3_vl_4b_fp8_scaled.safetensors")
        self.assertEqual(params["vae"], "qwen_image/qwen_image_vae.safetensors")
        self.assertEqual(params["count"], 1)

    def test_empty_prompt_rejected(self):
        with self.assertRaises(ValueError):
            image_gen.resolve_request({"prompt": "   "}, base_settings())

    def test_ratio_and_seed_fixed(self):
        settings = base_settings()
        settings["base_resolution"] = 1536
        params = image_gen.resolve_request(
            {"prompt": "a cat", "ratio": "2:3", "seed": 7}, settings)
        self.assertEqual((params["width"], params["height"]), (1024, 1536))
        self.assertEqual(params["seed"], 7)

    def test_t2i_follows_settings_default_ratio(self):
        settings = base_settings()
        settings["default_ratio"] = "16:9"
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual((params["width"], params["height"]), (1280, 720))
        # skill 声明比例已废弃：请求里带上也不生效，比例只看生图设置
        # （四视图由后端固定 16:9，与该分支无关）
        params = image_gen.resolve_request(
            {"prompt": "a cat", "skill_ratio": "9:16"}, settings)
        self.assertEqual((params["width"], params["height"]), (1280, 720))

    def test_lora_warnings_for_missing(self):
        settings = base_settings()
        settings["loras"] = [{"name": "style_a.safetensors", "strength": 0.5},
                             {"name": "nope.safetensors", "strength": 1.0}]
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual(params["loras"],
                         [{"name": "style_a.safetensors", "strength": 0.5}])
        self.assertTrue(params["warnings"])

    def test_count_from_settings_and_body(self):
        settings = base_settings()
        settings["count"] = 3
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual(params["count"], 3)
        params = image_gen.resolve_request({"prompt": "a cat", "count": 2}, settings)
        self.assertEqual(params["count"], 2)
        params = image_gen.resolve_request({"prompt": "a cat", "count": 99}, settings)
        self.assertEqual(params["count"], 8)

    def test_steps_priority(self):
        # 缺省 20（skill config.json 与请求都未给）
        params = image_gen.resolve_request({"prompt": "a cat"}, base_settings())
        self.assertEqual(params["steps"], 20)
        # skill config.json 的默认值（经设置合并传入）
        settings = base_settings()
        settings["steps"] = 25
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual(params["steps"], 25)
        # 本次请求（节点入参/接口 body）覆盖 skill 设置
        params = image_gen.resolve_request({"prompt": "a cat", "steps": 8}, settings)
        self.assertEqual(params["steps"], 8)

    def test_missing_model_folder_raises(self):
        with self.assertRaises(ValueError):
            image_gen.resolve_request({"prompt": "a cat"},
                                      {"model": "ghost.safetensors"})


class ReferenceTests(unittest.TestCase):
    def test_input_reference(self):
        write_png(os.path.join(_INPUT_DIR, "ref.png"), 768, 1024)
        params = image_gen.resolve_request(
            {"prompt": " redraw ", "references": [{"kind": "input", "value": "ref.png"}],
             "count": 3}, base_settings())
        self.assertEqual(params["ref_name"], "ref.png")
        # 尺寸跟随设置比例（默认 1:1）；采样参数写死在工作流模板里
        self.assertEqual((params["width"], params["height"]), (1280, 1280))
        self.assertEqual(params["prompt"], "redraw")
        # 参考图长边限到 1024：768×1024 → 768×1024
        self.assertEqual(params["ref_scale"], (768, 1024))

    def test_data_uri_reference_copied_to_input(self):
        raw = write_png(os.path.join(_TMP, "seed.png"), 32, 32)
        uri = "data:image/png;base64," + base64.b64encode(raw).decode()
        name = image_gen._reference_name({"kind": "data", "data": uri})
        digest = hashlib.sha1(raw).hexdigest()[:12]
        self.assertEqual(name, f"NeoAgent/ref_{digest}.png")
        self.assertTrue(os.path.isfile(os.path.join(_INPUT_DIR, name)))

    def test_unreadable_reference_raises(self):
        with self.assertRaises(ValueError):
            image_gen.resolve_request(
                {"prompt": "x", "references": [{"kind": "input", "value": "gone.png"}]},
                base_settings())


class RenderTemplateTests(unittest.TestCase):
    """workflow.json 模板渲染：占位符替换（类型化取值）+ LoRA 槽位填充 / 动态注入。"""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "image_gen", "workflow.json"),
                  encoding="utf-8") as f:
            cls.text_template = json.load(f)
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "image_gen_image", "workflow.json"),
                  encoding="utf-8") as f:
            cls.ref_template = json.load(f)

    def params(self, **overrides):
        settings = base_settings()
        settings["loras"] = [{"name": "style_a.safetensors", "strength": 0.5},
                             {"name": "sub/style_b.safetensors", "strength": 1.0}]
        return image_gen.resolve_request({"prompt": "a red fox", "seed": 3, **overrides},
                                         settings)

    def test_text_to_image_shape(self):
        graph, warns = image_gen.render_template(self.text_template, self.params(count=3))
        self.assertEqual(warns, [])
        latent = graph["9"]["inputs"]
        self.assertEqual(latent["batch_size"], 3)          # {{COUNT}} 取 int 类型值
        self.assertEqual((latent["width"], latent["height"]), (1280, 1280))
        self.assertEqual(graph["4"]["inputs"]["text"], "a red fox")
        self.assertEqual(graph["5"]["inputs"]["text"], "")
        self.assertEqual(graph["1"]["inputs"]["unet_name"], "krea2/krea2_turbo_fp16.safetensors")
        self.assertEqual(graph["10"]["inputs"]["seed"], 3)
        self.assertTrue(str(graph["12"]["inputs"]["filename_prefix"]).startswith("NeoAgent/"))

    def test_unknown_placeholder_raises(self):
        """模板里有后端不认识的占位符：直接报错，别把 {{XXX}} 原样提交（ComfyUI 只会报 float 转换失败）。"""
        template = {"1": {"class_type": "LoadImage", "inputs": {"image": "{{NOPE_TOKEN}}"}}}
        with self.assertRaises(ValueError):
            image_gen.render_template(template, self.params())

    def test_resolution_selector_tokens(self):
        """分辨率选择器模板：{{MEGAPIXELS}} 取本次输出尺寸反算的百万像素，{{ASPECT_RATIO}} 取 combo 认得的那一项。"""
        template = {"19": {"class_type": "ResolutionSelector",
                           "inputs": {"aspect_ratio": "{{ASPECT_RATIO}}", "megapixels": "{{MEGAPIXELS}}",
                                      "multiple": 16}},
                    "35": {"class_type": "EmptyFlux2LatentImage",
                           "inputs": {"width": ["19", 0], "height": ["19", 1], "batch_size": 1}}}
        params = self.params(ratio="16:9")
        graph, _ = image_gen.render_template(template, params)
        self.assertEqual(graph["19"]["inputs"]["aspect_ratio"], "16:9 (Widescreen)")
        self.assertEqual(graph["19"]["inputs"]["megapixels"],
                         round(params["width"] * params["height"] / (1024 * 1024), 2))

    def test_aspect_ratio_outside_selector_combo_raises(self):
        """技能比例不在分辨率选择器的 combo 里：明确报错，不把裸比例提交（节点按 label 取字典会 KeyError）。"""
        template = {"19": {"class_type": "ResolutionSelector",
                           "inputs": {"aspect_ratio": "{{ASPECT_RATIO}}", "megapixels": 1.0, "multiple": 16}}}
        with self.assertRaises(ValueError):
            image_gen.render_template(template, self.params(ratio="5:3"))

    def test_lora_dynamic_insertion_after_unet(self):
        # 文生图模板没有 LoRA 槽位：两个用户 LoRA 在主链末端动态串联
        graph, _ = image_gen.render_template(self.text_template, self.params())
        self.assertEqual(graph["13"]["class_type"], "LoraLoaderModelOnly")
        self.assertEqual(graph["13"]["inputs"], {"model": ["1", 0], "lora_name": "style_a.safetensors",
                                                 "strength_model": 0.5})
        self.assertEqual(graph["14"]["inputs"]["model"], ["13", 0])
        self.assertEqual(graph["14"]["inputs"]["lora_name"], "sub/style_b.safetensors")
        self.assertEqual(graph["10"]["inputs"]["model"], ["14", 0])   # KSampler 吃链尾

    def test_reference_template_rendering(self):
        write_png(os.path.join(_INPUT_DIR, "ref3.png"), 768, 1024)
        params = self.params(references=[{"kind": "input", "value": "ref3.png"}])
        graph, _ = image_gen.render_template(self.ref_template, params)
        self.assertEqual(graph["6"]["inputs"]["image"], "ref3.png")
        scale = graph["7"]["inputs"]
        self.assertEqual((scale["width"], scale["height"]), (768, 1024))
        self.assertEqual(scale["crop"], "disabled")
        self.assertEqual(graph["4"]["inputs"]["prompt"], "a red fox")
        # 单槽位填第一个 LoRA；其余在槽位后动态串联到 model patch
        self.assertEqual(graph["20"]["inputs"]["lora_name"], "style_a.safetensors")
        self.assertAlmostEqual(graph["20"]["inputs"]["strength_model"], 0.5)
        self.assertEqual(graph["21"]["inputs"], {"model": ["20", 0], "lora_name": "sub/style_b.safetensors",
                                                 "strength_model": 1.0})
        self.assertEqual(graph["14"]["inputs"]["model"], ["21", 0])   # model patch 吃链尾
        self.assertAlmostEqual(graph["10"]["inputs"]["denoise"], 1.0)  # 采样参数写死在模板

    def test_ref_template_requires_reference(self):
        with self.assertRaises(ValueError):
            image_gen.render_template(self.ref_template, self.params())

    def test_preset_template_steps_from_config(self):
        # 生图预设模板的 steps 是 {{STEPS}} 占位符：默认值取该技能 config.json（经设置合并），请求可覆盖
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "image_gen", "config.json"),
                  encoding="utf-8") as f:
            cfg = json.load(f)
        settings = dict(image_gen.DEFAULT_SETTINGS)
        for key, value in cfg.items():
            if key in image_gen._SKILL_SETTING_KEYS and value not in (None, "", []):
                settings[key] = value
        params = image_gen.resolve_request({"prompt": "a cat"}, settings)
        self.assertEqual(params["steps"], 8)   # config.json 默认 steps=8
        graph, _ = image_gen.render_template(self.text_template, params)
        self.assertEqual(graph["10"]["inputs"]["steps"], 8)
        # 请求覆盖（节点 steps 入参 / 接口 body）
        params = image_gen.resolve_request({"prompt": "a cat", "steps": 30}, settings)
        graph, _ = image_gen.render_template(self.text_template, params)
        self.assertEqual(graph["10"]["inputs"]["steps"], 30)

    def test_lora_slot_fallback_and_missing_raises(self):
        template = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "{{MODEL}}"}},
            "2": {"class_type": "LoraLoaderModelOnly",
                  "inputs": {"model": ["1", 0], "lora_name": "{{LORA_1_NAME}}",
                             "strength_model": "{{LORA_1_STRENGTH}}"}},
        }
        params = image_gen.resolve_request({"prompt": "a cat"}, base_settings())
        graph, _ = image_gen.render_template(template, params)
        # 空槽：loras 目录排序第一的文件兜底 + strength 0（可加载但无效）
        self.assertEqual(graph["2"]["inputs"]["lora_name"],
                         "krea2/Edit/Krea2-四视图QuadView_krea2_v1.safetensors")
        self.assertEqual(graph["2"]["inputs"]["strength_model"], 0.0)

        orig = image_gen._folder_files
        try:
            # 兜底扫描在 image_gen（模板渲染）与 image_gen_files（模型扫描）两处都要摘掉 loras
            image_gen._folder_files = image_gen_files._folder_files = \
                lambda folder: [] if folder == "loras" else orig(folder)
            with self.assertRaises(ValueError):
                image_gen.render_template(template, params)
        finally:
            image_gen._folder_files = image_gen_files._folder_files = orig

    def test_reference_scale_follows_source_aspect(self):
        # 超宽参考图：长边限到 1024 → 1024×512
        write_png(os.path.join(_INPUT_DIR, "ref_wide.png"), 1600, 800)
        params = self.params(references=[{"kind": "input", "value": "ref_wide.png"}])
        self.assertEqual(params["ref_scale"], (1024, 512))


class TemplateRefSlotTests(unittest.TestCase):
    """模板探测：{{REF_IMAGE_n}} 槽位数（可保留的参考图张数）。"""

    def test_max_refs_counts_highest_slot(self):
        template = {
            "4": {"class_type": "TextEncodeQwenImage21",
                  "inputs": {"images.image_1": "{{REF_IMAGE_1}}", "images.image_4": "{{REF_IMAGE_4}}"}},
        }
        self.assertEqual(image_gen.template_max_refs(template), 4)

    def test_max_refs_defaults_to_one(self):
        # 单路单帧模板（Krea2/首帧技能）与纯文生图模板都按 1 张处理
        self.assertEqual(image_gen.template_max_refs(
            {"1": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE}}"}}}), 1)
        self.assertEqual(image_gen.template_max_refs({}), 1)


class RefSlotExpansionTests(unittest.TestCase):
    """参考槽位运行时扩展：模板只写演示用的前几槽，张数上限由 config.json 的 max_refs 声明。"""

    TWO_SLOTS = load_preset_template("qwen_image_21")

    ONE_SLOT = {
        "4": {"class_type": "TextEncodeQwenImage21",
              "inputs": {"prompt": "{{PROMPT}}", "images.image_1": ["30", 0]}},
        "10": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_1}}"}},
        "30": {"class_type": "ImageScale",
               "inputs": {"image": ["10", 0], "width": "{{CANVAS_WIDTH}}",
                          "height": "{{CANVAS_HEIGHT}}", "crop": "disabled"}},
    }

    @classmethod
    def setUpClass(cls):
        for i in range(1, 21):
            write_png(os.path.join(_INPUT_DIR, f"exp_ref_{i}.png"), 512, 512)

    def params(self, n, max_refs=10):
        refs = [{"kind": "input", "value": f"exp_ref_{i}.png"} for i in range(1, n + 1)]
        return image_gen.resolve_request({"prompt": "分镜", "seed": 1, "references": refs},
                                         base_settings(), max_refs=max_refs)

    def slot_images(self, graph, node="4"):
        """消费者各槽位实际吃的图片名（按槽序号，沿预处理链回溯到 LoadImage）。"""
        inputs = graph[node]["inputs"]
        out, k = [], 1
        while f"images.image_{k}" in inputs:
            nid = inputs[f"images.image_{k}"][0]
            while graph[nid]["class_type"] != "LoadImage":
                nid = graph[nid]["inputs"]["image"][0]
            out.append(graph[nid]["inputs"]["image"])
            k += 1
        return out

    def test_preset_template_keeps_two_demo_slots(self):
        loads = [n for n in self.TWO_SLOTS.values() if n.get("class_type") == "LoadImage"]
        self.assertEqual(len(loads), 2, "模板只留演示槽，容量在 config.json")
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21", "config.json"),
                  encoding="utf-8") as f:
            self.assertEqual(json.load(f)["max_refs"], 10)

    def test_extra_refs_clone_the_bare_slot(self):
        graph, _ = image_gen.render_template(self.TWO_SLOTS, self.params(4))
        self.assertEqual(self.slot_images(graph), [f"exp_ref_{i}.png" for i in range(1, 5)])
        scales = [n for n in graph.values() if n.get("class_type") == "ImageScale"]
        self.assertEqual(len(scales), 1, "克隆裸 LoadImage 原型，不复制槽 1 的缩放链")

    def test_unfilled_slots_pruned(self):
        graph, _ = image_gen.render_template(self.TWO_SLOTS, self.params(1))
        self.assertEqual(self.slot_images(graph), ["exp_ref_1.png"])
        graph, _ = image_gen.render_template(self.TWO_SLOTS, self.params(0))
        self.assertEqual(self.slot_images(graph), [])
        self.assertFalse([n for n in graph.values() if n.get("class_type") == "ImageScale"])

    def test_slot_chain_cloned_with_its_scale(self):
        graph, _ = image_gen.render_template(self.ONE_SLOT, self.params(3, max_refs=3))
        self.assertEqual(self.slot_images(graph), [f"exp_ref_{i}.png" for i in range(1, 4)])
        scales = [n for n in graph.values() if n.get("class_type") == "ImageScale"]
        self.assertEqual(len(scales), 3, "单槽模板的原型含 ImageScale，整条链一起克隆")

    def test_expansion_capped_at_autogrow_names(self):
        graph, _ = image_gen.render_template(self.TWO_SLOTS, self.params(20, max_refs=20))
        self.assertEqual(len(self.slot_images(graph)), 17)

    def test_max_refs_prefers_config(self):
        template = {"1": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_3}}"}}}
        self.assertEqual(image_gen.template_max_refs(template), 3)
        self.assertEqual(image_gen.template_max_refs(template, {"max_refs": 10}), 10)
        self.assertEqual(image_gen.template_max_refs(template, {"max_refs": "0"}), 3)


class ControlNetPresetRenderTests(unittest.TestCase):
    """qwen_image_21_controlnet 模板渲染：姿势图只进模型补丁，内容与长相只进编码器。"""

    TEMPLATE = load_preset_template("qwen_image_21_controlnet")
    CFG = load_preset_config("qwen_image_21_controlnet")

    @classmethod
    def setUpClass(cls):
        for i in range(1, 5):
            write_png(os.path.join(_INPUT_DIR, f"cn_ref_{i}.png"), 512, 512)

    def params(self, n, min_refs=None):
        refs = [{"kind": "input", "value": f"cn_ref_{i}.png"} for i in range(1, n + 1)]
        settings = base_settings()
        settings["min_refs"] = self.CFG.get("min_refs", 0) if min_refs is None else min_refs
        settings["control_ref"] = self.CFG.get("control_ref", 0)
        return image_gen.resolve_request({"prompt": "a dancer", "seed": 1, "references": refs},
                                         settings, max_refs=4)

    def encoder_images(self, graph):
        enc = next(n for n in graph.values() if n["class_type"] == "TextEncodeQwenImage21")
        out, k = [], 1
        while f"images.image_{k}" in enc["inputs"]:
            out.append(graph[enc["inputs"][f"images.image_{k}"][0]]["inputs"]["image"])
            k += 1
        return out

    def cnet_node(self, graph):
        return next(n for n in graph.values() if n["class_type"] == "ZImageFunControlnet")

    def test_control_ref_feeds_the_model_patch_only(self):
        """姿势图 → Openpose 骨架 → 模型补丁；编码器里没有它，否则模型直接复刻姿势照片。"""
        graph, _ = image_gen.render_template(self.TEMPLATE, self.params(2))
        cnet = self.cnet_node(graph)
        pre = graph[cnet["inputs"]["image"][0]]
        self.assertEqual(pre["class_type"], "AIO_Preprocessor")
        self.assertEqual(pre["inputs"]["preprocessor"], "OpenposePreprocessor")
        self.assertIsInstance(pre["inputs"]["resolution"], int)
        self.assertGreater(pre["inputs"]["resolution"], 0)
        self.assertEqual(graph[pre["inputs"]["image"][0]]["inputs"]["image"], "cn_ref_2.png")
        self.assertEqual(self.encoder_images(graph), ["cn_ref_1.png"])
        sampler = next(n for n in graph.values() if n["class_type"] == "KSampler")
        cnet_id = next(k for k, n in graph.items() if n["class_type"] == "ZImageFunControlnet")
        self.assertEqual(sampler["inputs"]["model"][0], cnet_id)

    def test_control_ref_leaves_the_encoder_ref_list(self):
        self.assertIn("control_ref", image_gen._SKILL_SETTING_KEYS)
        p = self.params(3)
        self.assertEqual(p["control_image"], "cn_ref_2.png")
        self.assertEqual(p["ref_images"], ["cn_ref_1.png", "cn_ref_3.png"])

    def test_extra_refs_expand_encoder_slots_in_order(self):
        """附加内容参考顺位补进编码器槽，控制图不占槽。"""
        graph, _ = image_gen.render_template(self.TEMPLATE, self.params(4))
        self.assertEqual(self.encoder_images(graph),
                         ["cn_ref_1.png", "cn_ref_3.png", "cn_ref_4.png"])

    def test_fewer_refs_than_min_raises(self):
        """姿势槽（第 2 张）空时控制链会渲染成缺输入的图：张数不足必须在解析期拦住。"""
        self.assertIn("min_refs", image_gen._SKILL_SETTING_KEYS)
        self.assertGreaterEqual(self.CFG.get("min_refs", 0), 2)
        with self.assertRaises(ValueError) as ctx:
            self.params(1)
        self.assertIn("参考图", str(ctx.exception))

    def test_no_reference_prunes_control_chain(self):
        graph, _ = image_gen.render_template(self.TEMPLATE, self.params(0, min_refs=0))
        self.assertEqual(self.encoder_images(graph), [])
        self.assertFalse([n for n in graph.values()
                          if n["class_type"] in ("AIO_Preprocessor", "LoadImage")])
        self.assertNotIn("image", self.cnet_node(graph)["inputs"])


class StartGenerationTemplateRouteTests(unittest.TestCase):
    """start_generation 按模板决定参考槽位数（与 ImageGenEditNode 一致）。"""

    QWEN_TEMPLATE = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "{{MODEL}}"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "{{TEXT_ENCODER}}"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "{{VAE}}"}},
        "4": {"class_type": "TextEncodeQwenImage21",
              "inputs": {"prompt": "{{PROMPT}}",
                         "images.image_1": ["10", 0], "images.image_2": ["12", 0]}},
        "5": {"class_type": "EmptyLatentImage",
              "inputs": {"width": "{{WIDTH}}", "height": "{{HEIGHT}}"}},
        "6": {"class_type": "KSampler",
              "inputs": {"model": ["1", 0], "seed": "{{SEED}}", "steps": "{{STEPS}}",
                         "positive": ["4", 0], "negative": ["4", 1], "latent_image": ["5", 0]}},
        "7": {"class_type": "VAEDecode",
              "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage",
              "inputs": {"images": ["7", 0], "filename_prefix": "{{PREFIX}}"}},
        "10": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_1}}"}},
        "12": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_2}}"}},
    }

    PLAIN_TEMPLATE = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "{{MODEL}}"}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
    }

    def _run(self, template, body, cfg=None):
        captured = {}
        orig = (image_gen.get_settings, image_gen.submit_graph, image_gen._watch,
                _skill_mod.load_skill_workflow, _skill_mod.get_skill_gen_config)

        async def no_watch(task_id):
            return None

        async def fake_submit(graph):
            captured["graph"] = graph
            return "prompt-1"

        try:
            image_gen.get_settings = lambda: dict(base_settings(), **{k: v for k, v in (cfg or {}).items()
                                                                      if k in image_gen._SKILL_SETTING_KEYS})
            image_gen.submit_graph = fake_submit
            image_gen._watch = no_watch
            _skill_mod.load_skill_workflow = lambda sid: template
            _skill_mod.get_skill_gen_config = lambda sid: (cfg or {})
            write_png(os.path.join(_INPUT_DIR, "portrait.png"), 768, 1024)
            snap = asyncio.run(image_gen.start_generation(body))
        finally:
            (image_gen.get_settings, image_gen.submit_graph, image_gen._watch,
             _skill_mod.load_skill_workflow, _skill_mod.get_skill_gen_config) = orig
        return snap, captured

    def test_multi_ref_template_prunes_empty_slots(self):
        # Qwen Image 2.1 多路槽位模板：首张参考填槽 1，空槽连同 LoadImage 与连线裁掉
        snap, captured = self._run(
            self.QWEN_TEMPLATE,
            {"skill_id": "qwen_image_21", "prompt": "角色设定图",
             "references": [{"kind": "input", "value": "portrait.png"}]})
        self.assertEqual(snap["status"], "queued")
        graph = captured["graph"]
        self.assertEqual(graph["10"]["inputs"]["image"], "portrait.png")
        self.assertNotIn("12", graph)  # 第二槽无参考 → LoadImage 与连线一并裁掉
        self.assertNotIn("images.image_2", graph["4"]["inputs"])

    def test_remove_points_uses_sam3_local_edit(self):
        # 点选删除：SAM3 分割 → 遮罩，走局部编辑管线（标红裁剪 + 羽化合并），空提示词填默认删除指令
        seg_calls = {}

        async def fake_seg(ref_name, points):
            seg_calls["ref"] = ref_name
            seg_calls["points"] = points
            write_png(os.path.join(_INPUT_DIR, "NeoAgent", "_neo_sam3_mask_test.png"), 768, 1024)
            return "NeoAgent/_neo_sam3_mask_test.png"

        orig = image_gen._sam3_segment
        try:
            image_gen._sam3_segment = fake_seg
            snap, captured = self._run(
                self.QWEN_TEMPLATE,
                {"skill_id": "qwen_image_21", "prompt": "",
                 "remove_points": [{"x": 100, "y": 200}],
                 "references": [{"kind": "input", "value": "portrait.png"}]})
        finally:
            image_gen._sam3_segment = orig
        self.assertEqual(snap["status"], "queued")
        self.assertEqual(seg_calls["ref"], "portrait.png")
        self.assertEqual(seg_calls["points"], [{"x": 100, "y": 200}])
        self.assertIn("red highlighted area", snap["prompt"])
        # 遮罩走局部编辑管线：红色高亮裁剪图注入编码器参考槽
        graph = captured["graph"]
        hl_nodes = [n for n in graph.values() if isinstance(n, dict)
                    and n.get("class_type") == "LoadImage"
                    and str(n["inputs"]["image"]).startswith("NeoAgent/_neo_local_hl_")]
        self.assertEqual(len(hl_nodes), 1)

    def test_remove_points_requires_reference(self):
        with self.assertRaises(ValueError):
            self._run(
                self.QWEN_TEMPLATE,
                {"skill_id": "qwen_image_21", "prompt": "",
                 "remove_points": [{"x": 100, "y": 200}]})

    def test_remove_points_user_prompt_used_as_is(self):
        # 非空用户提示词原样使用；SAM3 分割照常执行
        async def fake_seg(ref_name, points):
            write_png(os.path.join(_INPUT_DIR, "NeoAgent", "_neo_sam3_mask_test.png"), 768, 1024)
            return "NeoAgent/_neo_sam3_mask_test.png"

        orig = image_gen._sam3_segment
        try:
            image_gen._sam3_segment = fake_seg
            snap, _ = self._run(
                self.QWEN_TEMPLATE,
                {"skill_id": "qwen_image_21",
                 "prompt": "Remove the red cup, keep the table",
                 "remove_points": [{"x": 100, "y": 200}],
                 "references": [{"kind": "input", "value": "portrait.png"}]})
        finally:
            image_gen._sam3_segment = orig
        self.assertEqual(snap["prompt"], "Remove the red cup, keep the table")

    def test_remove_points_sam3_error_propagates(self):
        # SAM3 分割失败（如缺模型）：错误直接回前端
        async def fake_seg(ref_name, points):
            raise ValueError("未找到 SAM3 模型")

        orig = image_gen._sam3_segment
        try:
            image_gen._sam3_segment = fake_seg
            with self.assertRaises(ValueError) as ctx:
                self._run(
                    self.QWEN_TEMPLATE,
                    {"skill_id": "qwen_image_21", "prompt": "",
                     "remove_points": [{"x": 100, "y": 200}],
                     "references": [{"kind": "input", "value": "portrait.png"}]})
            self.assertIn("未找到 SAM3 模型", str(ctx.exception))
        finally:
            image_gen._sam3_segment = orig

    def test_segment_points_route(self):
        class Req:
            def __init__(self, payload):
                self._payload = payload

            async def json(self):
                return self._payload

        orig = image_gen._sam3_segment

        async def fake_seg(ref_name, points):
            write_png(os.path.join(_INPUT_DIR, "NeoAgent", "_neo_sam3_mask_route.png"), 64, 64)
            return "NeoAgent/_neo_sam3_mask_route.png"

        try:
            image_gen._sam3_segment = fake_seg
            write_png(os.path.join(_INPUT_DIR, "portrait.png"), 64, 64)
            resp = asyncio.run(image_gen.segment_points_route(Req({
                "image": "portrait.png", "points": [{"x": 10, "y": 20}]})))
            self.assertEqual(resp.status, 200)
            self.assertEqual(json.loads(resp.text)["mask"], "NeoAgent/_neo_sam3_mask_route.png")
        finally:
            image_gen._sam3_segment = orig

        # 缺图 / 缺点 / 路径越界 → 400；分割失败（如缺模型）→ 500
        for payload in ({"points": [{"x": 1, "y": 2}]},
                        {"image": "portrait.png"},
                        {"image": "../secret.png", "points": [{"x": 1, "y": 2}]}):
            resp = asyncio.run(image_gen.segment_points_route(Req(payload)))
            self.assertEqual(resp.status, 400)

        async def failing_seg(ref_name, points):
            raise ValueError("未找到 SAM3 模型")

        orig = image_gen._sam3_segment
        try:
            image_gen._sam3_segment = failing_seg
            resp = asyncio.run(image_gen.segment_points_route(Req({
                "image": "portrait.png", "points": [{"x": 10, "y": 20}]})))
            self.assertEqual(resp.status, 500)
        finally:
            image_gen._sam3_segment = orig

    def test_real_qwen_preset_renders_with_required_inputs(self):
        # 真实预设模板必须带 TextEncodeQwenImage21 的必填 resolution 输入，
        # 否则 ComfyUI prompt 校验整图拒绝（"Required input is missing: resolution"）
        preset_dir = os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21")
        with open(os.path.join(preset_dir, "workflow.json"), encoding="utf-8") as f:
            template = json.load(f)
        with open(os.path.join(preset_dir, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        orig_models = {k: list(v) for k, v in _MODELS.items()}
        _MODELS["diffusion_models"].append(cfg["model"])
        _MODELS["text_encoders"].append(cfg["text_encoder"])
        _MODELS["vae"].append(cfg["vae"])
        try:
            snap, captured = self._run(
                template,
                {"skill_id": "qwen_image_21", "prompt": "角色设定图",
                 "width": 1920, "height": 1080,
                 "references": [{"kind": "input", "value": "portrait.png"}]},
                cfg=cfg)
        finally:
            _MODELS.clear()
            _MODELS.update(orig_models)
        self.assertEqual(snap["status"], "queued")
        graph = captured["graph"]
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        # 参考图是 3:4 竖图、目标是 16:9 横版：属「换画幅重画」，画布缩放只把原图对齐到 32
        # （不拉成目标比例），latent 仍按目标尺寸（Qwen2.1 规则对齐到 32 → 1920×1088）
        self.assertEqual((graph["30"]["inputs"]["width"], graph["30"]["inputs"]["height"]), (768, 1024))
        self.assertEqual((graph["5"]["inputs"]["width"], graph["5"]["inputs"]["height"]), (1920, 1088))
        loads = [v for v in graph.values() if v.get("class_type") == "LoadImage"]
        self.assertEqual(len(loads), 1)  # 其余 9 个空槽连同 LoadImage 裁掉

    def test_outpaint_canvas_mp_from_skill_config(self):
        """扩图补边画布的目标像素数可被 skill config 覆盖（target_megapixels，默认 1.5）。"""
        _, captured = self._run(
            load_preset_template("qwen_image_21_outpaint"),
            {"skill_id": "qwen_image_21_outpaint", "prompt": "extend the sky",
             "references": [{"kind": "input", "value": "portrait.png"}],
             "outpaint": {"left": 128, "top": 64, "right": 128, "bottom": 64}},
            cfg={"target_megapixels": 2.0})
        graph = captured["graph"]
        pad_id = next(nid for nid, n in graph.items()
                      if isinstance(n, dict) and n.get("class_type") == "ImagePadForOutpaint")
        canvas_scale = next(nid for nid, n in graph.items()
                            if isinstance(n, dict) and n.get("class_type") == "ImageScaleToTotalPixels"
                            and n["inputs"]["image"] == [pad_id, 0])
        self.assertAlmostEqual(graph[canvas_scale]["inputs"]["megapixels"], 2.0)

    def test_qwen_target_aligned_to_32(self):
        """Qwen2.1 模板的目标尺寸必须 32 对齐（latent 一格 = 32px），否则模型自己补/裁一格 → 尺寸和内容一起偏。"""
        snap, captured = self._run(
            self.QWEN_TEMPLATE,
            {"skill_id": "qwen_image_21", "prompt": "把衣服换成蓝色",
             "width": 1000, "height": 1080,
             "references": [{"kind": "input", "value": "portrait.png"}]})
        self.assertEqual((snap["width"], snap["height"]), (992, 1088))

    def test_edit_scales_reference_to_target(self):
        """常规编辑：模板把参考图缩放到与空 latent 同尺寸（画布尺寸 = 编辑窗目标尺寸）。

        模板里的 ImageScale → TextEncodeQwenImage21(resolution=0) → EmptyLatentImage 就是参考工作流
        「图像编辑」组那条链：参考图与 latent 同尺寸、同在 32 网格上，画面位置才不偏。"""
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21", "workflow.json"),
                  encoding="utf-8") as f:
            template = json.load(f)
        _, captured = self._run(
            template,
            {"skill_id": "qwen_image_21", "prompt": "把衣服换成蓝色",
             "width": 1152, "height": 1536,          # 与原图 768×1024 同比例（3:4）
             "references": [{"kind": "input", "value": "portrait.png"}]})
        graph = captured["graph"]
        scale = graph["30"]
        self.assertEqual(scale["class_type"], "ImageScale")
        self.assertEqual(scale["inputs"]["image"], ["10", 0])          # 原图先缩放
        self.assertEqual((scale["inputs"]["width"], scale["inputs"]["height"]), (1152, 1536))
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], ["30", 0])
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)                  # 编码器不再二次缩放
        self.assertEqual((graph["5"]["inputs"]["width"], graph["5"]["inputs"]["height"]), (1152, 1536))
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["5", 0])         # 空 latent 与参考图同尺寸

    def test_edit_canvas_scale_pruned_without_reference(self):
        """文生图（无参考图）：模板里的画布缩放节点随 LoadImage 一并被裁，latent 走空 latent。"""
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21", "workflow.json"),
                  encoding="utf-8") as f:
            template = json.load(f)
        params = image_gen.resolve_request({"prompt": "a red fox", "seed": 3,
                                            "width": 1024, "height": 1024}, base_settings())
        graph, _ = image_gen.render_template(template, params)
        self.assertNotIn("30", graph)
        self.assertNotIn("10", graph)
        self.assertNotIn("images.image_1", graph["4"]["inputs"])
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["5", 0])

    def test_edit_keeps_reference_unstretched_when_aspect_differs(self):
        """换画幅（参考图 3:4、目标 1:1）：画布缩放只把原图对齐到 32，不拉成目标比例。"""
        _, captured = self._run(
            load_preset_template("qwen_image_21"),
            {"skill_id": "qwen_image_21", "prompt": "改成方形构图",
             "width": 1024, "height": 1024,
             "references": [{"kind": "input", "value": "portrait.png"}]})
        graph = captured["graph"]
        self.assertEqual((graph["30"]["inputs"]["width"], graph["30"]["inputs"]["height"]), (768, 1024))
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["5", 0])
        self.assertEqual((graph["5"]["inputs"]["width"], graph["5"]["inputs"]["height"]), (1024, 1024))

    def test_outpaint_chain_from_template(self):
        """扩图链写在模板里：原图 →1MP 归一化 → 补灰边 → 画布归一化到目标像素 → 编码器空 latent。"""
        snap, captured = self._run(
            load_preset_template("qwen_image_21_outpaint"),
            {"skill_id": "qwen_image_21_outpaint", "prompt": "extend the sky",
             "references": [{"kind": "input", "value": "portrait.png"}],
             "outpaint": {"left": 128, "top": 64, "right": 128, "bottom": 64}})
        self.assertEqual(snap["status"], "queued")
        graph = captured["graph"]
        pad_id = next(nid for nid, n in graph.items()
                      if isinstance(n, dict) and n.get("class_type") == "ImagePadForOutpaint")
        scales = [nid for nid, n in graph.items()
                  if isinstance(n, dict) and n.get("class_type") == "ImageScaleToTotalPixels"]
        self.assertEqual(len(scales), 2, "扩图链应有两次 32 对齐缩放（原图→1MP、画布→1.5MP）")
        ref_scale = next(i for i in scales if graph[i]["inputs"]["image"] == ["10", 0])
        canvas_scale = next(i for i in scales if graph[i]["inputs"]["image"] == [pad_id, 0])
        self.assertAlmostEqual(graph[ref_scale]["inputs"]["megapixels"], image_gen.OUTPAINT_REF_MP)
        # 画布目标像素数取设置项 target_megapixels（默认 1.5，可被 skill config / 请求覆盖）
        self.assertAlmostEqual(graph[canvas_scale]["inputs"]["megapixels"],
                               image_gen.DEFAULT_SETTINGS["target_megapixels"])
        for i in scales:
            self.assertEqual(graph[i]["inputs"]["resolution_steps"], 32)
        pad = graph[pad_id]["inputs"]
        self.assertEqual(pad["image"], [ref_scale, 0])
        self.assertEqual((pad["left"], pad["top"], pad["right"], pad["bottom"]), (128, 64, 128, 64))
        self.assertEqual(pad["feathering"], 0)
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [canvas_scale, 0])
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["4", 2])
        self.assertNotIn("5", graph)   # EmptyLatentImage 移除

    def test_outpaint_total_pixels_from_request(self):
        """请求里的 total_pixels（目标 MP）覆盖设置项：画布缩放的 megapixels 随之为 2.0。"""
        _, captured = self._run(
            load_preset_template("qwen_image_21_outpaint"),
            {"skill_id": "qwen_image_21_outpaint", "prompt": "extend the sky",
             "references": [{"kind": "input", "value": "portrait.png"}],
             "outpaint": {"left": 128, "top": 64, "right": 128, "bottom": 64, "total_pixels": 2.0}})
        graph = captured["graph"]
        pad_id = next(nid for nid, n in graph.items()
                      if isinstance(n, dict) and n.get("class_type") == "ImagePadForOutpaint")
        scales = [nid for nid, n in graph.items()
                  if isinstance(n, dict) and n.get("class_type") == "ImageScaleToTotalPixels"]
        canvas_scale = next(i for i in scales if graph[i]["inputs"]["image"] == [pad_id, 0])
        self.assertAlmostEqual(graph[canvas_scale]["inputs"]["megapixels"], 2.0)   # 请求显式值优先
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [canvas_scale, 0])

    def test_settings_expose_target_megapixels(self):
        """模型工作分辨率作为设置项开放：默认 1.5，随 get_settings 返回，可由请求/技能覆盖。"""
        self.assertAlmostEqual(image_gen.DEFAULT_SETTINGS["target_megapixels"], 1.5)
        settings = base_settings()
        settings["target_megapixels"] = 2.5
        params = image_gen.resolve_request({"prompt": "x", "seed": 1}, settings)
        self.assertAlmostEqual(params["target_mp"], 2.5)

    def test_outpaint_unsupported_template_raises(self):
        with self.assertRaises(ValueError):
            self._run(
                self.PLAIN_TEMPLATE,
                {"skill_id": "image_gen_image", "prompt": "extend",
                 "references": [{"kind": "input", "value": "portrait.png"}],
                 "outpaint": {"left": 64}})

    def test_outpaint_empty_prompt_uses_default_trigger(self):
        snap, _ = self._run(
            load_preset_template("qwen_image_21_outpaint"),
            {"skill_id": "qwen_image_21_outpaint", "prompt": "",
             "references": [{"kind": "input", "value": "portrait.png"}],
             "outpaint": {"left": 64}})
        self.assertEqual(snap["prompt"], image_gen.OUTPAINT_DEFAULT_PROMPT)

    def test_local_edit_prompt_appends_red_constraint(self):
        from PIL import Image
        buf = os.path.join(_INPUT_DIR, "_loc_mask_small.png")
        with Image.new("L", (16, 16), 255) as img:
            img.save(buf, format="PNG")
        with open(buf, "rb") as f:
            data_url = "data:image/png;base64," + base64.b64encode(f.read()).decode()
        snap, _ = self._run(
            self.QWEN_TEMPLATE,
            {"skill_id": "qwen_image_21", "prompt": "fix the scratch",
             "local_edit": True,
             "references": [{"kind": "input", "value": "portrait.png"},
                            {"kind": "data", "data": data_url}]})
        self.assertTrue(snap["prompt"].endswith(image_gen.LOCAL_EDIT_PROMPT_SUFFIX))

    def test_local_edit_unsupported_template_raises(self):
        with self.assertRaises(ValueError):
            self._run(
                self.PLAIN_TEMPLATE,
                {"skill_id": "image_gen_image", "prompt": "fix",
                 "local_edit": True,
                 "references": [{"kind": "input", "value": "portrait.png"}]})

    def test_pose_edit_single_ref_fills_first_slot(self):
        """姿势编辑（1 张）：编辑目标走画布缩放链，第 2 槽随空参考一并裁掉。"""
        snap, captured = self._run(
            load_preset_template("qwen_image_21_pose_edit"),
            {"skill_id": "qwen_image_21_pose_edit",
             "prompt": "Change the pose of the person in <image1> to standing by the window",
             "references": [{"kind": "input", "value": "portrait.png"}]})
        self.assertEqual(snap["status"], "queued")
        graph = captured["graph"]
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], ["30", 0])
        self.assertNotIn("12", graph)
        self.assertNotIn("images.image_2", graph["4"]["inputs"])

    def test_pose_edit_second_ref_is_pose_reference(self):
        """姿势迁移（2 张）：第 2 张参考图直连编码器第 2 槽，不进画布缩放链。"""
        write_png(os.path.join(_INPUT_DIR, "pose_ref.png"), 640, 960)
        _, captured = self._run(
            load_preset_template("qwen_image_21_pose_edit"),
            {"skill_id": "qwen_image_21_pose_edit",
             "prompt": "Adopt the pose of the person in <image2>, keep the face of <image1>",
             "references": [{"kind": "input", "value": "portrait.png"},
                            {"kind": "input", "value": "pose_ref.png"}]})
        graph = captured["graph"]
        self.assertEqual(graph["12"]["inputs"]["image"], "pose_ref.png")
        self.assertEqual(graph["4"]["inputs"]["images.image_2"], ["12", 0])
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], ["30", 0])


class OutpaintParseTests(unittest.TestCase):
    """扩图参数解析：四边留白钳制、目标像素（MP）范围、非法值报错。"""

    def test_missing_returns_none(self):
        self.assertIsNone(image_gen._parse_outpaint(None))
        self.assertIsNone(image_gen._parse_outpaint("bad"))

    def test_all_zero_returns_none(self):
        self.assertIsNone(image_gen._parse_outpaint({"left": 0, "top": 0, "right": 0, "bottom": 0}))

    def test_clamped_and_typed(self):
        out = image_gen._parse_outpaint({"left": -5, "top": "64", "right": 99999, "bottom": 128,
                                        "total_pixels": 2.5})
        self.assertEqual(out["left"], 0)
        self.assertEqual(out["top"], 64)
        self.assertEqual(out["right"], 8192)
        self.assertEqual(out["bottom"], 128)
        self.assertAlmostEqual(out["total_pixels"], 2.5)

    def test_total_pixels_clamped(self):
        out = image_gen._parse_outpaint({"left": 16, "total_pixels": 99})
        self.assertAlmostEqual(out["total_pixels"], 16.0)
        out = image_gen._parse_outpaint({"left": 16, "total_pixels": -3})
        self.assertAlmostEqual(out["total_pixels"], 0.0)

    def test_bad_value_raises(self):
        with self.assertRaises(ValueError):
            image_gen._parse_outpaint({"left": "abc"})

    def test_pads_pass_through_unchanged(self):
        """留白原样透传：不在没拖的轴上凑数，画布对齐交给扩图链的两次缩放。"""
        write_png(os.path.join(_INPUT_DIR, "outp_align.png"), 1000, 750)
        params = image_gen.resolve_request(
            {"prompt": "a cat", "references": [{"kind": "input", "value": "outp_align.png"}],
             "outpaint": {"left": 16, "top": 16, "right": 16, "bottom": 16}}, base_settings())
        out = params["outpaint"]
        self.assertEqual((out["left"], out["top"], out["right"], out["bottom"]), (16, 16, 16, 16))

    def test_template_is_qwen21(self):
        with open(os.path.join(PLUGIN_DIR, "skills", "presets", "qwen_image_21", "workflow.json"),
                  encoding="utf-8") as f:
            qwen = json.load(f)
        self.assertTrue(image_gen.template_is_qwen21(qwen))
        self.assertFalse(image_gen.template_is_qwen21({
            "1": {"class_type": "UNETLoader", "inputs": {}}}))


class RemovePointsTests(unittest.TestCase):
    """点选删除：点击坐标解析（钳制/上限/非法值）。"""

    def test_missing_returns_none(self):
        self.assertIsNone(image_gen._parse_remove_points(None))
        self.assertIsNone(image_gen._parse_remove_points("bad"))
        self.assertIsNone(image_gen._parse_remove_points([]))

    def test_parsed_and_clamped(self):
        pts = image_gen._parse_remove_points([{"x": -3, "y": "120"}, {"x": 99999, "y": 4}])
        self.assertEqual(pts, [{"x": 0, "y": 120}, {"x": 8192, "y": 4}])

    def test_capped_at_five(self):
        pts = image_gen._parse_remove_points([{"x": i, "y": i} for i in range(8)])
        self.assertEqual(len(pts), 5)

    def test_bad_value_raises(self):
        with self.assertRaises(ValueError):
            image_gen._parse_remove_points([{"x": "abc", "y": 1}])
        with self.assertRaises(ValueError):
            image_gen._parse_remove_points(["not-a-dict"])


class OutpaintRenderTests(unittest.TestCase):
    """扩图链：写在模板里（原图→1MP 归一化→补灰边→画布→目标MP 归一化→编码器空 latent）。"""

    @classmethod
    def setUpClass(cls):
        cls.template = load_preset_template("qwen_image_21_outpaint")

    def params(self, **overrides):
        write_png(os.path.join(_INPUT_DIR, "outp_ref.png"), 768, 1024)
        return image_gen.resolve_request(
            {"prompt": "a red fox", "seed": 3,
             "references": [{"kind": "input", "value": "outp_ref.png"}], **overrides},
            base_settings())

    def _find(self, graph, class_type):
        ids = [nid for nid, n in graph.items()
               if isinstance(n, dict) and n.get("class_type") == class_type]
        assert len(ids) == 1, f"{class_type} 应恰好 1 个，实际 {ids}"
        return ids[0]

    def _find_all(self, graph, class_type):
        return [nid for nid, n in graph.items()
                if isinstance(n, dict) and n.get("class_type") == class_type]

    def test_pad_inserted_and_latent_rewired(self):
        params = self.params(outpaint={"left": 128, "top": 64, "right": 128, "bottom": 64})
        graph, _ = image_gen.render_template(self.template, params)
        pad_id = self._find(graph, "ImagePadForOutpaint")
        pad = graph[pad_id]["inputs"]
        scales = self._find_all(graph, "ImageScaleToTotalPixels")
        ref_scale = next(i for i in scales if graph[i]["inputs"]["image"] == ["10", 0])
        canvas_scale = next(i for i in scales if graph[i]["inputs"]["image"] == [pad_id, 0])
        self.assertEqual(pad["image"], [ref_scale, 0])          # 先归一化到 1MP，再补灰边
        self.assertEqual((pad["left"], pad["top"], pad["right"], pad["bottom"]), (128, 64, 128, 64))
        self.assertEqual(pad["feathering"], 0)
        self.assertAlmostEqual(graph[ref_scale]["inputs"]["megapixels"], image_gen.OUTPAINT_REF_MP)
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [canvas_scale, 0])
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["4", 2])
        self.assertNotIn("5", graph)   # EmptyLatentImage 不再被引用，移除

    def test_scale_inserted_when_total_pixels(self):
        params = self.params(outpaint={"left": 128, "top": 64, "right": 128, "bottom": 64,
                                       "total_pixels": 2.0})
        graph, _ = image_gen.render_template(self.template, params)
        pad_id = self._find(graph, "ImagePadForOutpaint")
        scales = self._find_all(graph, "ImageScaleToTotalPixels")
        canvas_scale = next(i for i in scales if graph[i]["inputs"]["image"] == [pad_id, 0])
        self.assertAlmostEqual(graph[canvas_scale]["inputs"]["megapixels"], 2.0)
        self.assertEqual(graph[canvas_scale]["inputs"]["resolution_steps"], 32)   # 32 对齐，编码器不再二次缩放
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [canvas_scale, 0])

    def test_outpaint_requires_reference(self):
        with self.assertRaises(ValueError):
            image_gen.resolve_request({"prompt": "a red fox", "seed": 3,
                                       "outpaint": {"left": 64}}, base_settings())


class LocalEditTests(unittest.TestCase):
    """高分局部编辑：遮罩自动定位区域、红色高亮/羽化遮罩落盘、图变换。"""

    @classmethod
    def setUpClass(cls):
        cls.template = load_preset_template("qwen_image_21_local_edit")

    def _make(self, mask_rect=None):
        from PIL import Image, ImageDraw
        orig_path = os.path.join(_INPUT_DIR, "loc_ref.png")
        with Image.new("RGB", (200, 300), (10, 120, 200)) as img:
            img.save(orig_path, format="PNG")
        mask = Image.new("L", (200, 300), 0)
        if mask_rect:
            ImageDraw.Draw(mask).rectangle(mask_rect, fill=255)
        mask_path = os.path.join(_INPUT_DIR, "_loc_mask_tmp.png")
        mask.save(mask_path, format="PNG")
        with open(mask_path, "rb") as f:
            return "data:image/png;base64," + base64.b64encode(f.read()).decode()

    def test_prepare_box_padding_alignment_and_files(self):
        data_url = self._make((50, 80, 120, 200))
        local = image_gen._prepare_local_edit("loc_ref.png", {"kind": "data", "data": data_url})
        # 包围盒(50,80,120,200) + padding：框包住涂抹区、对齐 8、不越界
        self.assertLessEqual(local["x"], 50)
        self.assertLessEqual(local["y"], 80)
        self.assertGreaterEqual(local["x"] + local["w"], 120)
        self.assertGreaterEqual(local["y"] + local["h"], 200)
        for key in ("x", "y", "w", "h"):
            self.assertEqual(local[key] % 8, 0)
        # 编辑区放大到约 1MP（原涂抹区仅 ~70×120）
        self.assertGreater(local["w2"] * local["h2"], 4e5)
        self.assertLess(local["w2"] * local["h2"], 2.5e6)
        from PIL import Image
        hl = Image.open(os.path.join(_INPUT_DIR, local["hl_name"]))
        fm = Image.open(os.path.join(_INPUT_DIR, local["mask_name"]))
        cx, cy = 85 - local["x"], 140 - local["y"]
        self.assertEqual(hl.getpixel((cx, cy)), (255, 0, 0))   # 涂抹区标红
        self.assertEqual(fm.size, (local["w"], local["h"]))
        self.assertEqual(fm.getpixel((cx, cy)), 255)           # 羽化遮罩内部保持实色

    def test_prepare_empty_mask_raises(self):
        data_url = self._make(None)
        with self.assertRaises(ValueError):
            image_gen._prepare_local_edit("loc_ref.png", {"kind": "data", "data": data_url})

    def test_resolve_extracts_mask_from_refs(self):
        data_url = self._make((50, 80, 120, 200))
        params = image_gen.resolve_request(
            {"prompt": "fix the scratch", "seed": 3, "local_edit": True,
             "references": [{"kind": "input", "value": "loc_ref.png"},
                            {"kind": "data", "data": data_url}]},
            base_settings())
        self.assertIsNotNone(params["local_edit"])
        self.assertEqual(params["ref_images"], ["loc_ref.png"])   # 遮罩不进模型参考槽

    def test_local_edit_requires_mask(self):
        write_png(os.path.join(_INPUT_DIR, "loc_ref.png"), 200, 300)
        with self.assertRaises(ValueError):
            image_gen.resolve_request(
                {"prompt": "fix", "seed": 3, "local_edit": True,
                 "references": [{"kind": "input", "value": "loc_ref.png"}]},
                base_settings())

    def test_graph_transform(self):
        data_url = self._make((50, 80, 120, 200))
        params = image_gen.resolve_request(
            {"prompt": "fix the scratch", "seed": 3, "local_edit": True,
             "references": [{"kind": "input", "value": "loc_ref.png"},
                            {"kind": "data", "data": data_url}]},
            base_settings())
        local = params["local_edit"]
        graph, _ = image_gen.render_template(self.template, params)

        def find(ct):
            ids = [nid for nid, n in graph.items()
                   if isinstance(n, dict) and n.get("class_type") == ct]
            assert len(ids) == 1, f"{ct} 应恰好 1 个，实际 {ids}"
            return ids[0]

        hl_id = next(nid for nid, n in graph.items()
                    if isinstance(n, dict) and n.get("class_type") == "LoadImage"
                    and (n.get("inputs") or {}).get("image") == local["hl_name"])
        mask_id = find("LoadImageMask")
        scales = [nid for nid, n in graph.items()
                  if isinstance(n, dict) and n.get("class_type") == "ImageScale"]
        up_id = next(nid for nid in scales if graph[nid]["inputs"]["width"] == local["w2"])
        down_id = next(nid for nid in scales if graph[nid]["inputs"]["width"] == local["w"])
        comp_id = find("ImageCompositeMasked")
        self.assertEqual(graph[up_id]["inputs"]["image"], [hl_id, 0])
        self.assertEqual((graph[up_id]["inputs"]["width"], graph[up_id]["inputs"]["height"]),
                         (local["w2"], local["h2"]))
        self.assertEqual(graph["4"]["inputs"]["images.image_1"], [up_id, 0])
        self.assertEqual(graph["4"]["inputs"]["resolution"], 0)
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["4", 2])
        self.assertEqual(graph[down_id]["inputs"]["image"], ["7", 0])
        comp = graph[comp_id]["inputs"]
        self.assertEqual(comp["destination"], ["10", 0])
        self.assertEqual(comp["source"], [down_id, 0])
        self.assertEqual((comp["x"], comp["y"]), (local["x"], local["y"]))
        self.assertEqual(comp["mask"], [mask_id, 0])
        self.assertEqual(graph[find("SaveImage")]["inputs"]["images"], [comp_id, 0])
        self.assertNotIn("5", graph)   # EmptyLatentImage 不再被引用，移除


class SidecarTests(unittest.TestCase):
    def test_sidecar_written_once(self):
        params = image_gen.resolve_request({"prompt": "a cat", "seed": 5}, base_settings())
        image_path = os.path.join(_OUTPUT_DIR, "NeoAgent", "pic_00001_.png")
        os.makedirs(os.path.dirname(image_path), exist_ok=True)
        with open(image_path, "wb") as f:
            f.write(b"img")
        image_gen.write_sidecar(image_path, params)
        txt = os.path.splitext(image_path)[0] + ".txt"
        with open(txt, encoding="utf-8") as f:
            lines = f.read().splitlines()
        self.assertEqual(lines[0], "a cat")
        self.assertIn("seed=5", lines[1])
        # 已存在时不覆盖（画廊里用户可能改过）
        with open(txt, "w", encoding="utf-8") as f:
            f.write("kept\n")
        image_gen.write_sidecar(image_path, params)
        with open(txt, encoding="utf-8") as f:
            self.assertEqual(f.read(), "kept\n")


class SkillWorkflowRouteTests(unittest.TestCase):
    """画布导出 / 技能生图设置 / 文件复制路由（假 request + 真实 skill 模块）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_dir = _skill_mod.SKILL_CUSTOM_DIR
        _skill_mod.SKILL_CUSTOM_DIR = self._tmp.name
        # 预设本地覆盖文件隔离到临时目录，避免污染真实 configs/skill_overrides/
        self._orig_ovr = _skill_mod.SKILL_OVERRIDES_DIR
        _skill_mod.SKILL_OVERRIDES_DIR = os.path.join(self._tmp.name, "skill_overrides")
        # 临时预设（含已知 config.json）替代真实 presets 目录，断言不依赖本机预设内容
        self._orig_presets = _skill_mod.SKILL_PRESETS_DIR
        pdir = os.path.join(self._tmp.name, "presets", "image_gen")
        os.makedirs(pdir)
        with open(os.path.join(pdir, "skill.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: image_gen\n---\nbody")
        with open(os.path.join(pdir, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"default_ratio": "16:9"}, f)
        with open(os.path.join(pdir, "workflow.json"), "w", encoding="utf-8") as f:
            json.dump({"1": {"class_type": "UNETLoader", "inputs": {}}}, f)
        _skill_mod.SKILL_PRESETS_DIR = os.path.join(self._tmp.name, "presets")
        # 全局生图设置隔离到临时目录：回写基线只由 DEFAULT_SETTINGS 推导，不依赖本机 settings
        self._orig_settings = image_gen_files.SETTINGS_FILE
        image_gen_files.SETTINGS_FILE = os.path.join(self._tmp.name, "image_gen.json")

    def tearDown(self):
        _skill_mod.SKILL_CUSTOM_DIR = self._orig_dir
        _skill_mod.SKILL_OVERRIDES_DIR = self._orig_ovr
        _skill_mod.SKILL_PRESETS_DIR = self._orig_presets
        image_gen_files.SETTINGS_FILE = self._orig_settings
        self._tmp.cleanup()

    @staticmethod
    def _req(payload=None, query=None):
        async def _json():
            return payload
        return types.SimpleNamespace(json=_json, query=query or {})

    @staticmethod
    def _call(handler, request):
        resp = asyncio.run(handler(request))
        body = json.loads(resp.body)
        return resp.status, body

    def _make_custom_skill(self, sid):
        d = os.path.join(self._tmp.name, sid)
        os.makedirs(d)
        with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: %s\n---\nbody" % sid)
        return d

    def test_save_workflow_skill_route(self):
        workflow = {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "krea2/krea2_turbo_fp16.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 0], "text": "hello world"}},
            "3": {"class_type": "EmptyLatentImage",
                  "inputs": {"width": 1280, "height": 720, "batch_size": 2}},
            "4": {"class_type": "SaveImage",
                  "inputs": {"images": ["3", 0], "filename_prefix": "MyWf"}},
        }
        status, body = self._call(
            image_gen_files.save_workflow_skill_route,
            self._req({"name": "my wf", "description": "d", "tags": ["t"], "workflow": workflow}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        d = os.path.join(self._tmp.name, body["id"])
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, _ = _skill_mod.split_frontmatter(f.read())
        self.assertIs(meta["gen_image"], True)
        self.assertEqual(meta["category"], "image_gen")
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["2"]["inputs"]["text"], "{{PROMPT}}")
        self.assertEqual(tpl["1"]["inputs"]["unet_name"], "{{MODEL}}")
        self.assertEqual(tpl["3"]["inputs"]["width"], "{{WIDTH}}")
        self.assertEqual(tpl["4"]["inputs"]["filename_prefix"], "{{PREFIX}}")
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["model"], "krea2/krea2_turbo_fp16.safetensors")
        self.assertEqual(cfg["default_ratio"], "16:9")
        self.assertEqual(cfg["output_prefix"], "MyWf")
        self.assertEqual(cfg["count"], 2)

        # 同名重复导出自动加后缀
        status, body2 = self._call(
            image_gen_files.save_workflow_skill_route,
            self._req({"name": "my wf", "workflow": workflow}))
        self.assertEqual(status, 200)
        self.assertEqual(body2["id"], body["id"] + "-2")

    def test_get_skill_workflow_route(self):
        # 预设带 workflow.json → 200 + 原样返回模板
        status, body = self._call(
            image_gen_files.get_skill_workflow_route,
            self._req(query={"skill_id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertEqual(body["skill_id"], "image_gen")
        self.assertEqual(body["workflow"], {"1": {"class_type": "UNETLoader", "inputs": {}}})

        # 缺 skill_id → 400
        status, _ = self._call(image_gen_files.get_skill_workflow_route, self._req(query={}))
        self.assertEqual(status, 400)

        # 自定义技能无 workflow.json → 404
        self._make_custom_skill("no_wf")
        status, _ = self._call(
            image_gen_files.get_skill_workflow_route,
            self._req(query={"skill_id": "no_wf"}))
        self.assertEqual(status, 404)

        # workflow.json 损坏 → 404（不抛异常）
        d = self._make_custom_skill("bad_wf")
        with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
            f.write("{not json")
        status, _ = self._call(
            image_gen_files.get_skill_workflow_route,
            self._req(query={"skill_id": "bad_wf"}))
        self.assertEqual(status, 404)

    def _h3_video_workflow(self, i2v=False):
        wf = {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "MiniMaxH3/minimax_h3.safetensors"}},
            "2": {"class_type": "CLIPLoader",
                  "inputs": {"clip_name": "qwen3vl_minimax_h3.safetensors", "type": "minimax"}},
            "3": {"class_type": "VAELoader",
                  "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
            "4": {"class_type": "MiniMaxH3ImageToVideo",
                  "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": "a cat",
                             "width": 1344, "height": 768, "length": 124}},
            "5": {"class_type": "MiniMaxH3SigmaShift",
                  "inputs": {"model": ["1", 0], "shift_video": 12.0, "shift_audio": 3.0}},
            "6": {"class_type": "KSampler",
                  "inputs": {"model": ["5", 0], "seed": 42, "steps": 20, "cfg": 1.0,
                             "sampler_name": "euler", "scheduler": "simple",
                             "positive": ["4", 0], "negative": ["4", 0],
                             "latent_image": ["4", 1], "denoise": 1.0}},
            "7": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["6", 0]}},
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
            "9": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["7", 1], "vae": ["11", 0]}},
            "10": {"class_type": "CreateVideo", "inputs": {"images": ["8", 0], "fps": 24, "audio": ["9", 0]}},
            "11": {"class_type": "VAELoader",
                   "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        }
        if i2v:
            wf["4"]["inputs"]["first_frame"] = ["12", 0]
            wf["12"] = {"class_type": "LoadImage", "inputs": {"image": "first.png"}}
            # 主链 LoRA：UNETLoader → LoraLoaderModelOnly → MiniMaxH3SigmaShift
            wf["5"]["inputs"]["model"] = ["13", 0]
            wf["13"] = {"class_type": "LoraLoaderModelOnly",
                        "inputs": {"model": ["1", 0], "lora_name": "h3_style.safetensors", "strength_model": 0.8}}
        return wf

    def test_save_workflow_skill_video_t2v(self):
        status, body = self._call(
            image_gen_files.save_workflow_skill_route,
            self._req({"name": "h3 t2v", "workflow": self._h3_video_workflow(i2v=False)}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertTrue(body["gen_video"])
        d = os.path.join(self._tmp.name, body["id"])
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, _ = _skill_mod.split_frontmatter(f.read())
        self.assertIs(meta["gen_video"], True)
        self.assertEqual(meta["category"], "video_gen")
        self.assertNotIn("requires_ref", meta)
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["1"]["inputs"]["unet_name"], "{{MODEL}}")
        self.assertEqual(tpl["2"]["inputs"]["clip_name"], "{{TEXT_ENCODER}}")
        self.assertEqual(tpl["3"]["inputs"]["vae_name"], "{{VAE}}")          # 视频 VAE（喂 VAEDecode）
        self.assertEqual(tpl["11"]["inputs"]["vae_name"], "{{AUDIO_VAE}}")   # 音频 VAE（喂 VAEDecodeAudio）
        self.assertEqual(tpl["4"]["inputs"]["prompt"], "{{PROMPT}}")
        self.assertEqual(tpl["4"]["inputs"]["width"], "{{WIDTH}}")
        self.assertEqual(tpl["4"]["inputs"]["height"], "{{HEIGHT}}")
        self.assertEqual(tpl["4"]["inputs"]["length"], "{{LENGTH}}")
        self.assertEqual(tpl["6"]["inputs"]["seed"], "{{SEED}}")
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["model"], "MiniMaxH3/minimax_h3.safetensors")
        self.assertEqual(cfg["text_encoder"], "qwen3vl_minimax_h3.safetensors")
        self.assertEqual(cfg["vae"], "minimax_h3_video_vae_fp16.safetensors")
        self.assertEqual(cfg["audio_vae"], "minimax_h3_audio_vae_fp32.safetensors")
        self.assertEqual((cfg["width"], cfg["height"], cfg["length"]), (1344, 768, 124))

    def test_save_workflow_skill_video_i2v_with_lora(self):
        status, body = self._call(
            image_gen_files.save_workflow_skill_route,
            self._req({"name": "h3 i2v", "workflow": self._h3_video_workflow(i2v=True)}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertTrue(body["gen_video"])
        d = os.path.join(self._tmp.name, body["id"])
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, _ = _skill_mod.split_frontmatter(f.read())
        self.assertIs(meta["requires_ref"], True)
        self.assertIn("image", meta.get("inputs") or [])
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["12"]["inputs"]["image"], "{{REF_IMAGE}}")
        self.assertEqual(tpl["4"]["inputs"]["first_frame"], ["12", 0])       # 首帧连线保留
        self.assertEqual(tpl["13"]["inputs"]["lora_name"], "{{LORA_1_NAME}}")
        self.assertEqual(tpl["13"]["inputs"]["strength_model"], "{{LORA_1_STRENGTH}}")
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["loras"], [{"name": "h3_style.safetensors", "strength": 0.8}])

    def test_save_workflow_skill_invalid(self):
        status, _ = self._call(image_gen_files.save_workflow_skill_route,
                               self._req({"name": "x", "workflow": {}}))
        self.assertEqual(status, 400)

    def test_update_workflow_skill_route(self):
        # 画布 API prompt 回写入 existing custom skill：workflow.json 落盘模板、skill.md 正文保留、config.json 初值
        d = self._make_custom_skill("upd_wf")
        with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
            json.dump({"1": {"class_type": "UNETLoader", "inputs": {}}}, f)
        workflow = {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "krea2/krea2_turbo_fp16.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 0], "text": "canvas prompt"}},
            "3": {"class_type": "EmptyLatentImage",
                  "inputs": {"width": 1280, "height": 720, "batch_size": 2}},
            "4": {"class_type": "SaveImage",
                  "inputs": {"images": ["3", 0], "filename_prefix": "MyWf"}},
        }
        status, body = self._call(
            image_gen_files.update_workflow_skill_route,
            self._req({"skill_id": "upd_wf", "workflow": workflow}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertEqual(body["id"], "upd_wf")
        self.assertFalse(body["gen_video"])
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["2"]["inputs"]["text"], "{{PROMPT}}")
        self.assertEqual(tpl["1"]["inputs"]["unet_name"], "{{MODEL}}")
        self.assertEqual(tpl["3"]["inputs"]["width"], "{{WIDTH}}")
        self.assertEqual(tpl["4"]["inputs"]["filename_prefix"], "{{PREFIX}}")
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, md_body = _skill_mod.split_frontmatter(f.read())
        self.assertEqual(md_body, "body")
        self.assertNotIn("requires_ref", meta)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["model"], "krea2/krea2_turbo_fp16.safetensors")
        self.assertEqual(cfg["default_ratio"], "16:9")
        self.assertEqual(cfg["output_prefix"], "MyWf")

    def test_update_workflow_skill_keeps_settings_cfg(self):
        # 回写整文件重写 config.json：画布 batch_size → count，设置区其余键垫底保留
        d = self._make_custom_skill("upd_cfg")
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"model": "old.safetensors", "base_resolution": 1536, "count": 3,
                       "default_ratio": "4:3", "enhance_prompt": True, "steps": 25}, f)
        workflow = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "new.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 0], "text": "p"}},
            "3": {"class_type": "EmptyLatentImage",
                  "inputs": {"width": 1024, "height": 1024, "batch_size": 4}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "P"}},
        }
        status, body = self._call(
            image_gen_files.update_workflow_skill_route,
            self._req({"skill_id": "upd_cfg", "workflow": workflow}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["model"], "new.safetensors")
        self.assertEqual(cfg["count"], 4)
        self.assertEqual(cfg["default_ratio"], "1:1")
        self.assertEqual(cfg["base_resolution"], 1536)
        self.assertIs(cfg["enhance_prompt"], True)
        self.assertEqual(cfg["steps"], 25)

    def _seeded_canvas(self, model, settings=None):
        """「导入到画布」灌出来的画布：编码器/VAE 是自动建议名，前缀/张数/尺寸是全局默认
        （这些都不落 config.json），尺寸按有效 base_resolution + default_ratio 推。"""
        st = dict(image_gen.DEFAULT_SETTINGS)
        st.update(settings or {})
        w, h = image_gen.resolve_dimensions(st)
        return {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": model}},
            "2": {"class_type": "CLIPLoader",
                  "inputs": {"clip_name": image_gen.suggest_model("text_encoders"), "type": "krea2"}},
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": image_gen.suggest_model("vae")}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": "p"}},
            "5": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
            "6": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["4", 0],
                                                        "latent_image": ["5", 0], "seed": 0, "steps": 20}},
            "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0],
                                                        "filename_prefix": st["output_prefix"]}},
        }

    def _preview(self, sid, workflow):
        return self._call(image_gen_files.preview_workflow_skill_route,
                          self._req({"skill_id": sid, "workflow": workflow}))

    def test_preview_changes_ignore_effective_defaults(self):
        # 基线 = 画布打开时的有效配置：只换主模型时，编码器/VAE/前缀/张数/尺寸这些默认值不报变更；
        # 1296x736（base_resolution 1296 + 16:9）与技能里的 16:9 同比例，也不算变更
        d = self._make_custom_skill("upd_base")
        seeded = {"default_ratio": "16:9", "base_resolution": 1296}
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"model": "krea2/krea2_turbo_fp16.safetensors", "default_ratio": "16:9"}, f)
        status, body = self._preview("upd_base", self._seeded_canvas(
            "krea2/krea2_turbo_fp16.safetensors", seeded))
        self.assertEqual(status, 200)
        self.assertEqual(body["changes"], [])

        status, body = self._preview("upd_base", self._seeded_canvas(
            "krea2/krea2_full_bf16.safetensors", seeded))
        self.assertEqual([c["field"] for c in body["changes"]], ["model"])
        self.assertEqual(body["changes"][0]["from"], "krea2/krea2_turbo_fp16.safetensors")
        self.assertEqual(body["changes"][0]["to"], "krea2/krea2_full_bf16.safetensors")

        # 真换比例（16:9 → 1:1）必须报出来
        status, body = self._preview("upd_base", self._seeded_canvas(
            "krea2/krea2_turbo_fp16.safetensors", {"default_ratio": "1:1", "base_resolution": 1296}))
        self.assertEqual([c["field"] for c in body["changes"]], ["default_ratio"])

    def test_preview_changes_auto_suggested_models_not_a_change(self):
        # 无 config.json：主模型/编码器/VAE 全走自动建议，画布灌的就是建议名 → 无变更
        self._make_custom_skill("upd_sug")
        status, body = self._preview("upd_sug", self._seeded_canvas(
            image_gen.suggest_model("diffusion_models")))
        self.assertEqual(status, 200)
        self.assertEqual(body["changes"], [])

    def test_preview_strips_runtime_injected_loras(self):
        # 模板 0 个 LoRA、config 1 个 LoRA：画布导入注入的具体名 LoRA 节点回写时剥离，
        # 不报「节点 LoraLoaderModelOnly 0→1」「连线数」假变更
        d = self._make_custom_skill("upd_lora")
        model = image_gen.suggest_model("diffusion_models")
        canvas = self._seeded_canvas(model)
        # 基线模板 = 画布结构（无 LoRA 节点），回写剥离注入节点后应与基线完全一致
        with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
            json.dump(canvas, f)
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"model": model, "loras": [{"name": "cfg_lora.safetensors", "strength": 1.0}]}, f)
        canvas["13"] = {"class_type": "LoraLoaderModelOnly",
                        "inputs": {"model": ["1", 0], "lora_name": "cfg_lora.safetensors", "strength_model": 1.0}}
        canvas["6"]["inputs"]["model"] = ["13", 0]
        status, body = self._preview("upd_lora", canvas)
        self.assertEqual(status, 200)
        self.assertEqual(body["changes"], [])

    def test_preview_lora_value_change_only_reports_loras(self):
        # 技能 0 个 LoRA 节点 + config 1 个 LoRA：画布上那个注入节点被改了 LoRA 文件（只改值、没加连线），
        # 剥离判据是数量不是名字 → 只报 loras 变更，不报「节点 0→1」「连线数」假变更
        d = self._make_custom_skill("upd_lora2")
        model = image_gen.suggest_model("diffusion_models")
        canvas = self._seeded_canvas(model)
        with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
            json.dump(canvas, f)
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"model": model, "loras": [{"name": "lora_a.safetensors", "strength": 1.0}]}, f)
        canvas["13"] = {"class_type": "LoraLoaderModelOnly",
                        "inputs": {"model": ["1", 0], "lora_name": "lora_b.safetensors", "strength_model": 0.8}}
        canvas["6"]["inputs"]["model"] = ["13", 0]
        status, body = self._preview("upd_lora2", canvas)
        self.assertEqual(status, 200)
        self.assertEqual([c["field"] for c in body["changes"]], ["loras"])
        self.assertEqual(body["changes"][0]["from"], "lora_a.safetensors×1.0")
        self.assertEqual(body["changes"][0]["to"], "lora_b.safetensors×0.8")
        # 落盘：模板不带 LoRA 节点（结构不变），画布上的新 LoRA 值写进 config.loras
        status, body = self._call(image_gen_files.update_workflow_skill_route,
                                  self._req({"skill_id": "upd_lora2", "workflow": canvas}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual([n for n in tpl.values() if n["class_type"] == "LoraLoaderModelOnly"], [])
        self.assertEqual(tpl["6"]["inputs"]["model"], ["1", 0])
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["loras"], [{"name": "lora_b.safetensors", "strength": 0.8}])

    def test_preview_keeps_template_lora_slots(self):
        # 模板自带 {{LORA_1_NAME}} 槽位、config 1 个 LoRA：画布灌的就是那一个槽位节点，
        # 注入数 = len(config.loras) - 槽位数 = 0 → 槽位不被删、无变更
        d = self._make_custom_skill("upd_slot")
        model = image_gen.suggest_model("diffusion_models")
        canvas = self._seeded_canvas(model)
        canvas["13"] = {"class_type": "LoraLoaderModelOnly",
                        "inputs": {"model": ["1", 0], "lora_name": "{{LORA_1_NAME}}",
                                   "strength_model": "{{LORA_1_STRENGTH}}"}}
        canvas["6"]["inputs"]["model"] = ["13", 0]
        with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
            json.dump(canvas, f)
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"model": model, "loras": [{"name": "lora_a.safetensors", "strength": 1.0}]}, f)
        filled = json.loads(json.dumps(canvas)
                            .replace("{{LORA_1_NAME}}", "lora_a.safetensors")
                            .replace("{{LORA_1_STRENGTH}}", "1.0"))
        status, body = self._preview("upd_slot", filled)
        self.assertEqual(status, 200)
        self.assertEqual(body["changes"], [])
        status, body = self._call(image_gen_files.update_workflow_skill_route,
                                  self._req({"skill_id": "upd_slot", "workflow": filled}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["13"]["inputs"]["lora_name"], "{{LORA_1_NAME}}")
        self.assertEqual(tpl["13"]["inputs"]["strength_model"], "{{LORA_1_STRENGTH}}")

    def test_preview_reports_real_added_lora_node(self):
        # 画布链上 2 个 LoRA 节点、config 只 1 个：剥 1 个注入的，多出来的那个是真结构变更
        d = self._make_custom_skill("upd_lora3")
        model = image_gen.suggest_model("diffusion_models")
        canvas = self._seeded_canvas(model)
        with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
            json.dump(canvas, f)
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"model": model, "loras": [{"name": "lora_a.safetensors", "strength": 1.0}]}, f)
        canvas["13"] = {"class_type": "LoraLoaderModelOnly",
                        "inputs": {"model": ["1", 0], "lora_name": "lora_a.safetensors", "strength_model": 1.0}}
        canvas["14"] = {"class_type": "LoraLoaderModelOnly",
                        "inputs": {"model": ["13", 0], "lora_name": "lora_b.safetensors", "strength_model": 0.5}}
        canvas["6"]["inputs"]["model"] = ["14", 0]
        status, body = self._preview("upd_lora3", canvas)
        self.assertEqual(status, 200)
        fields = [c["field"] for c in body["changes"]]
        self.assertIn("节点 LoraLoaderModelOnly", fields)
        self.assertIn("loras", fields)
        self.assertEqual([c for c in body["changes"] if c["field"] == "loras"][0]["to"],
                         "lora_a.safetensors×1.0、lora_b.safetensors×0.5")

    def test_preview_changes_video_size_defaults(self):
        # 视频技能 config.json 无 width/height/length：画布灌的 1344/768/124 是默认值，不进变更清单；
        # 模型/编码器/VAE 与自动建议基线不同 → 仍是真变更
        self._make_custom_skill("upd_vbase")
        status, body = self._preview("upd_vbase", self._h3_video_workflow(i2v=False))
        self.assertEqual(status, 200)
        fields = [c["field"] for c in body["changes"]]
        self.assertFalse([f for f in fields if f in ("width", "height", "length")])
        self.assertIn("model", fields)

    def test_update_workflow_skill_ref(self):
        # 画带参考图 → skill.md 里 requires_ref 归真（正文保留），模板留 {{REF_IMAGE}} 占串
        d = self._make_custom_skill("upd_ref")
        workflow = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 0], "text": "a cat"}},
            "9": {"class_type": "LoadImage", "inputs": {"image": "first.png"}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["2", 0], "filename_prefix": "P"}},
        }
        status, body = self._call(
            image_gen_files.update_workflow_skill_route,
            self._req({"skill_id": "upd_ref", "workflow": workflow}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["9"]["inputs"]["image"], "{{REF_IMAGE}}")
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, md_body = _skill_mod.split_frontmatter(f.read())
        self.assertIs(meta["requires_ref"], True)
        self.assertEqual(md_body, "body")

    def test_update_workflow_skill_video(self):
        # H3 画布 → 视频模板落盘（gen_video 真）
        d = self._make_custom_skill("upd_vid")
        status, body = self._call(
            image_gen_files.update_workflow_skill_route,
            self._req({"skill_id": "upd_vid", "workflow": self._h3_video_workflow(i2v=True)}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertTrue(body["gen_video"])
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            tpl = json.load(f)
        self.assertEqual(tpl["1"]["inputs"]["unet_name"], "{{MODEL}}")
        self.assertEqual(tpl["11"]["inputs"]["vae_name"], "{{AUDIO_VAE}}")
        self.assertEqual(tpl["12"]["inputs"]["image"], "{{REF_IMAGE}}")
        self.assertEqual(tpl["4"]["inputs"]["first_frame"], ["12", 0])
        self.assertEqual(tpl["13"]["inputs"]["lora_name"], "{{LORA_1_NAME}}")
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["loras"], [{"name": "h3_style.safetensors", "strength": 0.8}])
        self.assertEqual((cfg["width"], cfg["height"], cfg["length"]), (1344, 768, 124))

    def test_update_workflow_skill_guards(self):
        workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}}}
        # 技能不存在 → 400
        status, body = self._call(
            image_gen_files.update_workflow_skill_route,
            self._req({"skill_id": "nope", "workflow": workflow}))
        self.assertEqual(status, 400)
        self.assertIn("not found", body["error"].lower())
        # 空 / 非法节点结构 workflow → 400
        d = self._make_custom_skill("upd_bad")
        status, body = self._call(
            image_gen_files.update_workflow_skill_route,
            self._req({"skill_id": "upd_bad", "workflow": {}}))
        self.assertEqual(status, 400)
        self.assertIn("API prompt", body["error"])
        status, body = self._call(
            image_gen_files.update_workflow_skill_route,
            self._req({"skill_id": "upd_bad", "workflow": {"1": {"inputs": {}}}}))
        self.assertEqual(status, 400)
        self.assertIn("class_type", body["error"])
        # 失败时不落盘
        self.assertFalse(os.path.isfile(os.path.join(d, "workflow.json")))

    def test_update_workflow_skill_preset(self):
        # 预设技能：画布模型值写 configs/skill_overrides/，预设 workflow.json 不动；结构变更只回报
        preset_wf = os.path.join(_skill_mod.SKILL_PRESETS_DIR, "image_gen", "workflow.json")
        with open(preset_wf, encoding="utf-8") as f:
            before = json.load(f)
        canvas = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 0], "text": "a cat"}},
            "3": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 576, "batch_size": 2}},
            "4": {"class_type": "SaveImage", "inputs": {"images": ["2", 0], "filename_prefix": "P"}},
        }
        status, body = self._preview("image_gen", canvas)
        self.assertEqual(status, 200)
        self.assertTrue(body["preset"])
        self.assertTrue(body["structural"])

        status, body = self._call(
            image_gen_files.update_workflow_skill_route,
            self._req({"skill_id": "image_gen", "workflow": canvas}))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertTrue(body["structural"])
        with open(preset_wf, encoding="utf-8") as f:
            self.assertEqual(json.load(f), before)
        with open(os.path.join(_skill_mod.SKILL_OVERRIDES_DIR, "image_gen.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["model"], "m.safetensors")
        eff = _skill_mod.get_skill_gen_config("image_gen")
        self.assertEqual(eff["model"], "m.safetensors")
        self.assertEqual(eff["default_ratio"], "16:9")

    def test_get_skill_config(self):
        # 预设 image_gen 的 config.json（default_ratio: 16:9）
        status, body = self._call(image_gen_files.get_skill_config_route,
                                  self._req(query={"skill_id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertEqual(body, {"default_ratio": "16:9"})
        status, _ = self._call(image_gen_files.get_skill_config_route, self._req(query={}))
        self.assertEqual(status, 400)

    def test_post_skill_config(self):
        d = self._make_custom_skill("mygen")
        status, body = self._call(
            image_gen_files.post_skill_config_route,
            self._req({"skill_id": "mygen",
                       "config": {"count": 4, "default_ratio": "2:3",
                                  "loras": [{"name": "style_a.safetensors", "strength": 0.7}]}}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["count"], 4)
        self.assertEqual(cfg["default_ratio"], "2:3")
        self.assertEqual(cfg["loras"], [{"name": "style_a.safetensors", "strength": 0.7}])

        # 预设设置可编辑：写本地覆盖文件（configs/skill_overrides/<id>.json），不改预设文件
        status, body = self._call(image_gen_files.post_skill_config_route,
                                  self._req({"skill_id": "image_gen", "config": {"count": 2}}))
        self.assertEqual(status, 200)
        ov_path = os.path.join(_skill_mod.SKILL_OVERRIDES_DIR, "image_gen.json")
        self.assertTrue(os.path.isfile(ov_path), "预设保存应写本地覆盖文件")
        with open(ov_path, encoding="utf-8") as f:
            ov = json.load(f)
        self.assertEqual(ov["count"], 2)
        # GET 返回合并后的有效 config（预设 default_ratio + 覆盖 count）
        status, body = self._call(image_gen_files.get_skill_config_route,
                                  self._req(query={"skill_id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["default_ratio"], "16:9")

    def test_reset_skill_config(self):
        # 先写一条本地覆盖，再恢复默认（删覆盖文件）；幂等、未知 skill 404
        status, _ = self._call(image_gen_files.post_skill_config_route,
                               self._req({"skill_id": "image_gen", "config": {"count": 3}}))
        self.assertEqual(status, 200)
        ov_path = os.path.join(_skill_mod.SKILL_OVERRIDES_DIR, "image_gen.json")
        self.assertTrue(os.path.isfile(ov_path))

        status, body = self._call(_skill_mod.rs_prompts_reset_skill_config,
                                  self._req({"id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertFalse(os.path.isfile(ov_path), "恢复默认应删除本地覆盖文件")
        # 恢复后 GET 回落预设默认
        status, body = self._call(image_gen_files.get_skill_config_route,
                                  self._req(query={"skill_id": "image_gen"}))
        self.assertEqual(status, 200)
        self.assertNotIn("count", body)

        status, _ = self._call(_skill_mod.rs_prompts_reset_skill_config,
                               self._req({"id": "image_gen"}))
        self.assertEqual(status, 200, "无覆盖时恢复默认应幂等成功")
        # 未知 skill → 404（纯文本响应，不走 _call 的 JSON 解析）
        resp = asyncio.run(_skill_mod.rs_prompts_reset_skill_config(self._req({"id": "no_such_skill"})))
        self.assertEqual(resp.status, 404)

    def test_copy_skill_files_preset_with_override(self):
        # 复制带本地覆盖的预设 → 副本写入合并后的有效 config
        status, _ = self._call(image_gen_files.post_skill_config_route,
                               self._req({"skill_id": "image_gen", "config": {"count": 5}}))
        self.assertEqual(status, 200)
        d = self._make_custom_skill("copy_ovr")
        status, body = self._call(
            image_gen_files.copy_skill_files_route,
            self._req({"from_id": "image_gen", "to_id": "copy_ovr"}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["count"], 5)
        self.assertEqual(cfg["default_ratio"], "16:9")

    def test_post_skill_config_persists_video_audio_vae(self):
        # 视频技能 per-skill 覆盖：model/text_encoder/vae/audio_vae 落盘，且保留既有 width/height/length（尺寸/时长默认）
        d = self._make_custom_skill("vidgen")
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"width": 1344, "height": 768, "length": 247}, f)
        status, body = self._call(
            image_gen_files.post_skill_config_route,
            self._req({"skill_id": "vidgen",
                       "config": {"model": "h3/h3.safetensors",
                                  "text_encoder": "h3/te.safetensors",
                                  "vae": "h3/video_vae.safetensors",
                                  "audio_vae": "h3/audio_vae.safetensors"}}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["model"], "h3/h3.safetensors")
        self.assertEqual(cfg["text_encoder"], "h3/te.safetensors")
        self.assertEqual(cfg["vae"], "h3/video_vae.safetensors")
        self.assertEqual(cfg["audio_vae"], "h3/audio_vae.safetensors")
        # 尺寸/时长默认值不被模型设置覆盖清掉
        self.assertEqual((cfg["width"], cfg["height"], cfg["length"]), (1344, 768, 247))

    def test_post_skill_config_persists_video_steps(self):
        # 视频技能 per-skill「步数」：保存白名单此前丢弃 steps，输入框改完保存无效
        d = self._make_custom_skill("vidsteps")
        with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: vidsteps\ncategory: video_gen\ngen_video: true\n---\nbody\n")
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"width": 960, "height": 544, "length": 124, "steps": 20}, f)
        status, _ = self._call(
            image_gen_files.post_skill_config_route,
            self._req({"skill_id": "vidsteps",
                       "config": {"model": "h3/h3.safetensors", "steps": 8}}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["steps"], 8)
        self.assertEqual((cfg["width"], cfg["height"], cfg["length"]), (960, 544, 124))
        # GET 回显已存步数（详情弹窗 load 据此回填「步数」输入框）
        status, body = self._call(image_gen_files.get_skill_config_route,
                                  self._req(query={"skill_id": "vidsteps"}))
        self.assertEqual(body["steps"], 8)
        # 技能列表摘要（浮动预览卡数据源）同样带上步数
        scanned = {s["id"]: s for s in _skill_mod.scan_skills()}
        self.assertEqual(scanned["vidsteps"]["gen_config"]["steps"], 8)
        # 不传 steps（如生图设置区保存）时保留既有值
        status, _ = self._call(image_gen_files.post_skill_config_route,
                               self._req({"skill_id": "vidsteps", "config": {"count": 2}}))
        self.assertEqual(status, 200)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(cfg["steps"], 8, "未传 steps 时保留既有步数")
        # 预设技能同样落盘（写本地覆盖文件，不改预设 config.json）
        status, _ = self._call(image_gen_files.post_skill_config_route,
                               self._req({"skill_id": "image_gen", "config": {"steps": 12}}))
        self.assertEqual(status, 200)
        with open(os.path.join(_skill_mod.SKILL_OVERRIDES_DIR, "image_gen.json"), encoding="utf-8") as f:
            ov = json.load(f)
        self.assertEqual(ov["steps"], 12)

    def test_copy_skill_files(self):
        d = self._make_custom_skill("copy_dst")
        status, body = self._call(
            image_gen_files.copy_skill_files_route,
            self._req({"from_id": "image_gen", "to_id": "copy_dst"}))
        self.assertEqual(status, 200)
        self.assertTrue(os.path.isfile(os.path.join(d, "workflow.json")))
        self.assertTrue(os.path.isfile(os.path.join(d, "config.json")))

        status, _ = self._call(
            image_gen_files.copy_skill_files_route,
            self._req({"from_id": "no_such_skill", "to_id": "copy_dst"}))
        self.assertEqual(status, 400)


class EnhanceSystemPromptTests(unittest.TestCase):
    """带 workflow.json 的技能正文只作帮助文档 → 增强用内置默认；无工作流的技能仍用正文作扩写指令。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_custom = _skill_mod.SKILL_CUSTOM_DIR
        self._orig_presets = _skill_mod.SKILL_PRESETS_DIR
        self._orig_lang = _skill_mod._resolve_skill_language
        # 语言检测依赖 llm/folder_paths（本套桩环境没有）→ 固定按英文取主文件
        _skill_mod._resolve_skill_language = lambda text: "en"
        _skill_mod.SKILL_CUSTOM_DIR = os.path.join(self._tmp.name, "custom")
        _skill_mod.SKILL_PRESETS_DIR = os.path.join(self._tmp.name, "presets")
        for base, sid in ((_skill_mod.SKILL_CUSTOM_DIR, "wf_skill"),
                          (_skill_mod.SKILL_PRESETS_DIR, "plain_skill")):
            d = os.path.join(base, sid)
            os.makedirs(d)
            with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
                f.write("---\nname: %s\n---\n正文扩写指令" % sid)
        wf = os.path.join(_skill_mod.SKILL_CUSTOM_DIR, "wf_skill", "workflow.json")
        with open(wf, "w", encoding="utf-8") as f:
            json.dump({"1": {"class_type": "UNETLoader", "inputs": {}}}, f)

    def tearDown(self):
        _skill_mod.SKILL_CUSTOM_DIR = self._orig_custom
        _skill_mod.SKILL_PRESETS_DIR = self._orig_presets
        _skill_mod._resolve_skill_language = self._orig_lang
        self._tmp.cleanup()

    def test_workflow_skill_uses_builtin_default(self):
        out = image_gen._enhance_system_prompt("wf_skill", "一只猫")
        self.assertNotIn("正文扩写指令", out, "带 workflow.json 的技能不应把正文当扩写指令")
        self.assertIn("prompt enhancer", out, "应回落到内置默认扩写指令")

    def test_skill_without_workflow_uses_body(self):
        out = image_gen._enhance_system_prompt("plain_skill", "一只猫")
        self.assertIn("正文扩写指令", out, "无工作流的技能仍用正文作扩写指令")

    def test_missing_skill_falls_back_to_default(self):
        out = image_gen._enhance_system_prompt("no_such_skill", "一只猫")
        self.assertIn("prompt enhancer", out)
        self.assertNotIn("正文扩写指令", out)


class ProgressTests(unittest.TestCase):
    """采样进度读取：仅当全局 registry 属于本 prompt 且存在步数节点时返回 value/max。"""

    def _with_registry(self, reg):
        orig = image_gen.get_progress_state
        image_gen.get_progress_state = lambda: reg
        self.addCleanup(setattr, image_gen, "get_progress_state", orig)

    def test_matching_prompt_returns_sampling_node(self):
        reg = types.SimpleNamespace(prompt_id="p1", nodes={
            "3": {"state": "running", "value": 3.0, "max": 8.0},   # KSampler
            "7": {"state": "finished", "value": 1.0, "max": 1.0},  # 无步数节点
        })
        self._with_registry(reg)
        self.assertEqual(image_gen._progress_for("p1"), {"value": 3, "max": 8})

    def test_other_prompt_returns_none(self):
        reg = types.SimpleNamespace(prompt_id="other", nodes={
            "3": {"state": "running", "value": 2.0, "max": 8.0},
        })
        self._with_registry(reg)
        self.assertIsNone(image_gen._progress_for("p1"))

    def test_no_step_node_returns_none(self):
        reg = types.SimpleNamespace(prompt_id="p1", nodes={
            "7": {"state": "running", "value": 0.0, "max": 1.0},
        })
        self._with_registry(reg)
        self.assertIsNone(image_gen._progress_for("p1"))

    def test_snapshot_carries_progress_and_finish_clears(self):
        task = {
            "task_id": "t", "prompt_id": "p1", "status": "running",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": {"value": 2, "max": 8}, "error": "", "warnings": [],
        }
        self.assertEqual(image_gen._snapshot(task)["progress"], {"value": 2, "max": 8})
        image_gen._finish(task, "succeeded", [], "")
        self.assertIsNone(task["progress"])


class WatchPushTests(unittest.TestCase):
    """_watch 按变化推送 rs.image_gen.status：状态/进度变化才推，重复快照不推，终态必推。"""

    def setUp(self):
        self._orig_poll = image_gen.POLL_INTERVAL
        self._orig_lookup = image_gen._lookup
        self._orig_prog = image_gen._progress_for
        self._orig_send = image_gen.PromptServer.instance.send_sync
        image_gen.POLL_INTERVAL = 0.001
        self.pushes = []
        image_gen.PromptServer.instance.send_sync = \
            lambda event, data, sid=None: self.pushes.append((event, data))
        self.addCleanup(setattr, image_gen, "POLL_INTERVAL", self._orig_poll)
        self.addCleanup(setattr, image_gen, "_lookup", self._orig_lookup)
        self.addCleanup(setattr, image_gen, "_progress_for", self._orig_prog)
        self.addCleanup(setattr, image_gen.PromptServer.instance, "send_sync", self._orig_send)

    def _task(self):
        return {
            "task_id": "tw", "prompt_id": "p1", "status": "queued",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": None, "error": "", "warnings": [],
        }

    def test_pushes_on_change_only(self):
        states = iter([("running", None)] * 3
                      + [("done", {"status": {"completed": True}, "outputs": {}})])
        progs = iter([{"value": 1, "max": 8}, {"value": 1, "max": 8}, {"value": 2, "max": 8}])
        image_gen._lookup = lambda pid: next(states)
        image_gen._progress_for = lambda pid: next(progs)
        task = self._task()
        image_gen.TASKS[task["task_id"]] = task
        self.addCleanup(image_gen.TASKS.pop, task["task_id"], None)

        asyncio.run(image_gen._watch(task["task_id"]))

        self.assertEqual([p[0] for p in self.pushes],
                         ["rs.image_gen.status"] * 3)
        self.assertEqual([p[1]["status"] for p in self.pushes],
                         ["running", "running", "succeeded"])
        self.assertEqual([p[1]["progress"] for p in self.pushes],
                         [{"value": 1, "max": 8}, {"value": 2, "max": 8}, None])


class PreviewCaptureTests(unittest.TestCase):
    """采样预览图捕获：进度 handler 按 prompt 存最新一张，_watch 随快照推送，终态清空。"""

    def setUp(self):
        self._prev = dict(image_gen._PREVIEWS)
        image_gen._PREVIEWS.clear()
        self.addCleanup(self._restore_prev)

    def _restore_prev(self):
        image_gen._PREVIEWS.clear()
        image_gen._PREVIEWS.update(self._prev)

    @staticmethod
    def _image():
        from PIL import Image
        return ("JPEG", Image.new("RGB", (64, 64), (200, 30, 30)), 512)

    def test_preview_data_url(self):
        url = image_gen._preview_data_url(self._image())
        self.assertTrue(url.startswith("data:image/jpeg;base64,"))
        raw = base64.b64decode(url.split(",", 1)[1])
        self.assertEqual(raw[:3], b"\xff\xd8\xff", "应为 JPEG")

    def test_capture_stores_latest_for_active_task(self):
        task = {
            "task_id": "tc", "prompt_id": "p9", "status": "running",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": None, "preview": None, "error": "", "warnings": [],
        }
        image_gen.TASKS[task["task_id"]] = task
        self.addCleanup(image_gen.TASKS.pop, task["task_id"], None)

        image_gen._PREVIEW_CAPTURE.update_handler("n", 1, 8, {}, "p9", self._image())
        self.assertTrue(image_gen._PREVIEWS["p9"].startswith("data:image/jpeg;base64,"))
        # 无图 / 未知 prompt：不写入
        image_gen._PREVIEW_CAPTURE.update_handler("n", 2, 8, {}, "p9", None)
        image_gen._PREVIEW_CAPTURE.update_handler("n", 2, 8, {}, "p10", self._image())
        self.assertEqual(list(image_gen._PREVIEWS), ["p9"])

    def test_watch_pushes_preview_and_clears_on_finish(self):
        self._orig_poll = image_gen.POLL_INTERVAL
        self._orig_lookup = image_gen._lookup
        self._orig_prog = image_gen._progress_for
        self._orig_send = image_gen.PromptServer.instance.send_sync
        image_gen.POLL_INTERVAL = 0.001
        pushes = []
        image_gen.PromptServer.instance.send_sync = \
            lambda event, data, sid=None: pushes.append(data)
        self.addCleanup(setattr, image_gen, "POLL_INTERVAL", self._orig_poll)
        self.addCleanup(setattr, image_gen, "_lookup", self._orig_lookup)
        self.addCleanup(setattr, image_gen, "_progress_for", self._orig_prog)
        self.addCleanup(setattr, image_gen.PromptServer.instance, "send_sync", self._orig_send)

        states = iter([("running", None)] * 2
                      + [("done", {"status": {"completed": True}, "outputs": {}})])
        progs = iter([{"value": 1, "max": 8}, {"value": 2, "max": 8}])
        image_gen._lookup = lambda pid: next(states)
        image_gen._progress_for = lambda pid: next(progs)
        task = {
            "task_id": "tp", "prompt_id": "p1", "status": "queued",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": None, "preview": None, "error": "", "warnings": [],
        }
        image_gen.TASKS[task["task_id"]] = task
        self.addCleanup(image_gen.TASKS.pop, task["task_id"], None)
        url = image_gen._preview_data_url(self._image())
        image_gen._PREVIEWS["p1"] = url

        asyncio.run(image_gen._watch(task["task_id"]))

        self.assertEqual([p["status"] for p in pushes], ["running", "running", "succeeded"])
        self.assertEqual([p["preview"] for p in pushes], [url, url, None],
                         "运行中随快照推预览图，终态清空")
        self.assertNotIn("p1", image_gen._PREVIEWS)

    def test_watch_re_registers_handler_after_registry_reset(self):
        """核心每次执行重建空 registry；_watch 须把捕获 handler 补注册回去。"""
        self._orig_poll = image_gen.POLL_INTERVAL
        self._orig_lookup = image_gen._lookup
        image_gen.POLL_INTERVAL = 0.001
        # 模拟核心 reset_progress_state：新 registry，handlers 只剩 webui
        fresh = types.SimpleNamespace(prompt_id="p2", nodes={}, handlers={"webui": object()})
        orig_registry = _progress_registry_holder["registry"]
        _progress_registry_holder["registry"] = fresh
        self.addCleanup(setattr, image_gen, "POLL_INTERVAL", self._orig_poll)
        self.addCleanup(setattr, image_gen, "_lookup", self._orig_lookup)
        self.addCleanup(_progress_registry_holder.__setitem__, "registry", orig_registry)

        states = iter([("running", None)]
                      + [("done", {"status": {"completed": True}, "outputs": {}})])
        image_gen._lookup = lambda pid: next(states)
        task = {
            "task_id": "tr", "prompt_id": "p2", "status": "queued",
            "created": 0.0, "updated": 0.0,
            "params": {"prompt": "x", "ref_name": "", "width": 8, "height": 8,
                       "model": "m", "seed": 1},
            "images": [], "progress": None, "preview": None, "error": "", "warnings": [],
        }
        image_gen.TASKS[task["task_id"]] = task
        self.addCleanup(image_gen.TASKS.pop, task["task_id"], None)

        asyncio.run(image_gen._watch(task["task_id"]))

        self.assertIn("neo_image_gen_preview", fresh.handlers,
                      "registry 被核心重建后，_watch 须补注册捕获 handler")

    def test_ensure_preview_handler_swaps_handlers_dict(self):
        """执行线程在 start_progress 里遍历 registry.handlers.values()；
        补注册原地插入会在遍历中的 dict 上撞出 "dictionary changed size during iteration"，
        节点执行直接失败，所以只能整块换新 dict。"""
        fresh = types.SimpleNamespace(prompt_id="p3", nodes={}, handlers={"webui": object()})
        orig_registry = _progress_registry_holder["registry"]
        _progress_registry_holder["registry"] = fresh
        self.addCleanup(_progress_registry_holder.__setitem__, "registry", orig_registry)
        iterating = fresh.handlers  # 模拟执行线程正拿着这个 dict 在遍历

        image_gen._ensure_preview_handler()

        self.assertIn(image_gen._PREVIEW_CAPTURE.name, fresh.handlers)
        self.assertIn("webui", fresh.handlers, "换新 dict 不能把核心 webui handler 挤掉")
        self.assertNotIn(image_gen._PREVIEW_CAPTURE.name, iterating,
                         "正在被遍历的旧 dict 不得被原地插入")
        swapped = fresh.handlers
        image_gen._ensure_preview_handler()
        self.assertIs(fresh.handlers, swapped, "已注册时不重复换 dict")


class SubmitGraphPreviewTests(unittest.TestCase):
    """submit_graph：未显式配置预览方法时按 prompt 附 extra_data.preview_method=latent2rgb。"""

    def _run(self, preview_method):
        import contextlib
        captured = {}

        class _Resp:
            status = 200

            async def json(self):
                return {"prompt_id": "pid1"}

        class _Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            def post(self, url, json=None, timeout=None):
                @contextlib.asynccontextmanager
                async def _post():
                    captured["payload"] = json
                    yield _Resp()
                return _post()

        orig_session = image_gen.aiohttp.ClientSession
        image_gen.aiohttp.ClientSession = lambda *a, **k: _Session()
        self.addCleanup(setattr, image_gen.aiohttp, "ClientSession", orig_session)
        orig_pm = image_gen.cli_args.preview_method
        image_gen.cli_args.preview_method = preview_method
        self.addCleanup(setattr, image_gen.cli_args, "preview_method", orig_pm)

        pid = asyncio.run(image_gen.submit_graph({"1": {"class_type": "X"}}))
        self.assertEqual(pid, "pid1")
        return captured["payload"]

    def test_default_none_sends_latent2rgb(self):
        payload = self._run(image_gen.LatentPreviewMethod.NoPreviews)
        self.assertEqual(payload.get("extra_data"), {"preview_method": "latent2rgb"},
                         "CLI 默认不生成预览图，需按 prompt 附 latent2rgb")

    def test_explicit_method_not_overridden(self):
        payload = self._run(image_gen.LatentPreviewMethod.TAESD)
        self.assertNotIn("extra_data", payload, "用户显式配置过预览方法时沿用其设置")


if __name__ == "__main__":
    unittest.main()

restore(NODE_STUB_PREFIXES, _STUB_SAVED)
