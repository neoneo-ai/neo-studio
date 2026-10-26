# SPDX-License-Identifier: Apache-2.0
# Neo Studio - H3 提示词审计单元测试
# 覆盖 h3_prompt_audit 的确定性检查分支与窄修复验收，以及 skill.py 的 H3 grounding 注入

from stub_env import GALLERY_STUB_PREFIXES, restore, snapshot

_STUB_SAVED = snapshot(GALLERY_STUB_PREFIXES)

import os
import sys
import types
import importlib
import unittest

_NODE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, _NODE_DIR)

# h3_prompt_audit 无外部依赖，直接顶层导入
h3_prompt_audit = importlib.import_module("h3_prompt_audit")

# skill.py 需要 server stub（与 test_skills.py 一致）
_PKG_NAME = "_neo_nodes_test_pkg"
if _PKG_NAME not in sys.modules:
    _pkg = types.ModuleType(_PKG_NAME)
    _pkg.__path__ = [_NODE_DIR]
    sys.modules[_PKG_NAME] = _pkg

try:
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

    if "server" not in sys.modules:
        _fake_server = types.ModuleType("server")
        _fake_server.PromptServer = _FakePromptServer
        sys.modules["server"] = _fake_server
    skill_mod = importlib.import_module(f"{_PKG_NAME}.skill")
    SKILL_AVAILABLE = True
except Exception as _e:  # 缺少 yaml/aiohttp 等依赖时跳过 skill 相关用例
    skill_mod = None
    SKILL_AVAILABLE = False
    _IMPORT_ERROR = _e

_reason = "" if SKILL_AVAILABLE else f"skill module unavailable: {_IMPORT_ERROR}"


REF_PROMPT = """subject_definitions:
<Subject 1> is the young woman in <Picture 1>, with long blonde hair.

summary:
[reference generation] The target video shows <Subject 1> waving in <Picture 1>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - identity and outfit retained.

detailed_description:
The target video uses a live-action cinematic style.
[Shot 1] A medium shot frames <Subject 1> from <Picture 1>. <Subject 1> (S1) turns and says, <d>[English] Hello there.</d>
[Shot 2] At 00:03.500, the shot cuts to a close-up of <Subject 1>.

overall_soundscape:
Soft outdoor ambience continues throughout.

non_diegetic_music:
N/A"""

BASE_PROMPT = """integrated_multimodal_description:
[Shot 1] Live-action, cinematic, a medium shot frames a woman in a cafe.
[Shot 2] At 00:03.500, the camera cuts to a close-up.

overall_soundscape:
Soft indoor room tone.

non_diegetic_music:
N/A"""


class TestAuditStructure(unittest.TestCase):
    def test_valid_reference_prompt_passes(self):
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["a.png"]}}]}
        result = h3_prompt_audit.audit_h3_prompt(REF_PROMPT, ctx)
        self.assertFalse(result["repair_required"], result["failures"])

    def test_valid_base_prompt_passes(self):
        result = h3_prompt_audit.audit_h3_prompt(BASE_PROMPT)
        self.assertFalse(result["repair_required"], result["failures"])

    def test_missing_sections_reported(self):
        text = REF_PROMPT.replace("retention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - identity and outfit retained.\n", "")
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(result["repair_required"])
        self.assertIn("retention_analysis", " ".join(result["failures"]))

    def test_wrong_section_order_reported(self):
        # detailed_description 移到 retention_analysis 之前（乱序）
        text = ("subject_definitions:\n<Subject 1> is the woman in <Picture 1>.\n\n"
                "summary:\n[reference generation] The target video shows <Subject 1>.\n\n"
                "detailed_description:\n[Shot 1] A medium shot of <Subject 1> from <Picture 1>.\n\n"
                "retention_analysis:\n<Subject 1>: fully_preserved - retained.\n\n"
                "overall_soundscape:\nRoom tone.\n\n"
                "non_diegetic_music:\nN/A")
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(any("section order" in f for f in result["failures"]))

    def test_summary_without_task_label_reported(self):
        text = REF_PROMPT.replace("[reference generation] The target video", "The target video")
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(any("task label" in f for f in result["failures"]))

    def test_missing_shot1_marker_reported(self):
        text = REF_PROMPT.replace("[Shot 1] A medium shot", "The video opens with a medium shot")
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(any("[Shot 1]" in f for f in result["failures"]))

    def test_base_missing_field_reported(self):
        text = BASE_PROMPT.replace("overall_soundscape:\nSoft indoor room tone.\n", "")
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(result["repair_required"])
        self.assertIn("overall_soundscape", " ".join(result["failures"]))

    def test_no_structure_reported(self):
        result = h3_prompt_audit.audit_h3_prompt("a cat sits on a mat")
        self.assertTrue(result["repair_required"])
        self.assertIn("no H3 prompt structure found", " ".join(result["failures"]))


class TestAuditTimestamps(unittest.TestCase):
    def test_invalid_format(self):
        self.assertEqual(h3_prompt_audit.invalid_timestamps("At 00:09.5, cut"), ["00:09.5"])

    def test_valid_formats(self):
        self.assertEqual(h3_prompt_audit.invalid_timestamps("At 00:03.500 and at 01:00.000"), [])

    def test_seconds_over_60_invalid(self):
        self.assertEqual(h3_prompt_audit.invalid_timestamps("At 00:75.000"), ["00:75.000"])

    def test_duration_bound_from_context(self):
        ctx = {"h3": [{"type": "EmptyMiniMaxH3LatentAV", "length": 144}]}  # 6s @24fps
        text = BASE_PROMPT.replace("00:03.500", "00:07.000")
        result = h3_prompt_audit.audit_h3_prompt(text, ctx)
        self.assertTrue(any("invalid timestamps" in f for f in result["failures"]))

    def test_duration_seconds_field_preferred(self):
        self.assertEqual(h3_prompt_audit.context_duration_seconds({"h3": [{"duration_seconds": 12, "length": 96}]}), 12.0)


class TestAuditTagsAndDialogue(unittest.TestCase):
    def test_unexpected_tag_reported(self):
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["a.png"]}}]}
        text = REF_PROMPT.replace("<Picture 1>", "<Picture 2>")
        result = h3_prompt_audit.audit_h3_prompt(text, ctx)
        self.assertTrue(any("unexpected reference tags" in f for f in result["failures"]))

    def test_missing_connected_reference_reported(self):
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["a.png", "b.png"]}}]}
        result = h3_prompt_audit.audit_h3_prompt(REF_PROMPT, ctx)
        self.assertTrue(any("connected references are missing" in f for f in result["failures"]))

    def test_audio_not_required(self):
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo",
                       "refs": {"pictures": ["a.png"], "audios": ["voice.mp3"]}}]}
        result = h3_prompt_audit.audit_h3_prompt(REF_PROMPT, ctx)
        self.assertFalse(result["repair_required"], result["failures"])

    def test_keyframe_slots_counted_as_pictures(self):
        ctx = {"h3": [{"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"first": "f.png"}}}]}
        self.assertEqual(h3_prompt_audit.context_media_tags(ctx), {"<Picture 1>"})

    def test_dialogue_without_speaker_id_reported(self):
        text = BASE_PROMPT.replace("a woman in a cafe.", 'a woman in a cafe. She says, <d>[English] Hi.</d>')
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(any("speaker ID" in f for f in result["failures"]))

    def test_dialogue_with_speaker_id_passes(self):
        text = BASE_PROMPT.replace("a woman in a cafe.", 'a woman (S1) in a cafe. She says, <d>[English] Hi.</d>')
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertFalse(result["repair_required"], result["failures"])

    def test_dialogue_in_soundscape_reported(self):
        text = BASE_PROMPT.replace("Soft indoor room tone.", "Room tone. She says <d>[English] Hi.</d> (S1).")
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(any("must not appear in overall_soundscape" in f for f in result["failures"]))

    def test_dialogue_in_non_diegetic_music_reported(self):
        text = REF_PROMPT.replace("N/A", "A score. He says <d>[English] Hi.</d> (S1).")
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(any("must not appear in non_diegetic_music" in f for f in result["failures"]))

    def test_internal_terms_reported(self):
        text = BASE_PROMPT + "\n\nThe model sees a contact sheet of sampled frames."
        result = h3_prompt_audit.audit_h3_prompt(text)
        self.assertTrue(any("internal representation terms" in f for f in result["failures"]))


class TestNarrowRepair(unittest.TestCase):
    def test_messages_shape(self):
        msgs = h3_prompt_audit.narrow_repair_messages("make a video", "DRAFT", ["bad one", "bad two"])
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[0]["role"], "system")
        self.assertIn("narrow correction pass", msgs[0]["content"])
        self.assertIn("- bad one\n- bad two", msgs[0]["content"])
        self.assertEqual(msgs[1]["role"], "user")
        self.assertIn("make a video", msgs[1]["content"])
        self.assertIn("DRAFT", msgs[1]["content"])

    def test_acceptable_requires_audit_pass(self):
        ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["a.png"]}}]}
        self.assertTrue(h3_prompt_audit.repair_acceptable(REF_PROMPT, REF_PROMPT + "\n", ctx))

    def test_rejects_tag_changes(self):
        changed = REF_PROMPT.replace("<Picture 1>", "<Picture 1>, <Video 9>")
        self.assertFalse(h3_prompt_audit.repair_acceptable(REF_PROMPT, changed))

    def test_rejects_dialogue_changes(self):
        changed = REF_PROMPT.replace("Hello there.", "Goodbye.")
        self.assertFalse(h3_prompt_audit.repair_acceptable(REF_PROMPT, changed))

    def test_rejects_empty(self):
        self.assertFalse(h3_prompt_audit.repair_acceptable(REF_PROMPT, "  "))


@unittest.skipUnless(SKILL_AVAILABLE, _reason)
class TestH3Grounding(unittest.TestCase):
    def test_reference_mode(self):
        node = {"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["a.png"]}}
        self.assertIn("Final grounding check (Reference)", skill_mod._h3_grounding_check(node))

    def test_keyframe_modes(self):
        i2v = {"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"first": "f.png"}}}
        self.assertIn("(I2VA)", skill_mod._h3_grounding_check(i2v))
        fl2v = {"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"first": "f.png", "last": "l.png"}}}
        self.assertIn("(FL2VA)", skill_mod._h3_grounding_check(fl2v))
        l2v = {"type": "MiniMaxH3ImageToVideo", "refs": {"keyframes": {"last": "l.png"}}}
        self.assertIn("(L2VA)", skill_mod._h3_grounding_check(l2v))

    def test_default_t2va(self):
        node = {"type": "EmptyMiniMaxH3LatentAV"}
        self.assertIn("(T2VA)", skill_mod._h3_grounding_check(node))

    def test_context_block_includes_grounding_only_when_requested(self):
        ctx = {"h3": [{"type": "EmptyMiniMaxH3LatentAV", "duration_seconds": 6}]}
        plain = skill_mod._format_workflow_context(ctx)
        grounded = skill_mod._format_workflow_context(ctx, grounding=True)
        self.assertNotIn("Final grounding check", plain)
        self.assertIn("Final grounding check (T2VA)", grounded)

    def test_preset_skills_declare_h3_audit(self):
        for sid in ("minimax_h3_base", "minimax_h3_full_ref", "minimax_h3_image_ref"):
            self.assertEqual(skill_mod.load_skill_audit(sid), "h3", sid)


@unittest.skipUnless(SKILL_AVAILABLE, _reason)
class TestH3AuditEvents(unittest.TestCase):
    """流式路径的审计阶段事件（status/replace）与非流式 on_step 上报"""

    def setUp(self):
        self.ctx = {"h3": [{"type": "MiniMaxH3ReferenceToVideo", "refs": {"pictures": ["a.png"]}}]}
        self._llm_stub_name = f"{_PKG_NAME}.llm"

    def _events(self, content, repaired=None, raise_err=False):
        llm_stub = types.ModuleType(self._llm_stub_name)
        def chat_turn(messages, max_tokens=500):
            if raise_err:
                raise RuntimeError("no llm")
            return {"content": repaired or ""}
        llm_stub.chat_turn = chat_turn
        sys.modules[self._llm_stub_name] = llm_stub
        try:
            return list(skill_mod._h3_audit_events(content, "test-skill", "user text", self.ctx, 500))
        finally:
            del sys.modules[self._llm_stub_name]

    def test_pass_yields_status_only(self):
        events = self._events(REF_PROMPT)
        self.assertEqual([e["kind"] for e in events], ["status", "status"])
        self.assertIn("格式自检通过", events[1]["text"])

    def test_repair_yields_replace(self):
        draft = REF_PROMPT.replace(" (S1)", "")
        events = self._events(draft, repaired=REF_PROMPT)
        self.assertEqual([e["kind"] for e in events], ["status", "status", "status", "status", "replace"])
        # 审计结果（违规项明细）与修复结果都以 status 上报，前端常驻展示
        self.assertIn("处格式问题", events[1]["text"])
        self.assertIn("已自动修复格式", events[3]["text"])
        self.assertEqual(events[-1]["text"], REF_PROMPT)

    def test_repair_rejected_no_replace(self):
        draft = REF_PROMPT.replace(" (S1)", "")
        bad = REF_PROMPT.replace("Hello there.", "Goodbye.")
        events = self._events(draft, repaired=bad)
        self.assertEqual([e["kind"] for e in events], ["status", "status", "status", "status"])
        self.assertIn("保留原输出", events[-1]["text"])

    def test_repair_llm_error_keeps_draft(self):
        draft = REF_PROMPT.replace(" (S1)", "")
        events = self._events(draft, raise_err=True)
        self.assertEqual([e["kind"] for e in events], ["status", "status", "status", "status"])

    def test_audit_and_repair_on_step(self):
        llm_stub = types.ModuleType(self._llm_stub_name)
        llm_stub.chat_turn = lambda messages, max_tokens=500: {"content": REF_PROMPT}
        sys.modules[self._llm_stub_name] = llm_stub
        try:
            draft = REF_PROMPT.replace(" (S1)", "")
            steps = []
            out = skill_mod._h3_audit_and_repair(draft, "test-skill", "user text", self.ctx, 500, on_step=steps.append)
            self.assertEqual(out, REF_PROMPT)
            # 最终修复结果也经 on_step 上报（工具循环路径的状态在正文前发出，前端累计展示）
            self.assertTrue(any("处格式问题" in s for s in steps))
            self.assertTrue(any("已自动修复格式" in s for s in steps))
        finally:
            del sys.modules[self._llm_stub_name]


if __name__ == "__main__":
    unittest.main()

restore(GALLERY_STUB_PREFIXES, _STUB_SAVED)
