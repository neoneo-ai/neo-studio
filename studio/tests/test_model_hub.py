# SPDX-License-Identifier: Apache-2.0
# Neo Studio - 模型库（model_hub.py）单元测试
# 覆盖：文件名/子目录清洗、类别推断、落盘路径与越界拒绝、已有子目录探查与默认子目录、断点续传起点、
#       双源仓库与文件归一化、仓库并集与搜索、设置读写、注册表、
#       路由级异步流程（仓库列表 / 文件清单 / 子目录列表 / 下载 + 取消 + 续传）
import asyncio
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

_NODE_DIR = str(Path(__file__).resolve().parent.parent)
sys.path.insert(0, _NODE_DIR)


class _FakeRoutes:
    def _deco(self, *a, **k):
        def wrapper(fn):
            return fn
        return wrapper

    def get(self, *a, **k):
        return self._deco()

    def post(self, *a, **k):
        return self._deco()


class _FakePromptServer:
    class instance:
        routes = _FakeRoutes()


_prev_server = sys.modules.get("server")
_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

# model_hub 用相对导入（.util），测试里造一个包壳让它可导入
_PKG = "neo_model_hub_test_pkg"
if _PKG not in sys.modules:
    _pkg = types.ModuleType(_PKG)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG] = _pkg

model_hub = importlib.import_module(f"{_PKG}.model_hub")

# 系统代理探测读真实注册表，结果会随本机代理客户端状态漂；代理行为由用例自己 stub
model_hub.civitai.system_proxy = lambda: ""

CATEGORIES = ("checkpoints", "diffusion_models", "vae", "text_encoders", "clip_vision",
              "loras", "controlnet", "model_patches", "upscale_models", "audio_vae",
              "audio_encoders")


class FakeFolderPaths(types.ModuleType):
    """folder_paths 最小替身：类别目录 = <tmp>/models/<category>。"""

    def __init__(self, root: Path):
        super().__init__("folder_paths")
        self.base_path = str(root)
        self.folder_names_and_paths = {c: ([str(root / "models" / c)], set()) for c in CATEGORIES}

    def get_folder_paths(self, category):
        return list(self.folder_names_and_paths.get(category, ([],))[0])


def restore_folder_paths(prev) -> None:
    """setUp 里换掉的 folder_paths 桩在 tearDown 归还，避免污染同进程后续测试。"""
    if prev is None:
        sys.modules.pop("folder_paths", None)
    else:
        sys.modules["folder_paths"] = prev


def make_settings(root: Path) -> dict:
    settings = dict(model_hub.DEFAULT_SETTINGS)
    settings["source"] = "huggingface"
    settings["llm_subdir"] = "LLM"
    return settings


class FakeContent:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def iter_chunked(self, size):
        for chunk in self._chunks:
            await asyncio.sleep(0)
            yield chunk


class FakeResp:
    def __init__(self, status=200, body=None, headers=None, chunks=None):
        self.status = status
        self._body = body if body is not None else {}
        self.headers = dict(headers or {})
        self._chunks = chunks

    async def json(self, content_type=None):
        return self._body

    @property
    def content(self):
        return FakeContent(self._chunks or [])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    """handler(url, headers, params) -> (status, body, headers, chunks)"""

    def __init__(self, handler):
        self.handler = handler
        self.requests = []

    def get(self, url, headers=None, params=None, timeout=None, proxy=None):
        return self._call("GET", url, headers, params, proxy=proxy)

    def request(self, method, url, params=None, json=None, headers=None, timeout=None, proxy=None):
        return self._call(method, url, headers, params, json, proxy)

    def _call(self, method, url, headers, params, json_payload=None, proxy=None):
        self.requests.append({"method": method, "url": url, "headers": dict(headers or {}),
                              "params": dict(params or {}), "json": json_payload, "proxy": proxy})
        status, body, resp_headers, chunks = self.handler(url, dict(headers or {}), dict(params or {}))
        return FakeResp(status, body, resp_headers, chunks)


class FakeClientSession:
    session = None

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return FakeClientSession.session

    async def __aexit__(self, *exc):
        return False


def install_session(handler):
    session = FakeSession(handler)
    FakeClientSession.session = session
    model_hub.aiohttp.ClientSession = FakeClientSession
    return session

# ---------------------------------------------------------------------------
# 路径与文件名安全
# ---------------------------------------------------------------------------

class PathSafetyTests(unittest.TestCase):
    def test_sanitize_filename(self):
        self.assertEqual(model_hub.sanitize_filename("split_files/vae/a.safetensors"), "a.safetensors")
        self.assertEqual(model_hub.sanitize_filename("..\\..\\x.bin"), "x.bin")
        self.assertEqual(model_hub.sanitize_filename("a:b.safetensors"), "a_b.safetensors")
        self.assertEqual(model_hub.sanitize_filename("con.safetensors"), "")
        self.assertEqual(model_hub.sanitize_filename(".."), "")
        self.assertEqual(model_hub.sanitize_filename("   "), "")
        self.assertEqual(len(model_hub.sanitize_filename("x" * 400 + ".bin")), 180)

    def test_sanitize_subfolder(self):
        self.assertEqual(model_hub.sanitize_subfolder("a/../b"), "a/b")
        self.assertEqual(model_hub.sanitize_subfolder("/abs/path/"), "abs/path")
        self.assertEqual(model_hub.sanitize_subfolder("..\\..\\x"), "x")
        self.assertEqual(model_hub.sanitize_subfolder("a\\b"), "a/b")
        self.assertEqual(model_hub.sanitize_subfolder(""), "")

    def test_split_files_category(self):
        self.assertEqual(model_hub.split_files_category("split_files/text_encoders/x.safetensors"), "text_encoders")
        self.assertEqual(model_hub.split_files_category("split_files/transformer/x.safetensors"), "diffusion_models")
        self.assertEqual(model_hub.split_files_category("split_files/unknowns/x.bin"), "")
        self.assertEqual(model_hub.split_files_category("vae/x.bin"), "")

    def test_infer_category(self):
        self.assertEqual(model_hub.infer_category("split_files/upscale_models/x.bin"), "upscale_models")
        self.assertEqual(model_hub.infer_category("qwen3_8b_q4_k_m.gguf"), model_hub.LLM_CATEGORY)
        self.assertEqual(model_hub.infer_category("RealESRGAN_x4plus.pth"), "upscale_models")
        self.assertEqual(model_hub.infer_category("umt5_xxl_fp8_scaled.safetensors"), "text_encoders")
        self.assertEqual(model_hub.infer_category("clip_vision/pytorch_model.bin"), "diffusion_models")
        self.assertEqual(model_hub.infer_category("any/clip_vision_vit.safetensors"), "clip_vision")
        self.assertEqual(model_hub.infer_category("flux1-dev.safetensors"), "diffusion_models")

    def test_is_model_file(self):
        for name in ("a.safetensors", "a.gguf", "a.pt", "a.ckpt", "a.onnx"):
            self.assertTrue(model_hub.is_model_file(name), name)
        for name in ("a.png", "a.json", "a.md", "README"):
            self.assertFalse(model_hub.is_model_file(name), name)

    def test_validate_repo_and_path(self):
        self.assertEqual(model_hub.validate_repo("Comfy-Org/Real-ESRGAN_repackaged"),
                         "Comfy-Org/Real-ESRGAN_repackaged")
        self.assertEqual(model_hub.validate_repo("/Comfy-Org/x/"), "Comfy-Org/x")
        for bad in ("", "x", "a/../b", "a//b"):
            with self.assertRaises(model_hub.HubError):
                model_hub.validate_repo(bad)
        self.assertEqual(model_hub.validate_path("split_files/vae/x.safetensors"),
                         "split_files/vae/x.safetensors")
        for bad in ("", "../x", "a/../../b"):
            with self.assertRaises(model_hub.HubError):
                model_hub.validate_path(bad)


class TargetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._prev_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = FakeFolderPaths(self.root)
        self.settings = make_settings(self.root)

    def tearDown(self):
        restore_folder_paths(self._prev_fp)
        self.tmp.cleanup()

    def test_category_root_and_target(self):
        dest = model_hub.resolve_target("upscale_models", "", "RealESRGAN_x4plus.pth", self.settings)
        self.assertEqual(dest, self.root / "models/upscale_models/RealESRGAN_x4plus.pth")

    def test_llm_target_forces_repo_subfolder(self):
        dest = model_hub.resolve_target(model_hub.LLM_CATEGORY, "", "qwen3.gguf", self.settings,
                                        repo="QuantFactory/Qwen3-8B-GGUF")
        self.assertEqual(dest, self.root / "models/LLM/Qwen3-8B-GGUF/qwen3.gguf")

    def test_subfolder_is_contained(self):
        dest = model_hub.resolve_target("loras", "../../evil", "a.safetensors", self.settings)
        self.assertEqual(dest, self.root / "models/loras/evil/a.safetensors")

    def test_empty_filename_rejected(self):
        with self.assertRaises(ValueError):
            model_hub.resolve_target("loras", "", "..", self.settings)

    def test_find_existing(self):
        target = self.root / "models/vae/sub/vae.pt"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"x")
        self.assertEqual(model_hub.find_existing("vae", "vae.pt", self.settings), "sub/vae.pt")
        self.assertEqual(model_hub.find_existing("vae", "missing.pt", self.settings), "")

    def test_find_existing_scans_all_registered_dirs(self):
        """extra_model_paths 的外部注册目录也要查到（含子目录）。"""
        extra = self.root / "ext/loras"
        sys.modules["folder_paths"].folder_names_and_paths["loras"] = (
            [str(extra), str(self.root / "models/loras")], set())
        target = extra / "sub/a.safetensors"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"x")
        self.assertEqual(model_hub.find_existing("loras", "a.safetensors", self.settings), "sub/a.safetensors")

    def test_find_existing_escapes_glob_chars(self):
        base = self.root / "models/loras"
        base.mkdir(parents=True)
        (base / "a [1].safetensors").write_bytes(b"x")
        self.assertEqual(model_hub.find_existing("loras", "a [1].safetensors", self.settings),
                         "a [1].safetensors")

    def test_category_root_prefers_dir_named_like_category(self):
        """unet 与 diffusion_models 同组注册时，落盘根目录取类别同名者。"""
        sys.modules["folder_paths"].folder_names_and_paths["diffusion_models"] = (
            [str(self.root / "models/unet"), str(self.root / "models/diffusion_models")], set())
        (self.root / "models/unet").mkdir(parents=True)
        (self.root / "models/diffusion_models").mkdir(parents=True)
        self.assertEqual(model_hub.category_root("diffusion_models", self.settings),
                         self.root / "models/diffusion_models")

    def test_target_uses_external_registered_dir(self):
        ext = self.root / "ext/diffusion_models"
        ext.mkdir(parents=True)
        sys.modules["folder_paths"].folder_names_and_paths["diffusion_models"] = (
            [str(self.root / "models/unet"), str(ext)], set())
        dest = model_hub.resolve_target("diffusion_models", "z", "m.safetensors", self.settings)
        self.assertEqual(dest, ext / "z" / "m.safetensors")

    def test_llm_root_follows_registered_llm_dir(self):
        ext = self.root / "ext/LLM"
        ext.mkdir(parents=True)
        sys.modules["folder_paths"].folder_names_and_paths[model_hub.LLM_CATEGORY] = ([str(ext)], set())
        self.assertEqual(model_hub.category_root(model_hub.LLM_CATEGORY, self.settings), ext)
        self.settings["llm_subdir"] = "LLM2"
        self.assertEqual(model_hub.category_root(model_hub.LLM_CATEGORY, self.settings),
                         self.root / "ext/LLM2")

    def test_enrich_files_reports_existing_subfolder(self):
        base = self.root / "models/diffusion_models/Flux2-Klein"
        base.mkdir(parents=True)
        (base / "m.safetensors").write_bytes(b"x")
        (self.root / "models/diffusion_models/root.safetensors").write_bytes(b"x")
        files = model_hub.enrich_files(
            [{"path": "split_files/diffusion_models/m.safetensors", "size": 10},
             {"path": "split_files/diffusion_models/root.safetensors", "size": 10},
             {"path": "split_files/diffusion_models/new.safetensors", "size": 10}], self.settings)
        by_name = {f["filename"]: f for f in files}
        self.assertEqual((by_name["m.safetensors"]["exists"], by_name["m.safetensors"]["exists_sub"]),
                         (True, "Flux2-Klein"))
        self.assertEqual((by_name["root.safetensors"]["exists"], by_name["root.safetensors"]["exists_sub"]),
                         (True, ""))
        self.assertEqual((by_name["new.safetensors"]["exists"], by_name["new.safetensors"]["exists_sub"]),
                         (False, ""))


# ---------------------------------------------------------------------------
# 已有子目录探查与默认子目录
# ---------------------------------------------------------------------------

class SubfolderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._prev_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = FakeFolderPaths(self.root)
        self.settings = make_settings(self.root)

    def tearDown(self):
        restore_folder_paths(self._prev_fp)
        self.tmp.cleanup()

    def test_list_subfolders(self):
        base = self.root / "models/loras"
        for rel in ("Qwen", "Qwen/v2", "Flux", ".cache", "Z-Image"):
            (base / rel).mkdir(parents=True)
        (base / "loose.safetensors").write_bytes(b"x")
        self.assertEqual(model_hub.list_subfolders("loras", self.settings),
                         ["Flux", "Qwen", "Z-Image", "Qwen/v2"])

    def test_list_subfolders_missing_root(self):
        self.assertEqual(model_hub.list_subfolders("vae", self.settings), [])

    def test_default_subfolder_matches_repo_name(self):
        base = self.root / "models/loras"
        (base / "Qwen3").mkdir(parents=True)
        (base / "Flux/nested").mkdir(parents=True)
        self.assertEqual(model_hub.default_subfolder("loras", self.settings, "x/Qwen3"), "Qwen3")
        self.assertEqual(model_hub.default_subfolder("loras", self.settings, "x/Flux"), "Flux")
        self.assertEqual(model_hub.default_subfolder("loras", self.settings, "x/none"), "")

    def test_default_subfolder_matches_repo_name_prefix(self):
        base = self.root / "models/diffusion_models"
        (base / "qwen").mkdir(parents=True)
        (base / "z_image").mkdir(parents=True)
        self.assertEqual(model_hub.default_subfolder("diffusion_models", self.settings,
                                                     "Comfy-Org/Qwen3-8B-GGUF"), "qwen")
        self.assertEqual(model_hub.default_subfolder("diffusion_models", self.settings,
                                                     "Comfy-Org/z_image_repackaged"), "z_image")

    def test_default_subfolder_ignores_unrelated_dir(self):
        (self.root / "models/vae/recipes").mkdir(parents=True)
        self.assertEqual(model_hub.default_subfolder("vae", self.settings, "Comfy-Org/flux2-dev"), "")

    def test_default_subfolder_llm_stays_at_root(self):
        (self.root / "models/LLM/Qwen3-8B-GGUF").mkdir(parents=True)
        self.assertEqual(model_hub.default_subfolder("llm", self.settings, "Q/Qwen3-8B-GGUF"), "")


# ---------------------------------------------------------------------------
# 断点续传起点
# ---------------------------------------------------------------------------

class ResumeTests(unittest.TestCase):
    def test_resume_start(self):
        meta = {"source": "huggingface", "repo": "Comfy-Org/x", "path": "p.bin", "total": 100}
        self.assertEqual(model_hub.resume_start({}, "huggingface", "Comfy-Org/x", "p.bin", 0),
                         (0, "no_meta"))
        self.assertEqual(model_hub.resume_start(meta, "modelscope", "Comfy-Org/x", "p.bin", 40),
                         (0, "source_mismatch"))
        self.assertEqual(model_hub.resume_start(meta, "huggingface", "Comfy-Org/y", "p.bin", 40),
                         (0, "repo_mismatch"))
        self.assertEqual(model_hub.resume_start(meta, "huggingface", "Comfy-Org/x", "p.bin", 100),
                         (0, "complete"))
        self.assertEqual(model_hub.resume_start(meta, "huggingface", "Comfy-Org/x", "p.bin", 40),
                         (40, "resume"))


# ---------------------------------------------------------------------------
# 双源归一化 / 并集 / 搜索
# ---------------------------------------------------------------------------

class NormalizeTests(unittest.TestCase):
    def test_normalize_hf_repos(self):
        items = model_hub.normalize_hf_repos([
            {"id": "Comfy-Org/a", "downloads": 10, "likes": 2},
            {"modelId": "Comfy-Org/b"},
            {"id": ""},
        ])
        self.assertEqual(items, [{"repo": "Comfy-Org/a", "downloads": 10, "likes": 2},
                                 {"repo": "Comfy-Org/b", "downloads": 0, "likes": 0}])

    def test_normalize_ms_repos(self):
        items = model_hub.normalize_ms_repos({"Data": {"Models": [
            {"Name": "a", "Path": "Comfy-Org", "Downloads": 7, "Stars": 3},
            {"RepoId": "Comfy-Org/b", "Pv": 5},
        ]}})
        self.assertEqual(items, [{"repo": "Comfy-Org/a", "downloads": 7, "likes": 3},
                                 {"repo": "Comfy-Org/b", "downloads": 5, "likes": 0}])
        # dolphin 接口把列表包在 Data.Model.Models 里
        nested = model_hub.normalize_ms_repos({"Data": {"Model": {
            "Models": [{"Name": "c", "Path": "Comfy-Org", "Downloads": 11}], "TotalCount": 1}}})
        self.assertEqual(nested, [{"repo": "Comfy-Org/c", "downloads": 11, "likes": 0}])

    def test_normalize_files(self):
        hf = model_hub.normalize_hf_files({"siblings": [
            {"rfilename": "split_files/vae/v.pt", "lfs": {"size": 100}},
            {"rfilename": "README.md", "size": 5},
        ]})
        self.assertEqual(hf, [{"path": "split_files/vae/v.pt", "size": 100},
                              {"path": "README.md", "size": 5}])
        ms = model_hub.normalize_ms_files([
            {"Name": "v.pt", "Type": "blob", "Size": 100},
            {"Name": "sub", "Type": "tree"},
        ], prefix="split_files/vae")
        self.assertEqual(ms, [{"path": "split_files/vae/v.pt", "size": 100}])

    def test_merge_repo_lists(self):
        merged = model_hub.merge_repo_lists(
            [{"repo": "Comfy-Org/a", "downloads": 10, "likes": 1},
             {"repo": "Comfy-Org/b", "downloads": 5, "likes": 0}],
            [{"repo": "Comfy-Org/b", "downloads": 7, "likes": 4},
             {"repo": "Comfy-Org/c", "downloads": 1, "likes": 0}],
            ["Comfy-Org/d"])
        self.assertEqual([m["repo"] for m in merged],
                         ["Comfy-Org/a", "Comfy-Org/b", "Comfy-Org/c", "Comfy-Org/d"])
        b = merged[1]
        self.assertTrue(b["on_hf"] and b["on_ms"])
        self.assertEqual((b["downloads"], b["likes"]), (7, 4))
        self.assertFalse(merged[3]["on_hf"] or merged[3]["on_ms"])

    def test_search_repos(self):
        repos = [{"repo": "Comfy-Org/Wan_2.2_ComfyUI_Repackaged"}, {"repo": "Comfy-Org/ltx-2"}]
        self.assertEqual(len(model_hub.search_repos(repos, "")), 2)
        self.assertEqual([r["repo"] for r in model_hub.search_repos(repos, "WAN_2")],
                         ["Comfy-Org/Wan_2.2_ComfyUI_Repackaged"])
        self.assertEqual(model_hub.search_repos(repos, "zzz"), [])

# ---------------------------------------------------------------------------
# 设置读写 / 注册表
# ---------------------------------------------------------------------------

class SettingsRegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._prev_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = FakeFolderPaths(self.root)
        self._hub_file = model_hub.HUB_FILE
        model_hub.HUB_FILE = self.root / "model_hub.json"

    def tearDown(self):
        restore_folder_paths(self._prev_fp)
        model_hub.HUB_FILE = self._hub_file
        self.tmp.cleanup()

    def test_defaults_when_missing(self):
        settings = model_hub.load_hub_settings()
        self.assertEqual(settings["source"], "modelscope")
        self.assertEqual(settings["hf_endpoint"], model_hub.DEFAULT_HF_ENDPOINT)

    def test_save_sanitizes_and_roundtrips(self):
        saved = model_hub.save_hub_settings({
            "source": "bogus", "hf_endpoint": "ftp://x", "llm_subdir": "../LLM/",
            "timeout_total": "50", "sock_read": "bad", "ms_token": "tok", "junk": 1,
        })
        self.assertEqual(saved["source"], "modelscope")
        self.assertEqual(saved["hf_endpoint"], model_hub.DEFAULT_HF_ENDPOINT)
        self.assertEqual(saved["llm_subdir"], "LLM")
        self.assertEqual(saved["timeout_total"], 50)
        self.assertEqual(saved["sock_read"], 180)
        self.assertNotIn("junk", saved)
        self.assertEqual(model_hub.load_hub_settings(), saved)
        self.assertEqual(model_hub.save_hub_settings({"hf_endpoint": "https://hf-mirror.com/"})["hf_endpoint"],
                         "https://hf-mirror.com")

    def test_ui_categories(self):
        cats = model_hub.ui_categories(make_settings(self.root))
        self.assertEqual(cats[-1], model_hub.LLM_CATEGORY)
        self.assertIn("diffusion_models", cats)

    def test_registry_file(self):
        registry = model_hub.load_registry()
        self.assertTrue(registry.get("groups"), "注册表分组为空")
        repos = model_hub.registry_repos(registry)
        self.assertIn("Comfy-Org/Real-ESRGAN_repackaged", repos)
        self.assertEqual(len(repos), len(set(repos)))
        for repo in repos:
            self.assertIn("/", repo)

# ---------------------------------------------------------------------------
# 仓库列表 / 文件清单（双源，mock aiohttp）
# ---------------------------------------------------------------------------

class RepoFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._prev_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = FakeFolderPaths(self.root)
        self._session_cls = model_hub.aiohttp.ClientSession
        self._clear_caches()

    def tearDown(self):
        restore_folder_paths(self._prev_fp)
        model_hub.aiohttp.ClientSession = self._session_cls
        self._clear_caches()
        self.tmp.cleanup()

    @staticmethod
    def _clear_caches():
        model_hub._repo_cache.clear()
        model_hub._ms_exist_cache.clear()
        model_hub._file_cache.clear()

    def test_list_repos_union_and_probe(self):
        def handler(url, headers, params):
            if "/api/models" in url:
                return 200, [{"id": "Comfy-Org/a", "downloads": 10}], {}, None
            if "/api/v1/models/" in url:
                repo = url.split("/api/v1/models/")[1].split("?")[0]
                return (200, {}, {}, None) if repo == "Comfy-Org/a" else (404, {}, {}, None)
            return 404, {}, {}, None

        install_session(handler)
        settings = make_settings(self.root)
        repos, skipped = asyncio.run(model_hub.list_repos("modelscope", settings, True))
        # ModelScope 列表接口不可用（本用例 handler 直接 404）→ 如实标列表不可达，退回逐仓库探测
        self.assertEqual(skipped, ["modelscope"])
        by = {r["repo"]: r for r in repos}
        self.assertTrue(by["Comfy-Org/a"]["on_hf"] and by["Comfy-Org/a"]["on_ms"])
        # 注册表仓库两源都探测不到 → 双标记 False，列表仍保留供手动尝试
        self.assertFalse(by["Comfy-Org/Real-ESRGAN_repackaged"]["on_ms"])
        self.assertIn("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", by)

    def test_list_repos_modelscope_survives_unreachable_hf(self):
        """国内网络默认解析不到 huggingface.co：选 ModelScope 时 HF 列表失败只跳过 HF，列表照常出。"""
        def handler(url, headers, params):
            if "/api/models" in url:
                raise model_hub.aiohttp.ClientError(
                    "Cannot connect to host huggingface.co:443 ssl:default [getaddrinfo failed]")
            if "/api/v1/dolphin/models" in url:
                return 200, {"Data": {"Model": {"Models": [
                    {"Name": "x", "Path": "Comfy-Org", "Downloads": 3}]}}}, {}, None
            return 404, {}, {}, None

        install_session(handler)
        settings = make_settings(self.root)
        repos, skipped = asyncio.run(model_hub.list_repos("modelscope", settings, True))
        self.assertEqual(skipped, ["huggingface"])
        by = {r["repo"]: r for r in repos}
        self.assertTrue(by["Comfy-Org/x"]["on_ms"])
        self.assertFalse(by["Comfy-Org/x"]["on_hf"])

        # 源是 HF 时 HF 列表失败必须报出来，且给出「换镜像端点」这条出路
        with self.assertRaises(model_hub.HubError) as cm:
            asyncio.run(model_hub.list_repos("huggingface", settings, True))
        self.assertIn("hf-mirror.com", str(cm.exception))

    def test_ms_org_repos_composite_sort(self):
        """组织列表走 dolphin 接口：匿名可用、综合排序；接口挂了要报出来，这一侧没数据得让上层知道。"""
        def handler(url, headers, params):
            if "/api/v1/dolphin/models" in url:
                return 200, {"Data": {"Model": {"Models": [
                    {"Name": "x", "Path": "Comfy-Org", "Downloads": 3},
                    {"Name": "y", "Path": "Comfy-Org", "Downloads": 9}]}}}, {}, None
            return 404, {}, {}, None

        settings = make_settings(self.root)
        session = FakeSession(handler)
        items = asyncio.run(model_hub.ms_org_repos(session, settings, True))
        self.assertEqual(items, [{"repo": "Comfy-Org/x", "downloads": 3, "likes": 0},
                                 {"repo": "Comfy-Org/y", "downloads": 9, "likes": 0}])
        payload = session.requests[0]["json"]
        self.assertEqual(payload["SortBy"], "Default")
        self.assertEqual(payload["Criterion"][0]["values"], ["Comfy-Org"])

        with self.assertRaises(model_hub.HubError):
            asyncio.run(model_hub.ms_org_repos(
                FakeSession(lambda u, h, p: (502, {}, {}, None)), settings, True))

    def test_list_repos_reports_unreachable_modelscope(self):
        """ModelScope 整站连不通时列表只剩 HF + 注册表：skipped 要说明是 ModelScope 这侧没拿到数据。"""
        def handler(url, headers, params):
            if "/api/models" in url:
                return 200, [{"id": "Comfy-Org/a", "downloads": 10}], {}, None
            raise model_hub.aiohttp.ClientError(
                "Cannot connect to host modelscope.cn:443 ssl:default [getaddrinfo failed]")

        install_session(handler)
        settings = make_settings(self.root)
        repos, skipped = asyncio.run(model_hub.list_repos("modelscope", settings, True))
        self.assertEqual(skipped, ["modelscope"])
        self.assertTrue(next(r for r in repos if r["repo"] == "Comfy-Org/a")["on_hf"])
        # 连不通不等于「仓库在 MS 上」：整表被钉成 MS，用户挑中的仓库一到文件清单那步必炸
        self.assertFalse(any(r["on_ms"] for r in repos))
        self.assertFalse(model_hub._ms_exist_cache)

    def test_global_search_repos(self):
        def handler(url, headers, params):
            if "/api/v1/dolphin/models" in url:
                return 200, {"Data": {"Model": {"Models": [
                    {"Name": "Qwen3-8B-GGUF", "Path": "Qwen", "Downloads": 7}]}}}, {}, None
            if "/api/models" in url:
                return 200, [{"id": "QuantFactory/Qwen3-8B-GGUF", "downloads": 99}], {}, None
            return 404, {}, {}, None

        settings = make_settings(self.root)
        hf = asyncio.run(model_hub.global_search_repos(FakeSession(handler), "huggingface", "qwen3", settings))
        self.assertEqual(hf[0]["repo"], "QuantFactory/Qwen3-8B-GGUF")
        self.assertTrue(hf[0]["on_hf"])

        session = FakeSession(handler)
        ms = asyncio.run(model_hub.global_search_repos(session, "modelscope", "qwen3", settings))
        self.assertEqual([it["repo"] for it in ms], ["Qwen/Qwen3-8B-GGUF"])
        self.assertTrue(ms[0]["on_ms"])
        payload = session.requests[0]["json"]
        self.assertEqual(payload["Name"], "qwen3")
        self.assertNotIn("Criterion", payload)
        self.assertEqual(asyncio.run(model_hub.global_search_repos(
            FakeSession(lambda u, h, p: (502, {}, {}, None)), "modelscope", "qwen3", settings)), [])

    def test_repo_files_hf_enrich(self):
        def handler(url, headers, params):
            return 200, {"siblings": [
                {"rfilename": "split_files/vae/wan22_vae.safetensors", "lfs": {"size": 260000000}},
                {"rfilename": "README.md", "size": 10},
                {"rfilename": "split_files/transformer/diffusion_pytorch_model.safetensors", "lfs": {"size": 500}},
            ]}, {}, None

        install_session(handler)
        settings = make_settings(self.root)
        (self.root / "models/vae").mkdir(parents=True)
        (self.root / "models/vae/wan22_vae.safetensors").write_bytes(b"x")
        files = asyncio.run(model_hub.repo_files("huggingface", "Comfy-Org/Wan_2.2_ComfyUI_Repackaged",
                                                 settings, True))
        self.assertEqual([f["path"] for f in files],
                         ["split_files/transformer/diffusion_pytorch_model.safetensors",
                          "split_files/vae/wan22_vae.safetensors"])
        self.assertEqual(files[0]["category"], "diffusion_models")
        self.assertEqual(files[1]["category"], "vae")
        self.assertTrue(files[1]["exists"])
        self.assertFalse(files[0]["exists"])

    def test_repo_files_ms_recursive(self):
        def handler(url, headers, params):
            root = url.split("Root=")[1] if "Root=" in url else ""
            tree = {
                "": [{"Name": "split_files", "Type": "tree"}, {"Name": "README.md", "Type": "blob", "Size": 1}],
                "split_files": [{"Name": "vae", "Type": "tree"}],
                "split_files/vae": [{"Name": "vae.safetensors", "Type": "blob", "Size": 10}],
            }
            return 200, {"Data": {"Files": tree.get(root, [])}}, {}, None

        install_session(handler)
        files = asyncio.run(model_hub.repo_files("modelscope", "Comfy-Org/Wan_2.2_ComfyUI_Repackaged",
                                                 make_settings(self.root), True))
        self.assertEqual([f["path"] for f in files], ["split_files/vae/vae.safetensors"])

# ---------------------------------------------------------------------------
# 下载：完成 / 取消续传 / 单任务 / 断点校验 / LLM 落盘
# ---------------------------------------------------------------------------

class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._prev_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = FakeFolderPaths(self.root)
        self._session_cls = model_hub.aiohttp.ClientSession
        self.settings = make_settings(self.root)
        self._reset()

    def tearDown(self):
        restore_folder_paths(self._prev_fp)
        self._reset()
        model_hub.aiohttp.ClientSession = self._session_cls
        self.tmp.cleanup()

    @staticmethod
    def _reset():
        model_hub._download = None
        model_hub._download_task = None

    async def _run(self, payload):
        await model_hub.start_download(payload, self.settings)
        await model_hub._download_task
        return model_hub.download_snapshot()

    def test_resolve_url_and_headers(self):
        settings = make_settings(self.root)
        settings["hf_token"] = "tok"
        self.assertEqual(model_hub.resolve_url("huggingface", "Comfy-Org/a", "p.bin", settings),
                         "https://huggingface.co/models/Comfy-Org/a/resolve/main/p.bin")
        self.assertEqual(model_hub.resolve_url("modelscope", "Comfy-Org/a", "p.bin", settings),
                         "https://modelscope.cn/models/Comfy-Org/a/resolve/master/p.bin")
        self.assertEqual(model_hub.source_headers("huggingface", settings)["Authorization"], "Bearer tok")
        self.assertNotIn("Authorization", model_hub.source_headers("modelscope", settings))

    def test_download_completes_and_cleans_part(self):
        data = b"A" * 5000
        install_session(lambda url, headers, params:
                        (200, {}, {"Content-Length": str(len(data)), "ETag": '"abc"'}, [data[:2000], data[2000:]]))
        snap = asyncio.run(self._run({
            "source": "huggingface", "repo": "Comfy-Org/Real-ESRGAN_repackaged",
            "path": "RealESRGAN_x4plus.pth"}))
        self.assertEqual(snap["state"], "done")
        dest = Path(snap["dest"])
        self.assertEqual(dest, self.root / "models/upscale_models/RealESRGAN_x4plus.pth")
        self.assertEqual(dest.read_bytes(), data)
        part, meta = model_hub.part_paths(dest)
        self.assertFalse(part.exists())
        self.assertFalse(meta.exists())

    def test_hub_requests_use_system_proxy(self):
        """代理客户端接管 DNS 的机器直连必失败：HF / ModelScope 的请求必须带上注册表里的系统代理"""
        prev_proxy = model_hub.civitai.system_proxy
        model_hub.civitai.system_proxy = lambda: "http://127.0.0.1:7890"
        try:
            data = b"A" * 20
            session = install_session(lambda url, headers, params:
                                      (200, {}, {"Content-Length": str(len(data))}, [data]))
            settings = make_settings(self.root)
            asyncio.run(model_hub.list_repos("huggingface", settings, True))
            self.assertEqual({req["proxy"] for req in session.requests}, {"http://127.0.0.1:7890"})
            snap = asyncio.run(self._run({"source": "modelscope", "repo": "Comfy-Org/a", "path": "p.bin"}))
            self.assertEqual(snap["state"], "done")
            self.assertEqual(session.requests[-1]["proxy"], "http://127.0.0.1:7890")
        finally:
            model_hub.civitai.system_proxy = prev_proxy


    def test_cancel_keeps_part_then_resume(self):
        def handler(url, headers, params):
            if "Range" in headers:
                self.assertEqual(headers["Range"], "bytes=2000-")
                return 206, {}, {"Content-Range": "bytes 2000-2999/3000"}, [b"B" * 1000]
            return 200, {}, {"Content-Length": "3000"}, [b"A" * 1000] * 5

        install_session(handler)
        payload = {"source": "huggingface", "repo": "Comfy-Org/Real-ESRGAN_repackaged",
                   "path": "RealESRGAN_x4plus.pth"}

        async def run_cancel():
            await model_hub.start_download(payload, self.settings)
            for _ in range(3):
                await asyncio.sleep(0)
            self.assertTrue(model_hub.cancel_download())
            await model_hub._download_task
            return model_hub.download_snapshot()

        snap = asyncio.run(run_cancel())
        self.assertEqual(snap["state"], "paused")
        dest = Path(snap["dest"])
        part, meta = model_hub.part_paths(dest)
        self.assertEqual(part.stat().st_size, 2000)
        self.assertFalse(dest.exists())
        self.assertEqual(json.loads(meta.read_text(encoding="utf-8"))["done"], 2000)

        snap = asyncio.run(self._run(payload))
        self.assertEqual(snap["state"], "done")
        self.assertEqual(dest.read_bytes(), b"A" * 2000 + b"B" * 1000)
        self.assertFalse(part.exists())
        self.assertFalse(meta.exists())



    def test_busy_rejects_second_download(self):
        install_session(lambda url, headers, params:
                        (200, {}, {"Content-Length": "100000"}, [b"x" * 1000] * 200))
        payload = {"source": "huggingface", "repo": "Comfy-Org/Real-ESRGAN_repackaged",
                   "path": "RealESRGAN_x4plus.pth"}

        async def main():
            await model_hub.start_download(payload, self.settings)
            with self.assertRaises(model_hub.HubError) as ctx:
                await model_hub.start_download(payload, self.settings)
            self.assertEqual(ctx.exception.status, 409)
            self.assertEqual(ctx.exception.code, "busy")
            self.assertTrue(model_hub.cancel_download())
            await model_hub._download_task
            return model_hub.download_snapshot()

        snap = asyncio.run(main())
        self.assertEqual(snap["state"], "paused")
        self.assertFalse(model_hub.cancel_download())

    def test_existing_file_short_circuits(self):
        dest = self.root / "models/upscale_models/RealESRGAN_x4plus.pth"
        dest.parent.mkdir(parents=True)
        dest.write_bytes(b"old")
        install_session(lambda url, headers, params: (200, {}, {}, []))
        snap = asyncio.run(self._run({"source": "huggingface", "repo": "Comfy-Org/Real-ESRGAN_repackaged",
                                      "path": "RealESRGAN_x4plus.pth"}))
        self.assertEqual(snap["state"], "done")
        self.assertEqual(dest.read_bytes(), b"old")

    def test_part_from_other_source_is_rejected(self):
        dest = self.root / "models/upscale_models/RealESRGAN_x4plus.pth"
        dest.parent.mkdir(parents=True)
        part, meta = model_hub.part_paths(dest)
        part.write_bytes(b"junk")
        meta.write_text(json.dumps({"source": "modelscope", "repo": "Comfy-Org/Real-ESRGAN_repackaged",
                                    "path": "RealESRGAN_x4plus.pth", "total": 10}), encoding="utf-8")
        install_session(lambda url, headers, params: (200, {}, {}, []))
        snap = asyncio.run(self._run({"source": "huggingface", "repo": "Comfy-Org/Real-ESRGAN_repackaged",
                                      "path": "RealESRGAN_x4plus.pth"}))
        self.assertEqual(snap["state"], "error")
        self.assertIn("源", snap["error"])

    def test_token_required_error(self):
        install_session(lambda url, headers, params: (401, {}, {}, []))
        snap = asyncio.run(self._run({"source": "huggingface", "repo": "Comfy-Org/a",
                                      "path": "a.safetensors"}))
        self.assertEqual(snap["state"], "error")
        self.assertIn("Token", snap["error"])

    def test_gguf_lands_in_llm_repo_dir(self):
        data = b"G" * 10
        install_session(lambda url, headers, params: (200, {}, {"Content-Length": str(len(data))}, [data]))
        snap = asyncio.run(self._run({"source": "huggingface", "repo": "QuantFactory/Qwen3-8B-GGUF",
                                      "path": "qwen3-8b-q4_k_m.gguf"}))
        self.assertEqual(snap["category"], model_hub.LLM_CATEGORY)
        self.assertEqual(Path(snap["dest"]), self.root / "models/LLM/Qwen3-8B-GGUF/qwen3-8b-q4_k_m.gguf")
        self.assertTrue(Path(snap["dest"]).exists())



# ---------------------------------------------------------------------------
# 路由层（/neo_model_hub/*）
# ---------------------------------------------------------------------------

class FakeRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def payload(resp):
    return json.loads(resp.body)


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._prev_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = FakeFolderPaths(self.root)
        self._session_cls = model_hub.aiohttp.ClientSession
        self._hub_file = model_hub.HUB_FILE
        model_hub.HUB_FILE = self.root / "model_hub.json"
        model_hub._repo_cache.clear()
        model_hub._ms_exist_cache.clear()
        model_hub._file_cache.clear()
        model_hub._download = None
        model_hub._download_task = None

    def tearDown(self):
        restore_folder_paths(self._prev_fp)
        model_hub.HUB_FILE = self._hub_file
        model_hub.aiohttp.ClientSession = self._session_cls
        model_hub._download = None
        model_hub._download_task = None
        self.tmp.cleanup()

    def test_settings_routes(self):
        body = payload(asyncio.run(model_hub.rs_hub_settings(None)))
        self.assertTrue(body["success"])
        self.assertEqual(body["settings"]["source"], "modelscope")
        self.assertTrue(body["registry"].get("groups"))
        self.assertEqual(body["categories"][-1], model_hub.LLM_CATEGORY)
        self.assertEqual(body["sources"], ["modelscope", "huggingface", "civitai"])
        self.assertEqual(set(body["civitai"]), {"api_key_set", "proxy"})
        self.assertIsInstance(body["civitai"]["api_key_set"], bool)
        saved = payload(asyncio.run(model_hub.rs_hub_save_settings(
            FakeRequest({"source": "bogus", "llm_subdir": "LLM", "junk": 1}))))["settings"]
        self.assertEqual(saved["source"], "modelscope")
        self.assertEqual(saved["llm_subdir"], "LLM")
        self.assertNotIn("junk", saved)

    def test_repos_route_merges_global_search(self):
        def handler(url, headers, params):
            if "/api/models" in url:
                if params and params.get("search"):
                    return 200, [{"id": "QuantFactory/Qwen3-8B-GGUF", "downloads": 5}], {}, None
                return 200, [{"id": "Comfy-Org/flux2-dev", "downloads": 100},
                             {"id": "Comfy-Org/other", "downloads": 1}], {}, None
            return 404, {}, {}, None

        install_session(handler)
        body = payload(asyncio.run(model_hub.rs_hub_repos(FakeRequest(
            {"source": "huggingface", "query": "qwen3", "refresh": True}))))
        repos = {r["repo"] for r in body["repos"]}
        self.assertIn("QuantFactory/Qwen3-8B-GGUF", repos)
        self.assertNotIn("Comfy-Org/flux2-dev", repos)

    def test_repos_route_modelscope_needs_no_token(self):
        """ModelScope 侧接口全挂时，带 Token 的仓库列表请求仍成功（退回注册表探测）。"""
        def handler(url, headers, params):
            if "/api/models" in url:
                return 200, [{"id": "Comfy-Org/flux2-dev", "downloads": 100}], {}, None
            return 404, {}, {}, None

        install_session(handler)
        model_hub.save_hub_settings({"source": "modelscope", "ms_token": "tok"})
        body = payload(asyncio.run(model_hub.rs_hub_repos(FakeRequest(
            {"source": "modelscope", "query": "qwen3", "refresh": True}))))
        self.assertTrue(body["success"])
        self.assertTrue(body["repos"])

    def test_repos_route_modelscope_survives_unreachable_hf(self):
        """HF 端点不可达时，ModelScope 源的 /repos 照常出列表，并带回被跳过的源供界面说明。"""
        def handler(url, headers, params):
            if "/api/models" in url:
                raise model_hub.aiohttp.ClientError(
                    "Cannot connect to host huggingface.co:443 ssl:default [getaddrinfo failed]")
            if "/api/v1/dolphin/models" in url:
                return 200, {"Data": {"Model": {"Models": [
                    {"Name": "Qwen3-8B-GGUF", "Path": "Qwen", "Downloads": 7}]}}}, {}, None
            return 404, {}, {}, None

        install_session(handler)
        model_hub.save_hub_settings({"source": "modelscope"})
        body = payload(asyncio.run(model_hub.rs_hub_repos(
            FakeRequest({"source": "modelscope", "query": "qwen3", "refresh": True}))))
        self.assertTrue(body["success"])
        self.assertEqual(body["skipped"], ["huggingface"])
        self.assertIn("Qwen/Qwen3-8B-GGUF", {r["repo"] for r in body["repos"]})

    def test_repos_route_hf_failure_names_endpoint_fix(self):
        """源是 HF 且端点不可达：报错要给出「在 ⚙ 改 HF 端点」这条出路，光一行 gaierror 没人看得懂。"""
        def handler(url, headers, params):
            if "/api/models" in url:
                raise model_hub.aiohttp.ClientError(
                    "Cannot connect to host huggingface.co:443 ssl:default [getaddrinfo failed]")
            return 404, {}, {}, None

        install_session(handler)
        body = payload(asyncio.run(model_hub.rs_hub_repos(
            FakeRequest({"source": "huggingface", "refresh": True}))))
        self.assertFalse(body["success"])
        self.assertIn("hf-mirror.com", body["error"])

    def test_files_route_ms_failure_names_retry_path(self):
        """ModelScope 连不通时文件清单的报错要给出去路：查本机网络 / 代理后重试，或换源。"""
        def handler(url, headers, params):
            raise model_hub.aiohttp.ClientError(
                "Cannot connect to host modelscope.cn:443 ssl:default [getaddrinfo failed]")

        install_session(handler)
        resp = asyncio.run(model_hub.rs_hub_files(FakeRequest(
            {"source": "modelscope", "repo": "Comfy-Org/z_image_turbo", "refresh": True})))
        self.assertEqual(resp.status, 502)
        self.assertIn("ModelScope 连不通", payload(resp)["error"])

    def test_files_route_rejects_bad_input(self):
        self.assertEqual(asyncio.run(model_hub.rs_hub_files(
            FakeRequest({"source": "huggingface", "repo": "../etc"}))).status, 400)
        self.assertEqual(asyncio.run(model_hub.rs_hub_files(
            FakeRequest({"source": "bogus", "repo": "Comfy-Org/a"}))).status, 400)
        self.assertEqual(asyncio.run(model_hub.rs_hub_files(
            FakeRequest({"source": "huggingface", "repo": ""}))).status, 400)

    def test_subfolders_route(self):
        (self.root / "models/loras/Qwen3").mkdir(parents=True)
        body = payload(asyncio.run(model_hub.rs_hub_subfolders(
            FakeRequest({"category": "loras", "repo": "Comfy-Org/Qwen3"}))))
        self.assertTrue(body["success"])
        self.assertEqual(body["subfolders"], ["Qwen3"])
        self.assertEqual(body["default"], "Qwen3")
        resp = asyncio.run(model_hub.rs_hub_subfolders(FakeRequest({"category": "bogus"})))
        self.assertEqual(resp.status, 400)
        self.assertFalse(payload(resp)["success"])

    def test_progress_and_cancel_when_idle(self):
        self.assertEqual(payload(asyncio.run(model_hub.rs_hub_progress(None)))["download"], {"state": "idle"})
        self.assertFalse(payload(asyncio.run(model_hub.rs_hub_cancel(None)))["success"])

    def test_download_route(self):
        data = b"Z" * 20
        install_session(lambda url, headers, params: (200, {}, {"Content-Length": str(len(data))}, [data]))

        async def main():
            resp = await model_hub.rs_hub_download(FakeRequest(
                {"source": "huggingface", "repo": "Comfy-Org/Real-ESRGAN_repackaged",
                 "path": "RealESRGAN_x4plus.pth", "subfolder": "x/.."}))
            snap = payload(resp)["download"]
            await model_hub._download_task
            return snap, model_hub.download_snapshot()

        snap, final = asyncio.run(main())
        self.assertEqual(Path(snap["dest_dir"]), self.root / "models/upscale_models/x")
        self.assertEqual(final["state"], "done")
        self.assertEqual((self.root / "models/upscale_models/x/RealESRGAN_x4plus.pth").read_bytes(), data)


    def test_error_mapping(self):
        resp = model_hub._error(model_hub.HubError("仓库不存在", 404, "not_found"), "modelscope")
        self.assertEqual(resp.status, 404)
        body = payload(resp)
        self.assertEqual(body["code"], "not_on_source")
        self.assertEqual(body["other_source"], "huggingface")
        self.assertEqual(model_hub._error(ValueError("bad"), "").status, 500)


class CivitaiSourceTests(unittest.TestCase):
    """C 站作为第三源：地址与鉴权走共享 helper，下载只认签名端点，清单只列权重。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self._prev_fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = FakeFolderPaths(self.root)
        self._session_cls = model_hub.aiohttp.ClientSession
        self._load_settings = model_hub.civitai._load_settings
        self._system_proxy = model_hub.civitai.system_proxy
        # 系统代理探测读真实注册表，测试结果会随本机代理客户端状态漂
        model_hub.civitai.system_proxy = lambda: ""
        self.settings = make_settings(self.root)
        model_hub._download = None
        model_hub._download_task = None
        (self.root / "models" / "loras").mkdir(parents=True)

    def tearDown(self):
        restore_folder_paths(self._prev_fp)
        model_hub.aiohttp.ClientSession = self._session_cls
        model_hub.civitai._load_settings = self._load_settings
        model_hub.civitai.system_proxy = self._system_proxy
        model_hub._download = None
        model_hub._download_task = None
        self.tmp.cleanup()

    @staticmethod
    def set_civitai(**kwargs):
        model_hub.civitai._load_settings = lambda: dict(kwargs)

    def test_civitai_is_a_source(self):
        self.assertIn("civitai", model_hub.SOURCES)

    def test_resolve_url_and_headers(self):
        self.assertEqual(
            model_hub.resolve_url("civitai", "civitai/123", "/api/download/models/9?token=t",
                                  self.settings),
            "https://civitai.com/api/download/models/9?token=t")
        self.set_civitai(civitai_api_key="k9")
        self.assertEqual(model_hub.source_headers("civitai", self.settings)["Authorization"],
                         "Bearer k9")
        self.set_civitai(civitai_api_key="")
        self.assertNotIn("Authorization", model_hub.source_headers("civitai", self.settings))

    def test_validate_civitai_id(self):
        self.assertEqual(model_hub.validate_civitai_id(" 12345 "), "12345")
        self.assertEqual(model_hub.validate_civitai_id(77), "77")
        for bad in ("", None, "abc", "1;rm", "../2", "1 2"):
            with self.subTest(bad=bad):
                with self.assertRaises(model_hub.HubError):
                    model_hub.validate_civitai_id(bad)

    def test_validate_civitai_path(self):
        self.assertEqual(model_hub.validate_civitai_path("/api/download/models/9?token=t"),
                         "/api/download/models/9?token=t")
        for bad in ("", "/api/v1/models/9", "/api/download/models/x",
                    "//evil.com/api/download/models/1"):
            with self.subTest(bad=bad):
                with self.assertRaises(model_hub.HubError):
                    model_hub.validate_civitai_path(bad)

    async def _run(self, payload):
        await model_hub.start_download(payload, self.settings)
        await model_hub._download_task
        return model_hub.download_snapshot()

    def test_download_civitai_signed_endpoint(self):
        data = b"Z" * 4096
        session = install_session(lambda url, headers, params:
                                  (200, {}, {"Content-Length": str(len(data))}, [data]))
        snap = asyncio.run(self._run({
            "source": "civitai", "repo": "civitai/123",
            "path": "/api/download/models/9?token=t",
            "filename": "a.safetensors", "category": "loras"}))
        self.assertEqual(snap["state"], "done")
        dest = Path(snap["dest"])
        self.assertEqual(dest, self.root / "models/loras/a.safetensors")
        self.assertEqual(dest.read_bytes(), data)
        self.assertEqual(session.requests[0]["url"],
                         "https://civitai.com/api/download/models/9?token=t")

    def test_download_rejects_other_endpoint(self):
        install_session(lambda url, headers, params: (200, {}, {}, [b"x"]))
        with self.assertRaises(model_hub.HubError):
            asyncio.run(self._run({"source": "civitai", "repo": "civitai/123",
                                   "path": "/api/v1/models/9"}))

    VERSIONS = {"modelVersions": [{
        "id": 3, "name": "v2", "baseModel": "SDXL", "trainedWords": ["kw"],
        "files": [
            {"id": 1, "name": "a.safetensors", "format": "SafeTensor", "sizeKB": 10,
             "type": "Model", "primary": True,
             "downloadUrl": "https://civitai.com/api/download/models/1?token=t"},
            {"id": 2, "name": "preview.png", "type": "Image", "sizeKB": 1,
             "downloadUrl": "https://civitai.com/api/download/models/2?token=t"},
        ],
    }]}

    def test_civitai_files_lists_weights(self):
        install_session(lambda url, headers, params: (200, self.VERSIONS, {}, []))
        files = asyncio.run(model_hub.civitai_files("123", self.settings))
        self.assertEqual(len(files), 1)
        f = files[0]
        self.assertEqual(f["filename"], "a.safetensors")
        self.assertEqual(f["category"], model_hub.CIVITAI_CATEGORY)
        self.assertEqual(f["path"], "/api/download/models/1?token=t")
        self.assertEqual(f["version_name"], "v2")
        self.assertEqual(f["base_model"], "SDXL")
        self.assertEqual(f["trained_words"], ["kw"])
        self.assertEqual(f["size"], 10240)
        self.assertFalse(f["exists"])

    def test_civitai_files_marks_existing(self):
        (self.root / "models/loras/a.safetensors").write_bytes(b"x")
        install_session(lambda url, headers, params: (200, self.VERSIONS, {}, []))
        files = asyncio.run(model_hub.civitai_files("123", self.settings))
        self.assertTrue(files[0]["exists"])

    def test_civitai_files_error(self):
        install_session(lambda url, headers, params: (404, None, {}, []))
        with self.assertRaises(model_hub.HubError) as ctx:
            asyncio.run(model_hub.civitai_files("123", self.settings))
        self.assertIn("404", str(ctx.exception))

    def test_civitai_search_params_and_items(self):
        session = install_session(lambda url, headers, params:
                                  (200, {"items": [{"id": 1, "name": "A", "modelVersions": []}],
                                          "metadata": {"nextCursor": "24"}}, {}, []))
        items, page, cursor, bases = asyncio.run(model_hub.civitai_search(
            {"query": "anime", "page": 2, "nsfw": True, "types": ["LORA", "Bogus"]}))
        self.assertEqual(items[0]["name"], "A")
        # query 搜索按 cursor 翻页，页码回显请求值供前端维护游标
        self.assertEqual(page, 2)
        self.assertEqual(cursor, "24")
        self.assertIn("SDXL 1.0", bases)
        req = [r for r in session.requests if r["url"].endswith("/models")][0]
        self.assertEqual(req["url"], "https://civitai.com/api/v1/models")
        self.assertEqual(req["params"]["types"], ["LORA"])
        self.assertEqual(req["params"]["nsfw"], "True")
        self.assertEqual(req["params"]["query"], "anime")
        self.assertEqual(req["params"]["sort"], "Most Downloaded")
        # query 搜索不能带 page，C 站直接 400
        self.assertNotIn("page", req["params"])

    def test_civitai_search_browse_pages(self):
        # 浏览（无 query）同样按 cursor 链翻页，page 只是前端记账，不进请求
        session = install_session(lambda url, headers, params:
                                  (200, {"items": [], "metadata": {"nextCursor": "164425|20774"}}, {}, []))
        items, page, cursor, bases = asyncio.run(model_hub.civitai_search(
            {"page": 2, "cursor": "261069|5828|42903"}))
        self.assertEqual(page, 2)
        self.assertEqual(cursor, "164425|20774")
        req = [r for r in session.requests if r["url"].endswith("/models")][0]
        self.assertEqual(req["params"]["cursor"], "261069|5828|42903")
        self.assertNotIn("page", req["params"])

    def test_civitai_search_error(self):
        install_session(lambda url, headers, params: (401, None, {}, []))
        with self.assertRaises(model_hub.HubError) as ctx:
            asyncio.run(model_hub.civitai_search({"query": "x"}))
        self.assertIn("401", str(ctx.exception))

    def test_civitai_search_error_carries_civitai_detail(self):
        install_session(lambda url, headers, params:
                        (400, {"error": "Cannot use page param with query search."}, {}, []))
        with self.assertRaises(model_hub.HubError) as ctx:
            asyncio.run(model_hub.civitai_search({"query": "x"}))
        self.assertIn("page param", str(ctx.exception))

    def test_settings_route_echoes_civitai_status(self):
        self.set_civitai(civitai_api_key="secret-key", civitai_proxy="127.0.0.1:7890")
        body = payload(asyncio.run(model_hub.rs_hub_settings(None)))
        self.assertIn("civitai", body["sources"])
        self.assertEqual(body["civitai"]["proxy"], "http://127.0.0.1:7890")
        self.assertTrue(body["civitai"]["api_key_set"])
        # KEY 只回状态，不回明文
        self.assertNotIn("secret-key", json.dumps(body))
        self.set_civitai(civitai_api_key="", civitai_proxy="")
        body = payload(asyncio.run(model_hub.rs_hub_settings(None)))
        self.assertEqual(body["civitai"]["proxy"], "")
        self.assertFalse(body["civitai"]["api_key_set"])


if _prev_server is None:
    sys.modules.pop("server", None)
else:
    sys.modules["server"] = _prev_server


if __name__ == "__main__":
    unittest.main(verbosity=2)
