# SPDX-License-Identifier: Apache-2.0
# dsh 内核桥单测：能不能用的判定、patch 渲染、argv 与环境、事件翻成右栏的帧、回退决策。
# 不真起 dsh：那一段要 node 与 API key，留给 e2e；这里钉住桥自己写出来的东西。

import asyncio
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

kernel = importlib.import_module("studio.agent_kernel")
agent = importlib.import_module("studio.agent")


def fake_run(**kw):
    run = SimpleNamespace(run_id="ab" * 16, focus={}, media_urls={}, plan_steps=[], context="",
                          prefs={}, user_skill="", user_skill_info={}, image_refs=[], image_sources=[],
                          usage={"prompt_tokens": 0, "completion_tokens": 0,
                                 "total_tokens": 0, "turns": 0})
    for key, value in kw.items():
        setattr(run, key, value)
    return run


def collect():
    frames = []

    async def emit(frame):
        frames.append(frame)

    return frames, emit


class UnavailableTests(unittest.TestCase):
    """能不能用只由这五件事决定；回退决策照这一句，所以每一句都要点名缺什么。"""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.bin = Path(self.dir.name) / "bin.js"
        self.bin.write_text("// dsh entry\n", encoding="utf-8")

    def tearDown(self):
        self.dir.cleanup()

    def test_no_node(self):
        with mock.patch.object(kernel.shutil, "which", return_value=None):
            self.assertIn("node", kernel.unavailable({"dsh_bin": str(self.bin)}))

    def test_no_entry_configured(self):
        with mock.patch.object(kernel.shutil, "which", return_value="node.exe"), \
                mock.patch.dict(os.environ, {kernel.BIN_ENV: ""}):
            self.assertIn("没有指定 dsh 入口", kernel.unavailable({}))

    def test_entry_does_not_exist(self):
        with mock.patch.object(kernel.shutil, "which", return_value="node.exe"):
            self.assertIn("不存在", kernel.unavailable({"dsh_bin": str(Path(self.dir.name) / "nope.js")}))

    def test_missing_api_key(self):
        with mock.patch.object(kernel.shutil, "which", return_value="node.exe"), \
                mock.patch.dict(os.environ, {kernel.KEY_ENV: ""}):
            self.assertIn(kernel.KEY_ENV, kernel.unavailable({"dsh_bin": str(self.bin)}))

    def test_ready(self):
        with mock.patch.object(kernel.shutil, "which", return_value="node.exe"), \
                mock.patch.dict(os.environ, {kernel.KEY_ENV: "sk-test"}):
            self.assertEqual(kernel.unavailable({"dsh_bin": str(self.bin)}), "")


class RenderPatchTests(unittest.TestCase):
    def test_the_persona_lands_inline_and_the_marker_is_gone(self):
        dest = Path(tempfile.mkdtemp()) / "patch.yml"
        kernel.render_patch("第一行\n\n第二行 缩进", dest)
        text = dest.read_text(encoding="utf-8")
        self.assertNotIn(kernel.PROMPT_MARKER, text)
        self.assertIn("\n      第一行\n", text)
        self.assertIn("\n      第二行 缩进\n", text)
        self.assertIn("personaPrefix: |-", text)
        self.assertIn("mcp-neo", text, "叠加层里的 MCP 行不能丢：闸与收场靠它")


class ArgvAndEnvTests(unittest.TestCase):
    def test_argv_names_the_profile_and_the_patch(self):
        patch = Path("C:/data/patch.yml")
        with mock.patch.object(kernel.shutil, "which", return_value="C:/node/node.exe"):
            argv = kernel._argv({"dsh_bin": "C:/dsh/lib/bin.js"}, patch)
        # Windows 的 Path 会把分隔符换成反斜杠：按路径比，不按字面比
        self.assertEqual(argv[:5], ["C:/node/node.exe", "C:/dsh/lib/bin.js", "--profile",
                                    kernel.PROFILE, "--patch"])
        self.assertEqual(Path(argv[5]), patch)

    def test_env_binds_the_run_and_the_mcp_child(self):
        run = fake_run()
        run.client = SimpleNamespace(ctx=SimpleNamespace(comfy=SimpleNamespace(base="http://127.0.0.1:8188")))
        env = kernel._env(run)
        self.assertEqual(env["NEO_AGENT_RUN"], run.run_id, "闸与收场就认这一份绑定")
        self.assertEqual(env["DSH_HOME"], str(kernel.DSH_HOME_DIR))
        self.assertEqual(env["NEO_PYTHON"], sys.executable)
        self.assertTrue(env["NEO_MCP_SERVER"].endswith("mcp_server.py"))
        self.assertEqual(env["NEO_MCP_COMFY_URL"], "http://127.0.0.1:8188")


class EventMappingTests(unittest.TestCase):
    """dsh 的事件翻成右栏的帧：面板认的 kind 一个都不能少，产物名要记进运行对象。"""

    @staticmethod
    def _assistant(blocks, usage=None):
        data = {"message": {"role": "assistant", "content": blocks}}
        if usage:
            data["usage"] = usage
        return {"type": "assistant/message", "data": data}

    def test_text_tool_call_and_usage_become_frames(self):
        run = fake_run()
        frames, emit = collect()
        calls = {}
        event = self._assistant(
            [{"type": "reasoning", "text": "想一下"},
             {"type": "text", "text": "我来出图"},
             {"type": "tool-call", "id": "c1", "name": "mcp__neo__generate_image",
              "arguments": '{"prompt": "猫"}'}],
            {"inputTokens": 100, "outputTokens": 20, "totalTokens": 120})
        asyncio.run(kernel._event(run, emit, event, calls, agent))
        self.assertEqual([f["kind"] for f in frames], ["content", "tool_call", "usage"])
        self.assertEqual(frames[0]["text"], "我来出图")
        self.assertEqual(frames[1]["tool"], "mcp__neo__generate_image")
        self.assertEqual(calls["c1"][1], {"prompt": "猫"}, "参数留一份：焦点链兜底要用")
        self.assertEqual(run.usage["total_tokens"], 120)
        self.assertEqual(run.usage["turns"], 1)

    def test_tool_result_carries_media_and_records_the_names(self):
        run = fake_run()
        frames, emit = collect()
        calls = {"c1": ("mcp__neo__generate_image", {"prompt": "猫"})}
        result = json.dumps({"images": [{"url": "http://127.0.0.1:8188/view?filename=a.png",
                                         "filename": "a.png"}]}, ensure_ascii=False)
        event = {"type": "tool/result", "data": {
            "message": {"role": "tool", "toolCallId": "c1",
                        "content": [{"type": "text", "text": result}]}}}
        asyncio.run(kernel._event(run, emit, event, calls, agent))
        self.assertEqual(frames[0]["kind"], "tool_result")
        self.assertEqual(frames[0]["tool"], "mcp__neo__generate_image")
        self.assertEqual(frames[0]["media"][0]["title"], "a.png")
        self.assertIn("a.png", run.media_urls, "finish_task 只认这份表里的名字")

    def test_the_name_comes_from_the_tool_call_event(self):
        """tool/result 只带 callId：名字从 tool/call 那一份学（块 id 与它不一定同号，实测对不上）。"""
        run = fake_run()
        frames, emit = collect()
        calls = {}
        asyncio.run(kernel._event(run, emit, {"type": "tool/call", "data": {
            "callId": "c9", "name": "mcp__neo__task_status", "arguments": "{}"}}, calls, agent))
        self.assertEqual(frames, [], "tool/call 只记账：tool_call 帧由 assistant/message 发，别发两遍")
        asyncio.run(kernel._event(run, emit, {"type": "tool/result", "data": {
            "message": {"role": "tool", "toolCallId": "c9",
                        "content": [{"type": "text", "text": "{}"}]}}}, calls, agent))
        self.assertEqual(frames[0]["tool"], "mcp__neo__task_status")

    def test_an_unknown_call_id_still_reports_the_result(self):
        run = fake_run()
        frames, emit = collect()
        event = {"type": "tool/result", "data": {
            "message": {"role": "tool", "toolCallId": "nope",
                        "content": [{"type": "text", "text": "{}"}]}}}
        asyncio.run(kernel._event(run, emit, event, {}, agent))
        self.assertEqual(frames[0]["tool"], "")


class UseKernelTests(unittest.TestCase):
    """回退决策：dsh 接不住的形态一律回退循环，不静默丢东西。"""

    def _run(self, backend="dsh"):
        return fake_run(prefs={"backend": backend, "dsh_bin": "C:/dsh/lib/bin.js"})

    def test_loop_backend_never_uses_the_kernel(self):
        with mock.patch.object(agent.agent_kernel, "unavailable", return_value=""):
            self.assertFalse(agent._use_kernel(self._run("loop"), "act", None, None))

    def test_a_ready_kernel_takes_the_act_turn(self):
        with mock.patch.object(agent.agent_kernel, "unavailable", return_value=""):
            self.assertTrue(agent._use_kernel(self._run(), "act", None, None))

    def test_plan_mode_images_and_history_fall_back(self):
        with mock.patch.object(agent.agent_kernel, "unavailable", return_value=""):
            self.assertFalse(agent._use_kernel(self._run(), "plan", None, None))
            self.assertFalse(agent._use_kernel(self._run(), "act", [{"kind": "data"}], None))
            self.assertFalse(agent._use_kernel(self._run(), "act", None, [{"role": "user"}]))

    def test_a_missing_piece_falls_back(self):
        with mock.patch.object(agent.agent_kernel, "unavailable", return_value="本机没有 node"):
            self.assertFalse(agent._use_kernel(self._run(), "act", None, None))


if __name__ == "__main__":
    unittest.main()
