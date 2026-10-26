# SPDX-License-Identifier: Apache-2.0
# Neo Studio - Skills Unit Tests
# 测试 skill 元数据扫描与图片解析 helper（P1 MVP）

from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import base64
import io
import os
import sys
import json
import types
import asyncio
import tempfile
import importlib
import unittest

# 添加父目录到路径以导入模块
_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)
# ComfyUI 根目录（提供 server / folder_paths / torch 等模块）
import _comfy_api_bootstrap  # noqa: E402
_COMFY_ROOT = _comfy_api_bootstrap.comfy_root()
sys.path.insert(0, _COMFY_ROOT)

# prompts.py 使用相对导入（from .llm import / from .gallery import），
# 需要作为包的子模块加载
_PKG_NAME = "_neo_nodes_test_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg

# stub server 模块（脱离 ComfyUI 服务器运行时，PromptServer.instance 不存在）
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

_fake_server = types.ModuleType("server")
_fake_server.PromptServer = _FakePromptServer
sys.modules["server"] = _fake_server

try:
    prompts_mod = importlib.import_module(f"{_PKG_NAME}.prompts")
    PROMPTS_AVAILABLE = True
except Exception as _e:  # 缺少 server/torch 等依赖时跳过
    prompts_mod = None
    PROMPTS_AVAILABLE = False
    _IMPORT_ERROR = _e

_reason = "" if PROMPTS_AVAILABLE else f"prompts module unavailable: {_IMPORT_ERROR}"


def _png_data_uri(size=(2048, 1024)):
    """生成测试用 PNG data URI"""
    from PIL import Image
    img = Image.new("RGB", size, (200, 100, 50))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestScanSkills(unittest.TestCase):
    """测试 skill.scan_skills 统一元数据"""

    # multi_turn 断言针对自定义技能：测试数据根是隔离目录，夹具自建自清理
    _MULTI_TURN_SKILLS = ("co-op-game-intro-generator", "3d-animation-short-generator")

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.skill_mod = _il.import_module(f"{_PKG_NAME}.skill")
        cls._created_skill_dirs = []
        for sid in cls._MULTI_TURN_SKILLS:
            d = os.path.join(cls.skill_mod.SKILL_CUSTOM_DIR, sid)
            if os.path.isfile(os.path.join(d, "skill.md")):
                continue
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
                f.write(f"---\nname: {sid}\nmulti_turn: true\n---\nfixture body\n")
            cls._created_skill_dirs.append(d)

    @classmethod
    def tearDownClass(cls):
        import shutil
        for d in cls._created_skill_dirs:
            shutil.rmtree(d, ignore_errors=True)

    def _scan(self):
        return self.skill_mod.scan_skills()

    def test_reverse_prompt_is_vision_skill(self):
        skills = self._scan()
        by_id = {s["id"]: s for s in skills}
        self.assertIn("reverse_prompt", by_id)
        rp = by_id["reverse_prompt"]
        self.assertTrue(rp["needs_image"], "reverse_prompt 必须标记为需要图片")
        self.assertIn("image", rp["inputs"])
        self.assertEqual(rp["category"], "vision")

    def test_builtin_task_skills_exist(self):
        ids = {s["id"] for s in self._scan()}
        self.assertTrue({"smart_prompt", "translate_prompt"} <= ids)

    def test_storyboard_story_task_registered(self):
        """"九宫格故事" 任务：简要故事 + 参考图（vision），且已注册进 llm.LLM_TASKS"""
        by_id = {s["id"]: s for s in self._scan()}
        s = by_id.get("storyboard_story")
        self.assertIsNotNone(s, "storyboard_story 任务未被扫描到")
        self.assertTrue(s["needs_image"], "storyboard_story 需要参考图")
        self.assertEqual(s["category"], "vision")
        # 其它测试文件可能把 llm 从 sys.modules 里移除过（如 h3_prompt_audit 的桩清理），
        # 这里按需重新导入再查注册表，避免受文件间执行顺序影响
        llm_mod = importlib.import_module(f"{_PKG_NAME}.llm")
        self.assertIn("storyboard_story", getattr(llm_mod, "LLM_TASKS", {}),
                      "storyboard_story 未注册进 llm 的任务列表（task_names）")

    def test_storyboard_grid_skills_carry_story_contract(self):
        """storyboard_grid_* 技能：正文既是生图模板（{story} 占位），又含给 LLM 的编剧说明块。

        前端按所选技能当编剧技能（正文即系统提示词），并把 <!-- @story-writer -->…<!-- @end -->
        区块从生图提示词里剔除，所以这两部分都必须在正文里。"""
        ids = {s["id"] for s in self._scan()}
        for n in (4, 6, 9):
            sid = f"storyboard_grid_{n}"
            self.assertIn(sid, ids, f"{sid} 未被扫描到")
            content = self.skill_mod.load_skill_content(sid) or ""
            self.assertIn("{story}", content, f"{sid} 缺少 {{story}} 占位符（生图模板插入点）")
            self.assertIn("<!-- @story-writer -->", content, f"{sid} 缺少编剧说明块")
            self.assertIn("<!-- @end -->", content, f"{sid} 编剧说明块未闭合")
            # 剔掉编剧区块后必须只剩一个 {story}：前端是全局替换，多一个会把故事注入说明里
            import re
            stripped = re.sub(r"<!--\s*@story-writer\s*-->[\s\S]*?<!--\s*@end\s*-->", "", content)
            self.assertEqual(stripped.count("{story}"), 1,
                             f"{sid} 剔除编剧区块后应只剩一个 {{story}} 占位符")

    def test_storyboard_ref_detail_task_registered(self):
        """"参考图人物与服装细节" 任务：生图前做文字锚定用（前端按 id 调用），必须有参考图输入"""
        by_id = {s["id"]: s for s in self._scan()}
        s = by_id.get("storyboard_ref_detail")
        self.assertIsNotNone(s, "storyboard_ref_detail 任务未被扫描到")
        self.assertTrue(s["needs_image"], "storyboard_ref_detail 需要参考图")

    def test_internal_tasks_hidden(self):
        """内部任务不作为可选 skill 暴露"""
        ids = {s["id"] for s in self._scan()}
        self.assertFalse({"template_prompt", "extract_title", "extract_classify"} & ids)

    def test_template_skills_are_text_only(self):
        """纯 prompt 模板（非工作流导入）未声明 image 输入时默认为纯文本 skill。

        工作流导入的 skill（带 workflow.json，has_workflow=True）可合法引用图片，不参与此断言。"""
        styles = {s["id"]: s for s in self._scan()
                  if s["source"] in ("presets", "custom")
                  and not s.get("has_workflow")
                  and s["id"] not in ("minimax_h3_base", "minimax_h3_full_ref", "minimax_h3_image_ref", "image_to_video")}
        self.assertTrue(len(styles) > 0, "至少应扫描到一个模板 skill")
        for sid, s in styles.items():
            self.assertFalse(s["needs_image"], f"普通模板不应需要图片: {sid}")

    def test_minimax_h3_full_ref_skill(self):
        """内置 H3 全参考模板：图像输入 + video_enhance 分类"""
        by_id = {s["id"]: s for s in self._scan()}
        s = by_id.get("minimax_h3_full_ref")
        self.assertIsNotNone(s, "minimax_h3_full_ref 模板未被扫描到")
        self.assertTrue(s["needs_image"])
        self.assertEqual(s["category"], "video_enhance")

    def test_skill_fields_complete(self):
        for s in self._scan():
            for field in ("id", "name", "category", "source", "inputs",
                          "needs_image", "multi_turn"):
                self.assertIn(field, s)

    def test_multi_turn_flag(self):
        """multi_turn 标志：声明的技能为 True，未声明默认 False"""
        by_id = {s["id"]: s for s in self._scan()}
        for sid in ("co-op-game-intro-generator", "3d-animation-short-generator"):
            s = by_id.get(sid)
            self.assertIsNotNone(s, f"未扫描到技能: {sid}")
            self.assertTrue(s["multi_turn"], f"{sid} 应声明 multi_turn")
        ref = by_id.get("minimax_h3_full_ref")
        if ref is not None:
            self.assertFalse(ref["multi_turn"])

    def test_name_pinyin_tags_ascii_noop(self):
        """纯英文/数字名称不产生拼音标签"""
        self.assertEqual(self.skill_mod._skill_name_pinyin_tags("Enhance HD"), [])

    def test_name_pinyin_tags_chinese_full_and_initials(self):
        """中文名称生成全拼 + 首字母缩写；无 pypinyin 时优雅降级为空"""
        tags = self.skill_mod._skill_name_pinyin_tags("动漫风格")
        if self.skill_mod.lazy_pinyin is None:
            self.assertEqual(tags, [])
        else:
            self.assertIn("dongmanfengge", tags)
            self.assertIn("dmfg", tags)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestGenConfigSummary(unittest.TestCase):
    """_gen_config_summary：从技能有效 config 提取列表预览摘要，只保留非空项，全空返回 None"""

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.skill_mod = _il.import_module(f"{_PKG_NAME}.skill")

    def test_full_config(self):
        s = self.skill_mod._gen_config_summary({
            "model": "qwen3.safetensors",
            "loras": [{"name": "a.safetensors", "strength": 0.8}, {"name": "b.safetensors"}],
            "base_resolution": 1024,
            "default_ratio": "9:16",
            "steps": 8,
        })
        self.assertEqual(s, {
            "model": "qwen3.safetensors",
            "loras": ["a.safetensors", "b.safetensors"],
            "base_resolution": 1024,
            "default_ratio": "9:16",
            "steps": 8,
        })

    def test_empty_or_invalid_omitted(self):
        s = self.skill_mod._gen_config_summary({
            "model": "   ",
            "loras": [{"name": ""}, {"name": "x.safetensors"}, None, "y.safetensors", "x.safetensors"],
            "base_resolution": "not-a-number",
            "default_ratio": "",
            "count": 4,  # 非摘要字段，忽略
        })
        self.assertEqual(s, {"loras": ["x.safetensors", "y.safetensors"]})

    def test_all_empty_returns_none(self):
        self.assertIsNone(self.skill_mod._gen_config_summary({}))
        self.assertIsNone(self.skill_mod._gen_config_summary(
            {"model": "", "loras": [], "base_resolution": 0, "default_ratio": None}))
        self.assertIsNone(self.skill_mod._gen_config_summary(None))

    def test_base_resolution_positive_int_only(self):
        self.assertIsNone(self.skill_mod._gen_config_summary({"base_resolution": -5}))
        self.assertEqual(self.skill_mod._gen_config_summary({"base_resolution": "1024"})["base_resolution"], 1024)

    def test_steps_positive_int_only(self):
        # 预览卡「步数」行：只保留正整数（缺省 20 由前端显示）
        self.assertEqual(self.skill_mod._gen_config_summary({"steps": 8}), {"steps": 8})
        self.assertEqual(self.skill_mod._gen_config_summary({"steps": "12"})["steps"], 12)
        self.assertIsNone(self.skill_mod._gen_config_summary({"steps": 0}))
        self.assertIsNone(self.skill_mod._gen_config_summary({"steps": -1}))
        self.assertIsNone(self.skill_mod._gen_config_summary({"steps": "many"}))
        self.assertIsNone(self.skill_mod._gen_config_summary({"steps": None}))


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestScanSkillsGenConfig(unittest.TestCase):
    """scan_skills：生图/生视频技能附带 gen_config 摘要（tasks 与 presets/custom 两分支）；非生图或空配置不附"""

    def setUp(self):
        self.skill_mod = getattr(prompts_mod, "skill", None)
        if self.skill_mod is None:
            self.skipTest("prompts 未暴露 skill 模块")
        self._tmp = tempfile.TemporaryDirectory()
        root = self._tmp.name
        self._orig_custom = self.skill_mod.SKILL_CUSTOM_DIR
        self._orig_tasks = self.skill_mod.TASKS_DIR
        self.skill_mod.SKILL_CUSTOM_DIR = os.path.join(root, "custom")
        self.skill_mod.TASKS_DIR = os.path.join(root, "tasks")

    def tearDown(self):
        self.skill_mod.SKILL_CUSTOM_DIR = self._orig_custom
        self.skill_mod.TASKS_DIR = self._orig_tasks
        self._tmp.cleanup()

    def _write_config(self, d, config):
        if config is not None:
            with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
                json.dump(config, f)

    def _by_id(self):
        return {s["id"]: s for s in self.skill_mod.scan_skills()}

    def test_task_gen_image_skill_gets_summary(self):
        # tasks 分支：gen_image 任务技能附带有效 config 摘要
        d = os.path.join(self._tmp.name, "tasks", "zz-test-gen-task")
        os.makedirs(d)
        with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
            f.write("---\nname: zz-test-gen-task\ngen_image: true\n---\nbody\n")
        self._write_config(d, {"model": "task-model.safetensors", "default_ratio": "16:9"})
        s = self._by_id().get("zz-test-gen-task")
        self.assertIsNotNone(s, "任务技能应被扫描到")
        self.assertEqual(s["source"], "tasks")
        self.assertEqual(s.get("gen_config"), {"model": "task-model.safetensors", "default_ratio": "16:9"})

    def test_custom_gen_skill_partial_config(self):
        # presets/custom 分支：部分配置只附非空项
        sid = "zz-test-custom-gen"
        self.assertTrue(self.skill_mod.save_skill_main(
            sid, "ZZ Test Custom Gen", "body", None, "custom", False,
            category="image_gen", gen_image=True))
        self._write_config(os.path.join(self._tmp.name, "custom", sid), {"model": "m.safetensors"})
        s = self._by_id().get(sid)
        self.assertIsNotNone(s, "自定义技能应被扫描到")
        self.assertEqual(s.get("gen_config"), {"model": "m.safetensors"})

    def test_empty_config_not_attached(self):
        # 生视频但 config 全空 → 不附 gen_config 键
        sid = "zz-test-empty-cfg"
        self.assertTrue(self.skill_mod.save_skill_main(
            sid, "ZZ Test Empty Cfg", "body", None, "custom", False,
            category="video_gen", gen_video=True))
        self._write_config(os.path.join(self._tmp.name, "custom", sid), {})
        s = self._by_id().get(sid)
        self.assertIsNotNone(s)
        self.assertNotIn("gen_config", s)

    def test_non_gen_skill_not_attached_even_with_config(self):
        # 非生图/生视频技能：即使有 config.json 也不附 gen_config
        sid = "zz-test-non-gen"
        self.assertTrue(self.skill_mod.save_skill_main(
            sid, "ZZ Test Non Gen", "body", None, "custom"))
        self._write_config(os.path.join(self._tmp.name, "custom", sid), {"model": "m.safetensors"})
        s = self._by_id().get(sid)
        self.assertIsNotNone(s)
        self.assertNotIn("gen_config", s)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestVideoSkillAvailable(unittest.TestCase):
    """scan_skills：gen_video 技能附 available 标记（VDN 加速技能依赖 ComfyUI-VDN-H3 插件）；非视频技能不附"""

    def setUp(self):
        self.skill_mod = getattr(prompts_mod, "skill", None)
        if self.skill_mod is None:
            self.skipTest("prompts 未暴露 skill 模块")
        self._tmp = tempfile.TemporaryDirectory()
        root = self._tmp.name
        self._orig_custom = self.skill_mod.SKILL_CUSTOM_DIR
        self._orig_tasks = self.skill_mod.TASKS_DIR
        self.skill_mod.SKILL_CUSTOM_DIR = os.path.join(root, "custom")
        self.skill_mod.TASKS_DIR = os.path.join(root, "tasks")
        # 真实环境可能装了 VDN 插件：测试期间固定为「未装」，tearDown 还原
        self._orig_vdn = self.skill_mod._vdn_plugin_installed
        self.skill_mod._vdn_plugin_installed = lambda: False

    def tearDown(self):
        self.skill_mod.SKILL_CUSTOM_DIR = self._orig_custom
        self.skill_mod.TASKS_DIR = self._orig_tasks
        self.skill_mod._vdn_plugin_installed = self._orig_vdn
        self._tmp.cleanup()

    def _make_video_skill(self, sid, workflow):
        self.assertTrue(self.skill_mod.save_skill_main(
            sid, sid, "body", None, "custom", False,
            category="video_gen", gen_video=True))
        d = os.path.join(self._tmp.name, "custom", sid)
        if workflow is not None:
            with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
                json.dump(workflow, f)
        return d

    def _by_id(self):
        return {s["id"]: s for s in self.skill_mod.scan_skills()}

    def test_vdn_skill_unavailable_without_plugin(self):
        # workflow 引用 VDN 节点且插件未装 → available=False
        self._make_video_skill("zz-test-vdn", {
            "1": {"class_type": "UNETLoader", "inputs": {}},
            "2": {"class_type": "ApplyVDNH3Advanced", "inputs": {"model": ["1", 0]}},
        })
        s = self._by_id().get("zz-test-vdn")
        self.assertIsNotNone(s, "视频技能应被扫描到")
        self.assertIs(s.get("available"), False)

    def test_vdn_skill_available_with_plugin(self):
        # VDN 插件目录存在（已装）→ available=True
        self.skill_mod._vdn_plugin_installed = lambda: True
        self._make_video_skill("zz-test-vdn2", {
            "2": {"class_type": "ApplyVDNH3Advanced", "inputs": {}},
        })
        s = self._by_id().get("zz-test-vdn2")
        self.assertIsNotNone(s)
        self.assertIs(s.get("available"), True)

    def test_non_vdn_video_skill_available(self):
        # workflow 不引用 VDN → 恒可用（与插件无关）
        self._make_video_skill("zz-test-plain", {"1": {"class_type": "UNETLoader", "inputs": {}}})
        s = self._by_id().get("zz-test-plain")
        self.assertIsNotNone(s)
        self.assertIs(s.get("available"), True)

    def test_non_video_skill_no_available_field(self):
        # 非视频技能不附 available 字段
        sid = "zz-test-nonvideo"
        self.assertTrue(self.skill_mod.save_skill_main(sid, "ZZ Test NonVideo", "body", None, "custom"))
        s = self._by_id().get(sid)
        self.assertIsNotNone(s)
        self.assertNotIn("available", s)

    def test_load_skill_route_returns_available(self):
        # 详情弹窗顶部「不可用」说明靠 load_skill 响应的 available 字段
        self._make_video_skill("zz-test-vdn-route", {
            "2": {"class_type": "ApplyVDNH3Advanced", "inputs": {}},
        })
        async def _json():
            return {"id": "zz-test-vdn-route"}
        resp = asyncio.run(self.skill_mod.rs_prompts_load_skill(
            types.SimpleNamespace(json=_json)))
        body = json.loads(resp.body)
        self.assertIs(body["available"], False)

        self._make_video_skill("zz-test-plain-route", {"1": {"class_type": "UNETLoader", "inputs": {}}})
        async def _json2():
            return {"id": "zz-test-plain-route"}
        resp = asyncio.run(self.skill_mod.rs_prompts_load_skill(
            types.SimpleNamespace(json=_json2)))
        body = json.loads(resp.body)
        self.assertIs(body["available"], True)

        sid = "zz-test-nonvideo-route"
        self.assertTrue(self.skill_mod.save_skill_main(sid, "ZZ Route", "body", None, "custom"))
        async def _json3():
            return {"id": sid}
        resp = asyncio.run(self.skill_mod.rs_prompts_load_skill(
            types.SimpleNamespace(json=_json3)))
        body = json.loads(resp.body)
        self.assertNotIn("available", body)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestSaveSkillMultiTurn(unittest.TestCase):
    """save_skill_main 的 multi_turn 设置：显式写入 / 缺省沿用 / False 移除"""

    def setUp(self):
        self.skill_mod = getattr(prompts_mod, "skill", None)
        if self.skill_mod is None:
            self.skipTest("prompts 未暴露 skill 模块")
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_dir = self.skill_mod.SKILL_CUSTOM_DIR
        self.skill_mod.SKILL_CUSTOM_DIR = self._tmp.name

    def tearDown(self):
        self.skill_mod.SKILL_CUSTOM_DIR = self._orig_dir
        self._tmp.cleanup()

    def _read_meta(self, sid):
        main = os.path.join(self._tmp.name, sid, "skill.md")
        with open(main, encoding="utf-8") as f:
            meta, body = self.skill_mod.split_frontmatter(f.read())
        return meta, body

    def test_explicit_true_writes_field(self):
        self.assertTrue(self.skill_mod.save_skill_main("mt-a", "MT A", "body", None, "custom", True))
        meta, body = self._read_meta("mt-a")
        self.assertIs(meta.get("multi_turn"), True)
        self.assertEqual(body, "body")

    def test_omitted_preserves_existing(self):
        self.skill_mod.save_skill_main("mt-b", "MT B", "body", None, "custom", True)
        self.assertTrue(self.skill_mod.save_skill_main("mt-b", "MT B", "body2", None, "custom"))
        meta, body = self._read_meta("mt-b")
        self.assertIs(meta.get("multi_turn"), True)
        self.assertEqual(body, "body2")

    def test_explicit_false_removes_field(self):
        self.skill_mod.save_skill_main("mt-c", "MT C", "body", None, "custom", True)
        self.assertTrue(self.skill_mod.save_skill_main("mt-c", "MT C", "body", None, "custom", False))
        meta, _ = self._read_meta("mt-c")
        self.assertNotIn("multi_turn", meta)

    def test_new_skill_defaults_absent(self):
        self.assertTrue(self.skill_mod.save_skill_main("mt-d", "MT D", "body", None, "custom"))
        meta, _ = self._read_meta("mt-d")
        self.assertNotIn("multi_turn", meta)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestSaveSkillGenFields(unittest.TestCase):
    """save_skill_main 生图/生视频字段（复制为自定义场景）：显式写入 / 缺省沿用 / 假值移除"""

    def setUp(self):
        self.skill_mod = getattr(prompts_mod, "skill", None)
        if self.skill_mod is None:
            self.skipTest("prompts 未暴露 skill 模块")
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_dir = self.skill_mod.SKILL_CUSTOM_DIR
        self.skill_mod.SKILL_CUSTOM_DIR = self._tmp.name

    def tearDown(self):
        self.skill_mod.SKILL_CUSTOM_DIR = self._orig_dir
        self._tmp.cleanup()

    def _read_meta(self, sid):
        main = os.path.join(self._tmp.name, sid, "skill.md")
        with open(main, encoding="utf-8") as f:
            meta, body = self.skill_mod.split_frontmatter(f.read())
        return meta, body

    def test_copy_like_save_writes_gen_fields(self):
        # 前端复制预设生图技能时发送的字段：category/gen_image 写入，requires_ref 假值移除
        self.assertTrue(self.skill_mod.save_skill_main(
            "gen-copy", "Gen (Copy)", "body", None, "custom", False,
            category="image_gen", gen_image=True, requires_ref=False))
        meta, _ = self._read_meta("gen-copy")
        self.assertEqual(meta.get("category"), "image_gen")
        self.assertIs(meta.get("gen_image"), True)
        self.assertNotIn("requires_ref", meta)

    def test_omitted_preserves_existing(self):
        # 普通保存（handleSave 不传这三个字段）不得清掉既写生图标记
        self.skill_mod.save_skill_main("gen-keep", "GK", "body", None, "custom", False,
                                       category="image_gen", gen_image=True)
        self.assertTrue(self.skill_mod.save_skill_main("gen-keep", "GK2", "body2", None, "custom"))
        meta, _ = self._read_meta("gen-keep")
        self.assertEqual(meta.get("category"), "image_gen")
        self.assertIs(meta.get("gen_image"), True)

    def test_explicit_false_removes_fields(self):
        self.skill_mod.save_skill_main("gen-off", "GO", "body", None, "custom", False,
                                       category="image_gen", gen_image=True, requires_ref=True)
        self.assertTrue(self.skill_mod.save_skill_main(
            "gen-off", "GO", "body", None, "custom", False,
            category="", gen_image=False, requires_ref=False))
        meta, _ = self._read_meta("gen-off")
        self.assertNotIn("category", meta)
        self.assertNotIn("gen_image", meta)
        self.assertNotIn("requires_ref", meta)

    def test_copy_like_save_writes_video_mode(self):
        # 前端复制预设视频技能时发送 category/gen_video/mode：mode（t2v/i2v/fl2v/r2v）必须落盘
        self.assertTrue(self.skill_mod.save_skill_main(
            "vid-copy", "Vid (Copy)", "body", None, "custom", False,
            category="video_gen", gen_video=True, mode="i2v"))
        meta, _ = self._read_meta("vid-copy")
        self.assertEqual(meta.get("category"), "video_gen")
        self.assertIs(meta.get("gen_video"), True)
        self.assertEqual(meta.get("mode"), "i2v")

    def test_video_mode_omitted_preserves_existing(self):
        # 普通保存（handleSave 不传 mode）不得清掉视频模式
        self.skill_mod.save_skill_main("vid-keep", "VK", "body", None, "custom", False,
                                       category="video_gen", gen_video=True, mode="t2v")
        self.assertTrue(self.skill_mod.save_skill_main("vid-keep", "VK2", "body2", None, "custom"))
        meta, _ = self._read_meta("vid-keep")
        self.assertEqual(meta.get("mode"), "t2v")

    def test_empty_video_mode_removes_field(self):
        self.skill_mod.save_skill_main("vid-off", "VO", "body", None, "custom", False,
                                       category="video_gen", gen_video=True, mode="r2v")
        self.assertTrue(self.skill_mod.save_skill_main(
            "vid-off", "VO", "body", None, "custom", False,
            category="video_gen", gen_video=False, mode=""))
        meta, _ = self._read_meta("vid-off")
        self.assertNotIn("mode", meta)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestSaveComboSkill(unittest.TestCase):
    """save_combo_as_skill：把"主模型 + LoRA"组合存为新技能（名称自动生成，其余设置沿用源技能）"""

    def setUp(self):
        self.skill_mod = getattr(prompts_mod, "skill", None)
        if self.skill_mod is None:
            self.skipTest("prompts 未暴露 skill 模块")
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_dir = self.skill_mod.SKILL_CUSTOM_DIR
        self.skill_mod.SKILL_CUSTOM_DIR = self._tmp.name

    def tearDown(self):
        self.skill_mod.SKILL_CUSTOM_DIR = self._orig_dir
        self._tmp.cleanup()

    def _make_source(self, sid="src-t2i", model="krea2.safetensors", with_workflow=True):
        d = os.path.join(self._tmp.name, sid)
        os.makedirs(d)
        with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
            f.write(self.skill_mod.serialize_frontmatter({
                "name": sid, "cn_name": "源文生图", "tags": ["test"],
                "inputs": ["text"], "category": "image_gen", "gen_image": True,
            }, "body"))
        if with_workflow:
            wf = {"1": {"class_type": "KSampler", "inputs": {}},
                  "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{PROMPT}}"}}}
            with open(os.path.join(d, "workflow.json"), "w", encoding="utf-8") as f:
                json.dump(wf, f)
        cfg = {"model": model, "text_encoder": "t5.safetensors", "steps": 25, "loras": [],
               "default_ratio": "1:1", "base_resolution": 1280}
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        return d

    def _read_files(self, sid):
        d = os.path.join(self._tmp.name, sid)
        with open(os.path.join(d, "skill.md"), encoding="utf-8") as f:
            meta, _ = self.skill_mod.split_frontmatter(f.read())
        with open(os.path.join(d, "workflow.json"), encoding="utf-8") as f:
            wf = json.load(f)
        with open(os.path.join(d, "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        return meta, wf, cfg

    def test_model_and_lora_combo(self):
        self._make_source()
        res = self.skill_mod.save_combo_as_skill(
            "src-t2i", "qwen_image_2.1.safetensors",
            [{"name": "cute_style.safetensors", "strength": 0.8}])
        self.assertTrue(res["success"])
        self.assertEqual(res["name"], "qwen_image_2.1-cute_style")
        meta, wf, cfg = self._read_files(res["id"])
        # skill.md：纯文生图技能，名称自动生成
        self.assertEqual(meta.get("cn_name"), "qwen_image_2.1-cute_style")
        self.assertEqual(meta.get("category"), "image_gen")
        self.assertIs(meta.get("gen_image"), True)
        self.assertEqual(meta.get("inputs"), ["text"])
        # workflow.json 原样复制自源技能
        self.assertEqual(wf, {"1": {"class_type": "KSampler", "inputs": {}},
                              "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{PROMPT}}"}}})
        # config：只覆盖 model/loras，其余设置沿用源技能
        self.assertEqual(cfg["model"], "qwen_image_2.1.safetensors")
        self.assertEqual(cfg["loras"], [{"name": "cute_style.safetensors", "strength": 0.8}])
        self.assertEqual(cfg["text_encoder"], "t5.safetensors")
        self.assertEqual(cfg["steps"], 25)

    def test_lora_only_keeps_source_model(self):
        self._make_source()
        res = self.skill_mod.save_combo_as_skill("src-t2i", "", [{"name": "lora_a.safetensors"}])
        self.assertTrue(res["success"])
        self.assertEqual(res["name"], "lora_a")
        _, _, cfg = self._read_files(res["id"])
        self.assertEqual(cfg["model"], "krea2.safetensors", "未选主模型时沿用源技能模型")
        self.assertEqual(cfg["loras"], [{"name": "lora_a.safetensors", "strength": 1.0}])

    def test_ratio_and_edge_saved_when_selected(self):
        self._make_source()
        res = self.skill_mod.save_combo_as_skill(
            "src-t2i", "m.safetensors", [], ratio="16:9", base_resolution=2048)
        self.assertTrue(res["success"])
        _, _, cfg = self._read_files(res["id"])
        self.assertEqual(cfg["default_ratio"], "16:9")
        self.assertEqual(cfg["base_resolution"], 2048)

    def test_empty_ratio_edge_keeps_source(self):
        self._make_source()
        res = self.skill_mod.save_combo_as_skill("src-t2i", "m.safetensors", [])
        self.assertTrue(res["success"])
        _, _, cfg = self._read_files(res["id"])
        self.assertEqual(cfg.get("default_ratio"), "1:1", "未选比例时沿用源技能")
        self.assertEqual(cfg.get("base_resolution"), 1280, "未选最长边时沿用源技能")

    def test_id_conflict_gets_suffix(self):
        self._make_source()
        r1 = self.skill_mod.save_combo_as_skill("src-t2i", "m.safetensors", [])
        r2 = self.skill_mod.save_combo_as_skill("src-t2i", "m.safetensors", [])
        self.assertTrue(r1["success"] and r2["success"])
        self.assertEqual(r2["id"], f"{r1['id']}-2")

    def test_empty_selection_fails(self):
        self._make_source()
        res = self.skill_mod.save_combo_as_skill("src-t2i", "", [])
        self.assertFalse(res["success"])

    def test_missing_source_fails(self):
        res = self.skill_mod.save_combo_as_skill("nope", "m.safetensors", [])
        self.assertFalse(res["success"])

    def test_source_without_workflow_fails(self):
        self._make_source(sid="nowf", with_workflow=False)
        res = self.skill_mod.save_combo_as_skill("nowf", "m.safetensors", [])
        self.assertFalse(res["success"])


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestResolveImageBytes(unittest.TestCase):
    """测试前端图片源解析（base64 -> PNG bytes + 缩放）"""

    def test_decode_and_scale(self):
        uri = _png_data_uri((2048, 1024))
        out = prompts_mod.resolve_image_bytes({"kind": "data", "data": uri})
        self.assertIsNotNone(out)
        from PIL import Image
        img = Image.open(io.BytesIO(out))
        self.assertLessEqual(max(img.size), 1024)

    def test_small_image_kept(self):
        uri = _png_data_uri((100, 80))
        out = prompts_mod.resolve_image_bytes({"kind": "data", "data": uri})
        self.assertIsNotNone(out)
        from PIL import Image
        img = Image.open(io.BytesIO(out))
        self.assertEqual(img.size, (100, 80))

    def test_invalid_sources(self):
        self.assertIsNone(prompts_mod.resolve_image_bytes(None))
        self.assertIsNone(prompts_mod.resolve_image_bytes("not-a-dict"))
        # kind 不是 data / input
        self.assertIsNone(prompts_mod.resolve_image_bytes(
            {"kind": "file", "path": "/tmp/x.png"}))
        # 缺少逗号分隔的 data URI
        self.assertIsNone(prompts_mod.resolve_image_bytes(
            {"kind": "data", "data": "garbage"}))

    def test_input_kind_from_load_image(self):
        """节点 image 输入的文件名源（LoadImage 场景）"""
        import tempfile
        import shutil
        import folder_paths
        from PIL import Image

        tmp = tempfile.mkdtemp()
        try:
            Image.new("RGB", (2048, 1024), (10, 200, 30)).save(os.path.join(tmp, "test_img.png"))
            orig = folder_paths.get_input_directory
            folder_paths.get_input_directory = lambda: tmp
            try:
                out = prompts_mod.resolve_image_bytes({"kind": "input", "value": "test_img.png"})
                self.assertIsNotNone(out)
                from PIL import Image as PILImage
                img = PILImage.open(io.BytesIO(out))
                self.assertLessEqual(max(img.size), 1024)

                # 带标注形式
                out2 = prompts_mod.resolve_image_bytes({"kind": "input", "value": "test_img.png[input]"})
                self.assertIsNotNone(out2)

                # 越界路径必须被拒绝
                self.assertIsNone(prompts_mod.resolve_image_bytes({"kind": "input", "value": "../escape.png"}))
                # 不存在的文件
                self.assertIsNone(prompts_mod.resolve_image_bytes({"kind": "input", "value": "missing.png"}))
            finally:
                folder_paths.get_input_directory = orig
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestImageTensorToPng(unittest.TestCase):
    """测试节点 IMAGE 输入转 PNG bytes"""

    def test_tensor_to_png(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch not installed")
        from PIL import Image
        t = torch.rand(1, 32, 48, 3)
        out = prompts_mod.image_tensor_to_png(t)
        self.assertIsNotNone(out)
        img = Image.open(io.BytesIO(out))
        self.assertEqual(img.size, (48, 32))

    def test_invalid_tensor(self):
        self.assertIsNone(prompts_mod.image_tensor_to_png(None))


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestResolveMultiResult(unittest.TestCase):
    """测试 multi_result 输出契约解析（llm.resolve_multi_result）"""

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.llm = _il.import_module(f"{_PKG_NAME}.llm")

    def test_no_rule_returns_empty(self):
        # 未声明契约 → 空列表，调用方回退整段文本
        self.assertEqual(self.llm.resolve_multi_result("a\n---\nb", None), [])
        self.assertEqual(self.llm.resolve_multi_result("hello", {}), [])

    def test_empty_text(self):
        rule = {"format": "separator"}
        self.assertEqual(self.llm.resolve_multi_result("", rule), [])
        self.assertEqual(self.llm.resolve_multi_result("   \n  ", rule), [])

    def test_separator_split(self):
        rule = {"format": "separator", "separator": "\n---\n"}
        text = "prompt one\n---\nprompt two\n---\nprompt three"
        self.assertEqual(
            self.llm.resolve_multi_result(text, rule),
            ["prompt one", "prompt two", "prompt three"])

    def test_separator_default(self):
        rule = {"format": "separator"}
        self.assertEqual(
            self.llm.resolve_multi_result("a\n---\nb", rule), ["a", "b"])

    def test_json_array(self):
        rule = {"format": "json_array"}
        self.assertEqual(
            self.llm.resolve_multi_result('["p1", " p2 ", "p3"]', rule),
            ["p1", "p2", "p3"])

    def test_json_array_dict_wrapper(self):
        rule = {"format": "json_array"}
        self.assertEqual(
            self.llm.resolve_multi_result('{"prompts": ["x", "y"]}', rule),
            ["x", "y"])

    def test_json_invalid_falls_back_to_separator(self):
        rule = {"format": "json_array", "separator": "\n---\n"}
        text = "not json\n---\nstill not json"
        self.assertEqual(
            self.llm.resolve_multi_result(text, rule),
            ["not json", "still not json"])


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestSkillAgent(unittest.TestCase):
    """测试 skill 代理：语言互斥主文件选择、引用列表、安全读取与工具调用循环。"""

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.skill = _il.import_module(f"{_PKG_NAME}.skill")
        cls.llm = _il.import_module(f"{_PKG_NAME}.llm")

    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()
        self.skdir = os.path.join(self.tmp, "myskill")
        os.makedirs(os.path.join(self.skdir, "references"))
        self._write("SKILL.md", "---\nname: myskill\n---\nEN MAIN BODY")
        self._write("SKILL.cn.md", "CN MAIN BODY")
        self._write(os.path.join("references", "ref.txt"), "REFERENCE CONTENT")

        self._orig_skill_dir = self.skill._skill_dir
        self.skill._skill_dir = lambda sid: self.skdir if sid == "myskill" else None

        # 记录并替换 llm 依赖（skill 在函数运行时惰性 from .llm import ...）
        self._llm_attrs = {}
        for a in ("get_current_mode", "_load_remote_config", "_detect_language",
                  "chat_turn", "_run_llm_inference"):
            self._llm_attrs[a] = getattr(self.llm, a)
        self.llm._load_remote_config = lambda: {"skill_language": "auto"}
        self.llm._detect_language = (lambda t: ("Chinese" if any('\u4e00' <= c <= '\u9fff'
                                                                 for c in (t or "")) else "English"))

    def tearDown(self):
        import shutil
        self.skill._skill_dir = self._orig_skill_dir
        for a, v in self._llm_attrs.items():
            setattr(self.llm, a, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, rel, content):
        with open(os.path.join(self.skdir, rel), "w", encoding="utf-8") as f:
            f.write(content)

    def _clear_refs(self):
        ref = os.path.join(self.skdir, "references", "ref.txt")
        if os.path.exists(ref):
            os.remove(ref)

    def test_main_files_language_exclusive(self):
        self.assertEqual(self.skill._main_md_files_for_language(self.skdir, "en"), ["SKILL.md"])
        self.assertEqual(self.skill._main_md_files_for_language(self.skdir, "cn"), ["SKILL.cn.md"])

    def test_load_content_en_excludes_cn(self):
        c = self.skill.load_skill_content("myskill", language="en")
        self.assertIn("EN MAIN BODY", c)
        self.assertNotIn("CN MAIN BODY", c)

    def test_load_content_cn_excludes_en(self):
        c = self.skill.load_skill_content("myskill", language="cn")
        self.assertIn("CN MAIN BODY", c)
        self.assertNotIn("EN MAIN BODY", c)

    def test_list_references(self):
        self.assertEqual(self.skill.list_skill_references("myskill"), ["references/ref.txt"])

    def test_read_reference_ok_and_safe(self):
        self.assertEqual(self.skill.read_skill_file("myskill", "references/ref.txt"), "REFERENCE CONTENT")
        self.assertIsNone(self.skill.read_skill_file("myskill", "../x.txt"))
        self.assertIsNone(self.skill.read_skill_file("myskill", "/etc/passwd"))
        self.assertIsNone(self.skill.read_skill_file("myskill", "references/../SKILL.md"))

    def test_agent_reads_reference_then_finalizes(self):
        calls = []

        def fake_turn(messages, max_tokens=None, tools=None, enable_thinking=None, reasoning_effort=None):
            calls.append([dict(m) for m in messages])
            if len(calls) == 1:
                return {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "c1", "type": "function",
                     "function": {"name": "read_skill_file",
                                  "arguments": '{"path": "references/ref.txt"}'}}]}
            return {"role": "assistant", "content": "DONE"}

        self.llm.chat_turn = fake_turn
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        out = self.skill._skill_agent_core("myskill", "hello")
        self.assertEqual(out, "DONE")
        self.assertEqual(len(calls), 2)
        tool_msgs = [m for m in calls[1] if m.get("role") == "tool"]
        self.assertEqual(len(tool_msgs), 1)
        self.assertEqual(tool_msgs[0]["content"], "REFERENCE CONTENT")
        self.assertTrue(any(m.get("role") == "system" and "Available reference files" in m["content"]
                            for m in calls[0]))

    def test_agent_no_refs_falls_back_to_single_shot(self):
        # 无引用/上下文：本地或远程都回退单轮推理（_run_llm_inference）
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
        self.llm._run_llm_inference = lambda *a, **k: "[single]"
        out = self.skill._skill_agent_core("myskill", "hello")
        self.assertEqual(out, "[single]")

    def test_agent_local_mode_uses_tool_loop_with_refs(self):
        # 本地模式 + 引用：与远程一致，走工具调用循环（chat_turn）而非单轮回退
        calls = []

        def fake_turn(messages, max_tokens=None, tools=None, enable_thinking=None, reasoning_effort=None):
            calls.append([dict(m) for m in messages])
            if len(calls) == 1:
                return {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "c1", "type": "function",
                     "function": {"name": "read_skill_file",
                                  "arguments": '{"path": "references/ref.txt"}'}}]}
            return {"role": "assistant", "content": "DONE"}

        self.llm.chat_turn = fake_turn
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
        out = self.skill._skill_agent_core("myskill", "hello")
        self.assertEqual(out, "DONE")
        self.assertEqual(len(calls), 2)

    def test_stream_single_turn_yields_tokens_incrementally(self):
        # 本地模式 + 单轮：应逐 token 透传，且向 LLM 请求 stream=True
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
        captured = {}

        def fake_inference(system_prompt, text, max_tokens, images=None, use_remote=False, stream=False, enable_thinking=None, reasoning_effort=None):
            captured["stream"] = stream
            return iter(["Hello ", "world", "!"])

        self.llm._run_llm_inference = fake_inference
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hello"))
        self.assertEqual(captured.get("stream"), True)
        self.assertEqual(chunks, [{"text": "Hello ", "kind": "content"}, {"text": "world", "kind": "content"}, {"text": "!", "kind": "content"}])

    def test_stream_single_turn_parses_dict_chunks(self):
        # 本地模型可能返回 dict chunk：只取 delta.content，跳过空/无 choices
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
        self.llm._run_llm_inference = lambda *a, **k: iter([
            {"choices": [{"delta": {"content": "ab"}}]},
            {"choices": [{"delta": {}}]},
            {"choices": []},
        ])
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hi"))
        self.assertEqual(chunks, [{"text": "ab", "kind": "content"}])

    def test_stream_tool_loop_status_names_sources(self):
        # audit: h3 走工具循环时，状态文案须如实说明按需读取的来源（引用文件 / 已连参考图数量）
        self._write("SKILL.md", "---\nname: myskill\naudit: h3\n---\nEN MAIN BODY")
        self._clear_refs()
        self.llm.chat_turn = lambda *a, **k: {"role": "assistant", "content": "DONE"}
        ctx = {"references": [
            {"kind": "image", "source": {"kind": "input", "value": "a.png"}},
            {"kind": "image", "source": {"kind": "input", "value": "b.png"}},
            {"kind": "video", "source": {"kind": "input", "value": "v.mp4"}},
        ]}
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hi", context=ctx))
        self.assertEqual(chunks[0], {"text": "生成中（按需查看 2 张已连参考图）…", "kind": "status"})
        self.assertEqual("".join(c["text"] for c in chunks if c["kind"] == "content"), "DONE")

        # 只有技能引用文件、无已连参考图
        self._write(os.path.join("references", "ref.txt"), "REFERENCE CONTENT")
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hi"))
        self.assertEqual(chunks[0], {"text": "生成中（按需读取技能引用文件）…", "kind": "status"})

    def test_stream_single_turn_forwards_thinking_and_content(self):
        # 远程思考模型：reasoning_content（thinking）与 content 分开打标透传，不再丢弃思考
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        self.llm._run_llm_inference = lambda *a, **k: iter([
            {"text": "推理", "kind": "thinking"},
            {"text": "正文A", "kind": "content"},
            {"text": "正文B", "kind": "content"},
        ])
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hi"))
        self.assertEqual(chunks, [
            {"text": "推理", "kind": "thinking"},
            {"text": "正文A", "kind": "content"},
            {"text": "正文B", "kind": "content"},
        ])

    def test_stream_empty_content_yields_fallback(self):
        # 思考模型把 max_tokens 全花在 reasoning：正文为空时补一条可见提示，避免前端静默无响应
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        self.llm._run_llm_inference = lambda *a, **k: iter([
            {"text": "思考1", "kind": "thinking"},
            {"text": "思考2", "kind": "thinking"},
        ])
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hi"))
        self.assertEqual(chunks[:2], [
            {"text": "思考1", "kind": "thinking"},
            {"text": "思考2", "kind": "thinking"},
        ])
        self.assertEqual(len(chunks), 3)
        self.assertEqual(chunks[-1]["kind"], "content")
        self.assertIn("max_tokens", chunks[-1]["text"])

    def test_stream_forwards_enable_thinking_to_inference(self):
        # "关闭思考"开关：enable_thinking 应透传到单轮推理调用（Krea2 等无引用 skill 路径）
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        captured = {}

        def fake_inference(system_prompt, text, max_tokens, images=None, use_remote=False, stream=False, enable_thinking=None, reasoning_effort=None):
            captured["enable_thinking"] = enable_thinking
            return iter([{"text": "正文", "kind": "content"}])

        self.llm._run_llm_inference = fake_inference
        list(self.skill.run_skill_agent_stream("myskill", "hi", enable_thinking=False))
        self.assertIs(captured.get("enable_thinking"), False)

    def test_stream_tool_loop_forwards_enable_thinking_to_chat_turn(self):
        # "关闭思考"开关：工具循环路径（工作流带参考图）也应把 enable_thinking 透传给 chat_turn
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        captured = {}

        def fake_turn(messages, max_tokens=None, tools=None, enable_thinking=None, reasoning_effort=None):
            captured["enable_thinking"] = enable_thinking
            return {"role": "assistant", "content": "DONE"}

        self.llm.chat_turn = fake_turn
        ctx = {"references": [{"kind": "image", "source": {"kind": "input", "value": "ref.png"},
                               "width": 64, "height": 48}]}
        list(self.skill.run_skill_agent_stream("myskill", "hi", context=ctx, enable_thinking=False))
        self.assertIs(captured.get("enable_thinking"), False)

    def test_stream_forwards_reasoning_effort_to_inference_and_chat_turn(self):
        # 「思考深度」下拉：reasoning_effort（Qwen3.8 档位）应透传到单轮推理与工具循环 chat_turn
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        captured = {}

        def fake_inference(system_prompt, text, max_tokens, images=None, use_remote=False, stream=False, enable_thinking=None, reasoning_effort=None):
            captured["inference"] = reasoning_effort
            return iter([{"text": "正文", "kind": "content"}])

        self.llm._run_llm_inference = fake_inference
        list(self.skill.run_skill_agent_stream("myskill", "hi", reasoning_effort="low"))
        self.assertEqual(captured.get("inference"), "low")

        captured.clear()

        def fake_turn(messages, max_tokens=None, tools=None, enable_thinking=None, reasoning_effort=None):
            captured["turn"] = reasoning_effort
            return {"role": "assistant", "content": "DONE"}

        self.llm.chat_turn = fake_turn
        ctx = {"references": [{"kind": "image", "source": {"kind": "input", "value": "ref.png"},
                               "width": 64, "height": 48}]}
        list(self.skill.run_skill_agent_stream("myskill", "hi", context=ctx, reasoning_effort="xhigh"))
        self.assertEqual(captured.get("turn"), "xhigh")

    def test_stream_yields_error_on_failure(self):
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL

        def boom(*a, **k):
            raise RuntimeError("nope")

        self.llm._run_llm_inference = boom
        chunks = list(self.skill.run_skill_agent_stream("myskill", "hi"))
        self.assertEqual(chunks, [{"text": "[ERROR] nope", "kind": "content"}])

    def test_resolve_skill_language(self):
        self.llm._load_remote_config = lambda: {"skill_language": "cn"}
        self.assertEqual(self.skill._resolve_skill_language("any english text"), "cn")
        self.llm._load_remote_config = lambda: {"skill_language": "auto"}
        self.assertEqual(self.skill._resolve_skill_language("你好，世界"), "cn")
        self.assertEqual(self.skill._resolve_skill_language("hello world"), "en")

    def test_skill_stream_injects_context(self):
        # 有上下文但无引用文件/参考图：走单轮路径，workflow_context 仍注入传给 LLM 的系统提示词
        self._clear_refs()
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
        captured = {}

        def fake_inference(system_prompt, text, max_tokens, images=None, use_remote=False, stream=False, enable_thinking=None, reasoning_effort=None):
            captured["system"] = system_prompt
            return iter(["ok"])

        self.llm._run_llm_inference = fake_inference
        ctx = {"h3": [{"type": "EmptyMiniMaxH3LatentAV", "width": 1280, "height": 720}],
               "references": []}
        list(self.skill.run_skill_agent_stream("myskill", "hello", context=ctx))
        self.assertIn("<workflow_context>", captured.get("system", ""))

    def test_remote_agent_fetches_reference_image(self):
        # 远程模式 + 图片参考：代理应声明 get_reference_image 工具，取回像素后作为 user 消息回灌
        import folder_paths
        import shutil
        import tempfile
        from PIL import Image
        tmp = tempfile.mkdtemp()
        try:
            Image.new("RGB", (64, 48), (9, 8, 7)).save(os.path.join(tmp, "ref.png"))
            orig_in = folder_paths.get_input_directory
            folder_paths.get_input_directory = lambda: tmp
            calls = []

            def fake_turn(messages, max_tokens=None, tools=None, enable_thinking=None, reasoning_effort=None):
                calls.append([dict(m) for m in messages])
                if len(calls) == 1:
                    return {"role": "assistant", "content": "", "tool_calls": [
                        {"id": "c1", "type": "function",
                         "function": {"name": "get_reference_image",
                                      "arguments": '{"index": 1}'}}]}
                return {"role": "assistant", "content": "DONE"}

            self.llm.chat_turn = fake_turn
            self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
            ctx = {"references": [{"kind": "image", "source": {"kind": "input", "value": "ref.png"},
                                   "width": 64, "height": 48}]}
            out = self.skill._skill_agent_core("myskill", "hello", context=ctx)
            self.assertEqual(out, "DONE")
            sys0 = [m for m in calls[0] if m.get("role") == "system"][0]["content"]
            self.assertIn("<workflow_context>", sys0)
            user_imgs = [m for m in calls[1] if m.get("role") == "user"
                         and isinstance(m.get("content"), list)]
            self.assertTrue(any("image_url" in str(p) for m in user_imgs for p in m["content"]),
                            "取回的参考图像素应作为独立 user 消息回灌")
        finally:
            folder_paths.get_input_directory = orig_in
            shutil.rmtree(tmp, ignore_errors=True)

    def test_local_agent_exposes_and_refetches_reference_image(self):
        # 本地模式 + 图片参考：声明 get_reference_image，取回像素后作为 user 消息回灌
        import folder_paths
        import shutil
        import tempfile
        from PIL import Image
        tmp = tempfile.mkdtemp()
        try:
            Image.new("RGB", (64, 48), (9, 8, 7)).save(os.path.join(tmp, "ref.png"))
            orig_in = folder_paths.get_input_directory
            folder_paths.get_input_directory = lambda: tmp
            calls = []
            seen_tools = []

            def fake_turn(messages, max_tokens=None, tools=None, enable_thinking=None, reasoning_effort=None):
                calls.append([dict(m) for m in messages])
                if not seen_tools:
                    seen_tools.append([t["function"]["name"] for t in (tools or [])])
                if len(calls) == 1:
                    return {"role": "assistant", "content": "", "tool_calls": [
                        {"id": "c1", "type": "function",
                         "function": {"name": "get_reference_image",
                                      "arguments": '{"index": 1}'}}]}
                return {"role": "assistant", "content": "DONE"}

            self.llm.chat_turn = fake_turn
            self.llm.get_current_mode = lambda: self.llm.LLM_MODE_LOCAL
            ctx = {"references": [{"kind": "image", "source": {"kind": "input", "value": "ref.png"},
                                   "width": 64, "height": 48}]}
            out = self.skill._skill_agent_core("myskill", "hello", context=ctx)
            self.assertEqual(out, "DONE")
            self.assertIn("get_reference_image", seen_tools[0])
            user_imgs = [m for m in calls[1] if m.get("role") == "user"
                         and isinstance(m.get("content"), list)]
            self.assertTrue(any("image_url" in str(p) for m in user_imgs for p in m["content"]),
                            "取回的参考图像素应作为独立 user 消息回灌")
        finally:
            folder_paths.get_input_directory = orig_in
            shutil.rmtree(tmp, ignore_errors=True)

    def test_video_only_context_is_single_shot_with_ctx(self):
        # 上下文仅含视频参考（无引用文件、无可取回图像）：走单轮路径，workflow_context 仍注入系统提示词
        self._clear_refs()
        captured = {}

        def fake_inference(system_prompt, text, max_tokens, images=None, use_remote=False, stream=False, enable_thinking=None, reasoning_effort=None):
            captured["system"] = system_prompt
            return "[single]"

        self.llm._run_llm_inference = fake_inference
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        ctx = {"references": [{"kind": "video", "source": {"kind": "input", "value": "v.mp4"}}]}
        out = self.skill._skill_agent_core("myskill", "hello", context=ctx)
        self.assertEqual(out, "[single]")
        self.assertIn("<workflow_context>", captured.get("system", ""))

    def test_context_only_single_shot_includes_duration(self):
        # 仅工作流上下文（无引用文件/参考图）：单轮生成，系统提示词含 H3 真实时长
        self._clear_refs()
        captured = {}

        def fake_inference(system_prompt, text, max_tokens, images=None, use_remote=False, stream=False, enable_thinking=None, reasoning_effort=None):
            captured["system"] = system_prompt
            return "[single]"

        self.llm._run_llm_inference = fake_inference
        self.llm.get_current_mode = lambda: self.llm.LLM_MODE_REMOTE
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "width": 1344, "height": 768,
                       "length": 124, "duration_seconds": 5}], "references": []}
        out = self.skill._skill_agent_core("myskill", "hello", context=ctx)
        self.assertEqual(out, "[single]")
        self.assertIn("<workflow_context>", captured.get("system", ""))
        self.assertIn("Duration: 5s", captured.get("system", ""))


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestWorkflowContextFormat(unittest.TestCase):
    """_format_workflow_context：系统提示词文本块格式化。"""

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.skill = _il.import_module(f"{_PKG_NAME}.skill")

    def test_empty_or_invalid(self):
        self.assertEqual(self.skill._format_workflow_context(None), "")
        self.assertEqual(self.skill._format_workflow_context("x"), "")
        self.assertEqual(self.skill._format_workflow_context({}), "")
        self.assertEqual(self.skill._format_workflow_context({"h3": [], "references": []}), "")

    def test_h3_and_references(self):
        ctx = {
            "nodes": ["EmptyMiniMaxH3LatentAV", "KSampler", "CLIPTextEncode"],
            "h3": [{"type": "EmptyMiniMaxH3LatentAV", "width": 1280, "height": 720,
                    "length": 48, "ref_image_size": "large"}],
            "references": [
                {"kind": "image", "source": {"kind": "input", "value": "cat.png"},
                 "width": 1024, "height": 576},
                {"kind": "video", "source": {"kind": "input", "value": "clip.mp4"}},
            ],
        }
        block = self.skill._format_workflow_context(ctx)
        self.assertTrue(block.startswith("<workflow_context>"))
        self.assertTrue(block.rstrip().endswith("</workflow_context>"))
        self.assertIn("MiniMax H3 nodes in the current workflow", block)
        self.assertIn("Aspect Ratio: 16:9", block)
        self.assertIn("Duration: 2s (48 frames @24fps)", block)
        self.assertIn("ref_image_size=large", block)
        self.assertIn("Reference media (leaf inputs of the workflow):", block)
        self.assertIn("[1] image cat.png (16:9) (1024x576) - fetchable via get_reference_image(1)", block)
        self.assertIn("[2] video clip.mp4", block)
        # MiniMax 节点类型不重复出现在 Other node types
        self.assertIn("Other node types: KSampler, CLIPTextEncode", block)

    def test_video_only_ref_omits_fetch_hint(self):
        ctx = {"references": [{"kind": "video", "source": {"kind": "input", "value": "a.mp4"}}]}
        block = self.skill._format_workflow_context(ctx)
        self.assertIn("[1] video a.mp4", block)
        self.assertNotIn("get_reference_image tool only when you need", block)

    def test_h3_prefers_duration_seconds_over_stale_length(self):
        ctx = {
            "h3": [
                # 前端回溯出真实秒数：优先使用，忽略过期的 widget 帧数
                {"type": "MiniMaxH3ReferenceToVideo", "width": 1344, "height": 768,
                 "length": 124, "duration_seconds": 5},
                # 无 duration_seconds：回退 length/24
                {"type": "MiniMaxH3ImageToVideo", "width": 1280, "height": 720, "length": 192},
            ],
        }
        block = self.skill._format_workflow_context(ctx)
        self.assertIn("Duration: 5s", block)
        self.assertNotIn("124 frames", block)
        self.assertIn("Duration: 8s (192 frames @24fps)", block)

    def test_h3_aspect_only_without_stale_dims(self):
        # 前端回溯到 ResolutionSelector：只上报比例，丢弃被连线覆盖的 stale width/height
        ctx = {
            "h3": [
                {"type": "MiniMaxH3ReferenceToVideo", "aspect": "9:16"},
                {"type": "MiniMaxH3ImageToVideo", "width": 704, "height": 896},
            ],
        }
        block = self.skill._format_workflow_context(ctx)
        self.assertIn("Aspect Ratio: 9:16", block)
        # 有真实 w/h 时仍显示归一后的比例
        self.assertIn("Aspect Ratio: 11:14", block)

    def test_h3_reference_tags(self):
        # ReferenceToVideo：每个参考单独成 tag，<Picture N>/<Video N>/<Audio N> = 第 N 个（1-based），并附对应文件
        ctx = {
            "h3": [
                {"type": "MiniMaxH3ReferenceToVideo", "width": 1344, "height": 768,
                 "refs": {"pictures": ["a.jpg", "b.jpg"], "videos": ["c.mp4"],
                          "audios": ["d.wav", "e.wav", "f.wav"]}},
            ],
        }
        block = self.skill._format_workflow_context(ctx)
        self.assertIn("References: <Picture 1> a.jpg, <Picture 2> b.jpg, <Video 1> c.mp4, "
                      "<Audio 1> d.wav, <Audio 2> e.wav, <Audio 3> f.wav", block)
        # 有 ref tag 时附带一句：提示 LLM 用这些 tag 在提示词里指代参考媒体
        self.assertIn("refer to each node's reference media using the <Picture N>", block)

    def test_h3_single_reference_tag(self):
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["x.jpg"]}}]}
        block = self.skill._format_workflow_context(ctx)
        self.assertIn("References: <Picture 1> x.jpg", block)

    def test_h3_reference_tag_without_file(self):
        # 槽位已连但回溯不到叶子文件：仍按序号出 tag，只是不带文件名
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": [None, "b.jpg"]}}]}
        block = self.skill._format_workflow_context(ctx)
        self.assertIn("<Picture 1>, <Picture 2> b.jpg", block)

    def test_h3_keyframes_are_picture_tags(self):
        # ImageToVideo：first/last frame 本身就是 <Picture N>（tokenizer 按 [first, last] 顺序编号）
        ctx = {"h3": [{"type": "MiniMaxH3ImageToVideo",
                       "refs": {"keyframes": {"first": "ff.jpg", "last": "lf.jpg"}}}]}
        block = self.skill._format_workflow_context(ctx)
        self.assertIn("References: <Picture 1> ff.jpg (first frame), <Picture 2> lf.jpg (last frame)", block)

    def test_h3_keyframe_only_last_is_picture_1(self):
        # 只有 last_frame：它是唯一的图，编号仍为 <Picture 1>
        ctx = {"h3": [{"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"last": "lf.jpg"}}}]}
        block = self.skill._format_workflow_context(ctx)
        self.assertIn("References: <Picture 1> lf.jpg (last frame)", block)

    def test_h3_no_refs_omits_reference_line(self):
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "width": 1344, "height": 768}]}
        block = self.skill._format_workflow_context(ctx)
        self.assertNotIn("References:", block)
        self.assertNotIn("<Picture", block)
        self.assertNotIn("refer to each node's reference media", block)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestFilterModeSections(unittest.TestCase):
    """_filter_mode_sections：按 H3 模式裁剪 skill 正文中的 <!-- @if MODE --> 条件段落。"""

    BODY = (
        "SHARED START\n"
        "<!-- @if T2VA -->\nT2VA ONLY\n<!-- @end -->\n"
        "<!-- @if I2VA -->\nI2VA ONLY\n<!-- @end -->\n"
        "<!-- @if FL2VA,L2VA -->\nREF ONLY\n<!-- @end -->\n"
        "SHARED END\n"
    )

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.skill = _il.import_module(f"{_PKG_NAME}.skill")
        cls.h3 = _il.import_module(f"{_PKG_NAME}.minimax_h3")

    def _ctx(self, node):
        return {"h3": [node]}

    def test_i2va_keeps_only_matching_blocks(self):
        out = self.h3._filter_mode_sections(self.BODY, self._ctx(
            {"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"first": "a.png"}}}))
        self.assertIn("I2VA ONLY", out)
        self.assertNotIn("T2VA ONLY", out)
        self.assertNotIn("REF ONLY", out)
        self.assertIn("SHARED START", out)
        self.assertIn("SHARED END", out)
        self.assertNotIn("@if", out)
        self.assertNotIn("@end", out)

    def test_multi_mode_list(self):
        out = self.h3._filter_mode_sections(self.BODY, self._ctx(
            {"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"last": "b.png"}}}))
        self.assertIn("REF ONLY", out)  # L2VA 命中 FL2VA,L2VA 列表
        self.assertNotIn("I2VA ONLY", out)

    def test_t2va_mode(self):
        out = self.h3._filter_mode_sections(self.BODY, self._ctx(
            {"type": "MiniMaxH3ImageToVideo"}))
        self.assertIn("T2VA ONLY", out)
        self.assertNotIn("I2VA ONLY", out)

    def test_no_h3_context_unchanged(self):
        self.assertEqual(self.h3._filter_mode_sections(self.BODY, None), self.BODY)
        self.assertEqual(self.h3._filter_mode_sections(self.BODY, {"references": []}), self.BODY)

    def test_body_without_markers_unchanged(self):
        self.assertEqual(self.h3._filter_mode_sections("plain body", self._ctx(
            {"type": "MiniMaxH3ImageToVideo"})), "plain body")

    def test_mode_without_intersection_keeps_all(self):
        # 判定模式与所有 @if 列表无交集（如 base 技能用于 Reference 节点）：原样保留
        out = self.h3._filter_mode_sections(self.BODY, self._ctx(
            {"type": "MiniMaxH3ReferenceToVideo"}))
        self.assertEqual(out, self.BODY)

    def test_preset_minimax_h3_base_filters_per_mode(self):
        body = self.skill.load_skill_content("minimax_h3_base")
        if not body or "@if" not in body:
            self.skipTest("preset minimax_h3_base 未包含条件段落")
        cases = [
            ("T2VA", {"type": "MiniMaxH3ImageToVideo"}, "### Case 1: T2VA", "### Case 2: I2VA"),
            ("I2VA", {"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"first": "a.png"}}},
             "### Case 2: I2VA", "### Case 4: L2VA"),
            ("FL2VA", {"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"first": "a.png", "last": "b.png"}}},
             "### Case 3: FL2VA", "### Case 1: T2VA"),
            ("L2VA", {"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"last": "b.png"}}},
             "### Case 4: L2VA", "### Case 3: FL2VA"),
        ]
        for mode, node, keep, drop in cases:
            out = self.h3._filter_mode_sections(body, self._ctx(node))
            self.assertIn(keep, out, f"{mode}: 应保留 {keep}")
            self.assertNotIn(drop, out, f"{mode}: 应删除 {drop}")
            self.assertNotIn("@if", out)
            self.assertLess(len(out), len(body), f"{mode}: 裁剪后应比全文短")

    def test_reference_kind_tokens(self):
        body = ("<!-- @if pictures -->\nPIC\n<!-- @end -->\n"
                "<!-- @if videos -->\nVID\n<!-- @end -->\n"
                "<!-- @if audios -->\nAUD\n<!-- @end -->\n")
        node = {"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["a.jpg"]}}
        out = self.h3._filter_mode_sections(body, self._ctx(node))
        self.assertIn("PIC", out)
        self.assertNotIn("VID", out)
        self.assertNotIn("AUD", out)
        self.assertNotIn("@if", out)

    def test_reference_no_refs_keeps_all(self):
        # Reference 节点未连任何参考：活跃 token 只有 REFERENCE，与类型列表无交集 → 原样保留
        body = "<!-- @if videos -->\nVID\n<!-- @end -->\n"
        out = self.h3._filter_mode_sections(body, self._ctx({"type": "MiniMaxH3ReferenceToVideo"}))
        self.assertEqual(out, body)

    def test_preset_minimax_h3_full_ref_filters_per_kind(self):
        body = self.skill.load_skill_content("minimax_h3_full_ref")
        if not body or "@if" not in body:
            self.skipTest("preset minimax_h3_full_ref 未包含条件段落")
        pics_only = {"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["a.jpg"]}}
        out = self.h3._filter_mode_sections(body, self._ctx(pics_only))
        self.assertIn("### 2.2", out)
        self.assertNotIn("### 2.3", out)
        self.assertNotIn("### 2.4", out)
        self.assertNotIn("### 2.5", out)
        self.assertNotIn("### 4.2 Audio", out)
        self.assertNotIn("Video-structure entry:", out)
        self.assertNotIn("@if", out)
        self.assertLess(len(out), len(body))
        all_kinds = {"type": "MiniMaxH3ReferenceToVideo",
                     "refs": {"pictures": ["a.jpg"], "videos": ["b.mp4"], "audios": ["c.wav"]}}
        out2 = self.h3._filter_mode_sections(body, self._ctx(all_kinds))
        for sec in ("### 2.2", "### 2.3", "### 2.4", "### 2.5", "### 4.2 Audio"):
            self.assertIn(sec, out2)
        self.assertNotIn("@if", out2)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestFetchReferenceImage(unittest.TestCase):
    """_fetch_reference_image：按序号取回参考图像素 + 各类错误分支。"""

    @classmethod
    def setUpClass(cls):
        import importlib as _il
        cls.skill = _il.import_module(f"{_PKG_NAME}.skill")

    def test_valid_image(self):
        import folder_paths
        import shutil
        import tempfile
        from PIL import Image
        tmp = tempfile.mkdtemp()
        try:
            Image.new("RGB", (64, 48), (1, 2, 3)).save(os.path.join(tmp, "ref.png"))
            orig = folder_paths.get_input_directory
            folder_paths.get_input_directory = lambda: tmp
            try:
                ctx = {"references": [{"kind": "image", "source": {"kind": "input", "value": "ref.png"}}]}
                data, caption = self.skill._fetch_reference_image(ctx, 1)
                self.assertIsInstance(data, (bytes, bytearray))
                self.assertIn("ref.png", caption)
            finally:
                folder_paths.get_input_directory = orig
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_out_of_range(self):
        ctx = {"references": [{"kind": "image", "source": {"kind": "input", "value": "a.png"}}]}
        data, caption = self.skill._fetch_reference_image(ctx, 2)
        self.assertIsNone(data)
        self.assertIn("out of range", caption)

    def test_invalid_index(self):
        ctx = {"references": [{"kind": "image", "source": {"kind": "input", "value": "a.png"}}]}
        data, caption = self.skill._fetch_reference_image(ctx, "abc")
        self.assertIsNone(data)
        self.assertIn("invalid reference index", caption)

    def test_video_rejected(self):
        ctx = {"references": [{"kind": "video", "source": {"kind": "input", "value": "clip.mp4"}}]}
        data, caption = self.skill._fetch_reference_image(ctx, 1)
        self.assertIsNone(data)
        self.assertIn("is a video", caption)

    def test_read_failure(self):
        import folder_paths
        import shutil
        import tempfile
        tmp = tempfile.mkdtemp()
        try:
            orig = folder_paths.get_input_directory
            folder_paths.get_input_directory = lambda: tmp
            try:
                ctx = {"references": [{"kind": "image", "source": {"kind": "input", "value": "missing.png"}}]}
                data, caption = self.skill._fetch_reference_image(ctx, 1)
                self.assertIsNone(data)
                self.assertIn("failed to read", caption)
            finally:
                folder_paths.get_input_directory = orig
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_none_context(self):
        data, caption = self.skill._fetch_reference_image(None, 1)
        self.assertIsNone(data)
        self.assertIn("out of range", caption)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestGenImageSkill(unittest.TestCase):
    """gen_image 元数据：预设扫描透传与编辑保存保留"""

    def setUp(self):
        self.skill_mod = getattr(prompts_mod, "skill", None)
        if self.skill_mod is None:
            self.skipTest("prompts 未暴露 skill 模块")
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_dir = self.skill_mod.SKILL_CUSTOM_DIR
        self.skill_mod.SKILL_CUSTOM_DIR = self._tmp.name

    def tearDown(self):
        self.skill_mod.SKILL_CUSTOM_DIR = self._orig_dir
        self._tmp.cleanup()

    def _write_skill(self, sid, meta_lines, body="body"):
        d = os.path.join(self._tmp.name, sid)
        os.makedirs(d, exist_ok=True)
        text = "\n".join(["---"] + meta_lines + ["---", "", body])
        with open(os.path.join(d, "skill.md"), "w", encoding="utf-8") as f:
            f.write(text)

    def _read_meta(self, sid):
        main = os.path.join(self._tmp.name, sid, "skill.md")
        with open(main, encoding="utf-8") as f:
            meta, body = self.skill_mod.split_frontmatter(f.read())
        return meta, body

    def _scanned(self):
        return {s["id"]: s for s in self.skill_mod.scan_skills()}

    def test_gen_meta_scanned(self):
        self._write_skill("gen-a", [
            "name: Gen A", "category: image_gen", "gen_image: true",
        ])
        s = self._scanned().get("gen-a")
        self.assertIsNotNone(s)
        self.assertTrue(s["gen_image"])
        self.assertFalse(s["requires_ref"], "未声明 requires_ref 时默认 False")
        self.assertEqual(s["category"], "image_gen")

    def test_requires_ref_scanned(self):
        self._write_skill("gen-r", [
            "name: Gen R", "category: image_gen", "gen_image: true",
            "requires_ref: true",
        ])
        s = self._scanned().get("gen-r")
        self.assertIsNotNone(s)
        self.assertTrue(s["requires_ref"])

    def test_gen_meta_default_absent(self):
        self._write_skill("gen-b", ["name: Gen B"])
        s = self._scanned().get("gen-b")
        self.assertFalse(s["gen_image"])
        self.assertNotIn("ratio", s, "skill 声明比例已废弃，扫描结果不再输出")

    def test_preset_image_gen_skill_scanned(self):
        s = self._scanned().get("image_gen_image")
        self.assertIsNotNone(s)
        self.assertTrue(s["gen_image"])
        self.assertTrue(s["requires_ref"], "参考图 skill 必须声明 requires_ref")
        self.assertEqual(s["category"], "image_gen")

    # 生图预设的输入形态（skill.md 的 mode）决定「文生图」页与「图片编辑」页各列哪些技能。
    # 编辑类模板的参考图槽位是可空的 Autogrow，运行时判不出「必须有图」，只能靠声明。
    _PRESET_IMAGE_MODES = {
        "image_gen": "t2i",
        "image_gen_text_subject": "t2i",
        "nine_grid_storyboard": "t2i",
        "image_gen_image": "edit",
        "qwen_image_21": "t2i_edit",
        "qwen_image_21_body_swap": "edit",
        "qwen_image_21_controlnet": "edit",
        "qwen_image_21_face_swap": "edit",
        "qwen_image_21_identity_swap": "edit",
        "qwen_image_21_local_edit": "edit",
        "qwen_image_21_outpaint": "edit",
        "qwen_image_21_pose_edit": "edit",
        "qwen_image_21_watermark_remove": "edit",
    }

    def test_preset_image_skill_modes_scanned(self):
        scanned = self._scanned()
        for sid, mode in self._PRESET_IMAGE_MODES.items():
            s = scanned.get(sid)
            self.assertIsNotNone(s, f"预设 {sid} 未扫描到")
            self.assertEqual(s["mode"], mode, f"{sid} 的输入形态应声明为 {mode}")
            self.assertEqual(
                bool(s["requires_ref"]), mode == "edit",
                f"{sid} 的 requires_ref 必须与 mode 一致：文生图页与 LLM 生图都按它决定是否带参考图")

    def test_save_skill_main_preserves_gen_meta(self):
        self._write_skill("gen-c", [
            "name: Gen C", "gen_image: true", "requires_ref: true",
        ])
        self.assertTrue(self.skill_mod.save_skill_main("gen-c", "Gen C renamed", "body2"))
        meta, body = self._read_meta("gen-c")
        self.assertIs(meta.get("gen_image"), True)
        self.assertIs(meta.get("requires_ref"), True)
        self.assertEqual(body, "body2")

    def test_save_skill_main_preserves_gen_video(self):
        # 复制为自定义时 save_skill_main 需保留 gen_video，视频技能设置区才可见
        self._write_skill("vid-c", ["name: Vid C", "category: video_gen", "gen_video: true"])
        self.assertTrue(self.skill_mod.save_skill_main("vid-c", "Vid C renamed", "body2"))
        meta, body = self._read_meta("vid-c")
        self.assertIs(meta.get("gen_video"), True)
        self.assertEqual(body, "body2")

    def test_serialize_frontmatter_round_trip(self):
        text = self.skill_mod.serialize_frontmatter(
            {"name": "R", "gen_image": True, "requires_ref": False}, "body")
        meta, body = self.skill_mod.split_frontmatter(text)
        self.assertIs(meta.get("gen_image"), True)
        self.assertIs(meta.get("requires_ref"), False)
        self.assertEqual(body, "body")

    def test_load_skill_route_returns_gen_image(self):
        # 详情弹窗靠 load_skill 响应的 gen_image 决定是否显示生图设置区
        self._write_skill("gen-d", ["name: Gen D", "category: image_gen", "gen_image: true"])
        async def _json():
            return {"id": "gen-d"}
        resp = asyncio.run(self.skill_mod.rs_prompts_load_skill(
            types.SimpleNamespace(json=_json)))
        body = json.loads(resp.body)
        self.assertTrue(body["gen_image"])

        self._write_skill("plain-e", ["name: Plain E"])
        async def _json2():
            return {"id": "plain-e"}
        resp = asyncio.run(self.skill_mod.rs_prompts_load_skill(
            types.SimpleNamespace(json=_json2)))
        body = json.loads(resp.body)
        self.assertFalse(body["gen_image"])

    def test_load_skill_route_returns_gen_video(self):
        # 详情弹窗靠 load_skill 响应的 gen_video 决定是否显示生视频设置区
        self._write_skill("vid-d", ["name: Vid D", "category: video_gen", "gen_video: true"])
        async def _json():
            return {"id": "vid-d"}
        resp = asyncio.run(self.skill_mod.rs_prompts_load_skill(
            types.SimpleNamespace(json=_json)))
        body = json.loads(resp.body)
        self.assertTrue(body["gen_video"])

    def test_load_skill_route_returns_video_mode(self):
        # 「复制为自定义」靠 load_skill 响应的 mode / requires_ref 还原视频模式与参考图要求；
        # 导演编辑器的分段技能下拉按扫描结果的 skill.mode 过滤
        self._write_skill("vid-m", [
            "name: Vid M", "category: video_gen", "gen_video: true",
            "mode: i2v", "requires_ref: true",
        ])
        async def _json():
            return {"id": "vid-m"}
        resp = asyncio.run(self.skill_mod.rs_prompts_load_skill(
            types.SimpleNamespace(json=_json)))
        body = json.loads(resp.body)
        self.assertEqual(body["mode"], "i2v")
        self.assertTrue(body["requires_ref"])
        self.assertEqual(self._scanned()["vid-m"]["mode"], "i2v")

    def test_find_cn_name_conflict(self):
        self._write_skill("dup-a", ["name: dup-a", "cn_name: Dup Display"])
        self._write_skill("dup-b", ["name: dup-b", "cn_name: Dup Display"])
        self.assertEqual(self.skill_mod._find_name_conflict("Dup Display", "dup-a"), "dup-b")
        self.assertEqual(self.skill_mod._find_name_conflict("Dup Display", "dup-b"), "dup-a")
        self.assertIsNone(self.skill_mod._find_name_conflict("Unique Display", "dup-a"))

    def test_scan_pinyin_tags_use_cn_name(self):
        # 迁移后 name 为英文 id；拼音标签须基于中文 cn_name 生成，否则前端 / 菜单无法按中文名检索
        self._write_skill("cn-dn", ["name: cn-dn", "cn_name: 动漫风格"])
        s = self._scanned().get("cn-dn")
        self.assertIsNotNone(s)
        if self.skill_mod.lazy_pinyin is None:
            self.assertNotIn("dongmanfengge", s["tags"])
        else:
            self.assertIn("dongmanfengge", s["tags"])

    def test_save_skill_route_cn_name_conflict_409(self):
        self._write_skill("dup-a", ["name: dup-a", "cn_name: Dup Display"])
        self._write_skill("dup-b", ["name: dup-b", "cn_name: Other Display"])
        async def _json():
            return {"id": "dup-b", "name": "dup-b", "cn_name": "Dup Display", "content": "body", "source": "custom"}
        resp = asyncio.run(self.skill_mod.rs_prompts_save_skill(
            types.SimpleNamespace(json=_json)))
        self.assertEqual(resp.status, 409)


@unittest.skipUnless(PROMPTS_AVAILABLE, _reason)
class TestRefSlotWriteback(unittest.TestCase):
    """画布 → 技能回写：多路参考槽按 Autogrow 槽位序号编号，往返不塌成单槽。"""

    @classmethod
    def setUpClass(cls):
        cls.skill_mod = importlib.import_module(f"{_PKG_NAME}.skill")

    def graph(self, n):
        wf = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 0], "text": "p"}},
            "3": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["1", 0], "prompt": "p"}},
            "4": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["2", 0], "seed": 1}},
            "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": "x"}},
        }
        for k in range(1, n + 1):
            nid = str(10 + 2 * (k - 1))
            wf[nid] = {"class_type": "LoadImage", "inputs": {"image": f"{k}.png"}}
            wf["3"]["inputs"][f"images.image_{k}"] = [nid, 0]
        return wf

    def test_multi_ref_slots_keep_numbers(self):
        template, _, _ = self.skill_mod._template_from_workflow(self.graph(3))
        self.assertEqual([template[str(10 + 2 * i)]["inputs"]["image"] for i in range(3)],
                         ["{{REF_IMAGE_1}}", "{{REF_IMAGE_2}}", "{{REF_IMAGE_3}}"])

    def test_single_ref_keeps_plain_token(self):
        template, _, _ = self.skill_mod._template_from_workflow(self.graph(1))
        self.assertEqual(template["10"]["inputs"]["image"], "{{REF_IMAGE}}")

    def test_numbering_follows_slot_not_node_id(self):
        wf = self.graph(2)
        del wf["12"]
        wf["3"]["inputs"]["images.image_1"] = ["20", 0]
        wf["3"]["inputs"]["images.image_2"] = ["10", 0]
        wf["20"] = {"class_type": "LoadImage", "inputs": {"image": "first.png"}}
        template, _, _ = self.skill_mod._template_from_workflow(wf)
        self.assertEqual(template["20"]["inputs"]["image"], "{{REF_IMAGE_1}}")
        self.assertEqual(template["10"]["inputs"]["image"], "{{REF_IMAGE_2}}")

    def test_unslotted_load_image_not_numbered(self):
        wf = self.graph(1)
        wf["20"] = {"class_type": "LoadImage", "inputs": {"image": "base.png"}}
        template, _, _ = self.skill_mod._template_from_workflow(wf)
        self.assertEqual(template["10"]["inputs"]["image"], "{{REF_IMAGE}}")
        self.assertEqual(template["20"]["inputs"]["image"], "{{REF_IMAGE}}")

    def minimax_graph(self, n):
        wf = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}},
            "2": {"class_type": "MiniMaxH3ReferenceToVideo",
                  "inputs": {"clip": ["1", 0], "prompt": "p", "width": 512, "height": 512, "length": 24}},
        }
        for k in range(n):
            nid = str(21 + k)
            wf[nid] = {"class_type": "LoadImage", "inputs": {"image": f"{k + 1}.png"}}
            wf["2"]["inputs"][f"ref_images.ref_image_{k}"] = [nid, 0]
        return wf

    def test_zero_based_slots_keep_numbers(self):
        # minimax 0 基槽位：ref_image_0..2 → 占位符仍按 1 基编号
        template, _, _ = self.skill_mod._template_from_workflow(self.minimax_graph(3))
        self.assertEqual([template[str(21 + i)]["inputs"]["image"] for i in range(3)],
                         ["{{REF_IMAGE_1}}", "{{REF_IMAGE_2}}", "{{REF_IMAGE_3}}"])

    def video_graph(self):
        wf = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}},
            "2": {"class_type": "MiniMaxH3ReferenceToVideo",
                  "inputs": {"clip": ["1", 0], "prompt": "p", "width": 512, "height": 512, "length": 24}},
            "21": {"class_type": "LoadImage", "inputs": {"image": "1.png"}},
            "22": {"class_type": "LoadImage", "inputs": {"image": "2.png"}},
            "31": {"class_type": "LoadVideo", "inputs": {"file": "v.mp4"}},
            "41": {"class_type": "GetVideoComponents", "inputs": {"video": ["31", 0]}},
            "51": {"class_type": "LoadAudio", "inputs": {"audio": "a.wav"}},
        }
        wf["2"]["inputs"]["ref_images.ref_image_0"] = ["21", 0]
        wf["2"]["inputs"]["ref_images.ref_image_1"] = ["22", 0]
        wf["2"]["inputs"]["ref_videos.ref_video_0"] = ["41", 0]
        wf["2"]["inputs"]["ref_audios.ref_audio_0"] = ["51", 0]
        return wf

    def test_video_and_audio_slots_export_disabled(self):
        # 参考视频/音频槽位导出即默认跳过（bypass mode 4，洋红底比 mute 醒目；灌画布时占位文件不存在 → 红框）；LoadImage 不受影响
        template, _, _ = self.skill_mod._template_video_from_workflow(self.video_graph())
        self.assertEqual(template["31"].get("mode"), 4)
        self.assertEqual(template["51"].get("mode"), 4)
        self.assertIsNone(template["21"].get("mode"))
        self.assertEqual(template["41"].get("mode"), None)


class TestCanvasBindCandidates(unittest.TestCase):
    """画布 → 技能导出：提示词原文节点与分辨率选择器（百万像素 / 比例）作为可选占位符，由导入对话框勾选。"""

    @classmethod
    def setUpClass(cls):
        cls.skill_mod = importlib.import_module(f"{_PKG_NAME}.skill")

    def canvas(self):
        """moss_image_t2i 的骨架：提示词写在 PrimitiveStringMultiline 里，经开关 / 预览进编码器；
        宽高由 ResolutionSelector（比例 + 百万像素）喂 EmptyFlux2LatentImage。"""
        return {
            "19": {"class_type": "ResolutionSelector",
                   "inputs": {"aspect_ratio": "1:1 (Square)", "megapixels": 1.05, "multiple": 16}},
            "25": {"class_type": "PrimitiveStringMultiline", "inputs": {"value": "生成一张刘亦菲的写真照片"}},
            "27": {"class_type": "TextGenerate", "inputs": {"prompt": ["25", 0], "model_name": "deepseek-chat"}},
            "29": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["30", 0], "text": ["33", 0]}},
            "30": {"class_type": "CLIPLoader", "inputs": {"clip_name": "clip.safetensors"}},
            "31": {"class_type": "KSampler",
                   "inputs": {"positive": ["29", 0], "negative": ["36", 0], "latent_image": ["35", 0],
                              "seed": 127, "steps": 25}},
            "33": {"class_type": "PreviewAny", "inputs": {"source": ["34", 0]}},
            "34": {"class_type": "ComfySwitchNode",
                   "inputs": {"switch": True, "on_false": ["25", 0], "on_true": ["27", 0]}},
            "35": {"class_type": "EmptyFlux2LatentImage",
                   "inputs": {"width": ["19", 0], "height": ["19", 1], "batch_size": 1}},
            "36": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["30", 0], "text": "low quality"}},
        }

    def test_prompt_text_node_and_selector_are_offered(self):
        got = {(c["node"], c["field"], c["token"]) for c in self.skill_mod._bind_candidates(self.canvas())}
        self.assertEqual(got, {("25", "value", "PROMPT"),
                               ("19", "megapixels", "MEGAPIXELS"),
                               ("19", "aspect_ratio", "ASPECT_RATIO")})

    def test_empty_text_node_not_offered(self):
        wf = self.canvas()
        wf["25"]["inputs"]["value"] = "   "
        self.assertNotIn("25", [c["node"] for c in self.skill_mod._bind_candidates(wf)])

    def test_selector_feeding_no_latent_not_offered(self):
        wf = self.canvas()
        wf["35"]["class_type"] = "TextEncodeQwenImage21"
        tokens = [c["token"] for c in self.skill_mod._bind_candidates(wf)]
        self.assertNotIn("MEGAPIXELS", tokens)
        self.assertNotIn("ASPECT_RATIO", tokens)

    def test_plan_reports_candidates_without_writing(self):
        wf = self.canvas()
        plan = self.skill_mod.plan_workflow_skill(wf)
        self.assertTrue(plan["success"])
        self.assertFalse(plan["gen_video"])
        self.assertEqual(len(plan["candidates"]), 3)
        self.assertEqual(wf["25"]["inputs"]["value"], "生成一张刘亦菲的写真照片")
        self.assertEqual(wf["19"]["inputs"]["megapixels"], 1.05)

    def test_checked_bindings_replace_prompt_and_size(self):
        canvas = self.canvas()
        bindings = self.skill_mod._bind_candidates(canvas)
        template, _, seed_cfg = self.skill_mod._template_from_workflow(canvas, bindings)
        self.assertEqual(template["25"]["inputs"]["value"], "{{PROMPT}}")
        self.assertEqual(template["19"]["inputs"]["megapixels"], "{{MEGAPIXELS}}")
        self.assertEqual(template["19"]["inputs"]["aspect_ratio"], "{{ASPECT_RATIO}}")
        self.assertEqual(template["36"]["inputs"]["text"], "{{NEGATIVE}}")   # 固定规则照旧
        self.assertEqual(seed_cfg["default_ratio"], "1:1")
        self.assertEqual(seed_cfg["base_resolution"], 1056)                  # 1.05MP @ 1:1 的长边

    def test_size_candidates_name_the_settings_they_write(self):
        """megapixels / aspect_ratio 在技能里没有对应的设置项：候选要直接给出勾选后写进
        config.json 的那两项，值与 _template_from_workflow 落的 seed_cfg 对齐，
        对话框才能把行写成「技能设置「长边尺寸」1056」而不是画布上的 1.05。"""
        canvas = self.canvas()
        got = {c["token"]: c["setting"] for c in self.skill_mod._bind_candidates(canvas)
               if c["token"] in ("MEGAPIXELS", "ASPECT_RATIO")}
        self.assertEqual(got["MEGAPIXELS"], {"key": "base_resolution", "value": 1056})
        self.assertEqual(got["ASPECT_RATIO"], {"key": "default_ratio", "value": "1:1"})
        _, _, seed_cfg = self.skill_mod._template_from_workflow(canvas, self.skill_mod._bind_candidates(canvas))
        self.assertEqual(seed_cfg["base_resolution"], got["MEGAPIXELS"]["value"])
        self.assertEqual(seed_cfg["default_ratio"], got["ASPECT_RATIO"]["value"])

    def test_unchecked_binding_keeps_canvas_value(self):
        canvas = self.canvas()
        bindings = [c for c in self.skill_mod._bind_candidates(canvas) if c["token"] != "ASPECT_RATIO"]
        template, _, _ = self.skill_mod._template_from_workflow(canvas, bindings)
        self.assertEqual(template["19"]["inputs"]["aspect_ratio"], "1:1 (Square)")
        self.assertEqual(template["19"]["inputs"]["megapixels"], "{{MEGAPIXELS}}")

    def test_unknown_token_is_ignored(self):
        canvas = self.canvas()
        template, _, _ = self.skill_mod._template_from_workflow(
            canvas, [{"node": "25", "field": "value", "token": "MODEL"}])
        self.assertEqual(canvas["25"]["inputs"]["value"], template["25"]["inputs"]["value"])

    def test_writeback_restores_checked_bindings(self):
        canvas = self.canvas()
        template, _, _ = self.skill_mod._template_from_workflow(canvas, self.skill_mod._bind_candidates(canvas))
        # 导入到画布后 widget 灌回具体值，回写靠已存模板复原勾选
        restored = self.skill_mod._bound_bindings(template, canvas)
        self.assertEqual({(b["node"], b["token"]) for b in restored},
                         {("25", "PROMPT"), ("19", "MEGAPIXELS"), ("19", "ASPECT_RATIO")})
        template2, _, _ = self.skill_mod._template_from_workflow(canvas, restored)
        self.assertEqual(template2, template)

    def test_writeback_keeps_unchecked_binding_out(self):
        canvas = self.canvas()
        template, _, _ = self.skill_mod._template_from_workflow(canvas, [])
        self.assertEqual(self.skill_mod._bound_bindings(template, canvas), [])

    def test_video_plan_has_no_candidates(self):
        wf = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "m.safetensors"}},
              "2": {"class_type": "MiniMaxH3ImageToVideo",
                    "inputs": {"clip": ["1", 0], "prompt": "p", "width": 512, "height": 512, "length": 24}}}
        plan = self.skill_mod.plan_workflow_skill(wf)
        self.assertTrue(plan["gen_video"])
        self.assertEqual(plan["candidates"], [])


if __name__ == '__main__':
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)