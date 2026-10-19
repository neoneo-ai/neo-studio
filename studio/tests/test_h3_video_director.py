# SPDX-License-Identifier: Apache-2.0
"""h3_video_director + video_director 配方 schema 的离线单测。

不依赖 ComfyUI 运行中的服务器与真实 H3 模型：server/comfy/folder_paths/nodes 用桩模块替换，
recipes 的 gallery/bookmark/gallery_lora/util 依赖用假模块；director 编排逻辑通过 monkeypatch
execute_graph_inprocess / resolve_video_params 等验证帧拼接、边界丢帧、seed 派生与音频对齐。"""

import asyncio
import base64
import contextlib
import io
import json
import logging
import os
import pathlib
import random
import sys
import shutil
import tempfile
import types
import unittest

import torch
from PIL import Image

import av

_TMP = tempfile.mkdtemp(prefix="neo_h3director_")
_INPUT_DIR = os.path.join(_TMP, "input")
_OUTPUT_DIR = os.path.join(_TMP, "output")
os.makedirs(_INPUT_DIR, exist_ok=True)
os.makedirs(_OUTPUT_DIR, exist_ok=True)

_MODELS = {
    "diffusion_models": ["minimax_h3_fl2va_pruned_int8_convrot.safetensors"],
    "text_encoders": ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
    "vae": ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"],
    "loras": ["Krea2-QuadView_test.safetensors"],
}

# ---- 桩模块（对齐 test_h3_video_gen.py）----
_server = types.ModuleType("server")
_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(
    routes=types.SimpleNamespace(get=lambda p: (lambda f: f), post=lambda p: (lambda f: f)),
    prompt_queue=types.SimpleNamespace(), client_id=None, send_sync=lambda *a, **k: None))
sys.modules["server"] = _server

_comfy = types.ModuleType("comfy")
_comfy_cli = types.ModuleType("comfy.cli_args")
_comfy_cli.args = types.SimpleNamespace(listen="127.0.0.1", port=8188, tls_keyfile=None, tls_certfile=None)


class _LatentPreviewMethod:
    NoPreviews = "none"
    Auto = "auto"
    Latent2RGB = "latent2rgb"
    TAESD = "taesd"


_comfy_cli.LatentPreviewMethod = _LatentPreviewMethod
sys.modules["comfy"] = _comfy
sys.modules["comfy.cli_args"] = _comfy_cli
_comfy_pe = types.ModuleType("comfy.patcher_extension")
_comfy_pe.WrappersMP = types.SimpleNamespace(DIFFUSION_MODEL="DIFFUSION_MODEL", APPLY_MODEL="APPLY_MODEL")
_comfy_pe.add_wrapper_with_key = lambda *a, **k: None
sys.modules["comfy.patcher_extension"] = _comfy_pe
_comfy_utils = types.ModuleType("comfy.utils")
_comfy_utils.common_upscale = lambda *a, **k: None
_comfy_utils.PROGRESS_BAR_HOOK = None   # 进度钩子：e2e 用例装 hijack_progress 等价物，验证 last_prompt_id 回退
sys.modules["comfy.utils"] = _comfy_utils
# comfy_api.latest._ui 导入期会 `import comfy.audio`（新版核心）；comfy 是上面的普通模块桩，
# 子模块必须显式占位，否则 "comfy is not a package"
sys.modules["comfy.audio"] = types.ModuleType("comfy.audio")
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
sys.modules["comfy_execution"] = _comfy_exec
sys.modules["comfy_execution.progress"] = _comfy_exec_prog

_folder_paths = types.ModuleType("folder_paths")
_folder_paths.get_filename_list = lambda folder: list(_MODELS.get(folder, []))
_folder_paths.get_input_directory = lambda: _INPUT_DIR
_folder_paths.get_output_directory = lambda: _OUTPUT_DIR
_folder_paths.get_annotated_filepath = lambda name, base_dir: os.path.join(base_dir, str(name).replace("/", os.sep))
sys.modules["folder_paths"] = _folder_paths

_nodes = types.ModuleType("nodes")
_nodes.NODE_CLASS_MAPPINGS = {}
_nodes.MAX_RESOLUTION = 8192
_nodes.interrupt_processing = lambda *a, **k: False   # storyboard 逐段检查中断；桩默认不中断
sys.modules["nodes"] = _nodes

# node_helpers 桩：conditioning_set_values 只做「复制 metadata 并写入给定值」（与 core 同语义）
_node_helpers = types.ModuleType("node_helpers")


def _stub_conditioning_set_values(conditioning, values=None, append=False):
    out = []
    for t, d in conditioning:
        nd = dict(d)
        for k, v in (values or {}).items():
            nd[k] = ((nd.get(k) or []) + v) if append else v
        out.append([t, nd])
    return out


_node_helpers.conditioning_set_values = _stub_conditioning_set_values
sys.modules["node_helpers"] = _node_helpers

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PLUGIN_DIR)
# V3 节点（image_gen_edit）导入期要 comfy_api.latest：先备好 ComfyUI 根目录与占位子模块
import _comfy_api_bootstrap  # noqa: E402
_comfy_api_bootstrap.bootstrap(PLUGIN_DIR)

_PKG = "_neo_h3director_pkg"
_pkg = types.ModuleType(_PKG)
_pkg.__path__ = [PLUGIN_DIR]
sys.modules[_PKG] = _pkg


def _load(name, fname):
    import importlib.util
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{name}", os.path.join(PLUGIN_DIR, fname))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG}.{name}"] = mod
    setattr(_pkg, name, mod)
    spec.loader.exec_module(mod)
    return mod


# ---- recipes 的依赖桩（gallery/bookmark/gallery_lora/util）----
_gallery = types.ModuleType(f"{_PKG}.gallery")
_gallery.AUDIO_EXTENSIONS = {".mp3", ".wav"}
_gallery.IMG_EXTENSIONS = {".png", ".jpg", ".jpeg"}
_gallery.VIDEO_EXTENSIONS = {".mp4", ".webm"}


def _fake_copy_media_to_input(source_path, filename):
    import shutil
    dest = os.path.join(_INPUT_DIR, filename)
    if not os.path.exists(dest):
        shutil.copy2(str(source_path), dest)
    return filename, False


_gallery._copy_media_to_input = _fake_copy_media_to_input
sys.modules[f"{_PKG}.gallery"] = _gallery
setattr(_pkg, "gallery", _gallery)

_bookmark = types.ModuleType(f"{_PKG}.bookmark")
_bookmark._download_bytes = lambda *a, **k: b""
_bookmark._media_ext_from_url_or_bytes = lambda *a, **k: ".png"
sys.modules[f"{_PKG}.bookmark"] = _bookmark
setattr(_pkg, "bookmark", _bookmark)

_gallery_lora = types.ModuleType(f"{_PKG}.gallery_lora")
_gallery_lora.LORA_CACHE_DIR = os.path.join(_TMP, "lora_cache")
_gallery_lora._load_lora_index = lambda *a, **k: {}
sys.modules[f"{_PKG}.gallery_lora"] = _gallery_lora
setattr(_pkg, "gallery_lora", _gallery_lora)

_util = types.ModuleType(f"{_PKG}.util")
_util._extract_media_metadata = lambda *a, **k: {}
_util._json_safe = lambda v: v
class _PF(logging.Filter):
    def filter(self, record):
        return True
_util.PrefixFilter = _PF
_util.plugin_version = lambda: "0.0.0-stub"   # studio.py 的版本 banner / 版本页共用
sys.modules[f"{_PKG}.util"] = _util
setattr(_pkg, "util", _util)

# ---- h3_preview 依赖桩：latent_preview / comfy.model_management / comfy.latent_formats / comfy.taesd.taesd ----
# taeh3 缺失时预览走 Latent2RGB 回退，故 get_full_path 返回 None（离线测试不碰真实权重）。
_folder_paths.get_full_path = lambda folder, name: None

_comfy_mm = types.ModuleType("comfy.model_management")
_comfy_mm.vae_device = lambda *a, **k: torch.device("cpu")
_comfy_mm.vae_dtype = lambda device, allowed=None: torch.float32
_comfy_mm.get_torch_device = lambda: torch.device("cuda")
_comfy_mm.unload_all_models = lambda: None      # 重生成前先卸载驻留模型（用例里只验证调用与顺序）
_comfy_mm.soft_empty_cache = lambda force=False: None


class _StubInterruptProcessingException(BaseException):
    pass


_comfy_mm.InterruptProcessingException = _StubInterruptProcessingException
sys.modules["comfy.model_management"] = _comfy_mm

_comfy_lf = types.ModuleType("comfy.latent_formats")


class _StubMiniMaxH3Video:
    latent_rgb_factors = [[0.1, 0.2, 0.3]]
    latent_rgb_factors_bias = None
    latent_rgb_factors_reshape = None


_comfy_lf.MiniMaxH3Video = _StubMiniMaxH3Video
sys.modules["comfy.latent_formats"] = _comfy_lf

_comfy_taesd = types.ModuleType("comfy.taesd")
_comfy_taesd_taesd = types.ModuleType("comfy.taesd.taesd")


class _StubClamp(torch.nn.Module):
    def forward(self, x):
        return x


class _StubBlock(torch.nn.Module):
    """占位 Block：只留通道数，供 _build_decoder 的结构断言（真实 Block 由真机覆盖）。"""

    def __init__(self, n_in, n_out):
        super().__init__()
        self.n_in = n_in
        self.n_out = n_out


def _stub_conv(n_in, n_out, **kwargs):
    return torch.nn.Conv2d(n_in, n_out, 3, padding=1, bias=kwargs.get("bias", True))


_comfy_taesd_taesd.Clamp = _StubClamp
_comfy_taesd_taesd.Block = _StubBlock
_comfy_taesd_taesd.conv = _stub_conv
sys.modules["comfy.taesd"] = _comfy_taesd
sys.modules["comfy.taesd.taesd"] = _comfy_taesd_taesd


class _StubLatentPreviewer:
    def decode_latent_to_preview(self, x0):
        pass

    def decode_latent_to_preview_image(self, preview_format, x0):
        return ("JPEG", self.decode_latent_to_preview(x0), 512)


class _StubLatent2RGBPreviewer(_StubLatentPreviewer):
    def __init__(self, factors, bias=None, reshape=None):
        self.factors = factors


def _stub_preview_to_image(latent_image, do_scale=True):
    return Image.new("RGB", (int(latent_image.shape[1]), int(latent_image.shape[0])))


_latent_preview_stub = types.ModuleType("latent_preview")
_latent_preview_stub.LatentPreviewer = _StubLatentPreviewer
_latent_preview_stub.Latent2RGBPreviewer = _StubLatent2RGBPreviewer
_latent_preview_stub.preview_to_image = _stub_preview_to_image
_latent_preview_stub.get_previewer = lambda device, latent_format: None
sys.modules["latent_preview"] = _latent_preview_stub

# 预置在 sys.modules 的子模块不会自动挂到父模块，补上属性以支持 `comfy.x.y` 形式访问。
setattr(_comfy, "model_management", _comfy_mm)
setattr(_comfy, "utils", _comfy_utils)
setattr(_comfy, "latent_formats", _comfy_lf)
setattr(_comfy, "taesd", _comfy_taesd)
setattr(_comfy_taesd, "taesd", _comfy_taesd_taesd)

# ---- 加载插件模块 ----
skill = _load("skill", "skill.py")
image_gen = _load("image_gen", "image_gen.py")
# storyboard 端到端用例走真实 resolve_request/render_template（验证多参考去重/截断与槽位裁剪），
# 但不关心模型文件是否存在：桩掉 resolve_model 返回占位名，避免依赖 _MODELS 与 Krea2 名称线索匹配。
image_gen.resolve_model = lambda folder, wanted: (str(wanted or "").strip() or f"{folder}_stub.safetensors", "")
image_gen_edit = _load("image_gen_edit", "image_gen_edit.py")
h3_video_gen = _load("h3_video_gen", "h3_video_gen.py")
video_gen = _load("video_gen", "video_gen.py")
recipes = _load("recipes", "recipes.py")

# comfy_api.latest 桩：director 仅用 VideoFromComponents/VideoComponents 作容器，
# get_components() 原样返回传入的 components（.images/.audio），足以验证编排逻辑。
class _StubVideoComponents:
    def __init__(self, images=None, audio=None, frame_rate=None, metadata=None, alpha=None):
        self.images = images
        self.audio = audio
        self.frame_rate = frame_rate
        self.metadata = metadata
        self.alpha = alpha


class _StubVideoFromComponents:
    def __init__(self, components, **kwargs):
        self.__components = components

    def get_components(self):
        return self.__components


_comfy_api = types.ModuleType("comfy_api")
_comfy_api_latest = types.ModuleType("comfy_api.latest")
_comfy_api_latest.Types = types.SimpleNamespace(
    VideoComponents=_StubVideoComponents,
    VideoContainer=types.SimpleNamespace(MP4="mp4"),
    VideoCodec=types.SimpleNamespace(H264="h264"),
)
_comfy_api_latest.InputImpl = types.SimpleNamespace(VideoFromComponents=_StubVideoFromComponents)
sys.modules["comfy_api"] = _comfy_api
sys.modules["comfy_api.latest"] = _comfy_api_latest

h3_video_director = _load("h3_video_director", "h3_video_director.py")
# 多帧单次预设的工作流模板（从 skills/presets/minimax_h3_multiframe/workflow.json 读，供编排测试渲染桩用）
_MULTIFRAME_WF = json.load(open(os.path.join(PLUGIN_DIR, "skills", "presets", "minimax_h3_multiframe", "workflow.json"), encoding="utf-8"))
# VDN 版多帧模板（用户常选的那个）：多一层 ApplyVDNH3Advanced，图同样只经关键帧锚点注入
_MULTIFRAME_VDN_WF = json.load(open(os.path.join(PLUGIN_DIR, "skills", "presets", "minimax_h3_vdn_multiframe", "workflow.json"), encoding="utf-8"))
# comfy_execution.utils 加载真实实现（自包含，仅依赖 contextvars）：storyboard 的 CurrentNodeContext
# 与进度钩子的 get_executing_context 都靠它，e2e 用例要验证真实的执行上下文传播。
import importlib.util
_comfy_exec_utils_path = _comfy_api_bootstrap.comfy_file("comfy_execution", "utils.py")
_spec = importlib.util.spec_from_file_location("comfy_execution.utils", _comfy_exec_utils_path)
_comfy_exec_utils = importlib.util.module_from_spec(_spec)
sys.modules["comfy_execution.utils"] = _comfy_exec_utils
_spec.loader.exec_module(_comfy_exec_utils)
storyboard = _load("storyboard", "storyboard.py")


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()

# ===========================================================================
# P1：_normalize_director 校验
# ===========================================================================
class NormalizeDirectorTests(unittest.TestCase):
    def test_valid_segments_normalized(self):
        shared, segs = recipes._normalize_director(
            {"shared": {"width": "800", "height": 600, "seed": "7"},
             "segments": [
                 {"skill_id": "h3_t2v", "prompt": "a cat", "duration_sec": 5},
                 {"skill_id": "h3_i2v", "prompt": "runs", "first_frame": "f.png"},
             ]},
            {"f.png": "f_copied.png"})
        self.assertEqual(shared, {"width": 800, "height": 600, "seed": 7})
        self.assertEqual(segs[0]["skill_id"], "h3_t2v")
        self.assertIsNone(segs[0].get("first_frame"))
        # first_frame 回写为落盘最终名（原始名 → copied 名）
        self.assertEqual(segs[1]["first_frame"], "f_copied.png")

    def test_empty_segments_rejected(self):
        with self.assertRaises(ValueError):
            recipes._normalize_director({"segments": []}, {})

    def test_empty_skill_id_allowed_as_draft(self):
        # 技能为空允许保存（草稿）：前端只提示、不阻止，后端同样放行，执行时再校验
        shared, segs = recipes._normalize_director(
            {"segments": [{"prompt": "x", "skill_id": ""}]}, {})
        self.assertEqual(segs[0]["skill_id"], "")

    def test_bad_first_frame_ref_rejected(self):
        # 段引用了未出现在 orig_to_copied 的资产 → 拒绝
        with self.assertRaises(ValueError):
            recipes._normalize_director(
                {"segments": [{"prompt": "x", "skill_id": "s", "first_frame": "nope.png"}]},
                {"other.png": "other.png"})

    def test_resave_keeps_stored_asset_ref(self):
        # 二次保存：段引用的是上次保存回写的落盘最终名（不在本次 orig_to_copied），
        # 该名字在 existing_assets 中 → 直接保留不报错
        shared, segs = recipes._normalize_director(
            {"segments": [{"prompt": "x", "skill_id": "s", "first_frame": "f_copied.png"}]},
            {}, {"f_copied.png"})
        self.assertEqual(segs[0]["first_frame"], "f_copied.png")
        # 不在 existing_assets 的名字仍拒绝
        with self.assertRaises(ValueError):
            recipes._normalize_director(
                {"segments": [{"prompt": "x", "skill_id": "s", "first_frame": "ghost.png"}]},
                {}, {"f_copied.png"})

    def test_empty_prompt_allowed_as_draft(self):
        # 提示词为空允许保存（草稿）：前端只提示、不阻止，后端同样放行，执行时再校验
        shared, segs = recipes._normalize_director(
            {"segments": [{"prompt": "  ", "skill_id": "s"}]}, {})
        self.assertEqual(segs[0]["prompt"], "")

    def test_global_mode_preserved(self):
        shared, _ = recipes._normalize_director(
            {"shared": {"mode": "i2v"}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertEqual(shared["mode"], "i2v")

    def test_invalid_global_mode_dropped(self):
        shared, _ = recipes._normalize_director(
            {"shared": {"mode": "xxx"}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertNotIn("mode", shared)

    def test_identity_refs_only_written_when_disabled(self):
        # 默认开 → 不落盘该键（旧配方行为不变）；显式关掉才写 false
        shared, _ = recipes._normalize_director(
            {"shared": {"identity_refs": True}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertNotIn("identity_refs", shared)
        shared, _ = recipes._normalize_director(
            {"shared": {"identity_refs": False}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertFalse(shared["identity_refs"])

    def test_chunk_sec_normalized(self):
        # 分块秒数：合法值转 int 落盘；0 保留（显式关闭）；越界 / 非法丢弃（执行时按默认 15）
        shared, _ = recipes._normalize_director(
            {"shared": {"chunk_sec": 12.7}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertEqual(shared["chunk_sec"], 12)
        shared, _ = recipes._normalize_director(
            {"shared": {"chunk_sec": 0}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertEqual(shared["chunk_sec"], 0)
        shared, _ = recipes._normalize_director(
            {"shared": {"chunk_sec": -5}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertNotIn("chunk_sec", shared)

    def test_run_params_normalized(self):
        # 整片运行参数（编辑器保存，Studio 生成面板只发配方名）：steps 钳到 [-1,100]、
        # continuity 转 bool、context_frames 钳到 [0,362]
        shared, _ = recipes._normalize_director(
            {"shared": {"steps": 300, "continuity": False, "context_frames": 400},
             "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertEqual(shared["steps"], 100)
        self.assertIs(shared["continuity"], False)
        self.assertEqual(shared["context_frames"], 362)
        shared, _ = recipes._normalize_director(
            {"shared": {"steps": -1, "continuity": True, "context_frames": 0},
             "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertEqual(shared["steps"], -1)
        self.assertIs(shared["continuity"], True)
        self.assertEqual(shared["context_frames"], 0)

    def test_run_params_absent_keeps_old_recipe_shape(self):
        # 旧配方没有这些键 → 不落盘：执行时沿用 steps=-1（各段技能 config）、continuity=True、context_frames=22
        shared, _ = recipes._normalize_director(
            {"shared": {"width": 800}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
        self.assertNotIn("steps", shared)
        self.assertNotIn("continuity", shared)
        self.assertNotIn("context_frames", shared)

    def test_default_dims_prefers_shared_steps(self):
        # 节点 widget 默认值：配方 shared 存了 steps / 宽高就用配方的；steps=-1（技能默认）不覆盖 config
        self.assertEqual(recipes._director_default_dims([{"skill_id": "s"}], {"steps": 12, "width": 640, "height": 384}),
                         {"width": 640, "height": 384, "steps": 12})
        self.assertEqual(recipes._director_default_dims([], {"steps": -1})["steps"], 20)

    def test_multiframe_flag_ignored(self):
        # shared.multiframe 已废弃：无论输入取值如何都不落盘（多帧行为改由选中技能决定）
        for val in (True, False):
            shared, _ = recipes._normalize_director(
                {"shared": {"multiframe": val}, "segments": [{"prompt": "x", "skill_id": "s"}]}, {})
            self.assertNotIn("multiframe", shared)

    def test_segment_mode_kept_when_valid_dropped_when_invalid(self):
        _, segs = recipes._normalize_director(
            {"shared": {"mode": "mixed"},
             "segments": [{"prompt": "x", "skill_id": "s", "mode": "t2v"},
                          {"prompt": "y", "skill_id": "s", "mode": "bogus"}]}, {})
        self.assertEqual(segs[0]["mode"], "t2v")
        self.assertNotIn("mode", segs[1])

    def test_segment_ref_media_capped(self):
        # 每段参考上限与参考节点槽位一致：图 9 / 视频 3 / 音频 3
        names = ([f"i{n}.png" for n in range(12)] + [f"v{n}.mp4" for n in range(5)]
                 + [f"a{n}.wav" for n in range(5)])
        _, segs = recipes._normalize_director(
            {"shared": {"mode": "i2v"},
             "segments": [{"prompt": "x", "skill_id": "s",
                           "refs": {"images": names[:12], "videos": names[12:17], "audios": names[17:]}}]},
            {n: n for n in names})
        self.assertEqual(len(segs[0]["refs"]["images"]), 9)
        self.assertEqual(len(segs[0]["refs"]["videos"]), 3)
        self.assertEqual(len(segs[0]["refs"]["audios"]), 3)



# ===========================================================================
# P1：_normalize_director_story（自动故事板内容随配方落盘）
# ===========================================================================
class NormalizeDirectorStoryTests(unittest.TestCase):
    def test_story_normalized_and_refs_rewritten(self):
        # 描述去空白保留；参考图原始名回写为落盘最终名；粒度转 int
        story = recipes._normalize_director_story(
            {"story": {"idea": " 主题 ", "story": " 正文 ",
                       "characters": [{"filename": "c.png", "desc": " 猫 "}],
                       "segment_seconds": "10"}},
            {"c.png": "c_copied.png"})
        self.assertEqual(story["idea"], "主题")
        self.assertEqual(story["story"], "正文")
        self.assertEqual(story["characters"], [{"filename": "c_copied.png", "desc": "猫"}])
        self.assertNotIn("backgrounds", story, "背景参考图已移除，不再落盘")
        self.assertEqual(story["segment_seconds"], 10)

    def test_missing_and_empty_story_returns_none(self):
        self.assertIsNone(recipes._normalize_director_story({}, {}))
        self.assertIsNone(recipes._normalize_director_story({"story": {}}, {}))
        self.assertIsNone(recipes._normalize_director_story({"story": {"idea": "  "}}, {}))
        self.assertIsNone(recipes._normalize_director_story({"story": "不是对象"}, {}))

    def test_unstored_ref_dropped_without_failing(self):
        # 参考图只喂故事生成：引用未落盘资产时丢该条，其余内容仍保存
        story = recipes._normalize_director_story(
            {"story": {"story": "正文", "characters": [{"filename": "ghost.png"}]}}, {})
        self.assertEqual(story["characters"], [])
        self.assertEqual(story["story"], "正文")

    def test_resave_keeps_stored_ref(self):
        # 二次保存：参考图是上次回写的最终名（不在本次 orig_to_copied）→ 直接保留
        story = recipes._normalize_director_story(
            {"story": {"idea": "x", "characters": [{"filename": "c_copied.png", "desc": "猫"}]}},
            {}, {"c_copied.png"})
        self.assertEqual(story["characters"], [{"filename": "c_copied.png", "desc": "猫"}])

    def test_image_storyboard_settings_normalized(self):
        # 图片分镜设置（t2i/r2i + 生图技能 + 分镜来源）随 story 落盘；非法值丢弃不落盘
        story = recipes._normalize_director_story(
            {"story": {"idea": "x", "image_mode": "r2i", "image_skill": "qwen_image_21",
                       "frame_source": "storyboard"}}, {})
        self.assertEqual(story["image_mode"], "r2i")
        self.assertEqual(story["image_skill"], "qwen_image_21")
        self.assertEqual(story["frame_source"], "storyboard")

        story = recipes._normalize_director_story(
            {"story": {"idea": "x", "image_mode": "v2i", "frame_source": "unified", "image_skill": "  "}}, {})
        self.assertIsNone(story["image_mode"])
        self.assertIsNone(story["frame_source"])   # 旧 unified 值随非法值丢弃
        self.assertIsNone(story["image_skill"])

    def test_frame_source_grid_preserved(self):
        # 宫格图拆分方式（grid）是合法值，随 story 落盘并回显
        story = recipes._normalize_director_story(
            {"story": {"idea": "x", "frame_source": "grid"}}, {})
        self.assertEqual(story["frame_source"], "grid")


# ===========================================================================
# P1：_normalize_director_setup（统一设置区状态随配方落盘）
# ===========================================================================
class NormalizeDirectorSetupTests(unittest.TestCase):
    def test_setup_normalized_and_refs_rewritten(self):
        # 参考原始名回写为落盘最终名；首/尾帧同样回写
        setup = recipes._normalize_director_setup(
            {"setup": {"refs": {"images": ["a.png", "ghost.png"], "videos": ["v.mp4"]},
                       "first_frame": "f.png", "last_frame": "l.png"}},
            {"a.png": "a_copied.png", "v.mp4": "v_copied.mp4",
             "f.png": "f_copied.png", "l.png": "l_copied.png"})
        self.assertEqual(setup["refs"]["images"], ["a_copied.png"])   # 未落盘资产被丢弃、不报错
        self.assertEqual(setup["refs"]["videos"], ["v_copied.mp4"])
        self.assertEqual(setup["first_frame"], "f_copied.png")
        self.assertEqual(setup["last_frame"], "l_copied.png")

    def test_missing_and_empty_setup_returns_none(self):
        self.assertIsNone(recipes._normalize_director_setup({}, {}))
        self.assertIsNone(recipes._normalize_director_setup({"setup": {}}, {}))
        self.assertIsNone(recipes._normalize_director_setup({"setup": {"refs": {}}}, {}))
        self.assertIsNone(recipes._normalize_director_setup({"setup": "不是对象"}, {}))

    def test_resave_keeps_stored_ref(self):
        # 二次保存：统一素材是上次回写的最终名（不在本次 orig_to_copied）→ 直接保留
        setup = recipes._normalize_director_setup(
            {"setup": {"refs": {"images": ["a_copied.png"]}, "first_frame": "f_copied.png"}},
            {}, {"a_copied.png", "f_copied.png"})
        self.assertEqual(setup["refs"]["images"], ["a_copied.png"])
        self.assertEqual(setup["first_frame"], "f_copied.png")

    def test_prompt_compare_kept(self):
        # 优化前后提示词对照原样落盘（仅回显用）；空项/非文本项被丢弃
        setup = recipes._normalize_director_setup(
            {"setup": {"orig_prompts": ["a", "  b  ", "", None], "opt_prompts": [1]}}, {})
        self.assertEqual(setup["orig_prompts"], ["a", "b"])
        self.assertEqual(setup["opt_prompts"], ["1"])

    def test_prompt_compare_only_still_writes(self):
        # 仅对照内容也写入 setup；空列表不写该字段
        setup = recipes._normalize_director_setup(
            {"setup": {"orig_prompts": ["a"], "opt_prompts": []}}, {})
        self.assertEqual(setup["orig_prompts"], ["a"])
        self.assertNotIn("opt_prompts", setup)

    def test_bad_prompt_compare_dropped(self):
        # 非列表的对照字段丢弃，不影响其他字段
        setup = recipes._normalize_director_setup(
            {"setup": {"orig_prompts": "不是列表", "first_frame": "f.png"}},
            {"f.png": "f_copied.png"})
        self.assertNotIn("orig_prompts", setup)
        self.assertEqual(setup["first_frame"], "f_copied.png")


# ===========================================================================
# P1：list_director_recipes / load_director_spec（临时目录，不污染真实配方）
# ===========================================================================
class DirectorRecipeIOTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="neo_dirrec_")
        self.custom = os.path.join(self._tmp, "custom")
        self.presets = os.path.join(self._tmp, "presets")
        os.makedirs(self.custom)
        os.makedirs(self.presets)
        import pathlib
        self._orig_custom = recipes.CUSTOM_DIR
        self._orig_presets = recipes.PRESETS_DIR
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)
        recipes.PRESETS_DIR = pathlib.Path(self.presets)

    def tearDown(self):
        recipes.CUSTOM_DIR = self._orig_custom
        recipes.PRESETS_DIR = self._orig_presets

    def _make_recipe(self, name, meta, assets=()):
        d = os.path.join(self.custom, name)
        assets_dir = os.path.join(d, "assets")
        os.makedirs(assets_dir, exist_ok=True)
        for a in assets:
            with open(os.path.join(assets_dir, a), "wb") as f:
                f.write(b"fake-media-bytes")
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f)

    def test_list_returns_only_directors(self):
        self._make_recipe("flat", {"prompt": "p"})
        self._make_recipe("dir1", {"type": "video_director", "shared": {}, "segments": [
            {"skill_id": "s", "prompt": "p"}]}, assets=["f.png"])
        self.assertEqual(recipes.list_director_recipes(), ["dir1"])

    def _make_preset(self, name, meta):
        d = os.path.join(self.presets, name)
        os.makedirs(os.path.join(d, "assets"), exist_ok=True)
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f)

    def test_list_order_matches_sidebar(self):
        # 与配方面板侧栏一致：custom 在前、presets 在后，组内按最近修改时间倒序
        import time
        self._make_recipe("c-old", {"type": "video_director", "shared": {}, "segments": []})
        self._make_recipe("c-new", {"type": "video_director", "shared": {}, "segments": []})
        self._make_preset("p-mid", {"type": "video_director", "shared": {}, "segments": []})
        now = time.time()
        os.utime(os.path.join(self.custom, "c-old", "recipe.json"), (now - 7200, now - 7200))
        os.utime(os.path.join(self.custom, "c-new", "recipe.json"), (now, now))
        os.utime(os.path.join(self.presets, "p-mid", "recipe.json"), (now - 3600, now - 3600))

        self.assertEqual(recipes.list_director_recipes(), ["c-new", "c-old", "p-mid"])

    def test_list_dedupes_custom_over_preset(self):
        self._make_recipe("dup", {"type": "video_director", "shared": {}, "segments": []})
        self._make_preset("dup", {"type": "video_director", "shared": {}, "segments": []})
        self.assertEqual(recipes.list_director_recipes(), ["dup"])

    def test_list_sorted_by_mtime_descending(self):
        # /rs_recipes/list 组内按最近修改时间倒序：最新改动的配方排在最前
        import time
        self._make_recipe("aaa", {"prompt": "p"})
        self._make_recipe("zzz", {"prompt": "q"})
        now = time.time()
        os.utime(os.path.join(self.custom, "aaa", "recipe.json"), (now - 3600, now - 3600))
        os.utime(os.path.join(self.custom, "zzz", "recipe.json"), (now, now))

        resp = _run_async(recipes.rs_recipes_list(None))
        self.assertEqual(resp.status, 200)
        names = [r["name"] for r in json.loads(resp.body)]
        # zzz（新）在 aaa（旧）之前；若按名字字母序则会反过来
        self.assertEqual(names[:2], ["zzz", "aaa"])

    def test_load_spec_resolves_first_frame(self):
        self._make_recipe("d", {"type": "video_director",
                                "shared": {"width": 8, "height": 8, "seed": 1},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "duration_sec": 5, "first_frame": "f.png"},
                                    {"skill_id": "s1", "prompt": "b"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("d")
        self.assertEqual(spec["shared"]["seed"], 1)
        self.assertEqual(len(spec["segments"]), 2)
        self.assertEqual(spec["segments"][0]["ref_input"], "f.png")
        self.assertIsNone(spec["segments"][1]["ref_input"])

    def test_load_spec_resolves_keyframe_for_chunking(self):
        # 多帧单次关键帧：first_frame 优先；缺省时回退分镜图（t2v 段也算）；文件缺失 → None
        self._make_recipe("k", {"type": "video_director",
                                "shared": {},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "first_frame": "f.png", "storyboard": "sb.png"},
                                    {"skill_id": "s1", "prompt": "b", "storyboard": "sb1.png"},
                                    {"skill_id": "s2", "prompt": "c", "storyboard": "ghost.png"},
                                ]}, assets=["f.png", "sb.png", "sb1.png"])
        spec = recipes.load_director_spec("k")
        self.assertEqual([s["keyframe"] for s in spec["segments"]], ["f.png", "sb1.png", None])

    def test_load_spec_legacy_global_frame_mode_derived_from_assets(self):
        # 旧全局帧模式值（i2v/t2v）不再强制全体：按各段首/尾帧资产推导（有首帧=i2v，无=t2v）
        self._make_recipe("g", {"type": "video_director",
                                "shared": {"mode": "t2v", "width": 8, "height": 8},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "first_frame": "f.png"},
                                    {"skill_id": "s1", "prompt": "b"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("g")
        self.assertEqual([s["mode"] for s in spec["segments"]], ["i2v", "t2v"])

    def test_load_spec_mixed_respects_segment_mode(self):
        # 混合模式：逐段采用各自 seg.mode
        self._make_recipe("g", {"type": "video_director",
                                "shared": {"mode": "mixed", "width": 8, "height": 8},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "mode": "i2v", "first_frame": "f.png"},
                                    {"skill_id": "s1", "prompt": "b", "mode": "t2v"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("g")
        self.assertEqual([s["mode"] for s in spec["segments"]], ["i2v", "t2v"])

    def test_load_spec_legacy_infers_mode_from_first_frame(self):
        # 旧配方无 shared.mode / seg.mode：按是否带首帧推断（有=i2v，无=t2v）
        self._make_recipe("g", {"type": "video_director",
                                "shared": {"width": 8, "height": 8},
                                "segments": [
                                    {"skill_id": "s0", "prompt": "a", "first_frame": "f.png"},
                                    {"skill_id": "s1", "prompt": "b"},
                                ]}, assets=["f.png"])
        spec = recipes.load_director_spec("g")
        self.assertEqual([s["mode"] for s in spec["segments"]], ["i2v", "t2v"])

    def test_load_spec_resolves_segment_ref_media(self):
        # 每段挂的图/视频/音频参考解析成 input 相对名，供参考生视频技能使用
        self._make_recipe("r", {"type": "video_director",
                                "shared": {"mode": "i2v", "width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p",
                                              "refs": {"images": ["a.png", "b.png"],
                                                       "videos": ["v.mp4"],
                                                       "audios": ["s.wav"]}}]},
                         assets=["a.png", "b.png", "v.mp4", "s.wav"])
        spec = recipes.load_director_spec("r")
        self.assertEqual(spec["segments"][0]["refs"],
                         {"images": ["a.png", "b.png"], "videos": ["v.mp4"], "audios": ["s.wav"]})

    def test_load_spec_skips_missing_ref_media(self):
        # 缺文件的参考只跳过该条，其余照常解析（不整段失败）
        self._make_recipe("r", {"type": "video_director",
                                "shared": {"mode": "i2v", "width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p",
                                              "refs": {"videos": ["gone.mp4", "v.mp4"]}}]},
                         assets=["v.mp4"])
        spec = recipes.load_director_spec("r")
        self.assertEqual(spec["segments"][0]["refs"], {"videos": ["v.mp4"]})

    def test_load_spec_migrates_legacy_source_video(self):
        # 旧 v2v/rv2v 配方的独立 source_video：并入参考视频首位（第一个参考视频即源视频），模式推得 r2v
        self._make_recipe("sv", {"type": "video_director",
                                 "shared": {"width": 8, "height": 8},
                                 "segments": [{"skill_id": "s", "prompt": "p",
                                               "source_video": "src.mp4"}]},
                          assets=["src.mp4"])
        seg = recipes.load_director_spec("sv")["segments"][0]
        self.assertEqual(seg["refs"], {"videos": ["src.mp4"]})
        self.assertEqual(seg["mode"], "r2v")
        self.assertNotIn("source_video", seg)

    def test_load_spec_legacy_source_video_joins_existing_refs(self):
        # 旧 source_video 与已有参考视频同名：去重后置顶，顺序不变
        self._make_recipe("sv2", {"type": "video_director",
                                  "shared": {"width": 8, "height": 8},
                                  "segments": [{"skill_id": "s", "prompt": "p",
                                                "source_video": "src.mp4",
                                                "refs": {"videos": ["src.mp4", "v.mp4"]}}]},
                          assets=["src.mp4", "v.mp4"])
        seg = recipes.load_director_spec("sv2")["segments"][0]
        self.assertEqual(seg["refs"], {"videos": ["src.mp4", "v.mp4"]})

    def test_load_spec_resolves_last_frame(self):
        # 首尾帧模式：首帧 → ref_input，尾帧 → last_input，模式沿用配方 shared.mode
        self._make_recipe("f", {"type": "video_director",
                                "shared": {"mode": "fl2v", "width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p",
                                              "first_frame": "a.png", "last_frame": "z.png"}]},
                         assets=["a.png", "z.png"])
        seg = recipes.load_director_spec("f")["segments"][0]
        self.assertEqual(seg["ref_input"], "a.png")
        self.assertEqual(seg["last_input"], "z.png")
        self.assertEqual(seg["mode"], "fl2v")

    def test_load_spec_storyboard_not_first_frame_without_assets(self):
        # 无首帧段（推得 t2v）：分镜关键帧不回填为首帧，只作多帧分块锚点（keyframe）
        self._make_recipe("sb", {"type": "video_director",
                                 "shared": {"mode": "i2v", "width": 8, "height": 8},
                                 "segments": [{"skill_id": "s", "prompt": "p",
                                               "storyboard": "storyboard_sb_01.png"}]},
                          assets=["storyboard_sb_01.png"])
        seg = recipes.load_director_spec("sb")["segments"][0]
        self.assertIsNone(seg["ref_input"])
        self.assertEqual(seg["mode"], "t2v")
        self.assertEqual(seg["keyframe"], "storyboard_sb_01.png")

    def test_load_spec_storyboard_ignored_when_file_gone(self):
        # 配方 assets/ 里的关键帧已被清理：跳过，不报错（与编辑器同样显示不出缩略图）
        self._make_recipe("sbm", {"type": "video_director",
                                  "shared": {"mode": "i2v", "width": 8, "height": 8},
                                  "segments": [{"skill_id": "s", "prompt": "p",
                                                "storyboard": "storyboard_sbm_01.png"}]})
        self.assertIsNone(recipes.load_director_spec("sbm")["segments"][0]["ref_input"])

    def test_load_spec_storyboard_not_used_for_t2v(self):
        # t2v 段不拿分镜关键帧当首帧（执行时也不带参考）
        self._make_recipe("sbt", {"type": "video_director",
                                  "shared": {"mode": "t2v", "width": 8, "height": 8},
                                  "segments": [{"skill_id": "s", "prompt": "p",
                                                "storyboard": "storyboard_sbt_01.png"}]},
                          assets=["storyboard_sbt_01.png"])
        seg = recipes.load_director_spec("sbt")["segments"][0]
        self.assertIsNone(seg["ref_input"])

    def test_load_spec_storyboard_not_used_when_first_frame_set(self):
        # 段自己设了首帧：优先首帧，分镜关键帧不覆盖
        self._make_recipe("sb2", {"type": "video_director",
                                  "shared": {"mode": "i2v", "width": 8, "height": 8},
                                  "segments": [{"skill_id": "s", "prompt": "p",
                                                "first_frame": "own.png",
                                                "storyboard": "storyboard_sb2_01.png"}]},
                           assets=["own.png", "storyboard_sb2_01.png"])
        seg = recipes.load_director_spec("sb2")["segments"][0]
        self.assertEqual(seg["ref_input"], "own.png")

    def test_load_spec_infers_l2v_from_last_frame(self):
        # 旧配方无 mode：只挂尾帧识别为 L2VA（尾帧生视频）
        self._make_recipe("f", {"type": "video_director", "shared": {"width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p", "last_frame": "z.png"}]},
                         assets=["z.png"])
        self.assertEqual(recipes.load_director_spec("f")["segments"][0]["mode"], "l2v")

    def test_new_modes_kept_by_normalize(self):
        # 新段级模式（fl2v/r2v）与 last_frame 都要保留
        shared, segs = recipes._normalize_director(
            {"shared": {"mode": "fl2v"},
             "segments": [{"prompt": "x", "skill_id": "s", "mode": "r2v", "last_frame": "z.png"}]},
            {"z.png": "z.png"})
        self.assertEqual(shared["mode"], "fl2v")
        self.assertEqual(segs[0]["mode"], "r2v")
        self.assertEqual(segs[0]["last_frame"], "z.png")

    def test_load_spec_without_refs_has_empty_refs(self):
        self._make_recipe("r", {"type": "video_director",
                                "shared": {"mode": "t2v", "width": 8, "height": 8},
                                "segments": [{"skill_id": "s", "prompt": "p"}]})
        self.assertEqual(recipes.load_director_spec("r")["segments"][0]["refs"], {})

    def test_load_spec_rejects_flat_recipe(self):
        self._make_recipe("flat", {"prompt": "p"})
        with self.assertRaises(ValueError):
            recipes.load_director_spec("flat")

    def test_save_route_persists_director(self):
        payload = {"name": "saved-dir", "type": "video_director",
                   "shared": {"width": 8, "height": 8, "seed": 3},
                   "segments": [{"skill_id": "s", "prompt": "p", "duration_sec": 5}]}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200)
        with open(os.path.join(self.custom, "saved-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["type"], "video_director")
        self.assertEqual(saved["segments"][0]["skill_id"], "s")

    def test_save_route_rejects_bad_director(self):
        payload = {"name": "bad-dir", "type": "video_director",
                   "shared": {}, "segments": []}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 400)

    def test_resave_director_with_stored_first_frame(self):
        # 回归：首次保存后 first_frame 被回写为落盘最终名；二次保存时前端只重传
        # 当前连线的原始素材（甚至不再重传该图），引用已落盘名字不应报「未保存的资产」，
        # 且旧资产仍保留在 recipe.json 的 assets 清单里。
        self._make_recipe("resave-dir", {
            "type": "video_director",
            "shared": {"width": 8, "height": 8, "seed": 0},
            "assets": ["f.png"],
            "segments": [{"skill_id": "s", "prompt": "p", "first_frame": "f.png"}],
        }, assets=["f.png"])

        payload = {"name": "resave-dir", "type": "video_director",
                   "shared": {"width": 8, "height": 8},
                   "assets": [],   # 二次保存未重传素材
                   "segments": [{"skill_id": "s", "prompt": "p2", "first_frame": "f.png"}]}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"二次保存被误拒：{resp.body}")
        with open(os.path.join(self.custom, "resave-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["segments"][0]["first_frame"], "f.png")
        self.assertIn("f.png", saved["assets"], "未重传的既有资产应保留在清单")

    def test_story_saved_and_returned_on_reopen(self):
        # 自动故事板内容随配方落盘，重新打开（扫描 recipe.json）时带回给编辑器回显
        payload = {"name": "story-dir", "type": "video_director",
                   "shared": {"width": 8, "height": 8, "seed": 3},
                   "segments": [{"skill_id": "s", "prompt": "p", "duration_sec": 5}],
                   "story": {"idea": "主题", "story": "正文", "characters": [],
                             "segment_seconds": 10}}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"保存失败：{resp.body}")

        import pathlib
        scanned = recipes._scan_recipe_dir(pathlib.Path(self.custom) / "story-dir", "custom")
        self.assertEqual(scanned["story"]["story"], "正文")
        self.assertEqual(scanned["story"]["segment_seconds"], 10)

    def test_setup_saved_and_returned_on_reopen(self):
        # 统一设置区状态随配方落盘，重新打开（扫描 recipe.json）时带回给编辑器回显
        self._make_recipe("setup-dir", {"type": "video_director", "shared": {},
                                        "segments": [{"skill_id": "s", "prompt": "p"}],
                                        "assets": ["a.png", "f.png"]},
                          assets=["a.png", "f.png"])
        payload = {"name": "setup-dir", "type": "video_director", "shared": {},
                   "segments": [{"skill_id": "s", "prompt": "p", "duration_sec": 5}],
                   "setup": {"refs": {"images": ["a.png"]}, "first_frame": "f.png"}}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"保存失败：{resp.body}")

        with open(os.path.join(self.custom, "setup-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["setup"]["refs"]["images"], ["a.png"])
        self.assertEqual(saved["setup"]["first_frame"], "f.png")

        import pathlib
        scanned = recipes._scan_recipe_dir(pathlib.Path(self.custom) / "setup-dir", "custom")
        self.assertEqual(scanned["setup"]["first_frame"], "f.png")
        self.assertEqual(scanned["setup"]["refs"]["images"], ["a.png"])

    def test_director_without_setup_has_no_setup_key(self):
        # 统一区为空时不写 setup 键，旧配方重存也不该凭空多出
        self._make_recipe("nosetup-dir", {"type": "video_director", "shared": {},
                                          "segments": [{"skill_id": "s", "prompt": "p"}]})
        payload = {"name": "nosetup-dir", "type": "video_director", "shared": {},
                   "segments": [{"skill_id": "s", "prompt": "p"}],
                   "setup": {"refs": {}}}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"保存失败：{resp.body}")
        with open(os.path.join(self.custom, "nosetup-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertNotIn("setup", saved)

        import pathlib
        scanned = recipes._scan_recipe_dir(pathlib.Path(self.custom) / "nosetup-dir", "custom")
        self.assertNotIn("setup", scanned)

    def test_director_without_story_has_no_story_key(self):
        # 旧配方（保存时没有故事板内容）不该凭空多出 story 键
        self._make_recipe("nostory-dir", {"type": "video_director", "shared": {},
                                          "segments": [{"skill_id": "s", "prompt": "p"}]})
        payload = {"name": "nostory-dir", "type": "video_director", "shared": {},
                   "segments": [{"skill_id": "s", "prompt": "p"}],
                   "story": {"idea": None, "story": None, "characters": [],
                             "segment_seconds": None}}

        class _Req:
            async def json(self):
                return payload

        resp = _run_async(recipes.rs_recipes_save(_Req()))
        self.assertEqual(resp.status, 200, f"保存失败：{resp.body}")
        with open(os.path.join(self.custom, "nostory-dir", "recipe.json"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertNotIn("story", saved)

        import pathlib
        scanned = recipes._scan_recipe_dir(pathlib.Path(self.custom) / "nostory-dir", "custom")
        self.assertNotIn("story", scanned)

    def test_copy_route_creates_new_custom_recipe(self):
        # 复制配方：整目录复制到 custom，recipe.json 的 name 改写为新名，资源一并复制
        self._make_recipe("src", {"prompt": "p", "assets": ["f.png"]}, assets=["f.png"])

        class _Req:
            async def json(self):
                return {"name": "src"}

        resp = _run_async(recipes.rs_recipes_copy(_Req()))
        self.assertEqual(resp.status, 200)
        data = json.loads(resp.body)
        self.assertTrue(data["success"])
        self.assertEqual(data["name"], "src-copy")
        with open(os.path.join(self.custom, "src-copy", "recipe.json"), encoding="utf-8") as f:
            copied = json.load(f)
        self.assertEqual(copied["name"], "src-copy")
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "src-copy", "assets", "f.png")))

    def test_copy_route_increments_on_conflict(self):
        # 目标名冲突时自动加 -2/-3：已存在 src-copy → 复制得到 src-2
        self._make_recipe("src", {"prompt": "p"})
        self._make_recipe("src-copy", {"prompt": "q"})

        class _Req:
            async def json(self):
                return {"name": "src"}

        resp = _run_async(recipes.rs_recipes_copy(_Req()))
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.body)["name"], "src-2")

    def test_copy_route_copies_preset_to_custom(self):
        # preset 只读不可删，但可复制成 custom（副本落在 custom/）
        d = os.path.join(self.presets, "pre")
        os.makedirs(os.path.join(d, "assets"), exist_ok=True)
        with open(os.path.join(d, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump({"prompt": "preset-p"}, f)

        class _Req:
            async def json(self):
                return {"name": "pre"}

        resp = _run_async(recipes.rs_recipes_copy(_Req()))
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.body)["name"], "pre-copy")
        self.assertTrue(os.path.isfile(os.path.join(self.custom, "pre-copy", "recipe.json")))

    def test_copy_route_missing_source_404(self):
        class _Req:
            async def json(self):
                return {"name": "nope"}

        resp = _run_async(recipes.rs_recipes_copy(_Req()))
        self.assertEqual(resp.status, 404)


# ===========================================================================
# P2：director 编排（帧拼接 / 边界丢帧 / seed 派生 / 音频对齐）
# ===========================================================================
class _FakeComp:
    def __init__(self, images, audio):
        self.images = images
        self.audio = audio


class _FakeVideo:
    """get_components() 返回 n_frames 帧 + 每帧 samples_per_frame 采样的音频。"""

    def __init__(self, n_frames, frame_rate=24, sample_rate=48000):
        self._images = torch.rand(n_frames, 8, 8, 3)
        spf = sample_rate // frame_rate
        self._audio = {"waveform": torch.zeros(1, 1, n_frames * spf), "sample_rate": sample_rate}

    def get_components(self):
        return _FakeComp(self._images, self._audio)


class SegmentSelectionTests(unittest.TestCase):
    """「仅运行勾选的段」：段号解析（parse_segment_selection）+ 节点输入暴露。"""

    def test_empty_text_means_all_segments(self):
        self.assertIsNone(h3_video_director.parse_segment_selection("", 3))
        self.assertIsNone(h3_video_director.parse_segment_selection("   ", 3))
        self.assertIsNone(h3_video_director.parse_segment_selection(None, 3))

    def test_mixed_separators_dedupe_and_sort(self):
        self.assertEqual(h3_video_director.parse_segment_selection("3,1", 3), [0, 2])
        self.assertEqual(h3_video_director.parse_segment_selection("1 2，3、2", 3), [0, 1, 2])

    def test_out_of_range_raises(self):
        with self.assertRaises(ValueError) as ctx:
            h3_video_director.parse_segment_selection("0", 3)
        self.assertIn("段号越界：第 0 段（配方共 3 段）", str(ctx.exception))
        with self.assertRaises(ValueError):
            h3_video_director.parse_segment_selection("4", 3)

    def test_non_numeric_raises(self):
        with self.assertRaises(ValueError) as ctx:
            h3_video_director.parse_segment_selection("1,x", 3)
        self.assertIn("只接受段号", str(ctx.exception))

    def test_input_types_exposes_only_segments_widget(self):
        opt = h3_video_director.NeoH3VideoDirector.INPUT_TYPES()["optional"]
        self.assertIn("only_segments", opt)
        self.assertEqual(opt["only_segments"][0], "STRING")
        self.assertEqual(opt["only_segments"][1]["default"], "")
        self.assertNotIn("forceInput", opt["only_segments"][1])   # 是 widget（非连线槽），仅隐藏显示


class DirectorOrchestrationTests(unittest.TestCase):
    SR = 48000
    FPS = 24
    SPF = SR // FPS   # 2000 samples/frame

    def _patch(self, n_segments, frame_counts, seed_base=100, mode=None, panel=False):
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        bodies = []
        it = iter(_FakeVideo(n, self.FPS, self.SR) for n in frame_counts)

        def _fake_exec(graph, output_type="IMAGE", **kw):
            return next(it)

        # i2v 段首段需自带首帧才能通过执行校验，给占位 ref_input；其余段靠连续性链入（t2v 段不带任何参考）。
        # panel=True：每段自带分镜首帧（走「分镜首帧」路径）。
        segments = [{"skill_id": f"s{i}", "prompt": f"p{i}", "duration_sec": 5, "mode": mode,
                     "ref_input": f"panel{i}.png" if panel
                     else ("ff.png" if (mode == "i2v" and i == 0) else None)} for i in range(n_segments)]
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": seed_base, "chunk_sec": 0},
                                               "segments": segments}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg, **kw):
            bodies.append(dict(body))
            return {"prompt": body["prompt"]}

        h3d.resolve_video_params = _fake_resolve
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = _fake_exec
        return orig, bodies

    def test_continuity_on_drops_boundary_frames(self):
        # context_frames=0：退回 Tier A（上段尾帧当首帧 + 丢边界帧）
        orig, bodies = self._patch(3, [124, 124, 124], mode="i2v")
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True, context_frames=0)
        finally:
            self._restore(orig)
        comp = video.get_components()
        # 124 + (124-1) + (124-1) = 370
        self.assertEqual(comp.images.shape[0], 124 + 123 + 123)
        self.assertEqual([b["seed"] for b in bodies], [100, 101, 102])

    def test_continuity_off_keeps_all_frames(self):
        orig, _ = self._patch(3, [124, 124, 124])
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        comp = video.get_components()
        self.assertEqual(comp.images.shape[0], 124 * 3)

    def test_seed_override_beats_shared(self):
        orig, bodies = self._patch(2, [100, 100], seed_base=100)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", seed=500, continuity=False)
        finally:
            self._restore(orig)
        self.assertEqual([b["seed"] for b in bodies], [500, 501])

    def test_shared_seed_minus_one_draws_random_per_run(self):
        # 配方 shared.seed = -1：每次运行现取种子；同一次运行内各段仍按 base + 原始段序号派生
        # （_patch 的帧桩是一次性迭代器，两次运行各起一套桩）
        orig, bodies = self._patch(2, [100, 100], seed_base=-1)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
            first = [b["seed"] for b in bodies]
        finally:
            self._restore(orig)
        orig, bodies = self._patch(2, [100, 100], seed_base=-1)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
            second = [b["seed"] for b in bodies]
        finally:
            self._restore(orig)
        self.assertEqual(first[1] - first[0], 1, "段种子 = 本种子 + 原始段序号")
        self.assertTrue(all(s >= 0 for s in first + second))
        self.assertNotEqual(first, second, "两次运行应换种子")

    def test_audio_trimmed_to_match_dropped_frames(self):
        orig, _ = self._patch(3, [124, 124, 124], mode="i2v")
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True, context_frames=0)
        finally:
            self._restore(orig)
        comp = video.get_components()
        # 帧数 370 → 音频应恰好 370 * SPF 采样（A/V 对齐）
        self.assertEqual(comp.images.shape[0], 370)
        self.assertEqual(comp.audio["waveform"].shape[-1], 370 * self.SPF)

    def test_panel_first_segments_do_not_chain_in_tier_a(self):
        # 每段自带分镜首帧：Tier A 下不链入上段尾帧、不丢帧（段首就是各自的分镜图）
        orig, bodies = self._patch(3, [124, 124, 124], mode="i2v", panel=True)
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True, context_frames=0)
        finally:
            self._restore(orig)
        self.assertEqual([b["references"][0] for b in bodies],
                         [{"kind": "input", "value": f"panel{i}.png"} for i in range(3)])
        self.assertEqual(video.get_components().images.shape[0], 124 * 3)

    def test_concat_audio_none_when_no_audio(self):
        out = h3_video_director._concat_segment_audio([None, None], self.FPS, [0, 1])
        self.assertIsNone(out)

    def test_t2v_continuity_keeps_all_frames(self):
        # T2V 段在 Tier A（context_frames=0）下不带参考图、也不链入上段尾帧 → 全帧拼接
        orig, _ = self._patch(3, [124, 124, 124])   # mode=None → t2v
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=True, context_frames=0)
        finally:
            self._restore(orig)
        comp = video.get_components()
        self.assertEqual(comp.images.shape[0], 124 * 3)

    def test_ref_attached_only_to_i2v_segments(self):
        # 混合模式：i2v 段携带首帧参考，t2v 段绝不带
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        bodies = []
        it = iter(_FakeVideo(100, self.FPS, self.SR) for _ in range(2))
        segments = [
            {"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "ref_input": "ff.png", "mode": "i2v"},
            {"skill_id": "s1", "prompt": "p1", "duration_sec": 5, "ref_input": None, "mode": "t2v"},
        ]
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": 1, "chunk_sec": 0},
                                               "segments": segments}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg, **kw):
            bodies.append(dict(body))
            return {"prompt": body["prompt"]}

        h3d.resolve_video_params = _fake_resolve
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: next(it)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        self.assertIn("references", bodies[0])
        self.assertEqual(bodies[0]["references"][0]["value"], "ff.png")
        self.assertNotIn("references", bodies[1])

    def test_media_refs_attached_with_type_for_i2v_segment(self):
        # i2v 段：首帧 + 挂的图/视频/音频参考都进 body["references"]，视频/音频带 media 标记
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        bodies = []
        it = iter(_FakeVideo(100, self.FPS, self.SR) for _ in range(1))
        h3d.load_director_spec = lambda name: {
            "shared": {"width": 8, "height": 8, "seed": 1},
            "segments": [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "mode": "i2v",
                          "ref_input": "ff.png",
                          "refs": {"images": ["a.png"], "videos": ["v.mp4"], "audios": ["s.wav"]}}]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: bodies.append(dict(body)) or {"prompt": body["prompt"]}
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: next(it)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        refs = bodies[0]["references"]
        self.assertEqual([r["value"] for r in refs], ["ff.png", "a.png", "v.mp4", "s.wav"])
        self.assertEqual([r.get("media") for r in refs], [None, None, "video", "audio"])

    def test_i2v_without_first_frame_raises(self):
        # 首段 i2v 无自带首帧、无上段可链入 → 明确报错而非静默按 t2v 生成
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        h3d.load_director_spec = lambda name: {
            "shared": {"width": 8, "height": 8, "seed": 1},
            "segments": [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5,
                          "ref_input": None, "mode": "i2v"}]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: {"prompt": body["prompt"]}
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: _FakeVideo(100, self.FPS, self.SR)
        try:
            with self.assertRaises(ValueError):
                h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)

    def test_reports_progress_per_segment_and_resets(self):
        h3d = h3_video_director
        orig, _ = self._patch(3, [100, 100, 100])
        seen = []
        real_exec = h3d.execute_graph_inprocess

        def _recording_exec(graph, output_type="IMAGE", **kw):
            seen.append(dict(h3d._DIRECTOR_PROGRESS))
            return real_exec(graph, output_type, **kw)

        h3d.execute_graph_inprocess = _recording_exec
        # 桩 resolve 返回该段真实步数：on_total 应在每段执行前把 total_steps 上报到进度状态
        h3d.resolve_video_params = lambda body, cfg, **kw: {"prompt": body["prompt"], "steps": 12}
        try:
            h3d.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        # 每段执行时：active、total_segments=3，segment_index 依次 0/1/2，total_steps 为该段真实步数
        self.assertEqual([s["active"] for s in seen], [True, True, True])
        self.assertEqual([s["total_segments"] for s in seen], [3, 3, 3])
        self.assertEqual([s["segment_index"] for s in seen], [0, 1, 2])
        self.assertEqual([s["total_steps"] for s in seen], [12, 12, 12])
        # 结束后复位为 inactive（快照含 prompt_id 键：运行时按执行上下文写入）
        self.assertEqual(h3d.get_director_progress(),
                         {"active": False, "segment_index": -1, "total_segments": 0, "step": 0, "total_steps": 0,
                          "prompt_id": None})

    def _run_single(self, seg, continuity=False):
        """用单个自定义段跑一次 generate；返回 (bodies, 错误文本)。"""
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        bodies = []
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": 1},
                                               "segments": [seg]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: bodies.append(dict(body)) or {"prompt": body.get("prompt", "")}
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: _FakeVideo(100, self.FPS, self.SR)
        err = None
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=continuity)
        except ValueError as e:
            err = str(e)
        finally:
            self._restore(orig)
        return bodies, err

    def test_fl2v_segment_sends_first_and_last_frame(self):
        # 首尾帧段：首帧进 references（模板 {{REF_IMAGE}}），尾帧进 body["last_frame"]（{{REF_IMAGE_LAST}}）
        bodies, err = self._run_single({"skill_id": "s", "prompt": "p", "duration_sec": 5, "mode": "fl2v",
                                        "ref_input": "ff.png", "last_input": "lf.png"})
        self.assertIsNone(err)
        self.assertEqual(bodies[0]["references"], [{"kind": "input", "value": "ff.png"}])
        self.assertEqual(bodies[0]["last_frame"], {"kind": "input", "value": "lf.png"})

    def test_fl2v_segment_without_last_frame_raises(self):
        _, err = self._run_single({"skill_id": "s", "prompt": "p", "duration_sec": 5, "mode": "fl2v",
                                   "ref_input": "ff.png"})
        self.assertIn("尾帧", err or "")

    def test_r2v_segment_attaches_refs_without_first_frame(self):
        # 全参考段：只挂参考素材即可，不需要首帧；第一个参考视频即源视频（提示词自动加 <Video 1>）
        bodies, err = self._run_single({"skill_id": "s", "prompt": "p", "duration_sec": 5, "mode": "r2v",
                                        "ref_input": None,
                                        "refs": {"images": ["a.png"], "videos": ["v.mp4"], "audios": ["s.wav"]}})
        self.assertIsNone(err)
        self.assertEqual([(r["value"], r.get("media")) for r in bodies[0]["references"]],
                         [("a.png", None), ("v.mp4", "video"), ("s.wav", "audio")])
        self.assertEqual(bodies[0]["prompt"], "<Video 1> p")
        self.assertNotIn("last_frame", bodies[0])

    def test_r2v_prompt_keeps_existing_video_tag(self):
        # 提示词已含 <Video 1> 时不重复添加
        bodies, err = self._run_single({"skill_id": "s", "prompt": "<Video 1> p", "duration_sec": 5, "mode": "r2v",
                                        "ref_input": None, "refs": {"videos": ["v.mp4"]}})
        self.assertIsNone(err)
        self.assertEqual(bodies[0]["prompt"], "<Video 1> p")

    def test_r2v_segment_without_refs_runs_as_t2v(self):
        # 全参考段无参考素材：按文生执行（不硬报错，编辑器保存时已提示）
        bodies, err = self._run_single({"skill_id": "s", "prompt": "p", "duration_sec": 5, "mode": "r2v"})
        self.assertIsNone(err)
        self.assertNotIn("references", bodies[0])

    def _r2v_template(self):
        """H3 r2v 形状的最小模板图（含可注入模型的 KSampler）。"""
        return {
            "1": {"class_type": "VAELoader", "inputs": {"vae_name": "v.safetensors"}},
            "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "u.safetensors"}},
            "5": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "clip": ["3", 0], "vae": ["1", 0], "prompt": "p", "length": 124}},
            "6": {"class_type": "KSampler", "inputs": {
                "model": ["2", 0], "positive": ["5", 0], "negative": ["5", 0],
                "latent_image": ["5", 1]}},
        }

    def _run_r2v_chain(self, continuity=True, context_frames=22, frame_counts=(124, 141, 141), mode="r2v",
                       duration_sec=-1, identity_images=None, panels=False, params_sink=None):
        """三段配方跑一次（模板用 r2v 形状）；返回 ([(graph, overrides), ...], [各段 body], [各段 _FakeVideo], 输出 VIDEO)。

        第 1 段自带 a.png/b.png（身份来源）、第 2 段带 c.png、第 3 段带 a.png（用于验证身份去重）；
        identity_images 模拟配方「角色参考图」（load_director_spec 的 spec 级身份参考）。
        panels=True 时每段自带首帧图（ref_input=panelN.png）→ 走「分镜首帧」路径；
        params_sink 给了就把各段的模板参数收集进去（用于断言时长有没有被窗口撑长）。
        """
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        calls, bodies = [], []
        videos = [_FakeVideo(n, self.FPS, self.SR) for n in frame_counts]
        it = iter(videos)
        own = (["a.png", "b.png"], ["c.png"], ["a.png"])
        spec = {
            "shared": {"width": 8, "height": 8, "seed": 1},
            "segments": [{"skill_id": f"s{i}", "prompt": f"p{i}", "duration_sec": 5, "mode": mode,
                          "ref_input": f"panel{i}.png" if panels else ("ff.png" if (mode == "i2v" and i == 0) else None),
                          "refs": {"images": own[i]}} for i in range(len(frame_counts))]}
        if identity_images:
            spec["identity_images"] = list(identity_images)
        h3d.load_director_spec = lambda name: spec
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        def _resolve(body, cfg, **kw):
            bodies.append(dict(body))
            params = {"prompt": body["prompt"], "length": int(body.get("length") or 124)}
            if params_sink is not None:
                params_sink.append(params)
            return params

        h3d.resolve_video_params = _resolve
        h3d.render_template = lambda tpl, params: (self._r2v_template(), [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: calls.append(
            (graph, kw.get("overrides"))) or next(it)
        try:
            (out,) = h3_video_director.NeoH3VideoDirector().generate(
                "r", continuity=continuity, context_frames=context_frames, duration_sec=duration_sec)
        finally:
            self._restore(orig)
        return calls, bodies, videos, out

    def test_context_window_chains_via_injected_nodes(self):
        """跨段上下文窗口：第 2/3 段注入「身份图 + 上段尾部 22 帧」，采样器改由注入链供模型与 conditioning。"""
        calls, _, videos, _ = self._run_r2v_chain()
        self.assertNotIn("NeoH3AddContext", [n.get("class_type") for n in calls[0][0].values()])
        graph, overrides = calls[1]
        nodes = sorted((int(nid), n) for nid, n in graph.items()
                       if n.get("class_type") == "NeoH3AddContext")
        self.assertEqual(len(nodes), 3)                       # a.png + b.png + 上下文窗口
        names = [graph[n["inputs"]["identity_image"][0]]["inputs"]["image"] for _, n in nodes[:2]]
        self.assertEqual(names, ["a.png", "b.png"])
        tail_id = nodes[2][1]["inputs"]["context_image"][0]
        self.assertTrue(torch.equal(overrides[tail_id][0], videos[0]._images[-22:]))
        self.assertEqual(graph["6"]["inputs"]["model"], [str(nodes[2][0]), 0])
        self.assertEqual(graph["6"]["inputs"]["positive"], [str(nodes[2][0]), 1])
        self.assertEqual(graph["6"]["inputs"]["negative"], [str(nodes[2][0]), 1])
        self.assertEqual(graph["6"]["inputs"]["latent_image"], ["5", 1])
        self.assertEqual(nodes[2][1]["inputs"]["context_frames"], 22)
        # 第 3 段已自带 a.png → 只继承 b.png
        third = sorted((int(nid), n) for nid, n in calls[2][0].items()
                       if n.get("class_type") == "NeoH3AddContext")
        self.assertEqual(len(third), 2)
        self.assertEqual(calls[2][0][third[0][1]["inputs"]["identity_image"][0]]["inputs"]["image"], "b.png")

    def test_node_duration_sec_ignored_in_recipe_mode(self):
        """节点上的 duration_sec 只服务 BUNDLE 单段：配方多段各段仍用自己的 duration_sec（5s → 124 帧）。"""
        _, bodies, _, _ = self._run_r2v_chain(duration_sec=30)
        self.assertEqual([b["length"] for b in bodies], [h3_video_director._seconds_to_frames(5)] * 3)
        self.assertEqual(bodies[0]["length"], 124)

    def test_context_window_trims_head_frames_and_audio(self):
        """链入段丢掉头部 22 帧（重生成窗口），音频按同样帧数裁掉保 A/V 对齐。"""
        _, _, _, out = self._run_r2v_chain()
        comp = out.get_components()
        # 首段 124；后两段各生成 141（124+22=146 就近对齐）丢头部 22 → 交付 119
        self.assertEqual(comp.images.shape[0], 124 + 119 * 2)
        self.assertEqual(comp.audio["waveform"].shape[-1], (124 + 119 * 2) * self.SPF)

    def test_context_window_trims_tail_of_previous_segment(self):
        """窗口取的是上段「交付帧」的尾部 window 帧（拼接序列里紧邻新段的那一段）。"""
        calls, _, videos, out = self._run_r2v_chain()
        tail_id = next(nid for nid, n in calls[2][0].items()
                       if n.get("class_type") == "LoadImage" and n["inputs"]["image"] == "__neo_context_tail__")
        window = calls[2][1][tail_id][0]
        self.assertTrue(torch.equal(window, videos[1]._images[-22:]))
        # 第 1 段交付 124 帧、第 2 段交付 119 帧 → 总帧数对得上
        self.assertEqual(out.get_components().images.shape[0], 124 + 119 * 2)

    def test_context_window_off_inherits_identity_only(self):
        """context_frames=0：不注入窗口（不丢帧），但身份参考图仍继承（连续性总开关仍然开着）。"""
        calls, _, _, out = self._run_r2v_chain(context_frames=0, frame_counts=(124, 124, 124))
        self.assertEqual(out.get_components().images.shape[0], 124 * 3)
        for graph in (calls[1][0], calls[2][0]):
            nodes = [n for n in graph.values() if n.get("class_type") == "NeoH3AddContext"]
            self.assertTrue(nodes)
            self.assertTrue(all("context_image" not in n["inputs"] for n in nodes))

    def test_continuity_off_skips_injection_entirely(self):
        """continuity 关：既不注入窗口也不继承身份，各段完全独立。"""
        calls, _, _, out = self._run_r2v_chain(continuity=False, frame_counts=(124, 124, 124))
        for graph, overrides in calls:
            self.assertNotIn("NeoH3AddContext", [n.get("class_type") for n in graph.values()])
            self.assertIsNone(overrides)
        self.assertEqual(out.get_components().images.shape[0], 124 * 3)

    def test_i2v_chained_segment_anchors_on_window_first_frame(self):
        """i2v 段有上下文窗口时首帧取窗口第 0 帧（与窗口行同内容），不再用上段尾帧。"""
        _, bodies, videos, _ = self._run_r2v_chain(mode="i2v")
        self.assertEqual(bodies[0]["references"][0]["value"], "ff.png")   # 首段自带首帧
        tail = videos[0]._images[-22:]
        self.assertEqual(bodies[1]["references"][0]["data"],
                         h3_video_director._image_to_data_uri(tail[:1]))
        self.assertEqual(bodies[1]["references"][1]["value"], "c.png")    # 该段自己的素材照旧排在后面

    def test_panel_first_segment_anchors_on_its_own_storyboard(self):
        """i2v 段自带分镜首帧：锚点用它（不再是窗口第 0 帧），不再被连续性顶替。"""
        _, bodies, _, _ = self._run_r2v_chain(mode="i2v", panels=True, frame_counts=(124, 124, 124))
        self.assertEqual([b["references"][0] for b in bodies],
                         [{"kind": "input", "value": f"panel{i}.png"} for i in range(3)])

    def test_panel_first_segment_keeps_length_and_drops_nothing(self):
        """分镜首帧段：目标时长不加窗口（124 而非 141），拼接不丢帧、音频同步不减。"""
        seen = []
        _, _, _, out = self._run_r2v_chain(mode="i2v", panels=True, frame_counts=(124, 124, 124), params_sink=seen)
        self.assertEqual([p["length"] for p in seen], [124] * 3)
        comp = out.get_components()
        self.assertEqual(comp.images.shape[0], 124 * 3)
        self.assertEqual(comp.audio["waveform"].shape[-1], 124 * 3 * self.SPF)

    def test_panel_first_segment_injects_prev_tail_as_reference(self):
        """分镜首帧段仍带上段尾部，但走 reference：不搬时间轴、不做窗口丢弃。"""
        calls, _, videos, _ = self._run_r2v_chain(mode="i2v", panels=True, frame_counts=(124, 124, 124))
        graph, overrides = calls[1]
        nodes = sorted((int(nid), n) for nid, n in graph.items() if n.get("class_type") == "NeoH3AddContext")
        context = [n for _, n in nodes if "context_image" in n["inputs"]]
        self.assertEqual(len(context), 1)
        self.assertEqual(context[0]["inputs"]["context_mode"], "reference")
        self.assertEqual(context[0]["inputs"]["context_frames"], 22)
        tail_id = context[0]["inputs"]["context_image"][0]
        self.assertTrue(torch.equal(overrides[tail_id][0], videos[0]._images[-22:]))

    def test_identity_names_put_recipe_characters_first_then_segment_refs(self):
        """身份来源：配方角色参考图在前，段自带参考补齐；重复的只留一份。"""
        segs = [{"refs": {"images": ["a.png", "char.png"]}}]
        spec = {"identity_images": ["char.png"], "segments": segs}
        self.assertEqual(h3_video_director._identity_names(spec, segs), ["char.png", "a.png"])

    def test_identity_names_capped_at_four(self):
        segs = [{"refs": {"images": [f"r{i}.png" for i in range(6)]}}]
        spec = {"identity_images": ["c1.png", "c2.png", "c3.png"], "segments": segs}
        self.assertEqual(h3_video_director._identity_names(spec, segs),
                         ["c1.png", "c2.png", "c3.png", "r0.png"])

    def test_recipe_character_refs_anchor_first_segment(self):
        """配方角色参考图独立于段自带参考：首段只有首帧（分镜关键帧看不到脸）时也注入身份参考。"""
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        graphs = []
        segments = [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5,
                     "ref_input": "sb01.png", "mode": "i2v"}]
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": 1},
                                               "identity_images": ["char.png"], "segments": segments}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: {"prompt": body["prompt"]}
        h3d.render_template = lambda tpl, params: (self._r2v_template(), [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: graphs.append(graph) or _FakeVideo(
            124, self.FPS, self.SR)
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=True, context_frames=0)
        finally:
            self._restore(orig)
        nodes = [n for n in graphs[0].values() if n.get("class_type") == "NeoH3AddContext"]
        self.assertEqual([graphs[0][n["inputs"]["identity_image"][0]]["inputs"]["image"] for n in nodes],
                         ["char.png"])
        self.assertTrue(all("context_image" not in n["inputs"] for n in nodes))   # context_frames=0：只注入身份

    def test_recipe_identity_images_injected_into_every_segment(self):
        """配方角色参考图注入每一个段（含首段）；段自己已经送出的参考不重复注入。"""
        calls, _, _, _ = self._run_r2v_chain(identity_images=["char.png"], context_frames=0,
                                             frame_counts=(124, 124, 124))
        injected = []
        for graph, _ in calls:
            nodes = [n for n in graph.values() if n.get("class_type") == "NeoH3AddContext"]
            injected.append([graph[n["inputs"]["identity_image"][0]]["inputs"]["image"] for n in nodes])
        # 首段：自己的 a.png/b.png 已由 references 送出，只补配方角色参考图（不重复注入）
        self.assertEqual(injected[0], ["char.png"])
        # 后续段：配方角色参考图仍在前（作为身份第一来源），再补齐首个带参考素材的段的图
        self.assertEqual(injected[1], ["char.png", "a.png", "b.png"])

    def test_i2v_tier_a_still_chains_prev_tail_as_first_frame(self):
        """context_frames=0 时 i2v 段仍是 Tier A：上段尾帧当首帧链入（data URI）。"""
        _, bodies, videos, _ = self._run_r2v_chain(mode="i2v", context_frames=0, frame_counts=(124, 124, 124))
        self.assertEqual(bodies[1]["references"][0]["data"],
                         h3_video_director._image_to_data_uri(videos[0]._images[-1:]))

    # ---- 仅运行勾选的段：只生成选中的段（跳过段不出现也不占帧），seed / 文案仍按原始段序号 ----

    def test_only_segments_runs_selected_subset_in_recipe_order(self):
        orig, bodies = self._patch(4, [124, 124], seed_base=100)
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False, only_segments="2,4")
        finally:
            self._restore(orig)
        self.assertEqual([b["prompt"] for b in bodies], ["p1", "p3"])       # 只跑第 2 / 4 段，顺序按配方
        self.assertEqual([b["seed"] for b in bodies], [101, 103])            # seed 用原始段序号（与整片运行一致）
        self.assertEqual(video.get_components().images.shape[0], 124 * 2)    # 跳过段不占帧

    def test_only_segments_empty_runs_all(self):
        orig, bodies = self._patch(3, [124, 124, 124], seed_base=100)
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False, only_segments="")
        finally:
            self._restore(orig)
        self.assertEqual([b["prompt"] for b in bodies], ["p0", "p1", "p2"])
        self.assertEqual(video.get_components().images.shape[0], 124 * 3)

    def test_only_segments_out_of_range_raises(self):
        orig, bodies = self._patch(2, [124])
        try:
            with self.assertRaises(ValueError) as ctx:
                h3_video_director.NeoH3VideoDirector().generate("r", only_segments="3")
        finally:
            self._restore(orig)
        self.assertIn("段号越界：第 3 段（配方共 2 段）", str(ctx.exception))
        self.assertEqual(bodies, [])   # 未进入执行链

    def test_only_segments_rejects_non_numeric(self):
        orig, _ = self._patch(2, [124])
        try:
            with self.assertRaises(ValueError) as ctx:
                h3_video_director.NeoH3VideoDirector().generate("r", only_segments="1,a")
        finally:
            self._restore(orig)
        self.assertIn("只接受段号", str(ctx.exception))

    def _restore(self, orig):
        (h3_video_director.load_director_spec, h3_video_director._resolve_skill_id,
         h3_video_director.load_skill_workflow, h3_video_director.get_skill_gen_config,
         h3_video_director.resolve_video_params, h3_video_director.render_template,
         h3_video_director.execute_graph_inprocess, h3_video_director._require_vdn_plugin) = orig


# ===========================================================================
# 多帧单次分块：_plan_chunks / _plan_multiframe_guides / 提示词合并 / 单元执行编排
# ===========================================================================
class ChunkPlanTests(unittest.TestCase):
    def seg(self, i, dur=5, mode="t2v", **kw):
        s = {"skill_id": f"s{i}", "prompt": f"p{i}", "duration_sec": dur, "mode": mode}
        s.update(kw)
        return s

    def kinds(self, segs, budget):
        return [u["kind"] for u in h3_video_director._plan_chunks(segs, budget)]

    def setUp(self):
        self._orig_mf = h3_video_director.is_multiframe_skill
        h3_video_director.is_multiframe_skill = lambda v: bool(v)   # 测试段 skill_id 一律视为多帧技能

    def tearDown(self):
        h3_video_director.is_multiframe_skill = self._orig_mf

    def test_disabled_all_legacy(self):
        self.assertEqual(self.kinds([self.seg(0), self.seg(1)], 0), ["legacy", "legacy"])

    def test_compatible_merged_within_budget(self):
        units = h3_video_director._plan_chunks([self.seg(0), self.seg(1), self.seg(2)], 15)
        self.assertEqual([u["kind"] for u in units], ["multi"])
        self.assertEqual(len(units[0]["segs"]), 3)

    def test_budget_breaks_chunk(self):
        # 8+8 > 15：各成单元；单段兼容块归 legacy（无锚点可加，多帧模板没有收益）
        self.assertEqual(self.kinds([self.seg(0, 8), self.seg(1, 8)], 15), ["legacy", "legacy"])

    def test_budget_split_multi_and_single(self):
        # 6+6 成块；第三个 6 超预算 → 单段 legacy
        self.assertEqual(self.kinds([self.seg(0, 6), self.seg(1, 6), self.seg(2, 6)], 15), ["multi", "legacy"])

    def test_incompatible_breaks_chain(self):
        # r2v 无参考集（非多帧兼容）夹在 t2v 之间 → 三段各自成块（单段归 legacy）
        segs = [self.seg(0), self.seg(1, mode="r2v"), self.seg(2)]
        self.assertEqual(self.kinds(segs, 15), ["legacy", "legacy", "legacy"])

    def test_r2v_with_video_ref_incompatible(self):
        # r2v 段带参考视频（源视频）→ 与 t2v 的参考签名不同，回退逐段
        segs = [self.seg(0), self.seg(1, mode="r2v", refs={"videos": ["v.mp4"]})]
        self.assertEqual(self.kinds(segs, 15), ["legacy", "legacy"])

    def test_overlong_single_segment_legacy(self):
        self.assertEqual(self.kinds([self.seg(0, 20)], 15), ["legacy"])

    def test_single_segment_without_anchor_stays_legacy(self):
        # 单段无可钉的帧 → legacy（多帧模板没有收益）
        self.assertEqual(self.kinds([self.seg(0)], 15), ["legacy"])

    def test_single_segment_with_anchor_keeps_multi(self):
        # 自带首帧锚点的单段：多帧技能模板不带图片入口，只有多帧路径能把首帧钉在段首 → 不退回 legacy
        self.assertEqual(self.kinds([self.seg(0, keyframe="k.png")], 15), ["multi"])
        self.assertEqual(self.kinds([self.seg(0, mode="i2v", ref_input="f.png")], 15), ["multi"])
        # 关闭合并（chunk_sec=0）同样不丢锚点：仍逐段各跑一次，只是不再合并
        self.assertEqual(self.kinds([self.seg(0, keyframe="k.png")], 0), ["multi"])

    def test_single_segment_with_tail_anchor_stays_legacy(self):
        # 只带尾帧的段保持逐段：逐段路径走窗口连续性、帧数与成片对得上；尾帧锚点只在多帧块内注入
        self.assertEqual(self.kinds([self.seg(0, mode="l2v", last_input="t.png")], 15), ["legacy"])

    def test_single_segment_with_ref_material_stays_legacy(self):
        # 带自带参考素材的段按技能说明退回逐段执行（这类段不进多帧路径），即使还带首帧锚点
        segs = [self.seg(0, mode="r2v", refs={"images": ["a.png"]}, keyframe="k.png")]
        self.assertEqual(self.kinds(segs, 15), ["legacy"])

    def test_non_multiframe_single_anchor_stays_legacy(self):
        # 非多帧技能（模板自带图片入口）不需要关键帧锚点 → 仍归 legacy
        orig = h3_video_director.is_multiframe_skill
        h3_video_director.is_multiframe_skill = lambda v: False
        try:
            self.assertEqual(self.kinds([self.seg(0, keyframe="k.png")], 15), ["legacy"])
            self.assertEqual(self.kinds([self.seg(0, keyframe="k.png")], 0), ["legacy"])
        finally:
            h3_video_director.is_multiframe_skill = orig

    def test_missing_duration_defaults_five(self):
        units = h3_video_director._plan_chunks([self.seg(0, None), self.seg(1, None)], 10)
        self.assertEqual([u["kind"] for u in units], ["multi"])

    def test_chunk_budget_default(self):
        # chunk_sec 缺省 15
        self.assertEqual(h3_video_director._chunk_budget({}), 15.0)
        self.assertEqual(h3_video_director._chunk_budget({"chunk_sec": 8}), 8.0)

    def test_chunk_budget_zero_disables(self):
        # chunk_sec=0 → 预算 0（纯逐段生成）
        self.assertEqual(h3_video_director._chunk_budget({"chunk_sec": 0}), 0.0)

    def test_chunk_budget_zero_yields_all_legacy(self):
        segs = [self.seg(0), self.seg(1), self.seg(2)]
        budget = h3_video_director._chunk_budget({"chunk_sec": 0})
        self.assertEqual(self.kinds(segs, budget), ["legacy", "legacy", "legacy"])

    def test_chunk_budget_merges_compatible(self):
        # 连续兼容段（选中多帧技能）按预算合并成一次多帧单次块
        segs = [self.seg(0), self.seg(1), self.seg(2)]
        budget = h3_video_director._chunk_budget({"chunk_sec": 15})
        self.assertEqual(self.kinds(segs, budget), ["multi"])

    def test_non_multiframe_skill_stays_per_segment(self):
        # 未选中多帧技能 → 即便模式/预算都满足也逐段（不合并）
        orig = h3_video_director.is_multiframe_skill
        h3_video_director.is_multiframe_skill = lambda v: False
        try:
            segs = [self.seg(0), self.seg(1), self.seg(2)]
            self.assertEqual(self.kinds(segs, 15), ["legacy", "legacy", "legacy"])
        finally:
            h3_video_director.is_multiframe_skill = orig

    def test_r2v_identical_refs_merge(self):
        # r2v 各段参考集完全一致（含顺序）→ 合并成一次多帧单次，<Picture N> 编号整块一致
        segs = [self.seg(0, mode="r2v", refs={"images": ["a.png", "b.png"]}),
                self.seg(1, mode="r2v", refs={"images": ["a.png", "b.png"]})]
        units = h3_video_director._plan_chunks(segs, 15)
        self.assertEqual([u["kind"] for u in units], ["multi"])
        self.assertEqual(len(units[0]["segs"]), 2)

    def test_r2v_mismatched_refs_fallback(self):
        # r2v 参考集不同 → 无法统一 <Picture N>，回退逐段
        segs = [self.seg(0, mode="r2v", refs={"images": ["a.png"]}),
                self.seg(1, mode="r2v", refs={"images": ["b.png"]})]
        self.assertEqual(self.kinds(segs, 15), ["legacy", "legacy"])

    def test_r2v_ref_order_matters(self):
        # 参考图顺序不同（编号会错位）→ 视为不一致，回退逐段
        segs = [self.seg(0, mode="r2v", refs={"images": ["a.png", "b.png"]}),
                self.seg(1, mode="r2v", refs={"images": ["b.png", "a.png"]})]
        self.assertEqual(self.kinds(segs, 15), ["legacy", "legacy"])

    def test_r2v_video_ref_mismatch_fallback(self):
        # r2v 参考视频（源视频）不同 → 无法统一，回退逐段
        segs = [self.seg(0, mode="r2v", refs={"videos": ["a.mp4"]}),
                self.seg(1, mode="r2v", refs={"videos": ["b.mp4"]})]
        self.assertEqual(self.kinds(segs, 15), ["legacy", "legacy"])

    def test_r2v_without_refs_incompatible(self):
        # r2v 无参考集（退化态，无可共享）→ 不合并，回退逐段
        segs = [self.seg(0, mode="r2v"), self.seg(1, mode="r2v")]
        self.assertEqual(self.kinds(segs, 15), ["legacy", "legacy"])

    def test_r2v_mixed_media_refs_merge_when_identical(self):
        # 图/视频/音频混合参考，各段完全一致 → 合并
        r = {"images": ["a.png"], "videos": ["v.mp4"], "audios": ["x.wav"]}
        segs = [self.seg(0, mode="r2v", refs={k: list(v) for k, v in r.items()}),
                self.seg(1, mode="r2v", refs={k: list(v) for k, v in r.items()})]
        units = h3_video_director._plan_chunks(segs, 15)
        self.assertEqual([u["kind"] for u in units], ["multi"])

    def test_r2v_between_t2v_breaks_chain(self):
        # r2v（有参考）夹在 t2v 之间 → 参考签名与两侧都不同，三段各自成块（单段归 legacy）
        segs = [self.seg(0), self.seg(1, mode="r2v", refs={"images": ["a.png"]}), self.seg(2)]
        self.assertEqual(self.kinds(segs, 15), ["legacy", "legacy", "legacy"])

    def test_ref_signature_order_sensitive(self):
        self.assertEqual(h3_video_director._ref_signature({"refs": {"images": ["a", "b"]}}),
                         (("a", "b"), (), ()))
        self.assertNotEqual(h3_video_director._ref_signature({"refs": {"images": ["a", "b"]}}),
                            h3_video_director._ref_signature({"refs": {"images": ["b", "a"]}}))

    def test_segment_references_format(self):
        seg = {"refs": {"images": ["a.png"], "videos": ["v.mp4"], "audios": ["x.wav"]}}
        self.assertEqual(h3_video_director._segment_references(seg), [
            {"kind": "input", "value": "a.png"},
            {"kind": "input", "value": "v.mp4", "media": "video"},
            {"kind": "input", "value": "x.wav", "media": "audio"},
        ])
        self.assertEqual(h3_video_director._segment_references({}), [])


class MultiframeGuideTests(unittest.TestCase):
    def test_cumulative_frame_indices(self):
        segs = [{"duration_sec": 5, "keyframe": "a.png"}, {"duration_sec": 4}]
        guides, skipped = h3_video_director._plan_multiframe_guides(segs, 124)
        self.assertEqual(guides, [{"name": "a.png", "frame_idx": 0}])
        self.assertEqual(skipped, 0)

    def test_fl2v_tail_guide(self):
        segs = [{"duration_sec": 5, "mode": "fl2v", "keyframe": "a.png", "last_input": "b.png"}]
        guides, _ = h3_video_director._plan_multiframe_guides(segs, 124)
        self.assertEqual([(g["name"], g["frame_idx"]) for g in guides], [("a.png", 0), ("b.png", 119)])

    def test_ref_input_fallback(self):
        segs = [{"duration_sec": 5, "ref_input": "c.png"}, {"duration_sec": 5, "keyframe": "d.png"}]
        guides, skipped = h3_video_director._plan_multiframe_guides(segs, 124)
        self.assertEqual([(g["name"], g["frame_idx"]) for g in guides], [("c.png", 0), ("d.png", 120)])
        self.assertEqual(skipped, 0)

    def test_guide_past_budget_skipped(self):
        segs = [{"duration_sec": 5}, {"duration_sec": 5, "keyframe": "d.png"}]
        guides, skipped = h3_video_director._plan_multiframe_guides(segs, 120)
        self.assertEqual(guides, [])
        self.assertEqual(skipped, 1)

    def test_resize_guide_aligns_to_canvas(self):
        # 关键帧图缩放到目标画布（latent×16），保证编码后与主视频 latent 空间维度一致，避免 patchify 报错
        h3d = h3_video_director
        orig = h3d.comfy.utils.common_upscale
        h3d.comfy.utils.common_upscale = (lambda t, w, h, m="nearest", c="disabled":
                                          torch.nn.functional.interpolate(t, size=(h, w), mode="area"))
        try:
            img = torch.zeros(1, 200, 300, 3)   # [B,H,W,C]，原生分辨率 ≠ 配方画布
            out = h3d._resize_guide(img, 800, 600)   # width=800, height=600
        finally:
            h3d.comfy.utils.common_upscale = orig
        self.assertEqual(tuple(out.shape), (1, 600, 800, 3))


class ChunkPromptMergeTests(unittest.TestCase):
    def test_single_segment_uses_original(self):
        self.assertEqual(h3_video_director._merge_chunk_prompt([{"prompt": "原文", "duration_sec": 5}]), "原文")

    def test_mechanical_merge_preserves_order_and_timestamps(self):
        # 多段确定性机械拼接：[Shot N] + 切点时间戳，无 LLM
        segs = [{"prompt": "a", "duration_sec": 5}, {"prompt": "b", "duration_sec": 4}]
        prompt = h3_video_director._merge_chunk_prompt(segs)
        self.assertIn("[Shot 1] At 00:00.000 cut... a", prompt)
        self.assertIn("[Shot 2] At 00:05.000 cut... b", prompt)


class MultiframeChunkOrchestrationTests(unittest.TestCase):
    SR = 48000
    FPS = 24
    SPF = SR // FPS

    def _patch(self, segments, frame_counts, chunk_sec=15, seed_base=100, template=None):
        import copy as _copy
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.get_skill_gen_config,
                h3d.load_skill_workflow, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin, h3d._merge_chunk_prompt,
                h3d.is_multiframe_skill)
        bodies, graphs = [], []
        it = iter(_FakeVideo(n, self.FPS, self.SR) for n in frame_counts)

        def _fake_exec(graph, output_type="IMAGE", **kw):
            graphs.append(graph)
            return next(it)

        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": seed_base,
                                                          "chunk_sec": chunk_sec}, "segments": segments}
        h3d._resolve_skill_id = lambda v: v
        h3d.get_skill_gen_config = lambda id: {}
        h3d.load_skill_workflow = lambda id: {"1": {}}   # legacy 逐段路径要模板存在
        h3d.is_multiframe_skill = lambda v: bool(v)      # 测试段 skill_id 一律视为多帧技能

        def _fake_resolve(body, cfg, **kw):
            bodies.append(dict(body))
            return {"prompt": body["prompt"]}

        h3d.resolve_video_params = _fake_resolve
        h3d.render_template = lambda tpl, params: (_copy.deepcopy(template or _MULTIFRAME_WF), [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = _fake_exec
        return orig, bodies, graphs

    def _restore(self, orig):
        (h3_video_director.load_director_spec, h3_video_director._resolve_skill_id,
         h3_video_director.get_skill_gen_config, h3_video_director.load_skill_workflow,
         h3_video_director.resolve_video_params, h3_video_director.render_template,
         h3_video_director.execute_graph_inprocess, h3_video_director._require_vdn_plugin,
         h3_video_director._merge_chunk_prompt, h3_video_director.is_multiframe_skill) = orig

    def test_three_t2v_segments_run_once_with_guides(self):
        # 3×5s ≤ 15：一次 ref2va 运行（362 帧），两个关键帧锚点钉在 0 / 120，采样器改指注入节点
        segments = [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "mode": "t2v", "keyframe": "k0.png"},
                    {"skill_id": "s1", "prompt": "p1", "duration_sec": 5, "mode": "t2v", "keyframe": "k1.png"},
                    {"skill_id": "s2", "prompt": "p2", "duration_sec": 5, "mode": "t2v"}]
        orig, bodies, graphs = self._patch(segments, [362])
        h3_video_director._merge_chunk_prompt = lambda segs: "MERGED"
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        self.assertEqual(len(bodies), 1)   # 一次多帧单次运行
        self.assertEqual(bodies[0]["prompt"], "MERGED")
        self.assertEqual(bodies[0]["length"], 362)
        self.assertEqual(bodies[0]["seed"], 100)
        comp = video.get_components()
        self.assertEqual(comp.images.shape[0], 362)   # 不丢帧
        self.assertEqual(comp.audio["waveform"].shape[-1], 362 * self.SPF)
        g = graphs[0]
        guides = {nid: n for nid, n in g.items() if n.get("class_type") == "NeoH3AddGuides"}
        self.assertEqual(len(guides), 1)
        gid, gnode = next(iter(guides.items()))
        gi = gnode["inputs"]
        self.assertEqual(gi["guide_0_frame"], 0)
        self.assertEqual(gi["guide_1_frame"], 120)
        self.assertNotIn("guide_2_image", gi)
        load_names = sorted(n["inputs"]["image"] for n in g.values() if n.get("class_type") == "LoadImage")
        self.assertEqual(load_names, ["k0.png", "k1.png"])
        sampler = next(n for n in g.values() if n.get("class_type") == "KSampler")
        self.assertEqual(sampler["inputs"]["model"], [gid, 0])
        self.assertEqual(sampler["inputs"]["positive"], [gid, 1])
        # 关键帧锚点接目标 AV latent（据此把各段首帧图缩放到配方画布再编码，避免 patchify 报错）
        self.assertEqual(gi["latent"], ["5", 1])

    def test_incompatible_segment_falls_back_to_legacy(self):
        # t2v×2（成块，243 帧）+ r2v（参考集与 t2v 块不一致 → 回退 legacy 逐段，124 帧）：两次执行、不丢帧拼接
        segments = [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "mode": "t2v", "keyframe": "k0.png"},
                    {"skill_id": "s1", "prompt": "p1", "duration_sec": 5, "mode": "t2v"},
                    {"skill_id": "s2", "prompt": "p2", "duration_sec": 5, "mode": "r2v",
                     "refs": {"images": ["a.png"]}}]
        orig, bodies, graphs = self._patch(segments, [243, 124])
        h3_video_director._merge_chunk_prompt = lambda segs: "MERGED"
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0]["prompt"], "MERGED")
        self.assertEqual(bodies[1]["prompt"], "p2")
        comp = video.get_components()
        self.assertEqual(comp.images.shape[0], 243 + 124)
        self.assertEqual(comp.audio["waveform"].shape[-1], (243 + 124) * self.SPF)

    def test_single_i2v_segment_pins_first_frame(self):
        # 单段 i2v + 多帧技能：模板不带图片入口（图只经 minimax_keyframes 注入）→ 单段也走多帧路径，
        # 首帧锚点钉在 0，段首就是用户给的图（此前单段归 legacy，首帧被模板静默丢掉）
        segments = [{"skill_id": "mf", "prompt": "p0", "duration_sec": 5, "mode": "i2v", "ref_input": "f.png"}]
        orig, bodies, graphs = self._patch(segments, [124])
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        self.assertEqual(len(bodies), 1)              # 仍是一次运行（没合并别的段）
        self.assertEqual(bodies[0]["prompt"], "p0")
        self.assertEqual(bodies[0]["length"], 124)    # 与逐段路径同一帧数（5s → 124）
        self.assertEqual(video.get_components().images.shape[0], 124)
        g = graphs[0]
        gnode = next(n for n in g.values() if n.get("class_type") == "NeoH3AddGuides")
        self.assertEqual(gnode["inputs"]["guide_0_frame"], 0)
        load_names = [n["inputs"]["image"] for n in g.values() if n.get("class_type") == "LoadImage"]
        self.assertEqual(load_names, ["f.png"])

    def test_single_i2v_segment_pins_first_frame_on_vdn_template(self):
        # 真实 VDN 多帧模板（「H3 连续多段合成 (VDN)」）：模板同样没有图片入口，首帧锚点照样注入，
        # 采样器的 model 改指锚点节点（模板自带的 VDN 节点仍在链上）
        segments = [{"skill_id": "minimax_h3_vdn_multiframe", "prompt": "p0", "duration_sec": 5,
                     "mode": "i2v", "ref_input": "f.png"}]
        orig, bodies, graphs = self._patch(segments, [124], template=_MULTIFRAME_VDN_WF)
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        self.assertEqual(video.get_components().images.shape[0], 124)
        g = graphs[0]
        gid = next(nid for nid, n in g.items() if n.get("class_type") == "NeoH3AddGuides")
        self.assertEqual(g[gid]["inputs"]["guide_0_frame"], 0)
        self.assertIn(g[gid]["inputs"]["guide_0_image"][0], g)
        self.assertEqual([n["inputs"]["image"] for n in g.values() if n.get("class_type") == "LoadImage"], ["f.png"])
        sampler = next(n for n in g.values() if n.get("class_type") == "KSampler")
        self.assertEqual(sampler["inputs"]["model"], [gid, 0])
        self.assertEqual(sampler["inputs"]["positive"], [gid, 1])
        self.assertTrue(any(n.get("class_type") == "ApplyVDNH3Advanced" for n in g.values()))

    def test_single_fl2v_segment_pins_first_and_last_frame(self):
        # 首尾帧单段：首帧钉 0，尾帧按既有约定钉在该段名义末帧（5s × 24fps - 1 = 119，
        # 对齐到 17k+5 网格后的 120–123 属补齐帧，不挪锚点）
        segments = [{"skill_id": "mf", "prompt": "p0", "duration_sec": 5, "mode": "fl2v",
                     "ref_input": "f.png", "last_input": "t.png"}]
        orig, bodies, graphs = self._patch(segments, [124])
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        g = graphs[0]
        gnode = next(n for n in g.values() if n.get("class_type") == "NeoH3AddGuides")
        self.assertEqual(gnode["inputs"]["guide_0_frame"], 0)
        self.assertEqual(gnode["inputs"]["guide_1_frame"], 119)
        load_names = sorted(n["inputs"]["image"] for n in g.values() if n.get("class_type") == "LoadImage")
        self.assertEqual(load_names, ["f.png", "t.png"])

    def test_single_t2v_segment_without_anchor_stays_legacy(self):
        # 无可钉的帧 → 仍逐段（不注入锚点节点）
        segments = [{"skill_id": "mf", "prompt": "p0", "duration_sec": 5, "mode": "t2v"}]
        orig, bodies, graphs = self._patch(segments, [124])
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        self.assertFalse(any(n.get("class_type") == "NeoH3AddGuides" for n in graphs[0].values()))

    def test_r2v_shared_refs_flow_into_multiframe_body(self):
        # r2v×2 参考一致 → 一次多帧运行，共享参考集按顺序写入 body.references（<Picture N> 据此编号）
        segments = [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "mode": "r2v",
                     "refs": {"images": ["a.png", "b.png"]}},
                    {"skill_id": "s1", "prompt": "p1", "duration_sec": 5, "mode": "r2v",
                     "refs": {"images": ["a.png", "b.png"]}}]
        orig, bodies, graphs = self._patch(segments, [243])
        h3_video_director._merge_chunk_prompt = lambda segs: "MERGED"
        try:
            (video,) = h3_video_director.NeoH3VideoDirector().generate("r", continuity=False)
        finally:
            self._restore(orig)
        self.assertEqual(len(bodies), 1)   # 一次多帧单次运行
        self.assertEqual(bodies[0]["prompt"], "MERGED")
        self.assertEqual(bodies[0]["references"], [
            {"kind": "input", "value": "a.png"},
            {"kind": "input", "value": "b.png"},
        ])


class DirectorModelStepsTests(unittest.TestCase):
    """外部 MODEL / steps 入参：逐段注入模型 + 覆盖步数；无 model 时校验 VDN 插件。"""

    SR = 48000
    FPS = 24

    def _run(self, model=None, steps=-1, sink_present=True, width=-1, height=-1, shared=None):
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._model_injection_node, h3d._require_vdn_plugin)
        resolve_calls = []
        exec_calls = []
        render_params = []
        vdn_checks = 0
        if shared is None:
            shared = {"width": 8, "height": 8, "seed": 1, "chunk_sec": 0}   # 关闭分块：本组用例验证逐段注入行为
        h3d.load_director_spec = lambda name: {
            "shared": dict(shared),
            "segments": [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "mode": "t2v"},
                         {"skill_id": "s1", "prompt": "p1", "duration_sec": 5, "mode": "t2v"}]}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg, skip_model=False):
            resolve_calls.append(skip_model)
            return dict(body)

        h3d.resolve_video_params = _fake_resolve

        def _fake_render(tpl, params):
            render_params.append(dict(params))
            return {"inj": 1, "u": 1}, []

        h3d.render_template = _fake_render

        def _fake_exec(graph, output_type="IMAGE", overrides=None):
            exec_calls.append(overrides)
            return _FakeVideo(100, self.FPS, self.SR)

        h3d.execute_graph_inprocess = _fake_exec
        if sink_present:
            h3d._model_injection_node = lambda graph: ("inj", {"u"})
        else:
            h3d._model_injection_node = lambda graph: (None, set())

        def _fake_vdn(graph):
            nonlocal vdn_checks
            vdn_checks += 1

        h3d._require_vdn_plugin = _fake_vdn
        err = None
        try:
            h3_video_director.NeoH3VideoDirector().generate("r", model=model, steps=steps, width=width,
                                                            height=height, context_frames=0)
        except Exception as e:
            err = str(e)
        finally:
            self._restore(orig)
        return resolve_calls, exec_calls, render_params, vdn_checks, err

    def _restore(self, orig):
        (h3_video_director.load_director_spec, h3_video_director._resolve_skill_id,
         h3_video_director.load_skill_workflow, h3_video_director.get_skill_gen_config,
         h3_video_director.resolve_video_params, h3_video_director.render_template,
         h3_video_director.execute_graph_inprocess, h3_video_director._model_injection_node,
         h3_video_director._require_vdn_plugin) = orig

    def test_model_injected_per_segment_and_skips_model_resolve(self):
        resolve_calls, exec_calls, _, vdn_checks, err = self._run(model="M")
        self.assertIsNone(err)
        self.assertEqual(resolve_calls, [True, True])   # 每段跳过主模型解析
        self.assertEqual(vdn_checks, 0)                 # 有 model 时不校验 VDN 插件
        self.assertEqual(exec_calls, [{"inj": ["M"]}, {"inj": ["M"]}])

    def test_steps_override_applied_per_segment(self):
        _, _, render_params, _, err = self._run(model=None, steps=8)
        self.assertIsNone(err)
        self.assertTrue(all(p.get("steps") == 8 for p in render_params))

    def test_no_model_validates_vdn_plugin_and_keeps_internal_resolve(self):
        resolve_calls, exec_calls, _, vdn_checks, err = self._run(model=None)
        self.assertIsNone(err)
        self.assertEqual(resolve_calls, [False, False])  # 无 model 走内部模型解析
        self.assertEqual(vdn_checks, 2)                  # 每段校验一次 VDN 插件
        self.assertEqual(exec_calls, [None, None])       # 无覆盖

    def test_model_without_injection_point_raises(self):
        _, _, _, _, err = self._run(model="M", sink_present=False)
        self.assertIn("注入点", err or "")
    def test_width_height_falls_back_to_shared_when_node_default(self):
        # 节点 width/height=-1（默认）时优先用配方 shared 分辨率写入 body
        _, _, render_params, _, err = self._run()
        self.assertIsNone(err)
        self.assertTrue(all(p.get("width") == 8 and p.get("height") == 8 for p in render_params))

    def test_width_height_omitted_when_node_and_shared_absent(self):
        # 节点 width/height=-1 且配方 shared 无分辨率时不写入 body，交由 resolve_video_params 按 skill config 回退
        _, _, render_params, _, err = self._run(shared={"seed": 1})
        self.assertIsNone(err)
        for p in render_params:
            self.assertNotIn("width", p)
            self.assertNotIn("height", p)

    def test_width_height_override_applied_per_segment(self):
        # 节点 width/height>0 时覆盖全部段（忽略配方 shared.width/height）
        _, _, render_params, _, err = self._run(width=512, height=288)
        self.assertIsNone(err)
        self.assertTrue(all(p.get("width") == 512 and p.get("height") == 288 for p in render_params))



class DirectorBundleTests(unittest.TestCase):
    """BUNDLE 单段：NeoPromptAgent 的 BUNDLE（data URI 参考）作为单个片段生成，忽略 recipe。"""

    SR = 48000
    FPS = 24

    def _run(self, payload, seed=-1, width=-1, height=-1, model=None, steps=-1, duration_sec=5,
             skill_id="minimax_h3_t2v", valid_skills=("minimax_h3_t2v",)):
        h3d = h3_video_director
        orig = (h3d.get_bundle, h3d._gen_video_skills, h3d.load_director_spec,
                h3d._resolve_skill_id, h3d.load_skill_workflow, h3d.get_skill_gen_config,
                h3d.resolve_video_params, h3d.render_template, h3d.execute_graph_inprocess,
                h3d._model_injection_node, h3d._require_vdn_plugin)
        bodies = []
        recipe_calls = []

        h3d.get_bundle = lambda b: payload
        h3d._gen_video_skills = lambda: [{"id": s} for s in valid_skills]
        h3d.load_director_spec = lambda name: recipe_calls.append(name) or {"shared": {}, "segments": []}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}

        def _fake_resolve(body, cfg, skip_model=False):
            bodies.append(dict(body))
            return dict(body)

        h3d.resolve_video_params = _fake_resolve
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._model_injection_node = lambda graph: (None, set())
        h3d._require_vdn_plugin = lambda graph: None
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", overrides=None: _FakeVideo(100, self.FPS, self.SR)

        err = None
        out = None
        try:
            (out,) = h3_video_director.NeoH3VideoDirector().generate(
                "ignored_recipe", skill=skill_id, seed=seed, width=width, height=height, model=model, steps=steps,
                duration_sec=duration_sec, bundle="B1")
        except Exception as e:
            err = str(e)
        finally:
            self._restore(orig)
        return out, bodies, recipe_calls, err

    def _restore(self, orig):
        (h3_video_director.get_bundle, h3_video_director._gen_video_skills,
         h3_video_director.load_director_spec, h3_video_director._resolve_skill_id,
         h3_video_director.load_skill_workflow, h3_video_director.get_skill_gen_config,
         h3_video_director.resolve_video_params, h3_video_director.render_template,
         h3_video_director.execute_graph_inprocess, h3_video_director._model_injection_node,
         h3_video_director._require_vdn_plugin) = orig

    def test_bundle_single_segment_runs_and_ignores_recipe(self):
        payload = {"prompts": ["a cat walks"],
                   "references": [{"kind": "data", "data": "data:image/png;base64,AAA"}]}
        out, bodies, recipe_calls, err = self._run(payload)
        self.assertIsNone(err)
        self.assertEqual(recipe_calls, [])            # bundle 优先：recipe 不加载
        self.assertEqual(len(bodies), 1)              # 单段
        self.assertEqual(bodies[0]["prompt"], "a cat walks")
        # data URI 参考原样透传（不做文件名解析）
        self.assertEqual(bodies[0]["references"][0], {"kind": "data", "data": "data:image/png;base64,AAA"})
        self.assertIsNotNone(out.get_components())

    def test_bundle_seed_width_height_applied(self):
        payload = {"prompts": ["p"]}
        _, bodies, _, err = self._run(payload, seed=500, width=512, height=288)
        self.assertIsNone(err)
        self.assertEqual(bodies[0].get("seed"), 500)
        self.assertEqual((bodies[0].get("width"), bodies[0].get("height")), (512, 288))

    def test_bundle_default_seed_omitted(self):
        # seed/width/height=-1（默认）时不写入 body，交由 resolve_video_params 随机 / skill config 回退
        payload = {"prompts": ["p"]}
        _, bodies, _, err = self._run(payload)
        self.assertIsNone(err)
        self.assertNotIn("seed", bodies[0])
        self.assertNotIn("width", bodies[0])
        self.assertNotIn("height", bodies[0])

    def test_bundle_duration_sec_applied_as_frames(self):
        # 时长（秒）→ H3 帧数：按 24fps 取整后向上对齐 17k+5 网格
        payload = {"prompts": ["p"]}
        _, bodies, _, err = self._run(payload, duration_sec=10)
        self.assertIsNone(err)
        self.assertEqual(bodies[0].get("length"), h3_video_director._seconds_to_frames(10))
        self.assertEqual(bodies[0].get("length"), 243)          # 10s → 240 帧 → 243

    def test_bundle_default_duration_is_skill_config(self):
        # duration_sec=5（默认）= 内置 H3 skill config 的 length（124 帧 ≈ 5 秒），不再有 -1 哨兵
        payload = {"prompts": ["p"]}
        _, bodies, _, err = self._run(payload)
        self.assertIsNone(err)
        self.assertEqual(bodies[0].get("length"), h3_video_director._seconds_to_frames(5))
        self.assertEqual(bodies[0].get("length"), 124)

    def test_bundle_duration_sec_exposed_as_widget(self):
        # 时长（秒）是节点 widget（非连线槽），默认 5 秒 = 内置 H3 skill config 的 length 折算，最小 1 秒
        opt = h3_video_director.NeoH3VideoDirector.INPUT_TYPES()["optional"]
        self.assertIn("duration_sec", opt)
        self.assertEqual(opt["duration_sec"][0], "INT")
        self.assertEqual(opt["duration_sec"][1]["default"], 5)
        self.assertEqual(opt["duration_sec"][1]["min"], 1)
        self.assertNotIn("forceInput", opt["duration_sec"][1])

    def test_bundle_invalid_skill_raises(self):
        payload = {"prompts": ["p"]}
        _, bodies, _, err = self._run(payload, skill_id="not_a_video_skill")
        self.assertIn("视频 skill", err or "")
        self.assertEqual(bodies, [])                  # 未进入执行链

    def test_bundle_missing_prompt_raises(self):
        payload = {"prompts": []}                     # bundle 有效但无提示词
        _, bodies, _, err = self._run(payload)
        self.assertIn("提示词", err or "")
        self.assertEqual(bodies, [])

    def test_bundle_input_exposed_as_forceinput(self):
        # NeoPromptAgent BUNDLE 连线槽在 H3 视频节点上可见（forceInput，非 hidden）
        opt = h3_video_director.NeoH3VideoDirector.INPUT_TYPES()["optional"]
        self.assertIn("bundle", opt)
        self.assertTrue(opt["bundle"][1].get("forceInput"))
        self.assertNotIn("hidden", opt["bundle"][1])

    def test_skill_input_exposed_as_combo(self):
        # BUNDLE 单段的视频 skill 是节点 widget（combo），显示 cn_name（缺省回退 name）；旧名 skill_id 已弃用
        opt = h3_video_director.NeoH3VideoDirector.INPUT_TYPES()["optional"]
        self.assertIn("skill", opt)
        self.assertNotIn("skill_id", opt)
        self.assertIsInstance(opt["skill"][0], list)

    def test_skill_default_is_fewest_steps_available(self):
        # 默认 skill = 可用技能里采样步数最少者；不可用项带「（不可用）」后缀且被跳过
        orig = h3_video_director._gen_video_skills
        h3_video_director._gen_video_skills = lambda: [
            {"id": "a", "cn_name": "A", "name": "a", "gen_config": {"steps": 20}},
            {"id": "b", "cn_name": "B", "name": "b", "available": False, "gen_config": {"steps": 4}},
            {"id": "c", "cn_name": "C", "name": "c", "gen_config": {"steps": 8}},
        ]
        try:
            opt = h3_video_director.NeoH3VideoDirector.INPUT_TYPES()["optional"]
            self.assertEqual(opt["skill"][0], ["A", "B（不可用）", "C"])
            self.assertEqual(opt["skill"][1]["default"], "C")
        finally:
            h3_video_director._gen_video_skills = orig


class DirectorSpecRouteTests(unittest.TestCase):
    """/rs_recipes/director_spec 请求解析与错误分支（load_director_spec 打桩）。"""

    def _req(self, name):
        return types.SimpleNamespace(rel_url=types.SimpleNamespace(query={"name": name}))

    def test_missing_name_returns_400(self):
        resp = _run_async(recipes.rs_recipes_director_spec(self._req("   ")))
        self.assertEqual(resp.status, 400)

    def test_returns_shared_and_segments(self):
        orig = recipes.load_director_spec
        recipes.load_director_spec = lambda name: {
            "shared": {"width": 8},
            "segments": [{"skill_id": "s", "prompt": "a", "duration_sec": 5, "ref_input": None}],
        }
        try:
            resp = _run_async(recipes.rs_recipes_director_spec(self._req("myrecipe")))
        finally:
            recipes.load_director_spec = orig
        self.assertEqual(resp.status, 200)
        body = json.loads(resp.body)
        self.assertTrue(body["success"])
        self.assertEqual(body["name"], "myrecipe")
        self.assertEqual(len(body["segments"]), 1)
        self.assertIn("shared", body)

    def test_load_error_returns_500(self):
        orig = recipes.load_director_spec

        def _raise(name):
            raise ValueError("配方不存在")

        recipes.load_director_spec = _raise
        try:
            resp = _run_async(recipes.rs_recipes_director_spec(self._req("nope")))
        finally:
            recipes.load_director_spec = orig
        self.assertEqual(resp.status, 500)


class DirectorDefaultDimsTests(unittest.TestCase):
    """recipes._director_default_dims：取首段 skill config 的 width/height/steps，供节点 widget 动态填充。"""

    def _patch(self, cfg_by_id):
        skill_mod = sys.modules[f"{_PKG}.skill"]
        h3v_mod = sys.modules[f"{_PKG}.h3_video_gen"]
        orig = (skill_mod.get_skill_gen_config, h3v_mod._resolve_skill_id)
        skill_mod.get_skill_gen_config = lambda sid: cfg_by_id.get(sid, {})
        h3v_mod._resolve_skill_id = lambda v: v
        return (skill_mod, h3v_mod, orig)

    def _restore(self, ctx):
        skill_mod, h3v_mod, (orig_cfg, orig_res) = ctx
        skill_mod.get_skill_gen_config = orig_cfg
        h3v_mod._resolve_skill_id = orig_res

    def test_first_segment_skill_config_used(self):
        ctx = self._patch({"s1": {"width": 960, "height": 544, "steps": 8}})
        try:
            d = recipes._director_default_dims([{"skill_id": "s1"}, {"skill_id": "s2"}])
        finally:
            self._restore(ctx)
        self.assertEqual(d, {"width": 960, "height": 544, "steps": 8})

    def test_shared_dims_preferred_over_skill_config(self):
        # 配方 shared 有分辨率时优先（steps 仍取 skill config）
        ctx = self._patch({"s1": {"width": 960, "height": 544, "steps": 8}})
        try:
            d = recipes._director_default_dims([{"skill_id": "s1"}], {"width": 736, "height": 736})
        finally:
            self._restore(ctx)
        self.assertEqual(d, {"width": 736, "height": 736, "steps": 8})

    def test_shared_partial_falls_back_per_dim(self):
        # shared 只给一个维度时，另一维回退 skill config
        ctx = self._patch({"s1": {"width": 960, "height": 544, "steps": 8}})
        try:
            d = recipes._director_default_dims([{"skill_id": "s1"}], {"width": 736})
        finally:
            self._restore(ctx)
        self.assertEqual(d, {"width": 736, "height": 544, "steps": 8})

    def test_skips_segments_without_skill_id(self):
        ctx = self._patch({"s2": {"width": 512, "height": 288, "steps": 4}})
        try:
            d = recipes._director_default_dims([{"skill_id": ""}, {"skill_id": "s2"}])
        finally:
            self._restore(ctx)
        self.assertEqual(d, {"width": 512, "height": 288, "steps": 4})

    def test_falls_back_to_h3_defaults_when_no_config(self):
        ctx = self._patch({})
        try:
            d = recipes._director_default_dims([{"skill_id": "s1"}])
        finally:
            self._restore(ctx)
        self.assertEqual(d, {"width": 1344, "height": 768, "steps": 20})

    def test_empty_segments_returns_h3_defaults(self):
        d = recipes._director_default_dims([])
        self.assertEqual(d, {"width": 1344, "height": 768, "steps": 20})


class DirectorProgressRouteTests(unittest.TestCase):
    """/neo_video_gen/director_progress 返回当前 director 运行进度快照。"""

    def test_returns_current_state(self):
        h3d = h3_video_director
        orig = dict(h3d._DIRECTOR_PROGRESS)
        try:
            h3d._DIRECTOR_PROGRESS.update(active=True, segment_index=1, total_segments=4)
            resp = _run_async(h3d.neo_video_gen_director_progress(None))
        finally:
            h3d._DIRECTOR_PROGRESS.clear()
            h3d._DIRECTOR_PROGRESS.update(orig)
        self.assertEqual(resp.status, 200)
        body = json.loads(resp.body)
        self.assertEqual(body, {"active": True, "segment_index": 1, "total_segments": 4, "step": 0, "total_steps": 0,
                                "prompt_id": None})


class H3PreviewTests(unittest.TestCase):
    """h3_preview：taeh3 解码器重建、潜空间抽帧、每步多帧载荷推送与接管/还原、节点开关语义。"""

    def setUp(self):
        self.h3p = sys.modules[f"{_PKG}.h3_preview"]
        self.lp = sys.modules["latent_preview"]
        self.original = self.lp.get_previewer
        self.sent = []   # 后端每步推的预览载荷都会记到这里
        self.server = self.h3p.PromptServer.instance
        self.orig_send = self.server.send_sync
        self.server.send_sync = lambda event, data, sid=None: self.sent.append((event, data, sid))

    def tearDown(self):
        self.lp.get_previewer = self.original
        self.server.send_sync = self.orig_send

    def _vae(self):
        return self.h3p.H3TinyVAE({"1.weight": torch.zeros(8, 24, 3, 3), "1.bias": torch.zeros(8),
                                   "4.weight": torch.zeros(3, 8, 3, 3), "4.bias": torch.zeros(3)})

    def test_build_decoder_maps_flat_indices(self):
        # 缺号：0→Clamp、2→ReLU；conv.* → Block；裸 weight → conv（按有无 bias 定）
        sd = {
            "1.weight": torch.zeros(8, 4, 3, 3), "1.bias": torch.zeros(8),
            "3.conv.0.weight": torch.zeros(8, 8, 3, 3), "3.conv.0.bias": torch.zeros(8),
            "3.conv.2.weight": torch.zeros(8, 8, 3, 3), "3.conv.2.bias": torch.zeros(8),
            "3.conv.4.weight": torch.zeros(8, 8, 3, 3), "3.conv.4.bias": torch.zeros(8),
            "4.weight": torch.zeros(8, 8, 3, 3),
            "5.weight": torch.zeros(3, 8, 3, 3), "5.bias": torch.zeros(3),
        }
        model = self.h3p._build_decoder(sd)
        self.assertEqual([type(m).__name__ for m in model],
                         ["_StubClamp", "Conv2d", "ReLU", "_StubBlock", "Conv2d", "Conv2d"])
        self.assertEqual((model[3].n_in, model[3].n_out), (8, 8))
        self.assertIsNone(model[4].bias)          # 索引 4 无 bias → conv(bias=False)
        self.assertIsNotNone(model[5].bias)

    def test_build_decoder_fills_other_gaps_with_upsample(self):
        sd = {"1.weight": torch.zeros(4, 4, 3, 3), "1.bias": torch.zeros(4),
              "4.weight": torch.zeros(4, 4, 3, 3)}
        model = self.h3p._build_decoder(sd)
        self.assertEqual([type(m).__name__ for m in model],
                         ["_StubClamp", "Conv2d", "ReLU", "Upsample", "Conv2d"])

    def test_build_decoder_rejects_non_flat_state_dict(self):
        with self.assertRaises(ValueError):
            self.h3p._build_decoder({"decoder.1.weight": torch.zeros(4, 4, 3, 3)})

    def test_tiny_vae_reads_channels_and_decodes_frame(self):
        vae = self._vae()
        self.assertEqual(vae.latent_channels, 24)
        img = vae.decode_frame(torch.randn(1, 24, 4, 6))
        self.assertEqual((img.mode, img.size), ("RGB", (12, 8)))   # 缺号里的 Upsample 使边长翻倍

    def test_frame_indices_spread_across_time_axis(self):
        self.assertEqual(self.h3p._frame_indices(5, 8), [0, 1, 2, 3, 4])           # 帧数不足 → 全取
        self.assertEqual(self.h3p._frame_indices(8, 8), list(range(8)))
        self.assertEqual(self.h3p._frame_indices(120, 8), [0, 17, 34, 51, 68, 85, 102, 119])   # 首尾都取到
        self.assertEqual(self.h3p._frame_indices(120, 1), [0])

    def test_frame_indices_are_unique_for_odd_lengths(self):
        self.assertEqual(len(set(self.h3p._frame_indices(37, 8))), 8)

    def test_video_frames_picks_evenly_spaced_frames(self):
        frames = self.h3p._video_frames(torch.randn(1, 24, 6, 5, 7), 24, 3)
        self.assertEqual([tuple(f.shape) for f in frames], [(1, 24, 5, 7)] * 3)

    def test_video_frames_single_frame_input(self):
        frames = self.h3p._video_frames(torch.randn(1, 24, 5, 7), 24, 8)
        self.assertEqual([tuple(f.shape) for f in frames], [(1, 24, 5, 7)])

    def test_video_frames_returns_none_without_matching_stream(self):
        self.assertIsNone(self.h3p._video_frames(torch.randn(1, 32, 2, 5, 7), 24, 8))   # 音频流
        self.assertIsNone(self.h3p._video_frames(torch.randn(1, 24), 24, 8))

    def test_preview_payload_encodes_jpeg_frames(self):
        payload = self.h3p._preview_payload([Image.new("RGB", (600, 1200), (20, 40, 60)) for _ in range(2)])
        self.assertEqual(payload["fps"], self.h3p.PREVIEW_FPS)
        self.assertEqual((payload["w"], payload["h"]), (512, 1024))   # 等比缩到最长边 PREVIEW_SIDE
        self.assertEqual(len(payload["frames"]), 2)
        for frame in payload["frames"]:
            self.assertTrue(frame.startswith(self.h3p.JPEG_DATA_URL))   # 前端直接塞 <img>.src，必须是 data URL
            raw = base64.b64decode(frame[len(self.h3p.JPEG_DATA_URL):])
            self.assertEqual(raw[:3], b"\xff\xd8\xff")   # JPEG 魔数
            with Image.open(io.BytesIO(raw)) as im:
                self.assertEqual(im.size, (512, 1024))
                for got, want in zip(im.convert("RGB").getpixel((128, 256)), (20, 40, 60)):
                    self.assertLessEqual(abs(got - want), 3)   # 画面内容存活，没被压成黑

    def test_preview_off_suppresses_and_restores(self):
        with self.h3p.preview_override(False, None):
            self.assertIsNot(self.lp.get_previewer, self.original)
            self.assertIsNone(self.lp.get_previewer(None, _StubMiniMaxH3Video()))
        self.assertIs(self.lp.get_previewer, self.original)

    def test_preview_on_uses_taeh3_and_restores(self):
        with self.h3p.preview_override(True, self._vae(), "9"):
            prev = self.lp.get_previewer(None, _StubMiniMaxH3Video())
        self.assertIs(self.lp.get_previewer, self.original)
        self.assertIsInstance(prev, self.h3p.H3Previewer)
        self.assertEqual(prev.node_id, "9")
        prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 3, 4, 6))
        self.assertEqual(self.sent[0][1]["node_id"], "9")

    def test_preview_on_without_taeh3_falls_back_to_latent2rgb(self):
        with self.h3p.preview_override(True, None):
            prev = self.lp.get_previewer(None, _StubMiniMaxH3Video())
        self.assertIsInstance(prev, _StubLatent2RGBPreviewer)

    def test_preview_leaves_other_latent_formats_to_the_original(self):
        sentinel = object()
        self.lp.get_previewer = lambda device, latent_format: sentinel
        with self.h3p.preview_override(False, None):
            self.assertIs(self.lp.get_previewer(None, object()), sentinel)

    def test_preview_restores_on_exception(self):
        with self.assertRaises(RuntimeError):
            with self.h3p.preview_override(True, None):
                raise RuntimeError("boom")
        self.assertIs(self.lp.get_previewer, self.original)

    def test_previewer_pushes_frames_and_suppresses_core_image(self):
        """核心一步只出一张静图的通道返回 None（进度条照常推进），多帧载荷改走自有事件。"""
        prev = self.h3p.H3Previewer(self._vae(), "7")
        self.assertIsNone(prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 8, 4, 6)))
        self.assertEqual(len(self.sent), 1)
        event, data, sid = self.sent[0]
        self.assertEqual(event, self.h3p.PREVIEW_EVENT)
        self.assertEqual(data["node_id"], "7")
        self.assertEqual(len(data["frames"]), self.h3p.PREVIEW_FRAMES)   # 每步抽 PREVIEW_FRAMES 帧
        self.assertEqual((data["w"], data["h"]), (12, 8))
        self.assertIsNone(sid)   # 推给发起本次执行的客户端（client_id 为 None 即广播）

    def test_previewer_without_node_id_skips_send(self):
        prev = self.h3p.H3Previewer(self._vae())
        self.assertIsNone(prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 4, 4, 6)))
        self.assertEqual(self.sent, [])

    def test_previewer_stores_compact_frames_for_the_agent_card(self):
        """右栏智能体卡片只吃紧凑档：全尺寸那份过 SSE 太肥，WS 广播里不带上它。"""
        self.h3p._LATEST.clear()
        self.h3p._LATEST_SMALL.clear()
        prev = self.h3p.H3Previewer(self._vae(), "7")
        prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 8, 4, 6))
        _event, data, _sid = self.sent[0]
        self.assertNotIn("small", data)   # 广播载荷就是全尺寸那一份
        small = self.h3p.get_latest_preview("7", small=True)
        self.assertEqual(len(small["frames"]), self.h3p.PREVIEW_FRAMES)
        self.assertEqual(small["step"], data["step"])
        self.assertTrue(small["frames"][0].startswith(self.h3p.JPEG_DATA_URL))
        self.assertLessEqual(max(small["w"], small["h"]), self.h3p.AGENT_PREVIEW_SIDE)

    def test_previewer_skips_non_video_shapes(self):
        prev = self.h3p.H3Previewer(self._vae(), "7")
        self.assertIsNone(prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 32, 2, 5, 7)))
        self.assertEqual(self.sent, [])

    def test_previewer_keeps_sampling_alive_when_decode_fails(self):
        class _Bad:
            latent_channels = 24

            def decode_frame(self, frame):
                raise RuntimeError("boom")

        prev = self.h3p.H3Previewer(_Bad(), "7")
        self.assertIsNone(prev.decode_latent_to_preview_image("JPEG", torch.randn(1, 24, 2, 4, 6)))
        self.assertEqual(self.sent, [])

    def test_load_returns_none_without_taeh3_file(self):
        self.assertIsNone(self.h3p.load_h3_tiny_vae())

    def test_input_types_exposes_preview_toggle(self):
        types = h3_video_director.NeoH3VideoDirector.INPUT_TYPES()
        self.assertIs(types["optional"]["preview"][1]["default"], True)
        self.assertEqual(types["hidden"]["unique_id"], "UNIQUE_ID")   # 预览载荷靠它路由回节点

    def test_generate_loads_decoder_only_when_preview_is_on(self):
        h3d = h3_video_director
        names = ("load_director_spec", "_resolve_skill_id", "load_skill_workflow", "get_skill_gen_config",
                 "resolve_video_params", "render_template", "execute_graph_inprocess",
                 "_require_vdn_plugin", "load_h3_tiny_vae", "preview_override")
        orig = tuple(getattr(h3d, n) for n in names)
        seen, loads = [], []

        @contextlib.contextmanager
        def _rec(enabled, vae, node_id=None, **_):
            seen.append((enabled, vae, node_id))
            yield

        try:
            h3d.load_director_spec = lambda n: {"shared": {}, "segments": [
                {"skill_id": "s", "prompt": "p", "duration_sec": 5}]}
            h3d._resolve_skill_id = lambda v: v
            h3d.load_skill_workflow = lambda i: {"1": {}}
            h3d.get_skill_gen_config = lambda i: {}
            h3d.resolve_video_params = lambda body, cfg, skip_model=False: dict(body)
            h3d.render_template = lambda tpl, params: ({"1": {}}, [])
            h3d.execute_graph_inprocess = lambda graph, output_type="VIDEO", overrides=None: _FakeVideo(4)
            h3d._require_vdn_plugin = lambda graph: None
            h3d.load_h3_tiny_vae = lambda: (loads.append(1), "VAE")[1]
            h3d.preview_override = _rec
            node = h3d.NeoH3VideoDirector()
            node.generate("r", unique_id="12")                  # 默认开：段执行期间用 taeh3
            node.generate("r", preview=False, unique_id="12")   # 关：不加载解码器，段内完全不出预览
        finally:
            for n, v in zip(names, orig):
                setattr(h3d, n, v)
        self.assertEqual(seen, [(True, "VAE", "12"), (False, None, "12")])
        self.assertEqual(len(loads), 1)


class _FakeModelPatcher:
    """ModelPatcher 桩：只实现 clone + 命名空间 wrapper 增删。"""

    def __init__(self, wrappers=None):
        self.clones = 0
        self.wrappers = wrappers or {}

    def clone(self):
        self.clones += 1
        copied = {k: {k1: list(v1) for k1, v1 in v.items()} for k, v in self.wrappers.items()}
        return _FakeModelPatcher(copied)

    def remove_wrappers_with_key(self, wrapper_type, key):
        self.wrappers.get(wrapper_type, {}).pop(key, None)

    def add_wrapper_with_key(self, wrapper_type, key, wrapper):
        self.wrappers.setdefault(wrapper_type, {}).setdefault(key, []).append(wrapper)


class _KwargsExecutor:
    """APPLY_MODEL executor 桩：记录本次调用拿到的 kwargs，并把 payload 交回调用方。"""

    def __init__(self):
        self.kwargs = None

    def __call__(self, *args, **kwargs):
        self.kwargs = kwargs
        return kwargs.get("minimax_payload")


class _StubVae:
    def __init__(self):
        self.seen = None

    def encode(self, image):
        self.seen = image
        return torch.zeros(1, 16, 2, 2, 2)


class _StubH3Vae:
    """H3 视频 VAE 桩：latent 时间步按模型的 17k+5 网格（22 帧 → 7 步，单图 → 1 步）。"""

    def __init__(self):
        self.seen = []

    def encode(self, frames):
        self.seen.append(frames)
        n = int(frames.shape[0])
        latent_t = 1 if n < 5 else 2 + 5 * ((n - 5) // 17)
        return torch.zeros(1, 24, latent_t, frames.shape[1] // 16, frames.shape[2] // 16)


class _StubNode:
    """mini-executor 用的极简节点桩：INPUT_TYPES 无必填项，run 从类属性取预设值。"""

    RETURN_TYPES = ()
    FUNCTION = "run"
    value = None

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def run(self, **kwargs):
        return (self.value,)


class _StubVaeLoader(_StubNode):
    RETURN_TYPES = ("VAE",)


class _StubUnetLoader(_StubNode):
    RETURN_TYPES = ("MODEL",)


class _StubImageLoader(_StubNode):
    RETURN_TYPES = ("IMAGE",)


class _StubR2V(_StubNode):
    RETURN_TYPES = ("CONDITIONING", "LATENT")
    ref_latent = None

    def run(self, **kwargs):
        return ([["tok", {"minimax_refs": [{"latent": self.ref_latent}]}]], {"samples": torch.zeros(1)})


class _StubSampler(_StubNode):
    RETURN_TYPES = ("LATENT",)
    seen = None

    def run(self, model=None, positive=None, negative=None, latent_image=None, **kwargs):
        _StubSampler.seen = {"model": model, "positive": positive, "negative": negative}
        return ({"samples": torch.zeros(1)},)


class _StubCreateVideo(_StubNode):
    RETURN_TYPES = ("VIDEO",)

    def run(self, **kwargs):
        return ("VIDEO-OUT",)


class HybridKeyframeTests(unittest.TestCase):
    """P2 Hybrid：r2v 段注入首帧 keyframe 锚点 + cond 合并 wrapper 的单元测试。"""

    def setUp(self):
        # 各测试模块都会重写 comfy.patcher_extension 桩（后导入者生效、跨文件恢复会摘掉它）
        pe = sys.modules.get("comfy.patcher_extension")
        if pe is None:
            pe = types.ModuleType("comfy.patcher_extension")
            pe.WrappersMP = types.SimpleNamespace()
            pe.add_wrapper_with_key = lambda *a, **k: None
            sys.modules["comfy.patcher_extension"] = pe
        wrappers = pe.WrappersMP
        if not hasattr(wrappers, "APPLY_MODEL"):
            wrappers.APPLY_MODEL = "APPLY_MODEL"

    def _r2v_graph(self):
        return {
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": "x.safetensors"}},
            "5": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "clip": ["2", 0], "vae": ["3", 0], "prompt": "test",
                "width": 1344, "height": 768, "length": 124,
            }},
            "7": {"class_type": "KSampler", "inputs": {
                "model": ["6", 0], "seed": 42, "steps": 20, "cfg": 1.0,
                "sampler_name": "euler", "scheduler": "simple",
                "positive": ["5", 0], "negative": ["5", 0], "latent_image": ["5", 1],
                "denoise": 1.0,
            }},
        }

    def test_align_frame_count(self):
        self.assertEqual(h3_video_director._align_frame_count(5), 5)
        self.assertEqual(h3_video_director._align_frame_count(124), 124)
        self.assertEqual(h3_video_director._align_frame_count(6), 22)
        self.assertEqual(h3_video_director._align_frame_count(3), 5)
        self.assertEqual(h3_video_director._align_frame_count(125), 141)

    def test_inject_continuity_nodes_chains_identity_then_context(self):
        """r2v 模板图注入后：身份参考图各一个节点、上下文窗口用虚拟 LoadImage，采样器改指注入链末端。"""
        tail = torch.zeros(22, 768, 1344, 3)
        modified, overrides = h3_video_director._inject_continuity_nodes(
            self._r2v_graph(), tail, 22, ["a.png", "b.png"])
        nodes = sorted((int(nid), node) for nid, node in modified.items()
                       if node.get("class_type") == "NeoH3AddContext")
        self.assertEqual(len(nodes), 3)                                     # 2 张身份图 + 1 个上下文窗口
        self.assertEqual(nodes[0][1]["inputs"]["model"], ["6", 0])           # 第一棒接采样器原 model 源
        self.assertEqual(nodes[0][1]["inputs"]["conditioning"], ["5", 0])
        self.assertEqual(nodes[0][1]["inputs"]["vae"], ["3", 0])
        self.assertEqual(nodes[0][1]["inputs"]["width"], 1344)
        self.assertEqual(nodes[0][1]["inputs"]["height"], 768)
        self.assertEqual([modified[n["inputs"]["identity_image"][0]]["inputs"]["image"] for _, n in nodes[:2]],
                         ["a.png", "b.png"])
        self.assertNotIn("context_image", nodes[0][1]["inputs"])
        self.assertEqual(nodes[1][1]["inputs"]["model"], [str(nodes[0][0]), 0])   # 链式接棒
        self.assertEqual(nodes[1][1]["inputs"]["conditioning"], [str(nodes[0][0]), 1])
        tail_id = nodes[2][1]["inputs"]["context_image"][0]
        self.assertEqual(modified[tail_id]["inputs"]["image"], "__neo_context_tail__")
        self.assertEqual(nodes[2][1]["inputs"]["context_frames"], 22)
        self.assertIs(overrides[tail_id][0], tail)
        last = str(nodes[2][0])
        self.assertEqual(modified["7"]["inputs"]["model"], [last, 0])
        self.assertEqual(modified["7"]["inputs"]["positive"], [last, 1])
        self.assertEqual(modified["7"]["inputs"]["negative"], [last, 1])
        self.assertEqual(modified["7"]["inputs"]["latent_image"], ["5", 1])
        # 注入节点占独立 id 段，模板原有节点一个不少
        injected = {str(nid) for nid, _ in nodes} | {n["inputs"]["identity_image"][0] for _, n in nodes[:2]} | {tail_id}
        self.assertEqual(injected, {"9000", "9001", "9002", "9003", "9004", "9005"})
        self.assertEqual(set(modified) - injected, {"3", "5", "7"})

    def test_inject_continuity_nodes_passes_reference_mode(self):
        """注入节点的 context_mode 原样透传：默认 window / 分镜首帧段 reference。"""
        tail = torch.zeros(22, 768, 1344, 3)
        for mode, expected in ((None, "window"), ("reference", "reference")):
            args = (self._r2v_graph(), tail, 22, ()) if mode is None else \
                (self._r2v_graph(), tail, 22, (), mode)
            modified, _ = h3_video_director._inject_continuity_nodes(*args)
            node = next(n for n in modified.values() if n.get("class_type") == "NeoH3AddContext")
            self.assertEqual(node["inputs"]["context_mode"], expected)

    def test_inject_continuity_nodes_skips_without_window_and_identity(self):
        """没有上下文窗口也没有身份图时不注入（返回 None，调用方保持原 overrides）。"""
        graph = self._r2v_graph()
        modified, overrides = h3_video_director._inject_continuity_nodes(graph, None, 0)
        self.assertIsNone(overrides)
        self.assertEqual(set(modified), {"3", "5", "7"})

    def test_inject_continuity_nodes_needs_h3_sampler(self):
        """模板里没有消费 H3 conditioning 的采样器 → 明确报错，而不是静默丢掉连续性。"""
        graph = {
            "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "u.safetensors"}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "x"}},
            "6": {"class_type": "KSampler", "inputs": {
                "model": ["2", 0], "positive": ["4", 0], "negative": ["4", 0], "latent_image": ["4", 1]}},
        }
        img = torch.zeros(22, 768, 1344, 3)
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_director._inject_continuity_nodes(graph, img, 22)
        self.assertIn("跨段连续性", str(ctx.exception))

    def test_inject_continuity_nodes_without_model_source_raises(self):
        """采样器没有 model 引用时挂不上连续性 wrapper → 报错。"""
        graph = self._r2v_graph()
        del graph["7"]["inputs"]["model"]
        img = torch.zeros(22, 768, 1344, 3)
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_director._inject_continuity_nodes(graph, img, 22)
        self.assertIn("model 来源", str(ctx.exception))

    def test_inject_continuity_nodes_avoids_template_id_collision(self):
        """模板已占用 9000 时注入节点顺延取号，不覆盖模板节点。"""
        graph = self._r2v_graph()
        graph["9000"] = {"class_type": "LoadImage", "inputs": {"image": "keep.png"}}
        modified, overrides = h3_video_director._inject_continuity_nodes(
            graph, torch.zeros(22, 768, 1344, 3), 22)
        ids = sorted(int(nid) for nid in modified if int(nid) >= 9000)
        self.assertEqual(ids, [9000, 9001, 9002])
        self.assertEqual(modified["9000"]["inputs"]["image"], "keep.png")
        self.assertEqual(modified["9002"]["inputs"]["context_image"], ["9001", 0])
        self.assertIn("9001", overrides)

    def test_merge_cond_latents_puts_keyframes_first(self):
        """锚点在前、参考在后（与 PackedLayout 的 cond/ref row 顺序一致）。"""
        kf = {"latent": torch.ones(1, 16, 2, 2, 2), "audio_latent": torch.ones(1, 2, 7)}
        ref = {"latent": torch.zeros(1, 16, 2, 2, 2), "audio_latent": torch.zeros(1, 2, 7)}
        payload = {"keyframes": [kf], "refs": [ref]}
        h3_video_director._merge_cond_latents(payload)
        self.assertEqual(len(payload["cond_video_latents"]), 2)
        self.assertIs(payload["cond_video_latents"][0], kf["latent"])
        self.assertIs(payload["cond_video_latents"][1], ref["latent"])
        self.assertIs(payload["cond_audio_latents"][0], kf["audio_latent"])
        self.assertIs(payload["cond_audio_latents"][1], ref["audio_latent"])

    def test_continuity_wrapper_fixes_payload_for_model_call(self):
        """core 会把 keyframe 的 cond 换成 refs，wrapper 需在模型调用前合回一条列表。"""
        kf = {"resolved_frame_index": 0, "latent": torch.ones(1, 16, 2, 2, 2)}
        ref = {"latent": torch.zeros(1, 16, 2, 2, 2)}
        payload = {"keyframes": [kf], "refs": [ref], "cond_video_latents": [ref["latent"]]}
        exec_ = _KwargsExecutor()
        out = h3_video_director._continuity_wrapper(exec_, torch.zeros(1), minimax_payload=payload)
        merged = exec_.kwargs["minimax_payload"]
        self.assertEqual(len(merged["cond_video_latents"]), 2)
        self.assertIs(merged["cond_video_latents"][0], kf["latent"])
        self.assertIs(merged["cond_video_latents"][1], ref["latent"])
        self.assertIs(out, merged)
        self.assertIsNot(merged, payload)                       # 不改调用方的 payload
        self.assertEqual(payload["cond_video_latents"], [ref["latent"]])

    def test_continuity_wrapper_passes_through_without_refs(self):
        """只有 keyframes（或 payload 不是 dict）时原样透传。"""
        payload = {"keyframes": [{"latent": torch.ones(1)}], "cond_video_latents": []}
        exec_ = _KwargsExecutor()
        out = h3_video_director._continuity_wrapper(exec_, torch.zeros(1), minimax_payload=payload)
        self.assertIs(out, payload)
        self.assertIsNone(h3_video_director._continuity_wrapper(
            _KwargsExecutor(), torch.zeros(1), minimax_payload=None))

    def test_install_continuity_clones_and_replaces_wrapper(self):
        """安装到 clone 上、同一 key 只留一份（在已安装的 patcher 上重复安装不会叠加）。"""
        key = h3_video_director._CONTINUITY_WRAPPER_KEY
        model = _FakeModelPatcher()
        patched = h3_video_director._install_continuity(model)
        self.assertEqual(model.clones, 1)
        self.assertEqual(patched.wrappers["APPLY_MODEL"][key], [h3_video_director._continuity_wrapper])
        self.assertEqual(model.wrappers, {})                    # 原 model 不被改动
        again = h3_video_director._install_continuity(patched)
        self.assertEqual(len(again.wrappers["APPLY_MODEL"][key]), 1)

    def test_add_keyframe_returns_patched_model_and_keyframe_cond(self):
        """节点：写 keyframe 元数据 + 返回挂了合并 wrapper 的 MODEL，参考元数据原样保留。"""
        vae = _StubVae()
        refs = [{"latent": torch.zeros(1, 16, 2, 2, 2)}]
        cond = [["tokens", {"minimax_refs": refs}]]
        model = _FakeModelPatcher()
        patched, out = h3_video_director.NeoH3AddKeyframe().add_keyframe(
            model, cond, vae, torch.zeros(2, 64, 64, 3), 124)
        self.assertEqual(vae.seen.shape[0], 1)                  # 只用第一张图
        self.assertEqual(model.clones, 1)                       # 在原 model 上 clone 一份再挂 wrapper
        self.assertEqual(patched.wrappers["APPLY_MODEL"].keys(), {h3_video_director._CONTINUITY_WRAPPER_KEY})
        meta = out[0][1]
        self.assertIs(meta["minimax_refs"], refs)
        self.assertEqual(meta["minimax_frame_count"], 124)
        self.assertEqual([(k["resolved_frame_index"], tuple(k["latent"].shape))
                          for k in meta["minimax_keyframes"]], [(0, (1, 16, 2, 2, 2))])


    def test_inject_continuity_nodes_on_real_presets(self):
        """真实数据：四种预设模板（i2v/t2v/r2v + VDN 变体）都能定位注入点，模板节点一个不少。"""
        tail = torch.zeros(22, 768, 1344, 3)
        for preset in ("minimax-h3-r2v", "minimax-h3-vdn-r2v", "minimax_h3_i2v", "minimax_h3_t2v"):
            with open(os.path.join(PLUGIN_DIR, "skills", "presets", preset, "workflow.json"),
                      encoding="utf-8") as f:
                graph = json.load(f)
            template_ids = set(graph)
            cond_id = next(nid for nid, n in graph.items()
                           if n.get("class_type") in ("MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"))
            sampler_id = next(nid for nid, n in graph.items() if n.get("class_type") == "KSampler")
            model_src = list(graph[sampler_id]["inputs"]["model"])
            cond_vae = list(graph[cond_id]["inputs"]["vae"])
            modified, overrides = h3_video_director._inject_continuity_nodes(graph, tail, 22, ["a.png"])
            nodes = sorted((int(nid), n) for nid, n in modified.items()
                           if n.get("class_type") == "NeoH3AddContext")
            self.assertEqual(len(nodes), 2, preset)
            self.assertEqual(nodes[0][1]["inputs"]["model"], model_src, preset)
            self.assertEqual(nodes[0][1]["inputs"]["conditioning"], [cond_id, 0], preset)
            self.assertEqual(nodes[0][1]["inputs"]["vae"], cond_vae, preset)
            last = str(nodes[1][0])
            self.assertEqual(modified[sampler_id]["inputs"]["model"], [last, 0], preset)
            self.assertEqual(modified[sampler_id]["inputs"]["positive"], [last, 1], preset)
            if graph[sampler_id]["inputs"]["negative"][0] == cond_id:
                self.assertEqual(modified[sampler_id]["inputs"]["negative"], [last, 1], preset)
            injected = {str(nid) for nid, _ in nodes} | set(overrides)
            for _, node in nodes:
                for name in ("identity_image", "context_image"):
                    if name in node["inputs"]:
                        injected.add(node["inputs"][name][0])
            self.assertEqual(set(modified) - injected, template_ids, preset)

    def test_continuity_injection_executes_end_to_end(self):
        """整链路：注入后的图经 mini-executor 执行，采样器拿到挂过连续性 wrapper 的模型 + 带上下文窗口的 conditioning。"""
        key = h3_video_director._CONTINUITY_WRAPPER_KEY
        vae, model = _StubH3Vae(), _FakeModelPatcher()
        _StubVaeLoader.value = vae
        _StubUnetLoader.value = model
        _StubImageLoader.value = torch.zeros(1, 768, 1344, 3)
        _StubR2V.ref_latent = torch.zeros(1, 16, 2, 2, 2)
        _StubSampler.seen = None
        registry = {
            "VAELoader": _StubVaeLoader, "UNETLoader": _StubUnetLoader, "LoadImage": _StubImageLoader,
            "MiniMaxH3ReferenceToVideo": _StubR2V, "KSampler": _StubSampler,
            "CreateVideo": _StubCreateVideo, "NeoH3AddContext": h3_video_director.NeoH3AddContext,
        }
        image_gen_edit.comfy_nodes.NODE_CLASS_MAPPINGS.update(registry)
        graph = {
            "1": {"class_type": "VAELoader", "inputs": {"vae_name": "v.safetensors"}},
            "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "u.safetensors"}},
            "5": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "vae": ["1", 0], "prompt": "p", "width": 1344, "height": 768}},
            "6": {"class_type": "KSampler", "inputs": {
                "model": ["2", 0], "positive": ["5", 0], "negative": ["5", 0],
                "latent_image": ["5", 1]}},
            "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "fps": 24}},
        }
        tail = torch.zeros(22, 768, 1344, 3)
        try:
            graph, overrides = h3_video_director._inject_continuity_nodes(graph, tail, 22, ["a.png"])
            out = image_gen_edit.execute_graph_inprocess(graph, output_type="VIDEO", overrides=overrides)
        finally:
            for name in registry:
                image_gen_edit.comfy_nodes.NODE_CLASS_MAPPINGS.pop(name, None)
        self.assertEqual(out, "VIDEO-OUT")
        seen = _StubSampler.seen
        self.assertEqual(model.clones, 1)                        # 注入链上每个节点都在上一棒上 clone 一份
        self.assertIsNot(seen["model"], model)
        self.assertEqual(seen["model"].wrappers["APPLY_MODEL"].keys(), {key})
        identity, context = vae.seen                              # 先身份图、后上下文窗口
        self.assertEqual(tuple(identity.shape), (1, 768, 1344, 3))
        self.assertEqual(tuple(context.shape), (22, 768, 1344, 3))
        for key_ in ("positive", "negative"):                    # positive/negative 都拿到注入了上下文窗口的 conditioning
            refs = seen[key_][0][1]["minimax_refs"]
            self.assertEqual([r.get("kind") for r in refs], [None, "image", "video"])
            window = refs[2]
            self.assertEqual(window["latent_t"], 7)              # 22 帧 → 7 个 latent 步
            self.assertEqual(window[h3_video_director._CONTEXT_FRAMES_MARK], 22)
            self.assertEqual(window["ref_audio_t"], 0)
            self.assertEqual(tuple(window["latent"].shape), (1, 24, 7, 48, 84))
            self.assertEqual(seen[key_][0][1]["minimax_refs"][1]["latent_h"], 48)

    def test_continuity_injection_reference_mode_skips_window_mark(self):
        """reference 模式（分镜首帧段）：窗口块照样注入，但不打上下文标记 → 时间轴不搬到目标开头。"""
        key = h3_video_director._CONTINUITY_WRAPPER_KEY
        vae, model = _StubH3Vae(), _FakeModelPatcher()
        _StubVaeLoader.value = vae
        _StubUnetLoader.value = model
        _StubImageLoader.value = torch.zeros(1, 768, 1344, 3)
        _StubR2V.ref_latent = torch.zeros(1, 16, 2, 2, 2)
        _StubSampler.seen = None
        registry = {
            "VAELoader": _StubVaeLoader, "UNETLoader": _StubUnetLoader, "LoadImage": _StubImageLoader,
            "MiniMaxH3ReferenceToVideo": _StubR2V, "KSampler": _StubSampler,
            "CreateVideo": _StubCreateVideo, "NeoH3AddContext": h3_video_director.NeoH3AddContext,
        }
        image_gen_edit.comfy_nodes.NODE_CLASS_MAPPINGS.update(registry)
        graph = {
            "1": {"class_type": "VAELoader", "inputs": {"vae_name": "v.safetensors"}},
            "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "u.safetensors"}},
            "5": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
                "vae": ["1", 0], "prompt": "p", "width": 1344, "height": 768}},
            "6": {"class_type": "KSampler", "inputs": {
                "model": ["2", 0], "positive": ["5", 0], "negative": ["5", 0],
                "latent_image": ["5", 1]}},
            "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "fps": 24}},
        }
        tail = torch.zeros(22, 768, 1344, 3)
        try:
            graph, overrides = h3_video_director._inject_continuity_nodes(graph, tail, 22, ["a.png"], "reference")
            image_gen_edit.execute_graph_inprocess(graph, output_type="VIDEO", overrides=overrides)
        finally:
            for name in registry:
                image_gen_edit.comfy_nodes.NODE_CLASS_MAPPINGS.pop(name, None)
        _, context = vae.seen
        self.assertEqual(tuple(context.shape), (22, 768, 1344, 3))
        self.assertEqual(_StubSampler.seen["model"].wrappers["APPLY_MODEL"].keys(), {key})
        window = _StubSampler.seen["positive"][0][1]["minimax_refs"][-1]
        self.assertEqual(window["latent_t"], 7)
        self.assertNotIn(h3_video_director._CONTEXT_FRAMES_MARK, window)   # 不搬时间轴


_STUB_FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
_STUB_FRAME_RESCALE = 5.0 / 3.0


def _ref_advance(ref):
    """参考块在目标之前占的时间轴推进量（与 core 的 _ref_t_span 同式）。"""
    if ref["kind"] == "image":
        return 1.0
    spans = sum(_STUB_FRAME_RESCALE * _STUB_FRAME_PER_TOKEN[k % 5] for k in range(int(ref["latent_t"])))
    return max(float(ref.get("ref_audio_t") or 0), spans)


class _FakeLayout:
    """PackedLayout 桩：只保留我们用到的契约（segments / signature / position_ids），构建顺序与 core 一致。

    与 core 同步：refs 先占目标之前的时间轴，cond 行（keyframe 锚点）与目标流从目标时间轴原点（refs 之后）起算。
    """

    def __init__(self, text_len=3, latent_t=7, frame_rows=2, refs=(), keyframes=0):
        self.signature = (text_len, latent_t, frame_rows, 2, 1)
        segments, times = [], []
        row = 0

        def add(kind, n, first_t):
            nonlocal row
            segments.append((row, row + n, kind))
            times.extend((first_t + i, 0.0, 0.0) for i in range(n))
            row += n

        add("text", text_len, 0.0)
        origin = float(text_len) + sum(_ref_advance(ref) for ref in refs)   # 目标时间轴原点 = refs 之后
        for _ in range(keyframes):
            add("cond", frame_rows, origin)
        cursor = float(text_len)
        for ref in refs:
            if int(ref.get("ref_audio_t") or 0) > 0:
                add("ref_audio", int(ref["ref_audio_t"]) * 2, cursor)
            n = frame_rows if ref["kind"] == "image" else int(ref["latent_t"]) * frame_rows
            add("ref_img", n, cursor)
            cursor += _ref_advance(ref)
        add("audio", 2, origin)
        add("video", latent_t * frame_rows, origin)
        self.segments = segments
        self.position_ids = torch.tensor(times, dtype=torch.float64)


class ContextWindowTests(unittest.TestCase):
    """跨段上下文窗口：窗口帧数/步数、参考块构造、时间轴对齐。"""

    def setUp(self):
        # 各测试模块都会重写 comfy.patcher_extension 桩（后导入者生效、跨文件恢复会摘掉它）
        pe = sys.modules.get("comfy.patcher_extension")
        if pe is None:
            pe = types.ModuleType("comfy.patcher_extension")
            pe.WrappersMP = types.SimpleNamespace()
            pe.add_wrapper_with_key = lambda *a, **k: None
            sys.modules["comfy.patcher_extension"] = pe
        wrappers = pe.WrappersMP
        if not hasattr(wrappers, "APPLY_MODEL"):
            wrappers.APPLY_MODEL = "APPLY_MODEL"

    def test_align_context_frames_snaps_to_grid(self):
        h3d = h3_video_director
        self.assertEqual([h3d._align_context_frames(n) for n in (5, 22, 39, 20, 10, 0)],
                         [5, 22, 39, 22, 5, 5])

    def test_context_latent_t_matches_h3_grid(self):
        h3d = h3_video_director
        self.assertEqual([h3d._context_latent_t(n) for n in (5, 22, 39)], [2, 7, 12])

    def test_align_frame_count_nearest_keeps_window_sized_total(self):
        h3d = h3_video_director
        # 124 帧段 + 22 帧窗口 = 146 → 就近取 141（交付 119），不是向上取 158
        self.assertEqual(h3d._align_frame_count_nearest(146, minimum=27), 141)
        # 124 帧段 + 5 帧窗口 = 129 → 124（交付 119）
        self.assertEqual(h3d._align_frame_count_nearest(129, minimum=10), 124)
        # 低于下限时落到不低于下限的最近网格点（22 帧窗口的下限 27 → 39）
        self.assertEqual(h3d._align_frame_count_nearest(10, minimum=27), 39)
        # 不带窗口时与原有向上对齐一致
        self.assertEqual(h3d._align_frame_count_nearest(124), 124)

    def _node(self, context_frames=22, identity=None):
        """跑一次 NeoH3AddContext（已有 1 条参考），返回 (patched_model, cond, vae, 原 model)。"""
        vae = _StubH3Vae()
        model = _FakeModelPatcher()
        refs = [{"kind": "image", "latent": torch.zeros(1, 16, 2, 2, 2)}]
        cond = [["tokens", {"minimax_refs": refs}]]
        patched, out = h3_video_director.NeoH3AddContext().add_context(
            model, cond, vae, 1344, 768, context_image=torch.zeros(context_frames, 768, 1344, 3),
            identity_image=identity, context_frames=context_frames)
        return patched, out, vae, model

    def test_context_node_appends_video_ref_to_existing_refs(self):
        patched, out, vae, model = self._node()
        self.assertEqual([tuple(f.shape) for f in vae.seen], [(22, 768, 1344, 3)])
        refs = out[0][1]["minimax_refs"]
        self.assertEqual(len(refs), 2)                                   # 原有参考保留 + 追加窗口
        window = refs[1]
        self.assertEqual((window["kind"], window["latent_t"], window["ref_audio_t"]), ("video", 7, 0))
        self.assertEqual((window["latent_h"], window["latent_w"]), (48, 84))
        self.assertEqual(window[h3_video_director._CONTEXT_FRAMES_MARK], 22)
        self.assertIsNone(window["audio_latent"])
        self.assertEqual(patched.wrappers["APPLY_MODEL"].keys(),
                         {h3_video_director._CONTINUITY_WRAPPER_KEY})
        self.assertEqual(model.clones, 1)

    def test_context_node_encodes_identity_batch_per_image(self):
        _, out, vae, _ = self._node(identity=torch.zeros(2, 768, 1344, 3))
        refs = out[0][1]["minimax_refs"]
        self.assertEqual([r.get("kind") for r in refs], ["image", "image", "image", "video"])
        self.assertEqual([tuple(r["latent"].shape) for r in refs[1:3]], [(1, 24, 1, 48, 84)] * 2)
        self.assertEqual([tuple(f.shape) for f in vae.seen[:2]], [(1, 768, 1344, 3)] * 2)

    def test_context_node_without_images_passes_through(self):
        model = _FakeModelPatcher()
        cond = [["tokens", {"minimax_refs": []}]]
        patched, out = h3_video_director.NeoH3AddContext().add_context(
            model, cond, _StubH3Vae(), 1344, 768, context_frames=0)
        self.assertIs(patched, model)
        self.assertIs(out, cond)
        self.assertEqual(model.clones, 0)

    def test_ref_row_ranges_follow_layout_order(self):
        """video_audio 参考先占 ref_audio 行、再占 ref_img 行（消费顺序与 PackedLayout 构建顺序一致）。"""
        refs = [{"kind": "video", "latent_t": 3, "ref_audio_t": 2}, {"kind": "image"}]
        layout = _FakeLayout(refs=refs)
        rows = h3_video_director._ref_row_ranges(layout, refs)
        self.assertEqual(rows[0]["audio"], layout.segments[1][:2])
        self.assertEqual(rows[0]["video"], layout.segments[2][:2])
        self.assertEqual(rows[1]["video"], layout.segments[3][:2])
        self.assertIsNone(rows[1]["audio"])

    def test_align_payload_timeline_moves_context_rows_onto_target(self):
        """上下文窗口行整体搬到目标视频开头的行上（ref 行默认从 text_len 起算，与目标时间轴错开一个窗口）。"""
        refs = [{"kind": "image", "latent_t": 1, "latent": torch.zeros(1)},
                {"kind": "video", "latent_t": 7, "ref_audio_t": 0, "latent": torch.zeros(1),
                 h3_video_director._CONTEXT_FRAMES_MARK: 22}]
        layout = _FakeLayout(refs=refs)
        payload = {"layout": layout, "refs": refs}
        video_start, video_stop = layout.segments[-1][:2]
        target = layout.position_ids[video_start:video_stop].clone()
        window_start, window_stop = layout.segments[2][:2]
        h3_video_director._align_payload_timeline(payload)
        self.assertTrue(torch.equal(layout.position_ids[window_start:window_stop], target[:14]))
        self.assertTrue(torch.equal(layout.position_ids[video_start:video_stop], target))   # 目标行一个没动
        self.assertTrue(getattr(layout, h3_video_director._CONTEXT_ALIGNED_ATTR))

    def test_align_payload_timeline_keeps_keyframe_anchors_on_target_origin(self):
        """锚点行不动：core 已让 refs 先占位、keyframe 锚点从目标时间轴原点起算。"""
        refs = [{"kind": "image", "latent_t": 1, "latent": torch.zeros(1)}]
        layout = _FakeLayout(refs=refs, keyframes=1)
        payload = {"layout": layout, "refs": refs}
        cond_start = layout.segments[1][0]
        video_start = layout.segments[-1][0]
        before = float(layout.position_ids[cond_start, 0])
        target_t = float(layout.position_ids[video_start, 0])
        self.assertAlmostEqual(before, target_t)                     # 建好时锚点就在目标原点
        self.assertAlmostEqual(before - layout.signature[0], 1.0)    # 目标原点 = text_len + refs 推进量
        h3_video_director._align_payload_timeline(payload)
        self.assertAlmostEqual(float(layout.position_ids[cond_start, 0]), target_t)

    def test_align_payload_timeline_is_idempotent_and_skips_without_layout(self):
        refs = [{"kind": "video", "latent_t": 7, "ref_audio_t": 0, "latent": torch.zeros(1),
                 h3_video_director._CONTEXT_FRAMES_MARK: 22}]
        layout = _FakeLayout(refs=refs)
        payload = {"layout": layout, "refs": refs}
        h3_video_director._align_payload_timeline(payload)
        snapshot = layout.position_ids.clone()
        h3_video_director._align_payload_timeline(payload)
        self.assertTrue(torch.equal(layout.position_ids, snapshot))
        h3_video_director._align_payload_timeline({})                # 没有 layout 时什么都不做

    def test_align_payload_timeline_rejects_window_larger_than_target(self):
        refs = [{"kind": "video", "latent_t": 12, "ref_audio_t": 0, "latent": torch.zeros(1),
                 h3_video_director._CONTEXT_FRAMES_MARK: 39}]
        layout = _FakeLayout(latent_t=7, refs=refs)
        with self.assertRaises(RuntimeError) as ctx:
            h3_video_director._align_payload_timeline({"layout": layout, "refs": refs})
        self.assertIn("超过目标视频", str(ctx.exception))


class SeamBlendTests(unittest.TestCase):
    """段间接缝交叉淡化：_blend_seam 的权重、边界与编排效果。"""

    def test_blend_ramps_new_version_in_over_overlap_tail(self):
        prev = torch.zeros(5, 2, 2, 3)
        new = torch.ones(4, 2, 2, 3)
        out = h3_video_director._blend_seam(prev, new, drop=3, blend=2)
        # 只动最后 2 帧：权重 1/3 → 2/3 给了本段新版本
        self.assertTrue(torch.all(out[:-2] == 0))
        self.assertAlmostEqual(float(out[-2][0, 0, 0]), 1 / 3, places=6)
        self.assertAlmostEqual(float(out[-1][0, 0, 0]), 2 / 3, places=6)
        self.assertEqual(out.shape, prev.shape)

    def test_blend_uses_overlap_tail_of_new_segment(self):
        # 新段的 frames[:drop] 是重合区；取其中最后 blend 帧参与融合
        prev = torch.full((3, 1, 1, 1), 0.0)
        new = torch.tensor([[10.0], [20.0], [30.0], [40.0]]).view(4, 1, 1, 1)
        out = h3_video_director._blend_seam(prev, new, drop=3, blend=1)
        self.assertAlmostEqual(float(out[-1][0, 0, 0]), 30.0 / 2, places=6)   # 用 new[2]，不是 new[3]

    def test_blend_disabled_and_degenerate_cases(self):
        prev = torch.zeros(4, 2, 2, 3)
        new = torch.ones(4, 2, 2, 3)
        short = prev[:2]
        self.assertIs(h3_video_director._blend_seam(prev, new, drop=3, blend=0), prev)      # 关闭
        self.assertIs(h3_video_director._blend_seam(prev, new, drop=0, blend=6), prev)      # 无重合
        self.assertIs(h3_video_director._blend_seam(short, new, drop=3, blend=6), short)    # 上一段太短
        mismatched = torch.ones(4, 4, 4, 3)
        self.assertIs(h3_video_director._blend_seam(prev, mismatched, drop=3, blend=2), prev)   # 分辨率不同

    def test_window_run_blends_seam_frames_in_place(self):
        # 两段：首段全 0、次段全 1，window=22 → 接缝最后 6 帧应是 1/7..6/7，总帧数/时长不变
        h3d = h3_video_director
        orig = (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
                h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
                h3d.execute_graph_inprocess, h3d._require_vdn_plugin)
        _orig_inject = h3d._inject_continuity_nodes
        it = iter([_ConstFakeVideo(124, 0.0), _ConstFakeVideo(141, 1.0)])
        segments = [{"skill_id": "s0", "prompt": "p0", "duration_sec": 5, "mode": "t2v"},
                    {"skill_id": "s1", "prompt": "p1", "duration_sec": 5, "mode": "t2v"}]
        h3d.load_director_spec = lambda name: {"shared": {"width": 8, "height": 8, "seed": 0, "chunk_sec": 0}, "segments": segments}
        h3d._resolve_skill_id = lambda v: v
        h3d.load_skill_workflow = lambda id: {"1": {}}
        h3d.get_skill_gen_config = lambda id: {}
        h3d.resolve_video_params = lambda body, cfg, **kw: {"prompt": body["prompt"]}
        h3d.render_template = lambda tpl, params: ({"g": 1}, [])
        h3d._require_vdn_plugin = lambda graph: None
        h3d._inject_continuity_nodes = lambda graph, tail, window, names=(), mode="window": (graph, None)   # 图是桩，跳过注入
        h3d.execute_graph_inprocess = lambda graph, output_type="IMAGE", **kw: next(it)
        try:
            (video,) = h3d.NeoH3VideoDirector().generate("r", continuity=True, context_frames=22)
        finally:
            (h3d.load_director_spec, h3d._resolve_skill_id, h3d.load_skill_workflow,
             h3d.get_skill_gen_config, h3d.resolve_video_params, h3d.render_template,
             h3d.execute_graph_inprocess, h3d._require_vdn_plugin) = orig
            h3d._inject_continuity_nodes = _orig_inject
        frames = video.get_components().images
        self.assertEqual(frames.shape[0], 124 + 119, "接缝淡化不改变总帧数（141-22 帧入片）")
        self.assertTrue(torch.all(frames[:118] == 0))
        blend = [round(float(v), 6) for v in frames[118:124, 0, 0, 0]]
        self.assertEqual(blend, [round(i / 7, 6) for i in range(1, 7)], "接缝 6 帧按 1/7..6/7 渐入本段")
        self.assertTrue(torch.all(frames[124:] == 1))


class _ConstFakeVideo:
    """所有帧填同一常量（便于断言接缝混合结果）。"""

    def __init__(self, n_frames, value, frame_rate=24, sample_rate=48000):
        self._images = torch.full((n_frames, 8, 8, 3), float(value))
        spf = sample_rate // frame_rate
        self._audio = {"waveform": torch.zeros(1, 1, n_frames * spf), "sample_rate": sample_rate}

    def get_components(self):
        return _FakeComp(self._images, self._audio)


# ===========================================================================
# 图片分镜（storyboard）：字段持久化 / 尺寸解析 / 多参考截断 / Qwen 2.1 模板裁剪 / 端到端生成
# ===========================================================================

def _write_png(path: str, width: int = 8, height: int = 6) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with Image.new("RGB", (width, height), (30, 120, 200)) as img:
        img.save(path, format="PNG")


class StoryboardFieldTests(unittest.TestCase):
    def test_normalize_keeps_storyboard_fields(self):
        # 分镜关键帧是配方资产：与 first_frame 同源，按已落盘资产名保留（不再查 input）
        shared, segs = recipes._normalize_director(
            {"shared": {}, "segments": [
                {"skill_id": "h3_t2v", "prompt": "p",
                 "storyboard": "storyboard_sb-dir_01.png", "storyboard_prompt": "<image1>中的女孩"},
            ]}, {}, {"storyboard_sb-dir_01.png"})
        self.assertEqual(segs[0]["storyboard"], "storyboard_sb-dir_01.png")
        self.assertEqual(segs[0]["storyboard_prompt"], "<image1>中的女孩")

    def test_normalize_drops_missing_storyboard_ref(self):
        # 关键帧不在配方资产里（旧配方的 input 产物已清理）：丢掉引用、不阻塞保存，提示词快照保留
        shared, segs = recipes._normalize_director(
            {"shared": {}, "segments": [
                {"skill_id": "h3_t2v", "prompt": "p", "storyboard": "nope.png",
                 "storyboard_prompt": "画面描述"}]}, {})
        self.assertNotIn("storyboard", segs[0])
        self.assertEqual(segs[0]["storyboard_prompt"], "画面描述")

    def test_normalize_rewrites_storyboard_to_copied_name(self):
        # 本次保存新拷贝的资产：原始名回写为落盘最终名（同名不同内容可能被重命名）
        shared, segs = recipes._normalize_director(
            {"shared": {}, "segments": [
                {"skill_id": "h3_t2v", "prompt": "p", "storyboard": "storyboard_sb-dir_01.png"}]},
            {"storyboard_sb-dir_01.png": "storyboard_sb-dir_01_1.png"})
        self.assertEqual(segs[0]["storyboard"], "storyboard_sb-dir_01_1.png")

    def test_parse_segments_keeps_storyboard_prompt(self):
        raw = json.dumps([
            {"prompt": "视频提示词", "duration_sec": 5, "storyboard_prompt": "构图描述"},
            {"prompt": "第二段", "duration_sec": 8},   # 缺省 storyboard_prompt → 不写字段
        ])
        segs = recipes._parse_segments(raw)
        self.assertEqual(segs[0]["storyboard_prompt"], "构图描述")
        self.assertNotIn("storyboard_prompt", segs[1])


class StoryboardDimsTests(unittest.TestCase):
    def test_explicit_width_height(self):
        self.assertEqual(storyboard._storyboard_dims(800, 600, None), (800, 608))

    def test_ratio_uses_1024_base(self):
        self.assertEqual(storyboard._storyboard_dims(0, 0, "1:1"), (1024, 1024))

    def test_default_is_1024_square(self):
        # 无显式宽高/比例时走设置默认（base 1024、1:1）
        self.assertEqual(storyboard._storyboard_dims(None, None, None), (1024, 1024))

    def test_16_9_ratio(self):
        w, h = storyboard._storyboard_dims(None, None, "16:9")
        self.assertAlmostEqual(w / h, 16 / 9, places=2)


class StoryboardStoryRefsTests(unittest.TestCase):
    """_storyboard_story_refs 从 recipe["story"] 取角色参考图（键名修复：不再误读 director_story）。"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="neo_sbrefs_")
        self.custom = os.path.join(self._tmp, "custom")
        os.makedirs(self.custom)
        import pathlib
        self._orig_custom = recipes.CUSTOM_DIR
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)
        self.recipe_dir = os.path.join(self.custom, "refs-recipe")
        os.makedirs(os.path.join(self.recipe_dir, "assets"))
        with open(os.path.join(self.recipe_dir, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "refs-recipe", "type": "video_director",
                       "story": {"characters": [{"filename": "char.png"}]}}, f)
        _write_png(os.path.join(self.recipe_dir, "assets", "char.png"))
        # 桩掉拷贝（确定性返回文件名）：只验证键名读取与顺序，不测内容去重改名
        self._orig_copy = storyboard._copy_media_to_input
        storyboard._copy_media_to_input = lambda src, fn: (fn, False)

    def tearDown(self):
        storyboard._copy_media_to_input = self._orig_copy
        recipes.CUSTOM_DIR = self._orig_custom
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_reads_story_key_characters(self):
        # 真实配方把故事存在 recipe["story"]；第 1 张为 Qwen Image 2.1 编辑目标
        self.assertEqual(storyboard._storyboard_story_refs("refs-recipe"), ["char.png"])

    def test_missing_asset_file_skipped(self):
        os.remove(os.path.join(self.recipe_dir, "assets", "char.png"))
        self.assertEqual(storyboard._storyboard_story_refs("refs-recipe"), [])

    def test_no_story_key_returns_empty(self):
        # 旧配方没有 story 键 → 空列表（不报错）
        with open(os.path.join(self.recipe_dir, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "refs-recipe", "type": "video_director"}, f)
        self.assertEqual(storyboard._storyboard_story_refs("refs-recipe"), [])


class DirectorIdentityRefsTests(unittest.TestCase):
    """load_director_spec 把配方「角色参考图」（story.characters）解析成 identity_images（视频身份参考）。"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="neo_idrefs_")
        self.custom = os.path.join(self._tmp, "custom")
        os.makedirs(self.custom)
        import pathlib
        self._orig_custom = recipes.CUSTOM_DIR
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)
        # 桩掉拷贝（确定性返回文件名）：只验证读取顺序 / 去重 / 截断，不测内容去重改名
        self._orig_copy = recipes._copy_media_to_input
        recipes._copy_media_to_input = lambda src, fn: (fn, False)
        self.recipe_dir = os.path.join(self.custom, "id-recipe")
        os.makedirs(os.path.join(self.recipe_dir, "assets"))

    def tearDown(self):
        recipes._copy_media_to_input = self._orig_copy
        recipes.CUSTOM_DIR = self._orig_custom
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _write_recipe(self, story=None, segments=None, shared=None):
        body = {"name": "id-recipe", "type": "video_director", "shared": shared or {},
                "segments": segments or [{"skill_id": "h3_t2v", "prompt": "p"}]}
        if story is not None:
            body["story"] = story
        with open(os.path.join(self.recipe_dir, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump(body, f)

    def _write_asset(self, name):
        _write_png(os.path.join(self.recipe_dir, "assets", name))

    def test_characters_become_identity_images(self):
        self._write_recipe({"characters": [{"filename": "char.png"}, {"filename": "char2.png"}]})
        for name in ("char.png", "char2.png"):
            self._write_asset(name)
        spec = recipes.load_director_spec("id-recipe")
        self.assertEqual(spec["identity_images"], ["char.png", "char2.png"])

    def test_missing_asset_and_duplicate_skipped(self):
        self._write_recipe({"characters": [{"filename": "char.png"}, {"filename": "gone.png"},
                                           {"filename": "char.png"}]})
        self._write_asset("char.png")
        self.assertEqual(recipes.load_director_spec("id-recipe")["identity_images"], ["char.png"])

    def test_capped_at_four(self):
        self._write_recipe({"characters": [{"filename": f"c{i}.png"} for i in range(5)]})
        for i in range(5):
            self._write_asset(f"c{i}.png")
        self.assertEqual(recipes.load_director_spec("id-recipe")["identity_images"],
                         ["c0.png", "c1.png", "c2.png", "c3.png"])

    def test_no_characters_omits_identity_images(self):
        self._write_recipe({"idea": "只有主题"})
        self.assertNotIn("identity_images", recipes.load_director_spec("id-recipe"))

    def test_disabled_switch_skips_identity_images(self):
        # 界面上关掉「角色身份参考」→ 不解析也不注入（对比测试用）
        story = {"characters": [{"filename": "char.png"}]}
        self._write_recipe(story, shared={"identity_refs": False})
        self._write_asset("char.png")
        self.assertNotIn("identity_images", recipes.load_director_spec("id-recipe"))
        self._write_recipe(story, shared={"identity_refs": True})
        self.assertEqual(recipes.load_director_spec("id-recipe")["identity_images"], ["char.png"])


class StoryboardGenerateTests(unittest.TestCase):
    """端到端（桩掉生图执行）：参考解析/链式/文件名/幂等跳过/单段重生成序号对齐。"""

    # Qwen Image 2.1 同款模板：4 个参考槽未挂时连同 LoadImage 裁掉，TextEncodeQwenImage21 保留
    _TEMPLATE = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "c.safetensors", "type": "qwen_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "v.safetensors"}},
        "4": {"class_type": "TextEncodeQwenImage21", "inputs": {
            "clip": ["2", 0], "prompt": "{{PROMPT}}", "negative_prompt": "{{NEGATIVE}}",
            "vae": ["3", 0],
            "images.image_1": ["10", 0], "images.image_2": ["12", 0],
            "images.image_3": ["14", 0], "images.image_4": ["16", 0]}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": "{{WIDTH}}", "height": "{{HEIGHT}}", "batch_size": 1}},
        "6": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "seed": "{{SEED}}", "steps": 25, "cfg": 1.0,
            "sampler_name": "euler", "scheduler": "simple",
            "positive": ["4", 0], "negative": ["4", 1], "latent_image": ["5", 0], "denoise": 1.0}},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "{{PREFIX}}"}},
        "10": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_1}}"}},
        "12": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_2}}"}},
        "14": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_3}}"}},
        "16": {"class_type": "LoadImage", "inputs": {"image": "{{REF_IMAGE_4}}"}},
    }

    @staticmethod
    def _refs_of(graph):
        """从渲染后的图里按序取挂上的参考图名（未挂槽位已被裁掉）。"""
        inputs = graph["4"]["inputs"]
        refs = []
        for i in (1, 2, 3, 4):
            key = f"images.image_{i}"
            if key not in inputs:
                break
            src_id = inputs[key][0]   # LoadImage 节点 id
            refs.append(graph[src_id]["inputs"]["image"])
        return refs

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="neo_sbrec_")
        self.custom = os.path.join(self._tmp, "custom")
        os.makedirs(self.custom)
        import pathlib
        self._orig_custom = recipes.CUSTOM_DIR
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)

        self.recipe_dir = os.path.join(self.custom, "sb-e2e")
        # 关键帧的落盘位置就是配方 assets/（与 storyboard.py 一致）
        self.assets_dir = os.path.join(self.recipe_dir, "assets")
        os.makedirs(self.assets_dir, exist_ok=True)
        with open(os.path.join(self.recipe_dir, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "sb-e2e", "type": "video_director", "shared": {},
                       "story": {"characters": [{"filename": "char.png"}]}}, f)
        _write_png(os.path.join(self.recipe_dir, "assets", "char.png"))
        # _storyboard_story_refs 被桩成返回 ["char.png"]（相对 input 目录）；resolve_request 会校验文件存在，
        # 故需在 input 目录放一份同名图。
        _write_png(os.path.join(_INPUT_DIR, "char.png"))

        self.captured = []   # 每次 execute_graph_inprocess 收到的 (参考图列表, prompt)

        def _fake_execute(graph, *args):
            self.captured.append((self._refs_of(graph), graph["4"]["inputs"]["prompt"],
                                  graph["6"]["inputs"]["seed"]))   # (参考图, prompt, KSampler seed)
            return torch.zeros(1, 8, 6, 3)   # IMAGE 张量 [B,H,W,C]（execute_graph_inprocess 真实契约）

        orig = (storyboard.load_skill_workflow, storyboard.get_skill_gen_config,
                storyboard._storyboard_story_refs, storyboard.execute_graph_inprocess)
        self.orig = orig
        storyboard.load_skill_workflow = lambda sid: json.loads(json.dumps(self._TEMPLATE))
        storyboard.get_skill_gen_config = lambda sid: {}
        storyboard._storyboard_story_refs = lambda name: ["char.png"]
        storyboard.execute_graph_inprocess = _fake_execute

    def tearDown(self):
        (storyboard.load_skill_workflow, storyboard.get_skill_gen_config,
         storyboard._storyboard_story_refs, storyboard.execute_graph_inprocess) = self.orig
        recipes.CUSTOM_DIR = self._orig_custom

    def _generate(self, **extra):
        """提交生成请求并在同一事件循环里轮询到结束（后台任务跑在提交时的循环上）。seed=None 时省略该字段。"""
        payload = {"name": "sb-e2e", "skill_id": "qwen_image_21"}
        seed = extra.pop("seed", 7)
        if seed is not None:
            payload["seed"] = seed
        payload.update(extra)

        class _Req:
            async def json(self):
                return payload

        status_req = types.SimpleNamespace(match_info={})
        loop = asyncio.new_event_loop()
        try:
            resp = loop.run_until_complete(storyboard.neo_video_gen_storyboard_generate(_Req()))
            self.assertEqual(resp.status, 200, f"生成请求失败：{resp.body}")
            data = json.loads(resp.body)
            status_req.match_info["task_id"] = data["task_id"]
            for _ in range(200):
                loop.run_until_complete(asyncio.sleep(0.01))   # 让后台任务推进（桩执行无真实 I/O）
                st = json.loads(loop.run_until_complete(
                    storyboard.neo_video_gen_storyboard_status(status_req)).body)
                if st["status"] in ("done", "cancelled", "failed"):
                    return st
            self.fail("分镜任务未在限定轮次内结束")
        finally:
            loop.close()

    def test_batch_generation_uses_story_refs(self):
        st = self._generate(segments=[{"prompt": "段一"}, {"prompt": "段二"}, {"prompt": "段三"}])
        self.assertEqual(st["status"], "done")
        for d in st["details"]:
            self.assertEqual(d["status"], "done", f"第 {d['index']} 段失败：{d['error']}")
        for n in (1, 2, 3):
            self.assertTrue(os.path.isfile(os.path.join(self.assets_dir, f"storyboard_sb-e2e_{n:02d}.png")))

        # 参考图：只有角色/背景（各段相同，不再链式带前一分镜）
        for c in self.captured:
            self.assertEqual(c[0], ["char.png"])

    def test_ref_segments_switch_to_qwen_for_reference_edit(self):
        # 旧行为（请求不带 mode）：带参考图的段固定切 Qwen Image 2.1 参考编辑并在段上留 warning
        asked = []

        def _load(sid):
            asked.append(sid)
            return json.loads(json.dumps(self._TEMPLATE))

        storyboard.load_skill_workflow = _load
        st = self._generate(segments=[{"prompt": "段一", "storyboard_prompt": "首帧一"},
                                      {"prompt": "段二", "storyboard_prompt": "首帧二"}], skill_id="image_gen")
        self.assertEqual(st["status"], "done")
        # 端点校验一次 + 逐段懒加载：带角色参考的段都切 Qwen Image 2.1
        self.assertEqual(asked[-2:], ["image_gen", "qwen_image_21"])
        for d in st["details"]:
            self.assertTrue(any("Qwen Image 2.1" in w for w in d["warnings"]))

    def test_mode_t2i_ignores_story_refs(self):
        # t2i 纯文生图：即使配方有角色参考，也不挂任何参考图、不切技能
        asked = []

        def _load(sid):
            asked.append(sid)
            return json.loads(json.dumps(self._TEMPLATE))

        storyboard.load_skill_workflow = _load
        st = self._generate(segments=[{"prompt": "段一", "storyboard_prompt": "首帧一"},
                                      {"prompt": "段二", "storyboard_prompt": "首帧二"}],
                            skill_id="image_gen", mode="t2i")
        self.assertEqual(st["status"], "done")
        for d in st["details"]:
            self.assertEqual(d["warnings"], [])
        # 两段都是纯文生图：无参考图，技能始终是所选 Krea2（不切 Qwen）
        self.assertEqual(self.captured[0][0], [])
        self.assertEqual(self.captured[1][0], [])
        self.assertTrue(all(sid == "image_gen" for sid in asked))

    def test_mode_r2i_keeps_refs_without_forced_skill_switch(self):
        # r2i 参考编辑：角色参考照常挂上，但按所选技能执行（不强制切 Qwen、无切换 warning）
        asked = []

        def _load(sid):
            asked.append(sid)
            return json.loads(json.dumps(self._TEMPLATE))

        storyboard.load_skill_workflow = _load
        st = self._generate(segments=[{"prompt": "段一", "storyboard_prompt": "首帧一"},
                                      {"prompt": "段二", "storyboard_prompt": "首帧二"}],
                            skill_id="image_gen", mode="r2i")
        self.assertEqual(st["status"], "done")
        for d in st["details"]:
            self.assertEqual(d["warnings"], [])
        # 各段都只带角色参考（不链式带前一分镜）
        for c in self.captured:
            self.assertEqual(c[0], ["char.png"])
        self.assertTrue(all(sid == "image_gen" for sid in asked), "r2i 不强制切 Qwen Image 2.1")

    def test_storyboard_prompt_is_what_gets_rendered(self):
        # 分镜图用 storyboard_prompt（拆分 LLM 产出的静态画面提示词），不是视频段提示词；无回退 warning
        st = self._generate(segments=[{"prompt": "镜头跟随她走进大厅", "storyboard_prompt": "女孩站在门内，中景，暖光"}])
        self.assertEqual(st["status"], "done")
        self.assertEqual(self.captured[0][1], "女孩站在门内，中景，暖光")
        self.assertEqual(st["details"][0]["warnings"], [])

    def test_missing_storyboard_prompt_falls_back_with_warning(self):
        # 旧配方 / 缺 storyboard_prompt：回退视频提示词，但必须留 warning 让用户看见（视频提示词含运动描述）
        st = self._generate(segments=[{"prompt": "镜头跟随她走进大厅"}])
        self.assertEqual(st["status"], "done")
        self.assertEqual(self.captured[0][1], "镜头跟随她走进大厅")
        self.assertTrue(any("回退" in w for w in st["details"][0]["warnings"]))

    def test_invalid_mode_rejected(self):
        class _Req:
            async def json(self):
                return {"name": "sb-e2e", "segments": [{"prompt": "段一"}], "mode": "v2i"}

        loop = asyncio.new_event_loop()
        try:
            resp = loop.run_until_complete(storyboard.neo_video_gen_storyboard_generate(_Req()))
        finally:
            loop.close()
        self.assertEqual(resp.status, 400)
        self.assertIn("未知的分镜模式", json.loads(resp.body)["error"])

    def test_existing_storyboards_skipped_without_force(self):
        # 已有产物在配方 assets/ 里：非 force 时幂等跳过，只补缺失段
        _write_png(os.path.join(self.assets_dir, "storyboard_sb-e2e_01.png"))
        self.captured.clear()
        st = self._generate(segments=[{"prompt": "段一"}, {"prompt": "段二"}])
        self.assertEqual(st["status"], "done")
        self.assertEqual(len(self.captured), 1, "已有产物应跳过、只生成缺失的第 2 段")
        self.assertEqual(st["details"][0]["filename"], "storyboard_sb-e2e_01.png")

    def test_force_regenerates_existing_storyboard(self):
        # 再次点「🎨 生成图片分镜」带 force=True：已有产物的段也重新生成（不做幂等跳过）
        _write_png(os.path.join(self.assets_dir, "storyboard_sb-e2e_01.png"))
        self.captured.clear()
        st = self._generate(segments=[{"prompt": "段一"}, {"prompt": "段二"}], force=True)
        self.assertEqual(st["status"], "done")
        self.assertEqual(len(self.captured), 2, "force：两段都重新生成（含已有产物的一段）")

    def test_force_without_seed_uses_fresh_random_base(self):
        # 强制重生成且未钉种子 → 换新随机基（否则同 seed → 同图，重生成无意义）；显式钉的 seed 不受影响。
        # 同一次生成内各段共用同一 seed（不再按段序号偏移）。
        _write_png(os.path.join(self.assets_dir, "storyboard_sb-e2e_01.png"))
        self.captured.clear()
        orig_randint = random.randint
        random.randint = lambda a, b: 987654
        try:
            st = self._generate(segments=[{"prompt": "段一"}, {"prompt": "段二"}], force=True, seed=None)
        finally:
            random.randint = orig_randint
        self.assertEqual(st["status"], "done")
        # 两段共用新基 987654（不再是旧默认 0+n）
        self.assertEqual([c[2] for c in self.captured], [987654, 987654])

    def test_single_segment_regen_aligns_index(self):
        # 单段重生成（index=2）：文件名对齐真实序号 _03，参考图只带角色/背景
        self.captured.clear()
        st = self._generate(segments=[{"prompt": "重生成第3段"}], index=2, force=True)
        self.assertEqual(st["status"], "done")
        self.assertEqual(st["details"][0]["status"], "done", st["details"][0].get("error"))
        self.assertTrue(os.path.isfile(os.path.join(self.assets_dir, "storyboard_sb-e2e_03.png")))
        self.assertEqual(self.captured[0][0], ["char.png"])

    def test_interrupt_mid_run_cancels_cleanly(self):
        # 用户点「取消」→ execute_graph_inprocess 抛 InterruptProcessingException（继承 BaseException）。
        # 修复前 except Exception 接不住：任务异常从未被取回、状态卡在 running。修复后捕获并置 cancelled。
        calls = {"n": 0}

        def _exec_interrupt_on_second(graph, *args):
            calls["n"] += 1
            if calls["n"] >= 2:
                raise _comfy_mm.InterruptProcessingException()
            return torch.zeros(1, 8, 6, 3)

        storyboard.execute_graph_inprocess = _exec_interrupt_on_second
        st = self._generate(segments=[{"prompt": "段一"}, {"prompt": "段二"}])
        self.assertEqual(st["status"], "cancelled")
        self.assertEqual(st["details"][0]["status"], "done")
        self.assertNotEqual(st["details"][1]["status"], "done")

    def test_setup_error_marks_task_failed(self):
        # 循环外的 setup（_storyboard_story_refs）抛异常会逃出 _run_storyboard_task；
        # done callback 取回异常并置 failed，避免 "Task exception was never retrieved"、状态卡 running。
        def _boom(name):
            raise RuntimeError("recipe read blew up")

        storyboard._storyboard_story_refs = _boom
        st = self._generate(segments=[{"prompt": "段一"}])
        self.assertEqual(st["status"], "failed")


class StoryboardInProcessProgressTests(unittest.TestCase):
    """e2e：后台分镜任务进程内执行时，采样进度上报不得因缺 last_prompt_id 崩。

    复现线上故障链：storyboard 走 asyncio.to_thread 进程内跑生图、不经 ComfyUI 队列，PromptServer
    没有 last_prompt_id；KSampler 采样经 comfy.utils 全局钩子上报进度（不带 prompt_id），hijack_progress
    无执行上下文时回退读 server_instance.last_prompt_id → AttributeError。修复后 _run_storyboard_task
    用 CurrentNodeContext 提供 prompt_id=task_id，进度正常上报、任务跑完（去掉该 wrapper 本用例即失败）。"""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="neo_sbprog_")
        self.custom = os.path.join(self._tmp, "custom")
        os.makedirs(self.custom)
        import pathlib
        self._orig_custom = recipes.CUSTOM_DIR
        recipes.CUSTOM_DIR = pathlib.Path(self.custom)

        self.recipe_dir = os.path.join(self.custom, "sb-prog")
        self.assets_dir = os.path.join(self.recipe_dir, "assets")
        os.makedirs(self.assets_dir, exist_ok=True)
        with open(os.path.join(self.recipe_dir, "recipe.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "sb-prog", "type": "video_director", "shared": {},
                       "story": {"characters": []}}, f)

        # 进度钩子：与 main.py hijack_progress 同语义（无执行上下文时回退读 last_prompt_id）。
        self.updates = []
        srv = _server.PromptServer.instance
        self._had_last_prompt_id = hasattr(srv, "last_prompt_id")
        if self._had_last_prompt_id:
            del srv.last_prompt_id   # 后台任务真实状态：没有 last_prompt_id

        def _hook(value, total, preview_image=None, prompt_id=None, node_id=None):
            ctx = _comfy_exec_utils.get_executing_context()
            if prompt_id is None and ctx is not None:
                prompt_id = ctx.prompt_id
            if node_id is None and ctx is not None:
                node_id = ctx.node_id
            if prompt_id is None:
                prompt_id = srv.last_prompt_id   # ← 崩溃点：无上下文且缺 last_prompt_id
            self.updates.append((prompt_id, node_id, value, total))

        self._orig_hook = _comfy_utils.PROGRESS_BAR_HOOK
        _comfy_utils.PROGRESS_BAR_HOOK = _hook

        def _fake_execute(graph, *args):
            hook = _comfy_utils.PROGRESS_BAR_HOOK
            if hook is not None:
                for step in range(1, 4):   # KSampler 采样进度：不带 prompt_id（真实 ProgressBar 行为）
                    hook(step, 3, node_id=None)
            return torch.zeros(1, 8, 6, 3)

        self._orig = (storyboard.load_skill_workflow, storyboard.get_skill_gen_config,
                      storyboard._storyboard_story_refs, storyboard.render_template,
                      storyboard.execute_graph_inprocess)
        storyboard.load_skill_workflow = lambda sid: {}
        storyboard.get_skill_gen_config = lambda sid: {}
        storyboard._storyboard_story_refs = lambda name: []
        storyboard.render_template = lambda template, params: ({}, [])   # 图内容无关（execute 已桩）
        storyboard.execute_graph_inprocess = _fake_execute

    def tearDown(self):
        (storyboard.load_skill_workflow, storyboard.get_skill_gen_config,
         storyboard._storyboard_story_refs, storyboard.render_template,
         storyboard.execute_graph_inprocess) = self._orig
        _comfy_utils.PROGRESS_BAR_HOOK = self._orig_hook
        srv = _server.PromptServer.instance
        if self._had_last_prompt_id:
            srv.last_prompt_id = None
        recipes.CUSTOM_DIR = self._orig_custom
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _generate(self):
        payload = {"name": "sb-prog", "skill_id": "qwen_image_21", "seed": 7,
                   "segments": [{"prompt": "段一"}]}

        class _Req:
            async def json(self):
                return payload

        status_req = types.SimpleNamespace(match_info={})
        loop = asyncio.new_event_loop()
        try:
            resp = loop.run_until_complete(storyboard.neo_video_gen_storyboard_generate(_Req()))
            self.assertEqual(resp.status, 200, f"生成请求失败：{resp.body}")
            data = json.loads(resp.body)
            status_req.match_info["task_id"] = data["task_id"]
            for _ in range(200):
                loop.run_until_complete(asyncio.sleep(0.01))
                st = json.loads(loop.run_until_complete(
                    storyboard.neo_video_gen_storyboard_status(status_req)).body)
                if st["status"] in ("done", "cancelled", "failed"):
                    return data, st
            self.fail("分镜任务未在限定轮次内结束")
        finally:
            loop.close()

    def test_progress_reporting_without_last_prompt_id_does_not_crash(self):
        data, st = self._generate()
        # 段必须真正跑完（修复前：AttributeError → 段 failed）
        self.assertEqual(st["status"], "done")
        self.assertEqual(st["details"][0]["status"], "done", f"段失败：{st['details'][0].get('error')}")
        self.assertTrue(os.path.isfile(os.path.join(self.assets_dir, "storyboard_sb-prog_01.png")))
        # 进度确实被上报，且 prompt_id 来自执行上下文（=task_id），而非回退 last_prompt_id
        self.assertTrue(any(u[2] == 3 and u[3] == 3 for u in self.updates), "采样末步进度未上报")
        self.assertTrue(all(u[0] == data["task_id"] for u in self.updates),
                        f"进度 prompt_id 应为 task_id：{self.updates}")

    def test_missing_context_still_crashes_without_fix(self):
        # 回归护栏：直接复现崩溃路径——无执行上下文 + last_prompt_id 缺失时，钩子必抛 AttributeError。
        # 证明本用例确实踩到了线上故障点（若回退逻辑被改，此断言会先失败提醒）。
        srv = _server.PromptServer.instance
        self.assertFalse(hasattr(srv, "last_prompt_id"), "测试前提：PromptServer 无 last_prompt_id")
        with self.assertRaises(AttributeError):
            _comfy_utils.PROGRESS_BAR_HOOK(1, 3, None, node_id=None)


class StoryboardMultiRefTests(unittest.TestCase):
    """resolve_request 多参考：保留列表 / 去重 / 按上限截断（max_refs 缺省 1）。"""

    def setUp(self):
        self.names = []
        for i in range(12):
            n = f"sb_ref_{i}.png"
            _write_png(os.path.join(_INPUT_DIR, n))
            self.names.append(n)

    def test_multi_refs_kept_and_capped(self):
        settings = dict(image_gen.DEFAULT_SETTINGS)
        params = image_gen.resolve_request(
            {"prompt": "p", "references": [{"kind": "input", "value": n} for n in self.names]},
            settings, max_refs=10)
        self.assertEqual(params["ref_images"], self.names[:10])
        self.assertEqual(params["ref_name"], self.names[0])
        self.assertTrue(any("只使用前 10 张参考图" in w for w in params["warnings"]))

    def test_single_ref_default_unchanged(self):
        settings = dict(image_gen.DEFAULT_SETTINGS)
        # max_refs 缺省 1：第二张被截断并提示
        params = image_gen.resolve_request(
            {"prompt": "p", "references": [{"kind": "input", "value": self.names[0]},
                                           {"kind": "input", "value": self.names[1]}]},
            settings)
        self.assertEqual(params["ref_images"], [self.names[0]])
        self.assertTrue(any("只使用第一张参考图" in w for w in params["warnings"]))


class Qwen21TemplateTests(unittest.TestCase):
    """Qwen Image 2.1 预设模板：未挂的参考槽连同 LoadImage 一并裁掉，主链保留。"""

    def _render(self, ref_count, max_refs=10):
        template = skill.load_skill_workflow("qwen_image_21")
        self.assertIsNotNone(template, "qwen_image_21 预设应可加载 workflow.json")
        settings = dict(image_gen.DEFAULT_SETTINGS)
        for i in range(ref_count):
            _write_png(os.path.join(_INPUT_DIR, f"q_ref_{i}.png"))
        params = image_gen.resolve_request(
            {"prompt": "p", "width": 1024, "height": 576,
             "references": [{"kind": "input", "value": f"q_ref_{i}.png"} for i in range(ref_count)]},
            settings, max_refs=max_refs)
        graph, warns = image_gen.render_template(template, params)
        return graph

    def _ref_images(self, graph):
        """按 images.image_N 槽序取回每张参考图文件名（穿过 ImageScale 包装）。"""
        inputs = graph["4"]["inputs"]
        out, k = [], 1
        while f"images.image_{k}" in inputs:
            nid = inputs[f"images.image_{k}"][0]
            while graph[nid]["class_type"] != "LoadImage":
                nid = graph[nid]["inputs"]["image"][0]
            out.append(graph[nid]["inputs"]["image"])
            k += 1
        return out

    def test_no_refs_prunes_all_load_images(self):
        graph = self._render(0)
        self.assertEqual([n for n in graph.values() if n.get("class_type") == "LoadImage"], [],
                         "无参考时参考槽连同 LoadImage 应被裁掉")
        self.assertIn("4", graph)   # TextEncodeQwenImage21 保留

    def test_partial_refs_prune_unused_slots(self):
        # 模板只画 2 个演示槽，运行时按参考数扩槽：3 张 → image_1..image_3，第 4 槽不出现
        graph = self._render(3)
        self.assertEqual(self._ref_images(graph), ["q_ref_0.png", "q_ref_1.png", "q_ref_2.png"])
        self.assertNotIn("images.image_4", graph["4"]["inputs"], "第 4 个未挂的参考槽应被裁掉")

    def test_many_refs_fill_high_slots_and_prune_rest(self):
        # 上限 10：模板外的参考靠扩槽补齐，第 6 张起未挂 → 不出现 image_6
        graph = self._render(5)
        self.assertEqual(self._ref_images(graph), [f"q_ref_{i}.png" for i in range(5)])
        self.assertNotIn("images.image_6", graph["4"]["inputs"], "第 6 个未挂的参考槽应被裁掉")

    def test_rendered_refs_use_dotted_autogrow_keys(self):
        # TextEncodeQwenImage21 的 autogrow 容器是 images，模板必须用点号键 images.image_N；
        # 扁平 image_N 会绕过 _nest_dotted_inputs，变成 execute() 不认识的 kwarg 而崩溃。
        graph = self._render(3)
        inputs = graph["4"]["inputs"]
        for i in (1, 2, 3):
            self.assertIn(f"images.image_{i}", inputs, f"第 {i} 张参考应挂在 images.image_{i}")
        flat = [k for k in inputs if "." not in k and k.startswith("image_")]
        self.assertEqual(flat, [], "TextEncodeQwenImage21 不应再有扁平 image_N 键（会破坏 autogrow 聚合）")

    def test_dotted_refs_aggregate_to_nested_images_dict(self):
        # mini-executor 调 execute() 前用 _nest_dotted_inputs 把点号键收成嵌套 dict，
        # 与 ComfyUI 主循环 build_nested_inputs 一致；这里直接验证聚合结果符合 execute(images=...) 契约。
        graph = self._render(2)
        nested = image_gen_edit._nest_dotted_inputs(dict(graph["4"]["inputs"]))
        self.assertIn("images", nested, "点号键 images.image_N 应聚合成 images 字典")
        self.assertEqual(set(nested["images"]), {"image_1", "image_2"})
        self.assertFalse(any(k.startswith("image_") and "." not in k for k in nested),
                         "聚合后顶层不应残留扁平 image_N 键")

    def test_other_autogrow_prefixes_still_nest(self):
        # 回归护栏：Krea2/H3 的 ref_images.ref_image_0 等点号键同样被聚合成嵌套 dict，
        # 证明 _nest_dotted_inputs 不针对 images 特判。
        nested = image_gen_edit._nest_dotted_inputs(
            {"ref_images.ref_image_0": "a", "prompt": "p"})
        self.assertEqual(nested, {"ref_images": {"ref_image_0": "a"}, "prompt": "p"})


if __name__ == "__main__":
    unittest.main()


