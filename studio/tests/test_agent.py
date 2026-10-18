# SPDX-License-Identifier: Apache-2.0
"""右栏智能体后端（studio/agent.py）离线单测。

右栏的工具表就是 MCP 全集（出片链路也在里面），工具调用逐行走 mcp_server.serve 的 JSON-RPC。
用例只替两个接缝：McpClient.call（假工具载荷）与 _chat（假 LLM），验证工具表面等于 MCP
注册表、技能直出图、LLM 规划-调用-回填、异步任务轮询（含整片段进度）、工具错误原文回填、
轮次用满兜底、系统提示词缺失、SSE 帧形态、cancel 路由的 task_id 校验。
"""
import asyncio
import contextlib
import importlib
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

agent = None
_IMPORT_ERR = ""
try:
    agent = importlib.import_module("studio.agent")
    mcp = importlib.import_module("studio.mcp_server")
except Exception as e:                                  # aiohttp 不在的机器上整模块跳过
    _IMPORT_ERR = str(e)

AVAILABLE = agent is not None
skip = unittest.skipUnless(AVAILABLE, f"agent module unavailable: {_IMPORT_ERR}")


class FakeClient:
    """替掉 McpClient.call：按工具名喂预设载荷，记录调用顺序。

    预设值可以是 dict（自动转 JSON 文本）、list（按次弹出，用于轮询序列）或异常（抛出）。"""

    def __init__(self, replies, names=()):
        self.replies = dict(replies)
        self.names = list(names)
        self.calls = []

    def call(self, name, args):
        self.calls.append((name, args))
        rep = self.replies.get(name)
        if isinstance(rep, list):
            rep = rep.pop(0) if rep else "{}"
        if isinstance(rep, Exception):
            raise rep
        return rep if isinstance(rep, str) else json.dumps(rep, ensure_ascii=False)

    def tool_list(self):
        return [{"name": n} for n in (self.names or self.replies)]


def _run(coro):
    """跑一条协程，收齐它 emit 出来的帧。"""
    frames = []

    async def emit(frame):
        frames.append(frame)

    async def main():
        await coro(emit)

    asyncio.run(main())
    return frames


def _kinds(frames):
    return [f.get("kind") for f in frames]


def _data_lines(resp):
    """web.Response 的 body 在 SSE 路由里是异步生成子（被 aiohttp 包成 payload），在错误分支里是 bytes。"""
    async def collect():
        body = resp.body
        if isinstance(body, bytes):
            chunks = [body]
        else:
            chunks = [x async for x in getattr(body, "_value", body)]
        return [x[6:] for c in chunks for x in c.decode("utf-8").split("\n") if x.startswith("data: ")]
    return asyncio.run(collect())


def _result(coro):
    """跑一条协程，取回它的返回值与 emit 出来的帧。"""
    frames = []

    async def emit(frame):
        frames.append(frame)

    async def main():
        return await coro(emit)

    return asyncio.run(main()), frames


@contextlib.contextmanager
def _no_poll_sleep():
    """轮询用例里把 sleep 换成空转：TASK_POLL_SEC 保持真实值，等待上限才会被走到。"""
    async def noop(_seconds):
        return None
    with mock.patch.object(agent.asyncio, "sleep", noop):
        yield


@skip
class TestToolSurface(unittest.TestCase):
    def test_client_sees_the_whole_mcp_registry(self):
        """右栏不再砍第二层白名单：出片与配方写操作工具同样进 LLM 的工具表。"""
        client = agent.McpClient("http://127.0.0.1:8188")
        self.assertEqual([t["name"] for t in client.tools], [t["name"] for t in mcp.TOOLS])
        self.assertIn("director_run", [t["name"] for t in client.tools])
        self.assertIn("cancel_task", [t["name"] for t in client.tools])

    def test_task_tools_are_the_asyncones(self):
        self.assertEqual(agent.TASK_TOOLS,
                         ("generate_image", "director_run", "segment_run", "assemble_run"))

    def test_system_prompt_missing_raises_actionable_error(self):
        """提示词文件缺失要在第一帧之前报出文件路径，不能让 LLM 裸跑。"""
        with mock.patch.object(agent, "SYSTEM_PROMPT_FILE", Path("__no_such_prompt__.md")):
            with self.assertRaises(mcp.ToolError) as got:
                agent.system_prompt("")
        self.assertIn("__no_such_prompt__.md", str(got.exception))

    def test_system_prompt_pins_selected_skill(self):
        self.assertIn("skill_cat", agent.system_prompt("skill_cat"))


@skip
class TestPayloadHelpers(unittest.TestCase):
    def test_status_line_carries_progress_and_segment(self):
        one = agent._status_of(json.dumps({"status": "running", "progress": {"value": 7, "max": 20}}))
        self.assertEqual(one, "running 7/20")
        film = agent._status_of(json.dumps({
            "status": "running",
            "segment": {"index": 2, "total": 3, "step": 5, "total_steps": 30}}))
        self.assertEqual(film, "running 段 2/3 5/30")

    def test_status_of_non_json_is_empty(self):
        self.assertEqual(agent._status_of("not json"), "")

    def test_caption_covers_images_film_and_failure(self):
        self.assertEqual(agent._caption(json.dumps(
            {"status": "succeeded", "width": 1024, "height": 512,
             "images": [{"url": "/view?a=1"}]})), "完成：1 张 · 1024×512")
        self.assertEqual(agent._caption(json.dumps(
            {"status": "succeeded", "filename": "NeoDirector/cat.mp4"})), "完成：成片 NeoDirector/cat.mp4")
        self.assertEqual(agent._caption(json.dumps(
            {"status": "failed", "error": "显存不足"})), "显存不足")


@skip
class TestSkillPath(unittest.TestCase):
    def test_skill_runs_generate_then_polls_to_images(self):
        client = FakeClient({
            "generate_image": {"task_id": "t-1"},
            "task_status": [{"status": "running"},
                            {"status": "succeeded", "width": 1024, "height": 1024,
                             "images": [{"url": "/view?f=a.png", "filename": "a.png"}]}]})
        with _no_poll_sleep():
            frames = _run(lambda emit: agent._run_skill(client, "一只橘猫", "skill_cat", emit))
        self.assertEqual(_kinds(frames),
                         ["plan", "tool_call", "status", "status", "tool_result", "content"])
        self.assertEqual([f["tool"] for f in frames if f.get("tool")],
                         ["generate_image", "task_status", "task_status", "generate_image"])
        self.assertEqual(frames[4]["images"], [{"url": "/view?f=a.png", "filename": "a.png"}])
        self.assertEqual(frames[5]["text"], "完成：1 张 · 1024×1024")
        self.assertEqual(client.calls[0],
                         ("generate_image", {"skill_id": "skill_cat", "prompt": "一只橘猫"}))

    def test_skill_path_never_calls_the_llm(self):
        done = {"status": "succeeded", "images": [{"url": "/view?f=a.png"}]}
        client = FakeClient({"generate_image": {"task_id": "t-1"}, "task_status": done})
        with mock.patch.object(agent, "_chat",
                               side_effect=AssertionError("技能路径不该叫 LLM")), _no_poll_sleep():
            frames = _run(lambda emit: agent._run_skill(client, "x", "skill_cat", emit))
        self.assertEqual(frames[0]["kind"], "plan")
        self.assertEqual(frames[-1]["kind"], "content")



@skip
class TestTaskPolling(unittest.TestCase):
    def test_film_task_polls_with_segment_progress(self):
        """整片是多段任务：轮询要带段进度，产物是成片文件名。"""
        client = FakeClient({
            "director_run": {"task_id": "f-1"},
            "task_status": [{"status": "running",
                             "segment": {"index": 1, "total": 2, "step": 3, "total_steps": 10}},
                            {"status": "succeeded", "filename": "NeoDirector/film.mp4"}]})
        with _no_poll_sleep():
            payload, frames = _result(
                lambda emit: agent._tool_result(client, "director_run", {"recipe": "r"}, emit))
        self.assertEqual(client.calls[0][0], "director_run")
        self.assertEqual(client.calls[1], ("task_status", {"task_id": "f-1"}))
        self.assertEqual(frames[0]["text"], "running 段 1/2 3/10")
        self.assertEqual(frames[0]["task_id"], "f-1")
        self.assertEqual(agent._caption(payload), "完成：成片 NeoDirector/film.mp4")

    def test_poll_gives_up_at_the_wait_cap(self):
        client = FakeClient({"segment_run": {"task_id": "s-1"}, "task_status": {"status": "running"}})
        with _no_poll_sleep(), mock.patch.object(agent, "FILM_WAIT_SEC", 4.0):
            payload, _ = _result(lambda emit: agent._tool_result(
                client, "segment_run", {"recipe": "r", "segment": 1}, emit))
        self.assertIn("任务超时", payload)

    def test_sync_snapshot_without_task_id_is_returned_as_is(self):
        client = FakeClient({"generate_image": {"images": [{"url": "/view?f=a.png"}]}})
        payload, frames = _result(lambda emit: agent._tool_result(client, "generate_image", {}, emit))
        self.assertEqual(frames, [])
        self.assertIn("/view?f=a.png", payload)
        self.assertEqual(client.calls, [("generate_image", {})])

    def test_tool_error_text_goes_back_into_the_loop(self):
        """工具报错不能炸循环：原文带 [error] 前缀回填给 LLM，让它换路。"""
        client = FakeClient({"neo_status": mcp.ToolError("ComfyUI 没在线")})
        payload, _ = _result(lambda emit: agent._tool_result(client, "neo_status", {}, emit))
        self.assertEqual(payload, "[error] ComfyUI 没在线")


@skip
class TestAgentLoop(unittest.TestCase):
    def test_plan_tool_call_then_final_answer(self):
        turns = [{"content": "先看有哪些配方",
                  "tool_calls": [{"id": "c1", "function": {"name": "director_recipes", "arguments": "{}"}}]},
                 {"content": "有 2 个配方，选一个跑整片"}]
        seen = []

        def chat(messages, tools):
            seen.append((list(messages), list(tools)))
            return turns[len(seen) - 1]

        client = FakeClient({"director_recipes": {"count": 2, "recipes": []}},
                            names=("director_recipes", "director_run"))
        with mock.patch.object(agent, "_chat", chat):
            frames = _run(lambda emit: agent._run_agent(client, "出个片", "", emit))
        self.assertEqual(_kinds(frames), ["plan", "tool_call", "tool_result", "content"])
        self.assertEqual(frames[1]["tool"], "director_recipes")
        self.assertEqual(frames[3]["text"], "有 2 个配方，选一个跑整片")
        # 工具结果要以 tool 角色回填，第二轮 LLM 才看得见这一路
        self.assertIn("tool", [m["role"] for m in seen[1][0]])
        # LLM 拿到的工具表就是 MCP 全集，出片工具在里面
        self.assertEqual([t["name"] for t in seen[0][1]], ["director_recipes", "director_run"])

    def test_bad_tool_arguments_do_not_kill_the_turn(self):
        turns = [{"content": "",
                  "tool_calls": [{"id": "c1", "function": {"name": "list_skills", "arguments": "{坏 JSON"}}]},
                 {"content": "好了"}]

        asked = []

        def chat(messages, tools):
            asked.append(len(messages))
            return turns[len(asked) - 1]

        client = FakeClient({"list_skills": {"count": 0, "skills": []}})
        with mock.patch.object(agent, "_chat", chat):
            frames = _run(lambda emit: agent._run_agent(client, "列技能", "", emit))
        self.assertEqual(client.calls[0], ("list_skills", {}))
        self.assertEqual(frames[-1]["text"], "好了")

    def test_turn_cap_says_what_was_tried(self):
        """轮次用满不能静默收场：兜底文案要说明跑了多少轮、下一步该怎么说。"""
        looping = {"content": "",
                   "tool_calls": [{"id": "c", "function": {"name": "neo_status", "arguments": "{}"}}]}
        client = FakeClient({"neo_status": {"neo_studio": "1"}})
        with mock.patch.object(agent, "_chat", lambda m, t: looping), \
             mock.patch.object(agent, "MAX_TURNS", 2):
            frames = _run(lambda emit: agent._run_agent(client, "随便看看", "", emit))
        self.assertEqual(frames[-1]["kind"], "content")
        self.assertIn("2 轮", frames[-1]["text"])



@skip
class TestRoutes(unittest.TestCase):
    @staticmethod
    def _req(body, valid_json=True):
        async def json():
            if not valid_json:
                raise ValueError("nope")
            return body
        return SimpleNamespace(json=json,
                               url=SimpleNamespace(host="127.0.0.1", port=8188, scheme="http"))

    def test_comfy_base_comes_from_the_request_url(self):
        """工具回指的 ComfyUI 由请求来源决定，请求体里没有地址可注入。"""
        self.assertEqual(agent.comfy_base(TestRoutes._req({})), "http://127.0.0.1:8188")

    def test_run_rejects_empty_text_before_streaming(self):
        resp = asyncio.run(agent.agent_run(TestRoutes._req({"text": "  "})))
        self.assertIn("[ERROR]", _data_lines(resp)[0])

    def test_run_rejects_non_json_body(self):
        resp = asyncio.run(agent.agent_run(TestRoutes._req({}, valid_json=False)))
        self.assertIn("[ERROR]", _data_lines(resp)[0])

    def test_run_streams_plan_tool_result_then_done(self):
        client = FakeClient({"generate_image": {"images": [{"url": "/view?f=a.png"}]}})
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client):
            resp = asyncio.run(agent.agent_run(
                TestRoutes._req({"text": "橘猫", "skill_id": "skill_cat"})))
        self.assertEqual(resp.headers["Content-Type"], "text/event-stream")
        lines = _data_lines(resp)
        self.assertEqual(json.loads(lines[0]), {"kind": "plan", "text": "按技能 skill_cat 直接出图"})
        self.assertEqual(lines[-1], "[DONE]")
        self.assertEqual(json.loads(lines[-2])["kind"], "content")

    def test_run_reports_tool_failure_as_error_frame_then_done(self):
        """工具在流里炸掉不能把连接吊住：[ERROR] 之后必须补上 [DONE]。"""
        client = FakeClient({"generate_image": mcp.ToolError("技能不存在：skill_cat")})
        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: client):
            resp = asyncio.run(agent.agent_run(
                TestRoutes._req({"text": "橘猫", "skill_id": "skill_cat"})))
        lines = _data_lines(resp)
        self.assertIn("[ERROR] 技能不存在：skill_cat", lines)
        self.assertEqual(lines[-1], "[DONE]")

    def test_cancel_rejects_non_uuid_task_id(self):
        """task_id 会被拼进 cancel 路由的路径段，路径穿越形态必须在入口挡掉。"""
        resp = asyncio.run(agent.agent_cancel(TestRoutes._req({"task_id": "../secret"})))
        self.assertEqual(resp.status, 400)
        self.assertIn("task_id", json.loads(resp.text)["error"])

    def test_cancel_calls_mcp_cancel_task(self):
        calls = []

        class Client:
            def call(self, name, args):
                calls.append((name, args))
                return json.dumps({"kind": "director", "task_id": args["task_id"],
                                   "status": "cancelled"})

        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: Client()):
            resp = asyncio.run(agent.agent_cancel(
                TestRoutes._req({"task_id": "6f1c2a34-9b7c-4d0a-8e11-2f3a4b5c6d7e"})))
        data = json.loads(resp.text)
        self.assertTrue(data["success"])
        self.assertEqual(data["kind"], "director")
        self.assertEqual(calls, [("cancel_task",
                                  {"task_id": "6f1c2a34-9b7c-4d0a-8e11-2f3a4b5c6d7e"})])

    def test_cancel_reports_missing_task_as_404(self):
        class Client:
            def call(self, name, args):
                raise mcp.ToolError(f"任务不存在：{args['task_id']}")

        with mock.patch.object(agent, "McpClient", lambda base, timeout=30: Client()):
            resp = asyncio.run(agent.agent_cancel(
                TestRoutes._req({"task_id": "6f1c2a34-9b7c-4d0a-8e11-2f3a4b5c6d7e"})))
        self.assertEqual(resp.status, 404)
        self.assertIn("任务不存在", json.loads(resp.text)["error"])


if __name__ == "__main__":
    unittest.main()

