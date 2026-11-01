# SPDX-License-Identifier: Apache-2.0
# Neo Studio - 预设技能模型清单（studio/skill_models.py）单元测试
# 覆盖：清单缺失/坏 JSON 的降级、extends 合并与去重、文件层就位（配置写死名精确查 / 同名落别处 /
#       族系变体互备）、LoRA 激活口径、族系聚合、下载计划（当前源 / 该源没有 / 出处非法 / 落盘子目录）、
#       随包 37 份 models.json 的静态口径
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from pathlib import Path

_NODE_DIR = str(Path(__file__).resolve().parent.parent)
sys.path.insert(0, _NODE_DIR)
# 单跑本文件时也要把插件数据根钉在临时目录（全量跑由根 conftest.py 负责）
os.environ.setdefault("NEO_STUDIO_DATA", tempfile.mkdtemp(prefix="neo_skill_models_data_"))

_PRESETS = Path(_NODE_DIR) / "skills" / "presets"
# 翻译 / TTS 预设不吃本地模型文件，清单层不参与
NO_MANIFEST_PRESETS = {"translate", "translate_to_chinese", "translate_to_english", "cosyvoice_voice"}


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

# skill_models / skill / model_hub 都用相对导入，测试里造一个包壳让它们可导入
_PKG = "neo_skill_models_test_pkg"
if _PKG not in sys.modules:
    _pkg = types.ModuleType(_PKG)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG] = _pkg


class FakeFolderPaths(types.ModuleType):
    """folder_paths 最小替身：类别目录 = <tmp>/models/<category>，get_filename_list 递归列相对名。"""

    def __init__(self, root: Path):
        super().__init__("folder_paths")
        self.root = root

    def get_filename_list(self, cat: str):
        base = self.root / cat
        if not base.is_dir():
            return []
        out = []
        for dirpath, _dirs, files in os.walk(base):
            for fn in files:
                rel = os.path.relpath(os.path.join(dirpath, fn), base).replace("\\", "/")
                out.append(rel)
        return sorted(out)

    def get_full_path(self, cat: str, name: str):
        p = self.root / cat / str(name).replace("\\", "/")
        return str(p) if p.is_file() else None


sys.modules["folder_paths"] = FakeFolderPaths(Path(tempfile.gettempdir()) / "neo_skill_models_none")

skill_mod = importlib.import_module(f"{_PKG}.skill")
model_hub = importlib.import_module(f"{_PKG}.model_hub")
civitai_mod = importlib.import_module(f"{_PKG}.civitai")
image_gen_files = importlib.import_module(f"{_PKG}.image_gen_files")
video_gen = importlib.import_module(f"{_PKG}.video_gen")
skill_models = importlib.import_module(f"{_PKG}.skill_models")

# 清单项求值时惰性导入的那几个函数 → 所属模块与属性名：用例里换掉它们就是换掉数据源
_OWNERS = {"_skill_dir": (skill_mod, "_skill_dir"),
           "scan_skills": (skill_mod, "scan_skills"),
           "image_settings": (image_gen_files, "get_settings"),
           "video_settings": (video_gen, "get_video_settings"),
           "hub_settings": (model_hub, "load_hub_settings"),
           "civitai_key": (civitai_mod, "api_key")}


def bind_models(root: Path):
    """换模型根：skill_models 在导入期绑定的是 folder_paths 模块对象本身，只改 sys.modules 换不到它。"""
    saved = skill_models.folder_paths
    skill_models.folder_paths = sys.modules["folder_paths"] = FakeFolderPaths(root)
    return saved


def restore_models(saved):
    skill_models.folder_paths = sys.modules["folder_paths"] = saved


@contextmanager
def patched(**kw):
    saved = []
    for key, value in kw.items():
        owner, attr = _OWNERS[key]
        saved.append((owner, attr, getattr(owner, attr)))
        setattr(owner, attr, value)
    try:
        yield
    finally:
        for owner, attr, old in saved:
            setattr(owner, attr, old)


def entry(field, filename, category, gb, sources=None, **extra) -> dict:
    item = {"field": field, "filename": filename, "category": category, "gb": gb,
            "sources": sources or [ms_source("Fake/Repo", f"{category}/{filename}")]}
    item.update(extra)
    return item


def ms_source(repo, path) -> dict:
    return {"source": "modelscope", "repo": repo, "path": path}


def hf_source(repo, path, gated=False) -> dict:
    src = {"source": "huggingface", "repo": repo, "path": path}
    if gated:
        src["gated"] = True
    return src


def civ_source(path) -> dict:
    return {"source": "civitai", "repo": "civitai", "path": path}


class _FixtureCase(unittest.TestCase):
    """检查/计划用例的公共夹具：技能目录 = <tmp>/skills/presets/<id>，模型根 = <tmp>/models/<category>。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="neo_skill_models_"))
        self.models = self.tmp / "models"
        self.presets = self.tmp / "skills" / "presets"
        self.image_cfg, self.video_cfg = {}, {}
        self.hub_cfg = {"source": "modelscope"}
        self.hf_ok, self.civitai_ok = False, False
        self._fp = bind_models(self.models)

    def tearDown(self):
        restore_models(self._fp)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def skill(self, skill_id, manifest=None, cfg=None):
        """在临时数据根里建预设目录并写 models.json / config.json。"""
        d = self.presets / skill_id
        d.mkdir(parents=True, exist_ok=True)
        if manifest is not None:
            (d / "models.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        if cfg is not None:
            (d / "config.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")

    def place(self, category, rel_path):
        """往模型根里放一个文件（可带子目录）。"""
        p = self.models / category / rel_path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("w", encoding="utf-8")

    def _skill_dir(self, skill_id):
        d = self.presets / str(skill_id)
        return str(d) if d.is_dir() else None

    def _env(self):
        return {"_skill_dir": self._skill_dir,
                "image_settings": lambda: dict(self.image_cfg),
                "video_settings": lambda: dict(self.video_cfg),
                "hub_settings": lambda: {**self.hub_cfg, "hf_token": "tok" if self.hf_ok else ""},
                "civitai_key": lambda: "key" if self.civitai_ok else ""}

    def check(self, skill_id):
        with patched(**self._env()):
            return skill_models.check_skill(skill_id)

    def plan(self, skill_id, source="", include_optional=False):
        with patched(**self._env()):
            return skill_models.download_plan(skill_id, source, include_optional)

    def all_overview(self, presets):
        """presets = [(skill_id, cn_name)]，全部按 presets 来源参与聚合。"""
        scanned = [{"id": sid, "cn_name": cn, "source": "presets"} for sid, cn in presets]
        with patched(**self._env(), scan_skills=lambda: scanned):
            return skill_models.check_all()


class TestManifestDegradation(_FixtureCase):
    def test_missing_manifest_is_not_an_error(self):
        self.skill("plain")
        chk = self.check("plain")
        self.assertEqual((chk["has_manifest"], chk["blocked"], chk["missing_count"]), (False, False, 0))
        self.assertEqual(chk["files"], [])

    def test_corrupt_manifest_falls_back_to_no_manifest(self):
        self.skill("broken")
        (self.presets / "broken" / "models.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(self.check("broken")["has_manifest"], False)

    def test_non_object_manifest_and_files_fall_back(self):
        self.skill("arr")
        (self.presets / "arr" / "models.json").write_text("[1, 2]", encoding="utf-8")
        self.assertEqual(self.check("arr")["has_manifest"], False)
        self.skill("badfiles", {"family": "f", "label": "L", "files": "nope"})
        self.assertEqual(self.check("badfiles")["has_manifest"], False)

    def test_manifest_without_files_is_no_manifest(self):
        self.skill("nofiles", {"family": "f", "label": "L", "files": []})
        plan = self.plan("nofiles")
        self.assertEqual((self.check("nofiles")["has_manifest"], plan["has_manifest"], plan["files"]),
                         (False, False, []))

    def test_unknown_skill_reports_failure(self):
        self.assertEqual(self.check("ghost"), None)

    def test_extends_to_missing_base_keeps_own_files(self):
        self.skill("kid", {"family": "fam", "label": "L", "extends": "gone",
                           "files": [entry("model", "m.safetensors", "diffusion_models", 1.0)]})
        chk = self.check("kid")
        self.assertEqual(chk["missing_count"], 1)
        self.assertEqual(chk["family"], "fam")


class TestLocate(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="neo_skill_models_locate_"))
        self._fp = bind_models(self.tmp)
        for rel in ("diffusion_models/krea2/turbo.safetensors",
                    "diffusion_models/other.Turbo.SAFETENSORS",
                    "loras/Sub/a_lora.safetensors"):
            p = self.tmp / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("w", encoding="utf-8")

    def tearDown(self):
        restore_models(self._fp)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_exact_relative_name_case_and_slash_insensitive(self):
        self.assertEqual(skill_models.locate_exact("diffusion_models", "krea2/turbo.safetensors"),
                         "krea2/turbo.safetensors")
        self.assertEqual(skill_models.locate_exact("diffusion_models", "krea2\\TURBO.safetensors"),
                         "krea2/turbo.safetensors")
        self.assertEqual(skill_models.locate_exact("diffusion_models", "krea2/other.safetensors"), "")

    def test_by_names_matches_basename_anywhere_in_tree(self):
        self.assertEqual(skill_models.locate_by_names("diffusion_models", ["TURBO.SAFETENSORS"]),
                         "krea2/turbo.safetensors")
        self.assertEqual(skill_models.locate_by_names("loras", ["a_lora.safetensors"]),
                         "Sub/a_lora.safetensors")
        self.assertEqual(skill_models.locate_by_names("loras", ["nope.safetensors"]), "")

    def test_empty_category_and_missing_root_return_empty(self):
        self.assertEqual(skill_models.category_files(""), [])
        self.assertEqual(skill_models.locate_exact("text_encoders", "x.safetensors"), "")
        self.assertEqual(skill_models.locate_by_names("vae", ["x.safetensors"]), "")

    def test_subfolder_of(self):
        self.assertEqual(skill_models.subfolder_of("krea2/turbo.safetensors"), "krea2")
        self.assertEqual(skill_models.subfolder_of("krea2\\sub\\t.safetensors"), "krea2/sub")
        self.assertEqual(skill_models.subfolder_of("turbo.safetensors"), "")


class TestCheckSkill(_FixtureCase):
    def test_missing_required_files_block_with_gb(self):
        self.skill("base", {"family": "krea2_image", "label": "Krea2 生图族",
                            "files": [entry("model", "krea2/turbo.safetensors", "diffusion_models", 13.49),
                                      entry("vae", "qwen.safetensors", "vae", 0.64)]})
        chk = self.check("base")
        self.assertTrue(chk["blocked"])
        self.assertEqual(chk["missing_count"], 2)
        self.assertEqual(chk["missing_gb"], 14.13)
        self.assertEqual(chk["family"], "krea2_image")
        self.assertEqual(len(chk["missing"]), 2)

    def test_ready_when_exact_relative_name_present(self):
        self.skill("base", {"family": "f", "label": "L",
                            "files": [entry("model", "krea2/turbo.safetensors", "diffusion_models", 1.0)]})
        self.place("diffusion_models", "krea2/turbo.safetensors")
        chk = self.check("base")
        self.assertEqual((chk["blocked"], chk["files"][0]["ready"]), (False, True))
        self.assertEqual(chk["files"][0]["found"], "krea2/turbo.safetensors")

    def test_pinned_name_is_checked_exactly_like_generation_side(self):
        """配置写死了相对名，同名文件落在别的子目录就是生成侧 resolve_model 的硬报错。"""
        self.skill("pinned", {"family": "f", "label": "L",
                              "files": [entry("model", "qwen_a.safetensors", "diffusion_models", 1.0)]},
                   cfg={"model": "sub/qwen_a.safetensors"})
        self.place("diffusion_models", "other/qwen_a.safetensors")
        chk = self.check("pinned")
        self.assertTrue(chk["blocked"])
        self.assertTrue(chk["files"][0]["pinned"])
        self.assertEqual(chk["files"][0]["found"], "")
        self.assertIn("sub/qwen_a.safetensors", chk["files"][0]["notes"][0])

    def test_pinned_name_ready_at_its_own_path(self):
        self.skill("pinned", {"family": "f", "label": "L",
                              "files": [entry("model", "qwen_a.safetensors", "diffusion_models", 1.0)]},
                   cfg={"model": "sub/qwen_a.safetensors"})
        self.place("diffusion_models", "sub/qwen_a.safetensors")
        chk = self.check("pinned")
        self.assertFalse(chk["blocked"])
        self.assertIn("不是预设推荐名", chk["files"][0]["notes"][0])

    def test_auto_pick_accepts_same_name_in_other_subfolder(self):
        self.skill("auto", {"family": "f", "label": "L",
                            "files": [entry("model", "krea2/turbo.safetensors", "diffusion_models", 1.0)]})
        self.place("diffusion_models", "Krea2/Turbo.SAFETENSORS")
        chk = self.check("auto")
        self.assertEqual((chk["blocked"], chk["files"][0]["pinned"], chk["files"][0]["found"]),
                         (False, False, "Krea2/Turbo.SAFETENSORS"))
        self.assertEqual(chk["files"][0]["notes"], [])

    def test_family_alt_names_cover_missing_recommendation(self):
        self.skill("alt", {"family": "f", "label": "L", "files": [
            entry("model", "krea2/turbo_fp8.safetensors", "diffusion_models", 7.0,
                  alt=["krea2/turbo_int8.safetensors"])]})
        self.place("diffusion_models", "krea2/turbo_int8.safetensors")
        chk = self.check("alt")
        self.assertFalse(chk["blocked"])
        self.assertEqual(chk["files"][0]["found"], "krea2/turbo_int8.safetensors")

    def test_lora_inactive_when_not_in_config(self):
        self.skill("kid", {"family": "f", "label": "L", "files": [
            entry("model", "m.safetensors", "diffusion_models", 1.0),
            entry("loras", "Q/Qwen21-换头.safetensors", "loras", 0.3)]}, cfg={"loras": []})
        self.place("diffusion_models", "m.safetensors")
        chk = self.check("kid")
        lora = chk["files"][1]
        self.assertEqual((lora["active"], lora["ready"]), (False, False))
        self.assertEqual((chk["blocked"], chk["missing_count"]), (False, 0))

    def test_lora_active_from_skill_config_counts_when_missing(self):
        self.skill("kid", {"family": "f", "label": "L", "files": [
            entry("model", "m.safetensors", "diffusion_models", 1.0),
            entry("loras", "Q/Qwen21-换头.safetensors", "loras", 0.3)]},
                   cfg={"loras": [{"name": "Q/Qwen21-换头.safetensors", "strength": 0.8}]})
        self.place("diffusion_models", "m.safetensors")
        chk = self.check("kid")
        self.assertEqual((chk["blocked"], chk["missing_count"], chk["missing_gb"]), (True, 1, 0.3))

    def test_lora_falls_back_to_global_list(self):
        self.skill("kid", {"family": "f", "label": "L", "files": [
            entry("loras", "Lora/a.safetensors", "loras", 0.2)]})
        self.image_cfg["loras"] = [{"name": "Lora/a.safetensors", "strength": 1.0}]
        self.place("loras", "Lora/a.safetensors")
        chk = self.check("kid")
        self.assertEqual((chk["files"][0]["active"], chk["files"][0]["ready"]), (True, True))
        self.assertFalse(chk["blocked"])

    def test_optional_files_never_block(self):
        self.skill("opt", {"family": "f", "label": "L", "files": [
            entry("model", "m.safetensors", "diffusion_models", 1.0),
            entry("loras", "L/a.safetensors", "loras", 0.2, optional=True)]},
                   cfg={"loras": [{"name": "L/a.safetensors", "strength": 1}]})
        self.place("diffusion_models", "m.safetensors")
        chk = self.check("opt")
        self.assertEqual((chk["files"][1]["active"], chk["files"][1]["ready"]), (True, False))
        self.assertFalse(chk["blocked"])




class TestExtendsAndKind(_FixtureCase):
    def test_extends_merges_base_then_appends_dedupe_by_key(self):
        self.skill("base", {"family": "qwen_image_21", "label": "Qwen Image 2.1 族",
                            "files": [entry("model", "qwen/int8.safetensors", "diffusion_models", 11.0),
                                      entry("vae", "qwen_vae.safetensors", "vae", 0.64)]})
        self.skill("kid", {"family": "qwen_image_21", "label": "Qwen Image 2.1 族", "extends": "base",
                           "files": [entry("loras", "Q/face.safetensors", "loras", 0.35),
                                      entry("model", "qwen/int8.safetensors", "diffusion_models", 11.0)]})
        chk = self.check("kid")
        self.assertEqual([f["filename"] for f in chk["files"]],
                         ["qwen/int8.safetensors", "qwen_vae.safetensors", "Q/face.safetensors"])
        # LoRA 不在配置的 LoRA 列表里 → 未激活，不计入缺失体积
        self.assertEqual(chk["missing_gb"], 11.64)

    def test_extends_cycle_stops_at_depth_one(self):
        self.skill("a", {"family": "f", "label": "L", "extends": "b",
                         "files": [entry("model", "a.safetensors", "diffusion_models", 1.0)]})
        self.skill("b", {"family": "f", "label": "L", "extends": "a",
                         "files": [entry("model", "b.safetensors", "diffusion_models", 2.0)]})
        chk = self.check("a")
        self.assertEqual([f["filename"] for f in chk["files"]], ["b.safetensors", "a.safetensors"])
        self.assertEqual(chk["missing_gb"], 3.0)

    def test_manifest_notes_pass_through(self):
        self.skill("v", {"family": "minimax_h3", "label": "H3 视频族", "kind": "video",
                         "notes": ["需 MiniMax H3 VDN 插件", "8100 显存起"],
                         "files": [entry("model", "h3.safetensors", "diffusion_models", 1.0)]})
        chk = self.check("v")
        self.assertEqual(chk["notes"], ["需 MiniMax H3 VDN 插件", "8100 显存起"])
        self.assertEqual(chk["kind"], "video")

    def test_video_kind_reads_video_setting_keys(self):
        self.skill("v", {"family": "h3", "label": "H3", "kind": "video", "files": [
            entry("model", "h3/turbo.safetensors", "diffusion_models", 14.0),
            entry("audio_vae", "h3_audio.safetensors", "vae", 0.1)]})
        self.video_cfg["video_model"] = "h3/turbo.safetensors"
        self.place("diffusion_models", "h3/turbo.safetensors")
        chk = self.check("v")
        self.assertEqual((chk["files"][0]["ready"], chk["files"][1]["ready"]), (True, False))
        self.assertEqual((chk["missing_count"], chk["missing_gb"]), (1, 0.1))

    def test_video_kind_maps_all_four_keys(self):
        self.skill("v", {"family": "h3", "label": "H3", "kind": "video", "files": [
            entry("model", "m.safetensors", "diffusion_models", 1.0),
            entry("text_encoder", "te.safetensors", "text_encoders", 1.0),
            entry("vae", "vae.safetensors", "vae", 1.0),
            entry("audio_vae", "av.safetensors", "vae", 1.0)]})
        self.video_cfg.update({"video_model": "m.safetensors", "video_text_encoder": "te.safetensors",
                               "video_vae": "vae.safetensors", "video_audio_vae": "av.safetensors"})
        for cat, fn in (("diffusion_models", "m.safetensors"), ("text_encoders", "te.safetensors"),
                        ("vae", "vae.safetensors"), ("vae", "av.safetensors")):
            self.place(cat, fn)
        chk = self.check("v")
        self.assertEqual([f["ready"] for f in chk["files"]], [True, True, True, True])
        self.assertFalse(chk["blocked"])



class TestSourceSelection(_FixtureCase):
    def test_plan_uses_current_hub_source(self):
        self.skill("s", {"family": "f", "label": "L", "files": [entry(
            "model", "m.safetensors", "diffusion_models", 5.0,
            sources=[ms_source("Ms/Repo", "diffusion_models/m.safetensors"),
                     hf_source("Hf/Repo", "diffusion_models/m.safetensors")])]})
        self.hub_cfg["source"] = "huggingface"
        plan = self.plan("s")
        self.assertEqual((plan["source"], plan["source_label"]), ("huggingface", "HF"))
        self.assertTrue(plan["needs_token"])
        self.assertFalse(plan["has_token"])
        self.assertEqual(plan["files"][0]["payload"]["repo"], "Hf/Repo")

    def test_explicit_source_argument_wins(self):
        self.skill("s", {"family": "f", "label": "L", "files": [entry(
            "model", "m.safetensors", "diffusion_models", 5.0,
            sources=[ms_source("Ms/Repo", "diffusion_models/m.safetensors"),
                     civ_source("/api/download/models/12345")])]})
        self.hub_cfg["source"] = "modelscope"
        plan = self.plan("s", "civitai")
        self.assertEqual(plan["source"], "civitai")
        self.assertEqual(plan["files"][0]["payload"]["path"], "/api/download/models/12345")
        self.assertTrue(plan["files"][0]["on_source"])

    def test_file_absent_from_current_source_reports_other_source(self):
        self.skill("s", {"family": "f", "label": "L", "files": [entry(
            "model", "m.safetensors", "diffusion_models", 5.0,
            sources=[ms_source("Ms/Repo", "diffusion_models/m.safetensors")])]})
        self.hub_cfg["source"] = "huggingface"
        item = self.plan("s")["files"][0]
        self.assertEqual((item["on_source"], item["reason"], item["other_source"]),
                         (False, "not_on_source", "modelscope"))
        self.assertNotIn("payload", item)
        plan = self.plan("s")
        self.assertEqual((plan["total_gb"], plan["missing_gb"]), (0.0, 5.0))
        self.assertEqual(len(plan["missing"]), 1)

    def test_bad_source_is_flagged_not_planned(self):
        self.skill("s", {"family": "f", "label": "L", "files": [
            entry("model", "m.safetensors", "diffusion_models", 2.0,
                  sources=[ms_source("BadRepo", "diffusion_models/m.safetensors")]),
            entry("vae", "v.safetensors", "vae", 0.5,
                  sources=[ms_source("Ms/Repo", "diffusion_models/../escape")])]})
        plan = self.plan("s")
        self.assertEqual([i["reason"] for i in plan["files"]], ["bad_source", "bad_source"])
        self.assertTrue(all("payload" not in i for i in plan["files"]))
        self.assertEqual(plan["missing_gb"], 2.5)

    def test_gated_hf_and_civitai_key_flags(self):
        self.skill("s", {"family": "f", "label": "L", "files": [
            entry("model", "m.safetensors", "diffusion_models", 1.0,
                  sources=[hf_source("Hf/Repo", "diffusion_models/m.safetensors", gated=True)]),
            entry("vae", "v.safetensors", "vae", 0.5,
                  sources=[civ_source("/api/download/models/99")])]})
        self.hub_cfg["source"] = "huggingface"
        self.assertTrue(self.plan("s")["files"][0]["gated"])
        self.hub_cfg["source"] = "civitai"
        self.civitai_ok = False
        plan = self.plan("s")
        self.assertEqual((plan["source_label"], plan["needs_token"], plan["has_token"]),
                         ("C 站", False, False))
        self.civitai_ok = True
        self.assertTrue(self.plan("s")["has_token"])


class TestDownloadPlan(_FixtureCase):
    def setUp(self):
        super().setUp()
        self.skill("p", {"family": "f", "label": "L", "files": [
            entry("model", "krea/turbo.safetensors", "diffusion_models", 13.49),
            entry("loras", "L/a.safetensors", "loras", 0.2),
            entry("vae", "qwen_vae.safetensors", "vae", 0.64,
                  sources=[ms_source("Ms/Repo", "vae/qwen_vae.safetensors")])]})

    def test_landing_path_follows_repo_relative_subfolder(self):
        plan = self.plan("p")
        item = plan["files"][0]
        self.assertEqual(item["subfolder"], "diffusion_models/krea")
        self.assertEqual(item["payload"]["filename"], "turbo.safetensors")
        self.assertEqual(item["payload"]["path"], "diffusion_models/krea/turbo.safetensors")
        self.assertEqual(item["payload"]["category"], "diffusion_models")

    def test_plan_payload_passes_hub_validators(self):
        """计划条目要能直接 POST 给 /neo_model_hub/download —— 过模型库自己的校验器（非法就抛 HubError）。"""
        item = self.plan("p")["files"][0]["payload"]
        self.assertEqual(model_hub.validate_repo(item["repo"]), "Fake/Repo")
        self.assertEqual(model_hub.validate_path(item["path"]), "diffusion_models/krea/turbo.safetensors")
        self.assertEqual(model_hub.sanitize_subfolder(item["subfolder"]), "diffusion_models/krea")
        self.assertEqual(model_hub.sanitize_filename(item["filename"]), "turbo.safetensors")

    def test_plan_carries_manifest_notes(self):
        self.skill("n", {"family": "f", "label": "L", "notes": ["需额外插件", " 显存 24G 起", ""],
                         "files": [entry("model", "m.safetensors", "diffusion_models", 1.0)]})
        plan = self.plan("n")
        self.assertEqual(plan["notes"], ["需额外插件", "显存 24G 起"])
        self.assertEqual(self.plan("p")["notes"], [])

    def test_ready_files_excluded_from_bytes_and_missing(self):
        self.place("diffusion_models", "krea/turbo.safetensors")
        plan = self.plan("p")
        self.assertEqual(plan["total_gb"], 0.64)
        self.assertEqual(len(plan["files"]), 1)
        self.assertEqual(plan["missing"], [])
        self.assertEqual(plan["missing_gb"], 0.0)

    def test_lora_entry_is_not_in_download_plan(self):
        self.image_cfg["loras"] = [{"name": "L/a.safetensors", "strength": 1.0}]
        self.assertEqual([i["filename"] for i in self.plan("p")["files"]],
                         ["krea/turbo.safetensors", "qwen_vae.safetensors"])

    def test_optional_files_need_flag(self):
        self.skill("o", {"family": "f", "label": "L", "files": [
            entry("model", "m.safetensors", "diffusion_models", 1.0),
            entry("model", "extra.safetensors", "diffusion_models", 0.5, optional=True)]})
        self.assertEqual([i["filename"] for i in self.plan("o")["files"]], ["m.safetensors"])
        self.assertEqual([i["filename"] for i in self.plan("o", include_optional=True)["files"]],
                         ["m.safetensors", "extra.safetensors"])


class TestCheckAll(_FixtureCase):
    def test_check_all_groups_families_and_counts_blockers(self):
        self.skill("krea2_base", {"family": "krea2_image", "label": "Krea2 生图族",
                                  "files": [entry("model", "t.safetensors", "diffusion_models", 13.49)]})
        self.skill("krea2_kid", {"family": "krea2_image", "label": "Krea2 生图族", "extends": "krea2_base",
                                 "files": [entry("loras", "L/a.safetensors", "loras", 0.3)]})
        self.skill("h3", {"family": "minimax_h3", "label": "MiniMax H3 视频族", "kind": "video",
                          "files": [entry("model", "h3.safetensors", "diffusion_models", 14.0)]})
        self.skill("plain")
        out = self.all_overview([("krea2_base", "基础"), ("krea2_kid", "大头"),
                                 ("h3", "视频"), ("plain", "无清单")])
        self.assertEqual((out["family_count"], out["preset_count"], out["blocking_count"]), (2, 3, 2))
        self.assertEqual(sorted(f["family"] for f in out["families"] if f["blocked"]),
                         ["krea2_image", "minimax_h3"])
        krea = next(f for f in out["families"] if f["family"] == "krea2_image")
        self.assertEqual((krea["preset_count"], krea["missing_count"], krea["missing_gb"]), (2, 1, 13.49))
        self.assertEqual(krea["kind"], "image")
        h3 = next(f for f in out["families"] if f["family"] == "minimax_h3")
        self.assertEqual((h3["kind"], h3["missing_gb"]), ("video", 14.0))
        self.assertEqual(out["families"][0]["family"], "krea2_image")

    def test_check_all_empty_data_root_is_not_an_error(self):
        out = self.all_overview([])
        self.assertEqual((out["family_count"], out["families"], out["blocking_count"]), (0, [], 0))

    def test_family_files_dedupe_by_category_and_basename(self):
        out = skill_models.family_files([
            entry("model", "sub/m.safetensors", "diffusion_models", 1.0),
            entry("model", "m.safetensors", "diffusion_models", 1.0),
            entry("clip", "m.safetensors", "text_encoders", 2.0)])
        self.assertEqual([f["filename"] for f in out], ["sub/m.safetensors", "m.safetensors"])

    def test_family_files_skips_entries_without_a_file_name(self):
        self.assertEqual(skill_models.family_files([{"category": "vae", "filename": " "}]), [])
        self.assertEqual(skill_models.family_files([]), [])


class TestShippedManifests(unittest.TestCase):
    """随包 37 份 models.json 的静态口径：字段齐、出处合法、落盘子目录与模型 hub 一致。"""

    def manifests(self):
        return sorted(d.name for d in _PRESETS.iterdir() if (d / "models.json").is_file())

    def manifest(self, preset_id):
        return json.loads((_PRESETS / preset_id / "models.json").read_text(encoding="utf-8"))

    def test_every_preset_dir_is_accounted_for(self):
        """预设目录要么带清单，要么在"没有本地模型文件要检查"的白名单里（翻译 / TTS 预设）。"""
        shipped = sorted(d.name for d in _PRESETS.iterdir() if d.is_dir())
        self.assertEqual(self.manifests(), sorted(set(shipped) - NO_MANIFEST_PRESETS))
        self.assertEqual(len(self.manifests()), 37)
        self.assertTrue(set(NO_MANIFEST_PRESETS) <= set(shipped))

    def test_required_fields_positive_size_and_known_source(self):
        for pid in self.manifests():
            manifest = self.manifest(pid)
            with self.subTest(preset=pid):
                for key in ("family", "label"):
                    self.assertTrue(str(manifest.get(key, "")).strip(), f"{pid} 缺 {key}")
                self.assertIn(manifest.get("kind", "image"), ("image", "video"))
                if not manifest.get("extends"):
                    self.assertTrue(manifest.get("files"), f"{pid} 是族系基座，必须有文件清单")
                for item in manifest.get("files") or []:
                    self.assertTrue(str(item.get("field", "")).strip())
                    self.assertTrue(str(item.get("filename", "")).strip())
                    self.assertTrue(str(item.get("category", "")).strip())
                    self.assertGreater(float(item.get("gb", 0)), 0)
                    self.assertTrue(item.get("sources"))
                    for src in item["sources"]:
                        self.assertIn(src["source"], ("modelscope", "huggingface", "civitai"))
                        if src["source"] == "civitai":
                            self.assertTrue(src["path"].startswith("/api/download/models/"),
                                            f"{pid} C 站出处不是下载端点")

    def test_manifest_source_payloads_pass_hub_validators(self):
        """清单出处要能直接喂给 /neo_model_hub/download：repo/path 过它自己的校验器（非法即抛 HubError）。"""
        for pid in self.manifests():
            for item in self.manifest(pid).get("files") or []:
                for src in item["sources"]:
                    with self.subTest(preset=pid, repo=src["repo"], path=src["path"]):
                        if src["source"] == "civitai":
                            self.assertTrue(model_hub.validate_civitai_path(src["path"]))
                        else:
                            self.assertTrue(model_hub.validate_repo(src["repo"]))
                            self.assertTrue(model_hub.validate_path(src["path"]))

    def test_repo_shape_is_owner_slash_name(self):
        for pid in self.manifests():
            for item in self.manifest(pid).get("files") or []:
                for src in item["sources"]:
                    if src["source"] == "civitai":
                        continue
                    with self.subTest(preset=pid, repo=src["repo"]):
                        self.assertGreaterEqual(len(src["repo"].split("/")), 2)
                        self.assertNotIn("..", src["repo"].split("/"))

    def test_filename_basename_is_the_repo_file_basename(self):
        """落盘名 = 配置名末段：与仓库文件名同名最省事；模型库按仓库名落盘，不同名时必须在 alt 里认得它。"""
        for pid in self.manifests():
            for item in self.manifest(pid).get("files") or []:
                want = item["filename"].replace("\\", "/").split("/")[-1].lower()
                alts = [str(a).replace("\\", "/").split("/")[-1].lower() for a in (item.get("alt") or [])]
                for src in item["sources"]:
                    if src["source"] == "civitai":
                        continue  # C 站按配置名落盘，仓库端点里没有文件名
                    with self.subTest(preset=pid, filename=item["filename"], path=src["path"]):
                        base = src["path"].replace("\\", "/").split("/")[-1].lower()
                        self.assertTrue(base == want or base in alts,
                                        f"{pid}: 仓库文件 {base} 落盘后清单认不出")

    def test_extends_points_to_shipped_base_with_files(self):
        for pid in self.manifests():
            base_id = self.manifest(pid).get("extends", "")
            if not base_id:
                continue
            with self.subTest(preset=pid, base=base_id):
                self.assertTrue((_PRESETS / base_id / "models.json").is_file())
                self.assertTrue(self.manifest(base_id).get("files"))

    def test_family_sharing_presets_cover_their_base_files(self):
        """族里每个预设都要认它的基座清单项 —— extends 缺失会让预设显示为「缺基座模型」。"""
        for pid in self.manifests():
            manifest = self.manifest(pid)
            if not manifest.get("extends"):
                continue
            base = self.manifest(manifest["extends"])
            with self.subTest(preset=pid):
                self.assertEqual(manifest["family"], base["family"])
                self.assertEqual(manifest["label"], base["label"])
                self.assertEqual(manifest["kind"], base.get("kind", "image"))

    def test_landing_subfolder_survives_hub_sanitizer(self):
        """配置名带子目录时，落盘子目录必须能过模型库的消毒器，否则计划条目会被下载器改名。"""
        for pid in self.manifests():
            for item in self.manifest(pid).get("files") or []:
                rel = item["filename"].replace("\\", "/")
                with self.subTest(preset=pid, filename=item["filename"]):
                    self.assertEqual(model_hub.sanitize_subfolder(skill_models.subfolder_of(rel)),
                                     skill_models.subfolder_of(rel).strip("/"))

    def test_family_label_is_shared_across_the_family(self):
        """同族预设共用一个族系标签：聚合面板按它显示族名，不能让某个预设自带别名。"""
        groups = {}
        for pid in self.manifests():
            manifest = self.manifest(pid)
            groups.setdefault(manifest["family"], set()).add((manifest["label"], manifest["kind"]))
        for family, pairs in groups.items():
            with self.subTest(family=family):
                self.assertEqual(len(pairs), 1)


if __name__ == "__main__":
    unittest.main()

